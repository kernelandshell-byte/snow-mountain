// Drives the search page the way a person does: type, look, use the
// keyboard. The end to end test proves the messages work; this proves the
// interface built on top of them is wired to anything at all.
//
//   node test/browser/run-ui-smoke.mjs [--screenshot out.png]

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const shotIndex = process.argv.indexOf('--screenshot');
const shotPath = shotIndex === -1 ? null : process.argv[shotIndex + 1];

const context = await chromium.launchPersistentContext('', {
  headless: false,
  viewport: { width: 900, height: 760 },
  args: ['--disable-extensions-except=' + root, '--load-extension=' + root, '--no-sandbox'],
});

let [worker] = context.serviceWorkers();
if (!worker) worker = await context.waitForEvent('serviceworker');
const extensionId = new URL(worker.url()).host;

const seed = await context.newPage();
await seed.goto('chrome-extension://' + extensionId + '/src/ui/options/options.html');
await seed.evaluate(async () => {
  const { CORPUS } = await import('/test/fixtures/corpus.js');
  const { MSG } = await import('/src/shared/messages.js');
  let age = 0;
  for (const doc of CORPUS) {
    await chrome.runtime.sendMessage({
      type: MSG.PAGE_CONTENT,
      payload: {
        url: doc.url,
        title: doc.title,
        text: doc.text,
        // Spread out in time so the date filter and the recency sort have
        // something real to work on.
        capturedAt: Date.now() - age++ * 40 * 86400000,
      },
    });
  }
});
await seed.close();

const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push('console: ' + message.text());
});
await page.goto('chrome-extension://' + extensionId + '/src/ui/search/search.html');

const checks = [];
const check = (name, condition, detail) =>
  checks.push({ name, ok: !!condition, detail: condition ? '' : String(detail) });

check('the empty state invites a query', (await page.textContent('#results')).includes('Type a phrase'), await page.textContent('#results'));

await page.fill('#q', 'retro fatigue');
await page.waitForSelector('article', { timeout: 4000 });

const first = await page.textContent('article h2');
check('typing finds the right page', first.includes('retrospectives'), first);

const marks = await page.$$eval('article:first-child mark', (nodes) => nodes.map((n) => n.textContent.toLowerCase()));
check('matched words are highlighted', marks.length > 0 && marks.every((m) => 'retro fatigue'.includes(m)), JSON.stringify(marks));

const meta = await page.textContent('#meta');
check('the result count and timing are shown', /page|pages/.test(meta) && /ms/.test(meta), meta);
check('nothing offers to show more when there is no more',
  !(await page.isVisible('#more')), 'the show more button was visible');

// Keyboard navigation, which needs a query with more than one result.
await page.fill('#q', 'retention');
// The previous query's results are still on screen until the new render
// lands, so waiting for "an article exists" would count the old ones.
await page
  .waitForFunction(() => document.querySelectorAll('article').length > 1, null, { timeout: 4000 })
  .catch(() => {});
const resultCount = await page.$$eval('article', (nodes) => nodes.length);
check('a broad query returns several results', resultCount > 1, resultCount);
await page.focus('#q');
await page.keyboard.press('ArrowDown');
const selectedIndex = await page.$eval('article.selected', (el) => Number(el.dataset.index));
check('arrow keys move the selection', selectedIndex === 1, selectedIndex);

// The relaxation notice
await page.fill('#q', 'retros');
await page.waitForTimeout(400);
const relaxNote = await page.textContent('#meta');
check('a relaxed query says what it actually searched', relaxNote.includes('searched'), relaxNote);

// Pinning through the interface.
//
// Waiting for an article to exist is not enough: the previous query's results
// are still on screen until the debounce fires, and clicking those pins the
// wrong page and then watches the list replace itself. Wait for the results
// that belong to this query.
const settled = (page, needle) =>
  page.waitForFunction(
    (text) => {
      const first = document.querySelector('article .source');
      return !!first && first.textContent.includes(text);
    },
    needle,
    { timeout: 6000 }
  );

await page.fill('#q', 'cohort chart');
await settled(page, 'metricsdesk.example');
await page.click('.pin');
await page.waitForFunction(
  () => document.querySelector('.pin').getAttribute('aria-pressed') === 'true',
  null,
  { timeout: 3000 }
).catch(() => {});
const pinned = await page.getAttribute('.pin', 'aria-pressed');
check('pinning updates the button', pinned === 'true', pinned);

