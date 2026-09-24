// The edges of "how much", and the failures that only appear at the top of
// them: an export bigger than a message, a disk with nothing left on it,
// storage Chrome has not promised to keep, and the housekeeping that has to
// survive a restart.
//
// These are the ones that do not go wrong on a test archive and do go wrong on
// a real one, which is exactly the shape of bug worth a suite of its own.
//
//   node test/browser/run-limits.mjs [pages]

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PAGES = Number(process.argv[2] || 700);

const profile = await mkdtemp(path.join(tmpdir(), 'sm-limits-'));
const launch = () =>
  chromium.launchPersistentContext(profile, {
    headless: false,
    viewport: { width: 1000, height: 800 },
    acceptDownloads: true,
    args: ['--disable-extensions-except=' + root, '--load-extension=' + root, '--no-sandbox'],
  });

let context = await launch();
let worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
let extensionId = new URL(worker.url()).host;

const checks = [];
const errors = [];
const check = (name, condition, detail) => {
  const result = { name, ok: !!condition, detail: condition ? '' : String(detail) };
  checks.push(result);
  console.log(result.ok ? '  ok   ' + name : '  FAIL ' + name + '\n       ' + result.detail);
};
const note = (text) => console.log('  note  ' + text);
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

let driver = await driverPage();
await ask(driver, 'SETTINGS_SET', { setupComplete: true, mode: 'broad', retentionMonths: 24 });

// ---------------------------------------------------------------------------
phase('storage Chrome has actually promised to keep');

// Best effort storage is cleared under disk pressure without telling anybody,
// which for this extension means a year of reading disappearing quietly.
//
// Whether Chrome grants persistence is Chrome's business: it decides on
// heuristics, and an automated profile is always refused. What this extension
// is responsible for is asking from somewhere the question can be asked at
// all, and saying so when the answer is no. StorageManager.persist() is
// exposed to windows and not to workers, so a service worker asking is a
// service worker doing nothing, silently, for ever.
const workerCanAsk = await worker.evaluate(() => typeof navigator.storage.persist);
check('the worker knows it cannot be the one to ask', workerCanAsk === 'undefined',
  'persist() looked available in the worker; if this changed, the pages no longer need to ask');

const pageAnswer = await driver.evaluate(async () => {
  const stored = await chrome.storage.local.get('persistence');
  return {
    recorded: stored.persistence || null,
    actual: await navigator.storage.persisted(),
    canAsk: typeof navigator.storage.persist === 'function',
  };
});
note('persistence: Chrome says ' + pageAnswer.actual + ', the extension recorded ' +
  JSON.stringify(pageAnswer.recorded));

check('an extension page is where the asking happens', pageAnswer.canAsk === true,
  'nowhere in this extension can request persistent storage');
check('and it has actually asked, rather than assuming',
  pageAnswer.recorded && typeof pageAnswer.recorded.checkedAt === 'number',
  JSON.stringify(pageAnswer.recorded));
check('and recorded the answer Chrome actually gave',
  pageAnswer.recorded && pageAnswer.recorded.granted === pageAnswer.actual,
  JSON.stringify(pageAnswer.recorded) + ' against ' + pageAnswer.actual);

const stats0 = await ask(driver, 'STATS');
check('the interface can see that answer', stats0.persisted === pageAnswer.actual,
  String(stats0.persisted));

if (pageAnswer.actual === false) {
  const warned = await context.newPage();
  await warned.goto('chrome-extension://' + extensionId + '/src/ui/options/options.html');
  await warned.waitForTimeout(700);
  const text = await warned.textContent('body');
  check('and when it is refused, settings says so rather than leaving it unsaid',
    /hasn't marked this storage as persistent/i.test(text),
    text.replace(/\s+/g, ' ').slice(0, 200));
  await warned.close();
} else {
  note('Chrome granted persistence, so the refusal warning could not be exercised here');
}

// ---------------------------------------------------------------------------
phase('an export bigger than a message');

