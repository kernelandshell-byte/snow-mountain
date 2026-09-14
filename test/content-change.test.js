import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSuspiciousShrink, PROTECT_ABOVE_CHARS } from '../src/core/content-change.js';

const article = 'word '.repeat(600);          // ~3000 characters
const paywall = 'Subscribe to read the rest of this article. '.repeat(4);

test('an article replaced by a paywall stub is not an edit', () => {
  assert.equal(isSuspiciousShrink({ existingText: article, incomingText: paywall }), true);
});

test('an ordinary edit is still an edit', () => {
  assert.equal(
    isSuspiciousShrink({ existingText: article, incomingText: 'word '.repeat(520) }),
    false
  );
});

test('a page that grew is never suspicious', () => {
  assert.equal(
    isSuspiciousShrink({ existingText: article, incomingText: article + article }),
    false
  );
});

test('a short page is not worth protecting, so it is left alone', () => {
  const short = 'x'.repeat(PROTECT_ABOVE_CHARS - 1);
  assert.equal(isSuspiciousShrink({ existingText: short, incomingText: 'x' }), false);
});

test('asking for this page explicitly overrides all of it', () => {
  assert.equal(
    isSuspiciousShrink({ existingText: article, incomingText: paywall, explicit: true }),
    true === false
  );
});

test('an empty archive entry is not a shrink', () => {
  assert.equal(isSuspiciousShrink({ existingText: '', incomingText: paywall }), false);
});

test('whitespace does not count as content', () => {
  assert.equal(
    isSuspiciousShrink({ existingText: article, incomingText: '   \n\n   ' + 'a'.repeat(50) }),
    true
  );
});
