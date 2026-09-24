// The storage budget: the hourly sweep that applies it, and the numbers the
// interface shows about it.
//
// These belong together because they are two views of one thing. The sweep
// decides what the archive is allowed to hold; the statistics say where it has
// got to, and both have to tell the same story or the meter is a lie.

import { EVICTION_SCAN, DELETE_BATCH, MAX_SWEEP_MS } from '../shared/constants.js';
import {
  planEviction, budgetStatus, projectExhaustion, paceFrom, retentionCutoff, clockHold,
} from '../core/eviction.js';
import {
  loadSettings, isPaused, loadSweepState, saveSweepState,
} from '../shared/settings.js';
import { getStore } from './store-handle.js';
import { refreshBadge } from './badge.js';

export async function collectStats() {
  const settings = await loadSettings();
  const sweepState = await loadSweepState();
  const local = await chrome.storage.local
    .get(['persistence', 'storageFull', 'lastMigration', 'contentScripts', 'newCategories'])
    .catch(() => ({}));

  // Settings survive a database that does not, so the parts of the answer
  // that come from settings are worth giving even when the archive is gone.
  const base = {
    paused: isPaused(settings),
    mode: settings.mode,
    setupComplete: settings.setupComplete,
    sizeCapBytes: settings.sizeCapBytes,
    retentionMonths: settings.retentionMonths,
    // Two things the interface has to be able to say plainly, because both
    // mean pages are not being kept and neither is visible any other way.
    persisted: local.persistence ? local.persistence.granted !== false : null,
    storageFull: local.storageFull ? local.storageFull.at : null,
    lastMigration: local.lastMigration || null,
    // Which sites the extension is actually watching, so a site that quietly
    // stopped being captured can be said out loud rather than discovered a
    // month later by its absence.
    captureWatch: local.contentScripts || null,
    // Categories new in this version whose effect on what was already kept
    // is waiting on an answer in settings.
    newCategories: Array.isArray(local.newCategories) ? local.newCategories : [],
  };

  // An archive that cannot be opened must never be described as an empty one.
  // "Nothing kept yet", after a year of use, is exactly how somebody decides
  // the extension is broken and throws away an archive that was fine.
  let store;
  try {
    store = await getStore();
  } catch (error) {
    return {
      ...base,
      ready: false,
      unavailable: 'the archive could not be opened',
      detail: String((error && error.message) || error),
    };
  }

  try {
    // Deliberately not listPageMeta: this runs every time the popup opens, and
    // summing bytes across every stored page would make that scale with the
    // size of the archive.
    const [stats, oldestFirstSeen, log] = await Promise.all([
      store.readStats(),
      store.oldestFirstSeen(),
      store.readEvictionLog(5),
    ]);

    const usedBytes = stats.totalBytes;
    const budget = budgetStatus({
      usedBytes,
      sizeCapBytes: settings.sizeCapBytes,
      warnAtFraction: settings.warnAtFraction || 0.8,
    });
    const pace = paceFrom({ totalBytes: usedBytes, oldestFirstSeen });
    const exhaustsAt = projectExhaustion({
      usedBytes,
      sizeCapBytes: settings.sizeCapBytes,
      bytesPerDay: pace.bytesPerDay,
    });

    return {
      ...base,
      ready: true,
      docCount: stats.docCount,
      usedBytes,
      budget,
      pace,
      // An archive resting at its cap and replacing its oldest pages is doing
      // what it was told, so there is no date to give and nothing to warn
      // about. A cap that cannot be met is a different thing entirely.
      atCap: budget.level === 'over' && !sweepState.capUnmeetable,
      capUnmeetable: sweepState.capUnmeetable,
      clockProblem: sweepState.clockProblem || null,
      // Only worth showing once there is enough history to mean anything, and
      // never once the archive is simply full.
      exhaustsAt: pace.daysObserved >= 7 && budget.level !== 'over' ? exhaustsAt : null,
      recentEvictions: log,
    };
  } catch (error) {
    return {
      ...base,
      ready: false,
      unavailable: 'the archive could not be read',
      detail: String((error && error.message) || error),
    };
  }
}

