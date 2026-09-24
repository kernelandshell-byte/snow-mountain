// The things the browser and the operating system do to it, rather than the
// things a person does.
//
// A laptop that comes back from sleep with next year's clock. A database left
// behind by a newer build, which is what installing an older one over it looks
// like. Two tabs finishing in the same millisecond and both filing the same
// URL against a unique index. Settings that come back from storage as a
// string. A page three times the size cap, and one word repeated fifteen
// thousand times. None of these are exotic; they are Tuesday.
//
//   npm install --no-save playwright
//   node test/browser/run-hostile.mjs

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { invariantCheck } from './invariants.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DAY = 86400000;

const profile = await mkdtemp(path.join(tmpdir(), 'sm-hostile-'));
const launch = () =>
  chromium.launchPersistentContext(profile, {
    headless: false,
    viewport: { width: 1000, height: 760 },
    args: ['--disable-extensions-except=' + root, '--load-extension=' + root, '--no-sandbox'],
  });

let context = await launch();
let worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
let extensionId = new URL(worker.url()).host;

const checks = [];
const errors = [];
const check = (name, condition, detail) => {
  const result = { name, ok: !!condition, detail: condition ? '' : String(detail) };
  checks.push(result);
  console.log(result.ok ? '  ok   ' + name : '  FAIL ' + name + '\n       ' + result.detail);
  return result.ok;
};
const note = (text) => console.log('  note  ' + text);
const phase = (title) => console.log('\n--- ' + title + ' ' + '-'.repeat(Math.max(0, 62 - title.length)));

async function driverPage() {
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(String(error)));
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      await page.goto('chrome-extension://' + extensionId + '/src/ui/options/options.html');
      return page;
    } catch (error) {
      if (attempt === 11) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  return page;
}

const ask = (page, type, payload) =>
  page.evaluate(
    async ({ t, p }) => {
      const { MSG } = await import('/src/shared/messages.js');
      return chrome.runtime.sendMessage({ type: MSG[t], payload: p });
    },
    { t: type, p: payload }
  );

let driver = await driverPage();
await ask(driver, 'SETTINGS_SET', { setupComplete: true, mode: 'broad' });

const seed = (page, count, tag, at) =>
  page.evaluate(async ({ n, prefix, when }) => {
    const { MSG } = await import('/src/shared/messages.js');
    const pages = [];
    for (let i = 0; i < n; i++) {
      pages.push({
        url: 'https://' + prefix + '.example/page-' + i,
        title: prefix + ' page ' + i,
        text: 'A page about retention and eviction and indexing, number ' + i +
          ', with a unique word ' + prefix + 'needle' + i + ' and plenty of ordinary words around it.',
        firstSeen: new Date(when).toISOString(),
        lastSeen: new Date(when).toISOString(),
      });
    }
    return chrome.runtime.sendMessage({ type: MSG.IMPORT, payload: { pages } });
  }, { n: count, prefix: tag, when: at });

// ---------------------------------------------------------------------------
phase('a clock that comes back from sleep set to next year');

await seed(driver, 40, 'clock', Date.now() - 30 * DAY);
const beforeClock = await ask(driver, 'STATS');
check('there is an archive to lose', beforeClock.docCount === 40, beforeClock.docCount);

// The worker's clock cannot be moved from a page, and mocking it would test
// the mock. What can be moved is the extension's own record of when it last
// swept, and that is the signal it actually reasons from: an hourly alarm
// firing four hundred days after the last one did not happen, whatever the
// clock says.
await ask(driver, 'SETTINGS_SET', { retentionMonths: 12, sizeCapBytes: 500 * 1024 * 1024 });
await ask(driver, 'MAINTENANCE');

// Every page in this archive is now past a one month retention limit, so
// without the guard the next sweep empties it.
await ask(driver, 'SETTINGS_SET', { retentionMonths: 1 });

const setSweepClock = (page, lastSweepAt) =>
  page.evaluate(async (at) => {
    const stored = await chrome.storage.local.get('sweepState');
    await chrome.storage.local.set({ sweepState: { ...(stored.sweepState || {}), lastSweepAt: at } });
  }, lastSweepAt);

await setSweepClock(driver, Date.now() - 400 * DAY);
const jumped = await ask(driver, 'MAINTENANCE');
const afterClock = await ask(driver, 'STATS');
note('after a four hundred day gap the archive holds ' + afterClock.docCount + ' of ' + beforeClock.docCount +
  ' pages; the sweep says ' + JSON.stringify(jumped));
