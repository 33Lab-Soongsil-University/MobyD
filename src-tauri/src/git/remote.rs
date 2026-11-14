//! Running git on another machine over SSH.
//!
//! A remote repository is addressed as `ssh://<host-alias>/<absolute path>`
//! (Windows paths keep their drive letter: `ssh://pc/C:/Users/me/repo`). The
//! host alias is resolved by the user's own `ssh` and `~/.ssh/config`, so keys,
//! agents, jump hosts and ports work exactly as in their terminal.
//!
//! Latency: every call reuses one multiplexed connection (ControlMaster), and
//! the refresh path sends a whole batch of git commands as one script, so a
//! full graph refresh costs a single round trip.
//!
//! Shell independence: the command we send is a base64 encoded POSIX script,
//! decoded and evaluated on the far side. It survives zsh, fish, cmd.exe and
//! PowerShell login shells; on Windows the script runs in Git for Windows' bash.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;

use crate::error::{AppError, AppResult};

pub const SCHEME: &str = "ssh://";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshTarget {
    pub host: String,
    pub path: String,
}

pub fn is_remote(p: &Path) -> bool {
    p.to_string_lossy().starts_with(SCHEME)
}

/// Split `ssh://host/path` into host and remote path.
pub fn parse(p: &Path) -> Option<SshTarget> {
    let s = p.to_string_lossy();
    let rest = s.strip_prefix(SCHEME)?;
    let (host, path) = rest.split_once('/').unwrap_or((rest, ""));
    if host.is_empty() {
        return None;
    }
    let windows_drive = path.len() >= 2 && path.as_bytes()[1] == b':' && path.as_bytes()[0].is_ascii_alphabetic();
    let path = if windows_drive || path.starts_with('~') { path.to_string() } else { format!("/{path}") };
    Some(SshTarget { host: host.to_string(), path })
}

/// Inverse of [`parse`].
pub fn uri(host: &str, path: &str) -> String {
    format!("{SCHEME}{host}/{}", path.trim_start_matches('/'))
}

/// POSIX single-quote a word.
pub fn sh_quote(s: &str) -> String {
    if !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_./=:@,+%^".contains(&b)) {
        return s.to_string();
    }
    format!("'{}'", s.replace('\'', "'\"'\"'"))
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn base64(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (b[0] as u32) << 16 | (b[1] as u32) << 8 | b[2] as u32;
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(B64[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// Environment every remote git call gets (mirrors the local runner).
pub const PRELUDE: &str = "PATH=\"$PATH:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin\"; export PATH\n\
export GIT_TERMINAL_PROMPT=0 GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true GIT_MERGE_AUTOEDIT=no LC_ALL=C LANG=C\n";

pub const GIT_OPTS: &str = "git -c core.quotepath=false -c color.ui=false -c advice.detachedHead=false";

/// `cd` into the repository (or `~`) inside a script.
pub fn cd_line(path: &str) -> String {
    if path.is_empty() || path == "~" {
        "cd || exit 97\n".to_string()
    } else if let Some(rest) = path.strip_prefix("~/") {
        format!("cd -- \"$HOME\"/{} || exit 97\n", sh_quote(rest))
    } else {
        format!("cd -- {} || exit 97\n", sh_quote(path))
    }
}

/// Script running a single git command.
pub fn git_script(path: &str, args: &[String], env: &[(&str, &str)]) -> String {
    let mut s = String::from(PRELUDE);
    s.push_str(&cd_line(path));
    for (k, v) in env {
        s.push_str(&format!("export {k}={}\n", sh_quote(v)));
    }
    s.push_str("exec ");
    s.push_str(GIT_OPTS);
    for a in args {
        s.push(' ');
        s.push_str(&sh_quote(a));
    }
    s.push('\n');
    s
}

/// How to talk to a host's login shell. `Auto` detects it and verifies by running a command.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ShellPref {
    #[default]
    Auto,
    Posix,
    Cmd,
    Powershell,
}

/// Per-host settings that live in MobyD only (the user's ~/.ssh/config is never edited).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct HostPrefs {
    pub shell: ShellPref,
    /// Address to use instead of the config's HostName (e.g. a Tailscale IP).
    pub address: Option<String>,
}

fn host_prefs() -> &'static Mutex<HashMap<String, HostPrefs>> {
    static PREFS: OnceLock<Mutex<HashMap<String, HostPrefs>>> = OnceLock::new();
    PREFS.get_or_init(Default::default)
}

fn shell_cache() -> &'static Mutex<HashMap<String, Shell>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Shell>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// Install per-host preferences; hosts whose settings changed are re-detected on next use.
pub fn set_host_prefs(prefs: HashMap<String, HostPrefs>) {
    let mut current = host_prefs().lock().unwrap();
    let mut cache = shell_cache().lock().unwrap();
    for (host, p) in prefs.iter() {
        if current.get(host) != Some(p) {
            cache.remove(host);
        }
    }
    for host in current.keys() {
        if !prefs.contains_key(host) {
            cache.remove(host);
        }
    }
    *current = prefs;
}

fn prefs_for(host: &str) -> HostPrefs {
    host_prefs().lock().unwrap().get(host).cloned().unwrap_or_default()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Shell {
    Posix,
    /// Windows host whose login shell is cmd.exe; `bash` is Git for Windows' bash.
    WinCmd {
        bash: String,
    },
    /// Windows host whose login shell is PowerShell.
    WinPs {
        bash: String,
    },
}

/// The command line handed to the remote login shell.
pub fn remote_command_line(shell: &Shell, script: &str) -> String {
    let b = base64(script.as_bytes());
    match shell {
        Shell::Posix => format!("sh -c 'eval \"$(printf %s {b} | base64 -d)\"'"),
        // `cmd /c` strips the first and last quote of a line with more than two quotes,
        // so the whole command gets one extra pair that cmd removes.
        Shell::WinCmd { bash } => format!("\"\"{bash}\" -c \"source <(echo {b}|base64 -d)\"\""),
        Shell::WinPs { bash } => format!("& '{bash}' -c 'source <(echo {b}|base64 -d)'"),
    }
}

fn ssh_program() -> PathBuf {
    if let Ok(p) = std::env::var("MOBYD_SSH") {
        return PathBuf::from(p);
    }
    for dir in ["/usr/bin", "/opt/homebrew/bin", "/usr/local/bin"] {
        let p = Path::new(dir).join("ssh");
        if p.is_file() {
            return p;
        }
    }
    PathBuf::from(if cfg!(windows) { "ssh.exe" } else { "ssh" })
}

fn control_dir() -> Option<PathBuf> {
    if cfg!(windows) {
        return None; // Win32-OpenSSH has no connection multiplexing
    }
    let user = std::env::var("USER").unwrap_or_else(|_| "user".into());
    // Unix socket paths are limited to ~104 bytes, so stay in /tmp rather than the long per-user temp dir.
    let dir = PathBuf::from(format!("/tmp/mobyd-{user}"));
    if std::fs::create_dir_all(&dir).is_err() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    Some(dir)
}

/// What `ssh -G` resolves for a host alias (cached per alias).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ResolvedHost {
    /// The user's own config already multiplexes this host (we then keep theirs).
    pub multiplexes: bool,
    pub hostname: String,
    pub port: String,
    pub host_key_alias: Option<String>,
    /// Reached through ProxyJump/ProxyCommand: never re-routed.
    pub proxied: bool,
}

