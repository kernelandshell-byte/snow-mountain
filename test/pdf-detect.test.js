import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikePdf } from '../src/core/pdf-detect.js';

const pdfHead = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // "%PDF-1.4"

test('a real pdf header is recognised', () => {
  assert.equal(looksLikePdf(pdfHead), true);
});

test('an html error page served as application/pdf is not fooled', () => {
  const html = new TextEncoder().encode('<!doctype html><html><body>Please log in</body></html>');
  assert.equal(looksLikePdf(html), false);
});

test('an empty response is not a pdf', () => {
  assert.equal(looksLikePdf(new Uint8Array(0)), false);
});

test('a response shorter than the magic header is not a pdf', () => {
  assert.equal(looksLikePdf(new Uint8Array([0x25, 0x50])), false);
});

test('a plain ArrayBuffer works the same as a Uint8Array', () => {
  assert.equal(looksLikePdf(pdfHead.buffer), true);
});

test('nothing at all is not a pdf', () => {
  assert.equal(looksLikePdf(undefined), false);
});
