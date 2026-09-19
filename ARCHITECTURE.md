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

### Verified: a service worker cannot ask for persistent storage

`StorageManager.persist()` is exposed to windows and not to workers. In the
service worker `navigator.storage.persist` is `undefined`, while `persisted()`
is there and answers, which is exactly the shape of a bug that never throws. An
earlier version of this asked from the worker, which meant it never asked at
all, silently, for ever.

Asking therefore happens from the pages: setup, which everybody passes through
once, and settings, which is where the answer is reported if it was refused.
Whether Chrome says yes is Chrome's business and an automated profile is always
refused, so what this extension is responsible for is asking from somewhere the
question can be asked at all, and saying so when the answer is no. See
`shared/persistence.js`.

The manifest also asks for `unlimitedStorage`, which is the only mechanism an
extension has for exemption from quota eviction, and which carries no
permission warning.

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

Key: auto increment. Fields: `at`, `reason` (`age` | `size` | `both` |
`manual` | `siteRule`), `count`, `bytesFreed`, `counts`, `rounds`. This is what
the storage log in the UI reads. Nothing is ever removed without a row here.

A row is written as each sweep round commits, so an interrupted sweep has still
said what it removed; consecutive rounds with the same reason inside ten
minutes merge into the row they started. One sweep is one event to the person
reading it, and twenty rows of it would push a year of history out of a list
that shows fifteen. The store is capped at `EVICTION_LOG_MAX` rows and trimmed
from the oldest end, because this is the one list here that would otherwise
grow for ever.

### What the sweep and the one-off actions read

Four reads exist so that nothing walks the whole archive to do a job
proportional to a handful of pages.

| Method | What it avoids |
|---|---|
| `oldestPages(limit, before)` | The sweep reading every page record, text included, once an hour |
| `pageIdsByDomain(domain)` | "Never keep this site" scanning the archive from the popup while somebody waits |
| `pageIdsBetween(from, to)` | The same for "forget this day" |
| `listPagesFrom(afterId, limit)` | An export holding every page of text in one message and one string |

`listPageMeta()` still exists and is still in the contract; nothing in the
service worker calls it any more.

## Migration policy

This is the part the Session Buddy failure was about, so it is a rule, not a preference.

1. The schema version lives in both the IndexedDB version and a `meta` row, and they are checked against each other at startup.
2. An upgrade never transforms a store in place. It builds the new store alongside the old one.
3. The old store is deleted only after a verification pass confirms the new one holds the expected record count and passes a sample integrity check.
4. If anything throws, the old data is still there, and the extension shows a clear error instead of an empty list. An empty list must never be the way a user learns a migration failed.
5. If the database version is newer than the running code expects, which is what a downgrade looks like, refuse to start rather than mangling anything.
6. After a successful migration, tell the user once what happened.

All six are `db/migrations.js` rather than a paragraph somebody remembers, and
the reason points two to four are cheap is that IndexedDB gives them away if
everything happens inside the one versionchange transaction: a throw aborts it,
and an aborted versionchange transaction leaves the database exactly as it was,
at its old version. So the transaction rule from the data model applies harder
here -- every `await` resolves from a request belonging to that transaction,
because awaiting anything else commits it half done, which is the precise shape
of the bug this whole policy exists to prevent.

`rebuildStore` is the general move: stage the transformed records in a scratch
store, count them at both ends, let the caller sample the result, and only then
delete the old store, recreate it with its new indexes, and copy back. A throw
anywhere in that undoes all of it.

There is still only schema version 1, so `MIGRATIONS` is empty and the
machinery is driven by fixture migrations in `test:migration` instead --
including one that throws part way, one whose verification refuses the result,
and one that would quietly drop a third of the records. Each has to leave a
version 1 database with every page, every posting and a working search. The day
a second version is needed is a bad day to find out whether any of this works.

