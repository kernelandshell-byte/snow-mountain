import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phraseFrom, textFragmentUrl } from '../src/core/text-fragment.js';

test('starts at the match and stops at the end of the sentence', () => {
  const snippet = 'Retro fatigue sets in when the same problems are raised. The fix is rarely a new format.';
  const phrase = phraseFrom(snippet, [[0, 5]]);
  assert.ok(phrase.startsWith('Retro fatigue sets in'));
  assert.ok(!phrase.includes('The fix'), 'should not cross the sentence boundary');
});

test('never runs longer than ten words', () => {
  const snippet = 'one two three four five six seven eight nine ten eleven twelve thirteen';
  assert.equal(phraseFrom(snippet, [[0, 3]]).split(' ').length, 10);
});

test('begins on a word boundary even when the match is mid word', () => {
  const snippet = 'The cohort chart puts each signup month on its own row';
  const phrase = phraseFrom(snippet, [[6, 12]]);
  assert.ok(phrase.startsWith('cohort chart'), 'got: ' + phrase);
});

test('drops the ellipses a snippet carries', () => {
  const phrase = phraseFrom('…raised every fortnight and nothing changes…', [[0, 6]]);
  assert.ok(!phrase.includes('…'));
  assert.ok(phrase.startsWith('raised every'));
});

test('refuses to build a fragment out of almost nothing', () => {
  assert.equal(phraseFrom('two words', []), null);
  assert.equal(phraseFrom('', []), null);
});

test('produces an encoded directive on the bare url', () => {
  const url = textFragmentUrl(
    'https://example.com/a#section',
    'Retro fatigue sets in when the same problems are raised.',
    [[0, 5]]
  );
  assert.ok(url.startsWith('https://example.com/a#:~:text='), url);
  assert.ok(!url.includes('#section'), 'the old fragment has to go');
  assert.ok(url.includes('Retro%20fatigue'), url);
});

test('falls back to the plain url when there is nothing quotable', () => {
  assert.equal(textFragmentUrl('https://example.com/a', '', []), 'https://example.com/a');
});

test('a dash in the passage is encoded, since the syntax uses it', () => {
  const url = textFragmentUrl('https://example.com/a', 'Bread - flour, water and salt - rises slowly', []);
  assert.ok(!/text=.*-/.test(url), url);
  assert.ok(url.includes('%2D'), url);
});
