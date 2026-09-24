// The settings page, including two things this extension does not
// compromise on: an export you can read without this extension, and a
// delete that actually deletes.

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const context = await chromium.launchPersistentContext('', {
  headless: false,
  viewport: { width: 900, height: 900 },
  acceptDownloads: true,
  args: ['--disable-extensions-except=' + root, '--load-extension=' + root, '--no-sandbox'],
});

let [worker] = context.serviceWorkers();
if (!worker) worker = await context.waitForEvent('serviceworker');
const extensionId = new URL(worker.url()).host;

const checks = [];
const errors = [];
const check = (name, condition, detail) =>
  checks.push({ name, ok: !!condition, detail: condition ? '' : String(detail) });

// Seed a few pages so there is something to report on.
const seed = await context.newPage();
await seed.goto('chrome-extension://' + extensionId + '/src/ui/options/options.html');
const seeded = await seed.evaluate(async () => {
  const { CORPUS } = await import('/test/fixtures/corpus.js');
  const { MSG } = await import('/src/shared/messages.js');
  for (const doc of CORPUS.slice(0, 6)) {
    await chrome.runtime.sendMessage({
      type: MSG.PAGE_CONTENT,
      payload: { url: doc.url, title: doc.title, text: doc.text, capturedAt: Date.now() },
    });
  }
  return (await chrome.runtime.sendMessage({ type: MSG.STATS })).docCount;
});
await seed.close();
check('the fixture pages were captured', seeded === 6, seeded);

const page = await context.newPage();
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push('console: ' + message.text());
});
await page.goto('chrome-extension://' + extensionId + '/src/ui/options/options.html');
await page.waitForFunction(() => document.getElementById('usage').textContent.length > 0);

const usage = await page.textContent('#usage');
check('usage is reported in pages and a sensible unit',
  /6 pages/.test(usage) && /\d+(\.\d+)?(B|KB|MB|GB) of \d+/.test(usage), usage);
check('a small corpus is not described as 0.0MB', !/0\.0MB of/.test(usage), usage);
check('capacity is expressed in pages', /room for roughly/.test(usage), usage);

const readSettings = () =>
  page.evaluate(async () => {
    const { MSG } = await import('/src/shared/messages.js');
    return chrome.runtime.sendMessage({ type: MSG.SETTINGS_GET });
  });

await page.uncheck('[data-preset="health"]');
await page.waitForTimeout(300);
check('turning a bundle off is saved', (await readSettings()).presets.health === false, 'not saved');

const keep = (url) =>
  page.evaluate(async (address) => {
    const { MSG } = await import('/src/shared/messages.js');
    await chrome.runtime.sendMessage({
      type: MSG.PAGE_CONTENT,
      payload: { url: address, title: 'Kept page', text: 'Something kept before the rule existed.', capturedAt: Date.now() },
    });
    return (await chrome.runtime.sendMessage({ type: MSG.STATS })).docCount;
  }, url);
const docCount = () =>
  page.evaluate(async () => {
    const { MSG } = await import('/src/shared/messages.js');
    return (await chrome.runtime.sendMessage({ type: MSG.STATS })).docCount;
  });

// Turning a category back on removes what it covers, not only what comes next.
check('a page from a category that is off is kept', (await keep('https://www.mychart.org/visits')) === 7, 'not kept');
await page.check('[data-preset="health"]');
await page.waitForFunction(() => !document.getElementById('presetNote').hidden);
check('turning the category on removes it', (await docCount()) === 6, await docCount());
check('and says so', /Removed 1 page already saved from health/.test(await page.textContent('#presetNote')),
  await page.textContent('#presetNote'));

await page.fill('#rules', 'example.com\n*.internal.example');
await page.waitForTimeout(1000);
const savedRules = (await readSettings()).customRules;
check('custom rules are saved once typing stops',
  savedRules.length === 2 && savedRules[0] === 'example.com', JSON.stringify(savedRules));
check('rules that match nothing kept say nothing', await page.isHidden('#rulesMatch'), 'shown');

// A custom rule only removes saved pages when asked, since it is saved while
// it is still being typed.
await keep('https://www.example.com/private/notes');
await page.fill('#rules', 'example.com\n*.internal.example\n');
await page.waitForFunction(() => !document.getElementById('rulesMatch').hidden);
check('a rule matching a kept page offers to remove it',
  /1 page you already saved matches/.test(await page.textContent('#rulesMatchText')),
  await page.textContent('#rulesMatchText'));
