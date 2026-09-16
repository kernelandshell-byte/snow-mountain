// IndexedDB implementation of the store interface that core/index-reader
// consumes, and that db/memory-store implements in memory. Anything added
// here has to be added there too, or the tests stop meaning anything.
//
// Transaction discipline: every await in this file resolves from an
// IndexedDB request. Awaiting anything else, a timer or a fetch, lets the
// transaction auto commit underneath you and the rest of the writes vanish.

import { DB_NAME, DB_VERSION, createStores, pageRecordBytes } from './schema.js';
import { MIGRATIONS, runMigrations, checkVersions } from './migrations.js';
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

const req = (request) =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const txDone = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });

// All buckets for one term. Arrays sort after numbers in IndexedDB key
// order, so [term, []] is an upper bound above every [term, <number>].
const termRange = (term) => IDBKeyRange.bound([term], [term, []]);

// Every bucket of every term starting with a prefix. The postings key is
// [term, bucket] and IndexedDB keeps it ordered, so this is a range scan
// rather than a search: prefix + \uffff sorts above every real word that
// starts with the prefix and below the next word that does not.
const prefixRange = (prefix) => IDBKeyRange.bound([prefix], [prefix + '\uffff', []]);

async function upgrade(db, tx, oldVersion, newVersion, migrations) {
  // Version 1 has nothing to migrate from, so it only creates stores.
  if (oldVersion < 1) {
    createStores(db);
    await req(tx.objectStore('meta').put({ key: 'stats', docCount: 0, totalTokens: 0, totalBytes: 0 }));
    await req(tx.objectStore('meta').put({ key: 'schema', version: newVersion, createdAt: Date.now() }));
    return [];
  }

  // Everything from here is the migration policy in migrations.js, and all of
  // it happens inside this one versionchange transaction so that a throw
  // leaves the old database exactly as it was.
  const applied = await runMigrations(db, tx, oldVersion, newVersion, migrations);
  const schema = (await req(tx.objectStore('meta').get('schema'))) || { key: 'schema' };
  await req(
    tx.objectStore('meta').put({
      ...schema,
      key: 'schema',
      version: newVersion,
      migratedAt: Date.now(),
      migratedFrom: oldVersion,
    })
  );
  return applied;
}

export function openDatabase({
  factory = globalThis.indexedDB,
  name = DB_NAME,
  version = DB_VERSION,
  onClosed = null,
  onMigrated = null,
  migrations = MIGRATIONS,
  blockedTimeoutMs = 10000,
} = {}) {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, version);
    let upgradeError = null;
    let applied = [];
    let blockedTimer = null;

    // "Blocked" is not a failure. It means another connection is still open,
    // and the open carries on by itself the moment that one goes away --
    // which includes the ordinary case of this extension's own handle, since
    // close() returns before the connection has actually gone. Rejecting here
    // turned an upgrade that would have worked into one that never ran.
    //
    // It only becomes a failure if the other connection never lets go, which
    // in practice is a second window sitting on an older build.
    const settle = (fn) => (value) => {
      clearTimeout(blockedTimer);
      fn(value);
    };
    const finish = settle(resolve);
    const fail = settle(reject);

    request.onupgradeneeded = (event) => {
      const tx = request.transaction;
      // An upgrade that fails must not leave a half migrated database behind,
      // so the abort is deliberate and the error is carried out to the caller
      // rather than being swallowed by an unhandled rejection in here.
      upgrade(request.result, tx, event.oldVersion, version, migrations).then(
        (result) => {
          applied = result;
        },
        (error) => {
          upgradeError = error;
          try {
            tx.abort();
          } catch {
            // Already gone, which is the outcome this wanted anyway.
          }
        }
      );
    };

    request.onsuccess = () => {
      const db = request.result;
      if (upgradeError) {
        db.close();
        return fail(upgradeError);
      }

      // Someone else wants to delete or upgrade this database, which is what
      // clearing site data looks like from in here. Holding the connection
      // open would block them, and holding onto it afterwards would leave
      // every later write failing against a dead handle.
      db.onversionchange = () => {
        db.close();
        if (onClosed) onClosed('versionchange');
      };
      db.onclose = () => {
        if (onClosed) onClosed('closed');
      };

      // The two version numbers have to agree before anything is read or
      // written, because a disagreement means an upgrade did not finish.
      const check = db.transaction('meta', 'readonly');
      const schemaRequest = check.objectStore('meta').get('schema');
      schemaRequest.onsuccess = () => {
        const stored = schemaRequest.result;
        const problem = checkVersions({
          dbVersion: db.version,
          metaVersion: stored && stored.version,
          expected: version,
        });
        if (problem) {
          db.close();
          return fail(new Error(problem));
        }
        if (applied.length && onMigrated) onMigrated(applied, { from: stored && stored.migratedFrom, to: db.version });
        finish(db);
      };
      schemaRequest.onerror = () => {
        db.close();
        fail(schemaRequest.error);
      };
    };

    request.onerror = () => {
      // A database written by a newer build reaches here as a VersionError.
      // Saying so plainly is the difference between "reinstall it" and
      // "your archive is gone".
      const error = upgradeError || request.error;
      if (error && error.name === 'VersionError') {
        return fail(
          new Error(
            'this archive was written by a newer version of the extension. ' +
            'Nothing has been changed. Updating the extension will open it again.'
          )
        );
      }
      fail(error);
    };

    request.onblocked = () => {
      clearTimeout(blockedTimer);
      blockedTimer = setTimeout(() => {
        fail(new Error(
          'another window still has this archive open, so it could not be upgraded. ' +
          'Nothing has been changed. Closing the other window and trying again will work.'
        ));
      }, blockedTimeoutMs);
    };
  });
}

