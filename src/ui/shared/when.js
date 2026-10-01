import { t, formatNumber } from '../../shared/i18n.js';

// How long ago, in words, shared by the search page and the popup so the two
// cannot describe the same date differently.
//
// It says "last month" rather than "1 months ago", which is not pedantry: a
// date is the one thing on a result card that tells you whether this is the
// page you are thinking of, and copy that reads as a template shows through
// immediately.

// Calendar days in the reader's own timezone, not blocks of 24 hours: a page
// read at half past eleven last night is "yesterday" at eight this morning,
// not "today". Rounded, because the day the clocks change is 23 or 25 hours.
const startOfDay = (time) => {
  const date = new Date(time);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
};

export function whenText(timestamp, now = Date.now()) {
  const days = Math.round((startOfDay(now) - startOfDay(timestamp)) / 86400000);
  if (!Number.isFinite(days)) return '';
  // A page dated in the future is what a wrong clock leaves behind. "In 4
  // months" would be a strange thing to read on something you have read.
  if (days < 0) return t('when_today');
  if (days === 0) return t('when_today');
  if (days === 1) return t('when_yesterday');
  if (days < 30) return t('when_days_ago', formatNumber(days));

  const months = Math.round(days / 30);
  if (days < 365) return months === 1 ? t('when_last_month') : t('when_months_ago', formatNumber(months));

  const years = Math.round(days / 365);
  return years === 1 ? t('when_last_year') : t('when_years_ago', formatNumber(years));
}