const seeded = await driver.evaluate(async (count) => {
  const { MSG } = await import('/src/shared/messages.js');
  const vocabulary = ('retention eviction indexing posting bucket worker fragment quote passage ' +
    'relevance snippet extraction permission migration transaction cursor archive browser').split(' ');
  let batch = [];
  const started = Date.now();
  for (let i = 0; i < count; i++) {
    const words = [];
    for (let w = 0; w < 700; w++) words.push(vocabulary[i % vocabulary.length] + (w % 40));
    batch.push({
      url: 'https://bulk' + (i % 30) + '.example/page-' + i,
      title: 'Bulk page ' + i,
      text: words.join(' ') + ' bulkneedle' + i,
      firstSeen: new Date(Date.now() - i * 60000).toISOString(),
      lastSeen: new Date(Date.now() - i * 60000).toISOString(),
    });
    if (batch.length >= 50) {
      await chrome.runtime.sendMessage({ type: MSG.IMPORT, payload: { pages: batch } });
      batch = [];
    }
  }
  if (batch.length) await chrome.runtime.sendMessage({ type: MSG.IMPORT, payload: { pages: batch } });
  const stats = await chrome.runtime.sendMessage({ type: MSG.STATS });
  return { docCount: stats.docCount, usedBytes: stats.usedBytes, ms: Date.now() - started };
}, PAGES);
note(seeded.docCount + ' pages, ' + (seeded.usedBytes / 1048576).toFixed(1) + 'MB, seeded in ' +
  Math.round(seeded.ms / 1000) + 's');

// One EXPORT message must never be asked to carry the whole archive.
const SLICE = 50;
const slice = await ask(driver, 'EXPORT', { afterId: 0, limit: SLICE });
check('an export comes back a slice at a time', slice.pages.length === SLICE, slice.pages.length);
check('and says how much there is in total', slice.total === seeded.docCount, slice.total);
check('and where to carry on from', typeof slice.lastId === 'number' && slice.done === false,
  JSON.stringify({ lastId: slice.lastId, done: slice.done }));

const second = await ask(driver, 'EXPORT', { afterId: slice.lastId, limit: SLICE });
check('the next slice starts after the last page of the one before',
  second.pages.length > 0 && second.pages[0].url !== slice.pages[0].url,
  second.pages[0] && second.pages[0].url);

const [download] = await Promise.all([
  driver.waitForEvent('download', { timeout: 120000 }),
  driver.click('#export'),
]);
const exportPath = await download.path();
const exportBytes = (await stat(exportPath)).size;
const exported = JSON.parse(await readFile(exportPath, 'utf8'));
note('the exported file is ' + (exportBytes / 1048576).toFixed(1) + 'MB');
check('the whole archive still reaches the file', exported.pages.length === seeded.docCount,
  exported.pages.length + ' of ' + seeded.docCount);
check('the file assembled from slices is valid JSON with the expected shape',
  exported.format === 'reading-archive-export' && Array.isArray(exported.pages) && exported.settings,
  Object.keys(exported).join(','));
check('and every page in it carries its full text',
  exported.pages.every((page) => page.text && page.text.length > 200), 'text was lost on the way out');
check('and its dates', /^\d{4}-\d{2}-\d{2}T/.test(exported.pages[0].lastSeen), exported.pages[0].lastSeen);

const urls = new Set(exported.pages.map((page) => page.url));
check('with no page written twice and none missed', urls.size === seeded.docCount, urls.size);

// ---------------------------------------------------------------------------
phase('deleting a lot of it');

const bySiteTiming = await driver.evaluate(async () => {
  const { openStore } = await import('/src/db/idb-store.js');
  const store = await openStore({});
  const a = performance.now();
  const ids = await store.pageIdsByDomain('bulk3.example');
  const indexed = performance.now() - a;
  const b = performance.now();
  const all = await store.listPageMeta();
  const scanned = performance.now() - b;
  store.close();
  return { found: ids.length, indexed: Math.round(indexed), total: all.length, scanned: Math.round(scanned) };
});
note('finding one site\'s pages: ' + bySiteTiming.indexed + 'ms off the index against ' +
  bySiteTiming.scanned + 'ms to scan all ' + bySiteTiming.total);
check('finding one site\'s pages does not read the whole archive',
  bySiteTiming.found > 0 && bySiteTiming.indexed < Math.max(30, bySiteTiming.scanned / 2),
  bySiteTiming.indexed + 'ms against a ' + bySiteTiming.scanned + 'ms scan');

const forgotten = await ask(driver, 'FORGET', { scope: 'site', value: 'bulk3.example' });
check('and forgetting that site removes exactly its pages',
  forgotten.deleted === bySiteTiming.found, forgotten.deleted + ' of ' + bySiteTiming.found);

