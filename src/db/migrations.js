// How the schema changes, and why it is written this way.
//
// A silent migration that loses the archive is the failure this file exists
// to make impossible, so the policy from ARCHITECTURE.md is code here rather
// than a paragraph somebody remembers:
//
//   1. The schema version lives in both the IndexedDB version and a `meta`
//      row, and they are checked against each other at startup.
//   2. An upgrade never transforms a store in place. It builds the new shape
//      alongside the old one.
//   3. The old shape goes only after a verification pass confirms the new one
//      holds the expected number of records and passes a sample check.
//   4. If anything throws, the old data is still there and the extension says
//      so. An empty list must never be how somebody learns a migration failed.
//   5. A database newer than the running code refuses to open rather than
//      being mangled by it.
//   6. After a successful migration, say once what happened.
//
// Points 2 to 4 come free from IndexedDB if, and only if, everything happens
// inside the one versionchange transaction: a throw aborts it, and an aborted
// versionchange transaction leaves the database exactly as it was, at its old
// version. So the rule for anything in this file is that every await resolves
// from a request belonging to `tx`. Await a timer, a fetch or an unrelated
// promise and the transaction commits underneath you, half done, which is the
// precise shape of the bug this is all here to prevent.

const request = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const SCRATCH = '__migrating';

// Copies a store through a scratch store and back, applying `transform` on the
// way out. The record count is checked at both ends, and a caller supplied
// `verify` gets a sample of the result before the old shape is given up.
export async function rebuildStore(db, tx, { name, spec, transform, verify }) {
  const source = tx.objectStore(name);
  const expected = await request(source.count());
  const rows = await request(source.getAll());

  if (rows.length !== expected) {
    throw new Error('migration read ' + rows.length + ' of ' + expected + ' records from ' + name);
  }

  // Build the new shape alongside the old one. Nothing has been given up yet.
  if (db.objectStoreNames.contains(SCRATCH)) db.deleteObjectStore(SCRATCH);
  const scratch = db.createObjectStore(SCRATCH, { keyPath: spec.keyPath, autoIncrement: false });

  const migrated = [];
  for (const row of rows) {
    const next = transform ? transform(row) : row;
    if (next) migrated.push(next);
  }
  if (migrated.length !== rows.length) {
    throw new Error('migration would lose ' + (rows.length - migrated.length) + ' records from ' + name);
  }
  for (const row of migrated) await request(scratch.add(row));

  const staged = await request(scratch.count());
  if (staged !== expected) {
    throw new Error('migration staged ' + staged + ' of ' + expected + ' records for ' + name);
  }
  if (verify) await verify(migrated.slice(0, 20));

  // Only now is the old shape given up, and even this is still inside the one
  // transaction that a throw would roll back.
  db.deleteObjectStore(name);
  const rebuilt = db.createObjectStore(name, {
    keyPath: spec.keyPath,
    autoIncrement: spec.autoIncrement,
  });
  for (const index of spec.indexes) {
    rebuilt.createIndex(index.name, index.keyPath, { unique: !!index.unique });
  }
  for (const row of migrated) await request(rebuilt.add(row));

  const restored = await request(rebuilt.count());
  if (restored !== expected) {
    throw new Error('migration restored ' + restored + ' of ' + expected + ' records to ' + name);
  }

  db.deleteObjectStore(SCRATCH);
  return { name, records: restored };
}

// Ordered, and applied in order for any gap between the stored version and the
// running one. There is only version 1 so far, so this list is empty and the
// machinery above is exercised by the migration suite rather than by a real
// schema change. That is deliberate: the day a second version exists is a bad
// day to find out whether any of this works.
export const MIGRATIONS = [];

export async function runMigrations(db, tx, oldVersion, newVersion, migrations = MIGRATIONS) {
  const applied = [];
  for (const migration of migrations) {
    if (migration.version <= oldVersion || migration.version > newVersion) continue;
    const result = await migration.run(db, tx, { rebuildStore, request });
    applied.push({ version: migration.version, describe: migration.describe, ...(result || {}) });
  }
  return applied;
}

// The two version numbers have to agree. A `meta` row saying one thing and an
// IndexedDB version saying another means an upgrade did not finish, and
// carrying on regardless is how an archive gets quietly mangled.
export function checkVersions({ dbVersion, metaVersion, expected }) {
  if (dbVersion > expected) {
    return (
      'this archive was written by a newer version of the extension (database ' +
      dbVersion + ', this build expects ' + expected + '). Nothing has been changed.'
    );
  }
  if (metaVersion && metaVersion !== dbVersion) {
    return (
      'this archive did not finish an upgrade (database says ' + dbVersion +
      ', its own record says ' + metaVersion + '). Nothing has been changed.'
    );
  }
  return null;
}
