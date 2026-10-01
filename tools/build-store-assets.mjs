// Builds everything the Chrome Web Store listing needs from the real
// extension, so the images always show the product as it is.
//
//   node tools/build-store-assets.mjs [outputDirectory]     (default: store/)
//
// Writes
//   screenshots/   five 1280x800 screenshots (the store's size, no alpha)
//   promo/         the 440x280 small tile and the 1400x560 marquee
//   icon/          the 128x128 store icon (96px of art, 16px of padding)
//   logo/          the logo as SVG and as 512 / 1024 PNG, and a preview board
//
// Not a test. The UI is photographed at twice the resolution and placed at
// half, so text stays crisp. The fonts the stylesheet asks for first (Inter and
// JetBrains Mono) should be installed on the machine that runs this; without
// them the screenshots fall back to whatever sans-serif the machine has.

import { chromium } from 'playwright';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildGrantedExtension } from '../test/browser/harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] || path.join(root, 'store'));
for (const dir of ['screenshots', 'promo', 'icon', 'logo', '.raw']) await mkdir(path.join(out, dir), { recursive: true });
const raw = (name) => path.join(out, '.raw', name + '.png');

const { CORPUS } = await import(path.join(root, 'test/fixtures/corpus.js'));
const { textFragmentUrl } = await import(path.join(root, 'src/core/text-fragment.js'));
const logoSvg = await readFile(path.join(root, 'icons', 'logo.svg'), 'utf8');
const dataUri = async (file) => 'data:image/png;base64,' + (await readFile(file)).toString('base64');
const svgUri = (svg) => 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
const logoUri = svgUri(logoSvg);

// --- 1. photograph the real UI ---------------------------------------------

const granted = await buildGrantedExtension(root);
const ctx = await chromium.launchPersistentContext('', {
  headless: false,
  viewport: { width: 1040, height: 560 },
  deviceScaleFactor: 2,
  colorScheme: 'light',
  args: ['--disable-extensions-except=' + granted.dir, '--load-extension=' + granted.dir, '--no-sandbox'],
});
let [worker] = ctx.serviceWorkers();
if (!worker) worker = await ctx.waitForEvent('serviceworker');
const base = 'chrome-extension://' + new URL(worker.url()).host;

