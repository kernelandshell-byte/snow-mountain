// The display name lives here and nowhere else, so renaming the project
// stays a one line change. Everything that shows a name to somebody reads it
// from here, including the page titles and the name of an exported file.
export const DISPLAY_NAME = 'TextMemory';

// A lowercase form for filenames.
export const SLUG = DISPLAY_NAME.toLowerCase().replace(/[^a-z0-9]+/g, '-');

// The identifier inside an export file, and the one thing here that must not
// track the display name.
//
// An export is a file somebody keeps, and the importer checks this string
// before it will read one. Naming it after the product means the day the
// product is renamed is the day every export anybody already has stops being
// importable, which is a data format broken by a marketing decision. So it
// says what the file is rather than what the extension is called, and it
// never changes again. The old name is still accepted, because files written
// under it exist.
export const EXPORT_FORMAT = 'reading-archive-export';
export const EXPORT_FORMATS_ACCEPTED = [EXPORT_FORMAT, 'snow-mountain-export'];

export const DB_NAME = 'archive';
export const DB_VERSION = 1;

// Postings are chunked by document id. 256 documents per bucket, chosen by
// measurement rather than by feel: at 4096 the record for a term grew with
// every page added to the same bucket, and since indexing one article
// rewrites roughly 550 term records, cost per page climbed from 132ms to
// 297ms between 400 and 1500 documents and was heading for a second. At 256
// the rewrite is bounded, indexing stays near 130ms, and storage came out
// 26% smaller. See test/browser/run-benchmark.mjs.
//
// Changing this invalidates every existing index, so it is a migration and
// not a tweak.
export const BUCKET_SHIFT = 8;

// Positions per term per document. Enough for phrase queries in practice,
// and it stops one pathological document from bloating the index.
export const MAX_POSITIONS_PER_TERM = 32;

export const MAX_TEXT_BYTES = 200 * 1024;

// The largest PDF whose text is kept. Enforced where the file is read, in
// content/pdf-fetch.js, which cannot import this and repeats the number.
export const MAX_PDF_BYTES = 20 * 1024 * 1024;

// Prefix matching is one of several ways a search term gets widened when
// it finds nothing on its own (see stemming.js and edit-distance.js for the
// other two). It is a fallback and never a default: a word that has
// postings of its own is searched exactly, so a query that already works
// can never be made worse or noisier by this. Only a word that found
// nothing at all is widened, which is where "isra" lives and "car" does
// not.
//
// Three characters is the floor. Two would expand to most of the index for no
// gain, and one is not a search.
export const MIN_PREFIX_CHARS = 3;

// How many of the matching words a widened search actually uses, most common
// first. A cap matters because a short prefix in a large archive can match
// thousands of words, and reading all of them to answer one query is how a
// search that was meant to be forgiving becomes a search that is slow.
export const PREFIX_EXPANSION_LIMIT = 24;

// How many distinct words the index is walked over before choosing those. The
// walk is a range scan on the postings key, which is already ordered by term,
// so this bounds the work rather than the result.
export const PREFIX_SCAN_LIMIT = 200;

// A widened word is a guess, and it scores as one. This only changes anything
// when a query mixes a word that matched exactly with one that had to be
// widened: there, the solid word should carry more weight than the guess.
export const PREFIX_SCORE_FACTOR = 0.75;

// A term four characters or longer can afford one or two character typos
// without becoming a different word. Below that, "cat" and "car" are both
// three letters and one edit apart, and treating them as the same search
// would be wrong more often than it would help.
export const MIN_TYPO_CHARS = 4;

// The scan cap for a fallback that verifies candidates and mostly discards
// them -- typo tolerance, and stemming's own "does this candidate's stem
// actually match" check -- smaller than PREFIX_SCAN_LIMIT on purpose.
// Prefix widening reads that many candidates because every one of them is
// going to be used; these two read candidates only to throw most of them
// away on a check, and each one costs a full posting list read regardless
// of whether it survives that check. Measured against real IndexedDB at
// 3,000 pages, for typo tolerance: a short scan prefix shared by hundreds
// of real words (this is common -- a lot of English starts with "un" or
// "re") pushed p95 for that one term past 190ms at PREFIX_SCAN_LIMIT, well
// over the 100ms budget the architecture doc sets for search as a whole.
// This brings it back under that, and 60 real candidates is already far
// more than a one or two character typo ever needs. Applied to stemming's
// scan too on the same reasoning, though not measured separately there.
export const VERIFY_SCAN_LIMIT = 60;