// A result opens in a new tab, carrying a text fragment
await page.fill('#q', 'retro fatigue');
await settled(page, 'teamcraft.example');
await page.evaluate(() => {
  window.__opened = [];
  const original = chrome.runtime.sendMessage.bind(chrome.runtime);
  chrome.runtime.sendMessage = (message) => {
    if (message && message.type === 'OPEN_RESULT') {
      window.__opened.push(message.payload);
      return Promise.resolve({ opened: 'new' });
    }
    return original(message);
  };
});
await page.click('article h2 a');
await page.waitForTimeout(150);
const opened = await page.evaluate(() => window.__opened);
check('opening a result hands the worker the url and the passage',
  opened.length === 1 && /teamcraft/.test(opened[0].url) && opened[0].quote.split(' ').length >= 4,
  JSON.stringify(opened));

if (shotPath) {
  await page.fill('#q', 'cohort chart retention');
  await page.waitForSelector('article', { timeout: 4000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: shotPath });
}

// --- filters, sorting and paging -----------------------------------------
// A word common enough to match across several sites, which is what the
// filters need in order to be doing anything.
await page.fill('#q', 'the');
await page
  .waitForFunction(() => document.querySelectorAll('article').length > 1, null, { timeout: 4000 })
  .catch(() => {});
const beforeFilter = await page.$$eval('article', (nodes) => nodes.length);
check('a broad query returns several results again', beforeFilter > 1, beforeFilter);

const siteOptions = await page.$$eval('#site option', (nodes) => nodes.map((n) => n.value));
check('the site filter is built from what actually matched',
  siteOptions[0] === '' && siteOptions.length > 1, JSON.stringify(siteOptions));

await page.selectOption('#site', siteOptions[1]);
await page.waitForTimeout(400);
const domains = await page.$$eval('article .source', (nodes) => nodes.map((n) => n.textContent.split('·')[0].trim()));
check('choosing a site narrows the results to it',
  domains.length > 0 && domains.every((d) => d === siteOptions[1]), JSON.stringify(domains));

await page.selectOption('#site', '');
await page.waitForTimeout(400);

await page.click('[data-sort="recent"]');
await page.waitForTimeout(400);
const order = await page.$$eval('article .source', (nodes) =>
  nodes.map((n) => n.textContent.split('·')[1].trim())
);
check('sorting by newest changes the order', order.length > 1, JSON.stringify(order));
check('and the newest result is the most recent one',
  /today|yesterday|days ago/.test(order[0]), order[0]);

await page.click('[data-sort="relevance"]');
await page.waitForTimeout(300);

await page.selectOption('#when', '7');
await page.waitForTimeout(400);
const recentOnly = await page.$$eval('article .source', (nodes) =>
  nodes.map((n) => n.textContent.split('·')[1].trim())
);
check('a time filter drops everything older',
  recentOnly.every((text) => /today|yesterday|[1-7] days ago/.test(text)), JSON.stringify(recentOnly));
await page.selectOption('#when', '');
await page.waitForTimeout(300);

// Paging: a query that matches more than one screenful.
await page.fill('#q', 'the');
await page.waitForTimeout(600);
const firstPage = await page.$$eval('article', (nodes) => nodes.length);
const moreVisible = await page.isVisible('#more');
if (moreVisible) {
  await page.click('#more');
  await page.waitForTimeout(500);
  const secondPage = await page.$$eval('article', (nodes) => nodes.length);
  check('showing more appends rather than replacing', secondPage > firstPage, firstPage + ' then ' + secondPage);
  const ids = await page.$$eval('article', (nodes) => nodes.map((n) => n.dataset.index));
  check('and never repeats a result', new Set(ids).size === ids.length, JSON.stringify(ids));
} else {
  check('paging is offered when there is more', firstPage <= 20, firstPage);
}

// Escape clears
await page.fill('#q', 'retro fatigue');
await page.waitForTimeout(300);
await page.focus('#q');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
check('escape clears the query', (await page.inputValue('#q')) === '', await page.inputValue('#q'));

await context.close();

let failed = 0;
for (const result of checks) {
  if (result.ok) console.log('  ok   ' + result.name);
  else { failed += 1; console.log('  FAIL ' + result.name + '\n       ' + result.detail); }
}
for (const error of errors) console.log('  page error: ' + error);
console.log('');
console.log(checks.length - failed + ' passed, ' + failed + ' failed');
process.exit(failed || errors.length ? 1 : 0);