check('a clock that jumps a year does not wipe the archive in one sweep',
  afterClock.docCount === beforeClock.docCount,
  'lost ' + (beforeClock.docCount - afterClock.docCount) + ' pages to a clock, which is not recoverable');
check('and it says why it left the age limit alone',
  jumped && jumped.clockProblem, JSON.stringify(jumped));
check('and settings can tell the user about it',
  afterClock.clockProblem, JSON.stringify(afterClock.clockProblem));

// A clock that comes back wrong the other way is the same problem mirrored:
// the extension has a record of sweeping in the future.
await setSweepClock(driver, Date.now() + 400 * DAY);
await ask(driver, 'MAINTENANCE');
const afterBackwards = await ask(driver, 'STATS');
check('a clock that has moved backwards does not wipe it either',
  afterBackwards.docCount === beforeClock.docCount,
  beforeClock.docCount + ' before, ' + afterBackwards.docCount + ' after');

// Used to: the guard held for one sweep only. That sweep recorded the wrong
// clock as its own, and the ordinary looking sweep an hour later deleted by
// it. The hold lasts a day.
const held = await ask(driver, 'MAINTENANCE');
const afterHeld = await ask(driver, 'STATS');
check('the sweep straight after a jump still leaves the age limit alone',
  afterHeld.docCount === beforeClock.docCount && held.clockProblem,
  JSON.stringify(held) + ' left ' + afterHeld.docCount);

// The guard is a pause, not an amnesty. Once the clock has been steady for
// the hold, the retention limit applies exactly as configured.
await driver.evaluate(async () => {
  const stored = await chrome.storage.local.get('sweepState');
  await chrome.storage.local.set({ sweepState: { ...stored.sweepState, clockHoldUntil: Date.now() - 1000 } });
});
const resumed = await ask(driver, 'MAINTENANCE');
const afterResume = await ask(driver, 'STATS');
note('the sweep after the jump removed ' + (beforeClock.docCount - afterResume.docCount) + ' pages');
check('the age limit applies again once the hold is over',
  afterResume.docCount < beforeClock.docCount && !resumed.clockProblem,
  JSON.stringify(resumed) + ' left ' + afterResume.docCount);

await ask(driver, 'SETTINGS_SET', { retentionMonths: 12 });
await seed(driver, 40, 'clock2', Date.now() - 30 * DAY);

// Pages filed while the clock was wrong carry timestamps from the future.
await driver.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  const future = Date.now() + 400 * 86400000;
  await chrome.runtime.sendMessage({
    type: MSG.IMPORT,
    payload: {
      pages: [{
        url: 'https://future.example/from-a-wrong-clock',
        title: 'Filed from the future',
        text: 'A page captured while the clock was a year ahead, carrying a futureneedle word.',
        firstSeen: new Date(future).toISOString(),
        lastSeen: new Date(future).toISOString(),
      }],
    },
  });
});

const withFuture = await ask(driver, 'STATS');
check('a page dated in the future does not break the storage meter',
  Number.isFinite(withFuture.usedBytes) && withFuture.budget.fraction >= 0 &&
    Number.isFinite(withFuture.budget.fraction),
  JSON.stringify(withFuture.budget));
check('and does not produce a projection that has already passed',
  !withFuture.exhaustsAt || withFuture.exhaustsAt >= Date.now(),
  'says the archive fills up on ' + new Date(withFuture.exhaustsAt || 0).toISOString());
check('and does not report a pace of the whole archive per day',
  !(withFuture.pace.bytesPerDay > withFuture.usedBytes),
  JSON.stringify(withFuture.pace));

const futureSearch = await ask(driver, 'SEARCH', { query: 'futureneedle' });
check('a page from the future is still findable', futureSearch.results.length === 1,
  futureSearch.results.length);

// ---------------------------------------------------------------------------
phase('two tabs filing the same page in the same millisecond');

const race = await driver.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  const payload = {
    url: 'https://race.example/one-page-two-tabs',
    title: 'Filed twice at once',
    text: 'A page that two tabs both decided was read at exactly the same moment, with a raceneedle word in it.',
    capturedAt: Date.now(),
  };
  const both = await Promise.all([
    chrome.runtime.sendMessage({ type: MSG.PAGE_CONTENT, payload }),
    chrome.runtime.sendMessage({ type: MSG.PAGE_CONTENT, payload }),
  ]);
  const found = await chrome.runtime.sendMessage({ type: MSG.SEARCH, payload: { query: 'raceneedle' } });
  return { both, results: found.results.length };
});

note('two simultaneous writes answered: ' + JSON.stringify(race.both));
check('one page, not two, when two tabs file it at once', race.results === 1, race.results + ' copies');
check('and neither tab is told the page was lost',
  race.both.every((r) => r && !r.error), JSON.stringify(race.both));

