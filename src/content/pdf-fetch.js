// Injected only once observer.js has already decided this PDF tab is worth
// keeping. This is the one file THREAT-MODEL.md names as the exception to
// "no network calls anywhere in this code": getting a PDF's bytes at all
// needs one fetch() of the tab's own URL. It reaches nowhere the tab had not
// already reached, and it sends nothing. See PDF-CAPTURE.md, "The fetch
// problem".
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

  (async () => {
    let bytes = null;
    let reason = null;
    try {
      const res = await fetch(location.href);
      const data = new Uint8Array(await res.arrayBuffer());
      // A typed array sent from a content script to the background does not
      // survive chrome.runtime.sendMessage as a typed array -- checked here
      // rather than assumed, and it arrives as an empty {} on the other end.
      // A plain array of numbers is what actually round-trips.
      if (looksLikePdf(data.slice(0, 5))) bytes = Array.from(data);
      else reason = 'not actually a pdf';
    } catch {
      reason = 'could not read this pdf';
    }

    chrome.runtime.sendMessage({
      type: 'PDF_BYTES',
      payload: {
        ok: !!bytes,
        reason,
        url: location.href,
        title: document.title || '',
        bytes,
        capturedAt: Date.now(),
        explicit,
      },
    });
  })();
})();
