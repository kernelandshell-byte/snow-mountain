import { PDFDocument, StandardFonts } from 'pdf-lib';
import fs from 'fs';

const doc = await PDFDocument.create();
const page = doc.addPage([400, 300]);
const font = await doc.embedFont(StandardFonts.Helvetica);
page.drawText('The quick brown lemur audits seventeen postings buckets before breakfast', {
  x: 20, y: 250, size: 12, font, maxWidth: 360, lineHeight: 16,
});
page.drawText('Second line of body text for the PDF capture spike.', { x: 20, y: 220, size: 12, font });
const bytes = await doc.save();
fs.writeFileSync(new URL('./site/test.pdf', import.meta.url), bytes);
console.log('wrote test.pdf,', bytes.length, 'bytes');
