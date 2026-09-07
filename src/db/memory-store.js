// In-memory implementation of the Store interface that index-reader expects.
// Used by the unit tests and by the relevance harness, so search can be
// exercised without a browser. The IndexedDB implementation has to satisfy
// exactly this contract and nothing more.

import { tokenize } from '../core/tokenizer.js';
import { buildPostings, bucketOf, upsertDoc } from '../core/index-writer.js';
import { urlKey, domainOf } from '../core/url-key.js';

export function createMemoryStore() {
  const pages = new Map();
  const buckets = new Map(); // `${term}:${bucket}` -> docs[]
  let nextId = 1;
  let totalTokens = 0;

  const key = (term, bucket) => term + ':' + bucket;

  return {
    addPage({ url, title = '', text = '', lastSeen = Date.now(), pinned = false }) {
      const id = nextId++;
      // Title and body are one token stream, so a title match is simply a
      // match. Weighting happens at score time, not at index time.
      const tokens = tokenize(title + '\n\n' + text);
      const doc = {
        id,
        url,
        urlKey: urlKey(url),
        domain: domainOf(url),
        title,
        text,
        wordCount: tokens.length,
        lastSeen,
        firstSeen: lastSeen,
        visitCount: 1,
        pinned: pinned ? 1 : 0,
      };
      pages.set(id, doc);
      totalTokens += tokens.length;

      for (const [term, entry] of buildPostings(tokens)) {
        const b = bucketOf(id);
        const k = key(term, b);
        buckets.set(k, upsertDoc(buckets.get(k) || [], { id, tf: entry.tf, pos: entry.pos }));
      }
      return id;
    },

    async readTerm(term) {
      const out = [];
      for (const [k, docs] of buckets) {
        if (k.slice(0, k.lastIndexOf(':')) === term) out.push(...docs);
      }
      return out.sort((a, b) => a.id - b.id);
    },

    async readDocs(ids) {
      const out = new Map();
      for (const id of ids) if (pages.has(id)) out.set(id, pages.get(id));
      return out;
    },

    async readStats() {
      const docCount = pages.size;
      return {
        docCount,
        avgDocLength: docCount ? totalTokens / docCount : 0,
      };
    },

    _pages: pages,
  };
}
