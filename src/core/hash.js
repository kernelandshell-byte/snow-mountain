// Content hash, used to tell "the same page again" from "the page changed".
// FNV-1a run twice with different offsets, giving a 64 bit hex string.
// Deterministic, dependency free, and identical in Node and the browser,
// which matters because the same code runs in tests and in the extension.

function fnv1a(text, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function contentHash(text) {
  const a = fnv1a(text, 0x811c9dc5);
  const b = fnv1a(text, 0x9e3779b9);
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

export function byteLength(text) {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.codePointAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c < 0x10000) bytes += 3;
    else { bytes += 4; i++; }
  }
  return bytes;
}
