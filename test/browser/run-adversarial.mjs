// Deliberately unkind. Everything else in test/browser checks that the thing
// works when used as intended; this one tries to break it.

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGrantedExtension } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const granted = await buildGrantedExtension(root);

const context = await chromium.launchPersistentContext('', {
  headless: false,
  viewport: { width: 900, height: 700 },
  args: ['--disable-extensions-except=' + granted.dir, '--load-extension=' + granted.dir, '--no-sandbox'],
});

let [worker] = context.serviceWorkers();
if (!worker) worker = await context.waitForEvent('serviceworker');
const extensionId = new URL(worker.url()).host;

await context.route('https://fixture.example/**', (route) =>
  route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html><head><title>Fixture</title></head><body><article><h1>Fixture</h1><p>A paragraph about postings buckets and retro fatigue that is long enough to be worth keeping around for a while.</p></article></body></html>',
  })
);

const driver = await context.newPage();
const errors = [];
driver.on('pageerror', (error) => errors.push(String(error)));
await driver.goto('chrome-extension://' + extensionId + '/src/ui/options/options.html');

const ask = (type, payload) =>
  driver.evaluate(
    async ({ t, p }) => {
      const { MSG } = await import('/src/shared/messages.js');
      return chrome.runtime.sendMessage({ type: MSG[t], payload: p });
    },
    { t: type, p: payload }
  );

const checks = [];
const check = (name, condition, detail) =>
  checks.push({ name, ok: !!condition, detail: condition ? '' : String(detail) });

await ask('SETTINGS_SET', { setupComplete: true, mode: 'broad', customRules: [], presets: {} });

// --- content that is not tidy English ------------------------------------
const awkward = [
  { name: 'German with umlauts and a sharp s', url: 'https://de.example/strassen', title: 'Strassenfotografie in Muenchen', text: 'Strassenfotografie lebt davon, dass Menschen sich unbeobachtet fuehlen.' },
  { name: 'right to left text', url: 'https://he.example/a', title: 'RTL', text: 'צילום רחוב הוא תחום מורכב שדורש סבלנות רבה ותשומת לב לפרטים קטנים בסביבה העירונית. לעיתים צריך לחכות שעה שלמה כדי לקבל תמונה אחת שבאמת עובדת.' },
  { name: 'a language without spaces between words', url: 'https://zh.example/a', title: 'CJK', text: '街头摄影是一种记录日常生活的艺术形式，需要耐心和对细节的关注。很多摄影师在城市里长时间等待，只为了一个瞬间。这种拍摄方式没有固定的规则，也没有可以重复的流程，每一次出门都可能一无所获。' },
  { name: 'emoji', url: 'https://emoji.example/a', title: 'Ship it', text: 'We shipped the thing 🚢 and everybody was pleased 🎉 with how it turned out.' },
  { name: 'a page that is one enormous word', url: 'https://blob.example/a', title: 'Blob', text: 'x'.repeat(50000) },
  { name: 'a page of whitespace', url: 'https://blank.example/a', title: 'Blank', text: '   \n\n\t   ' },
  { name: 'a page with no title', url: 'https://untitled.example/a', title: '', text: 'This page never had a title element, which is more common than it should be.' },
  { name: 'a very long page', url: 'https://long.example/a', title: 'Long', text: 'sentence number one about indexing. '.repeat(8000) },
];

for (const item of awkward) {
  let result;
  try {
    result = await ask('PAGE_CONTENT', { url: item.url, title: item.title, text: item.text, capturedAt: Date.now() });
  } catch (error) {
    result = { error: String(error) };
  }
  const expected = item.url.includes('blank') ? result && result.ok === false : result && result.ok === true;
  check('survives ' + item.name, expected, JSON.stringify(result));
}

const afterAwkward = await ask('STATS');
check('the blank page was refused and the rest were kept', afterAwkward.docCount === awkward.length - 1, afterAwkward.docCount);

const germanSharp = await ask('SEARCH', { query: 'straßenfotografie' });
check('a sharp s query finds the page spelled with ss', germanSharp.results.length === 1, germanSharp.results.length);

const hebrewHit = await ask('SEARCH', { query: 'צילום' });
check('right to left text is searchable', hebrewHit.results.length === 1, hebrewHit.results.length);

const emojiHit = await ask('SEARCH', { query: 'shipped' });
check('a page with emoji in it is searchable', emojiHit.results.length === 1, emojiHit.results.length);

const chineseHit = await ask('SEARCH', { query: '街头摄影' });
check('a language without spaces returns something rather than throwing',
  Array.isArray(chineseHit.results), JSON.stringify(chineseHit).slice(0, 120));

