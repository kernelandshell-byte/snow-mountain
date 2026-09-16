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

**No line of this code contacts the network.**

That is a claim about the code, and it is checkable in one command:

```
grep -rnE "fetch\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource" src/
```

It returns nothing, including in the vendored copy of Mozilla's Readability,
which is the only third party code in the project. There are no other
dependencies at runtime. The extension's own pages additionally ship a content
security policy of `connect-src 'none'`, so even a bug that tried to open a
connection from one of them would be refused by Chrome rather than by our good
intentions.

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
ever changed hands, or a future version added a network call, nothing in the
current design would stop it. The mitigations available are the ordinary ones:
the source is public, there is no build step, the vendored Readability is
pinned and inspectable, and the repository history is the record. Pinning the
version you trust, or building from source yourself, is the only real defence,
and it is the same defence every extension offers whether it says so or not.

**A compromised operating system.** Anything with your file system has the
archive. There is no encryption at rest beyond whatever your disk provides.

**Traffic analysis or anything on the network.** Out of scope, because nothing
here uses the network.

**Legal or physical compulsion.** The archive is on your disk, in plain form,
and a wipe is one button. That is the whole story.

## Verifying any of this yourself

```
grep -rnE "fetch\(|XMLHttpRequest|WebSocket|sendBeacon" src/   # network calls
grep -rn "storage.sync" src/                                   # anything synced
grep -rhoE "chrome\.[a-zA-Z]+\.[a-zA-Z]+" src/ | sort -u       # every Chrome API used
cat manifest.json                                              # every permission asked for
```

The first two return nothing. The third is a list of about thirty calls, none
of which is a network call. The fourth is five permissions and one optional
host permission.
