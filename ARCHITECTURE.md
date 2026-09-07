# Architecture

Companion to `BRIEF.md`. The brief says what we are building and why. This says how it is put together, and it exists mainly to settle the decisions that are expensive to reverse later: the storage schema, the index format, what runs in which context, and the contracts between them.

Everything here is meant to be implementable by someone who has not read the conversation that produced it.

## Assumption log

Design work that rests on an unverified browser behaviour is a trap, so assumptions are tracked with their status and the evidence behind them.

### Verified: the whole jump to passage mechanism

Tested with a real Manifest V3 extension calling `chrome.tabs.create`, driven by Playwright against a local test page. Reproducible in about fifteen seconds: `spikes/text-fragment/`.

Page is 4727px tall, the target sentence sits at document offset 3829, viewport is 800px.

| Case | scrollY | Reading |
|---|---|---|
| `tabs.create`, no directive | 0 | control |
| `tabs.create`, phrase present | 3433 | works, match centred in the viewport |
| `tabs.create`, phrase absent | 0 | opens at the top, nothing thrown |
| `tabs.update` on an open tab, same URL plus directive | 0 | does not fire |
| `tabs.create`, target inserted 800ms after load | 0 | does not wait for late content |

In every case Chrome stripped the directive from the URL before any script could read it.

Four consequences, all settled:

1. **The happy path is free.** Opening a search result in a new tab with `#:~:text=` lands on the passage. No anchoring code, no content script, no work.
2. **Failure is silent and harmless.** A page whose text changed since capture simply opens at the top. That is the right behaviour and it needs no handling at all.
3. **The extension cannot tell whether it worked.** The directive is gone before scripts run, so never build UI that claims "jumped to your passage". Say nothing and let the result speak.
4. **Exactly two cases need the fallback**, and both are detectable in advance rather than being error paths: the URL is already open in a tab, or capture recorded that the page renders late, which covers most SPAs. In those two cases, send `HIGHLIGHT` to the content script and skip the fragment entirely.

The fallback is the quote plus position matching that Form Recovery already uses, so it is a port rather than a new problem.

### Unverified

**Whether a service worker can spawn a dedicated `Worker`.** An earlier draft of the brief claimed indexing would run in a Web Worker. That was written before checking, and MV3 service workers have historically not been permitted to create dedicated workers. Nothing below depends on the answer, so this is worth knowing but not worth blocking on.

## Execution contexts

Four places code can run, and the rule that keeps this sane is that **only one context writes to the database.**

**Content script**, one per eligible tab. Watches focus, dwell and scroll. Detects password fields. Runs extraction when the page qualifies. Sends a payload to the service worker and forgets about it. Never touches IndexedDB, never makes policy decisions.

**Service worker**, the coordinator, and the only writer. Owns capture policy, tab focus tracking, the omnibox handler, alarms for maintenance, and all reads and writes to the database. It dies constantly, so nothing important lives in its memory between events.

**Extension pages** (search, setup, options, popup). Read only with respect to the database, and they get their data by messaging the service worker rather than opening their own connection. This costs a message hop and buys a single writer with no cross context races.

**Offscreen document**, not in v1. Reserved for bulk jobs: a schema migration, a full reindex, an import. Created with `chrome.offscreen` using the `WORKERS` reason, closed as soon as the job finishes. Named here so that when a bulk job is needed, nobody invents a second architecture for it.

Indexing a single page is small work, tens of milliseconds for a normal article, and it happens in the service worker where blocking costs nothing visible. Batching exists to protect the database, not the UI.

## Data model

One IndexedDB database. Settings do not live in it, they live in `chrome.storage.local`, because the service worker needs them cheaply at startup and they must survive even if the database has to be rebuilt.

### `pages`

Key: `id`, auto increment integer.

The integer key is deliberate. Document ids repeat inside every postings list, so they have to be compact. Keying pages by URL would inflate the index by an order of magnitude.

| Field | Notes |
|---|---|
| `id` | auto increment, stable for the life of the record |
| `url` | as captured |
| `urlKey` | normalised, unique, used for dedupe |
| `title` | |
| `domain` | registrable domain, for filters and site rules |
| `text` | extracted body text, capped at 200KB |
| `excerpt` | short summary for result cards |
| `wordCount` | |
| `contentHash` | to detect whether a revisit needs reindexing |
| `firstSeen`, `lastSeen` | epoch ms |
| `visitCount` | |
| `pinned` | 0 or 1, never evicted when 1 |
| `bytes` | our own accounting of what this record costs |
| `lang` | nullable, reserved for later stemming work |

