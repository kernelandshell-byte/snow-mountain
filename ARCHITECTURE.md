# Architecture

Companion to `BRIEF.md`. The brief says what we are building and why. This says how it is put together, and it exists mainly to settle the decisions that are expensive to reverse later: the storage schema, the index format, what runs in which context, and the contracts between them.

Everything here is meant to be implementable by someone who has not read the conversation that produced it.

## Assumption log

Design work that rests on an unverified browser behaviour is a trap, so assumptions are tracked explicitly with their status.

### Verified

**Scroll to text fragments work, on a real page, in this Chrome.** Loading `https://en.wikipedia.org/wiki/Okapi_BM25#:~:text=long%20documents%20which%20do%20match%20the%20query%20term` in a fresh tab scrolled to `scrollY 1581` on a 5792px page, landing on the matching passage. Chrome strips the directive from the URL afterwards: `location.href` came back as the plain article URL, and `'fragmentDirective' in document` is true.

Two consequences follow directly:

1. The extension cannot read back whether the match succeeded, because the directive is gone from the URL by the time any script sees it. Firing it is blind unless a content script separately checks where the page ended up.
2. The directive is processed on document load. Re-pointing an already open tab at the same URL with a different directive is a same document navigation and does not re-fire it. Jumping to a passage in a tab that is already open therefore needs the fallback path, not the fragment.

### Unverified, and how to close it

**Whether `chrome.tabs.create({url})` activates the directive the same way.** The browser pane's navigations are a close proxy but not the same code path, and the follow up runs that would have confirmed it were invalidated: the pane stopped rendering (`window.innerHeight` reported 0), and a tab that is not laid out cannot scroll, so every later measurement was meaningless rather than negative.

Close it in the first build session with a throwaway extension: a manifest, a background script that calls `chrome.tabs.create` with a fragment URL, and a content script that reports `window.scrollY` after load. Twenty minutes, and it decides whether jump to passage is nearly free or a week of anchoring code. Do this before building anything that depends on it.

**Whether the fragment survives late rendering content.** Untested on SPAs and pages that hydrate after load. Assume it does not, and let the fallback cover it.

**Whether a service worker can spawn a dedicated `Worker`.** The brief claimed indexing would run in a Web Worker. That claim was written before checking, and MV3 service workers have historically not been allowed to create dedicated workers. Do not build on it either way, because the design below does not need it.

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

Key: `[term, bucket]` compound, where `bucket = id >> 12`, so 4096 documents per bucket.

Value: `{ term, bucket, df, docs: [{ id, tf, pos: number[] }] }`.

Chunking is the important decision here. The two obvious alternatives both fail at scale:

- One record per term holding the whole list means every update to a common term rewrites a record that grows without bound. Write amplification gets brutal fast.
- One record per term and document pair means IndexedDB per record overhead dominates, and reading a common term walks thousands of tiny records.

Buckets of 4096 documents keep updates local, keep reads to a bounded number of records, and let a term's document frequency be assembled cheaply.

Positions are capped at the first 32 occurrences per term per document. That is enough for phrase queries in practice and it stops pathological documents from bloating the index.

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

All messages are `{type, payload}` with types declared as constants in `shared/messages.js`. No string literals at call sites.

Content script to service worker:

- `PAGE_CANDIDATE` `{url, title, hasPasswordField, textLength}` and the reply is `{capture: boolean, reason: string}`. Policy is evaluated in the service worker so the rules exist in exactly one place.
- `PAGE_CONTENT` `{url, canonicalUrl, title, text, excerpt, wordCount, contentHash, capturedAt}`

Service worker to content script:

- `HIGHLIGHT` `{quote}` for the fallback jump to passage path

Extension pages to service worker:

- `SEARCH` `{query, filters, limit, offset}` returns `{results, total, tookMs}`
- `PIN` `{id, pinned}`
- `FORGET` `{scope: 'page' | 'site' | 'day', value}`
- `STATS` returns `{docCount, bytes, budget, oldestDoc, pace}`
- `EXPORT` streams the archive

## Pure core

`src/core/` contains no `chrome.*` calls at all. That is what makes it unit testable without a browser, and it is also what makes a Firefox port later a packaging problem rather than a rewrite.

**`capture-policy.js`**

