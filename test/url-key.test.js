import { test } from 'node:test';
import assert from 'node:assert/strict';
import { urlKey, domainOf } from '../src/core/url-key.js';

test('strips tracking parameters but keeps real ones', () => {
  assert.equal(
    urlKey('https://example.com/post?utm_source=news&id=7&fbclid=xyz'),
    'https://example.com/post?id=7'
  );
});

test('keeps a bare ref, because some sites route content through it', () => {
  assert.equal(urlKey('https://example.com/p?ref=abc'), 'https://example.com/p?ref=abc');
});

test('sorts query parameters so order does not create duplicates', () => {
  assert.equal(urlKey('https://e.com/a?b=2&a=1'), urlKey('https://e.com/a?a=1&b=2'));
});

test('drops www, the fragment and a trailing slash', () => {
  assert.equal(urlKey('https://WWW.Example.com/path/#section'), 'https://example.com/path');
});

test('keeps the root slash', () => {
  assert.equal(urlKey('https://example.com/'), 'https://example.com/');
});

test('does not merge pages that differ in a real parameter', () => {
  assert.notEqual(urlKey('https://e.com/s?q=cats'), urlKey('https://e.com/s?q=dogs'));
});

test('rejects anything that is not a web page', () => {
  assert.equal(urlKey('chrome://extensions'), null);
  assert.equal(urlKey('file:///tmp/x.html'), null);
  assert.equal(urlKey('not a url'), null);
});

test('domainOf strips www', () => {
  assert.equal(domainOf('https://www.example.com/x'), 'example.com');
});
