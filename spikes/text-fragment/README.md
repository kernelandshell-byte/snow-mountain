# Spike: scroll to text fragments

Answers one question the jump to passage feature depends on: does `chrome.tabs.create` with a `#:~:text=` directive actually scroll to the passage, and how does it fail?

Run it:

```
npm install playwright
xvfb-run -a node run.js     # or plain `node run.js` with a display
```

It loads the throwaway extension in `ext/`, serves `site/` locally, and drives five cases through a real Manifest V3 service worker.

## Results, 7 September 2026, Chromium via Playwright 1.56

Test page is 4727px tall, target sentence sits at document offset 3829, viewport 800px.

| Case | scrollY | Reading |
|---|---|---|
| `tabs.create`, no directive | 0 | control |
| `tabs.create`, phrase present | 3433 | works, match centred in the viewport |
| `tabs.create`, phrase absent | 0 | opens at top, no error |
| `tabs.update` on an open tab, same URL plus directive | 0 | does not fire |
| `tabs.create`, target inserted 800ms after load | 0 | does not wait for late content |

In every case Chrome stripped the directive from the URL before scripts could read it.

Rerun this if Chrome's behaviour ever looks like it changed. It takes about fifteen seconds.
