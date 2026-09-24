# Threat model

This extension reads the text of pages you read and keeps it. This document
sets out what the design protects against, what it does not, and which of the
claims you can check yourself. Where a protection is weaker than it sounds, it
says so.

## What is stored, and where

| What | Where | Leaves the machine |
|---|---|---|
| Page text, title, URL, dates, visit count | IndexedDB, in the extension's own origin | No |
| The search index over that text | The same database | No |
| Your settings, exclusions and allowlist | `chrome.storage.local` | No |
| Which shipped rules have been applied to what is kept, and which new categories are waiting on your answer | `chrome.storage.local` | No |
| Why the page in each open tab was or was not kept | `chrome.storage.session`: memory only, never on disk, gone when the tab or browser closes | No |
| A log of what eviction removed | The same database | No |

`chrome.storage.local`, not `chrome.storage.sync`. Chrome synchronises the
`sync` area between your signed-in browsers; the `local` area it does not
touch. Nothing here is written to `sync`, so nothing here is carried to
another machine by Chrome.

There is no account, no server, no telemetry, no crash reporting and no
analytics.

## The central claim, stated exactly

**No line of this code contacts the network, except one, for one reason.**

`content/pdf-fetch.js` calls `fetch(location.href)` -- once, on the tab's own
URL, only after `observer.js` has already decided a PDF in that tab is worth
keeping. It exists because there is no other way to get a PDF's bytes out of
Chrome's native viewer: the viewer renders the file without ever handing this
extension a copy of it, so the only way to see it is to ask for the exact same
URL the tab is already showing. It reaches nowhere the tab had not already
reached, sends no body and no header this extension controls, and returns
bytes that are checked against the PDF magic number before anything is done
with them -- an HTML login or paywall page served at that URL is refused, not
indexed.

Apart from that one file, the claim is checkable in one command, with one
more exclusion that needs explaining rather than hiding:

```
grep -rnE "fetch\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource" src/ \
  | grep -v "content/pdf-fetch.js" | grep -v "src/vendor/pdfjs/"
```

`src/vendor/pdfjs/` is excluded too, and unlike `pdf-fetch.js` this is code
this project never calls, not code it wrote. pdf.js is a general-purpose
library that can fetch a PDF from a URL itself, in chunks, for streaming
large remote files; that code ships inside the vendored file because pdf.js
is not built to order, the same way Readability's full parser ships even
though only part of it runs on any given page. It is never reached here:
`src/offscreen/offscreen.js` is the only call site, and it is checkable in
one line that it never does --

```
grep -n "getDocument" src/offscreen/offscreen.js
```

-- and the one call there passes `data` (bytes already in hand), never
`url`, which is the only way to make pdf.js's own network code run. Once
that one file is excluded on that basis, the grep above returns nothing.
There are no other dependencies at runtime. The extension's own pages
additionally ship a content security policy that starts from `default-src
'self'` and sets `connect-src 'none'`, `frame-src 'none'` and `form-action
'none'`: they cannot fetch anything, load an image, a stylesheet, a font or a
frame from anywhere else, or submit a form, and a bug that tried would be
refused by Chrome. What a content
security policy cannot stop is a page navigating itself or opening a tab to
an address; nothing here does, and that is a code review question, not one
Chrome answers. The policy governs the extension's own pages, not a content
script, which is why it does not and cannot cover `pdf-fetch.js` itself; the
fetch it makes is deliberate, not a hole the policy missed.

**What that claim is not.** It is not a guarantee that exfiltration is
impossible. Capturing a page requires permission to inject a script into it,
and a script with that permission could in principle send what it reads
somewhere. A sandbox could make that impossible; this design cannot, because
the permission is the feature. So the guarantee on offer is weaker and more
ordinary than "impossible": the code is open, it is small, it has no build
step and no bundler, what you install is what is in the repository, and the
one thing you would look for is one grep away.

## Permissions, and why each one is there

The extension asks for no site access at install. The one warning Chrome
shows at install comes from `tabs` ("Read your browsing history"). Host access
is requested during setup, at the moment the reason for it is on screen.

