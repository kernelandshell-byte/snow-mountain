// Indexes a synthetic corpus into real IndexedDB and measures what it costs.
// The architecture claims search p95 under 100ms and capture under 150ms.
// Claims in a document are worth nothing, so this is where they get checked.
//
//   npm install --no-save playwright
//   node test/browser/run-benchmark.mjs [documentCount]

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const docCount = Number(process.argv[2] || 400);

const context = await chromium.launchPersistentContext('', {
  headless: false,
  args: ['--disable-extensions-except=' + root, '--load-extension=' + root, '--no-sandbox'],
});

let [worker] = context.serviceWorkers();
if (!worker) worker = await context.waitForEvent('serviceworker');
const extensionId = new URL(worker.url()).host;

const page = await context.newPage();
await page.goto('chrome-extension://' + extensionId + '/src/ui/options/options.html');

const report = await page.evaluate(async (count) => {
  const { openStore } = await import('/src/db/idb-store.js');
  const { search } = await import('/src/core/index-reader.js');

  // A Zipf-ish vocabulary, so a few terms are everywhere and most are rare,
  // which is what makes posting list sizes realistic.
  const vocab = [];
  for (let i = 0; i < 6000; i++) vocab.push('term' + i);
  const pick = () => {
    const index = Math.floor(vocab.length * Math.pow(Math.random(), 3));
    return vocab[Math.min(index, vocab.length - 1)];
  };

  const makeDoc = (i) => {
    const words = [];
    for (let w = 0; w < 800; w++) words.push(pick());
    // One unique marker per document, which is what the known item search
    // below looks for.
    words.splice(400, 0, 'marker' + i);
    return {
      url: 'https://site' + (i % 50) + '.example/article-' + i,
      title: 'Document ' + i + ' about ' + pick() + ' and ' + pick(),
      text: words.join(' '),
      lastSeen: Date.now() - i * 60000,
    };
  };

  const name = 'bench-' + Date.now();
  const store = await openStore({ name });

  const indexTimes = [];
  const startedAll = performance.now();
  for (let i = 0; i < count; i++) {
    const doc = makeDoc(i);
    const t0 = performance.now();
    await store.putPage(doc);
    indexTimes.push(performance.now() - t0);
  }
  const indexTotal = performance.now() - startedAll;

  const rareTimes = [];
  for (let i = 0; i < 60; i++) {
    const target = Math.floor(Math.random() * count);
    const t0 = performance.now();
    await search('marker' + target, { store });
    rareTimes.push(performance.now() - t0);
  }

  // Worst case: both terms are among the most common in the corpus, so their
  // posting lists contain nearly every document.
  const commonTimes = [];
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    await search(vocab[0] + ' ' + vocab[1], { store });
    commonTimes.push(performance.now() - t0);
  }

  // Realistic case: one common word plus one selective word, which is what a
  // half remembered phrase actually looks like.
  const mixedTimes = [];
  for (let i = 0; i < 30; i++) {
    const target = Math.floor(Math.random() * count);
    const t0 = performance.now();
    await search(vocab[0] + ' marker' + target, { store });
    mixedTimes.push(performance.now() - t0);
  }

  // Phrase query, the only path that needs stored positions.
  const phraseTimes = [];
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    await search('"' + vocab[0] + ' ' + vocab[1] + '"', { store });
    phraseTimes.push(performance.now() - t0);
  }

  const pct = (arr, p) => {
    const sorted = [...arr].sort((a, b) => a - b);
    return Math.round(sorted[Math.floor(sorted.length * p)] * 10) / 10;
  };

  const estimate = await navigator.storage.estimate();
  const stats = await store.readStats();
  store.close();
  await new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = resolve;
    request.onerror = resolve;
    request.onblocked = resolve;
  });

  return {
    docs: stats.docCount,
    avgDocLength: Math.round(stats.avgDocLength),
    indexTotalSec: Math.round(indexTotal) / 1000,
    indexP50: pct(indexTimes, 0.5),
    indexP95: pct(indexTimes, 0.95),
    // Does cost per page stay flat as the corpus grows, or climb?
    indexP50First20pct: pct(indexTimes.slice(0, Math.floor(count * 0.2)), 0.5),
    indexP50Last20pct: pct(indexTimes.slice(Math.floor(count * 0.8)), 0.5),
    rareSearchP50: pct(rareTimes, 0.5),
    rareSearchP95: pct(rareTimes, 0.95),
    commonSearchP50: pct(commonTimes, 0.5),
    commonSearchP95: pct(commonTimes, 0.95),
    mixedSearchP50: pct(mixedTimes, 0.5),
    mixedSearchP95: pct(mixedTimes, 0.95),
    phraseSearchP50: pct(phraseTimes, 0.5),
    storageMB: Math.round((estimate.usage || 0) / 1048576 * 10) / 10,
    kbPerDoc: Math.round(((estimate.usage || 0) / 1024 / (stats.docCount || 1)) * 10) / 10,
  };
}, docCount);

await context.close();
console.log(JSON.stringify(report, null, 2));