Writing that suite found one thing immediately: `onblocked` used to reject the
open. It is not a failure. It means another connection is still open, and the
open carries on by itself the moment that one goes away -- which includes this
extension's own handle, since `close()` returns before the connection has
actually gone. Rejecting turned an upgrade that would have worked into one that
never ran. It now rejects only if the other connection never lets go.

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
| `listPageMeta()` | Lightweight rows: id, domain, firstSeen, lastSeen, bytes, pinned. Deliberately excludes text |
| `oldestPages(limit, before)` | The same rows for the oldest pages by `lastSeen`, at most `limit`, optionally only those before a cutoff. What the sweep reads instead of the whole archive |
| `pageIdsByDomain(domain)` / `pageIdsBetween(from, to)` | Ids only, off an index, for forgetting a site or a day |
| `listPagesFrom(afterId, limit)` | Whole records by primary key, for walking the archive during an export |
| `deletePages(ids, {batch, signal})` | Removes pages and their postings, returns `{deleted, bytesFreed}`. Split across transactions, so a large job keeps the progress it made and lets other work through |
| `setPinned(id, pinned)` | Returns false rather than throwing for an id that is gone |
| `listRecent(limit)` | Newest first |
| `logEviction(entry, {merge, now})` / `readEvictionLog(limit)` | Newest first, insertion order as the tiebreak. `merge` folds consecutive rounds of one sweep into a single row |
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
  storage. If that also finds nothing, the term is widened to the words it
  is the start of. See "Half a word" below.
- **`url-key.js`** the dedupe key. Conservative on purpose: merging two
  different pages loses data, failing to merge two spellings only costs a
  row, so only unambiguous tracking parameters are stripped and a bare
  `ref` is kept.
- **`bm25.js`** scoring, with corpus statistics passed in rather than read,
  plus a mild logarithmic recency preference.
- **`query-parser.js`** bare terms, quoted phrases, `site:`, `before:`/`after:`,
  and `-word` to exclude a term.
- **`snippet.js`** picks the densest window of query terms and expands to
  sentence boundaries. This is what makes a result recognisable at a glance.
- **`text-fragment.js`** builds the `#:~:text=` URL, following the rules the
  spike established.
- **`eviction.js`** the budget: two caps that both apply, pinned pages
  exempt, plus the pace and projection that let the interface say "full
  around March" instead of a percentage, and `clockLooksWrong`, which delays
  the age rule for one sweep when time has moved in a way an hourly alarm
  cannot account for.
- **`content-change.js`** what to do when a page you already have comes back
  much smaller, which is usually a paywall rather than an edit. See below.

## Search pipeline

1. Parse the query.
2. Read postings for each term across the buckets that matter.
3. Intersect with AND semantics by default. If AND returns nothing, fall back to OR and say so in the UI. Half remembered phrases usually contain one wrong word, and a search that returns nothing when four of five terms matched feels broken.

   Note what AND does and does not require. Bare terms have to appear in the
   page, and that is all: not in the order typed, not next to each other, not
   in the same sentence. Order and adjacency are opt-in, through quotes, and
   are verified against stored positions. So "retro fatigue teams" finds a
   page carrying all three words anywhere in it, which is the shape a half
   remembered query actually has.
4. Score with BM25, add a mild logarithmic recency boost, and a small boost for matches in the title.
5. For phrase queries, verify with positions.
6. Load the top N page records and build snippets.
7. Return with timing, because the timing goes in the UI and slow search is a bug we want visible.

## Half a word

`BRIEF.md` says prefix matching is what stands in for stemming, on the grounds
that an English stemmer damages German and Dutch and no stemming at all leaves
the commonest near miss unhandled. Typing half a word is that near miss: "isra"
should find the article about Israel.

The rule is that widening is a **fallback and never a default**. A term with
postings of its own is searched exactly, always. Only a term that found
nothing, and has at least `MIN_PREFIX_CHARS` characters, is widened to the
terms it is the start of. That ordering is the whole design:

- It cannot make a working query worse. "car" has postings, so "car" is never
  quietly turned into carbon, carry and cardigan, and precision on ordinary
  queries is untouched.
- It costs nothing on the common path. The widening read only happens for a
  term that already came back empty, which for a word somebody meant to type
  is rare.
- It is the same shape as the two relaxations already here, the singular
  attempt and the OR fallback: try the strict thing, relax only on failure,
  and say in the interface that you did. A search that quietly answers a
  different question is worse than one that finds nothing.

The read is a range scan rather than a search, because the postings key is
`[term, bucket]` and IndexedDB already keeps it in order: everything from
`[prefix]` to `[prefix + '\uffff']` is exactly the terms starting with the
prefix. Terms are returned most widely used first and capped, with the walk
bounded separately from the result, because a three letter prefix in a large
archive can start thousands of words.

