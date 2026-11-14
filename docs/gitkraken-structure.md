# GitKraken 구조 대응표

GitKraken Desktop 12.3.0을 정적 분석한 결과([research/gitkraken-reference.md](research/gitkraken-reference.md)의 Q5·Q6)와 MobyD의 실제 화면을 항목별로 맞춰 본 표입니다.
GitKraken 쪽은 번들 문자열·메뉴 키에서 확인한 것이고 화면을 직접 보지는 않았습니다. 코드·아이콘·자산은 가져오지 않았습니다.

검증 방법 표기:

- **화면**: 2026-11-13, 데모 저장소(`scripts/make-demo-repo.sh`: 브랜치·병합·태그·stash·워크트리·원격·미커밋 변경 포함)를 devbridge + 웹 UI로 열고 DOM에서 직접 읽음.
- **자체 점검**: 릴리스 앱 안 자체 점검(실제 웹뷰 + Tauri IPC)에서 동작까지 확인. 영어·한국어 각각 9/9 통과.
  그중 "GitKraken-style layout" 검사가 이 표의 화면 배치와 우클릭 메뉴를 자동으로 확인한다: 저장소 ▾·브랜치 ▾, 툴바(실행 취소·다시 실행·Pull·Push·브랜치·Stash·Pop·터미널),
  왼쪽 패널 섹션(로컬·원격·워크트리·Stash·풀 리퀘스트·태그), 그래프 열 6개, WIP·stash 행, 커밋·브랜치·stash·저장소 메뉴 항목, 환경설정 4페이지, 통합 서비스 5개, 복제 출처 6개.
  항목이 하나라도 빠지면 그 이름을 담아 실패한다(`src/lib/selftest.ts`).
- **테스트**: Rust 통합 테스트(실제 git 저장소, 가짜 ssh 원격 포함).
- **소스**: 코드에서 확인(화면에서 동작은 확인하지 않음).

## 화면 배치

| GitKraken | MobyD | 확인 |
|---|---|---|
| 상단 저장소 탭, 새 탭, 탭 1~9 단축키 | 상단 탭 바, `+` 새 탭(저장소 관리자), ⌘T 새 탭, ⌘O 열기, ⌘1~9 탭 이동, ⌘, 환경설정 | 화면(탭 바), 소스(단축키) |
| 툴바: 저장소 ▾ · 브랜치 ▾, Undo, Redo, Pull(▼ 기본 동작), Push, Branch, Stash, Pop, Terminal, 오른쪽 위 프로필 | 툴바: 저장소 ▾(열린 탭·최근 저장소·열기·복제), 브랜치 ▾, 실행 취소, 다시 실행, Pull, Push, 브랜치, Stash, Pop, 워크트리, PR, 터미널, 오른쪽 위 계정 아바타. ⌘Z / ⇧⌘Z | 화면, 자체 점검(실행 취소·다시 실행) |
| Pull 기본 동작 선택(ff-if-possible / ff-only / rebase, Fetch All) | Pull 메뉴: Fetch(모든 원격), fast-forward만, merge, rebase. Push 메뉴: Push, Push 후 PR 만들기, Force push(--force-with-lease) | 소스 |
| 왼쪽 패널: LOCAL, REMOTE, WORKTREES, STASHES, PULL REQUESTS, TAGS (+ ISSUES, SUBMODULES, TEAMS, CLOUD PATCHES, GITFLOW) | 로컬, 원격, 워크트리, Stash, 풀 리퀘스트, 태그 (개수·ahead/behind 표시, 섹션 접기, 필터) | 화면(섹션 6개, 항목 13개) |
| 중앙 그래프 열: Branch/Tag, Graph, Commit Message, Author, Date/Time, SHA (+ Changes) | 브랜치/태그, 그래프, 커밋 메시지, 작성자, 날짜, SHA. 머리글 오른쪽 클릭으로 열 보이기/숨기기 | 화면(열 6개) |
| 맨 위 WIP 행, stash 행 | 맨 위 작업 중(WIP) 행, stash 행이 그래프 안에 표시 | 화면(행 종류 확인), 자체 점검 |
| 오른쪽 패널(커밋 선택): 메타데이터, 변경 파일 목록, diff | 커밋 패널: 제목·본문·작성자·부모·SHA 복사·웹에서 보기, 변경 파일, diff(한 줄/나란히, 공백 무시) | 자체 점검(상세→diff) |
| 오른쪽 패널(WIP 선택): Unstaged/Staged, 커밋 메시지, amend | 작업 패널: 스테이징 안 됨/스테이징됨, 파일·전체 스테이징·해제·버리기, 요약+본문, amend, ⌘Enter 커밋 | 자체 점검(모두 스테이징→커밋) |
| File blame / File history | diff 머리의 Blame(줄마다 마지막 커밋), 파일 히스토리 | 자체 점검(blame), 소스(히스토리) |
| 하단 터미널 | 터미널 버튼: 저장소 폴더에서 시스템 터미널 열기(원격은 ssh 접속 터미널) | 소스 |
| 환경설정, Integrations(서비스 목록 + "Connect to GitHub") | 일반(언어 포함), 외관, 통합(왼쪽 서비스 목록: GitHub.com·GitHub Enterprise·GitLab.com·GitLab Self-Managed·Gitea / 오른쪽 계정 또는 연결 카드), SSH 원격 | 화면(2026-11-13, 영어·한국어), 자체 점검 |
| Repo Management(열기·복제·초기화), Clone 화면의 서비스 탭(URL·GitHub.com·GHE·GitLab…) | 저장소 관리자: 열기(이 컴퓨터 / SSH PC), 복제(왼쪽 "URL로 복제" + 서비스 목록 → 연결 카드 또는 계정 저장소 목록), 새로 만들기 | 화면(가짜 GHE 230개 저장소), 자체 점검 |

