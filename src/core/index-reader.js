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
import { stem } from './stemming.js';
import { withinEditDistance } from './edit-distance.js';
import {
  MIN_PREFIX_CHARS, PREFIX_SCORE_FACTOR, MIN_TYPO_CHARS,
  TYPO_SCAN_PREFIX_CHARS, TYPO_LONG_TERM_CHARS, VERIFY_SCAN_LIMIT,
  PREFIX_EXPANSION_LIMIT,
} from '../shared/constants.js';

const PRESCORE_LIMIT = 500;

// A widened word -- by prefix, stem or typo -- behaves as one word from
// here on. A document that contains "israel" twice and "israeli" once has
// three reasons to match "isra", and counting them as three is what makes
// the ranking sensible.
function mergeTermMatches(matches) {
  const merged = new Map();
  for (const match of matches) {
    for (const entry of match.docs) {
      const already = merged.get(entry.id);
      if (already) already.tf += entry.tf;
      else merged.set(entry.id, { id: entry.id, tf: entry.tf, pos: entry.pos });
    }
  }
  return [...merged.values()].sort((a, b) => a.id - b.id);
}

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
  {
    store, limit = 20, offset = 0, now = Date.now(), filters = {},
    stemLanguages = [],
  } = {}
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

  // And then, still only if it matched nothing: a stem, the start of a
  // longer word, or a small typo -- see the three fallbacks below, tried in
  // that order. Each is deliberately a last resort rather than the default:
  // a word with postings of its own is searched exactly, so "car" stays
  // "car" and never quietly becomes "carbon". Only a word that finds
  // nothing at all on its own is widened.
  //
  // Words inside a quoted phrase are never widened, by any of the three. A
  // phrase is checked against stored positions, and the positions of
  // several different words merged together do not describe any real
  // sentence.
  const expanded = {};
  const phraseTerms = new Set(q.phrases.flat());
  const canExpand = typeof store.readTermsWithPrefix === 'function';

  // Several languages often agree on a stem ("organ" for Spanish, Portuguese,
  // French and Italian alike), and the typo scan can land on a prefix a stem
  // scan already read. Each scan reads real posting lists, so one query reads
  // any given prefix once.
  const scans = new Map();
  const scanPrefix = (prefix, options) => {
    const key = prefix + '\u0000' + (options ? options.scan + ':' + options.limit : '');
    if (!scans.has(key)) scans.set(key, store.readTermsWithPrefix(prefix, options));
    return scans.get(key);
  };

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

      // Still only if it matched nothing: try the stem of the term, in
      // whichever languages are enabled. The index stores surface forms,
      // not stems, so this works by finding real terms that start with the
      // stem and share it -- the same prefix-scan the index already has,
      // not a second index.
      if (list.length === 0 && canExpand && stemLanguages.length && !phraseTerms.has(term)) {
        for (const lang of stemLanguages) {
          const stemmed = stem(term, lang);
          if (!stemmed || stemmed.length < MIN_PREFIX_CHARS) continue;
          const candidates = await scanPrefix(stemmed, {
            scan: VERIFY_SCAN_LIMIT,
            limit: VERIFY_SCAN_LIMIT,
          });
          const sameFamily = candidates.filter((c) => stem(c.term, lang) === stemmed);
          if (sameFamily.length) {
            list = mergeTermMatches(sameFamily);
            expanded[term] = sameFamily.map((c) => c.term);
            break;
          }
        }
      }

      // And then, still only if it matched nothing, at being the start of a
      // longer word. Deliberately a last resort rather than the default: a
      // word with postings of its own is searched exactly, so "car" stays
      // "car" and never quietly becomes "carbon". Only "isra", which finds
      // nothing at all on its own, is widened.
      if (
        list.length === 0 &&
        canExpand &&
        term.length >= MIN_PREFIX_CHARS &&
        !phraseTerms.has(term)
      ) {
        const matches = await scanPrefix(term);
        if (matches.length) {
          list = mergeTermMatches(matches);
          expanded[term] = matches.map((match) => match.term);
        }
      }

      // Last resort: a bounded typo. Reuses the same prefix scan, keyed on
      // the term's own first few characters rather than a stem, so it only
      // catches a typo that leaves the start of the word alone -- see
      // TYPO_SCAN_PREFIX_CHARS.
      if (list.length === 0 && canExpand && term.length >= MIN_TYPO_CHARS && !phraseTerms.has(term)) {
        const typoPrefix = term.slice(0, TYPO_SCAN_PREFIX_CHARS);
        const budget = term.length >= TYPO_LONG_TERM_CHARS ? 2 : 1;
        const candidates = await scanPrefix(typoPrefix, {
          scan: VERIFY_SCAN_LIMIT,
          limit: VERIFY_SCAN_LIMIT,
        });
        const close = candidates
          .filter((c) => withinEditDistance(term, c.term, budget))
          .slice(0, PREFIX_EXPANSION_LIMIT);
        if (close.length) {
          list = mergeTermMatches(close);
          expanded[term] = close.map((c) => c.term);
        }
      }

      const map = new Map();
      for (const entry of list) map.set(entry.id, entry);
      postingsByTerm.set(term, map);
      dfByTerm.set(term, list.length);
    })
  );

  // Excluded terms are looked up exactly, with none of the relaxation above:
  // the point of "-word" is to name a word precisely, not to guess at what
  // else might mean the same thing.
  const excludedIds = new Set();
  if (q.exclude.length) {
    const excludedLists = await Promise.all(q.exclude.map((term) => store.readTerm(term)));
    for (const list of excludedLists) for (const entry of list) excludedIds.add(entry.id);
  }

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

  // Applied after the AND/OR decision, not before, so excluding a word never
  // changes which mode the interface says it used.
  if (excludedIds.size) {
    for (const id of excludedIds) candidates.delete(id);
  }

  // Everything that decides whether a page is in the answer at all happens
  // here, on the whole candidate set, before anything is ranked or cut. The
  // ranking below reads only the first PRESCORE_LIMIT records, and applying
  // a filter after that cut meant that once more than PRESCORE_LIMIT
  // pages matched, a site or a date that was not already among the top few
  // hundred by score found nothing at all, and the total stopped at the cap.
  //
  // A filter typed into the query wins over the same filter set in the
  // interface, on the grounds that the more specific instruction is the one
  // the person just wrote.
  const site = q.site || filters.site || null;
  const after = q.after || filters.after || null;
  const before = q.before || filters.before || null;

  //
  // Two ways to apply them, which have to agree. When no more pages matched
  // than the ranking below reads anyway, their records are read once, now,
  // and the filters are applied to them: the usual case, a word or two that
  // matched a handful of pages. Past that, the site and date indexes are
  // walked instead, which costs the same however many pages matched, but
  // grows with the archive: measured at 5,000 pages, a rare word with a site
  // filter went from 7ms to over 100ms when it always took this road.
  const lo = after || -Infinity;
  // lastSeen is whole milliseconds, so "no later than before" is "earlier
  // than before + 1".
  const hi = before ? before + 1 : Infinity;
  const wantsRecords = !!(site || after || before || filters.sort === 'recent');
  const preloaded = wantsRecords && candidates.size && candidates.size <= PRESCORE_LIMIT
    ? await store.readDocs([...candidates])
    : null;
  const wantedSite = site ? String(site).toLowerCase().replace(/^www\./, '') : null;
  const onWantedSite = (domain) =>
    typeof domain === 'string' && (domain === wantedSite || domain.endsWith('.' + wantedSite));
  const inDates = (lastSeen) => Number.isFinite(lastSeen) && lastSeen >= lo && lastSeen < hi;

  if (preloaded) {
    for (const id of candidates) {
      const doc = preloaded.get(id);
      if (!doc || (site && !onWantedSite(doc.domain)) || ((after || before) && !inDates(doc.lastSeen))) {
        candidates.delete(id);
      }
    }
  } else {
    if (site && candidates.size) {
      const onSite = new Set(await store.pageIdsForSite(site));
      for (const id of candidates) if (!onSite.has(id)) candidates.delete(id);
    }
    if ((after || before) && candidates.size) {
      const inRange = new Set(await store.pageIdsBetween(lo, hi));
      for (const id of candidates) if (!inRange.has(id)) candidates.delete(id);
    }
  }
  // Phrases are checked against positions already in memory, so this costs
  // no reads, and it has to happen before the count is taken.
  if (q.phrases.length) {
    for (const id of candidates) {
      if (!q.phrases.every((p) => phraseHit(p, postingsByTerm, id))) candidates.delete(id);
    }
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

  // Stage one: an order for every candidate that needs no record reads.
  // Newest first comes straight off the lastSeen index; best match is a
  // cheap score from the postings already in memory.
  let order;
  if (filters.sort === 'recent' && preloaded) {
    // The same order the lastSeen index gives, read backwards: newest
    // first, and the higher id first between two read in the same moment.
    order = [...candidates]
      .filter((id) => Number.isFinite(preloaded.get(id).lastSeen))
      .sort((a, b) => preloaded.get(b).lastSeen - preloaded.get(a).lastSeen || b - a);
  } else if (filters.sort === 'recent') {
    order = [];
    for (const id of await store.pageIdsByRecency()) {
      if (candidates.has(id)) order.push(id);
    }
  } else {
    const prescored = [];
    for (const id of candidates) {
      let s = 0;
      for (const term of q.lookup) {
        const entry = postingsByTerm.get(term).get(id);
        if (entry) s += idf(dfByTerm.get(term), stats.docCount) * (1 + Math.log(entry.tf));
      }
      prescored.push([id, s]);
    }
    prescored.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    order = prescored.map(([id]) => id);
  }

  // Stage two: the first PRESCORE_LIMIT of that order are read and ranked
  // properly. Anything past them keeps the stage one order, and is read only
  // when somebody pages that far. The head is always the same pages ranked
  // the same way however deep the paging goes, so no page of results can
  // repeat or skip a match that another page showed.
  const head = order.slice(0, PRESCORE_LIMIT);
  const tail = offset + limit > PRESCORE_LIMIT ? order.slice(PRESCORE_LIMIT, offset + limit) : [];
  const docs = preloaded || await store.readDocs([...head, ...tail]);

  const scored = [];
  for (const id of head) {
    const doc = docs.get(id);
    if (!doc) continue;

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

  if (filters.sort !== 'recent') scored.sort((a, b) => b.score - a.score || a.id - b.id);
  const ranked = scored.concat(
    tail.filter((id) => docs.has(id)).map((id) => ({ id, score: 0, doc: docs.get(id) }))
  );

  // Every candidate passed every filter above, so this is the real count. A
  // record that vanished between the index read and the page read (a sweep
  // running alongside) is the only way it can be off, by that page.
  const total = candidates.size - (head.length + tail.length - ranked.length);

  const page = ranked.slice(offset, offset + limit);

  // Domains of what was read for ranking, which is every match up to
  // PRESCORE_LIMIT: enough to offer a site filter that means something
  // without reading every record in a very broad match.
  const domains = new Map();
  for (const { doc } of scored) {
    domains.set(doc.domain, (domains.get(doc.domain) || 0) + 1);
  }

  return {
    mode,
    relaxed,
    expanded,
    total,
    hasMore: offset + limit < total,
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
