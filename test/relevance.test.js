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
];

// Queries the current design cannot answer, kept visible instead of being
// deleted. Each is reduced to the single word that carries the meaning,
// because with more words the OR fallback rescues the result and hides the
// real problem: without stemming, a word and its inflection are unrelated
// strings. Reported, never asserted.
const KNOWN_GAPS = [
  ['localisation', 'dutch-localisation', 'localisation vs localising'],
  ['clustering', 'topic-clusters', 'clustering vs clusters'],
  ['muenchen', 'strassenfotografie', 'German ue spelling of an umlaut'],
  ['behoerdengaenge', 'umzug-prag', 'German oe and ae spellings'],
  ['retrospektiven', 'retro-fatigue', 'no cross language matching, by design'],
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
    const result = await search(query, { store, limit: 10 });
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
    const result = await search(query, { store, limit: 10 });
    const rank = rankOf(result.results, urlFor(slug));
    gapReport.push('    ' + (rank === Infinity ? 'miss' : 'rank ' + rank) + '  ' + query + '  (' + why + ')');
  }

  console.log(
    '\n  relevance over ' + ranks.length + ' known item queries against ' + CORPUS.length + ' documents' +
    '\n    top 1: ' + top1 + '/' + ranks.length +
    '\n    top 3: ' + top3 + '/' + ranks.length +
    '\n    MRR:   ' + mrr.toFixed(3) +
    '\n  known gaps, all needing stemming or transliteration:\n' + gapReport.join('\n') + '\n'
  );

  // Set just below what the suite currently scores, so this is a regression
  // gate rather than an aspiration.
  assert.ok(mrr > 0.95, 'mean reciprocal rank regressed to ' + mrr.toFixed(3));
});