// --- queries designed to be annoying --------------------------------------
const nastyQueries = [
  ['an empty query', '   '],
  ['only punctuation', '!!! ... ???'],
  ['an unbalanced quote', '"retro fatigue'],
  ['a site filter with nothing after it', 'site:'],
  ['a date filter full of nonsense', 'after:yesterdayish before:soon'],
  ['a regular expression', '.*+?[](){}|^$'],
  ['a very long query', 'indexing '.repeat(200)],
  ['a single letter', 'a'],
  ['a word that is nowhere', 'zzzzzzzzzz'],
  ['emoji only', '🚢🎉'],
  ['a null byte in the middle', 'retro' + String.fromCharCode(0) + 'fatigue'],
  ['a lone surrogate', 'retro\ud800fatigue'],
];

for (const [name, query] of nastyQueries) {
  let result;
  try {
    result = await ask('SEARCH', { query });
  } catch (error) {
    result = { error: String(error) };
  }
  check('search survives ' + name, result && Array.isArray(result.results), JSON.stringify(result).slice(0, 140));
}

// --- opening a result whose url has a query string ------------------------
const queryUrl = 'https://fixture.example/article?id=7&ref=abc';
const openTab = await context.newPage();
await openTab.goto(queryUrl);
await driver.bringToFront();
const reopened = await ask('OPEN_RESULT', { url: queryUrl, quote: 'A paragraph about postings buckets' });
check('a url with a query string still finds its open tab', reopened.opened === 'existing', JSON.stringify(reopened));
await openTab.close();

// --- how it behaves once there is a lot in there --------------------------
const bulk = [];
for (let i = 0; i < 400; i++) {
  bulk.push({
    url: 'https://bulk.example/page-' + i,
    title: 'Bulk page ' + i,
    text: 'Filler about indexing and retention, page ' + i + '. ' + 'More words to make this realistic. '.repeat(40),
    lastSeen: new Date(Date.now() - i * 3600000).toISOString(),
    firstSeen: new Date(Date.now() - i * 3600000).toISOString(),
    visitCount: 1,
  });
}
for (let i = 0; i < bulk.length; i += 50) {
  await ask('IMPORT', { pages: bulk.slice(i, i + 50) });
}

const statsTiming = await driver.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  const runs = [];
  for (let i = 0; i < 5; i++) {
    const started = performance.now();
    await chrome.runtime.sendMessage({ type: MSG.STATS });
    runs.push(performance.now() - started);
  }
  return Math.round(runs.sort((a, b) => a - b)[2]);
});
console.log('  note  popup stats at 400 pages: ' + statsTiming + 'ms');
check('the popup opens quickly with 400 pages stored, under 150ms', statsTiming < 150, statsTiming + 'ms');

const searchTiming = await driver.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  const started = performance.now();
  await chrome.runtime.sendMessage({ type: MSG.SEARCH, payload: { query: 'retention indexing' } });
  return Math.round(performance.now() - started);
});
console.log('  note  search at 400 pages: ' + searchTiming + 'ms');
check('search stays quick with 400 pages stored, under 200ms', searchTiming < 200, searchTiming + 'ms');

// --- everything at once ----------------------------------------------------
const concurrent = await driver.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  const results = await Promise.all([
    chrome.runtime.sendMessage({ type: MSG.SEARCH, payload: { query: 'indexing' } }),
    chrome.runtime.sendMessage({ type: MSG.PAGE_CONTENT, payload: { url: 'https://race.example/a', title: 'Race A', text: 'A page written while other things were happening at the same time.', capturedAt: Date.now() } }),
    chrome.runtime.sendMessage({ type: MSG.PAGE_CONTENT, payload: { url: 'https://race.example/b', title: 'Race B', text: 'Another page written at exactly the same moment as the first one.', capturedAt: Date.now() } }),
    chrome.runtime.sendMessage({ type: MSG.STATS }),
    chrome.runtime.sendMessage({ type: MSG.RECENT, payload: { limit: 5 } }),
    chrome.runtime.sendMessage({ type: MSG.SEARCH, payload: { query: 'retention' } }),
  ]);
  const after = await chrome.runtime.sendMessage({ type: MSG.SEARCH, payload: { query: 'exactly the same moment' } });
  return { ok: results.every(Boolean), found: after.results.length };
});
check('six things at once all come back', concurrent.ok, JSON.stringify(concurrent));
check('and both pages written during that survived', concurrent.found === 1, concurrent.found);

// --- the same page captured twice at once ---------------------------------
const doubled = await driver.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  const payload = { url: 'https://double.example/a', title: 'Doubled', text: 'The same page arriving twice because two things asked for it at once.', capturedAt: Date.now() };
  await Promise.all([
    chrome.runtime.sendMessage({ type: MSG.PAGE_CONTENT, payload }),
    chrome.runtime.sendMessage({ type: MSG.PAGE_CONTENT, payload }),
  ]);
  const found = await chrome.runtime.sendMessage({ type: MSG.SEARCH, payload: { query: 'arriving twice because' } });
  return found.results.length;
});
check('capturing the same page twice at once stores it once', doubled === 1, doubled);