check('and removes nothing until asked', (await docCount()) === 7, await docCount());
await page.click('#rulesRemove');
await page.waitForFunction(() => /Removed/.test(document.getElementById('rulesMatchText').textContent));
check('and removes it when asked', (await docCount()) === 6, await docCount());

// What an update re-applies: every category that is on, and addresses that
// carry a key, which earlier builds kept.
await keep('https://reader.example/reset-password/Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA');
const reapplied = await page.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  return chrome.runtime.sendMessage({ type: MSG.REMOVE_EXCLUDED, payload: { scope: 'shipped' } });
});
check('an update removes kept pages whose address is a key', reapplied.removed === 1, JSON.stringify(reapplied));
check('and nothing else', (await docCount()) === 6, await docCount());

await page.selectOption('#months', '24');
await page.waitForTimeout(300);
check('retention is saved', (await readSettings()).retentionMonths === 24, 'not saved');

// Export
const download = await Promise.all([
  page.waitForEvent('download', { timeout: 10000 }),
  page.click('#export'),
]).then(([d]) => d);
const exportPath = await download.path();
const exported = JSON.parse(await readFile(exportPath, 'utf8'));
check('the export is named for the day it was made', /textmemory-\d{4}-\d{2}-\d{2}\.json/.test(download.suggestedFilename()), download.suggestedFilename());
check('the export holds every page', exported.pages.length === 6, exported.pages.length);
check('the export carries the full text, not a summary',
  exported.pages[0].text.length > 200, exported.pages[0].text.length);
check('the export carries readable dates',
  /^\d{4}-\d{2}-\d{2}T/.test(exported.pages[0].lastSeen), exported.pages[0].lastSeen);
check('the export records the settings too', exported.settings.retentionMonths === 24, JSON.stringify(exported.settings));

// Delete everything, which must take two clicks.
await page.click('#wipe');
await page.waitForTimeout(200);
const armedLabel = await page.textContent('#wipe');
check('the first click only arms the button', /Click again/.test(armedLabel), armedLabel);
const stillThere = await page.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  return (await chrome.runtime.sendMessage({ type: MSG.STATS })).docCount;
});
check('one click deletes nothing', stillThere === 6, stillThere);

await page.click('#wipe');
await page.waitForTimeout(600);
const afterWipe = await page.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  return (await chrome.runtime.sendMessage({ type: MSG.STATS })).docCount;
});
check('the second click deletes everything', afterWipe === 0, afterWipe);

const logText = await page.textContent('#log');
check('the deletion is in the log', /deleted by you/.test(logText), logText);

// --- switching modes, and whether strict mode means anything --------------
//
// This is the difference between this extension and every other one: strict
// mode is meant to be enforced by Chrome rather than promised by us, and it
// only is if switching away from broad mode actually hands the wide host
// permission back.
//
// chrome.permissions.remove cannot be proven end to end here, because granting
// the optional permission in the first place needs a click on a Chrome dialog
// that automation cannot reach, and the test harness therefore loads a copy
// with the permission required rather than optional. So what is held down is
// the call itself: that it is made, with the right origins, before the mode
// changes, and that the mode does not change if Chrome says no.
const modes = await context.newPage();
modes.on('pageerror', (error) => errors.push('modes page: ' + String(error)));
await modes.addInitScript(() => {
  window.__permissionCalls = [];
  const realRemove = chrome.permissions.remove.bind(chrome.permissions);
  const realRequest = chrome.permissions.request.bind(chrome.permissions);
  chrome.permissions.remove = (details) => {
    window.__permissionCalls.push({ op: 'remove', origins: details.origins });
    return Promise.resolve(true);
  };
  chrome.permissions.request = (details) => {
    window.__permissionCalls.push({ op: 'request', origins: details.origins });
    return Promise.resolve(window.__grant !== false);
  };
  window.__realPermissions = { realRemove, realRequest };
});
await modes.goto('chrome-extension://' + extensionId + '/src/ui/options/options.html');
await modes.waitForTimeout(300);

check('settings offers the choice of capture mode at all',
  (await modes.$$('input[name="mode"]')).length === 2,
  'there was no way to change mode after setup, so strict mode was unreachable');

