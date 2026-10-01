import { tn } from './i18n.js';

// Shared so the popup and the settings page cannot drift into describing the
// same number differently.

export function bytes(value) {
  const n = Number(value) || 0;
  if (n < 1024) return n + 'B';
  // Below a megabyte, "0.0MB" reads as a bug rather than as a small number.
  // Each tier hands over to the next when its own rounding would reach the
  // next unit, so a size just under a megabyte reads "1.0MB", not "1024KB".
  if (n < 1048576) {
    const kb = Math.round(n / 1024);
    if (kb < 1024) return kb + 'KB';
  }
  if (n < 10485760) {
    const mb = n / 1048576;
    if (mb < 9.95) return mb.toFixed(1) + 'MB';
  }
  if (n < 1073741824) {
    const mb = Math.round(n / 1048576);
    if (mb < 1024) return mb + 'MB';
  }
  return (n / 1073741824).toFixed(1) + 'GB';
}

export function pageCount(n) {
  return tn('pages', n);
}

// Cuts text to at most `maxBytes` of UTF-8, never in the middle of a
// character. A limit counted in characters lets a page in Hebrew or Chinese
// take two or three times the space the limit says.
export function truncateUtf8(text, maxBytes) {
  const value = String(text || '');
  // Every character is at most four bytes, so short text needs no encoding.
  if (value.length * 4 <= maxBytes) return value;
  const encoded = new TextEncoder().encode(value);
  if (encoded.length <= maxBytes) return value;
  let end = maxBytes;
  // Step back off any continuation bytes (10xxxxxx) to a character start.
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1;
  return new TextDecoder().decode(encoded.subarray(0, end));
}