| Permission | Why | What it would allow if this code were malicious |
|---|---|---|
| `storage` | Settings, the sweep's record of itself, and (in memory only, cleared when the browser closes) why the page in each open tab was or was not kept | Nothing beyond this extension's own data |
| `unlimitedStorage` | Exemption from Chrome clearing the archive under disk pressure. It is the only mechanism an extension has for that | Filling the disk |
| `tabs` | Finding an already open tab when you open a result, and knowing which page the popup is about | Seeing the URL and title of every open tab |
| `alarms` | The hourly sweep that applies your storage budget | Nothing |
| `scripting` | Registering the content script at runtime, so install time asks for no host access at all | Combined with host access, running code in pages |
| `offscreen` | Running pdf.js in a hidden document to extract a PDF's text, off the service worker's own thread | Nothing beyond what `optional_host_permissions` already allows; this only lets the extension parse bytes it already has |
| `optional_host_permissions` | Reading the pages you read. Granted per mode, never at install | Reading every page you visit |

### The two capture modes

**Broad mode** holds the wide host permission and captures everywhere except
your exclusions. **Strict mode** holds no wide permission at all: you grant
one site at a time, and content scripts are registered for exactly those
origins.

The difference is enforced by Chrome, not by this code. Switching to strict
calls `permissions.remove()`, so the access is really handed back and Chrome's
own permissions screen will tell you so. "Never keep this site" in strict
mode hands back that site's access the same way. That matters because the alternative,
keeping the permission and merely promising not to use it, looks identical
from inside the extension and is a lie you cannot check.

### Skipped, in either mode

- Everything, until setup is finished. Until then the content script is not
  registered in any page, and the policy refuses anyway, so granting access
  half way through setup and closing it is not agreeing to anything
- Any page asking for a password, a card number, a one-time code or an
  account number, checked when the page is judged worth keeping and again
  when its text is taken, including inside open shadow roots and same-origin
  frames. A field counts even when it is hidden, which is the cautious way
  round and has a cost: a site that keeps a hidden sign-in form on every page
  is never kept, and the extension's button says that is why. A visible
  embedded payment form from a known provider counts too; the hidden helper
  frames Stripe adds to every page that loads it, and PayPal's buttons and
  pay-later messages, do not
- Any address carrying a sign-in or access key: reset and magic links,
  OAuth callbacks, signed download URLs. Recognised by parameter name
  (including any name ending in `token` or `secret`, which is how Rails,
  GitLab and most frameworks name them), or by a random-looking path segment
  after a word like `reset` or `verify`, so a key under an unusual name
  (`?t=`, `/r/<id>`) is missed. A page is filed under its canonical address
  only when that is the same page spelled more tidily (same host and path,
  fewer parameters), and never when one of these checks or your exclusions
  would refuse it
- Anything in incognito
- Anything that is not an ordinary `http` or `https` document, so no `file://`,
  no `chrome://`, no extension pages, no media
- Anything matching your exclusions. Webmail, messaging, AI chats, password
  managers and account pages, banking, health, adult, dating, government,
  local network and routers, work tools and search results are all on by
  default.
  A rule is read the way it was meant rather than as typed, so
  `https://www.example.com/` means example.com, and settings shows how each
  rule was read and names any line that cannot match anything

Turning on a category removes what it covers from the archive as well, and
each update applies the key check, and any site newly added to a category
that is on, to what is already kept, so a site added to a list is not left
behind from before. A category that is itself new in an update is on from
then on for what is read next, but what it would remove from before is not
taken: settings says how many saved pages it covers and asks whether to
remove or keep them, and either answer holds through later updates.
Custom rules only remove saved pages when asked, because they are saved
while still being typed. An import leaves out pages your exclusions cover
now, so an old export cannot bring back what was since excluded.

The exclusion lists are lists of well-known sites. They cannot name every
bank, clinic or intranet, and a page after login often has nothing on it
that marks it as private. That is the weakest part of broad mode, and why
strict mode exists: there nothing is read unless it was added on purpose.