The matched terms are then treated as one term: a page carrying "israel" twice
and "israeli" once has three reasons to match "isra", and counting them as
three is what makes the ranking sensible. A widened term scores at
`PREFIX_SCORE_FACTOR`, which only changes anything when a query mixes a widened
term with an exact one, and there the exact one should carry more of the
answer.

Two things are deliberately excluded. A term inside a quoted phrase is never
widened, because a phrase is checked against stored positions and the merged
positions of several different words do not describe any real sentence. And
matching is on the start of a word only, never the middle, so "sola" does not
find "isolation".

## The storage sweep

Runs hourly on an alarm, and on demand from settings. Two caps apply at once
and whichever binds first wins; pinned pages are exempt from both, which is
what makes accepting a budget safe.

It is written as rounds rather than one pass, for three separate reasons that
all turned up under test at ten and thirty thousand pages.

**It reads only what it might delete.** Only the oldest pages can be evicted by
either rule, so a round reads the oldest `EVICTION_SCAN` pages by `lastSeen` --
and when nothing is over the size cap, only those older than the retention
cutoff. With nothing expired and nothing over the cap it reads nothing at all,
which is what almost every hourly run should cost: **10ms against an archive of
10,000 pages**. The version before this called `listPageMeta()`, which cursors
every page record, text included, to pick six fields off each. `planEviction`
is still the pure function that decides; it takes the archive's real
`totalBytes` alongside the slice, because a slice cannot say how far over the
cap things are.

**It deletes a page at a time.** A single transaction covering thousands of
pages holds a write lock for minutes, and Manifest V3 stops the worker whenever
it likes: an all-or-nothing sweep that is always interrupted would achieve
nothing, forever. Small transactions keep whatever finished, which is checked
by stopping the worker in the middle of one and watching the count drop and
stay dropped.

**It lets go between them.** IndexedDB starts transactions in creation order,
and one search is not one transaction -- it reads a posting list per word and
then the pages, each created only after the last resolved. A sweep that never
yields creates its next batch before a waiting search has created anything, so
the search ends up behind the whole queue instead of behind one piece of it. A
timer between batches fixes the ordering, and then the batch size decides the
wait. The numbers are in `DELETE_BATCH`, and they include what the choice
costs: one page at a time is about sixty percent slower to get through, in
exchange for search latency five times better. That is the right way round,
because search is what somebody is waiting for and the sweep is a background
job with nothing waiting on it.

A sweep also gives up its turn after `MAX_SWEEP_MS` rather than running until
Chrome stops it. What is left is picked up by the next alarm, and the progress
made is kept.

**The clock.** A laptop that comes back from sleep set to next year makes every
page look expired, and an hourly sweep would then delete a year of reading in
one go with no way back. The archive cannot tell the time any better than the
machine can, but it can notice that time has moved in a way an hourly alarm
cannot account for: `lastSweepAt` is kept beside the settings, and if `now` is
more than a week past it, or before it, the age rule is suspended for that run
and settings says why. The size rule needs no clock and carries on regardless.
A machine genuinely switched off for a fortnight pays one hour of delay for
this.

What this buys is one hour, and that is worth stating rather than claiming
more. `lastSweepAt` is written on every sweep, including the one that suspended
the age rule, so a clock that is wrong and stays wrong looks perfectly ordinary
to the next sweep an hour later, and that one applies the age rule against next
year's cutoff. For the case this was built for, a machine switched off for a
fortnight, an hour of delay is the whole cost and the guard is exactly right.
For a clock that is genuinely wrong it is a pause rather than a rescue, and no
value of `CLOCK_JUMP_MS` changes that, because the second sweep never sees a
jump. What would hold is a ceiling on how much one sweep may remove under the
age rule, which would cover every other way a cutoff can come out wrong as
well. Not built.

**The badge** is raised only for something that can be acted on. An archive
sitting at its cap and replacing its oldest pages is not that: it stays at
ninety-nine percent of the cap by design, and a permanently lit badge is one
nobody reads. It is raised when the cap cannot be met at all, which in practice
means more has been pinned than the cap allows, and when the disk itself has
run out. Chrome clears the badge on restart, so a state that still cannot be
acted on raises it again at startup -- a warning that only ever appears once is
not a warning.

The hourly alarm is also re-created at startup rather than only at install. An
alarm survives a restart but not a profile that lost it, and an extension whose
only sweep was scheduled once at install would quietly stop applying the budget
for ever.

