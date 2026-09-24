// The storage budget, as pure functions.
//
// Two caps apply at once and whichever binds first wins: an age limit and a
// size limit. Pinned pages are never evicted by either, which is what makes
// the whole budget idea safe to accept: anything you care about, you keep.
//
// Nothing here deletes. It decides, and the caller writes an eviction log
// entry, because nothing should be removed without saying so.

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// A sweep that has to read the whole archive to decide it has nothing to do
// is a background problem rather than a background job, so the caller hands
// in a slice of the oldest pages and the archive's real total separately.
// Only the oldest pages can be evicted by either rule, and a slice cannot say
// how far over the cap things are.
export function planEviction({
  pages,
  totalBytes = null,
  now = Date.now(),
  retentionMonths = 12,
  sizeCapBytes = Infinity,
  // The age rule is the only one that needs a clock, so it is the only one
  // switched off when the clock cannot be trusted. See clockLooksWrong.
  applyAge = true,
}) {
  // Settings are normalised before they reach here, but this function decides
  // what gets deleted for ever. A retention of null once made the cutoff
  // "now" and expired an entire archive, so the guard lives here too.
  const months =
    Number.isFinite(retentionMonths) && retentionMonths > 0 ? retentionMonths : 12;
  const cap = Number.isFinite(sizeCapBytes) && sizeCapBytes > 0 ? sizeCapBytes : Infinity;

  const cutoff = applyAge ? now - months * MONTH_MS : -Infinity;
  const evict = [];
  let reasonAge = 0;

  const survivors = [];
  for (const page of pages) {
    if (page.pinned) continue;
    if (page.lastSeen < cutoff) {
      evict.push(page);
      reasonAge += 1;
    } else {
      survivors.push(page);
    }
  }

  let total = totalBytes;
  if (total === null || !Number.isFinite(total)) {
    total = 0;
    for (const page of pages) total += page.bytes || 0;
  }
  let freed = evict.reduce((sum, p) => sum + (p.bytes || 0), 0);

  // Oldest first, which is also least recently opened, since a revisit
  // updates lastSeen.
  survivors.sort((a, b) => a.lastSeen - b.lastSeen);
  let reasonSize = 0;
  for (const page of survivors) {
    if (total - freed <= cap) break;
    evict.push(page);
    freed += page.bytes || 0;
    reasonSize += 1;
  }

  let reason = null;
  if (reasonAge && reasonSize) reason = 'both';
  else if (reasonAge) reason = 'age';
  else if (reasonSize) reason = 'size';

  return {
    ids: evict.map((p) => p.id),
    bytesFreed: freed,
    reason,
    counts: { age: reasonAge, size: reasonSize },
    // True when this slice was entirely consumed, which is the signal that
    // there may be more to do and the sweep should read another one.
    exhaustedSlice: evict.length > 0 && evict.length === pages.length,
    // Whether anything in this slice could still be removed under the size
    // rule. Nothing evictable while still over the cap is the one budget
    // state worth warning about, and it means more is pinned than fits.
    sizePressureRemains: total - freed > cap,
  };
}

// The moment before which a page is past its retention limit. The sweep uses
// it to read only the pages the age rule could remove, rather than reading the
// archive to discover it has nothing to do.
export function retentionCutoff(now, retentionMonths) {
  const months = Number.isFinite(retentionMonths) && retentionMonths > 0 ? retentionMonths : 12;
  return now - months * MONTH_MS;
}

export function budgetStatus({ usedBytes, sizeCapBytes, warnAtFraction = 0.8 }) {
  const fraction = sizeCapBytes > 0 ? usedBytes / sizeCapBytes : 0;
  let level = 'ok';
  if (fraction >= 1) level = 'over';
  else if (fraction >= warnAtFraction) level = 'warn';
  return { fraction, level, usedBytes, sizeCapBytes };
}

// The mobile data plan part: once there are a few weeks of history, the
// budget can be expressed as a date rather than a percentage, which is the
// only form anyone can act on.
export function projectExhaustion({ usedBytes, sizeCapBytes, bytesPerDay, now = Date.now() }) {
  if (!bytesPerDay || bytesPerDay <= 0 || !Number.isFinite(bytesPerDay)) return null;
  const remaining = sizeCapBytes - usedBytes;
  if (remaining <= 0) return now;
  const days = remaining / bytesPerDay;
  if (days > 3650) return null;
  return now + days * DAY_MS;
}

// Takes totals rather than a list of pages, so the interface can ask for
// this without the store reading every record it has.
export function paceFrom({ totalBytes = 0, oldestFirstSeen = null }, now = Date.now()) {
  const unknown = { bytesPerDay: 0, daysObserved: 0 };
  if (!totalBytes || !oldestFirstSeen || !Number.isFinite(oldestFirstSeen)) return unknown;
  // A page dated in the future is what a wrong clock leaves behind. Dividing
  // by the resulting negative span would report a pace of the whole archive
  // per day and a budget that runs out tomorrow.
  if (oldestFirstSeen > now) return unknown;
  const days = (now - oldestFirstSeen) / DAY_MS;
  if (days < 1) return unknown;
  return { bytesPerDay: totalBytes / days, daysObserved: Math.round(days) };
}

// A clock that comes back from sleep set to next year makes every page look
// expired, and an hourly sweep would then delete a year of reading in one go
// with no way back. The archive cannot tell the time any better than the
// machine can, but it can notice that time has moved in a way an hourly alarm
// cannot explain, and decline to act on the age rule until the clock has had
// time to put itself right; see clockHold below.
//
// The size rule needs no clock and carries on regardless. A machine that was
// genuinely switched off for a month pays a day of delay for this.
export const CLOCK_JUMP_MS = 7 * DAY_MS;

// How long the age rule stays off after a jump. Declining for one sweep was
// not enough: that sweep recorded the wrong time as its own, the next one an
// hour later saw nothing odd, and a clock still set to next year deleted a
// year of reading an hour late. A day is long enough for a network time sync,
// or for somebody to notice every site's certificate failing and fix the
// clock, and a correction back is itself a jump that starts a fresh hold.
export const CLOCK_HOLD_MS = DAY_MS;

export function clockLooksWrong({ now = Date.now(), lastSweepAt = 0 } = {}) {
  if (!lastSweepAt) return null;
  if (now < lastSweepAt - 60 * 60 * 1000) return 'the clock has moved backwards since the last sweep';
  if (now - lastSweepAt > CLOCK_JUMP_MS) return 'more time has passed than an hourly sweep can account for';
  return null;
}

// Whether the age rule is held off on this sweep, carried between sweeps in
// `holdUntil`. A jump starts or restarts the hold. A hold further away than
// CLOCK_HOLD_MS can only have been set by a clock that has since gone back,
// and is not trusted to keep the rule off for longer than that.
export function clockHold({ now = Date.now(), lastSweepAt = 0, holdUntil = 0, lastProblem = null } = {}) {
  const jumped = clockLooksWrong({ now, lastSweepAt });
  if (jumped) return { problem: jumped, holdUntil: now + CLOCK_HOLD_MS };
  if (holdUntil > now && holdUntil - now <= CLOCK_HOLD_MS) {
    return { problem: lastProblem || 'the clock jumped recently', holdUntil };
  }
  return { problem: null, holdUntil: 0 };
}
