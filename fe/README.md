# Focus Recovery Chrome Extension (Issue #9·21 / FE-004·007)

Manifest V3 기반 개발용 페이지 수집기입니다. React popup은 목표 입력, 로컬 세션 제어 및 수집 결과 확인에만 사용하며 정식 FE-001~003 화면은 구현하지 않습니다. Spring Boot·AI 서비스에 요청을 보내지 않습니다.

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

## Chrome에서 로드 및 세션 검증

1. `npm run build`를 실행합니다.
2. `chrome://extensions`에서 개발자 모드를 켭니다.
3. **압축해제된 확장 프로그램을 로드**로 `fe/dist/`를 선택합니다.
4. 수집할 일반 HTTP(S) 사이트에서 확장 프로그램 아이콘을 클릭합니다.
5. **현재 사이트 수집 허용**을 누르고 해당 사이트의 접근 권한을 허용합니다. 다른 사이트를 탐색하려면 그 사이트에서도 이 단계를 수행합니다.
6. 최초 목표를 입력하고 **로컬 세션 시작**을 선택합니다. 이미 활성 세션이 있으면 새 세션을 만들지 않습니다.
7. 허용한 문서 탭으로 돌아가 Chrome 창과 탭을 활성 상태로 1초 이상 유지합니다.
8. popup의 **상태 새로고침**으로 후보/유효 방문 수를 확인합니다. **수집 데이터 표시**를 선택하면 본문을 포함한 구조화 데이터가 popup 안에만 표시됩니다. 화면 공유·캡처 시 주의하고 실제 개인정보를 저장소에 붙여 넣지 마세요.
9. **세션 종료**를 선택하면 새로운 후보 및 지연된 Content Script 응답을 받지 않습니다. 마지막 후보의 유효/제외 판정을 완료하고 결과는 확인용으로 유지합니다.
10. 종료 후 **로컬 기록 삭제**로 데이터를 지울 수 있습니다. 새 세션 시작 시에도 이전 결과를 지웁니다.

세션 시작 당시 이미 열려 있던 **허용된 탭**에도 Script를 주입하고 현재 문서를 후보로 등록합니다. 백그라운드 탭의 시간은 누적하지 않습니다. 방문 시각은 실제 과거 방문 시각을 추정하지 않고 이 세션에서 후보를 관찰한 UTC 시각입니다.

목표는 기존 BE `CreateWorkSessionRequest` 구현의 공백 제거 후 **5~150 UTF-16 code units** 검증과 맞췄습니다. `docs/fe-spec.md`의 길이는 아직 미확정이므로 FE 정책으로 새로 확정한 값은 아닙니다. 개발용 세션의 `source: development-local`과 UUID는 서버 세션과 구분합니다. 실제 API 성공 응답의 `sessionId`로 대체할 경계는 `Collector.start`와 Background의 start 처리입니다.

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

- `chrome.storage.local`: 활성 로컬 세션 메타데이터만 보관 (`activeSession`).
- `chrome.storage.session`: 세션, 전역 sequence, 탭/문서 식별, 후보 및 유효 방문의 개발용 checkpoint. 디스크에 영속 전송 큐를 만들지 않습니다.
- 두 storage 영역 모두 `TRUSTED_CONTEXTS`로 제한하며 Content Script에 저장소 읽기 권한을 열지 않습니다.
- Service Worker 재기동 시 session checkpoint를 복구합니다. 브라우저 재시작/확장 프로그램 reload 시에는 기록이 사라지고 자동 수집을 재개하지 않습니다. 다음 worker 기동에서 stale local 세션 메타데이터를 삭제합니다.
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

`VisitCandidate`는 `pending | valid | excluded`와 판정 종료 여부 `finalized`를 가집니다. 제외 시 본문 payload를 지우고 이유와 식별 정보만 유지합니다. popup의 로컬 미리보기 `visits`는 유효하지만 순서 미확정인 방문(`sequence: null`)도 표시합니다. `readyVisits: PageVisit[]`에는 앞선 후보가 모두 종료되어 서버 전송 순서가 확정된 방문만 포함됩니다. 확정된 번호·visitId·방문 원본은 유지되며 제외 후보는 번호를 소비하지 않습니다. 앞선 열린 탭 때문에 `readyVisits`가 지연될 수 있습니다. 실제 HTTP 요청과 ACK 큐는 아직 구현하지 않습니다.

