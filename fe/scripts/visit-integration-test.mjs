// Real BE test: requires an explicit disposable API server; no API request mocking.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const api = process.env.INTEGRATION_API_BASE_URL;
assert.ok(api, 'Set INTEGRATION_API_BASE_URL to a disposable Spring Boot server');
const apiUrl = new URL(api);
assert.ok(['http:', 'https:'].includes(apiUrl.protocol));
const host = apiUrl.hostname === '127.0.0.1' ? 'localhost' : '127.0.0.1';
const fixture = createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end('<!doctype html><title>공개 합성 방문 검증</title><article><h1>공개 문서</h1><p>' + '서버 방문 저장을 확인하는 개인정보 없는 공개 합성 본문입니다. '.repeat(5) + '</p></article>');
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const origin = `http://${host}:${fixture.address().port}`;
const root = await mkdtemp(join(tmpdir(), 'focus-visit-integration-'));
let context;
try {
  process.env.VITE_API_BASE_URL = apiUrl.origin;
  const extension = join(root, 'extension');
  await build({ configFile: resolve('vite.config.ts'), build: { outDir: extension } });
  await build({ configFile: resolve('vite.content.config.ts'), build: { outDir: extension } });
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
  manifest.host_permissions.push(`http://${host}/*`);
  await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
  context = await chromium.launchPersistentContext(join(root, 'profile'), {
    channel: 'chromium', headless: !process.env.HEADED, executablePath: process.env.CHROMIUM_PATH || undefined,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent('serviceworker');
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${worker.url().split('/')[2]}/popup.html`);
  const request = message => popup.evaluate(message => chrome.runtime.sendMessage(message), message);
  const status = async () => { const reply = await request({ type: 'status' }); assert.equal(reply.ok, true); return reply.status; };
  async function until(check) {
    for (let i = 0; i < 150; i++) {
      const current = await status();
      assert.equal(current.visitDelivery.blocked, undefined);
      assert.equal(current.visitDelivery.visits.some(visit => visit.phase === 'failed'), false, 'visit delivery must not fail');
      if (check(current)) return current;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail('Timed out waiting for visits/ACK');
  }
  const page = await context.newPage();
  await page.goto(`${origin}/document/1`); await page.bringToFront();
  assert.equal((await request({ type: 'start', goalText: '공개 합성 방문 여섯 개 저장 검증하기' })).ok, true);
  const sessionId = (await status()).session.sessionId;
  assert.match(sessionId, /^[a-f0-9-]{36}$/);
  async function checkDatabase() {
    if (!process.env.INTEGRATION_MYSQL_CONTAINER) return;
    const sql = `SELECT COUNT(*), COUNT(DISTINCT visit_id), COUNT(DISTINCT sequence) FROM page_visit WHERE session_id='${sessionId}';
      SELECT COUNT(*), COUNT(DISTINCT window_index), COUNT(DISTINCT end_visit_id) FROM analysis_window WHERE session_id='${sessionId}';
      SELECT aw.window_index, GROUP_CONCAT(pv.sequence ORDER BY wv.position) FROM analysis_window aw
      JOIN window_visit wv ON wv.window_id=aw.window_id JOIN page_visit pv ON pv.visit_id=wv.visit_id
      WHERE aw.session_id='${sessionId}' GROUP BY aw.window_index ORDER BY aw.window_index;`;
    const { stdout } = await promisify(execFile)('docker', ['exec', process.env.INTEGRATION_MYSQL_CONTAINER, 'mysql', '-uroot', '--batch', '--skip-column-names', 'focus_recovery', '-e', sql]);
    assert.deepEqual(stdout.trim().split('\n'), ['6\t6\t6', '2\t2\t2', '1\t1,2,3,4,5', '2\t2,3,4,5,6']);
  }
  for (let count = 1; count <= 6; count++) {
    if (count > 1) await page.goto(`${origin}/document/${count}`);
    await page.bringToFront();
    await until(state => state.visits.length === count);
  }
  assert.equal((await request({ type: 'stop' })).ok, true);
  const complete = await until(state => state.visitDelivery.visits.length === 6 && state.visitDelivery.visits.every(visit => visit.phase === 'acked'));
  assert.deepEqual(complete.readyVisits.map(visit => visit.sequence), [1, 2, 3, 4, 5, 6]);
  const checkpoint = await popup.evaluate(() => chrome.storage.session.get('visitDelivery').then(saved => saved.visitDelivery));
  const list = async () => {
    const reply = await fetch(`${apiUrl.origin}/api/sessions/${sessionId}/visits?size=100`);
    assert.equal(reply.status, 200); return reply.json();
  };
  const beforeReplay = await list();
  assert.equal(beforeReplay.totalElements, 6);
  assert.equal(new Set(beforeReplay.items.map(visit => visit.visitId)).size, 6);
  assert.deepEqual(beforeReplay.items.map(visit => visit.sequence), [1, 2, 3, 4, 5, 6]);
  await checkDatabase();
  for (const entry of checkpoint.entries) {
    const { sessionId: _, ...body } = entry.visit;
    const replay = await fetch(`${apiUrl.origin}/api/sessions/${sessionId}/visits`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(replay.status, 200);
    const replayed = await replay.json();
    assert.equal(Object.entries({ ...entry.visit, updatedAt: null }).every(([key, value]) => replayed[key] === value), true, 'replay must match the stored original without printing payloads');
  }
  assert.deepEqual(await list(), beforeReplay, 'all replays leave the stored visit list unchanged');
  await checkDatabase();
  const cdp = await context.newCDPSession(page);
  await cdp.send('ServiceWorker.enable'); await cdp.send('ServiceWorker.stopAllWorkers'); await cdp.detach();
  const restored = await status();
  assert.deepEqual(restored.visitDelivery.visits, complete.visitDelivery.visits);
  assert.deepEqual(await list(), beforeReplay);
  // A test-only file lets a separate DB check verify counts without logging payloads.
  if (process.env.INTEGRATION_RESULT_PATH) await writeFile(process.env.INTEGRATION_RESULT_PATH, JSON.stringify({ sessionId, visits: 6, expectedWindows: 2 }));
  console.log(`PASS: Chrome ${context.browser()?.version() ?? 'Chromium'} → real Spring Boot: session creation, six collector visits, ordered ACK, six duplicate 200 replays, unchanged server list, worker ACK recovery`);
  console.log(process.env.INTEGRATION_MYSQL_CONTAINER
    ? 'PASS: real MySQL before/after duplicate replays: six unique visits, two unique Windows, [1,2,3,4,5] and [2,3,4,5,6]'
    : 'SKIP: DB Window contents/counts require INTEGRATION_MYSQL_CONTAINER (disposable MySQL with passwordless test root).');
} finally {
  await context?.close();
  await new Promise(resolve => fixture.close(resolve));
  await rm(root, { recursive: true, force: true });
}
