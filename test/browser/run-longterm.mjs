// A year of use, end to end.
//
// Every other suite asks whether a thing works. This one asks what a year of
// doing it does to the archive: both caps actually biting, the browser closed
// and opened again, the worker stopped in the middle of a sweep, a search
// typed while pages are being deleted underneath it, and then sixty ordinary
// days in a row, because a slow leak in the index only shows up in the state
// a real archive spends its life in.
//
//   npm install --no-save playwright
//   node test/browser/run-longterm.mjs [pageCount]

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { invariantCheck } from './invariants.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TOTAL = Number(process.argv[2] || 4000);
const DAYS = Number(process.argv[3] || 60);
const MONTH = 30 * 24 * 60 * 60 * 1000;

const profile = await mkdtemp(path.join(tmpdir(), 'sm-longterm-'));
const launch = () =>
  chromium.launchPersistentContext(profile, {
    headless: false,
    viewport: { width: 1000, height: 760 },
    args: ['--disable-extensions-except=' + root, '--load-extension=' + root, '--no-sandbox'],
  });

let context = await launch();
let worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
let extensionId = new URL(worker.url()).host;

const checks = [];
const errors = [];
const notes = [];

const check = (name, condition, detail) => {
  const result = { name, ok: !!condition, detail: condition ? '' : String(detail) };
  checks.push(result);
  console.log(result.ok ? '  ok   ' + name : '  FAIL ' + name + '\n       ' + result.detail);
  return result.ok;
};
const note = (text) => {
  notes.push(text);
  console.log('  note  ' + text);
};
const phase = (title) => console.log('\n--- ' + title + ' ' + '-'.repeat(Math.max(0, 62 - title.length)));

async function driverPage() {
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(String(error)));
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      await page.goto('chrome-extension://' + extensionId + '/src/ui/options/options.html');
      return page;
    } catch (error) {
      if (attempt === 11) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  return page;
}

const ask = (page, type, payload) =>
  page.evaluate(
    async ({ t, p }) => {
      const { MSG } = await import('/src/shared/messages.js');
      return chrome.runtime.sendMessage({ type: MSG[t], payload: p });
    },
    { t: type, p: payload }
  );

// Seeding goes through the real import path, which is the only way in that
// can set firstSeen and lastSeen. A year of history cannot be captured in
// real time, and backdating the records directly would test a database this
// extension never actually writes.
const seed = (page, spec) =>
  page.evaluate(async ({ from, count, spread, pinnedEvery, batch, tag }) => {
    const { MSG } = await import('/src/shared/messages.js');
    const vocabulary = (
      'retro fatigue cohort churn standup retention index eviction budget posting bucket worker ' +
      'fragment quote passage relevance snippet extraction permission migration transaction cursor ' +
      'archive browser history tokenizer morphology ranking corpus latency throughput invariant'
    ).split(' ');

    let seedValue = 99991 + from;
    const random = () => {
      seedValue = (seedValue * 1103515245 + 12345) % 2147483648;
      return seedValue / 2147483648;
    };

    const started = Date.now();
    let imported = 0;
    let failed = 0;
    let pending = [];

    const flush = async () => {
      if (!pending.length) return;
      const result = await chrome.runtime.sendMessage({ type: MSG.IMPORT, payload: { pages: pending } });
      imported += (result && result.imported) || 0;
      failed += (result && result.failed) || 0;
      pending = [];
    };

    for (let i = 0; i < count; i++) {
      const n = from + i;
      const words = [];
      // 340 tokens, which is closer to a real page than the benchmark corpus.
      for (let w = 0; w < 340; w++) words.push(vocabulary[Math.floor(random() * vocabulary.length)]);
      // One term unique to this page, so a known-item search has something to
      // find that no other page contains.
      words[Math.floor(random() * 300)] = 'needle' + n;
      const when = spread.end - Math.floor(random() * (spread.end - spread.start));
      pending.push({
        url: 'https://' + tag + (n % 40) + '.example/article-' + n,
        title: 'Article ' + n + ' about ' + vocabulary[n % vocabulary.length],
        text: words.join(' ') + '.',
        firstSeen: new Date(when).toISOString(),
        lastSeen: new Date(when).toISOString(),
        visitCount: 1 + Math.floor(random() * 4),
        pinned: pinnedEvery > 0 && n % pinnedEvery === 0,
      });
      if (pending.length >= batch) await flush();
    }
    await flush();
    return { imported, failed, ms: Date.now() - started };
  }, spec);

