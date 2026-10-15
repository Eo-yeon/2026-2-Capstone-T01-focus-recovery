# Issue #26 방문 순서 분석 및 구현 기록

## 최신 main 반영 (2026-10-15)

사용자의 충돌 해결·Push 요청에 따라 공식 `upstream/main`의 `332874e`를 작업 브랜치에 병합했다. PR #24는 최초 분석 이후 `5cd3e22`, `b1c628c`로 변경된 뒤 main에 병합됐다. **아래 최초 분석의 연속 번호 강제·미병합 상태는 당시 `d61eb8b` 기준의 기록이며 현재 BE 동작이 아니다.**

최신 BE는 저장된 방문을 sequence 오름차순으로 묶으며 번호 공백을 기다리지 않는다. 이미 생성된 Window는 변경하지 않고, 마지막 Window의 끝보다 작은 번호의 신규 방문은 `409 VISIT_SEQUENCE_OUT_OF_ORDER`로 거절한다. 기존 visitId의 같은 원본 재전송은 먼저 처리하므로 과거 번호여도 200이며, 같은 ID의 sequence 등 원본 변경은 충돌이다. 롤백 후 같은 visitId 재시도 테스트도 main에 추가됐다.

사용자가 선택한 A안 FE 구현은 유지했다. 연속 번호도 최신 BE가 허용하는 오름차순 번호이므로 Window 구성과 호환되며, 앞선 후보를 기다리는 방식은 뒤늦은 방문이 순서 오류로 거절되는 것을 방지한다. 실제 HTTP 전송에는 여전히 앞선 방문 ACK 후 다음 방문 전송이 필요하다. main의 BE·AI 변경은 그대로 반영했고 충돌한 명세 및 자동 병합 후 모순된 설명만 조정했다. 이번 작업에서 BE 코드를 별도로 수정하지 않았다.

병합 후 `npm run typecheck`, `npm test`(212개), `npm run build`, `npm run test:browser`(Chrome for Testing 151.0.7922.34), `git diff --check`를 다시 실행해 통과했다. BE·AI 코드는 upstream/main과 차이가 없음을 확인했으며 BE 통합 테스트는 재실행하지 않았다.

## 최초 분석 확인 기준