await modes.click('input[name="mode"][value="strict"]');
await modes.waitForTimeout(400);
let calls = await modes.evaluate(() => window.__permissionCalls);
check('switching to strict hands the wide permission back to Chrome',
  calls.some((call) => call.op === 'remove' && call.origins.includes('*://*/*')),
  JSON.stringify(calls));

let saved = await modes.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  return chrome.runtime.sendMessage({ type: MSG.SETTINGS_GET });
});
check('and the mode really is strict afterwards', saved.mode === 'strict', saved.mode);
check('and the exclusion list stays, since it still applies to the sites added',
  await modes.getAttribute('#presetBlock', 'hidden') === null, 'exclusions hidden');
check('and the list of added sites takes its place',
  await modes.getAttribute('#allowBlock', 'hidden') === null, 'allowlist not shown');

// Removing a site has to take its permission back too, or the list is a lie.
await modes.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  await chrome.runtime.sendMessage({ type: MSG.SETTINGS_SET, payload: { allowlist: ['example.org'] } });
});
await modes.reload();
await modes.waitForTimeout(400);
check('an added site is listed', (await modes.textContent('#allowlist')).includes('example.org'),
  await modes.textContent('#allowlist'));
await modes.click('#allowlist .remove');
await modes.waitForTimeout(400);
calls = await modes.evaluate(() => window.__permissionCalls);
check('removing a site takes back Chrome\'s permission for it',
  calls.some((call) => call.op === 'remove' && call.origins.some((o) => o.includes('example.org'))),
  JSON.stringify(calls));
saved = await modes.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  return chrome.runtime.sendMessage({ type: MSG.SETTINGS_GET });
});
check('and drops it from the list', !saved.allowlist.includes('example.org'), JSON.stringify(saved.allowlist));

// Going back to broad has to ask, and has to believe the answer.
await modes.evaluate(() => { window.__grant = false; });
await modes.click('input[name="mode"][value="broad"]');
await modes.waitForTimeout(400);
saved = await modes.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  return chrome.runtime.sendMessage({ type: MSG.SETTINGS_GET });
});
check('a refused permission leaves the mode where it was',
  saved.mode === 'strict', 'it switched to broad without the access to do it');
check('and says so rather than failing silently',
  /did not grant/.test(await modes.textContent('#modeLine')), await modes.textContent('#modeLine'));
check('and the radio goes back to where it was',
  await modes.isChecked('input[name="mode"][value="strict"]'), 'the interface disagrees with the setting');

await modes.evaluate(() => { window.__grant = true; });
await modes.click('input[name="mode"][value="broad"]');
await modes.waitForTimeout(400);
calls = await modes.evaluate(() => window.__permissionCalls);
saved = await modes.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  return chrome.runtime.sendMessage({ type: MSG.SETTINGS_GET });
});
check('switching back to broad asks Chrome for the access first',
  calls.some((call) => call.op === 'request' && call.origins.includes('*://*/*')), JSON.stringify(calls));
check('and switches once it is granted', saved.mode === 'broad', saved.mode);
await modes.close();

// --- the round trip: export, delete everything, import it back ------------
await page.setInputFiles('#importFile', exportPath);
await page.waitForFunction(() => /imported/.test(document.getElementById('dataNote').textContent), null, { timeout: 15000 });
const importNote = await page.textContent('#dataNote');
check('importing reports what it restored', /6 imported/.test(importNote), importNote);

const restored = await page.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  const stats = await chrome.runtime.sendMessage({ type: MSG.STATS });
  const found = await chrome.runtime.sendMessage({
    type: MSG.SEARCH,
    payload: { query: 'retro fatigue' },
  });
  const recent = await chrome.runtime.sendMessage({ type: MSG.RECENT, payload: { limit: 20 } });
  return { docCount: stats.docCount, hits: found.results.length, recent };
});
check('the pages are back', restored.docCount === 6, restored.docCount);
check('and searchable again', restored.hits === 1, restored.hits);

const oldest = restored.recent.find((p) => /retro-fatigue/.test(p.url));
check('history came back with them, not today\'s date',
  oldest && oldest.visitCount >= 1 && oldest.firstSeen <= oldest.lastSeen,
  JSON.stringify(oldest && { firstSeen: oldest.firstSeen, lastSeen: oldest.lastSeen }));

