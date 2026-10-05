# Vendored: pdf.js 6.3.289

`pdf.mjs` and `pdf.worker.mjs` are taken unmodified from
`pdfjs-dist` 6.3.289's `build/` directory, Apache License 2.0,
licence text in `LICENSE.md`. `polyfills.js` is ours, not pdf.js's.

The unminified files, not `pdf.min.mjs` / `pdf.worker.min.mjs`. The Chrome
Web Store rejects minified third-party code as obfuscated (violation "Red
Titanium"). Do not switch back to the `.min.mjs` files.

The modern build in `build/`, not `legacy/build/`. The legacy build bundles
core-js polyfills, and the Web Store rejected those too (same violation):
core-js's `Object.create` shim builds the string `'java' + 'script:'` and
assembles `<script>` tags by concatenation, which the review reads as
concealed code. The modern build contains no core-js. Do not switch to the
legacy build.

What the modern build needs that Chrome 116 (the manifest minimum) lacks is
covered by `polyfills.js`, plain readable code: `Promise.try`,
`Promise.withResolvers`, `Math.sumPrecise`, `Map`/`WeakMap`
`getOrInsert`/`getOrInsertComputed`, `URL.parse` and
`Set.prototype.intersection`. It is imported before pdf.js in
`src/offscreen/offscreen.js`, and the worker is started through
`src/offscreen/pdf-worker.js`, which imports the polyfills and then
`pdf.worker.mjs`, so they exist in the worker too. When updating pdf.js,
check for new APIs with the PDF capture suite (it fails with "x is not a
function") and add them there. `Uint8Array` base64/hex methods are not
polyfilled: pdf.js only uses them when saving signatures and editing, which
this extension never does.

Vendored rather than installed, same reason as `src/vendor/readability/`:
this extension ships no build step and has no runtime dependencies. Unlike
Readability, neither file is loaded as a classic script or injected into a
web page at all -- `pdf.mjs` is imported as an ES module from
`src/offscreen/offscreen.js`, which points `GlobalWorkerOptions.workerSrc`
at `src/offscreen/pdf-worker.js` via `chrome.runtime.getURL`, and both only ever run
inside the extension's own offscreen document.

The two files together are about 3.1MB, against Readability's 90KB --
a different order of magnitude, not a rounding error, and worth being
honest about rather than glossing over. It is acceptable for a reason
Readability's cost isn't: Readability is injected into every tab that
earns capture, so its size is a tax on every page someone reads, while
pdf.js is never injected into a page. It loads once into the offscreen
document, which is created on demand only when a PDF candidate exists, so
the 3.1MB is paid by the extension's own background context, not by the
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

To update: `npm pack pdfjs-dist`, copy `build/pdf.mjs`,
`build/pdf.worker.mjs` and `LICENSE` (as `LICENSE.md`) out of the
tarball, and run the PDF capture browser suite.