## What a page costs

The budget is the promise this extension makes about its footprint. "Use at
most 500MB" is a sentence in the settings screen, the meter is on the popup,
and eviction is enforced against the number behind both. If that number is not
what is on disk then the promise, the meter and the sweep are all wrong
together, and nothing in the interface can tell you.

It was wrong. A page's `bytes` was `byteLength(text) + byteLength(title)` and
nothing else, so the meter reported about a fifth of what the archive actually
occupied, and a 500MB cap was really a 2.4GB one. The index is not a rounding
error on an archive: measured against a realistic six thousand word vocabulary,
the postings weigh nearly three times the page records they index. The setup
screen's "room for roughly 34,000 pages", which comes from
`BYTES_PER_PAGE_ESTIMATE` and has always assumed 15KB a page including its
index, disagreed with the extension's own meter by a factor of five.

`bytes` now covers all three parts of what a page costs:

- **The page record**, which is not just its text: the URL twice, as captured
  and normalised, the domain, the title, a four hundred character excerpt that
  duplicates the start of the text, a content hash, five numbers and the field
  names. About five hundred bytes a page. `schema.js` counts it from the
  fields rather than by serialising the record, because serialising means
  running `JSON.stringify` over two hundred kilobytes of text on every capture
  to learn something about the other five hundred bytes.
- **An entry in a posting list** for each distinct term, `{id, tf, pos}`.
- **The record that holds those entries**, charged once, to whichever document
  first mentions that term in that bucket, because that is the document whose
  write creates it. Up to 255 others then join it for the cost of an entry
  each, which is what actually happens on disk. Charging every document for the
  whole record instead overstated a 2,000 page archive by 88%.

The two index constants are solved against a measured archive rather than
counted off the JSON shapes, because IndexedDB stores structured clones and
keys, not the JSON they resemble. `test:storage` does the measuring, by
serialising every record in both stores, and fails if the meter drifts more
than a tenth from it at any of three corpus sizes, or if either number drifts
as the archive grows, or if a page of an odd shape is badly mis-counted.

What that measures is what the archive's records weigh, not what is on the
disk, and the difference is not a detail. The same 2,000 page archive occupies
28.7MB immediately after it is written and 15.3MB once a reopen has triggered
compaction, because LevelDB holds its write-ahead log and uncompacted files
until something clears them, and Snappy compresses what is left. On a corpus of
real prose the same two states are 47.3MB and 15.1MB. Nothing about the archive
changes between those numbers.

So the budget is a promise about what the archive holds, and not a claim about
bytes on a disk. It has to be, because a figure that moves by a factor of three
between compactions is not something eviction can be enforced against. On disk
the archive will sometimes be half what the meter says and sometimes twice it.

| pages | meter | page records | index | total serialised | the meter counts |
|---|---|---|---|---|---|
| 500 | 6.2MB | 1.7MB | 4.5MB | 6.2MB | 100% |
| 1,000 | 12.4MB | 3.3MB | 9.1MB | 12.4MB | 100% |
| 2,000 | 24.7MB | 6.6MB | 18.5MB | 25.1MB | 98% |

`navigator.storage.estimate()` cannot settle any of this either, though not
because it is wrong. It is approximate and it includes things that are not
ours, and the 15KB and then 29.6KB a document it reported for two runs of the
same benchmark on the same corpus is the compaction swing above, caught in two
different states. It reports something real that genuinely moves, which is
precisely what a budget cannot be enforced against.

## Settings are not to be trusted

Settings come back from `chrome.storage.local`, and storage can hand back
something that is not settings at all: a profile copied between machines, a
half written value, an older build's shape, an extension interrupted mid save.

This is not a tidiness concern. `retentionMonths` arriving as `null` made the
retention cutoff `now`, which expired every page in the archive on the next
hourly sweep -- all of it, silently, because a default parameter only applies
to `undefined`. A settings file being slightly wrong must never be able to
delete somebody's year of reading, so `normaliseSettings` checks every field
where they are loaded, and `planEviction` guards the retention window again
where it is used. Belt and braces, for the one operation here that cannot be
undone.

## A page that comes back smaller