const deepInvariants = (page) => page.evaluate(invariantCheck, { deep: true });
const fastInvariants = (page) => page.evaluate(invariantCheck, { deep: false });

let driver = await driverPage();
await ask(driver, 'SETTINGS_SET', { setupComplete: true, mode: 'broad' });

// ---------------------------------------------------------------------------
phase('fourteen months of reading');

const now = Date.now();
const seeded = await seed(driver, {
  from: 0,
  count: TOTAL,
  spread: { start: now - 14 * MONTH, end: now - 1 * MONTH },
  pinnedEvery: 200,
  batch: 50,
  tag: 'site',
});
note(seeded.imported + ' pages imported in ' + Math.round(seeded.ms / 1000) + 's (' +
  (seeded.ms / Math.max(1, seeded.imported)).toFixed(1) + 'ms each)');
check('a year of pages all arrive', seeded.imported === TOTAL && seeded.failed === 0,
  JSON.stringify(seeded));

let stats = await ask(driver, 'STATS');
check('the archive counts what was put in it', stats.docCount === TOTAL, stats.docCount);
check('and knows how big it is', stats.usedBytes > 0, stats.usedBytes);
note('archive is ' + (stats.usedBytes / 1048576).toFixed(1) + 'MB, ' +
  Math.round(stats.usedBytes / stats.docCount) + ' bytes per page');

const firstInvariants = await deepInvariants(driver);
check('the index is consistent after a year of writing',
  firstInvariants.problems.length === 0, JSON.stringify(firstInvariants.problems));

// ---------------------------------------------------------------------------
phase('an hourly sweep with nothing to do');

// Nothing is expired and nothing is over the cap, which is what almost every
// hourly run looks like. It should therefore cost almost nothing. A sweep
// that reads the whole archive to decide it has no work is the difference
// between a background job and a background problem.
await ask(driver, 'SETTINGS_SET', { retentionMonths: 24, sizeCapBytes: 500 * 1024 * 1024 });

const idleRuns = [];
for (let i = 0; i < 3; i++) {
  const started = Date.now();
  const result = await ask(driver, 'MAINTENANCE');
  idleRuns.push({ ms: Date.now() - started, evicted: result.evicted });
}
const idleMs = Math.min(...idleRuns.map((r) => r.ms));
note('an idle sweep over ' + TOTAL + ' pages takes ' + idleMs + 'ms');
check('an idle sweep evicts nothing', idleRuns.every((r) => r.evicted === 0),
  JSON.stringify(idleRuns));
check('an idle sweep does not read the archive to decide it has no work',
  idleMs < 250, idleMs + 'ms for ' + TOTAL + ' pages, which is a full scan');

// ---------------------------------------------------------------------------
phase('the retention cap biting');

// Three pages the sweep has to tell apart: one old and pinned, one old and
// left to expire, and one whose history is old but which was read today.
const marked = await driver.evaluate(async ({ monthMs }) => {
  const { MSG } = await import('/src/shared/messages.js');
  const old = Date.now() - 13 * monthMs;
  const pages = [
    { key: 'pinned', url: 'https://marker.example/kept-on-purpose', pinned: true, lastSeen: old },
    { key: 'expiring', url: 'https://marker.example/left-to-expire', pinned: false, lastSeen: old },
    { key: 'revisited', url: 'https://marker.example/read-again-today', pinned: false, lastSeen: Date.now() },
  ];
  const ids = {};
  for (const page of pages) {
    await chrome.runtime.sendMessage({
      type: MSG.IMPORT,
      payload: {
        pages: [{
          url: page.url,
          title: 'Marker ' + page.key,
          text: 'A marker page for the retention sweep, ' + page.key +
            ', with a unique word markerneedle' + page.key + ' and enough other words around it to index normally.',
          firstSeen: new Date(old).toISOString(),
          lastSeen: new Date(page.lastSeen).toISOString(),
          pinned: page.pinned,
        }],
      },
    });
    const status = await chrome.runtime.sendMessage({ type: MSG.PAGE_STATUS, payload: { url: page.url } });
    ids[page.key] = status.kept ? status.kept.id : null;
  }
  return ids;
}, { monthMs: MONTH });

