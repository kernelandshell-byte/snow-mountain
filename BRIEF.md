# Project Snow Mountain

A local full text memory for your browser. Everything you actually read gets indexed on your own machine, so you can find it later by any phrase you remember.

Working title only. Naming comes later.

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
2. **No network calls anywhere in the codebase.** Extension pages ship a CSP with `connect-src 'none'`. The honest version of the claim: capture needs broad host permissions to inject content scripts, so exfiltration is not technically impossible the way a sandbox would make it impossible. What we can say instead, and prove, is that no line of this code contacts the network, the extension pages are locked down, and the whole thing is open source so verifying it is one grep away. Write the threat model down and do not overclaim.
3. **Quiet.** No badges, no nags, no upsell, no onboarding carousel.
4. **Your data is yours.** Full export to a readable format, import back, one click wipe.
5. **Never surprise the user.** Any future storage migration takes a backup first and tells the user. Session Buddy has a million users and lost years of their saved sessions in a silent Web SQL to IndexedDB migration. That is the mistake to design against from day one.

## Architecture

### Capture

The hard question is not how to grab text, it is deciding what counts as "read". Indexing every URL that ever loaded produces a landfill.

Heuristic for a page worth keeping:

- Normal http(s) document, so no `file://`, `chrome://`, extension pages, or media
- Tab was actually focused, which rules out background tabs and prefetch
- Foreground dwell past a threshold, roughly 8 to 10 seconds
- Plus either meaningful scroll depth, or a short enough page that scrolling was never needed
- Not excluded by the blocklist or by a password field on the page

Revisits update the existing record rather than duplicating: keep first seen, last seen, visit count, and re-index only when a content hash shows the page materially changed.

### Extraction

Mozilla Readability on a cloned DOM gives main text, title, byline and excerpt without the nav, footer and cookie banner noise. Non article pages fall back to visible text from the main landmarks, capped.

Stored per page: url, canonical url, title, extracted text (capped, roughly 200KB), excerpt, domain, first seen, last seen, visit count, word count, content hash. Favicons come from Chrome's local favicon API, never fetched.

### Storage and index

IndexedDB with two stores:

- `pages`: the documents and their metadata
- `postings`: an inverted index mapping term to a list of `{docId, termFrequency, positions}`

Tokenizer is lowercase, unicode aware, diacritic normalising, punctuation stripped, numbers kept. No stemming in v1. Joshua reads in English, German and Dutch, and naive English stemming actively hurts the other two. Prefix matching covers most of what stemming would have bought us.

Ranking is BM25, plus a recency boost and a small boost for matches in the title or headings. Positions in the postings list give us exact phrase search.

All indexing runs in a Web Worker with batched writes, so nothing ever blocks the UI.

Storage discipline, which is where projects like this usually die:

- User visible storage meter showing real usage
- A budget, defaulting to something like 12 months or 500MB, whichever comes first
- Eviction oldest and least visited first, announced before it happens, never silent
- `navigator.storage.persist()` so Chrome does not quietly evict the database under pressure

### Search

Two entry points:

- **Omnibox keyword.** Type the keyword then space in the address bar and search inline without ever opening a UI. This is the fastest path and should feel instant.
- **A full search page**, not a cramped popup. Query box, results with highlighted snippets showing the matched context, filters by site and date range, relevance or recency sort, and full keyboard control.

Result cards show title, domain, date, and two or three lines of snippet with the query terms highlighted. That snippet is what makes a result recognisable, so it deserves real attention rather than the first 150 characters of the page.

### Jump to passage

Opening a result should land on the sentence that matched, not the top of the page.

First thing to prototype: Chrome's native scroll to text fragments (`#:~:text=`). If a tab opened by the extension activates the fragment reliably, we get scrolling and highlighting for free, and pages that have since changed simply do not scroll, which is a clean failure mode. Confirm this early, because it decides whether this feature costs an afternoon or a week.

Fallback if that does not hold up: the anchoring approach from Form Recovery, quote plus position with fuzzy matching.

## Privacy model

- A first run screen that states plainly what is stored, where, and what leaves the machine, which is nothing
- Default exclusions: banking, health portals, webmail, adult sites, and any page carrying a password field
- Pause, for an hour or until resumed
- Exclude this site, from the popup, which also deletes everything already captured from that domain
- Forget this page, forget this day, forget this site
- Export everything, wipe everything

This is the scariest of the three extensions permission wise, since it reads content on every site. That is also the opportunity. The security review process that SafeClip went through is the thing that makes this one credible, so plan for a written threat model and an external review before release.

## v1 scope

In:

- Capture with the dwell and scroll heuristic
- Readability extraction
- IndexedDB inverted index with BM25 in a worker
- Search page with snippets and site/date filters
- Omnibox search
- Exclusions, pause, per site delete
- Retention policy, storage meter, eviction with warning
- Export and wipe
- Jump to passage if the text fragment prototype holds

Out of v1, deliberately:

- PDF capture
- Language aware stemming and typo tolerance
- Semantic or embedding based search
- Allowlist only capture mode
- Firefox port

## Known risks

| Risk | Handling |
|---|---|
| Storage grows without bound | Budget, retention, visible meter, announced eviction |
| Search returns junk and feels useless | Build a fixed test corpus and about 30 known item queries, measure whether the right page lands in the top 3, treat relevance as a number that has to stay green |
| Chrome evicts the database | Request persistent storage, warn if it is refused |
| Users find the concept creepy | Lead with the threat model, ship the exclusions on by default, keep it open source |
| Extraction quality varies wildly across sites | Fixture set of saved real pages, news, docs, forums, SPAs, and assert on extraction output |

## Testing

The core of this project is pure functions, which is unusually testable for an extension. Tokeniser, index, BM25 scoring and snippet generation all get unit tests. Capture heuristics get jsdom tests the way Form Recovery's did. Relevance gets its own eval corpus with a pass threshold, because "does search feel good" is otherwise unanswerable and quietly rots.

## Open questions

1. Default retention: 12 months, or size based, or both?
2. Should webmail be excluded by default? Indexing Gmail is powerful and also the single creepiest thing this could do.
3. Is capture broad by default with exclusions, or is there also a strict allowlist mode in v1?
4. Name.
