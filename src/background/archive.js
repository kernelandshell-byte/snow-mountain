// The deliberate, one-off things somebody does to their own archive: allowing
// a site, blocking one, exporting, importing, forgetting and wiping.
//
// All of them are irreversible except the first two, so none of them guesses,
// and every one that deletes leaves a row in the storage log.

import { EXPORT_FORMAT, MAX_TEXT_BYTES } from '../shared/constants.js';
import { loadSettings, saveSettings } from '../shared/settings.js';
import { getStore } from './store-handle.js';
import { syncContentScripts } from './content-scripts.js';

export async function allowSite(domain) {
  const settings = await loadSettings();
  if (settings.allowlist.includes(domain)) return settings;
  const next = await saveSettings({ allowlist: [...settings.allowlist, domain] });
  await syncContentScripts();
  return next;
}

// Blocking a site is not only about the future. Leaving what was already
// captured in place would make the button a lie.
export async function blockSite(domain) {
  const settings = await loadSettings();
  const rules = settings.customRules.includes(domain)
    ? settings.customRules
    : [...settings.customRules, domain];
  await saveSettings({
    customRules: rules,
    allowlist: settings.allowlist.filter((entry) => entry !== domain),
  });
  await syncContentScripts();

  const store = await getStore();
  const ids = await store.pageIdsByDomain(domain);
  const result = ids.length ? await store.deletePages(ids) : { deleted: 0, bytesFreed: 0 };
  if (result.deleted) {
    await store.logEviction({
      reason: 'siteRule',
      count: result.deleted,
      bytesFreed: result.bytesFreed,
    });
  }
  return { removed: result.deleted };
}

// Export is handed out a slice at a time, keyed by the last id seen.
//
// The obvious version reads every page and returns one object. At fourteen
// kilobytes a page that is hundreds of megabytes in a single message and, once
// the receiving side calls JSON.stringify on it, in a single string as well.
// Neither survives a real archive, and the failure is an out of memory crash
// rather than an error anybody can act on.
export async function buildExport({ afterId = 0, limit = 200 } = {}) {
  const store = await getStore();
  const settings = await loadSettings();
  const [stats, rows] = await Promise.all([
    store.readStats(),
    store.listPagesFrom(afterId, limit),
  ]);

  return {
    format: EXPORT_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    total: stats.docCount,
    // Plain JSON with the full text, not an opaque blob. The point of an
    // export is that it is readable without this extension existing.
    settings: {
      mode: settings.mode,
      retentionMonths: settings.retentionMonths,
      sizeCapBytes: settings.sizeCapBytes,
      presets: settings.presets,
      customRules: settings.customRules,
    },
    pages: rows.map((page) => ({
      url: page.url,
      title: page.title,
      domain: page.domain,
      firstSeen: new Date(page.firstSeen).toISOString(),
      lastSeen: new Date(page.lastSeen).toISOString(),
      visitCount: page.visitCount,
      pinned: !!page.pinned,
      text: page.text,
    })),
    lastId: rows.length ? rows[rows.length - 1].id : null,
    done: rows.length < limit,
  };
}

// Import takes one batch at a time. The interface does the chunking, so a
// large archive reports progress instead of sitting silent for ten minutes,
// and no single message has to survive that long.
export async function importPages(pages) {
  const store = await getStore();
  let imported = 0;
  let skipped = 0;
  let failed = 0;

  for (const page of pages || []) {
    if (!page || !page.url || !page.text) {
      failed += 1;
      continue;
    }
    try {
      // An import file is not held to the same shape a real capture is: it
      // can come from a corrupted file, a much older export, or one somebody
      // never wrote themselves. The same cap capture.js enforces on the way
      // in applies here too, and a count that is not a genuine positive
      // integer is worth less than not trusting it at all.
      const text = String(page.text).slice(0, MAX_TEXT_BYTES);
      const visitCount = Number.isInteger(page.visitCount) && page.visitCount > 0
        ? page.visitCount
        : null;
      const result = await store.putPage({
        url: page.url,
        title: page.title || '',
        text,
        lastSeen: Date.parse(page.lastSeen) || Date.now(),
        firstSeen: Date.parse(page.firstSeen) || null,
        visitCount,
        pinned: !!page.pinned,
      });
      // Already there, unchanged: importing the same archive twice should
      // not look like it did something.
      if (!result.created && !result.reindexed) skipped += 1;
      else imported += 1;
    } catch {
      failed += 1;
    }
  }
  return { imported, skipped, failed };
}

// Deliberately not one pass over the whole archive. This is the one
// irreversible button in the interface, and it has to finish rather than be
// stopped part way through by a worker Chrome decided looked idle. Taking it a
// slice at a time means whatever it got through stays got through.
export async function wipeEverything() {
  const store = await getStore();
  let deleted = 0;
  let bytesFreed = 0;

  for (let guard = 0; guard < 10000; guard++) {
    const slice = await store.oldestPages(200);
    if (!slice.length) break;
    const result = await store.deletePages(slice.map((page) => page.id));
    deleted += result.deleted;
    bytesFreed += result.bytesFreed;
    if (!result.deleted) break;
  }

  await store.logEviction({ reason: 'manual', count: deleted, bytesFreed });
  return { deleted, bytesFreed };
}

export async function forget(payload) {
  const store = await getStore();
  if (payload.scope === 'page') {
    return store.deletePages([payload.id]);
  }
  let ids = [];
  if (payload.scope === 'site') {
    ids = await store.pageIdsByDomain(payload.value);
  } else if (payload.scope === 'day') {
    const from = new Date(payload.value).setHours(0, 0, 0, 0);
    ids = await store.pageIdsBetween(from, from + 86400000);
  }
  return store.deletePages(ids);
}
