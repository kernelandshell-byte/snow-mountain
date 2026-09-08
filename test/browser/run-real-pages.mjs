// Extraction against real pages rather than fixtures I wrote myself. Mozilla
// ships snapshots of real articles in Readability's own test suite, together
// with the output it expects, so this checks our extractor against pages
// nobody tidied up first.
//
// The snapshots are fetched on demand into test/browser/.pages, which is not
// committed: they are large, and they belong to that project rather than
// this one. With no network the suite says so and stops rather than failing.

import { chromium } from 'playwright';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cache = path.join(root, 'test/browser/.pages');
const SOURCE = 'https://raw.githubusercontent.com/mozilla/readability/main/test/test-pages';

// Chosen for variety rather than for being easy: newspapers, blogs, a wiki,
// technical documentation, a spec, fiction, pages built out of tables, pages
// whose comments load after the article, and several that exist in that
// corpus precisely because they are awkward.
const PAGES = [
  'ars-1', 'nytimes-1', 'guardian-1', 'medium-1', 'wordpress', 'bbc-1',
  'wikipedia', 'lwn-1', 'theverge', 'engadget', 'tumblr', 'blogger',
  'google-sre-book-1', 'ietf-1', 'keep-tabular-data', 'embedded-videos',
  'videos-1', 'lifehacker-post-comment-load', 'social-buttons',
  'links-in-tables', 'hidden-nodes', 'missing-paragraphs', 'quanta-1',
  'daringfireball-1', 'v8-blog', 'mozilla-1', 'telegraph', 'cnet', 'msn',
  'yahoo-1', 'royal-road', 'archive-of-our-own',
];

async function fetchIfMissing(name, file) {
  const target = path.join(cache, name + '.' + file + '.html');
  try {
    await access(target);
    return target;
  } catch {}
  const response = await fetch(SOURCE + '/' + name + '/' + file + '.html');
  if (!response.ok) throw new Error(name + '/' + file + ': ' + response.status);
  await writeFile(target, await response.text());
  return target;
}

await mkdir(cache, { recursive: true });

const fixtures = [];
try {
  for (const name of PAGES) {
    fixtures.push({
      name,
      source: await readFile(await fetchIfMissing(name, 'source'), 'utf8'),
      expected: await readFile(await fetchIfMissing(name, 'expected'), 'utf8'),
    });
  }
} catch (error) {
  console.log('  skipped: the real page snapshots could not be fetched (' + error.message + ')');
  console.log('  This suite needs raw.githubusercontent.com once, then works offline.');
  process.exit(0);
}

// Serve each snapshot as a real page, because Readability behaves differently
// on a document the browser actually parsed.
const server = http.createServer((request, response) => {
  const name = new URL(request.url, 'http://localhost').pathname.slice(1);
  const fixture = fixtures.find((f) => f.name === name);
  response.writeHead(fixture ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(fixture ? fixture.source : 'not found');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const site = 'http://127.0.0.1:' + server.address().port;

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext();
await context.addInitScript(() => {
  window.__captured = null;
  window.chrome = { runtime: { sendMessage: (message) => { window.__captured = message; return Promise.resolve(); } } };
});

const checks = [];
const check = (name, condition, detail) => {
  const ok = !!condition;
  checks.push({ name, ok, detail: ok ? '' : String(detail) });
  console.log(ok ? '  ok   ' + name : '  FAIL ' + name + '\n       ' + String(detail));
};

function expectedText(expectedHtml) {
  return expectedHtml
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// A sentence from the middle of what Readability itself expects to keep.
function expectedSentence(expectedHtml) {
  const sentences = expectedText(expectedHtml)
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => sentence.split(' ').length >= 8 && sentence.length < 200);
  return sentences[Math.floor(sentences.length / 2)] || null;
}

// Tags are replaced by spaces when reducing the expected HTML to text, which
// splits words that sat either side of inline markup. Comparing without any
// whitespace at all sidesteps that entirely.
const squash = (text) => text.replace(/[\s\u00a0]+/g, '').toLowerCase();

for (const fixture of fixtures) {
  const page = await context.newPage();
  await page.goto(site + '/' + fixture.name, { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ path: path.join(root, 'src/vendor/readability/Readability.js') });
  await page.addScriptTag({ path: path.join(root, 'src/content/extract.js') });
  await page.waitForFunction(() => window.__captured !== null, null, { timeout: 15000 });
  const payload = (await page.evaluate(() => window.__captured)).payload;
  const rawLength = await page.evaluate(() => (document.body.innerText || '').length);
  await page.close();

  const sentence = expectedSentence(fixture.expected);
  const expectedLength = expectedText(fixture.expected).length;
  const ratio = payload.text.length / expectedLength;

  check(fixture.name + ': something was extracted', payload.text.length > 500,
    payload.text.length + ' characters');
  // Measured against what Readability's own maintainers expect from this
  // page, which is a fairer standard than a guess about how much of a page
  // is boilerplate. Medium's snapshot really is almost all article.
  check(fixture.name + ': about as much as Readability expects, ' + Math.round(ratio * 100) + '%',
    ratio > 0.6 && ratio < 1.6,
    'kept ' + payload.text.length + ' characters against an expected ' + expectedLength +
      ', and ' + Math.round((payload.text.length / rawLength) * 100) + '% of the raw page');
  check(fixture.name + ': it has a title', payload.title && payload.title.length > 3, payload.title);
  if (sentence) {
    check(fixture.name + ': the article body survived',
      squash(payload.text).includes(squash(sentence)),
      'missing: ' + sentence.slice(0, 90));
  }
}

await browser.close();
server.close();

const failed = checks.filter((c) => !c.ok).length;
console.log('');
console.log(checks.length - failed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
