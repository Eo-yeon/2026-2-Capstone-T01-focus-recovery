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
  async function until(check, allowFailure = false) {
    for (let n = 0; n < 150; n++) {
      const state = await status(); assert.equal(state.visitDelivery.blocked, undefined); assert.equal(state.behaviorDelivery.blocked, undefined);
      if (!allowFailure) assert.equal(state.behaviorDelivery.visits.some(e => e.phase === 'failed'), false, 'behavior delivery must not fail');
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
  for (const { label, holdPost, failures, interruptions } of [
    { label: 'B-1 normal POST ACK', holdPost: false, failures: 0, interruptions: 1 },
    { label: 'B-1 held POST ACK', holdPost: true, failures: 0, interruptions: 1 },
    { label: 'B-2 third attempt interruption', holdPost: false, failures: 2, interruptions: 1 },
    { label: 'B-3 repeated interruptions', holdPost: false, failures: 0, interruptions: 3 },
  ]) {
    proxy.failBehaviors = failures;
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
      assert.equal((await db(visitId)).updatedAt, 'NULL');
      for (const version of [post.body.behaviorVersion, post.body.behaviorVersion - 1]) {
        const initialReplay = await patch(sessionId, visitId, { ...values(post.body), behaviorVersion: version });
        assert.equal(initialReplay.status, 200); assert.equal(initialReplay.body.applied, false);
        assert.equal(initialReplay.body.updatedAt, null, 'initial POST can have null time even when returning a higher version');
        assert.deepEqual(values(initialReplay.body), values(post.body));
      }
      committed.release();
    }
    let patchHold = await deadline(heldPatch);
    assert.equal(patchHold.record.status, 200); assert.equal(patchHold.record.response.applied, true); assert.equal(patchHold.record.delivered, false);
    assert.deepEqual(Object.keys(patchHold.record.body).sort(), ['activeDurationMs', 'behaviorVersion', 'tabSwitchCount']);
    assert.ok(patchHold.record.body.tabSwitchCount > post.body.tabSwitchCount);
    assert.ok(patchHold.record.body.behaviorVersion > post.body.behaviorVersion);
    assert.deepEqual(values(await db(visitId)), patchHold.record.body);
    assert.equal((await request({ type: 'stop' })).ok, true);
    assert.equal((await request({ type: 'start', goalText: '미확인 행동 갱신 중 신규 세션' })).ok, false);
    const firstSnapshot = structuredClone(patchHold.record.body), committedState = await db(visitId);
    const firstAttempt = failures + 1;
    for (let interrupt = 0; interrupt < interruptions; interrupt++) {
      const expectedAttempt = firstAttempt + interrupt;
      const saved = await popup.evaluate(() => chrome.storage.session.get('behaviorDelivery').then(s => s.behaviorDelivery));
      const current = saved.entries.find(e => e.visitId === visitId);
      assert.equal(current.phase, 'sending'); assert.equal(current.attempts, expectedAttempt);
      assert.deepEqual(current.request, firstSnapshot);
      const holdAgain = interrupt + 1 < interruptions ? proxy.holdNextBehavior(visitId) : undefined;
      await restart(); patchHold.release();
      if (holdAgain) {
        await status();
        patchHold = await deadline(holdAgain);
        assert.equal(patchHold.record.response.applied, false);
        assert.deepEqual(await db(visitId), committedState);
      }
    }
    const exhausted = firstAttempt + interruptions - 1 >= 3;
    if (exhausted) {
      const failed = await until(s => s.behaviorDelivery.visits[0]?.phase === 'failed', true);
      assert.equal(failed.behaviorDelivery.visits[0].attempts, 3);
      assert.equal(failed.behaviorDelivery.visits[0].retryable, true);
      assert.match(failed.behaviorDelivery.visits[0].error, /서버에 반영되었을 수/);
      assert.deepEqual(failed.behaviorDelivery.visits[0].request, firstSnapshot);
      const attemptsBefore = proxy.behaviorRequests.filter(r => r.visitId === visitId).length;
      assert.equal(attemptsBefore, 3);
      for (let repeat = 0; repeat < 2; repeat++) {
        await restart(); await status(); await wait(1100); await status();
      }
      assert.equal(proxy.behaviorRequests.filter(r => r.visitId === visitId).length, attemptsBefore, 'no extra automatic requests after budget exhaustion');
      assert.equal((await request({ type: 'start', goalText: '예산 소진 후 새 세션 차단' })).ok, false);
      await popup.reload();
      await popup.getByRole('button', { name: '같은 행동 갱신 재시도', exact: true }).waitFor();
      assert.equal(await popup.getByRole('button', { name: '같은 행동 갱신 재시도', exact: true }).isEnabled(), true);
      await popup.getByText(/마지막 요청은 서버에 반영되었을 수 있습니다/).waitFor();
      await popup.getByRole('button', { name: '같은 행동 갱신 재시도', exact: true }).click();
    }
    const done = await until(s => s.behaviorDelivery.visits.every(e => e.phase === 'acked'));
    assert.equal(done.session, null);
    const attempts = proxy.behaviorRequests.filter(r => r.visitId === visitId);
    assert.equal(attempts.length, exhausted ? 4 : 2);
    assert.equal(attempts.every(r => JSON.stringify(r.body) === JSON.stringify(firstSnapshot)), true, 'all attempts preserve the original snapshot');
    const realAttempts = attempts.filter(r => !r.injected);
    assert.equal(attempts.filter(r => r.injected).length, failures);
    assert.deepEqual(realAttempts.map(r => r.response.applied), [true, ...Array(realAttempts.length - 1).fill(false)]);
    for (const record of realAttempts) assert.match(record.response.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.deepEqual(await db(visitId), committedState, 'replay and manual retry never update the already committed behavior/time');
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
    console.log(`PASS ${label}: real Chrome → POST ACK → PATCH/SQL; ${failures} injected 503 failures, ${interruptions} actual Worker interruption(s); preserved attempts/snapshot, ${exhausted ? 'automatic budget stops at 3, two more restarts send nothing, explicit retry' : 'automatic identical replay'}; no duplicate DB/time updates; final ACK; real 409/stale contract`);
  }
} finally {
  await context?.close(); await proxy.close(); await new Promise(resolve => fixture.close(resolve)); await rm(root, { recursive: true, force: true });
}
