# TextMemory

A local full text memory for your browser. Pages you actually read get indexed on your own machine, so you can find them later by any phrase you remember.

Nothing leaves the computer. See `THREAT-MODEL.md` for what that claim does
and does not cover, and `PRIVACY.md` for the short version.

- `ARCHITECTURE.md` is how it is built, and it settles the decisions that are expensive to reverse.
- `npm run package` builds the zip to upload to the Chrome Web Store.

## What it does

Set it up, read some pages, search them back, land on the paragraph that
matched.

- The pure core: tokenising, capture policy, read heuristic, BM25, query
  parsing, snippets, the storage budget, quote matching, text fragment URLs
- Two stores, `memory-store` and `idb-store`, held to one contract that runs
  against both
- Search with an AND to OR fallback, a singular fallback for plurals,
  stemming in English, Spanish, Portuguese, German, French and Italian (and
  Dutch on request), and bounded-edit-distance typo tolerance for a word
  that found nothing at all, prefix matching for the same case, site
  and date filters, sorting, and paging, all of which hold however many
  pages match
- Jump to passage: a text fragment for a new tab, and a highlight in place
  for a tab already open or a page that renders late
- Extraction through vendored Readability, injected only into pages that
  have earned it
- PDF capture: the same dwell heuristic minus the scroll signal a native PDF
  viewer cannot give, vendored pdf.js running in an offscreen document, and
  one narrowly scoped exception to "no network calls" for the one fetch
  needed to get a PDF's own bytes out of Chrome's viewer.
- A five screen setup flow that requests host access at the moment it is
  explained, asks for nothing at all in strict mode, and asks which languages
  you read, starting from your browser's own
- A popup about the page in front of you: whether it is kept, why not if it
  is not (including what the page itself had on it, like a password field),
  and one click to keep it or forget it, or two to never keep that site
  again, since that also deletes what was kept from it
- Nothing captured, and nothing injected into any page, until setup is
  finished
- Settings with exclusion bundles, custom rules that are read the way they
  were meant and say how, the storage meter, the deletion log, export, import
  that streams so an archive of any size comes back, and delete everything
- A storage budget with two caps, an hourly sweep that reads only what it
  might delete, pinning that eviction can never touch, a storage log, a clock
  guard that holds the age limit off for a day when the clock jumps, so a
  laptop that wakes up in next year has time to set itself right before
  anything is removed for its age,
  and a meter that counts the index as well as the text, because the index is
  most of an archive
- A migration policy that is code rather than a paragraph: build the new
  shape alongside the old, verify it, and only then give up the old one, all
  inside one transaction so a failure leaves the archive exactly as it was
- 314 Node tests and twenty-three browser suites, including
  extraction against 32 real page snapshots, the page shapes that are not
  articles at all, a resilience suite that deletes the database underneath a
  running extension, a consistency check that churns the index and then
  verifies it has not drifted, a year of accumulation with both caps biting,
  a migration suite whose failing migrations all have to leave the old
  database untouched, a PDF capture suite proving a login page served as
  `application/pdf` is refused rather than indexed, and regression checks
  for defects found in review

## Tests

```
npm test                              # 314 Node tests, no dependencies, about two seconds
npm install --no-save playwright      # only needed for the browser suites

npm run test:browser                  # the store contract against real IndexedDB
npm run test:e2e                      # capture, search, pin, forget, evict, through the real worker
npm run test:extraction               # Readability against a page full of clutter
npm run test:pdf                      # a real pdf, a scanned one, and a login page pretending to be one
npm run test:setup                    # the setup flow, including a refused permission
npm run test:options                  # settings, capture modes, export and delete everything
npm run test:migration                # the migration policy, including migrations that fail
npm run test:limits                   # export at scale, persistence, a full disk, restarts
npm run test:hostile                  # a wrong clock, a newer database, settings that are not settings
npm run test:storage                  # whether the storage meter is telling the truth
npm run test:review                   # regressions for defects found in review
npm run test:presentation             # contrast, both themes, narrow windows, no mouse
npm run test:longterm                 # a year of accumulation; takes a while
node test/browser/run-ui-smoke.mjs    # the search page; --screenshot out.png to look at it

node test/browser/run-benchmark.mjs 1500   # what it costs; not a test
npm run bench:delete                       # why DELETE_BATCH is one; not a test
npm run bench:fallback                     # what each search language costs; not a test
npm run verify:stemmers                    # the stemmers against real dictionaries; needs python
```

`npm run test:longterm [pages] [days]` and `npm run test:limits [pages]` both
take a size. The defaults are 4,000 pages and 700; the numbers in
`ARCHITECTURE.md` come from runs at 10,000 and 30,000.

## Loading it

`chrome://extensions`, developer mode on, load unpacked, pick this folder. It asks for no site access at install: host access is requested during setup, and content scripts are registered at runtime.

Setup opens by itself on a fresh install. Until you finish it nothing is captured, which is deliberate: the permission is requested on the screen that explains what it is for, not at install time.

## The two rules

Nothing in `src/core/` imports `chrome.*`, so it can be tested without a browser.

Nothing except the service worker writes to the database. Extension pages ask it for what they need, which costs a message hop and buys a single writer with no cross context races.

## Licence

MIT; see `LICENSE`. The vendored Readability, pdf.js and Snowball stemmers
keep their own licences, listed in `THIRD-PARTY-NOTICES.md` and kept beside
their code in `src/vendor/`.
