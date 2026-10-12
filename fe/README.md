# Focus Recovery Chrome Extension (Issue #9 / FE-004)

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

`src/background/collector.ts`가 후보·유효 방문·제외 상태를 관리하고 Background의 단일 비동기 직렬 실행기가 이벤트 처리와 checkpoint 저장을 순서대로 수행합니다. `visitId` 및 세션 내 `browserTabKey`는 UUID v4이며 `sequence`는 후보 생성 시 증가합니다. 제외된 후보의 번호는 재사용하지 않습니다.

| 상황 | 처리 |
| --- | --- |
| 새 최상위 문서 진입 | 새 후보 |
| 동일 탐색 대상 새로고침 | 문서 ID만 교체, visitId/sequence/활성시간 유지 |
| 다른 문서로 뒤로/앞으로가기 (BFCache 포함) | 새 후보. 과거 URL의 방문을 재사용하지 않음 |
| 기존 탭 활성화 | 현재 방문 재개 |
| 동일 문서의 중복 탐색/등록 이벤트 | 문서 ID로 중복 방지 |
| SPA URL만 또는 본문만 변경 | 기존 방문 유지 |
| SPA URL과 주요 본문 변경 | 새 후보 |
| 금지 URL/민감 DOM/검색 결과 | 제외 상태, 제목·본문 payload 보관하지 않음 |

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
- Google·Naver 검색 페이지는 `search-pending`으로 제외합니다. 검색어와 유기적 결과를 확인하는 FE-007 전에는 일반 HTML로 우회해 통과시키지 않습니다.

### 최소 유효성 측정

활성 세션, 제외 정책 통과, 주요 본문 50자 이상, 활성시간 1,000ms 이상을 모두 만족해야 유효합니다. `active-time.ts`는 활성 탭과 포커스된 비최소화 Chrome 창에서만 누적합니다. 탭/창 전환 시 일시 정지하고 복귀/새로고침 시 누적을 이어갑니다. 최소 유효성 확인을 위해 Content Script가 활성화 후 한 번 타이머를 실행하며 반복 분석 스냅샷이나 worker keepalive 루프는 없습니다. 유효시간 미달 후보는 탭 복귀 시 계속 대기할 수 있고, 실제 문서 이탈/닫기/세션 종료 시 최종 제외합니다.

## 데이터 상태 및 BE 계약 경계

`VisitCandidate`는 `pending | valid | excluded`입니다. 제외 시 본문 payload를 지우고 이유와 식별 정보만 유지합니다. popup에는 후보 상태 요약과 유효 방문 `PageVisit` 배열을 구분해 표시합니다. BE 전송 데이터는 아직 만들지 않습니다.

| 유효 `PageVisit` 필드 | 값 |
| --- | --- |
| `visitId`, `sessionId`, `sequence`, `browserTabKey` | FE UUID v4, 현재 로컬 세션 UUID, 후보 순서, 세션 내 탭 UUID |
| `normalizedUrl`, `domain`, `title`, `content` | 정책 통과한 정규화 URL, hostname, 제한된 제목/주요 본문 |
| `visitedAt`, `activeDurationMs` | 후보 관찰 UTC ISO 시각, 누적 최소 활성시간(ms) |
| `isSearchResultPage` | 검색 여부 (이번 구현에서는 검색 결과가 유효 방문으로 승격되지 않음) |
| `searchQuery`, `tabSwitchCount`, `behaviorVersion` | **null**: 미구현 값을 0/가짜 검색어/임의 버전으로 생성하지 않음 |

현재 저장소에는 `page_visit` ERD·엔티티·저장 API가 없습니다. `docs/data-collection-spec.md`와 BE-003의 논리 필드를 기준으로 타입을 만들었으며, 이 개발용 객체를 확정된 서버 DTO라고 간주하면 안 됩니다. 실제 BE 전송 시 서버 세션 ID와 필드의 nullability, `(session_id, sequence)` 유일성 및 visitId 멱등성 계약을 확인해야 합니다.

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

브라우저 테스트는 임시 프로필·합성 localhost 문서만 사용합니다. 자동 실행을 위해 **테스트용 manifest 복사본에만 localhost 호스트 권한을 사전 부여**하며, 배포 manifest의 사이트별 선택 권한은 바꾸지 않습니다. popup, 메시징, 세션 전/후 차단, 본문, 새로고침, 뒤로가기, SPA, 탭 재사용, sequence, 민감 페이지/짧은 본문 제외를 실제 MV3 런타임에서 검증합니다. Google Chrome Stable의 unpacked 로드와 권한 허용 dialog는 아래 수동 절차로 추가 확인합니다.

수동 검증 항목:

1. popup을 열기 전/세션 시작 전 방문해도 기록이 생성되지 않는지 확인합니다.
2. 사이트 권한을 거부하면 수집하지 않는지 확인하고, 허용 후 이미 열린 탭과 새 탭 모두 수집되는지 확인합니다.
3. 정상 문서에서 1초 이상 머무른 뒤 하나의 유효 방문이 생성되는지 확인합니다. 1초 미만에 떠나거나 본문이 50자 미만인 경우 유효 기록이 없어야 합니다.
4. 새로고침 및 탭 복귀는 ID/sequence를 유지하고, 다른 문서 이동과 뒤로/앞으로가기는 새 ID를 갖는지 확인합니다.
5. SPA의 Query가 다른 문서 이동 시 URL+주요 본문이 바뀌면 새 방문이 생기고, Fragment/메뉴/댓글 변경은 중복을 만들지 않는지 확인합니다.
6. 두 탭을 빠르게 탐색해 sequence 중복이 없는지 확인합니다. Chrome 최소화/다른 프로그램으로 이동한 시간은 늘어나지 않아야 합니다.
7. 로그인·결제·민감 form·오류·PDF·영상·짧은 본문 페이지는 유효 목록에 없어야 합니다. 숨김/입력 필드의 합성 비밀값도 결과에 없어야 합니다.
8. Google/Naver 페이지에 권한을 허용한 경우 검색어가 없거나 결과를 확인하지 못해도 `search-pending`이어야 합니다.
9. 세션 종료 후 새 방문을 생성하지 않는지, 기록 삭제와 권한 철회가 동작하는지 확인합니다.
10. Service Worker가 idle 종료된 후 popup을 다시 열어 세션·방문 ID·순서를 복구하는지 확인합니다 (DevTools가 worker를 계속 살려둘 수 있으므로 닫고 검사). 브라우저 재시작 시 자동 수집을 재개하지 않아야 합니다.

## 미구현·후속 작업 및 명세 차이

- FE-001~003 정식 UI/BE 세션 생성·종료. 현재 BE는 `POST /api/sessions` (`goalText`, 선택적 `Idempotency-Key`) 및 `GET /api/sessions/{sessionId}`를 구현했으며 종료 API는 없습니다.
- FE-005의 10초 분석용 행동 스냅샷·최종 누적 행동 전송, FE-006 탭 전환 횟수 및 FE-007 검색어/유기적 검색 결과 추출. 각 기능 구현 시 `null` 필드를 실제 측정값으로 교체하고 `behaviorVersion` 증가/재전송 규칙을 적용해야 합니다.
- BE 저장/ACK, IndexedDB 영속 큐·순차 전송·재시도·END_PENDING, AI 분석/분류/알림/사용자 선택, 대량 데이터셋 구축.
- 현재 문서/DOM 휴리스틱은 민감 페이지를 완벽하게 판별하지 못하며 안전한 form 포함 문서나 비표준 본문/Shadow DOM/iframe도 제외할 수 있습니다. 민감 페이지로 판정된 SPA 문서는 새 문서 navigation 전까지 제외를 유지합니다. 실제 공개 샘플로 selector/판정을 추가 검증해야 합니다.
- 수집 규격은 탭 복귀 재사용, FE UUID 및 IndexedDB 복구를 명시하지만 FE/BE 통합 명세는 일부 항목을 미확정/BE ID로 기재합니다. 이번 작업은 사용자 지시대로 수집 규격을 우선하며 원본 명세는 변경하지 않습니다.
- Issue #9는 활성시간 전체 측정을 후속 범위로 두지만 수집 규격은 1초 유효성 조건을 요구합니다. 이번 작업에서는 요청된 최소 측정만 수행합니다.
- 수집 규격의 디스크 영속성/서버 세션 요구는 최종 제품 요구사항입니다. 이번 개발용 로컬 세션/checkpoint는 명시적으로 허용된 검증 범위이며 실제 BE와 전송 큐를 대체하지 않습니다.
- 프로젝트의 보장 대상은 Windows 11 Chrome Stable입니다. macOS Chrome for Testing 자동 검증만으로 이 플랫폼의 최종 검증 완료를 주장하지 않습니다.

참고: [Issue #9](https://github.com/SKHU-AI-Projects-Archive/2026-2-Capstone-T01-focus-recovery/issues/9), [Chrome Service Worker 생명주기](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle), [webNavigation](https://developer.chrome.com/docs/extensions/reference/api/webNavigation), [storage](https://developer.chrome.com/docs/extensions/reference/api/storage), [Playwright 확장 테스트](https://playwright.dev/docs/chrome-extensions).

## 이번 작업의 검증 기록 (2026-10-12)

- `npm test`: 5개 파일, **79개 테스트 성공**.
- `npm run build`, `npm run build:dev`: 타입 검사 및 두 확장 번들 빌드 성공.
- `npm run dev`: 초기 빌드/두 watcher 실행 및 필수 산출물 유지 확인 후 종료.
- `npm run test:browser`: macOS **Chrome for Testing 151.0.7922.34**의 임시 프로필에서 성공. 앞/뒤 탐색과 CDP로 worker를 중단한 뒤 세션/ID/sequence 복구도 포함.
- `git diff --check`: 성공.
- Chrome Stable의 실제 toolbar 권한 dialog, 외부 프로그램 포커스 전환 및 Windows 11 환경은 수동 검증하지 않았습니다. 최소 지원 버전 Chrome 106도 별도 실행 검증이 필요합니다.