check('the three marker pages were all stored',
  marked.pinned && marked.expiring && marked.revisited, JSON.stringify(marked));

const beforeAge = (await ask(driver, 'STATS')).docCount;
await ask(driver, 'SETTINGS_SET', { retentionMonths: 6 });

let ageSweep = { evicted: 0 };
let ageRounds = 0;
const ageStarted = Date.now();
// The sweep is written as rounds; keep going until it says there is nothing
// left to do, the way the hourly alarm eventually would.
for (let i = 0; i < 40; i++) {
  ageSweep = await ask(driver, 'MAINTENANCE');
  ageRounds += 1;
  if (!ageSweep.evicted) break;
}
const afterAge = await ask(driver, 'STATS');
note('retention sweep removed ' + (beforeAge - afterAge.docCount) + ' pages in ' + ageRounds +
  ' runs, ' + Math.round((Date.now() - ageStarted) / 1000) + 's');

check('pages older than the retention limit are gone',
  afterAge.docCount < beforeAge, beforeAge + ' before, ' + afterAge.docCount + ' after');

const survived = await driver.evaluate(async (ids) => {
  const { MSG } = await import('/src/shared/messages.js');
  const out = {};
  for (const [key, id] of Object.entries(ids)) {
    const found = await chrome.runtime.sendMessage({
      type: MSG.SEARCH,
      payload: { query: 'markerneedle' + key },
    });
    out[key] = found.results.some((r) => r.id === id);
  }
  return out;
}, marked);

check('a pinned page outlives the retention limit', survived.pinned === true,
  'the one thing eviction must never do');
check('an expired page is actually gone', survived.expiring === false, 'it is still there');
check('a page read today survives even though its history is old',
  survived.revisited === true, 'lastSeen was ignored in favour of firstSeen');

const ageLog = await ask(driver, 'LOG', { limit: 40 });
check('the retention sweep said what it removed', ageLog.length > 0, 'nothing was logged');
check('and said it was the age limit',
  ageLog[0] && (ageLog[0].reason === 'age' || ageLog[0].reason === 'both'),
  ageLog[0] && ageLog[0].reason);
check('one sweep is one entry in the storage log, not one per round',
  ageLog.length <= ageRounds - 1 || ageLog.length <= 2,
  ageLog.length + ' rows for a sweep that went round ' + ageRounds + ' times');

const ageInvariants = await deepInvariants(driver);
check('the index is consistent after the retention sweep',
  ageInvariants.problems.length === 0, JSON.stringify(ageInvariants.problems));

// ---------------------------------------------------------------------------
phase('the size cap biting');

const beforeSize = await ask(driver, 'STATS');
const targetBytes = Math.floor(beforeSize.usedBytes * 0.6);
await ask(driver, 'SETTINGS_SET', { retentionMonths: 24, sizeCapBytes: targetBytes });

const logBefore = (await ask(driver, 'LOG', { limit: 100 })).length;
let sizeRounds = 0;
const sizeStarted = Date.now();
for (let i = 0; i < 200; i++) {
  const result = await ask(driver, 'MAINTENANCE');
  sizeRounds += 1;
  if (!result.evicted) break;
}
const afterSize = await ask(driver, 'STATS');
note('size sweep took ' + Math.round((Date.now() - sizeStarted) / 1000) + 's over ' + sizeRounds +
  ' runs, ' + (beforeSize.docCount - afterSize.docCount) + ' pages removed');

check('the archive is brought under its size cap',
  afterSize.usedBytes <= targetBytes,
  (afterSize.usedBytes / 1048576).toFixed(1) + 'MB against a cap of ' +
    (targetBytes / 1048576).toFixed(1) + 'MB');

