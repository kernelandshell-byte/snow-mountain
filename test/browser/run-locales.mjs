// The whole interface, in every language it speaks, in a browser that is
// really set to that language.
//
// Chrome on Linux takes its interface language from the LANGUAGE environment
// variable, not from --lang, which is the part that is easy to get wrong and
// which makes a test look like it passed while still reading English. So the
// first thing checked per language is that Chrome itself reports the language.
//
// Then, on every screen: the text on the page is the translation (not English,
// not a raw message key, not a placeholder left unfilled), the plural and date
// forms come out as that language writes them, the page does not scroll
// sideways (German and French run long), and nothing logged an error.
//
//   node test/browser/run-locales.mjs [--only de-DE,fr-FR] [--screenshots dir]

import { chromium } from 'playwright';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { getMessage, setLocale } from '../helpers/chrome-i18n.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const onlyIndex = process.argv.indexOf('--only');
const only = onlyIndex === -1 ? null : process.argv[onlyIndex + 1].split(',');
const shotIndex = process.argv.indexOf('--screenshots');
const shotDir = shotIndex === -1 ? null : process.argv[shotIndex + 1];
if (shotDir) await mkdir(shotDir, { recursive: true });

// [what the browser is set to, the message folder Chrome should read, the
// language the page should report]
const LANGUAGES = [
  ['en-US', 'en', 'en'],
  ['de-DE', 'de', 'de'],
  ['es-ES', 'es', 'es'],
  ['fr-FR', 'fr', 'fr'],
  ['it-IT', 'it', 'it'],
  ['nl-NL', 'nl', 'nl'],
  ['pt-BR', 'pt_BR', 'pt'],
  ['pt-PT', 'pt_PT', 'pt'],
];
// Regional variants Chrome has to fold into a language we ship, and one it
// has to hand back to English.
const FALLBACKS = [
  ['es-419', 'es_419', 'es'], ['fr-CA', 'fr_CA', 'fr'], ['de-CH', 'de_CH', 'de'], ['sv-SE', 'sv', 'en'],
];

const checks = [];
const errors = [];
const check = (name, condition, detail) => {
  checks.push({ name, ok: !!condition });
  console.log(condition ? '  ok   ' + name : '  FAIL ' + name + '\n       ' + String(detail));
};

const TAGS = /<\/?(kbd|code|strong|em)>/g;
const words = (text) => String(text).replace(/\s+/g, ' ').trim();
const plain = (message) => words(message.replace(TAGS, ''));
const DAY = 86400000;

const EN_KEYS = Object.keys(JSON.parse((await import('node:fs')).readFileSync(path.join(root, '_locales/en/messages.json'), 'utf8')));
const RAW_KEY = new RegExp('\\b(?:' + EN_KEYS.join('|') + ')\\b');

