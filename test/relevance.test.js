// The relevance harness.
//
// "Does search feel good" is unanswerable, so it gets measured instead.
// Each query below is a known item search: a person half remembers one
// document and types what they can. The target has to come back in the top
// three. If a change to scoring, tokenising or snippets makes this worse,
// the build fails rather than the quality quietly rotting.
//
// The gap list at the bottom is the honest counterpart: queries that do not
// work yet, kept visible instead of being deleted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/db/memory-store.js';
import { search } from '../src/core/index-reader.js';
import { STEM_LANGUAGES } from '../src/core/stemming.js';
import { CORPUS } from './fixtures/corpus.js';

const QUERIES = [
  ['retro fatigue', 'retro-fatigue'],
  ['same problems raised nothing changes', 'retro-fatigue'],
  ['retro fatigue kangaroo', 'retro-fatigue'],
  ['cancel recurring meetings quarterly', 'meeting-audit'],
  ['written update standup blockers', 'standup-written'],
  ['cohort chart retention flattens', 'cohort-churn'],
  ['"cohort chart"', 'cohort-churn'],
  ['logo churn contraction', 'churn-contraction'],
  ['activation metric predicts retention', 'activation-metric'],
  ['brief writer nothing left to decide', 'content-briefs'],
  ['topic clusters internal linking', 'topic-clusters'],
  ['serp volatility noise', 'serp-volatility'],
  ['dutch readers direct superlatives', 'dutch-localisation'],
  ['manifest v3 service worker idle', 'mv3-migration'],
  ['listeners must happen synchronously', 'service-worker-lifetime'],
  ['content script import syntax error', 'content-script-imports'],
  ['isolated world dom variables', 'content-script-imports'],
  ['transactioninactiveerror', 'indexeddb-transactions'],
  ['k1 and b knobs', 'bm25-plain'],
  ['rare words count for more', 'bm25-plain'],
  ['chunk size trade off', 'inverted-index'],
  ['stop words phrase queries', 'stopwords'],
  ['rarest term first narrow candidates', 'stopwords'],
  ['zivnostensky urad', 'prague-osvc'],
  ['landlord written consent address', 'prague-osvc'],
  ['identified person first invoice', 'czech-vat'],
  ['summary report eu country', 'czech-vat'],
  ['site:praguehow.example identified person', 'czech-vat'],
  ['strassenfotografie', 'strassenfotografie'],
  ['münchen kamera', 'strassenfotografie'],
  ['behördengänge reihenfolge', 'umzug-prag'],
  ['beans change as they age', 'espresso-grind'],
  ['cold hands gloves wind', 'winter-cycling'],
  ['note written to a stranger', 'notes-graveyard'],

  // Harder: every one of these has at least one document competing for it,
  // so a ranker that merely matches words will get them wrong.
  ['every distinct word rewrite record', 'inverted-index'],
  ['diminishing returns repeating a word', 'bm25-plain'],
  ['status theatre bullet points', 'standup-written'],
  ['seats trimmed accounts shrink', 'churn-contraction'],
  ['pages that moved share a template', 'serp-volatility'],
  ['sample data instead of real data', 'activation-metric'],
  ['facilitator from another team', 'retro-fatigue'],
  ['belgian dutch vocabulary', 'dutch-localisation'],

  // Plurals, handled by the singular fallback rather than by stemming.
  ['retros', 'retro-fatigue'],
  ['cohort charts', 'cohort-churn'],

  // A word and its inflection, handled by the stemming fallback now that it
  // exists. Each is reduced to the single word that carries the meaning,
  // because with more words the OR fallback would rescue the result and
  // hide whether stemming itself did anything.
  ['localisation', 'dutch-localisation'],
  ['clustering', 'topic-clusters'],

  // The current German stemmer normalises the ae/oe/ue ASCII spelling of
  // an umlaut as part of stemming itself ("muenchen" and "munchen" -- the
  // tokenizer's own folded form of "münchen" -- both reduce to "munch"),
  // so this genuinely needs stemming on: turning it off drops this query
  // to zero results, checked directly in stemming-search.test.js.
  ['muenchen', 'strassenfotografie'],

  // A German ASCII transliteration two edits from the real spelling
  // ("gaenge" for "gänge", plus the "be-"/"be-" match itself), which the
  // German stemmer's own transliteration handling resolves the same way
  // as "muenchen" above -- but this one was already reachable without any
  // stemming at all, through typo tolerance alone: "behoerdengaenge" is
  // two edits from the tokenizer's folded "behordengange", inside its
  // budget for a word this length.
  ['behoerdengaenge', 'umzug-prag'],

  // Not a stemming gap and not really a transliteration either: a German
  // spelling of the English word, close enough in edit distance ("ktive"
  // for "ctive", plus the trailing "n") that typo tolerance closes it by
  // coincidence. No language here does cross language matching on
  // purpose -- see "rueckblick" below for a query typed with an actual
  // German word instead of a German-spelled English one, which still
  // finds nothing.
  ['retrospektiven', 'retro-fatigue'],
];