const pinnedStillThere = await driver.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  const found = await chrome.runtime.sendMessage({
    type: MSG.SEARCH, payload: { query: 'markerneedlepinned' },
  });
  return found.results.length > 0;
});
check('and the pinned page is still there afterwards', pinnedStillThere, 'it was evicted');

const logAfter = await ask(driver, 'LOG', { limit: 100 });
note((logAfter.length - logBefore) + ' storage log rows written by a sweep of ' + sizeRounds + ' runs');
check('a long sweep does not flood the storage log',
  logAfter.length - logBefore <= Math.max(2, Math.ceil(sizeRounds / 8)),
  (logAfter.length - logBefore) + ' rows for one sweep would push a year of history out of a list of fifteen');

const sizeInvariants = await deepInvariants(driver);
check('the index is consistent after the size sweep',
  sizeInvariants.problems.length === 0, JSON.stringify(sizeInvariants.problems));

// ---------------------------------------------------------------------------
phase('the badge, for an archive doing exactly what it was told');

const resting = await ask(driver, 'STATS');
const badgeAtCap = await worker.evaluate(() => chrome.action.getBadgeText({}));
note('archive rests at ' + Math.round(resting.budget.fraction * 100) + '% of its cap, badge is "' +
  badgeAtCap + '"');
check('a full archive replacing its oldest pages does not light a warning badge',
  badgeAtCap === '',
  'a badge that is always lit is one nobody reads');

// More pinned than the cap allows is the one case that cannot be swept out
// of, and the one worth telling somebody about. Everything unpinned goes;
// the phases below seed again.
// A cap of one byte. Nothing can meet it, so what survives is exactly what
// eviction is forbidden to touch, and the sweep has to say so rather than
// coming back every hour to try again.
await ask(driver, 'SETTINGS_SET', { sizeCapBytes: 1 });
let unmeetableSweep = null;
for (let i = 0; i < 400; i++) {
  unmeetableSweep = await ask(driver, 'MAINTENANCE');
  if (!unmeetableSweep.evicted) break;
}
const afterUnmeetable = await ask(driver, 'STATS');
const badgeUnmeetable = await worker.evaluate(() => chrome.action.getBadgeText({}));
note('with a cap nothing can meet, the archive settles at ' + afterUnmeetable.docCount +
  ' pinned pages, badge is "' + badgeUnmeetable + '"');
check('a cap that cannot be met does light one', badgeUnmeetable !== '',
  'nothing warns about a budget the archive cannot honour');
check('and the sweep says so rather than retrying for ever',
  unmeetableSweep && unmeetableSweep.unmeetable === true, JSON.stringify(unmeetableSweep));
check('and what it could not evict is exactly what was pinned',
  afterUnmeetable.docCount > 0, 'it evicted pinned pages to meet a budget, which it must never do');

await ask(driver, 'SETTINGS_SET', { sizeCapBytes: 500 * 1024 * 1024 });
await ask(driver, 'MAINTENANCE');
const badgeCleared = await worker.evaluate(() => chrome.action.getBadgeText({}));
check('and the badge goes out once the budget can be met again', badgeCleared === '', badgeCleared);

// ---------------------------------------------------------------------------
phase('searching while a sweep is deleting');

const refill = await ask(driver, 'STATS');
const topUp = Math.max(0, 900 - refill.docCount);
if (topUp > 0) {
  await seed(driver, {
    from: 100000,
    count: topUp,
    spread: { start: now - 2 * MONTH, end: now },
    pinnedEvery: 0,
    batch: 50,
    tag: 'refill',
  });
}