The usual revisit is harmless: an article gains a correction, a docs page gains
a paragraph, and reindexing is right. One case is not. You read something in
full, and weeks later the same URL serves three paragraphs and a subscribe
button, or a consent wall, or a takedown stub. Reindexing that replaces what
you read with what you are now allowed to read, and the one thing this
extension exists to do stops working for exactly the pages most worth keeping.

So a revisit that would replace a substantial page with one under forty percent
of its length is treated as a revisit and nothing more: the visit is counted,
the date moves, and the text that was read is kept. The cost is a page that
really was shortened staying stale in the index. That is the right way round --
a stale copy of something you read can still be found, and a lost one cannot.
Keeping the page explicitly overrides all of it, because at that point the
person can see what is on the screen and is saying to keep that.

## Export

Export is handed out a slice at a time, keyed by the last id seen, and the
settings page assembles the file from those slices as separate strings in one
`Blob`.

The obvious version reads every page and returns one object. At fourteen
kilobytes a page that is hundreds of megabytes in a single message and, once
the receiving side calls `JSON.stringify` on it, in a single string as well.
Neither survives a real archive, and the failure is an out of memory crash
rather than an error anybody can act on.

## One visual system

Four surfaces used to carry four palettes, four type scales and four copies of
the same reset, which is why they looked like three tools that happened to ship
together. Everything shared now lives in `ui/shared/base.css`: colour, a single
type scale, buttons, fields, the storage meter, the row list, and the callout
used for the handful of things that have to be noticed rather than read.

Two rules came out of doing it. Every text colour clears 4.5:1 against every
surface it is allowed to sit on, which `test:presentation` checks and which
caught the metadata grey at 3.4:1. And the selected search result is marked by
an accent bar as well as a tint, because keyboard is the primary way through
that list and a tint alone is not enough to tell it apart from the tint next to
it.

## Capture modes, and what makes strict mode true

Strict mode is the one claim here that is meant to be enforced by Chrome rather
than promised by us, and it only is if switching away from broad mode actually
hands the wide host permission back. Leaving it granted and merely
unregistering the content scripts looks identical from inside the extension and
is a lie on Chrome's own permissions screen.

So settings has the mode switch, switching to strict calls
`permissions.remove()` before saving, switching back calls
`permissions.request()` first and does not save if Chrome says no, and removing
a site from the strict mode allowlist takes back that site's origins too.
`permissions.request` has to be the first statement in its click handler:
awaiting anything before it spends the user gesture and Chrome refuses.

**Registering for a site Chrome will not allow.** The allowlist and the granted
permissions are two records of one intention and they drift: a permission can
be taken back from Chrome's own settings screen without this extension hearing
about it in a form it can act on. `registerContentScripts` rejects the whole
call rather than the bad entry, so a single stale row used to stop capture on
every other site in the list, silently, for ever. That is the worst kind of
bug this project can have: capture failing leaves nothing behind to notice,
and an empty result looks like a page you never read rather than one that was
never kept.

So the allowlist is checked against `permissions.contains` before anything is
registered, a registration that still fails is retried one site at a time so
that one bad entry cannot take the others down with it, and what is left
unwatched is written where settings can say so out loud.

## A limit somebody else chose is not a limit

Both budget controls are a short list of presets plus a custom field, and
neither has a ceiling. The presets are there because most people want one of
them and should not have to do arithmetic. The custom field is there because
the archive is on somebody's own disk, `unlimitedStorage` means Chrome is not
the thing stopping them, and a maximum picked by the author is a judgement
about how much reading a stranger is allowed to keep.

Two things sit next to the number, both in `ui/shared/limits.js` so setup and
settings cannot drift. The size is quoted back in pages as it is typed, because
a figure in gigabytes means nothing and a figure in pages means something. And
a limit below what is already stored says so before it is saved, naming how
many of the oldest pages the next sweep would remove and that pinned pages are
exempt. Lowering the cap is the one control here whose consequence cannot be
undone, and being told afterwards is not being told.

## Performance, measured

Numbers from `test/browser/run-benchmark.mjs`, `run-longterm.mjs` and
`run-delete-batch.mjs` against real IndexedDB in Chromium. Synthetic text has a
wider vocabulary than prose, so the benchmark corpus is a pessimistic case for
index size.

Through the real service worker, on the long-term corpus of 340 token pages,
which is closer to what a real archive holds:

| What | 4,000 pages | 10,000 pages | 30,000 pages |
|---|---|---|---|
| Bytes per page, meter | 5,898 | | |
| Indexing one page, through import | 31ms | 34ms | 41ms |
| **An hourly sweep with nothing to do** | **6ms** | **10ms** | **8ms** |
| Eviction | 50ms per page removed | 47ms | |
| Search during a sweep | 147ms p50, 246ms worst | 162ms p50, 240ms worst | |

The idle sweep is the one worth staring at. It does not grow with the archive
because it reads nothing when there is nothing to remove, which is what almost
every hourly run is. The version that called `listPageMeta()` read the lot.

The 10,000 and 30,000 page figures were measured before the storage accounting
was corrected, so their bytes-per-page numbers counted text alone and are not
repeated here; the timings are unaffected, since nothing about what the sweep
reads depends on what the meter says. `test:storage` is where the size
question is answered now.

Benchmark corpus, 807 tokens per document:

| What | 1,500 docs | 6,000 docs |
|---|---|---|
| Indexing one page | 110ms p50, 150ms p95 | 118ms p50, 159ms p95 |
| Known item search, one rare word | 0.9ms p50, 1.5ms p95 | 1.1ms p50, 6.3ms p95 |
| One common word plus one selective word | 4.6ms p50, 8.9ms p95 | 20ms p50, 30ms p95 |
| Both words among the most common | 37ms p50, 69ms p95 | 74ms p50, 128ms p95 |
| Phrase query on two common words | 42ms p50 | 65ms p50 |
| Storage | 16KB per document | 14KB per document |

Deleting 400 pages while searching every 80ms, which is what decides
`DELETE_BATCH`:

| batch | typical search | worst | sweep, alone |
|---|---|---|---|
| 10 | 520ms | 1237ms | 8s |
| 3 | 224ms | 465ms | 10s |
| 1 | 93ms | 253ms | 13s |

The shape worth knowing about search: it is fast for the queries people
actually type, because one selective word is enough to bound the work. Queries
made entirely of very common words are the slow case, and they are slow for a
reason no amount of tuning removes, which is that their posting lists contain
almost every document. If that ever becomes a real complaint, the fix is to
split positions into their own store so the common path never reads them, not
to tune the scorer.

Two things are deliberately flat rather than fast: the popup statistics and the
recent list do not move between four and thirty thousand pages, because neither
reads the archive. The statistics come from a running total kept in `meta` and
one cursor step on an index; the recent list is a cursor on `lastSeen`.
Anything on the path that opens the popup has to stay that way.

Eviction is the expensive operation, at around fifty milliseconds a page,
because removing a page recomputes its terms from its text instead of storing a
term list -- which would cost roughly forty percent on top of the text,
permanently, to make an hourly background job faster. That is the trade, and it
is why the sweep is written to stay out of the way rather than to be quick.

At around 13KB a page for a realistic vocabulary, counted properly, a 500MB
budget holds roughly 38,000 pages, and `BYTES_PER_PAGE_ESTIMATE` is
deliberately a little pessimistic at 15KB so the interface promises fewer
pages than it delivers.

Scale has been run to 30,000 pages: 30,000 seeded through the real import path,
index invariants consistent, an idle sweep at 8ms. The eviction phases at that
size were interrupted by the machine rather than by anything the extension did,
and are proven at 10,000.

## File layout

```
manifest.json
src/
  background/              the only context that writes to the database
    service-worker.js      every listener, registered synchronously; nothing else
    store-handle.js        the one connection, and the rules for keeping it
    content-scripts.js     registering where the extension may watch
    capture.js             candidate to stored page
    open-result.js         opening a result, and what to say about this tab
    archive.js             allow, block, export, import, forget, wipe
    maintenance.js         the sweep, and the numbers the meter shows
  content/
    observer.js            dwell, scroll, password fields; a sensor only
  core/                    pure, no chrome.*, fully tested
    capture-policy.js  read-heuristic.js  tokenizer.js  morphology.js
    url-key.js         hash.js            bm25.js      query-parser.js
    snippet.js         text-fragment.js   eviction.js  content-change.js
    index-writer.js    index-reader.js    quote-match.js
  db/
    schema.js              stores, indexes, version
    migrations.js          the policy, as code
    memory-store.js        reference implementation, used by tests
    idb-store.js           the real one
  shared/
    messages.js  settings.js  presets.js  constants.js  format.js
    persistence.js         asking Chrome not to throw the archive away
  ui/
    shared/base.css        one palette, one type scale, one set of controls
    shared/when.js         "last month", not "1 months ago"
    shared/limits.js       the budget controls, shared by setup and settings
    setup/  search/  popup/  options/
test/
  *.test.js                the Node suite
  store-contract.js        one contract, run against both stores
  fixtures/corpus.js       24 documents for the relevance harness
  browser/
    invariants.mjs          what must be true whatever happened
    harness.mjs             a copy of the extension with the grant shortcut
    run-*.mjs               one file per suite; see Testing
spikes/
  text-fragment/           the experiment that settled jump to passage
```