// Queries the current design still cannot answer, kept visible instead of
// being deleted. Reported, never asserted.
const KNOWN_GAPS = [
  ['rueckblick', 'retro-fatigue', 'a real German word for the idea, not a German spelling of the English one -- no cross language matching, by design'],
];

const urlFor = (slug) => CORPUS.find((d) => d.slug === slug).url;

async function buildStore() {
  const store = createMemoryStore();
  const base = Date.now() - CORPUS.length * 86400000;
  for (let i = 0; i < CORPUS.length; i++) {
    const doc = CORPUS[i];
    await store.putPage({
      url: doc.url,
      title: doc.title,
      text: doc.text,
      lastSeen: base + i * 86400000,
    });
  }
  return store;
}

const rankOf = (results, url) => {
  const index = results.findIndex((r) => r.url === url);
  return index === -1 ? Infinity : index + 1;
};

const store = await buildStore();
const ranks = [];

for (const [query, slug] of QUERIES) {
  test('finds "' + slug + '" from: ' + query, async () => {
    const result = await search(query, { store, limit: 10, stemLanguages: STEM_LANGUAGES });
    const rank = rankOf(result.results, urlFor(slug));
    ranks.push(rank);
    assert.ok(
      rank <= 3,
      'expected ' + slug + ' in the top 3, got rank ' + (rank === Infinity ? 'nothing' : rank) +
        '. Top: ' + result.results.slice(0, 3).map((r) => r.url.split('/').pop()).join(', ')
    );
  });
}

test('relevance summary', async () => {
  const top1 = ranks.filter((r) => r === 1).length;
  const top3 = ranks.filter((r) => r <= 3).length;
  const mrr = ranks.reduce((sum, r) => sum + (r === Infinity ? 0 : 1 / r), 0) / ranks.length;

  const gapReport = [];
  for (const [query, slug, why] of KNOWN_GAPS) {
    const result = await search(query, { store, limit: 10, stemLanguages: STEM_LANGUAGES });
    const rank = rankOf(result.results, urlFor(slug));
    gapReport.push('    ' + (rank === Infinity ? 'miss' : 'rank ' + rank) + '  ' + query + '  (' + why + ')');
  }

  console.log(
    '\n  relevance over ' + ranks.length + ' known item queries against ' + CORPUS.length + ' documents' +
    '\n    top 1: ' + top1 + '/' + ranks.length +
    '\n    top 3: ' + top3 + '/' + ranks.length +
    '\n    MRR:   ' + mrr.toFixed(3) +
    '\n  known gaps, cross language matching:\n' + gapReport.join('\n') + '\n'
  );

  // Set just below what the suite currently scores, so this is a regression
  // gate rather than an aspiration.
  assert.ok(mrr > 0.95, 'mean reciprocal rank regressed to ' + mrr.toFixed(3));
});
