import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const bodyA = 'JWT 문서에서 토큰 검증 방법과 Spring Security 인증 처리 절차를 설명합니다. 안전한 공개 기술 문서의 의미 있는 본문입니다.';
const bodyB = '우주 탐사선은 먼 행성의 대기와 암석을 연구합니다. 천문학자들이 수집한 관측 자료로 태양계 형성 과정을 분석하는 과학 기사입니다.';
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  const body = path === '/b' ? bodyB : path === '/short' ? '짧은 본문' : bodyA;
  const sensitive = path === '/sensitive' ? '<form><input type="password" value="PRIVATE_PASSWORD"><textarea>PRIVATE_INPUT</textarea></form>' : '';
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><html lang="ko"><head><title>공개 테스트 문서</title></head><body><article><h1>문서 제목</h1><p>${body}</p></article>${sensitive}<nav>OMITTED_NAV</nav></body></html>`);
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const origin = `http://127.0.0.1:${server.address().port}`;
const root = await mkdtemp(join(tmpdir(), 'focus-recovery-browser-'));
let context;
try {
  const extension = join(root, 'extension');
  await cp(resolve('dist'), extension, { recursive: true });
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
  // The unattended test profile pre-grants only its synthetic fixture host.
  // The shipped manifest still uses optional per-site permissions.
  manifest.host_permissions = ['http://127.0.0.1/*', 'https://www.google.com/*', 'https://search.naver.com/*'];
  await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
  context = await chromium.launchPersistentContext(join(root, 'profile'), {
    channel: 'chromium', headless: !process.env.HEADED,
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  // All search test responses are intercepted fixtures, never live-service evidence.
  await context.route(/^https:\/\/(?:www\.google\.com|search\.naver\.com)\//, async route => {
    const url = new URL(route.request().url());
    const google = url.hostname === 'www.google.com';
    const parameter = google ? 'q' : 'query';
    const empty = url.searchParams.get(parameter) === 'NO_RESULTS';
    const card = google
      ? '<div class="MjjYud"><a href="https://example.com/docs"><h3>인증</h3></a></div>'
      : '<div data-block-id="web/prs_template_v2_web_basic_desk.ts"><a href="https://example.com/docs"><span class="sds-comps-text-type-headline1">인증</span></a></div>';
    const ad = google ? '<div id="tads" class="MjjYud"><span>Sponsored</span><a href="https://example.com/ad"><h3>PRIVATE_AD</h3></a></div>' : '<div data-ad data-block-id="web/example"><span>광고</span><a href="https://example.com/ad"><span class="sds-comps-text-type-headline1">PRIVATE_AD</span></a></div>';
    const root = google ? '<div id="search"><div id="rso"></div></div>' : '<div id="main_pack"></div>';
    const selector = google ? '#rso' : '#main_pack';
    const action = google ? '/search' : '/search.naver';
    await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><title>공개 검색 fixture</title><form role="search" action="${action}"><input name="${parameter}" value="PRIVATE_INPUT"></form>${root}${empty ? '' : `<script>setTimeout(() => document.querySelector('${selector}').innerHTML = ${JSON.stringify(card + ad)}, 500)</script>`}` });
  });
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent('serviceworker', { timeout: 10000 });
  const id = worker.url().split('/')[2];
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  const status = () => popup.evaluate(() => chrome.runtime.sendMessage({ type: 'status' })).then(reply => { assert.equal(reply.ok, true); return reply.status; });
  const page = await context.newPage();
  await page.goto(`${origin}/a`);
  assert.equal((await status()).candidates.length, 0, 'no collection before session');
  await popup.bringToFront();
  await popup.getByLabel(/최초 작업 목표/).fill('공개 문서 조사하기');
  await popup.getByRole('button', { name: '로컬 세션 시작' }).click();
  await popup.getByText('활성 로컬 세션', { exact: false }).waitFor();
  await page.bringToFront();
  async function until(check, label) {
    for (let i = 0; i < 50; i++) {
      const result = await status();
      if (check(result)) return result;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out: ${label}`);
  }
  let result = await until(state => state.visits.length === 1, 'active document becomes valid');
  const first = result.visits[0];
  assert.equal(first.content.includes('OMITTED_NAV'), false);
  assert.match(first.visitId, /^[a-f0-9-]{36}$/);
  await page.reload();
  await page.waitForLoadState();
  result = await until(state => state.visits[0]?.activeDurationMs > first.activeDurationMs, 'reload resumes');
  assert.equal(result.visits[0].visitId, first.visitId);
  assert.equal(result.candidates.length, 1);
  await page.goto(`${origin}/b`);
  result = await until(state => state.visits.length === 2, 'new document');
  assert.notEqual(result.visits[1].visitId, first.visitId);
  await page.goBack();
  result = await until(state => state.visits.length === 3, 'back navigation');
  assert.notEqual(result.visits[2].visitId, first.visitId);
  await page.goForward();
  result = await until(state => state.visits.length === 4, 'forward navigation');
  await page.goBack();
  result = await until(state => state.visits.length === 5, 'second back navigation');
  const beforeSpa = result.candidates.length;
  await page.evaluate(() => history.pushState({}, '', '?id=100'));
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal((await status()).candidates.length, beforeSpa, 'URL-only SPA change is not a visit');
  await page.evaluate(body => { history.pushState({}, '', '?id=200'); document.querySelector('article p').textContent = body; }, bodyB);
  result = await until(state => state.visits.length === 6, 'SPA changes URL and content');
  assert.equal(result.visits.at(-1).normalizedUrl, `${origin}/a`);
  await page.evaluate(() => { document.querySelector('article').insertAdjacentHTML('beforeend', '<p>댓글 펼치기</p>'); });
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal((await status()).visits.length, 6, 'UI mutation does not duplicate');
  const second = await context.newPage();
  await second.goto(`${origin}/b`); await second.bringToFront();
  result = await until(state => state.visits.length === 7, 'second tab');
  const sequence = result.visits.map(visit => visit.sequence);
  assert.equal(new Set(sequence).size, sequence.length);
  await page.bringToFront();
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal((await status()).visits.length, 7, 'returning to existing tab reuses visit');
  const beforeFailure = await status();
  const protectedVisits = beforeFailure.visits.map(({ visitId, sequence, content }) => ({ visitId, sequence, content }));
  // Abort only a synthetic request: exercise real onErrorOccurred without external URLs.
  await page.route(`${origin}/failed`, route => route.abort('failed'));
  let navigationFailed = false;
  try { await page.goto(`${origin}/failed`); } catch { navigationFailed = true; }
  assert.equal(navigationFailed, true, 'navigation failure was actually exercised');
  result = await until(state => state.session?.sessionId === beforeFailure.session.sessionId && state.visits.length === 7, 'failed navigation preserves the session');
  assert.deepEqual(result.visits.map(({ visitId, sequence, content }) => ({ visitId, sequence, content })), protectedVisits, 'failed navigation preserves prior visits');
  await second.bringToFront();
  await new Promise(resolve => setTimeout(resolve, 1200));
  result = await status();
  assert.equal(result.visits.length, 7, 'failed navigation never becomes a valid visit');
  assert.equal(result.session.sessionId, beforeFailure.session.sessionId);
  const closing = await context.newPage();
  let releaseRequest;
  const requestEntered = new Promise(resolve => { releaseRequest = resolve; });
  await closing.route(`${origin}/closing`, async route => {
    releaseRequest();
    await route.abort('failed').catch(() => undefined);
  });
  const interrupted = closing.goto(`${origin}/closing`).catch(() => undefined);
  await requestEntered;
  await closing.close();
  await interrupted;
  result = await status();
  assert.equal(result.session.sessionId, beforeFailure.session.sessionId, 'closing a navigating tab preserves other tabs');
  assert.deepEqual(result.visits.map(({ visitId, sequence, content }) => ({ visitId, sequence, content })), protectedVisits);
  const beforeRestart = await status();
  const cdp = await context.newCDPSession(page);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  const afterRestart = await status();
  assert.equal(afterRestart.session.sessionId, beforeRestart.session.sessionId, 'worker recovers session');
  assert.deepEqual(afterRestart.visits.map(visit => [visit.visitId, visit.sequence]), beforeRestart.visits.map(visit => [visit.visitId, visit.sequence]), 'worker recovers visits');
  await cdp.detach();
  await page.goto(`${origin}/sensitive`);
  result = await until(state => state.candidates.at(-1)?.reason === 'dom-policy', 'sensitive page exclusion');
  assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
  await page.goto(`${origin}/short`);
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal((await status()).visits.length, 7, 'short content excluded');
  const initialSearchCount = (await status()).visits.length;
  await page.goto('https://www.google.com/search?q=JWT&extra=OMITTED#OMITTED'); await page.bringToFront();
  result = await until(state => state.visits.length === initialSearchCount + 1, 'synthetic Google delayed organic result');
  const searchVisit = result.visits.at(-1);
  assert.equal(searchVisit.searchQuery, 'JWT'); assert.equal(searchVisit.isSearchResultPage, true);
  assert.equal(searchVisit.normalizedUrl, 'https://www.google.com/search');
  assert.equal([...searchVisit.content].length < 50, true, 'short organic result bypasses ordinary HTML threshold');
  assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
  assert.equal(JSON.stringify(result).includes('OMITTED'), false);
  await page.reload();
  result = await until(state => state.visits.at(-1)?.activeDurationMs > searchVisit.activeDurationMs, 'search reload resumes');
  assert.equal(result.visits.at(-1).visitId, searchVisit.visitId);
  const searchCandidates = result.candidates.length;
  await page.evaluate(() => history.pushState({}, '', '?q=우주'));
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal((await status()).candidates.length, searchCandidates, 'query-only search change does not duplicate');
  await page.evaluate(() => { document.querySelector('#rso h3').textContent = '행성'; });
  result = await until(state => state.visits.length === initialSearchCount + 2, 'search SPA query and results change');
  assert.equal(result.visits.at(-1).searchQuery, '우주');
  await page.goto('https://search.naver.com/search.naver?query=한글+인증');
  result = await until(state => state.visits.length === initialSearchCount + 3, 'synthetic Naver Korean results');
  assert.equal(result.visits.at(-1).searchQuery, '한글 인증');
  await page.goBack();
  result = await until(state => state.visits.length === initialSearchCount + 4, 'search back creates a visit');
  assert.notEqual(result.visits.at(-1).visitId, searchVisit.visitId);
  await page.goForward();
  result = await until(state => state.visits.length === initialSearchCount + 5, 'search forward creates a visit');
  const naverVisit = result.visits.at(-1);
  await second.goto('https://www.google.com/search?q=Spring+Boot+JWT'); await second.bringToFront();
  result = await until(state => state.visits.length === initialSearchCount + 6, 'second search tab');
  assert.equal(new Set(result.candidates.map(c => c.sequence)).size, result.candidates.length);
  await page.bringToFront(); await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal((await status()).visits.at(-2).visitId, naverVisit.visitId, 'search tab return reuses ID');
  const searchBeforeRestart = await status();
  const searchCdp = await context.newCDPSession(page); await searchCdp.send('ServiceWorker.enable'); await searchCdp.send('ServiceWorker.stopAllWorkers');
  result = await status();
  assert.deepEqual(result.visits.map(v => [v.visitId, v.sequence, v.searchQuery]), searchBeforeRestart.visits.map(v => [v.visitId, v.sequence, v.searchQuery]), 'worker restores search visits');
  await searchCdp.detach();
  const preserved = result.visits.map(v => [v.visitId, v.sequence, v.content]);
  await page.goto('https://www.google.com/search?q=NO_RESULTS');
  await new Promise(resolve => setTimeout(resolve, 8500));
  result = await status();
  assert.equal(result.candidates.at(-1).reason, 'unavailable-content', 'zero search results exhaust bounded wait');
  assert.deepEqual(result.visits.map(v => [v.visitId, v.sequence, v.content]), preserved, 'empty search preserves valid visits');
  await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'stop' }));
  const stopped = await status();
  await page.goto(`${origin}/a`);
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal((await status()).candidates.length, stopped.candidates.length, 'no collection after stop');
  console.log(`PASS: real MV3 load, popup, messaging, session gate, extraction, reload, back/forward, SPA, tabs, sequence, navigation failure/tab-close race, worker restart, sensitive/short exclusion, synthetic Google/Naver organic results, search SPA/reload/history/tabs/recovery/zero results, stop (${context.browser()?.version() ?? 'Chromium'})`);
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
