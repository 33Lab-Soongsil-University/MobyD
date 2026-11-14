//! Thin wrapper around the `git` executable — local or on an SSH host.
//!
//! MobyD shells out to the git CLI instead of linking libgit2 so that every
//! feature the user's git supports (worktrees, credential helpers, hooks, SSH
//! agents, signing) behaves exactly as it does in their terminal. A repository
//! path of the form `ssh://host/path` runs the same commands on that host
//! (see [`super::remote`]).

use std::ffi::{OsStr, OsString};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::OnceLock;

use super::remote;
use crate::error::{AppError, AppResult};

static GIT_BIN: OnceLock<PathBuf> = OnceLock::new();
static EXTRA_PATH: OnceLock<String> = OnceLock::new();

/// Directories GUI apps on macOS usually miss from PATH. Git hooks and
/// credential helpers (`gh`, `git-credential-manager`, `git-lfs`) live here.
const EXTRA_DIRS: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];

pub fn search_path() -> &'static str {
    EXTRA_PATH.get_or_init(|| {
        let mut parts: Vec<String> = std::env::var("PATH")
            .unwrap_or_default()
            .split(if cfg!(windows) { ';' } else { ':' })
            .filter(|s| !s.is_empty())
            .map(String::from)
            .collect();
        if !cfg!(windows) {
            for d in EXTRA_DIRS {
                if !parts.iter().any(|p| p == d) {
                    parts.push((*d).to_string());
                }
            }
        }
        parts.join(if cfg!(windows) { ";" } else { ":" })
    })
}

/// Locate the git binary once. Homebrew git is preferred over the Xcode shim.
pub fn git_bin() -> &'static Path {
    GIT_BIN.get_or_init(|| {
        if let Ok(p) = std::env::var("MOBYD_GIT") {
            return PathBuf::from(p);
        }
        let exe = if cfg!(windows) { "git.exe" } else { "git" };
        let sep = if cfg!(windows) { ';' } else { ':' };
        for dir in search_path().split(sep) {
            let candidate = Path::new(dir).join(exe);
            if candidate.is_file() {
                return candidate;
            }
        }
        PathBuf::from(exe)
    })
}

pub fn is_remote(repo: &Path) -> bool {
    remote::is_remote(repo)
}

/// Build a local git command with stable, non-interactive settings.
fn local_command(repo: &Path) -> Command {
    let mut cmd = Command::new(git_bin());
    cmd.current_dir(repo)
        .env("PATH", search_path())
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_EDITOR", "true")
        .env("GIT_SEQUENCE_EDITOR", "true")
        .env("GIT_MERGE_AUTOEDIT", "no")
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .args(["-c", "core.quotepath=false", "-c", "color.ui=false", "-c", "advice.detachedHead=false"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn to_strings(args: &[OsString]) -> Vec<String> {
    args.iter().map(|a| a.to_string_lossy().into_owned()).collect()
}

/// Core: run git with extra environment and optional stdin, locally or remotely.
pub fn exec(repo: &Path, args: &[OsString], env: &[(&str, &str)], stdin: Option<&[u8]>) -> AppResult<Output> {
    if let Some(t) = remote::parse(repo) {
        return remote::exec_git(&t, &to_strings(args), env, stdin);
    }
    let mut cmd = local_command(repo);
    cmd.envs(env.iter().copied()).args(args);
    if stdin.is_some() {
        cmd.stdin(Stdio::piped());
    }
    let mut child = cmd.spawn().map_err(|e| {
        AppError::Git(crate::trf!("git을 실행할 수 없습니다 ({}): {e}", "Could not run git ({}): {e}", git_bin().display()))
    })?;
    if let Some(input) = stdin {
        if let Some(mut pipe) = child.stdin.take() {
            pipe.write_all(input)?;
        }
    }
    Ok(child.wait_with_output()?)
}

fn collect<I, S>(args: I) -> Vec<OsString>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    args.into_iter().map(|a| a.as_ref().to_os_string()).collect()
}

/// Add a plain-language hint for common git failures.
pub fn explain(text: &str) -> String {
    let hint = if text.contains("Please tell me who you are") || text.contains("unable to auto-detect email address") {
        Some(crate::tr!("이 저장소가 있는 PC에 git 사용자 이름·이메일이 설정되어 있지 않습니다. 그 PC에서 `git config --global user.name \"이름\"`과 `git config --global user.email \"메일\"`을 설정하세요.", "Git user name and email are not set on the PC that holds this repository. On that PC run `git config --global user.name \"Name\"` and `git config --global user.email \"mail\"`."))
    } else if text.contains("Permission denied (publickey)") {
        Some(crate::tr!(
            "SSH 키 인증에 실패했습니다. ssh-agent에 키를 올리거나 ~/.ssh/config의 IdentityFile을 확인하세요.",
            "SSH key authentication failed. Add your key to ssh-agent or check IdentityFile in ~/.ssh/config."
        ))
    } else if text.contains("could not read Username") || text.contains("Authentication failed") {
        Some(crate::tr!(
            "원격 저장소 인증이 필요합니다. 환경설정 → 통합에서 계정에 로그인하거나 SSH 주소를 사용하세요.",
            "The remote requires authentication. Sign in to an account under Preferences → Integrations, or use an SSH URL."
        ))
    } else {
        None
    };
    match hint {
        Some(h) => format!("{h}\n\n{text}"),
        None => text.to_string(),
    }
}

fn describe_failure(args: &[OsString], out: &Output) -> AppError {
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let sub = args.iter().map(|a| a.to_string_lossy().to_string()).find(|a| !a.starts_with('-')).unwrap_or_default();
    let detail = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        format!("exit status {}", out.status.code().unwrap_or(-1))
    };
    AppError::Git(format!("git {sub}: {}", explain(&detail)))
}

/// Run git with extra env; non-zero exit codes outside `ok_codes` fail.
pub fn run_raw_env<I, S>(repo: &Path, args: I, env: &[(&str, &str)], stdin: Option<&[u8]>, ok_codes: &[i32]) -> AppResult<Vec<u8>>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let args = collect(args);
    let out = exec(repo, &args, env, stdin)?;
    let code = out.status.code().unwrap_or(-1);
    if out.status.success() || ok_codes.contains(&code) {
        Ok(out.stdout)
    } else {
        Err(describe_failure(&args, &out))
    }
}