async function launch(locale, folder) {
  const context = await chromium.launchPersistentContext('', {
    headless: false,
    locale,
    viewport: { width: 1000, height: 800 },
    env: { ...process.env, LANGUAGE: folder, LC_ALL: folder + '.UTF-8', LANG: folder + '.UTF-8' },
    args: ['--disable-extensions-except=' + root, '--load-extension=' + root, '--no-sandbox', '--lang=' + locale],
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  context.on('page', (page) => {
    page.on('pageerror', (error) => errors.push(locale + ': ' + error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(locale + ': ' + message.text()); });
  });
  return { context, base: 'chrome-extension://' + new URL(worker.url()).host };
}

async function seed(context, base) {
  const page = await context.newPage();
  await page.goto(base + '/src/ui/options/options.html');
  await page.evaluate(async (ages) => {
    const { CORPUS } = await import('/test/fixtures/corpus.js');
    const { MSG } = await import('/src/shared/messages.js');
    await chrome.runtime.sendMessage({ type: MSG.SETTINGS_SET, payload: { setupComplete: true, mode: 'broad', customRules: ['bank.example'] } });
    for (const [i, age] of ages.entries()) {
      const doc = CORPUS[i];
      await chrome.runtime.sendMessage({ type: MSG.PAGE_CONTENT, payload: {
        url: doc.url, title: doc.title, text: doc.text, capturedAt: Date.now() - age * 86400000 } });
    }
  }, [0, 1, 3, 20, 45, 100, 400, 800]);
  await page.close();
}

let wanted = 'en';

// Everything marked for translation on the page says what the language says.
async function checkMarkup(page, label, ignore = []) {
  const found = await page.evaluate((skip) => {
    const out = { text: [], attrs: [], lang: document.documentElement.lang, body: document.body.innerText };
    for (const element of document.querySelectorAll('[data-i18n]')) {
      if (skip.includes(element.id)) continue;
      out.text.push({ key: element.dataset.i18n, text: element.textContent });
    }
    for (const attribute of ['placeholder', 'title', 'aria-label']) {
      for (const element of document.querySelectorAll('[data-i18n-' + attribute + ']')) {
        out.attrs.push({ key: element.getAttribute('data-i18n-' + attribute), attribute, value: element.getAttribute(attribute) });
      }
    }
    return out;
  }, ignore);
  const wrong = [];
  check(`${label}: the page declares its language`, found.lang.toLowerCase().startsWith(wanted.split('_')[0]), found.lang);
  for (const { key, text } of found.text) if (words(text) !== plain(getMessage(key))) wrong.push(`${key}: "${words(text)}" is not "${plain(getMessage(key))}"`);
  for (const { key, attribute, value } of found.attrs) if (value !== getMessage(key)) wrong.push(`${key}[${attribute}]: "${value}"`);
  check(`${label}: the marked text is the translation (${found.text.length + found.attrs.length} items)`, !wrong.length, wrong.slice(0, 4).join(' | '));
  check(`${label}: no raw message key or unfilled placeholder shows`,
    !RAW_KEY.test(found.body) && !/\$[A-Za-z0-9_]+\$/.test(found.body), found.body.match(RAW_KEY) || found.body.match(/\$[A-Za-z0-9_]+\$/));
  return found;
}

async function noSideways(page, label) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(`${label}: does not scroll sideways`, over <= 0, over + 'px too wide');
}

async function visit(context, base, url, { width = 1000, height = 800, tab, prepare } = {}) {
  const page = await context.newPage();
  await page.setViewportSize({ width, height });
  if (tab) await page.addInitScript((t) => { chrome.tabs.query = () => Promise.resolve([t]); }, tab);
  await page.goto(base + url);
  await page.waitForTimeout(500);
  if (prepare) await prepare(page);
  await page.waitForTimeout(400);
  return page;
}

for (const [locale, folder, language] of [...LANGUAGES, ...FALLBACKS]) {
  if (only && !only.includes(locale)) continue;
  const fallbackOnly = FALLBACKS.some((entry) => entry[0] === locale);
  console.log('\n' + locale + (fallbackOnly ? ' (a variant)' : ''));
  const { context, base } = await launch(locale, folder);
  // What Chrome will serve is decided by Chrome. The test's own lookups follow
  // the same rule: the region, then the language, then English.
  wanted = fallbackOnly ? (language === 'en' ? 'en' : language) : folder;
  setLocale(wanted);
  const bcp = wanted.replace('_', '-');

  const probe = await context.newPage();
  await probe.goto(base + '/src/ui/options/options.html');
  const reported = await probe.evaluate(() => ({
    settings: chrome.i18n.getMessage('common_settings'),
    name: chrome.runtime.getManifest().name,
    description: chrome.runtime.getManifest().description,
  }));
  await probe.close();
  check(`Chrome itself serves ${wanted}: "${reported.settings}"`, reported.settings === getMessage('common_settings'), JSON.stringify(reported));
  check('the extension name is never translated', reported.name === 'TextMemory', reported.name);
  check('the store description is the translation', reported.description === getMessage('extDescription'), reported.description);
  if (fallbackOnly) { await context.close(); continue; }

  await seed(context, base);

  // --- search ---------------------------------------------------------------
  let page = await visit(context, base, '/src/ui/search/search.html', { prepare: async (p) => { await p.fill('#q', 'retention'); await p.waitForTimeout(700); } });
  await checkMarkup(page, 'search');
  const meta = words(await page.textContent('#meta'));
  const total = Number((meta.match(/\d+/) || [])[0]);
  const expectedCount = getMessage('pages_' + (new Intl.PluralRules(bcp).select(total) === 'one' ? 'one' : 'other'), total.toLocaleString(bcp));
  check('search: the result count is written as this language writes it', meta.toLowerCase().startsWith(expectedCount.toLowerCase()), `"${meta}" should start with "${expectedCount}"`);
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const whenPattern = new RegExp('(?:' + ['when_today', 'when_yesterday', 'when_days_ago', 'when_months_ago', 'when_last_month', 'when_last_year', 'when_years_ago']
    .map((key) => escape(getMessage(key, '\u0000')).replace('\u0000', '\\d[\\d.,\\s\u202f\u00a0]*')).join('|') + ')$', 'i');
  const sources = await page.$$eval('.source', (nodes) => nodes.map((n) => n.textContent));
  check('search: every result date is one of this language\'s date phrases', sources.length > 0 && sources.every((text) => whenPattern.test(words(text))), sources.join(' | '));
  await noSideways(page, 'search (1000px)');
  if (shotDir) await page.screenshot({ path: path.join(shotDir, `search-${locale}.png`) });
  await page.setViewportSize({ width: 380, height: 800 });
  await noSideways(page, 'search (380px)');
  await page.close();

  page = await visit(context, base, '/src/ui/search/search.html', { prepare: async (p) => { await p.fill('#q', 'zzqqxx'); await p.waitForTimeout(700); } });
  const nothing = await page.textContent('.empty');
  check('search: "nothing matched" is the translation', words(nothing).includes(plain(getMessage('search_nothing_title'))), nothing);
  await page.close();

  page = await visit(context, base, '/src/ui/search/search.html');
  await checkMarkup(page, 'search (empty)');
  const tip = words(await page.textContent('.empty'));
  check('search: the tip explains the syntax in this language', tip.includes(plain(getMessage('search_tip_title'))) && tip.includes('site:example.com'), tip);
  await page.close();

  // --- popup, three situations ----------------------------------------------
  const when1 = getMessage('when_yesterday');
  for (const [name, url, expected] of [
    ['kept', 'https://teamcraft.example/written-standup', () => getMessage('popup_kept', when1)],
    ['not kept yet', 'https://new.example/page', () => getMessage('popup_not_kept_yet')],
    ['excluded', 'https://bank.example/accounts', () => getMessage('popup_not_kept', getMessage('reason_excluded'))],
  ]) {
    page = await visit(context, base, '/src/ui/popup/popup.html', { width: 352, height: 640, tab: { id: 1, url } });
    await page.waitForFunction(() => !document.getElementById('pageStatus').textContent.startsWith('Checking') && !document.getElementById('pageStatus').dataset.pending, null, { timeout: 5000 }).catch(() => {});
    await checkMarkup(page, 'popup (' + name + ')', ['pageStatus']);
    const status = words(await page.textContent('#pageStatus'));
    check(`popup (${name}): the status is the translation`, status === words(expected()), `"${status}" vs "${words(expected())}"`);
    await noSideways(page, 'popup (' + name + ')');
    if (shotDir && name === 'kept') await page.screenshot({ path: path.join(shotDir, `popup-${locale}.png`), fullPage: true });
    await page.close();
  }

  // --- settings --------------------------------------------------------------
  page = await visit(context, base, '/src/ui/options/options.html');
  await checkMarkup(page, 'settings');
  const presetTitles = await page.$$eval('#presets label > span:first-of-type', (nodes) => nodes.map((n) => n.textContent));
  check('settings: every exclusion category is named in this language',
    presetTitles.length === 12 && presetTitles.every((t, i) => t === getMessage(`preset_${['webmail', 'messaging', 'aiChats', 'accounts', 'banking', 'health', 'adult', 'dating', 'government', 'intranet', 'workTools', 'searchResults'][i]}_title`)), presetTitles.join(' | '));
  const langNames = await page.$$eval('#stemLanguages .picker-name', (nodes) => nodes.map((n) => n.textContent));
  const names = new Intl.DisplayNames([bcp], { type: 'language' });
  // A Dutch browser pre-ticks Dutch, and a chosen language stays listed.
  const expectedNames = ['en', 'es', 'pt', 'de', 'fr', 'it', ...(folder === 'nl' ? ['nl'] : [])].map((code) => { const n = names.of(code); return n.charAt(0).toLocaleUpperCase(bcp) + n.slice(1); });
  check('settings: the language list names languages in this language', JSON.stringify(langNames) === JSON.stringify(expectedNames), langNames.join(' | ') + ' vs ' + expectedNames.join(' | '));
  await noSideways(page, 'settings (1000px)');
  if (shotDir) await page.screenshot({ path: path.join(shotDir, `settings-${locale}.png`), fullPage: true });
  await page.setViewportSize({ width: 380, height: 800 });
  await noSideways(page, 'settings (380px)');
  await page.close();

  // --- plurals, dates and reasons, asked of the real modules -----------------
  page = await visit(context, base, '/src/ui/options/options.html');
  const forms = await page.evaluate(async () => {
    const { pageCount } = await import('/src/shared/format.js');
    const { whenText } = await import('/src/ui/shared/when.js');
    const { reasonText } = await import('/src/shared/reasons.js');
    const day = 86400000;
    return {
      pages: [0, 1, 2, 12345].map((n) => pageCount(n)),
      when: [0, 1, 3, 45, 400, 800].map((n) => whenText(Date.now() - n * day)),
      reasons: ['paused', 'not on your allowlist', 'excluded: shop.example', 'a reason nobody wrote'].map((r) => reasonText(r)),
    };
  });
  const rules = new Intl.PluralRules(bcp);
  const expectedPages = [0, 1, 2, 12345].map((n) => getMessage('pages_' + (rules.select(n) === 'one' ? 'one' : 'other'), n.toLocaleString(bcp)));
  check('pages: 0, 1, 2 and 12,345 follow the language\'s plural rules', JSON.stringify(forms.pages) === JSON.stringify(expectedPages), forms.pages.join(' | ') + ' vs ' + expectedPages.join(' | '));
  const expectedWhen = [getMessage('when_today'), getMessage('when_yesterday'), getMessage('when_days_ago', '3'), getMessage('when_months_ago', '2'), getMessage('when_last_year'), getMessage('when_years_ago', '2')];
  check('dates: today, yesterday, days, months and years read in this language', JSON.stringify(forms.when) === JSON.stringify(expectedWhen), forms.when.join(' | ') + ' vs ' + expectedWhen.join(' | '));
  check('reasons: known ones are translated, an unknown one is left as it came',
    forms.reasons[0] === getMessage('reason_paused') && forms.reasons[1] === getMessage('reason_allowlist') &&
      forms.reasons[2] === getMessage('reason_excluded') && forms.reasons[3] === 'a reason nobody wrote', forms.reasons.join(' | '));
  await page.close();

  // --- setup, walked through ---------------------------------------------------
  page = await visit(context, base, '/src/ui/setup/setup.html', { width: 380, height: 800 });
  const stepOf = () => page.evaluate(() => [...document.querySelectorAll('section[data-step]')].find((s) => !s.hidden).dataset.step);
  const look = async (expectedStep) => {
    check(`setup: on step ${expectedStep}`, (await stepOf()) === String(expectedStep), await stepOf());
    await checkMarkup(page, 'setup step ' + expectedStep);
    await noSideways(page, 'setup step ' + expectedStep + ' (380px)');
    if (shotDir) await page.screenshot({ path: path.join(shotDir, `setup${expectedStep}-${locale}.png`), fullPage: true });
  };
  await look(0);
  await page.click('section[data-step="0"] [data-next]');
  await look(1);
  await page.check('input[name="mode"][value="strict"]');
  await page.click('#chooseMode');
  await look(3);
  const capacity = words(await page.textContent('#capacity'));
  check('setup: the size note is a sentence in this language', capacity.length > 0 && capacity !== 'limit_capacity' && !/Roughly/.test(capacity) === (language !== 'en'), capacity);
  await page.click('section[data-step="3"] [data-next]');
  await look(4);
  await page.click('#finish');
  await page.waitForTimeout(500);
  await look(5);
  const done = words(await page.textContent('#doneNote'));
  check('setup: the closing message is the translation', done === plain(getMessage('setup_done_strict')), done);
  const hint = await page.$eval('#doneHint', (el) => ({ text: el.textContent, kbds: el.querySelectorAll('kbd').length }));
  check('setup: the address-bar hint carries its key caps', hint.kbds >= 1 && hint.text.includes('tm'), JSON.stringify(hint));
  await page.close();

  await context.close();
}

console.log('');
check('nothing logged an error in any language', errors.length === 0, errors.slice(0, 5).join('\n       '));
const failed = checks.filter((c) => !c.ok).length;
console.log('\n' + (checks.length - failed) + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
