# MobyD 사용·개발 안내 (한국어)

> 프로젝트 소개는 [README](../README.md)에 있습니다. 이 문서는 기능·단축키·개발 방법을 자세히 적은 안내서입니다.

흰 고래(백경, Moby Dick)가 헤엄치는 커밋 그래프. Tauri 2 + Rust + React/TypeScript로 만든 데스크톱 Git 클라이언트입니다.

- 커밋 그래프: 레인 색상, 병합 곡선, 브랜치·태그·원격 라벨, 작업 중인 변경(WIP)과 stash 노드, 가상 스크롤(수천 개 커밋)
- 로컬 Git 전부: 스테이징(파일·헝크·줄 단위), 커밋·amend, 브랜치 생성/전환/이름 변경/삭제/업스트림, fast-forward,
  병합(ff / --no-ff / ff-only / squash), 리베이스, 체리픽, revert, reset(soft/mixed/hard), 태그, stash, fetch/pull/push(force-with-lease)
- 충돌 처리: 상단 진행 배너(계속/건너뛰기/중단), 파일별 ours/theirs/해결 표시, git이 준비한 병합 메시지 자동 사용
- **워크트리**: 목록, 추가(기존/새 브랜치/분리된 HEAD), 새 탭으로 열기, 잠금/해제, 제거(+브랜치 삭제), prune
- **GitHub · GitHub Enterprise · GitLab(.com/자체 운영) · Gitea/Forgejo(Codeberg 포함)**: PR/MR 목록·상세·생성·병합(merge/squash/rebase, head SHA 검증)·닫기·댓글·로컬 체크아웃
- **통합(로그인)**: GitKraken처럼 **"브라우저로 GitHub.com 로그인"** 버튼 → 브라우저에서 코드 승인(OAuth Device Flow)으로 연결합니다.
  GitHub Enterprise·GitLab·Gitea는 권한이 미리 채워진 토큰 생성 페이지 + 붙여넣기, GitHub CLI 로그인 가져오기도 지원합니다.
- **계정 저장소 전체 복제**: 새 탭 → 복제 → 서비스(GitHub.com · GitHub Enterprise · GitLab.com · GitLab Self-Managed · Gitea)를 고르면
  그 계정이 접근할 수 있는 **모든** 저장소(개인·협업·조직, 페이지 끝까지)가 나옵니다. 검색·소유자·공개/비공개·보관 필터, 체크박스·"보이는 저장소 모두 선택",
  **선택한 N개 일괄 복제**(3개씩 병렬, 저장소별 진행·실패 이유 표시), 소유자별 폴더, HTTPS/SSH 선택, 이 컴퓨터 또는 SSH 원격 PC로 복제. 이미 복제한 저장소는 "열기".
  HTTPS 원격의 clone·fetch·pull·push 에 그 계정 토큰이 자동으로 쓰입니다(설정 파일·명령줄에 남지 않음). 토큰은 OS 키체인에만 저장
- **언어**: 한국어 · English · 시스템 설정 따르기(환경설정 → 일반). 화면과 백엔드 오류·안내 메시지가 함께 바뀝니다
- **SSH 원격 PC의 저장소**: `~/.ssh/config`의 호스트에서 폴더를 골라 로컬 저장소처럼 그래프·스테이징·커밋·병합·리베이스·워크트리·PR을 그대로 사용.
  연결 하나를 재사용(ControlMaster)하고 새로고침에 필요한 git 명령을 원격에서 병렬로 한 번에 실행해 왕복을 최소화. 원격에 새 저장소 만들기·복제도 지원
- **인터랙티브 리베이스**: 커밋 우클릭 → pick·reword·edit·squash·fixup·drop, 끌어서 순서 변경, autostash
- **Undo / Redo** (⌘Z / ⇧⌘Z): 커밋·amend·체크아웃·브랜치/태그 생성·삭제·이름 변경·병합·리베이스·체리픽·revert·reset·pull·fast-forward·변경 버리기·stash
- **Blame**: 줄마다 마지막으로 바꾼 커밋(작업 트리 또는 특정 커밋 기준), 커밋으로 이동, 나이 표시
- **테마**: 다크 · 라이트 · 시스템 설정 따르기(실시간)
- GitKraken과 비슷한 구조: 저장소 관리 화면(열기·복제·새로 만들기, 복제는 서비스 목록 + 계정 저장소), 툴바(저장소 ▾ · 브랜치 ▾ |
  실행 취소·다시 실행 | Pull·Push | 브랜치 | Stash·Pop | 터미널), 오른쪽 위 계정 아바타, 왼쪽 패널(로컬·원격·워크트리·Stash·PR·태그),
  오른쪽 커밋/작업 패널, 환경설정(일반·외관·통합(서비스 목록 + 연결 카드)·SSH). 항목별 대응표는 [gitkraken-structure.md](gitkraken-structure.md)