Indexes: `urlKey` (unique), `lastSeen`, `domain`, `pinned`, `firstSeen`.

`urlKey` normalisation, fixed now because changing it later silently splits or merges records: lowercase scheme and host, drop `www.`, drop the fragment, drop tracking parameters (`utm_*`, `fbclid`, `gclid`, `mc_eid`, `ref`, `ref_src`), sort the remaining query parameters, strip a trailing slash on the path. Everything else is kept, because for plenty of sites the query string is the page.

### `postings`

Key: `[term, bucket]` compound, where `bucket = id >> 8`, so 256 documents
per bucket.

Value: `{ term, bucket, docs: [{ id, tf, pos }] }`.

Chunking is the important decision here, and the size was chosen by
measurement rather than by feel. The two obvious layouts both fail:

- One record per term holding the whole list means every update to a common
  term rewrites a record that grows without bound.
- One record per term and document pair means IndexedDB per record overhead
  dominates, and reading a common word walks thousands of tiny records.

Chunks fix that, but only if the chunk is small. Indexing one article
rewrites a record for roughly 550 distinct terms, and with 4096 documents
per bucket each of those records grew with every page added to the same
bucket. Measured against real IndexedDB, cost per page climbed from 132ms
at 400 documents to 297ms at 1500 and was heading for about a second as the
bucket approached capacity. At 256 the rewrite is bounded, indexing settles
around 130ms, and storage came out 26% smaller because smaller records
serialise more efficiently. `test/browser/run-benchmark.mjs` reproduces all
of that.

Positions are capped at the first 32 occurrences per term per document.
Enough for phrase queries in practice, and it stops one pathological
document from bloating the index.

Removing a document's postings needs to know which terms it had. Rather
than storing a term list on every page, which would cost roughly 40% on top
of the text, the terms are recomputed by tokenising the text the record
already holds. That is also why a page keeps its text after indexing.

**Transaction discipline.** Every await inside a transaction must resolve
from an IndexedDB request belonging to that transaction. Await anything else
and the transaction commits underneath you, leaving half the writes done.
Separately, issue requests before awaiting them: awaiting each read in turn
costs one round trip per term, which was most of the original 265ms per
page. `Promise.all` over requests created synchronously is the whole fix.

### `meta`

Key: `key`. Holds the schema version and the corpus statistics BM25 needs: document count, total token count, average document length. These change on every write, so they are updated in the same transaction as the postings, never recomputed by scanning.

### `evictionLog`

Key: auto increment. Fields: `at`, `reason` (`age` | `size` | `manual` | `siteRule`), `count`, `bytesFreed`, `sampleTitles`. This is what the storage log in the UI reads. Nothing is ever removed without a row here.

## Migration policy

This is the part the Session Buddy failure was about, so it is a rule, not a preference.

1. The schema version lives in both the IndexedDB version and a `meta` row, and they are checked against each other at startup.
2. An upgrade never transforms a store in place. It builds the new store alongside the old one.
3. The old store is deleted only after a verification pass confirms the new one holds the expected record count and passes a sample integrity check.
4. If anything throws, the old data is still there, and the extension shows a clear error instead of an empty list. An empty list must never be the way a user learns a migration failed.
5. If the database version is newer than the running code expects, which is what a downgrade looks like, refuse to start rather than mangling anything.
6. After a successful migration, tell the user once what happened.

A migration test belongs in the suite from the day there is a second schema version: build a v1 database, run the upgrade, assert no loss, then assert that a forced failure leaves v1 intact.

## Message contracts

All messages are `{type, payload}` with types declared as constants in
`shared/messages.js`. No string literals at call sites.

Content script to service worker:

- `PAGE_CANDIDATE` `{url, title, hasPasswordField, focusedMs, scrollDepth, wordCount}`
  answered with `{capture, reason}`. The content script measures; the worker
  judges, so the rules exist in exactly one place.
- `PAGE_CONTENT` `{url, title, text, capturedAt}` answered with
  `{ok, id, created, reindexed}`.

Service worker to content script:

- `HIGHLIGHT` `{quote}`, the fallback jump to passage path for a tab that is
  already open or a page that renders late.

Extension pages to service worker:

- `SEARCH` `{query, limit, offset}` returns `{results, total, mode, relaxed, tookMs}`
- `RECENT` `{limit}` returns the newest pages
- `PIN` `{id, pinned}`
- `FORGET` `{scope: 'page' | 'site' | 'day', id | value}`
- `STATS` returns counts, storage use, budget level, observed pace, the
  projected date the budget runs out, and the last few eviction log entries
