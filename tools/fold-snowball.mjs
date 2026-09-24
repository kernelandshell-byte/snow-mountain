// Compiles a Snowball algorithm for text that has already been accent
// folded, which is the only text a stemmer ever sees here: the tokenizer
// strips combining marks before anything is indexed or searched.
//
//   node tools/fold-snowball.mjs <snowball-checkout> <language> <out.js>
//
// The unmodified French algorithm strips "-ité", "-é" and "-ées". After
// folding those endings arrive as "-ite", "-e" and "-ees", which it never
// matches, so "généralité" and "général" stop sharing a stem. Measured over
// real dictionaries this breaks about three in ten French and Portuguese
// word families.
//
// The transform is mechanical and adds no rule of its own:
//
// 1. Only the suffix stripping, inside backwardmode, is touched. The
//    forward prelude and postlude rewrite accented letters into markers and
//    back ("ë" to "He" in French), and folding those turns a rewrite of a
//    rare letter into a rewrite of every "e", which never terminates.
// 2. Inside it, every accented letter in a string is replaced by its folded
//    form, and so is any marker the prelude would have produced from one
//    (Portuguese turns "ã" into "a~" before stripping, so its suffix tables
//    say "a~o" where the text says "ão").
// 3. Where that makes a string identical to a plain one already in the same
//    among() list, the rewritten copy is dropped: the plain one already says
//    what folded input should do, and an among() may not hold both.
//
// The Snowball compiler then runs on the result exactly as it would on the
// original, and refuses anything left ambiguous. Checked afterwards by
// test/oracle/verify-stemmers.mjs, against the unmodified algorithm run on
// the real, accented words.

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const [checkout, language, out] = process.argv.slice(2);
if (!checkout || !language || !out) {
  console.error('usage: node tools/fold-snowball.mjs <snowball-checkout> <language> <out.js>');
  process.exit(2);
}

const fold = (text) =>
  text.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/ß/g, 'ss');
const codes = (text) =>
  [...text].map((c) => '{U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0') + '}').join('');

// A string literal, allowing for escapes that themselves contain a quote,
// such as {a'} for a-acute.
const LITERAL = /'((?:\{[^}]*\}|[^'{])*)'/g;
const SUFFIX = '~f';

let source = readFileSync(join(checkout, 'algorithms', language + '.sbl'), 'utf8');

// Every escape naming a letter that folding changes gets a folded twin,
// defined beside it. The twin's name marks a string as rewritten, which is
// how step 3 knows which copy to drop.
const folding = new Map();
source = source.replace(
  /^(stringdef\s+(\S+)\s+)'\{U\+([0-9A-Fa-f]+)\}'(.*)$/gm,
  (line, head, name, hex) => {
    const letter = String.fromCodePoint(parseInt(hex, 16));
    const folded = fold(letter);
    if (folded === letter) return line;
    folding.set(name, folded);
    return line + '\nstringdef ' + name + SUFFIX + " '" + codes(folded) + "'";
  }
);

// Markers the prelude writes in place of a folding letter: '{a~}' (<- 'a~').
const markers = new Map();
for (const m of source.matchAll(/'\{([^}]+)\}'\s*\]?\s*\(?\s*<-\s*'([^'{]+)'/g)) {
  if (folding.has(m[1]) && m[2].length > 1) markers.set(m[2], m[1]);
}

// The balanced span of each backwardmode ( ... ).
function backwardSpans(text) {
  const spans = [];
  for (const m of text.matchAll(/backwardmode\s*\(/g)) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (ch === "'") {
        const scan = new RegExp(LITERAL.source, 'y');
        scan.lastIndex = i;
        const lit = scan.exec(text);
        if (lit) i += lit[0].length - 1;
      } else if (ch === '/' && text[i + 1] === '/') {
        i = text.indexOf('\n', i);
      } else if (ch === '(') depth += 1;
      else if (ch === ')' && --depth === 0) break;
    }
    spans.push([m.index, i]);
  }
  return spans;
}

function rewriteLiteral(body) {
  let next = body.replace(/\{([^}]+)\}/g, (all, name) => (folding.has(name) ? '{' + name + SUFFIX + '}' : all));
  for (const [marker, name] of markers) {
    next = next.split(marker).join('{' + name + SUFFIX + '}');
  }
  return next;
}

