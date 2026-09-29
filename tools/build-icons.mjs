// Renders icons/logo.svg to the PNG sizes the manifest names.
//
//   node tools/build-icons.mjs
//
// The two toolbar sizes drop the faint text lines: at 16px they turn into
// noise, and the T and its highlight are the whole mark.

import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const full = await readFile(path.join(root, 'icons', 'logo.svg'), 'utf8');
const small = full.replace(/<g fill="#fff" opacity="\.34">[\s\S]*?<\/g>/, '');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 128, height: 128 } });
for (const size of [16, 32, 48, 128]) {
  const svg = size <= 32 ? small : full;
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<body style="margin:0;background:transparent"><div style="width:${size}px;height:${size}px">${svg.replace(/ width="128" height="128"/, ` width="${size}" height="${size}"`)}</div></body>`,
  );
  await page.screenshot({
    path: path.join(root, 'icons', `icon-${size}.png`),
    omitBackground: true,
    clip: { x: 0, y: 0, width: size, height: size },
  });
}
await browser.close();
console.log('wrote icon-16, 32, 48, 128');
