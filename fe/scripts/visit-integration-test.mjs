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
import { visitTestProxy } from './visit-test-proxy.mjs';

const api = process.env.INTEGRATION_API_BASE_URL;
assert.ok(api, 'Set INTEGRATION_API_BASE_URL to a disposable Spring Boot server');
const apiUrl = new URL(api);
assert.ok(['http:', 'https:'].includes(apiUrl.protocol));
const proxy = await visitTestProxy(apiUrl.origin);
const host = '127.0.0.1';
const fixture = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const content = req.url === '/empty' ? '짧음' : req.url === '/unicode/korean' ? '가'.repeat(5000)
    : req.url === '/unicode/english' ? 'a'.repeat(5000) : req.url === '/unicode/emoji' ? '😀'.repeat(2500)
    : req.url === '/unicode/overflow' ? '😀'.repeat(2501) : '서버 방문 저장을 확인하는 개인정보 없는 공개 합성 본문입니다. '.repeat(5);
  res.end('<!doctype html><title>공개 합성 방문 검증</title><article><p>' + content + '</p></article>');
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const origin = `http://${host}:${fixture.address().port}`;
const root = await mkdtemp(join(tmpdir(), 'focus-visit-integration-'));
let context;
try {
  process.env.VITE_API_BASE_URL = proxy.origin;
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
  async function until(check, allowFailure = false) {
    for (let i = 0; i < 150; i++) {
      const current = await status();
      assert.equal(current.visitDelivery.blocked, undefined);
      if (!allowFailure) assert.equal(current.visitDelivery.visits.some(visit => visit.phase === 'failed'), false, 'visit delivery must not fail');
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
  async function checkDatabase(id = sessionId, count = 6) {
    assert.match(id, /^[a-f0-9-]{36}$/);
    if (!process.env.INTEGRATION_MYSQL_CONTAINER) return;
    const sql = `SELECT COUNT(*), COUNT(DISTINCT visit_id), COUNT(DISTINCT sequence) FROM page_visit WHERE session_id='${id}';
      SELECT COUNT(*), COUNT(DISTINCT window_index), COUNT(DISTINCT end_visit_id) FROM analysis_window WHERE session_id='${id}';
      SELECT aw.window_index, GROUP_CONCAT(pv.sequence ORDER BY wv.position) FROM analysis_window aw
      JOIN window_visit wv ON wv.window_id=aw.window_id JOIN page_visit pv ON pv.visit_id=wv.visit_id
      WHERE aw.session_id='${id}' GROUP BY aw.window_index ORDER BY aw.window_index;`;
    const { stdout } = await promisify(execFile)('docker', ['exec', process.env.INTEGRATION_MYSQL_CONTAINER, 'mysql', '-uroot', '--batch', '--skip-column-names', 'focus_recovery', '-e', sql]);
    const windows = Math.max(0, count - 4);
    assert.deepEqual(stdout.trim().split('\n'), [`${count}\t${count}\t${count}`, `${windows}\t${windows}\t${windows}`,
      ...Array.from({ length: windows }, (_, index) => `${index + 1}\t${Array.from({ length: 5 }, (_, offset) => index + offset + 1).join(',')}`)]);
  }
  for (let count = 1; count <= 6; count++) {
    if (count > 1) await page.goto(`${origin}/document/${count}`);
    await page.bringToFront();
    await until(state => state.visits.length === count);
  }
  await page.goto(`${origin}/empty`);
  await until(state => state.visitDelivery.visits.length === 6 && state.visitDelivery.visits.every(visit => visit.phase === 'acked'));
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

  const readCheckpoint = () => popup.evaluate(() => chrome.storage.session.get('visitDelivery').then(saved => saved.visitDelivery));
  const allAck = count => until(state => state.visitDelivery.visits.length === count && state.visitDelivery.visits.every(visit => visit.phase === 'acked'));
  const visitList = async id => {
    const reply = await fetch(`${apiUrl.origin}/api/sessions/${id}/visits?size=100`);
    assert.equal(reply.status, 200); return reply.json();
  };
  async function begin(label) {
    await page.goto(`${origin}/empty`); await page.bringToFront();
    const reply = await request({ type: 'start', goalText: `공개 합성 방문 검증 ${label}` });
    assert.equal(reply.ok, true); return reply.status.session.sessionId;
  }
  async function collect(count, label) {
    for (let index = 1; index <= count; index++) {
      await page.goto(`${origin}/document/${label}/${index}`); await page.bringToFront();
      await until(state => state.visits.length === index);
    }
  }
  async function finish(count) {
    await page.goto(`${origin}/empty`); await allAck(count);
    assert.equal((await request({ type: 'stop' })).ok, true);
  }
  function sameRequest(record, visit) {
    const { sessionId: id, ...body } = visit;
    return record.sessionId === id && Object.keys(record.body).length === Object.keys(body).length
      && Object.entries(body).every(([key, value]) => record.body[key] === value);
  }
  async function deadline(promise) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Test gate timed out')), 15000); })]); }
    finally { clearTimeout(timer); }
  }
  async function restart() {
    const connection = await context.newCDPSession(page);
    try {
      const { targetInfos } = await connection.send('Target.getTargets');
      const target = targetInfos.find(target => target.type === 'service_worker' && target.url === worker.url());
      assert.ok(target, 'extension Worker target must exist before interruption');
      const result = await connection.send('Target.closeTarget', { targetId: target.targetId });
      assert.equal(result.success, true);
      for (let attempt = 0; attempt < 50; attempt++) {
        const current = await connection.send('Target.getTargets');
        if (!current.targetInfos.some(current => current.targetId === target.targetId)) return;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.fail('Extension Worker target was not terminated');
    } finally { await connection.detach(); }
  }

  // A-1: no explicit clear between six ACKed A visits and two B visits.
  const aRequests = proxy.requests.filter(record => record.sessionId === sessionId).length;
  const b = await begin('연속 세션 B'); assert.notEqual(b, sessionId);
  await collect(2, 'B'); await finish(2); await restart(); await allAck(2);
  assert.deepEqual((await readCheckpoint()).entries.map(entry => [entry.visit.sessionId, entry.sequence, entry.phase]), [[b, 1, 'acked'], [b, 2, 'acked']]);
  assert.equal(proxy.requests.filter(record => record.sessionId === sessionId).length, aRequests);
  assert.equal(proxy.requests.filter(record => record.sessionId === b).length, 2);
  assert.deepEqual((await visitList(b)).items.map(visit => visit.sequence), [1, 2]);
  assert.equal((await visitList(sessionId)).totalElements, 6);
  await checkDatabase(b, 2);
  console.log('PASS A-1: six ACKed A visits → local stop → B without clear, two B visits start at 1, Worker restart, no A resend or session mixing');

  // A-2/A-3: only transport 503 is injected; after retry the request reaches real BE.
  const failedSession = await begin('전송 실패 복구'); proxy.failVisits = true;
  await collect(1, 'failed'); await request({ type: 'stop' });
  await until(state => state.visitDelivery.visits[0]?.phase === 'failed', true);
  const failedCheckpoint = await readCheckpoint();
  assert.equal(failedCheckpoint.entries[0].attempts, 3);
  const sessionRequests = proxy.sessionRequests;
  const blocked = await request({ type: 'start', goalText: '미확인 상태에서 새 세션 시작 검증' });
  assert.equal(blocked.ok, false);
  assert.equal(proxy.sessionRequests, sessionRequests, 'blocked start must not call the session API');
  assert.ok(blocked.status.visitDelivery.visits[0].error);
  assert.equal(JSON.stringify(await readCheckpoint()) === JSON.stringify(failedCheckpoint), true, 'denied start must preserve the failed snapshot');
  assert.equal((await visitList(failedSession)).totalElements, 0);
  proxy.failVisits = false; await request({ type: 'retry-visits' }); await allAck(1);
  const retries = proxy.requests.filter(record => record.sessionId === failedSession);
  assert.equal(retries.length, 4);
  assert.equal(retries.every(record => sameRequest(record, failedCheckpoint.entries[0].visit)), true, 'all retries preserve original fields');
  const afterRetry = await begin('재시도 완료 후 새 세션'); await collect(2, 'after-retry'); await finish(2);
  await checkDatabase(failedSession, 1); await checkDatabase(afterRetry, 2);
  console.log('PASS A-2/A-3: injected transport 503 exhausts three attempts, new start blocked with intact snapshot, explicit retry stores in real BE, next session works');

  // B + C-1: real BE commits visit 5/Window 1, but its response cannot reach FE.
  const crashSession = await begin('저장 후 ACK 유실과 Worker 중단');
  let ackBeforeSix = false;
  proxy.onVisit = async record => {
    if (record.sessionId === crashSession && record.body.sequence === 6) {
      ackBeforeSix = (await readCheckpoint()).entries.find(entry => entry.sequence === 5)?.phase === 'acked';
    }
  };
  const committedPromise = proxy.holdNext(5);
  await collect(6, 'crash');
  const committed = await deadline(committedPromise);
  assert.equal(committed.record.status, 201); assert.equal(committed.record.delivered, false);
  await checkDatabase(crashSession, 5);
  assert.equal((await request({ type: 'stop' })).ok, true);
  const beforeCrash = await readCheckpoint();
  assert.deepEqual(beforeCrash.entries.map(entry => entry.phase), ['acked', 'acked', 'acked', 'acked', 'sending', 'queued']);
  assert.equal(proxy.requests.filter(record => record.sessionId === crashSession && record.body.sequence === 6).length, 0);
  await restart();
  assert.equal(JSON.stringify(await readCheckpoint()) === JSON.stringify(beforeCrash), true, 'Worker death before ACK must leave original checkpoint');
  committed.release();
  const recovered = await allAck(6);
  const crashRequests = proxy.requests.filter(record => record.sessionId === crashSession);
  const fifth = crashRequests.filter(record => record.body.sequence === 5);
  assert.deepEqual(fifth.map(record => record.status), [201, 200]);
  assert.equal(fifth.every(record => sameRequest(record, beforeCrash.entries[4].visit)), true, 'worker retry must keep exact request');
  assert.deepEqual(crashRequests.map(record => record.body.sequence), [1, 2, 3, 4, 5, 5, 6]);
  assert.equal(ackBeforeSix, true, 'visit 6 arrives only after persisted ACK for visit 5');
  assert.equal(recovered.session, null, 'local stop remains effective through recovery');
  assert.equal(recovered.readyVisits.every(visit => visit.sessionId === crashSession), true);
  assert.equal((await visitList(crashSession)).totalElements, 6); await checkDatabase(crashSession, 6);
  proxy.onVisit = async () => undefined;
  console.log('PASS B/C-1: real BE commits visit 5, response held, local stop queues visit 6, actual Worker target closed, identical retry 200, persisted ACK before visit 6, six server visits');
  console.log(process.env.INTEGRATION_MYSQL_CONTAINER
    ? 'PASS B SQL: five visits/one Window before interruption, six unique visits/two unique Windows after recovery, correct Window members'
    : 'SKIP B SQL: Window counts/members require INTEGRATION_MYSQL_CONTAINER');

  // C-2: a late real 201 must not resurrect explicitly deleted local records.
  const deletionSession = await begin('전송 중 로컬 기록 삭제');
  const latePromise = proxy.holdNext(1); await collect(2, 'deletion');
  const late = await deadline(latePromise); assert.equal(late.record.status, 201);
  await request({ type: 'stop' });
  await popup.reload();
  await popup.getByText(/로컬 기록 삭제는 저장·행동 갱신 미확인 요청도 버립니다/).waitFor();
  assert.equal((await request({ type: 'clear' })).ok, true);
  const responseFinished = context.waitForEvent('requestfinished', { predicate: request => request.url().includes(`/sessions/${deletionSession}/visits`), timeout: 10000 });
  late.release(); await responseFinished; await status(); await status();
  assert.equal((await readCheckpoint()).entries.length, 0);
  assert.equal((await status()).candidates.length, 0);
  assert.deepEqual(proxy.requests.filter(record => record.sessionId === deletionSession).map(record => record.body.sequence), [1]);
  assert.equal((await visitList(deletionSession)).totalElements, 1);
  await checkDatabase(deletionSession, 1);
  console.log('PASS C-2: explicit local clear, late real 201 received, checkpoint stays empty, queued visit 2 never sent, already committed server visit remains');

  // E + C-3: real extraction/API validation; no original is cut to fit Java @Size.
  for (const [label, codePoints, units, expected] of [['korean', 5000, 5000, 201], ['english', 5000, 5000, 201], ['emoji', 2500, 5000, 201], ['overflow', 2501, 5002, 400]]) {
    const unicodeSession = await begin(`Unicode ${label}`);
    await page.goto(`${origin}/unicode/${label}`); await page.bringToFront();
    await until(state => state.visits.length === 1);
    await request({ type: 'stop' });
    await until(state => state.visitDelivery.visits[0]?.phase === (expected === 400 ? 'failed' : 'acked'), true);
    const unicodeCheckpoint = await readCheckpoint(), original = unicodeCheckpoint.entries[0].visit;
    assert.equal([...original.content].length, codePoints); assert.equal(original.content.length, units);
    const requests = proxy.requests.filter(record => record.sessionId === unicodeSession);
    assert.equal(requests.length, 1); assert.equal(requests[0].status, expected);
    assert.equal((await visitList(unicodeSession)).totalElements, expected === 400 ? 0 : 1);
    assert.equal(sameRequest(requests[0], original), true);
    if (expected === 400) {
      assert.equal(unicodeCheckpoint.entries[0].retryable, false);
      await restart(); await request({ type: 'retry-visits' });
      assert.equal(JSON.stringify(await readCheckpoint()) === JSON.stringify(unicodeCheckpoint), true, 'failed original must survive restart and disallowed retry');
      await checkDatabase(unicodeSession, 0);
      await popup.reload();
      await popup.getByText(/로컬 기록 삭제는 저장·행동 갱신 미확인 요청도 버립니다/).waitFor();
      assert.equal((await request({ type: 'clear' })).ok, true);
      assert.equal((await readCheckpoint()).entries.length, 0);
    } else await checkDatabase(unicodeSession, 1);
  }
  console.log('PASS E/C-3: real BE accepts Korean/English 5000 units and emoji 2500 code points/5000 units; rejects emoji 2501 code points/5002 units with 400, keeps original through restart, deletes only on explicit clear');
} finally {
  await context?.close();
  await proxy.close();
  await new Promise(resolve => fixture.close(resolve));
  await rm(root, { recursive: true, force: true });
}
