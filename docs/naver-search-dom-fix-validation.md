# Naver 일반 웹 결과 DOM 누락 수정 — Issue #60

검증일: 2026-10-19 (Asia/Seoul). [Issue #60](https://github.com/SKHU-AI-Projects-Archive/2026-2-Capstone-T01-focus-recovery/issues/60)의 전체 본문과 [#59 검증 PR #61](https://github.com/SKHU-AI-Projects-Archive/2026-2-Capstone-T01-focus-recovery/pull/61)의 결과를 확인했다. **원래 재현 2건은 FAIL → PASS이고, 실제 Chrome 확장에서 영어·한국어 검색 방문 2건을 새 전용 MySQL에 저장했다.** 합성 회귀와 실제 서비스 결과를 구분한다. 파일럿 전체 승인이나 #59의 수동 권한 검증 완료를 의미하지 않는다.

## Git 기준과 #59 의존 관계

- 시작 브랜치 `test/59/real-search-permission-e2e`, HEAD `43ee8aa52993e22a462156e1072acf37aeac6598`, 미커밋·미추적 변경 없음.
- origin은 개인 Fork `hyeon-marina/2026-2-Capstone-T01-focus-recovery`, upstream은 공식 `SKHU-AI-Projects-Archive/2026-2-Capstone-T01-focus-recovery`다.
- 공식 main을 fetch한 **`739196cd70ef3f763d2f8af69fba85f102395f45`**에서 `fix/60/naver-search-dom` 생성. 중복 원격 `fix/60/*` 브랜치/PR 없음. main·기존 #59 브랜치·다른 worktree를 수정하지 않았다.
- #59 PR #61은 시작 시 **OPEN / Draft / 미병합**이었다. 해당 커밋에서 `fe/tests/search-live-dom.test.ts`, `fe/tests/fixtures/naver-20261019.html` **두 파일만** 가져왔다. unrelated 권한 테스트·보고서·브라우저 변경을 통째로 병합하거나 cherry-pick하지 않았다. #60 PR은 공식 main에 독립적으로 적용 가능하다.
- **PR 조정 필요:** #61과 두 파일이 겹친다. #61을 나중에 반영할 때 이 수정된 fixture와 기본 활성 테스트를 유지하고, #61의 “같은 fixture가 안전하게 제외된다”는 과거 브라우저 기대를 현재의 정상 추출 기대와 조정해야 한다. #59 당시의 FAIL 기록은 역사적 결과로 보존한다. 이번에는 그 브랜치를 임의 수정하지 않았다.
- README·프로젝트 계획서·PR template 확인. 적용할 AGENTS.md나 별도 Git 가이드는 발견하지 못했다. 사용자의 공식 main 대상 PR 지시를 따른다. 새 Issue 생성·force push·hard reset·자동 Merge 없음.

## 원인과 실제 DOM 근거

기존 `naverResults()`는 `#main_pack [data-block-id^="web/"]` 또는 `[data-template-id="ugcItem"][data-template-type="searchBasic"]`만 순회했다. #59와 이번 실제 데스크톱 관측에서 일반 웹 결과는 다음 의미 있는 클래스 계층을 가졌다.

```html
<div id="main_pack">
  <!-- 상위 검색 collection의 data-block-id는 빈 값인 샘플도 있다. -->
  <div class="fds-web-root">
    <div class="fds-web-list-root">
      <div class="fds-web-doc-root fds-web-normal-doc-root">
        <div><!-- layout --><a href="https://example.com/docs">
          <span class="sds-comps-text-type-headline1">합성 제목</span>
        </a></div>
        <a href="https://example.com/docs"><span class="sds-comps-text-type-body1">합성 설명</span></a>
      </div>
    </div>
  </div>
</div>
```

실제 원문이 아닌 구조 설명이다. DOM 관측은 새 임시 Chrome 프로필에서 공개 영어/한국어 검색 각 1회로 수행했다. 한국어의 관측된 일반 카드 10개는 모두 제목 1개·설명 1개였고 두 anchor의 목적지 URL이 같았다. 해시 클래스·추적 파라미터·실제 검색 결과 텍스트는 fixture에 옮기지 않았다. 동적으로 로드되는 카드도 기존 MutationObserver와 재시도 안에서 수집한다.

기존 selector는 빈 `data-block-id` 아래의 이 카드를 찾지 못하므로 결과 null → 약 8초 뒤 `unavailable-content` → 유효 방문 및 POST 없음으로 이어졌다. 검색 URL parser/정규화나 BE 저장 계약의 결함은 아니었다.

### 수정한 경계와 연결 규칙

1. 새 selector는 **`#main_pack .fds-web-root .fds-web-list-root > .fds-web-doc-root.fds-web-normal-doc-root`**다. `#main_pack`의 모든 headline이나 공통 SDS layout을 결과로 인정하지 않는다.
2. 새 카드에서는 `a[href] .sds-comps-text-type-headline1`이 정확히 하나이고 그 제목이 현재 카드에 속해야 한다. 설명도 현재 카드에 속하며 제목 링크와 URL 해석 후 **동일한 전체 href**인 `body1`만 연결한다. 다른 카드/다른 목적지의 설명을 빌리지 않는다.
3. 일치하는 설명이 여러 개면 추측하지 않고 카드를 제외한다. 설명이 없거나 다른 목적지면 검증된 제목만 기존 계약대로 1건으로 인정한다. 링크가 안전하지 않으면 기존 `result()`에서 카드 전체를 제외한다.
4. 기존 `web/…`, `ugcItem/searchBasic` 경로는 유지한다. 기존 wrapper가 새 카드를 포함할 때는 wrapper를 건너뛰고 실제 카드별로 처리하며 같은 제목 DOM과 같은 제목·설명의 중복을 방지한다.
5. 새 카드의 상위 nonempty `data-block-id`는 `web/`만 허용하고, 구형 경로는 `web/`·`ugc/`만 허용한다. **빈 ID는 미분류 페이지 전체 허용이 아니라, 위의 정확한 카드 경계가 이미 있는 경우에만 허용**한다. 그 밖의 nonempty section 및 `aipickItem`은 제외한다.

### 광고·AI·공통 UI 제외

- `ai-briefing/`, `aipick/`, 추천·관련 검색·계정·광고 등 non-web section은 상위에 빈 ID가 더 있어도 제외한다. 카드 클래스가 흉내 나더라도 상위 section 검사를 우회하지 못한다.
- `.fds-web-recommend-doc-root` 및 web/list/normal 카드 경계가 없는 headline은 수집하지 않는다. AI 브리핑·AI 추천을 유기적 결과로 추가하는 fallback은 없다.
- 기존 광고 속성·Sponsored/광고 라벨·숨김·form·검색창·nav/header/footer·개인정보 문서 제외를 유지한다. 실제 #59에서 관측한 Naver 광고 destination `ader.naver.com`을 기존 광고 호스트 거부 목록에 추가했다. 공통 `result()`의 이 호스트 거부만 Google에도 적용되며 Google selector/본문 생성은 변경하지 않았다.
- `reply`·`articleSource`의 body1은 설명으로 쓰지 않는다. 전체 body/페이지 innerText fallback, 해시 CSS 클래스 의존성, 새로운 API 필드는 없다.
- `organicResultCount`는 실제로 통과한 결과와 5,000 code point 한도 안의 완전한 제목만 센다. query, `isSearchResultPage`, URL 정규화, visitId/sequence, IDB/ACK, POST/PATCH/END 처리는 기존 코드와 계약을 유지했다.

## 재현 FAIL → PASS와 합성 테스트

먼저 #59의 원래 fixture/테스트를 가져온 직후 `RUN_KNOWN_SEARCH_BUG=1 npm test -- tests/search-live-dom.test.ts`에서 **2 FAIL**을 재확인했다. 기존 fixture는 일반 결과 제목/설명만 남겨 안전한 카드 경계를 지나치게 생략했으므로, 이번 실제 관측의 `fds-web-root/list-root/doc-root/normal-doc-root`를 최소 구조에 보완했다. 기대 본문과 `organicResultCount=1`은 바꾸지 않았다.

제품 수정 전, 보완 fixture와 기본 활성화된 두 테스트도 **2 FAIL(null)**이었다. 그 후 추출기 수정으로 같은 기대값이 **2 PASS**했다. `RUN_KNOWN_SEARCH_BUG` 조건·SKIP·예상 실패 설정은 제거했다. 예전 명령을 사용해도 이제 같은 기본 테스트가 실행된다.

| 테스트 | 판정·범위 |
| --- | --- |
| `search-live-dom.test.ts` | **25 PASS**: 원래 영어/한국어 2건, 카드별 제목/설명 연결, AI·추천·계정/광고 section, sponsor 속성/라벨, 공통 UI, 경계 누락, 광고/검색/비HTTP 링크, 다른 목적지 설명 배제, 모호한 다중 제목/설명, 중첩 legacy/modern 중복, query+결과 교체·결과 없음, 5,000 code points |
| `search-extraction.test.ts` | 기존 **25 PASS** 그대로: Google 추출/광고/민감 DOM/길이, 구형 Naver web·UGC 구조 등 |
| `search-content.test.ts` | **6 PASS**: 기존 테스트 유지, 새 구조의 지연 DOM·8초 timeout 이후 복구, query/결과 동적 교체 추가. 실제 MutationObserver를 jsdom에서 검사 |
| `browser-test.mjs` | Naver 합성 응답을 새 카드 경계로 검증. 지연 로딩·제목/설명·광고/입력 비노출, reload/history/tabs/Worker/sequence 등 기존 검사 유지. Naver 0결과의 bounded 제외/기존 방문 보존 추가 |

신규 테스트 초기에 합성 링크 `/auth-doc`가 기존 민감 URL 제외 정책에 걸려 카드 1개만 남았다. 공개 문서용 `/security-guide`로 fixture만 바로잡았으며 기대 2건과 기존 민감 경로 정책은 완화하지 않았다.

## 실제 Naver Chrome → BE → MySQL

macOS **27.0.1 arm64**, Chrome for Testing **151.0.7922.34**, Node **25.9.0**, npm **11.12.1**, Java **21.0.10**, Spring Boot **4.1.1**, MySQL **8.4.9**.

새 컨테이너 `focus-recovery-issue60-20261019-d9ba` (ID `4abc301a4572…`, label `focus-recovery.issue=60`)를 생성했다. DB는 `127.0.0.1:62862`, 신규 Flyway V1~V10 적용 후 validate. JAR를 고정 사본 `/tmp/focus60-be-JrYV6j/server.jar`로 실행하고 **`server.port=0`**을 사용했다. 새 PID **84689**, 기동 완료 로그와 datasource를 확인한 실제 API 포트는 **63112**였다. 기존 포트의 서버나 기존 DB에 요청하지 않았다.

`scripts/naver-search-integration-test.mjs`는 명시적인 loopback API와 issue=60 label이 있는 DB를 요구한다. 생성한 sessionId가 해당 DB에 실제 있는지 확인한 **뒤에** 검색을 시작한다. 임시 extension을 이 API로 빌드하고 Naver host를 임시 manifest에 사전 부여했다. **수동 사이트 권한 dialog 검증은 아니다.** 실제 검색 응답을 가로채거나 HTML로 교체하지 않았으며 CAPTCHA·로그인·서비스 제한을 우회하지 않았다.

| 실제 서비스 검증 | 판정 | 이번 실행 근거 |
| --- | --- | --- |
| 정상 결과 표시·일반 카드 인식 | PASS | 영어·한국어 정상 `/search.naver`, 유효 방문 2건 |
| 영어 결과 제목·설명 | PASS | **7건 / 본문 1,573 code points**. 각 추출 제목/설명이 실제 일반 카드의 같은 링크 쌍과 일치 |
| 한국어 결과 제목·설명 | PASS | **10건 / 본문 2,430 code points**. 같은 연결 대조 |
| 실제 검색어·URL·제목·본문 | PASS | query 정확 보존, query/fragment 없는 URL, document.title 일치. SQL의 각 필드 SHA-256을 FE 원본과 대조 |
| AI 영역의 무분별 수집 방지 | PASS (관측 샘플) | 수집 블록 모두 실제 normal 카드의 제목/설명 쌍에 대응. 구조 관측에서 AI 하위 normal 카드 0. 합성 AI section 검사는 별도 수행 |
| 실제 광고가 있는 화면의 광고 제외 | SKIP (해당 샘플 부재) | 구조 관측의 광고 컨테이너 0; 실제 광고 노출 샘플 전체를 검증했다고 주장하지 않음. 광고 속성/라벨/호스트 제외는 합성 회귀 PASS |
| Page Visit 생성·전송·저장 | PASS | 실제 확장→Spring Boot→MySQL 방문 **2행**, sequence **1,2**, 별도 UUID |
| 중복 재전송 | PASS | 각각 같은 payload POST **200**, 본문/제목/query 원본 응답 일치, SQL 행 수 1→2 유지 |
| 결과 없는 검색 | PASS (관측 샘플) | 공개 무의미 검증어 1회: `unavailable-content`, 유효 방문·DB 행 수 **2**로 불변 |
| 연속 검색 | PASS | 영어→한국어의 실제 전체 문서 이동, 별도 visitId/sequence, 이전 query/결과 재사용 없음 |
| 실제 SPA/A-B 레이아웃의 제어된 동적 변경 | SKIP | 실제 페이지의 비동기 결과 수집은 확인. 실제 SPA 변경 전체 행렬은 미실행. 합성 observer/SPA 회귀는 PASS |
| 최종 행동·종료 | PASS | 최종 activeDurationMs/tabSwitchCount/behaviorVersion SQL 일치, 서버·SQL **ENDED**, 유효 방문 5개 미만 Window **0** |

실서비스 요청은 DOM 구조 관찰 2회와 위 영어/한국어/빈 검색 3회였다. 실제 결과 원문은 메모리와 전용 임시 DB에서만 대조하고 출력·GitHub·fixture에는 남기지 않았다. 전체 사이트 HTML·쿠키·인증정보·개인 검색 기록을 저장하지 않았다.

정리 직전 UTF-8 MySQL client로 실제 검증 세션의 **ENDED / 2행 / sequence 1,2 / 본문 길이 1,573·2,430**을 다시 대조했다. 직접 만든 BE PID와 DB 컨테이너 ID/label 확인 후 종료·삭제했고, 익명 볼륨·고정 JAR 사본·모든 테스트 임시 Chrome 프로필도 정리했다. 기존 서버·DB·컨테이너는 정리하거나 변경하지 않았다.

## 기존 회귀 실행 결과

| 실행 | 판정 | 범위 |
| --- | --- | --- |
| `npm test` | PASS | **26파일 / 754건**, failure/skip 0. 공식 main의 기존 726건 보존 + 신규 추출 25건 + async 3건 |
| `npm run typecheck`, `npm run build` | PASS | production popup/Worker/content |
| 수정 전 원래/보완 재현 | FAIL → PASS | 위의 실제 null 실패를 먼저 확인, 수정 후 기본 실행 PASS |
| Chrome MV3 headless | PASS | 합성 API/검색, 새 Naver 구조와 기존 Google/방문/복구 회귀. native 창 검사는 이 실행에서 SKIP |
| Chrome MV3 headed | PASS | 전체 회귀와 native 다중 창·최소화·복원 |
| 기존 방문 통합 | PASS | 새 전용 BE/MySQL의 7방문·3Window·단계별 SQL·Unicode 7종·멱등·복구·삭제 경합·실제 400 원본 보존 |
| 기존 행동 통합 | PASS | 기존 12개 POST/PATCH·SQL·Worker/브라우저/reload/복구 시나리오 |
| 기존 세션 종료 통합 | PASS | 기존 12개 END_PENDING·최종 ACK·Worker/브라우저/reload·충돌 원본 보존 시나리오 |
| Java 21 `./gradlew --offline --rerun-tasks test bootJar` | PASS | **16 suite / 361건**, failure/error/skip 0. 캐시 UP-TO-DATE만 보고한 결과가 아님 |
| Node 구문·`git diff --check` | PASS | 변경 스크립트 구문·공백 |
| 실제 Google·Chrome 권한 dialog·Windows/모바일/국가별 DOM | SKIP | 이번 #60 범위 밖. #59의 Google BLOCKED/수동 권한 미완료를 해소했다고 주장하지 않음 |

BE 제품 코드·스키마·DTO·전송 계약을 변경하지 않았다. AI base URL은 연결이 거부되는 테스트 주소로 지정했으며 AI 추론 성능은 검증하지 않았다.

## 변경 파일

- `fe/src/content/search.ts`: 새 Naver 경계·동일 카드/링크 연결·section 제외·중복 처리, 알려진 Naver 광고 호스트 추가.
- `fe/tests/search-live-dom.test.ts`, `fe/tests/fixtures/naver-20261019.html`: #59의 두 파일만 재사용·보완, 기본 활성화와 경계/광고 회귀.
- `fe/tests/search-content.test.ts`: 지연·복구·query 교체의 새 구조 검증.
- `fe/scripts/browser-test.mjs`: 새 구조·설명·빈 결과의 기존 MV3 회귀 보강.
- `fe/scripts/naver-search-integration-test.mjs`: 명시적 로컬 API·전용 DB, 실제 서비스 3검색과 저장/멱등/종료 검증, 원문 비출력.
- `fe/README.md`, 이 문서: 현재 지원 경계·재현·실서비스/합성 판정·미검증 범위.

## 재실행

먼저 **새 이름의 일회용 DB**와 본인이 시작한 BE를 준비한다. 이름이 이미 있으면 재사용하거나 삭제하지 말고 새 이름을 선택한다.

```sh
docker run --detach --name focus-recovery-issue60-NEW \
  --label focus-recovery.issue=60 --publish 127.0.0.1::3306 \
  --env MYSQL_ALLOW_EMPTY_PASSWORD=yes --env MYSQL_DATABASE=focus_recovery mysql:8.4
docker port focus-recovery-issue60-NEW 3306
docker exec focus-recovery-issue60-NEW mysqladmin ping --silent

cd be
JAVA_HOME=/absolute/path/to/Java21 ./gradlew --offline test bootJar
# 고정 JAR 사본을 만든 뒤 별도 터미널에서 시작한다. 실행 중 JAR를 재빌드하지 않는다.
/absolute/path/to/Java21/bin/java -jar /absolute/path/to/copied-server.jar \
  --spring.profiles.active=e2e --server.address=127.0.0.1 --server.port=0 \
  '--spring.datasource.url=jdbc:mysql://127.0.0.1:새_DB_포트/focus_recovery?serverTimezone=UTC' \
  --spring.datasource.username=root --spring.datasource.password= \
  --spring.jpa.hibernate.ddl-auto=validate --focus-recovery.ai.base-url=http://127.0.0.1:1
```

새 PID·datasource·기동 완료와 실제 배정 API 포트를 확인하고, 브라우저 테스트는 순차 실행한다.

```sh
cd fe
npm ci --no-audit --no-fund
npm test
npm test -- tests/search-live-dom.test.ts tests/search-extraction.test.ts tests/search-content.test.ts
# 예전 재현 명령도 이제 같은 기본 회귀를 실행하며 PASS해야 한다.
RUN_KNOWN_SEARCH_BUG=1 npm test -- tests/search-live-dom.test.ts
npm run typecheck
npm run build
export CHROMIUM_PATH='/absolute/path/to/Google Chrome for Testing'
export INTEGRATION_API_BASE_URL=http://127.0.0.1:배정_API_포트
export INTEGRATION_MYSQL_CONTAINER=focus-recovery-issue60-NEW
HEADED=1 node scripts/naver-search-integration-test.mjs
npm run test:browser
HEADED=1 npm run test:browser
node scripts/visit-integration-test.mjs
node scripts/behavior-integration-test.mjs
node scripts/session-end-integration-test.mjs
```

실서비스 실패 시 무조건 반복 요청하지 않는다. 출력의 stage와 제한/DOM 변화를 분리해 확인한다. 수집 텍스트는 로그로 출력하지 않으며, 실패 때도 임시 프로필은 삭제한다. 해당 테스트 서버의 ACTIVE/END_PENDING 세션이 남을 수 있으므로 일회용 DB에서만 실행한다. 정리는 직접 만든 서버·컨테이너·익명 볼륨만 대상으로 한다.

## 알려진 한계와 파일럿 장애 요인

- 이 수정은 관측된 데스크톱 normal 웹 카드와 기존 web/UGC 구조를 지원한다. 모바일·국가별·다른 A/B·Shadow DOM·iframe·새로운 section은 보장하지 않는다. 정확한 경계가 사라지거나 미확인 nonempty section이면 제외하며 body fallback으로 수집하지 않는다.
- 같은 href 설명만 연결하는 보수적 정책은 제목/설명이 서로 다른 tracking URL을 쓰는 레이아웃에서 설명을 누락할 수 있다. 다중 제목/설명이 있는 카드도 제외한다. 실제 구조 근거 없이 범위를 확대하지 않는다.
- 일반 웹 카드도 기존 민감 URL/DOM·광고 정책을 통과해야 하므로 화면의 모든 headline 수와 organicResultCount가 같아야 하는 것은 아니다. 광고·AI를 포함한 전체 페이지 수집 기능이 아니다.
- #59의 Google 접근 제한, 실제 권한 허용·거부·철회·재허용 전체, 지원 OS/Chrome 범위, 광고 노출 샘플과 실제 SPA 전체 조합 검증은 남아 있다. #60의 실제 Naver 저장 성공만으로 파일럿 전제가 모두 충족되지는 않는다.
- 새 Issue·AI 기능·BE 비즈니스 로직·로그인/인증·DB migration·확장 아키텍처 변경은 없다. PR #61과 겹치는 fixture/테스트의 병합 조정이 필요하다.