Worker checkpoint에는 `sequenceVersion: 1`을 저장합니다. 이전 개발용 checkpoint는 기존 ID·본문·체류시간·후보 순서를 보존해 복구하고 과거 후보 번호를 새 정책으로 변환합니다. 이전 버전은 서버 전송을 하지 않았으므로 이미 전송된 번호를 변경하는 마이그레이션이 아닙니다. 브라우저/확장 reload 후에는 기존대로 session storage를 복구하지 않고 명시적 새 시작을 요구합니다.

| 유효 `PageVisit` 필드 | 값 |
| --- | --- |
| `visitId`, `sessionId`, `sequence`, `browserTabKey` | FE UUID v4, 현재 로컬 세션 UUID, 확정 유효 방문 순서(미리보기는 null 가능), 세션 내 탭 UUID |
| `normalizedUrl`, `domain`, `title`, `content` | 정책 통과한 정규화 URL, hostname, 제한된 제목/주요 본문 |
| `visitedAt`, `activeDurationMs` | 후보 관찰 UTC ISO 시각, 누적 최소 활성시간(ms) |
| `isSearchResultPage`, `searchQuery` | 검색 방문은 `true`와 실제 URL 검색어, 일반 HTML은 `false`와 `null` |
| `tabSwitchCount`, `behaviorVersion` | **null**: FE-005/006 미구현 값을 생성하지 않음 |

`docs/data-collection-spec.md`와 BE-003의 논리 필드를 기준으로 타입을 만들었으며, 이 개발용 객체를 확정된 서버 DTO라고 간주하면 안 됩니다. 실제 BE 전송 시 서버 세션 ID와 필드의 nullability, `(session_id, sequence)` 유일성 및 visitId 멱등성 계약을 확인해야 합니다.

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

브라우저 테스트는 임시 프로필·합성 localhost 문서와 요청 가로채기로 제공한 Google·Naver URL의 합성 검색 문서를 사용합니다. 실제 검색 서비스 검증과 구분합니다. 자동 실행을 위해 **테스트용 manifest 복사본에만 localhost·Google·Naver 호스트 권한을 사전 부여**하며, 배포 manifest의 사이트별 선택 권한은 바꾸지 않습니다. popup, 메시징, 세션 전/후 차단, 본문, 새로고침, 뒤로가기, SPA, 탭 재사용, sequence, 민감 페이지/짧은 본문 제외를 실제 MV3 런타임에서 검증합니다. Google Chrome Stable의 unpacked 로드와 권한 허용 dialog는 아래 수동 절차로 추가 확인합니다.

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

- FE-001~003 정식 UI/BE 세션 생성·종료. 현재 BE는 `POST /api/sessions` (`goalText`, 선택적 `Idempotency-Key`) 및 `GET /api/sessions/{sessionId}`를 구현했으며 종료 API는 없습니다.
- FE-005의 10초 분석용 행동 스냅샷·최종 누적 행동 전송, FE-006 탭 전환 횟수. 각 기능 구현 시 `null` 필드를 실제 측정값으로 교체하고 `behaviorVersion` 증가/재전송 규칙을 적용해야 합니다.
- BE 저장/ACK, IndexedDB 영속 큐·순차 전송·재시도·END_PENDING, AI 분석/분류/알림/사용자 선택, 대량 데이터셋 구축.
- 현재 문서/DOM 휴리스틱은 민감 페이지를 완벽하게 판별하지 못하며 안전한 form 포함 문서나 비표준 본문/Shadow DOM/iframe도 제외할 수 있습니다. 민감 페이지로 판정된 SPA 문서는 새 문서 navigation 전까지 제외를 유지합니다. 실제 공개 샘플로 selector/판정을 추가 검증해야 합니다.
- 수집 규격은 탭 복귀 재사용, FE UUID 및 IndexedDB 복구를 명시하지만 FE/BE 통합 명세는 일부 항목을 미확정/BE ID로 기재합니다. 이번 작업은 사용자 지시대로 수집 규격을 우선하며 원본 명세는 변경하지 않습니다.
- Issue #9는 활성시간 전체 측정을 후속 범위로 두지만 수집 규격은 1초 유효성 조건을 요구합니다. 이번 작업에서는 요청된 최소 측정만 수행합니다.
- 수집 규격의 디스크 영속성/서버 세션 요구는 최종 제품 요구사항입니다. 이번 개발용 로컬 세션/checkpoint는 명시적으로 허용된 검증 범위이며 실제 BE와 전송 큐를 대체하지 않습니다.
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
- 검색어·결과 본문은 허용된 활성 로컬 세션의 메시지와 trusted `chrome.storage.session` checkpoint, 사용자가 직접 요청한 개발 popup 데이터 표시에서만 사용합니다. 로그·`storage.local`·외부 서버에는 보관/전송하지 않습니다. 기존 세션 종료 후 로컬 삭제 절차를 적용합니다.

