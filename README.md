# Snow Mountain

A local full text memory for your browser. Everything you actually read gets indexed on your own machine, so you can find it later by any phrase you remember.

Working title. See the naming note at the end of `BRIEF.md`.

- `BRIEF.md` is what this is and why, including the privacy model and v1 scope.
- `ARCHITECTURE.md` is how it is built, and it settles the decisions that are expensive to reverse.
- `spikes/` holds throwaway experiments that answered a question, kept so the answers stay reproducible.

## State

It works end to end. Capture a page, search it back, open the result on the paragraph that matched.

What is real:

- The whole pure core: tokenising, capture policy, read heuristic, BM25, query parsing, snippets, the storage budget, text fragment URLs
- Two stores, `memory-store` and `idb-store`, held to one contract that runs against both
- Search, with an AND to OR fallback and a singular fallback for plural queries
- A service worker that captures, indexes, searches, pins, forgets and evicts
- A working search page and popup
- 134 Node tests, 14 store contract cases against real IndexedDB, 14 end to end checks through the real extension, 9 interface checks

What is not done:

- Extraction is still `document.body.innerText`. Readability needs vendoring, and until then captured text includes navigation and footer noise
- No setup flow yet, so capture mode and the budget use their defaults
- No export, no storage log screen, no per site controls in the interface
- The search page works and has had no design pass

## Tests

```
npm test                              # Node suite, no dependencies, about a second
npm install --no-save playwright      # only needed for the three below
npm run test:browser                  # the store contract against real IndexedDB
npm run test:e2e                      # capture, search, pin, forget, evict, through the real worker
node test/browser/run-ui-smoke.mjs    # drives the search page; --screenshot out.png to look
node test/browser/run-benchmark.mjs 1500   # what it costs, not a test
```

## Loading it

`chrome://extensions`, developer mode on, load unpacked, pick this folder. It installs and asks for nothing: host access is requested during setup rather than at install time, and content scripts are registered at runtime.

Until the setup flow exists, grant the broad permission by hand from the extension's details page if you want it to capture anything.

## The two rules

Nothing in `src/core/` imports `chrome.*`. That keeps the test suite meaningful and would make a Firefox port a packaging problem rather than a rewrite.

Nothing except the service worker writes to the database. Extension pages ask it for what they need, which costs a message hop and buys a single writer with no cross context races.
