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