### 대기·상태·SPA

검색 방문은 활성 세션, 사이트 허용, 지원 URL, 실제 검색어, 유기적 결과 1건, 활성 체류 1,000ms, 제외 정책 통과를 모두 요구합니다. 일반 HTML의 50자 기준을 적용하지 않습니다.

초기 결과 없음은 payload 없이 pending으로 보내며 기존 MutationObserver, 350ms debounce/최대 1.5초 대기, 350ms·1s·2s·4s 재시도를 사용합니다. 검색 URL 해시가 바뀌면 대기 기준을 다시 설정하고 약 **8초** 뒤에도 결과가 없으면 pending 후보를 `unavailable-content`로 제외해 payload를 지웁니다. observer는 남아 있으므로 나중에 실제 결과가 나타나면 동일 문서 후보를 복구할 수 있습니다. Worker 복구에는 기존 session checkpoint를 사용합니다.

이미 valid인 방문은 결과의 일시적 로딩 실패/검색어 누락으로 삭제하지 않습니다. 새 실패 후보는 다른 정상 방문에 영향을 주지 않습니다. 민감 DOM/URL 제외는 기존 개인정보 삭제 정책을 우선합니다.

정규화 전 URL에서 Fragment만 제외해 계산한 SHA-256과 결과 콘텐츠 변경을 **함께** 검증합니다. SPA 결과 비교에서는 검색어/번호/고정 라벨을 제거하고 기존 양방향 32자 조각·60% 기준을 재사용하되 50자 최소 길이만 해제합니다. 검색어만 변경, 결과 추가만 발생, 메뉴 mutation은 신규 방문을 만들지 않습니다. 동일 결과 새로고침/탭 복귀는 ID·sequence·tab key를 유지하고 다른 문서의 뒤/앞 탐색은 새 방문을 만듭니다.

### 실제 검색 브라우저 검증

1. `npm run build` 후 위 절차로 확장을 로드합니다. Google와 Naver **각 origin에서** 수집을 허용하고 로컬 세션을 시작합니다.
2. `Spring Boot JWT`, `스프링 부트 인증` 등 공개 검증어를 검색하고 결과 탭을 1초 이상 활성화합니다. `isSearchResultPage=true`, 실제 `searchQuery`, Query/Fragment 없는 URL, 제목·설명이 있는 content를 확인합니다.
3. 광고가 포함된 검색과 결과 없는 검색에서 광고가 content에 없고, 실제 유기적 결과 0건이면 8초 뒤 제외되는지 확인합니다. 차단/동의/CAPTCHA 화면은 성공으로 처리하지 않습니다.
4. 새로고침/탭 복귀의 ID·sequence 재사용, 새 검색/뒤·앞 탐색의 신규 ID, SPA URL만 변경의 중복 방지, 결과 지연 로딩을 확인합니다.
5. Worker 중단 후 재기동해 검색어·본문·후보 상태·ID·sequence가 유지되는지 확인합니다. 종료 후 기록을 삭제합니다.

합성 MV3 테스트: `CHROMIUM_PATH="/absolute/path/to/browser" npm run test:browser`.
실제 서비스 점검(선택): `CHROMIUM_PATH="/absolute/path/to/browser" node scripts/live-search-check.mjs`.
실제 점검 스크립트는 임시 프로필/테스트용 manifest에 Google·Naver 권한만 사전 부여합니다. 요청을 가로채지 않으며 상태/건수/일치 여부만 출력합니다. 공개 검증어만 사용하고 임시 기록은 종료 시 삭제합니다. `HEADED=1`로 화면을 볼 수 있습니다.

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
