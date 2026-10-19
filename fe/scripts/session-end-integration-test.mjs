import { readDurable } from './durable-test-utils.mjs';
// Real Chrome events → disposable Spring Boot/MySQL; only explicitly counted proxy 503 faults are injected.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { visitTestProxy } from './visit-test-proxy.mjs';

const api = process.env.INTEGRATION_API_BASE_URL;
assert.ok(api, 'Set INTEGRATION_API_BASE_URL to a disposable Spring Boot server');
assert.ok(process.env.INTEGRATION_MYSQL_CONTAINER, 'Set INTEGRATION_MYSQL_CONTAINER to the disposable DB container');
const proxy = await visitTestProxy(new URL(api).origin);
const fixture = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (req.url === '/pending') { res.end('<!doctype html><title>후보</title><article>짧은 합성 본문</article>'); return; }
  res.end('<!doctype html><title>공개 행동 검증</title><article><p>' + '개인정보 없는 행동 갱신 통합 검증용 합성 본문입니다. '.repeat(10) + '</p></article>');
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${fixture.address().port}`;
const root = await mkdtemp(join(tmpdir(), 'focus-end-integration-'));
let context;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function deadline(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Test gate timed out')), 15000); })]); }
  finally { clearTimeout(timer); }
}
try {
  process.env.VITE_API_BASE_URL = proxy.origin;
  const extension = join(root, 'extension');
  await build({ configFile: resolve('vite.config.ts'), build: { outDir: extension } });
  await build({ configFile: resolve('vite.content.config.ts'), build: { outDir: extension } });
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
  manifest.host_permissions.push('http://127.0.0.1/*');
  await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
  const launch = () => chromium.launchPersistentContext(join(root, 'profile'), {
    channel: 'chromium', headless: !process.env.HEADED, executablePath: process.env.CHROMIUM_PATH || undefined,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  context = await launch();
  async function enableDeveloperMode() {
    // A killed browser may not flush this profile preference; reload still enforces it.
    const settings = await context.newPage(); await settings.goto('chrome://extensions');
    const before = await settings.evaluate(() => chrome.developerPrivate.getProfileConfiguration());
    await settings.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
    assert.equal((await settings.evaluate(() => chrome.developerPrivate.getProfileConfiguration())).inDeveloperMode, true);
    if (!before.inDeveloperMode) console.log('TEST SETUP: enabled developer mode in this disposable browser profile');
    await settings.close();
  }
  await enableDeveloperMode();
  let [worker] = context.serviceWorkers(); worker ??= await context.waitForEvent('serviceworker');
  let popup = await context.newPage();
  await popup.goto(`chrome-extension://${worker.url().split('/')[2]}/popup.html`);
  const request = value => popup.evaluate(value => chrome.runtime.sendMessage(value), value);
  const status = async () => { const reply = await request({ type: 'status' }); assert.equal(reply.ok, true); return reply.status; };
  async function until(check, allowFailure = false) {
    for (let n = 0; n < 150; n++) {
      const state = await status(); assert.equal(state.visitDelivery.blocked, undefined); assert.equal(state.behaviorDelivery.blocked, undefined);
      if (!allowFailure) assert.equal(state.behaviorDelivery.visits.some(e => e.phase === 'failed'), false, 'behavior delivery must not fail');
      if (check(state)) return state;
      await wait(100);
    }
    assert.fail('Timed out waiting for session end state');
  }
  async function restart(mode = 'worker') {
    if (mode === 'browser') {
      const browser = context.browser();
      const connection = await browser.newBrowserCDPSession();
      const { processInfo } = await connection.send('SystemInfo.getProcessInfo');
      const browserProcess = processInfo.find(info => info.type === 'browser'); assert.ok(browserProcess?.id > 0);
      const disconnected = new Promise(resolve => browser.once('disconnected', resolve));
      // Terminate only this disposable browser's own PID, before graceful tab-close events can flush.
      process.kill(browserProcess.id, 'SIGKILL');
      await deadline(disconnected); await context.close().catch(() => undefined);
      assert.equal(browser.isConnected(), false, 'the complete persistent browser process exited');
      context = await launch();
      await enableDeveloperMode();
      [worker] = context.serviceWorkers(); worker ??= await context.waitForEvent('serviceworker');
      popup = await context.newPage();
      await popup.goto(`chrome-extension://${worker.url().split('/')[2]}/popup.html`);
      return;
    }
    if (mode === 'reload') {
      const url = popup.url();
      await popup.evaluate(() => chrome.storage.session.set({ durableTestReloadMarker: true }));
      await popup.evaluate(() => chrome.runtime.reload()).catch(() => undefined);
      await wait(300);
      for (let n = 0; n < 30; n++) {
        popup = await context.newPage();
        try {
          await popup.goto(url);
          assert.equal((await request({ type: 'status' })).ok, true);
          const marker = await popup.evaluate(() => chrome.storage.session.get('durableTestReloadMarker'));
          assert.equal(marker.durableTestReloadMarker, undefined, 'actual reload clears storage.session');
          worker = context.serviceWorkers().find(candidate => candidate.url().includes('/background.js'));
          assert.ok(worker); return;
        } catch { await popup.close().catch(() => undefined); await wait(100); }
      }
      throw Error('Extension reload did not restore popup and clear the session marker');
    }
    const connection = await context.newCDPSession(popup);
    try {
      const { targetInfos } = await connection.send('Target.getTargets');
      const target = targetInfos.find(t => t.type === 'service_worker' && t.url === worker.url()); assert.ok(target);
      assert.equal((await connection.send('Target.closeTarget', { targetId: target.targetId })).success, true);
      for (let n = 0; n < 50; n++) {
        if (!(await connection.send('Target.getTargets')).targetInfos.some(t => t.targetId === target.targetId)) return;
        await wait(100);
      }
      assert.fail('Worker target was not terminated');
    } finally { await connection.detach(); }
  }
  async function sql(sessionId) {
    assert.match(sessionId, /^[a-f0-9-]{36}$/i);
    const { stdout } = await promisify(execFile)('docker', ['exec', process.env.INTEGRATION_MYSQL_CONTAINER, 'mysql', '-uroot', '--batch', '--skip-column-names', 'focus_recovery', '-e',
      `SELECT status,COALESCE(DATE_FORMAT(ended_at,'%Y-%m-%dT%H:%i:%s.%fZ'),'NULL') FROM work_session WHERE session_id='${sessionId}'; SELECT COUNT(*) FROM page_visit WHERE session_id='${sessionId}'; SELECT COUNT(*) FROM analysis_window WHERE session_id='${sessionId}';`]);
    return stdout.trim().split('\n');
  }
  for (const mode of ['normal', 'worker', 'browser', 'reload']) {
    const page = await context.newPage(); await page.goto(`${origin}/first`); await page.bringToFront();
    const started = await request({ type: 'start', goalText: '개인정보 없는 종료 영속 복구 통합 검증하기' }); assert.equal(started.ok, true);
    const sessionId = started.status.session.sessionId;
    const patchHold = proxy.holdNextBehavior();
    const postHold = proxy.holdNext(1);
    await until(s => s.visits.some(v => v.activeDurationMs >= 1500));
    await page.close();
    const post = await deadline(postHold);
    const patchTab = await context.newPage(); await patchTab.goto(`${origin}/second`); await patchTab.bringToFront();
    await until(s => s.readyVisits[0]?.tabSwitchCount > post.record.body.tabSwitchCount);
    for (let n = 2; n <= 6; n++) {
      await patchTab.goto(`${origin}/visit-${n}`); await patchTab.bringToFront();
      await until(s => s.visits.some(v => v.normalizedUrl === `${origin}/visit-${n}` && v.activeDurationMs >= 1100));
    }
    await patchTab.close();
    const pending = await request({ type: 'end-session' }); assert.equal(pending.ok, true);
    assert.equal(pending.status.session, null); assert.equal(pending.status.sessionEnd.state, 'END_PENDING');
    assert.equal(proxy.endRequests.filter(r => r.sessionId === sessionId).length, 0, 'no END before POST ACK');
    assert.equal((await request({ type: 'start', goalText: '종료 중 새 세션 생성은 차단됩니다' })).ok, false);
    post.release(); const patch = await deadline(patchHold);
    await until(s => s.visitDelivery.visits.every(e => e.phase === 'acked'));
    assert.equal(proxy.endRequests.filter(r => r.sessionId === sessionId).length, 0, 'no END before final PATCH ACK');
    const endHold = mode === 'normal' ? undefined : proxy.holdNextEnd();
    patch.release();
    if (endHold) {
      const committedEnd = await deadline(endHold); assert.equal(committedEnd.record.status, 200); assert.equal(committedEnd.record.delivered, false);
      assert.equal(committedEnd.record.response.status, 'ENDED');
      assert.equal((await readDurable(popup, 'sessionEnd')).phase, 'sending');
      assert.ok((await sql(sessionId))[0].startsWith('ENDED\t'));
      await restart(mode); committedEnd.release();
    }
    const done = await until(s => s.sessionEnd?.state === 'ENDED');
    assert.equal(done.session, null); assert.ok(done.sessionEnd.ack.endedAt);
    const durable = await readDurable(popup); assert.equal(durable.value.sessionEnd.phase, 'acked');
    assert.deepEqual(durable.value.sessionEnd.request, {});
    const records = proxy.endRequests.filter(r => r.sessionId === sessionId);
    assert.equal(records.length, mode === 'normal' ? 1 : 2); assert.ok(records.every(r => JSON.stringify(r.body) === '{}'));
    assert.ok(records.every(r => r.response.endedAt === done.sessionEnd.ack.endedAt));
    const rows = await sql(sessionId); assert.ok(rows[0].startsWith('ENDED\t')); assert.equal(Number(rows[1]), done.readyVisits.length);
    assert.equal(Number(rows[2]), Math.max(0, done.readyVisits.length - 4));
    const queried = await fetch(`${api}/api/sessions/${sessionId}`).then(r => r.json()); assert.equal(queried.endedAt, done.sessionEnd.ack.endedAt);
    const first = durable.value.visitDelivery.entries[0].visit;
    const newVisit = { ...first, visitId: crypto.randomUUID(), sequence: first.sequence + 100 }; delete newVisit.sessionId;
    const rejectedPost = await fetch(`${api}/api/sessions/${sessionId}/visits`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newVisit) });
    assert.equal(rejectedPost.status, 409); assert.equal((await rejectedPost.json()).code, 'SESSION_ENDED');
    const rejectedPatch = await fetch(`${api}/api/sessions/${sessionId}/visits/${first.visitId}/behavior`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ activeDurationMs: first.activeDurationMs + 1000, tabSwitchCount: first.tabSwitchCount, behaviorVersion: first.behaviorVersion + 10 }) });
    assert.equal(rejectedPatch.status, 409); assert.equal((await rejectedPatch.json()).code, 'SESSION_ENDED');
    const counts = [proxy.requests.length, proxy.behaviorRequests.length, proxy.endRequests.length];
    const after = await context.newPage(); await after.goto(`${origin}/after-end`); await after.bringToFront(); await wait(1200); await status(); await after.close(); await status();
    assert.deepEqual([proxy.requests.length, proxy.behaviorRequests.length, proxy.endRequests.length], counts, 'no delivery after durable END ACK');
    assert.deepEqual(await sql(sessionId), rows, 'no duplicate visits/windows or updated endedAt');
    await popup.reload(); await popup.getByText(/종료 ACK 저장 완료/).waitFor();
    console.log(`PASS END-${mode}: real Chrome → POST/PATCH ACK gates → END → SQL ENDED/endedAt, ${done.readyVisits.length} visits/${rows[2]} windows; ${records.length} identical END request(s); original endedAt, real post-end POST/PATCH 409, no new delivery`);
    await request({ type: 'clear' });
  }
} finally {
  await context?.close(); await proxy.close(); await new Promise(resolve => fixture.close(resolve)); await rm(root, { recursive: true, force: true });
}
