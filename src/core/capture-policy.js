// The single place that decides whether a page may be captured.
//
// Both capture modes route through this one function with the mode as a
// parameter. If the two modes ever fork into separate code paths, the bug
// where strict mode captures something it should not becomes inevitable.
//
// `reason` is user facing: it is what the debug view shows, and it is what
// makes the tests read like documentation.

import { domainOf } from './url-key.js';

export const MODE = { BROAD: 'broad', STRICT: 'strict' };

// Patterns are deliberately not regex. Supported forms:
//   example.com            host and its subdomains
//   *.example.com          subdomains only
//   example.com/private/*  host plus a path prefix
export function matchesRule(rawUrl, pattern) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const path = u.pathname;

  const [hostPart, ...pathParts] = pattern.trim().toLowerCase().split('/');
  const pathPattern = pathParts.join('/');

  let hostOk;
  if (hostPart.startsWith('*.')) {
    const base = hostPart.slice(2);
    hostOk = host.endsWith('.' + base);
  } else {
    hostOk = host === hostPart || host.endsWith('.' + hostPart);
  }
  if (!hostOk) return false;
  if (!pathPattern) return true;

  if (pathPattern.endsWith('*')) {
    return path.toLowerCase().startsWith('/' + pathPattern.slice(0, -1));
  }
  return path.toLowerCase() === '/' + pathPattern;
}

const anyRuleMatches = (url, rules) => rules.some((r) => matchesRule(url, r));

export function decide({
  url,
  mode = MODE.BROAD,
  allowlist = [],
  rules = [],
  hasPasswordField = false,
  incognito = false,
  paused = false,
}) {
  if (incognito) return { capture: false, reason: 'incognito' };
  if (paused) return { capture: false, reason: 'paused' };

  let protocol;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return { capture: false, reason: 'unparseable url' };
  }
  if (protocol !== 'http:' && protocol !== 'https:') {
    return { capture: false, reason: 'not a web page' };
  }

  // Always applies, in every mode, before anything else can allow it.
  if (hasPasswordField) return { capture: false, reason: 'password field on page' };

  if (mode === MODE.STRICT) {
    if (!anyRuleMatches(url, allowlist)) {
      return { capture: false, reason: 'not on your allowlist' };
    }
  }

  if (anyRuleMatches(url, rules)) {
    return { capture: false, reason: 'excluded: ' + (domainOf(url) || 'rule match') };
  }

  return { capture: true, reason: 'ok' };
}
