# Reads "<lang>\t<word>" lines on stdin, writes one stem per line on stdout,
# using Python's snowballstemmer as an oracle the vendored JavaScript is
# checked against. See verify-stemmers.mjs.
import sys
import snowballstemmer

stemmers = {}
for line in sys.stdin:
    lang, word = line.rstrip('\n').split('\t', 1)
    if lang not in stemmers:
        stemmers[lang] = snowballstemmer.stemmer(lang)
    sys.stdout.write(stemmers[lang].stemWord(word) + '\n')
