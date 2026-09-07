const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PHRASE = 'The quick brown lemur audits seventeen postings buckets before breakfast';
const ABSENT = 'This sentence is nowhere on the page at all whatsoever';

const frag = (s) => '#:~:text=' + encodeURIComponent(s);

(async () => {
  const server = http.createServer((req, res) => {
    const name = (req.url.split('?')[0].split('#')[0]) || '/';
    const file = path.join(__dirname, 'site', name === '/' ? 'page.html' : name);
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); }
      else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(data); }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  const extDir = path.join(__dirname, 'ext');
  const ctx = await chromium.launchPersistentContext('', {
    headless: false,
    viewport: { width: 1000, height: 800 },
    args: [
      '--disable-extensions-except=' + extDir,
      '--load-extension=' + extDir,
      '--no-sandbox',
    ],
  });

  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  console.log('extension service worker up:', sw.url().split('/').pop());

  const openViaExtension = async (url) => {
    const p = ctx.waitForEvent('page');
    await sw.evaluate((u) => chrome.tabs.create({ url: u, active: true }), url);
    const page = await p;
    await page.waitForLoadState('load');
    await page.waitForTimeout(1800);
    return page;
  };

  const probe = (page) => page.evaluate(() => ({
    scrollY: Math.round(window.scrollY),
    innerHeight: window.innerHeight,
    docHeight: document.documentElement.scrollHeight,
    href: location.href.replace(/^http:\/\/127\.0\.0\.1:\d+/, ''),
  }));

  const results = {};

  let page = await openViaExtension(base + '/page.html');
  results.A_no_directive = await probe(page);
  await page.close();

  page = await openViaExtension(base + '/page.html' + frag(PHRASE));
  results.B_tabs_create_match = await probe(page);
  results.B_target_offset_in_doc = await page.evaluate(
    () => Math.round(document.getElementById('target').getBoundingClientRect().top + window.scrollY)
  );
  await page.close();

  page = await openViaExtension(base + '/page.html' + frag(ABSENT));
  results.C_tabs_create_absent = await probe(page);
  await page.close();

  page = await openViaExtension(base + '/page.html');
  const tabId = await sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    return tabs[tabs.length - 1].id;
  });
  await sw.evaluate(
    ({ id, u }) => chrome.tabs.update(id, { url: u }),
    { id: tabId, u: base + '/page.html' + frag(PHRASE) }
  );
  await page.waitForTimeout(1800);
  results.D_tabs_update_same_url = await probe(page);
  await page.close();

  page = await openViaExtension(base + '/late.html' + frag(PHRASE));
  results.E_late_render = await probe(page);
  await page.close();

  console.log(JSON.stringify(results, null, 2));
  await ctx.close();
  server.close();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
