// The deliberate, one-off things somebody does to their own archive: allowing
// a site, blocking one, exporting, importing, forgetting and wiping.
//
// All of them are irreversible except the first two, so none of them guesses,
// and every one that deletes leaves a row in the storage log.

import { EXPORT_FORMAT, MAX_TEXT_BYTES } from '../shared/constants.js';
import { truncateUtf8 } from '../shared/format.js';
import { loadSettings, updateSettings, saveSettings, SETTINGS_DEFAULTS } from '../shared/settings.js';
import { MODE } from '../core/capture-policy.js';
import { PRESETS, rulesFor } from '../shared/presets.js';
import { excludedIds, decide } from '../core/capture-policy.js';
import { urlKey } from '../core/url-key.js';
import { getStore } from './store-handle.js';
import { syncContentScripts } from './content-scripts.js';

// The popup hands over a hostname. Anything else is not a site to allow or
// block, and saving it would only add a rule that matches nothing.
const isHost = (value) => typeof value === 'string' && /^[a-z0-9][a-z0-9.-]*$/i.test(value);

export async function allowSite(domain) {
  if (!isHost(domain)) return loadSettings();
  const next = await updateSettings((current) =>
    current.allowlist.includes(domain) ? {} : { allowlist: [...current.allowlist, domain] });
  await syncContentScripts();
  return next;
}

