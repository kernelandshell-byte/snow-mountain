// Shared so the popup and the settings page cannot drift into describing the
// same number differently.

export function bytes(value) {
  const n = Number(value) || 0;
  if (n < 1024) return n + 'B';
  // Below a megabyte, "0.0MB" reads as a bug rather than as a small number.
  if (n < 1048576) return Math.round(n / 1024) + 'KB';
  if (n < 10485760) return (n / 1048576).toFixed(1) + 'MB';
  if (n < 1073741824) return Math.round(n / 1048576) + 'MB';
  return (n / 1073741824).toFixed(1) + 'GB';
}

export function pageCount(n) {
  return n === 1 ? '1 page' : n.toLocaleString() + ' pages';
}
