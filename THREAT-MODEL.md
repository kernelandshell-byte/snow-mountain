# Threat model

This extension reads the text of pages you read and keeps it. That is a large
amount of trust to ask for, and the honest way to ask for it is to write down
what the design actually protects against, what it does not, and which of the
claims you can check yourself rather than take on faith.

Nothing below is marketing. Where a protection is weaker than it sounds, it
says so.

## What is stored, and where

| What | Where | Leaves the machine |
|---|---|---|
| Page text, title, URL, dates, visit count | IndexedDB, in the extension's own origin | No |
| The search index over that text | The same database | No |
| Your settings, exclusions and allowlist | `chrome.storage.local` | No |
| A log of what eviction removed | The same database | No |

`chrome.storage.local`, not `chrome.storage.sync`. Chrome synchronises the
`sync` area between your signed-in browsers; the `local` area it does not
touch. Nothing here is written to `sync`, so nothing here is carried to
another machine by Chrome.

There is no account, no server, no telemetry, no crash reporting and no
analytics. Not "anonymised" versions of those. None of them.

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
indexed. See `PDF-CAPTURE.md` for the reasoning and the spike that ruled out
every alternative found.

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
additionally ship a content security policy of `connect-src 'none'`, so even
a bug that tried to open a connection from one of them would be refused by
Chrome rather than by our good intentions -- that CSP directive governs the
extension's own pages, not a content script, which is why it does not and
cannot cover `pdf-fetch.js` itself; the fetch it makes is deliberate, not a
hole the policy missed.

**What that claim is not.** It is not a guarantee that exfiltration is
impossible. Capturing a page requires permission to inject a script into it,
and a script with that permission could in principle send what it reads
somewhere. A sandbox could make that impossible; this design cannot, because
the permission is the feature. So the guarantee on offer is weaker and more
ordinary than "impossible": the code is open, it is small, it has no build
step and no bundler, what you install is what is in the repository, and the
one thing you would look for is one grep away.

Anyone who tells you their extension *cannot* exfiltrate your browsing while
also reading your pages is either sandboxed in a way this is not, or is
overclaiming.

## Permissions, and why each one is there

The extension asks for nothing at install. Host access is requested during
setup, in context, at the moment the reason for it is on screen.

| Permission | Why | What it would allow if this code were malicious |
|---|---|---|
| `storage` | Settings, and the sweep's record of itself | Nothing beyond this extension's own data |
| `unlimitedStorage` | Exemption from Chrome clearing the archive under disk pressure. It is the only mechanism an extension has for that | Filling the disk |
| `tabs` | Finding an already open tab when you open a result, and knowing which page the popup is about | Seeing the URL and title of every open tab |
| `alarms` | The hourly sweep that applies your storage budget | Nothing |
| `scripting` | Registering the content script at runtime, so install time asks for no host access at all | Combined with host access, running code in pages |
| `offscreen` | Running pdf.js in a hidden document to extract a PDF's text, off the service worker's own thread | Nothing beyond what `optional_host_permissions` already allows; this only lets the extension parse bytes it already has |
| `optional_host_permissions` | Reading the pages you read. Granted per mode, never at install | Reading every page you visit |

`favicon` was in an earlier draft and has been removed, because nothing ended
up using it. A permission that is not needed is one more thing a reader has to
take on trust.

### The two capture modes

**Broad mode** holds the wide host permission and captures everywhere except
your exclusions. **Strict mode** holds no wide permission at all: you grant
one site at a time, and content scripts are registered for exactly those
origins.

The difference is enforced by Chrome, not by this code. Switching to strict
calls `permissions.remove()`, so the access is really handed back and Chrome's
own permissions screen will tell you so. That matters because the alternative,
keeping the permission and merely promising not to use it, looks identical
from inside the extension and is a lie you cannot check.

### Never captured, in either mode

- Any page carrying a password field, whether or not anything was typed in it
- Anything in incognito
- Anything that is not an ordinary `http` or `https` document, so no `file://`,
  no `chrome://`, no extension pages, no media
- Anything matching your exclusions. Webmail, banking, health, adult,
  government and intranet ranges are all on by default

## Threats this design takes seriously

**Another extension reading the archive.** It cannot. IndexedDB is scoped to
this extension's origin, and one extension has no access to another's storage.

**A website reading the archive.** It cannot, for the same reason. The content
script is a sensor: it measures dwell and scroll, extracts text and sends it
one way to the service worker. It never reads the database and never receives
anything from it beyond a single quote when you open a result.

**Someone with your unlocked machine.** They can read the archive, and the
archive is a detailed record of your reading. This is the threat the design
handles least well, and no local tool can handle it well: full disk encryption
and a locked screen are the answer, not an extension setting. Worth knowing
before you turn capture on for a shared computer.

**Chrome deleting the archive under disk pressure.** `unlimitedStorage` plus a
request for persistent storage. If persistence is refused, settings says so,
and the export exists for exactly this reason.

**A migration losing the archive.** The failure that motivated the whole
storage policy. An upgrade never transforms a store in place, everything
happens inside one versionchange transaction so a throw leaves the database
exactly as it was, and a verification pass has to pass before the old store is
dropped. Driven by fixture migrations that fail on purpose. See
`ARCHITECTURE.md` and `npm run test:migration`.

**Silent deletion.** Nothing is removed without a row in the storage log, and
pinned pages are never evicted by either cap.

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
and a wipe is one button. That is the whole story.

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
fourth is a list of about thirty calls, none of which is a network call. The
fifth is six permissions and one optional host permission.
