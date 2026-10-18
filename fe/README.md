# Focus Recovery Chrome Extension (Issue #9·21·32·34·43 / FE-001·002·004~007)

Manifest V3 기반 개발용 페이지 수집기입니다. React popup의 목표로 Background Service Worker가 Spring Boot `POST /api/sessions`를 호출하고, 검증된 서버 세션으로 수집을 시작합니다. 확정된 유효 방문·본문·초기 행동 정보는 `POST /api/sessions/{sessionId}/visits`로 저장하고 응답을 검증합니다. 행동 PATCH·AI 연동은 아직 구현하지 않습니다. **로컬 수집 종료는 서버 종료가 아니며 서버 세션은 ACTIVE로 남을 수 있습니다.**

## 방문 기록 저장 및 ACK (Issue #43)

`src/api/visit.ts`는 세션 생성용 `postJson()`과 분리된 방문 클라이언트입니다. Content Script는 서버에 직접 접근하지 않고 Background만 호출합니다. `sessionId`는 경로에만 넣고, DTO의 `visitId`, `sequence`, `browserTabKey`, `normalizedUrl`, `domain`, `title`, `content`, `searchQuery`, `isSearchResultPage`, `visitedAt`, `activeDurationMs`, `tabSwitchCount`, `behaviorVersion`을 명시적으로 선택합니다. 세션 생성의 `Idempotency-Key`를 방문 요청에 보내지 않습니다. FE의 UUID·sequence·URL·본문·검색어는 다시 생성하거나 정규화·절단하지 않습니다. `visitedAt`은 Collector의 `toISOString()` UTC 밀리초 문자열을 그대로 보내며 이 형식이 아니면 전송하지 않습니다.

전송 시점은 기존 판정 정책을 따릅니다. 새 문서/SPA 방문으로 교체, 탭 닫기, 로컬 수집 종료, 수집 한도 도달 등으로 후보가 종료되고 앞선 후보가 모두 확정되어 `readyVisits`에 포함된 방문만 큐에 추가합니다. `pending`, `excluded`, `sequence: null`은 전송하지 않습니다. 앞선 열린 탭이 있으면 뒤 방문도 기다립니다. 연속 sequence를 그대로 사용하며 BE가 허용하는 번호 공백 정책에 맞추기 위해 재번호를 매기지 않습니다.

`src/background/visit-delivery.ts`는 큐에 처음 추가할 때 평탄한 `PageVisit` 복사본을 고정합니다. 이후 Collector의 체류시간·전환 횟수·버전 변화는 이 요청에 반영하지 않습니다. 큐 상태와 최초 요청은 HTTP 전에 trusted `storage.session`에 저장합니다. 기존 직렬 실행기는 Collector 처리·스냅샷·저장·전송 상태 반영만 수행하며, **fetch와 응답 대기는 직렬 실행기 밖**에서 수행합니다. 이벤트 도착 순서를 유지하고 HTTP 중에도 수집과 로컬 종료를 처리합니다.

한 번에 한 요청만 실행하고 sequence 오름차순으로 보냅니다. 복원 시 Collector/저장된 세션 생성 응답의 세션 ID와 큐 세션을 비교하고, ACK가 앞에서부터 연속된 상태인지 확인합니다. 세션 불일치나 앞 미확인·뒤 ACK 상태는 원본을 수정하지 않고 보류합니다. 성공 응답의 검증이 끝나 `acked`가 된 뒤에만 다음 방문을 보냅니다. 새 이벤트는 동일 ID를 다시 큐에 넣지 않습니다. Worker 재기동 뒤 첫 확장 이벤트에서 checkpoint를 읽고 `sending`을 동일 스냅샷의 재시도로 복구합니다. ACK가 있으면 재전송하지 않습니다. 서버 저장 후 응답만 유실되면 같은 ID·원본으로 POST하여 BE의 200 재전송 응답을 받습니다. 중복 행·Window 방지는 BE의 기존 원본 비교·유일성 제약과 이 순차 ACK 정책을 함께 사용합니다.

| 응답/실패 | 처리 |
| --- | --- |
| 201 | sessionId와 모든 원본 필드 일치, UTC 밀리초 시각, 초기 행동 값 일치, `updatedAt=null` 확인 후 ACK |
| 200 | sessionId와 모든 원본 필드 일치 확인 후 ACK. 서버 행동 값은 안전한 정수이며 초기 값보다 작지 않아야 하고 `updatedAt`은 null 또는 UTC 밀리초 시각이어야 함 |
| 400 | 요청 확인 필요 상태로 유지, 자동·버튼 재시도 없음 |
| 404 | 세션/리소스 확인 필요 상태, 자동 새 세션 생성 없음 |
| 409 | `SESSION_ENDED`, `VISIT_ID_CONFLICT`, `VISIT_SEQUENCE_CONFLICT`, `VISIT_SEQUENCE_OUT_OF_ORDER` 코드 보존, 재시도/ID·순서 교체 없이 보류 |
| network·10초 timeout·5xx·408·429·읽을 수 없는 성공 JSON | 정상 연속 실행에서 최초 포함 최대 3회, 첫/둘째 실패 후 1초/2초 대기. 소진 후 명시적 **같은 방문 재시도**로 같은 스냅샷을 최대 3회 다시 시도 |
| 원본과 다른 성공 응답·알 수 없는 거절 | ACK하지 않고 확인 필요 상태로 유지 |
| 전송 checkpoint 손상·API 주소 변경·저장 실패 | 원본 checkpoint를 자동 덮어쓰지 않고 전송 보류. Worker/저장소 및 기존 서버 확인 필요 |

어떤 실패든 앞 방문이 미확인인 동안 후속 방문은 보내지 않습니다. Popup의 **서버 저장 확인**은 검증된 ACK 건수이며 유효 방문 수와 구분합니다. `queued`/`sending`/`retry-wait`/`failed`와 시도 횟수·안전한 오류·409 코드를 **상태 새로고침**으로 확인합니다. 서버 오류 메시지·필드 오류 원문과 수집 본문을 로그에 출력하지 않습니다.

로컬 수집 종료는 남은 후보를 확정하고 전송을 계속하지만, 서버 세션 종료는 호출하지 않습니다. 미확인 방문이 있으면 신규 세션 시작을 막아 원본이 사라지지 않게 합니다. 일시 실패는 같은 방문 재시도, 영구 실패는 서버 확인이 필요합니다. 사용자가 종료 후 **로컬 기록 삭제**를 선택하면 미확인 요청도 삭제됩니다. 권한 철회도 수집과 남은 큐를 지우며, 늦게 도착한 ACK가 기록을 재생성하지 않습니다. 이미 전송 중인 요청은 서버에 저장될 수 있고 로컬 삭제·권한 철회는 서버 삭제가 아닙니다.

`storage.session` checkpoint는 IndexedDB 영속 큐가 아닙니다. **브라우저 재시작·확장 reload/업데이트 시 미전송 방문·ACK가 유실될 수 있습니다.** 저장 전에 Worker가 종료되거나 저장소 쓰기가 실패한 구간도 복구를 보장하지 않습니다. 재시도 타이머가 Worker를 계속 살려두거나 자동으로 깨우는 보장도 없으며 다음 이벤트에서 재개합니다. 기존 세션 생성 키·응답의 local 복구 정책은 유지합니다. 전송 스냅샷은 본문 저장량을 늘리므로 `storage.session` 용량 초과 시 수집/전송 상태 확인이 필요합니다. 브라우저 재시작 복구·행동 PATCH·최종 행동 ACK·서버 종료·END_PENDING·AI 호출은 후속 Issue 범위입니다.

명세 차이: FE 본문 제한은 5,000 Unicode code point이고 현재 BE `@Size(max=5000)`는 Java UTF-16 길이입니다. 이모지 등 비 BMP 문자가 많으면 FE 제한 내 본문도 400이 될 수 있습니다. 원본을 자르거나 BE·명세를 변경하지 않고 요청 오류로 남깁니다. 문자 단위 통일은 팀 확인이 필요합니다. 기존 명세의 활성 10초 분석 시점과 열린 앞선 탭에 의한 전송 지연, 영구 실패 후 운영 복구 정책도 별도 협의 대상입니다. 문서의 IndexedDB 전체 복구 요구는 이번 구현에서 충족하지 않습니다.

### 실제 FE–BE–MySQL 검증 절차

1. 개인정보가 없는 **전용 테스트 DB**에 기존 BE를 연결하고 실행합니다. 예: 별도 MySQL 8.4의 `focus_recovery`, Java 21, `DB_URL`과 BE 포트 지정. 기존 데이터베이스에 테스트를 실행하지 마세요.
2. `fe`에서 아래 명령을 실행합니다. 스크립트는 임시 확장/프로필에 합성 문서 호스트 권한을 부여하고, 실제 Popup → 세션 API → Collector → 방문 API를 사용합니다. 성공 요청은 테스트 전용 HTTP 프록시(`scripts/visit-test-proxy.mjs`)를 거쳐 실제 BE에 전달합니다. BE가 실제 저장을 마친 뒤 응답만 보류할 수 있습니다. A-2/A-3의 실패 구간만 프록시가 503을 주입하며, 이를 실제 BE 오류 검증으로 간주하지 않습니다. `CHROMIUM_PATH`는 설치한 Chrome for Testing 실행 파일입니다.

