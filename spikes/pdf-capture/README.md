# Spike: PDF capture

Two questions the PDF capture feature depends on, answered the same way the
text fragment spike answered its question: a real Manifest V3 extension,
driven by Playwright, against real Chromium.

## Question 1: does anything fire at all on a PDF tab?

Readability needs an HTML DOM. Chrome's native PDF viewer is not one, from a
content script's point of view it is a different rendering path entirely. Two
things had to be checked before assuming a content script can see a PDF tab
at all: does the content script run there, and can it get the PDF's own bytes
back out.

Run it: `node run-injection.cjs` (serves `site/test.pdf` locally, loads
`ext/` with a content script matching `<all_urls>`).

### Result, 20 September 2026, Chromium via Playwright

```
SPIKE_RESULT {"href":"http://127.0.0.1:PORT/test.pdf","contentType":"application/pdf",
  "readyState":"loading","title":"","bodyChildCount":null,"hasEmbed":false,
  "fetchOk":true,"fetchByteLength":1010,"fetchMagic":"%PDF-"}
```

Three things settled:

1. **The content script fires**, at `document_start`, same as any other page.
   No new injection mechanism, no new permission beyond what capture already
   asks for.
2. **`document.contentType` is `'application/pdf'`.** Cheap, reliable
   signal to route a candidate through a PDF path instead of Readability,
   from inside the exact same `PAGE_CANDIDATE` message `observer.js` already
   sends.
3. **`fetch(location.href)` returns the real PDF bytes**, not the viewer's
   synthetic wrapper: 1010 bytes, `%PDF-` magic header, matching the fixture
   on disk exactly. The tab's `location.href` is the original PDF URL
   throughout; the native viewer is a rendering layer on top of it, not a
   navigation away from it.

See `PDF-CAPTURE.md` at the repo root for why (3) is not a free lunch: it is
a `fetch()` call inside `src/`, and the threat model's checkable claim is
that grepping `src/` for `fetch(` returns nothing.

## Question 2: does pdf.js run vendored, unbundled, under the real CSP?

The project's rule is no build step and a vendored dependency is one file
(see `src/vendor/readability/`). pdf.js is not one file, it needs its own
Worker, and the extension pages ship
`script-src 'self'; object-src 'self'; connect-src 'none'`. All three had to
be checked together rather than assumed from pdf.js's general reputation for
working in browsers, because "works in a webpage" and "works inside an
offscreen document under this CSP with no bundler" are different claims.

Run it: `node run-pdfjs.cjs`. Vendors `pdfjs-dist`'s prebuilt
`build/pdf.min.mjs` and `build/pdf.worker.min.mjs` (the modern build, not
`legacy/`, since an offscreen document is a real current Chromium DOM) into
`ext/vendor/` untouched, no bundler step. An offscreen document imports
`pdf.min.mjs` as an ES module, points `GlobalWorkerOptions.workerSrc` at the
vendored worker file via `chrome.runtime.getURL`, and parses bytes handed to
it in a message with `isEvalSupported: false` (pdf.js's flag for the one
thing that would need `unsafe-eval`: executing embedded PDF JavaScript for
form field calculations, which capture has no reason to run).

### Result, 20 September 2026, Chromium via Playwright

```
service worker up
asking service worker to parse 1010 bytes via offscreen pdf.js...
RESULT: {
  "ok": true,
  "numPages": 1,
  "text": "The quick brown lemur audits seventeen postings buckets before breakfast Second line of body text for the PDF capture spike."
}
```

No console output at all besides the script's own logging: no CSP violation
report, no worker error, nothing swallowed. Four things settled:

1. **pdf.js runs vendored as two plain `.mjs` files**, no bundler, the same
   shape as the Readability vendoring, just two files instead of one plus a
   worker.
2. **The real production CSP is enough.** `script-src 'self'` covers the ES
   module import and the worker script (both are extension-local URLs).
   `connect-src 'none'` did not need loosening for this fixture, because
   `isEvalSupported: false` avoids the one path (`Function()`/`eval` for
   embedded JS forms) that would need `unsafe-eval`, and the fixture has no
   embedded standard-font substitution or CJK cmap lookups, which pdf.js
   otherwise fetches by URL. **Not yet checked**: a PDF that needs those
   (non-embedded CJK fonts, certain older Type1 fonts) needs
   `standardFontDataUrl` / `cmapUrl` pointed at vendored copies of
   `node_modules/pdfjs-dist/standard_fonts` and `.../cmaps` rather than
   pdf.js's default of fetching them, or `connect-src 'none'` will actually
   bite in production on documents this fixture does not exercise.
