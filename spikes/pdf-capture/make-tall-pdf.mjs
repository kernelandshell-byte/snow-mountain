import { PDFDocument, StandardFonts } from 'pdf-lib';
import fs from 'fs';

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
for (let i = 1; i <= 8; i++) {
  const page = doc.addPage([400, 700]);
  page.drawText(`Page ${i} of the tall spike fixture.`, { x: 20, y: 650, size: 18, font });
}
const bytes = await doc.save();
fs.writeFileSync(new URL('./site/tall.pdf', import.meta.url), bytes);
console.log('wrote tall.pdf,', bytes.length, 'bytes,', doc.getPageCount(), 'pages');