/// Run git and return raw stdout bytes.
pub fn run_raw<I, S>(repo: &Path, args: I, stdin: Option<&[u8]>, ok_codes: &[i32]) -> AppResult<Vec<u8>>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    run_raw_env(repo, args, &[], stdin, ok_codes)
}

/// Run git and return stdout as (lossy) UTF-8.
pub fn run<I, S>(repo: &Path, args: I) -> AppResult<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    run_raw(repo, args, None, &[]).map(|b| String::from_utf8_lossy(&b).into_owned())
}

/// Run git, feeding `input` on stdin.
pub fn run_stdin<I, S>(repo: &Path, args: I, input: &[u8]) -> AppResult<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    run_raw(repo, args, Some(input), &[]).map(|b| String::from_utf8_lossy(&b).into_owned())
}

/// Run git and report only whether it succeeded.
pub fn succeeds<I, S>(repo: &Path, args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    exec(repo, &collect(args), &[], None).map(|o| o.status.success()).unwrap_or(false)
}

/// Combined stdout+stderr of a command that is allowed to fail (merge, rebase …),
/// returning `(success, text)`.
pub fn run_report_env<I, S>(repo: &Path, args: I, env: &[(&str, &str)], stdin: Option<&[u8]>) -> AppResult<(bool, String)>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let out = exec(repo, &collect(args), env, stdin)?;
    let mut text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if !err.is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&err);
    }
    let text = if out.status.success() { text } else { explain(&text) };
    Ok((out.status.success(), text))
}

pub fn run_report<I, S>(repo: &Path, args: I) -> AppResult<(bool, String)>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    run_report_env(repo, args, &[], None)
}

pub fn git_version() -> Option<String> {
    Command::new(git_bin())
        .arg("--version")
        .env("PATH", search_path())
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
}

// ----- batches -----------------------------------------------------------------

/// Placeholder argument replaced by `HEAD` only when HEAD points at a commit.
pub const HEAD_IF_VALID: &str = "@HEAD_IF_VALID@";

