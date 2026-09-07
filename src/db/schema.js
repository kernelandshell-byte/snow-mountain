// Store definitions, kept as data so tests and documentation can read them
// without opening a database.
//
// Migration policy lives in migrations.js and is not optional reading:
// nothing is ever transformed in place, and an empty list must never be how
// a user learns that an upgrade failed.

import { DB_NAME, DB_VERSION } from '../shared/constants.js';

export { DB_NAME, DB_VERSION };

export const STORES = {
  pages: {
    keyPath: 'id',
    autoIncrement: true,
    indexes: [
      { name: 'urlKey', keyPath: 'urlKey', unique: true },
      { name: 'lastSeen', keyPath: 'lastSeen' },
      { name: 'firstSeen', keyPath: 'firstSeen' },
      { name: 'domain', keyPath: 'domain' },
      { name: 'pinned', keyPath: 'pinned' },
    ],
  },
  postings: {
    keyPath: ['term', 'bucket'],
    autoIncrement: false,
    indexes: [{ name: 'term', keyPath: 'term' }],
  },
  meta: { keyPath: 'key', autoIncrement: false, indexes: [] },
  evictionLog: {
    keyPath: 'id',
    autoIncrement: true,
    indexes: [{ name: 'at', keyPath: 'at' }],
  },
};

// Shape of a row in `pages`. Written down because several modules depend on
// these field names and guessing them later is how drift starts.
export const PAGE_FIELDS = [
  'id', 'url', 'urlKey', 'title', 'domain', 'text', 'excerpt',
  'wordCount', 'contentHash', 'firstSeen', 'lastSeen', 'visitCount',
  'pinned', 'bytes', 'lang',
];

export function createStores(db) {
  for (const [name, spec] of Object.entries(STORES)) {
    if (db.objectStoreNames.contains(name)) continue;
    const store = db.createObjectStore(name, {
      keyPath: spec.keyPath,
      autoIncrement: spec.autoIncrement,
    });
    for (const idx of spec.indexes) {
      store.createIndex(idx.name, idx.keyPath, { unique: !!idx.unique });
    }
  }
}