// Importing the same archive again should look like it did nothing.
await page.setInputFiles('#importFile', exportPath);
await page.waitForFunction(() => /already here/.test(document.getElementById('dataNote').textContent), null, { timeout: 15000 });
const secondNote = await page.textContent('#dataNote');
check('importing the same archive twice changes nothing', /6 already here/.test(secondNote), secondNote);

// A page read again since the export, with different text. Restoring the
// older export used to put the older text back over it.
await page.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  await chrome.runtime.sendMessage({
    type: MSG.PAGE_CONTENT,
    payload: {
      url: 'https://teamcraft.example/retro-fatigue',
      title: 'Why teams stop running retrospectives',
      text: 'Rewritten since the export: the zeppelin paragraph is what was read most recently, and it has to survive an older backup.',
      capturedAt: Date.now(),
    },
  });
});
await page.evaluate(() => { document.getElementById('dataNote').textContent = ''; });
await page.setInputFiles('#importFile', exportPath);
await page.waitForFunction(() => /already here/.test(document.getElementById('dataNote').textContent), null, { timeout: 15000 });
const afterOlder = await page.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  const fresh = await chrome.runtime.sendMessage({ type: MSG.SEARCH, payload: { query: 'zeppelin' } });
  return { note: document.getElementById('dataNote').textContent, fresh: fresh.total };
});
check('an older export does not overwrite text read since', afterOlder.fresh === 1, JSON.stringify(afterOlder));
check('and says the page was already here', /6 already here/.test(afterOlder.note), afterOlder.note);

// An export written before the rename. Somebody's file on disk is not
// something to break over a marketing decision, so the old identifier is
// accepted for ever.
const legacy = path.join(path.dirname(exportPath), 'legacy-export.json');
await writeFile(legacy, JSON.stringify({
  format: 'snow-mountain-export',
  version: 1,
  pages: [{
    url: 'https://legacy.example/kept',
    title: 'Written under the old name',
    text: 'This page was exported before the extension was called anything in particular, and it still comes back.',
    firstSeen: new Date(Date.now() - 86400000).toISOString(),
    lastSeen: new Date(Date.now() - 86400000).toISOString(),
    visitCount: 1,
    pinned: false,
  }],
}));
// Cleared first, so the wait below is for this import's answer and not the
// last one's still sitting on the screen.
await page.evaluate(() => { document.getElementById('dataNote').textContent = ''; });
await page.setInputFiles('#importFile', legacy);
await page.waitForFunction(() => /\d+ imported|already here/.test(document.getElementById('dataNote').textContent), null, { timeout: 15000 });
const legacyFound = await page.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  const found = await chrome.runtime.sendMessage({
    type: MSG.SEARCH,
    payload: { query: 'exported before the extension' },
  });
  return found.results.length;
});
check('an export written under the old name still imports', legacyFound === 1, legacyFound);

// And something that is not an export at all.
const junk = path.join(path.dirname(exportPath), 'not-an-export.json');
await writeFile(junk, JSON.stringify({ hello: 'world' }));
await page.setInputFiles('#importFile', junk);
await page.waitForTimeout(500);
check('a file that is not an export is refused clearly',
  /does not look like an export/.test(await page.textContent('#dataNote')), await page.textContent('#dataNote'));

// ---------------------------------------------------------------------------
// The budget controls. Presets are for the common case; the custom field is
// there because the limit is on somebody's own disk and a ceiling nobody can
// pass is a judgement about how much reading they are allowed to keep.

await page.selectOption('#size', 'custom');
check('choosing a custom size reveals somewhere to type it',
  await page.isVisible('#sizeCustom'), 'the custom field stayed hidden');

await page.fill('#sizeCustom', '40');
await page.dispatchEvent('#sizeCustom', 'input');
const roomFor40 = await page.textContent('#capacityNote');
check('and says what that number holds, in pages rather than bytes',
  /pages/.test(roomFor40) && /00/.test(roomFor40), roomFor40);

await page.dispatchEvent('#sizeCustom', 'change');
await page.waitForTimeout(400);
const savedBig = await page.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  return (await chrome.runtime.sendMessage({ type: MSG.SETTINGS_GET })).sizeCapBytes;
});
check('a limit far above every preset is accepted',
  savedBig === 40 * 1024 * 1024 * 1024, savedBig);

