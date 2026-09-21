# PDF capture

Companion to `ARCHITECTURE.md`, same purpose: settle the decisions that are
expensive to reverse before writing the code, and record the evidence rather
than the impression. `ROADMAP.md` calls this "the big one" and says to spec
it before touching code, on the grounds that it is the first feature that
does not fit "pure text extraction, nothing but `chrome.*` calls." That
turned out to be true in a more specific way than expected: Readability
needs a DOM to run its heuristics against, and a PDF viewed through Chrome's
native viewer has no DOM a content script can reach at all. Everything below
comes from `spikes/pdf-capture/`, run the same way the text fragment spike
was: a real Manifest V3 extension, driven by Playwright, against real
Chromium, not reasoning from pdf.js's or Chrome's general reputation.

## Assumption log

### Verified: a content script fires on a native-viewer PDF tab, and can read `document.contentType`

`spikes/pdf-capture/run-injection.cjs`. The content script runs at
`document_start` exactly as it does on an HTML page, no new injection
mechanism and no new permission. `document.contentType` reads
`'application/pdf'` throughout, which is a free, reliable way to route a
`PAGE_CANDIDATE` down a PDF path instead of the Readability path, from
inside `observer.js`'s existing message.

### Verified: `fetch(location.href)` from that content script returns the PDF's own bytes

Same spike. 1010-byte fixture, `%PDF-` magic header, byte-for-byte match.
The tab's `location.href` stays the original PDF URL the whole time; the
native viewer renders on top of it rather than navigating away from it. This
is the only way found to get bytes: `chrome.tabs.captureVisibleTab` gives
pixels, not text; there is no `chrome.pdfViewer` API; the plugin's own
rendering is not reachable from outside it (see the scroll finding below).

**This needs a decision from you before it goes further. See "The fetch problem" below.**

### Verified: pdf.js runs vendored, unbundled, inside an offscreen document, under the real CSP

`spikes/pdf-capture/run-pdfjs.cjs`, against the exact
`script-src 'self'; object-src 'self'; connect-src 'none'` this extension
ships. Vendor `pdfjs-dist`'s prebuilt `build/pdf.min.mjs` and
`build/pdf.worker.min.mjs` untouched (the modern build, not `legacy/`, since
an offscreen document is a current Chromium DOM, same reasoning as choosing
the right Readability build), same shape as vendoring Readability, two files
instead of one plus a worker. No CSP violation, no console output at all
beyond the spike's own logging. `isEvalSupported: false` is what makes
`connect-src 'none'` and no `unsafe-eval` enough: it disables the one path
(executing embedded PDF JavaScript for form calculations) that would need
`Function()`/`eval`, and capture has no reason to run PDF forms.

**Not yet checked**: a PDF needing non-embedded CJK fonts or certain
older Type1 font substitution makes pdf.js fetch `standardFontDataUrl` /
`cmapUrl` by default, which `connect-src 'none'` would then actually block.
The fix, if it turns out to matter, is vendoring
`node_modules/pdfjs-dist/standard_fonts` and `.../cmaps` alongside the two
`.mjs` files and pointing pdf.js at the vendored copies, the same fix
already applied to the worker. Needs a fixture PDF that actually exercises
this before deciding whether it is worth the extra ~2MB vendored.

### Verified: scroll depth cannot be observed on a native-viewer PDF tab, by any means available here

`spikes/pdf-capture/run-scroll.cjs`, an 8-page PDF in a viewport too short
to fit it, real mouse-wheel scrolling plus `End`. The whole document is one
`<embed>` sized to the viewport; `document.documentElement.scrollHeight` is
the viewport height, never the document's; the embed's `contentDocument` is
inaccessible (cross-process rendering, not a same-origin iframe); zero
`scroll` events reached `window` despite real scrolling happening on
screen. This is not a gap in the spike, it is the actual limit: the PDFium
plugin paginates internally and tells nothing outside itself.

**Decision: PDF capture policy is dwell-only. But the mechanism has to be
explicit, not inherited by accident**, which an earlier draft of this spec
got wrong. Checking `read-heuristic.js` and `observer.js` against the spike
output rather than assuming turned up two things:

