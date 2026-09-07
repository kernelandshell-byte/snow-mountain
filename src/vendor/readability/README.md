# Vendored: Mozilla Readability 0.6.0

`Readability.js` is taken unmodified from `@mozilla/readability` 0.6.0,
Apache License 2.0, licence text in `LICENSE.md`.

Vendored rather than installed because this extension ships no build step
and has no runtime dependencies. It is loaded as a classic script, which is
what a content script can actually execute, and it defines a `Readability`
global rather than exporting a module.

It is not injected into every page. The observer decides a page is worth
keeping first, and only then does the service worker inject this file and
`src/content/extract.js` into that one tab. Injecting 90KB of parser into
every page a person opens would be a strange thing to do to their browser.

To update: `npm pack @mozilla/readability`, copy `Readability.js` and
`LICENSE.md` out of the tarball, and run the extraction test.
