
// The shapes of pages people actually spend their time on, which are mostly
// not articles: forum threads, feeds, video pages, dashboards, chats, search
// results. Mozilla's corpus is all articles, so this covers what it does not.
//
// Some of these have an obviously correct answer and are asserted. Others
// are genuinely open questions about what a reading memory should do with a
// page that is not a document, so this reports what happens and leaves the
// judgement visible rather than baking in a guess.

import { chromium } from 'playwright';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGrantedExtension } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const granted = await buildGrantedExtension(root);

const shell = (title, body) =>
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>' + title + '</title>' +
  '<style>body{font:16px/1.6 system-ui;margin:0}nav,aside,footer{color:#666}main{max-width:700px;margin:0 auto;padding:20px}</style>' +
  '</head><body>' + body + '</body></html>';

const nav = '<nav><a href="/">Home</a><a href="/popular">Popular</a><a href="/all">All</a><a href="/login">Log in</a></nav>';
const foot = '<footer>Terms, privacy, cookie policy, and a long list of country selectors.</footer>';

const comments = (n) =>
  Array.from({ length: n }, (_, i) =>
    '<div class="comment"><span class="score">' + (200 - i * 7) + ' points</span>' +
    '<span class="user">user' + i + '</span>' +
    '<p>Comment number ' + (i + 1) + ': this is the kind of reply that carries the actual answer on a forum thread, which is why the comments are often the reason the page was worth reading at all.</p>' +
    '<div class="reply"><p>A nested reply to comment ' + (i + 1) + ' adding a correction that matters.</p></div></div>'
  ).join('');

const SHAPES = {
  // A forum thread: short post, long comment tree, vote controls everywhere.
  forum: shell('Ask: how do you stop retros becoming theatre? : r/agile',
    nav + '<main><h1>How do you stop retros becoming theatre?</h1>' +
    '<div class="post"><span class="score">412 points</span><p>We run retros every fortnight and the same three problems come up every time. Nothing changes between sessions. What actually worked for you?</p></div>' +
    '<div class="comments"><h2>418 comments</h2>' + comments(25) + '</div></main>' +
    '<aside>About this community. Rules. Moderators. Related communities.</aside>' + foot),

  // A link aggregator: almost no prose, everything is a link in a table.
  aggregator: shell('Front page',
    nav + '<main><table>' +
    Array.from({ length: 30 }, (_, i) =>
      '<tr><td>' + (i + 1) + '.</td><td><a href="/item?id=' + i + '">A headline about indexing, retention or some other engineering concern number ' + i + '</a>' +
      '<span class="meta">' + (300 - i * 9) + ' points by user' + i + ' 3 hours ago | 84 comments</span></td></tr>'
    ).join('') + '</table></main>' + foot),

  // A timeline: many short posts, more chrome than content.
  feed: shell('Home / timeline',
    nav + '<main>' +
    Array.from({ length: 40 }, (_, i) =>
      '<article class="post"><span class="handle">@someone' + i + '</span>' +
      '<p>Short post number ' + i + ' with an opinion about software in it, roughly the length people actually write.</p>' +
      '<div class="actions">Reply Repost Like Bookmark Share</div></article>'
    ).join('') + '</main>' + foot),

  // A video page: the thing you came for is not text at all.
  video: shell('How search engines rank documents - Explained',
    nav + '<main><h1>How search engines rank documents, explained</h1>' +
    '<div class="player">[video player]</div>' +
    '<div class="meta">184,203 views · 2 weeks ago</div>' +
    '<div class="description"><p>In this video we walk through how BM25 scores a document against a query, why rare words count for more, and what the two parameters actually do. Links to the papers are below.</p><p>Chapters: 0:00 intro, 2:14 term frequency, 7:40 length normalisation.</p></div>' +
    '<div class="comments">' + comments(12) + '</div></main>' + foot),

  // A page that is a shell until its content arrives.
  hydrating: shell('Loading…',
    nav + '<main id="app"><p class="skeleton">Loading…</p></main>' + foot +
    '<script>setTimeout(function(){document.getElementById("app").innerHTML =' +
    ' "<h1>The article that arrived late</h1>" + ' +
    ' "<p>This paragraph did not exist when the page first loaded, which is how most application shaped sites work: the document arrives empty and the words turn up afterwards.</p>".repeat(6);' +
    ' document.title = "The article that arrived late";}, 6000);</script>'),

  // A paywall: a few paragraphs, then a wall.
  paywall: shell('Subscribers only: the piece you wanted',
    nav + '<main><h1>The piece you wanted to read</h1>' +
    '<p>The opening paragraph is always free, and it is usually the summary, which is genuinely the part worth keeping if the rest is behind a wall.</p>' +
    '<p>A second paragraph continues the setup and stops just as it gets to the point.</p>' +
    '<div class="wall"><h2>Subscribe to continue</h2><p>Get unlimited access for 1 euro a month. Cancel anytime.</p><button>Subscribe</button></div>' +
    '</main>' + foot),

  // A consent wall covering the article.
  cookiewall: shell('An article behind a consent dialog',
    '<div class="consent" role="dialog"><h2>We value your privacy</h2><p>We and 1,482 partners store and access information on your device.</p><button>Accept all</button><button>Reject all</button></div>' +
    nav + '<main><h1>An ordinary article</h1>' +
    '<p>The article itself is perfectly ordinary and sits underneath a dialog that covers it until someone clicks one of two buttons designed to look different in importance.</p>'.repeat(4) +
    '</main>' + foot),

  // Content inside a shadow root.
  shadow: shell('An article inside a shadow root',
    nav + '<main><div id="host"></div></main>' + foot +
    '<script>const host=document.getElementById("host");const shadow=host.attachShadow({mode:"open"});' +
    'shadow.innerHTML = "<h1>Inside the shadow root</h1>" + "<p>This paragraph lives inside a shadow root, which is invisible to anything walking the ordinary document tree.</p>".repeat(5);</script>'),

  // Content inside an iframe.
  framed: shell('An article inside an iframe',
    nav + '<main><iframe src="/framed-inner" width="640" height="400"></iframe></main>' + foot),

  'framed-inner': shell('The framed article',
    '<h1>The framed article</h1>' +
    '<p>This paragraph is inside an iframe, which is a separate document with its own address, and therefore its own answer to the question of what page you are on.</p>'.repeat(5)),

  // A page of results about other pages.
  results: shell('retro fatigue - Search',
    nav + '<main><p>About 412,000 results</p>' +
    Array.from({ length: 10 }, (_, i) =>
      '<div class="result"><a href="/out?u=' + i + '">Result title number ' + i + ' about retro fatigue</a>' +
      '<p>A snippet from the page that mentions retro fatigue and then trails off in the usual way…</p></div>'
    ).join('') + '</main>' + foot),

  // An application, not a document.
  dashboard: shell('Analytics',
    nav + '<main><h1>Analytics</h1><div class="tiles">' +
    Array.from({ length: 6 }, (_, i) => '<div class="tile"><span class="n">' + (1000 + i * 37) + '</span><span class="l">Metric ' + i + '</span></div>').join('') +
    '</div><table><tr><th>Page</th><th>Views</th></tr>' +
    Array.from({ length: 20 }, (_, i) => '<tr><td>/page-' + i + '</td><td>' + (500 - i * 7) + '</td></tr>').join('') +
    '</table></main>' + foot),

  // A chat, which is a document that keeps changing.
  chat: shell('Team chat',
    nav + '<main>' +
    Array.from({ length: 30 }, (_, i) =>
      '<div class="message"><b>person' + (i % 4) + '</b><p>Message number ' + i + ' in a conversation that is mostly short lines and would be strange to keep as a document.</p></div>'
    ).join('') + '</main>' + foot),
};

