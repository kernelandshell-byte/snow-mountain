// How long ago, in words, shared by the search page and the popup so the two
// cannot describe the same date differently.
//
// It says "last month" rather than "1 months ago", which is not pedantry: a
// date is the one thing on a result card that tells you whether this is the
// page you are thinking of, and copy that reads as a template shows through
// immediately.

export function whenText(timestamp, now = Date.now()) {
  const days = Math.floor((now - timestamp) / 86400000);
  if (!Number.isFinite(days)) return '';
  // A page dated in the future is what a wrong clock leaves behind. "In 4
  // months" would be a strange thing to read on something you have read.
  if (days < 0) return 'today';
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return days + ' days ago';

  const months = Math.round(days / 30);
  if (days < 365) return months === 1 ? 'last month' : months + ' months ago';

  const years = Math.round(days / 365);
  return years === 1 ? 'last year' : years + ' years ago';
}