// ---------------------------------------------------------------------------
phase('settings that are not settings');

const shapes = [
  ['a string', 'nonsense'],
  ['a number', 42],
  ['an array', ['broad']],
  ['null presets', { setupComplete: true, mode: 'broad', presets: null, customRules: null, allowlist: null }],
  ['the wrong types throughout', { mode: 7, presets: 'yes', customRules: 'no', allowlist: {}, sizeCapBytes: 'big', retentionMonths: null }],
];

for (const [label, value] of shapes) {
  const outcome = await driver.evaluate(async ({ v }) => {
    const { MSG } = await import('/src/shared/messages.js');
    await chrome.storage.local.set({ settings: v });
    const out = {};
    try {
      out.stats = await chrome.runtime.sendMessage({ type: MSG.STATS });
    } catch (error) { out.statsThrew = String(error.message || error); }
    try {
      out.status = await chrome.runtime.sendMessage({
        type: MSG.PAGE_STATUS, payload: { url: 'https://example.com/a' },
      });
    } catch (error) { out.statusThrew = String(error.message || error); }
    try {
      out.sweep = await chrome.runtime.sendMessage({ type: MSG.MAINTENANCE });
    } catch (error) { out.sweepThrew = String(error.message || error); }
    return out;
  }, { v: value });

  check('settings as ' + label + ': the popup still gets an answer',
    outcome.stats && !outcome.stats.error && typeof outcome.stats.docCount === 'number',
    JSON.stringify(outcome.stats || outcome.statsThrew));
  check('settings as ' + label + ': the capture policy still decides',
    outcome.status && !outcome.status.error && typeof outcome.status.capturable === 'boolean',
    JSON.stringify(outcome.status || outcome.statusThrew));
  check('settings as ' + label + ': the sweep does not delete everything',
    outcome.sweep && !outcome.sweep.error && outcome.sweep.evicted === 0,
    JSON.stringify(outcome.sweep || outcome.sweepThrew));
}

await driver.evaluate(() => chrome.storage.local.remove('settings'));
await ask(driver, 'SETTINGS_SET', { setupComplete: true, mode: 'broad', retentionMonths: 12, sizeCapBytes: 500 * 1024 * 1024 });

const afterJunk = await ask(driver, 'STATS');
check('nothing was lost to a run of corrupted settings',
  afterJunk.docCount >= 40, afterJunk.docCount + ' pages left');

// ---------------------------------------------------------------------------
phase('pages that are the wrong shape');

const huge = await driver.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  // Three times the text cap, and every character multibyte, so the UTF-8
  // length is well past what a code unit count suggests.
  const big = 'Straße und Grünflächen mit Bäumen. '.repeat(20000);
  const started = performance.now();
  const stored = await chrome.runtime.sendMessage({
    type: MSG.PAGE_CONTENT,
    payload: { url: 'https://huge.example/enormous', title: 'An enormous page', text: big + ' hugeneedle', capturedAt: Date.now() },
  });
  const ms = performance.now() - started;
  const found = await chrome.runtime.sendMessage({ type: MSG.SEARCH, payload: { query: 'grünflächen' } });
  return { stored, ms: Math.round(ms), found: found.results.length, tookMs: found.tookMs };
});
note('a ' + '700KB' + ' page indexed in ' + huge.ms + 'ms');
check('an enormous page is truncated rather than refused', huge.stored && huge.stored.ok, JSON.stringify(huge.stored));
check('and indexing it does not take a visible amount of time', huge.ms < 4000, huge.ms + 'ms');
check('and it is findable afterwards', huge.found > 0, huge.found);

const repeated = await driver.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  const started = performance.now();
  const stored = await chrome.runtime.sendMessage({
    type: MSG.PAGE_CONTENT,
    payload: {
      url: 'https://repeat.example/one-word',
      title: 'One word, many times',
      text: ('drumbeat ').repeat(15000) + ' repeatneedle',
      capturedAt: Date.now(),
    },
  });
  const ms = performance.now() - started;
  const phrase = await chrome.runtime.sendMessage({
    type: MSG.SEARCH, payload: { query: '"drumbeat drumbeat"' },
  });
  const plain = await chrome.runtime.sendMessage({ type: MSG.SEARCH, payload: { query: 'repeatneedle' } });
  return { stored, ms: Math.round(ms), phrase: phrase.results.length, plain: plain.results.length };
});
note('one word fifteen thousand times indexed in ' + repeated.ms + 'ms');
check('one word repeated fifteen thousand times is stored', repeated.stored && repeated.stored.ok,
  JSON.stringify(repeated.stored));
