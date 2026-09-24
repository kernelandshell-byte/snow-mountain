// Injected only once observer.js has already decided this PDF tab is worth
// keeping. This is the one file THREAT-MODEL.md names as the exception to
// "no network calls anywhere in this code": getting a PDF's bytes at all
// needs one fetch() of the tab's own URL. It reaches nowhere the tab had not
// already reached, and it sends nothing.
//
// A classic script on purpose, same reason as observer.js and extract.js:
// content scripts cannot use ES modules without a bundler, and v1 has no
// build step.

(() => {
  const explicit = window.__readingArchiveExplicit === true;
  delete window.__readingArchiveExplicit;

  // Same check as core/pdf-detect.js's looksLikePdf, inlined rather than
  // imported for the reason above. That module is the tested version of
  // this logic; this is the one thing standing between a paywalled or
  // login-gated PDF URL and indexing an HTML error page as if it were the
  // document.
  const looksLikePdf = (head) =>
    head.length >= 5 &&
    head[0] === 0x25 &&
    head[1] === 0x50 &&
    head[2] === 0x44 &&
    head[3] === 0x46 &&
    head[4] === 0x2d;

  // Bigger than any document worth searching by its text, and past this a
  // tab would spend real memory encoding it. Kept in step with
  // MAX_PDF_BYTES in shared/constants.js.
  const MAX_PDF_BYTES = 20 * 1024 * 1024;

  // Base64 rather than an array of numbers: a typed array does not survive
  // chrome.runtime.sendMessage (it arrives as {}), and a plain array costs
  // several characters per byte, which puts a 20MB file past the 64MB
  // message limit. Base64 costs four characters per three bytes.
  const toBase64 = (data) => {
    let binary = '';
    for (let i = 0; i < data.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, data.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  };

  (async () => {
    let base64 = null;
    let reason = null;
    try {
      const res = await fetch(location.href);
      const declared = Number(res.headers.get('content-length'));
      if (declared > MAX_PDF_BYTES) throw new RangeError('too large');
      // Read in pieces so a server that does not say how big the file is
      // still cannot make this read more than the limit.
      const reader = res.body.getReader();
      const parts = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_PDF_BYTES) {
          reader.cancel().catch(() => {});
          throw new RangeError('too large');
        }
        parts.push(value);
      }
      const data = new Uint8Array(size);
      let at = 0;
      for (const part of parts) { data.set(part, at); at += part.length; }
      if (looksLikePdf(data.subarray(0, 5))) base64 = toBase64(data);
      else reason = 'not actually a pdf';
    } catch (error) {
      reason = error instanceof RangeError ? 'this pdf is too large to keep (over 20MB)' : 'could not read this pdf';
    }

    chrome.runtime.sendMessage({
      type: 'PDF_BYTES',
      payload: {
        ok: !!base64,
        reason,
        url: location.href,
        title: document.title || '',
        base64,
        capturedAt: Date.now(),
        explicit,
      },
    }).catch(() => {
      // The worker was restarting. The next visit offers the page again.
    });
  })();
})();
