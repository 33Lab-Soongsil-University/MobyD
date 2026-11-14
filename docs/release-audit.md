# 릴리스 산출물 점검 (REA)

대상: `src-tauri/target/release/bundle/macos/MobyD.app` (v0.1.0, arm64, 5.3 MB) · DMG 3.1 MB · 2026-11-13 (이름 MobyD·식별자 `org.mobyd.desktop`, 추상 로고, 영어/한국어, GitHub 브라우저 로그인, 일괄 복제 반영 후 재점검)

| 점검 | 결과 | 근거 |
|---|---|---|
| 릴리스 노출 감사 (`audit_release_exposure`) | 노출 0건. 소스맵·sourcesContent 없음, 자격 증명 패턴 없음, 디버그 동반 파일(.dSYM 등) 없음 | ev_f7316c29… (이전 빌드 ev_e2ab464c…, ev_aba9fbd8…) |
| 바이너리 하드닝 (`inspect_binary_hardening`) | PIE 켜짐, 스택 실행 금지, 스택 보호(`___stack_chk_fail`) 사용, 코드 서명 로드 명령 있음 | ev_be6e1325… |
| Rust 의존성 메타데이터 (`inspect_rust_binary`) | cargo-auditable 섹션 없음(크레이트 목록이 바이너리에 실리지 않음) | ev_e4292e78… |
| 빌드 경로 문자열 (직접 확인) | 홈 디렉터리 경로 0곳 (`scripts/build-release.sh`의 `--remap-path-prefix`, 첫 빌드에는 429곳) | `strings -a … \| grep -c /Users/` |
| 앱 안 자체 점검 | 영어·한국어 각각 9/9 통과: 로컬 그래프, WIP, 상세·diff·blame, 리베이스 편집기, GitKraken식 배치(툴바·패널·열·우클릭 메뉴), 커밋→Undo→Redo, 테마, 환경설정·복제 화면, Windows PC의 SSH 저장소 | `MOBYD_SELFTEST_LANG=en|ko`, 별도 번들 ID·설정 폴더로 격리 실행 |

바이너리에 들어 있는 GitHub OAuth client ID(`Ov23lieIItaI2GuawY0B`)는 공개 값이며 비밀이 아닙니다. client secret은 만들지 않았고 앱에 없습니다.

## 남은 배포 과제

- 현재 서명은 ad-hoc(링커 서명)입니다. 다른 Mac에 배포하려면 Developer ID 인증서로 서명하고 hardened runtime을 켠 뒤 공증(notarization)이 필요합니다.
  `tauri.conf.json`의 `bundle.macOS.signingIdentity`와 `APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID` 환경변수를 설정하면 Tauri가 처리합니다.
- REA 감사는 정적 분석 결과이며 앱이 안전하다는 증명은 아닙니다.

릴리스 빌드 명령:

```bash
pnpm release
```
