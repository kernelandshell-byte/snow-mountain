import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPostings, upsertDoc, removeDoc, bucketOf } from '../src/core/index-writer.js';
import { tokenize } from '../src/core/tokenizer.js';
import { MAX_POSITIONS_PER_TERM, BUCKET_SHIFT } from '../src/shared/constants.js';

test('counts term frequency and records positions', () => {
  const p = buildPostings(tokenize('cat dog cat'));
  assert.equal(p.get('cat').tf, 2);
  assert.deepEqual(p.get('cat').pos, [0, 2]);
  assert.equal(p.get('dog').tf, 1);
});

test('caps stored positions but keeps counting frequency', () => {
  const text = Array(100).fill('cat').join(' ');
  const entry = buildPostings(tokenize(text)).get('cat');
  assert.equal(entry.tf, 100);
  assert.equal(entry.pos.length, MAX_POSITIONS_PER_TERM);
});

test('documents land in fixed size buckets', () => {
  const size = 1 << BUCKET_SHIFT;
  assert.equal(bucketOf(1), 0);
  assert.equal(bucketOf(size - 1), 0);
  assert.equal(bucketOf(size), 1);
  assert.equal(bucketOf(size * 3 + 7), 3);
});

test('upsert replaces an existing document and keeps the bucket sorted', () => {
  let docs = [{ id: 5, tf: 1, pos: [0] }, { id: 2, tf: 1, pos: [0] }];
  docs = upsertDoc(docs, { id: 5, tf: 9, pos: [1] });
  assert.deepEqual(docs.map((d) => d.id), [2, 5]);
  assert.equal(docs.find((d) => d.id === 5).tf, 9);
  assert.equal(removeDoc(docs, 2).length, 1);
});