- [Issue #26](https://github.com/SKHU-AI-Projects-Archive/2026-2-Capstone-T01-focus-recovery/issues/26)의 본문·완료 조건·협의 요구를 확인했다. 조회 시 댓글은 없었다.
- 공식 `upstream/main`: `167999223faf78fc1c8363d5af89e79db7026584`. 시작 HEAD와 같았고 미커밋 변경은 없었다.
- [PR #24](https://github.com/SKHU-AI-Projects-Archive/2026-2-Capstone-T01-focus-recovery/pull/24): 조회 시 OPEN·미병합, head `d61eb8b18ea91146e1a26c5c813c6bb6149f9394`. 별도 remote ref로 읽었으며 BE 코드를 작업 브랜치에 병합하지 않았다.
- `AnalysisWindowService`, `PageVisitService`, `PageVisitRepository`, `AnalysisWindowTest`와 PR 리뷰를 확인했다.
- [sequence 리뷰](https://github.com/SKHU-AI-Projects-Archive/2026-2-Capstone-T01-focus-recovery/pull/24#discussion_r4270081651)는 영구 누락 시 이후 Window가 막히는 문제와 FE의 연속 번호 정책 확인을 요청한다. [롤백 리뷰](https://github.com/SKHU-AI-Projects-Archive/2026-2-Capstone-T01-focus-recovery/pull/24#discussion_r4270085492)는 구간 생성 실패 후 같은 visitId 재시도 복구 테스트를 요청한다. 조회 시 답변은 없었다.
- 이번 대화에서 사용자가 **A안 FE 구현·테스트, 전송 지연은 후속 협의**를 선택했다. BE 담당자의 별도 합의를 받은 것은 아니다.

## 기존 구현과 정확한 문제 조건

`navigate()`는 후보 생성 즉시 전역 `nextSequence`를 증가시켰다. `status().visits`는 유효 후보만 필터링하므로 후보 중 제외가 생기면 유효 방문의 번호에 공백이 남았다. 수집 규격 6장도 기존에는 이 공백을 허용했다.

PR #24는 마지막 Window 다음 index부터 방문 ID·sequence를 조회하고, 기대 번호와 다른 첫 행에서 중단한다. Window k는 k~k+4의 방문으로 만들어진다. 따라서 1,3,4,5,6이 저장되어도 첫 Window를 생성하지 못한다. 순서가 뒤집혀 도착한 **실제 방문**은 나중에 저장되면 밀린 Window를 생성하지만, **제외되어 전송하지 않는 후보**의 번호는 영원히 채워지지 않는다.

PR #24의 방문 저장은 세션 쓰기 잠금 아래 실행된다. 같은 visitId의 원본 필드가 같으면 재요청으로 처리하고, 원본이 다르거나 같은 세션의 sequence가 다른 ID에 사용되면 충돌한다. 방문 저장과 Window 생성은 같은 트랜잭션이다. 번호 재배정은 이 계약과 맞지 않는다.

## A/B 비교

| 검토 항목 | A: FE의 연속 유효 sequence | B: BE가 불연속 sequence 허용 |
| --- | --- | --- |
| 방문 순서 | 후보 배열의 생성 순서 유지, 판정 종료까지 대기 | 기존 후보 번호로 순서 유지 가능 |
| 유효성 역전 | 앞선 열린 후보를 건너뛰지 않아야 함 | 아직 안 온 방문이 앞에 들어올 수 있음 |
| 제외·복구 | 복구 가능한 후보는 종료 전까지 대기, 제외 확정 시 번호 미사용 | 번호 공백만으로 제외와 전송 지연 구분 불가능 |
| 전송 후 안정성 | 종료된 앞쪽 구간에만 한 번 부여하면 번호와 원본 고정 | 단순 저장 방문 상위 5개 선택은 지연 방문에 의해 기존 조합이 바뀔 수 있음 |
| 중복 요청 | 같은 visitId와 sequence·원본 유지 | 같은 식별자를 유지할 수 있지만 Window 확정 경계가 추가로 필요 |
| 변경 범위 | Collector·타입·복구·테스트·명세, PR #24 연속 검사 유지 | Window 서비스·조회/index 정의·동시성·제외/완료 경계 API·통합 테스트 변경 필요 |
| 비용·제한 | 열린 앞선 탭에 의한 전송 및 분석 지연 | 제외 통지/확정 경계 없이 안전하게 공백을 무시할 수 없음 |

A를 선택했다. 유효 판정 시점에 번호를 붙이거나 매번 valid 배열 index로 다시 번호를 매기는 방식은 적용하지 않았다. 후보 순서는 기존 배열로 충분하므로 별도의 candidateOrder ID나 정렬 자료구조를 추가하지 않았다.

## 상태별 실제 동작과 변경

| 상황 | 기존 동작 | 이번 구현 |
| --- | --- | --- |
| 여러 탭·비동기 이벤트 | Background 단일 직렬 실행기가 hydration·브라우저 질의·저장까지 직렬 처리. 후보는 처리된 순서로 추가됨 | 실행기 유지. 배열 삽입 순서 사용, 판정 순서로 재정렬하지 않음 |
| 먼저 생성된 pending 후보가 늦게 valid | 배열 위치 유지, 이미 후보 번호 존재 | 열린 앞선 후보에서 번호 확정을 멈춤. 뒤의 종료 방문도 기다림 |
| excluded 검색 복구 | unavailable-content 검색 후보만 확인된 결과로 복구 가능 | 열린 동안 기존 복구 유지. 종료 후의 후보에는 새 관찰을 적용하지 않음 |
| valid 이후 민감 DOM | 제외하고 snapshot 삭제 | 번호 확정 전 기존대로 삭제. 뒤의 번호를 앞당겨 재사용하는 문제 방지 |
| 새로고침·탭 복귀 | 동일 visitId, 후보·본문 기준·활성시간 재사용 | 종료 경계로 취급하지 않음. 번호를 조기 부여하지 않음 |
| 새 문서·뒤/앞 이동·SPA | 새 후보. SPA는 URL identity와 주요 본문 변화가 함께 있어야 함 | 이전 후보 종료 후 새 후보 생성. 같은 URL 실제 재방문도 별개 ID 유지 |
| 늦은 본문 | 같은 sessionId·현재 documentId여야 반영. 이전 문서는 무시 | 기존 가드 유지. 현재 후보의 늦은 유효성도 생성 순서로 반영 |
| 서버 지연 도착 | FE HTTP 미구현. PR #24는 연속 번호 도착 후 밀린 Window 생성 | FE는 확정 번호만 readyVisits로 제공. 실제 네트워크 재시도 성공을 주장하지 않음 |
| 동일 visitId 재전송 | FE HTTP 미구현. BE는 원본 일치 확인 | readyVisits 재조회·Worker 복구 후 동일 ID·번호·원본 제공. HTTP 멱등성 통합은 후속 |
| Worker 중단 | storage.session checkpoint 복구. activeSince 기반 시간 계산 | 새 버전 상태 그대로 복구. 기존 local-only checkpoint는 ID·본문·시간·순서를 유지해 번호 정책만 이행 |
| 브라우저/확장 reload | session storage 상실, stale local 활성 세션 제거, 명시적 새 시작 필요 | 유지. IndexedDB·자동 세션 재개를 추가하지 않음 |
| 권한 철회·저장 실패 | 철회 시 중단·삭제, 저장 오류 시 직렬 큐 안에서 fail closed | 유지 |
| 세션 종료·탭 닫기·수집 한도 | 복구 불가능한 제외는 복구 경로 없음. 종료/닫기에서 pending 최종 제외. 한도 도달 시 새 수집 차단 | 복구 불가능한 제외는 즉시 finalized 처리하며 나머지는 종료 경계에서 처리. 앞쪽 확정 구간에만 번호 부여. 한도에서도 모든 탭 종료 처리 |

Chrome에서 관찰하지 못한 과거 방문, 현재 frame과 달라 이미 버려진 commit 이벤트의 복원은 구현하지 않았다. 방문 순서는 세션에서 Collector가 후보를 생성한 관찰 순서이며 모든 브라우저 탐색의 절대 시간 순서라는 주장은 하지 않는다.

## 데이터 경계

- `VisitCandidate.sequence`: number 또는 null. `finalized`와 기존 후보 배열로 확정 경계를 표현한다.
- `DevStatus.visits`: 기존 유효 방문 미리보기 유지. 열린 방문이나 앞선 후보를 기다리는 방문의 sequence는 null이다.
- `DevStatus.readyVisits`: number sequence를 가진 `PageVisit[]`. 확정된 앞쪽 구간의 유효 방문만 포함하며 제외 후보는 번호를 소비하지 않는다.
- `PageVisit.sequence`는 여전히 number이다. 후보 내부 필드 finalized·sequenceVersion, snapshot의 identity·organicResultCount는 서버용 PageVisit에 넣지 않는다.
- 로컬 세션 UUID, 행동 정보 null 필드 등 기존 개발용 경계가 남아 있다. readyVisits를 변환 없이 실제 BE DTO로 전송해도 된다는 의미는 아니다.
- 최소 활성시간, 활성 체류시간 계산, 검색어·본문 추출, URL/DOM 개인정보 제한은 유지한다.

## 후속 FE·BE 협의

1. 장기간 열린 앞선 탭 때문에 전송·Window 생성이 지연될 수 있다. 현재 10초 분석 스냅샷 규격과의 조정이 필요하다. 임의 timeout으로 앞선 방문을 버리거나 순서를 바꾸지 않았다.
2. 번호 확정 후 전송 실패는 이번 제외 후보 문제와 다르다. 영구 실패를 건너뛸지, 세션을 실패 상태로 둘지, BE에 skip/종료 경계를 추가할지 협의가 필요하다. PR #24의 공백 대기를 임의로 완화하지 않았다.
3. HTTP·IndexedDB 큐·ACK·END_PENDING 구현 시 readyVisits 순서로 저장을 확인한 다음 행동 정보 및 서버 세션 종료를 처리해야 한다. 브라우저/확장 reload 복구도 해당 영속 큐 작업 범위다.
4. PR #24의 rollback 후 같은 visitId 재시도 통합 테스트는 BE 후속 검증이다. 이번에는 BE 코드와 테스트를 실행·수정하지 않았다.

## 테스트 정책

기존 192개를 삭제하지 않았다. 즉시 후보 번호를 기대했던 테스트는 유효 방문의 판정 종료 후 번호를 검증하도록 바꿨고, 열린 방문은 null을 명시적으로 검증한다. 후보 동시 생성 테스트는 ID 중복 방지와 미확정 번호를 검증한다. 서버 번호 중복 방지는 새 finalized 순서 테스트로 검증한다.

신규 단위 테스트는 20개(순서 계약 18개, Background adapter 2개)다. 5·6·7개 유효 방문, 같은 URL 재방문, 1·3개 연속 제외, 열린 영구 제외 탭의 후속 방문 차단 방지, 여러 탭의 역순 유효/종료 판정, 앞선 pending 제외, 검색 제외 복구, 후발 민감 DOM, reload·SPA, 지연 본문, 재조회/재전송 원본 안정성, Worker 및 구버전 checkpoint 복구, 한도 도달, 종료 후 지연 이벤트를 포함한다.

Window 테스트는 FE 출력이 선택된 연속 번호 정책과 크기 5·stride 1 조건에 맞는지 확인하는 계약 테스트다. 최신 BE는 번호 공백도 허용하며 FE가 제공하는 연속 번호는 그 허용 범위에 포함된다. 실제 BE DB에 Window를 생성하는 통합 테스트가 아니다. 브라우저 테스트의 Google·Naver 응답은 기존처럼 합성 fixture이며 실제 검색 서비스의 DOM 검증을 의미하지 않는다.

## 수정 파일별 영향

| 파일 | 변경 |
| --- | --- |
| `fe/src/background/collector.ts` | 판정 종료·앞쪽 확정 구간의 연속 번호 부여, 영구 제외 즉시 종료, 한도 종료, 구버전 checkpoint 이행, readyVisits 구성 |
| `fe/src/background/index.ts` | hydration 시 restore 경계 사용. 기존 직렬 실행·권한/세션 가드 유지 |
| `fe/src/shared/types.ts` | 후보의 nullable sequence·finalized, checkpoint 버전, 미리보기와 확정 PageVisit 타입 구분 |
| `fe/src/popup/index.tsx` | 기존 데이터 표시 영역에 readyVisits 추가. 수집/세션 UI 동작 유지 |
| `fe/tests/sequence.test.ts` | 신규 순서 계약 테스트 18개 |
| `fe/tests/background.test.ts` | 실제 adapter 큐·지연 브라우저 질의·역순 판정·Worker/구버전 복구 테스트 2개 추가 |
| `fe/tests/collector.test.ts` | 기존 방문/SPA/복구/동시 후보 테스트의 번호 기대를 새 정책에 맞춤 |
| `fe/tests/search-collector.test.ts` | 검색 재방문·복구·동시 후보의 번호 확정 시점 검증 |
| `fe/scripts/browser-test.mjs` | 확정 번호 연속성·원본 안정성·제외 후 Window 입력·실제 두 탭의 역순 유효/종료 판정 검증 |
| `fe/README.md` | 로컬 미리보기·readyVisits·복구 및 번호 정책 설명 |
| `docs/data-collection-spec.md` | 기존 후보 번호 공백 규칙을 선택된 A안으로 수정, 지연 및 후속 계약 경계 명시 |
| `docs/fe-spec.md` | FE-004에 이번 로컬 구현 경계 연결 |
| `docs/be-spec.md` | BE-009에 PR #24와 FE 번호 정책의 호환성 및 후속 협의 명시 |
| `docs/issue-26-analysis.md` | 분석·대안 비교·구현 경계·검증 및 남은 협의 기록 |

`active-time.ts`, `serial.ts`, `messages.ts`, 본문·검색 추출기, URL 정책, manifest와 의존성/lockfile은 수정하지 않았다. 새 의존성은 없다.

## 실행 결과 (2026-10-15)

- 실행 환경: Node.js v25.9.0, npm 11.12.1. `npm ci`로 기존 lockfile 의존성을 설치했다.
- 변경 전: 타입 검사·빌드·기존 10개 파일/192개 단위 테스트·기존 MV3 브라우저 테스트 통과.
- 변경 후 `npm run typecheck`: 통과.
- 변경 후 `npm test`: **11개 파일 / 212개 성공**. 기존 192개 유지, 20개 추가.
- 변경 후 `npm run build`: 통과. MV3 worker·popup·content 번들 생성.
- 변경 후 `npm run test:browser`: **통과**, Chrome for Testing **151.0.7922.34**. 기존 설치 바이너리를 `CHROMIUM_PATH`로 지정했다. 새 역순 유효성/종료 판정 시나리오까지 실행됐다.
- 최초 제한 환경에서 browser 명령은 localhost listen `EPERM`으로 실패했다. 로컬 서버·격리 Chrome 실행 권한을 사용한 실행이 성공했다. 실패를 성공으로 계산하지 않았다.
- `git diff --check`: 통과.
- 실제 BE DB/HTTP 통합 테스트, 실제 Google/Naver DOM, Chrome Stable 권한 대화상자 및 Windows 환경 테스트는 실행하지 않았다.

## 최초 검토 보고 당시 Git 처리

최초 검토 보고 당시 worktree는 `fix/26/page-visit-sequence`이며 기준은 공식 최신 main `1679992`였다. 이 브랜치가 기존 원본 checkout에도 연결되어 있어, 그 checkout의 파일을 변경하지 않고 현재 worktree에서 사용했다. 공유 브랜치 참조를 전진시켜 다른 checkout의 상태에 영향을 주지 않도록 최초 검토 단계에서는 커밋을 생성하지 않았다. 변경 파일 14개는 이 worktree에 미커밋 상태로 남겨 두었다. 당시 Push·PR 생성·BE PR 병합·main 직접 변경은 하지 않았다.

이후 사용자가 `origin/fix/26/page-visit-sequence` Push를 요청하여, 위 변경사항의 한국어 커밋 및 해당 원격 브랜치 Push를 승인했다. 실제 커밋과 원격 반영 결과는 Git 이력으로 확인한다. PR 생성은 요청하지 않았다.
