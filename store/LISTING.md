# Chrome Web Store listing

Everything the store's dashboard asks for, ready to paste. The images are in
this folder and are rebuilt from the real extension with `npm run store`.

Upload `dist/textmemory-1.0.0.zip` (built by `npm run package`).

## Store listing tab

**Name** (from the manifest): `TextMemory`

**Summary** (132 characters at most, also taken from the manifest's
`description`):

> Search the full text of pages you've read. Stored on your computer, never sent anywhere.

**Category:** Productivity  
**Language:** English

**Description:**

```
Find anything you've read.

TextMemory keeps the full text of the pages you actually read, on your own computer, so you can find them again by any phrase you remember. Half remembered a sentence from an article last month? Type it, and land on the paragraph.

It stays on your computer. There is no account, no server, no sync and no analytics. Nothing you read is uploaded anywhere.

WHAT IT DOES
• Full-text search of everything you've read, not just titles and addresses
• Jump to passage: open a result and the page scrolls straight to the sentence that matched
• Forgiving search: typos, plurals and endings are handled, in English, Spanish, Portuguese, German, French and Italian. Search says what it actually searched for
• Search syntax when you want it: "exact phrases", -excluded words, site:example.com, before: and after:
• PDFs too: the text of PDFs you read in Chrome is searchable
• Keyboard first: Ctrl+Shift+F (Command+Shift+F on a Mac), or type tm and a space in the address bar
• Light and dark themes, fully usable from the keyboard, and built for high contrast and zoom

ONLY WHAT YOU ACTUALLY READ
A page is kept only once it has been in front of you for a few seconds and you've scrolled it. Pages you merely opened in a background tab are not kept.

YOU DECIDE WHAT'S READ
• Pages asking for a password, card number or one-time code are never kept
• Incognito windows are never kept
• Webmail, messaging, AI chats, banking, health, adult sites, dating, government portals, work tools, local network addresses and search results pages are skipped by default. Switch categories on or off, add your own sites, or keep only sites you add one by one
• Setup asks for access to sites at the moment it explains why. In "only sites I add" mode it asks for nothing up front
• One click in the toolbar shows whether the page in front of you is kept, and why not. Forget a page, or never keep a site, in one more click

IN YOUR CONTROL
• Pin pages so they are never removed
• Set how long pages are kept and how much space they may use. The oldest are replaced first, and every removal is listed in settings
• Export everything to a plain JSON file, import it back, or delete everything in two clicks

Open source (MIT). The privacy policy and a threat model that says plainly what the extension can and cannot do are in the repository.
```

## Privacy tab

**Single purpose:**

> Let people search the full text of the web pages they have read, using an index stored only on their own computer.

**Permission justifications**

| Permission | Justification |
|---|---|
| `storage` | Saves the user's settings (which sites to include or exclude, how long and how much to keep) and, in memory only, whether the page in each open tab was kept so the toolbar button can say so. |
| `unlimitedStorage` | The searchable archive of pages lives in the extension's IndexedDB. This exempts it from Chrome clearing it under disk pressure. The user sets their own size limit, enforced by the extension. |
| `tabs` | Finds an already open tab when the user opens a search result, and tells the toolbar popup which page it is about (its address and title). |
| `alarms` | Runs the hourly job that applies the user's storage and age limits. |
| `scripting` | Registers the content script at runtime, so installing asks for no site access, and injects the text extractor and the highlighter only into pages that have been read. |
| `offscreen` | Runs the bundled pdf.js in a hidden document to extract the text of PDFs the user reads. It is only ever handed bytes the extension already has. |
| Host permissions (`*://*/*`, optional) | Required to read the text of pages the user reads. It is optional: requested during setup at the moment the reason is shown, never at install, and not requested at all in "only sites I add" mode, where the user grants one site at a time. |
| `omnibox` (keyword `tm`) | Lets the user search from the address bar. |

**Remote code:** No. Everything (including pdf.js and Readability) is bundled
in the package. The extension's content security policy is `script-src 'self'`
and `connect-src 'none'`.

**Data usage** (what the extension handles; all of it stays on the user's
device):

- Web history: yes (the addresses and titles of pages the user has read)
- Website content: yes (the text of pages the user has read)
- Everything else (personally identifiable information, health, financial,
  authentication, location, user activity, communications): no

Certify all three statements: the data is not sold to third parties, not used
or transferred for purposes unrelated to the single purpose, and not used or
transferred to determine creditworthiness or for lending.

**Privacy policy URL:**
https://github.com/kernelandshell-byte/snow-mountain/blob/main/PRIVACY.md

## Graphic assets

| Slot | File | Size |
|---|---|---|
| Store icon | `icon/store-icon-128.png` | 128 × 128 |
| Screenshot 1 | `screenshots/1-find-anything.png` | 1280 × 800 |
| Screenshot 2 | `screenshots/2-jump-to-passage.png` | 1280 × 800 |
| Screenshot 3 | `screenshots/3-forgiving.png` | 1280 × 800 |
| Screenshot 4 | `screenshots/4-always-know.png` | 1280 × 800 |
| Screenshot 5 | `screenshots/5-you-decide.png` | 1280 × 800 |
| Small promo tile | `promo/small-tile-440x280.png` | 440 × 280 |
| Marquee promo tile | `promo/marquee-1400x560.png` | 1400 × 560 |

Screenshots and tiles are 24-bit PNG with no alpha, as the store requires.
Every page in them is fictional (addresses end in `.example`).

The logo itself is in `logo/` (SVG, 512 and 1024 PNG, and `logo-board.png`
showing it at every size and on light, dark and brand backgrounds).

## Notes for reviewers (the "test instructions" box)

> No account or sign-in is needed. After installing, a setup page opens.
> Choose "Everywhere, minus your exclusions" and accept Chrome's site-access
> prompt (or choose "Only sites I add myself", which asks for nothing). Open
> any long article, keep it in front of you and scroll for about ten seconds.
> Then press Ctrl+Shift+F (Command+Shift+F on a Mac) and search for a phrase
> from it. Clicking the toolbar button shows whether the current page was kept
> and why not. Nothing is sent over the network: the extension has no servers.
