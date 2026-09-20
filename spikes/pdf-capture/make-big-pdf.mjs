import { PDFDocument, StandardFonts } from 'pdf-lib';
import fs from 'fs';

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
const words = 'the quick brown lemur audits seventeen postings buckets before breakfast and finds nothing out of place which is itself a small surprise'.split(' ');
for (let p = 0; p < 50; p++) {
  const page = doc.addPage([400, 700]);
  let y = 660;
  for (let line = 0; line < 35; line++) {
    const text = Array.from({ length: 12 }, (_, i) => words[(p * 35 + line + i) % words.length]).join(' ');
    page.drawText(text, { x: 20, y, size: 9, font });
    y -= 18;
  }
}
const bytes = await doc.save();
fs.writeFileSync(new URL('./site/big.pdf', import.meta.url), bytes);
console.log('wrote big.pdf,', bytes.length, 'bytes,', doc.getPageCount(), 'pages');