## Threats this design takes seriously

**Another extension reading the archive.** It cannot. IndexedDB is scoped to
this extension's origin, and one extension has no access to another's storage.

**A website reading the archive.** It cannot, for the same reason. The content
script is a sensor: it measures dwell and scroll, extracts text and sends it
one way to the service worker. It never reads the database and never receives
anything from it beyond a single quote when you open a result.

That is also enforced, not just how the script happens to be written. A
content script runs inside the page it reads, so a page that compromised its
own renderer could send anything that script can. The service worker answers
a message from a web page only if it is one of the three a sensor needs
(a page worth reading, its text, a PDF's bytes). Search, export, import,
settings and delete everything are answered only for the extension's own
pages, and not for the hidden page that runs pdf.js over PDFs from the web:
it only ever answers the worker, so a hostile PDF that got code running
there still could not ask for any of them. And every one of the three has
to name the address of the page that sent it, and the text is checked
against your exclusions again when it arrives, so a page can't file
made-up text under another site's name or get around an exclusion.
`npm run test:capture` tries all of this from a real content script and
checks it's refused.

**Someone with your unlocked machine.** They can read the archive, and the
archive is a detailed record of your reading. This is the threat the design
handles least well, and no local tool can handle it well: full disk encryption
and a locked screen are the answer, not an extension setting. Worth knowing
before you turn capture on for a shared computer.

**Chrome deleting the archive under disk pressure.** `unlimitedStorage` plus a
request for persistent storage. If persistence is refused, settings says so,
and the export exists for exactly this reason.

**A migration losing the archive.** An upgrade never transforms a store in place, everything
happens inside one versionchange transaction so a throw leaves the database
exactly as it was, and a verification pass has to pass before the old store is
dropped. Driven by fixture migrations that fail on purpose. See
`ARCHITECTURE.md` and `npm run test:migration`.

**Silent deletion.** Nothing is removed without a row in the storage log --
the sweep, an exclusion, forgetting a page, a site or a day, and deleting
everything all write one -- and pinned pages are never evicted by either cap.
The log records how many pages and how much space, never which pages, since a
list of what was deleted would keep exactly what deleting it was for.

## Threats it does not handle

**A malicious update, to this extension or to a dependency.** If this project
ever changed hands, or a future version added a network call somewhere other
than the one named above, nothing in the current design would stop it. The
mitigations available are the ordinary ones: the source is public, there is
no build step, the vendored Readability and pdf.js are both pinned and
inspectable, and the repository history is the record. Pinning the version
you trust, or building from source yourself, is the only real defence, and
it is the same defence every extension offers whether it says so or not.

**A compromised operating system.** Anything with your file system has the
archive. There is no encryption at rest beyond whatever your disk provides.

**Traffic analysis or anything on the network.** Out of scope for the same
reason the central claim holds: the one fetch this design makes is a
same-tab, same-URL re-read of a resource the tab already loaded, not a
request to a remote server of ours, and there is no remote server on the
other end of anything here to analyse traffic to.

**Legal or physical compulsion.** The archive is on your disk, in plain form,
and a wipe is one button.

## Verifying any of this yourself

```
grep -rnE "fetch\(|XMLHttpRequest|WebSocket|sendBeacon" src/   # network calls
grep -n "getDocument" src/offscreen/offscreen.js               # ...and that pdf.js is never told to fetch one
grep -rn "storage.sync" src/                                   # anything synced
grep -rhoE "chrome\.[a-zA-Z]+\.[a-zA-Z]+" src/ | sort -u       # every Chrome API used
cat manifest.json                                              # every permission asked for
```

The first turns up three files: `content/pdf-fetch.js`, discussed above, and
the two vendored `pdf.js` files, which contain library code for fetching a
PDF from a URL that this project never calls -- the second command confirms
the one call site passes bytes, never a URL. The third returns nothing. The
fourth is a list of about forty calls, none of which is a network call. The
fifth is six permissions and one optional host permission.
