// In-memory reference implementation of the store interface.
//
// It exists so search can be exercised without a browser, and so the same
// contract suite can run against both implementations. Its semantics are the
// specification: if this and idb-store ever disagree, one of them is wrong,
// and the contract test is what says which.

import { tokenize } from '../core/tokenizer.js';
import { buildPostings, bucketOf, upsertDoc, removeDoc } from '../core/index-writer.js';
import { urlKey, domainOf } from '../core/url-key.js';
import { contentHash, byteLength } from '../core/hash.js';

export function createMemoryStore() {
  const pages = new Map();
  const byUrlKey = new Map();
  const buckets = new Map();
  const evictionLog = [];
  let nextId = 1;
  let totalTokens = 0;

  const bucketKey = (term, bucket) => term + ' ' + bucket;

  function dropPostings(page) {
    const tokens = tokenize((page.title || '') + '\n\n' + (page.text || ''));
    const bucket = bucketOf(page.id);
    const seen = new Set();
    for (const { term } of tokens) {
      if (seen.has(term)) continue;
      seen.add(term);
      const key = bucketKey(term, bucket);
      const docs = buckets.get(key);
      if (!docs) continue;
      const next = removeDoc(docs, page.id);
      if (next.length) buckets.set(key, next);
      else buckets.delete(key);
    }
  }

  function writePostings(id, tokens) {
    const bucket = bucketOf(id);
    for (const [term, entry] of buildPostings(tokens)) {
      const key = bucketKey(term, bucket);
      buckets.set(key, upsertDoc(buckets.get(key) || [], { id, tf: entry.tf, pos: entry.pos }));
    }
  }

  return {
    async putPage({ url, title = '', text = '', lastSeen = Date.now(), pinned = false }) {
      const key = urlKey(url);
      if (!key) throw new Error('not an indexable url: ' + url);
      const hash = contentHash(title + '\n\n' + text);
      const existingId = byUrlKey.get(key);
      const existing = existingId ? pages.get(existingId) : null;

      if (existing && existing.contentHash === hash) {
        existing.lastSeen = lastSeen;
        existing.visitCount = (existing.visitCount || 0) + 1;
        return { id: existing.id, created: false, reindexed: false };
      }

      if (existing) {
        dropPostings(existing);
        totalTokens -= existing.wordCount || 0;
      }

      const tokens = tokenize(title + '\n\n' + text);
      const id = existing ? existing.id : nextId++;
      const record = {
        id,
        url,
        urlKey: key,
        title,
        domain: domainOf(url),
        text,
        excerpt: text.slice(0, 400),
        wordCount: tokens.length,
        contentHash: hash,
        firstSeen: existing ? existing.firstSeen : lastSeen,
        lastSeen,
        visitCount: existing ? (existing.visitCount || 0) + 1 : 1,
        pinned: existing ? existing.pinned : pinned ? 1 : 0,
        bytes: byteLength(text) + byteLength(title),
        lang: null,
      };

      pages.set(id, record);
      byUrlKey.set(key, id);
      writePostings(id, tokens);
      totalTokens += tokens.length;

      return { id, created: !existing, reindexed: !!existing };
    },

    async readTerm(term) {
      const out = [];
      const prefix = term + ' ';
      for (const [key, docs] of buckets) {
        if (key.startsWith(prefix)) out.push(...docs);
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
        totalTokens,
        avgDocLength: docCount ? totalTokens / docCount : 0,
      };
    },

    async deletePages(ids) {
      let deleted = 0;
      let bytesFreed = 0;
      for (const id of ids) {
        const page = pages.get(id);
        if (!page) continue;
        dropPostings(page);
        pages.delete(id);
        byUrlKey.delete(page.urlKey);
        totalTokens -= page.wordCount || 0;
        bytesFreed += page.bytes || 0;
        deleted += 1;
      }
      return { deleted, bytesFreed };
    },

    async setPinned(id, pinned) {
      const page = pages.get(id);
      if (!page) return false;
      page.pinned = pinned ? 1 : 0;
      return true;
    },

    async listRecent(limit = 20) {
      return [...pages.values()].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, limit);
    },

    async listPageMeta() {
      return [...pages.values()].map((page) => ({
        id: page.id,
        domain: page.domain,
        lastSeen: page.lastSeen,
        firstSeen: page.firstSeen,
        bytes: page.bytes || 0,
        pinned: page.pinned || 0,
      }));
    },

    async logEviction(entry) {
      evictionLog.push({ id: evictionLog.length + 1, at: Date.now(), ...entry });
    },

    async readEvictionLog(limit = 20) {
      // Two entries written in the same millisecond need a tiebreaker, and
      // insertion order is the honest one. IndexedDB does this for free by
      // walking the primary key backwards, so this keeps the two stores
      // agreeing rather than passing by luck.
      return [...evictionLog]
        .sort((a, b) => (b.at === a.at ? b.id - a.id : b.at - a.at))
        .slice(0, limit);
    },

    close() {},
  };
}