// The storage sweep.
//
// Written as rounds rather than one pass, for three separate reasons that all
// turned up under test at four and ten thousand pages.
//
// It reads only what it might delete. Only the oldest pages can be evicted by
// either rule, so a round reads the oldest EVICTION_SCAN pages by lastSeen,
// and when nothing is over the size cap, only those past the retention
// cutoff. With nothing expired and nothing over the cap it reads nothing at
// all, which is what almost every hourly run should cost.
//
// It deletes a page at a time, and lets go between them. Both of those live
// in the store; see DELETE_BATCH for the numbers behind them.
export async function runMaintenance() {
  const now = Date.now();
  const settings = await loadSettings();
  const sweepState = await loadSweepState();

  let store;
  try {
    store = await getStore();
  } catch (error) {
    // Nothing can be swept against an archive that will not open, and
    // guessing is how data gets deleted. Do nothing and say so.
    return { evicted: 0, unavailable: true, detail: String((error && error.message) || error) };
  }

  // A clock that comes back from sleep set to next year makes every page look
  // expired. The age rule is suspended for this run rather than being allowed
  // to delete a year of reading with no way back, and stays suspended for a
  // day so a clock that is still wrong an hour later cannot do it either; the
  // size rule needs no clock and carries on.
  const { problem: clockProblem, holdUntil: clockHoldUntil } = clockHold({
    now,
    lastSweepAt: sweepState.lastSweepAt,
    holdUntil: sweepState.clockHoldUntil,
    lastProblem: sweepState.clockProblem,
  });

  const deadline = now + MAX_SWEEP_MS;
  let evicted = 0;
  let bytesFreed = 0;
  let rounds = 0;
  let reason = null;
  let unmeetable = false;
  let ranOut = false;

  while (true) {
    if (Date.now() >= deadline) {
      ranOut = true;
      break;
    }

    const stats = await store.readStats();
    const overCap = stats.totalBytes > settings.sizeCapBytes;
    const cutoff = clockProblem ? null : retentionCutoff(now, settings.retentionMonths);

    // Nothing over the cap and no age rule to apply: there is nothing this
    // sweep could possibly remove, so it reads nothing.
    if (!overCap && cutoff === null) break;

    // Pinned pages are skipped by the read itself, not after it. They are
    // never removed, so they gather at the old end of the archive, and a
    // slice that was all pinned pages used to end the sweep while every
    // expired page behind them waited for ever.
    const slice = await store.oldestPages(EVICTION_SCAN, overCap ? null : cutoff, { skipPinned: true });
    if (!slice.length) {
      // Nothing left that could be removed. Still over the cap means more
      // is pinned than fits, which is the one budget state worth a warning.
      unmeetable = overCap;
      break;
    }

    const plan = planEviction({
      pages: slice,
      totalBytes: stats.totalBytes,
      now,
      retentionMonths: settings.retentionMonths,
      sizeCapBytes: settings.sizeCapBytes,
      applyAge: !clockProblem,
    });

    if (!plan.ids.length) {
      unmeetable = overCap;
      break;
    }

    const result = await store.deletePages(plan.ids, { batch: DELETE_BATCH });
    evicted += result.deleted;
    bytesFreed += result.bytesFreed;
    reason = plan.reason;
    rounds += 1;

    // Nothing is ever removed without a record of it, and the record is
    // written as each round commits, so an interrupted sweep has still said
    // what it removed. Consecutive rounds merge into one row, because one
    // sweep is one event to the person reading the log.
    await store.logEviction(
      {
        reason: plan.reason,
        count: result.deleted,
        bytesFreed: result.bytesFreed,
        counts: plan.counts,
      },
      { merge: true }
    );

    if (!result.deleted) break;
  }

  await saveSweepState({
    lastSweepAt: now,
    capUnmeetable: unmeetable,
    clockProblem: clockProblem || null,
    clockHoldUntil,
  });

  // The badge is raised only for something that can be acted on; see badge.js.
  await refreshBadge().catch(() => {});

  return { evicted, bytesFreed, rounds, reason, unmeetable, clockProblem, more: ranOut };
}
