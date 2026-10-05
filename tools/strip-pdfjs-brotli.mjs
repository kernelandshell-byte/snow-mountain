// Removes the Brotli decoder from the vendored pdf.worker.mjs. It only serves
// the rare PDF 2.0 /BrotliDecode filter, and carries Brotli's built-in
// dictionary as a single 131KB packed string that the Chrome Web Store
// review can read as obfuscated code. A PDF using that filter is then
// treated like any other unknown filter (pdf.js warns and skips it).
//
//   node tools/strip-pdfjs-brotli.mjs        (run after copying a new pdf.worker.mjs in)
import { readFileSync, writeFileSync } from 'node:fs';

const file = new URL('../src/vendor/pdfjs/pdf.worker.mjs', import.meta.url);
let text = readFileSync(file, 'utf8');

const start = text.indexOf(';// ./external/brotli/decode.js');
const end = text.indexOf(';// ./external/jbig2/jbig2.js');
if (start === -1 || end === -1 || end < start) {
  console.log('no Brotli decoder found, nothing to do');
  process.exit(0);
}
text = text.slice(0, start) + text.slice(end);

const filterCase = '        case "BrotliDecode":\n          return new BrotliStream(stream, maybeLength);\n';
if (!text.includes(filterCase)) throw new Error('BrotliDecode filter case not found');
text = text.replace(filterCase, '');

if (/BrotliStream|BrotliDecode\(|unpackDictionaryData/.test(text)) throw new Error('Brotli code remains');
writeFileSync(file, text);
console.log('removed Brotli decoder');
