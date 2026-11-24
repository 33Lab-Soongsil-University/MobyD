<p align="center">
  <img src="public/mobyd.svg" width="96" alt="MobyD logo" />
</p>

<h1 align="center">MobyD</h1>

<p align="center">
  A fast, native Git client for macOS — with repositories on your other machines, over SSH.
</p>

<p align="center">
  <a href="https://github.com/gyeongjin-kim/MobyD-releases/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/gyeongjin-kim/MobyD-releases?label=release&color=2ed3e6"></a>
  <a href="https://github.com/33Lab-Soongsil-University/MobyD/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/33Lab-Soongsil-University/MobyD/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20(Apple%20silicon)-lightgrey">
</p>

<p align="center">
  <a href="https://github.com/gyeongjin-kim/MobyD-releases/releases/latest/download/MobyD-macOS-arm64.dmg"><b>⬇ Download MobyD for macOS (.dmg)</b></a>
</p>

<p align="center">
  <img src="docs/screenshots/graph.png" alt="MobyD commit graph with branches, tags, a stash and work in progress" />
</p>

---

## Why "MobyD"?

GitKraken is named after the **Kraken**, the giant squid of sea legend. The giant squid has exactly one natural enemy: the **sperm whale**. The most famous sperm whale of all is **Moby Dick**, the white whale — hence **MobyD**. The logo is that whale seen from far below, hanging upright in the deep under rings of light from the surface, with commits riding the rings.

MobyD started as an answer to the things we kept running into with GitKraken: it is heavy (a full Electron app), and it cannot work on a repository that lives on *another* computer. MobyD is a small native app (~7 MB) that treats a repository on your SSH-reachable PC the same as one on your laptop.

## Features

- **Commit graph** — coloured lanes, merge curves, branch / tag / remote labels, WIP and stash nodes, smooth scrolling through thousands of commits.
- **Everyday Git** — stage files, hunks or single lines; commit and amend; branch, merge, rebase, cherry-pick, revert, reset, tags, stash, fetch / pull / push.
- **Interactive rebase** — pick, reword, edit, squash, fixup, drop, drag to reorder.
- **Undo / Redo** (⌘Z / ⇧⌘Z) for commits, checkouts, merges, rebases, resets, branch and tag changes.
- **Blame** and **file history**.
- **Worktrees** — list, add, open in a new tab, lock, remove.
- **GitHub, GitLab and Gitea / Forgejo** — sign in with the browser (GitHub) or a token, see every repository your account can reach and clone many at once; list, create, review and merge pull requests.
- **Dark and light themes**, or follow the system. English and Korean UI.
- **Updates itself** — one click installs a new version and restarts.
- **Always know where you are** — the commit your folder has checked out is ringed and marked with an icon (hover it for the branch and folder), commits other worktrees have checked out get their own icon, and a button brings you back when you scroll away.
- **Guided tour** — a step-by-step walk through the basics on first launch; take it again from the **?** in the top bar or ⌘K.
- **Command palette** (⌘K), readable error messages instead of raw Git output, `mobyd://` links to open a repository from a web page.

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/stage.png" alt="Reviewing a change and staging a single hunk" /></td>
    <td width="50%"><img src="docs/screenshots/rebase.png" alt="Interactive rebase with pick, fixup and reword" /></td>
  </tr>
  <tr>
    <td align="center"><sub>Review changes and stage a hunk or a line</sub></td>
    <td align="center"><sub>Interactive rebase — reorder, reword, squash, fixup, drop</sub></td>
  </tr>
</table>

### SSH repositories — the part GitKraken doesn't do

Pick a host from your `~/.ssh/config`, browse its folders, and open a repository that lives there. Graph, staging, commit, merge, rebase, blame, worktrees and pull requests all work as if it were local.

- **Nothing to install on the other machine** except Git. macOS, Linux and Windows (Git for Windows) hosts are supported.
- **Any login shell** — bash, zsh, fish, cmd, PowerShell or Git Bash. MobyD detects it and never asks you to change it.
- **Low latency** — one multiplexed SSH connection is reused, and a full refresh runs as a single round trip.
- **Follows you between networks** — if the office address in your SSH config doesn't answer, MobyD reaches the same machine over Tailscale and still checks the host key you already trust.
- Your own SSH setup is used as-is: keys, ssh-agent, ports, ProxyJump.

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/ssh-browse.png" alt="Browsing folders on an SSH host from ~/.ssh/config" /></td>
    <td width="50%"><img src="docs/screenshots/ssh-repo.png" alt="A repository on another machine open in MobyD" /></td>
  </tr>
  <tr>
    <td align="center"><sub>Pick a host from <code>~/.ssh/config</code> and browse its folders</sub></td>
    <td align="center"><sub>The remote repository opens in a tab marked with its host</sub></td>
  </tr>