pub fn parse_resolved(text: &str) -> ResolvedHost {
    let get = |k: &str| {
        text.lines().find_map(|l| {
            let (key, v) = l.split_once(' ')?;
            key.eq_ignore_ascii_case(k).then(|| v.trim().to_string())
        })
    };
    let master = get("controlmaster").unwrap_or_else(|| "false".into()).to_lowercase();
    let path = get("controlpath").unwrap_or_else(|| "none".into());
    ResolvedHost {
        multiplexes: !matches!(master.as_str(), "false" | "no") && !path.eq_ignore_ascii_case("none"),
        hostname: get("hostname").unwrap_or_default(),
        port: get("port").unwrap_or_else(|| "22".into()),
        host_key_alias: get("hostkeyalias").filter(|a| !a.is_empty() && !a.eq_ignore_ascii_case("none")),
        proxied: ["proxyjump", "proxycommand"].iter().any(|k| get(k).is_some_and(|v| !v.eq_ignore_ascii_case("none"))),
    }
}

fn resolved(host: &str) -> ResolvedHost {
    static CACHE: OnceLock<Mutex<HashMap<String, ResolvedHost>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    if let Some(v) = cache.lock().unwrap().get(host) {
        return v.clone();
    }
    let v = Command::new(ssh_program())
        .args(["-G", "--", host])
        .stdin(Stdio::null())
        .output()
        .map(|o| parse_resolved(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or_default();
    cache.lock().unwrap().insert(host.to_string(), v.clone());
    v
}

/// When the app connects to another address for a host (say the office LAN
/// instead of Tailscale), the server must still prove it is the machine already
/// trusted under the configured name: look its key up under that name.
pub fn host_key_alias_for_override(r: &ResolvedHost, address: &str) -> Option<String> {
    if let Some(a) = &r.host_key_alias {
        return Some(a.clone());
    }
    if r.hostname.is_empty() || r.hostname.eq_ignore_ascii_case(address) {
        return None;
    }
    Some(if r.port == "22" { r.hostname.clone() } else { format!("[{}]:{}", r.hostname, r.port) })
}

// ----- Tailscale fallback ---------------------------------------------------
//
// A host configured with its office address (say 192.168.1.9) is unreachable
// from home, while the same machine answers on its Tailscale address. When the
// configured address does not answer and a Tailscale peer carries the host's
// name, MobyD connects to that peer instead, still checking the host key the
// user already trusts. The choice lasts until a connection fails again.

/// Host alias -> Tailscale address currently used instead of the configured one.
fn ts_route() -> &'static Mutex<HashMap<String, String>> {
    static ROUTE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    ROUTE.get_or_init(Default::default)
}

/// The Tailscale peer that is this host: same name as the ssh alias or as the
/// configured HostName (first DNS label), online. None when ambiguous.
pub fn tailscale_match<'a>(alias: &str, hostname: &str, peers: &'a [TailscalePeer]) -> Option<&'a TailscalePeer> {
    let label = |s: &str| s.split('.').next().unwrap_or_default().to_lowercase();
    let is_ip = hostname.parse::<std::net::IpAddr>().is_ok();
    let want: Vec<String> =
        [Some(alias.to_lowercase()), (!is_ip && !hostname.is_empty()).then(|| label(hostname))].into_iter().flatten().collect();
    let hits: Vec<&TailscalePeer> = peers
        .iter()
        .filter(|p| p.online && p.address != hostname)
        .filter(|p| {
            let names = [Some(p.name.to_lowercase()), p.dns.as_deref().map(label)];
            names.iter().flatten().any(|n| !n.is_empty() && want.contains(n))
        })
        .collect();
    (hits.len() == 1).then(|| hits[0])
}

/// ssh failures that mean "this address does not answer from here".
pub fn is_unreachable(stderr: &[u8]) -> bool {
    let e = String::from_utf8_lossy(stderr).to_lowercase();
    [
        "timed out",
        "no route to host",
        "network is unreachable",
        "could not resolve hostname",
        "connection refused",
        "host is down",
    ]
    .iter()
    .any(|k| e.contains(k))
}

/// Address to dial instead of the configured HostName, if any.
fn route_override(host: &str) -> Option<String> {
    prefs_for(host)
        .address
        .filter(|a| !a.trim().is_empty() && !a.starts_with('-'))
        .map(|a| a.trim().to_string())
        .or_else(|| ts_route().lock().unwrap().get(host).cloned())
}

/// Whether the configured address accepts a TCP connection within `ms`.
fn answers(hostname: &str, port: &str, ms: u64) -> bool {
    use std::net::{TcpStream, ToSocketAddrs};
    let Ok(addrs) = format!("{hostname}:{port}").to_socket_addrs() else { return false };
    addrs.into_iter().any(|a| TcpStream::connect_timeout(&a, std::time::Duration::from_millis(ms)).is_ok())
}