- `wordCount()` in `observer.js` reads `document.body.innerText`, which is
  empty on a native PDF viewer tab (the body is a wrapper around one opaque
  `<embed>`). `isRead()`'s short-page exemption is `wordCount > 0 &&
  wordCount <= cfg.shortPageWords` -- and `wordCount` is exactly `0` for a
  PDF, which does **not** satisfy `> 0`. So the existing short-page
  exemption never fires for a PDF; it isn't the mechanism.
- `observer.js`'s own `scrollDepth()` is `doc.scrollHeight - innerHeight <=
  0 ? 1 : ...`. The scroll spike measured exactly that: a native-viewer
  tab's `document.documentElement.scrollHeight` sits pinned to
  `window.innerHeight`, because the top-level document never scrolls at
  all. So `scrollDepth()` already, coincidentally, returns `1` on the very
  first tick for every PDF tab today, for the same numeric reason a
  genuinely short HTML page does. **Dwell-only behaviour for PDFs may
  already happen, right now, in the shipped code, by accident.**

Relying on that would be a mistake, not a shortcut. It is the exact shape of
bug this project is written to be paranoid about: something that works by
coincidence, isn't tested as intentional behaviour, and would fail silently
and invisibly the moment the coincidence stops holding -- a future Chrome
version reporting the embed's scrollHeight one pixel taller than the
viewport, a zoomed page, a print-layout PDF with visible margins, anything
that makes `scrollHeight - innerHeight` land above zero would push a PDF
candidate back onto a scroll requirement that can structurally never be
satisfied, and PDFs would simply, quietly, stop being captured. Nobody
would notice until "why doesn't this find any of my PDFs" turned up, with
no error and no log line pointing at why.

So the real decision is: `observer.js` gains an explicit
`document.contentType === 'application/pdf'` check and reports it as its
own field (`isPdf: true`) on `PAGE_CANDIDATE`, and `read-heuristic.js`
gains one explicit branch reading that field, not a repurposing of
`wordCount` or `scrollDepth`. That is a real, small change to `core/`, and
"no changes to core/" in the pipeline section below was wrong until this
revision -- corrected there. Whether the dwell threshold should differ for
PDFs (a long report read a screenful at a time might sit under the current
8-10s more often than an HTML page would) is worth watching after real
use, not guessing now.

### Reasoned through, not spiked: revisit and content-hash semantics

No new mechanism needed. `contentHash` is computed over **extracted text**,
exactly like an HTML page, not over the PDF's bytes. That means:

- A PDF re-exported with different metadata or producer tags but identical
  text hashes the same and is not treated as a revisit-with-changed-content.
  Correct: nothing the reader would call a change happened.
- `content-change.js`'s "came back much smaller" guard (the paywall
  detector) applies unmodified. A PDF that starts returning a cover page and
  a login prompt instead of its real text is the same shape of problem an
  HTML paywall is, and gets the same protection for free.
- Everything downstream of "here is the extracted text" -- `putPage`,
  `index-writer.js`, `bm25.js`, snippets, filters, export -- needs zero
  changes. The only new code is getting from "PDF bytes" to "extracted
  text," which is the point of vendoring pdf.js in the first place.

## The fetch problem

`THREAT-MODEL.md`'s central claim is checked by one command:

```
grep -rnE "fetch\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource" src/
```

It currently returns nothing, and the doc is explicit that this is the
whole point: "the one thing you would look for is one grep away." PDF
capture needs `fetch(location.href)` inside a content script to get the
PDF's bytes at all. That call would make the command return a hit, for the
first time.

Worth being precise about what actually changes, because it is less than it
sounds:

- **The CSP is untouched.** `connect-src 'none'` is `content_security_policy.extension_pages`,
  which governs the extension's own pages (setup, search, popup, options,
  the new offscreen document) -- not content scripts, which run in the
  page's context and were never covered by that directive. Nothing about
  the CSP needs to loosen for this.
- **The call is same-tab, same URL, no new destination.** It re-reads the
  exact resource already loaded into the tab the user navigated to,
  in practice served from Chrome's own HTTP cache. It cannot reach anywhere
  the page itself did not already reach, and it sends nothing -- there is no
  request body, no header this extension controls, nothing to exfiltrate
  through. It is a local re-read, not an outbound call in the sense the
  threat model is written to rule out.
- **What genuinely breaks is the verification promise's simplicity.** "Grep
  for `fetch(`, get nothing" stops being literally true, and the honest fix
  is a narrower, still-checkable claim, not a quieter one:

  ```
  grep -rnE "fetch\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource" src/ \
    | grep -v "content/pdf-fetch.js"
  ```

  returns nothing, plus one line in `THREAT-MODEL.md` naming the one file,
  saying what it fetches (`location.href`, nothing else, no other scheme
  permitted) and why (there is no other way to get a PDF's bytes out of
  Chrome's native viewer, per the spike above).

I did not want to fold that rewording into `THREAT-MODEL.md` myself: it is a
security claim you make to users, and changing what it promises is your
call, not a default I should reach for quietly. My recommendation is the
narrowed claim above, isolating the fetch into its own small,
easy-to-audit file (`content/pdf-fetch.js`: fetch, check the magic header,
return bytes or an error, nothing else) so "the one thing you would look
for" stays a fifteen-second read. If you'd rather not accept this at all,
the feature does not ship -- there is no third way to get the bytes that
was found in the spike, and I don't think it's worth inventing an unproven
one (e.g. `webRequest` body interception, which is heavier, needs a new
permission, and is a worse story to explain in a threat model than "one
`fetch` of the page's own URL").

## Pipeline

1. `observer.js` gains one check, before the existing Readability path:
   `document.contentType === 'application/pdf'`, reported as `isPdf` on
   `PAGE_CANDIDATE`. `read-heuristic.js` gains one explicit branch reading
   it, per the correction above -- a real, small, tested change to `core/`,
   not zero changes.
2. `content/pdf-fetch.js` (new, small, the one file named in the threat
   model exception): `fetch(location.href)`, confirm the response starts
   `%PDF-`, return the bytes. Refuses anything that doesn't have the magic
   header, so a server that lies about `Content-Type` doesn't hand a content
   script an arbitrary blob to pass along. The header check itself belongs
   in `core/` as a one-line pure function (`looksLikePdf(bytes)`, next to
   `hash.js` or its own tiny module) rather than living only as an assertion
   inside the content script: it is the one thing standing between a
   paywalled or login-walled PDF URL and indexing an HTML error page as if
   it were the document. Exercised in `test:pdf` with exactly that: an HTTP
   response claiming `Content-Type: application/pdf` while actually serving
   an HTML login page, confirmed refused rather than indexed.
3. Bytes go to the service worker as a new `PDF_BYTES` message, alongside
   url/title/explicit, in a new `PAGE_CANDIDATE`-adjacent path rather than
   reusing `PAGE_CONTENT` (which carries text, not bytes). The bytes travel
   as a plain array of numbers, not a typed array: see "Built" below for why
   that is not optional.
4. `background/pdf-extract.js` (new): ensures the offscreen document exists
   (`chrome.offscreen.createDocument({reasons: ['WORKERS']})`, the first
   real use of the offscreen document `ARCHITECTURE.md` reserved), sends the
   bytes over, gets back `{text, numPages}` or an error.
5. Offscreen document (`src/offscreen/`): vendored pdf.js, `getDocument()`,
   `getTextContent()` per page, joined. This is where "is there anything
   worth keeping" lives for PDFs -- a scanned, image-only PDF returns near-
   empty text, and that is treated the same way a non-article HTML page
   that fails Readability's threshold is treated today: not captured, not
   an error. Title does not come from here: see "Built" below.
6. From here on, identical to an HTML page: `putPage`, indexing, search,
   snippets, export. No changes to `db/` or the search pipeline. `core/`
   gets the two small, testable additions above (the `isPdf` branch in
   `read-heuristic.js`, `looksLikePdf`); nothing downstream of extracted
   text changes at all.

### Vendoring pdf.js

Same shape as `src/vendor/readability/`, but it is worth being explicit
about where the shape stretches rather than letting the comparison imply
it's identical. Readability is one 90KB file, unmodified, with a
`README.md` stating the exact upstream version, the licence, and the update
recipe (`npm pack @mozilla/readability`, copy the file and licence out,
rerun the extraction test). pdf.js needs the same treatment but is two
files, `pdf.min.mjs` and `pdf.worker.min.mjs`, both prebuilt by upstream
(the spike copied them from `pdfjs-dist`'s `build/` directory untouched,
no bundler step on either side), totalling roughly 1.7MB against
Readability's 90KB. Both are Apache 2.0, so the licence file is the same
shape. `src/vendor/pdfjs/README.md` should say, same as Readability's does:
the exact `pdfjs-dist` version pinned, that both files are copied verbatim
from `build/` (not `legacy/`), and the update recipe. The size difference
is worth a line in that README too, with the reason it's acceptable: unlike
Readability, which is injected into every tab that earns capture, pdf.js is
never injected into a web page at all -- it loads once into the offscreen
document, which is created on demand and only for a PDF candidate, so the
1.7MB cost is paid by the extension's own background context, not by every
page someone reads.

### Offscreen document lifecycle

Closed after a short idle window (`background/pdf-extract.js`,
`OFFSCREEN_IDLE_ALARM`) rather than immediately after every single PDF, so a
page with several PDF links opened in succession doesn't pay creation cost
per document, and rather than leaving it open indefinitely, matching the
service worker's own "dies constantly, holds nothing important" ethos
extended to its one helper process. `chrome.alarms` rather than
`setTimeout`, which a suspended service worker would drop. The window is
one minute, not the 30 seconds an earlier draft of this section proposed
before being checked against the real API: `chrome.alarms.create` has a
floor of about a minute for a published extension, and a shorter
`delayInMinutes` does not get honoured.

## Performance

`spikes/pdf-capture/run-perf.cjs`, 50 pages, ~420 words a page (denser than
typical prose, a pessimistic case, same choice `ARCHITECTURE.md`'s own
benchmark corpus makes), 55KB file:

| | Wall time | Time inside the offscreen document |
|---|---|---|
| 1st call (creates the offscreen document) | 793ms | 372ms |
| 2nd call | 710ms | 338ms |
| 3rd call | 697ms | 325ms |

That 350-400ms gap between wall time and in-document time turned out to be
message-passing and reconstruction overhead, confirmed against a real
14.5MB, 12,000 page fixture rather than left as a guess (see "Built"
below): real, but small next to the actual cost at that size, which is
pdf.js parsing every page.

## Built

Implemented and green: `npm test` (207 Node tests) and the full existing
browser suite, plus a new `test:pdf` (`test/browser/run-pdf-capture.mjs`)
driving the real extension end to end -- a real PDF read for its dwell
period with no scrolling at all, a scanned/image-only PDF correctly not
kept, a login page served with `Content-Type: application/pdf` correctly
refused, and "keep this page now" working immediately on a PDF tab. Of the
open questions above: (1) is answered -- `THREAT-MODEL.md` now carries the
narrowed claim, isolating the exception to `content/pdf-fetch.js`. (4) is
settled as `src/offscreen/`. (5) turned out to need nothing new: a PDF that
parses to empty text hits `onPageContent`'s existing "too little text"
floor, the same message an empty HTML extraction already gets. (6) is
exercised by the new browser suite. (3) is answered, and the answer was not
the one expected: see below. (2) is still genuinely open -- nothing here
needed it, but nothing here answered it either.

Four things surfaced only by building this rather than by reasoning about
it, all found the same way everything else in this document was: run it for
real and check, don't assume.

**Message-passing was not the bottleneck at a realistic large size; pdf.js
parsing every page was.** Built a 14.5MB, 12,000 page fixture specifically
to answer open question (3) rather than leave it a guess. The plain-array
conversion this document worried about (see the next finding) cost under a
second on the content-script side. What actually took time was the
offscreen document calling `getPage()` and `getTextContent()` once per
page: 38.6 of a 47.5 second total capture, almost all of it text that
`onPageContent`'s existing `MAX_TEXT_BYTES` cap was going to throw away
regardless, since it truncates stored text to 200KB no matter how much
came in. Fixed by stopping the extraction loop once accumulated text
reaches that cap, in `src/offscreen/offscreen.js`: the same fixture now
captures in about 9 seconds, roughly five times faster, for identical
stored output (`onPageContent`'s own truncation made the result
byte-for-byte the same either way; only the wasted work changed). A
correctness test for this lives in `test:pdf` against a small committed
fixture built to exceed the cap (`test/fixtures/pdf/many-pages.pdf`, 130
dense pages, 161KB) -- the 12,000 page fixture used to find and confirm
the fix is not committed, being large for what it is worth keeping around.

**`chrome.runtime.sendMessage` does not preserve a `Uint8Array` or
`ArrayBuffer` between a content script and the background.** The very first
end-to-end run sent real bytes from `pdf-fetch.js` and they arrived at the
service worker as `{}` -- an empty plain object, not a typed array, not an
error, nothing that would have shown up short of actually checking what
came out the other end. The fix is the one the earlier spike happened to
use for an unrelated reason (Playwright's own argument-passing constraint
into `page.evaluate`, nothing to do with the real extension messaging
layer): send `Array.from(bytes)`, a plain array of numbers, and
reconstruct with `new Uint8Array(...)` wherever it is used as bytes again.
Both `content/pdf-fetch.js` (content script to service worker) and
`background/pdf-extract.js` (service worker to offscreen document) do this
now. Found with the original 1010-byte fixture, before the large-file
question above was even asked: a plain array of numbers is a measurably
worse shape to send than packed bytes, but per the finding above it turns
out not to be the dominant cost even at 14.5MB, so it was fixed for
correctness (bytes have to actually arrive) rather than for the
performance question it happens to also touch.

**`doc.getMetadata()` throws inside this `pdfjs-dist` build.** Getting a
PDF's title looked like the obvious next step once extraction worked, and
calling it on the very first real PDF crashed with
`TypeError: this[#Yr].getOrInsertComputed is not a function` -- a `Map`
method this Chromium does not have, reached through code `getMetadata()`
shares internally with unrelated editor and telemetry modules in the
minified bundle. `getTextContent()`, the only pdf.js call this code
actually depends on, has been run dozens of times across every test above
with no error at all; this is a narrow, specific crash in one unused
codepath, not a reason to distrust the rest of the library. Fixed by not
calling it: see the next finding.

**`document.title` reads empty on Chrome's native PDF viewer, always,
however long the wait -- but `chrome.tabs.get(tabId).title` already has the
PDF's real metadata title, immediately, correctly, and needs no pdf.js
metadata call at all.** Checked directly: a PDF with a title embedded via
`pdf-lib`'s `setTitle()` showed `document.title === ''` for ten full
seconds of polling in the same tab where `chrome.tabs.query` reported the
correct title from the first check. `background/capture.js`'s `pdfTitle()`
asks Chrome, with `payload.title` (the content script's `document.title`,
in practice always empty) and the URL's filename as fallbacks in that
order, and the whole `getMetadata()` question above became moot.

## Review

An independent pass (real re-runs of all four spikes, not a read-through)
confirmed the headline findings reproduce and checked the CSP-scoping claim
and the content-hash reasoning against the actual code rather than trusting
this document. It found one real problem, since fixed above: an earlier
draft's "no changes to `core/`" was wrong, because the dwell-only decision
needs an explicit signal rather than relying on `wordCount()` or
`scrollDepth()`'s existing branches, which turned out to already produce
dwell-only behaviour for PDFs today by numeric coincidence rather than by
design. It also flagged the magic-header check as asserted but unexercised
(now item 6 above) and asked for vendoring parity with `src/vendor/readability/`
(now under "Vendoring pdf.js" above). See the PR thread for the full review.