</table>

| Measured | macOS on LAN | Windows 11 on LAN | Windows 10 via Tailscale relay |
|---|---|---|---|
| Open a repository | 0.1 s | 0.6 s | 0.6 s |
| Refresh the graph | 0.2–0.3 s | 0.5 s | 0.6–0.75 s |
| Status / diff / blame | 0.1 s | 0.2 s | 0.25 s |

### Light theme

<p align="center">
  <img src="docs/screenshots/light.png" alt="MobyD in the light theme" />
</p>

## Install

1. Download **[MobyD-macOS-arm64.dmg](https://github.com/gyeongjin-kim/MobyD-releases/releases/latest/download/MobyD-macOS-arm64.dmg)** (always the latest release) and drag MobyD into Applications.
2. MobyD is not notarized yet, so macOS blocks the first launch. Open **System Settings → Privacy & Security**, scroll down and click **Open Anyway** next to MobyD, or run:

   ```bash
   xattr -dr com.apple.quarantine /Applications/MobyD.app
   ```

Requires macOS on Apple silicon and Git 2.36+ (Xcode Command Line Tools or Homebrew). Past versions and release notes are on the [Releases](https://github.com/gyeongjin-kim/MobyD-releases/releases) page.

MobyD updates itself: it checks for a new version at launch and every hour, shows a notice when one is out, and the **Update now** button (also in the top bar) downloads, verifies and installs it, then restarts the app. Preferences → General has a manual check.

## Tech stack

| Layer | |
|---|---|
| App shell | [Tauri 2](https://tauri.app) (system WebView, no bundled browser) |
| Backend | Rust — drives the `git` CLI, SSH transport, GitHub / GitLab / Gitea API clients, OS keychain for tokens |
| Frontend | React 19 + TypeScript, Vite, Zustand, TanStack Virtual |
| Tests | `cargo test` against real temporary Git repositories and mock forge servers; Vitest for the UI logic; an in-app self-test |

## Build from source

You need Node 20+, pnpm, Rust (stable) and Git.

```bash
pnpm install
```

```bash
pnpm tauri dev
```

```bash
pnpm release   # → src-tauri/target/release/bundle/{macos/MobyD.app, dmg/*.dmg}
```

Checks:

```bash
pnpm typecheck && pnpm test && cargo test --manifest-path src-tauri/Cargo.toml
```

More detail (shortcuts, the dev bridge for working on the UI in a browser, the self-test, architecture) is in [docs/guide.ko.md](docs/guide.ko.md) and [docs/architecture.md](docs/architecture.md) (Korean).

## Releasing

Releases are built by GitHub Actions. Bump the version and push a tag:

```bash
scripts/set-version.sh 0.2.0 && git commit -am "Release 0.2.0" && git tag v0.2.0 && git push origin main v0.2.0
```

The [release workflow](.github/workflows/release.yml) builds the app on macOS and publishes it in two places: as a release of this repository, and in the public [MobyD-releases](https://github.com/gyeongjin-kim/MobyD-releases) repository, which serves the download link above and the update feed (`latest.json`) that running apps read.

The update archive is signed with a key that only the workflow has (`TAURI_SIGNING_PRIVATE_KEY`); the app checks that signature with the public key in `src-tauri/tauri.conf.json` before installing anything. Keep a copy of the private key: an app can only accept updates signed with it.

## License

MobyD is licensed under either of

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE))
- MIT license ([LICENSE-MIT](LICENSE-MIT))

at your option.

Unless you explicitly state otherwise, any contribution intentionally submitted for inclusion in MobyD by you, as defined in the Apache-2.0 license, shall be dual licensed as above, without any additional terms or conditions.

The name "MobyD" and the MobyD logo are not covered by these licenses. If you ship a modified build, please give it a different name and icon.