- 외부 변경 자동 감지(터미널·에디터·다른 워크트리), 탭으로 여러 저장소 동시 열기, 파일 히스토리, 터미널 열기(원격은 ssh 접속 터미널)

## 단축키와 편의 기능

| 키 | 동작 |
|---|---|
| ⌘K 또는 ⌘P | 명령 찾기: Pull·Push·Fetch·브랜치·Stash·실행 취소, 브랜치 체크아웃, 열린 탭·최근 저장소 이동, 열기·복제, 환경설정·테마·언어·화면 크기 |
| Esc | 맨 위에 열린 것 하나만 닫기(메뉴 → 대화상자 → blame → diff), 검색창에서는 검색어 지우기 |
| 파일 더블클릭 | 작업 중인 변경 목록에서 스테이징 / 스테이징 해제 |
| ⌘↵ | 커밋(요약·설명 어느 칸에서든) |
| 검색창에서 ↵ / ⇧↵ | 다음 / 이전 일치 커밋으로 이동 |
| ⌘+ / ⌘− / ⌘0 | 화면 확대 / 축소 / 기본 크기(75–200%, 다음 실행에도 유지. 환경설정 → 외관에서도 조정) |
| ⌘F | 커밋 검색 |
| ⌘R | 새로고침 |
| ⌘Z / ⇧⌘Z | 실행 취소 / 다시 실행 |
| ⌘T · ⌘O · ⌘, · ⌘1–9 | 새 탭 · 저장소 열기 · 환경설정 · 탭 이동 |
| ⌘Enter | 커밋 |

- 오류는 git 출력 대신 무슨 일이 있었고 어떻게 하면 되는지를 문장으로 보여 줍니다(약 35가지 경우). 원문은 "자세히"에서 보고 복사할 수 있습니다.
- 커밋하지 않은 변경 때문에 체크아웃이 막히면 "Stash하고 체크아웃"을 제안합니다.
- 알림은 마우스를 올려 두는 동안 사라지지 않습니다. 창이 좁거나 화면을 키우면 툴바가 아이콘만 남기고, 브랜치·태그 열이 줄어 커밋 메시지 자리를 넓힙니다.
- 기본 글자 크기는 14px, 가장 작은 글자는 12px입니다(아바타 안 이니셜 제외).

## 웹에서 여는 링크 (`mobyd://`)

웹페이지·메신저·문서에 아래 주소를 링크로 넣으면 누를 때 MobyD가 열립니다(앱이 꺼져 있으면 켜집니다). 경로와 URL은 퍼센트 인코딩합니다.

| 링크 | 동작 |
|---|---|
| `mobyd://` | MobyD 실행 |
| `mobyd://open?path=%2FUsers%2Fme%2Fcode%2Fapp` | 이 컴퓨터의 저장소 열기(이미 열려 있으면 그 탭으로 이동) |
| `mobyd://open?path=ssh%3A%2F%2Fdevbox%2FE%3A%2Fcode%2Fapp` | SSH PC의 저장소 열기(접속 전에 한 번 확인) |
| `mobyd://clone?url=https%3A%2F%2Fgithub.com%2Fowner%2Frepo.git` | 복제 화면을 주소가 채워진 채로 열기(복제는 직접 누름) |