/// Pick the Tailscale route for `host` when its configured address is not
/// reachable from here. Returns true when a new route was chosen.
fn choose_tailscale_route(host: &str, quick_check: bool) -> bool {
    if prefs_for(host).address.is_some_and(|a| !a.trim().is_empty()) {
        return false; // the user's explicit choice wins
    }
    let r = resolved(host);
    if r.proxied || r.hostname.is_empty() {
        return false;
    }
    let peers = tailscale_peers();
    let Some(peer) = tailscale_match(host, &r.hostname, &peers) else { return false };
    if quick_check && answers(&r.hostname, &r.port, 1500) {
        return false;
    }
    ts_route().lock().unwrap().insert(host.to_string(), peer.address.clone());
    true
}

fn ssh_base(host: &str) -> Command {
    let mut cmd = Command::new(ssh_program());
    cmd.args([
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
        "-o",
        "LogLevel=ERROR",
    ]);
    let r = resolved(host);
    if let Some(addr) = route_override(host) {
        let addr = addr.as_str();
        cmd.arg("-o").arg(format!("HostName={addr}"));
        if let Some(alias) = host_key_alias_for_override(&r, addr) {
            cmd.arg("-o").arg(format!("HostKeyAlias={alias}"));
        }
    }
    if !r.multiplexes {
        if let Some(dir) = control_dir() {
            cmd.arg("-o").arg("ControlMaster=auto");
            cmd.arg("-o").arg(format!("ControlPath={}/%C", dir.display()));
            cmd.arg("-o").arg("ControlPersist=600");
        }
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    cmd
}

fn run_ssh(host: &str, remote_cmd: &str, stdin: Option<&[u8]>) -> AppResult<Output> {
    let attempt = || -> AppResult<Output> {
        let mut cmd = ssh_base(host);
        cmd.arg("--").arg(host).arg(remote_cmd);
        if stdin.is_some() {
            cmd.stdin(Stdio::piped());
        }
        let mut child =
            cmd.spawn().map_err(|e| AppError::Git(crate::trf!("ssh를 실행할 수 없습니다: {e}", "Could not run ssh: {e}")))?;
        if let Some(input) = stdin {
            if let Some(mut pipe) = child.stdin.take() {
                pipe.write_all(input)?;
            }
        }
        Ok(child.wait_with_output()?)
    };
    // First contact this session: if the configured address does not answer
    // from this network, go through Tailscale right away (no 10 s timeout).
    static CHECKED: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();
    let first = CHECKED.get_or_init(Default::default).lock().unwrap().insert(host.to_string());
    if first {
        choose_tailscale_route(host, true);
    }
    let out = attempt()?;
    if out.status.code() == Some(255) && out.stdout.is_empty() && is_unreachable(&out.stderr) {
        // The network changed under us: drop a stale Tailscale route, or take one.
        let had = ts_route().lock().unwrap().remove(host).is_some();
        if had || choose_tailscale_route(host, false) {
            return attempt();
        }
    }
    // 255 is ssh's own failure. Retry once (reads only) when a shared connection went stale;
    // an unreachable host is reported right away instead of waiting for a second timeout.
    if out.status.code() == Some(255) && stdin.is_none() && out.stdout.is_empty() && is_stale_connection(&out.stderr) {
        return attempt();
    }
    Ok(out)
}

/// ssh errors that mean "the multiplexed connection died", worth one retry.
pub fn is_stale_connection(stderr: &[u8]) -> bool {
    let e = String::from_utf8_lossy(stderr).to_lowercase();
    ["mux_client", "control socket", "controlsocket", "master", "broken pipe", "connection reset", "connection closed"]
        .iter()
        .any(|k| e.contains(k))
}

pub fn ssh_error(host: &str, out: &Output) -> Option<AppError> {
    if out.status.code() != Some(255) {
        return None;
    }
    let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
    let hint = if err.contains("Permission denied") {
        crate::tr!(" — 키 인증이 필요합니다. ssh-agent에 키를 올리거나 ~/.ssh/config에 IdentityFile을 지정하세요(비밀번호 입력은 지원하지 않습니다).", " — key authentication is required. Add your key to ssh-agent or set IdentityFile in ~/.ssh/config (password prompts are not supported).")
    } else if err.contains("Host key verification failed") {
        crate::tr!(
            " — 터미널에서 한 번 ssh로 접속해 호스트 키를 등록하세요.",
            " — connect once with ssh in a terminal to register the host key."
        )
    } else {
        ""
    };
    Some(AppError::Git(format!(
        "SSH {host}: {}{hint}",
        if err.is_empty() { crate::tr!("연결 실패", "connection failed").to_string() } else { err }
    )))
}

pub const PROBE: &str = "echo __DLP__; uname -s";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeKind {
    Posix,
    Cmd,
    PowerShell,
}

/// Classify the login shell from the output of [`PROBE`]:
/// * cmd.exe has no `;` separator and echoes the rest of the line;
/// * PowerShell ends its own output lines with CRLF (and may still find a
///   Git-for-Windows `uname` on PATH, so the second line alone proves nothing);
/// * POSIX shells (bash, zsh, fish, Git Bash) print `__DLP__\n` and the OS name.
pub fn classify_probe(stdout: &[u8]) -> ProbeKind {
    let text = String::from_utf8_lossy(stdout);
    let mut lines = text.split('\n');
    let first_raw = lines.next().unwrap_or_default();
    let first = first_raw.trim_end_matches('\r').trim();
    let second = lines.next().unwrap_or_default().trim();
    if first.starts_with("__DLP__;") {
        ProbeKind::Cmd
    } else if first_raw.ends_with('\r') {
        ProbeKind::PowerShell
    } else if first == "__DLP__" && !second.is_empty() {
        ProbeKind::Posix
    } else {
        ProbeKind::PowerShell
    }
}

const VERIFY_MARK: &str = "__MOBYD_SHELL_OK__";

/// Run a trivial script through `shell` and check it really executed.
fn verify(host: &str, shell: &Shell) -> bool {
    run_ssh(host, &remote_command_line(shell, &format!("echo {VERIFY_MARK}\n")), None)
        .map(|o| String::from_utf8_lossy(&o.stdout).contains(VERIFY_MARK))
        .unwrap_or(false)
}

/// Order in which to try strategies, best guess first.
pub fn candidate_kinds(first: ProbeKind) -> [ProbeKind; 3] {
    match first {
        ProbeKind::Posix => [ProbeKind::Posix, ProbeKind::PowerShell, ProbeKind::Cmd],
        ProbeKind::Cmd => [ProbeKind::Cmd, ProbeKind::PowerShell, ProbeKind::Posix],
        ProbeKind::PowerShell => [ProbeKind::PowerShell, ProbeKind::Cmd, ProbeKind::Posix],
    }
}

fn win_shell(kind: ProbeKind, bash: &str) -> Shell {
    if kind == ProbeKind::Cmd {
        Shell::WinCmd { bash: bash.to_string() }
    } else {
        Shell::WinPs { bash: bash.to_string() }
    }
}

/// How the far side runs MobyD's scripts, decided once per host. Nothing on
/// the host is reconfigured: whatever its login shell (bash, zsh, fish,
/// cmd.exe, PowerShell, Git Bash), MobyD picks a command line that works
/// there — detected, then proven by actually running a command, with the
/// other strategies (and every Git Bash location found) as fallbacks.
pub fn shell(host: &str) -> AppResult<Shell> {
    if let Some(s) = shell_cache().lock().unwrap().get(host) {
        return Ok(s.clone());
    }
    let pref = prefs_for(host).shell;
    let shell = match pref {
        ShellPref::Posix => Shell::Posix,
        ShellPref::Cmd | ShellPref::Powershell => {
            let kind = if pref == ShellPref::Cmd { ProbeKind::Cmd } else { ProbeKind::PowerShell };
            windows_bash_candidates(host)?.iter().map(|b| win_shell(kind, b)).find(|s| verify(host, s)).ok_or_else(|| {
                AppError::invalid(crate::trf!(
                    "{host}: 지정한 방식({})으로 Git Bash를 실행하지 못했습니다. 환경설정 → SSH 원격에서 '자동 감지'로 두거나 Git for Windows 설치를 확인하세요.", "{host}: could not start Git Bash with the chosen mode ({}). Set it to 'Auto-detect' under Preferences → SSH Remotes, or check the Git for Windows installation.",
                    if pref == ShellPref::Cmd { "Windows cmd" } else { "PowerShell" }
                ))
            })?
        }
        ShellPref::Auto => detect(host)?,
    };
    shell_cache().lock().unwrap().insert(host.to_string(), shell.clone());
    Ok(shell)
}

fn detect(host: &str) -> AppResult<Shell> {
    let out = run_ssh(host, PROBE, None)?;
    if let Some(e) = ssh_error(host, &out) {
        return Err(e);
    }
    let mut bashes: Option<Vec<String>> = None;
    for kind in candidate_kinds(classify_probe(&out.stdout)) {
        let shells: Vec<Shell> = match kind {
            ProbeKind::Posix => vec![Shell::Posix],
            ProbeKind::Cmd | ProbeKind::PowerShell => {
                let list = bashes.get_or_insert_with(|| windows_bash_candidates(host).unwrap_or_default());
                list.iter().map(|b| win_shell(kind, b)).collect()
            }
        };
        if let Some(s) = shells.into_iter().find(|s| verify(host, s)) {
            return Ok(s);
        }
    }
    Err(AppError::invalid(crate::trf!(
        "{host}: 이 호스트에서 명령을 실행할 방법을 찾지 못했습니다. macOS·Linux는 sh, Windows는 Git for Windows가 필요합니다.",
        "{host}: found no way to run commands on this host. macOS/Linux need sh; Windows needs Git for Windows."
    )))
}

/// Human-readable description of how a host is driven (for the SSH settings pane).
pub fn describe(shell: &Shell) -> String {
    match shell {
        Shell::Posix => crate::tr!("POSIX 셸", "POSIX shell").into(),
        Shell::WinCmd { bash } => format!("Windows cmd → {bash}"),
        Shell::WinPs { bash } => format!("Windows PowerShell → {bash}"),
    }
}

/// Every plausible Git Bash: from `where.exe git` (any login shell runs it), then the standard install locations.
fn windows_bash_candidates(host: &str) -> AppResult<Vec<String>> {
    let out = run_ssh(host, "where.exe git", None)?;
    if let Some(e) = ssh_error(host, &out) {
        return Err(e);
    }
    let mut list: Vec<String> = Vec::new();
    for line in String::from_utf8_lossy(&out.stdout).replace('\r', "").lines() {
        if let Some(b) = bash_from_where(line) {
            if !list.contains(&b) {
                list.push(b);
            }
        }
    }
    for std in ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe"] {
        if !list.iter().any(|b| b.eq_ignore_ascii_case(std)) {
            list.push(std.to_string());
        }
    }
    Ok(list)
}