// --- import that is full of rubbish ---------------------------------------
const junkImport = await ask('IMPORT', {
  pages: [
    { url: 'https://ok.example/a', title: 'Fine', text: 'A perfectly ordinary page that should import without any trouble at all.' },
    { url: 'not a url', title: 'Bad url', text: 'Some text' },
    { url: 'https://nope.example/a', title: 'No text' },
    null,
    { title: 'No url', text: 'Some text' },
    { url: 'chrome://extensions', title: 'Internal', text: 'Some text' },
    { url: 'https://dates.example/a', title: 'Bad dates', text: 'A page whose dates are unparseable rubbish.', lastSeen: 'not-a-date', firstSeen: 'also-not', visitCount: 'seven' },
  ],
});
check('a junk import keeps what it can and counts the rest',
  junkImport.imported === 2 && junkImport.failed === 5, JSON.stringify(junkImport));

const badDates = await driver.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  const recent = await chrome.runtime.sendMessage({ type: MSG.RECENT, payload: { limit: 60 } });
  return recent.find((p) => p.url.includes('dates.example'));
});
check('unparseable dates become a real date rather than NaN',
  badDates && Number.isFinite(badDates.lastSeen) && Number.isFinite(badDates.firstSeen),
  JSON.stringify(badDates && { lastSeen: badDates.lastSeen, firstSeen: badDates.firstSeen }));

// --- a tab open on a messier version of the same url -----------------------
// Tracking parameters are noise, so a tab carrying them is the same page.
const messy = await context.newPage();
await messy.goto('https://fixture.example/article?id=7&utm_source=newsletter&utm_campaign=x');
await driver.bringToFront();
const messyResult = await ask('OPEN_RESULT', {
  url: 'https://fixture.example/article?id=7',
  quote: 'A paragraph about postings buckets',
});
check('a tab carrying tracking parameters is still recognised as the same page',
  messyResult.opened === 'existing', JSON.stringify(messyResult));
await messy.close();

// A parameter that is not noise means a different page, and must not be
// treated as the same one.
const otherPage = await context.newPage();
await otherPage.goto('https://fixture.example/article?id=99');
await driver.bringToFront();
const differentResult = await ask('OPEN_RESULT', {
  url: 'https://fixture.example/article?id=7',
  quote: 'A paragraph about postings buckets',
});
check('a genuinely different page is not mistaken for the open one',
  differentResult.opened === 'new', JSON.stringify(differentResult));
await otherPage.close();

// --- the worker being stopped underneath everything -----------------------
// Manifest V3 stops the background worker whenever it looks idle, which is
// the single most common source of "it worked in development" bugs.
const cdp = await context.newCDPSession(driver);
await cdp.send('ServiceWorker.enable');
await cdp.send('ServiceWorker.stopAllWorkers');
await driver.waitForTimeout(1200);

const afterRestart = await driver.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  const stats = await chrome.runtime.sendMessage({ type: MSG.STATS });
  const found = await chrome.runtime.sendMessage({ type: MSG.SEARCH, payload: { query: 'retention indexing' } });
  const stored = await chrome.runtime.sendMessage({
    type: MSG.PAGE_CONTENT,
    payload: { url: 'https://afterstop.example/a', title: 'After the stop', text: 'A page captured after the background worker was stopped and had to start again.', capturedAt: Date.now() },
  });
  const settings = await chrome.runtime.sendMessage({ type: MSG.SETTINGS_GET });
  return { docCount: stats.docCount, hits: found.results.length, stored, mode: settings.mode };
});
check('the worker comes back and still knows how many pages there are',
  afterRestart.docCount > 0, JSON.stringify(afterRestart));
check('search works after a restart', afterRestart.hits > 0, afterRestart.hits);
check('capture works after a restart', afterRestart.stored && afterRestart.stored.ok === true, JSON.stringify(afterRestart.stored));
check('settings survived the restart', afterRestart.mode === 'broad', afterRestart.mode);

// --- eviction when everything is pinned -----------------------------------
await driver.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  const recent = await chrome.runtime.sendMessage({ type: MSG.RECENT, payload: { limit: 600 } });
  for (const page of recent) {
    await chrome.runtime.sendMessage({ type: MSG.PIN, payload: { id: page.id, pinned: true } });
  }
  await chrome.runtime.sendMessage({ type: MSG.SETTINGS_SET, payload: { sizeCapBytes: 1000, retentionMonths: 0 } });
});
const sweep = await ask('MAINTENANCE');
const afterSweep = await ask('STATS');
check('a sweep with everything pinned removes nothing', sweep.evicted === 0, JSON.stringify(sweep));
check('and nothing was lost', afterSweep.docCount > 0, afterSweep.docCount);

await context.close();
await granted.cleanup();

let failed = 0;
for (const result of checks) {
  if (result.ok) console.log('  ok   ' + result.name);
  else { failed += 1; console.log('  FAIL ' + result.name + '\n       ' + result.detail); }
}
for (const error of errors) console.log('  page error: ' + error);
console.log('');
console.log(checks.length - failed + ' passed, ' + failed + ' failed');
process.exit(failed || errors.length ? 1 : 0);