- 툴바의 저장소 이름 ▾ → "MobyD 링크 복사"로 지금 저장소의 링크를 바로 얻을 수 있습니다.
- 링크는 저장소 열기와 화면 띄우기만 합니다. 복제·커밋 같은 작업은 실행하지 않고, `file:`·`ext::` 같은 원격 주소나 상대 경로는 거부합니다.
- macOS는 MobyD.app을 한 번 열거나 응용 프로그램 폴더에 두면 `mobyd://`를 MobyD에 연결합니다. HTML에서는 `<a href="mobyd://open?path=...">MobyD로 열기</a>`처럼 씁니다(브라우저가 "MobyD를 열까요?"를 한 번 물을 수 있습니다).
- macOS 외 플랫폼은 Tauri deep-link 플러그인으로 스킴을 등록해야 합니다(아직 미구현, 앱은 인수로 받은 `mobyd://` 링크를 처리하도록 준비됨).

## 이름과 식별자

앱 이름은 **MobyD**, 번들 식별자는 `org.mobyd.desktop`입니다. 설정은 `~/Library/Application Support/org.mobyd.desktop`에, 토큰은 키체인의 `org.mobyd.desktop` 항목에 있습니다.

GitHub 브라우저 로그인은 GitHub OAuth 앱 **MobyD**(client ID `Ov23lieIItaI2GuawY0B`, Device Flow 사용, 토큰 만료 없음,
client secret 없음)을 씁니다. 요청 권한은 `repo read:org read:user workflow`입니다. 조직 저장소가 안 보이면 조직에서 이 앱을 승인해야 합니다
(통합 화면의 "조직 접근 권한 관리").

로고는 백경(Moby Dick)의 흰 고래를 추상화한 형태입니다. 표정이나 지느러미 없이 몸 윤곽만 남기고, 꼬리를 커밋 그래프의 브랜치(갈라지는 지점 하나와 브랜치 끝 두 개)로 그렸습니다(`src-tauri/icons/source.svg`, `src/components/Logo.tsx`).

## 실행

필요: Node 20+, pnpm, Rust(stable), git 2.36+ (Xcode CLT 또는 Homebrew git).

```bash
pnpm install
```

```bash
pnpm tauri dev
```

릴리스 빌드(`src-tauri/target/release/bundle/macos/MobyD.app` + `bundle/dmg/*.dmg`). 바이너리에서 로컬 경로를 지우고 DMG까지 만듭니다:

```bash
pnpm release
```

점검 결과는 [release-audit.md](release-audit.md)에 있습니다.

### 브라우저에서 UI 작업하기 (dev bridge)

Rust 명령을 HTTP(127.0.0.1 전용)로 노출하는 개발용 브리지가 있습니다. Tauri 창 없이 일반 브라우저에서 실제 저장소로 UI를 확인할 수 있습니다.

```bash
cargo run --manifest-path src-tauri/Cargo.toml --features devbridge --bin mobyd-devbridge -- 1430 /tmp/mobyd-bridge
```

```bash
VITE_DEVBRIDGE=http://127.0.0.1:1430 pnpm dev
```

브리지는 `devbridge` 기능을 켰을 때만 빌드되며 앱 번들에는 들어가지 않습니다.

### 데모 저장소

브랜치·병합·태그·stash·워크트리·미커밋 변경이 섞인 저장소를 만듭니다.

```bash
scripts/make-demo-repo.sh /tmp/pod
```

## 앱 안 자체 점검

실제 앱(웹뷰 + Tauri IPC)에서 주요 화면과 기능을 돌려 보고 JSON 보고서를 쓴 뒤 종료합니다. 환경변수가 없으면 아무 일도 하지 않습니다.

```bash
MOBYD_SELFTEST_OUT=/tmp/mobyd-selftest.json MOBYD_SELFTEST_REPO=/tmp/pod src-tauri/target/release/bundle/macos/MobyD.app/Contents/MacOS/mobyd
```

`MOBYD_SELFTEST_REMOTE=ssh://호스트/경로`를 더하면 SSH 저장소도 확인합니다. `MOBYD_SELFTEST_LANG=en`(또는 `ko`)이면 그 언어로 화면을 바꿔 같은 검사를 돌립니다. `MOBYD_SELFTEST_STRESS=60`이면 요청이 몰린 상태에서 화면을 60번 다시 불러와도 앱이 버티는지 봅니다(릴리스 빌드는 `panic = "unwind"`여야 통과합니다. `src-tauri/Cargo.toml` 주석 참고). 테스트용 앱 복사본에는 `-ApplePersistenceIgnoreState YES`를 넘기면 이전 비정상 종료 뒤 macOS의 "창 다시 열기" 확인 창에 막히지 않습니다. `MOBYD_SELFTEST_CONFIG=<폴더>`를 주면 사용자의 설정 대신 그 폴더를 씁니다.
MobyD가 이미 실행 중이면 웹뷰 저장소를 함께 쓰므로, 앱 복사본의 `CFBundleIdentifier`를 바꿔(예: `org.mobyd.selftest`) 실행하세요.