```sh
INTEGRATION_API_BASE_URL=http://localhost:18043 \
CHROMIUM_PATH="/absolute/path/to/Chrome for Testing" \
node scripts/visit-integration-test.mjs
```

3. 비밀번호 없는 root를 쓰는 **전용 임시** MySQL 컨테이너라면 `INTEGRATION_MYSQL_CONTAINER=컨테이너명`을 함께 지정하면 실제 SQL로 방문·Window 수와 구성도 검사합니다. 이 옵션이 없으면 DB 검사는 명시적으로 SKIP합니다. 비밀정보를 인자·문서에 넣지 마세요. 스크립트는 방문 6개/sequence 1~6, ACK, 실제 서버 GET 결과, 각 방문의 동일 POST 200 재전송, 재전송 전후 실제 SQL의 방문 6개·Window 2개와 `[1,2,3,4,5]`, `[2,3,4,5,6]` 구성, Worker 재기동의 ACK 복구를 확인합니다. 추가로 A/B 연속 세션, 미확인 방문의 신규 시작 차단과 명시적 재시도, BE 저장 직후 ACK 유실+실제 Worker target 종료, 전송 중 로컬 종료/삭제, Unicode 경계를 검사합니다. 임시 브라우저 파일은 자동 삭제합니다. 생성된 서버 세션은 ACTIVE로 남으므로 검증 후 전용 BE/DB 컨테이너를 정리하세요.
4. `CHROMIUM_PATH="…" npm run test:browser`는 별도 합성 API 회귀 테스트입니다. 세션 응답 유실/동일 키 복구, 방문 응답 유실/동일 ID 재전송 200, 검색·SPA·탭·Worker·제외 정책을 검사합니다. 실제 BE 검증과 구분합니다.

### Issue #43 실행 결과 (2026-10-18)

- `npm run typecheck`, `npm test` **16개 파일 / 405개 성공**, `npm run build`, `git diff --check`: 성공. 기존 338개 검증을 유지하고 방문 API·전송기·Background 검증 67개를 추가했습니다.
- macOS Chrome for Testing **151.0.7922.34**, 합성 API MV3 테스트: 성공. 방문 응답 유실 후 동일 ID 재시도, 200 ACK, 순서 및 Worker 복구를 포함합니다. 기본 Playwright 바이너리는 설치되어 있지 않아 첫 실행은 실패했고, 기존 설치 바이너리를 명시해 통과했습니다. native 다중 창 포커스/최소화는 `HEADED=1` 미실행으로 SKIP했습니다.
- 실제 Java **21.0.10**, Spring Boot **4.1.1**, 전용 MySQL **8.4.9**, 위 Chrome의 실제 6개 수집 방문 저장·ACK·6개 중복 POST 200·목록 불변·Worker ACK 복구를 검증했습니다. 실제 SQL에서 재전송 전후 모두 중복 없는 방문 6개·Window 2개, Window 1=[1,2,3,4,5], Window 2=[2,3,4,5,6]를 확인했습니다. 임시 BE와 테스트 컨테이너는 검증 후 정리했습니다.
- Windows 11 Chrome Stable, 실제 사이트의 새 Google/Naver DOM, 화면 기반 권한 dialog는 이번 작업에서 검증하지 않았습니다. 행동 PATCH·브라우저 재시작의 방문 복원은 구현하지 않았습니다.

### Issue #43 리뷰 후 보완 검증 (2026-10-18)

작업 기준은 `feat/43/page-visit-api-integration`의 `d9e0e72`, 미커밋 변경 없음입니다. 최신 `upstream/main`은 `b9f6de5`이며 별도 알림 기능의 6개 커밋은 병합하지 않았습니다. 이 검증은 현재 작업 브랜치의 BE/Flyway V1~V8로 수행했습니다.

정상 세션 혼합은 재현되지 않았습니다. 기능 수정은 두 재현 테스트로 확인한 복원 검증 누락에 한정합니다. 기존 큐의 내부 세션 ID가 일치해도 Collector와 다른 세션이면 차단하며, 앞 방문이 미확인인데 뒤 방문이 ACK인 불가능한 순서도 차단합니다. 두 경우 모두 원본 checkpoint를 자동 덮어쓰거나 ID/sequence를 고치지 않습니다. 정상 세션 전환, Collector·Popup·API 클라이언트 정책은 변경하지 않았습니다.

| 항목 | 실제 검증 및 결과 |
| --- | --- |
| A-1 연속 세션 | A의 방문 6개를 모두 ACK한 뒤 로컬 종료하고 명시적 기록 삭제 없이 B 생성. B의 2개 방문은 새 세션과 sequence 1·2로 저장. Worker 재기동 후 A 재전송·중복·복원 충돌 없음. 실제 세션별 SQL/GET 확인 |
| A-2 미확인 방문 | 프록시 503을 3회 주입. 새 세션 API 호출 차단, 오류 표시, 원본 스냅샷·ID·sequence 보존. 이 실패 자체는 주입된 전송 오류이며 실제 BE 장애가 아님 |
| A-3 명시적 재시도 | 503 주입 해제 후 같은 요청이 실제 BE에 저장·ACK됨. 이후 새 세션에서 2개 방문 정상 저장 |
| B 저장 직후 Worker 중단 | 실제 BE의 5번째 방문 201과 첫 Window SQL 저장 확인 후 응답 보류. FE checkpoint는 `sending`, 6번째 방문은 `queued`. CDP `Target.closeTarget`과 기존 target 소멸 확인 뒤 재기동. 같은 5번 원본 POST가 실제 BE의 200으로 ACK되고, 저장된 ACK를 확인한 뒤에만 6번 요청 도착 |
| Window 일관성 | 중단 전 실제 SQL에 방문 5개·Window 1개, 복구 후 방문 6개·Window 2개. 각 방문 ID·sequence와 Window index·끝 방문 중복 없음. 구성 [1,2,3,4,5], [2,3,4,5,6] 유지 |
| C-1 전송 중 로컬 종료 | 5번 응답 보류 중 로컬 종료가 즉시 처리되고 6번 후보 확정. 복구 후 두 요청이 순차 저장되며 로컬 종료 상태 유지. Worker 중단 없는 종료 흐름도 Background 회귀 테스트로 확인 |
| C-2 전송 중 로컬 삭제 | 실제 BE가 1번을 저장하고 응답을 보류한 동안 로컬 종료·명시적 삭제. 늦은 실제 201 수신 후에도 checkpoint·후보는 비어 있고 2번 미전송. 서버의 1번 기록은 유지. Popup의 서버 저장 가능성·서버 삭제 아님 안내 확인 |
| C-3 실패 후 삭제 | 실제 Unicode 400 원본이 Worker 재기동·허용되지 않는 재시도 뒤에도 보존됨. 명시적 기록 삭제 후에만 로컬 제거. 삭제 전 경고 표시 확인 |
| Unicode | 실제 Collector 추출→BE 전송. 한글 5,000자·영문 5,000자·이모지 2,500개(UTF-16 5,000)는 201. 이모지 2,501개(code point 2,501 / UTF-16 5,002)는 실제 400, DB 0건. 요청 원본을 절단·보정하거나 새 ID로 보내지 않음 |

`queued`·`sending`·`retry-wait`·`failed`·`acked`의 각 복원은 단위 테스트와 실제 Background 모듈을 재로드하는 모의 Chrome/HTTP adapter 테스트에서 모두 확인했습니다. `sending`은 같은 원본으로 재시도, `acked`는 중복 전송 없음, `retry-wait`는 대기 시각 유지, `failed`는 자동 재시도 없이 유지합니다. 실제 Chrome·BE 테스트에서는 `sending`+`queued`, `failed`, `acked` 복구를 확인했으며 `retry-wait` 상태 자체에서의 실제 Chrome 강제 종료는 별도로 실행하지 않았습니다. 손상·세션 불일치·ACK 역전·API Base URL 변경의 차단과 원본 보존은 모의 adapter/단위 테스트 범위입니다.

재시도 보장 범위는 정상 연속 실행에서 최초 포함 최대 3회(1초/2초 대기), 이후 명시적 재시도입니다. `sending`으로 중단된 요청은 결과를 모르므로 재기동 시 같은 스냅샷으로 추가 전송할 수 있습니다. 마지막 시도 도중 중단됐다면 복구 전송으로 시도 횟수가 4가 될 수 있고, 이 요청이 실패하면 `failed`로 멈추는 것을 테스트했습니다. **Worker 중단이 반복되는 전체 수명에 걸친 최대 3회 보장은 아닙니다.** 별도 장기 재시도 스케줄러나 전역 예산은 구현하지 않았습니다.

로컬 종료는 수집만 끝내고 확정 방문 전송을 계속합니다. 미확인 방문이 있으면 새 세션을 차단하며, 사용자의 명시적 로컬 삭제는 복구용 스냅샷까지 제거합니다. 이미 전송 중이거나 저장된 서버 데이터는 삭제되지 않습니다. 늦은 ACK는 삭제된 로컬 큐를 재생성하지 않습니다. 기존 Popup 안내를 유지했고 자동 초기화는 추가하지 않았습니다.