/// Git for Windows' bash from `where.exe git` output. Handles every layout
/// Git for Windows ships: `<root>\cmd\git.exe`, `<root>\bin\git.exe` and
/// `<root>\{mingw64,mingw32,ucrt64,clang64,clangarm64,usr}\bin\git.exe`.
pub fn bash_from_where(text: &str) -> Option<String> {
    for line in text.replace('\r', "").lines() {
        let line = line.trim();
        let parts: Vec<&str> = line.split('\\').collect();
        let n = parts.len();
        if n < 3 || !parts[n - 1].eq_ignore_ascii_case("git.exe") {
            continue;
        }
        let dir = parts[n - 2].to_ascii_lowercase();
        let root_len = match dir.as_str() {
            "cmd" => n - 2,
            "bin"
                if n >= 4
                    && ["mingw64", "mingw32", "ucrt64", "clang64", "clangarm64", "usr"]
                        .contains(&parts[n - 3].to_ascii_lowercase().as_str()) =>
            {
                n - 3
            }
            "bin" => n - 2,
            _ => continue,
        };
        return Some(format!("{}\\bin\\bash.exe", parts[..root_len].join("\\")));
    }
    None
}

/// Longest command line sent as-is. cmd.exe stops at 8191 characters and
/// CreateProcess at 32767, so bigger scripts travel over stdin instead.
pub const MAX_COMMAND_LINE: usize = 6000;

/// Command line that reads exactly `len` bytes of script from stdin, then runs
/// it with stdin closed. It never waits for end-of-input: Windows' OpenSSH server
/// sometimes loses one channel's EOF when several commands share a connection,
/// and a `cat` there would wait (and the app with it) forever.
pub fn stdin_command_line(shell: &Shell, len: usize) -> String {
    match shell {
        Shell::Posix => format!("sh -c 'eval \"$(head -c {len})\" </dev/null'"),
        Shell::WinCmd { bash } => format!("\"\"{bash}\" -c \"source <(head -c {len}) </dev/null\"\""),
        Shell::WinPs { bash } => format!("& '{bash}' -c 'source <(head -c {len}) </dev/null'"),
    }
}

