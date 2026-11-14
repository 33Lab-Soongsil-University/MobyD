# MobyD 설계 요약

## 원칙

1. **git은 시스템 CLI로만 다룬다.** libgit2를 섞지 않고 `git` 하위 명령 하나를 Rust 함수 하나로 감싼다(`src-tauri/src/git`).
   사용자의 credential helper, SSH agent, hook, 서명 설정이 터미널과 똑같이 동작한다.
2. **git·네트워크·토큰은 전부 Rust 쪽.** 웹뷰는 뷰 모델만 받는다. forge 토큰은 키체인에서 Rust가 직접 읽어 HTTP 헤더에 붙이고 프론트로 돌려보내지 않는다.
3. **UI 스레드를 막지 않는다.** 모든 git 명령은 `spawn_blocking`에서 돈다. 저장소(작업 트리)마다 쓰기 잠금을 두어 연속 클릭이 `index.lock`에서 충돌하지 않게 한다. 읽기는 병렬.

## git 실행기 (`git/runner.rs`)

- git 경로: `MOBYD_GIT` → PATH + `/opt/homebrew/bin`, `/usr/local/bin` 순으로 탐색(GUI 앱은 PATH가 짧다).
- 공통 옵션: `-c core.quotepath=false -c color.ui=false`, `GIT_TERMINAL_PROMPT=0`(인증 프롬프트로 멈추지 않음),
  `GIT_EDITOR=true`·`GIT_SEQUENCE_EDITOR=true`(에디터 대기 방지), `LC_ALL=C`(파싱 안정).
- 상태 폴링은 `GIT_OPTIONAL_LOCKS=0`으로 index를 건드리지 않는다.
- 이름·리비전 인자는 `-`로 시작하거나 공백·`..`·특수문자가 있으면 거부해 옵션 주입을 막는다.

## SSH 원격 저장소 (`git/remote.rs`, `git/runner.rs`)

- 저장소 식별자: 로컬 경로 또는 `ssh://<host-alias>/<path>`(Windows는 `ssh://pc/C:/…`). 모든 git 호출이 지나는 `runner::exec`가 둘을 나눈다.
- 원격 명령은 **base64로 인코딩한 POSIX 스크립트**를 `sh -c 'eval "$(printf %s … | base64 -d)"'`로 보낸다. 원격 로그인 셸이 zsh·fish든
  cmd.exe·PowerShell이든 따옴표 해석 차이가 생기지 않는다. Windows는 처음 접속 때 셸을 감지하고 Git for Windows의 `bash.exe`로 같은 스크립트를 실행한다.
- 셸 결정(`remote::shell`, 호스트당 한 번, 캐시): 원격 PC의 기본 셸은 바꾸지 않는다.
  1. `echo __DLP__; uname -s` 응답으로 추정한다. cmd는 `;`를 모르고 줄 전체를 출력, PowerShell은 자기 출력 줄을 CRLF로 끝냄, POSIX 셸은 `__DLP__\n<OS>`.
  2. 추정한 방식부터 `echo __MOBYD_SHELL_OK__`를 실제로 실행해 확인하고, 안 되면 나머지 방식(POSIX → `sh -c`, cmd → `""bash" -c "…""`,
     PowerShell → `& 'bash' -c '…'`)과 `where.exe git`·표준 설치 경로에서 찾은 모든 `bash.exe`를 차례로 시도한다.
  3. 환경설정의 호스트별 지정(`HostPrefs.shell`)이 있으면 그 방식만 검증해 쓰고, 실패하면 이유를 담은 오류를 낸다.