검증 환경은 macOS Chrome for Testing 151.0.7922.34, Java 21.0.10, Spring Boot 4.1.1, 전용 임시 MySQL 8.4.9입니다. 초기 Playwright Worker `close` 이벤트 대기는 timeout이 발생해, 확장 Worker의 CDP target 종료 및 소멸을 직접 확인하는 방식으로 변경했습니다. 성공 응답과 SQL은 실제 BE/DB 결과이며 본문·개인정보·비밀정보는 출력하지 않습니다.

- 자동 테스트: 기존 **405개 유지 + 신규 27개 = 432개**. 전송기 복원 14개, Background 세션/복원/삭제 9개, API Unicode 4개. 기존 검증 삭제·완화 없음.
- `npm run typecheck`, `npm test`(16개 파일 / 432개), `npm run build`, `git diff --check`: 최종 실행 성공. 기존 합성 API MV3 브라우저 테스트도 성공했으며 native 다중 창 검사는 SKIP했습니다.
- 새 실제 통합 시나리오 A-1/A-2/A-3/B/C-1/C-2/C-3/E와 SQL 검사: 최종 재실행 성공. 테스트 서버와 전용 MySQL 컨테이너/데이터는 검증 후 정리했습니다. A-2/A-3의 503 구간은 명시적으로 프록시 주입 오류로 구분합니다.
- Windows 11 Chrome Stable, native 다중 창 포커스/최소화(`HEADED=1`), 화면 기반 권한 dialog, 실제 Google/Naver DOM 재검증은 미실행입니다. BE 단위 테스트 전체는 이번 FE 보완 작업에서 실행하지 않았습니다.

현재 구현은 통제된 파일럿 수집에 사용할 수 있습니다. `storage.session`은 같은 브라우저 세션의 Worker 재기동 복구를 지원하지만 브라우저 재시작·확장 reload/업데이트·저장 전 종료·저장소 장애·명시적 삭제에서 미전송 데이터가 유실될 수 있습니다. 타이머는 Worker를 자동으로 깨우거나 장기간 유지하지 않으며 다음 확장 이벤트가 필요할 수 있습니다. 장기 무손실 수집에는 IndexedDB 영속 큐와 복구 정책이 필요합니다. 이는 이번 보완에서 구현하지 않았습니다.

BE의 UTF-16 제한과 FE의 code point 제한을 통일할지 팀 협의가 필요합니다. 현재는 원본을 유지하고 400으로 멈추므로 후속 방문 전송도 보류됩니다. 열린 탭에 의한 전송 지연과 활성 10초 분석 시점, 영구 실패 시 운영 복구 방식도 후속 협의 대상입니다. 행동 PATCH·서버 종료·END_PENDING·AI·장기 alarms 스케줄러·DB 스키마 변경은 포함하지 않았습니다.

## 개발 환경 및 명령

- Node.js 22.12 이상, npm (lockfile 포함)
- TypeScript, React 19, Vite 7, Chrome API 타입
- Vitest + jsdom: 순수 정책, 상태 관리, Chrome API adapter 테스트
- Playwright: 격리된 Chrome for Testing/Chromium에서 MV3 실행 테스트
- Chrome 106 이상: `documentId`, `documentLifecycle`, `storage.session` 기반

```sh
cd fe
npm ci
npm test
npm run build
npm run build:dev
npm run dev
```

`build`는 타입 검사 후 `dist/`에 popup, ES module Service Worker, 단일 IIFE Content Script 및 manifest를 생성합니다. `build:dev`는 개발 모드 빌드입니다. `dev`는 최초 두 번들을 빌드한 후 변경을 감시합니다. HMR 서버를 사용하지 않으므로 코드 변경 후 Chrome 확장 프로그램을 새로고침하고 열린 웹페이지도 새로고침해야 합니다. 두 watcher는 출력 폴더를 지우지 않아 서로의 번들을 보존합니다. `npm run typecheck`로 타입 검사만 실행할 수 있습니다.

## API 설정 및 복구 (Issue #34)

`src/api/client.ts`의 `postJson()`은 세션 생성 전용 fetch·10초 timeout(본문 수신 포함)·오류, `session.ts`는 POST와 응답 검증, `types.ts`는 현재 BE DTO를 담당합니다. Content Script는 BE를 직접 호출하지 않습니다. HTTP 201, UUID, 목표 일치, UTC 밀리초 시각, ACTIVE/ENDED 및 endedAt을 확인하고 ACTIVE만 수집에 사용합니다. 서버 오류 본문은 사용자/로그에 노출하지 않습니다.

기본 주소는 `http://localhost:8080`입니다. `.env.example`을 `.env.development.local` 또는 `.env.production.local`로 복사해 `VITE_API_BASE_URL`을 HTTP(S) origin으로 설정합니다. `npm run build`는 production, `build:dev`/`dev`는 development 값을 사용합니다. 환경 변경 후 다시 빌드하고 확장을 reload합니다. 값에 비밀키나 인증정보를 넣지 않습니다.

빌드는 해당 API 호스트 **한 개**만 `host_permissions`에 생성합니다. Chrome 호스트 권한은 포트를 제한하지 못하므로 같은 scheme·hostname의 모든 포트는 수집 대상에서 제외합니다. 사이트별 선택 권한 선언은 기존대로 유지합니다. API 주소로 localhost를 쓴다면 로컬 수집 fixture는 127.0.0.1처럼 별도 호스트를 사용하세요.

시작 요청마다 UUID 키를 만들고 HTTP 요청 **전에** 키·정리된 목표·API 주소를 trusted local storage에 저장합니다. Popup의 요청 잠금과 Background의 도착 시점 잠금, 기존 직렬 큐로 중복 시작을 차단합니다. 성공 응답도 먼저 저장하고 활성 checkpoint/메타데이터 저장과 Script 활성화를 마친 뒤 미완료 요청을 지웁니다. 완료된 키·응답은 `activeSession.startRequest`에 계속 보관하며, 정상 활성 세션을 명시적으로 로컬 종료하고 저장까지 성공한 경우 해제합니다. API 대기 중 도착한 수집 이벤트의 시각은 활성화 이전으로 소급하지 않습니다.

- 네트워크 오류·timeout·5xx·잘못된 JSON/필드: 활성화하지 않고 키를 보존합니다. **같은 요청 재시도**로 동일 목표·키를 보냅니다. 백그라운드 자동 재시도는 없습니다.
- 최초 요청의 400: BE가 생성 전에 거절한 것이므로 요청을 해제해 목표를 수정할 수 있습니다. 이전 미확인 요청의 재시도에서 받은 400은 키를 유지합니다.
- 422, ENDED 재응답, API 주소 변경, 손상된 요청: 새 키로 우회하지 않습니다. 기존 서버/목표 확인이 필요합니다. 이를 강제로 취소하는 UI는 없습니다.
- 저장·활성화·권한 동기화 실패: 수집을 중단하고 시작 정보와 기존 방문 ID·sequence를 보존합니다. 정상 활성 세션의 일반 오류도 동일하게 중단하고 완료된 요청 정보를 복구 대기로 전환합니다. 이미 수신한 정상 응답은 명시적 복구 시 재사용하며, 응답 저장 전에 Worker가 종료되었다면 같은 키로 POST합니다. 닫힌 탭의 broadcast 수신 실패는 전체 활성화 실패로 취급하지 않습니다.
- Worker 중단: 정상 활성 checkpoint는 기존 세션·방문을 복구하며 미관찰 시간을 더하지 않습니다. 활성화 미완료 또는 오류 중단(`activeSession.interrupted`) 상태는 자동 재개하지 않고 명시적 재시도를 요구합니다. 브라우저/확장 reload 후 방문 checkpoint는 사라지지만 생성 키·응답은 남아 같은 서버 세션으로 명시적으로 복구합니다.
- **로컬 기록 삭제/로컬 종료는 미확인 생성 요청을 취소하지 않습니다.** 서버에 이미 생성되었을 수 있으므로 먼저 같은 요청으로 복구해야 합니다.

Background 상태의 `sessionStartRecovery`는 `none`(복구 불필요), `pending`(같은 목표·키/저장 응답으로 복구), `invalid`(손상·불일치·키 누락·초기화 실패)를 구분합니다. 손상된 `pendingSessionStart`나 완료 요청 정보는 자동 삭제·덮어쓰지 않으며, Popup에 **시작 요청 복구 필요**를 표시하고 목표 입력·신규 시작을 차단합니다. 상태 조회와 명시적인 방문 기록 삭제는 가능하지만, 생성 요청 원본은 그대로 남습니다. 저장소 초기화 자체가 실패하면 상태 조회만 제공하고 데이터를 수정하지 않습니다. 저장소 접근을 복구한 뒤 Worker를 재시작해 다시 확인해야 합니다.

손상·불일치 또는 생성 키가 없는 구버전 서버 세션은 UI에서 안전하게 복원할 수 없습니다. 원본 저장 정보와 확인 가능한 세션 ID를 보존한 채 담당자가 기존 API 서버의 멱등성 키·세션 상태를 확인해야 합니다. **서버 확인 없이 레코드를 삭제하거나 새 키로 우회하지 마세요.** 강제 초기화·서버 조회·관리자 복구 UI는 구현하지 않았습니다. API 주소 변경은 기존 설정으로 되돌린 뒤 재시도하고, ENDED 응답은 서버 확인이 필요합니다.