check('a phrase query against it still answers', repeated.phrase >= 0 && repeated.ms < 4000,
  JSON.stringify(repeated));
check('and the page is findable by its one distinctive word', repeated.plain === 1, repeated.plain);

// A single page larger than the whole size cap: the sweep can never satisfy
// the budget, and must stop rather than spin.
await ask(driver, 'SETTINGS_SET', { sizeCapBytes: 50 * 1024 });
const spun = await driver.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  const started = performance.now();
  let rounds = 0;
  for (let i = 0; i < 60; i++) {
    const result = await chrome.runtime.sendMessage({ type: MSG.MAINTENANCE });
    rounds += 1;
    if (!result.evicted) break;
  }
  const stats = await chrome.runtime.sendMessage({ type: MSG.STATS });
  return { rounds, ms: Math.round(performance.now() - started), left: stats.docCount, level: stats.budget.level };
});
note('a cap smaller than one stored page settled after ' + spun.rounds + ' rounds in ' + spun.ms + 'ms, ' +
  spun.left + ' pages left');
check('a cap that one page alone exceeds does not spin for ever',
  spun.rounds < 60, 'still evicting after 60 rounds');
await ask(driver, 'SETTINGS_SET', { sizeCapBytes: 500 * 1024 * 1024 });

// ---------------------------------------------------------------------------
phase('an article that has since gone behind a paywall');

const paywalled = await driver.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  const url = 'https://paper.example/the-piece-you-read';
  const article = 'The piece you actually read, with paywallneedle in it. ' +
    'A great deal of substance around it, sentence after sentence. '.repeat(40);
  const stub = 'Subscribe to continue reading this article. Already a member? Sign in.';

  await chrome.runtime.sendMessage({
    type: MSG.PAGE_CONTENT,
    payload: { url, title: 'The piece you read', text: article, capturedAt: Date.now() },
  });
  const before = await chrome.runtime.sendMessage({ type: MSG.SEARCH, payload: { query: 'paywallneedle' } });

  // Weeks later, the same URL serves three sentences and a subscribe button.
  const revisit = await chrome.runtime.sendMessage({
    type: MSG.PAGE_CONTENT,
    payload: { url, title: 'The piece you read', text: stub, capturedAt: Date.now() },
  });
  const after = await chrome.runtime.sendMessage({ type: MSG.SEARCH, payload: { query: 'paywallneedle' } });
  const status = await chrome.runtime.sendMessage({ type: MSG.PAGE_STATUS, payload: { url } });

  // Whereas an ordinary edit is still an ordinary edit.
  const edited = article.replace('a great deal of', 'a great deal more of') + ' editneedle';
  await chrome.runtime.sendMessage({
    type: MSG.PAGE_CONTENT,
    payload: { url, title: 'The piece you read', text: edited, capturedAt: Date.now() },
  });
  const afterEdit = await chrome.runtime.sendMessage({ type: MSG.SEARCH, payload: { query: 'editneedle' } });

  return {
    before: before.results.length,
    revisit,
    after: after.results.length,
    visits: status.kept && status.kept.visitCount,
    afterEdit: afterEdit.results.length,
  };
});

check('the article is there to begin with', paywalled.before === 1, paywalled.before);
check('a paywall stub does not replace the article you read',
  paywalled.after === 1,
  'the page is no longer findable by its own words, which is the one thing this is for');
check('and the revisit says it kept the older version',
  paywalled.revisit && paywalled.revisit.keptOlderVersion === true, JSON.stringify(paywalled.revisit));
check('the visit still counts, because you did visit it',
  paywalled.visits >= 2, paywalled.visits);
check('and a genuine edit is still indexed normally',
  paywalled.afterEdit === 1, paywalled.afterEdit + ' results for a word only the edited version has');

// ---------------------------------------------------------------------------
phase('a page deleted while a search for it is in flight');

await seed(driver, 30, 'inflight', Date.now());
const inflight = await driver.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  const out = [];
  for (let round = 0; round < 6; round++) {
    const first = await chrome.runtime.sendMessage({
      type: MSG.SEARCH, payload: { query: 'retention eviction indexing' },
    });
    if (!first.results.length) break;
    const victim = first.results[0].id;
    const [searched] = await Promise.all([
      chrome.runtime.sendMessage({ type: MSG.SEARCH, payload: { query: 'retention eviction indexing' } }),
      chrome.runtime.sendMessage({ type: MSG.FORGET, payload: { scope: 'page', id: victim } }),
    ]);
    out.push({
      ok: !searched.error,
      results: searched.results.length,
      wellFormed: searched.results.every((r) => r && r.url && r.snippet && Array.isArray(r.snippet.ranges)),
    });
  }
  return out;
});
check('a search racing a delete always answers', inflight.length > 0 && inflight.every((r) => r.ok),
  JSON.stringify(inflight));