- `SETTINGS_GET` and `SETTINGS_SET`, which also re-register content scripts
  when the capture mode changes
- `MAINTENANCE` runs the retention sweep on demand, which is also what the
  hourly alarm calls

## The store interface

`core/index-reader.js` never sees IndexedDB. It takes a store, and both
`db/memory-store.js` and `db/idb-store.js` implement the same surface. That
seam is what lets search be tested without a browser, and it is enforced by
one contract file run against both.

| Method | Contract |
|---|---|
| `putPage({url, title, text, lastSeen, pinned})` | Creates, or reindexes in place when the content hash changed, or bumps `visitCount` when it did not. Returns `{id, created, reindexed}`. Refuses a URL that is not http(s). |
| `readTerm(term)` | Every posting for a term across its buckets, sorted by id |
| `readDocs(ids)` | `Map` of id to full page record |
| `readStats()` | `{docCount, totalTokens, avgDocLength}` |
| `listPageMeta()` | Lightweight rows for the eviction planner: id, domain, firstSeen, lastSeen, bytes, pinned. Deliberately excludes text |
| `deletePages(ids)` | Removes pages and their postings, returns `{deleted, bytesFreed}` |
| `setPinned(id, pinned)` | Returns false rather than throwing for an id that is gone |
| `listRecent(limit)` | Newest first |
| `logEviction(entry)` / `readEvictionLog(limit)` | Newest first, insertion order as the tiebreak |
| `close()` | |

## Pure core

`src/core/` contains no `chrome.*` calls at all. That is what makes it unit
testable without a browser, and what would make a Firefox port a packaging
problem rather than a rewrite.

- **`capture-policy.js`** `decide({url, mode, allowlist, rules, hasPasswordField, incognito, paused})`
  returns `{capture, reason}`. Both capture modes route through this one
  function with the mode as a parameter, so they can never drift apart. The
  `reason` string is user facing, which also makes the tests read like
  documentation.
- **`read-heuristic.js`** decides what counts as read, from dwell, scroll
  depth and length. Short pages are exempt from the scroll requirement,
  because there was nothing to scroll.
- **`tokenizer.js`** lowercase, Unicode aware, diacritic folding, and an
  explicit fold of the German sharp s, which NFKD leaves alone and which
  would otherwise keep "Straße" and "Strasse" apart forever.
- **`morphology.js`** the smallest possible amount of stemming: a query term
  with no postings at all gets one attempt at its singular. Applied only as
  a query time fallback, never at index time, so nothing is conflated in
  storage.
- **`url-key.js`** the dedupe key. Conservative on purpose: merging two
  different pages loses data, failing to merge two spellings only costs a
  row, so only unambiguous tracking parameters are stripped and a bare
  `ref` is kept.
- **`bm25.js`** scoring, with corpus statistics passed in rather than read,
  plus a mild logarithmic recency preference.
- **`query-parser.js`** bare terms, quoted phrases, `site:`.
- **`snippet.js`** picks the densest window of query terms and expands to
  sentence boundaries. This is what makes a result recognisable at a glance.
- **`text-fragment.js`** builds the `#:~:text=` URL, following the rules the
  spike established.
- **`eviction.js`** the budget: two caps that both apply, pinned pages
  exempt, plus the pace and projection that let the interface say "full
  around March" instead of a percentage.

## Search pipeline

1. Parse the query.
2. Read postings for each term across the buckets that matter.
3. Intersect with AND semantics by default. If AND returns nothing, fall back to OR and say so in the UI. Half remembered phrases usually contain one wrong word, and a search that returns nothing when four of five terms matched feels broken.
4. Score with BM25, add a mild logarithmic recency boost, and a small boost for matches in the title.
5. For phrase queries, verify with positions.
6. Load the top N page records and build snippets.
7. Return with timing, because the timing goes in the UI and slow search is a bug we want visible.

## Performance, measured

Numbers from `test/browser/run-benchmark.mjs` against real IndexedDB in
Chromium, 1500 synthetic documents averaging 807 tokens, on an ordinary
laptop. Synthetic text has a wider vocabulary than prose, so it is a
pessimistic case for index size.

| What | Measured |
|---|---|
| Indexing one page | 130ms p50, 174ms p95 |
| Indexing, first fifth vs last fifth of the corpus | 113ms then 140ms, so close to flat |
| Known item search, one rare word | 1.1ms p50, 3.8ms p95 |
| One common word plus one selective word | 5.1ms p50, 6.6ms p95 |
| Both words among the most common in the corpus | 51ms p50, 83ms p95 |
| Phrase query on two common words | 46ms p50 |
| Storage | about 15KB per document |