## 검사

```bash
pnpm typecheck && pnpm test
```

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

```bash
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features devbridge -- -D warnings
```

Rust 테스트는 임시 폴더에 진짜 git 저장소를 만들어 그래프·상태·헝크 스테이징·충돌·체리픽·리베이스·stash·워크트리·원격·PR ref 체크아웃을 검증하고,
로컬 목 서버로 GitHub/GitLab/Gitea의 PR 생성·병합·닫기·댓글 요청(메서드·경로·인증 헤더·본문)을 검증합니다.

## 구조

```
src/                 React UI
  components/        TopBar, Toolbar, Sidebar, GraphView, CommitPanel, WipPanel, DiffView, PrPanel, 대화상자
  repo/              저장소 컨텍스트(데이터 로드·폴링·작업 실행)와 메뉴/흐름(actions)
  lib/               API 래퍼, diff 파서, 그래프 렌더 헬퍼, dev bridge 클라이언트
src-tauri/src/
  git/               git CLI 실행기, 로그·ref·상태·워크트리·stash 파서, 레인 레이아웃, 작업(ops)
  forge/             GitHub / GitLab / Gitea API 클라이언트
  commands.rs        Tauri 명령(저장소별 쓰기 잠금, blocking 스레드 실행)
  store.rs           설정 JSON + 키체인 토큰
  devbridge.rs       개발용 HTTP 브리지(feature `devbridge`)
docs/
  architecture.md    설계 요약
```

자세한 설계는 [architecture.md](architecture.md)를 보세요.
GitKraken과 화면·메뉴·기능 구조를 항목별로 맞춰 본 결과는 [gitkraken-structure.md](gitkraken-structure.md)에 있습니다.

## SSH 원격 저장소

새 탭(⌘T) → 열기 → **SSH로 연결된 PC에서 열기**. 호스트를 고르고 폴더를 찾아가 Git 저장소를 엽니다. 저장소는 `ssh://<호스트>/<경로>`로 기억됩니다.

- 인증은 사용자의 ssh 그대로입니다(키·ssh-agent·포트·ProxyJump). 비밀번호 입력은 지원하지 않으므로 키 인증이 필요합니다.
- 원격 호스트에는 git만 있으면 됩니다(설치할 에이전트 없음). macOS·Linux와, Git for Windows가 설치된 Windows를 지원합니다.
- **원격 PC의 기본 셸은 바꿀 필요가 없습니다.** bash·zsh·fish·cmd·PowerShell·Git Bash 무엇이든, MobyD가 처음 접속할 때 셸을 감지하고
  짧은 명령을 실제로 실행해 확인합니다. 감지가 틀리면 다른 실행 방식과 다른 Git Bash 위치(`where git`, 표준 설치 경로)를 차례로 시도합니다.
  cmd의 명령줄 길이 제한(8191자)을 넘는 큰 작업(파일 수백 개 스테이징 등)은 스크립트를 표준 입력으로 보냅니다.
- 환경설정 → SSH 원격에서 호스트마다 **MobyD 전용 설정**을 둘 수 있습니다. `~/.ssh/config`와 원격 PC 설정은 건드리지 않습니다.
  - 명령 실행 방식: 자동 감지(기본) · POSIX · Windows cmd · PowerShell. 지정한 방식이 안 되면 그 이유를 바로 알려 줍니다.
  - 접속 주소: config의 주소 대신 쓸 주소(예: Tailscale IP). 사용자·키·포트는 config 값을 그대로 씁니다. Tailscale 기기 목록에서 고를 수 있고,
    config 주소로 접속이 안 될 때 같은 이름의 Tailscale 기기가 있으면 "이 주소로 접속"을 제안합니다.
- 연결 확인은 OS·실행 방식(예: `Windows cmd → C:\Program Files\Git\bin\bash.exe`)·git 버전·응답 시간을 보여 줍니다.
- 연결이 끊기면(다중화 연결이 죽으면) 다음 요청에서 자동으로 다시 연결합니다. 응답 없는 호스트는 10초 안에 오류를 냅니다.

