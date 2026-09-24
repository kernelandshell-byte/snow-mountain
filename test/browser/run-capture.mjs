// The full capture path, which nothing else exercises: a real page, the
// observer measuring real dwell and scrolling, the worker deciding, the
// extractor injected into the tab, and a record landing in the index.
//
// Slow by nature. A page has to hold attention for several seconds before it
// counts as read, and that wait is the thing being tested.

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGrantedExtension } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const granted = await buildGrantedExtension(root);

const ARTICLE = 'Retro fatigue sets in when the same problems are raised every fortnight and nothing changes.';
const body = Array.from({ length: 30 }, (_, i) =>
  '<p>Paragraph ' + (i + 1) + ' of an article long enough that reading it involves scrolling, which is what the observer is watching for.</p>'
).join('\n');

const page = (extra = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Why teams stop running retrospectives</title></head>
<body>
  <nav><a href="/">Home</a><a href="/pricing">Pricing</a></nav>
  ${extra}
  <article><h1>Why teams stop running retrospectives</h1><p>${ARTICLE}</p>${body}</article>
  <footer>Copyright and a modern slavery statement nobody reads.</footer>
</body></html>`;

const context = await chromium.launchPersistentContext('', {
  headless: false,
  viewport: { width: 900, height: 700 },
  args: ['--disable-extensions-except=' + granted.dir, '--load-extension=' + granted.dir, '--no-sandbox'],
});

let [worker] = context.serviceWorkers();
if (!worker) worker = await context.waitForEvent('serviceworker');
const extensionId = new URL(worker.url()).host;

await context.route('**/*', (route) => {
  const url = route.request().url();
  if (!/^https?:/.test(url)) return route.continue();
  const login = url.includes('login') ? '<form><input type="password" name="p" /></form>'
    : url.includes('checkout') ? '<form><input autocomplete="cc-number" name="n" /></form>'
    : url.includes('paywidget') ? '<iframe src="https://js.stripe.com/v3/elements-inner.html"></iframe>'
    : url.includes('camelcase') ? '<form><input type="text" name="otpCode" /></form>'
    : url.includes('productpage') ? '<iframe src="https://js.stripe.com/v3/controller-x.html" ' +
      'style="visibility:hidden;position:fixed;width:1px;height:1px"></iframe>' +
      '<iframe src="https://www.paypal.com/smart/buttons?x=1"></iframe>'
    : url.includes('shadowlogin') ? '<div id="host"></div><script>document.getElementById("host")' +
      '.attachShadow({ mode: "open" }).innerHTML = \'<input type="password">\';</script>'
    : '';
  // Each path gets a distinguishing sentence, so two captures can be told
  // apart by what is in them rather than only by their address.
  const marker = '<p>Path marker ' + new URL(url).pathname.replace(/[^a-z-]/g, '') + ' appears here.</p>';
  route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: page(login + marker) });
});

const checks = [];
const check = (name, condition, detail) =>
  checks.push({ name, ok: !!condition, detail: condition ? '' : String(detail) });

const driver = await context.newPage();
await driver.goto('chrome-extension://' + extensionId + '/src/ui/options/options.html');
const ask = (type, payload) =>
  driver.evaluate(
    async ({ t, p }) => {
      const { MSG } = await import('/src/shared/messages.js');
      return chrome.runtime.sendMessage({ type: MSG[t], payload: p });
    },
    { t: type, p: payload }
  );

await ask('SETTINGS_SET', {
  setupComplete: true,
  mode: 'broad',
  presets: { banking: true },
  customRules: ['excluded.example'],
});

// Reading a page: open it, look at it, scroll it, keep looking.
async function read(url, seconds = 14) {
  const tab = await context.newPage();
  await tab.goto(url);
  await tab.bringToFront();
  const started = Date.now();
  while (Date.now() - started < seconds * 1000) {
    await tab.mouse.wheel(0, 400);
    await tab.waitForTimeout(1000);
  }
  return tab;
}

const tab = await read('https://reader.example/retro-fatigue');
await driver.bringToFront();
await driver.waitForTimeout(1500);

const status = await ask('PAGE_STATUS', { url: 'https://reader.example/retro-fatigue' });
check('a page that was actually read gets kept', status.kept !== null, JSON.stringify(status));

const found = await ask('SEARCH', { query: 'retro fatigue fortnight' });
check('and is findable straight away', found.results.length === 1, JSON.stringify(found.results.map((r) => r.url)));
check('by the sentence it was read for',
  found.results[0] && /Retro fatigue/.test(found.results[0].snippet.text),
  found.results[0] && found.results[0].snippet.text);

const stored = await driver.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  const recent = await chrome.runtime.sendMessage({ type: MSG.RECENT, payload: { limit: 1 } });
  return recent[0];
});
check('the stored text is the article, not the chrome around it',
  stored.text.includes(ARTICLE) && !/modern slavery/i.test(stored.text) && !/Pricing/.test(stored.text),
  stored.text.slice(0, 160));
check('the title came from the page', /Why teams stop/.test(stored.title), stored.title);
await tab.close();

// A page with a password field on it is never captured, in any mode.
const loginTab = await read('https://reader.example/login', 14);
await driver.bringToFront();
await driver.waitForTimeout(1200);
const loginStatus = await ask('PAGE_STATUS', { url: 'https://reader.example/login' });
check('a page with a password field is not captured', loginStatus.kept === null, JSON.stringify(loginStatus));
await loginTab.close();

// Not only a password field: a card number, an embedded payment form, and a
// password field hidden inside a shadow root all count.
for (const [path, what] of [
  ['/checkout', 'a card number field'],
  ['/paywidget', 'an embedded payment form'],
  ['/shadowlogin', 'a password field inside a shadow root'],
  ['/camelcase', 'a one-time code field named in camelCase'],
]) {
  const sensitiveTab = await read('https://reader.example' + path, 14);
  await driver.bringToFront();
  await driver.waitForTimeout(1200);
  const status = await ask('PAGE_STATUS', { url: 'https://reader.example' + path });
  check('a page with ' + what + ' is not captured', status.kept === null, JSON.stringify(status));
  if (sensitiveTab) await sensitiveTab.close();
}

// A page that merely loads a payment script, or shows a pay button, is not
// a payment form.
const productTab = await read('https://reader.example/productpage', 14);
await driver.bringToFront();
await driver.waitForTimeout(1200);
const productStatus = await ask('PAGE_STATUS', { url: 'https://reader.example/productpage' });
check('a page with only hidden payment helpers and a pay button is captured', productStatus.kept !== null,
  JSON.stringify(productStatus));
await productTab.close();

// An excluded domain is never captured either.
const excludedTab = await read('https://excluded.example/article', 14);
await driver.bringToFront();
await driver.waitForTimeout(1200);
const excludedStatus = await ask('PAGE_STATUS', { url: 'https://excluded.example/article' });
check('an excluded site is not captured', excludedStatus.kept === null, JSON.stringify(excludedStatus));
check('and the reason says which rule stopped it', /excluded/.test(excludedStatus.reason), excludedStatus.reason);
await excludedTab.close();

// A glance is not reading.
const glance = await context.newPage();
await glance.goto('https://reader.example/glanced-at');
await glance.bringToFront();
await glance.waitForTimeout(3000);
await glance.close();
await driver.bringToFront();
await driver.waitForTimeout(1000);
const glanceStatus = await ask('PAGE_STATUS', { url: 'https://reader.example/glanced-at' });
check('a page glanced at for three seconds is not kept', glanceStatus.kept === null, JSON.stringify(glanceStatus));

const finalStats = await ask('STATS');
check('only the two pages that should be were kept', finalStats.docCount === 2, finalStats.docCount);

// --- pause actually pauses -------------------------------------------------
await ask('SETTINGS_SET', { pausedUntil: Date.now() + 3600000 });
const pausedTab = await read('https://reader.example/while-paused', 14);
await driver.bringToFront();
await driver.waitForTimeout(1200);
const pausedStatus = await ask('PAGE_STATUS', { url: 'https://reader.example/while-paused' });
check('nothing is captured while paused', pausedStatus.kept === null, JSON.stringify(pausedStatus));
check('and the popup says why', /paused/.test(pausedStatus.reason), pausedStatus.reason);
await pausedTab.close();
await ask('SETTINGS_SET', { pausedUntil: 0 });

// --- a rule added mid session takes effect straight away -------------------
await ask('SETTINGS_SET', { customRules: ['excluded.example', 'banned.example'] });
const bannedTab = await read('https://banned.example/article', 14);
await driver.bringToFront();
await driver.waitForTimeout(1200);
const bannedStatus = await ask('PAGE_STATUS', { url: 'https://banned.example/article' });
check('a rule added while running blocks capture immediately', bannedStatus.kept === null, JSON.stringify(bannedStatus));
await bannedTab.close();

// --- a single page app changing route without navigating -------------------
const spa = await context.newPage();
await spa.goto('https://reader.example/spa-first');
await spa.bringToFront();
for (let i = 0; i < 14; i++) {
  await spa.mouse.wheel(0, 400);
  await spa.waitForTimeout(1000);
}
// The route changes and the article is replaced, with no navigation at all.
await spa.evaluate(() => {
  history.pushState({}, '', '/spa-second');
  document.querySelector('article').innerHTML =
    '<h1>The second view</h1><p>Path marker spa-second appears here, on a view that was never loaded as a document.</p>';
});
for (let i = 0; i < 14; i++) {
  await spa.mouse.wheel(0, 400);
  await spa.waitForTimeout(1000);
}
await driver.bringToFront();
await driver.waitForTimeout(1500);

const firstView = await ask('PAGE_STATUS', { url: 'https://reader.example/spa-first' });
const secondView = await ask('PAGE_STATUS', { url: 'https://reader.example/spa-second' });
check('the first view of a single page app is kept', firstView.kept !== null, JSON.stringify(firstView));
check('and the second view is kept as its own page',
  secondView.kept !== null && secondView.kept.id !== (firstView.kept && firstView.kept.id),
  JSON.stringify({ first: firstView.kept, second: secondView.kept }));
const spaHit = await ask('SEARCH', { query: 'never loaded as a document' });
check('the second view is searchable by what was on it', spaHit.results.length === 1, JSON.stringify(spaHit.results.map((r) => r.url)));
await spa.close();

// A content script runs inside the page it reads. Whatever it can send, a
// page that compromised its own renderer could send too, so it gets the
// three capture messages and nothing else.
const before = await ask('STATS');
const hostile = await context.newPage();
await hostile.goto('https://hostile.example/article');
await driver.bringToFront();
const fromPage = await driver.evaluate(async () => {
  const [tab] = await chrome.tabs.query({ url: 'https://hostile.example/*' });
  const [run] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: async () => {
      const attempt = (type, payload) =>
        chrome.runtime.sendMessage({ type, payload }).then(
          (answer) => ({ answered: answer !== undefined, answer }),
          (error) => ({ answered: false, error: String(error.message || error) })
        );
      return {
        wipe: await attempt('WIPE'),
        exportAll: await attempt('EXPORT', { afterId: 0, limit: 5 }),
        settings: await attempt('SETTINGS_SET', { setupComplete: false }),
        acknowledge: await attempt('ACKNOWLEDGE', { what: 'settings' }),
        search: await attempt('SEARCH', { query: 'retrospectives' }),
        forged: await attempt('PAGE_CONTENT', {
          url: 'https://yourbank.example/statement',
          title: 'Statement',
          text: 'Forged statement text planted by another page, long enough to pass the length floor easily.',
          explicit: true,
        }),
      };
    },
  });
  return run.result;
});
await hostile.close();
check('a content script cannot delete everything', !fromPage.wipe.answered, JSON.stringify(fromPage.wipe));
check('or read the archive out', !fromPage.exportAll.answered && !fromPage.search.answered,
  JSON.stringify([fromPage.exportAll, fromPage.search]));
check('or change the settings', !fromPage.settings.answered && !fromPage.acknowledge.answered,
  JSON.stringify([fromPage.settings, fromPage.acknowledge]));
check('or file text under another site\'s address',
  fromPage.forged.answered && fromPage.forged.answer.ok === false &&
    /does not match/.test(fromPage.forged.answer.reason),
  JSON.stringify(fromPage.forged));
const forgedHit = await ask('SEARCH', { query: 'forged statement' });
check('and nothing forged is searchable', forgedHit.total === 0, JSON.stringify(forgedHit.results.map((r) => r.url)));

// Text arriving from a page is held to the policy again, not only the
// decision that it was worth keeping: an excluded site cannot hand text
// over directly.
const directTab = await context.newPage();
await directTab.goto('https://excluded.example/notes');
await driver.bringToFront();
const fromExcluded = await driver.evaluate(async () => {
  const [tab] = await chrome.tabs.query({ url: 'https://excluded.example/*' });
  const [run] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => chrome.runtime.sendMessage({
      type: 'PAGE_CONTENT',
      payload: {
        url: location.href,
        title: 'Private notes',
        text: 'Private notes from a site on the exclusion list, which should never reach the archive at all.',
        explicit: true,
      },
    }),
  });
  return run.result;
});
await directTab.close();
check('an excluded site cannot hand its text over directly',
  fromExcluded && fromExcluded.ok === false, JSON.stringify(fromExcluded));

const after = await ask('STATS');
const settingsAfter = await ask('SETTINGS_GET');
check('and the archive and settings are exactly as they were',
  after.docCount === before.docCount && settingsAfter.setupComplete === true,
  JSON.stringify({ before: before.docCount, after: after.docCount, setup: settingsAfter.setupComplete }));
const acknowledged = await ask('ACKNOWLEDGE', { what: 'settings' });
const stillSet = await ask('SETTINGS_GET');
check('even settings itself can only acknowledge a notice, not erase the settings',
  acknowledged.ok === false && stillSet.setupComplete === true, JSON.stringify(acknowledged));

await context.close();
await granted.cleanup();

let failed = 0;
for (const result of checks) {
  if (result.ok) console.log('  ok   ' + result.name);
  else { failed += 1; console.log('  FAIL ' + result.name + '\n       ' + result.detail); }
}
console.log('');
console.log(checks.length - failed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