const contention = await driver.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  const stats = await chrome.runtime.sendMessage({ type: MSG.STATS });
  // A cap that forces roughly half the archive out, so the sweep is long
  // enough for searches to land in the middle of it.
  await chrome.runtime.sendMessage({
    type: MSG.SETTINGS_SET,
    payload: { sizeCapBytes: Math.floor(stats.usedBytes * 0.5) },
  });

  const latencies = [];
  let sweeping = true;
  const sweep = (async () => {
    for (let i = 0; i < 200; i++) {
      const result = await chrome.runtime.sendMessage({ type: MSG.MAINTENANCE });
      if (!result.evicted) break;
    }
    sweeping = false;
  })();

  while (sweeping && latencies.length < 120) {
    const started = performance.now();
    await chrome.runtime.sendMessage({ type: MSG.SEARCH, payload: { query: 'retro cohort' } });
    latencies.push(performance.now() - started);
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  await sweep;

  latencies.sort((a, b) => a - b);
  return {
    samples: latencies.length,
    p50: Math.round(latencies[Math.floor(latencies.length / 2)] || 0),
    p95: Math.round(latencies[Math.floor(latencies.length * 0.95)] || 0),
    worst: Math.round(latencies[latencies.length - 1] || 0),
  };
});

note('search during a sweep: ' + contention.p50 + 'ms typical, ' + contention.p95 + 'ms p95, ' +
  contention.worst + 'ms worst, over ' + contention.samples + ' samples');
check('a search typed during a sweep still answers promptly',
  contention.p50 < 400, contention.p50 + 'ms typically, which feels broken');
check('and there is no multi second tail behind the sweep',
  contention.worst < 1200, contention.worst + 'ms worst case');

await ask(driver, 'SETTINGS_SET', { sizeCapBytes: 500 * 1024 * 1024 });

// ---------------------------------------------------------------------------
phase('the worker stopped in the middle of a sweep');

await seed(driver, {
  from: 200000,
  count: 600,
  spread: { start: now - 2 * MONTH, end: now },
  pinnedEvery: 0,
  batch: 50,
  tag: 'killme',
});

const beforeKill = await ask(driver, 'STATS');
const cdp = await context.newCDPSession(driver);
await cdp.send('ServiceWorker.enable');

await ask(driver, 'SETTINGS_SET', { sizeCapBytes: Math.floor(beforeKill.usedBytes * 0.4) });
const interrupted = driver.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  try {
    for (let i = 0; i < 200; i++) {
      const result = await chrome.runtime.sendMessage({ type: MSG.MAINTENANCE });
      if (!result || !result.evicted) break;
    }
    return 'finished';
  } catch (error) {
    return 'interrupted: ' + String(error.message || error);
  }
});
await driver.waitForTimeout(1500);
await cdp.send('ServiceWorker.stopAllWorkers');
const killOutcome = await interrupted;
await driver.waitForTimeout(1000);

const afterKill = await ask(driver, 'STATS');
note('worker was stopped mid sweep (' + killOutcome + '); ' + beforeKill.docCount + ' pages before, ' +
  afterKill.docCount + ' after');
check('an interrupted sweep keeps the progress it made',
  afterKill.docCount < beforeKill.docCount,
  'an all or nothing delete transaction rolls back to nothing, and would do so for ever');

const killInvariants = await deepInvariants(driver);
check('the worker and the database agree after the interruption',
  afterKill.docCount === killInvariants.pages,
  'worker says ' + afterKill.docCount + ', database has ' + killInvariants.pages);
check('and the index is still consistent',
  killInvariants.problems.length === 0, JSON.stringify(killInvariants.problems));

await ask(driver, 'SETTINGS_SET', { sizeCapBytes: 500 * 1024 * 1024 });

// ---------------------------------------------------------------------------
phase('four browser restarts');

for (let restart = 1; restart <= 4; restart++) {
  const before = await ask(driver, 'STATS');
  await ask(driver, 'SETTINGS_SET', { customRules: ['restart-' + restart + '.example'] });
  const probe = await ask(driver, 'SEARCH', { query: 'needle300' });
  const probeFound = probe.results.length;

  await context.close();
  context = await launch();
  worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  extensionId = new URL(worker.url()).host;
  driver = await driverPage();

  const after = await ask(driver, 'STATS');
  const settings = await ask(driver, 'SETTINGS_GET');
  const probeAgain = await ask(driver, 'SEARCH', { query: 'needle300' });

  check('restart ' + restart + ': the archive is all still there',
    after.docCount === before.docCount, before.docCount + ' before, ' + after.docCount + ' after');
  check('restart ' + restart + ': settings survive',
    settings.customRules.includes('restart-' + restart + '.example'), JSON.stringify(settings.customRules));
  check('restart ' + restart + ': search finds the same page it found before',
    probeAgain.results.length === probeFound,
    probeFound + ' before, ' + probeAgain.results.length + ' after');
}

