// Question: can a content script observe scroll position at all inside
// Chrome's native PDF viewer, the way read-heuristic.js wants for HTML pages?
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

(async () => {
  const server = http.createServer((req, res) => {
    const file = path.join(__dirname, 'site', 'tall.pdf');
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
    viewport: { width: 900, height: 500 }, // short viewport so the 8-page PDF needs real scrolling
    executablePath: '/opt/pw-browsers/chromium',
    args: [
      '--disable-extensions-except=' + extDir,
      '--load-extension=' + extDir,
      '--no-sandbox',
    ],
  });

  const messages = [];
  const page = await ctx.newPage();
  page.on('console', (msg) => { if (msg.text().startsWith('SCROLL_RESULT')) messages.push(msg.text()); });

  await page.goto(base + '/tall.pdf', { waitUntil: 'load', timeout: 15000 }).catch((e) => {
    console.log('goto note:', e.message);
  });
  await page.waitForTimeout(1500);

  console.log('--- after initial load ---');
  for (const m of messages) console.log(m);
  messages.length = 0;

  // Try to scroll the way a reader actually would: mouse wheel over the viewer,
  // and PageDown, since window.scrollTo from our content script's world may not
  // reach whatever surface is actually rendering.
  await page.mouse.move(450, 250);
  await page.mouse.wheel(0, 4000);
  await page.waitForTimeout(1000);
  await page.keyboard.press('End');
  await page.waitForTimeout(1000);

  console.log('--- after wheel + End ---');
  for (const m of messages) console.log(m);
  if (messages.length === 0) console.log('(no scroll events observed by the content script at all)');

  const forced = await page.evaluate(() => window.__spikeForceScroll ? window.__spikeForceScroll(3000) : 'no-hook').catch((e) => 'eval failed: ' + e.message);
  console.log('window.scrollTo(0,3000) from content-script world result:', forced);

  await ctx.close();
  server.close();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