오류 시에는 중단 checkpoint와 local 중단 표시를 저장하고, checkpoint 저장도 실패하면 그 checkpoint를 제거해 자동 재개를 막습니다. 두 저장소의 쓰기와 checkpoint 삭제가 모두 실패한 채 Worker까지 종료되면 중단 표시를 영속화할 수 없습니다. 이 전면 저장소 장애까지 원자적으로 보장하는 기능은 없으며, 저장소 복구 및 서버 상태 확인이 필요합니다.

**후속 작업:** BE 종료 API, END_PENDING과 마지막 방문/행동 ACK, IndexedDB 전송 큐, 브라우저 재시작 후 서버 ACTIVE 세션 정리·복구 UX를 구현해야 합니다. 현재 로컬 종료·권한 철회·브라우저 재시작은 서버 종료를 보장하지 않습니다.

2026-10-16 실제 Java 21·Spring Boot·전용 MySQL 8.4·Chrome for Testing 통합 검증은 **17개 시나리오 성공**, 당시 FE 테스트는 **309건 성공**입니다. 실제 저장·동일 키 재시도·BE 중단·응답 유실·timeout·Worker 중단 복구를 확인했습니다. 테스트 종료 후 전용 컨테이너와 임시 비밀번호는 정리했습니다.

Issue #34 당시 2026-10-18 복구 보완 후 FE 테스트는 **338건 성공**(신규 29건), 타입 검사·production 빌드 통과입니다. BE 코드는 변경하지 않았으며, 해당 Issue #34 보완 시점에는 실제 Spring Boot·MySQL 통합 검증을 재실행하지 않았습니다. Issue #43의 신규 실제 검증은 위 실행 결과를 참고하세요. 아래 브라우저 스크립트는 모의 API로 복구를 검증합니다.

## Chrome에서 로드 및 세션 검증

1. `npm run build`를 실행합니다.
2. `chrome://extensions`에서 개발자 모드를 켭니다.
3. **압축해제된 확장 프로그램을 로드**로 `fe/dist/`를 선택합니다.
4. 수집할 일반 HTTP(S) 사이트에서 확장 프로그램 아이콘을 클릭합니다.
5. **현재 사이트 수집 허용**을 누르고 해당 사이트의 접근 권한을 허용합니다. 다른 사이트를 탐색하려면 그 사이트에서도 이 단계를 수행합니다.
6. 설정한 BE 서버를 실행하고 최초 목표를 입력한 뒤 **작업 세션 시작**을 선택합니다. 이미 활성 세션이 있으면 새 세션을 만들지 않습니다.
7. 허용한 문서 탭으로 돌아가 Chrome 창과 탭을 활성 상태로 1초 이상 유지합니다.
8. popup의 **상태 새로고침**으로 후보/유효 방문 수를 확인합니다. **수집 데이터 표시**를 선택하면 본문을 포함한 구조화 데이터가 popup 안에만 표시됩니다. 화면 공유·캡처 시 주의하고 실제 개인정보를 저장소에 붙여 넣지 마세요.
9. **로컬 수집 종료**를 선택하면 새로운 후보 및 지연된 Content Script 응답을 받지 않습니다. 마지막 후보의 유효/제외 판정을 완료하고 결과는 확인용으로 유지합니다. 서버 종료 요청은 보내지 않아 BE의 ACTIVE 상태는 그대로 남을 수 있습니다.
10. 종료 후 **로컬 기록 삭제**로 데이터를 지울 수 있습니다. 미확인 방문이 없을 때 새 세션 시작 시에도 이전 결과를 지웁니다.

세션 시작 당시 이미 열려 있던 **허용된 탭**에도 Script를 주입하고 현재 문서를 후보로 등록합니다. 백그라운드 탭의 시간은 누적하지 않습니다. 방문 시각은 실제 과거 방문 시각을 추정하지 않고 이 세션에서 후보를 관찰한 UTC 시각입니다.

목표는 기존 BE `CreateWorkSessionRequest` 구현의 공백 제거 후 **5~150 UTF-16 code units** 검증과 맞췄습니다. `docs/fe-spec.md`의 길이는 아직 미확정이므로 FE 정책으로 새로 확정한 값은 아닙니다. 공백 정리는 Java `String.strip()`과 동일하며 NBSP/BOM은 임의로 제거하지 않습니다. `Collector.start`는 서버 응답만 받고 `source: server`로 표시합니다. sessionId/startedAt/status를 로컬에서 만들지 않습니다.

## 권한 및 개인정보

| 항목 | 실제 사용 목적 |
| --- | --- |
| `storage` | 활성 세션 메타데이터 및 Service Worker 중단 시 상태 복구 |
| `webNavigation` | 최상위 문서의 진입, 새로고침, 뒤로/앞으로가기 및 History API 이벤트 구분 |
| `scripting` | 사용자가 허용한 사이트에만 Content Script 등록/주입; 세션 시작 전에 열린 탭도 지원 |
| `activeTab` | 아이콘을 클릭한 현재 탭의 origin을 확인하여 사이트별 권한 요청 |
| 선택적 `http://*/*`, `https://*/*` | HTTP(S) 사이트를 선택할 수 있는 선언 범위. 실제 요청은 현재 **origin 한 개**이며 전체 사이트 권한을 일괄 요청하지 않음 |

`tabs`, `history`, `cookies`, `webRequest`, `clipboardRead`, `unlimitedStorage` 권한은 요청하지 않습니다. 탭 활성화 및 창 포커스 이벤트는 `tabs` 권한 없이 구독하며 전체 방문 기록을 조회하지 않습니다. 비활성 세션의 Content Script는 context 확인만 하고 DOM 추출/관찰을 시작하지 않습니다. 페이지와의 `postMessage` 또는 MAIN-world 코드 주입은 사용하지 않습니다.

원본 URL은 정책 검사와 SHA-256 계산에만 일시 사용합니다. 원본 Query·Fragment를 저장하거나 출력하지 않고, 정규화 URL과 문서 비교용 해시만 보관합니다. 해시는 익명화 보장이 아니므로 외부에 공개하지 않습니다. 개발 로그에 목표, URL, 제목, 본문, 입력값 또는 플랫폼 오류 원문을 출력하지 않습니다.

- `chrome.storage.local`: 활성 서버 세션 메타데이터(`activeSession`: 완료 생성 정보 `startRequest`, 오류 중단 시 `interrupted`)와 미완료 생성 요청(`pendingSessionStart`: 키·목표·서버 주소·수신 응답)을 보관합니다. 방문 본문은 보관하지 않습니다.
- `chrome.storage.session`: 세션, 전역 sequence, 탭/문서 식별, 후보 및 유효 방문의 개발용 checkpoint. 디스크에 영속 전송 큐를 만들지 않습니다.
- 두 storage 영역 모두 `TRUSTED_CONTEXTS`로 제한하며 Content Script에 저장소 읽기 권한을 열지 않습니다.
- Service Worker 재기동 시 정상 session checkpoint를 복구합니다. 브라우저 재시작/확장 프로그램 reload 시에는 방문 기록이 사라지고 자동 수집을 재개하지 않습니다. 유효한 서버 세션 메타데이터와 생성 요청은 local에 남아 명시적인 동일 세션 재시도로 복구합니다. 키가 없는 구버전 서버 메타데이터는 신규 시작을 차단하고 서버 확인을 요구합니다. 이전 개발용 로컬 세션 checkpoint는 서버 세션으로 승격하지 않습니다.
- 사이트 권한 철회 시 활성 세션을 중단하고 기록을 삭제합니다.
- 개발용 저장 한도는 **세션당 후보 200개**입니다. 한도 도달 시 수집을 중지하고 popup에 표시합니다. 무제한 저장 권한을 쓰지 않습니다.

## 수집 및 방문 정책

`src/background/collector.ts`가 후보·유효 방문·제외 상태를 관리하고 Background의 단일 비동기 직렬 실행기가 이벤트 처리와 checkpoint 저장을 순서대로 수행합니다. `visitId` 및 세션 내 `browserTabKey`는 UUID v4입니다. Issue #26부터 후보 배열의 생성 순서를 유지하고, 앞에서부터 판정이 종료된 후보 중 유효 방문에만 `sequence`를 1부터 연속 부여합니다. 복구 불가능한 제외는 즉시 판정을 종료하고, 나머지는 문서/SPA 교체·탭 닫기·세션 종료·수집 한도 도달로 종료하며, 새로고침·탭 전환은 기존 방문을 유지합니다. 열린 후보는 검색 결과 복구나 민감 DOM 제외가 가능하므로 뒤의 방문보다 늦게 유효해져도 원래 순서를 보장하도록 기다립니다.

| 상황 | 처리 |
| --- | --- |
| 새 최상위 문서 진입 | 새 후보 |
| 동일 탐색 대상 새로고침 | 문서 ID만 교체, visitId/sequence/활성시간 유지 |
| 다른 문서로 뒤로/앞으로가기 (BFCache 포함) | 새 후보. 과거 URL의 방문을 재사용하지 않음 |
| 기존 탭 활성화 | 현재 방문 재개 |
| 동일 문서의 중복 탐색/등록 이벤트 | 문서 ID로 중복 방지 |
| SPA URL만 또는 본문만 변경 | 기존 방문 유지 |
| SPA URL과 주요 본문 변경 | 새 후보 |
| 금지 URL/민감 DOM | 제외 상태, 제목·본문·검색어 payload 보관하지 않음 |

