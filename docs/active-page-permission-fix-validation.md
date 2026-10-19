# 기존 활성 문서의 사이트 권한 적용 수정 — Issue #67

검증일: 2026-10-19 (Asia/Seoul). [Bug #67](https://github.com/SKHU-AI-Projects-Archive/2026-2-Capstone-T01-focus-recovery/issues/67)은 ACTIVE 세션에서 미허용 사이트를 먼저 연 뒤 허용하면, 같은 문서가 `excluded / url-policy`에 남는 결함이다.

## Git 기준과 범위

- 공식 main `78887ccb1a1b3482fced0ed4c60e62d5e7e1e8ef`에서 `fix/67/active-page-permission`을 생성했다. #64 수정 PR #65의 병합을 확인했다.
- #59 / PR #61은 OPEN Draft다. 그 브랜치의 #67 재현 테스트 **한 건만** 가져왔으며, 다른 변경이나 미병합 PR에 의존하지 않는다. 기존 브랜치와 다른 worktree는 변경하지 않았다.
- 제품 변경은 Background 권한 대기 구분과 해당 IndexedDB 상태 검증뿐이다. Collector의 유효 방문 정책, API 계약, BE 코드, DB 스키마, manifest, 검색 추출기, 의존성은 변경하지 않는다.

## 원인과 수정

`onCommitted`는 사이트 권한이 없으면 identity를 null로 전달했다. Collector는 이를 URL 정책 제외로 확정한다. 권한 허용 후 설치된 content script가 `context`를 보내도 `navigate(..., 'existing')`는 같은 documentId이면 반환하고, 확정 제외 후보의 snapshot도 무시한다.

1. 권한 없이 관측한 탐색 중 URL 정책을 통과하고 API 호스트·오류 문서가 아닌 경우에만 `TabState.awaitingPermission = true`를 저장한다. URL 원문·해시·본문은 저장하지 않는다.
2. 기존 검증 경로에서 현재 frame/documentId, 실제 사이트 권한, 세션 종료 상태를 확인한 `context`에 한해 대기 표식을 한 번 소비한다. 현재 URL도 다시 검사한다.
3. 안전한 URL이면 기존의 새 후보 생성 경로를 사용한다. 같은 문서와 browserTabKey를 유지하면서 새 visitId와 허용 후 visitedAt/체류시간을 시작한다. 이전 제외 후보를 되살리거나 허용 전 본문·시간을 소급하지 않는다.
4. 현재 URL이 민감 경로로 바뀌었다면 표식만 소비한다. 진짜 URL·DOM 제외는 유지한다. 반복 context/권한 동기화로 후보를 추가하지 않는다.
5. 표식은 선택 필드다. 기존 체크포인트를 그대로 읽고, 새 표식의 타입·null identity·제외 사유·확정 여부·미발급 sequence·체류시간 0을 검증한다. 손상 상태는 계속 차단한다.

## 합성 회귀: FAIL → PASS

원래 재현 테스트의 기대값을 바꾸지 않았다. 기본 `npm test`에 포함되며 별도 opt-in이나 skip은 없다.

```sh
cd fe
npm test -- tests/durable-background.test.ts -t 'collects the same active document'
```

- 수정 전: **FAIL**, expected `valid` / received `excluded`, exit 1. 이 명령에서 필터로 제외된 기존 테스트는 실행 성공으로 세지 않는다.
- 수정 후: **PASS**. 전체 회귀에서도 해당 테스트가 실행됐다.
- 추가 검증: 일반 문서/Naver 검색의 허용 전 snapshot 차단, 80초 대기 비소급, 허용 후 500ms는 미유효/1500ms는 유효, 같은 탭·새 UUID, 원래 제외 후보 불변, 반복 요청 중복 방지, sequence 1 POST/PATCH ACK.
- 안전성: 처음부터 민감 URL인 문서, 허용 직전 민감 경로로 변경된 문서, DOM 제외, 필수 API 호스트, 다른 documentId, 허용 철회 후 메시지를 차단한다.
- Worker 재시작 후에도 허용 후의 새 후보만 수집한다. 대기 표식 저장·재조회와 타입/identity/사유/시간이 불일치하는 체크포인트 차단도 검사한다.

## 실제 Chrome 및 전용 BE·MySQL

macOS 27.0.1 arm64 / Chrome for Testing 151.0.7922.34 / Node 25.9.0 / npm 11.12.1 / Java 21.0.10 / Spring Boot 4.1.1 / MySQL 8.4.9. 설치된 Playwright Chromium으로 새 headed 프로필을 만들었다. 수집 사이트를 manifest에 사전 허용하지 않았으며 Chrome API로 grant하지 않았다. 개발 API localhost 권한만 빌드 설정에 따른다.

이번 실행이 생성한 컨테이너 `focus-recovery-issue67-20261019-d9ba` (ID `d86518e490c3…`, label issue=67), MySQL `127.0.0.1:49222`를 사용했다. 고정 JAR 사본 `/tmp/focus67-be-zi8Ft5/server.jar`, 새 BE PID 98629, API `127.0.0.1:49258`을 확인했다. 세션 생성 직후 이 DB의 세션 1행을 확인했다. 테스트 전송 proxy의 성공 요청은 모두 이 Spring Boot로 전달한다. AI는 기동하지 않았으며 추론 결과를 검증하지 않는다.

검증 후 생성 ID·label·JAR 경로를 다시 대조해 이번 BE와 컨테이너만 종료·삭제했다. 임시 Chrome 프로필·확장 빌드·고정 JAR 사본도 정리했다. 운영 DB와 기존 컨테이너·브라우저 프로필은 수정하지 않았다.

### 공개 로컬 문서 + 실제 네이티브 허용: PASS

1. 세션을 먼저 시작하고 미허용 `127.0.0.1`의 개인정보 없는 합성 문서를 열었다. 권한 대기=true, snapshot 없음, 체류시간 0, DB 방문 0행을 확인했다.
2. 실제 toolbar Popup의 `현재 사이트 수집 허용`을 눌러 Chrome의 **127.0.0.1 데이터를 읽고 변경 / 거부·허용** 대화상자를 관측하고 `허용`을 클릭했다.
3. 새로고침·탐색 없이 documentId가 동일했다. 표식이 사라지고 같은 browserTabKey의 새 visitId가 생성됐다. visitedAt은 허용 클릭 직전에 기록한 시각 이후다. 원래 제외 후보는 본문·시간을 포함해 그대로였다.
4. 유효 방문이 생긴 뒤 권한 동기화를 반복해도 같은 visitId/후보 수를 유지했다. 세션 종료 후 POST 201 / sequence 1 / 방문 **1행** / `ENDED`를 확인했다.
5. SQL의 visitId·정규화 URL·제목·본문이 FE와 정확히 같고 검색어는 null이었다. 최종 활성 체류시간은 48,069ms였다. 이 사례는 최종 행동 값이 POST에 포함돼 별도 PATCH는 발생하지 않았다.

### 실제 Naver의 기존 문서 수집·저장: PASS

- 실제 `Spring Boot JWT` 검색 요청 HTTP 200, 일반 웹 결과 7건을 확인했다. 세션 중 미허용 페이지를 연 직후 표식=true / snapshot 없음 / DB 방문 0행이었다.
- toolbar에서 요청한 **search.naver.com 데이터를 읽고 변경 / 거부·허용** 네이티브 창을 관측했다. 이후 실제 권한=true, 같은 documentId, 새 후보 valid, 표식 제거를 확인했다.
- Naver 허용 클릭 도구는 UI 변경 경고를 반환했고, 조회한 후보 생성 시각도 클릭 직전 계측보다 빨랐다. 따라서 **그 클릭의 실행 시각·성공을 입증하는 사례로는 사용하지 않는다**. 네이티브 클릭의 확실한 근거는 위 로컬 문서 실행이며, Naver는 실제 권한 전환 전후의 동일 문서 수집·저장 근거다.
- 실제 일반 웹 카드 7건 각각의 제목·설명이 해당 FE 본문과 일치했다. 본문은 1,573 Unicode code points이고 `AI 브리핑` 제목은 포함하지 않았다. 광고가 실제 노출된 샘플 전체를 검증했다는 뜻은 아니다.
- FE와 SQL의 제목·본문·검색어·정규화 URL·visitId가 정확히 일치했다. MySQL CLI는 `--default-character-set=utf8mb4 --batch --raw`로 JSON을 조회해 개행 이스케이프와 한글을 보존했다. 저장 URL은 `https://search.naver.com/search.naver`, 검색어는 별도 필드에 보존됐다. 방문 **1행**, sequence 1, POST 201, 활성 체류시간 52,890ms, 세션 `ENDED`였다.
- 원래 제외 후보는 변하지 않았다. 페이지 전체 HTML·추적 URL·쿠키·인증정보·본문 원문을 저장소나 GitHub에 게시하지 않았다. 브라우저와 DB 안의 공개 검증 내용만 비교했다.

위 두 결과는 실제 Chrome/BE/DB 실행이며 합성 unit test 성공으로 대체한 결과가 아니다. 로컬 콘텐츠 자체는 합성이고 Naver 콘텐츠만 실서비스다.

## 실행 결과

| 검사 | 결과 | 근거 |
| --- | --- | --- |
| 수정 전 #67 기본 재현 | FAIL (예상된 결함 재현) | valid 기대 / excluded 실제 |
| 수정 후 `npm test` | PASS | 26개 파일, 775개 테스트, FAIL/SKIP 0 |
| `npm run typecheck` | PASS | TypeScript 오류 없음 |
| `npm run build` | PASS | Popup/Background/content production build |
| `npm run test:browser` | PASS | 실제 MV3, 합성 API·검색 DOM, Worker/ACK/탐색/세션 회귀 |
| 방문 통합 | PASS | sequence 1–7, 5건부터 Window 0/0/0/0/1/2/3, 재전송 200, Worker 복구, Unicode 상한·400 차단 |
| 행동 통합 | PASS | 12개 로그 시나리오, POST/PATCH/SQL, 재시도 상한, Worker·브라우저 재시작·확장 reload·원래 방문 보존 |
| 세션 종료 통합 | FAIL → 재실행 PASS | 최초 serviceworker 대기 타임아웃 기록 보존; 코드 불변 재실행 12개 시나리오 전체 통과 |
| MV3 스크립트의 native 다중 윈도우 최소화/복원 | SKIP | 기본 headless 실행, HEADED=1 분기 미실행 |
| 네이티브 허용 후 기존 로컬 문서·DB | PASS | 동일 documentId, 비소급·중복 없음, SQL 1행, ENDED |
| 실제 Naver 기존 문서·DB | PASS | 실제 권한=true 후 결과 7건/SQL 1행, ENDED; 클릭 계측 제한은 위 참고 |
| Windows Stable | SKIP | 이 환경은 macOS Chrome for Testing |
| Google 실제 검색 재검증 | SKIP | #67 범위 밖; #59의 CAPTCHA BLOCKED를 해소했다고 주장하지 않음 |
| BE 제품 단위 테스트 신규 실행 | SKIP | BE 코드·계약 불변; 실제 API·DB 통합으로 영향 확인 |

통합 회귀는 같은 전용 DB에 별도 세션·새 Chrome 프로필로 순차 실행한다. 아래 명령의 검색 페이지 응답은 합성 fixture이며 실서비스 검색 성공에 포함하지 않는다.

```sh
cd fe
export CHROMIUM_PATH='/path/to/Google Chrome for Testing'
export INTEGRATION_API_BASE_URL='http://127.0.0.1:49258'
export INTEGRATION_MYSQL_CONTAINER='focus-recovery-issue67-20261019-d9ba'
node scripts/visit-integration-test.mjs
node scripts/behavior-integration-test.mjs
node scripts/session-end-integration-test.mjs
```

세션 종료 통합 첫 실행은 **FAIL (exit 1)**이었다. END normal/worker/browser/reload와 REVIEW-A-abort는 통과했으나, 다음 quota 오류 주입 후 전체 Chrome 강제 종료·재기동에서 `waitForEvent('serviceworker')`가 30초 타임아웃했다 (`session-end-integration-test.mjs:83`, 호출 :242). #67 단언 실패는 아니지만 전체 성공으로 처리하지 않는다. 제품/테스트 코드·기대값을 바꾸지 않고 새 프로필로 한 번 재실행한 결과는 **PASS (exit 0)**였다. END 4종, ACK 저장 실패 4종, 신규 생성 영수증 복구 2종, 서버 종료 후 POST/PATCH 불일치 2종의 12개 시나리오를 통과했다. 최초 타임아웃의 정확한 원인은 미확정이며, 간헐적인 브라우저 시작 대기 문제는 추가 관찰이 필요하다.

## 변경 파일과 한계

- `fe/src/shared/types.ts`: 권한 대기 표식.
- `fe/src/background/index.ts`: 미허용 탐색 구분, 재검사 후 새 후보 생성.
- `fe/src/background/durable-state.ts`: 새 선택 필드의 저장 무결성 검증.
- `fe/tests/durable-background.test.ts`, `fe/tests/durable-state.test.ts`: 원래 재현 및 안전성/영속성 회귀.
- 이 보고서 및 README 문서 링크.

기존 표식 없는 체크포인트를 권한 부족이었다고 추측해 마이그레이션하지 않는다. 이미 제외된 기존 문서에 표식이 없다면 새로고침/정상 새 문서 context 경로로 다시 검사해야 한다. 권한 거부 안내, 모든 OS의 실제 권한 철회·브라우저 재시작 조합, Google CAPTCHA와 #59의 미완료 실서비스 항목은 별도 검증이 필요하다. 이번 수정으로 파일럿 준비 전체가 끝났다고 주장하지 않는다.