3. **The offscreen document, service worker and Worker three-hop works**:
   service worker to offscreen document to a pdf.js-spawned Worker, and back.
   This is the "not in v1" offscreen document from `ARCHITECTURE.md` actually
   being created for the first time, for the first bulk-ish job that needs
   it.
4. **Extraction is via `getTextContent()` per page**, not `getDocument()`
   alone; the numbers, spacing and reading order come from `item.str` joins,
   which is the same shape of problem Readability solves for HTML (what
   counts as body text) except pdf.js hands back a flat run of text items
   with no DOM to apply Readability's heuristics to. A real implementation
   needs its own "is this page worth extracting" pass, not Readability's.

## Question 3: can the content script see scroll depth inside the native viewer?

`read-heuristic.js` wants dwell *and* scroll depth. Run it:
`node run-scroll.cjs` (an 8-page, 700px-tall-page PDF, viewport shrunk to
500px so it cannot possibly fit without scrolling, real mouse wheel events
plus `End`).

### Result, 20 September 2026, Chromium via Playwright

```
SCROLL_RESULT {"label":"start","scrollY":0,"docScrollHeight":500,"bodyChildCount":null,"iframeCount":0,"embedCount":0}
SCROLL_RESULT {"label":"load","scrollY":0,"docScrollHeight":500,"bodyChildCount":1,"iframeCount":0,"embedCount":1}
SCROLL_RESULT {"label":"child-doc-access","tag":"EMBED","accessible":false}
(no scroll events observed by the content script at all, after a real wheel scroll and End)
```

Settled, and it is a real gap rather than a detail: the whole page is one
`<embed>` sized to the viewport. `document.documentElement.scrollHeight` is
the viewport height, not the document height, because the top-level
document never scrolls -- the PDFium plugin inside the embed does its own
paging, invisibly to anything outside it, and `el.contentDocument` on that
embed is inaccessible (cross-process rendering, not a same-origin iframe).
Scrolling really happened (visible in the non-headless run) and produced
zero `scroll` events on `window`.

**Scroll depth cannot be observed for a PDF tab, at all, by any means this
extension has.** Capture policy for PDFs has to be dwell-only. See
`PDF-CAPTURE.md`.

## Performance, on 50 pages of dense text

`node run-perf.cjs`, against a 55KB, 50-page fixture (`make-big-pdf.mjs`,
~420 words a page, denser than typical prose to be a pessimistic case, the
same choice `ARCHITECTURE.md`'s benchmark corpus makes):

| Run | Wall time (call to response) | Time inside the offscreen document | Extracted |
|---|---|---|---|
| 1st (creates the offscreen document) | 793ms | 372ms | 130,780 chars |
| 2nd (document already open) | 710ms | 338ms | 130,780 chars |
| 3rd | 697ms | 325ms | 130,780 chars |

Two things worth noting rather than glossing over. The offscreen document,
once created, is not torn down between calls in this spike (`hasDocument()`
short-circuits), which is why runs 2 and 3 do not pay creation cost again --
a real implementation needs a policy for when to `closeDocument()`, since
`ARCHITECTURE.md` says to close it "when the job finishes" and a capture
pipeline does not have one obvious moment that is. And roughly 350-400ms is
unaccounted for between "wall time" and "time inside the document": message
serialisation of a 55KB `Uint8Array` across two `postMessage` hops (service
worker to offscreen document, offscreen document to its Worker) is the
likely cost, not measured separately here. Both are implementation questions
for the spec, not blockers.

## What is still not answered

- **Real-world PDFs**: no images, no columns, one embedded standard font, no
  scanned/image-only pages. A scanned PDF has no text layer at all and
  `getTextContent()` returns nothing, silently -- that needs its own
  "nothing to extract" path, the same shape as the existing "not an article"
  fallback for HTML, rather than being captured as a blank page.
- **Byte transfer cost at a realistic PDF size** (a few MB, not 55KB) through
  the message-passing three-hop above is unmeasured.
- **Revisit / content-hash semantics** were reasoned through, not spiked:
  see `PDF-CAPTURE.md`. They turn out to need no new mechanism, only a
  decision about what gets hashed.
