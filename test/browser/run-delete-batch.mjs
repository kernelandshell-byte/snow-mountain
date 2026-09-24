// Why DELETE_BATCH is one.
//
// This is not a test. It answers the only question that decides the constant:
// how long does a search wait when it is typed while a sweep is deleting, and
// what does a bigger batch buy in exchange.
//
//   node test/browser/run-delete-batch.mjs [pages]

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PAGES = Number(process.argv[2] || 300);

const context = await chromium.launchPersistentContext('', {
  headless: false,
  args: ['--disable-extensions-except=' + root, '--load-extension=' + root, '--no-sandbox'],
});
let [worker] = context.serviceWorkers();
if (!worker) worker = await context.waitForEvent('serviceworker');
const page = await context.newPage();
await page.goto('chrome-extension://' + new URL(worker.url()).host + '/src/ui/options/options.html');

const rows = await page.evaluate(async (count) => {
  const { openStore } = await import('/src/db/idb-store.js');
  const { search } = await import('/src/core/index-reader.js');

  const vocabulary = ('retro fatigue cohort churn standup retention index eviction budget posting ' +
    'bucket worker fragment quote passage relevance snippet extraction permission migration').split(' ');
  const doc = (i) => {
    const words = [];
    for (let w = 0; w < 340; w++) words.push(vocabulary[Math.floor(Math.random() * vocabulary.length)]);
    return {
      url: 'https://batch.example/page-' + i,
      title: 'Page ' + i,
      text: words.join(' '),
      lastSeen: Date.now() - i * 60000,
    };
  };

  const fresh = async (name) => {
    const store = await openStore({ name });
    const ids = [];
    for (let i = 0; i < count; i++) ids.push((await store.putPage(doc(i))).id);
    return { store, ids };
  };
  const drop = async (store, name) => {
    store.close();
    await new Promise((resolve) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = resolve; request.onerror = resolve; request.onblocked = resolve;
    });
  };

  const out = [];
  for (const batch of [10, 3, 1]) {
    // Sweep throughput on its own, so the cost of the searches is not
    // mistaken for the cost of the batch size.
    const idleName = 'deletebatch-idle-' + batch + '-' + Date.now();
    const idle = await fresh(idleName);
    const idleStarted = performance.now();
    await idle.store.deletePages(idle.ids, { batch });
    const idleMs = Math.round(performance.now() - idleStarted);
    await drop(idle.store, idleName);

    const name = 'deletebatch-' + batch + '-' + Date.now();
    const store = await openStore({ name });
    const ids = [];
    for (let i = 0; i < count; i++) ids.push((await store.putPage(doc(i))).id);

    const latencies = [];
    let running = true;
    const started = performance.now();
    const sweep = store.deletePages(ids, { batch }).then(() => { running = false; });

    while (running) {
      const at = performance.now();
      await search('retro cohort', { store, limit: 20 });
      latencies.push(performance.now() - at);
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    await sweep;
    const sweepMs = Math.round(performance.now() - started);
    await drop(store, name);

    latencies.sort((a, b) => a - b);
    out.push({
      batch,
      samples: latencies.length,
      typical: Math.round(latencies[Math.floor(latencies.length / 2)] || 0),
      p95: Math.round(latencies[Math.floor(latencies.length * 0.95)] || 0),
      worst: Math.round(latencies[latencies.length - 1] || 0),
      sweepMs,
      idleMs,
    });
  }
  return out;
}, PAGES);

await context.close();

console.log('\n  deleting ' + PAGES + ' pages while searching every 80ms\n');
console.log('  batch   typical     p95    worst    sweep  sweep alone   searches');
for (const row of rows) {
  console.log(
    '  ' + String(row.batch).padStart(5) +
    String(row.typical + 'ms').padStart(10) +
    String(row.p95 + 'ms').padStart(8) +
    String(row.worst + 'ms').padStart(9) +
    String(Math.round(row.sweepMs / 1000) + 's').padStart(9) +
    String(Math.round(row.idleMs / 1000) + 's').padStart(13) +
    String(row.samples).padStart(11)
  );
}
console.log('');