Two rules hold this together. Nothing in `core/` imports `chrome.*`.
Nothing except the service worker writes to the database.

## Build order

Everything here is done. Steps 2 to 4 needed no browser at all, which is what
made the test suite worth having before any of the fiddly parts existed.

1. ~~The text fragment spike~~ (see the assumption log)
2. ~~`core/` with tests~~
3. ~~`db/`, one contract run against both stores~~
4. ~~Index, search and the relevance harness~~
5. ~~Capture pipeline and service worker wiring~~
6. ~~The search page~~ (works, keyboard first, no design pass yet)
7. ~~Setup flow and the two permission modes~~
8. ~~Budget, meter, eviction, storage log~~
9. ~~Omnibox~~
10. ~~Export, pause, forget~~
11. ~~Readability, replacing the placeholder extraction~~

12. ~~Import, and the current page controls in the popup~~
13. ~~Search filters, sorting and paging~~
14. ~~A year put through it: both caps biting, restarts, a worker stopped
    mid sweep, sixty days of ordinary use~~
15. ~~What the browser and the operating system do to it: a wrong clock, a
    database from a newer build, settings that are not settings~~
16. ~~The migration policy, written as code and driven by migrations that
    fail~~
17. ~~The limits: an export bigger than a message, persistent storage, a full
    disk, housekeeping that has to survive a restart~~
18. ~~Switching capture modes, and making strict mode true~~

Icons are in `icons/`, the licence is MIT with Readability's Apache 2.0 kept
beside it, and `PRIVACY.md` and `THREAT-MODEL.md` are written. The threat
model is the one worth rereading before publishing, because it is where the
claim about network access is stated precisely enough to be checked and
weakly enough to be true.

The `favicon` permission was dropped on the way: nothing ever used it, and a
permission a reader has to take on trust for no return is the opposite of what
the brief asks for.

## Testing

Twenty-two suites. One runs in Node, the rest drive a real Chromium with the
extension loaded.

**`npm test`** is the Node suite: every pure module, the store contract
against `memory-store`, and the relevance harness. No dependencies, about a
second, runs on every change.

The browser suites need Playwright (`npm install --no-save playwright`):

| Command | What it holds down |
|---|---|
| `test:browser` | the store contract against real IndexedDB |
| `test:capture` | a page read with real dwell and scrolling, plus pause, rules and a single page app changing route |
| `test:journey` | one whole session: setup, read, popup, search, open, pin, sweep, export |
| `test:e2e` | capture, revisit, search, pin, forget, eviction, through the worker |
| `test:extraction` | Readability against a page full of navigation, banners and footers |
| `test:real-pages` | extraction against 32 real page snapshots: newspapers, blogs, a wiki, docs, a spec, fiction, tables |
| `test:shapes` | the page shapes that are not articles: forums, feeds, video pages, dashboards, chats, paywalls |
| `test:highlight` | jump to passage when a fragment cannot fire |
| `test:setup` | the setup flow, including a refused permission |
| `test:options` | settings, and the export to import round trip |
| `test:popup` | the current page controls, including strict mode granting |
| `test:ui` | the search page: typing, filters, sorting, paging, keyboard |
| `test:adversarial` | awkward content, hostile queries, concurrency, a stopped worker |
| `test:resilience` | storage deleted underneath, a worker killed mid write, a browser restart |
| `test:consistency` | randomised churn, then the invariants that must always hold |
| `test:presentation` | dark mode, a 360px window, and using it without a mouse |
| `test:longterm` | a year of accumulation, both caps biting, sixty days of ordinary use, and four browser restarts |
| `test:hostile` | a wrong clock, a database from a newer build, two tabs filing one page at once, corrupted settings, an article that has since gone behind a paywall |
| `test:migration` | the migration policy, including three migrations that fail in different ways |
| `test:limits` | an export bigger than a message, persistent storage, a full disk, an alarm a profile lost |
| `test:storage` | whether the meter is telling the truth about what the archive holds |

