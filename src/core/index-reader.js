// Search pipeline. Storage is injected as a small interface so this runs
// against IndexedDB in the extension and against an in-memory store in the
// tests and the relevance harness.
//
// @typedef {object} Store
// @property {(term: string) => Promise<Array<{id:number, tf:number, pos:number[]}>>} readTerm
// @property {(ids: number[]) => Promise<Map<number, object>>} readDocs
// @property {() => Promise<{docCount:number, avgDocLength:number}>} readStats

import { parseQuery } from './query-parser.js';
import { termScore, recencyBoost, idf } from './bm25.js';
import { buildSnippet } from './snippet.js';
import { terms as termsOf } from './tokenizer.js';
import { variantsOf } from './morphology.js';
import { MIN_PREFIX_CHARS, PREFIX_SCORE_FACTOR } from '../shared/constants.js';

const PRESCORE_LIMIT = 500;

function phraseHit(phrase, postingsByTerm, docId) {
  const positionLists = phrase.map((t) => postingsByTerm.get(t)?.get(docId)?.pos || []);
  if (positionLists.some((l) => l.length === 0)) return false;
  const first = positionLists[0];
  return first.some((start) =>
    positionLists.every((list, offset) => offset === 0 || list.includes(start + offset))
  );
}

export async function search(
  input,
  { store, limit = 20, offset = 0, now = Date.now(), filters = {} } = {}
) {
  const started = Date.now();
  const q = parseQuery(input);
  if (q.isEmpty) {
    return { results: [], total: 0, mode: 'empty', relaxed: {}, expanded: {}, tookMs: 0, query: q };
  }

  const stats = await store.readStats();
  const postingsByTerm = new Map();
  const dfByTerm = new Map();

  // A term that matches nothing gets one cheap second chance at its
  // singular. Recorded so the interface can say what it actually searched.
  const relaxed = {};

  // And then, still only if it matched nothing, at being the start of a
  // longer word. This is the prefix matching BRIEF.md always meant to stand
  // in for stemming, and it is deliberately a last resort rather than the
  // default: a word with postings of its own is searched exactly, so "car"
  // stays "car" and never quietly becomes "carbon". Only "isra", which finds
  // nothing at all on its own, is widened.
  //
  // Words inside a quoted phrase are never widened. A phrase is checked
  // against stored positions, and the positions of several different words
  // merged together do not describe any real sentence.
  const expanded = {};
  const phraseTerms = new Set(q.phrases.flat());
  const canExpand = typeof store.readTermsWithPrefix === 'function';

  await Promise.all(
    q.lookup.map(async (term) => {
      let list = await store.readTerm(term);

      // A phrase word is checked against stored positions, and a singular
      // swapped in from a different word does not describe any position the
      // page's text actually has -- the same reason prefix widening below
      // excludes phrase words. Relaxing here would make phraseHit compare a
      // phrase against another word's positions and call it a match.
      if (list.length === 0 && !phraseTerms.has(term)) {
        for (const variant of variantsOf(term)) {
          const alternative = await store.readTerm(variant);
          if (alternative.length) {
            list = alternative;
            relaxed[term] = variant;
            break;
          }
        }
      }

      if (
        list.length === 0 &&
        canExpand &&
        term.length >= MIN_PREFIX_CHARS &&
        !phraseTerms.has(term)
      ) {
        const matches = await store.readTermsWithPrefix(term);
        if (matches.length) {
          // The widened word behaves as one word from here on. A document
          // that contains "israel" twice and "israeli" once has three
          // reasons to match "isra", and counting them as three is what
          // makes the ranking sensible.
          const merged = new Map();
          for (const match of matches) {
            for (const entry of match.docs) {
              const already = merged.get(entry.id);
              if (already) already.tf += entry.tf;
              else merged.set(entry.id, { id: entry.id, tf: entry.tf, pos: entry.pos });
            }
          }
          list = [...merged.values()].sort((a, b) => a.id - b.id);
          expanded[term] = matches.map((match) => match.term);
        }
      }

      const map = new Map();
      for (const entry of list) map.set(entry.id, entry);
      postingsByTerm.set(term, map);
      dfByTerm.set(term, list.length);
    })
  );

  const sets = q.lookup.map((t) => postingsByTerm.get(t));
  let mode = 'and';
  let candidates = null;

  if (sets.length && sets.every((s) => s.size > 0)) {
    const smallest = sets.reduce((a, b) => (a.size <= b.size ? a : b));
    candidates = new Set();
    for (const id of smallest.keys()) {
      if (sets.every((s) => s.has(id))) candidates.add(id);
    }
  }

  // A half remembered phrase usually contains one wrong word. Returning
  // nothing when four terms out of five matched feels broken, so fall back
  // to a union and tell the caller that is what happened.
  if (!candidates || candidates.size === 0) {
    mode = 'or';
    candidates = new Set();
    for (const s of sets) for (const id of s.keys()) candidates.add(id);
  }
  if (candidates.size === 0) {
    return { results: [], total: 0, mode, relaxed, expanded, tookMs: Date.now() - started, query: q };
  }

  // The snippet highlights what was actually found, not what was typed.
  // Searching "isra" and getting back a paragraph with nothing marked in it
  // would look like the wrong page.
  const highlightTerms = [...new Set([
    ...q.lookup,
    ...Object.values(relaxed),
    ...Object.values(expanded).flat(),
  ])];

  // Stage one: cheap ranking with no document loads, to bound how many
  // records the expensive stage has to read.
  const prescored = [];
  for (const id of candidates) {
    let s = 0;
    for (const term of q.lookup) {
      const entry = postingsByTerm.get(term).get(id);
      if (entry) s += idf(dfByTerm.get(term), stats.docCount) * (1 + Math.log(entry.tf));
    }
    prescored.push([id, s]);
  }
  prescored.sort((a, b) => b[1] - a[1]);
  const shortlist = prescored.slice(0, PRESCORE_LIMIT).map(([id]) => id);

  const docs = await store.readDocs(shortlist);

  // A filter typed into the query wins over the same filter set in the
  // interface, on the grounds that the more specific instruction is the one
  // the person just wrote.
  const site = q.site || filters.site || null;
  const after = q.after || filters.after || null;
  const before = q.before || filters.before || null;

  const scored = [];
  for (const id of shortlist) {
    const doc = docs.get(id);
    if (!doc) continue;
    if (site && doc.domain !== site) continue;
    if (after && doc.lastSeen < after) continue;
    if (before && doc.lastSeen > before) continue;
    if (q.phrases.length && !q.phrases.every((p) => phraseHit(p, postingsByTerm, id))) continue;

    let score = 0;
    for (const term of q.lookup) {
      const entry = postingsByTerm.get(term).get(id);
      if (!entry) continue;
      const contribution = termScore(
        { tf: entry.tf, df: dfByTerm.get(term), docLength: doc.wordCount || 1 },
        stats
      );
      // A widened word is a guess. This only moves anything when a query
      // mixes one with a word that matched exactly, which is the case where
      // the exact word deserves to carry more of the answer.
      score += expanded[term] ? contribution * PREFIX_SCORE_FACTOR : contribution;
    }

    const titleTerms = new Set(termsOf(doc.title || ''));
    const titleHits = q.lookup.filter((t) => titleTerms.has(t)).length;
    if (titleHits) score *= 1 + 0.08 * titleHits;

    score *= recencyBoost(doc.lastSeen || now, now);
    if (doc.pinned) score *= 1.05;

    scored.push({ id, score, doc });
  }

  if (filters.sort === 'recent') scored.sort((a, b) => b.doc.lastSeen - a.doc.lastSeen);
  else scored.sort((a, b) => b.score - a.score);

  const page = scored.slice(offset, offset + limit);

  // Domains of everything that matched, not just this page of it, so the
  // interface can offer a site filter that means something.
  const domains = new Map();
  for (const { doc } of scored) {
    domains.set(doc.domain, (domains.get(doc.domain) || 0) + 1);
  }

  return {
    mode,
    relaxed,
    expanded,
    total: scored.length,
    hasMore: offset + limit < scored.length,
    domains: [...domains.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([domain, count]) => ({ domain, count })),
    appliedFilters: { site, after, before, sort: filters.sort || 'relevance' },
    tookMs: Date.now() - started,
    query: q,
    results: page.map(({ id, score, doc }) => ({
      id,
      score,
      url: doc.url,
      title: doc.title,
      domain: doc.domain,
      lastSeen: doc.lastSeen,
      pinned: !!doc.pinned,
      snippet: buildSnippet(doc.text || '', highlightTerms),
    })),
  };
}