## 오른쪽 클릭 메뉴

| 대상 | GitKraken | MobyD (화면에서 읽은 항목) |
|---|---|---|
| 커밋 행 | Checkout, Create branch here, Create tag, Create worktree, Cherry pick, Revert, Reset(Soft/Mixed/Hard), Rebase onto, Interactive Rebase, Copy sha, Copy link | 이 커밋 체크아웃(분리된 HEAD), 여기서 새 브랜치, 여기서 워크트리, 태그 만들기, 체리픽, 병합, 여기로 리베이스, 여기부터 인터랙티브 리베이스(reword·squash·drop), 되돌리기 커밋(revert), reset(soft/mixed/hard), SHA 복사, 메시지 복사, 웹에서 보기 |
| 로컬 브랜치 | Checkout, Merge into, Rebase onto, Push, Start a pull request, Set Upstream, Rename, Delete, Copy branch name, Create worktree | 체크아웃, 현재 브랜치로 병합, 이 브랜치 위로 리베이스, 여기서 새 브랜치, 워크트리로 열기, 풀 리퀘스트 만들기, 업스트림 설정, 이름 바꾸기, 삭제, 이름 복사 |
| 원격 브랜치 | (로컬과 같은 계열) + 원격에서 삭제 | 체크아웃, 병합, 리베이스, 여기서 새 브랜치, 워크트리로 열기, 풀 리퀘스트 만들기, 원격에서 삭제, 이름 복사 |
| 원격 | Fetch, Edit, Remove, Add a remote | origin fetch, 원격 제거, (섹션 머리) 원격 추가·정리(prune) |
| 워크트리 | 새 탭/창에서 열기, lock/unlock, remove | 새 탭으로 열기, 잠그기/잠금 해제, 워크트리 제거, (섹션 머리) 워크트리 추가 |
| Stash | Apply, Pop, Delete | 적용(apply), 꺼내기(pop), 삭제 |
| 태그 | Checkout, Push tag to remote, Delete, Copy tag name | 체크아웃, 여기서 새 브랜치, 원격에 태그 push, 태그 삭제, 이름 복사 |

## 기능 흐름

| GitKraken | MobyD | 확인 |
|---|---|---|
| 인터랙티브 rebase 편집기: Pick / Reword / Squash / Drop, 위·아래 이동, `GIT_SEQUENCE_EDITOR`로 앱이 todo 작성 | 편집기: pick·reword·edit·squash·fixup·drop, 끌어서 또는 ↑↓로 순서 변경, `GIT_SEQUENCE_EDITOR`에 표준 입력으로 todo 전달 | 테스트(reword·squash·drop·Undo, 원격 포함), 자체 점검(편집기 열기) |
| Undo/Redo: commit, checkout, 일부 discard (reflog) | 커밋·체크아웃·브랜치/태그 생성·삭제·이름 변경·fast-forward·pull·reset·병합·리베이스·체리픽·revert·버리기·stash. 전후 상태가 맞을 때만 적용 | 테스트, 자체 점검 |
| 원격 URL → 서비스 판정, PR 목록·생성·병합(방법 선택)·닫기·댓글 | GitHub·GitLab·Gitea 판정, PR 패널(목록·상세·댓글), 생성, 병합(병합 커밋/스쿼시/리베이스, 예상 head SHA 전달), 닫기 | 테스트(목 서버), 실제 GitHub 계정(목록·저장소) |
| 브라우저 로그인 후 접근 가능한 저장소 바로 복제 | "브라우저로 GitHub.com 로그인"(Device Flow, 코드 표시·클립보드·승인 페이지) → 계정의 모든 저장소(페이지 끝까지) → 검색·소유자·공개/비공개 필터, 모두 선택, 선택 일괄 복제(병렬 3개, 진행·실패 표시) | 실제 GitHub 코드 발급, 목 서버(대기·slow_down·거부·토큰), 가짜 GHE로 일괄 복제 |

## MobyD에만 있는 것

- SSH로 연결된 PC의 폴더를 골라 저장소를 로컬처럼 사용(원격 PC의 기본 셸 무관, 호스트별 실행 방식·MobyD 전용 주소).
- Gitea 연동(GitKraken에는 없음).

## 아직 없는 것 (요청 범위 밖)

Gitflow, LFS, 서브모듈, 이슈 패널, Cloud Patch, Launchpad·Workspaces, 팀 기능, AI 기능, 내장 3분할 머지 도구(충돌 파일은 상태 표시와 이어가기·중단·건너뛰기, 파일별 ours/theirs 선택으로 해결), 스크롤 미니맵, 브랜치 고정/숨기기.