```
decide({url, mode, allowlist, rules, hasPasswordField, incognito, paused})
  -> {capture: boolean, reason: string}
```

Both capture modes route through this one function, with the mode as a parameter. If the two modes ever fork into separate code paths, the bug where strict mode captures something it should not becomes inevitable. The `reason` string is user facing, shown in a debug view as "skipped: webmail preset", which also makes the tests read like documentation.

**`read-heuristic.js`**

```
isRead({focusedMs, scrollDepth, textLength})
  -> boolean
```

Thresholds live in one config object. Visibility changes stop the timer. An SPA route change resets the candidate, which is the lesson Form Recovery paid for. A page that qualifies twice in one visit captures once, deduped by content hash.

**`tokenizer.js`** Lowercase, Unicode aware, diacritic normalising, punctuation stripped, numbers kept. No stemming, for the reason in the brief. Returns tokens with positions.

**`url-key.js`** The normalisation rules above, as a pure function, with tests covering the tracking parameter list.

**`bm25.js`** `k1 = 1.2`, `b = 0.75` as starting values, both configurable so the relevance harness can tune them. Scoring takes corpus stats as an argument rather than reading them, so it stays pure.

**`query-parser.js`** Bare terms, `"quoted phrases"`, `site:` filter. Date filters can wait.

**`snippet.js`** Given text and match positions, pick the window with the highest density of query terms, expand to sentence boundaries, cap the length, mark the matches. This is what makes a result recognisable at a glance, so it deserves real tests rather than a first draft that ships.

## Search pipeline

1. Parse the query.
2. Read postings for each term across the buckets that matter.
3. Intersect with AND semantics by default. If AND returns nothing, fall back to OR and say so in the UI. Half remembered phrases usually contain one wrong word, and a search that returns nothing when four of five terms matched feels broken.
4. Score with BM25, add a mild logarithmic recency boost, and a small boost for matches in the title.
5. For phrase queries, verify with positions.
6. Load the top N page records and build snippets.
7. Return with timing, because the timing goes in the UI and slow search is a bug we want visible.

## Performance targets

These become assertions in a performance test against a generated corpus, not aspirations in a document.

- Search p95 under 100ms at 20,000 documents
- Capture to indexed under 150ms for a typical article
- Cold service worker to first search result under 300ms
- No structure proportional to corpus size held in memory. Everything is demand loaded.

## File layout

```
manifest.json
src/
  background/
    service-worker.js      coordinator, omnibox, alarms
    capture-pipeline.js    payload to database
    maintenance.js         budget checks, eviction, notices
  content/
    observer.js            dwell, scroll, SPA route changes
    extract.js             Readability wrapper
    highlight.js           fallback jump to passage
  core/                    pure, no chrome.*, fully tested
    capture-policy.js
    read-heuristic.js
    tokenizer.js
    url-key.js
    bm25.js
    query-parser.js
    snippet.js
    index-writer.js
    index-reader.js
  db/
    schema.js              stores, indexes, version
    migrations.js
    pages-repo.js
    postings-repo.js
    meta-repo.js
  ui/
    setup/                 four screen first run
    search/
    popup/
    options/
  shared/
    messages.js
    settings.js
    constants.js           display name lives here, once
test/
```

## Build order

Steps 1 to 4 need no browser, which means fast iteration and a real test suite before any of the fiddly parts.

1. The text fragment spike from the assumption log
2. `core/` with tests: tokenizer, url-key, capture-policy, read-heuristic
3. `db/` schema and repositories, with a synthetic corpus generator
4. index-writer, index-reader, bm25, and the relevance harness: 30 known item queries where the right page has to land in the top three, run in CI, failing the build on regression
5. Content script capture and the service worker pipeline, end to end into the database
6. Search page
7. Setup flow and the two permission modes
8. Budget, meter, eviction, storage log
9. Omnibox
10. Export, pause, forget
11. Jump to passage, fragment path plus fallback

## Testing

Unit tests for everything in `core/`, which is most of the logic. jsdom tests for the content script, capture flow, password field exclusion and SPA navigation, in the style Form Recovery already uses. A fixture set of saved real pages covering news, documentation, forums, SPAs, cookie walls and paywalls, asserting on extraction shape. The relevance harness from step 4, treated as a test that can fail rather than a benchmark nobody reads. A migration test as soon as a second schema version exists.