// ---------------------------------------------------------------------------
phase('sixty ordinary days');

// A dozen pages in, a sweep after each. This is the state a real archive
// spends its life in, and the only place a slow leak in the index shows up.
const trend = [];
let dayProblems = [];
const dayStarted = Date.now();

for (let day = 1; day <= DAYS; day++) {
  await seed(driver, {
    from: 500000 + day * 100,
    count: 12,
    spread: { start: now + day * 86400000, end: now + day * 86400000 + 1000 },
    pinnedEvery: 0,
    batch: 12,
    tag: 'day' + day + '-',
  });
  await ask(driver, 'MAINTENANCE');

  const daily = await fastInvariants(driver);
  if (daily.problems.length) dayProblems.push('day ' + day + ': ' + daily.problems.join('; '));
  if (day === 1 || day % 10 === 0 || day === DAYS) {
    const s = await ask(driver, 'STATS');
    trend.push({
      day,
      pages: s.docCount,
      mb: +(s.usedBytes / 1048576).toFixed(2),
      postings: daily.postingRecords,
      perPage: Math.round(s.usedBytes / Math.max(1, s.docCount)),
    });
  }
}

note('sixty days took ' + Math.round((Date.now() - dayStarted) / 1000) + 's');
for (const row of trend) {
  note('  day ' + String(row.day).padStart(2) + ': ' + String(row.pages).padStart(5) + ' pages, ' +
    String(row.mb).padStart(6) + 'MB, ' + String(row.postings).padStart(6) + ' posting records, ' +
    row.perPage + ' bytes per page');
}

check('the invariants hold after every single sweep',
  dayProblems.length === 0, dayProblems.slice(0, 3).join(' | '));

const first = trend[0];
const last = trend[trend.length - 1];
check('storage per page does not drift upwards over sixty days',
  last.perPage <= first.perPage * 1.15,
  first.perPage + ' bytes per page on day ' + first.day + ', ' + last.perPage + ' on day ' + last.day);
check('posting records track the pages that exist, rather than accumulating',
  last.postings / last.pages <= (first.postings / first.pages) * 1.15,
  (first.postings / first.pages).toFixed(1) + ' records per page at the start, ' +
    (last.postings / last.pages).toFixed(1) + ' at the end);');

// ---------------------------------------------------------------------------
phase('after all of that');

const finalStats = await ask(driver, 'STATS');
const finalInvariants = await deepInvariants(driver);
note('ended with ' + finalStats.docCount + ' pages, ' +
  (finalStats.usedBytes / 1048576).toFixed(1) + 'MB, ' + finalInvariants.postingRecords + ' posting records');

check('the index is consistent at the end of a simulated year',
  finalInvariants.problems.length === 0, JSON.stringify(finalInvariants.problems));
check('the worker and the database still agree',
  finalStats.docCount === finalInvariants.pages,
  finalStats.docCount + ' vs ' + finalInvariants.pages);

const finalSearch = await ask(driver, 'SEARCH', { query: 'retention eviction' });
check('search still works after a year of churn', finalSearch.results.length > 0, '0 results');
check('and is still fast', finalSearch.tookMs < 300, finalSearch.tookMs + 'ms');

const finalRecent = await ask(driver, 'RECENT', { limit: 10 });
check('the recent list still works', finalRecent.length > 0, finalRecent.length);

await context.close();
await rm(profile, { recursive: true, force: true });

const failed = checks.filter((result) => !result.ok).length;
console.log('');
for (const error of errors) console.log('  page error: ' + error);
console.log(checks.length - failed + ' passed, ' + failed + ' failed');
process.exit(failed || errors.length ? 1 : 0);