// Blocking a site is not only about the future. Leaving what was already
// captured in place would make the button a lie, and so would keeping
// Chrome's access to a site in strict mode after being told never to read it.
//
// `dryRun` counts what would be removed, so the button can say so before it
// does something that cannot be undone.
export async function blockSite(domain, { dryRun = false } = {}) {
  if (!isHost(domain)) return { removed: 0 };
  if (dryRun) {
    const store = await getStore();
    return { wouldRemove: (await store.pageIdsForSite(domain)).length };
  }
  const before = await loadSettings();
  await updateSettings((current) => ({
    customRules: current.customRules.includes(domain)
      ? current.customRules
      : [...current.customRules, domain],
    allowlist: current.allowlist.filter((entry) => entry !== domain),
  }));
  await syncContentScripts();
  // Only access that was granted for this entry: blocking news.example.com
  // must not reach for a grant that belongs to an allowlisted example.com.
  if (before.mode === MODE.STRICT && before.allowlist.includes(domain)) {
    await chrome.permissions
      .remove({ origins: ['*://' + domain + '/*', '*://*.' + domain + '/*'] })
      .catch(() => false);
  }

  const store = await getStore();
  // The rule covers the site and everything under it, so what is removed
  // has to as well: blocking example.com takes news.example.com with it.
  const ids = await store.pageIdsForSite(domain);
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

// Turning on an exclusion is not only about the future either, for the same
// reason as blocking a site: a category ticked in settings, or an update
// that fixed a list, would otherwise leave behind exactly the pages it now
// promises to skip.
//
// Only rules that are actually in force can delete anything, so the caller
// names which of them to apply rather than handing over patterns:
//   { scope: 'preset', name }  one category, if it is turned on
//   { scope: 'custom' }        the rules somebody wrote themselves
//   { scope: 'shipped' }       every category that is on, plus addresses that
//                              carry a key; what an update re-applies
// `dryRun` counts without deleting, so settings can ask before removing
// pages that a half typed custom rule happens to match.
// `keepExisting` answers the question a new category asks in settings the
// other way: apply it from now on, and leave what was kept before alone --
// for good, including through later updates.
export async function removeExcluded({ scope, name, dryRun = false, keepExisting = false } = {}) {
  const settings = await loadSettings();
  let rules = [];
  let secrets = false;
  let marking = [];
  if (scope === 'preset') {
    rules = settings.presets[name] && PRESETS[name] ? PRESETS[name] : [];
    marking = rules;
  } else if (scope === 'custom') {
    rules = settings.customRules;
  } else if (scope === 'shipped') {
    // What an update applies to the past: new entries in categories that
    // were already on, and the key check. Not a category that is itself new
    // in this version -- nobody chose that one, so what it would remove from
    // before is offered in settings instead of taken. And not an entry that
    // has been applied before, so choosing to keep pages is not undone by
    // the next update.
    const { appliedRules, newCategories } = await chrome.storage.local
      .get(['appliedRules', 'newCategories'])
      .catch(() => ({}));
    const skip = new Set(Array.isArray(newCategories) ? newCategories : []);
    const applied = new Set(Array.isArray(appliedRules) ? appliedRules : []);
    const enabled = Object.fromEntries(Object.entries(settings.presets).filter(([key]) => !skip.has(key)));
    const inForce = rulesFor(enabled, []);
    rules = inForce.filter((rule) => !applied.has(rule));
    marking = inForce;
    secrets = true;
  }
  if (keepExisting && scope === 'preset' && PRESETS[name]) {
    await markApplied(PRESETS[name], name);
    return { matched: 0, removed: 0, kept: true };
  }
  if (!rules.length && !secrets) return { matched: 0, removed: 0 };

  const store = await getStore();
  // A rule needs only the address. The whole record, text included, is read
  // only for the update sweep, whose key check has to see the fragment too
  // (an #access_token=), which the normalised address drops.
  const rows = secrets
    ? await store.listPageMeta()
    : (await store.listPageKeys()).map((row) => ({ id: row.id, url: row.urlKey }));
  const ids = excludedIds(rows, rules, { secrets });
  if (dryRun) return { matched: ids.length, removed: 0 };

  const result = ids.length ? await store.deletePages(ids) : { deleted: 0, bytesFreed: 0 };
  if (result.deleted) {
    await store.logEviction({
      reason: 'siteRule',
      count: result.deleted,
      bytesFreed: result.bytesFreed,
    });
  }
  await markApplied(marking, scope === 'preset' ? name : null);
  return { matched: ids.length, removed: result.deleted };
}

// Which shipped rules have been applied to what is already kept, so an
// update only applies what is new, and which new categories still have an
// open question in settings.
async function markApplied(rules, settledCategory) {
  if (!rules.length && !settledCategory) return;
  const { appliedRules, newCategories } = await chrome.storage.local
    .get(['appliedRules', 'newCategories'])
    .catch(() => ({}));
  const next = { appliedRules: [...new Set([...(Array.isArray(appliedRules) ? appliedRules : []), ...rules])] };
  if (settledCategory && Array.isArray(newCategories)) {
    next.newCategories = newCategories.filter((key) => key !== settledCategory);
  }
  await chrome.storage.local.set(next).catch(() => {});
}

// Called on update, before anything is applied: categories that did not
// exist in the version being updated from. They are on from now on, for what
// is read next, which is the cautious default; what they cover from before
// waits for an answer in settings.
export async function noteNewCategories() {
  const stored = await chrome.storage.local.get(['settings', 'newCategories']).catch(() => ({}));
  const raw = stored && stored.settings;
  if (!raw || typeof raw !== 'object' || !raw.presets || typeof raw.presets !== 'object') return [];
  const added = Object.keys(SETTINGS_DEFAULTS.presets).filter((key) => !(key in raw.presets));
  if (!added.length) return [];
  const known = Array.isArray(stored.newCategories) ? stored.newCategories : [];
  await chrome.storage.local.set({ newCategories: [...new Set([...known, ...added])] });
  // Written out, so the next update does not see them as new again.
  await saveSettings({});
  return added;
}

// An update can fix a list, so the fixed lists are applied to what is
// already kept. Marked before it starts and cleared once it has finished,
// so a worker stopped part way through picks it up again next time rather
// than leaving it half done.
export async function removeExcludedIfPending() {
  const { exclusionSweepPending } = await chrome.storage.local
    .get('exclusionSweepPending')
    .catch(() => ({}));
  if (!exclusionSweepPending) return null;
  const result = await removeExcluded({ scope: 'shipped' });
  await chrome.storage.local.remove('exclusionSweepPending');
  return result;
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
  const settings = await loadSettings();
  const rules = rulesFor(settings.presets, settings.customRules);
  let imported = 0;
  let skipped = 0;
  let failed = 0;
  let excluded = 0;
  const now = Date.now();

  for (const page of Array.isArray(pages) ? pages : []) {
    // Not a web address at all is a page that could not be read, not one an
    // exclusion left out: saying "your exclusions cover it" would be wrong.
    if (!page || typeof page.url !== 'string' || !urlKey(page.url) ||
      typeof page.text !== 'string' || !page.text) {
      failed += 1;
      continue;
    }
    // An export from before a category was switched on, or before a site was
    // blocked, would otherwise bring back exactly what was since excluded.
    // The same exclusions and the same key check as a live capture; not the
    // mode or a pause, which are about reading, not about restoring.
    const verdict = decide({ url: page.url, rules });
    if (!verdict.capture) {
      excluded += 1;
      continue;
    }
    try {
      // An import file is not held to the same shape a real capture is: it
      // can come from a corrupted file, a much older export, or one somebody
      // never wrote themselves. The same cap capture.js enforces on the way
      // in applies here too, and a count that is not a genuine positive
      // integer is worth less than not trusting it at all. A date in the
      // future is what a wrong clock leaves behind, and would keep a page
      // out of reach of the age limit for ever.
      const text = truncateUtf8(page.text, MAX_TEXT_BYTES);
      const visitCount = Number.isInteger(page.visitCount) && page.visitCount > 0
        ? page.visitCount
        : null;
      const lastSeen = Math.min(Date.parse(page.lastSeen) || now, now);
      // A page already kept is only replaced by a copy read more recently.
      // Restoring last month's backup must not put last month's text over
      // what was read since, nor count a visit that never happened.
      const existing = await store.getPageByUrl(page.url);
      if (existing && (existing.lastSeen || 0) >= lastSeen) {
        skipped += 1;
        continue;
      }
      const firstSeenRaw = Date.parse(page.firstSeen);
      const firstSeen = Number.isFinite(firstSeenRaw) ? Math.min(firstSeenRaw, lastSeen) : null;
      const result = await store.putPage({
        url: page.url,
        title: typeof page.title === 'string' ? page.title.slice(0, 1000) : '',
        text,
        lastSeen,
        firstSeen,
        visitCount,
        pinned: page.pinned === true,
      });
      // Already there, unchanged: importing the same archive twice should
      // not look like it did something.
      if (!result.created && !result.reindexed) skipped += 1;
      else imported += 1;
    } catch {
      failed += 1;
    }
  }
  return { imported, skipped, failed, excluded };
}

// This is the one irreversible button in the interface, and it has to finish
// rather than be stopped part way through by a worker Chrome decided had run
// too long. Deleting page by page took about 7ms a page, so four minutes for a
// 500MB archive and a quarter of an hour for 2GB, past the five minutes Chrome
// allows one request. Clearing the stores takes the same time at any size.
export async function wipeEverything() {
  const store = await getStore();
  const { deleted, bytesFreed } = await store.deleteAll();
  await store.logEviction({ reason: 'manual', count: deleted, bytesFreed });
  return { deleted, bytesFreed };
}

// Forgetting is deleting, and nothing is deleted without a row in the
// storage log -- that promise is on the settings screen.
export async function forget(payload) {
  const store = await getStore();
  let ids = [];
  if (payload.scope === 'page') {
    ids = [payload.id];
  } else if (payload.scope === 'site') {
    ids = await store.pageIdsForSite(payload.value);
  } else if (payload.scope === 'day') {
    // A calendar day, not 24 hours: the day the clocks change is 23 or 25.
    // A bare "2026-09-23" is read by Date as midnight UTC, which west of
    // Greenwich is still the day before, so it is taken as a local date.
    const plainDate = typeof payload.value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(payload.value);
    const day = plainDate ? new Date(payload.value + 'T00:00') : new Date(payload.value);
    const from = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
    const to = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
    ids = Number.isFinite(from) ? await store.pageIdsBetween(from, to) : [];
  }
  const result = ids.length ? await store.deletePages(ids) : { deleted: 0, bytesFreed: 0 };
  if (result.deleted) {
    await store.logEviction({ reason: 'manual', count: result.deleted, bytesFreed: result.bytesFreed });
  }
  return result;
}
