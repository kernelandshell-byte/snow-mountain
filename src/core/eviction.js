// The storage budget, as pure functions.
//
// Two caps apply at once and whichever binds first wins: an age limit and a
// size limit. Pinned pages are never evicted by either, which is what makes
// the whole budget idea safe to accept: anything you care about, you keep.
//
// Nothing here deletes. It decides, and the caller writes an eviction log
// entry, because "your data was removed and here is exactly what" is the
// difference between a tool people trust and Session Buddy.

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

export function planEviction({
  pages,
  now = Date.now(),
  retentionMonths = 12,
  sizeCapBytes = Infinity,
}) {
  const cutoff = now - retentionMonths * MONTH_MS;
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

  let total = 0;
  for (const page of pages) total += page.bytes || 0;
  let freed = evict.reduce((sum, p) => sum + (p.bytes || 0), 0);

  // Oldest first, which is also least recently opened, since a revisit
  // updates lastSeen.
  survivors.sort((a, b) => a.lastSeen - b.lastSeen);
  let reasonSize = 0;
  for (const page of survivors) {
    if (total - freed <= sizeCapBytes) break;
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
  };
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
  if (!bytesPerDay || bytesPerDay <= 0) return null;
  const remaining = sizeCapBytes - usedBytes;
  if (remaining <= 0) return now;
  const days = remaining / bytesPerDay;
  if (days > 3650) return null;
  return now + days * 24 * 60 * 60 * 1000;
}

// Takes totals rather than a list of pages, so the interface can ask for
// this without the store reading every record it has.
export function paceFrom({ totalBytes = 0, oldestFirstSeen = null }, now = Date.now()) {
  if (!totalBytes || !oldestFirstSeen) return { bytesPerDay: 0, daysObserved: 0 };
  const days = Math.max(1, (now - oldestFirstSeen) / (24 * 60 * 60 * 1000));
  return { bytesPerDay: totalBytes / days, daysObserved: Math.round(days) };
}
