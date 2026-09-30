import { test } from 'node:test';
import assert from 'node:assert/strict';
import { whenText } from '../src/ui/shared/when.js';

const NOW = Date.parse('2026-09-14T12:00:00Z');
const daysAgo = (n) => NOW - n * 86400000;

test('the recent past reads as a person would say it', () => {
  assert.equal(whenText(NOW, NOW), 'today');
  assert.equal(whenText(daysAgo(1), NOW), 'yesterday');
  assert.equal(whenText(daysAgo(9), NOW), '9 days ago');
});

test('one of something is never "1 months ago"', () => {
  assert.equal(whenText(daysAgo(31), NOW), 'last month');
  assert.equal(whenText(daysAgo(365), NOW), 'last year');
});

test('and more than one still counts', () => {
  assert.equal(whenText(daysAgo(70), NOW), '2 months ago');
  assert.equal(whenText(daysAgo(800), NOW), '2 years ago');
});

test('a page dated in the future does not read as a prediction', () => {
  // What a wrong clock leaves behind. "In four months" on something you have
  // already read would be a strange thing to put in front of somebody.
  assert.equal(whenText(NOW + 120 * 86400000, NOW), 'today');
});

test('nonsense produces nothing rather than NaN', () => {
  assert.equal(whenText(undefined, NOW), '');
  assert.equal(whenText(NaN, NOW), '');
});

// "Yesterday" is the calendar day before the reader's today, wherever they
// are, not anything between 24 and 48 hours ago.
const inZone = (zone, run) => {
  const before = process.env.TZ;
  process.env.TZ = zone;
  try { run(); } finally { if (before === undefined) delete process.env.TZ; else process.env.TZ = before; }
};
const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).getTime();

test('last night is yesterday the next morning, and today is today from midnight', () => {
  for (const zone of ['America/Los_Angeles', 'Europe/Amsterdam', 'Pacific/Kiritimati', 'Asia/Kolkata']) {
    inZone(zone, () => {
      const now = at(2026, 9, 14, 8, 0);
      assert.equal(whenText(at(2026, 9, 13, 23, 30), now), 'yesterday', zone);
      assert.equal(whenText(at(2026, 9, 14, 0, 10), now), 'today', zone);
      assert.equal(whenText(at(2026, 9, 13, 9, 0), now), 'yesterday', zone);
      assert.equal(whenText(at(2026, 9, 12, 23, 59), now), '2 days ago', zone);
    });
  }
});

test('the day the clocks change still counts as one day', () => {
  inZone('America/Los_Angeles', () => {
    // Spring forward 2026-03-08 (23 hour day) and fall back 2026-11-01 (25).
    assert.equal(whenText(at(2026, 3, 8, 12, 0), at(2026, 3, 9, 12, 0)), 'yesterday');
    assert.equal(whenText(at(2026, 11, 1, 12, 0), at(2026, 11, 2, 12, 0)), 'yesterday');
    assert.equal(whenText(at(2026, 3, 7, 23, 30), at(2026, 3, 9, 0, 30)), '2 days ago');
    assert.equal(whenText(at(2026, 11, 1, 0, 30), at(2026, 11, 2, 23, 30)), 'yesterday');
  });
});
