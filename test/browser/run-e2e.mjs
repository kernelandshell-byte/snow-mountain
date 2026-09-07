// End to end through the real extension: a loaded service worker, real
// IndexedDB, real message passing. The Node suite proves the logic and the
// contract proves the storage, but neither would notice a broken import in
// the service worker or a message type nobody handles.
//
//   npm install --no-save playwright
//   node test/browser/run-e2e.mjs

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const context = await chromium.launchPersistentContext('', {
  headless: false,
  args: ['--disable-extensions-except=' + root, '--load-extension=' + root, '--no-sandbox'],
});

let [worker] = context.serviceWorkers();
if (!worker) {
  worker = await Promise.race([
    context.waitForEvent('serviceworker'),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('the service worker never started, check its imports')), 10000)
    ),
  ]);
}
const extensionId = new URL(worker.url()).host;

const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
await page.goto('chrome-extension://' + extensionId + '/src/ui/options/options.html');

const results = await page.evaluate(async () => {
  const { CORPUS } = await import('/test/fixtures/corpus.js');
  const { MSG } = await import('/src/shared/messages.js');
  const ask = (type, payload) => chrome.runtime.sendMessage({ type, payload });

  const out = [];
  const check = (name, condition, detail) =>
    out.push({ name, ok: !!condition, detail: condition ? '' : String(detail) });

  // 1. Capture, the way the content script would.
  const sample = CORPUS.slice(0, 8);
  for (const doc of sample) {
    await ask(MSG.PAGE_CONTENT, {
      url: doc.url,
      title: doc.title,
      text: doc.text,
      capturedAt: Date.now(),
    });
  }

  let stats = await ask(MSG.STATS);
  check('captured pages are counted', stats.docCount === sample.length, 'got ' + stats.docCount);
  check('storage use is reported', stats.usedBytes > 0, stats.usedBytes);
  check('budget is computed', stats.budget && stats.budget.level === 'ok', JSON.stringify(stats.budget));

  // 2. Capturing the same page again is a revisit, not a duplicate.
  await ask(MSG.PAGE_CONTENT, {
    url: sample[0].url,
    title: sample[0].title,
    text: sample[0].text,
    capturedAt: Date.now(),
  });
  stats = await ask(MSG.STATS);
  check('a revisit does not create a second page', stats.docCount === sample.length, 'got ' + stats.docCount);

  // 3. Search through the worker.
  const found = await ask(MSG.SEARCH, { query: 'retro fatigue' });
  check('search returns the right page first',
    found.results[0] && found.results[0].url === 'https://teamcraft.example/retro-fatigue',
    found.results[0] && found.results[0].url);
  check('results carry a highlighted snippet',
    found.results[0] && found.results[0].snippet.ranges.length > 0,
    JSON.stringify(found.results[0] && found.results[0].snippet));

  const plural = await ask(MSG.SEARCH, { query: 'retros' });
  check('the singular fallback works through the worker',
    plural.results.length > 0 && plural.relaxed.retros === 'retro',
    JSON.stringify(plural.relaxed));

  // 4. Pin, then recent, then forget a whole site.
  const target = found.results[0].id;
  await ask(MSG.PIN, { id: target, pinned: true });
  const recent = await ask(MSG.RECENT, { limit: 10 });
  check('recent pages come back', recent.length === sample.length, 'got ' + recent.length);
  check('the pin stuck', recent.some((p) => p.id === target && p.pinned === 1), 'pin missing');

  const forgotten = await ask(MSG.FORGET, { scope: 'site', value: 'metricsdesk.example' });
  check('forgetting a site removes its pages', forgotten.deleted === 3, 'deleted ' + forgotten.deleted);
  const afterForget = await ask(MSG.SEARCH, { query: 'cohort chart' });
  check('a forgotten page is unfindable', afterForget.results.length === 0, afterForget.results.length);

  // 5. Maintenance under a budget small enough to force eviction, and the
  // pinned page has to survive it.
  await ask(MSG.SETTINGS_SET, { sizeCapBytes: 1500 });
  const swept = await ask(MSG.MAINTENANCE);
  check('maintenance evicts to fit the budget', swept.evicted > 0, JSON.stringify(swept));

  const afterSweep = await ask(MSG.STATS);
  check('the eviction was logged',
    afterSweep.recentEvictions.length > 0 && afterSweep.recentEvictions[0].count > 0,
    JSON.stringify(afterSweep.recentEvictions));

  const survivors = await ask(MSG.RECENT, { limit: 50 });
  check('the pinned page survived eviction',
    survivors.some((p) => p.id === target),
    'pinned page was evicted, which is the one thing eviction must never do');

  await ask(MSG.SETTINGS_SET, { sizeCapBytes: 500 * 1024 * 1024 });
  return out;
});

await context.close();

let failed = 0;
for (const result of results) {
  if (result.ok) console.log('  ok   ' + result.name);
  else {
    failed += 1;
    console.log('  FAIL ' + result.name + '\n       ' + result.detail);
  }
}
for (const error of errors) console.log('  page error: ' + error);
console.log('');
console.log(results.length - failed + ' passed, ' + failed + ' failed');
process.exit(failed || errors.length ? 1 : 0);