// The candidate scan for typo tolerance reuses the prefix-scan mechanism,
// which means it inherits the same blind spot: a typo has to leave the
// term's first few characters alone to be found at all, because that is
// what the scan is keyed on. "wrold" for "world" is a transposition right
// at the start and this will not catch it. A real fix would need an index
// keyed some other way, which is more machinery than one more character
// typo is worth right now.
export const TYPO_SCAN_PREFIX_CHARS = MIN_PREFIX_CHARS;

// Past this length, a query term can afford a two character edit distance
// rather than one. A short word misspelled by two letters is often a
// different word; a long one usually is not.
export const TYPO_LONG_TERM_CHARS = 6;

// Below this there is nothing to find later. Pages whose content lives in a
// shadow root or an iframe extract to twenty or thirty characters, and an
// archive full of those husks is worse than one without them.
//
// Kept deliberately low, for two reasons. A character count means different
// things in different scripts: thirty characters is nothing in English and a
// whole sentence in Chinese, so a generous floor would quietly discriminate
// against the languages that pack the most meaning per character. And the
// target here is not "short pages", it is pages where extraction found
// nothing, which is a much lower bar. Most of the work is done by the title
// ratio below rather than by this floor.
export const MIN_TEXT_CHARS = 25;

// The half of the test that does the actual work. A husk is the title echoed
// back, so text barely longer than its own heading is not a page that was
// read, whatever its absolute length. This is what separates a thirty
// character Chinese sentence, which carries a paragraph of meaning, from a
// thirty character English husk, which carries none. No character count can
// tell those apart; the relationship to the title can.
export const MIN_TEXT_OVER_TITLE = 20;

export const BM25 = { k1: 1.2, b: 0.75 };

// Measured, not guessed: 1500 documents averaging 800 tokens came out at
// about 15KB each including their share of the index. Used to turn a
// megabyte figure into a number of pages, which is the only form of the
// question anyone can answer.
export const BYTES_PER_PAGE_ESTIMATE = 15 * 1024;

export const DEFAULTS = {
  retentionMonths: 12,
  sizeCapBytes: 500 * 1024 * 1024,
  warnAtFraction: 0.8,
  dwellMs: 9000,
  scrollDepth: 0.35,
  shortPageWords: 400,
};

// How many of the oldest pages one eviction round reads. Only the oldest can
// be evicted by either rule, so the sweep never needs the rest, and reading
// the whole archive once an hour to discover it has no work is the difference
// between a background job and a background problem.
export const EVICTION_SCAN = 500;

// Pages deleted per transaction during a sweep. One, which looks absurd until
// you measure it.
//
// IndexedDB starts transactions in creation order, and one search is not one
// transaction: it reads a posting list per word and then the pages, each
// created only after the last resolved. A sweep that never yields creates its
// next batch before a waiting search has created anything, so the search ends
// up behind the whole queue rather than behind one piece of it. The pause
// between batches fixes the ordering, and then the batch size decides the wait.
//
// Deleting 400 pages while searching every 80ms, measured by
// test/browser/run-delete-batch.mjs:
//
//   batch   typical search   worst   sweep, alone
//      10            520ms  1237ms             8s
//       3            224ms   465ms            10s
//       1             93ms   253ms            13s
//
// Unlike the latency, the throughput is not free: one page at a time is about
// sixty percent slower to get through. That is the right way round. Search is
// the thing somebody is waiting for, and the sweep is a background job on an
// hourly alarm with nothing waiting on it -- and because deletion is split
// across transactions, a sweep that runs out of time keeps what it did and the
// next alarm carries on. A person who halves their size cap gets a sweep
// spread over several hours instead of a browser that stutters for one.
export const DELETE_BATCH = 1;

// One sweep is one event to the person reading the storage log, even when it
// goes round twenty times. Consecutive rounds with the same reason inside this
// window are merged into one row rather than pushing a year of history out of
// a list that shows fifteen.
export const EVICTION_LOG_MERGE_MS = 10 * 60 * 1000;

// The storage log is the record of everything ever removed, and it is the only
// one. It is also unbounded: a couple of rows a day is a few hundred a year,
// which is nothing on its own and is still a list that grows for ever. Keeping
// the newest few hundred means the log covers about two years of sweeps and
// stops there.
export const EVICTION_LOG_MAX = 500;

// A sweep gives up its turn rather than running until Chrome stops it. What is
// left is picked up by the next hourly alarm, and the progress made is kept
// because deletion is split across transactions.
export const MAX_SWEEP_MS = 20 * 1000;