`run-benchmark.mjs` and `run-delete-batch.mjs` are not tests. It answers "what does this cost", and it
is where the numbers above come from.

Eight of these deserve explaining.

**The adversarial suite** goes looking for trouble rather than confirming
the happy path: right to left text, a language without spaces between words,
a page that is one 50,000 character word, emoji, queries made of regular
expression metacharacters, a lone surrogate, six operations at once, the
same page captured twice simultaneously, an import full of rubbish, and the
background worker being stopped underneath everything. It found five real
bugs the first time it ran.

**The consistency suite** runs a randomised but reproducible sequence of
writes, rewrites, deletes and pins, then opens the database directly and
checks what must always be true: the running totals match the pages that
exist, no posting points at a deleted page, no empty posting records are
left behind, every page sits in the bucket its id belongs to, and every word
of every page is findable while nothing else is. That last pair is the one
that matters. An index that has drifted does not throw; it just quietly
stops finding things, or starts returning pages that no longer contain the
word.

**The long-term suite** is the only one that answers what a year does to it.
It seeds pages spread over fourteen months through the real import path, so
they can be backdated, then makes both caps actually bite: the retention limit
with one old page pinned, one left to expire and one revisited today, so the
sweep has to tell them apart; then the size cap, shrunk under what is stored.
In between it closes and reopens the browser four times, kills the worker in
the middle of a sweep, and searches while a sweep is deleting. Then sixty
simulated days of a dozen pages in and a sweep after each, which is the state a
real archive spends its life in and the only place a slow leak in the index
would show. The invariants are checked after every single sweep. It found the
sweep reading the whole archive once an hour, an all-or-nothing delete
transaction that an interrupted worker rolled back to nothing, searches waiting
seventeen seconds behind a sweep, and a warning badge permanently lit by an
archive doing exactly what it was told.

**The hostile suite** is about the things the browser and the operating system
do to it rather than the things a person does. A laptop that comes back from
sleep with next year's clock. A database left behind by a newer build, which is
what installing an older one over it looks like. Two tabs finishing in the same
millisecond and both filing the same URL, against a unique index. Settings that
come back from storage as a string. A page three times the size cap, and one
word repeated fifteen thousand times. An article that has since gone behind a
paywall. It found that a `retentionMonths` of `null` expired the entire
archive, that a null preset list took the capture policy down with it, and that
an archive which could not be opened was described to the user as an empty one
-- "nothing kept yet", after a year -- which is exactly how somebody decides
the extension is broken and throws away an archive that was fine.

**The migration suite** drives the policy with fixture migrations, because
there is only one schema version and waiting for a second one would mean
finding out whether the policy works on the day it matters. Three of its
migrations fail on purpose, and each has to leave a version 1 database with
every page, every posting and a working search.

**The limits suite** covers the failures that do not happen on a test archive
and do happen on a real one: an export too big for one message, storage Chrome
has not promised to keep, a disk with nothing left on it, and an hourly alarm a
profile lost. It found that `navigator.storage.persist()` was being called from
a service worker, where it does not exist.

**The storage suite** asks the one question the storage meter cannot be trusted
to answer about itself, and found the meter counting a fifth of what was on
disk. See "What a page costs".

Two notes on how these are built.

`test/browser/harness.mjs` copies the extension to a temporary directory and
adds `host_permissions` before loading it. Granting an optional permission
needs a click on a Chrome dialog that automation cannot reach, so the two
suites that inject into real pages use that copy. The code under test is the
real code; only the grant is shortcut. The shipped manifest still asks for
nothing at install.

The relevance harness deserves its own note. "Does search feel good" is
unanswerable, so it is replaced by 44 known item queries against a corpus
written as prose with deliberately overlapping vocabulary. The target has to
come back in the top three, and the suite gates on mean reciprocal rank so a
regression fails the build. Its first version scored a perfect 1.000 with
its own known gaps passing too, which meant it was measuring nothing: the OR
fallback was rescuing queries that should have failed. Gap queries are now
reduced to the single word that carries the meaning, so they miss honestly
and stay visible in the output.
