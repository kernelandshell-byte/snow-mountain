// Whether a byte sequence is actually a PDF, not just something a server
// claimed was one. This is the one thing standing between a paywalled or
// login-gated PDF URL and indexing an HTML error page as if it were the
// document: content/pdf-fetch.js checks the same header before it trusts a
// response, and this is the pure, tested version of that check.
export function looksLikePdf(bytes) {
  const head = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (head.length < 5) return false;
  // "%PDF-" in ASCII.
  return (
    head[0] === 0x25 &&
    head[1] === 0x50 &&
    head[2] === 0x44 &&
    head[3] === 0x46 &&
    head[4] === 0x2d
  );
}