check('and never returns a half built result', inflight.every((r) => r.wellFormed),
  JSON.stringify(inflight));

// ---------------------------------------------------------------------------
phase('a database left behind by a newer build');

// Installing an older build over a newer one leaves a database whose version
// is ahead of the code. Opening it would either fail or, worse, mangle it.
await driver.evaluate(async () => {
  await new Promise((resolve, reject) => {
    const request = indexedDB.open('archive', 99);
    request.onupgradeneeded = () => {};
    request.onsuccess = () => { request.result.close(); resolve(); };
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  });
});
await driver.waitForTimeout(600);

const refused = await ask(driver, 'STATS');
note('against a newer database the worker answers: ' + JSON.stringify(refused).slice(0, 160));
check('an archive it cannot open is not reported as an empty one',
  !(refused && refused.ready && refused.docCount === 0),
  'after a year of use it would say "nothing kept yet", which is how somebody throws away an archive that was fine');
check('and the answer says what is actually wrong',
  refused && (refused.error || refused.unavailable),
  JSON.stringify(refused));

const popup = await context.newPage();
popup.on('pageerror', (error) => errors.push('popup: ' + String(error)));
await popup.goto('chrome-extension://' + extensionId + '/src/ui/popup/popup.html');
await popup.waitForTimeout(900);
const popupText = await popup.textContent('body');
note('popup says: ' + popupText.replace(/\s+/g, ' ').trim().slice(0, 160));
check('the popup does not claim the archive is empty',
  !/Nothing kept yet/i.test(popupText), popupText.replace(/\s+/g, ' ').slice(0, 120));
check('the popup does not offer to finish a setup that is already done',
  !/Finish setting up/i.test(popupText), popupText.replace(/\s+/g, ' ').slice(0, 120));
check('the popup does not print undefined at the user',
  !/undefined/i.test(popupText), popupText.replace(/\s+/g, ' ').slice(0, 160));
check('the popup says the archive could not be opened',
  /could not be opened|couldn't be opened|cannot be opened|not available/i.test(popupText),
  popupText.replace(/\s+/g, ' ').slice(0, 160));
await popup.close();

const settingsPage = await context.newPage();
settingsPage.on('pageerror', (error) => errors.push('options: ' + String(error)));
await settingsPage.goto('chrome-extension://' + extensionId + '/src/ui/options/options.html');
await settingsPage.waitForTimeout(900);
const settingsText = await settingsPage.textContent('body');
check('settings says so too rather than going quiet',
  /could not be opened|couldn't be opened|cannot be opened|not available/i.test(settingsText),
  settingsText.replace(/\s+/g, ' ').slice(0, 200));
check('and settings does not print undefined either',
  !/undefined/i.test(settingsText), settingsText.replace(/\s+/g, ' ').slice(0, 160));
await settingsPage.close();

// ---------------------------------------------------------------------------
phase('and afterwards');

// Delete the impostor database and confirm the extension recovers rather than
// needing a reinstall.
await driver.evaluate(async () => {
  await new Promise((resolve) => {
    const request = indexedDB.deleteDatabase('archive');
    request.onsuccess = resolve;
    request.onerror = resolve;
    request.onblocked = resolve;
    setTimeout(resolve, 4000);
  });
});
await driver.waitForTimeout(500);

const recovered = await ask(driver, 'STATS');
check('once the database is gone the extension starts again cleanly',
  recovered && !recovered.error && recovered.docCount === 0, JSON.stringify(recovered));

const captureAgain = await ask(driver, 'PAGE_CONTENT', {
  url: 'https://recovered.example/a',
  title: 'After all that',
  text: 'A page captured after the database was replaced, with a recoveredneedle word in it.',
  capturedAt: Date.now(),
});
check('and capture works', captureAgain && captureAgain.ok, JSON.stringify(captureAgain));

const finalInvariants = await driver.evaluate(invariantCheck, { deep: true });
check('the index is consistent after everything above',
  finalInvariants.problems.length === 0, JSON.stringify(finalInvariants.problems));

await context.close();
await rm(profile, { recursive: true, force: true });

const failed = checks.filter((result) => !result.ok).length;
console.log('');
for (const error of errors) console.log('  page error: ' + error);
console.log(checks.length - failed + ' passed, ' + failed + ' failed');
process.exit(failed || errors.length ? 1 : 0);
