// The popup, which is where a person sees and changes what is happening to
// the page in front of them. Driven as a normal extension page with a tab
// query stubbed, because a popup cannot be opened by automation.

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const context = await chromium.launchPersistentContext('', {
  headless: false,
  viewport: { width: 420, height: 700 },
  args: ['--disable-extensions-except=' + root, '--load-extension=' + root, '--no-sandbox'],
});

let [worker] = context.serviceWorkers();
if (!worker) worker = await context.waitForEvent('serviceworker');
const extensionId = new URL(worker.url()).host;
const popupUrl = 'chrome-extension://' + extensionId + '/src/ui/popup/popup.html';

const checks = [];
const errors = [];
const check = (name, condition, detail) =>
  checks.push({ name, ok: !!condition, detail: condition ? '' : String(detail) });

async function setup(settings) {
  const page = await context.newPage();
  await page.goto('chrome-extension://' + extensionId + '/src/ui/options/options.html');
  const result = await page.evaluate(async (patch) => {
    const { MSG } = await import('/src/shared/messages.js');
    return chrome.runtime.sendMessage({ type: MSG.SETTINGS_SET, payload: patch });
  }, settings);
  await page.close();
  return result;
}

async function seed(doc) {
  const page = await context.newPage();
  await page.goto('chrome-extension://' + extensionId + '/src/ui/options/options.html');
  await page.evaluate(async (payload) => {
    const { MSG } = await import('/src/shared/messages.js');
    await chrome.runtime.sendMessage({ type: MSG.PAGE_CONTENT, payload });
  }, doc);
  await page.close();
}

// The popup asks which tab is in front. Automation cannot put a real tab
// there, so the query is answered with whatever the test is about.
async function openPopup(fakeTab, permissionAnswer = true) {
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push('console: ' + message.text());
  });
  await page.addInitScript(
    ({ tab, answer }) => {
      chrome.tabs.query = () => Promise.resolve([tab]);
      window.__granted = [];
      chrome.permissions.request = (options) => {
        window.__granted.push(options);
        return Promise.resolve(answer);
      };
    },
    { tab: fakeTab, answer: permissionAnswer }
  );
  await page.goto(popupUrl);
  await page.waitForFunction(() => !/Checking this page/.test(document.getElementById('pageStatus').textContent));
  return page;
}

const actionLabels = (page) => page.$$eval('#pageActions button', (nodes) => nodes.map((n) => n.textContent));

await setup({ setupComplete: true, mode: 'broad', customRules: [], allowlist: [], presets: { webmail: true } });

// --- a page that is not kept yet ------------------------------------------
let page = await openPopup({ id: 1, url: 'https://teamcraft.example/retro-fatigue' });
check('an uncaptured page says so', /Not kept yet/.test(await page.textContent('#pageStatus')), await page.textContent('#pageStatus'));
check('the domain is shown', (await page.textContent('#pageUrl')) === 'teamcraft.example', await page.textContent('#pageUrl'));

// The popup opens on a search box, so a half remembered phrase can be typed
// straight away, and Enter hands it to the search page.
check('the popup opens with the search box focused',
  await page.evaluate(() => document.activeElement && document.activeElement.id === 'popupQuery'),
  await page.evaluate(() => document.activeElement && document.activeElement.id));
const opened = await page.evaluate(() => {
  const created = [];
  chrome.tabs.create = (options) => { created.push(options.url); return Promise.resolve({}); };
  window.close = () => {};
  const input = document.getElementById('popupQuery');
  input.value = 'retro fatigue';
  input.form.requestSubmit();
  return created;
});
check('and pressing Enter opens search with that query',
  opened.length === 1 && /search\.html\?q=retro%20fatigue$/.test(opened[0]), JSON.stringify(opened));
let labels = await actionLabels(page);
check('it offers to keep the page and to block the site',
  labels.includes('Keep this page now') && labels.includes('Never keep this site'), JSON.stringify(labels));
await page.close();

// --- a page that is kept --------------------------------------------------
await seed({
  url: 'https://teamcraft.example/retro-fatigue',
  title: 'Why teams stop running retrospectives',
  text: 'Retro fatigue sets in when the same problems are raised every fortnight and nothing changes.',
  capturedAt: Date.now(),
});
page = await openPopup({ id: 1, url: 'https://teamcraft.example/retro-fatigue' });
const keptText = await page.textContent('#pageStatus');
check('a kept page says when it was read', /Kept, last read today/.test(keptText), keptText);
labels = await actionLabels(page);
check('it offers to forget the page', labels.includes('Forget this page'), JSON.stringify(labels));

await page.click('text=Forget this page');
await page.waitForFunction(() => /Not kept yet/.test(document.getElementById('pageStatus').textContent), null, { timeout: 4000 }).catch(() => {});
check('forgetting updates the popup without a reload',
  /Not kept yet/.test(await page.textContent('#pageStatus')), await page.textContent('#pageStatus'));