Chrome의 `onHistoryStateUpdated`로 `pushState`/`replaceState`를 감지하고, `popstate`, `pageshow`, `pagehide` 및 MutationObserver로 탐색 복원과 비동기 렌더링을 처리합니다. SPA는 Fragment를 뺀 **정규화 전 URL의 해시**와 주요 본문의 변경을 함께 확인합니다. Query만 다른 문서도 구분할 수 있습니다.

SPA 본문은 32자 조각이 이전/현재 본문에 포함되는 양방향 비율을 비교해, 양쪽 모두 **60% 미만**인 경우에만 주요 변경으로 봅니다. 댓글 덧붙이기와 단순 메뉴 변경은 신규 방문으로 처리하지 않습니다. 최초 50자 이상 본문을 비교 기준으로 유지하여 DOM과 URL 변경 순서가 바뀌어도 감지합니다. 이는 PoC 휴리스틱이며 서로 거의 같은 텍스트를 사용하는 서로 다른 문서는 놓칠 수 있습니다. 실제 SPA 샘플로 FE-007과 함께 검증해야 합니다.

### URL·DOM 정책 및 본문

- HTTP(S)만 허용, hostname 소문자 및 기본 포트 제거, 경로 의미/대소문자 보존, Query/Fragment 제거.
- 인증정보가 포함된 URL, 민감 경로/호스트/인증 파라미터, PDF·미디어 파일/대표 미디어 서비스는 제외합니다.
- 비밀번호/인증/연락처/결제 입력 요소 또는 보이는 form/편집 영역이 있는 문서는 보수적으로 제외합니다. 입력값은 검사하거나 읽지 않습니다.
- 주요 영역은 `article`, `main`, `[role=main]` 및 대표 본문 selector입니다. 없으면 문단/코드 블록이 2개 이상인 `section`을 시도하고, 이를 찾지 못하면 추출 실패로 둡니다. 전체 body의 `innerText`는 사용하지 않습니다.
- script/style, 광고, 메뉴/내비게이션, footer/aside, 숨겨진 요소와 숨겨진 조상, form 및 모든 입력/편집 요소, 반복 댓글·공유 요소를 텍스트 순회에서 제외합니다.
- 공백/줄바꿈을 정리하고 Unicode code point 기준 최대 **5,000자**로 제한합니다. 한국어·영어와 코드 기호를 유지하며 실패 시 임의 본문을 만들지 않습니다.
- 제목은 개발 저장 용량 제한을 위해 최대 500자로 제한합니다.
- 본문 준비 실패/50자 미만이면 최대 4회 추가 확인합니다 (350ms, 1s, 2s, 4s). DOM/History 이벤트 발생 시에도 확인합니다. DOM 이벤트는 350ms debounce, 최대 1.5s 대기로 연속 mutation의 무한 지연을 방지합니다.
- Google·Naver는 아래 FE-007 검색 정책으로 처리합니다. 검색어가 없는 검색 페이지는 기존 `search-pending`으로 제외하며, 결과를 기다리는 후보는 `pending`입니다.

### 최소 유효성 측정

활성 세션, 사이트 수집 허용, 제외 정책 통과, 종류별 콘텐츠 기준, 활성시간 1,000ms 이상을 모두 만족해야 유효합니다. 일반 HTML은 주요 본문 50자 이상이며 검색 페이지는 검색어와 유기적 결과 1건 이상입니다. `active-time.ts`는 활성 탭과 포커스된 비최소화 Chrome 창에서만 누적합니다. 탭/창 전환 시 일시 정지하고 복귀/새로고침 시 누적을 이어갑니다. 최소 유효성 확인을 위해 Content Script가 활성화 후 한 번 타이머를 실행하며 반복 분석 스냅샷이나 worker keepalive 루프는 없습니다. 유효시간 미달 후보는 탭 복귀 시 계속 대기할 수 있고, 실제 문서 이탈/닫기/세션 종료 시 최종 제외합니다.

## 데이터 상태 및 BE 계약 경계

`VisitCandidate`는 `pending | valid | excluded`와 판정 종료 여부 `finalized`를 가집니다. 제외 시 본문 payload를 지우고 이유와 식별 정보만 유지합니다. popup의 로컬 미리보기 `visits`는 유효하지만 순서 미확정인 방문(`sequence: null`)도 표시합니다. `readyVisits: PageVisit[]`에는 앞선 후보가 모두 종료되어 서버 전송 순서가 확정된 방문만 포함됩니다. 확정된 번호·visitId·방문 원본은 유지되며 제외 후보는 번호를 소비하지 않습니다. 앞선 열린 탭 때문에 `readyVisits`가 지연될 수 있습니다. Issue #43에서는 이 `readyVisits`만 순차 전송하며, 방문 전송 checkpoint와 ACK를 별도로 관리합니다.

Worker checkpoint에는 `sequenceVersion: 1`을 저장합니다. 이전 sequence 형식의 서버 세션 checkpoint는 기존 ID·본문·체류시간·후보 순서를 보존해 복구하고 과거 후보 번호를 새 정책으로 변환합니다. 서버 응답이 없는 구 개발용 로컬 세션은 업그레이드 시 중단합니다. 이전 버전은 서버 전송을 하지 않았으므로 이미 전송된 번호를 변경하는 마이그레이션이 아닙니다. 브라우저/확장 reload 후에는 session storage를 복구하지 않으며, local에 남은 정상 생성 정보로 명시적 재시도를 요구합니다.

| 유효 `PageVisit` 필드 | 값 |
| --- | --- |
| `visitId`, `sessionId`, `sequence`, `browserTabKey` | FE UUID v4, BE 응답의 sessionId, 확정 유효 방문 순서(미리보기는 null 가능), 세션 내 탭 UUID |
| `normalizedUrl`, `domain`, `title`, `content` | 정책 통과한 정규화 URL, hostname, 제한된 제목/주요 본문 |
| `visitedAt`, `activeDurationMs` | 후보 관찰 UTC ISO 시각, 누적 최소 활성시간(ms) |
| `isSearchResultPage`, `searchQuery` | 검색 방문은 `true`와 실제 URL 검색어, 일반 HTML은 `false`와 `null` |
| `tabSwitchCount`, `behaviorVersion` | 방문별 누적 이탈 횟수, 행동 값이 변경될 때 증가하는 방문별 버전 |

`docs/data-collection-spec.md`와 BE-003의 논리 필드를 기준으로 타입을 만들었으며, 로컬 미리보기와 서버 요청 DTO는 구분합니다. Issue #43의 `visitRequest()`가 현재 BE DTO로 필드를 선택하며 서버 세션 ID·UTC 밀리초 시각·`(session_id, sequence)` 유일성·visitId 원본 비교 계약을 따릅니다.

## FE-005·006 행동 정보 정책 (Issue #32)

`docs/fe-spec.md`와 `docs/be-spec.md`는 방문별 배분·버전의 일부를 미확정으로 두지만, `docs/data-collection-spec.md` 5~6절과 현재 BE `applyBehavior`는 이전 방문 귀속 및 누적값·버전 계약을 명시합니다. 이를 적용하며 기존 새로고침·SPA·검색·유효성·sequence 정책은 유지합니다.

