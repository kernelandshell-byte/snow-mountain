# Vendored: pdf.js 6.3.289

`pdf.mjs` and `pdf.worker.mjs` are taken unmodified from
`pdfjs-dist` 6.3.289's `legacy/build/` directory, Apache License 2.0,
licence text in `LICENSE.md`.

The unminified files, not `pdf.min.mjs` / `pdf.worker.min.mjs`. The Chrome
Web Store rejects minified third-party code as obfuscated (violation "Red
Titanium"), so the readable build is shipped even though it is about twice
the size. Do not switch back to the `.min.mjs` files.

The legacy build, not the modern one in `build/`. The modern build calls
`Promise.try` on every message between pdf.js and its worker, which Chrome
only has from 128 while the manifest allows 116, and `Math.sumPrecise` and
`Map.prototype.getOrInsertComputed`, which Chrome 141 still does not have
(the second is why `getMetadata()` threw). The legacy build is the same
code with those polyfilled, for about 110KB more.

Vendored rather than installed, same reason as `src/vendor/readability/`:
this extension ships no build step and has no runtime dependencies. Unlike
Readability, neither file is loaded as a classic script or injected into a
web page at all -- `pdf.mjs` is imported as an ES module from
`src/offscreen/offscreen.js`, which points `GlobalWorkerOptions.workerSrc`
at `pdf.worker.mjs` via `chrome.runtime.getURL`, and both only ever run
inside the extension's own offscreen document.

The two files together are about 3.4MB, against Readability's 90KB --
a different order of magnitude, not a rounding error, and worth being
honest about rather than glossing over. It is acceptable for a reason
Readability's cost isn't: Readability is injected into every tab that
earns capture, so its size is a tax on every page someone reads, while
pdf.js is never injected into a page. It loads once into the offscreen
document, which is created on demand only when a PDF candidate exists, so
the 3.4MB is paid by the extension's own background context, not by the
browsing experience.

Not vendored: `standard_fonts/` and `cmaps/`, which pdf.js otherwise
fetches by URL for PDFs using non-embedded CJK fonts or certain older
Type1 font substitution. `connect-src 'none'` on the extension's pages
would block that fetch. Nothing in the fixtures this project targets
(English, German, Dutch) has been found to need them; if
one turns up, vendor `node_modules/pdfjs-dist/standard_fonts` and
`.../cmaps` alongside these two files and point `getDocument()` at the
vendored copies via `standardFontDataUrl` / `cmapUrl`, the same fix
already applied to the worker.

To update: `npm pack pdfjs-dist`, copy `legacy/build/pdf.mjs`,
`legacy/build/pdf.worker.mjs` and `LICENSE` (as `LICENSE.md`) out of the
tarball, and run the PDF capture browser suite.
