// Reads an export a page at a time, from a stream, so that an archive of any
// size can be imported back.
//
// Export was written never to hold the archive in one string, because a real
// archive does not fit in one. Import then read the same file with
// JSON.parse(await file.text()), which is one string by definition: an
// archive large enough to need the careful export was exactly the one that
// could not be imported again. This walks the JSON as it streams, keeps only
// the page it is in the middle of, and parses each page on its own.
//
// It understands just enough JSON to find its way: strings (with escapes),
// nesting, and the top-level "format" and "pages" keys. Each page is handed
// to JSON.parse, so a page is exactly as strictly checked as before.
//
// Yields, in order:
//   { type: 'format', value }          the file's format identifier
//   { type: 'page', value, read }      one page; `read` is characters so far
//   { type: 'bad', read }              a page that is not valid JSON
//   { type: 'truncated' }              the file ended part way through

export async function* readExport(stream) {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let depth = 0;
  let inString = false;
  let escape = false;
  let text = null; // a string being collected at the top level
  let lastString = null;
  let pendingKey = null; // the key whose value comes next, at the top level
  let inPages = false;
  let pieces = null; // the page being collected, across chunks
  let read = 0;

  for (;;) {
    const { done, value: chunk } = await reader.read();
    if (done) break;
    let start = pieces ? 0 : -1;
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i];
      if (inString) {
        if (escape) {
          escape = false;
          if (text !== null) text += c;
        } else if (c === '\\') {
          escape = true;
          if (text !== null) text += c;
        } else if (c === '"') {
          inString = false;
          if (text !== null) {
            const value = JSON.parse('"' + text + '"');
            text = null;
            if (pendingKey === null) lastString = value;
            else if (pendingKey === 'format') yield { type: 'format', value };
          }
        } else if (text !== null) {
          text += c;
        }
        continue;
      }

      if (c === '"') {
        inString = true;
        if (depth === 1 && !pieces) text = '';
      } else if (c === '{' || c === '[') {
        if (depth === 1 && c === '[' && pendingKey === 'pages') inPages = true;
        if (inPages && depth === 2 && c === '{') {
          pieces = [];
          start = i;
        }
        depth += 1;
      } else if (c === '}' || c === ']') {
        depth -= 1;
        if (pieces && depth === 2) {
          pieces.push(chunk.slice(start, i + 1));
          const raw = pieces.join('');
          pieces = null;
          start = -1;
          let page;
          try {
            page = JSON.parse(raw);
          } catch {
            yield { type: 'bad', read: read + i };
            continue;
          }
          yield { type: 'page', value: page, read: read + i };
        }
        if (inPages && depth === 1) inPages = false;
      } else if (depth === 1 && c === ':') {
        pendingKey = lastString;
      } else if (depth === 1 && c === ',') {
        pendingKey = null;
      }
    }
    if (pieces && start !== -1) pieces.push(chunk.slice(start));
    read += chunk.length;
  }

  if (depth !== 0 || inString) yield { type: 'truncated' };
}