- **활성시간:** 탭과 비최소화 Chrome 창이 모두 활성인 구간만 ms로 정산합니다. 문서 교체, 탭 전환/종료, 창 비활성화 및 세션 종료에서 마지막 구간을 닫습니다. `leave` 이후에는 새 문서나 현재 문서의 재등록 전까지 상태 조회/중복 창 이벤트만으로 측정을 재개하지 않습니다. 뒤로 움직인 시계는 이전 정산 경계를 넘은 부분만 더합니다.
- **탭 전환:** A → B에서는 A 방문에 1회, B → A에서는 B 방문에 1회를 더합니다. 초기 탭 결정, 동일 탭 중복 활성화, URL 이동/새로고침/SPA, 백그라운드 탭 생성, 단순 창 포커스 해제는 제외합니다. 다른 Chrome 창의 탭으로 이동하면 실제 전경 탭 ID 변경으로 1회만 집계합니다. 비활성 창 내부의 탭 선택은 집계하지 않습니다.
- **미수집 탭/닫기:** 권한이 없거나 수집 제외인 탭으로 전환해도 이전 수집 방문의 이탈은 셉니다. 목적지의 URL/본문은 추가 수집하지 않습니다. 탭 닫기 자체는 전환이 아니며, 다른 전경 탭이 확인되면 닫힌 방문에 마지막 1회를 반영합니다. `onRemoved`와 `onActivated` 순서에 상관없이 한 번만 집계합니다. 닫기 후 대체 활성화가 없으면 전환은 0회입니다. 창 비활성 중 마지막 탭이 자동 이동해도 이탈은 마지막으로 실제 활성화되었던 방문에 귀속합니다.
- **버전:** 새 후보는 세 값 모두 0으로 시작합니다. 양의 시간 정산 또는 전환 횟수 증가마다 해당 방문의 `behaviorVersion`을 1 올립니다. 한 이벤트에서 둘 다 변경하면 두 번 증가할 수 있으며 버전 연속 전송은 요구하지 않습니다. 값이 같으면 버전도 그대로입니다. `status().visits`/`readyVisits`는 후보와 분리한 값 복사본이므로 이미 반환한 버전의 스냅샷은 이후 변경되지 않습니다. 내부 타이머 경계는 외부 결과에 노출하지 않습니다.
- **방문 확정 이후:** `finalized`와 `sequence`는 방문 순서/콘텐츠 확정을 뜻합니다. 닫힌 탭의 대체 활성화가 늦게 도착하면 행동 정보만 높은 버전으로 갱신할 수 있습니다. 세션 종료 이후에는 최종 행동 값도 고정합니다. 향후 재시도는 보관한 동일 스냅샷을 보내고, 최신 값은 새 버전의 갱신 요청으로 보내야 합니다.
- **MV3:** 창·탭 이벤트는 수신한 ID/시각과 창별 선택 탭 캐시를 사용해 단일 직렬 실행기 안에서 처리하고 `storage.session`에 값·버전·측정 경계·마지막 활성 방문을 함께 저장합니다. Worker 재기동 시에는 같은 탭이 다시 전경이어도 마지막 checkpoint 이후의 확인할 수 없는 구간을 누적하지 않습니다. 저장된 값·버전을 보존하고, 새 창/탭 이벤트 또는 실제 상태 조회로 확인한 시점부터 측정을 재개합니다. 따라서 정상 idle 종료였어도 checkpoint 이후 구간은 과소 측정될 수 있습니다. 비동기 조회 결과는 조회 완료 시점의 상태로만 사용하며, 과거 수신 시각으로 소급하지 않습니다. 일반 페이지 등록/이동 메시지는 이미 알려진 전경 상태를 임의의 최신 조회로 덮어쓰지 않습니다. 브라우저/확장 reload 후 자동 세션 재개를 하지 않는 정책은 유지합니다.
- **구 checkpoint:** 측정되지 않았던 전환은 0, 기존 체류시간이 있으면 최초 버전은 1(없으면 0)로 초기화합니다. 과거 탭 전환은 복원할 수 없습니다. 기존 식별자·본문·체류시간·확정 sequence를 보존합니다. 이전 checkpoint는 서버 전송을 하지 않았던 개발용 상태입니다.

Issue #32는 상태와 스냅샷 준비까지였으며 Issue #34에서 서버 세션 ID를 적용했습니다. Issue #43은 BE-003 방문 생성과 고정된 초기 요청 스냅샷 재시도를 구현합니다. 이후 BE-006 행동 PATCH, 종료 요청과 최종 행동 ACK 순서는 후속 작업입니다.

## 테스트

```sh
npm test
npm run build
npm run build:dev
# 실제 브라우저 테스트용 바이너리 설치 (최초 1회)
npx playwright install chromium
npm run test:browser
# 이미 설치된 Chrome for Testing/Chromium을 지정할 수도 있음
CHROMIUM_PATH="/absolute/path/to/browser" npm run test:browser
# 화면이 보이는 테스트 (선택)
HEADED=1 npm run test:browser
```

브라우저 테스트는 임시 프로필·로컬 HTTP API 모의 서버·합성 문서와 요청 가로채기로 제공한 Google·Naver URL의 합성 검색 문서를 사용합니다. 실제 Spring Boot·MySQL 및 검색 서비스 검증과 구분합니다. 임시 빌드의 API 주소만 모의 서버로 지정하고 dist는 변경하지 않습니다. 응답 유실 뒤 Worker 재시작·동일 키 재시도·중복 시작 차단·서버 세션 ID 일치를 검사합니다. 자동 실행을 위해 **테스트용 manifest 복사본에만 localhost·Google·Naver 호스트 권한을 사전 부여**하며, 배포 manifest의 사이트별 선택 권한은 바꾸지 않습니다. popup, 메시징, 세션 전/후 차단, 본문, 새로고침, 뒤로가기, SPA, 탭 재사용, sequence, 민감 페이지/짧은 본문 제외를 실제 MV3 런타임에서 검증합니다. Google Chrome Stable의 unpacked 로드와 권한 허용 dialog는 아래 수동 절차로 추가 확인합니다.

추가 창 포커스·최소화·복원 시나리오는 `HEADED=1`에서 실행합니다. headless Chrome for Testing은 여러 창을 동시에 focused로 보고할 수 있으므로 기본 실행에서는 이 시나리오만 `SKIP`으로 명시합니다. 복구 시 포커스 조회 결과가 모호하면 측정을 중지하고 확실한 이벤트를 기다립니다.

Issue #34 보완 브라우저 시나리오는 실제 Worker에 checkpoint 저장 오류를 한 번 주입하고 재시작 후 HTTP 재요청 없이 동일 세션·방문으로 복구하는지 검사합니다. 손상된 pending 레코드는 두 번의 Worker 재시작과 Popup 기록 삭제 이후에도 원본이 보존되고 신규 시작이 차단되는지 확인합니다. 이는 모의 HTTP API와 합성 저장 오류를 사용한 MV3 검증이며 실제 BE·MySQL 장애 검증과 구분합니다.

수동 검증 항목:

1. popup을 열기 전/세션 시작 전 방문해도 기록이 생성되지 않는지 확인합니다.
2. 사이트 권한을 거부하면 수집하지 않는지 확인하고, 허용 후 이미 열린 탭과 새 탭 모두 수집되는지 확인합니다.
3. 정상 문서에서 1초 이상 머무른 뒤 하나의 유효 방문이 생성되는지 확인합니다. 1초 미만에 떠나거나 본문이 50자 미만인 경우 유효 기록이 없어야 합니다.
4. 새로고침 및 탭 복귀는 ID/sequence를 유지하고, 다른 문서 이동과 뒤로/앞으로가기는 새 ID를 갖는지 확인합니다.
5. SPA의 Query가 다른 문서 이동 시 URL+주요 본문이 바뀌면 새 방문이 생기고, Fragment/메뉴/댓글 변경은 중복을 만들지 않는지 확인합니다.
6. 두 탭을 빠르게 탐색해 sequence 중복이 없는지 확인합니다. Chrome 최소화/다른 프로그램으로 이동한 시간은 늘어나지 않아야 합니다.
7. 로그인·결제·민감 form·오류·PDF·영상·짧은 본문 페이지는 유효 목록에 없어야 합니다. 숨김/입력 필드의 합성 비밀값도 결과에 없어야 합니다.
8. Google/Naver는 아래 검색 브라우저 검증 절차를 수행합니다. 검색어가 없으면 `search-pending`, 결과가 없으면 8초 대기 후 `unavailable-content`이며 유효 목록에 없어야 합니다.
9. 세션 종료 후 새 방문을 생성하지 않는지, 기록 삭제와 권한 철회가 동작하는지 확인합니다.
10. Service Worker가 idle 종료된 후 popup을 다시 열어 세션·방문 ID·순서를 복구하는지 확인합니다 (DevTools가 worker를 계속 살려둘 수 있으므로 닫고 검사). 브라우저 재시작 시 자동 수집을 재개하지 않아야 합니다.

## 미구현·후속 작업 및 명세 차이

- 정식 제품 UI 및 FE-003 서버 종료 연동. Issue #34에서 `POST /api/sessions` 생성은 연동했고, GET 조회와 `POST /api/sessions/{sessionId}/end` 종료는 아직 FE에서 호출하지 않습니다.
- 활성 체류 10초 시점의 AI 분석 예약과 최종 누적 행동의 실제 전송은 후속 연동 범위입니다. 현재는 확정된 방문을 저장할 때 초기 행동 스냅샷을 보내며, 이후 누적 행동 PATCH와 반복 분석 요청은 만들지 않습니다. 기존 명세의 10초 분석 시점과 `readyVisits` 순서 확정 지연의 조정도 후속 FE·BE 협의가 필요합니다.
- IndexedDB 영속 전송 큐·브라우저 재시작 복구·행동 PATCH·END_PENDING, AI 분석/분류/알림/사용자 선택, 대량 데이터셋 구축. 방문 생성 POST·순차 전송·ACK·제한된 재시도는 Issue #43에서 구현했습니다.
- 현재 문서/DOM 휴리스틱은 민감 페이지를 완벽하게 판별하지 못하며 안전한 form 포함 문서나 비표준 본문/Shadow DOM/iframe도 제외할 수 있습니다. 민감 페이지로 판정된 SPA 문서는 새 문서 navigation 전까지 제외를 유지합니다. 실제 공개 샘플로 selector/판정을 추가 검증해야 합니다.
- 수집 규격은 탭 복귀 재사용, FE UUID 및 IndexedDB 복구를 명시하지만 FE/BE 통합 명세는 일부 항목을 미확정/BE ID로 기재합니다. 이번 작업은 사용자 지시대로 수집 규격을 우선하며 원본 명세는 변경하지 않습니다.
- Issue #9에서는 최소 유효성 측정만 구현했고, Issue #32에서 방문별 누적 활성시간·탭 전환·행동 버전 관리를 보완했습니다. 실제 행동 전송과 분석 예약은 후속 범위입니다.
- 서버 세션 생성은 연동했지만 방문 checkpoint는 여전히 `storage.session` 기반입니다. 수집 규격의 방문 디스크 영속성·전송 큐·서버 종료 요구는 후속 작업입니다.
- 프로젝트의 보장 대상은 Windows 11 Chrome Stable입니다. macOS Chrome for Testing 자동 검증만으로 이 플랫폼의 최종 검증 완료를 주장하지 않습니다.

