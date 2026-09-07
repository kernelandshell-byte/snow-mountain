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
  parsing, snippets, the storage budget, text fragment URLs
- Two stores, `memory-store` and `idb-store`, held to one contract that runs
  against both
- Search, with an AND to OR fallback and a singular fallback for plurals
- A service worker that captures, indexes, searches, pins, forgets, exports
  and evicts
- Extraction through vendored Readability, injected only into pages that
  have earned it
- A four screen setup flow that requests host access at the moment it is
  explained, and asks for nothing at all in strict mode
- Search page, popup, and a settings page with exclusion bundles, custom
  rules, the storage meter, the deletion log, export and wipe
- 134 Node tests and 88 browser checks across six suites

Not done, and listed at the end of `ARCHITECTURE.md` with the reasons:
import, one click site granting in strict mode, a design pass on the search
page, and the highlight fallback for the two cases where a text fragment
cannot fire.

## Tests

```
npm test                              # 134 Node tests, no dependencies, about a second
npm install --no-save playwright      # only needed for the browser suites

npm run test:browser                  # the store contract against real IndexedDB
npm run test:e2e                      # capture, search, pin, forget, evict, through the real worker
npm run test:extraction               # Readability against a page full of clutter
npm run test:setup                    # the setup flow, including a refused permission
npm run test:options                  # settings, export and delete everything
node test/browser/run-ui-smoke.mjs    # the search page; --screenshot out.png to look at it

node test/browser/run-benchmark.mjs 1500   # what it costs; not a test
```

## Loading it

`chrome://extensions`, developer mode on, load unpacked, pick this folder. It installs and asks for nothing: host access is requested during setup rather than at install time, and content scripts are registered at runtime.

Setup opens by itself on a fresh install. Until you finish it nothing is captured, which is deliberate: the permission is requested on the screen that explains what it is for, not at install time.

## The two rules

Nothing in `src/core/` imports `chrome.*`. That keeps the test suite meaningful and would make a Firefox port a packaging problem rather than a rewrite.

Nothing except the service worker writes to the database. Extension pages ask it for what they need, which costs a message hop and buys a single writer with no cross context races.