/// One read in a [`batch`].
#[derive(Debug, Clone)]
pub enum Item {
    Git {
        args: Vec<String>,
        env: Vec<(&'static str, &'static str)>,
    },
    /// Contents of `$(git rev-parse --git-path NAME)`, empty when missing.
    GitFile(&'static str),
    /// Exit code 0 when `$(git rev-parse --git-path NAME)` is a directory.
    GitDir(&'static str),
}

impl Item {
    pub fn git(args: &[&str]) -> Item {
        Item::Git { args: args.iter().map(|s| s.to_string()).collect(), env: vec![] }
    }
    pub fn git_owned(args: Vec<String>) -> Item {
        Item::Git { args, env: vec![] }
    }
    pub fn git_env(args: &[&str], env: &[(&'static str, &'static str)]) -> Item {
        Item::Git { args: args.iter().map(|s| s.to_string()).collect(), env: env.to_vec() }
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ItemOut {
    pub code: i32,
    pub out: Vec<u8>,
}

impl ItemOut {
    pub fn ok(&self) -> bool {
        self.code == 0
    }
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.out).into_owned()
    }
}

/// Run several read-only commands. Remote repositories get them in one SSH
/// round trip; failures are reported per item instead of aborting the batch.
pub fn batch(repo: &Path, items: &[Item]) -> AppResult<Vec<ItemOut>> {
    match remote::parse(repo) {
        Some(t) => batch_remote(&t, items),
        None => batch_local(repo, items),
    }
}

fn batch_local(repo: &Path, items: &[Item]) -> AppResult<Vec<ItemOut>> {
    let has_head = items.iter().any(|i| matches!(i, Item::Git { args, .. } if args.iter().any(|a| a == HEAD_IF_VALID)))
        && succeeds(repo, ["rev-parse", "-q", "--verify", "HEAD^{commit}"]);
    let git_dir = if items.iter().any(|i| !matches!(i, Item::Git { .. })) {
        exec(repo, &["rev-parse".into(), "--absolute-git-dir".into()], &[], None)
            .ok()
            .map(|o| PathBuf::from(String::from_utf8_lossy(&o.stdout).trim()))
    } else {
        None
    };
    let run_one = |item: &Item| -> AppResult<ItemOut> {
        Ok(match item {
            Item::Git { args, env } => {
                let a: Vec<OsString> = args
                    .iter()
                    .filter(|arg| *arg != HEAD_IF_VALID || has_head)
                    .map(|arg| if arg == HEAD_IF_VALID { "HEAD".into() } else { arg.into() })
                    .collect();
                let o = exec(repo, &a, env, None)?;
                ItemOut { code: o.status.code().unwrap_or(-1), out: o.stdout }
            }
            Item::GitFile(name) => match git_dir.as_ref().map(|g| std::fs::read(g.join(name))) {
                Some(Ok(b)) => ItemOut { code: 0, out: b },
                _ => ItemOut { code: 1, out: vec![] },
            },
            Item::GitDir(name) => {
                let is_dir = git_dir.as_ref().is_some_and(|g| g.join(name).is_dir());
                ItemOut { code: if is_dir { 0 } else { 1 }, out: vec![] }
            }
        })
    };
    // Independent read-only commands: run them side by side.
    let results: Vec<AppResult<ItemOut>> = std::thread::scope(|scope| {
        let handles: Vec<_> = items.iter().map(|item| scope.spawn(move || run_one(item))).collect();
        handles.into_iter().map(|h| h.join().unwrap_or_else(|_| Err(AppError::invalid("git worker panicked")))).collect()
    });
    results.into_iter().collect()
}

/// Build the POSIX script for a remote batch. Git commands run in parallel
/// on the far side; every item leaves its output and a boundary marker in
/// files, and one final `cat` streams them in order (arbitrary, even
/// NUL-containing, output survives). Process count is kept low on purpose:
/// on Windows (Git Bash) every fork costs tens of milliseconds.
/// `GitFile`/`GitDir` names are per-worktree files under `--absolute-git-dir`.
pub fn batch_script(path: &str, items: &[Item], boundary: &str) -> String {
    let mut s = String::from(remote::PRELUDE);
    s.push_str(&remote::cd_line(path));
    s.push_str(&format!("B={boundary}\n"));
    s.push_str("T=$(mktemp -d 2>/dev/null || mktemp -d -t mobyd) || exit 96\n");
    s.push_str("G=$(git rev-parse --absolute-git-dir 2>/dev/null)\n");
    s.push_str("H=; git rev-parse -q --verify 'HEAD^{commit}' >/dev/null 2>&1 && H=HEAD\n");
    let mut files: Vec<String> = Vec::with_capacity(items.len() * 2);
    for (i, item) in items.iter().enumerate() {
        let mark = format!("printf '\\n%s %s\\n' \"$B\" \"$c\" >\"$T/{i}.m\"");
        match item {
            Item::Git { args, env } => {
                s.push_str("{ ");
                for (k, v) in env {
                    s.push_str(&format!("{k}={} ", remote::sh_quote(v)));
                }
                s.push_str(remote::GIT_OPTS);
                for a in args {
                    s.push(' ');
                    if a == HEAD_IF_VALID {
                        s.push_str("$H");
                    } else {
                        s.push_str(&remote::sh_quote(a));
                    }
                }
                s.push_str(&format!(" >\"$T/{i}\" 2>/dev/null; c=$?; {mark}; }} &\n"));
                files.push(format!("\"$T/{i}\""));
            }
            Item::GitFile(name) => {
                s.push_str(&format!(
                    "if [ -f \"$G/{name}\" ]; then F{i}=\"$G/{name}\"; c=0; else F{i}=/dev/null; c=1; fi; {mark}\n"
                ));
                files.push(format!("\"$F{i}\""));
            }
            Item::GitDir(name) => {
                s.push_str(&format!("if [ -d \"$G/{name}\" ]; then c=0; else c=1; fi; {mark}\n"));
            }
        }
        files.push(format!("\"$T/{i}.m\""));
    }
    s.push_str("wait\n");
    s.push_str(&format!("cat -- {}\n", files.join(" ")));
    s.push_str("rm -rf -- \"$T\"\n");
    s
}

/// Split remote batch output back into per-item results.
pub fn parse_batch(raw: &[u8], boundary: &str, count: usize) -> Vec<ItemOut> {
    let marker = format!("\n{boundary} ");
    let m = marker.as_bytes();
    let mut out = Vec::with_capacity(count);
    let mut pos = 0;
    while out.len() < count {
        let Some(idx) = raw[pos..].windows(m.len()).position(|w| w == m) else { break };
        let start = pos + idx;
        let data = raw[pos..start].to_vec();
        let code_start = start + m.len();
        let code_end = raw[code_start..].iter().position(|&b| b == b'\n').map(|i| code_start + i).unwrap_or(raw.len());
        let code = String::from_utf8_lossy(&raw[code_start..code_end]).trim().parse().unwrap_or(-1);
        out.push(ItemOut { code, out: data });
        pos = (code_end + 1).min(raw.len());
    }
    while out.len() < count {
        out.push(ItemOut { code: -1, out: vec![] });
    }
    out
}

fn boundary() -> String {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("__MOBYD_{:x}_{:x}__", nanos, std::process::id())
}

fn batch_remote(t: &remote::SshTarget, items: &[Item]) -> AppResult<Vec<ItemOut>> {
    let b = boundary();
    let out = remote::run_script(&t.host, &batch_script(&t.path, items, &b), None)?;
    if out.status.code() == Some(97) {
        return Err(AppError::invalid(crate::trf!(
            "{}: 폴더에 들어갈 수 없습니다: {}",
            "{}: cannot enter the folder: {}",
            t.host,
            t.path
        )));
    }
    Ok(parse_batch(&out.stdout, &b, items.len()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn batch_output_round_trips_binary_data() {
        let b = "__MOBYD_x__";
        let raw = [
            b"one\0two".as_slice(),
            format!("\n{b} 0\n").as_bytes(),
            b"".as_slice(),
            format!("\n{b} 1\n").as_bytes(),
            b"line\n".as_slice(),
            format!("\n{b} 0\n").as_bytes(),
        ]
        .concat();
        let parts = parse_batch(&raw, b, 4);
        assert_eq!(parts[0], ItemOut { code: 0, out: b"one\0two".to_vec() });
        assert_eq!(parts[1], ItemOut { code: 1, out: vec![] });
        assert_eq!(parts[2], ItemOut { code: 0, out: b"line\n".to_vec() });
        assert_eq!(parts[3].code, -1, "missing items are reported, not invented");
    }

    #[test]
    fn explains_missing_identity() {
        let t = explain("*** Please tell me who you are.\n\nRun\n  git config --global user.email");
        assert!(t.starts_with("이 저장소가 있는 PC에 git 사용자 이름"));
        assert_eq!(explain("plain"), "plain");
    }

    #[test]
    fn batch_script_shape() {
        let s = batch_script(
            "/r",
            &[
                Item::git(&["log", HEAD_IF_VALID, "--"]),
                Item::git_env(&["status"], &[("GIT_OPTIONAL_LOCKS", "0")]),
                Item::GitFile("MERGE_MSG"),
                Item::GitDir("rebase-merge"),
            ],
            "BND",
        );
        assert!(s.contains("log $H -- >\"$T/0\" 2>/dev/null; c=$?; printf"));
        assert!(s.contains("{ GIT_OPTIONAL_LOCKS=0 git -c"));
        assert!(s.contains("F2=\"$G/MERGE_MSG\""));
        assert!(s.contains("[ -d \"$G/rebase-merge\" ]"));
        assert!(s.contains("wait\ncat -- \"$T/0\" \"$T/0.m\" \"$T/1\" \"$T/1.m\" \"$F2\" \"$T/2.m\" \"$T/3.m\"\n"));
        assert_eq!(s.matches("cat ").count(), 1, "a single cat process collects everything");
    }
}
