# Project Snow Mountain

A local full text memory for your browser. Everything you actually read gets indexed on your own machine, so you can find it later by any phrase you remember.

Working title only. See "Naming" at the end.

## The problem

You read something useful. Two weeks later you need it back and all you have is a fragment: "that piece about why teams stop doing retros" or "the article with the chart about churn". You cannot find it.

Chrome's history only matches page titles and URLs, never the content of the page. Google cannot help because you do not remember the site or the wording of the headline. Your bookmarks do not have it because you did not know at the time that you would need it.

This is a permanent, universal, daily annoyance and the browser has never solved it.

## What it does

Pages you genuinely read get their main text extracted and indexed locally. A search box then does what you expect: type a half remembered phrase, get the page back, ranked sensibly, with the matching sentences shown in context. Opening a result takes you to the page and jumps to the passage that matched.

The moment it pays off: you type "retro fatigue" and get back the article you read in March, on a site you had forgotten the name of.

## Why this is worth building now

Nobody owns this space. The best known open source attempt (Falcon, 1.8k GitHub stars) was Manifest V2 and was permanently removed from the Web Store in the purge on 31 August 2026. The handful of current listings have between 25 and a few hundred users. There is no incumbent to beat, only an idea nobody has executed well.

Google will not ship this natively. Storing the text of every page a user reads is exactly the kind of feature a company that sells ads does not want to be seen doing.

It also completes a set. SafeClip remembers what you copied, Form Recovery remembers what you typed, this remembers what you read. Three tools, one idea: the browser forgets everything, these remember it locally.

## Non negotiables

1. **Local only.** No account, no server, no sync, no telemetry, no analytics.
2. **No network calls anywhere in the codebase.** Extension pages ship a CSP with `connect-src 'none'`. The honest version of the claim: capture needs host permissions to inject content scripts, so exfiltration is not technically impossible the way a sandbox would make it impossible. What we can say instead, and prove, is that no line of this code contacts the network, the extension pages are locked down, and the whole thing is open source so verifying it is one grep away. Write the threat model down and do not overclaim.
3. **Quiet.** No badges, no nags, no upsell, no onboarding carousel.
4. **Your data is yours.** Full export to a readable format, import back, one click wipe.
5. **Never surprise the user.** Nothing is ever deleted silently, and any future storage migration takes a backup first. Session Buddy has a million users and lost years of their saved sessions in a silent Web SQL to IndexedDB migration. That is the mistake to design against from day one.

## First run setup

Four screens, no account, no carousel.

1. **What this does.** Plain language: what gets stored, where it lives, what leaves the machine (nothing).
2. **Capture mode.** Everywhere except exclusions (recommended), or only sites I allow.
3. **Exclusions**, if the user picked the broad mode. Preset bundles shown with the sensible ones already on.
4. **Budget.** Time limit and size limit, both with recommended defaults and a plain explanation of what they mean in pages.

Permissions are requested at step 2, not at install. If the user picks the broad mode we ask for the wide host permission right then, in context, where the reason is obvious. If they pick strict mode we never ask for it at all.

## Capture model

Two modes, and the difference between them is enforced by Chrome, not by our own good behaviour.

**Broad mode (default).** Wide host permission, capture everywhere, minus the exclusion rules.

**Strict mode.** No wide host permission at all. The user grants access per site through `optional_host_permissions`, and content scripts are registered dynamically with `chrome.scripting.registerContentScripts` for exactly those origins. The extension is not able to read anything else, because Chrome will not let it.

That distinction is worth the extra complexity. Every competitor's privacy mode is a promise. This one is enforced by the browser, and switching from broad to strict later actually calls `permissions.remove()` so the access is really gone.

### Exclusion rules

Preset bundles, each toggled as a group, maintained in the repo:

- Webmail (on by default)
- Banking and finance (on by default)
- Health and medical (on by default)
- Adult (on by default)
- Government and ID portals (on by default)
- Local and intranet, meaning private IP ranges and `.local` (on by default)

Custom rules on top, using simple patterns rather than regex to avoid footguns: `example.com`, `*.example.com`, `example.com/private/*`.

Plus two rules that always apply regardless of mode: never capture a page that contains a password field, and never capture in incognito.

Excluding a site retroactively deletes everything already captured from it. That should be the visible, obvious behaviour, not a hidden extra step.

## Storage budget

Two independent caps, both set during setup, whichever binds first wins.

- **Age cap**, default 12 months
- **Size cap**, default 500MB

500MB is roughly 30,000 pages. That is measured rather than estimated:
indexing 1500 synthetic documents of about 800 words each into real
IndexedDB came out at 15KB per document including the index, and synthetic
text has a wider vocabulary than prose, so real pages should be cheaper.
Recompute it from observed averages rather than hardcoding it, and show it
in the setup screen as a real number so the choice means something.

The behaviour model is a mobile data plan, which is the right mental model because people already understand it:

- A storage meter that is always visible in the popup and never shouts
- One notice at 80 percent, saying what it will cost them and what they can do: raise the budget, or let old pages roll off
- Once the extension has a few weeks of history it knows the user's actual pace, so that notice can say something concrete like "at your pace you will hit this around 12 March"
- One notice when eviction actually starts, saying what was removed, with a link to a storage log
- Never a modal, never a repeated daily nag

