# Vendored: Snowball stemmers

Seven query-time stemmers used only as a last-resort fallback when a search
term has zero postings of its own (see `src/core/stemming.js` and
`src/core/index-reader.js`). Never applied at index time, so nothing in
storage is affected and a term that really exists always wins over a
stemmed guess.

All of them come from the official Snowball compiler's own `-js` code
generator (`snowballstem/snowball` on GitHub, BSD-3-Clause, licence text in
`LICENSE.md`), the same project the algorithms themselves are defined by.
Each language file is `export default class extends BaseStemmer { stem(word) {...} }`,
already a plain ES module with no bundler, UMD shim or `lunr` global to
satisfy. They come in two kinds.

**Unmodified**: `english.js`, `spanish.js`, `german.js`, `dutch.js`, and
`base-stemmer.js`. Exactly what the compiler writes.

**Accent folded**: `french-folded.js`, `portuguese-folded.js`,
`italian-folded.js`. The tokenizer strips accents before anything is
indexed or searched, so a stemmer only ever sees "informacoes", never
"informações". The unmodified French, Portuguese and Italian algorithms
look for accented suffixes ("-ité", "-ção", "-ità") and so miss them on
folded text, which breaks about three in ten French and Portuguese word
families. These three are compiled from the same `.sbl` sources after a
mechanical rewrite by `tools/fold-snowball.mjs` that makes the suffix
tables match the folded endings. It adds no rule of its own; the header of
each file says it was produced that way. Spanish is deliberately left
unmodified: its accents are grammatical ("-ía" is a verb ending, "-ia" is
not), and folding its suffixes made it strip "acacia" to "acac".

## Checked

`test/oracle/verify-stemmers.mjs` checks every language against Python's
`snowballstemmer` (the same project's own Python port) over 15,000 real
dictionary words each (`/usr/share/dict/american-english`, `spanish`,
`portuguese`, `ngerman`, `french`, `italian`, `dutch`), fed through this
project's own folding first. Last run, compiler and oracle both 3.1.1:

| | kind | against the oracle | families kept | grouped correctly |
|---|---|---|---|---|
| en | unmodified | 0 mismatches | 100.0% | 99.9% |
| es | unmodified | 0 mismatches | 93.5% | 97.2% |
| pt | folded | (unmodified: 71.5%, 97.4%) | 99.4% | 97.4% |
| de | unmodified | 0 mismatches | 100.0% | 100.0% |
| fr | folded | (unmodified: 70.5%, 98.6%) | 98.0% | 98.4% |
| it | folded | (unmodified: 89.9%, 99.7%) | 99.3% | 99.6% |
| nl | unmodified | 0 mismatches | 100.0% | 99.6% |

"Families kept" is, of every pair of words the real algorithm gives the
same stem when run on the real accented words, the share that still share
a stem after folding: what the search fallback can actually find. "Grouped
correctly" is the reverse, so that merging everything cannot score well.

An earlier version of this vendoring hand-extracted the algorithm from
`lunr.js`/`lunr-languages` (2010-2016 vintage), which measurably lagged the
current algorithms: about 2% mismatch for English, 5% for German and 47%
for Dutch, whose port was the older `dutch_porter`.

## To update

```
git clone https://github.com/snowballstem/snowball && cd snowball && make
for lang in english spanish german dutch; do
  ./snowball algorithms/$lang.sbl -js -o <this directory>/$lang
done
for lang in french portuguese italian; do
  node <repo>/tools/fold-snowball.mjs . $lang <this directory>/$lang-folded.js
done
cp javascript/base-stemmer.js <this directory>/
cp COPYING <this directory>/LICENSE.md
```

Then `npm test`, and `node test/oracle/verify-stemmers.mjs` (it needs
`python3`, `pip install snowballstemmer` at the same version, and the word
lists from `apt-get install wamerican wspanish wportuguese wngerman wfrench
witalian wdutch`). It fails if an unmodified stemmer disagrees with the
oracle on a single word, or if a folded one stops beating the unmodified
algorithm.
