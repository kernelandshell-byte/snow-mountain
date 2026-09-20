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

  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker');

  const pdfBytes = fs.readFileSync(path.join(__dirname, 'site', 'big.pdf'));
  const bytesArray = Array.from(pdfBytes);
  console.log('big.pdf:', bytesArray.length, 'bytes, 50 pages, ~420 words/page');

  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    const result = await sw.evaluate(async (bytes) => {
      const t = performance.now();
      const r = await self.parsePdfBytes(bytes);
      return { ...r, ms: performance.now() - t, textLength: r.text ? r.text.length : 0 };
    }, bytesArray);
    console.log(`run ${i}: wall=${Date.now() - t0}ms reported=${Math.round(result.ms)}ms pages=${result.numPages} chars=${result.textLength} ok=${result.ok}`);
  }

  await ctx.close();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
