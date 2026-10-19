# FE 데이터 수집 E2E 검증 — Issue #55

검증일: 2026-10-19 (Asia/Seoul). [Issue #55](https://github.com/SKHU-AI-Projects-Archive/2026-2-Capstone-T01-focus-recovery/issues/55)의 전체 본문과 댓글(0건), FE·BE 기능명세 및 데이터 수집 규격을 기준으로 검증했다. **실행한 자동 검사는 모두 통과했지만, 본문 문자 단위 불일치 요구사항은 FAIL이며 실제 검색 서비스 DOM·수동 권한 허용 검증은 BLOCKED(미실행)다.** AI 학습·최종 분류 성능은 범위 밖이다.

## Git 기준과 작업 범위

- 시작 worktree: detached HEAD `f73e086`, 추적/미추적 변경 없음.
- `origin`: 개인 Fork `hyeon-marina/2026-2-Capstone-T01-focus-recovery`.
- `upstream`: 공식 `SKHU-AI-Projects-Archive/2026-2-Capstone-T01-focus-recovery`.
- 두 remote를 실제 fetch/prune한 뒤 공식 `upstream/main` **`8841259`**에서 `test/55/fe-collection-e2e`를 생성했다. 당시 Fork main은 `5e49cb3`으로 공식 main보다 3커밋 뒤였다. 다른 worktree와 main 브랜치는 수정하지 않았다.
- README, `.github/pull_request_template.md`, 프로젝트 계획서의 GitHub 협업 규칙을 확인했다. 별도 Git 가이드·CONTRIBUTING·AGENTS·브랜치 강제 규칙은 저장소에 없었고 Wiki 저장소도 접근 가능한 상태가 아니었다. 기존 `feat/번호/설명`, `fix/번호/설명` 형식과 요청한 `test/55/fe-collection-e2e`가 일치하므로 브랜치명 변경은 없다.
- 프로젝트 계획서는 develop 통합 후 main 반영을 설명한다. 이번 작업은 사용자의 명시적 지시에 따라 **공식 main 대상 PR**으로 제출한다. Merge는 수행하지 않는다.

## 기존 테스트 분석과 필요한 추가 검사

기존 FE는 Vitest 25파일·715건, 실제 MV3 회귀 스크립트와 방문·행동·종료의 BE 통합 스크립트를 갖고 있었다. BE는 H2 기반 API/Window/분석/알림 테스트가 있다. 별도 E2E 프레임워크나 같은 정책의 단위 테스트를 추가하지 않았다.

| 기존 검증 | 이미 다루는 내용 | 이번 처리 |
| --- | --- | --- |
| `fe/tests/{url,extraction,search-*,messages,collector,sequence,behavior,background}.test.ts` | 추출/제외, 검색, 방문 재사용, 후보 순서, 누적 행동과 Chrome adapter | 그대로 실행 |
| `fe/tests/{api,visit-*,behavior-*,durable-*,session-end-*}.test.ts` | HTTP 계약, 재시도 예산, POST→PATCH→END 게이트, IDB 트랜잭션·마이그레이션·충돌 보존 | 그대로 실행 |
| `fe/scripts/browser-test.mjs` | 실제 MV3·합성 API/검색 문서, 새로고침/뒤로·앞으로/SPA/탭 복귀/민감 DOM/Worker 복구, native 창 검사 | headless와 HEADED 모두 실행 |
| `fe/scripts/visit-integration-test.mjs` | 실제 BE/MySQL의 6개 방문·2개 Window, 중복, 전송 오류/응답 유실/Worker/삭제 경합/Unicode | 기존 시나리오를 유지하면서 첫 시나리오만 7개로 확장 |
| `fe/scripts/behavior-integration-test.mjs` | 실제 POST/PATCH·SQL, 오래된 버전/충돌/중복, Worker·브라우저·reload 복구 | 전체 그대로 실행 |
| `fe/scripts/session-end-integration-test.mjs` | 최종 ACK 전 END 금지, END_PENDING, END 응답 유실, 저장 실패, 새 생성 영수증, 서버 종료 충돌 | 12개 시나리오 그대로 실행 |
| BE `WorkSession*`, `PageVisitApiTest`, `AnalysisWindowTest` 등 | 세션/행동/Window/멱등/종료/롤백 계약 | 전체 15 suite 실행 |

추가한 검사는 다음과 같다.

- 실제 서버의 ACTIVE·goalText·startedAt과 FE 활성 세션 일치.
- 7개 방문의 sequence 1~7과 매 ACK 직후 SQL 방문 수/유일성, Window 수 **0,0,0,0,1,2,3**.
- Window 구성 **[1,2,3,4,5] / [2,3,4,5,6] / [3,4,5,6,7]**, size 5·stride 1 및 중복 POST 후 불변.
- Query/Fragment 제거, hostname, 제목, 5,000자 제한 본문 및 합성 Google 검색어/결과의 실제 BE 저장. 목록 API가 생략하는 본문은 동일 POST 재전송 응답의 원본 전체 비교로 확인.
- 6번째 방문은 2번째 URL 재방문: 같은 정규화 URL에 다른 visitId와 sequence를 저장.
- 짧은 페이지·로그인 경로·비밀번호 입력 DOM이 있어도 서버 방문/Window 수가 늘지 않음. 민감 후보의 실제 IndexedDB aggregate에 snapshot이 없음을 확인.

제품 소스·BE·AI·원본 명세·의존성·배포 manifest는 변경하지 않았다. Google 호스트 권한은 테스트용 manifest 복사본에만 부여하고 해당 문서는 Playwright로 합성 응답했다.

## 환경과 재실행

macOS arm64, Node **25.9.0**, npm **11.12.1**, Chrome for Testing **151.0.7922.34**, Java **21.0.10**, Spring Boot **4.1.1**, MySQL **8.4.9**. 기본 Java 25 대신 Java 21을 명시했다. 브라우저는 매 실행 생성한 임시 프로필만 사용했다.

테스트 DB는 이번에 새로 만든 `focus-recovery-issue55-e2e`, `127.0.0.1:60489`였고 BE는 `127.0.0.1:18055`였다. 기존 운영/개발 컨테이너·DB·브라우저 프로필을 사용하거나 수정하지 않았다. 아래 컨테이너 이름이 이미 있다면 재사용하지 말고 새 이름을 사용한다. `60489`는 이번 실행의 동적 포트이므로 재실행 시 조회한 값으로 바꾼다.

```sh
# repository root
docker run --detach --name focus-recovery-issue55-e2e \
  --label focus-recovery.issue=55 --publish 127.0.0.1::3306 \
  --env MYSQL_ALLOW_EMPTY_PASSWORD=yes --env MYSQL_DATABASE=focus_recovery mysql:8.4
docker port focus-recovery-issue55-e2e 3306
docker exec focus-recovery-issue55-e2e mysqladmin ping --silent

cd be
JAVA_HOME=/absolute/path/to/Java21 ./gradlew --offline test bootJar
/absolute/path/to/Java21/bin/java -jar build/libs/focus-recovery-0.0.1-SNAPSHOT.jar \
  --spring.profiles.active=e2e --server.address=127.0.0.1 --server.port=18055 \
  '--spring.datasource.url=jdbc:mysql://127.0.0.1:60489/focus_recovery?serverTimezone=UTC' \
  --spring.datasource.username=root --spring.datasource.password= \
  --spring.jpa.hibernate.ddl-auto=validate --focus-recovery.ai.base-url=http://127.0.0.1:1
```

BE는 별도 터미널에서 유지하고 다음을 실행한다. 첫 Gradle 실행에 캐시가 없다면 `--offline`을 제거한다. 활성 profile `e2e`에 명시적 datasource를 지정해 `application-local.properties`의 기존 DB/`.env`를 가져오지 않는다. AI 주소는 연결이 거부되는 테스트 주소로 지정했으며 AI 실패와 방문 저장/Window 생성 성공은 별개로 판정한다.

```sh
cd fe
npm ci --no-audit --no-fund
npm test
npm run build  # typecheck 포함
export CHROMIUM_PATH='/absolute/path/to/Google Chrome for Testing'
npm run test:browser
HEADED=1 npm run test:browser
export INTEGRATION_API_BASE_URL=http://127.0.0.1:18055
export INTEGRATION_MYSQL_CONTAINER=focus-recovery-issue55-e2e
node scripts/visit-integration-test.mjs
node scripts/behavior-integration-test.mjs
node scripts/session-end-integration-test.mjs
```

검증이 끝나면 직접 실행한 BE만 종료하고, 직접 생성한 DB만 제거한다.

```sh
docker rm --force --volumes focus-recovery-issue55-e2e
```

## 실제 실행 결과

| 실행 | 결과 | 근거 |
| --- | --- | --- |
| `npm test` | PASS | 25파일 / 715건, 실패 0 |
| `npm run build` | PASS | TypeScript 검사, popup/Service Worker/content production 빌드 |
| Java 21 `./gradlew --offline test bootJar` | PASS | JUnit XML 합계 **15 suite / 345건**, failure/error/skipped 0; JAR 생성 |
| `npm run test:browser` | PASS | 실제 headless MV3, API는 합성 서버. native 검사는 이 실행에서 SKIP |
| `HEADED=1 npm run test:browser` | PASS | 전체 MV3 회귀와 **native multi-window focus/minimize/restore** 통과; headless의 SKIP을 이 실행으로 보완 |
| `visit-integration-test.mjs` 최종 실행 | PASS | 추가한 7방문·3Window·각 단계 SQL·동일 URL 재방문·저장 필드 검사 및 기존 A/B/C/E 시나리오 전체, exit 0 |
| `behavior-integration-test.mjs` | PASS | B-1 2종/B-2/B-3/D-1~3, D-POST browser/reload, D-LIVE, D-COLLECTOR, REVIEW-C **12개 시나리오**, exit 0 |
| `session-end-integration-test.mjs` | PASS | normal/worker/browser/reload 4종 + 리뷰 A 4종/B 2종/C 2종 **12개 시나리오**, exit 0 |
| `node --check fe/scripts/visit-integration-test.mjs`, `git diff --check` | PASS | 구문·공백 검사 |

초기 추가 fixture 실행은 검색 HTML의 charset 선언이 없어 한글 제목 비교가 실패했다. 테스트 fixture의 `text/html; charset=utf-8`만 바로잡았고 전체 방문 통합 실행을 다시 통과했다. 제품 결함으로 분류하지 않는다. sandbox의 네트워크/Gradle 캐시 접근 제한은 허용된 실행 권한으로 해결했으며 미실행 검사를 PASS로 바꾸지 않았다.

## Issue #55 체크리스트 판정

PASS는 아래에 명시한 검증 수준에 한한다. 합성 DOM·모의 어댑터·명시적 오류 주입을 실제 서비스 DOM이나 물리적 네트워크/디스크 고장 재현으로 취급하지 않는다.

| 체크 항목 | 판정 | 실행 근거 / 범위 |
| --- | --- | --- |
| FE·BE 테스트/환경, 명세 일치 및 누락 분석 | PASS | 위 분석·환경 및 문자 단위 결함 분리 |
| 정상 세션 생성/활성화 | PASS | 실제 BE ACTIVE·goalText·startedAt와 FE 일치 |
| 유효 방문 7개 수집·저장 | PASS | 실제 Chrome + 실제 MySQL 7행 |
| sequence 1~7 / 중복 방지 | PASS | FE·GET·SQL 및 7건 동일 POST 200, 불변 목록/Window |
| URL·제목·제한 본문·검색어 | PASS / FAIL | 한글 긴 본문·합성 Google query 저장 PASS; 비 BMP 문자 길이 계약 FAIL(#56) |
| 제외/개인정보 입력 페이지 제한 | PASS | 실제 DOM/URL 제외, IDB payload 없음, SQL 방문/Window 불변 |
| 동일 URL 재방문 | PASS | 실제 서버의 2번·6번 URL 동일, visitId·sequence 별도 |
| 새로고침·탭 복귀 | PASS | 실제 MV3 + 합성 API의 ID 재사용/누적 보존. 해당 조합의 실제 BE 저장은 별도 재구성하지 않음 |
| SPA URL+본문 변경 | PASS | MV3 회귀 및 behavior D-LIVE의 실제 BE ACK |
| 활성 탭·창 기준 체류시간 | PASS | MV3 탭 검사 + HEADED native 다중 창·최소화·복원, Collector 단위 검사 |
| 탭 전환·창 비활성 시 일시 중지 | PASS | 단위 누적값, 실제 탭 전환, HEADED 창 최소화 중 시간 불변/복원 후 증가 |
| 탭 전환 횟수·방문별 연결 | PASS | MV3 A→B→A 및 실제 POST→PATCH→SQL visitId 연결 |
| 행동 중복·지연·버전 | PASS | 실제 DB updated_at/계수 불변, stale applied=false, 동일 버전 충돌·감소 409 |
| 방문 5개 미만 Window 없음 | PASS | 실제 SQL 매 방문 1~4에서 0 |
| 5번째 최초 Window | PASS | 실제 SQL 1개, [1,2,3,4,5] |
| 6·7번째 새 Window | PASS | 실제 SQL 2·3개 |
| Window size 5 / stride 1 / 순서 | PASS | 실제 window_visit JOIN의 position 순서로 모든 구성 비교 |
| 동일 Window 중복 방지 | PASS | 동일 POST 재전송 전후 SQL 행 수/유일성/구성 불변 |
| 전송 장애 시 데이터 보존 | PASS | 테스트 프록시 503·응답 유실 주입, 실제 IDB 원본/시도 보존. 실제 망 단절은 미검증 |
| 복구 후 방문·행동 재전송 | PASS | 장애 주입 해제/명시적 재시도 후 실제 BE/SQL 저장 및 ACK |
| Worker 재시작 후 IndexedDB 복구 | PASS | 실제 Worker target 종료·재기동, 원본/ID/순서/ACK 유지 |
| 응답 누락·중복 전송 | PASS | 실제 BE commit 이후 응답 보류, 재전송 200/applied=false, SQL 중복 없음 |
| 복구 실패·서버 충돌 보존/오류 | PASS | 실제 SESSION_ENDED + GET ENDED 불일치, 원본 유지/Popup 차단; IDB abort/quota/revision은 테스트 오류 주입 |
| 종료 전 미전송 방문·최종 행동 | PASS | POST/PATCH ACK 전 END 0회, 최종 ACK 이후만 END |
| 종료 요청·서버 ENDED | PASS | 실제 BE 응답/GET·SQL endedAt 일치 |
| END_PENDING 재시도·복구 | PASS | Worker/완전 브라우저/runtime.reload, 동일 `{}`·최초 endedAt 유지 |
| 종료 후 신규 방문·행동 금지 | PASS | FE 추가 전송 0, 실제 신규 POST/PATCH 409, SQL 불변 |
| 결과/환경/재현 문서화, Bug 분리 | PASS | 이 문서 및 [Bug #56](https://github.com/SKHU-AI-Projects-Archive/2026-2-Capstone-T01-focus-recovery/issues/56) |
| 실제 Google/Naver 서비스 DOM 전체·사용자 권한 허용 dialog | BLOCKED (미실행) | 임시 manifest 사전 권한과 합성 검색 응답을 사용하므로 실제 사이트 지원·수동 허용을 입증하지 못함. 외부 접근 실패를 새로 관측한 결과는 아님 |

Windows Chrome Stable, 다른 앱으로의 OS 포커스 전환, 실제 망 단절/디스크 용량 소진은 실행하지 않았다. macOS Chrome native 최소화/다중 창 검사를 해당 전체 조합의 PASS로 확대하지 않는다.

## 발견된 결함과 명세 차이

**FAIL — [Bug #56: FE code point / BE UTF-16 제한 불일치](https://github.com/SKHU-AI-Projects-Archive/2026-2-Capstone-T01-focus-recovery/issues/56).** `😀`.repeat(2501)을 article 본문으로 제공하고 활성 체류 후 이탈하면 FE는 2,501 code points를 유효 방문으로 보존하지만 BE `@Size(max=5000)`는 5,002 UTF-16 units로 판단해 400 INVALID_REQUEST를 반환한다. 실제 SQL 방문 수 0, 원본은 IDB failed/non-retryable로 남는다. Worker 재시작과 재시도 후에도 원본이 유지된다. 한글/영문 5,000 units 및 이모지 2,500개는 201로 저장된다.

원인은 `fe/src/content/extraction.ts`의 `[...text].slice(0, 5000)`와 `CreatePageVisitRequest.content`의 Java `@Size`가 서로 다른 문자 단위를 사용하기 때문이다. 기존 E/C-3의 400/보존 검사가 PASS인 것은 결함 재현과 데이터 보존의 성공이며, 요구사항의 저장 성공이 아니다. 임의 절단·제품 코드 수정 없이 팀의 문자 단위 합의가 필요한 Bug로 분리했다.

FE·BE 기능명세는 아직 상태/세부 계약이 일부 미확정으로 기재되어 있고, 데이터 수집 규격과 현재 구현은 이미 누적값·behaviorVersion·IndexedDB·END_PENDING을 구체화했다. 열린 앞선 후보가 finalized되기 전 sequence 전송을 보류하는 정책과 활성 10초 분석 시점의 조정도 데이터 수집 규격에 기존 협의 대상으로 남아 있다. 이번 검증에서 AI 분류나 해당 제품 정책을 변경하지 않았다.

## 정리와 변경 파일

- `fe/scripts/visit-integration-test.mjs`: 기존 통합 시나리오 재사용, 첫 시나리오의 7개 방문·단계별 SQL·저장 필드·재방문·제외 보강.
- `fe/README.md`: 이 검증 문서로 연결.
- `docs/fe-collection-e2e-validation.md`: Git/중복 분석, 실행 명령, 체크리스트별 결과와 결함/미검증 범위.

최종 확인 시 전용 DB는 초기 fixture 실패·재실행까지 합쳐 합성 세션 47개(ACTIVE 33, ENDED 14), 방문 95개, Window 21개였다. 과거 로컬 stop 시나리오는 서버 ACTIVE를 유지하는 기존 검사이므로 전체 ENDED라고 주장하지 않는다. **이번에 직접 만든 BE 프로세스와 MySQL 컨테이너·익명 볼륨은 종료/제거했다.** 스크립트는 각 Chrome 프로필·임시 확장·합성 HTTP 서버를 finally에서 정리했다. 실제 사용자 데이터와 운영 DB에는 변경하지 않았다.
