// Is the storage meter telling the truth?
//
// The budget is the promise this extension makes about its footprint: "use at
// most 500MB" is a sentence in the settings screen, the meter is on the popup,
// and eviction is enforced against the number behind both. If that number is
// not what is on disk, then the promise, the meter and the sweep are all
// wrong together and nothing in the interface can tell you.
//
// It was wrong. `bytes` counted the stored text and nothing else, so the meter
// reported about a fifth of what the archive actually occupied and a 500MB cap
// was really a 2.4GB one. The index is most of an archive, not a rounding
// error on it.
//
// This weighs the two stores by serialising every record, which is
// deterministic; navigator.storage.estimate() is approximate, includes things
// that are not ours, and moved by a factor of two between two runs of the same
// benchmark, so it cannot settle anything.
//
//   node test/browser/run-storage.mjs

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const context = await chromium.launchPersistentContext('', {
  headless: false,
  args: ['--disable-extensions-except=' + root, '--load-extension=' + root, '--no-sandbox'],
});
let [worker] = context.serviceWorkers();
if (!worker) worker = await context.waitForEvent('serviceworker');
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
await page.goto('chrome-extension://' + new URL(worker.url()).host + '/src/ui/options/options.html');

const checks = [];
const check = (name, condition, detail) => {
  const result = { name, ok: !!condition, detail: condition ? '' : String(detail) };
  checks.push(result);
  console.log(result.ok ? '  ok   ' + name : '  FAIL ' + name + '\n       ' + result.detail);
};
const note = (text) => console.log('  note  ' + text);

const report = await page.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  const { openDatabase } = await import('/src/db/idb-store.js');

  // A vocabulary the size of real prose. A synthetic corpus of thirty words
  // compresses into almost no index at all, and would answer the question
  // flatteringly and wrongly.
  const vocabulary = [];
  for (let i = 0; i < 6000; i++) vocabulary.push('term' + i);
  let seed = 4242;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  // Zipf-ish, so a few terms are everywhere and most are rare, which is what
  // makes posting list sizes realistic.
  const word = () =>
    vocabulary[Math.min(vocabulary.length - 1, Math.floor(vocabulary.length * Math.pow(random(), 3)))];

  const weigh = async () => {
    const db = await openDatabase({});
    const readAll = (name) =>
      new Promise((resolve, reject) => {
        const request = db.transaction(name, 'readonly').objectStore(name).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    const size = (rows) => {
      let total = 0;
      for (const row of rows) total += new Blob([JSON.stringify(row)]).size;
      return total;
    };
    const pageRows = await readAll('pages');
    const postingRows = await readAll('postings');
    let entries = 0;
    for (const row of postingRows) entries += row.docs.length;
    const result = {
      pageBytes: size(pageRows),
      indexBytes: size(postingRows),
      postingRecords: postingRows.length,
      entries,
    };
    db.close();
    return result;
  };

  const out = { steps: [], shapes: [] };
  let made = 0;
  for (const target of [500, 1000, 2000]) {
    const batch = [];
    for (; made < target; made++) {
      const words = [];
      for (let w = 0; w < 340; w++) words.push(word());
      batch.push({
        url: 'https://truth' + (made % 40) + '.example/page-' + made,
        title: 'Page ' + made + ' about ' + word(),
        text: words.join(' ') + ' truthneedle' + made,
        firstSeen: new Date(Date.now() - made * 60000).toISOString(),
        lastSeen: new Date(Date.now() - made * 60000).toISOString(),
      });
      if (batch.length >= 50) {
        await chrome.runtime.sendMessage({ type: MSG.IMPORT, payload: { pages: batch.splice(0) } });
      }
    }
    if (batch.length) await chrome.runtime.sendMessage({ type: MSG.IMPORT, payload: { pages: batch } });

    const stats = await chrome.runtime.sendMessage({ type: MSG.STATS });
    const weighed = await weigh();
    out.steps.push({
      pages: stats.docCount,
      meter: stats.usedBytes,
      ...weighed,
      stored: weighed.pageBytes + weighed.indexBytes,
    });
  }

  // Page shapes that are nothing like prose, where an estimate built on prose
  // could be wildly wrong in either direction.
  const shapes = [
    { name: 'one word, fifteen thousand times', text: ('drumbeat ').repeat(15000) },
    { name: 'no word used twice', text: Array.from({ length: 4000 }, (_, i) => 'unique' + i).join(' ') },
    { name: 'a very long page', text: Array.from({ length: 20000 }, () => word()).join(' ') },
  ];
  for (const shape of shapes) {
    const before = await weigh();
    const beforeStats = await chrome.runtime.sendMessage({ type: MSG.STATS });
    await chrome.runtime.sendMessage({
      type: MSG.PAGE_CONTENT,
      payload: { url: 'https://shape.example/' + encodeURIComponent(shape.name), title: shape.name, text: shape.text, capturedAt: Date.now() },
    });
    const after = await weigh();
    const afterStats = await chrome.runtime.sendMessage({ type: MSG.STATS });
    out.shapes.push({
      name: shape.name,
      meter: afterStats.usedBytes - beforeStats.usedBytes,
      stored: (after.pageBytes + after.indexBytes) - (before.pageBytes + before.indexBytes),
    });
  }

  return out;
});

