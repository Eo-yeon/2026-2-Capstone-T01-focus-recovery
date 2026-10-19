// Opt-in live Naver → extension → disposable BE/MySQL test. Never prints sampled text.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { build } from 'vite';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readDurable } from './durable-test-utils.mjs';

const api = new URL(process.env.INTEGRATION_API_BASE_URL);
assert.ok(api.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(api.hostname) && !api.username && !api.password);
const container = process.env.INTEGRATION_MYSQL_CONTAINER;
assert.ok(container, 'An explicit disposable MySQL container is required');
const exec = promisify(execFile);
assert.equal((await exec('docker', ['inspect', container, '--format', '{{index .Config.Labels "focus-recovery.issue"}}'])).stdout.trim(), '60');
const sql = async query => (await exec('docker', ['exec', container, 'mysql', '-uroot', '--batch', '--skip-column-names', 'focus_recovery', '-e', query])).stdout.trim();
const hash = text => createHash('sha256').update(text).digest('hex');
const root = await mkdtemp(join(tmpdir(), 'focus-nav60-'));
let context, stage = 'setup', blocked = false;
try {
  process.env.VITE_API_BASE_URL = api.origin;
  const extension = join(root, 'extension');
  await build({ configFile: resolve('vite.config.ts'), build: { outDir: extension } });
  await build({ configFile: resolve('vite.content.config.ts'), build: { outDir: extension } });
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
  // Service extraction test only: this pre-grant is not evidence of user permission approval.
  manifest.host_permissions.push('https://search.naver.com/*');
  await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
  context = await chromium.launchPersistentContext(join(root, 'profile'), {
    channel: 'chromium', headless: !process.env.HEADED, executablePath: process.env.CHROMIUM_PATH || undefined,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  let [worker] = context.serviceWorkers(); worker ??= await context.waitForEvent('serviceworker');
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${worker.url().split('/')[2]}/popup.html`);
  const request = message => popup.evaluate(message => chrome.runtime.sendMessage(message), message);
  const status = async () => { const reply = await request({ type: 'status' }); assert.ok(reply.ok); return reply.status; };
  async function until(check) {
    for (let i = 0; i < 150; i++) {
      const state = await status(); if (check(state)) return state;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail('Timed out in the current test stage');
  }
  assert.ok((await request({ type: 'start', goalText: '공개 Naver 일반 검색 결과 저장 검증하기' })).ok);
  const sessionId = (await status()).session.sessionId;
  assert.match(sessionId, /^[a-f0-9-]{36}$/);
  // Catch an API/DB mismatch before collecting live search data.
  assert.equal(await sql(`SELECT COUNT(*) FROM work_session WHERE session_id='${sessionId}'`), '1');
  const page = await context.newPage();
  for (const [index, query] of ['Spring Boot JWT', '스프링 부트 인증'].entries()) {
    stage = `navigation-${index + 1}`;
    try {
      const response = await page.goto(`https://search.naver.com/search.naver?query=${encodeURIComponent(query)}&where=nexearch#results`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      blocked = !response?.ok() || new URL(page.url()).hostname !== 'search.naver.com' || new URL(page.url()).pathname !== '/search.naver';
      if (blocked) throw Error('Service access restricted');
    } catch (error) { blocked = true; throw error; }
    await page.bringToFront();
    stage = `extraction-${index + 1}`;
    const state = await until(s => s.visits.length === index + 1 && s.visits.at(-1).searchQuery === query);
    const visit = state.visits.at(-1);
    const snapshot = (await readDurable(popup, 'collection')).candidates.find(c => c.visitId === visit.visitId).snapshot;
    // Independent DOM pairing check; public text stays in memory, never in output/artifacts.
    const observed = await page.evaluate(() => ({
      title: document.title.trim(),
      entries: [...document.querySelectorAll('#main_pack .fds-web-root .fds-web-list-root > .fds-web-doc-root.fds-web-normal-doc-root')].flatMap(card => {
        const title = card.querySelector('a[href] .sds-comps-text-type-headline1');
        const snippet = card.querySelector('a[href] .sds-comps-text-type-body1');
        if (!title || !snippet || title.closest('a').href !== snippet.closest('a').href) return [];
        return [`제목: ${title.innerText.trim()}\n설명: ${snippet.innerText.trim()}`];
      }),
    }));
    assert.ok(visit.title === observed.title, 'document title matches');
    assert.equal(visit.normalizedUrl, 'https://search.naver.com/search.naver');
    assert.equal(visit.isSearchResultPage, true);
    const blocks = visit.content.split(/\n\n검색 결과 \d+\n/).slice(1);
    assert.equal(blocks.length, snapshot.organicResultCount);
    assert.ok(blocks.length > 0 && [...visit.content].length <= 5000);
    assert.ok(blocks.every((block, i) => observed.entries.some(expected => expected === block || i === blocks.length - 1 && [...visit.content].length === 5000 && expected.startsWith(block))), 'every collected title/snippet matches its own ordinary web card');
    await page.goto('about:blank');
    stage = `storage-${index + 1}`;
    await until(s => s.visitDelivery.visits.length === index + 1 && s.visitDelivery.visits.every(v => v.phase === 'acked'));
    const saved = (await readDurable(popup, 'visitDelivery')).entries.at(-1).visit;
    assert.equal(saved.sequence, index + 1);
    assert.match(saved.visitId, /^[a-f0-9-]{36}$/);
    assert.equal(await sql(`SELECT CONCAT(sequence,':',SHA2(normalized_url,256),':',SHA2(title,256),':',SHA2(content,256),':',SHA2(search_query,256),':',is_search_result_page) FROM page_visit WHERE session_id='${sessionId}' AND visit_id='${saved.visitId}'`), `${index + 1}:${hash(saved.normalizedUrl)}:${hash(saved.title)}:${hash(saved.content)}:${hash(query)}:1`);
    const { sessionId: _, ...body } = saved;
    const replay = await fetch(`${api.origin}/api/sessions/${sessionId}/visits`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(replay.status, 200);
    const response = await replay.json();
    assert.ok(response.content === saved.content && response.title === saved.title && response.searchQuery === query, 'exact original fields in idempotent replay');
    assert.equal(await sql(`SELECT COUNT(*) FROM page_visit WHERE session_id='${sessionId}'`), String(index + 1));
    console.log(JSON.stringify({ result: 'PASS', sample: index + 1, organicResultCount: snapshot.organicResultCount, contentCodePoints: [...saved.content].length, sequence: saved.sequence, sqlFieldsMatch: true, duplicateStatus: 200 }));
  }
  stage = 'empty-search';
  const response = await page.goto('https://search.naver.com/search.naver?query=focusrecovery60xyz20261019noresult', { waitUntil: 'domcontentloaded', timeout: 20000 });
  blocked = !response?.ok() || new URL(page.url()).pathname !== '/search.naver';
  if (blocked) throw Error('Service access restricted');
  await page.bringToFront();
  await until(s => s.candidates.at(-1)?.reason === 'unavailable-content');
  assert.equal((await status()).visits.length, 2);
  assert.equal(await sql(`SELECT COUNT(*) FROM page_visit WHERE session_id='${sessionId}'`), '2');
  stage = 'end';
  assert.ok((await request({ type: 'end-session' })).ok);
  const ended = await until(s => s.sessionEnd?.state === 'ENDED');
  assert.equal(await sql(`SELECT status FROM work_session WHERE session_id='${sessionId}'`), 'ENDED');
  assert.equal(await sql(`SELECT COUNT(*) FROM analysis_window WHERE session_id='${sessionId}'`), '0');
  for (const visit of ended.readyVisits) {
    assert.equal(await sql(`SELECT CONCAT(active_duration_ms,':',tab_switch_count,':',behavior_version) FROM page_visit WHERE session_id='${sessionId}' AND visit_id='${visit.visitId}'`), `${visit.activeDurationMs}:${visit.tabSwitchCount}:${visit.behaviorVersion}`);
  }
  console.log(JSON.stringify({ result: 'PASS', browser: context.browser().version(), emptySearchExcluded: true, uniqueVisits: 2, windowsBelowFive: 0, finalBehaviorSqlMatches: true, session: 'ENDED', userPermissionDialog: 'NOT_TESTED' }));
} catch (error) {
  console.error(JSON.stringify({ result: blocked ? 'BLOCKED' : 'FAIL', stage, errorType: error.name }));
  process.exitCode = 1;
} finally { await context?.close(); await rm(root, { recursive: true, force: true }); }