const server = http.createServer((request, response) => {
  const name = new URL(request.url, 'http://localhost').pathname.slice(1) || 'forum';
  const body = SHAPES[name];
  response.writeHead(body ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(body || 'not found');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const site = 'http://127.0.0.1:' + server.address().port;

const context = await chromium.launchPersistentContext('', {
  headless: false,
  viewport: { width: 1000, height: 800 },
  args: ['--disable-extensions-except=' + granted.dir, '--load-extension=' + granted.dir, '--no-sandbox'],
});
let [worker] = context.serviceWorkers();
if (!worker) worker = await context.waitForEvent('serviceworker');
const extensionId = new URL(worker.url()).host;

const driver = await context.newPage();
await driver.goto('chrome-extension://' + extensionId + '/src/ui/options/options.html');
const ask = (type, payload) =>
  driver.evaluate(
    async ({ t, p }) => {
      const { MSG } = await import('/src/shared/messages.js');
      return chrome.runtime.sendMessage({ type: MSG[t], payload: p });
    },
    { t: type, p: payload }
  );
// The pages are served from 127.0.0.1, which the local network bundle
// rightly skips, so it is off here; this suite is about page shapes.
await ask('SETTINGS_SET', { setupComplete: true, mode: 'broad', presets: { intranet: false }, customRules: [] });

const checks = [];
const check = (name, condition, detail) => {
  const ok = !!condition;
  checks.push({ name, ok });
  console.log(ok ? '  ok   ' + name : '  FAIL ' + name + '\n       ' + String(detail));
};

const rows = [];

// Two ways in, and the difference matters. "explicit" is someone pressing
// keep this page, which deliberately overrides the heuristics. "auto" is the
// extension deciding for itself after real dwell and scrolling, which is
// where those heuristics actually apply.
async function capture(name, { wait = 0, mode = 'explicit' } = {}) {
  const tab = await context.newPage();
  await tab.goto(site + '/' + name);
  await tab.bringToFront();
  if (wait) await tab.waitForTimeout(wait);

  if (mode === 'auto') {
    for (let i = 0; i < 13; i++) {
      await tab.mouse.wheel(0, 400);
      await tab.waitForTimeout(1000);
    }
    await driver.bringToFront();
    await driver.waitForTimeout(1200);
  } else {
    await driver.bringToFront();
    const realTabId = await driver.evaluate(async (target) => {
      const found = await chrome.tabs.query({});
      const match = found.find((t) => t.url && t.url.includes(target));
      return match ? match.id : null;
    }, '/' + name);
    await ask('CAPTURE_NOW', { tabId: realTabId, url: site + '/' + name });
    await driver.waitForTimeout(900);
  }
  const status = await ask('PAGE_STATUS', { url: site + '/' + name });
  let stored = null;
  if (status.kept) {
    const recent = await ask('RECENT', { limit: 40 });
    stored = recent.find((page) => page.url.includes('/' + name));
  }
  await tab.close();
  rows.push({
    shape: name,
    kept: !!status.kept,
    chars: stored ? stored.text.length : 0,
    title: stored ? stored.title : '',
    text: stored ? stored.text : '',
  });
  return rows[rows.length - 1];
}

for (const name of ['forum', 'aggregator', 'feed', 'video', 'paywall', 'cookiewall', 'results', 'dashboard', 'chat']) {
  await capture(name);
}
const hydrating = await capture('hydrating', { wait: 7000 });

// These two are only interesting when the extension decides for itself.
await capture('shadow', { mode: 'auto' });
await capture('framed', { mode: 'auto' });

console.log('');
console.log('  shape         kept  chars  title');
console.log('  ' + '-'.repeat(64));
for (const row of rows) {
  console.log('  ' + row.shape.padEnd(13) + ' ' + (row.kept ? 'yes ' : 'no  ') + ' ' +
    String(row.chars).padStart(6) + '  ' + row.title.slice(0, 34));
}
console.log('');

const by = (name) => rows.find((row) => row.shape === name);

// --- the ones with a right answer ------------------------------------------
check('a forum thread keeps the comments, which are usually the point',
  by('forum').kept && /Comment number 1/.test(by('forum').text), by('forum').text.slice(0, 120));
check('and drops the vote counts and sidebar',
  !/Moderators/.test(by('forum').text), 'sidebar leaked');

check('a video page keeps its description rather than nothing',
  by('video').kept && /BM25 scores a document/.test(by('video').text), by('video').text.slice(0, 120));

check('a paywalled article keeps the part that was actually there',
  by('paywall').kept && /opening paragraph is always free/.test(by('paywall').text), by('paywall').text.slice(0, 120));
// The subscription pitch comes along with it, because Readability reads it
// as content and it structurally is. Chasing that with a heuristic would be
// fragile and would break on every redesign. Recorded rather than fixed.
console.log('  note  the paywall pitch is stored alongside the free paragraphs: ' +
  (/Cancel anytime/.test(by('paywall').text) ? 'yes' : 'no'));

check('a consent dialog does not end up in the archive',
  by('cookiewall').kept && !/1,482 partners/.test(by('cookiewall').text), by('cookiewall').text.slice(0, 120));

check('a page that hydrates late is kept with the article, not the shell',
  hydrating.kept && /did not exist when the page first loaded/.test(hydrating.text),
  hydrating.text.slice(0, 120));
check('and its title is the real one rather than "Loading"',
  !/Loading/.test(hydrating.title), hydrating.title);

check('a page whose content is in an iframe does not pretend to have kept it',
  !by('framed').kept || !/framed article/i.test(by('framed').text),
  'the outer page claims to contain the frame');

// Pages whose content is unreachable extract to a husk, and a husk in the
// archive is a search result that can never be useful.
check('a page whose content lives in a shadow root is not kept as a husk',
  !by('shadow').kept, by('shadow').chars + ' characters stored');
check('nor is an iframe wrapper', !by('framed').kept, by('framed').chars + ' characters stored');
check('but a page with real content on it still is',
  by('forum').kept && by('feed').kept && by('video').kept, 'a real page was refused');

// Asking for a page by name is not a heuristic and should not be overruled
// by one.
const forced = await capture('shadow', { mode: 'explicit' });
check('though pressing keep this page still keeps it', forced.kept, 'the override did not work');

// The results fixture above is served from localhost, so the shipped rule
// cannot match it. This asks the policy about a real one.
await ask('SETTINGS_SET', { presets: { searchResults: true, intranet: false } });
const googleStatus = await ask('PAGE_STATUS', { url: 'https://www.google.com/search?q=retro+fatigue' });
check('a real search results page is excluded by the shipped rule',
  !googleStatus.capturable && /excluded/.test(googleStatus.reason), JSON.stringify(googleStatus));
const googleOther = await ask('PAGE_STATUS', { url: 'https://blog.google/technology/ai/' });
check('and the rest of that site is not', googleOther.capturable, JSON.stringify(googleOther));

check('nothing crashed on any shape', rows.every((row) => row.chars >= 0), 'a shape threw');

await context.close();
await granted.cleanup();
server.close();

const failed = checks.filter((c) => !c.ok).length;
console.log('');
console.log(checks.length - failed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
