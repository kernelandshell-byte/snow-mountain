// Stemming and typo tolerance both verify a batch of real terms and throw
// most of them away -- on a stem match, or an edit-distance check -- so
// their scan is capped at VERIFY_SCAN_LIMIT rather than the wider
// PREFIX_SCAN_LIMIT prefix widening uses, where every scanned term is kept.
// See "Typo tolerance" in ARCHITECTURE.md for why: reading a real term's
// postings costs the same whether or not it survives the check, and a
// short shared prefix in a real archive can have hundreds of them.
//
// This only checks that a real answer is still found when several other
// terms share its prefix, well short of VERIFY_SCAN_LIMIT itself -- not
// that every possible one always will be. A prefix with more genuine
// candidates than VERIFY_SCAN_LIMIT is the same known trade-off
// PREFIX_SCAN_LIMIT already makes for prefix widening, and is expected to
// behave the same way: a real match can be missed if too much else sorts
// ahead of it in the same scan.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/db/memory-store.js';
import { search } from '../src/core/index-reader.js';

test('a typo is still found when several other words share its scan prefix', async () => {
  const store = createMemoryStore();
  // Real "cat-" words that are not typos of "category", plus the one that
  // actually is. "category" sorts ahead of all of them ("e" < "w"), so
  // this also confirms the scan order itself, not just the scan size.
  const words = [];
  for (let i = 0; i < 20; i++) words.push('catword' + i);
  words.push('category');
  await store.putPage({ url: 'https://a.example/one', title: '', text: words.join(' ') });

  const result = await search('categary', { store });
  assert.equal(result.results.length, 1);
  assert.deepEqual(result.expanded.categary, ['category']);
});

test('a stem is still found when several other words share its scan prefix', async () => {
  const store = createMemoryStore();
  // "organizer0".."organizer19" share the stem "organiz"'s prefix but not
  // its actual stem (each stems to itself), so they are scanned and
  // discarded; only "organizing" (stem "organiz", same as the query) is
  // kept.
  const words = [];
  for (let i = 0; i < 20; i++) words.push('organizer' + i);
  words.push('organizing');
  await store.putPage({ url: 'https://a.example/one', title: '', text: words.join(' ') });

  const result = await search('organization', { store, stemLanguages: ['en'] });
  assert.equal(result.results.length, 1);
  assert.deepEqual(result.expanded.organization, ['organizing']);
});
