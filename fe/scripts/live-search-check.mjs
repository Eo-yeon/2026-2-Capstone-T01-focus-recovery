// Opt-in live-service probe. Uses a temporary profile; prints counts/flags only.
import { chromium } from 'playwright';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const root = await mkdtemp(join(tmpdir(), 'focus-recovery-live-'));
let context;
try {
  const extension = join(root, 'extension');
  await cp(resolve('dist'), extension, { recursive: true });
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
  manifest.host_permissions = ['https://www.google.com/*', 'https://search.naver.com/*'];
  await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
  context = await chromium.launchPersistentContext(join(root, 'profile'), {
    channel: 'chromium', headless: !process.env.HEADED, executablePath: process.env.CHROMIUM_PATH || undefined,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  let [worker] = context.serviceWorkers(); worker ??= await context.waitForEvent('serviceworker');
  const popup = await context.newPage(); await popup.goto(`chrome-extension://${worker.url().split('/')[2]}/popup.html`);
  await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'start', goalText: '공개 검색 동작 검증하기' }));
  const page = await context.newPage();
  const status = () => popup.evaluate(() => chrome.runtime.sendMessage({ type: 'status' })).then(reply => reply.status);
  async function inspect(label, expectedQuery) {
    await page.bringToFront();
    let state;
    for (let i = 0; i < 45; i++) {
      state = await status();
      const last = state.candidates.at(-1);
      const current = state.visits.find(v => v.visitId === last?.visitId);
      if ((last?.state === 'valid' && current?.searchQuery === expectedQuery) || last?.state === 'excluded') break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    const last = state.candidates.at(-1);
    const visit = state.visits.find(v => v.visitId === last?.visitId);
    const advertisingContainers = await page.evaluate(() => document.querySelectorAll('#power_link,.ad_section,[data-ad],#tads,#tadsb').length);
    const evidence = await popup.evaluate(() => chrome.storage.session.get('collection'));
    const candidate = evidence.collection.candidates.find(c => c.visitId === last?.visitId);
    console.log(JSON.stringify({ label, state: last?.state, reason: last?.reason, supportedLocation: /^(www\.google\.com|search\.naver\.com)$/.test(new URL(page.url()).hostname) && ['/search', '/search.naver'].includes(new URL(page.url()).pathname), queryMatches: visit ? visit.searchQuery === expectedQuery : false, advertisingContainers, organicResultCount: candidate?.snapshot?.organicResultCount ?? 0, contentLength: visit ? [...visit.content].length : 0 }));
    return visit;
  }
  for (const [label, base, parameter, query] of [
    ['Google English', 'https://www.google.com/search', 'q', 'Spring Boot JWT'],
    ['Google Korean', 'https://www.google.com/search', 'q', '스프링 부트 인증'],
    ['Naver English', 'https://search.naver.com/search.naver', 'query', 'Spring Boot JWT'],
    ['Naver Korean', 'https://search.naver.com/search.naver', 'query', '스프링 부트 인증'],
    ['Naver ad sample', 'https://search.naver.com/search.naver', 'query', '노트북'],
    ['Naver rare query', 'https://search.naver.com/search.naver', 'query', 'focusrecoveryfe007xyz20261014nocontent'],
  ]) {
    try {
      const response = await page.goto(`${base}?${parameter}=${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      console.log(JSON.stringify({ label, httpStatus: response?.status() }));
      const visit = await inspect(label, query);
      if (label === 'Naver Korean' && visit) {
        await page.goBack({ waitUntil: 'domcontentloaded' });
        const back = await inspect('Naver back', 'Spring Boot JWT');
        console.log(JSON.stringify({ label: 'Naver back identity', newVisit: !!back && back.visitId !== visit.visitId }));
        await page.goForward({ waitUntil: 'domcontentloaded' });
        const forward = await inspect('Naver forward', query);
        console.log(JSON.stringify({ label: 'Naver forward identity', newVisit: !!forward && forward.visitId !== visit.visitId }));
      }
      if (label === 'Naver English' && visit) {
        await page.reload({ waitUntil: 'domcontentloaded' });
        const reloaded = await inspect('Naver reload', query);
        console.log(JSON.stringify({ label: 'Naver reload identity', idReused: reloaded?.visitId === visit.visitId, sequenceReused: reloaded?.sequence === visit.sequence }));
      }
    } catch { console.log(JSON.stringify({ label, navigationFailed: true })); }
  }
  console.log(JSON.stringify({ browserVersion: context.browser()?.version() }));
} finally { await context?.close(); await rm(root, { recursive: true, force: true }); }