| 실측 | macOS (LAN, 왕복 약 90ms) | Windows 11 (LAN) | Windows 10 (Tailscale 릴레이) |
|---|---|---|---|
| 저장소 열기 | 0.1초 | 0.6초 | 0.64초 |
| 그래프 새로고침 (전체 상태 포함) | 0.2–0.3초 | 0.54초 | 0.62–0.75초 |
| 변경 감지(폴링) | 0.15초 | 0.42초 | 0.56–0.60초 |
| 단일 명령(상태·diff·blame) | 0.1초 | 0.18–0.25초 | 0.24–0.27초 |
| 커밋 / 실행 취소 | 0.7초 / 0.5초 | 0.63초 / 0.36초 | 1.07초 / 0.6초 |
| 인터랙티브 리베이스 | 0.66초 | 1.1초 | 1.25초 |

## 알려진 한계

- LFS·서브모듈 UI, Bitbucket·Azure DevOps는 아직 없습니다. 브라우저 로그인은 GitHub.com만 기본 제공합니다(GitLab·GHE는 그 서버에 OAuth 앱을
  등록하고 `settings.json`의 `oauthClientIds` 또는 `MOBYD_GITLAB_CLIENT_ID`/`MOBYD_GITHUB_CLIENT_ID`로 client ID를 주면 같은 방식으로 동작합니다).
- 실제 계정 확인(2026-11-13): 설치된 MobyD.app에서 실제 GitHub 계정으로 복제 → GitHub.com의 저장소 목록이 뜨는 것을 확인했습니다.
  브라우저 로그인(Device Flow)은 실제 GitHub에서 코드 발급까지 확인했고, 새 계정의 승인 단계는 계정 주인이 직접 하는 부분이라 따로 해 보지 않았습니다.
  응답 처리(대기·slow_down·거부·만료·토큰)는 목 서버 테스트로 확인했습니다. 일괄 복제는 230개 저장소를 주는 가짜 GHE API로 3페이지 목록·4개 성공·1개 실패를 확인했습니다.
- Windows SSH는 두 대에서 끝까지 실측했습니다: Windows 11(직접 연결)과 Windows 10(Tailscale 릴레이, config의 LAN 주소 대신 MobyD 전용 주소 사용).
  두 PC 모두 OpenSSH 기본 셸이 Git Bash입니다. 기본 셸이 cmd/PowerShell인 경우는 PC 설정을 바꾸지 않고, Windows 11 PC에서 Windows OpenSSH 서버와 같은 방식
  (`cmd.exe /c <명령줄>`, `powershell.exe -c <명령줄>`, 표준 입출력 전달)으로 MobyD의 실제 명령을 실행해 목록·그래프·스테이징·커밋(특수문자 메시지)·
  Undo/Redo·인터랙티브 리베이스·blame까지 전부 통과했습니다. 기본 셸 자체가 cmd/PowerShell로 설정된 PC에 직접 연결해 본 것은 아닙니다.
- 통합 로그인은 실제 GitHub 계정(GitHub CLI 로그인 가져오기)으로 확인했습니다. 접근 가능한 비공개 저장소 15개를 0.9초에 받았고, 그중 하나를 자격 증명 도우미 없이
  MobyD 토큰만으로 HTTPS 복제·열기·fetch 했습니다(토큰을 빼면 같은 복제가 실패, `.git/config`에 토큰 미기록). GitLab·Gitea는 실제 서버와의 인증 통신·오류 처리,
  공개 API 응답 변환, 목 서버 E2E로 검증했고 실제 계정 로그인은 해 보지 않았습니다.
- Undo 기록은 앱 실행 동안 저장소별로 유지되며, 추적하지 않던 파일을 버린 것은 되돌릴 수 없습니다.
- PR 쓰기 작업(생성·병합·닫기·댓글)은 목 서버로 요청 형식을 검증했고, 실서버 쓰기는 사용자의 계정으로 직접 확인이 필요합니다.
- 외부 변경 감지는 폴링(로컬 3.5초, 원격 5초) + 창 포커스 기준입니다(파일 시스템 감시 미사용).
