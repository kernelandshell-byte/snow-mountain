// What the search fallbacks cost as the number of enabled stemming
// languages grows, against real IndexedDB at archive scale. Not a test.
//
//   npm install --no-save playwright
//   node test/browser/run-fallback-benchmark.mjs [pages]
//
// The expensive case is a word that matches nothing at all: it goes through
// the singular, then one bounded stem scan per enabled language, then a
// prefix scan, then a typo scan, and each scan reads real posting lists. So
// every query here is built to miss, over a vocabulary built from shared
// syllables so that the prefixes it scans are crowded the way a real
// language's are. Each language's scan is capped at VERIFY_SCAN_LIMIT and
// only runs if the one before it found nothing, so the cost should grow
// about linearly with the language count. This is where "should" gets a
// number. At 3,000 pages, six languages measured a median of 44ms for a word
// that matches nothing, against 31ms with none.

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pageCount = Number(process.argv[2] || 3000);

const context = await chromium.launchPersistentContext('', {
  headless: false,
  args: ['--disable-extensions-except=' + root, '--load-extension=' + root, '--no-sandbox'],
});

let [worker] = context.serviceWorkers();
if (!worker) worker = await context.waitForEvent('serviceworker');
const extensionId = new URL(worker.url()).host;

const page = await context.newPage();
page.on('console', (message) => { if (message.text().startsWith('progress')) console.log(message.text()); });
await page.goto('chrome-extension://' + extensionId + '/src/ui/options/options.html');

const report = await page.evaluate(async (count) => {
  const { openStore } = await import('/src/db/idb-store.js');
  const { search } = await import('/src/core/index-reader.js');
  const { STEM_LANGUAGES } = await import('/src/core/stemming.js');

  // Deterministic, so two runs measure the same archive. mulberry32: an LCG
  // written in plain floats loses precision past 2^53 and falls into a short
  // cycle, which is how an earlier draft of this never finished building
  // its vocabulary.
  let seed = 42;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const choose = (list) => list[Math.floor(random() * list.length)];

  // Stems and endings from the languages being measured, so that every
  // language's stemmer finds something to strip and something to scan.
  const heads = [
    'con', 'des', 'pre', 'inter', 'trans', 'com', 'ver', 'ent', 'infor', 'organ',
    'nation', 'gener', 'parl', 'citt', 'muda', 'haus', 'arbeit', 'zeit', 'polit', 'econom',
    'sider', 'struct', 'ven', 'form', 'port', 'tract', 'duc', 'mov', 'pens', 'spec',
  ];
  const middles = ['', 'a', 'e', 'i', 'o', 'ar', 'er', 'ir', 'al', 'iz', 'ific', 'ens', 'ul'];
  const endings = [
    '', 's', 'ing', 'ed', 'ation', 'ations', 'ement', 'ements', 'ite', 'ites', 'eur',
    'cion', 'ciones', 'mente', 'ando', 'endo', 'ado', 'ada', 'idad', 'idades',
    'cao', 'coes', 'amento', 'zione', 'zioni', 'ita', 'ung', 'ungen', 'heit', 'lich', 'en',
  ];
  const word = () => choose(heads) + choose(middles) + choose(endings);

  const vocabulary = new Set();
  while (vocabulary.size < 12000) vocabulary.add(word() + (random() < 0.4 ? choose(['', 'x', 'k', 'z']) : ''));
  const vocab = [...vocabulary];
  const pick = () => vocab[Math.floor(vocab.length * Math.pow(random(), 2.2))];

  const name = 'fallback-bench-' + Date.now();
  const store = await openStore({ name });
  console.log('progress vocabulary ready');
  for (let i = 0; i < count; i++) {
    if (i % 250 === 0) console.log('progress indexed ' + i);
    const words = [];
    for (let w = 0; w < 700; w++) words.push(pick());
    await store.putPage({
      url: 'https://site' + (i % 60) + '.example/page-' + i,
      title: 'Page ' + i,
      text: words.join(' '),
      lastSeen: Date.now() - i * 60000,
    });
  }

  // Queries that miss exactly: real-looking inflections the vocabulary never
  // uses, built from the same stems, so every language's stem lands in a
  // crowded neighbourhood and has to be scanned and checked.
  const unusedEndings = ['aremos', 'erions', 'issimo', 'ungens', 'ationen', 'amentes', 'acoes', 'erebbe'];
  const misses = [];
  while (misses.length < 60) {
    const candidate = choose(heads) + choose(middles) + choose(unusedEndings);
    if ((await store.readTerm(candidate)).length === 0 && !misses.includes(candidate)) misses.push(candidate);
  }

  const pct = (arr, p) => {
    const sorted = [...arr].sort((a, b) => a - b);
    return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] * 10) / 10;
  };

  const sets = [
    ['none', []],
    ['en', ['en']],
    ['en de nl (the original three)', ['en', 'de', 'nl']],
    ['the six', ['en', 'es', 'pt', 'de', 'fr', 'it']],
    ['all seven', STEM_LANGUAGES],
  ];

  console.log('progress queries ready');
  const rows = [];
  for (const [label, languages] of sets) {
    console.log('progress measuring ' + label);
    // One warm-up pass so the first set does not pay for a cold cache the
    // others do not.
    for (const query of misses.slice(0, 5)) await search(query, { store, stemLanguages: languages });
    const times = [];
    let widened = 0;
    for (const query of misses) {
      const t0 = performance.now();
      const result = await search(query, { store, stemLanguages: languages });
      times.push(performance.now() - t0);
      if (result.total) widened += 1;
    }
    // Two words, one that misses: the shape of a half remembered phrase.
    const pairs = [];
    for (const query of misses.slice(0, 30)) {
      const t0 = performance.now();
      await search(pick() + ' ' + query, { store, stemLanguages: languages });
      pairs.push(performance.now() - t0);
    }
    rows.push({
      languages: label,
      missP50: pct(times, 0.5),
      missP95: pct(times, 0.95),
      missMax: pct(times, 1),
      found: widened + '/' + misses.length,
      pairP50: pct(pairs, 0.5),
      pairP95: pct(pairs, 0.95),
    });
  }

  const stats = await store.readStats();
  store.close();
  await new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = resolve;
    request.onerror = resolve;
    request.onblocked = resolve;
  });
  return { pages: stats.docCount, vocabulary: vocab.length, rows };
}, pageCount);

await context.close();
console.log('pages ' + report.pages + ', vocabulary ' + report.vocabulary +
  ', every query misses exactly; "found" is how many a fallback still answered\n');
console.table(report.rows);
const six = report.rows.find((row) => row.languages === 'the six');
console.log(
  '\nsix languages, p95 for a word that matches nothing: ' + six.missP95 + 'ms ' +
  (six.missP95 < 100 ? '(inside the 100ms budget)' : '(OVER the 100ms budget)')
);
