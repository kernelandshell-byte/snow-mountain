import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readExport } from '../src/ui/shared/export-reader.js';

// Bytes in awkward pieces, so every boundary case -- a split inside a string,
// an escape, a multi-byte character, a brace -- actually happens.
function streamOf(text, size = 7) {
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(at, at + size));
      at += size;
    },
  });
}

async function collect(text, size) {
  const out = [];
  for await (const event of readExport(streamOf(text, size))) out.push(event);
  return out;
}

const pages = [
  { url: 'https://a.example/1', title: 'Quotes "inside" and a \\ backslash', text: 'Braces { and } and [brackets], ünïcödé, 中文, emoji 🎉' },
  { url: 'https://b.example/2', title: 'Second', text: 'Plain text', pinned: true },
];
const exported = '{\n  "format": "reading-archive-export",\n  "version": 1,\n  "settings": {"format":"not this one","pages":[{"url":"nope"}]},\n  "pages": [\n' +
  pages.map((p) => '    ' + JSON.stringify(p)).join(',\n') + '\n  ]\n}\n';

test('reads the format and every page, whatever the chunk size', async () => {
  for (const size of [1, 3, 7, 64, 100000]) {
    const events = await collect(exported, size);
    assert.deepEqual(events.filter((e) => e.type === 'format').map((e) => e.value), ['reading-archive-export'], 'size ' + size);
    assert.deepEqual(events.filter((e) => e.type === 'page').map((e) => e.value), pages, 'size ' + size);
    assert.equal(events.some((e) => e.type === 'truncated' || e.type === 'bad'), false);
  }
});

test('keys with the same names nested elsewhere are not mistaken for the real ones', async () => {
  const events = await collect(exported, 5);
  assert.equal(events.filter((e) => e.type === 'page').some((e) => e.value.url === 'nope'), false);
});

test('a file cut off part way says so, after the pages it did get', async () => {
  const events = await collect(exported.slice(0, exported.length - 60), 11);
  assert.equal(events.at(-1).type, 'truncated');
  assert.equal(events.filter((e) => e.type === 'page').length, 1);
});

test('the same as JSON.parse on a file written in one line', async () => {
  const oneLine = JSON.stringify({ format: 'snow-mountain-export', pages });
  const events = await collect(oneLine, 13);
  assert.deepEqual(events.filter((e) => e.type === 'page').map((e) => e.value), JSON.parse(oneLine).pages);
});
