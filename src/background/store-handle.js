// The one connection to the archive, and the rules for keeping it.
//
// Only this context writes to the database, and this is the only place the
// handle to it lives. The worker is stopped whenever Chrome decides it looks
// idle, so the handle is cached for the lifetime of one worker and no longer:
// when the worker restarts, this module is evaluated again and the connection
// is reopened.

import { openStore, isClosedError } from '../db/idb-store.js';

// Cached for the lifetime of this worker only, which is the point: when the
// worker is restarted the module is re-evaluated and the handle is reopened.
let storePromise = null;

export const getStore = () => {
  if (!storePromise) {
    storePromise = openStore({
      // Chrome closes the connection when the database is deleted or
      // upgraded elsewhere, which is what clearing site data looks like from
      // in here. Dropping the handle means the next call opens a fresh one
      // rather than failing forever against a dead one.
      onClosed: () => {
        storePromise = null;
      },
      // Point six of the migration policy: after a successful upgrade, say
      // once what happened. Kept in storage rather than announced from here,
      // because the worker that ran the migration is usually long gone by the
      // time anybody opens a page.
      onMigrated: (applied, versions) => {
        chrome.storage.local.set({
          lastMigration: {
            at: Date.now(),
            from: versions && versions.from,
            to: versions && versions.to,
            steps: applied.map((step) => step.describe || ('version ' + step.version)),
          },
        });
      },
    }).catch((error) => {
      // Never keep a rejected promise: one transient failure would
      // otherwise disable storage until the worker happened to restart.
      storePromise = null;
      throw error;
    });
  }
  return storePromise;
};

// Any operation can fail against a connection that has just gone away. One
// retry against a fresh handle turns that from a lost page into a hiccup.
export async function withStore(work) {
  try {
    return await work(await getStore());
  } catch (error) {
    if (!isClosedError(error)) throw error;
    storePromise = null;
    return work(await getStore());
  }
}
