import { test } from 'node:test';
import assert from 'node:assert/strict';
import { urlKey, domainOf, canonicalFor } from '../src/core/url-key.js';

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

test('a canonical address may tidy the address a page was read at', () => {
  assert.equal(canonicalFor('http://example.com/story?utm_source=x', 'https://www.example.com/story/'),
    'https://www.example.com/story/');
  assert.equal(canonicalFor('https://example.com/story?id=7&sort=new', 'https://example.com/story?id=7'),
    'https://example.com/story?id=7');
  assert.equal(canonicalFor('https://example.com/story#part-2', 'https://example.com/story'),
    'https://example.com/story');
});

test('a canonical address naming the home page does not merge every article into it', () => {
  assert.equal(canonicalFor('https://example.com/2026/09/first-article', 'https://example.com/'),
    'https://example.com/2026/09/first-article');
  assert.equal(canonicalFor('https://example.com/2026/09/second-article', 'https://example.com'),
    'https://example.com/2026/09/second-article');
});

test('a stale canonical left behind by a single page app is not used', () => {
  assert.equal(canonicalFor('https://news.example/articles/two', 'https://news.example/articles/one'),
    'https://news.example/articles/two');
});

test('a canonical address cannot add or change a parameter, or move to another site', () => {
  assert.equal(canonicalFor('https://example.com/view?id=5', 'https://example.com/view?id=1'),
    'https://example.com/view?id=5');
  assert.equal(canonicalFor('https://example.com/view', 'https://example.com/view?id=1'),
    'https://example.com/view');
  assert.equal(canonicalFor('https://example.com/story', 'https://partner.example/story'),
    'https://example.com/story');
  assert.equal(canonicalFor('https://example.com/story', 'https://example.com:8443/story'),
    'https://example.com/story');
  assert.equal(canonicalFor('https://example.com/story', 'javascript:alert(1)'), 'https://example.com/story');
  assert.equal(canonicalFor('https://example.com/story', 'not a url'), 'https://example.com/story');
  assert.equal(canonicalFor('https://example.com/story', null), 'https://example.com/story');
});