Eviction removes the pages you have not opened in the longest time. **Pinned pages are never evicted.** A pin is one click from the search results and it is what makes the whole budget idea safe: anything you care about, you keep, forever, regardless of caps.

Storage accounting has to be honest, which means tracking our own byte counts per record. `navigator.storage.estimate()` is approximate and includes things that are not ours, so it is fine for a sanity check and useless as the number we show the user.

## Architecture

### Capture

The hard question is not how to grab text, it is deciding what counts as "read". Indexing every URL that ever loaded produces a landfill.

Heuristic for a page worth keeping:

- Normal http(s) document, so no `file://`, `chrome://`, extension pages, or media
- Tab was actually focused, which rules out background tabs and prefetch
- Foreground dwell past a threshold, roughly 8 to 10 seconds
- Plus either meaningful scroll depth, or a short enough page that scrolling was never needed
- Not excluded by the rules above

Revisits update the existing record rather than duplicating: keep first seen, last seen, visit count, and re-index only when a content hash shows the page materially changed.

### Extraction

Mozilla Readability on a cloned DOM gives main text, title, byline and excerpt without the nav, footer and cookie banner noise. Non article pages fall back to visible text from the main landmarks, capped.

Stored per page: url, canonical url, title, extracted text (capped, roughly 200KB), excerpt, domain, first seen, last seen, visit count, word count, content hash, pinned flag. Favicons come from Chrome's local favicon API, never fetched.

### Storage and index

IndexedDB with two stores:

- `pages`: the documents and their metadata
- `postings`: an inverted index mapping term to a list of `{docId, termFrequency, positions}`

Tokenizer is lowercase, unicode aware, diacritic normalising, punctuation stripped, numbers kept. No stemming in v1. Joshua reads in English, German and Dutch, and naive English stemming actively hurts the other two. Prefix matching covers most of what stemming would have bought us.

Ranking is BM25, plus a recency boost and a small boost for matches in the title or headings. Positions in the postings list give us exact phrase search.

All indexing runs in a Web Worker with batched writes, so nothing ever blocks the UI. Request `navigator.storage.persist()` so Chrome does not quietly evict the database under pressure, and warn if it is refused.

### Search

Two entry points:

- **Omnibox keyword.** Type the keyword then space in the address bar and search inline without ever opening a UI. This is the fastest path and should feel instant.
- **A full search page**, not a cramped popup. Query box, results with highlighted snippets showing the matched context, filters by site and date range, relevance or recency sort, and full keyboard control.

Result cards show title, domain, date, and two or three lines of snippet with the query terms highlighted. That snippet is what makes a result recognisable, so it deserves real attention rather than the first 150 characters of the page.

### Jump to passage

Opening a result should land on the sentence that matched, not the top of the page.

First thing to prototype: Chrome's native scroll to text fragments (`#:~:text=`). If a tab opened by the extension activates the fragment reliably, we get scrolling and highlighting for free, and pages that have since changed simply do not scroll, which is a clean failure mode. Confirm this early, because it decides whether this feature costs an afternoon or a week.

Fallback if that does not hold up: the anchoring approach from Form Recovery, quote plus position with fuzzy matching.

## v1 scope

In:

- Four screen setup flow, with permissions requested in context
- Both capture modes, strict mode enforced through optional host permissions
- Preset exclusion bundles plus custom rules
- Capture with the dwell and scroll heuristic
- Readability extraction
- IndexedDB inverted index with BM25 in a worker
- Search page with snippets and site/date filters
- Omnibox search
- Pinning
- Both budget caps, storage meter, threshold notices, announced eviction, storage log
- Pause, per site delete, forget this page
- Export and wipe
- Jump to passage if the text fragment prototype holds

Out of v1, deliberately:

- PDF capture
- Language aware stemming and typo tolerance
- Semantic or embedding based search
- Import (export first, import once the format has settled)
- Firefox port

## Known risks

| Risk | Handling |
|---|---|
| Storage grows without bound | Two caps, pinning, visible meter, announced eviction |
| Search returns junk and feels useless | Fixed test corpus and about 30 known item queries, measure whether the right page lands in the top 3, treat relevance as a number that has to stay green |
| Chrome evicts the database | Request persistent storage, warn if refused |
| Users find the concept creepy | Lead with the threat model, exclusions on by default, strict mode that Chrome enforces, open source |
| Extraction quality varies wildly across sites | Fixture set of saved real pages, news, docs, forums, SPAs, and assert on extraction output |
| Two permission models double the surface area | Route everything through one capture policy module, so mode is a parameter and not a fork in the codebase |

## Testing

The core of this project is pure functions, which is unusually testable for an extension. Tokeniser, index, BM25 scoring and snippet generation all get unit tests. Capture heuristics and exclusion matching get jsdom tests the way Form Recovery's did. Relevance gets its own eval corpus with a pass threshold, because "does search feel good" is otherwise unanswerable and quietly rots.

## Naming

Not settled, and it does not need to be. The name only appears in three places: `manifest.json`, the store listing, and the repo name. All three are trivial to change right up until publication.

The one rule that keeps it cheap: **keep the name out of the code.** No `SnowMountain` prefixes on classes, storage keys, database names or CSS classes. Put the display name in one constant and read it from there. Renaming then costs a single line instead of a refactor.