await page.close();

// --- an excluded page -----------------------------------------------------
page = await openPopup({ id: 1, url: 'https://mail.google.com/u/0/inbox' });
const excluded = await page.textContent('#pageStatus');
check('an excluded page explains itself', /Not kept: excluded/.test(excluded), excluded);
labels = await actionLabels(page);
check('and points at where to change it', labels.includes('Change what is excluded'), JSON.stringify(labels));
await page.close();

// --- blocking a site removes what was already kept ------------------------
await seed({
  url: 'https://blockme.example/one',
  title: 'First',
  text: 'Some text on a site that is about to be blocked entirely.',
  capturedAt: Date.now(),
});
await seed({
  url: 'https://blockme.example/two',
  title: 'Second',
  text: 'More text on the same site, which should also go when the site is blocked.',
  capturedAt: Date.now(),
});
page = await openPopup({ id: 1, url: 'https://blockme.example/one' });
await page.click('text=Never keep this site');
// Deleting what was kept cannot be undone, so the first click only says how
// much would go.
await page.waitForSelector('text=Also deletes 2 pages. Click again', { timeout: 4000 });
const stillThere = await page.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  return (await chrome.runtime.sendMessage({ type: MSG.SEARCH, payload: { query: 'blocked entirely' } })).results.length;
});
check('the first click deletes nothing, and says what the second will', stillThere === 1, stillThere);
await page.click('text=Also deletes 2 pages. Click again');
await page.waitForFunction(() => /Never keeping/.test(document.getElementById('pageStatus').textContent), null, { timeout: 4000 });
const blockedText = await page.textContent('#pageStatus');
check('blocking a site reports what it removed', /2 pages deleted/.test(blockedText), blockedText);
const remaining = await page.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  const found = await chrome.runtime.sendMessage({ type: MSG.SEARCH, payload: { query: 'blocked entirely' } });
  return found.results.length;
});
check('the blocked site is gone from the index', remaining === 0, remaining);
const rules = await page.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  return (await chrome.runtime.sendMessage({ type: MSG.SETTINGS_GET })).customRules;
});
check('and it is in the rules from now on', rules.includes('blockme.example'), JSON.stringify(rules));
await page.close();

// --- strict mode ----------------------------------------------------------
await setup({ mode: 'strict', allowlist: [] });
page = await openPopup({ id: 1, url: 'https://docs.example/guide' }, true);
const strictText = await page.textContent('#pageStatus');
check('strict mode says it is not watching the site', /Not watching this site/.test(strictText), strictText);
labels = await actionLabels(page);
check('and offers to start', labels.includes('Keep pages from this site'), JSON.stringify(labels));

await page.click('text=Keep pages from this site');
await page.waitForFunction(() => /Watching/.test(document.getElementById('pageStatus').textContent), null, { timeout: 4000 });
const requested = await page.evaluate(() => window.__granted);
check('granting asks Chrome for that one origin',
  requested.length === 1 && requested[0].origins.includes('*://docs.example/*'), JSON.stringify(requested));
const allowlist = await page.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  return (await chrome.runtime.sendMessage({ type: MSG.SETTINGS_GET })).allowlist;
});
check('the site is added to the allowlist', allowlist.includes('docs.example'), JSON.stringify(allowlist));
await page.close();

// --- strict mode, a site the exclusions cover ------------------------------
// Used to: offered "Keep pages from this site", granted Chrome access to
// it, and then refused the page anyway.
page = await openPopup({ id: 1, url: 'https://mail.google.com/u/0/inbox' }, true);
const strictExcluded = await page.textContent('#pageStatus');
check('strict mode says an excluded site is excluded', /Not kept: excluded/.test(strictExcluded), strictExcluded);
labels = await actionLabels(page);
check('and does not offer to add it', !labels.includes('Keep pages from this site'), JSON.stringify(labels));
await page.close();

// --- strict mode, refused --------------------------------------------------
await setup({ allowlist: [] });
page = await openPopup({ id: 1, url: 'https://other.example/guide' }, false);
await page.click('text=Keep pages from this site');
await page.waitForFunction(() => /did not grant/.test(document.getElementById('pageStatus').textContent), null, { timeout: 4000 });
check('a refusal is reported rather than silently ignored',
  /did not grant access to other.example/.test(await page.textContent('#pageStatus')), await page.textContent('#pageStatus'));
await page.close();

// --- a page that is not a web page ----------------------------------------
page = await openPopup({ id: 1, url: 'chrome://extensions' });
check('an internal page is not offered', /Nothing to keep here/.test(await page.textContent('#pageStatus')), await page.textContent('#pageStatus'));
check('and offers no actions', (await actionLabels(page)).length === 0, 'buttons present');
await page.close();

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