export function createIdbStore(db) {
  const emptyStats = { key: 'stats', docCount: 0, totalTokens: 0, totalBytes: 0 };

  // Removing a document's postings needs to know which terms it had. Rather
  // than storing a term list on every page, which would cost roughly 40% on
  // top of the text, the terms are recomputed from the text we already keep.
  async function dropPostings(postings, page) {
    const tokens = tokenize((page.title || '') + '\n\n' + (page.text || ''));
    const bucket = bucketOf(page.id);
    const terms = [...new Set(tokens.map((t) => t.term))];

    // Every request is issued before any of them is awaited, so IndexedDB
    // pipelines them. Awaiting each read in turn costs one round trip per
    // term, and a normal article has well over a thousand of them.
    const records = await Promise.all(terms.map((term) => req(postings.get([term, bucket]))));

    const writes = [];
    for (let i = 0; i < terms.length; i++) {
      const record = records[i];
      if (!record) continue;
      const docs = removeDoc(record.docs, page.id);
      if (docs.length) writes.push(req(postings.put({ ...record, docs })));
      else writes.push(req(postings.delete([terms[i], bucket])));
    }
    await Promise.all(writes);
  }

  // Returns what this document added to the index, which is the other half of
  // its `bytes`. Counted from what was actually written rather than estimated:
  // a term that already had a record in this bucket costs one entry, and only
  // the document that creates the record pays for the record.
  async function writePostings(postings, id, tokens) {
    const bucket = bucketOf(id);
    const entries = [...buildPostings(tokens)];

    // Same pipelining as above: read everything, then write everything.
    const records = await Promise.all(entries.map(([term]) => req(postings.get([term, bucket]))));

    const writes = [];
    let bytes = 0;
    for (let i = 0; i < entries.length; i++) {
      const [term, entry] = entries[i];
      const existing = records[i];
      if (!existing) bytes += postingRecordBytes(term);
      bytes += postingEntryBytes(entry.pos.length);
      const record = existing || { term, bucket, docs: [] };
      record.docs = upsertDoc(record.docs, { id, tf: entry.tf, pos: entry.pos });
      writes.push(req(postings.put(record)));
    }
    await Promise.all(writes);
    return bytes;
  }

  return {
    async readTerm(term) {
      const tx = db.transaction('postings', 'readonly');
      const records = await req(tx.objectStore('postings').getAll(termRange(term)));
      const out = [];
      for (const record of records) out.push(...record.docs);
      out.sort((a, b) => a.id - b.id);
      return out;
    },

    // The words an unmatched query word could have meant. Returned per word
    // rather than merged, because the caller has to be able to say which ones
    // it used, and because a word nobody can see used is a search that lies
    // about what it did.
    //
    // Ordered by how many documents each word appears in, so a cap keeps the
    // words that are actually worth having rather than the alphabetically
    // luckiest. The scan is bounded separately from the result, because a
    // three letter prefix in a large archive can start thousands of words.
    async readTermsWithPrefix(prefix, { limit = PREFIX_EXPANSION_LIMIT, scan = PREFIX_SCAN_LIMIT } = {}) {
      if (!prefix) return [];
      const tx = db.transaction('postings', 'readonly');
      const byTerm = new Map();
      await new Promise((resolve, reject) => {
        const request = tx.objectStore('postings').openCursor(prefixRange(prefix));
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return resolve();
          const record = cursor.value;
          let docs = byTerm.get(record.term);
          if (!docs) {
            if (byTerm.size >= scan) return resolve();
            docs = [];
            byTerm.set(record.term, docs);
          }
          docs.push(...record.docs);
          cursor.continue();
        };
        request.onerror = () => reject(request.error);
      });
      return [...byTerm.entries()]
        .map(([term, docs]) => ({ term, docs: docs.sort((a, b) => a.id - b.id) }))
        .sort((a, b) => b.docs.length - a.docs.length || (a.term < b.term ? -1 : 1))
        .slice(0, limit);
    },

    async readDocs(ids) {
      const tx = db.transaction('pages', 'readonly');
      const store = tx.objectStore('pages');
      const rows = await Promise.all(ids.map((id) => req(store.get(id))));
      const out = new Map();
      for (const row of rows) if (row) out.set(row.id, row);
      return out;
    },

    async getPageByUrl(url) {
      const key = urlKey(url);
      if (!key) return null;
      const tx = db.transaction('pages', 'readonly');
      const page = await req(tx.objectStore('pages').index('urlKey').get(key));
      return page || null;
    },

    async readStats() {
      const tx = db.transaction('meta', 'readonly');
      const stats = (await req(tx.objectStore('meta').get('stats'))) || emptyStats;
      return {
        docCount: stats.docCount,
        totalTokens: stats.totalTokens,
        totalBytes: stats.totalBytes || 0,
        avgDocLength: stats.docCount ? stats.totalTokens / stats.docCount : 0,
      };
    },

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

      const tx = db.transaction(['pages', 'postings', 'meta'], 'readwrite');
      const pages = tx.objectStore('pages');
      const postings = tx.objectStore('postings');
      const meta = tx.objectStore('meta');

      const existing = await req(pages.index('urlKey').get(key));
      const stats = (await req(meta.get('stats'))) || { ...emptyStats };

      // Same page, same content: this is a revisit, not new material.
      if (existing && existing.contentHash === hash) {
        existing.lastSeen = lastSeen;
        existing.visitCount = (existing.visitCount || 0) + 1;
        await req(pages.put(existing));
        await txDone(tx);
        return { id: existing.id, created: false, reindexed: false };
      }

      if (existing) {
        await dropPostings(postings, existing);
        stats.totalTokens -= existing.wordCount || 0;
        stats.totalBytes = (stats.totalBytes || 0) - (existing.bytes || 0);
      }

      const tokens = tokenize(title + '\n\n' + text);
      const record = {
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
        // The record itself now; its share of the index is added once the
        // postings have been written and it is known rather than guessed.
        bytes: 0,
        lang: null,
      };

      let id;
      if (existing) {
        record.id = existing.id;
        await req(pages.put(record));
        id = existing.id;
      } else {
        id = await req(pages.add(record));
        stats.docCount += 1;
      }

      record.bytes = pageRecordBytes(record, byteLength) + (await writePostings(postings, id, tokens));
      // The second write is what makes the budget honest: the page record now
      // carries what it really cost, index included.
      record.id = id;
      await req(pages.put(record));

      stats.totalTokens += tokens.length;
      stats.totalBytes = (stats.totalBytes || 0) + record.bytes;
      await req(meta.put(stats));
      await txDone(tx);

      return { id, created: !existing, reindexed: !!existing };
    },

    // Split across transactions, and not as an optimisation.
    //
    // Manifest V3 stops the worker whenever it likes. A single transaction
    // covering a few thousand pages holds a write lock for over a minute, and
    // an interrupted one rolls all of it back, so an archive too far over its
    // cap to sweep inside the worker's lifetime would retry and roll back for
    // ever and achieve nothing. Small transactions keep whatever finished.
    //
    // The pause between them is the other half. IndexedDB starts transactions
    // in creation order, and a sweep that never yields creates its next batch
    // before a waiting search has created anything. See DELETE_BATCH.
    async deletePages(ids, { batch = DELETE_BATCH, signal = null } = {}) {
      if (!ids.length) return { deleted: 0, bytesFreed: 0 };

      let deleted = 0;
      let bytesFreed = 0;

      for (let start = 0; start < ids.length; start += batch) {
        if (signal && signal.aborted) break;
        const slice = ids.slice(start, start + batch);

        const tx = db.transaction(['pages', 'postings', 'meta'], 'readwrite');
        const pages = tx.objectStore('pages');
        const postings = tx.objectStore('postings');
        const meta = tx.objectStore('meta');
        const stats = (await req(meta.get('stats'))) || { ...emptyStats };

        let touched = false;
        for (const id of slice) {
          const page = await req(pages.get(id));
          if (!page) continue;
          await dropPostings(postings, page);
          await req(pages.delete(id));
          stats.docCount -= 1;
          stats.totalTokens -= page.wordCount || 0;
          stats.totalBytes = (stats.totalBytes || 0) - (page.bytes || 0);
          bytesFreed += page.bytes || 0;
          deleted += 1;
          touched = true;
        }
        if (touched) await req(meta.put(stats));
        await txDone(tx);

        // Outside the transaction, which is the point: it has committed, and
        // anything queued behind it now gets its turn.
        if (start + batch < ids.length) await new Promise((resolve) => setTimeout(resolve, 0));
      }

      return { deleted, bytesFreed };
    },

    // The sweep's read. Only the oldest pages can be evicted by either rule,
    // so those are the only ones worth reading, and when nothing is over the
    // size cap `before` narrows it further to pages past the retention cutoff
    // -- which on almost every hourly run means reading nothing at all.
    async oldestPages(limit = 500, before = null) {
      const tx = db.transaction('pages', 'readonly');
      const index = tx.objectStore('pages').index('lastSeen');
      const range = before === null ? null : IDBKeyRange.upperBound(before, true);
      const out = [];
      await new Promise((resolve, reject) => {
        const request = index.openCursor(range);
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor || out.length >= limit) return resolve();
          const value = cursor.value;
          out.push({
            id: value.id,
            domain: value.domain,
            lastSeen: value.lastSeen,
            firstSeen: value.firstSeen,
            bytes: value.bytes || 0,
            pinned: value.pinned || 0,
          });
          cursor.continue();
        };
        request.onerror = () => reject(request.error);
      });
      return out;
    },

    async setPinned(id, pinned) {
      const tx = db.transaction('pages', 'readwrite');
      const pages = tx.objectStore('pages');
      const page = await req(pages.get(id));
      if (!page) {
        await txDone(tx);
        return false;
      }
      page.pinned = pinned ? 1 : 0;
      await req(pages.put(page));
      await txDone(tx);
      return true;
    },

    async listRecent(limit = 20) {
      const tx = db.transaction('pages', 'readonly');
      const index = tx.objectStore('pages').index('lastSeen');
      const out = [];
      await new Promise((resolve, reject) => {
        const cursorRequest = index.openCursor(null, 'prev');
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor || out.length >= limit) return resolve();
          out.push(cursor.value);
          cursor.continue();
        };
        cursorRequest.onerror = () => reject(cursorRequest.error);
      });
      return out;
    },

    // One cursor step on an index, rather than reading every page, because
    // this is on the path that opens the popup.
    async oldestFirstSeen() {
      const tx = db.transaction('pages', 'readonly');
      const index = tx.objectStore('pages').index('firstSeen');
      return new Promise((resolve, reject) => {
        const request = index.openCursor();
        request.onsuccess = () => resolve(request.result ? request.result.value.firstSeen : null);
        request.onerror = () => reject(request.error);
      });
    },

    // Deliberately lightweight: the eviction planner needs four fields per
    // page, and reading whole records including their text would mean
    // loading the entire corpus into memory to decide what to drop.
    async listPageMeta() {
      const tx = db.transaction('pages', 'readonly');
      const out = [];
      await new Promise((resolve, reject) => {
        const request = tx.objectStore('pages').openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return resolve();
          const value = cursor.value;
          out.push({
            id: value.id,
            domain: value.domain,
            lastSeen: value.lastSeen,
            firstSeen: value.firstSeen,
            bytes: value.bytes || 0,
            pinned: value.pinned || 0,
          });
          cursor.continue();
        };
        request.onerror = () => reject(request.error);
      });
      return out;
    },

    // Written as each round commits, so an interrupted sweep has still said
    // what it removed. `merge` folds consecutive rounds of the same sweep into
    // the row they started, because one sweep is one event to the person
    // reading the log, and twenty rows of it would push a year of history out
    // of a list that shows fifteen.
    // Ids only, straight off an index. "Never keep this site" and "forget this
    // day" are one-off actions, but they run from the popup while somebody
    // waits, and reading every page record to filter on one field would make
    // them scale with the whole archive rather than with what is being
    // removed.
    async pageIdsByDomain(domain) {
      const tx = db.transaction('pages', 'readonly');
      return req(tx.objectStore('pages').index('domain').getAllKeys(IDBKeyRange.only(domain)));
    },

    async pageIdsBetween(from, to) {
      const tx = db.transaction('pages', 'readonly');
      return req(tx.objectStore('pages').index('lastSeen').getAllKeys(IDBKeyRange.bound(from, to, false, true)));
    },

    // Export walks the archive by primary key a page at a time, because the
    // alternative is one message and one string holding every page of text at
    // once. At fourteen kilobytes a page a full archive is well past what
    // either will carry.
    async listPagesFrom(afterId = 0, limit = 100) {
      const tx = db.transaction('pages', 'readonly');
      const range = afterId > 0 ? IDBKeyRange.lowerBound(afterId, true) : null;
      const out = [];
      await new Promise((resolve, reject) => {
        const request = tx.objectStore('pages').openCursor(range);
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor || out.length >= limit) return resolve();
          out.push(cursor.value);
          cursor.continue();
        };
        request.onerror = () => reject(request.error);
      });
      return out;
    },

    async logEviction(entry, { merge = false, now = Date.now() } = {}) {
      const tx = db.transaction('evictionLog', 'readwrite');
      const log = tx.objectStore('evictionLog');

      if (merge) {
        const newest = await new Promise((resolve, reject) => {
          const request = log.index('at').openCursor(null, 'prev');
          request.onsuccess = () => resolve(request.result ? request.result.value : null);
          request.onerror = () => reject(request.error);
        });
        if (
          newest &&
          newest.reason === entry.reason &&
          now - newest.at < EVICTION_LOG_MERGE_MS
        ) {
          const merged = {
            ...newest,
            at: now,
            count: (newest.count || 0) + (entry.count || 0),
            bytesFreed: (newest.bytesFreed || 0) + (entry.bytesFreed || 0),
            counts: {
              age: ((newest.counts && newest.counts.age) || 0) + ((entry.counts && entry.counts.age) || 0),
              size: ((newest.counts && newest.counts.size) || 0) + ((entry.counts && entry.counts.size) || 0),
            },
            rounds: (newest.rounds || 1) + 1,
          };
          await req(log.put(merged));
          await txDone(tx);
          return merged;
        }
      }

      const row = { at: now, rounds: 1, ...entry };
      const id = await req(log.add(row));

      // Trimmed from the oldest end, and only ever by whole rows, so what the
      // log does say stays true. Nothing else in this extension deletes
      // without saying so; the log is the one place where the saying is the
      // thing being deleted, and it cannot grow for ever.
      const count = await req(log.count());
      if (count > EVICTION_LOG_MAX) {
        let excess = count - EVICTION_LOG_MAX;
        await new Promise((resolve, reject) => {
          const request = log.openCursor();
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor || excess <= 0) return resolve();
            cursor.delete();
            excess -= 1;
            cursor.continue();
          };
          request.onerror = () => reject(request.error);
        });
      }

      await txDone(tx);
      return { id, ...row };
    },

    async readEvictionLog(limit = 20) {
      const tx = db.transaction('evictionLog', 'readonly');
      const index = tx.objectStore('evictionLog').index('at');
      const out = [];
      await new Promise((resolve, reject) => {
        const request = index.openCursor(null, 'prev');
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor || out.length >= limit) return resolve();
          out.push(cursor.value);
          cursor.continue();
        };
        request.onerror = () => reject(request.error);
      });
      return out;
    },

    close() {
      db.close();
    },
  };
}

export async function openStore(options) {
  return createIdbStore(await openDatabase(options));
}

export function isClosedError(error) {
  const message = String((error && error.name) || '');
  return message === 'InvalidStateError' || message === 'TransactionInactiveError';
}

// Running out of disk is not a bug and not a transient hiccup, and it is the
// one storage failure a person can actually do something about. It has to be
// told apart from everything else so the extension can say so rather than
// quietly failing to keep pages.
export function isQuotaError(error) {
  const name = String((error && error.name) || '');
  const message = String((error && error.message) || '');
  return name === 'QuotaExceededError' || /quota/i.test(message);
}
