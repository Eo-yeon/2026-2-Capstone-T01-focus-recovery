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
  manifest.host_permissions = ['http://127.0.0.1/*'];
  await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
  context = await chromium.launchPersistentContext(join(root, 'profile'), {
    channel: 'chromium', headless: !process.env.HEADED,
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
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
  await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'stop' }));
  const stopped = await status();
  await page.goto(`${origin}/a`);
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal((await status()).candidates.length, stopped.candidates.length, 'no collection after stop');
  console.log(`PASS: real MV3 load, popup, messaging, session gate, extraction, reload, back/forward, SPA, tabs, sequence, worker restart, sensitive/short exclusion, stop (${context.browser()?.version() ?? 'Chromium'})`);
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