The shape worth knowing: search is fast for the queries people actually
type, because one selective word is enough to bound the work. Queries made
entirely of very common words are the slow case, and they are slow for a
reason that no amount of tuning removes, which is that their posting lists
contain almost every document. If that ever becomes a real complaint, the
fix is to split positions into their own store so the common path never
reads them, not to tune the scorer.

At 15KB per document, a 500MB budget holds roughly 30,000 pages.

## File layout

```
manifest.json
src/
  background/
    service-worker.js      coordinator, omnibox, alarms, the only writer
  content/
    observer.js            dwell, scroll, password fields; a sensor only
  core/                    pure, no chrome.*, fully tested
    capture-policy.js  read-heuristic.js  tokenizer.js  morphology.js
    url-key.js         hash.js            bm25.js      query-parser.js
    snippet.js         text-fragment.js   eviction.js
    index-writer.js    index-reader.js
  db/
    schema.js              stores, indexes, version
    memory-store.js        reference implementation, used by tests
    idb-store.js           the real one
  shared/
    messages.js  settings.js  presets.js  constants.js
  ui/
    search/  popup/  options/
test/
  *.test.js                the Node suite
  store-contract.js        one contract, run against both stores
  fixtures/corpus.js       24 documents for the relevance harness
  browser/
    run-store-contract.mjs  run-e2e.mjs  run-ui-smoke.mjs  run-benchmark.mjs
spikes/
  text-fragment/           the experiment that settled jump to passage
```

Two rules hold this together. Nothing in `core/` imports `chrome.*`.
Nothing except the service worker writes to the database.

## Build order

Steps 1 to 5 are done. Steps 2 to 4 needed no browser at all, which is what
made the test suite worth having before any of the fiddly parts existed.

1. ~~The text fragment spike~~ (done, see the assumption log)
2. ~~`core/` with tests~~ (done: tokenizer, url-key, capture-policy,
   read-heuristic, bm25, query-parser, snippet, morphology, eviction,
   text-fragment)
3. ~~`db/`~~ (done: schema, memory-store, idb-store, one contract for both)
4. ~~Index and search with a relevance harness~~ (done: 44 known item
   queries, gated on mean reciprocal rank)
5. ~~Capture pipeline and service worker wiring~~ (done, end to end through
   the real extension), except that extraction is still
   `document.body.innerText` rather than Readability
6. The search page (a working version exists, it has had no design pass)
7. Setup flow and the two permission modes
8. Budget notices in the interface, and the storage log
9. Omnibox polish
10. Export, and forget by day in the interface
11. Vendoring Readability, replacing the placeholder extraction

## Testing

Four suites, in increasing order of how much they cost to run.

**`npm test`** runs the Node suite: every pure module, plus the store
contract against `memory-store`, plus the relevance harness. No
dependencies, no browser, about a second. This is the one that runs on every
change.

**`npm run test:browser`** runs the same store contract against
`idb-store` in a real Chromium with the extension loaded. One contract, two
implementations. It has already earned its place: `memory-store` returned
eviction log entries written in the same millisecond in the wrong order,
which IndexedDB gets right for free by walking the primary key backwards,
and the contract is what caught the disagreement.

**`npm run test:e2e`** drives the real service worker: capture, revisit,
search, pin, forget a site, run maintenance under a budget small enough to
force eviction, and check the pinned page survived it. This is the suite
that would notice a broken import or a message type nobody handles.

**`node test/browser/run-ui-smoke.mjs`** types into the search page, checks
the highlighting, the keyboard selection, the relaxation notice and that
opening a result carries a text fragment. Pass `--screenshot out.png` to
look at it.

`test/browser/run-benchmark.mjs` is not a test. It answers "what does this
cost" and it is what the numbers above come from.

The relevance harness deserves a note. "Does search feel good" is
unanswerable, so it is replaced by 44 known item queries against a corpus
written as prose with deliberately overlapping vocabulary. The target has to
come back in the top three, and the suite gates on mean reciprocal rank so a
regression fails the build. Its first version scored a perfect 1.000 with
its own known gaps passing too, which meant it was measuring nothing: the OR
fallback was rescuing queries that should have failed. Gap queries are now
reduced to the single word that carries the meaning, so they miss honestly
and stay visible in the output.
