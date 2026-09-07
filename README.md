# Snow Mountain

A local full text memory for your browser. Everything you actually read gets indexed on your own machine, so you can find it later by any phrase you remember.

Working title. See the naming note at the end of `BRIEF.md`.

- `BRIEF.md` is what this is and why, including the privacy model and v1 scope.
- `ARCHITECTURE.md` is how it is built, and it settles the decisions that are expensive to reverse.
- `spikes/` holds throwaway experiments that answered a question, kept so the answers stay reproducible.

## State

Foundation only. The pure core, the search pipeline and the test suite are real and passing. Storage against IndexedDB, capture, and the interface are not built yet.

Done:

- `src/core/` URL normalisation, tokenizer, capture policy, read heuristic, BM25, query parser, snippets, index writer, search pipeline
- `src/db/memory-store.js`, an in-memory implementation of the store interface, which is what lets search be tested without a browser
- 47 tests, no dependencies
- Wiring skeleton: manifest, service worker message router, content script sensor, placeholder pages, so the extension loads

Next, in order, from the build order in `ARCHITECTURE.md`:

3. `src/db/idb-store.js`, satisfying exactly the interface `memory-store.js` implements
4. The relevance harness: 30 known item queries where the right page has to land in the top three
5. Capture end to end, with Readability vendored in place of the placeholder extraction

## Tests

```
npm test
```

No dependencies, no install step. Node 22 or newer, using the built in test runner.

## Loading it

`chrome://extensions`, developer mode on, load unpacked, pick this folder. It installs and asks for nothing, because host access is requested during setup rather than at install time, and content scripts are registered at runtime.

## The one rule

Nothing in `src/core/` imports `chrome.*`. That is what keeps the test suite meaningful and what would make a Firefox port a packaging problem rather than a rewrite. Storage arrives as an injected interface, never as a global.
