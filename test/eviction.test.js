import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planEviction, budgetStatus, projectExhaustion, paceFrom } from '../src/core/eviction.js';

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
  const pace = paceFrom([page(1, 10, 1000), page(2, 5, 1000)], now);
  assert.equal(pace.daysObserved, 10);
  assert.equal(Math.round(pace.bytesPerDay), 200);
});
