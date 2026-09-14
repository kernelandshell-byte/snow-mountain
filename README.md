# Snow Mountain

A local full text memory for your browser. Everything you actually read gets indexed on your own machine, so you can find it later by any phrase you remember.

Working title. See the naming note at the end of `BRIEF.md`.

- `BRIEF.md` is what this is and why, including the privacy model and v1 scope.
- `ARCHITECTURE.md` is how it is built, and it settles the decisions that are expensive to reverse.
- `spikes/` holds throwaway experiments that answered a question, kept so the answers stay reproducible.

## State

It works. Set it up, read some pages, search them back, land on the
paragraph that matched.

- The pure core: tokenising, capture policy, read heuristic, BM25, query
  parsing, snippets, the storage budget, quote matching, text fragment URLs
- Two stores, `memory-store` and `idb-store`, held to one contract that runs
  against both
- Search with an AND to OR fallback, a singular fallback for plurals, site
  and date filters, sorting, and paging
- Jump to passage: a text fragment for a new tab, and a highlight in place
  for a tab already open or a page that renders late
- Extraction through vendored Readability, injected only into pages that
  have earned it
- A four screen setup flow that requests host access at the moment it is
  explained, and asks for nothing at all in strict mode
- A popup about the page in front of you: whether it is kept, why not if it
  is not, and one click to keep it, forget it, or never keep that site again
- Settings with exclusion bundles, custom rules, the storage meter, the
  deletion log, export, import and delete everything
- A storage budget with two caps, an hourly sweep that reads only what it
  might delete, pinning that eviction can never touch, a storage log, a clock
  guard so a laptop that wakes up in next year cannot delete a year of reading,
  and a meter that counts the index as well as the text, because the index is
  most of an archive
- A migration policy that is code rather than a paragraph: build the new
  shape alongside the old, verify it, and only then give up the old one, all
  inside one transaction so a failure leaves the archive exactly as it was
- 177 Node tests and 625 browser checks across twenty-two suites, including
  extraction against 32 real page snapshots, the page shapes that are not
  articles at all, a resilience suite that deletes the database underneath a
  running extension, a consistency check that churns the index and then
  verifies it has not drifted, a year of accumulation with both caps biting,
  and a migration suite whose failing migrations all have to leave the old
  database untouched

## Tests

```
npm test                              # 177 Node tests, no dependencies, about two seconds
npm install --no-save playwright      # only needed for the browser suites

npm run test:browser                  # the store contract against real IndexedDB
npm run test:e2e                      # capture, search, pin, forget, evict, through the real worker
npm run test:extraction               # Readability against a page full of clutter
npm run test:setup                    # the setup flow, including a refused permission
npm run test:options                  # settings, capture modes, export and delete everything
npm run test:migration                # the migration policy, including migrations that fail
npm run test:limits                   # export at scale, persistence, a full disk, restarts
npm run test:hostile                  # a wrong clock, a newer database, settings that are not settings
npm run test:storage                  # whether the storage meter is telling the truth
npm run test:longterm                 # a year of accumulation; takes a while
node test/browser/run-ui-smoke.mjs    # the search page; --screenshot out.png to look at it

node test/browser/run-benchmark.mjs 1500   # what it costs; not a test
npm run bench:delete                       # why DELETE_BATCH is one; not a test
```

`npm run test:longterm [pages] [days]` and `npm run test:limits [pages]` both
take a size. The defaults are 4,000 pages and 700; the numbers in
`ARCHITECTURE.md` come from runs at 10,000 and 30,000.

## Loading it

`chrome://extensions`, developer mode on, load unpacked, pick this folder. It installs and asks for nothing: host access is requested during setup rather than at install time, and content scripts are registered at runtime.

Setup opens by itself on a fresh install. Until you finish it nothing is captured, which is deliberate: the permission is requested on the screen that explains what it is for, not at install time.

## The two rules

Nothing in `src/core/` imports `chrome.*`. That keeps the test suite meaningful and would make a Firefox port a packaging problem rather than a rewrite.

Nothing except the service worker writes to the database. Extension pages ask it for what they need, which costs a message hop and buys a single writer with no cross context races.
