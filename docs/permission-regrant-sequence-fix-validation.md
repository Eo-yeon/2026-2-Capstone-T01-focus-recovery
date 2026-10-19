# 사이트 권한 재허용 sequence 충돌 수정 — Issue #64

검증일: 2026-10-19 (Asia/Seoul). [Bug #64](https://github.com/SKHU-AI-Projects-Archive/2026-2-Capstone-T01-focus-recovery/issues/64)는 #59의 실제 Chrome 권한 재허용 검증에서 발견한 `409 VISIT_SEQUENCE_CONFLICT`를 다룬다. 개인정보 없는 합성 문서와 별도 테스트 DB만 사용한다.

## Git 기준 및 재현

- 이슈를 먼저 생성해 #64를 발급받은 뒤 `fix/64/permission-regrant-sequence`를 공식 최신 main `9cf9463031d901e7c59a34af215d9de308e7c06c`에서 생성했다. 기존 worktree는 미커밋 변경이 없었다.
- origin은 개인 Fork `hyeon-marina`, upstream은 공식 `SKHU-AI-Projects-Archive`. 기존 #59 브랜치 `5e877e8`은 그대로 보존했다. #61은 미병합이므로 **실패 재현 테스트 1건만** 가져왔고 나머지 변경은 병합하지 않았다. 이번 PR은 #61에 의존하지 않는다.
- Bug/PR template을 따르며, main 직접 커밋·force push·자동 merge·다른 worktree 수정은 하지 않는다.
- 수정 전 `npm test -- tests/durable-background.test.ts -t 'keeps the next server sequence'`: **FAIL**, expected 2 / received 1. 필터로 나머지 테스트가 실행되지 않은 것을 PASS로 세지 않는다.

## 원인과 수정

`permissions.onRemoved`는 시작 영수증을 남겨 같은 세션을 재개하게 하지만, `emptyState()`로 `nextSequence`를 1로 초기화했다. 서버에는 이미 sequence1이 남아 있어 새 UUID의 sequence1을 거절한다. 또한 철회 뒤 명시적인 로컬 삭제를 실행하면 다음 순서가 다시 초기화되는 우회 경로도 있었다.

수정은 다음 네 경계에 한정한다.

1. `emptyState(sequenceStart)`로 후보·탭·본문을 모두 비우면서 **이미 발급한 순서의 상한(nextSequence)** 만 보존한다. 권한 철회와 동일 세션 영수증이 남은 로컬 삭제에서 사용한다.
2. IndexedDB에 선택적 숫자 `sequenceStart`를 저장해 삭제한 prefix 뒤의 첫 번호를 증명한다. 기존 checkpoint는 필드가 없으면 1로 해석한다. DB version·BE DTO·DB 스키마는 변경하지 않는다.
3. 영속 상태 검사에서 candidate 순서와 POST prefix를 이 시작점부터 여전히 연속 검증한다. 잘못된 시작점, 누락/변조한 prefix, candidate/POST 불일치는 거부한다. 기존 검사 조건을 무조건 제거하지 않는다.
4. 새 세션 시작은 기존 `Collector.start()`를 통해 sequence1로 초기화한다. END_PENDING의 철회 보존·ACK·종료 게이트는 유지한다.

서버 계약은 숫자 연속성을 강제하지 않고 저장 방문을 sequence 오름차순으로 묶는다(`PageVisitController`의 기존 명세). 예를 들어 sequence1 저장 뒤 sequence2 전송 실패 상태에서 철회했다면, 재개는 **sequence3**부터 시작한다. 서버 목록을 읽어 max+1로 재계산하거나 ACK 번호만 보존하면, ACK 유실 또는 응답 대기 중이던 sequence2의 늦은 commit과 충돌할 수 있어 그렇게 처리하지 않는다. 로컬에서 발급해 영속화한 모든 번호를 재사용하지 않는다.

권한 재허용만으로 자동 수집하지 않는다. 삭제한 본문/UUID/POST/PATCH 큐도 복원하지 않는다. 같은 목표의 보존된 시작 요청을 명시적으로 재개해야 한다.

## 추가 테스트

- #59의 기존 실패 재현 1건: 같은 세션, 새 UUID, sequence2, 모의 API 응답에 대한 전송기 ACK까지 확인한다. 비동기 POST/PATCH가 다음 테스트에 남지 않도록 완료 후 정리한다.
- ACK 완료/503 미확인/응답 대기 3가지 상태에서 반복 철회 → 로컬 삭제 → Worker 재시작 → 재허용 → 명시적 재개를 확인한다. 샘플 삭제, 순서 보존, 늦은 ACK 무시, 이후 POST ACK와 재시작 복구, 새 세션 sequence1 초기화를 검사한다.
- 영속 상태 테스트 7건: 시작점7의 후보/POST/PATCH 저장·재로드, 변조된 prefix·counter·후보·POST 거부, 시작점 0/음수/소수/null/문자열/안전 정수 초과 거부. 기존 필드 없는 checkpoint 검사도 유지한다.

## 검증 결과

| 검사 | 결과 | 범위 |
| --- | --- | --- |
| 수정 전 기존 재현 | FAIL | expected2 / actual1 |
| 수정 후 FE 전체 | PASS | 26파일 **765건**, 실패/skip 0 |
| typecheck / build | PASS | 배포 manifest에 수집 권한 추가 없음 |
| 실제 Chrome 권한 UI + BE/DB | PASS | 신규 프로필, 실제 허용·2회 철회/재허용·완전 재시작, 같은 세션 201·SQL·Window·ENDED |
| MV3 브라우저 회귀 | PASS | headless 임시 프로필, 합성 API/DOM. native 다중 창/최소화 자동 검사는 SKIP |
| 기존 실제 방문 회귀 | PASS | 7방문/sequence1~7·단계별3Window·중복/장애/Unicode 경계·Worker 복구 |
| 기존 실제 행동 회귀 | PASS | 12개 시나리오, POST ACK 이후 PATCH·SQL·재시작/재로드·stale/409 |
| 기존 실제 종료 회귀 | PASS | 12개 시나리오, 실제 ENDED·ACK 실패/중단 복구·불일치 원본 보존 |
| BE 단위/API 테스트 재실행 | SKIP | BE 제품·계약 변경 없음. 실제 API/SQL은 위 종단 검증에서 확인 |

## 실제 Chrome → Spring Boot → MySQL 상세

macOS 27.0.1 arm64 / Chrome for Testing 151.0.7922.34 / Node25.9.0 / Java21.0.10 / Spring Boot4.1.1 / MySQL8.4.9. 새 컨테이너 `focus-recovery-issue64-20261019-d9ba`, 생성 ID `31aa954819c1…`, label issue=64, DB 포트 `64253`을 사용했다. JAR 고정 사본과 `server.port=0`으로 새 BE PID `91763`, API 포트 `64275`를 확인했다. 생성 세션이 이번 DB에 존재함을 SQL로 확인한 뒤 브라우저를 검증했다.

임시 extension은 localhost API 필수 권한만 갖고, 수집 사이트를 manifest에 추가하지 않았다. 개인정보 없는 `127.0.0.1` 합성 문서에서 실제 toolbar `현재 사이트 수집 허용` → Chrome native `허용` 버튼을 선택했다. 권한 철회/재허용은 Chrome 확장 프로그램 상세 설정의 스위치를 조작했다. Chrome permissions API로 허용/철회를 대체하지 않았다.

| 단계 | 엄격한 전후 대조 |
| --- | --- |
| 초기 및 최초 허용 | origin=false·방문0 → 실제 허용 후 기존 활성 문서 valid. 첫 페이지 확정 시 POST201·SQL sequence1 |
| 실패 큐 준비 | proxy에서 명시적503 주입. IDB sequence1 ACK / sequence2 failed, nextSequence3. 이503은 실제 BE 오류로 보고하지 않음 |
| 최초 철회 | Chrome 설정으로 이동하며 활성 세 번째 후보가 확정돼 상한4가 됨. UI 철회 후 후보/탭/POST/PATCH 큐0, sequenceStart/nextSequence4, SQL 기존1행 유지 |
| 명시적 삭제 및 재시작 | 로컬 clear 후에도 상한4. Chrome UI에서 API localhost와 수집 origin을 각각 재허용. 자동 수집 없음. 완전 종료/같은 프로필 재실행 후 origin=true·상한4 유지 |
| 같은 시작 요청 재개 | 같은 sessionId·추가 세션 생성 없음, 새 UUID/sequence4 POST201·SQL `1,4`. 과거409 재현 대신 정상 저장 |
| 반복 철회 | 다음 방문을 확정한 뒤 **철회 직전 IDB**에서 상한6·ACK4,5 확인. 수집 origin만 두 번째 철회한 뒤 상한6 유지·큐삭제, clear 후에도6 유지 |
| 두 번째 재허용·방문 | 명시적 재개 후 sequence6,7 POST201. SQL `1,4,5,6,7`, Window1개. 동일 sequence6 원본 replay200, 방문/Window 중복 없음 |
| 종료 | 마지막 방문 sequence8 및 행동 ACK 후 실제 ENDED. SQL `1,4,5,6,7,8`, Window2개, 생성 요청 총1회 |
| 새 세션 | 별도 서버 UUID, nextSequence1, 실제 sequence1 저장과 ENDED 확인 |

Window 구성도 SQL join으로 `[1,4,5,6,7]` / `[4,5,6,7,8]`을 정확히 확인했다. 재개된 방문의 정규화 URL·UTF-8 제목·본문 SHA-256을 원본 POST와 대조했다. 삭제한 본문을 복구하거나 기존 visitId/sequence를 수정한 결과가 아니다. 철회 전에 이미 저장된 서버 행은 남는다.

검증 도구 보정: 최초 수동 assertion은 설정 이동으로 세 번째 후보가 확정되는 점을 놓쳐 상한3을 기대하며 실패했다. 후보의 유효/미확정 상태와 페이지 이동에 따른 발급을 대조해 상한4를 확인했고, 두 번째 철회는 직전 IDB 상한6을 먼저 읽어 그대로 유지되는지 검사했다. SQL CLI 기본 문자셋에서 한글 출력이 `?`로 나와 최초 평문 비교도 실패했으며 `--default-character-set=utf8mb4`로 재조회해 원문과 정확히 일치함을 확인했다. 이 도구 실패를 제품 FAIL이나 최초 실행 PASS로 바꾸어 기록하지 않는다.

### 재실행

새 일회용 BE/DB를 준비하고 기동 PID/포트/datasource와 생성 세션의 SQL 존재를 확인한다. 기존 DB/서버를 재사용하지 않는다.

```sh
cd fe
npm test
npm run typecheck
npm run build
CHROMIUM_PATH='/absolute/path/to/Chrome for Testing' npm run test:browser
# 새 일회용 API/컨테이너를 명시하고 순차 실행
INTEGRATION_API_BASE_URL=http://127.0.0.1:NEW_API_PORT \
INTEGRATION_MYSQL_CONTAINER=NEW_OWN_CONTAINER node scripts/visit-integration-test.mjs
# 같은 환경 변수로 behavior-integration-test.mjs, session-end-integration-test.mjs 실행
```

native 권한은 API 호스트만 필수 권한으로 갖는 새 빌드/프로필에서 위 표 순서대로 실제 UI를 조작한다. 세션 시작 메시지, IDB `current` 원본, proxy의 성공 응답, UTF-8 SQL/Window 구성·ENDED를 각각 대조한다. UI의 허용 버튼 확인 없이 manifest 사전 권한만 부여한 실행은 native PASS에 포함하지 않는다.

검증 후 직접 생성한 BE PID/실행 경로와 MySQL ID/issue label을 확인하고 BE·컨테이너·익명 볼륨·임시 JAR·Chrome 프로필을 정리했다. 기존 서비스/컨테이너/DB는 삭제하거나 중지하지 않았다.

## 한계 및 후속 범위

변경 파일: `fe/src/background/{collector,durable-state,index}.ts`, `fe/src/shared/types.ts`, `fe/tests/{durable-background,durable-state}.test.ts`, `fe/README.md`, 이 보고서. 제품은 네 파일의 순서 보존과 검증 경계만 변경했다.

수정 전 이미 순서 정보가 삭제됐거나 409 상태가 된 오래된 원본은 임의로 재번호를 부여하지 않는다. 기존 데이터 충돌의 자동 복구는 별도 정책 검토가 필요하다. 본 수정은 정상 checkpoint에서 철회/삭제할 때 순서 손실을 방지한다.

Google/Naver 실서비스 DOM·권한 거부 안내·Windows Stable은 이번 순서 결함 수정의 검증 대상이 아니다. #59의 미완료 검색 검증을 완료했다고 주장하지 않는다. AI·BE 제품 코드·DB 스키마·수집 동의 정책은 변경하지 않는다.
