# Unicode 본문 길이 계약 수정 — Issue #56

검증일: 2026-10-19 (Asia/Seoul). [Issue #56](https://github.com/SKHU-AI-Projects-Archive/2026-2-Capstone-T01-focus-recovery/issues/56)의 본문·댓글(0건), [PR #57](https://github.com/SKHU-AI-Projects-Archive/2026-2-Capstone-T01-focus-recovery/pull/57)의 병합 상태와 전체 설명을 확인했다. 실제 실행 결과만 PASS로 기록한다.

## Git 기준과 의존 관계

- 시작: detached HEAD `5e49cb3`, Working Tree/미추적 파일 없음.
- origin: 개인 Fork `hyeon-marina/2026-2-Capstone-T01-focus-recovery`, upstream: 공식 `SKHU-AI-Projects-Archive/2026-2-Capstone-T01-focus-recovery`.
- 공식 main을 fetch한 **`54d1f6570f597026123a1c294ea681ad75e14f10`**에서 `fix/56/unicode-content-length` 생성.
- PR #57은 2026-10-19 12:40:19 KST에 이미 병합됐다. #55의 7방문·3Window 검사와 오류 복구를 그대로 확장했으며 cherry-pick·중복 E2E 파일을 만들지 않았다.
- README·프로젝트 계획서·PR template 확인. 별도 AGENTS/CONTRIBUTING/Git 가이드 없음. 계획서의 develop 통합 설명보다 사용자의 공식 main 대상 PR 지시를 우선한다. main 직접 커밋·기존 변경 삭제·force push·hard reset·자동 Merge 없음.

## 원인과 최소 변경 선택

`extractMainContent`는 `[...text].slice(0, 5000)`으로 code points를 제한한다. 검색 본문 및 Content Script 메시지 검증도 code point 기준이다. 반면 `CreatePageVisitRequest.content`의 `@Size(max=5000)`는 Java `String.length()`와 같은 UTF-16 code units를 센다. `😀` 2,501개는 2,501 code points / 5,002 code units이므로 정상 FE 본문이 400 거절됐다. 전송기에서는 이를 non-retryable로 보존해 후속 전송·종료가 차단될 수 있었다.

정책은 **최대 5,000 Unicode code points**다. 기존 FE 제한과 일치하며 보충 평면 문자도 허용한다. grapheme cluster 수와는 다르므로 결합 문자나 ZWJ 이모지는 여러 code points로 센다.

- BE: 기존 `NormalizedUrl`과 같은 Bean Validation 패턴의 `@CodePointLength(max=5000)`를 추가해 `String.codePointCount`로 검사한다. 기존 null·생략·빈 문자열·공백 허용을 유지하고 초과 입력은 기존 `INVALID_REQUEST`/`fieldErrors` 형식으로 거절한다. 오류 메시지와 OpenAPI 설명에 단위를 명시한다.
- FE: 추출 동작은 이미 올바르므로 계약 주석만 추가한다. DTO 생성·IndexedDB·전송·ACK·오류 복구·수집기 코드는 변경하지 않는다. 전송이나 저장에서 다시 자르지 않는다.
- DB: 기존 Entity/Flyway V2는 `MEDIUMTEXT`. 새 일회용 MySQL의 information_schema에서 `mediumtext`, 최대 **16,777,215 bytes**, `utf8mb4`를 확인했다. 허용 본문은 최대 20,000 UTF-8 bytes이므로 Migration 불필요.
- AI: BE `AnalysisRequestService.snapshot`은 저장 본문을 그대로 `AiAnalysisRequest.Visit.content`에 담는다. 이 DTO 및 Python `PageVisitRequest`에는 추가 본문 길이 검증이 없다. Python context 모델의 기존 `MAX_CONTENT_CHARS=600` 프롬프트 제한과 embedding 모델의 토큰 처리는 유지한다. AI 추론 서버·분류 정확도는 이번 E2E에서 검증하지 않았다.

## 회귀 테스트 변경의 근거

수정 전에 확장한 기존 `PageVisitApiTest`만 실행해 **107건 중 3건 FAIL**을 확인했다. 이모지 2,501개·5,000개 및 혼합 5,000 code points의 기대 201에 실제 400이 반환됐다. 그 뒤 BE 검증을 수정하고 통과시켰다. 성공 기대값만 바꾸어 결함을 숨긴 것이 아니다.

- 기존 API 테스트를 parameterized test로 확장: 허용 본문 8종, 초과 4종, 기존 null·생략 검사 유지. 201 원본 저장·200 멱등 재전송·DB 단일 행과 기존 오류 형식을 검증한다.
- 재사용 Annotation 단위 테스트 6건: 별도 `max=2`로 설정값 반영, null·빈 문자열, 한글/보충 문자 혼합, 오류 필드·메시지 보간을 확인한다.
- FE 추출 테스트 8건 추가: 정확한 Unicode prefix, 혼합 경계·마지막 이모지의 surrogate pair 보존. 기존 API payload 테스트의 2,501개 기대를 400→201로 수정하고 5,000개·혼합·5,001개 거절 사례를 추가한다. 이 API 단위 검사는 모의 응답이며 실제 서버 검증은 아래 E2E가 담당한다.
- 기존 E/C-3의 2,501개 400 기대를 정상 저장으로 변경한다. 400 복구 검사는 삭제하지 않고 **테스트 프록시의 onVisit hook에서 전송 본문만 5,001 code points로 명시적으로 바꾸어 실제 BE 검증 실패**를 발생시킨다. 정상 Chrome 추출은 5,000에서 제한되므로 이 주입은 정상 수집 사례로 보고하지 않는다. 실제 400/INVALID_REQUEST·DB 0행·IDB 원본과 non-retryable 상태 보존·Worker 재시작·재시도 금지·명시적 clear를 검사한다. 제품 데이터는 변경하지 않는다.

## 실행 환경과 명령

macOS arm64, Node 25.9.0 / npm 11.12.1, Chrome for Testing 151.0.7922.34, Java 21.0.10, Spring Boot 4.1.1, MySQL 8.4.9. 임시 Chrome 프로필과 새 **`focus-recovery-issue56-e2e`** 컨테이너만 사용했다. 기존 개발/운영 컨테이너·사용자 데이터에 접근하지 않았다. 테스트 DB 바인딩은 `127.0.0.1:60964`, BE는 `127.0.0.1:18056`이다.

```sh
# repository root: 이름이 이미 존재하면 재사용하지 말고 새 이름 사용
docker run --detach --name focus-recovery-issue56-e2e \
  --label focus-recovery.issue=56 --publish 127.0.0.1::3306 \
  --env MYSQL_ALLOW_EMPTY_PASSWORD=yes --env MYSQL_DATABASE=focus_recovery mysql:8.4
docker port focus-recovery-issue56-e2e 3306
docker exec focus-recovery-issue56-e2e mysqladmin ping --silent

cd be
export JAVA_HOME=/Users/hyeon/Library/Java/JavaVirtualMachines/temurin-21.0.10/Contents/Home
# 수정 전 결함 검출용 1회 (107 tests / 3 failures)
./gradlew --offline test --tests '*PageVisitApiTest'
# 수정 후 전체 테스트 및 JAR; OpenAPI 설명 수정 후 최종 실행도 성공
./gradlew --offline test bootJar
cp build/libs/focus-recovery-0.0.1-SNAPSHOT.jar /tmp/focus56-e2e-server.jar
"$JAVA_HOME/bin/java" -jar /tmp/focus56-e2e-server.jar \
  --spring.profiles.active=e2e --server.address=127.0.0.1 --server.port=18056 \
  '--spring.datasource.url=jdbc:mysql://127.0.0.1:60964/focus_recovery?serverTimezone=UTC' \
  --spring.datasource.username=root --spring.datasource.password= \
  --spring.jpa.hibernate.ddl-auto=validate --focus-recovery.ai.base-url=http://127.0.0.1:1
```

재실행 시 Java/Chrome 경로는 로컬 경로로, MySQL 포트는 `docker port` 결과로 바꾼다. 명시적 e2e profile/datasource를 사용해 기존 local DB 설정을 가져오지 않는다. AI 주소는 연결이 거부되는 테스트 주소이며 AI 성공을 저장/Window 성공으로 간주하지 않는다.

```sh
cd fe
npm ci --no-audit --no-fund
npm test
npm run typecheck
npm run build
node --check scripts/visit-integration-test.mjs
node --check scripts/visit-test-proxy.mjs
export CHROMIUM_PATH='/Users/hyeon/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
npm run test:browser
HEADED=1 npm run test:browser
export INTEGRATION_API_BASE_URL=http://127.0.0.1:18056
export INTEGRATION_MYSQL_CONTAINER=focus-recovery-issue56-e2e
node scripts/visit-integration-test.mjs
node scripts/behavior-integration-test.mjs
node scripts/session-end-integration-test.mjs
# repository root
git diff --check
```

## 실제 경계값 저장 결과

모든 행은 실제 Chrome Content Script → IndexedDB → POST → Spring Boot → MySQL 검사다. 추출 원문과 IDB/201 응답/200 재전송 본문을 비교하고 SQL `CHAR_LENGTH`, `OCTET_LENGTH`, `SHA2(content,256)`를 원본과 대조했다. 재전송·Worker 종료/재기동 뒤 ACK checkpoint·GET 목록 불변과 SQL 단일 행을 다시 확인했다.

| 합성 본문 입력 | 저장 code points | 저장 UTF-16 units | UTF-8 bytes | 결과 |
| --- | ---: | ---: | ---: | --- |
| 한글 5,000개 | 5,000 | 5,000 | 15,000 | PASS 201 / replay 200 |
| 영문 5,000개 | 5,000 | 5,000 | 5,000 | PASS 201 / replay 200 |
| 이모지 2,500개 | 2,500 | 5,000 | 10,000 | PASS 201 / replay 200 |
| 이모지 2,501개 | 2,501 | 5,002 | 10,004 | PASS 201 / replay 200 |
| 이모지 5,000개 | 5,000 | 10,000 | 20,000 | PASS 201 / replay 200 |
| 이모지 5,001개 | 5,000 (추출에서 제한) | 10,000 | 20,000 | PASS 201 / replay 200 |
| `한a😀𐐀` × 1,250 | 5,000 | 7,500 | 15,000 | PASS 201 / replay 200 |

최종 JAR 재검증에서 Bug #56의 2,501개 저장 방문 ID는 **`1dcdfdac-ca65-49ff-81be-e38cd043a8d7`**다. 원본 본문과 SQL SHA-256 `dc3ef291b9b160750ab980e09909ea16c3a710741e5b068199135f2f49eff581` 일치, 1행 저장, 중복 행 없음, Worker 재시작 후 ACK 유지까지 확인했다.

## 실행 판정

| 검사 | 결과 | 근거 |
| --- | --- | --- |
| FE `npm test` | PASS | 25파일 / 726건 (기존 715 + 신규 11), 실패 0 |
| FE typecheck / production build | PASS | 각각 실행, 번들 생성 |
| BE Java 21 전체 test / bootJar | PASS | 16 suite / 361건 (기존 345 + 신규 16), failure/error/skipped 0 |
| Node 구문 / git diff 공백 | PASS | 변경 스크립트 2개 및 전체 diff |
| Chrome MV3 headless | PASS | 실제 확장, 합성 API/검색 DOM; native 창 검사는 이 실행에서 SKIP |
| Chrome MV3 HEADED | PASS | native 다중 창 포커스·최소화·복원 포함 exit 0 |
| 실제 visit 통합 | PASS | 경계값 7개·400 오류 복구, 기존 A/B/C 및 7방문·3Window 전체 exit 0 |
| 실제 behavior 통합 | PASS (재실행) | 기존 12개 시나리오 전체, POST/PATCH/SQL·버전/충돌·Worker/브라우저/reload 복구 |
| 실제 session-end 통합 | PASS (재실행) | 기존 12개 시나리오 전체, 최종 ACK 게이트·END_PENDING·SQL ENDED·종료 충돌/오류 복구 |

방문 회귀에서는 1~7번 ACK 직후 MySQL Window 수 **0,0,0,0,1,2,3**, 구성 **[1,2,3,4,5] / [2,3,4,5,6] / [3,4,5,6,7]**를 확인했다. 제목·URL·합성 검색어·민감/로그인/짧은 페이지 제외, visitId/sequence, 503 재시도, ACK 유실 후 중복 재전송, Worker 복구, 삭제 경합 검사를 유지했다.

초기 행동·종료 통합 실행은 각각 exit 1 / `Test gate timed out`으로 실패했다. 실행 중인 JAR를 OpenAPI 설명 갱신 빌드로 덮어써 서버에 `NoClassDefFoundError`(Logback 등)가 발생한 실행 환경 실수였다. 해당 전용 서버만 종료하고 최종 JAR를 `/tmp/focus56-e2e-server.jar`로 복사해 고정했다. 이후 방문·행동·종료 3종을 순서대로 재실행해 모두 exit 0으로 통과했다. 고정 JAR와 최종 bootJar의 SHA-256도 일치했다. 기대값·timeout·제품 로직을 바꾸지 않았고 초기 실패의 합성 DB 데이터도 삭제하지 않았다.

**BLOCKED / 미실행:** 실제 Google/Naver 서비스 DOM 전체, 사용자 권한 허용 dialog, Windows Chrome, 실제 네트워크 단절·디스크 소진, AI 추론·분류 성능. 검색 DOM은 합성 응답, 권한은 임시 manifest 사전 부여, 장애는 명시적 테스트 주입이다. 이전 버전에서 이미 non-retryable failed로 저장된 방문의 자동 해제는 변경/검증하지 않았다. 기존 원본을 임의 삭제하거나 실패 상태를 자동 재전송 가능 상태로 바꾸지 않는다.

## 변경 파일과 정리

- BE 제품: `CreatePageVisitRequest.java`, `CodePointLength.java`, `PageVisitController.java` (검증 및 OpenAPI).
- BE 테스트: 기존 `PageVisitApiTest.java`, `CodePointLengthTest.java` (Annotation 단위 검사만 별도).
- FE: `src/content/extraction.ts` (주석만), `tests/extraction.test.ts`, `tests/visit-api.test.ts`, `scripts/visit-integration-test.mjs`, `scripts/visit-test-proxy.mjs`.
- 문서: 수집 규격, FE·BE 기능명세, FE README, 이 보고서, #55 보고서의 후속 보고서 안내. #55 당시 실패 기록은 역사로 유지했다.

검증 종료 후 직접 생성한 BE 프로세스 및 `focus-recovery-issue56-e2e` MySQL 컨테이너·익명 볼륨을 종료/제거했다. 각 스크립트는 임시 확장·Chrome 프로필·HTTP 서버를 finally에서 정리했다. 운영 DB·기존 데이터·AI 코드·의존성·배포 manifest·Flyway는 수정하지 않았다.
