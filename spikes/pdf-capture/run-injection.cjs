// Question: does a content script fire at all on a tab where Chrome's native
// PDF viewer is showing a PDF, and if so, can it get the PDF's own bytes back
// via same-origin fetch(location.href)? If the answer is no on either count,
// PDF capture needs a completely different trigger (e.g. webRequest headers,
// or the download shelf) instead of the observer.js content-script pattern
// every other capture path uses.
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

(async () => {
  const server = http.createServer((req, res) => {
    const file = path.join(__dirname, 'site', 'test.pdf');
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': data.length });
      res.end(data);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  const extDir = path.join(__dirname, 'ext');
  const ctx = await chromium.launchPersistentContext('', {
    headless: false,
    viewport: { width: 1000, height: 800 },
    executablePath: '/opt/pw-browsers/chromium',
    args: [
      '--disable-extensions-except=' + extDir,
      '--load-extension=' + extDir,
      '--no-sandbox',
    ],
  });

  const messages = [];
  ctx.on('console', (msg) => { if (msg.text().startsWith('SPIKE_RESULT')) messages.push(msg.text()); });

  const page = await ctx.newPage();
  page.on('console', (msg) => { if (msg.text().startsWith('SPIKE_RESULT')) messages.push(msg.text()); });

  console.log('navigating to', base + '/test.pdf');
  await page.goto(base + '/test.pdf', { waitUntil: 'load', timeout: 15000 }).catch((e) => {
    console.log('goto rejected (may still have loaded the viewer):', e.message);
  });
  await page.waitForTimeout(2500);

  console.log('page url after nav:', page.url());
  console.log('collected messages:', messages.length);
  for (const m of messages) console.log(m);

  if (messages.length === 0) {
    console.log('NO content-script output observed for the PDF tab.');
  }

  await ctx.close();
  server.close();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