- 명령줄이 `MAX_COMMAND_LINE`(6000자)을 넘거나 git에 넘길 입력이 있으면, 스크립트(입력은 base64로 스크립트 안에 넣음)를 표준 입력으로 보낸다. 받는 쪽은 정해진 바이트 수만 읽는다(`sh -c 'eval "$(head -c N)" </dev/null'`, Windows는 `bash -c 'source <(head -c N) </dev/null'`). 입력 끝(EOF)을 기다리지 않는 이유: Windows OpenSSH 서버는 한 연결에 여러 명령이 동시에 돌 때 일부 채널의 EOF를 놓치고, `cat`으로 읽으면 그 명령과 앱이 끝없이 기다린다(2026-11-13 devbox에서 동시 6개 이상 호출 시 재현, 회귀 테스트 `input_without_eof_does_not_hang`).
  원래 표준 입력이 있으면 스크립트 안에 base64로 넣어 파이프로 넘긴다. cmd.exe 8191자·CreateProcess 32767자 제한을 피한다.
- 호스트별 MobyD 전용 설정(`settings.json`의 `sshHosts`): 실행 방식과 접속 주소. 주소는 `ssh -o HostName=<주소>`로만 적용되어
  `~/.ssh/config`를 고치지 않고 사용자·키·포트·ProxyJump는 그대로 쓴다. Tailscale 기기 목록은 `tailscale status --json`에서 읽는다.
- 자동 Tailscale 우회: 주소를 따로 지정하지 않은 호스트의 설정 주소(예: 사무실 LAN 주소 `192.168.1.9`)가 지금 네트워크에서 응답하지 않고, 호스트 별칭이나 HostName과 이름이 같은 Tailscale 기기가 하나 온라인이면 그 Tailscale 주소로 접속한다. 세션에서 처음 접속할 때 1.5초 TCP 확인으로 고르고, 접속이 끊기면 다시 고른다. 호스트 키는 원래 이름(또는 설정의 HostKeyAlias)으로 확인하므로 이미 신뢰한 기기에만 붙는다. ProxyJump/ProxyCommand 호스트는 건드리지 않는다.
- 테스트: 가짜 `ssh`(`integration_tests.rs`)가 POSIX·cmd(따옴표 제거, 8191자 제한)·PowerShell(CRLF, 32767자 제한)·오판정 셸을 흉내 내고,
  각 셸에서 스냅샷·스테이징·커밋·Undo/Redo·리베이스·blame·폴더 목록과 큰 스크립트(파일 300개 스테이징, 40KB 스크립트 + 표준 입력)를 확인한다.
- 지연: `ControlMaster=auto` + `ControlPersist=600`으로 호스트당 연결 하나를 재사용한다(사용자 설정에 이미 있으면 그것을 존중).
  `runner::batch`는 여러 읽기 명령을 원격 한 번 왕복으로 보내고, 원격에서 **병렬 실행** 후 경계 문자열로 출력을 나눠 돌려준다(NUL 포함 출력 안전).
  그래프 새로고침(`snapshot::load`)은 커밋·ref·상태·stash·워크트리·원격·진행 중 작업·변경 지문을 이 한 번에 읽는다.
- 안정성: `BatchMode=yes`(프롬프트로 멈추지 않음), `ConnectTimeout=10`, `ServerAliveInterval=15`, ssh 자체 실패(255)는 읽기에 한해 한 번 재시도,
  프론트는 원격 탭을 시작 시 네트워크 없이 복원하고 실패하면 다시 시도 버튼을 보여주며 변경 감지 요청을 겹치지 않게 한다.
- 원격에서 실행되는 네트워크 작업(fetch/pull/push/clone)은 그 PC의 자격 증명을 쓴다. 로컬 키체인 토큰은 원격으로 보내지 않는다.

## Undo / Redo (`journal.rs`)

작업마다 전·후 상태(HEAD·브랜치, 특정 ref 값, stash, 버린 변경의 패치)를 기록한다. 되돌릴 때는 현재 저장소가 기록한 "후" 상태와 같을 때만 적용한다
(`reset --soft|--keep`, `update-ref <ref> <new> <old>` 비교-교체, `switch`, `stash store`, `git apply`). 터미널 등 외부에서 바뀌었으면 거부한다.