const wipeStarted = Date.now();
const wiped = await ask(driver, 'WIPE');
const afterWipe = await ask(driver, 'STATS');
note('wiping ' + wiped.deleted + ' pages took ' + Math.round((Date.now() - wipeStarted) / 1000) + 's');
check('delete everything really does', afterWipe.docCount === 0, afterWipe.docCount + ' left');
check('and says how much it removed', wiped.deleted > 0, JSON.stringify(wiped));
const wipeLog = await ask(driver, 'LOG', { limit: 5 });
check('and leaves a record of it, like everything else that deletes',
  wipeLog.some((row) => row.reason === 'manual' && row.count === wiped.deleted),
  JSON.stringify(wipeLog.slice(0, 2)));

// ---------------------------------------------------------------------------
phase('a disk with nothing left on it');

// A genuinely full disk is not something a test profile can be given, and the
// CDP quota override does not reach a chrome-extension origin. What can be
// held down is the two halves that would otherwise rot unnoticed: telling a
// quota failure apart from every other storage failure, and saying so.
const classified = await driver.evaluate(async () => {
  const { isQuotaError } = await import('/src/db/idb-store.js');
  const quota = new DOMException('The quota has been exceeded.', 'QuotaExceededError');
  const other = new DOMException('Something else went wrong.', 'InvalidStateError');
  return {
    quota: isQuotaError(quota),
    worded: isQuotaError(new Error('Encountered full disk while opening backing store for quota')),
    other: isQuotaError(other),
    nothing: isQuotaError(null),
  };
});
check('a quota failure is told apart from every other storage failure',
  classified.quota && classified.worded, JSON.stringify(classified));
check('and nothing else is mistaken for one',
  classified.other === false && classified.nothing === false, JSON.stringify(classified));

await driver.evaluate(() => chrome.storage.local.set({ storageFull: { at: Date.now() } }));
const fullStats = await ask(driver, 'STATS');
check('the extension remembers that the disk ran out', fullStats.storageFull,
  JSON.stringify(fullStats.storageFull));

const fullPage = await context.newPage();
await fullPage.goto('chrome-extension://' + extensionId + '/src/ui/options/options.html');
await fullPage.waitForTimeout(700);
const fullText = await fullPage.textContent('body');
check('and settings explains it rather than showing a meter that looks fine',
  /ran out of space/i.test(fullText), fullText.replace(/\s+/g, ' ').slice(0, 200));
check('and says what to do about it',
  /free up some space|lower the size limit/i.test(fullText), fullText.replace(/\s+/g, ' ').slice(0, 200));
await fullPage.close();

// ---------------------------------------------------------------------------
phase('housekeeping that has to survive a restart');

await driver.evaluate(() => chrome.storage.local.remove('storageFull'));
await ask(driver, 'SETTINGS_SET', { sizeCapBytes: 500 * 1024 * 1024 });
await ask(driver, 'MAINTENANCE');

const alarmBefore = await worker.evaluate(() => chrome.alarms.get('maintenance').then((a) => !!a));
check('there is an hourly sweep scheduled at all', alarmBefore, 'no maintenance alarm');

// An alarm a profile lost would leave the budget silently unenforced for ever,
// because the only place it was ever created was install.
await worker.evaluate(() => chrome.alarms.clear('maintenance'));
await context.close();

context = await launch();
worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
extensionId = new URL(worker.url()).host;
driver = await driverPage();
await driver.waitForTimeout(800);

const alarmAfter = await worker.evaluate(() => chrome.alarms.get('maintenance').then((a) => !!a));
check('and a lost one comes back on the next browser start', alarmAfter,
  'the budget would never be applied again');

// A warning that only ever appears once is not a warning.
await driver.evaluate(async () => {
  const stored = await chrome.storage.local.get('sweepState');
  await chrome.storage.local.set({ sweepState: { ...(stored.sweepState || {}), capUnmeetable: true } });
});
await context.close();
context = await launch();
worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
extensionId = new URL(worker.url()).host;
driver = await driverPage();
await driver.waitForTimeout(1000);

const badgeAfterRestart = await worker.evaluate(() => chrome.action.getBadgeText({}));
check('a budget that still cannot be met is still flagged after a restart',
  badgeAfterRestart !== '', 'Chrome clears the badge on restart and nothing put it back');

await context.close();
await rm(profile, { recursive: true, force: true });

const failed = checks.filter((result) => !result.ok).length;
console.log('');
for (const error of errors) console.log('  page error: ' + error);
console.log(checks.length - failed + ' passed, ' + failed + ' failed');
process.exit(failed || errors.length ? 1 : 0);
