// Regression checks for defects found in review, run against the real
// extension in a real Chromium, so none of them can come back quietly.
// Each check names what used to happen.
//
// Slow, like test:capture: several of these read a real page, and reading
// takes seconds of dwell by design.

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGrantedExtension } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const granted = await buildGrantedExtension(root);

const paragraphs = Array.from({ length: 30 }, (_, i) =>
  '<p>Paragraph ' + (i + 1) + ' of a long article about sourdough starters and hydration ratios, long enough to scroll.</p>'
).join('');
const html = (title, extra = '', head = '') =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}</head>` +
  `<body>${extra}<article><h1>${title}</h1>${paragraphs}</article></body></html>`;

const context = await chromium.launchPersistentContext('', {
  headless: false,
  viewport: { width: 900, height: 700 },
  args: ['--disable-extensions-except=' + granted.dir, '--load-extension=' + granted.dir, '--no-sandbox'],
});
let [worker] = context.serviceWorkers();
if (!worker) worker = await context.waitForEvent('serviceworker');
const id = new URL(worker.url()).host;

await context.route('**/*', (route) => {
  const u = new URL(route.request().url());
  if (!/^https?:$/.test(u.protocol)) return route.continue();
  if (u.pathname.includes('hidden-login')) {
    return route.fulfill({ contentType: 'text/html', body: html('Forum thread about bread',
      '<div style="display:none"><form><input type="password" name="pw"></form></div>') });
  }
  if (u.pathname.includes('home-canonical')) {
    return route.fulfill({ contentType: 'text/html', body: html('Article at ' + u.pathname, '',
      '<link rel="canonical" href="https://' + u.host + '/">') });
  }
  if (u.pathname.includes('public')) {
    return route.fulfill({ contentType: 'text/html', body: html('Public page', '',
      '<link rel="canonical" href="https://canon.example/private/secret-notes">') });
  }
  return route.fulfill({ contentType: 'text/html', body: html('Article at ' + u.pathname) });
});

const checks = [];
const check = (name, condition, detail) =>
  checks.push({ name, ok: !!condition, detail: condition ? '' : JSON.stringify(detail) });

const driver = await context.newPage();
const cspErrors = [];
driver.on('console', (message) => {
  if (/Content Security Policy/i.test(message.text())) cspErrors.push(message.text());
});
await driver.goto('chrome-extension://' + id + '/src/ui/options/options.html');
const ask = (type, payload) => driver.evaluate(async ({ type, payload }) => {
  const { MSG } = await import('/src/shared/messages.js');
  return chrome.runtime.sendMessage({ type: MSG[type], payload });
}, { type, payload });
const tabIdFor = (pattern) => driver.evaluate(async (p) => (await chrome.tabs.query({ url: p }))[0].id, pattern);

async function read(url, seconds = 13) {
  const tab = await context.newPage();
  await tab.goto(url);
  await tab.bringToFront();
  const started = Date.now();
  while (Date.now() - started < seconds * 1000) {
    await tab.mouse.wheel(0, 400);
    await tab.waitForTimeout(1000);
  }
  await driver.bringToFront();
  await driver.waitForTimeout(1500);
  return tab;
}
const kept = async (url) => (await ask('PAGE_STATUS', { url })).kept !== null;

// --- setup ------------------------------------------------------------------
// Used to: a person who granted access on setup's second screen and closed
// it had every page they read kept, while the popup said "Finish setting up".

check('setup starts unfinished', (await ask('SETTINGS_GET')).setupComplete === false);
const registeredBefore = await driver.evaluate(() => chrome.scripting.getRegisteredContentScripts());
check('nothing is registered in pages before setup is finished', registeredBefore.length === 0, registeredBefore);
let tab = await read('https://before-setup.example/article');
check('a page read before setup is finished is not kept', !(await kept('https://before-setup.example/article')));
check('and the button says why', /setup/.test((await ask('PAGE_STATUS', { url: 'https://before-setup.example/article' })).reason));
await tab.close();

await ask('SETTINGS_SET', { setupComplete: true });
const registeredAfter = await driver.evaluate(() => chrome.scripting.getRegisteredContentScripts());
check('finishing setup starts watching', registeredAfter.length === 1, registeredAfter);

// --- the popup saying something true ----------------------------------------
// Used to: a page refused for a hidden password field showed "Not kept yet"
// for ever, with a "Keep this page now" button that silently did nothing.

tab = await read('https://forum.example/hidden-login/thread-1');
const hiddenStatus = await ask('PAGE_STATUS', {
  url: 'https://forum.example/hidden-login/thread-1',
  tabId: await tabIdFor('https://forum.example/*'),
});
check('a page with a password field is still not kept', hiddenStatus.kept === null, hiddenStatus);
check('and the button now says why', hiddenStatus.capturable === false && /password/.test(hiddenStatus.reason), hiddenStatus);
await tab.close();

// --- canonical addresses ----------------------------------------------------
// Used to: a page at /public naming /private as canonical was filed under
// /private, an address the rule excluded.

await ask('SETTINGS_SET', { customRules: ['canon.example/private/*'] });
tab = await read('https://canon.example/public/page');
const recent = await ask('RECENT', { limit: 5, slim: true });
check('a canonical address a rule excludes is not used',
  recent.some((r) => r.url === 'https://canon.example/public/page') &&
  !recent.some((r) => r.url.includes('/private/')), recent.map((r) => r.url));
await tab.close();

// Used to: a site whose every page names its home page as canonical kept one
// page, each article read overwriting the one before under the home address.

tab = await read('https://homecanon.example/home-canonical/first');
await tab.close();
tab = await read('https://homecanon.example/home-canonical/second');
await tab.close();
check('two articles that both name the home page as canonical are both kept',
  (await kept('https://homecanon.example/home-canonical/first')) &&
  (await kept('https://homecanon.example/home-canonical/second')) &&
  !(await kept('https://homecanon.example/')));

// --- rules as typed ---------------------------------------------------------
// Used to: "www.example.com" or a pasted address excluded nothing at all.

await ask('SETTINGS_SET', { customRules: ['www.news.example', 'https://www.shop.example/'] });
for (const url of ['https://www.news.example/story', 'https://shop.example/item']) {
  check('a rule typed as it appears excludes ' + url, (await ask('PAGE_STATUS', { url })).capturable === false);
}
check('and is stored the way it is matched',
  JSON.stringify((await ask('SETTINGS_GET')).customRules) === JSON.stringify(['news.example', 'shop.example']));
await ask('SETTINGS_SET', { customRules: [] });

// --- keep now while paused --------------------------------------------------
// Used to: answered "capturing", and then the page was refused as paused.

await ask('SETTINGS_SET', { pausedUntil: Date.now() + 3600000 });
tab = await context.newPage();
await tab.goto('https://paused.example/article');
const whilePaused = await ask('CAPTURE_NOW', { tabId: await tabIdFor('https://paused.example/*'), url: 'https://paused.example/article' });
check('keep now during a pause says it is paused', whilePaused.ok === false && /paused/.test(whilePaused.reason), whilePaused);
const badgePaused = await driver.evaluate(() => chrome.action.getBadgeText({}));
check('and a pause shows on the toolbar', badgePaused === 'off', badgePaused);
await ask('SETTINGS_SET', { pausedUntil: 0 });
check('and goes when it ends', (await driver.evaluate(() => chrome.action.getBadgeText({}))) === '');
await tab.close();

// --- deletion is logged -----------------------------------------------------
// Used to: forgetting a page, a site or a day wrote nothing to the log that
// says "Nothing is deleted without an entry here".

for (let i = 0; i < 3; i++) {
  await ask('PAGE_CONTENT', { url: 'https://forget.example/' + i, title: 'Forget ' + i,
    text: 'A page about forgetting things, number ' + i + ', long enough to be kept around.' });
}
const logBefore = (await ask('LOG', { limit: 100 })).length;
const forgetMe = (await ask('RECENT', { limit: 10, slim: true })).find((r) => r.url === 'https://forget.example/0');
await ask('FORGET', { scope: 'page', id: forgetMe && forgetMe.id });
await ask('FORGET', { scope: 'site', value: 'forget.example' });
const logAfter = await ask('LOG', { limit: 100 });
check('forgetting a page and a site each leave a row', logAfter.length === logBefore + 2, [logBefore, logAfter.length]);
check('saying they were deleted by you', !!logAfter[0] && logAfter[0].reason === 'manual', logAfter[0]);

// --- two quick changes ------------------------------------------------------
// Used to: ticking two categories in quick succession left one of them off.

await ask('SETTINGS_SET', { presets: { adult: false, health: false } });
// Through the real settings page, which is where the stale copy lived: tick
// two categories without waiting between them.
await driver.reload();
await driver.waitForSelector('[data-preset="adult"]');
// One after the other, as a person would, without waiting for the first
// save to come back: that overlap is where the stale copy used to win.
// (Two clicks issued at once make the automation itself misclick.)
await driver.click('[data-preset="adult"]');
await driver.click('[data-preset="health"]');
await driver.waitForTimeout(1500);
const presets = (await ask('SETTINGS_GET')).presets;
check('two quick category changes both stick', presets.adult && presets.health, presets);

// --- disk full clears -------------------------------------------------------
// Used to: once the disk had filled, the popup said so for ever.

await driver.evaluate(() => chrome.storage.local.set({ storageFull: { at: Date.now() } }));
await ask('PAGE_CONTENT', { url: 'https://room.example/again', title: 'Room again',
  text: 'A page saved after the disk had room again, long enough to be worth keeping.' });
const stillFull = await driver.evaluate(async () => (await chrome.storage.local.get('storageFull')).storageFull);
check('a page saving again clears the disk-full warning', !stillFull, stillFull);

// --- import -----------------------------------------------------------------
// Used to: an old export brought back pages since excluded, and a date in
// the future kept a page out of the age limit's reach.

const future = new Date(Date.now() + 5 * 365 * 86400000).toISOString();
const imported = await ask('IMPORT', { pages: [
  { url: 'https://chatgpt.com/c/private', title: 'A chat', text: 'Something said to an assistant that was later excluded.' },
  { url: 'https://future.example/a', title: 'From the future', text: 'A page whose export claimed a date years from now.', lastSeen: future, firstSeen: future },
] });
check('an import leaves out what exclusions now cover', imported.excluded === 1 && imported.imported === 1, imported);
const futurePage = (await ask('RECENT', { limit: 1 }))[0];
check('and does not accept a date in the future', futurePage.lastSeen <= Date.now(), futurePage.lastSeen);

// --- retention behind pinned pages ------------------------------------------
// Used to: once the 500 oldest expired pages were pinned, the age limit
// never removed anything again.

await driver.evaluate(() => chrome.storage.local.remove('sweepState'));
const now = Date.now();
const DAY = 86400000;
const make = (i, pinned, ageDays) => ({
  url: 'https://old.example/p' + i + (pinned ? '-pinned' : ''), title: 'Old ' + i,
  text: 'An old page number ' + i + ' about things nobody remembers any more, long enough to keep.',
  lastSeen: new Date(now - ageDays * DAY).toISOString(), firstSeen: new Date(now - ageDays * DAY).toISOString(),
  pinned,
});
const old = [];
for (let i = 0; i < 520; i++) old.push(make(i, true, 1100));
for (let i = 0; i < 5; i++) old.push(make(1000 + i, false, 800));
for (let i = 0; i < old.length; i += 25) await ask('IMPORT', { pages: old.slice(i, i + 25) });
const sweep = await ask('MAINTENANCE');
check('the age limit gets past pinned pages', sweep.evicted === 5, sweep);
const pinnedLeft = await ask('SEARCH', { query: 'old page number', limit: 1 });
check('and the pinned ones are all still there', pinnedLeft.total === 520, pinnedLeft.total);

// --- search past the first few hundred matches -------------------------------
// Used to: the site filter found nothing and the total stopped at 500.

const one = await ask('SEARCH', { query: 'old page number', filters: { site: 'old.example', sort: 'recent' }, limit: 5 });
check('filters and totals hold past the shortlist', one.total === 520 && one.results.length === 5, one.total);

// --- the pages themselves -----------------------------------------------------
// Result links are real links; no page breaks the content security policy.

const search = await context.newPage();
search.on('console', (message) => {
  if (/Content Security Policy/i.test(message.text())) cspErrors.push(message.text());
});
await search.goto('chrome-extension://' + id + '/src/ui/search/search.html?q=' + encodeURIComponent('room again'));
await search.waitForSelector('[data-open]');
const href = await search.getAttribute('[data-open]', 'href');
check('a result is a real link to the page', href === 'https://room.example/again', href);
for (const page of ['popup/popup.html', 'setup/setup.html', 'options/options.html']) {
  const p = await context.newPage();
  p.on('console', (message) => {
    if (/Content Security Policy/i.test(message.text())) cspErrors.push(page + ': ' + message.text());
  });
  await p.goto('chrome-extension://' + id + '/src/ui/' + page);
  await p.waitForTimeout(800);
  await p.close();
}
check('no page is refused anything by the content security policy', cspErrors.length === 0, cspErrors);

// --- strict mode with access already granted ----------------------------------
// Used to: Chrome already had access to the site (this harness grants every
// site, as Chrome's own site access menu or an earlier broad mode can) but it
// was not on the list, and the popup said "Not kept: not on your allowlist"
// with no way to add it.

await ask('SETTINGS_SET', { mode: 'strict', allowlist: [] });
const strictPopup = await context.newPage();
await strictPopup.addInitScript(() => {
  chrome.tabs.query = () => Promise.resolve([{ id: 424242, url: 'https://granted.example/guide' }]);
  chrome.permissions.request = () => Promise.resolve(true);
});
await strictPopup.goto('chrome-extension://' + id + '/src/ui/popup/popup.html');
await strictPopup.waitForFunction(() => document.querySelectorAll('#pageActions button').length > 0, null, { timeout: 5000 }).catch(() => {});
const strictLabels = await strictPopup.$$eval('#pageActions button', (nodes) => nodes.map((n) => n.textContent));
check('strict mode offers to add a site Chrome already has access to',
  strictLabels.includes('Keep pages from this site'), strictLabels);
await strictPopup.close();
await ask('SETTINGS_SET', { mode: 'broad' });

// --- an update --------------------------------------------------------------
// Used to: every update applied every category that was on to what was
// already kept, so a category new in that update deleted pages nobody had
// chosen to delete. Reloading the extension is what an update looks like.

await ask('SETTINGS_SET', { presets: { messaging: true } });
await driver.evaluate(async () => {
  const { settings } = await chrome.storage.local.get('settings');
  delete settings.presets.aiChats;
  delete settings.presets.accounts;
  await chrome.storage.local.set({ settings });
  await chrome.storage.local.remove(['appliedRules', 'newCategories']);
});
for (const url of ['https://chatgpt.com/c/kept-from-before', 'https://x.com/i/chat/older-entry']) {
  await ask('PAGE_CONTENT', { url, title: 'Saved before the update',
    text: 'Text saved before this version shipped its lists, long enough to be kept.' });
}
// Chrome disables an extension loaded from the command line when it reloads
// itself, so a real update cannot be driven from here. What onInstalled does
// on an update is run instead, from an extension page, in the same order:
// note the new categories, mark the sweep pending, run it.
async function update() {
  await driver.evaluate(async () => {
    const archive = await import('/src/background/archive.js');
    await archive.noteNewCategories();
    await chrome.storage.local.set({ exclusionSweepPending: true });
    await archive.removeExcludedIfPending();
  });
  await driver.reload();
  await driver.waitForTimeout(1500);
  return driver;
}
let settings = await update();
const askOn = (page, type, payload) => page.evaluate(async ({ type, payload }) => {
  const { MSG } = await import('/src/shared/messages.js');
  return chrome.runtime.sendMessage({ type: MSG[type], payload });
}, { type, payload });
const statusAfter = async (page, url) => (await askOn(page, 'PAGE_STATUS', { url })).kept !== null;
check('an update does not delete what a brand new category covers',
  await statusAfter(settings, 'https://chatgpt.com/c/kept-from-before'));
check('but does apply a new entry in a category that was already on',
  !(await statusAfter(settings, 'https://x.com/i/chat/older-entry')));
check('the new categories are on for what is read next',
  (await askOn(settings, 'PAGE_STATUS', { url: 'https://chatgpt.com/c/new' })).capturable === false);
await settings.waitForSelector('#newCategories:not([hidden])', { timeout: 10000 }).catch(() => {});
const offer = await settings.textContent('#newCategoriesText');
check('settings asks about what was saved before', /AI chats/.test(offer) && /1 page/.test(offer), offer);
await settings.click('#newCategoriesKeep');
await settings.waitForSelector('#newCategories[hidden]', { state: 'attached', timeout: 10000 });
settings = await update();
check('and keeping them holds through the next update too',
  await statusAfter(settings, 'https://chatgpt.com/c/kept-from-before'));
check('without asking again', (await askOn(settings, 'STATS')).newCategories.length === 0);

await context.close();
await granted.cleanup();

let failed = 0;
for (const c of checks) {
  console.log((c.ok ? '  ok   ' : '  FAIL ') + c.name + (c.ok ? '' : '\n       ' + c.detail));
  if (!c.ok) failed += 1;
}
console.log('\n' + (checks.length - failed) + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