{
  let rebuilt = '';
  let cursor = 0;
  for (const [start, end] of backwardSpans(source)) {
    rebuilt += source.slice(cursor, start);
    rebuilt += source.slice(start, end).replace(LITERAL, (all, body) => "'" + rewriteLiteral(body) + "'");
    cursor = end;
  }
  source = rebuilt + source.slice(cursor);
}

const rewritten = (literal) => literal.includes(SUFFIX + '}');
const spelled = (literal) =>
  literal.replace(/\{([^}]+)\}/g, (all, name) =>
    name.endsWith(SUFFIX) ? folding.get(name.slice(0, -SUFFIX.length)) : all
  );

// Removes one string literal from an among() list, taking its action with it
// if it was the only string that action belonged to.
function dropLiteral(text, offset, length) {
  let next = text.slice(0, offset) + text.slice(offset + length);
  const after = next.slice(offset).replace(/^(\s|\/\/[^\n]*)*/, '');
  const before = next.slice(0, offset).replace(/(\s|\/\/[^\n]*)*$/, '');
  if (!(after.startsWith('(') && (before.endsWith(')') || before.endsWith('among(')))) return next;

  const start = next.length - after.length;
  let depth = 0;
  let end = start;
  for (; end < next.length; end++) {
    if (next[end] === "'") {
      const scan = new RegExp(LITERAL.source, 'y');
      scan.lastIndex = end;
      const lit = scan.exec(next);
      if (lit) end += lit[0].length - 1;
    } else if (next[end] === '(') depth += 1;
    else if (next[end] === ')' && --depth === 0) break;
  }
  return next.slice(0, start) + next.slice(end + 1);
}

const lineStart = (text, lineNo) => {
  let at = 0;
  for (let n = 1; n < lineNo; n++) at = text.indexOf('\n', at) + 1;
  return at;
};

const dir = mkdtempSync(join(tmpdir(), 'fold-snowball-'));
const sbl = join(dir, language + '.sbl');
const compiler = join(checkout, 'snowball');

for (let attempt = 0; attempt < 500; attempt++) {
  writeFileSync(sbl, source);
  const run = spawnSync(compiler, [sbl, '-js', '-o', join(dir, language)], { encoding: 'utf8' });
  const errors = (run.stderr || '').split('\n').filter((line) => line && !line.includes('warning:'));
  if (run.status === 0 && !errors.length) {
    const generated = readFileSync(join(dir, language + '.js'), 'utf8').replace(
      /^\/\/ Generated from (\S+) by (Snowball \S+)/m,
      '// Generated from $1 by $2, accent folded by tools/fold-snowball.mjs'
    );
    writeFileSync(out, generated);
    process.exit(0);
  }

  const repeat = errors.findIndex((line) => line.includes('has repeated string'));
  if (repeat < 0) {
    console.error(errors.join('\n'));
    process.exit(1);
  }
  const lines = [errors[repeat], errors[repeat + 1] || '']
    .map((line) => Number(line.match(/:(\d+):/)?.[1]))
    .filter(Boolean);

  // Of the two copies the compiler names, drop the one this script wrote.
  // Both lines are searched because either can be the later one.
  let dropped = false;
  const clashes = new Map();
  for (const lineNo of lines) {
    const from = lineStart(source, lineNo);
    const to = source.indexOf('\n', from);
    for (const m of source.slice(from, to).matchAll(LITERAL)) {
      const key = spelled(m[1]);
      clashes.set(key, [...(clashes.get(key) || []), { lit: m[1], at: from + m.index, len: m[0].length }]);
    }
  }
  for (const group of clashes.values()) {
    const plain = group.find((entry) => !rewritten(entry.lit));
    const copy = group.find((entry) => rewritten(entry.lit) && entry !== plain);
    const pair = plain && copy ? copy : group.length > 1 ? group.find((e) => rewritten(e.lit)) : null;
    if (pair) {
      source = dropLiteral(source, pair.at, pair.len);
      dropped = true;
      break;
    }
  }
  if (!dropped) {
    console.error('could not resolve: ' + errors.slice(repeat, repeat + 2).join(' / '));
    process.exit(1);
  }
}
console.error('gave up after too many rounds');
process.exit(1);
