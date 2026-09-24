import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planEviction, budgetStatus, projectExhaustion, paceFrom, clockHold, CLOCK_HOLD_MS,
} from '../src/core/eviction.js';

const DAY = 86400000;
const now = Date.now();
const page = (id, ageDays, bytes = 1000, pinned = 0) => ({
  id,
  lastSeen: now - ageDays * DAY,
  firstSeen: now - ageDays * DAY,
  bytes,
  pinned,
});

test('nothing is evicted when both caps are satisfied', () => {
  const plan = planEviction({
    pages: [page(1, 10), page(2, 20)],
    now,
    retentionMonths: 12,
    sizeCapBytes: 1e9,
  });
  assert.deepEqual(plan.ids, []);
  assert.equal(plan.reason, null);
});

test('the age cap removes what is older than the retention window', () => {
  const plan = planEviction({
    pages: [page(1, 400), page(2, 10)],
    now,
    retentionMonths: 12,
    sizeCapBytes: 1e9,
  });
  assert.deepEqual(plan.ids, [1]);
  assert.equal(plan.reason, 'age');
});

test('the size cap removes the oldest until it fits', () => {
  const plan = planEviction({
    pages: [page(1, 30), page(2, 20), page(3, 10)],
    now,
    retentionMonths: 12,
    sizeCapBytes: 2000,
  });
  assert.deepEqual(plan.ids, [1]);
  assert.equal(plan.reason, 'size');
  assert.equal(plan.bytesFreed, 1000);
});

test('pinned pages are never evicted, by either cap', () => {
  const plan = planEviction({
    pages: [page(1, 4000, 1000, 1), page(2, 3000, 1000, 1), page(3, 1, 1000)],
    now,
    retentionMonths: 1,
    sizeCapBytes: 500,
  });
  assert.deepEqual(plan.ids, [3], 'only the unpinned page can go');
});

test('a page pinned while over budget leaves the budget genuinely exceeded', () => {
  // Worth stating plainly: pinning wins over the cap. The interface has to
  // say so rather than pretending the cap still holds.
  const plan = planEviction({
    pages: [page(1, 10, 5000, 1)],
    now,
    retentionMonths: 12,
    sizeCapBytes: 1000,
  });
  assert.deepEqual(plan.ids, []);
});

test('both caps can bite at once and the reason says so', () => {
  const plan = planEviction({
    pages: [page(1, 400), page(2, 30), page(3, 20), page(4, 1)],
    now,
    retentionMonths: 12,
    sizeCapBytes: 2000,
  });
  assert.equal(plan.reason, 'both');
  assert.ok(plan.ids.includes(1), 'the old one goes on age');
  assert.ok(plan.ids.includes(2), 'the next oldest goes on size');
});

test('budget status crosses into warning and then over', () => {
  assert.equal(budgetStatus({ usedBytes: 10, sizeCapBytes: 100 }).level, 'ok');
  assert.equal(budgetStatus({ usedBytes: 85, sizeCapBytes: 100 }).level, 'warn');
  assert.equal(budgetStatus({ usedBytes: 120, sizeCapBytes: 100 }).level, 'over');
});

test('exhaustion is projected from the observed pace', () => {
  const when = projectExhaustion({
    usedBytes: 0,
    sizeCapBytes: 1000,
    bytesPerDay: 100,
    now,
  });
  assert.equal(Math.round((when - now) / DAY), 10);
});

test('no pace means no projection rather than a wrong one', () => {
  assert.equal(projectExhaustion({ usedBytes: 0, sizeCapBytes: 1000, bytesPerDay: 0 }), null);
});

test('a pace that would take a decade is not worth showing', () => {
  assert.equal(
    projectExhaustion({ usedBytes: 0, sizeCapBytes: 1e12, bytesPerDay: 1, now }),
    null
  );
});

test('pace is measured from the oldest page, not from today', () => {
  const pace = paceFrom({ totalBytes: 2000, oldestFirstSeen: now - 10 * DAY }, now);
  assert.equal(pace.daysObserved, 10);
  assert.equal(Math.round(pace.bytesPerDay), 200);
});

test('an empty archive has no pace rather than a pace of zero over zero days', () => {
  assert.deepEqual(paceFrom({ totalBytes: 0, oldestFirstSeen: null }, now), {
    bytesPerDay: 0,
    daysObserved: 0,
  });
});

// Used to: the sweep declined the age rule once, recorded the wrong time as
// its own, and the next sweep an hour later deleted by the wrong clock.
test('a clock jump holds the age rule off for a day, not one sweep', () => {
  const HOUR = 3600000;
  const lastSweepAt = Date.UTC(2026, 0, 1);
  const wrongNow = lastSweepAt + 400 * 86400000;
  const first = clockHold({ now: wrongNow, lastSweepAt });
  assert.ok(first.problem);
  assert.equal(first.holdUntil, wrongNow + CLOCK_HOLD_MS);

  // An hour later the gap looks ordinary, but the hold is still on.
  const second = clockHold({ now: wrongNow + HOUR, lastSweepAt: wrongNow, holdUntil: first.holdUntil, lastProblem: first.problem });
  assert.equal(second.problem, first.problem);
  assert.equal(second.holdUntil, first.holdUntil);

  // A day of steady time later, it lifts.
  const later = clockHold({ now: first.holdUntil + HOUR, lastSweepAt: first.holdUntil, holdUntil: first.holdUntil });
  assert.deepEqual(later, { problem: null, holdUntil: 0 });
});

test('a clock put back right starts a fresh hold rather than keeping a far off one', () => {
  const lastSweepAt = Date.UTC(2027, 0, 1);
  const rightNow = Date.UTC(2026, 0, 1);
  const back = clockHold({ now: rightNow, lastSweepAt, holdUntil: lastSweepAt + CLOCK_HOLD_MS });
  assert.ok(back.problem);
  assert.equal(back.holdUntil, rightNow + CLOCK_HOLD_MS);
  // A hold set by a clock that has since gone back is not trusted for longer than a day.
  const stale = clockHold({ now: rightNow, lastSweepAt: rightNow - 3600000, holdUntil: rightNow + 300 * 86400000 });
  assert.deepEqual(stale, { problem: null, holdUntil: 0 });
});

test('with no jump and no hold, nothing is held', () => {
  const now = Date.UTC(2026, 5, 1);
  assert.deepEqual(clockHold({ now, lastSweepAt: now - 3600000 }), { problem: null, holdUntil: 0 });
  assert.deepEqual(clockHold({ now, lastSweepAt: 0 }), { problem: null, holdUntil: 0 });
});
