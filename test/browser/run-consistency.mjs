// Churns the store with a randomised but reproducible sequence of writes,
// then opens the database directly and checks the things that must always be
// true. Silent index drift is the worst failure this project could have: it
// would not throw, it would just quietly stop finding pages, or start
// returning ones that no longer contain the word.

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { invariantCheck } from './invariants.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OPERATIONS = Number(process.argv[2] || 300);

const context = await chromium.launchPersistentContext('', {
  headless: false,
  args: ['--disable-extensions-except=' + root, '--load-extension=' + root, '--no-sandbox'],
});

let [worker] = context.serviceWorkers();
if (!worker) worker = await context.waitForEvent('serviceworker');
const extensionId = new URL(worker.url()).host;

const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
await page.goto('chrome-extension://' + extensionId + '/src/ui/options/options.html');

const churn = await page.evaluate(async (operations) => {
  const { openStore, openDatabase } = await import('/src/db/idb-store.js');
  const { tokenize } = await import('/src/core/tokenizer.js');
  const { bucketOf } = await import('/src/core/index-writer.js');

  // Reproducible randomness, so a failure can be repeated.
  let seed = 20260907;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const pick = (list) => list[Math.floor(random() * list.length)];

  const vocabulary = 'index retention cohort churn retro fatigue meeting standup extraction permission budget eviction snippet posting bucket worker fragment quote passage relevance'.split(' ');
  const sentence = () => {
    const words = [];
    for (let i = 0; i < 40 + Math.floor(random() * 200); i++) words.push(pick(vocabulary));
    return words.join(' ') + '.';
  };

  const name = 'consistency-' + Date.now();
  const store = await openStore({ name });

  const urls = [];
  for (let i = 0; i < 40; i++) urls.push('https://site' + (i % 6) + '.example/page-' + i);

  const log = [];
  for (let i = 0; i < operations; i++) {
    const url = pick(urls);
    const roll = random();
    if (roll < 0.55) {
      // Write, sometimes the same content again and sometimes new content.
      await store.putPage({
        url,
        title: 'Page about ' + pick(vocabulary),
        text: sentence(),
        lastSeen: Date.now() - Math.floor(random() * 1e9),
      });
      log.push('put ' + url);
    } else if (roll < 0.7) {
      // Rewrite with identical content, which must not change any total.
      await store.putPage({ url, title: 'Stable', text: 'A page whose content never changes at all.' });
      log.push('stable ' + url);
    } else if (roll < 0.85) {
      const existing = await store.getPageByUrl(url);
      if (existing) {
        await store.deletePages([existing.id]);
        log.push('delete ' + url);
      }
    } else {
      const existing = await store.getPageByUrl(url);
      if (existing) {
        await store.setPinned(existing.id, random() < 0.5);
        log.push('pin ' + url);
      }
    }
  }

  store.close();
  return {
    name,
    writes: log.filter((l) => l.startsWith('put')).length,
    deletes: log.filter((l) => l.startsWith('delete')).length,
  };
}, OPERATIONS);

const invariants = await page.evaluate(invariantCheck, churn.name);

await page.evaluate(async (name) => {
  await new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = resolve;
    request.onerror = resolve;
    request.onblocked = resolve;
  });
}, churn.name);

const report = { operations: OPERATIONS, ...churn, ...invariants };

await context.close();

console.log('  ' + report.operations + ' operations, ' + report.writes + ' writes, ' + report.deletes + ' deletes');
console.log('  ended with ' + report.pages + ' pages across ' + report.postingRecords + ' posting records');
console.log('');
if (report.problems.length) {
  for (const problem of report.problems) console.log('  FAIL ' + problem);
} else {
  console.log('  ok   totals match the pages that exist');
  console.log('  ok   no postings point at deleted pages');
  console.log('  ok   no empty posting records left behind');
  console.log('  ok   every page is filed in the bucket its id belongs to');
  console.log('  ok   every word of every page is findable, and nothing else is');
}
for (const error of errors) console.log('  page error: ' + error);
console.log('');
console.log(report.problems.length ? report.problems.length + ' problems' : 'no inconsistencies found');
process.exit(report.problems.length || errors.length ? 1 : 0);