/// A script that carries its own stdin, so nothing on the far side has to read to EOF.
pub fn script_with_stdin(script: &str, stdin: Option<&[u8]>) -> String {
    match stdin {
        None => script.to_string(),
        Some(data) => format!("printf %s '{}' | base64 -d | {{\n{script}\n}}\n", base64(data)),
    }
}

/// The command line and stdin to send for `script`. Short scripts without input
/// go on the command line; everything else is sent as a counted stdin payload.
pub fn invocation(shell: &Shell, script: &str, stdin: Option<&[u8]>) -> (String, Option<Vec<u8>>) {
    if stdin.is_none() {
        let line = remote_command_line(shell, script);
        if line.len() <= MAX_COMMAND_LINE {
            return (line, None);
        }
    }
    let payload = script_with_stdin(script, stdin).into_bytes();
    (stdin_command_line(shell, payload.len()), Some(payload))
}

/// Run a POSIX script on `host`.
pub fn run_script(host: &str, script: &str, stdin: Option<&[u8]>) -> AppResult<Output> {
    let shell = shell(host)?;
    let (line, input) = invocation(&shell, script, stdin);
    let out = run_ssh(host, &line, input.as_deref())?;
    if let Some(e) = ssh_error(host, &out) {
        return Err(e);
    }
    Ok(out)
}

/// Run one git command in a remote repository.
pub fn exec_git(t: &SshTarget, args: &[String], env: &[(&str, &str)], stdin: Option<&[u8]>) -> AppResult<Output> {
    let out = run_script(&t.host, &git_script(&t.path, args, env), stdin)?;
    if out.status.code() == Some(97) {
        return Err(AppError::invalid(crate::trf!(
            "{}: 폴더에 들어갈 수 없습니다: {}",
            "{}: cannot enter the folder: {}",
            t.host,
            t.path
        )));
    }
    Ok(out)
}

// ----- browsing --------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SshHost {
    pub alias: String,
    pub hostname: Option<String>,
    pub user: Option<String>,
    pub port: Option<String>,
    pub other_aliases: Vec<String>,
}

/// Host aliases from an ssh config (Include files are followed, wildcards skipped).
pub fn parse_ssh_config(text: &str, base: &Path, depth: u8, out: &mut Vec<SshHost>) {
    let mut current: Vec<usize> = Vec::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, value) = match line.split_once(|c: char| c.is_whitespace() || c == '=') {
            Some((k, v)) => (k.to_ascii_lowercase(), v.trim().trim_start_matches('=').trim().trim_matches('"').to_string()),
            None => continue,
        };
        match key.as_str() {
            "host" => {
                current.clear();
                let names: Vec<&str> = value.split_whitespace().filter(|n| !n.contains(['*', '?', '!'])).collect();
                if let Some((first, rest)) = names.split_first() {
                    if !out.iter().any(|h| &h.alias == first) {
                        out.push(SshHost {
                            alias: first.to_string(),
                            hostname: None,
                            user: None,
                            port: None,
                            other_aliases: rest.iter().map(|s| s.to_string()).collect(),
                        });
                        current.push(out.len() - 1);
                    }
                }
            }
            "match" => current.clear(),
            "hostname" => current.iter().for_each(|&i| {
                out[i].hostname.get_or_insert(value.clone());
            }),
            "user" => current.iter().for_each(|&i| {
                out[i].user.get_or_insert(value.clone());
            }),
            "port" => current.iter().for_each(|&i| {
                out[i].port.get_or_insert(value.clone());
            }),
            "include" if depth < 4 && current.is_empty() => {
                for pattern in value.split_whitespace() {
                    let pattern = if let Some(rest) = pattern.strip_prefix("~/") {
                        dirs_home().join(rest)
                    } else if Path::new(pattern).is_absolute() {
                        PathBuf::from(pattern)
                    } else {
                        base.join(pattern)
                    };
                    for file in expand_glob(&pattern) {
                        if let Ok(t) = std::fs::read_to_string(&file) {
                            parse_ssh_config(&t, base, depth + 1, out);
                        }
                    }
                }
            }
            _ => {}
        }
    }
}

fn dirs_home() -> PathBuf {
    std::env::var("HOME").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("/"))
}

/// Minimal `*` support in the last path component (enough for `config.d/*`).
fn expand_glob(p: &Path) -> Vec<PathBuf> {
    let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    if !name.contains('*') {
        return vec![p.to_path_buf()];
    }
    let (pre, post) = name.split_once('*').unwrap_or((&name, ""));
    let dir = p.parent().unwrap_or(Path::new("."));
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|f| {
                    let n = f.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                    n.starts_with(pre) && n.ends_with(post) && f.is_file()
                })
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    files
}

pub fn hosts() -> Vec<SshHost> {
    let base = dirs_home().join(".ssh");
    let mut out = Vec::new();
    if let Ok(text) = std::fs::read_to_string(base.join("config")) {
        parse_ssh_config(&text, &base, 0, &mut out);
    }
    out
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub is_repo: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    pub host: String,
    /// Absolute path on the host (Windows hosts report `C:/…`).
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<DirEntry>,
    pub is_repo: bool,
    pub git_version: Option<String>,
    pub os: String,
    /// How MobyD runs commands on this host.
    pub shell: String,
}

pub const LIST_SCRIPT: &str = r#"
P=$(pwd -W 2>/dev/null || pwd)
printf 'PWD\t%s\n' "$P"
printf 'OS\t%s\n' "$(uname -s 2>/dev/null)"
printf 'GIT\t%s\n' "$(git --version 2>/dev/null)"
if [ -e .git ]; then printf 'REPO\t1\n'; fi
for d in * .[!.]*; do
  [ -d "$d" ] || continue
  case "$d" in .git|.Trash|.cache|.npm|node_modules) continue;; esac
  if [ -e "$d/.git" ]; then printf 'D\t1\t%s\n' "$d"; else printf 'D\t0\t%s\n' "$d"; fi