참고: [Issue #9](https://github.com/SKHU-AI-Projects-Archive/2026-2-Capstone-T01-focus-recovery/issues/9), [Chrome Service Worker 생명주기](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle), [webNavigation](https://developer.chrome.com/docs/extensions/reference/api/webNavigation), [storage](https://developer.chrome.com/docs/extensions/reference/api/storage), [Playwright 확장 테스트](https://playwright.dev/docs/chrome-extensions).

## Issue #9에서 복사한 과거 검증 기록 (2026-10-12)

- `npm test`: 5개 파일, **79개 테스트 성공**.
- `npm run build`, `npm run build:dev`: 타입 검사 및 두 확장 번들 빌드 성공.
- `npm run dev`: 초기 빌드/두 watcher 실행 및 필수 산출물 유지 확인 후 종료.
- `npm run test:browser`: macOS **Chrome for Testing 151.0.7922.34**의 임시 프로필에서 성공. 앞/뒤 탐색과 CDP로 worker를 중단한 뒤 세션/ID/sequence 복구도 포함.
- `git diff --check`: 성공.
- Chrome Stable의 실제 toolbar 권한 dialog, 외부 프로그램 포커스 전환 및 Windows 11 환경은 수동 검증하지 않았습니다. 최소 지원 버전 Chrome 106도 별도 실행 검증이 필요합니다.


## FE-007 검색 수집 정책 (Issue #21)

### 지원 URL과 검색어

- Google: `http(s)://[www.]google.com/search?q=...`. 기존 정책의 `google.co.kr`, `google.co.uk`, `google.co.jp`, 2자리 국가 도메인도 동일한 `/search` 경로로 식별합니다. 국가 도메인·모바일 DOM은 모두 실측 검증된 지원 범위가 아닙니다.
- Naver: `http(s)://search.naver.com/search.naver?query=...`, `m.search.naver.com`의 동일 경로. 실제 DOM 검증은 데스크톱 `search.naver.com`입니다.
- URL API로 정규화 **전에** Google `q` 또는 Naver `query` 하나만 디코딩하고, 공백을 한 칸으로 정리합니다. `+`, `%2B`, 한글 인코딩을 처리하며 다른 파라미터·Fragment를 검색어에 합치지 않습니다.
- 파라미터 누락·빈 검색어·중복 파라미터·제어문자·500 Unicode code point 초과는 추정하거나 잘라서 저장하지 않습니다. 500자는 개발용 메시지/메모리 제한이며 서버 계약이 아닙니다.
- 다른 검색 엔진·사이트 내부 검색에는 검색 플래그나 검색어를 부여하지 않습니다. 일반 HTML 수집 정책은 별도로 적용됩니다.

### 유기적 결과 구조

`src/content/search.ts`에서 서비스별 추출을 분리했습니다. 결과 컨테이너, 표시되는 제목, 실제 HTTP(S) 제목 링크를 함께 확인합니다. 제목이 확인되면 설명이 없어도 1건이며, 검색창·메뉴·추천어·AI 브리핑·미확인 영역을 결과로 계산하지 않습니다.

| 서비스 | 현재 판별 근거 | 설명 추출 | 검증 상태 |
| --- | --- | --- | --- |
| Google | `#search #rso` 안의 `.MjjYud`/`.g`, `a[href] h3` | `[data-sncf]`, `.VwiC3b`, `.IsZvec` | 합성 HTML/MV3 검증만 완료. 실제 서비스는 차단되어 **실제 DOM 미확인** |
| Naver | `#main_pack` 안의 `[data-block-id^="web/"]` 또는 `[data-template-id="ugcItem"][data-template-type="searchBasic"]`, 제목 링크의 `sds-comps-text-type-headline` | 제목과 분리된 설명 링크의 `sds-comps-text-type-body1` | 2026-10-14 실제 데스크톱 DOM과 확장 실행 확인 |

Naver의 해시형 클래스는 사용하지 않습니다. Google의 클래스 변경, Naver의 다른 섹션/모바일/실험 레이아웃은 추출 실패할 수 있습니다. 근거가 부족하면 전체 body 텍스트로 대체하지 않습니다. 같은 제목 DOM의 중첩 wrapper와 같은 제목·설명은 중복 계산하지 않습니다.

`content`는 `검색어: …`, `검색 결과 N`, `제목: …`, 선택적 `설명: …` 구조이며 총 **5,000 Unicode code point** 제한을 적용합니다. 제한 내에 온전한 제목을 보관할 수 없는 결과는 세지 않습니다. 별도 서버 검색 결과 배열/DTO/`searchedAt`은 추가하지 않았습니다. `PageSnapshot.organicResultCount`는 내부 판정 근거이며 `PageVisit`에서 제거합니다.

### 광고·민감정보

- 광고 컨테이너(`#tads`, `#tadsb`, `#bottomads`, `#power_link`, `.ad_section` 등), 광고 데이터 속성, 결과 wrapper의 광고/스폰서 라벨, 광고 전용 링크 호스트를 제외합니다. 숨김·form·입력·편집·메뉴 영역도 기존 텍스트 정리에서 제거합니다.
- 기존 URL 인증정보·민감 파라미터·경로 정책을 그대로 적용합니다. 결과 링크도 이 정책을 통과해야 하며 링크 URL 자체는 저장하지 않습니다.
- 검색 페이지에서만 동일 origin/검색 경로를 대상으로 하는 `role=search` 또는 Naver `nx_search_form`의 검색 필드·hidden/submit 필드 구성, 입력이 전부 hidden인 옵션 form을 허용합니다. 비밀번호/인증/연락처/결제 입력, 다른 form·편집 영역은 여전히 문서 전체를 제외합니다. **입력값은 읽지 않습니다.** 일반 HTML의 form 제외 정책은 유지합니다.
- Background는 타입/길이/빈 검색어/결과 건수/서비스·호스트·정규화 URL을 검사하고, 현재 Chrome frame URL에서 직접 추출한 검색어 및 해시와 비교합니다. 알 수 없는 snapshot 필드도 거부해 원본 URL·임의 DTO가 저장되는 것을 방지합니다.
- 검색어·결과 본문은 허용된 작업 세션의 메시지, trusted `chrome.storage.session`의 수집·전송 checkpoint, 사용자가 직접 요청한 개발 popup 데이터 표시와 설정된 BE 방문 저장에 사용합니다. 로그·`storage.local`에는 보관하지 않습니다. Issue #43부터 확정 방문은 BE로 전송하며, 로컬 삭제는 이미 전송한 서버 기록을 삭제하지 않습니다.

### 대기·상태·SPA

검색 방문은 활성 세션, 사이트 허용, 지원 URL, 실제 검색어, 유기적 결과 1건, 활성 체류 1,000ms, 제외 정책 통과를 모두 요구합니다. 일반 HTML의 50자 기준을 적용하지 않습니다.

초기 결과 없음은 payload 없이 pending으로 보내며 기존 MutationObserver, 350ms debounce/최대 1.5초 대기, 350ms·1s·2s·4s 재시도를 사용합니다. 검색 URL 해시가 바뀌면 대기 기준을 다시 설정하고 약 **8초** 뒤에도 결과가 없으면 pending 후보를 `unavailable-content`로 제외해 payload를 지웁니다. observer는 남아 있으므로 나중에 실제 결과가 나타나면 동일 문서 후보를 복구할 수 있습니다. Worker 복구에는 기존 session checkpoint를 사용합니다.

이미 valid인 방문은 결과의 일시적 로딩 실패/검색어 누락으로 삭제하지 않습니다. 새 실패 후보는 다른 정상 방문에 영향을 주지 않습니다. 민감 DOM/URL 제외는 기존 개인정보 삭제 정책을 우선합니다.

정규화 전 URL에서 Fragment만 제외해 계산한 SHA-256과 결과 콘텐츠 변경을 **함께** 검증합니다. SPA 결과 비교에서는 검색어/번호/고정 라벨을 제거하고 기존 양방향 32자 조각·60% 기준을 재사용하되 50자 최소 길이만 해제합니다. 검색어만 변경, 결과 추가만 발생, 메뉴 mutation은 신규 방문을 만들지 않습니다. 동일 결과 새로고침/탭 복귀는 ID·sequence·tab key를 유지하고 다른 문서의 뒤/앞 탐색은 새 방문을 만듭니다.

### 실제 검색 브라우저 검증

1. `npm run build` 후 위 절차로 확장을 로드합니다. BE 서버를 실행한 뒤 Google와 Naver **각 origin에서** 수집을 허용하고 작업 세션을 시작합니다.
2. `Spring Boot JWT`, `스프링 부트 인증` 등 공개 검증어를 검색하고 결과 탭을 1초 이상 활성화합니다. `isSearchResultPage=true`, 실제 `searchQuery`, Query/Fragment 없는 URL, 제목·설명이 있는 content를 확인합니다.
3. 광고가 포함된 검색과 결과 없는 검색에서 광고가 content에 없고, 실제 유기적 결과 0건이면 8초 뒤 제외되는지 확인합니다. 차단/동의/CAPTCHA 화면은 성공으로 처리하지 않습니다.
4. 새로고침/탭 복귀의 ID·sequence 재사용, 새 검색/뒤·앞 탐색의 신규 ID, SPA URL만 변경의 중복 방지, 결과 지연 로딩을 확인합니다.
5. Worker 중단 후 재기동해 검색어·본문·후보 상태·ID·sequence가 유지되는지 확인합니다. 종료 후 기록을 삭제합니다.

합성 MV3 테스트: `CHROMIUM_PATH="/absolute/path/to/browser" npm run test:browser`.
실제 서비스 점검(선택): `CHROMIUM_PATH="/absolute/path/to/browser" node scripts/live-search-check.mjs`.
실제 점검 스크립트는 설정된 BE 서버가 필요하며 서버에 검증용 세션을 생성합니다. 종료 후 서버는 ACTIVE로 남을 수 있습니다. 임시 프로필/테스트용 manifest에는 기존 API 권한을 보존하고 Google·Naver 수집 권한을 사전 부여합니다. 요청을 가로채지 않으며 상태/건수/일치 여부만 출력합니다. 공개 검증어만 사용하고 임시 기록은 종료 시 삭제합니다. `HEADED=1`로 화면을 볼 수 있습니다.

### 제한·명세 해석

- **Google은 실제 DOM 검증 미완료입니다.** 보수적인 selector가 합성 테스트를 통과한 상태이며 실제 서비스 지원이 검증됐다고 간주하지 않습니다. 차단되지 않는 사용자 Chrome에서 위 수동 검증이 필요합니다.
- 모바일·국가 도메인·동의 화면·개인화/A/B 레이아웃·Shadow DOM·iframe·보이지 않는 결과·비표준 snippet은 놓칠 수 있습니다. Naver UGC/웹 결과 외 다른 섹션은 일부러 확대하지 않았습니다.
- 개인정보/광고 판정은 보수적인 구조/URL 휴리스틱입니다. 일반 공개 결과 문구나 검색어 자체에 포함된 개인정보를 완벽하게 제거하는 DLP 기능은 구현하지 않았습니다.
- 8초 대기, 검색어 500자, 내부 건수 100건, 짧은 검색 결과 SPA 비교는 명세의 미확정 항목을 개발용 구현에서 제한한 값입니다. 원본 명세나 서버 계약은 변경하지 않았습니다.
- FE-005/006 전체 행동 측정, 정식 UI, BE/AI 연동, IndexedDB 큐는 범위 밖입니다.

### 작업 기반 복원

시작 시 detached HEAD `d1435751878fe4494b128dc40329e3c00d3af2a5`, 미커밋 변경 없음. PR #15는 병합됐지만 마지막 커밋 `8386d64`가 FE 소스/테스트를 삭제한 상태라 최신 upstream/main에는 README만 있었습니다. 사용자 승인에 따라 Issue #9 worktree의 **현재 FE 파일 28개**를 복사해 FE-004 안정성 수정과 기존 **102개 테스트**를 보존한 후 FE-007을 확장했습니다. 다른 worktree는 변경하지 않았습니다. 최초 구현 보고 시점에는 커밋/푸시/PR 생성을 수행하지 않았습니다.


### Issue #21 파일 변경 목록

복사한 FE-004 기반 대비 수정 11개:

- `README.md`
- `scripts/browser-test.mjs`
- `src/background/collector.ts`, `src/background/index.ts`
- `src/content/extraction.ts`, `src/content/index.ts`
- `src/shared/url.ts`, `src/shared/types.ts`, `src/shared/messages.ts`, `src/shared/content-change.ts`
- `tests/background.test.ts` (기존 내용 그대로, 검색 테스트 8개 추가)

FE-007 신규 7개:

- `src/content/search.ts`
- `scripts/live-search-check.mjs`
- `tests/search-url.test.ts`, `tests/search-extraction.test.ts`, `tests/search-collector.test.ts`, `tests/search-messages.test.ts`, `tests/search-content.test.ts`

그대로 복원한 나머지 FE-004 기반 17개:

- `.gitignore`, `package.json`, `package-lock.json`, `popup.html`, `public/manifest.json`
- `tsconfig.json`, `vite.config.ts`, `vite.content.config.ts`, `scripts/dev.mjs`
- `src/background/active-time.ts`, `src/background/serial.ts`, `src/popup/index.tsx`, `src/popup/style.css`
- `tests/collector.test.ts`, `tests/extraction.test.ts`, `tests/messages.test.ts`, `tests/url.test.ts`

최신 main 대비 README 수정 1개와 신규 파일 34개로 보이는 것은 위 기반 복원이 포함됐기 때문입니다. 의존성과 lockfile, 원본 명세, BE·AI 영역은 변경하지 않았습니다.

### Issue #21 검증 기록 (2026-10-14)

- Vitest: 기존 **102개**를 삭제/완화하지 않고 검색 테스트 **90개 추가**, **10개 파일 / 192개 테스트** 성공.
- `npm run typecheck`, `npm run build`: 성공.
- `npm run test:browser`: 설치된 Chrome for Testing **151.0.7922.34**를 `CHROMIUM_PATH`로 지정하여 성공. 기본 실행은 Playwright 요구 바이너리가 설치되어 있지 않아 실패했으며 기존 설치된 브라우저로 재검증했습니다. 합성 검색 응답에 대한 MV3 테스트이며 실제 서비스 성공을 의미하지 않습니다.
- 실제 Naver: 영어 검색 16건/3,971자, 한국어 검색 17건/4,086자, 광고 포함 샘플 23건/4,398자의 유기적 결과 기반 content 및 실제 검색어 확인. 검색어/본문 원문은 로그로 출력하지 않았습니다. 실제 광고 컨테이너가 있는 페이지도 확인했습니다. 새로고침 ID·sequence 재사용, 다른 검색으로 뒤/앞 이동의 신규 ID·검색어, 결과 없는 희소 검색의 `unavailable-content` 제외를 확인했습니다. 이 건수는 확인 시점의 샘플 결과이며 서비스 결과 변화로 달라질 수 있습니다.
- 실제 Google: MCP 브라우저에서 HTTP 429 차단, 확장을 로드한 Chrome에서도 영어/한국어 모두 결과 화면 밖으로 이동했습니다. 차단 화면은 `dom-policy`로 제외됐고 **실제 유기적 결과 DOM/수집 성공은 확인하지 못했습니다**.
- 동적 로딩/검색 SPA/두 탭/Worker 복구/빈 결과에서 기존 방문 보존은 합성 자동 테스트로 검증했습니다. 실제 서비스 전체 조합과 Windows 11 Chrome Stable/권한 dialog/모바일은 수동 검증이 남습니다.
- `git diff --check`: 성공. 최초 구현 검증 당시 Git은 `feat/21/search-query-collection`, HEAD `d143575`, 미커밋 변경 상태였습니다.
- 기존 lockfile의 개발 의존성 audit 결과: `@vitest/mocker` moderate, `tinypool` critical, `vitest` critical (총 3건). 해결 제안은 Vitest 메이저 업데이트라 이 Issue에서 의존성을 변경하지 않았습니다. [mocker advisory](https://github.com/advisories/GHSA-82fw-gwwq-j7x9), [tinypool advisory](https://github.com/advisories/GHSA-5gmw-xhrv-c9v3). 배포 확장 번들에 포함되는 운영 의존성은 아닙니다.
- 권장 커밋 메시지: `feat(#21): Google·Naver 검색어 및 유기적 검색 결과 수집`. 최초 구현 보고 시점에는 커밋·푸시·PR 생성을 수행하지 않았습니다.


### Git 검증 및 Fork Push 구성 (2026-10-14)

- 원격 최신 참조 확인 후 `origin/main`, `upstream/main`, 작업 브랜치의 기준은 모두 `d1435751878fe4494b128dc40329e3c00d3af2a5`입니다. 불필요한 Merge/Rebase나 main 변경을 하지 않았습니다.
- 복원 당시 28개 파일의 해시가 Issue #9 worktree의 현재 파일과 모두 일치함을 확인했습니다. 이 정확한 스냅샷을 첫 커밋에 스테이징하고 FE-007 변경을 두 번째 커밋으로 분리합니다. 작업 파일을 삭제/교체하거나 다른 worktree를 수정하지 않습니다.
- 최종 추적 대상은 FE 파일 35개입니다. BE·AI·공통 명세 변경, 인증정보, `.env`, 브라우저 프로필, 로컬 테스트 산출물은 포함하지 않습니다. `node_modules`, `dist`, `coverage`, `*.local`은 기존 `.gitignore`로 제외합니다.
- Commit 전 Vitest 192개(기존 102개 + 신규 90개), 타입 검사, 빌드 및 MV3 브라우저 테스트를 다시 실행해 모두 통과했습니다. Google의 실제 검색 결과 DOM 검증은 접근 차단으로 여전히 미완료입니다.
- Push 대상은 개인 Fork의 `origin/feat/21/search-query-collection`입니다. Force Push, PR 생성, Merge는 수행하지 않습니다.