// Reopening has to show the custom number back, or a custom limit is one you
// can set and never see again.
const reopened = await context.newPage();
await reopened.goto('chrome-extension://' + extensionId + '/src/ui/options/options.html');
await reopened.waitForTimeout(600);
check('and comes back on the control when settings is reopened',
  (await reopened.inputValue('#size')) === 'custom' &&
    Math.abs(Number(await reopened.inputValue('#sizeCustom')) - 40) < 0.01,
  (await reopened.inputValue('#size')) + ' / ' + (await reopened.inputValue('#sizeCustom')));
await reopened.close();

// The one direction where a typo cannot be undone.
const used = await page.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  return (await chrome.runtime.sendMessage({ type: MSG.STATS })).usedBytes;
});
await page.fill('#sizeCustom', String(used / 2 / (1024 * 1024 * 1024)));
await page.dispatchEvent('#sizeCustom', 'input');
await page.waitForTimeout(200);
const shrink = await page.textContent('#shrinkNote');
check('a limit below what is already kept says so before it is saved',
  (await page.isVisible('#shrinkNote')) && /would remove/.test(shrink), shrink);
check('and promises pinned pages are safe from it', /[Pp]inned/.test(shrink), shrink);

// Months take a custom value too.
await page.selectOption('#months', 'custom');
await page.fill('#monthsCustom', '84');
await page.dispatchEvent('#monthsCustom', 'change');
await page.waitForTimeout(400);
const savedMonths = await page.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  return (await chrome.runtime.sendMessage({ type: MSG.SETTINGS_GET })).retentionMonths;
});
check('a retention nobody offered is accepted too', savedMonths === 84, savedMonths);

// Put it back so nothing below inherits a silly cap.
await page.selectOption('#size', '500');
await page.dispatchEvent('#size', 'change');
await page.selectOption('#months', '12');
await page.dispatchEvent('#months', 'change');
await page.waitForTimeout(400);

// ---------------------------------------------------------------------------
// Capture failing is the one failure that leaves nothing behind to notice.

const watch = await page.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  await chrome.runtime.sendMessage({
    type: MSG.SETTINGS_SET,
    payload: { mode: 'strict', allowlist: ['never-granted.example', 'also-not.example'] },
  });
  await new Promise((r) => setTimeout(r, 400));
  return (await chrome.runtime.sendMessage({ type: MSG.STATS })).captureWatch;
});
check('sites the extension cannot actually watch are recorded',
  watch && watch.ungranted && watch.ungranted.length === 2, JSON.stringify(watch));

await page.reload();
await page.waitForTimeout(700);
const note = await page.textContent('#storageNote');
check('and settings says so rather than looking fine',
  /never-granted\.example/.test(note) && /also-not\.example/.test(note), note);

await page.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  await chrome.runtime.sendMessage({ type: MSG.SETTINGS_SET, payload: { mode: 'broad', allowlist: [] } });
});

// ---------------------------------------------------------------------------
// The language picker: the same control setup uses, saving as it goes.

await page.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  await chrome.runtime.sendMessage({ type: MSG.SETTINGS_SET, payload: { stemLanguages: ['en', 'de', 'nl'] } });
});
await page.reload();
await page.waitForTimeout(700);
const listed = await page.$$eval('#stemLanguages [data-lang]', (nodes) =>
  nodes.map((n) => n.dataset.lang + (n.checked ? '+' : '')));
check('an archive set up with the original three still shows Dutch, ticked',
  listed.includes('nl+') && listed.includes('en+') && listed.includes('de+'), listed.join());
check('and the new languages are offered beside them',
  ['es', 'pt', 'fr', 'it'].every((lang) => listed.includes(lang)), listed.join());

await page.check('#stemLanguages [data-lang="fr"]');
await page.uncheck('#stemLanguages [data-lang="de"]');
await page.waitForTimeout(500);
const languages = await page.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  return (await chrome.runtime.sendMessage({ type: MSG.SETTINGS_GET })).stemLanguages;
});
check('ticking and unticking saves straight away, in the order chosen',
  languages.join() === 'en,nl,fr', languages.join());

await page.uncheck('#stemLanguages [data-lang="nl"]');
await page.waitForTimeout(300);
const nlStillListed = await page.$$eval('#stemLanguages [data-lang]', (nodes) => nodes.map((n) => n.dataset.lang));
check('unticking a language that is not offered up front does not make it vanish',
  nlStillListed.includes('nl'), nlStillListed.join());

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
