# Privacy policy

Last updated: 16 September 2026

## The short version

This extension does not collect anything, because there is nowhere for
anything to go. There is no server, no account and no network connection of
any kind. Everything it stores stays in your browser, on your computer, and is
deleted when you delete it.

## What it stores

When you genuinely read a page, meaning you had it in the foreground for
several seconds and either scrolled it or it was short enough not to need
scrolling, the extension extracts the main text and keeps it so you can search
for it later. For each such page it stores:

- the address, and a normalised copy of it used to recognise the same page again
- the title and the extracted body text
- the domain
- when you first and last read it, and how many times
- a content hash, used to notice when a page has changed
- whether you pinned it

It also stores your own settings: which capture mode you chose, your
exclusions and allowlist, and your storage limits.

All of it lives in your browser's local storage for this extension. None of it
is sent anywhere. None of it is synchronised to your other browsers, because
the extension writes to Chrome's local storage area and never to the
synchronised one.

## What it never stores

- Pages with a password field on them, whether or not you typed anything
- Anything at all in incognito windows
- Anything excluded by your rules. Webmail, banking and finance, health,
  adult, government portals and local network addresses are excluded by
  default, before you change a thing
- Anything that is not an ordinary web page, so no local files, no browser
  pages, no media
- Anything, anywhere, if you have paused capture or not finished setup

## Who it is shared with

Nobody. There is no analytics, no telemetry, no crash reporting, no
advertising identifier and no third party service. The extension makes no
network requests, and its own pages are locked down so that they cannot, even
by accident. You can confirm this yourself: the source is public and the
relevant search is one command, which the threat model spells out.

## Your control over it

- **See it.** The search page and the popup show everything that is kept.
- **Export it.** One button produces a plain JSON file containing the full
  text of every page. It is readable in any text editor, without this
  extension existing.
- **Delete some of it.** Forget a page, a site or a day, from the popup or the
  search results. Excluding a site also deletes what was already kept from it.
- **Delete all of it.** One button in settings, and it is gone.

Uninstalling the extension removes its storage as well, in the ordinary way
Chrome removes an extension's data.

## Children

This extension is not directed at children and collects nothing from anybody,
children included.

## Changes

If a future version ever changed what is stored or introduced any form of
network access, that would be a change to this document and to the threat
model, both of which are versioned in the public repository alongside the
code. The history is the record.

## Contact

Open an issue on the project's repository.
