// Churns the store with a randomised but reproducible sequence of writes,
// then opens the database directly and checks the things that must always be
// true. Silent index drift is the worst failure this project could have: it
// would not throw, it would just quietly stop finding pages, or start
// returning ones that no longer contain the word.

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const report = await page.evaluate(async (operations) => {
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

  // Now read the database directly and check the invariants.
  const db = await openDatabase({ name });
  const readAll = (storeName) =>
    new Promise((resolve, reject) => {
      const request = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

  const pages = await readAll('pages');
  const postings = await readAll('postings');
  const meta = await readAll('meta');
  const stats = meta.find((row) => row.key === 'stats');

  const problems = [];

  if (stats.docCount !== pages.length) {
    problems.push('docCount says ' + stats.docCount + ' but there are ' + pages.length + ' pages');
  }
  const realBytes = pages.reduce((sum, p) => sum + (p.bytes || 0), 0);
  if (stats.totalBytes !== realBytes) {
    problems.push('totalBytes says ' + stats.totalBytes + ' but the pages add up to ' + realBytes);
  }
  const realTokens = pages.reduce((sum, p) => sum + (p.wordCount || 0), 0);
  if (stats.totalTokens !== realTokens) {
    problems.push('totalTokens says ' + stats.totalTokens + ' but the pages add up to ' + realTokens);
  }

  const liveIds = new Set(pages.map((p) => p.id));
  let orphanEntries = 0;
  let emptyRecords = 0;
  const indexed = new Map(); // id -> Set(terms)
  for (const record of postings) {
    if (!record.docs.length) emptyRecords += 1;
    for (const entry of record.docs) {
      if (!liveIds.has(entry.id)) {
        orphanEntries += 1;
        continue;
      }
      if (!indexed.has(entry.id)) indexed.set(entry.id, new Set());
      indexed.get(entry.id).add(record.term);
      if (bucketOf(entry.id) !== record.bucket) {
        problems.push('page ' + entry.id + ' is filed in bucket ' + record.bucket);
      }
    }
  }
  if (orphanEntries) problems.push(orphanEntries + ' postings point at pages that no longer exist');
  if (emptyRecords) problems.push(emptyRecords + ' posting records are empty and should have been removed');

  // Every word of every live page has to be findable, and nothing else.
  let missingTerms = 0;
  let extraTerms = 0;
  for (const record of pages) {
    const expected = new Set(tokenize((record.title || '') + '\n\n' + (record.text || '')).map((t) => t.term));
    const actual = indexed.get(record.id) || new Set();
    for (const term of expected) if (!actual.has(term)) missingTerms += 1;
    for (const term of actual) if (!expected.has(term)) extraTerms += 1;
  }
  if (missingTerms) problems.push(missingTerms + ' words of live pages are missing from the index');
  if (extraTerms) problems.push(extraTerms + ' words are indexed for pages that no longer contain them');

  store.close();
  db.close();
  await new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = resolve;
    request.onerror = resolve;
    request.onblocked = resolve;
  });

  return {
    operations,
    pages: pages.length,
    postingRecords: postings.length,
    writes: log.filter((l) => l.startsWith('put')).length,
    deletes: log.filter((l) => l.startsWith('delete')).length,
    problems,
  };
}, OPERATIONS);

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