## 인터랙티브 리베이스 (`git/history.rs`)

화면에서 편집한 계획을 todo 목록으로 만들어 `git rebase -i --autostash`의 표준입력으로 넘긴다(`GIT_SEQUENCE_EDITOR='cat >'`).
reword와 합친 커밋의 새 메시지는 `exec printf %s <base64> | base64 -d | git commit --amend -F -` 줄로 넣어 에디터 없이 처리한다. 로컬·원격 동일.

## 커밋 그래프

- 데이터: `git log --date-order --max-count=N+1 --branches --remotes --tags HEAD` + `\x1f`/`\x1e` 구분 포맷. N+1번째가 있으면 "더 보기".
- ref: `for-each-ref` 한 번으로 브랜치·원격·태그(annotated는 peel), 업스트림·ahead/behind.
- 합성 행: 작업 트리가 더럽거나 병합·리베이스 중이면 맨 위에 WIP 행(부모 = HEAD), stash는 기준 커밋 바로 위에 끼워 넣는다.
- 레인(`git/graph.rs`): 위에서 아래로 한 번 훑는다. 각 레인은 "기다리는 커밋"을 기억한다.
  커밋은 자기를 기다리는 첫 레인을 차지하고(없으면 새 레인 = 브랜치 끝), 첫 부모가 레인과 색을 잇는다.
  병합의 나머지 부모는 이미 기다리는 레인에 합류하거나 빈 슬롯에 새 레인을 연다. 같은 커밋을 기다리던 레인들은 그 커밋에서 합쳐지고 비워진다.
- 행마다 `pass`(위→아래), `enter`(위→노드), `leave`(노드→아래) 선분을 보내므로 프론트는 각 행을 독립적인 작은 SVG로 그린다(가상 스크롤과 궁합).
  레인 변경은 둥근 꺾임(quadratic curve)으로 그린다.
- 7,555 커밋 저장소에서 그래프 계산+전송 0.37초(디버그 빌드) 확인.

## 변경 감지

`repo_fingerprint`가 status·ref·stash·worktree·진행 중 작업을 FNV 해시로 요약한다(원격은 한 번 왕복). 활성 탭이 3.5초(원격 5초)마다, 그리고 창 포커스 때 비교해
바뀌면 다시 읽는다. 쓰기 작업 중에는 폴링을 쉬고, 요청은 한 번에 하나만 보낸다.

## 테마

CSS 변수로 다크(심해)·라이트(얕은 바다) 두 벌을 둔다. `data-theme`이 없으면 `prefers-color-scheme`을 따라 실시간으로 바뀌고, 선택하면 창의 네이티브 테마도 맞춘다. 바꾸는 곳은 환경설정 › 외관과 명령 찾기(⌘K)다(상단 바의 테마 버튼은 2026-11-14 사용자 요청으로 없앴다).
그래프 레인 색도 테마별 변수(`--lane-0…11`)라 밝은 배경에서도 대비가 유지된다.

## forge (`forge/`)

| | GitHub / GHE | GitLab | Gitea / Forgejo |
|---|---|---|---|
| API | `api.github.com`, `<host>/api/v3` | `<host>/api/v4` | `<host>/api/v1` |
| 인증 | `Authorization: Bearer` | `PRIVATE-TOKEN` | `Authorization: token` |
| 목록 | `GET /repos/{o}/{r}/pulls` | `GET /projects/{id}/merge_requests` | `GET /repos/{o}/{r}/pulls` |
| 생성 | `POST …/pulls` | `POST …/merge_requests` (Draft: 접두) | `POST …/pulls` (WIP: 접두) |
| 병합 | `PUT …/pulls/{n}/merge` `merge_method`, `sha` | `PUT …/merge_requests/{iid}/merge` `squash`, `sha` | `POST …/pulls/{n}/merge` `Do`, `head_commit_id` |
| 닫기 | `PATCH state=closed` | `PUT state_event=close` | `PATCH state=closed` |
| 댓글 | issues comments | MR notes(시스템 노트 제외) | issues comments |
| 체크아웃 | `refs/pull/N/head` → `pr/N` | `refs/merge-requests/N/head` → `mr/N` | `refs/pull/N/head` → `pr/N` |

