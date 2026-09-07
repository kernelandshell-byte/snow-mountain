import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locateQuote } from '../src/core/quote-match.js';

const page = 'Teams usually start with enthusiasm. Retro fatigue sets in when the same problems are raised every fortnight and nothing changes. The fix is rarely a new format.';

test('finds a quote that is still exactly there', () => {
  const hit = locateQuote(page, 'Retro fatigue sets in');
  assert.equal(hit.how, 'exact');
  assert.equal(page.slice(hit.start, hit.end), 'Retro fatigue sets in');
});

test('ignores reflowed whitespace and a changed capital', () => {
  const reflowed = 'Teams usually start with enthusiasm.\n\n  Retro   fatigue\nsets in when the same problems are raised.';
  const hit = locateQuote(reflowed, 'retro fatigue sets in when the same problems');
  assert.equal(hit.how, 'loose');
  assert.match(reflowed.slice(hit.start, hit.end), /Retro\s+fatigue/);
});

test('falls back to the opening when the sentence was edited', () => {
  const edited = 'Retro fatigue sets in when the same problems are raised every single week and very little changes.';
  const stored = 'Retro fatigue sets in when the same problems are raised every fortnight and nothing changes';
  const hit = locateQuote(edited, stored);
  assert.equal(hit.how, 'partial');
  assert.ok(edited.slice(hit.start, hit.end).startsWith('Retro fatigue sets in'));
});

test('gives up rather than matching something unrelated', () => {
  assert.equal(locateQuote(page, 'kangaroos in the marketing department'), null);
});

test('refuses to match on a scrap of a sentence', () => {
  // Three words left after editing is not enough to be confident.
  assert.equal(locateQuote('The fix is rarely a new format.', 'Retro fatigue sets somewhere else entirely'), null);
});

test('handles empty input without throwing', () => {
  assert.equal(locateQuote('', 'anything'), null);
  assert.equal(locateQuote(page, ''), null);
  assert.equal(locateQuote(page, null), null);
});
