# TextMemory Privacy Policy

Effective date: 23 September 2026

This policy explains what information the TextMemory browser extension
("TextMemory", "the extension") handles, how it is used, and the choices you
have. TextMemory is designed so that your information never leaves your
computer.

## 1. Summary

TextMemory saves the text of web pages you read so that you can search them
later. All of this information is stored locally in your browser. It is not
sent to the developer or to any third party. TextMemory has no user
accounts, no servers, and no analytics.

## 2. Information the extension stores

When you read a web page, meaning the page was in front of you for a few
seconds and you scrolled it (or it was too short to need scrolling),
TextMemory stores the following on your device:

- the page address (URL) and title. If the page names a tidier form of its
  own address (a "canonical" address: the same page, without some of the
  parameters after the "?"), that form is stored instead, unless your
  exclusions cover it
- the main text content of the page
- the date and time you first and last read it, and the number of visits
- whether you have pinned the page
- a search index built from the title and text, so they can be searched

The same applies to PDF documents you read in Chrome: their text is stored,
not the file itself.

TextMemory also stores your settings, such as which sites to include or
exclude, how long pages are kept, how much storage may be used, and the
languages search should recognise, and a log of what has been removed and
when (how many pages and how much space, not which pages).

While your browser is open, TextMemory also keeps in memory, for each open
tab, whether the page in it was saved and if not why not, so that its button
can tell you. This is never written to disk and is discarded when the tab or
the browser closes.

## 3. Pages the extension skips

TextMemory is designed to skip the pages below. The first two are
recognised automatically from what is on the page and in its address, and
that recognition is not perfect: a page that hides its fields in an unusual
way, or an address that carries a key under an unusual name, can be missed.
If you read sensitive pages on sites that are not excluded by default, add
those sites to your own exclusions, or use the mode that saves only sites
you add one by one.

TextMemory skips:

- pages it detects asking for a password, a card number or a one-time code
- pages whose address it detects contains a sign-in or access key, such as
  password reset links
- anything viewed in an incognito window
- local files, browser settings pages, and other content that is not an
  ordinary web page or PDF
- anything while capture is paused, or before setup is complete. Until you
  finish setup, the extension does not run in web pages at all

It also skips sites in the exclusion categories you leave switched on. By
default these are webmail, messaging, AI chat assistants, password managers
and account settings pages, banking and payments, health, adult sites,
dating, government and identity portals, local network addresses and
routers, work tools, and search engine results pages.

Each category covers a list of common sites, not every site of its kind.
When an update adds a new category, it applies to pages you read from then
on; for pages you saved before, the settings page asks whether to remove
them or keep them.
You can add your own sites to skip at any time, choose to save only sites
you add one by one, and review or delete anything that has been saved.

## 4. How the information is used

The stored information is used for one purpose only: to let you search the
pages you have read and return to them. It is not used for advertising,
profiling, analytics, or any other purpose.

## 5. Where the information is kept

All information is kept in the extension's own storage inside your Chrome
profile, on your device. It is not synchronised to other devices or
browsers, and it is not uploaded anywhere.

## 6. Network requests

TextMemory does not transmit your information over the network.

The extension makes one kind of network request, for PDF documents only.
Chrome's built-in PDF viewer does not give extensions access to the file it
displays, so to read the text of a PDF you are viewing, TextMemory requests
the same PDF again from the address already open in your tab. This request
goes only to the website you are already viewing and contains no information
from TextMemory. To that website it looks like your browser downloading the
file a second time, with the same cookies your browser would send for it
anyway. It is made only for PDFs you have read on sites you have not
excluded.

## 7. Sharing

TextMemory does not sell, rent, share, or transfer your information to
anyone. The developer has no access to it.

TextMemory's use of information complies with the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq),
including the Limited Use requirements.

## 8. Your choices and control

You can, at any time:

- view and search everything that has been stored
- export all stored pages to a JSON file from the settings page. The file
  contains the full text of every page, so keep it somewhere private
- delete the page you are viewing from the extension's popup
- stop saving a site, which also deletes everything already stored from it
- turn on an exclusion category, which also deletes what is already stored
  from the sites it covers, or remove stored pages matching your own rules
- delete every stored page from the settings page. Your settings, including
  the lists of sites you chose to include or exclude, stay until you change
  them or uninstall the extension
- import pages from an export; pages your exclusions now cover are left out
- limit how long pages are kept and how much storage they may use
- see a log of every removal, whether by you, by an exclusion, or by these
  limits
- pause saving, or restrict saving to sites you choose one by one

Uninstalling the extension deletes all information it has stored. Export
files you saved are ordinary files on your computer and stay where you saved
them until you delete them.

## 9. Retention

Pages are kept until you delete them, until they are older than the
retention period you set, or until the storage limit you set is reached, in
which case the oldest pages that are not pinned are removed first.

## 10. Children

TextMemory is not directed at children under 13 and does not knowingly
collect information from anyone.

## 11. Changes to this policy

If this policy changes, the updated version will be published at the same
address with a new effective date.

## 12. Contact

For questions about this policy, email kernelandshell@gmail.com.