console.log('');
console.log('  pages     meter   page records      index      total    the meter counts');
for (const row of report.steps) {
  const mb = (n) => (n / 1048576).toFixed(1) + 'MB';
  console.log(
    '  ' + String(row.pages).padStart(5) +
    String(mb(row.meter)).padStart(10) +
    String(mb(row.pageBytes)).padStart(15) +
    String(mb(row.indexBytes)).padStart(11) +
    String(mb(row.stored)).padStart(11) +
    String(Math.round((row.meter / row.stored) * 100) + '%').padStart(20)
  );
}
console.log('');

const last = report.steps[report.steps.length - 1];
note('the index is ' + Math.round((last.indexBytes / last.pageBytes) * 100) +
  '% of the page records it indexes, so it is most of an archive rather than a rounding error');
note(Math.round(last.stored / last.pages) + ' bytes per page stored, meter says ' +
  Math.round(last.meter / last.pages));

for (const row of report.steps) {
  const ratio = row.meter / row.stored;
  check(
    'at ' + row.pages + ' pages the meter is within a tenth of what is stored',
    ratio > 0.9 && ratio < 1.15,
    'the meter says ' + Math.round(ratio * 100) + '% of the real size'
  );
}

const ratios = report.steps.map((row) => row.meter / row.stored);
check('and does not drift as the archive grows',
  Math.max(...ratios) - Math.min(...ratios) < 0.08,
  ratios.map((r) => r.toFixed(2)).join(' then '));

console.log('');
for (const shape of report.shapes) {
  const ratio = shape.meter / shape.stored;
  note(shape.name + ': meter ' + Math.round(shape.meter / 1024) + 'KB against ' +
    Math.round(shape.stored / 1024) + 'KB stored');
  check('a page that is ' + shape.name + ' is not wildly mis-counted',
    ratio > 0.6 && ratio < 1.8,
    'the meter says ' + Math.round(ratio * 100) + '% of what it cost');
}

// And the number the setup and settings screens use to turn a megabyte cap
// into a number of pages has to agree with all of the above, or the interface
// contradicts itself in two places at once.
const estimate = await page.evaluate(async () => {
  const { BYTES_PER_PAGE_ESTIMATE } = await import('/src/shared/constants.js');
  return BYTES_PER_PAGE_ESTIMATE;
});
const realPerPage = last.stored / last.pages;
note('"room for roughly N pages" assumes ' + Math.round(estimate / 1024) + 'KB a page; measured ' +
  Math.round(realPerPage / 1024) + 'KB on a 340 word corpus');
check('the page estimate the interface quotes is in the same world as the meter',
  estimate > realPerPage * 0.6 && estimate < realPerPage * 2.5,
  estimate + ' against a measured ' + Math.round(realPerPage));

await context.close();

const failed = checks.filter((result) => !result.ok).length;
console.log('');
for (const error of errors) console.log('  page error: ' + error);
console.log(checks.length - failed + ' passed, ' + failed + ' failed');
process.exit(failed || errors.length ? 1 : 0);
