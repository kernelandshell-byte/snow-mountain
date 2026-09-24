// Checks the vendored Snowball stemmers against an independent oracle,
// Python's snowballstemmer, over real dictionary words. Not part of `npm
// test`, because it needs Python and the system word lists:
//
//   apt-get install wamerican wngerman wdutch wfrench wspanish wportuguese witalian
//   pip install snowballstemmer
//   node test/oracle/verify-stemmers.mjs [words-per-language]
//
// Two checks, because the vendored stemmers come in two kinds.
//
// Unmodified (English, Spanish, German, Dutch): given the folded word, the
// vendored stemmer has to agree with the oracle given the same folded word,
// every time. A single mismatch is a vendoring problem and fails the run.
//
// Accent folded (French, Portuguese, Italian; see tools/fold-snowball.mjs):
// these deliberately differ from the oracle on folded input, so what is
// checked is what they are for. Take the word families the real algorithm
// finds on real, accented words, and count how many pairs of words in a
// family still share a stem once everything is folded. The folded build has
// to keep more of them than the unmodified algorithm would, or it is not
// earning its place.
//
// Families kept is reported for every language, since it is the number
// that says what the search fallback will actually find.

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { foldTerm, terms } from '../../src/core/tokenizer.js';
import { STEM_LANGUAGES, stem } from '../../src/core/stemming.js';

const here = dirname(fileURLToPath(import.meta.url));
const perLanguage = Number(process.argv[2]) || 15000;

const LISTS = {
  en: ['english', '/usr/share/dict/american-english', 'unmodified'],
  es: ['spanish', '/usr/share/dict/spanish', 'unmodified'],
  pt: ['portuguese', '/usr/share/dict/portuguese', 'folded'],
  de: ['german', '/usr/share/dict/ngerman', 'unmodified'],
  fr: ['french', '/usr/share/dict/french', 'folded'],
  it: ['italian', '/usr/share/dict/italian', 'folded'],
  nl: ['dutch', '/usr/share/dict/dutch', 'unmodified'],
};

// Deterministic, so a mismatch found once is found again.
function sample(words, n) {
  let seed = 1234567;
  const next = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const copy = [...words];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

function oracle(algorithm, words) {
  const input = words.map((word) => algorithm + '\t' + word).join('\n') + '\n';
  const run = spawnSync('python3', [join(here, 'stem.py')], { input, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (run.status !== 0) throw new Error(run.stderr || 'python3 failed');
  return run.stdout.split('\n').slice(0, words.length);
}

// Of every pair of words the real algorithm puts in one family, the share
// that `stems` still puts in one family.
function familiesKept(truth, stems) {
  const families = new Map();
  truth.forEach((key, i) => {
    if (!families.has(key)) families.set(key, []);
    families.get(key).push(stems[i]);
  });
  let pairs = 0;
  let kept = 0;
  for (const members of families.values()) {
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        pairs += 1;
        if (members[i] === members[j]) kept += 1;
      }
    }
  }
  return pairs ? kept / pairs : 1;
}

// The other direction: of every pair `stems` puts in one family, the share
// the real algorithm agrees belongs together. Keeping families by merging
// everything would score perfectly above and badly here.
const precision = (truth, stems) => familiesKept(stems, truth);

const percent = (fraction) => (fraction * 100).toFixed(1) + '%';

let failed = false;
for (const lang of STEM_LANGUAGES) {
  const entry = LISTS[lang];
  if (!entry || !existsSync(entry[1])) {
    console.log(lang + ': no word list, skipped');
    continue;
  }
  const [algorithm, path, kind] = entry;
  // Only words the tokenizer would keep as a single term: no apostrophes,
  // hyphens or anything else that would split them.
  const raw = [...new Set(readFileSync(path, 'utf8').split('\n').map((w) => w.trim()).filter(Boolean))]
    .map((w) => w.normalize('NFC').toLowerCase())
    .filter((w) => terms(w).length === 1 && terms(w)[0] === foldTerm(w));
  const words = sample(raw, perLanguage);
  const folded = words.map(foldTerm);

  const vendored = folded.map((w) => stem(w, lang));
  const oracleOnFolded = oracle(algorithm, folded);
  const truth = oracle(algorithm, words);

  const ours = familiesKept(truth, vendored);
  const unmodified = familiesKept(truth, oracleOnFolded);
  const oursPrecise = precision(truth, vendored);
  const unmodifiedPrecise = precision(truth, oracleOnFolded);
  let line = lang + ': ' + words.length + ' words, ' + kind + ', families kept ' + percent(ours) +
    ', grouped correctly ' + percent(oursPrecise);

  if (kind === 'unmodified') {
    const mismatches = [];
    folded.forEach((w, i) => {
      if (vendored[i] !== oracleOnFolded[i]) {
        mismatches.push(w + ': vendored ' + vendored[i] + ', oracle ' + oracleOnFolded[i]);
      }
    });
    line += ', ' + mismatches.length + ' mismatches against the oracle';
    console.log(line);
    for (const mismatch of mismatches.slice(0, 10)) console.log('  ' + mismatch);
    if (mismatches.length) failed = true;
  } else {
    line += ' (unmodified: ' + percent(unmodified) + ', ' + percent(unmodifiedPrecise) + ')';
    console.log(line);
    // Better at finding families, and not buying it by grouping words that
    // do not belong together: a point of precision is the most it may give.
    if (ours <= unmodified || oursPrecise < unmodifiedPrecise - 0.01) {
      console.log('  the folded build is not doing better than the unmodified algorithm');
      failed = true;
    }
  }
}
process.exit(failed ? 1 : 0);
