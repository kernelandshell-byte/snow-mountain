// A small corpus with deliberately overlapping vocabulary. Documents that
// share words are what make relevance testing meaningful: if every document
// were about a different subject, any ranker would look good.
//
// Written as prose rather than generated, because generated text has no
// idioms, no synonyms and no half remembered phrases, which is exactly what
// real queries are made of.

export const CORPUS = [
  {
    slug: 'retro-fatigue',
    url: 'https://teamcraft.example/retro-fatigue',
    title: 'Why teams stop running retrospectives',
    text: `Retro fatigue sets in when the same problems are raised every fortnight and nothing changes. People stop preparing, then stop speaking, and eventually the meeting is quietly dropped from the calendar. The usual response is to try a new format, a new set of prompts, or a facilitator from another team. That almost never helps, because the format was not the problem. What kills a retrospective is the absence of a visible loop between what gets raised and what actually gets done. Teams that keep the habit alive tend to do one unglamorous thing: they carry a small number of actions forward, assign them to a person rather than to the group, and start the next session by reporting on them. When people see that raising something leads to a change, they keep raising things.`,
  },
  {
    slug: 'standup-written',
    url: 'https://teamcraft.example/written-standup',
    title: 'Replacing the daily standup with a written update',
    text: `The daily standup survives mostly because nobody wants to be the person who cancels it. In a distributed team it costs everyone a context switch at a fixed hour, and the information density is low. A written update in a shared channel covers the same ground and is searchable afterwards, which the spoken version never is. The failure mode is that written updates become status theatre, three bullet points written to look busy. The fix is to write about blockers and decisions rather than activity. If nobody is blocked and no decision is pending, the honest update is one line, and that should be acceptable rather than suspicious.`,
  },
  {
    slug: 'meeting-audit',
    url: 'https://teamcraft.example/meeting-audit',
    title: 'Every recurring meeting should justify itself once a quarter',
    text: `Recurring meetings accumulate like browser tabs. Each one made sense when it started, and none of them has an obvious moment to end. A quarterly audit works better than a one off purge: list every recurring meeting, name the decision it exists to make, and cancel the ones that cannot answer. Meetings that survive usually turn out to be the ones with a named owner and a written outcome. The ones that die are the recurring syncs that exist because a project was risky eighteen months ago and nobody noticed it stopped being risky.`,
  },
  {
    slug: 'cohort-churn',
    url: 'https://metricsdesk.example/cohort-churn',
    title: 'Reading a churn cohort chart without fooling yourself',
    text: `A cohort chart puts each signup month on its own row and follows it across time, which is the only honest way to look at retention. The headline number everyone quotes is monthly churn, and it hides the shape completely. Healthy consumer products usually show a steep drop in the first weeks and then a flattening, and the height of that flat section matters far more than the slope before it. If retention never flattens, you do not have a churn problem to fix at the margin, you have a product that nobody keeps using. Reading the chart column by column instead of row by row is the most common mistake, because it mixes cohorts of very different ages.`,
  },
  {
    slug: 'churn-contraction',
    url: 'https://metricsdesk.example/churn-vs-contraction',
    title: 'Churn is not the same as contraction revenue',
    text: `Two companies can report the same revenue retention while being in completely different health. One is losing whole customers and replacing them. The other is keeping everyone but watching each account shrink as seats are trimmed. Lumping both into a single churn number makes them look identical. Contraction is usually the earlier signal, because accounts shrink before they leave, and a shrinking account is still reachable. Splitting the number into logo churn and revenue contraction takes an afternoon and changes what you work on next quarter.`,
  },
  {
    slug: 'activation-metric',
    url: 'https://metricsdesk.example/activation-metric',
    title: 'Picking an activation metric that actually predicts retention',
    text: `Most activation metrics are chosen because they are easy to instrument, not because they predict anything. The useful version is found the other way around: take users who were still active after three months, look at what they did in their first week, and find the behaviour that separates them from the ones who left. It is usually mundane and specific, like importing real data rather than sample data. Once you have it, resist adding more conditions to make the number look better.`,
  },
  {
    slug: 'content-briefs',
    url: 'https://benelux-content.example/content-briefs',
    title: 'Writing content briefs that survive contact with the writer',
    text: `A brief that lists only keywords produces an article that reads like it was assembled from keywords. The briefs that work carry three things a writer cannot get from a search tool: who the reader is at the moment they land on the page, what they already believe, and what the piece is allowed to leave out. Word count belongs at the bottom and should be a range. The most common failure is a brief that specifies the shape of the article in such detail that the writer has nothing left to decide, which produces competent, forgettable copy.`,
  },
  {
    slug: 'topic-clusters',
    url: 'https://benelux-content.example/topic-clusters',
    title: 'Topic clusters and internal linking for the Benelux market',
    text: `Topic clusters are usually explained as an SEO trick, a hub page surrounded by supporting articles pointing at it. That framing gets the mechanism right and the purpose wrong. The reason a cluster works is that it forces you to cover a subject completely enough that a reader has no reason to leave. Internal links are how that coverage becomes visible to a crawler, not the point in themselves. In the Benelux market this matters more than usual, because the same subject often needs a Dutch and a French treatment that are not translations of each other, and a cluster built by translation reads exactly like one.`,
  },
  {
    slug: 'serp-volatility',
    url: 'https://benelux-content.example/serp-volatility',
    title: 'What SERP volatility actually tells you',
    text: `Volatility trackers make every week look eventful. The trouble is that a rankings tracker measures movement, and movement is not the same as a change in how a search engine judges quality. Most of what these tools report is testing, personalisation and geographic variation. Before rewriting anything in response to a jump, check whether the pages that moved share a template, a topic or an age. If they do not share anything, the movement is noise and the correct response is to do nothing, which is the hardest recommendation to sell to anyone.`,
  },
  {
    slug: 'dutch-localisation',
    url: 'https://benelux-content.example/dutch-localisation',
    title: 'Localising English marketing copy for Dutch readers',
    text: `Dutch readers are famously direct, and English marketing copy translated word for word lands as evasive rather than friendly. Superlatives that pass unnoticed in English read as unserious. The practical version of this is unglamorous: shorten sentences, cut the hedging, and replace promises with specifics. Prices and conditions should appear earlier than an English page would put them. Belgian Dutch differs enough in vocabulary that a single Dutch page for both markets tends to read as slightly foreign in one of them.`,
  },
  {
    slug: 'mv3-migration',
    url: 'https://extdev.example/mv3-migration',
    title: 'What Manifest V3 actually changed for extension authors',
    text: `The migration is usually discussed in terms of blocking network requests, because that is what broke ad blockers, but for most extensions the disruptive change is the background page becoming a service worker that is stopped whenever it looks idle. Anything kept in a module level variable is gone the next time an event fires. Long running work has to be broken into pieces that can be resumed, and timers have to be replaced with alarms. The second surprise is that permissions are now easier to request at runtime, which makes it practical to ship an extension that asks for nothing at install time.`,
  },
  {
    slug: 'service-worker-lifetime',
    url: 'https://extdev.example/service-worker-lifetime',
    title: 'Designing background code that expects to be killed',
    text: `A background service worker should be treated as a function that happens to have listeners, not as a process. State belongs in storage, and every handler must work when it is the first thing to run after a restart. The common bug is an initialisation step that populates a cache at startup, which works during development because the worker stays alive while devtools are open, and fails in the wild where it is stopped after thirty seconds of quiet. Registering listeners must happen synchronously at the top level, because a listener added inside an async callback can miss the event that woke the worker in the first place.`,
  },
  {
    slug: 'content-script-imports',
    url: 'https://extdev.example/content-script-imports',
    title: 'Content scripts, isolated worlds and why your imports fail',
    text: `A content script runs in an isolated world: it shares the page's DOM but not its variables, which is why the page's own libraries are invisible to it. Less well known is that a content script is a classic script, so an import statement is a syntax error unless the file has been through a bundler. Teams usually discover this after moving shared helpers into a module and watching every injected script break at once. The options are to bundle, to load the helper as a web accessible module through a dynamic import, or to keep content scripts small enough that they need no helpers at all.`,
  },
  {
    slug: 'indexeddb-transactions',
    url: 'https://extdev.example/indexeddb-transactions',
    title: 'IndexedDB transactions close when you await the wrong thing',
    text: `An IndexedDB transaction stays alive as long as it has requests in flight. Await a promise that resolves from a request and everything continues normally. Await anything else, a fetch, a timer, a message round trip, and control returns to the event loop with nothing pending, the transaction commits, and every write after that point throws a TransactionInactiveError. The symptom is maddening, because half the data is written. The rule is simple to state and easy to break during a refactor: inside a transaction, only ever await requests belonging to that transaction. Batching requests before awaiting them is also dramatically faster, because the requests are pipelined instead of taking one round trip each.`,
  },
  {
    slug: 'bm25-plain',
    url: 'https://searchnotes.example/bm25-plain',
    title: 'BM25 in plain language',
    text: `BM25 scores a document against a query using three ideas. Rare words count for more than common ones, which is the inverse document frequency part. Repeating a word helps, but with diminishing returns, so a page that mentions a term forty times does not beat a page that mentions it four times by a factor of ten. And long documents are penalised, because they have more chances to contain any given word by accident. The two knobs, usually written k1 and b, control how quickly repetition saturates and how strongly length is normalised. Sensible defaults are close enough for most collections that tuning them is rarely where the wins are.`,
  },
  {
    slug: 'inverted-index',
    url: 'https://searchnotes.example/inverted-index',
    title: 'Building an inverted index you can afford to update',
    text: `An inverted index maps each term to the list of documents containing it, which makes lookup trivial and updates expensive. The naive layout keeps one record per term, so adding a document rewrites a record for every distinct word it contains, and those records grow without bound as the collection grows. Splitting each term's list into fixed size chunks bounds the rewrite: only the chunk covering the new document is touched. The chunk size is a real trade off. Large chunks mean fewer records to read for a common word and slower writes, small chunks mean the opposite, and the only way to choose is to measure with documents the size of the ones you actually have.`,
  },
  {
    slug: 'stopwords',
    url: 'https://searchnotes.example/stopwords',
    title: 'Stop words, phrase queries and the cost of throwing words away',
    text: `Dropping the most frequent words from an index is the oldest optimisation in search, and it quietly breaks phrase queries. A search for a famous quotation is mostly made of the words a stop list removes. Modern systems tend to keep everything and manage the cost at query time instead, by looking at the rarest term first and using it to narrow the candidates before the common ones are consulted. That ordering matters more than any storage saving, because the expensive part of answering a query is reading the long lists, not storing them.`,
  },
  {
    slug: 'prague-osvc',
    url: 'https://praguehow.example/osvc-registration',
    title: 'Registering as an OSVČ in Prague, step by step',
    text: `The trade licence itself is the fast part. You visit a Živnostenský úřad, present identification and proof of an address for the business, pay the fee, and walk out with a registration that is usually active the same week. What takes longer is everything hanging off it: the social insurance office, the health insurance company, and the tax office each need to hear from you within eight days, and each has its own form. Foreigners are usually caught out by the address requirement rather than by the paperwork, because a landlord's written consent is needed and not every landlord will give it quickly.`,
  },
  {
    slug: 'czech-vat',
    url: 'https://praguehow.example/czech-vat-identified-person',
    title: 'When a Czech freelancer becomes an identified person for VAT',
    text: `Full VAT registration and becoming an identified person are different things, and the distinction catches out freelancers who invoice abroad. Selling a service to a business in another EU country makes you an identified person from the first invoice, regardless of turnover. That means filing a summary report for those invoices, while domestic work stays outside VAT. The practical effect is that a first foreign client triggers an obligation nobody mentioned, usually discovered after the invoice has already been sent.`,
  },
  {
    slug: 'strassenfotografie',
    url: 'https://fotonotizen.example/strassenfotografie-muenchen',
    title: 'Warum Straßenfotografie in München schwieriger geworden ist',
    text: `Straßenfotografie lebt davon, dass Menschen sich unbeobachtet fühlen. In München ist das schwieriger geworden, seit fast jeder damit rechnet, fotografiert zu werden. Rechtlich ist die Lage klarer als viele denken: entscheidend ist, ob eine Person als Beiwerk erscheint oder erkennbar im Mittelpunkt steht. Praktisch hilft eine kleine Kamera mehr als jedes Argument, weil eine große Ausrüstung sofort als professionell gelesen wird und die Szene verändert, bevor das Bild entsteht.`,
  },
  {
    slug: 'umzug-prag',
    url: 'https://fotonotizen.example/umzug-nach-prag',
    title: 'Umzug nach Prag: die Behördengänge in der richtigen Reihenfolge',
    text: `Der Umzug selbst ist einfacher als die Reihenfolge der Ämter. Ohne Meldebescheinigung geht bei der Krankenversicherung wenig, und ohne Versicherungsnachweis wird es beim Gewerbeamt unangenehm. Wer die Termine in der falschen Reihenfolge macht, verliert schnell zwei Wochen. Deutsche unterschätzen außerdem, wie viel über persönliche Vorsprache läuft statt über Formulare im Internet.`,
  },
  {
    slug: 'espresso-grind',
    url: 'https://kitchennotes.example/espresso-grind',
    title: 'Grind size is the variable you actually control',
    text: `Everything else in an espresso recipe is a number you can write down and repeat. Dose, water temperature and pressure hold still. Grind does not, because beans change as they age and the same setting yields a different shot in week three than it did on day one. This is why chasing a recipe from a video rarely works. Pull a shot, taste it, and move the grinder in one direction only until it stops improving.`,
  },
  {
    slug: 'winter-cycling',
    url: 'https://kitchennotes.example/winter-cycling-kit',
    title: 'Winter cycling kit that is not miserable',
    text: `Cold hands end more winter rides than cold anything else, and the usual mistake is buying thicker gloves rather than blocking wind. Overdressing is the other failure: if you are comfortable in the first five minutes you will be soaked by the twentieth. Lights matter more than clothing in the dark months, and a rear light that flashes irregularly is noticed sooner by drivers than one that pulses on a steady rhythm.`,
  },
  {
    slug: 'notes-graveyard',
    url: 'https://kitchennotes.example/notes-graveyard',
    title: 'Why your notes app is a graveyard',
    text: `Most notes are written by a person with context to a person without it, and the second person is always the loser. A note that says "look into the pricing thing" is useless in six weeks. Capture is not the bottleneck, retrieval is, and no amount of tagging fixes a note that never said what it was about. The one habit that helps is writing the note as if to a stranger: name the subject, say why it mattered, and accept that this takes an extra fifteen seconds.`,
  },
];
