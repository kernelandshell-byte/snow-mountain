// Runs the real extraction script against pages built the way real pages
// are: navigation, a cookie banner, a sidebar of related links, a footer
// full of legal text, and somewhere in there the thing the reader came for.
//
// What gets indexed is what gets searched, so extraction quality is search
// quality. This is the test that notices when it degrades.
//
//   node test/browser/run-extraction.mjs

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const ARTICLE_SENTENCE =
  'Retro fatigue sets in when the same problems are raised every fortnight and nothing changes.';

const articlePage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Why teams stop running retrospectives | TeamCraft</title></head>
<body>
  <div id="cookie-banner" role="dialog">
    <p>We value your privacy. We and our particular partners store cookies on your device.</p>
    <button>Accept all cookies</button><button>Manage preferences</button>
  </div>
  <nav aria-label="Main"><a href="/">Home</a><a href="/topics">Topics</a><a href="/pricing">Pricing</a><a href="/login">Log in</a></nav>
  <header><h1>Why teams stop running retrospectives</h1><p class="byline">By A. Writer, 4 March</p></header>
  <article>
    <p>${ARTICLE_SENTENCE} People stop preparing, then stop speaking, and eventually the meeting is quietly dropped from the calendar.</p>
    <p>The usual response is to try a new format, a new set of prompts, or a facilitator borrowed from another team. That almost never helps, because the format was never the problem in the first place.</p>
    <p>What kills a retrospective is the absence of a visible loop between what gets raised and what actually gets done about it. Teams that keep the habit alive carry a small number of actions forward and start the next session by reporting on them.</p>
    <p>When people see that raising something leads to a change, they keep raising things, and the meeting earns its place in the calendar again rather than surviving on habit.</p>
  </article>
  <aside><h2>Related reading</h2><ul><li><a href="/a">Seventeen standup alternatives</a></li><li><a href="/b">The quarterly meeting audit</a></li></ul></aside>
  <footer><p>Copyright TeamCraft. All rights reserved. Terms of service, privacy policy, cookie policy, modern slavery statement.</p></footer>
</body></html>`;

const dashboardPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Deployments</title></head>
<body>
  <nav><a href="/">Overview</a><a href="/deploys">Deployments</a></nav>
  <h1>Deployments</h1>
  <table>
    <tr><th>Service</th><th>Version</th><th>Status</th></tr>
    <tr><td>checkout-api</td><td>4.19.2</td><td>healthy</td></tr>
    <tr><td>search-indexer</td><td>0.8.1</td><td>degraded</td></tr>
  </table>
</body></html>`;

const sparsePage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Status</title></head>
<body>
  <nav><a href="/">Home</a><a href="/status">Status</a></nav>
  <p>All systems normal.</p>
</body></html>`;

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext();

// The extraction script talks to the extension. Standing in for that lets
// the real file run unmodified rather than being reimplemented here.
await context.addInitScript(() => {
  window.__captured = null;
  window.chrome = {
    runtime: {
      sendMessage: (message) => {
        window.__captured = message;
        return Promise.resolve();
      },
    },
  };
});

await context.route('https://fixture.example/**', (route) => {
  const url = route.request().url();
  route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: url.includes('dashboard') ? dashboardPage : url.includes('sparse') ? sparsePage : articlePage,
  });
});

const checks = [];
const check = (name, condition, detail) =>
  checks.push({ name, ok: !!condition, detail: condition ? '' : String(detail) });

async function extract(url, { withReadability = true } = {}) {
  const page = await context.newPage();
  await page.goto(url);
  if (withReadability) {
    await page.addScriptTag({ path: path.join(root, 'src/vendor/readability/Readability.js') });
  }
  await page.addScriptTag({ path: path.join(root, 'src/content/extract.js') });
  await page.waitForFunction(() => window.__captured !== null, null, { timeout: 5000 });
  const captured = await page.evaluate(() => window.__captured);
  await page.close();
  return captured.payload;
}

const article = await extract('https://fixture.example/retro-fatigue');

check('an article is recognised as one', article.extractedBy === 'readability', article.extractedBy);
check('the article text is kept', article.text.includes(ARTICLE_SENTENCE), article.text.slice(0, 120));
check('all four paragraphs survive', (article.text.match(/\./g) || []).length >= 7, article.text.length);
check('the cookie banner is dropped', !/Accept all cookies/i.test(article.text), 'cookie text present');
check('navigation is dropped', !/Pricing/.test(article.text), 'nav text present');
check('the related sidebar is dropped', !/Seventeen standup alternatives/.test(article.text), 'sidebar present');
check('the footer boilerplate is dropped', !/modern slavery statement/i.test(article.text), 'footer present');
check('the title is the article title, not the site title',
  article.title === 'Why teams stop running retrospectives', article.title);
check('an excerpt is produced', typeof article.excerpt === 'string' && article.excerpt.length > 0, article.excerpt);

const dashboard = await extract('https://fixture.example/dashboard');

// A dashboard is not article shaped, and Readability parses it anyway.
// Worth knowing rather than asserting a path: what matters is that the
// content ends up searchable, whichever route it took.
check('a page that is not an article still gets captured', dashboard.text.length > 0, dashboard.text);
check('the table content is searchable', /search-indexer/.test(dashboard.text), dashboard.text.slice(0, 120));

// Readability turns out to parse almost anything, including a dashboard and
// a page with one sentence on it, so the fallback is not reached by feeding
// it thin content. It exists for the case where the parser is unavailable or
// throws, and that is what gets tested: run the extractor without it.
const withoutParser = await extract('https://fixture.example/sparse', { withReadability: false });
check('extraction survives Readability being unavailable',
  withoutParser.extractedBy === 'fallback', withoutParser.extractedBy);
check('the fallback still captures the text', /All systems normal/.test(withoutParser.text), withoutParser.text);
check('the fallback keeps the document title', withoutParser.title === 'Status', withoutParser.title);

// And the article, extracted without the parser, shows what the fallback
// costs: everything the page contains, boilerplate included.
const articleFallback = await extract('https://fixture.example/retro-fatigue', { withReadability: false });
check('the fallback is measurably worse, which is why it is a fallback',
  /Accept all cookies/.test(articleFallback.text) && /modern slavery/i.test(articleFallback.text),
  'fallback unexpectedly clean');

await browser.close();

let failed = 0;
for (const result of checks) {
  if (result.ok) console.log('  ok   ' + result.name);
  else { failed += 1; console.log('  FAIL ' + result.name + '\n       ' + result.detail); }
}
console.log('');
console.log(checks.length - failed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