done
"#;

pub fn parse_listing(host: &str, text: &str) -> DirListing {
    let mut l = DirListing {
        host: host.to_string(),
        path: String::new(),
        parent: None,
        entries: vec![],
        is_repo: false,
        git_version: None,
        os: String::new(),
        shell: String::new(),
    };
    for line in text.replace('\r', "").lines() {
        let f: Vec<&str> = line.splitn(3, '\t').collect();
        match f.as_slice() {
            ["PWD", p] => l.path = p.to_string(),
            ["OS", o] => l.os = o.to_string(),
            ["GIT", g] if !g.is_empty() => l.git_version = Some(g.to_string()),
            ["REPO", _] => l.is_repo = true,
            ["D", r, name] => l.entries.push(DirEntry { name: name.to_string(), is_repo: *r == "1" }),
            _ => {}
        }
    }
    l.entries.sort_by(|a, b| {
        let hidden = |n: &str| n.starts_with('.');
        (hidden(&a.name), a.name.to_lowercase()).cmp(&(hidden(&b.name), b.name.to_lowercase()))
    });
    let trimmed = l.path.trim_end_matches('/');
    l.parent = match trimmed.rfind('/') {
        Some(0) if trimmed.len() > 1 => Some("/".into()),
        Some(i) if i > 0 => Some(trimmed[..i].to_string() + if trimmed[..i].ends_with(':') { "/" } else { "" }),
        _ => None,
    };
    l
}

