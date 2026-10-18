// Real Chrome events and HTTP → disposable Spring Boot/MySQL. No collector or API mocks.
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
const fixture = createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end('<!doctype html><title>공개 행동 검증</title><article><p>' + '개인정보 없는 행동 갱신 통합 검증용 합성 본문입니다. '.repeat(10) + '</p></article>');
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${fixture.address().port}`;
const root = await mkdtemp(join(tmpdir(), 'focus-behavior-integration-'));
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
  context = await chromium.launchPersistentContext(join(root, 'profile'), {
    channel: 'chromium', headless: !process.env.HEADED, executablePath: process.env.CHROMIUM_PATH || undefined,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  let [worker] = context.serviceWorkers(); worker ??= await context.waitForEvent('serviceworker');
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${worker.url().split('/')[2]}/popup.html`);
  const request = value => popup.evaluate(value => chrome.runtime.sendMessage(value), value);
  const status = async () => { const reply = await request({ type: 'status' }); assert.equal(reply.ok, true); return reply.status; };
  async function until(check) {
    for (let n = 0; n < 150; n++) {
      const state = await status(); assert.equal(state.visitDelivery.blocked, undefined); assert.equal(state.behaviorDelivery.blocked, undefined);
      assert.equal(state.behaviorDelivery.visits.some(e => e.phase === 'failed'), false, 'behavior delivery must not fail');
      if (check(state)) return state;
      await wait(100);
    }
    assert.fail('Timed out waiting for behavior state');
  }
  async function db(visitId) {
    assert.match(visitId, /^[a-f0-9-]{36}$/i);
    const { stdout } = await promisify(execFile)('docker', ['exec', process.env.INTEGRATION_MYSQL_CONTAINER, 'mysql', '-uroot', '--batch', '--skip-column-names', 'focus_recovery', '-e',
      `SELECT active_duration_ms,tab_switch_count,behavior_version,COALESCE(CAST(updated_at AS CHAR),'NULL') FROM page_visit WHERE visit_id='${visitId}';`]);
    const [duration, count, version, updatedAt] = stdout.trim().split('\t');
    return { activeDurationMs: Number(duration), tabSwitchCount: Number(count), behaviorVersion: Number(version), updatedAt };
  }
  const values = v => ({ activeDurationMs: v.activeDurationMs, tabSwitchCount: v.tabSwitchCount, behaviorVersion: v.behaviorVersion });
  async function patch(sessionId, visitId, body) {
    const response = await fetch(`${api}/api/sessions/${sessionId}/visits/${visitId}/behavior`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  async function restart() {
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
  for (const holdPost of [false, true]) {
    // Chrome's tab removal and replacement activation can finalize A before its switch count arrives.
    const a = await context.newPage(); await a.goto(`${origin}/a`); await a.bringToFront();
    const started = await request({ type: 'start', goalText: '공개 합성 문서의 행동 누적값 통합 검증하기' }); assert.equal(started.ok, true);
    const sessionId = started.status.session.sessionId;
    const valid = await until(s => s.visits.some(v => v.normalizedUrl === `${origin}/a` && v.activeDurationMs >= 1500));
    const visitId = valid.visits.find(v => v.normalizedUrl === `${origin}/a`).visitId;
    const heldPatch = proxy.holdNextBehavior(visitId);
    const postHold = holdPost ? proxy.holdNext(1) : undefined;
    await a.close();
    await until(s => s.visitDelivery.visits.length >= 1);
    const committed = postHold ? await deadline(postHold) : undefined;
    if (!holdPost) await until(s => s.visitDelivery.visits[0].phase === 'acked');
    const post = proxy.requests.find(r => r.sessionId === sessionId && r.body.sequence === 1); assert.ok(post);
    assert.ok(post.body.activeDurationMs >= 1500);
    await until(s => s.readyVisits[0]?.tabSwitchCount > post.body.tabSwitchCount);
    if (holdPost) {
      assert.equal(proxy.behaviorRequests.filter(r => r.sessionId === sessionId).length, 0, 'no PATCH before POST ACK');
      committed.release();
    }
    const patchHold = await deadline(heldPatch);
    assert.equal(patchHold.record.status, 200); assert.equal(patchHold.record.response.applied, true); assert.equal(patchHold.record.delivered, false);
    assert.deepEqual(Object.keys(patchHold.record.body).sort(), ['activeDurationMs', 'behaviorVersion', 'tabSwitchCount']);
    assert.ok(patchHold.record.body.tabSwitchCount > post.body.tabSwitchCount);
    assert.ok(patchHold.record.body.behaviorVersion > post.body.behaviorVersion);
    assert.deepEqual(values(await db(visitId)), patchHold.record.body);
    assert.equal((await request({ type: 'stop' })).ok, true);
    assert.equal((await request({ type: 'start', goalText: '미확인 행동 갱신 중 신규 세션' })).ok, false);
    await restart();
    patchHold.release();
    const done = await until(s => s.behaviorDelivery.visits.every(e => e.phase === 'acked'));
    assert.equal(done.session, null);
    const attempts = proxy.behaviorRequests.filter(r => r.visitId === visitId);
    assert.equal(attempts.length, 2); assert.deepEqual(attempts.map(r => r.body), [patchHold.record.body, patchHold.record.body]);
    assert.deepEqual(attempts.map(r => r.response.applied), [true, false]);
    const stored = await db(visitId), entry = done.behaviorDelivery.visits.find(e => e.visitId === visitId);
    assert.deepEqual(values(stored), entry.ack); assert.deepEqual(entry.ack, entry.latest);
    const duplicate = await patch(sessionId, visitId, entry.ack); assert.equal(duplicate.status, 200); assert.equal(duplicate.body.applied, false);
    assert.deepEqual(await db(visitId), stored, 'duplicate does not change counters/version/updated_at');
    const stale = await patch(sessionId, visitId, values(post.body)); assert.equal(stale.status, 200); assert.equal(stale.body.applied, false);
    assert.deepEqual(values(stale.body), entry.ack); assert.deepEqual(await db(visitId), stored);
    const versionConflict = await patch(sessionId, visitId, { ...entry.ack, tabSwitchCount: entry.ack.tabSwitchCount + 1 });
    assert.equal(versionConflict.status, 409); assert.equal(versionConflict.body.code, 'BEHAVIOR_VERSION_CONFLICT');
    const decrease = await patch(sessionId, visitId, { ...entry.ack, behaviorVersion: entry.ack.behaviorVersion + 1, activeDurationMs: entry.ack.activeDurationMs - 1 });
    assert.equal(decrease.status, 409); assert.equal(decrease.body.code, 'BEHAVIOR_COUNTER_DECREASED');
    assert.deepEqual(await db(visitId), stored);
    await restart(); assert.deepEqual((await status()).behaviorDelivery.visits.find(e => e.visitId === visitId).ack, entry.ack);
    console.log(`PASS ${holdPost ? 'held POST ACK' : 'normal POST ACK'}: real Chrome dwell/tab close/replacement activation → POST ACK → PATCH; MySQL counters/version; committed PATCH response loss + Worker restart identical replay applied=false; final local stop ACK; duplicate/stale preserve DB; real 409 codes; ACK recovery`);
  }
} finally {
  await context?.close(); await proxy.close(); await new Promise(resolve => fixture.close(resolve)); await rm(root, { recursive: true, force: true });
}
