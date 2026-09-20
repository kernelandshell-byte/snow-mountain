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
   it were the document, and "asserted in the spec, never exercised by a
   test" is not good enough for the one line doing that job. Wants a fixture
   in whatever suite ends up covering PDF capture: an HTTP response that
   claims `Content-Type: application/pdf` but is actually an HTML login
   page, confirming the fetch path refuses it rather than indexing it.
3. Bytes go to the service worker in the existing `PAGE_CANDIDATE` /
   capture flow, as a typed-array payload alongside url/title, the same
   message shape as today plus one field.
4. `background/pdf-extract.js` (new): ensures the offscreen document exists
   (`chrome.offscreen.createDocument({reasons: ['WORKERS']})`, the first
   real use of the offscreen document `ARCHITECTURE.md` reserved), sends the
   bytes over, gets back `{text, numPages}` or an error.
5. Offscreen document (`ui/offscreen/` or `background/offscreen/`, still
   undecided which, see open questions): vendored pdf.js, `getDocument()`,
   `getTextContent()` per page, joined. This is where "is there anything
   worth keeping" lives for PDFs -- a scanned, image-only PDF returns near-
   empty text, and that is treated the same way a non-article HTML page
   that fails Readability's threshold is treated today: not captured, not
   an error.
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

Not spiked, a design choice: close it after a short idle window (proposed:
30 seconds since the last parse) rather than immediately after every single
PDF, so a page with several PDF links opened in succession doesn't pay
creation cost per document, and rather than leaving it open indefinitely,
matching the service worker's own "dies constantly, holds nothing
important" ethos extended to its one helper process. `chrome.alarms`
already exists for the maintenance sweep; reusing it for this rather than
`setTimeout` (which a suspended service worker would drop) is the
consistent choice.

## Performance

`spikes/pdf-capture/run-perf.cjs`, 50 pages, ~420 words a page (denser than
typical prose, a pessimistic case, same choice `ARCHITECTURE.md`'s own
benchmark corpus makes), 55KB file:

| | Wall time | Time inside the offscreen document |
|---|---|---|
| 1st call (creates the offscreen document) | 793ms | 372ms |
| 2nd call | 710ms | 338ms |
| 3rd call | 697ms | 325ms |

Two things not yet explained and worth resolving before this ships rather
than after: roughly 350-400ms is unaccounted for between wall time and
in-document time, most likely the cost of moving a `Uint8Array` across two
message hops (service worker to offscreen document, offscreen document to
its own Worker) rather than the parse itself; and this fixture is 55KB,
where real PDFs run from tens of KB to tens of MB, so the message-passing
cost at a realistic size is genuinely unmeasured, not just unoptimised.

## Open questions before implementation starts

In roughly the order they'd block someone:

1. **Your call on "The fetch problem" above.** Everything else can be built
   speculatively; this one changes a document you show to users, and I'm
   not comfortable defaulting it.
2. **A fixture PDF that needs non-embedded font substitution or CJK cmaps**,
   to settle whether `standard_fonts`/`cmaps` need vendoring alongside the
   worker, or whether the fixtures this project actually cares about (per
   `BRIEF.md`: English, German, Dutch) never hit that path.
3. **Message-passing cost at realistic file sizes** (low tens of MB), since
   the existing `bytes` accounting in `ARCHITECTURE.md` and the message-size
   limits `test:limits` already tests for export apply here too, and a PDF
   is a second place a single message can be too big.
4. **Where the offscreen document's files live** in `src/` -- a new
   top-level directory (`src/offscreen/`) reads cleanest against the
   existing `background/content/core/db/shared/ui` split, since it's
   neither a content script, service-worker-owned logic, nor an extension
   page in the `ui/` sense, but it does talk to the service worker the way
   `ui/` pages do (by message, never by opening its own DB connection).
5. **The scanned-PDF "nothing to extract" UI.** The popup already says why
   a page wasn't kept (password field, excluded site, too short). A PDF
   that parsed to nothing needs its own reason string, following the
   existing pattern in `capture-policy.js` rather than a new one.
6. **A fixture exercising the magic-header rejection**: an HTTP response
   claiming `Content-Type: application/pdf` that isn't one, confirmed to be
   refused rather than indexed. Cheap, and it is the one line standing
   between a login wall and a bad capture, so it should not ship unverified.

Nothing above needs code to answer except (2) and (3), which are more
spiking in the same shape as this document, and (6), which is a small
fixture rather than a spike. (1) is yours. (4) and (5) are small enough to
settle when implementation starts.

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