pub fn list_dir(host: &str, path: &str) -> AppResult<DirListing> {
    let mut script = String::from(PRELUDE);
    script.push_str(&cd_line(path));
    script.push_str(LIST_SCRIPT);
    let out = run_script(host, &script, None)?;
    if out.status.code() == Some(97) {
        return Err(AppError::invalid(crate::trf!(
            "{host}: 폴더를 열 수 없습니다: {path}",
            "{host}: cannot open the folder: {path}"
        )));
    }
    let mut l = parse_listing(host, &String::from_utf8_lossy(&out.stdout));
    l.shell = shell(host).map(|s| describe(&s)).unwrap_or_default();
    Ok(l)
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TailscalePeer {
    pub name: String,
    pub address: String,
    /// MagicDNS name without the trailing dot, when MagicDNS is on.
    pub dns: Option<String>,
    pub os: String,
    pub online: bool,
}

/// Peers of the local Tailscale network (empty when Tailscale is not installed).
pub fn tailscale_peers() -> Vec<TailscalePeer> {
    for bin in [
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        "/usr/local/bin/tailscale",
        "/opt/homebrew/bin/tailscale",
        "tailscale",
    ] {
        let Ok(out) = Command::new(bin).args(["status", "--json"]).stdin(Stdio::null()).output() else { continue };
        if out.status.success() {
            return parse_tailscale(&String::from_utf8_lossy(&out.stdout));
        }
    }
    vec![]
}

pub fn parse_tailscale(json: &str) -> Vec<TailscalePeer> {
    let v: serde_json::Value = serde_json::from_str(json).unwrap_or_default();
    let mut out: Vec<TailscalePeer> = v
        .get("Peer")
        .and_then(|p| p.as_object())
        .map(|peers| {
            peers
                .values()
                .filter_map(|p| {
                    let address = p
                        .get("TailscaleIPs")?
                        .as_array()?
                        .iter()
                        .filter_map(|a| a.as_str())
                        .find(|a| !a.contains(':'))?
                        .to_string();
                    Some(TailscalePeer {
                        name: p.get("HostName").and_then(|h| h.as_str()).unwrap_or_default().to_string(),
                        address,
                        dns: p
                            .get("DNSName")
                            .and_then(|d| d.as_str())
                            .map(|d| d.trim_end_matches('.').to_string())
                            .filter(|d| !d.is_empty()),
                        os: p.get("OS").and_then(|o| o.as_str()).unwrap_or_default().to_string(),
                        online: p.get("Online").and_then(|o| o.as_bool()).unwrap_or(false),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort_by_key(|p| (!p.online, p.name.to_lowercase()));
    out
}

/// Open a terminal on the Mac that logs into `host` and changes into `path`.
pub fn terminal_command(host: &str, path: &str) -> String {
    let inner = format!("cd {} 2>/dev/null; exec \"$SHELL\" -l", sh_quote(path));
    // same route as the app's own calls (address override or Tailscale fallback)
    let addr = route_override(host)
        .map(|a| {
            let alias = host_key_alias_for_override(&resolved(host), &a)
                .map(|k| format!("-o HostKeyAlias={} ", sh_quote(&k)))
                .unwrap_or_default();
            format!("-o HostName={} {alias}", sh_quote(&a))
        })
        .unwrap_or_default();
    format!("ssh -t {addr}{} {}", sh_quote(host), sh_quote(&inner))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ssh_uris() {
        let t = parse(Path::new("ssh://studio/Users/me/repo")).unwrap();
        assert_eq!(t, SshTarget { host: "studio".into(), path: "/Users/me/repo".into() });
        let w = parse(Path::new("ssh://pc/C:/Users/me/repo")).unwrap();
        assert_eq!(w.path, "C:/Users/me/repo");
        assert_eq!(uri("studio", "/Users/me/repo"), "ssh://studio/Users/me/repo");
        assert_eq!(uri("pc", "C:/x"), "ssh://pc/C:/x");
        assert!(parse(Path::new("/local/path")).is_none());
        assert!(is_remote(Path::new("ssh://h/x")));
    }

    #[test]
    fn quotes_for_posix_shells() {
        assert_eq!(sh_quote("main"), "main");
        assert_eq!(sh_quote("--format=%H%x1f"), "--format=%H%x1f");
        assert_eq!(sh_quote("a b"), "'a b'");
        assert_eq!(sh_quote("it's"), "'it'\"'\"'s'");
        assert_eq!(sh_quote(""), "''");
        assert_eq!(sh_quote("$(rm -rf /)"), "'$(rm -rf /)'");
    }

    #[test]
    fn base64_matches_reference() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64("돌고래".as_bytes()), "64+M6rOg656Y");
    }

    #[test]
    fn builds_shell_neutral_command_lines() {
        let posix = remote_command_line(&Shell::Posix, "echo hi\n");
        assert!(posix.starts_with("sh -c 'eval \"$(printf %s "));
        assert_eq!(posix.matches('\'').count(), 2, "only the outer quotes: the payload is base64");
        let cmd = remote_command_line(&Shell::WinCmd { bash: "C:\\Program Files\\Git\\bin\\bash.exe".into() }, "x");
        assert!(cmd.starts_with("\"\"C:\\Program Files\\Git\\bin\\bash.exe\" -c \"source <(echo "));
        assert!(cmd.ends_with("|base64 -d)\"\""));
        let ps = remote_command_line(&Shell::WinPs { bash: "C:\\Git\\bin\\bash.exe".into() }, "x");
        assert!(ps.starts_with("& 'C:\\Git\\bin\\bash.exe' -c 'source"));
    }

    #[test]
    fn git_script_quotes_every_argument() {
        let s = git_script("/srv/my repo", &["log".into(), "--format=%s".into(), "a b".into()], &[("GIT_OPTIONAL_LOCKS", "0")]);
        assert!(s.contains("cd -- '/srv/my repo' || exit 97"));
        assert!(s.contains("export GIT_OPTIONAL_LOCKS=0"));
        assert!(s.trim_end().ends_with("log --format=%s 'a b'"));
        assert!(git_script("~/code/x", &[], &[]).contains("cd -- \"$HOME\"/code/x"));
    }

    #[test]
    fn oversized_scripts_and_input_travel_as_counted_stdin() {
        let bash = "C:\\Program Files\\Git\\bin\\bash.exe".to_string();
        for shell in [Shell::Posix, Shell::WinCmd { bash: bash.clone() }, Shell::WinPs { bash }] {
            // short and no input: command line only, nothing on stdin
            let (line, input) = invocation(&shell, "echo hi\n", None);
            assert!(input.is_none() && line.len() < 200, "{line}");
            // input is folded into the script, so the far side never reads to EOF
            let (line, input) = invocation(&shell, "echo hi\n", Some(b"data"));
            let sent = input.unwrap();
            assert!(line.contains(&format!("head -c {}", sent.len())) && !line.contains("cat"), "{line}");
            assert!(String::from_utf8(sent).unwrap().starts_with("printf %s 'ZGF0YQ==' | base64 -d | {\necho hi"));
            let big = format!("# {}\ncat\n", "x".repeat(MAX_COMMAND_LINE));
            let (line, input) = invocation(&shell, &big, Some(b"it's \"in\""));
            assert!(line.len() < 100 && line.contains("</dev/null"), "{line}");
            let sent = String::from_utf8(input.unwrap()).unwrap();
            assert!(sent.starts_with("printf %s 'aXQncyAiaW4i' | base64 -d | {\n# xxx"));
            let (line, input) = invocation(&shell, &big, None);
            assert!(line.contains(&format!("head -c {}", big.len())), "{line}");
            assert_eq!(input.unwrap(), big.as_bytes());
        }
    }

    #[test]
    fn finds_the_tailscale_peer_for_a_host() {
        let peer = |name: &str, dns: &str, ip: &str, online: bool| TailscalePeer {
            name: name.into(),
            address: ip.into(),
            dns: Some(dns.into()),
            os: "windows".into(),
            online,
        };
        let peers = vec![
            peer("office-pc", "office-pc.tail.ts.net", "100.64.0.20", true),
            peer("DESKTOP-AB12CDE", "desktop-ab12cde.tail.ts.net", "100.64.0.55", true),
            peer("old-box", "old-box.tail.ts.net", "100.1.1.1", false),
        ];
        // alias = peer name, configured with an office IP
        assert_eq!(tailscale_match("office-pc", "192.168.1.9", &peers).map(|p| p.address.as_str()), Some("100.64.0.20"));
        assert_eq!(tailscale_match("Office-PC", "192.168.1.9", &peers).map(|p| p.address.as_str()), Some("100.64.0.20"));
        // configured HostName names the machine
        assert_eq!(tailscale_match("devbox", "desktop-ab12cde.lan", &peers).map(|p| p.address.as_str()), Some("100.64.0.55"));
        // offline, unknown, or already the Tailscale address: no re-route
        assert!(tailscale_match("old-box", "10.0.0.2", &peers).is_none());
        assert!(tailscale_match("studio", "192.168.0.30", &peers).is_none());
        assert!(tailscale_match("office-pc", "100.64.0.20", &peers).is_none());
        assert!(is_unreachable(b"ssh: connect to host 192.168.1.9 port 22: Operation timed out\r\n"));
        assert!(is_unreachable(b"ssh: connect to host 192.168.1.9 port 22: No route to host"));
        assert!(!is_unreachable(b"Permission denied (publickey)."));
        assert!(parse_resolved("hostname a\nproxyjump bastion\n").proxied);
        assert!(!parse_resolved("hostname a\nproxyjump none\n").proxied);
    }

    #[test]
    fn address_override_keeps_the_trusted_host_key() {
        let r =
            parse_resolved("user noah\nhostname desktop-x.tailnet.ts.net\nport 8702\ncontrolmaster false\ncontrolpath none\n");
        assert!(!r.multiplexes);
        assert_eq!(host_key_alias_for_override(&r, "192.168.1.5").as_deref(), Some("[desktop-x.tailnet.ts.net]:8702"));
        let r22 = parse_resolved("hostname pc.lan\nport 22\n");
        assert_eq!(host_key_alias_for_override(&r22, "10.0.0.5").as_deref(), Some("pc.lan"));
        assert_eq!(host_key_alias_for_override(&r22, "pc.lan"), None);
        let own = parse_resolved("hostname pc.lan\nport 22\nhostkeyalias mypc\ncontrolmaster auto\ncontrolpath ~/.ssh/cm-%C\n");
        assert!(own.multiplexes);
        assert_eq!(host_key_alias_for_override(&own, "10.0.0.5").as_deref(), Some("mypc"));
    }

    #[test]
    fn tries_the_detected_strategy_first() {
        assert_eq!(candidate_kinds(ProbeKind::Cmd)[0], ProbeKind::Cmd);
        assert_eq!(candidate_kinds(ProbeKind::PowerShell), [ProbeKind::PowerShell, ProbeKind::Cmd, ProbeKind::Posix]);
        assert_eq!(candidate_kinds(ProbeKind::Posix)[0], ProbeKind::Posix);
    }

    #[test]
    fn parses_tailscale_status() {
        let json = r#"{"Peer":{"a":{"HostName":"office-pc","DNSName":"office-pc.example.ts.net.","TailscaleIPs":["100.64.0.20","fd7a::1"],"OS":"windows","Online":true},
                              "b":{"HostName":"old-phone","TailscaleIPs":["100.1.1.1"],"OS":"iOS","Online":false}}}"#;
        let peers = parse_tailscale(json);
        assert_eq!(
            peers[0],
            TailscalePeer {
                name: "office-pc".into(),
                address: "100.64.0.20".into(),
                dns: Some("office-pc.example.ts.net".into()),
                os: "windows".into(),
                online: true
            }
        );
        assert!(!peers[1].online && peers[1].dns.is_none());
        assert!(parse_tailscale("not json").is_empty());
    }

    #[test]
    fn classifies_real_probe_output() {
        // bytes captured from a Windows 11 host running the probe under each shell
        assert_eq!(classify_probe(b"__DLP__; uname -s\r\n"), ProbeKind::Cmd);
        assert_eq!(classify_probe(b"__DLP__\r\nMINGW64_NT-10.0-26200\n"), ProbeKind::PowerShell);
        assert_eq!(classify_probe(b"__DLP__\nMINGW64_NT-10.0-26200\n"), ProbeKind::Posix);
        assert_eq!(classify_probe(b"__DLP__\nDarwin\n"), ProbeKind::Posix);
        assert_eq!(classify_probe(b"__DLP__\r\n"), ProbeKind::PowerShell, "PowerShell without uname on PATH");
    }

    #[test]
    fn finds_git_bash_from_where_output() {
        // real `where.exe git` output from a Windows 11 host (first hit is mingw64)
        let out = "C:\\Program Files\\Git\\mingw64\\bin\\git.exe\r\nC:\\Program Files\\Git\\cmd\\git.exe\r\n";
        assert_eq!(bash_from_where(out).as_deref(), Some("C:\\Program Files\\Git\\bin\\bash.exe"));
        assert_eq!(bash_from_where("D:\\Tools\\Git\\cmd\\git.exe").as_deref(), Some("D:\\Tools\\Git\\bin\\bash.exe"));
        assert_eq!(bash_from_where("INFO: Could not find files"), None);
        // newer Git for Windows (ucrt64) in a custom location, real output from a Windows 10 host
        let custom = "C:\\ProgramData\\CodexRemote\\git-2.56.0.4\\ucrt64\\bin\\git.exe\r\nC:\\ProgramData\\CodexRemote\\git-2.56.0.4\\bin\\git.exe\r\n";
        assert_eq!(bash_from_where(custom).as_deref(), Some("C:\\ProgramData\\CodexRemote\\git-2.56.0.4\\bin\\bash.exe"));
    }

    /// `MOBYD_WINLINES_OUT=<dir>` writes the exact cmd.exe / PowerShell command
    /// lines for a probe script, to be executed on a real Windows host.
    #[test]
    #[ignore]
    fn write_windows_command_lines() {
        let dir = std::path::PathBuf::from(std::env::var("MOBYD_WINLINES_OUT").unwrap());
        let bash = std::env::var("MOBYD_WINBASH").unwrap_or_else(|_| "C:\\Program Files\\Git\\bin\\bash.exe".to_string());
        let mut list = String::from(PRELUDE);
        list.push_str(&cd_line(""));
        list.push_str(LIST_SCRIPT);
        let git = git_script("", &["-c".into(), "x.y=it's \"quoted\" $HOME %PATH%".into(), "config".into(), "x.y".into()], &[]);
        for (name, script) in [("list", list), ("git", git)] {
            std::fs::write(dir.join(format!("{name}.cmd")), remote_command_line(&Shell::WinCmd { bash: bash.clone() }, &script))
                .unwrap();
            std::fs::write(dir.join(format!("{name}.ps1")), remote_command_line(&Shell::WinPs { bash: bash.clone() }, &script))
                .unwrap();
        }
    }

    #[test]
    fn retries_only_stale_connections() {
        assert!(is_stale_connection(b"mux_client_request_session: read from master failed: Broken pipe"));
        assert!(is_stale_connection(b"Control socket connect(/tmp/x): Connection refused"));
        assert!(!is_stale_connection(b"ssh: connect to host 10.0.0.1 port 22: Operation timed out"));
        assert!(!is_stale_connection(b"Permission denied (publickey)."));
    }

    #[test]
    fn parses_ssh_config_hosts() {
        let cfg = "Host *\n  ServerAliveInterval 30\nHost studio studio-vscode\n  HostName example.com\n  Port 8701\n  User me\n\
                   Host pc 192.168.0.7\n  HostName=10.0.0.2\n  User \"First Last\"\nMatch host x\n  User nobody\n";
        let mut out = vec![];
        parse_ssh_config(cfg, Path::new("/nonexistent"), 0, &mut out);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].alias, "studio");
        assert_eq!(out[0].other_aliases, vec!["studio-vscode"]);
        assert_eq!(out[0].port.as_deref(), Some("8701"));
        assert_eq!(out[1].user.as_deref(), Some("First Last"));
        assert_eq!(out[1].hostname.as_deref(), Some("10.0.0.2"));
    }

    #[test]
    fn parses_directory_listing() {
        let text = "PWD\t/Users/me/code\nOS\tDarwin\nGIT\tgit version 2.50.1\nD\t0\tnotes\nD\t1\tmobyd\nD\t0\t.config\n";
        let l = parse_listing("studio", text);
        assert_eq!(l.path, "/Users/me/code");
        assert_eq!(l.parent.as_deref(), Some("/Users/me"));
        assert_eq!(l.entries.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), vec!["mobyd", "notes", ".config"]);
        assert!(l.entries[0].is_repo);
        let w = parse_listing("pc", "PWD\tC:/Users\r\n");
        assert_eq!(w.parent.as_deref(), Some("C:/"));
        assert_eq!(parse_listing("h", "PWD\t/\n").parent, None);
        assert_eq!(parse_listing("h", "PWD\t/home\n").parent.as_deref(), Some("/"));
    }
}
