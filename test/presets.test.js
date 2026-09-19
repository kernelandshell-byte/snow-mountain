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
  assert.ok(!rules.includes('*.paypal.com'));
  assert.ok(rules.includes('example.com'));
});
