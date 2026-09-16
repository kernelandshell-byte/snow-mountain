// In-memory reference implementation of the store interface.
//
// It exists so search can be exercised without a browser, and so the same
// contract suite can run against both implementations. Its semantics are the
// specification: if this and idb-store ever disagree, one of them is wrong,
// and the contract test is what says which.

import {
  DELETE_BATCH, EVICTION_LOG_MERGE_MS, EVICTION_LOG_MAX,
  PREFIX_EXPANSION_LIMIT, PREFIX_SCAN_LIMIT,
} from '../shared/constants.js';
import { tokenize } from '../core/tokenizer.js';
import {
  buildPostings, bucketOf, upsertDoc, removeDoc, postingEntryBytes, postingRecordBytes,
} from '../core/index-writer.js';
import { urlKey, domainOf } from '../core/url-key.js';
import { contentHash, byteLength } from '../core/hash.js';
import { pageRecordBytes } from './schema.js';

export function createMemoryStore() {
  const pages = new Map();
  const byUrlKey = new Map();
  const buckets = new Map();
  const evictionLog = [];
  let nextId = 1;
  let nextLogId = 1;
  let totalTokens = 0;
  let totalBytes = 0;

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

  // Returns what this document added to the index. Has to agree with
  // idb-store to the byte, or the contract stops meaning anything.
  function writePostings(id, tokens) {
    const bucket = bucketOf(id);
    let bytes = 0;
    for (const [term, entry] of buildPostings(tokens)) {
      const key = bucketKey(term, bucket);
      const existing = buckets.get(key);
      if (!existing) bytes += postingRecordBytes(term);
      bytes += postingEntryBytes(entry.pos.length);
      buckets.set(key, upsertDoc(existing || [], { id, tf: entry.tf, pos: entry.pos }));
    }
    return bytes;
  }

  return {
    // firstSeen, visitCount and pinned are overrides for import, which is
    // restoring history rather than recording a visit. Everything else
    // leaves them alone and lets the store maintain them.
    async putPage({
      url,
      title = '',
      text = '',
      lastSeen = Date.now(),
      pinned = false,
      firstSeen = null,
      visitCount = null,
    }) {
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
        totalBytes -= existing.bytes || 0;
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
        firstSeen: firstSeen || (existing ? existing.firstSeen : lastSeen),
        lastSeen,
        visitCount: visitCount || (existing ? (existing.visitCount || 0) + 1 : 1),
        pinned: existing ? existing.pinned : pinned ? 1 : 0,
        bytes: 0,
        lang: null,
      };

      pages.set(id, record);
      byUrlKey.set(key, id);
      record.bytes = pageRecordBytes(record, byteLength) + writePostings(id, tokens);
      totalTokens += tokens.length;
      totalBytes += record.bytes;

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

    // Same contract as idb-store: the words an unmatched query word could
    // have meant, per word, most widely used first. Bucket keys here are
    // "term bucket", so the term is everything before the last space.
    async readTermsWithPrefix(prefix, { limit = PREFIX_EXPANSION_LIMIT, scan = PREFIX_SCAN_LIMIT } = {}) {
      if (!prefix) return [];
      const byTerm = new Map();
      for (const [key, docs] of [...buckets.entries()].sort()) {
        const term = key.slice(0, key.lastIndexOf(' '));
        if (!term.startsWith(prefix)) continue;
        let into = byTerm.get(term);
        if (!into) {
          if (byTerm.size >= scan) break;
          into = [];
          byTerm.set(term, into);
        }
        into.push(...docs);
      }
      return [...byTerm.entries()]
        .map(([term, docs]) => ({ term, docs: docs.sort((a, b) => a.id - b.id) }))
        .sort((a, b) => b.docs.length - a.docs.length || (a.term < b.term ? -1 : 1))
        .slice(0, limit);
    },

    async readDocs(ids) {
      const out = new Map();
      for (const id of ids) if (pages.has(id)) out.set(id, pages.get(id));
      return out;
    },

    async getPageByUrl(url) {
      const key = urlKey(url);
      if (!key) return null;
      const id = byUrlKey.get(key);
      return id ? pages.get(id) : null;
    },

    async readStats() {
      const docCount = pages.size;
      return {
        docCount,
        totalTokens,
        totalBytes,
        avgDocLength: docCount ? totalTokens / docCount : 0,
      };
    },

    // The batching that matters in idb-store has nothing to do here, but the
    // signature has to match or the contract stops meaning anything.
    async deletePages(ids, { batch = DELETE_BATCH, signal = null } = {}) {
      let deleted = 0;
      let bytesFreed = 0;
      for (const id of ids) {
        if (signal && signal.aborted) break;
        const page = pages.get(id);
        if (!page) continue;
        dropPostings(page);
        pages.delete(id);
        byUrlKey.delete(page.urlKey);
        totalTokens -= page.wordCount || 0;
        totalBytes -= page.bytes || 0;
        bytesFreed += page.bytes || 0;
        deleted += 1;
      }
      return { deleted, bytesFreed };
    },

    // Only the oldest pages can be evicted by either rule, so the sweep reads
    // those and nothing else. `before` narrows it to the retention cutoff.
    async oldestPages(limit = 500, before = null) {
      return [...pages.values()]
        .filter((page) => (before === null ? true : page.lastSeen < before))
        .sort((a, b) => a.lastSeen - b.lastSeen)
        .slice(0, limit)
        .map((page) => ({
          id: page.id,
          domain: page.domain,
          lastSeen: page.lastSeen,
          firstSeen: page.firstSeen,
          bytes: page.bytes || 0,
          pinned: page.pinned || 0,
        }));
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

    async oldestFirstSeen() {
      let oldest = null;
      for (const page of pages.values()) {
        if (oldest === null || page.firstSeen < oldest) oldest = page.firstSeen;
      }
      return oldest;
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

    async pageIdsByDomain(domain) {
      return [...pages.values()].filter((page) => page.domain === domain).map((page) => page.id);
    },

    async pageIdsBetween(from, to) {
      return [...pages.values()]
        .filter((page) => page.lastSeen >= from && page.lastSeen < to)
        .map((page) => page.id);
    },

    async listPagesFrom(afterId = 0, limit = 100) {
      return [...pages.values()]
        .filter((page) => page.id > afterId)
        .sort((a, b) => a.id - b.id)
        .slice(0, limit);
    },

    async logEviction(entry, { merge = false, now = Date.now() } = {}) {
      if (merge && evictionLog.length) {
        const newest = evictionLog[evictionLog.length - 1];
        if (newest.reason === entry.reason && now - newest.at < EVICTION_LOG_MERGE_MS) {
          newest.at = now;
          newest.count = (newest.count || 0) + (entry.count || 0);
          newest.bytesFreed = (newest.bytesFreed || 0) + (entry.bytesFreed || 0);
          newest.counts = {
            age: ((newest.counts && newest.counts.age) || 0) + ((entry.counts && entry.counts.age) || 0),
            size: ((newest.counts && newest.counts.size) || 0) + ((entry.counts && entry.counts.size) || 0),
          };
          newest.rounds = (newest.rounds || 1) + 1;
          return newest;
        }
      }
      const row = { id: nextLogId++, at: now, rounds: 1, ...entry };
      evictionLog.push(row);
      if (evictionLog.length > EVICTION_LOG_MAX) {
        evictionLog.splice(0, evictionLog.length - EVICTION_LOG_MAX);
      }
      return row;
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
