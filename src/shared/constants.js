// The display name lives here and nowhere else, so renaming the project
// stays a one line change. See the naming section of BRIEF.md.
export const DISPLAY_NAME = 'Snow Mountain';

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
