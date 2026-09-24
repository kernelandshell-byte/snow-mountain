import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bytes, pageCount } from '../src/shared/format.js';

test('small sizes are shown in kilobytes, never as 0.0MB', () => {
  assert.equal(bytes(0), '0B');
  assert.equal(bytes(900), '900B');
  assert.equal(bytes(40000), '39KB');
  assert.equal(bytes(900 * 1024), '900KB');
});

test('megabytes gain a decimal only while it means something', () => {
  assert.equal(bytes(2.5 * 1048576), '2.5MB');
  assert.equal(bytes(250 * 1048576), '250MB');
});

test('gigabytes are shown as gigabytes', () => {
  assert.equal(bytes(2 * 1073741824), '2.0GB');
});

test('one page is not "1 pages"', () => {
  assert.equal(pageCount(1), '1 page');
  assert.equal(pageCount(0), '0 pages');
  assert.equal(pageCount(1200), '1,200 pages');
});

test('the minimum tells a husk apart from short writing', async () => {
  const { MIN_TEXT_CHARS, MIN_TEXT_OVER_TITLE } = await import('../src/shared/constants.js');
  const keeps = (text, title) =>
    text.length >= MIN_TEXT_CHARS && text.length >= title.length + MIN_TEXT_OVER_TITLE;

  // What a page whose content sits in a shadow root or an iframe extracts to:
  // the wrapper's heading, echoed back.
  assert.equal(keeps('An article inside a shadow root', 'An article inside a shadow root'), false);

  // Two sentences someone might actually have read.
  assert.equal(
    keeps(
      'Grind size is the one variable you cannot write down and repeat, because beans change as they age.',
      'Espresso notes'
    ),
    true
  );

  // A short sentence in a script that carries a word per character. The floor
  // is low enough that this is a judgement about extraction rather than about
  // which language someone reads in.
  assert.equal(keeps('街头摄影是一种记录日常生活的艺术形式，需要耐心和对细节的关注。', '街头摄影'), true);

  // And the floor still refuses a page that genuinely has nothing on it,
  // even when its title is too short for the ratio to catch it.
  assert.equal(keeps('Loading…', ''), false);
});

test('text is cut by bytes, never inside a character', async () => {
  const { truncateUtf8 } = await import('../src/shared/format.js');
  const hebrew = 'שלום'.repeat(1000); // two bytes a character
  const cut = truncateUtf8(hebrew, 1001);
  assert.ok(new TextEncoder().encode(cut).length <= 1001);
  assert.equal(cut.length, 500);
  assert.ok(!cut.includes('�'));
  assert.equal(truncateUtf8('short', 100), 'short');
  assert.equal(truncateUtf8('😀😀', 5), '😀');
});