// The corpus is fiction (every address ends in .example), so no real site
// or brand appears in anything published.
const article = (doc) => {
  const paragraphs = doc.text.split(/\n+/).filter(Boolean);
  const sentences = doc.text.match(/[^.!?]+[.!?]+(\s|$)/g) || [doc.text];
  const body = paragraphs.length > 1 ? paragraphs
    : Array.from({ length: Math.ceil(sentences.length / 3) }, (_, i) => sentences.slice(i * 3, i * 3 + 3).join('').trim());
  const site = new URL(doc.url).hostname.split('.')[0];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${doc.title}</title><style>
    html { scrollbar-width: none; } ::-webkit-scrollbar { display: none; }
    body { margin: 0; background: #fbfaf7; color: #1d1d1f; font: 19px/1.7 Georgia, "Times New Roman", serif; }
    nav { position: sticky; top: 0; background: #fbfaf7; display: flex; gap: 28px; align-items: center; padding: 18px 56px; border-bottom: 1px solid #e8e5dd; font: 600 14px Inter, system-ui, sans-serif; color: #5a5a5f; }
    nav b { color: #1d1d1f; font-size: 17px; margin-right: auto; letter-spacing: -.02em; text-transform: capitalize; }
    main { max-width: 640px; margin: 0 auto; padding: 44px 24px 120px; }
    .kicker { font: 600 12px Inter, system-ui, sans-serif; letter-spacing: .12em; text-transform: uppercase; color: #8a6d3b; }
    h1 { font: 800 40px/1.1 Inter, system-ui, sans-serif; letter-spacing: -.035em; margin: 12px 0 10px; }
    .by { font: 14px Inter, system-ui, sans-serif; color: #7a7a80; margin-bottom: 28px; }
    p { margin: 0 0 22px; }
  </style></head><body><nav><b>${site}</b><span>Guides</span><span>Essays</span><span>About</span></nav>
  <main><div class="kicker">Essay</div><h1>${doc.title}</h1><div class="by">8 min read</div>${body.map((p) => '<p>' + p + '</p>').join('')}</main></body></html>`;
};
await ctx.route('**/*', (route) => {
  const url = route.request().url();
  if (!/^https?:/.test(url)) return route.continue();
  const doc = CORPUS.find((d) => url.split('#')[0] === d.url);
  return route.fulfill({ contentType: 'text/html', body: doc ? article(doc) : '<!doctype html><title>x</title>' });
});

const admin = await ctx.newPage();
await admin.goto(base + '/src/ui/options/options.html');
await admin.evaluate(async (docs) => {
  const { MSG } = await import('/src/shared/messages.js');
  await chrome.runtime.sendMessage({ type: MSG.SETTINGS_SET, payload: {
    setupComplete: true, mode: 'broad', stemLanguages: ['en', 'es', 'de'], customRules: ['bank.example'] } });
  let i = 0;
  for (const doc of docs) {
    await chrome.runtime.sendMessage({ type: MSG.PAGE_CONTENT, payload: {
      url: doc.url, title: doc.title, text: doc.text, capturedAt: Date.now() - (i++ * 2 + 1) * 86400000 } });
  }
}, CORPUS);

async function photograph(name, url, { scheme = 'light', width = 1040, height = 560, before, popupTab, clip } = {}) {
  const page = await ctx.newPage();
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ colorScheme: scheme });
  if (popupTab) await page.addInitScript((tab) => { chrome.tabs.query = () => Promise.resolve([tab]); }, popupTab);
  await page.goto(base + url);
  // A marketing image has no use for the browser's own scrollbar.
  // (A constructed stylesheet, because the extension's CSP refuses an inline one.)
  await page.evaluate(() => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync('::-webkit-scrollbar { display: none } html { scrollbar-width: none }');
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  });
  await page.waitForTimeout(500);
  if (before) await before(page);
  await page.mouse.move(1, 1);
  await page.waitForTimeout(700);
  // A clip of height 0 means "the whole page, at its natural height".
  const natural = clip && clip.height === 0
    ? await page.evaluate(() => Math.ceil(document.body.getBoundingClientRect().height)) : null;
  await page.screenshot({ path: raw(name), clip: natural ? { ...clip, height: natural } : clip });
  await page.close();
  return natural;
}

await photograph('search-light', '/src/ui/search/search.html', { before: async (p) => {
  await p.fill('#q', 'retention'); await p.waitForTimeout(800); await p.keyboard.press('ArrowDown'); } });
await photograph('search-dark', '/src/ui/search/search.html', { scheme: 'dark', before: async (p) => {
  await p.fill('#q', 'cohort retenton'); await p.waitForTimeout(900); } });
await photograph('settings', '/src/ui/options/options.html', { height: 700, before: async (p) => {
  await p.evaluate(() => { document.getElementById('presetBlock').scrollIntoView(); window.scrollBy(0, -28); }); } });
const popupClip = { x: 0, y: 0, width: 352, height: 0 };
const popupKept = await photograph('popup-kept', '/src/ui/popup/popup.html', { width: 352, height: 760, clip: popupClip,
  popupTab: { id: 1, url: 'https://metricsdesk.example/cohort-churn' } });
const popupSkipped = await photograph('popup-skipped', '/src/ui/popup/popup.html', { width: 352, height: 760, clip: popupClip,
  popupTab: { id: 1, url: 'https://bank.example/accounts' } });
const popupHeight = Math.max(popupKept, popupSkipped);

// The signature move: land on the passage that matched. The URL is built by
// the same function the extension uses to open a result. (Letting the
// extension open the tab itself races Playwright's attaching to it, and the
// first navigation escapes the route above.)
{
  const hit = await admin.evaluate(async () => {
    const { MSG } = await import('/src/shared/messages.js');
    const r = await chrome.runtime.sendMessage({ type: MSG.SEARCH, payload: { query: '"honest way" retention', limit: 1 } });
    return r.results[0];
  });
  const target = textFragmentUrl(hit.url, hit.snippet.text, hit.snippet.ranges);
  const tab = await ctx.newPage();
  await tab.goto(target);
  await tab.waitForTimeout(2500);
  console.log('passage url:', decodeURIComponent(target).slice(0, 110));
  await tab.screenshot({ path: raw('article') });
  await tab.close();
}
await ctx.close();
await granted.cleanup();

// --- 2. compose the listing images -------------------------------------------

const compositor = await chromium.launch();
const page = await compositor.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });

const FONT = "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const MONO = "'JetBrains Mono', ui-monospace, 'DejaVu Sans Mono', monospace";
const baseCss = `
  * { box-sizing: border-box; margin: 0; }
  body { font-family: ${FONT}; -webkit-font-smoothing: antialiased; color: #f4f4f2; position: relative; overflow: hidden;
    background:
      radial-gradient(900px 620px at 6% 108%, rgb(90 44 245 / .62), transparent 70%),
      radial-gradient(760px 520px at 102% -12%, rgb(138 92 255 / .38), transparent 70%),
      #0b0b0c; }
  mark { background: #e3ff4f; color: #0b0b0c; padding: 0 .16em; border-radius: .14em; margin: 0 -.04em;
    -webkit-box-decoration-break: clone; box-decoration-break: clone; }
  .brand { display: flex; align-items: center; gap: 12px; font-weight: 800; letter-spacing: -.035em; }
  .brand img { display: block; }
  .eyebrow { font: 600 13px/1 ${MONO}; letter-spacing: .14em; text-transform: uppercase; color: #a48bff; }
  .window { position: absolute; border-radius: 16px 16px 0 0; overflow: hidden; background: #fff;
    box-shadow: 0 50px 90px -24px rgb(0 0 0 / .75), 0 0 0 1px rgb(255 255 255 / .1), 0 0 0 9px rgb(255 255 255 / .035); }
  .window.dark { background: #0a0a0b; }
  .bar { height: 38px; display: flex; align-items: center; gap: 8px; padding: 0 16px; background: #eeeeec; border-bottom: 1px solid #deded9; }
  .dark .bar { background: #202124; border-bottom: 1px solid #333438; }
  .bar i { width: 11px; height: 11px; border-radius: 50%; background: #d0d0cb; }
  .dark .bar i { background: #4a4b50; }
  .tab { margin-left: 14px; height: 30px; align-self: flex-end; display: flex; align-items: center; gap: 8px; padding: 0 14px;
    background: #fff; border-radius: 9px 9px 0 0; font: 500 12px ${FONT}; color: #3c3c40; max-width: 300px; white-space: nowrap; overflow: hidden; }
  .dark .tab { background: #0a0a0b; color: #c9c9ce; }
  .tab img { width: 14px; height: 14px; border-radius: 3px; }
  .url { margin-left: 18px; flex: 1; max-width: 420px; height: 24px; border-radius: 12px; background: #fff; font: 500 12px/24px ${FONT}; color: #5a5a60; padding: 0 14px; }
  .dark .url { background: #0a0a0b; color: #8f8f98; }
  .shot { display: block; width: 100%; }
`;

const scene = ({ eyebrow, headline, sub, body, width = 1280, height = 800 }) => `<!doctype html><style>${baseCss}
  body { width: ${width}px; height: ${height}px; }
  .copy { position: absolute; left: 72px; top: 36px; right: 72px; }
  .copy .brand { font-size: 20px; margin-bottom: 40px; }
  h1 { margin-top: 16px; font-size: 54px; font-weight: 800; line-height: 1.04; letter-spacing: -.045em; }
  .sub { margin-top: 14px; font-size: 20px; line-height: 1.45; color: #b4b4bb; }
</style>
<div class="copy">
  <div class="brand"><img src="${logoUri}" width="30" height="30" alt="">TextMemory</div>
  <div class="eyebrow">${eyebrow}</div>
  <h1>${headline}</h1>
  <div class="sub">${sub}</div>
</div>${body}`;

const windowOf = async (shotFile, { left = 120, top = 292, width = 1040, tab, url, dark = false, favicon = logoUri }) =>
  `<div class="window${dark ? ' dark' : ''}" style="left:${left}px;top:${top}px;width:${width}px;height:${800 - top + 4}px">
     <div class="bar"><i></i><i></i><i></i><div class="tab">${favicon ? `<img src="${favicon}" alt="">` : ''}<span style="overflow:hidden;text-overflow:ellipsis">${tab}</span></div><div class="url">${url}</div></div>
     <img class="shot" src="${await dataUri(shotFile)}" alt=""></div>`;

async function save(file, html, size) {
  await page.setViewportSize(size);
  await page.setContent(html);
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(out, file), omitBackground: false });
  console.log('wrote', file);
}
const HD = { width: 1280, height: 800 };

await save('screenshots/1-find-anything.png', scene({
  eyebrow: 'Full-text search · Your own browsing',
  headline: 'Find anything you\'ve <mark>read</mark>.',
  sub: 'Search the full text of the pages you read, by any phrase you remember.',
  body: await windowOf(raw('search-light'), { tab: 'Search what you have read', url: 'TextMemory' }),
}), HD);

await save('screenshots/2-jump-to-passage.png', scene({
  eyebrow: 'Jump to passage',
  headline: 'It lands on the <mark>exact</mark> paragraph.',
  sub: 'Open a result and the page scrolls straight to the sentence that matched.',
  body: await windowOf(raw('article'), { tab: 'Reading a churn cohort chart without fooling yourself', url: 'metricsdesk.example/cohort-churn', favicon: '' }),
}), HD);

await save('screenshots/3-forgiving.png', scene({
  eyebrow: 'Typos · Plurals · Six languages',
  headline: 'Misspelled it? <mark>Still</mark> found.',
  sub: 'Search forgives typos and endings, and says what it actually searched for.',
  body: await windowOf(raw('search-dark'), { tab: 'Search what you have read', url: 'TextMemory', dark: true }),
}), HD);

// Both popups are shown whole, scaled to the room under the headline.
const cardWidth = Math.min(380, Math.floor((800 - 276 - 34 - 40) * 352 / popupHeight));
const popupCard = async (file, label) => `<figure style="margin:0;text-align:center">
  <figcaption style="margin-bottom:16px;font:600 13px/1 ${MONO};letter-spacing:.12em;text-transform:uppercase;color:#a48bff">${label}</figcaption>
  <img src="${await dataUri(file)}" style="display:block;width:${cardWidth}px;border-radius:16px;box-shadow:0 40px 80px -20px rgb(0 0 0 / .7), 0 0 0 1px rgb(255 255 255 / .12)" alt=""></figure>`;
await save('screenshots/4-always-know.png', scene({
  eyebrow: 'The toolbar button',
  headline: 'Always know what\'s <mark>kept</mark>.',
  sub: 'One click shows whether this page is saved, and why not. Forget it or block the site in a click.',
  body: `<div style="position:absolute;left:0;right:0;top:272px;display:flex;justify-content:center;align-items:flex-start;gap:76px">
    ${await popupCard(raw('popup-kept'), 'Kept')}${await popupCard(raw('popup-skipped'), 'Skipped on purpose')}</div>`,
}), HD);

await save('screenshots/5-you-decide.png', scene({
  eyebrow: 'Private · Local · No account',
  headline: 'You decide what gets <mark>read</mark>.',
  sub: 'Banking, webmail, health and more are skipped by default. Nothing ever leaves your computer.',
  body: await windowOf(raw('settings'), { tab: 'Settings', url: 'TextMemory' }),
}), HD);

// The small tile: the name, the promise, and a miniature of the product.
const tile = `<!doctype html><style>${baseCss}
  body { width: 440px; height: 280px; }
  .brand { position: absolute; left: 28px; top: 26px; font-size: 17px; }
  h1 { position: absolute; left: 28px; top: 76px; width: 400px; font-size: 38px; font-weight: 800; line-height: 1.04; letter-spacing: -.045em; }
  .mini { position: absolute; left: 28px; right: -30px; bottom: -26px; height: 96px; background: #fff; border-radius: 14px; padding: 14px 16px;
    box-shadow: 0 20px 40px -12px rgb(0 0 0 / .7), 0 0 0 1px rgb(255 255 255 / .12); color: #0b0b0c; }
  .field { height: 30px; border: 2px solid #5a2cf5; border-radius: 10px; font: 600 13px/26px ${FONT}; padding: 0 12px 0 32px; position: relative; box-shadow: 0 0 0 3px rgb(90 44 245 / .18); }
  .field::before { content: ""; position: absolute; left: 11px; top: 6px; width: 8px; height: 8px; border: 2px solid #0b0b0c; border-radius: 50%; }
  .field::after { content: ""; position: absolute; left: 20px; top: 15px; width: 6px; height: 2px; background: #0b0b0c; transform: rotate(45deg); }
  .line { margin-top: 10px; font: 500 12px/1.4 ${FONT}; color: #4a4a50; }
</style>
<div class="brand"><img src="${logoUri}" width="26" height="26" alt="">TextMemory</div>
<h1>Find anything you've <mark>read</mark>.</h1>
<div class="mini"><div class="field">retention</div><div class="line">…the only honest way to look at <mark>retention</mark>. The headline…</div></div>`;
await save('promo/small-tile-440x280.png', tile, { width: 440, height: 280 });

// The marquee: the pitch on the left, the product breaking out of the frame.
const marquee = `<!doctype html><style>${baseCss}
  body { width: 1400px; height: 560px; }
  .brand { position: absolute; left: 88px; top: 72px; font-size: 30px; }
  .eyebrow { position: absolute; left: 88px; top: 168px; }
  h1 { position: absolute; left: 88px; top: 196px; width: 600px; font-size: 68px; font-weight: 800; line-height: 1.02; letter-spacing: -.045em; }
  p { position: absolute; left: 88px; top: 392px; width: 480px; font-size: 20px; line-height: 1.5; color: #b4b4bb; }
  .window { left: 720px; top: 84px; width: 760px; height: 520px; }
  .pop { position: absolute; left: 640px; top: 250px; width: 250px; border-radius: 14px;
    box-shadow: 0 40px 70px -16px rgb(0 0 0 / .8), 0 0 0 1px rgb(255 255 255 / .14); }
</style>
<div class="brand"><img src="${logoUri}" width="52" height="52" alt="">TextMemory</div>
<div class="eyebrow">Full-text search · Stays on your computer</div>
<h1>Find anything you've <mark>read</mark>.</h1>
<p>Search the full text of every page you've read, by any phrase you remember.</p>
<div class="window"><div class="bar"><i></i><i></i><i></i><div class="tab"><img src="${logoUri}" alt="">Search what you have read</div></div>
  <img class="shot" style="width:900px;margin-left:-70px" src="${await dataUri(raw('search-light'))}" alt=""></div>
<img class="pop" src="${await dataUri(raw('popup-kept'))}" alt="">`;
await save('promo/marquee-1400x560.png', marquee, { width: 1400, height: 560 });

// --- 3. the logo --------------------------------------------------------------

const sized = (size, svg = logoSvg) => svg.replace(/ width="128" height="128"/, ` width="${size}" height="${size}"`);
async function renderSvg(file, svg, size, canvas = size, transparent = true) {
  await page.setViewportSize({ width: canvas, height: canvas });
  const offset = (canvas - size) / 2;
  await page.setContent(`<body style="margin:0;background:${transparent ? 'transparent' : '#fff'}"><div style="position:absolute;left:${offset}px;top:${offset}px;width:${size}px;height:${size}px">${sized(size, svg)}</div></body>`);
  await page.screenshot({ path: path.join(out, file), omitBackground: transparent });
}
await writeFile(path.join(out, 'logo/textmemory-logo.svg'), logoSvg);
await renderSvg('logo/textmemory-logo-1024.png', logoSvg, 1024);
await renderSvg('logo/textmemory-logo-512.png', logoSvg, 512);
// The store icon is 128 square with the art inside a 16px margin; the squircle
// is not cropped by the store, so it needs the room.
await renderSvg('icon/store-icon-128.png', logoSvg, 96, 128);

const board = `<!doctype html><style>${baseCss}
  body { width: 1600px; height: 900px; background: #0b0b0c; }
  .tiles { position: absolute; left: 0; right: 0; top: 540px; display: flex; gap: 0; }
  .tile { flex: 1; height: 360px; display: flex; align-items: center; justify-content: center; gap: 36px; }
  .tile img { display: block; }
  .name { position: absolute; left: 120px; top: 150px; }
  .name .t { font-size: 96px; font-weight: 850; letter-spacing: -.05em; line-height: 1; }
  .name .s { margin-top: 18px; font-size: 26px; color: #b4b4bb; }
  .big { position: absolute; right: 150px; top: 70px; width: 400px; height: 400px; filter: drop-shadow(0 40px 60px rgb(90 44 245 / .45)); }
  .cap { position: absolute; bottom: 14px; left: 0; right: 0; text-align: center; font: 600 12px ${MONO}; letter-spacing: .12em; text-transform: uppercase; opacity: .6; }
  .l { background: #fff; color: #0b0b0c; position: relative; } .d { background: #202124; position: relative; } .v { background: #5a2cf5; position: relative; }
  .tile .wm { font-size: 44px; font-weight: 850; letter-spacing: -.045em; }
</style>
<div class="name"><div class="t">TextMemory</div><div class="s">Find anything you've <mark>read</mark>.</div></div>
<img class="big" src="${logoUri}" alt="">
<div class="tiles">
  <div class="tile l"><img src="${logoUri}" width="96" height="96" alt=""><img src="${logoUri}" width="48" height="48" alt=""><img src="${logoUri}" width="32" height="32" alt=""><img src="${logoUri}" width="16" height="16" alt=""><div class="cap">on light</div></div>
  <div class="tile d"><img src="${logoUri}" width="96" height="96" alt=""><img src="${logoUri}" width="48" height="48" alt=""><img src="${logoUri}" width="32" height="32" alt=""><img src="${logoUri}" width="16" height="16" alt=""><div class="cap" style="color:#fff">on dark</div></div>
  <div class="tile v"><div class="brand wm"><img src="${logoUri}" width="64" height="64" alt="">TextMemory</div><div class="cap" style="color:#fff">lockup</div></div>
</div>`;
await save('logo/logo-board.png', board, { width: 1600, height: 900 });

await compositor.close();
console.log('\nAll assets written to ' + out);
