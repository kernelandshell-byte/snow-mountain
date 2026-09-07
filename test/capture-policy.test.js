import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, matchesRule, MODE } from '../src/core/capture-policy.js';

const base = { url: 'https://example.com/article', mode: MODE.BROAD };

test('captures an ordinary page', () => {
  assert.equal(decide(base).capture, true);
});

test('a password field blocks capture even on an allowlisted site', () => {
  const r = decide({
    ...base,
    mode: MODE.STRICT,
    allowlist: ['example.com'],
    hasPasswordField: true,
  });
  assert.equal(r.capture, false);
  assert.match(r.reason, /password/);
});

test('incognito and pause both block', () => {
  assert.equal(decide({ ...base, incognito: true }).capture, false);
  assert.equal(decide({ ...base, paused: true }).capture, false);
});

test('non web pages are refused', () => {
  assert.equal(decide({ ...base, url: 'chrome://extensions' }).capture, false);
  assert.equal(decide({ ...base, url: 'file:///tmp/a.html' }).capture, false);
});

test('strict mode captures only what is on the allowlist', () => {
  const strict = { ...base, mode: MODE.STRICT, allowlist: ['docs.example.org'] };
  assert.equal(decide(strict).capture, false);
  assert.equal(decide({ ...strict, url: 'https://docs.example.org/guide' }).capture, true);
});

test('exclusion rules block in broad mode', () => {
  const r = decide({ ...base, url: 'https://mail.google.com/u/0', rules: ['mail.google.com'] });
  assert.equal(r.capture, false);
  assert.match(r.reason, /excluded/);
});

test('rules cover subdomains, and *. excludes the apex', () => {
  assert.equal(matchesRule('https://a.example.com/x', 'example.com'), true);
  assert.equal(matchesRule('https://example.com/x', 'example.com'), true);
  assert.equal(matchesRule('https://a.example.com/x', '*.example.com'), true);
  assert.equal(matchesRule('https://example.com/x', '*.example.com'), false);
});

test('path prefix rules only match that prefix', () => {
  assert.equal(matchesRule('https://e.com/private/doc', 'e.com/private/*'), true);
  assert.equal(matchesRule('https://e.com/public/doc', 'e.com/private/*'), false);
});

test('a rule for another host does not leak', () => {
  assert.equal(matchesRule('https://notexample.com/x', 'example.com'), false);
});
