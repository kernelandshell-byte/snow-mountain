// Dark mode, small windows, and using the thing without a mouse. None of
// this is exotic: half of people browse in dark mode, and a search tool that
// cannot be driven from the keyboard has missed its own point.
//
//   node test/browser/run-presentation.mjs [--screenshots dir]

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const shotIndex = process.argv.indexOf('--screenshots');
const shotDir = shotIndex === -1 ? null : process.argv[shotIndex + 1];
if (shotDir) await mkdir(shotDir, { recursive: true });

const checks = [];
const check = (name, condition, detail) => {
  const ok = !!condition;
  checks.push({ name, ok });
  console.log(ok ? '  ok   ' + name : '  FAIL ' + name + '\n       ' + String(detail));
};

// Relative luminance, so contrast can be judged rather than eyeballed.
function luminance(rgb) {
  const [r, g, b] = rgb.map((value) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => {
  const light = Math.max(luminance(a), luminance(b));
  const dark = Math.min(luminance(a), luminance(b));
  return (light + 0.05) / (dark + 0.05);
};
const parseRgb = (value) => (value.match(/\d+/g) || ['0', '0', '0']).slice(0, 3).map(Number);

for (const scheme of ['light', 'dark']) {
  const context = await chromium.launchPersistentContext('', {
    headless: false,
    colorScheme: scheme,
    viewport: { width: 1000, height: 800 },
    args: ['--disable-extensions-except=' + root, '--load-extension=' + root, '--no-sandbox'],
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;

  const seed = await context.newPage();
  await seed.goto('chrome-extension://' + id + '/src/ui/options/options.html');
  await seed.evaluate(async () => {
    const { CORPUS } = await import('/test/fixtures/corpus.js');
    const { MSG } = await import('/src/shared/messages.js');
    await chrome.runtime.sendMessage({ type: MSG.SETTINGS_SET, payload: { setupComplete: true, mode: 'broad' } });
    let age = 0;
    for (const doc of CORPUS.slice(0, 10)) {
      await chrome.runtime.sendMessage({
        type: MSG.PAGE_CONTENT,
        payload: { url: doc.url, title: doc.title, text: doc.text, capturedAt: Date.now() - age++ * 9 * 86400000 },
      });
    }
  });
  await seed.close();

  const pages = {
    search: '/src/ui/search/search.html?q=cohort%20chart%20retention',
    popup: '/src/ui/popup/popup.html',
    options: '/src/ui/options/options.html',
    setup: '/src/ui/setup/setup.html',
  };

  for (const [name, url] of Object.entries(pages)) {
    const page = await context.newPage();
    if (name === 'popup') {
      await page.addInitScript(() => {
        chrome.tabs.query = () => Promise.resolve([{ id: 1, url: 'https://teamcraft.example/retro-fatigue' }]);
      });
      await page.setViewportSize({ width: 380, height: 640 });
    }
    await page.goto('chrome-extension://' + id + url);
    await page.waitForTimeout(700);

    const readable = await page.evaluate(() => {
      const body = getComputedStyle(document.body);
      const sample = document.querySelector('h1, h2, p, .status') || document.body;
      return {
        background: body.backgroundColor,
        text: getComputedStyle(sample).color,
        transparentBody: body.backgroundColor === 'rgba(0, 0, 0, 0)',
      };
    });

    check(scheme + ' ' + name + ': the page paints its own background', !readable.transparentBody,
      readable.background);
    const ratio = contrast(parseRgb(readable.background), parseRgb(readable.text));
    check(scheme + ' ' + name + ': text is legible against it, ' + ratio.toFixed(1) + ' to 1',
      ratio >= 4.5, readable.background + ' behind ' + readable.text);

    // Chrome paints its own controls -- a checkbox, a radio, a scrollbar --
    // from color-scheme, not from the page's colours. Unset, an unticked box
    // stays bright white on the dark theme.
    const controls = await page.evaluate(() => {
      const paint = (element) => {
        for (let node = element.parentElement; node; node = node.parentElement) {
          const background = getComputedStyle(node).backgroundColor;
          if (background !== 'rgba(0, 0, 0, 0)') return background;
        }
        return getComputedStyle(document.body).backgroundColor;
      };
      return {
        scheme: getComputedStyle(document.documentElement).colorScheme,
        fields: [...document.querySelectorAll('input:not([type="checkbox"]):not([type="radio"]):not([type="file"]), select, textarea')]
          .filter((element) => element.offsetParent !== null)
          .map((element) => ({
            what: element.id || element.type || element.tagName,
            border: getComputedStyle(element).borderTopColor,
            behind: paint(element),
          })),
      };
    });
    check(scheme + ' ' + name + ': Chrome is told which theme its own controls are in',
      /dark/.test(controls.scheme), controls.scheme);
    // A field is recognised by its outline, so the outline is held to the
    // 3:1 non-text contrast a field boundary needs, not the rule lines' 1.5.
    const faintFields = controls.fields
      .map((field) => ({ ...field, ratio: contrast(parseRgb(field.border), parseRgb(field.behind)) }))
      .filter((field) => field.ratio < 3);
    check(scheme + ' ' + name + ': every field outline clears 3:1 (' + controls.fields.length + ' fields)',
      faintFields.length === 0, JSON.stringify(faintFields));

    if (shotDir) await page.screenshot({ path: path.join(shotDir, scheme + '-' + name + '.png'), fullPage: name !== 'popup' });
    await page.close();
  }

  // --- a narrow window ------------------------------------------------------
  if (scheme === 'light') {
    for (const [name, url] of Object.entries({
      search: '/src/ui/search/search.html?q=retention',
      options: '/src/ui/options/options.html',
      setup: '/src/ui/setup/setup.html',
    })) {
      const narrow = await context.newPage();
      await narrow.setViewportSize({ width: 360, height: 720 });
      await narrow.goto('chrome-extension://' + id + url);
      await narrow.waitForTimeout(700);
      const overflow = await narrow.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        widest: [...document.querySelectorAll('*')]
          .map((element) => ({ tag: element.tagName + '.' + element.className, right: Math.round(element.getBoundingClientRect().right) }))
          .sort((a, b) => b.right - a.right)[0],
      }));
      check('a 360px window does not scroll sideways on ' + name,
        overflow.scrollWidth <= overflow.clientWidth + 1, JSON.stringify(overflow));
      if (shotDir) await narrow.screenshot({ path: path.join(shotDir, 'narrow-' + name + '.png') });
      await narrow.close();
    }

    // --- no mouse -----------------------------------------------------------
    const keys = await context.newPage();
    await keys.goto('chrome-extension://' + id + '/src/ui/search/search.html');
    await keys.waitForTimeout(400);
    const startsFocused = await keys.evaluate(() => document.activeElement && document.activeElement.id);
    check('the search box has focus on arrival', startsFocused === 'q', startsFocused);

    await keys.keyboard.type('retention');
    await keys.waitForTimeout(600);
    await keys.keyboard.press('ArrowDown');
    const selected = await keys.evaluate(() =>
      document.querySelector('article.selected') ? Number(document.querySelector('article.selected').dataset.index) : -1
    );
    check('results can be walked without touching the mouse', selected === 1, selected);

    // Tab should reach the controls, and focus must be visible when it does.
    const reachable = await keys.evaluate(() => {
      const order = [...document.querySelectorAll('input, select, button, a[href]')]
        .filter((element) => !element.disabled && element.offsetParent !== null);
      return order.map((element) => element.id || element.className || element.tagName);
    });
    check('the filters and controls are reachable by tab',
      reachable.some((entry) => String(entry).includes('site')) &&
        reachable.some((entry) => String(entry).includes('when')),
      JSON.stringify(reachable.slice(0, 8)));

    await keys.focus('#site');
    const outline = await keys.evaluate(() => {
      const style = getComputedStyle(document.getElementById('site'));
      return style.outlineStyle + ' ' + style.outlineWidth;
    });
    check('focus is visible when it lands somewhere', !/none/.test(outline), outline);
    await keys.close();
  }

  await context.close();
}

const failed = checks.filter((c) => !c.ok).length;
console.log('');
console.log(checks.length - failed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