- 원격 URL(scp형·ssh://·http(s)) → 호스트·경로. 등록된 계정의 호스트가 먼저, 없으면 알려진 호스트(github.com, gitlab.com, gitea.com, codeberg.org)와 호스트명 추정.
- 병합 시 사용자가 보고 있던 head SHA를 함께 보내 그 사이 PR이 바뀌었으면 서버가 거절한다.
- 계정이 없으면 공개 저장소는 익명으로 읽고, 쓰기 버튼은 비활성화한다.
- PR 본문·댓글은 HTML을 실행하지 않는 경량 마크다운 렌더러로 보여준다(웹뷰가 IPC를 가지므로 원시 HTML 주입 금지).

## 저장소

- 설정: `<app config dir>/settings.json` (최근 저장소, 열린 탭, 계정 메타데이터).
- 토큰: 키체인 서비스 `org.mobyd.desktop`, 계정 id = `<kind>:<host>:<user>`. 키체인이 없는 환경에서만 0600 파일로 대체.

## GitKraken 참고 조사

`docs/research/gitkraken-reference.md`에 REA로 설치된 GitKraken 12.3을 정적 분석한 결과(기능 목록, 그래프 방식, forge 엔드포인트)가 있다.
코드·에셋은 복제하지 않았고, MobyD는 그 결과를 설계 비교용으로만 쓴다. 반영한 항목: CLI 단일 경로, N+1 페이지 판정, 단일 패스 레인,
저장소별 쓰기 직렬화, 병합 시 head SHA 검증, 워크트리 생성 전 사전 검증. GitKraken에 없는 Gitea/Forgejo 지원은 MobyD의 차별점이다.

## 언어 (`src/lib/i18n.ts`, `src/lib/i18n.en.ts`, `src-tauri/src/i18n.rs`)

- 화면 문자열은 한국어 원문을 메시지 ID로 쓰는 gettext 방식이다: `t("커밋")`, 자리표시자 `t("{n}개", { n })`, 문장 안에 굵은 글씨·코드가 있으면 `tj()`.
  영어는 `i18n.en.ts` 사전(복수형은 함수 항목). 번역이 빠지면 한국어로 보인다.
- `i18n.test.ts`가 TypeScript AST로 소스를 훑어 ① `t()`로 감싸지 않은 한국어 리터럴 ② 영어 항목이 없는 메시지 ③ 자리표시자 불일치 ④ 쓰이지 않는 사전 항목을 막는다.
- 언어는 `localStorage`의 `mobyd.lang`(system/ko/en). 바꾸면 화면을 다시 불러오고(열린 탭 유지), 시작할 때 `set_locale`로 백엔드에 알린다.
- 백엔드 메시지는 호출 위치에 두 언어를 함께 쓴다: `tr!("한국어", "English")`, `trf!("{x} 한국어", "{x} English")`.

## 브라우저 로그인 (`forge/oauth.rs`)

- RFC 8628 Device Authorization Grant. `oauth_device_start`가 코드를 받아 화면에 보여 주고(클립보드 복사 + 승인 페이지 열기),
  프론트가 `interval`마다 `oauth_device_poll`을 부른다. `slow_down`이면 간격을 5초 늘리고, 승인되면 토큰으로 `account_add`와 같은 경로로 계정을 저장한다.
- device code는 Rust 프로세스 안에만 있다. client secret은 쓰지 않는다. github.com은 내장 client ID, 다른 서버는 설정/환경변수로 준다.
- 저장소 목록은 GitHub/GitLab 100개, Gitea 50개 단위로 마지막 페이지까지 읽는다(조직 저장소 포함).
