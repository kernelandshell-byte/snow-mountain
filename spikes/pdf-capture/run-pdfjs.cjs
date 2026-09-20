// Question: does pdf.js, vendored as plain .mjs files with no bundler (same
// pattern as the vendored Readability.js), run inside an offscreen document
// under this extension's real CSP (script-src 'self'; object-src 'self';
// connect-src 'none'), spin up its own Worker, and extract real text back out?
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
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

  ctx.on('console', (msg) => console.log('[console]', msg.type(), msg.text()));
  ctx.on('weberror', (e) => console.log('[weberror]', e.error()));
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  console.log('service worker up');

  const pdfBytes = fs.readFileSync(path.join(__dirname, 'site', 'test.pdf'));
  const bytesArray = Array.from(pdfBytes); // structured-clone friendly for evaluate()

  console.log('asking service worker to parse', bytesArray.length, 'bytes via offscreen pdf.js...');
  const result = await sw.evaluate(async (bytes) => {
    return await self.parsePdfBytes(bytes);
  }, bytesArray);

  console.log('RESULT:', JSON.stringify(result, null, 2));

  await ctx.close();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
