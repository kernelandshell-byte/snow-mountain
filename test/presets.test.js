import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesRule } from '../src/core/capture-policy.js';
import { PRESETS, rulesFor } from '../src/shared/presets.js';

// Builds a plausible URL for a pattern and checks it actually matches. This
// is a shape check, not a re-implementation of matchesRule: it exists so a
// pattern that cannot match any real host (like the shipped 'webmail.*',
// 'banking.*' and 'patient.*' once were, silently) fails a test instead of
// silently doing nothing for as long as nobody happens to look.
function sampleUrlFor(pattern) {
  const [hostPart, ...pathParts] = pattern.split('/');
  let host;
  if (hostPart.startsWith('*.')) host = 'sub.' + hostPart.slice(2);
  else if (hostPart.endsWith('.*')) host = hostPart.slice(0, -1) + 'example.org';
  else host = hostPart;
  const path = pathParts.length ? '/' + pathParts.join('/').replace(/\*$/, 'x') : '/somewhere';
  return 'https://' + host + path;
}

test('every shipped preset pattern matches at least one real-shaped host', () => {
  for (const [bundle, patterns] of Object.entries(PRESETS)) {
    for (const pattern of patterns) {
      const url = sampleUrlFor(pattern);
      assert.equal(
        matchesRule(url, pattern),
        true,
        `preset "${bundle}" pattern "${pattern}" does not match ${url}`
      );
    }
  }
});

test('rulesFor only includes enabled bundles, plus custom rules', () => {
  const rules = rulesFor({ webmail: true, banking: false }, ['example.com']);
  assert.ok(rules.includes('mail.google.com'));
  assert.ok(!rules.includes('paypal.com'));
  assert.ok(rules.includes('example.com'));
});

// The URLs people actually visit, with every bundle on. Each of these was
// saved at one point: "*.paypal.com" never matches www.paypal.com, because
// the matcher strips "www." first, and several bundles were empty or tiny.
const ALL_ON = rulesFor(Object.fromEntries(Object.keys(PRESETS).map((key) => [key, true])), []);
const blocked = (url) => ALL_ON.some((rule) => matchesRule(url, rule));

const MUST_BLOCK = [
  'https://www.paypal.com/myaccount/summary', 'https://paypal.com/', 'https://wise.com/home',
  'https://www.chase.com/', 'https://secure.chase.com/web/auth/dashboard', 'https://www.bankofamerica.com/',
  'https://www.bankhapoalim.co.il/', 'https://app.revolut.com/', 'https://www.barclays.co.uk/',
  'https://www.sparkasse.de/', 'https://banking.dkb.de/',
  'https://www.gov.uk/', 'https://www.gov.il/he', 'https://www.irs.gov/', 'https://www.tax.service.gov.uk/',
  'https://mychart.com/', 'https://www.zocdoc.com/', 'https://my.nhs.uk/', 'https://www.doctolib.fr/',
  'https://www.pornhub.com/', 'https://anything.xxx/', 'https://onlyfans.com/',
  'https://tinder.com/app/recs', 'https://www.okcupid.com/messages', 'https://web.grindr.com/', 'https://bumble.com/app',
  'http://192.168.1.1/', 'http://10.0.0.5/admin', 'http://172.20.3.4/', 'http://127.0.0.1:8080/',
  'http://[::1]/', 'http://[fd12:3456::1]/', 'http://wiki/', 'http://printer.local/',
  'https://www.google.co.il/search?q=x', 'https://www.google.com/search?q=x', 'https://www.google.de/search?q=x',
  'https://search.yahoo.com/search?p=x', 'https://yandex.ru/search/?text=x', 'https://www.baidu.com/s?wd=x',
  'https://duckduckgo.com/?q=x', 'https://www.bing.com/search?q=x',
  'https://mail.google.com/mail/u/0/', 'https://outlook.office.com/mail/',
  'https://web.whatsapp.com/', 'https://app.slack.com/client/T1/C1', 'https://www.messenger.com/t/1',
  'https://www.linkedin.com/messaging/thread/1/', 'https://discord.com/channels/1/2',
  'https://docs.google.com/document/d/1/edit', 'https://acme.atlassian.net/wiki/spaces/X',
  'https://www.notion.so/acme/Page-1', 'https://acme.sharepoint.com/sites/x',
];

const MUST_ALLOW = [
  'https://en.wikipedia.org/wiki/Banking', 'https://www.nytimes.com/2026/01/01/business/banks.html',
  'https://www.google.com/maps', 'https://news.ycombinator.com/', 'https://www.reddit.com/r/programming/',
  'https://www.linkedin.com/pulse/some-article', 'https://discord.com/blog/post', 'https://github.com/',
  'https://8.8.8.8/', 'https://www.essex.ac.uk/', 'https://sussex.example/',
  'https://www.theguardian.com/money/2026/jan/01/savings', 'https://developer.chrome.com/docs',
];

test('every sensitive URL is excluded with all bundles on', () => {
  const missed = MUST_BLOCK.filter((url) => !blocked(url));
  assert.deepEqual(missed, []);
});

test('ordinary reading is not excluded', () => {
  const caught = MUST_ALLOW.filter((url) => blocked(url));
  assert.deepEqual(caught, []);
});

test('no shipped entry uses "*." in front of a domain the bare form would cover', () => {
  // "*.paypal.com" misses www.paypal.com. Only whole top-level domains
  // (".xxx") are allowed in that form, where there is no bare site to miss.
  const suspicious = Object.values(PRESETS).flat()
    .filter((rule) => rule.startsWith('*.') && rule.slice(2).includes('.'));
  assert.deepEqual(suspicious, []);
});

test('pages kept before a category was turned on are found by it', async () => {
  const { excludedIds } = await import('../src/core/capture-policy.js');
  const pages = [
    { id: 1, url: 'https://www.paypal.com/myaccount/summary' },
    { id: 2, url: 'https://docs.google.com/document/d/abc/edit' },
    { id: 3, url: 'https://example.com/an-article' },
    { id: 4, url: 'https://example.com/reset-password/Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA' },
  ];
  assert.deepEqual(excludedIds(pages, PRESETS.banking), [1]);
  assert.deepEqual(excludedIds(pages, rulesFor({ banking: true, workTools: true }, [])), [1, 2]);
  assert.deepEqual(excludedIds(pages, [], { secrets: true }), [4]);
  assert.deepEqual(excludedIds(pages, []), []);
});
