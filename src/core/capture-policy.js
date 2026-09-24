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
//   webmail.*              any host whose first label is "webmail"
//   example.com/private/*  host plus a path prefix, and the path itself
//   @private-network       an IP address on a local network, or a single
//                          label host like http://wiki/
//
// People type rules the way they see addresses, so a rule is read the way it
// was meant rather than the way it was typed: "https://www.example.com/",
// "WWW.Example.com" and "example.com:8080" all mean example.com. A rule that
// silently matches nothing is worse than no rule, because it looks like one.
export function normaliseRule(raw) {
  let rule = String(raw || '').trim().toLowerCase();
  if (!rule) return '';
  if (rule === '@private-network') return rule;
  rule = rule.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  rule = rule.replace(/[?#].*$/, '');
  const slash = rule.indexOf('/');
  let host = slash === -1 ? rule : rule.slice(0, slash);
  let path = slash === -1 ? '' : rule.slice(slash + 1);
  host = host.replace(/^[^@/]*@/, '').replace(/:\d*$/, '').replace(/\.+$/, '');
  if (host.startsWith('www.')) host = host.slice(4);
  path = path.replace(/^\/+/, '');
  if (path === '*') path = '';
  // "example.com/private/" and "example.com/private" both mean the page and
  // everything under it once the trailing star is added.
  if (path.endsWith('/')) path = path + '*';
  return path ? host + '/' + path : host;
}

export function matchesRule(rawUrl, pattern) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  // A trailing dot is a valid, identically-resolving root-label marker
  // (`mail.google.com.` navigates exactly like `mail.google.com`), and the
  // URL parser keeps it in `hostname`. Stripped here so a rule cannot be
  // defeated by a single dot at the end of a link.
  const host = u.hostname.toLowerCase().replace(/^www\./, '').replace(/\.+$/, '');
  const path = u.pathname.toLowerCase();

  const rule = normaliseRule(pattern);
  if (!rule) return false;
  if (rule === '@private-network') return isPrivateHost(host);

  const [hostPart, ...pathParts] = rule.split('/');
  const pathPattern = pathParts.join('/');
  if (!hostPart) return false;

  let hostOk;
  if (hostPart.startsWith('*.')) {
    const base = hostPart.slice(2);
    hostOk = host.endsWith('.' + base);
  } else if (hostPart.length > 2 && hostPart.endsWith('.*')) {
    hostOk = host.startsWith(hostPart.slice(0, -1));
  } else {
    hostOk = host === hostPart || host.endsWith('.' + hostPart);
  }
  if (!hostOk) return false;
  if (!pathPattern) return true;

  if (pathPattern.endsWith('*')) {
    const prefix = '/' + pathPattern.slice(0, -1);
    if (path.startsWith(prefix)) return true;
    // "x.com/messages/*" has to cover the inbox at /messages itself, not
    // only the conversations under it.
    return prefix.endsWith('/') && path === prefix.slice(0, -1);
  }
  const exact = '/' + pathPattern;
  return path === exact || path === exact + '/';
}

// Addresses that only mean something on the network you are on: a router's
// admin page, a NAS, a printer, a company's internal hosts. RFC 1918 and
// friends for IPv4, loopback, link-local and unique-local for IPv6, and a
// bare name with no dot, which only resolves inside a local network.
export function isPrivateHost(host) {
  if (!host) return false;
  const bare = host.replace(/^\[|\]$/g, '');
  const v4 = bare.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) ||
      a === 0;
  }
  if (bare.includes(':')) {
    // An IPv4 address written as IPv6. The URL parser serialises it in hex
    // (::ffff:c0a8:101 for 192.168.1.1), so it is converted back and checked
    // as the address it is.
    const mapped = bare.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mapped) {
      const hi = parseInt(mapped[1], 16);
      const lo = parseInt(mapped[2], 16);
      return isPrivateHost([hi >> 8, hi & 255, lo >> 8, lo & 255].join('.'));
    }
    return bare === '::' || bare === '::1' || /^f[cd][0-9a-f]{2}:/.test(bare) ||
      /^fe[89ab][0-9a-f]:/.test(bare) || /^::ffff:(10|127|192\.168)\./.test(bare);
  }
  return !bare.includes('.');
}

// An address that is itself a key: a password reset link, a magic sign-in
// link, an OAuth callback, a signed download. Keeping the page would keep
// the key, in plain text, in the archive and in every export of it.
//
// Names that only ever carry a secret count whatever their value, as long as
// there is one. Names that are also ordinary words (`?key=react`,
// `?session=1`) count only when the value looks like a key.
const SECRET_PARAMS = new Set([
  'token', 'access_token', 'id_token', 'refresh_token', 'auth_token', 'authtoken',
  'api_key', 'apikey', 'secret', 'client_secret', 'password', 'passwd', 'pwd',
  'signature', 'sig', 'x-amz-signature', 'x-amz-credential', 'x-goog-signature',
  'x-goog-credential', 'sessionid', 'session_id', 'otp',
  'magic_link', 'login_token', 'reset_token', 'invite_token', 'jwt',
  'saml', 'samlresponse', 'samlrequest', 'oauth_token', 'oauth_verifier',
  'oobcode', 'code_verifier',
]);
const SECRET_IF_KEYLIKE = new Set(['auth', 'key', 'session', 'sid', 'magic', 'reset', 'ticket', 'code']);

// Frameworks name their keys after what they are for, and nearly always end
// the name the same way: reset_password_token, confirmation_token,
// invitation_token (Rails), private_token (GitLab), csrfToken. Any name
// ending in "token" or "secret" is treated as a key once its value is long
// enough to be one. Names ending in "key" also say "key" in ordinary use
// (`?sort_key=date`), so those count only when the value looks like a key.
//
// Except the names APIs give a position in a list of results, which end in
// "token" and carry nothing that signs anybody in: a Google or YouTube
// `pageToken`, an AWS `nextToken`, an OData `$skiptoken`. Counting them made
// every second page of a paginated listing unkeepable, and the update sweep
// deleted the ones kept before.
const PAGINATION_TOKENS = new Set([
  'pagetoken', 'page_token', 'nextpagetoken', 'next_page_token', 'prevpagetoken',
  'prev_page_token', 'nexttoken', 'next_token', 'continuationtoken', 'continuation_token',
  'skiptoken', '$skiptoken', 'synctoken', 'sync_token',
]);
const secretBySuffix = (name, value) =>
  (/(token|secret)$/.test(name) && !PAGINATION_TOKENS.has(name) && value.length >= 8) ||
  (/[_-]?key$/.test(name) && name !== 'key' && looksLikeKey(value));
const SECRET_PATH_WORDS = /^(reset|reset-password|password-reset|forgot-password|magic|magic-link|verify|verify-email|confirm|activate|invite|invitation|unsubscribe|auth|login|signin|sso)$/i;

// A key is long, mixes letters with digits, and is not a slug. A slug is
// mostly words joined by hyphens, underscores or dots:
// `how-to-verify-email-in-2024` and `auth0-universal-login` are articles,
// `550e8400-e29b-41d4-...` and `Zm9vYmFy...` are not.
export function looksLikeKey(value) {
  if (typeof value !== 'string' || value.length < 16) return false;
  if (!/^[A-Za-z0-9_\-.=~+/%]+$/.test(value)) return false;
  if (!/[0-9]/.test(value) || !/[A-Za-z]/.test(value)) return false;
  const parts = value.split(/[-_.]/).filter(Boolean);
  const words = parts.filter((part) => /^[a-z]{2,}$/i.test(part)).length;
  const isSlug = parts.length > 1 && words * 2 >= parts.length;
  return !isSlug;
}

export function hasSecretInUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  const params = [
    ...u.searchParams.entries(),
    ...new URLSearchParams(u.hash.replace(/^#/, '')).entries(),
  ].map(([name, value]) => [name.toLowerCase(), value]);
  const names = params.map(([name]) => name);
  // "code" on its own is ordinary; next to "state" it is an OAuth callback.
  if (names.includes('code') && names.includes('state')) return true;
  // Azure's shared access signatures are only recognisable as a set.
  if (names.includes('sig') && (names.includes('se') || names.includes('sp'))) return true;
  for (const [name, value] of params) {
    if (!value) continue;
    if (SECRET_PARAMS.has(name)) return true;
    if (SECRET_IF_KEYLIKE.has(name) && looksLikeKey(value)) return true;
    if (secretBySuffix(name, value)) return true;
  }
  // A key as a path segment, straight after a word that says what it is for:
  // /reset-password/<key>, /magic-link/<key>, /verify/<key>.
  const segments = u.pathname.split('/');
  for (let i = 0; i < segments.length - 1; i++) {
    if (SECRET_PATH_WORDS.test(segments[i]) && looksLikeKey(segments[i + 1])) return true;
  }
  return false;
}

const anyRuleMatches = (url, rules) => rules.some((r) => matchesRule(url, r));

// Which of the pages already kept a set of rules now excludes, for applying
// an exclusion to the past as well as the future. `secrets` adds addresses
// that carry a key, which earlier builds kept.
export function excludedIds(pages, rules, { secrets = false } = {}) {
  return pages
    .filter((page) => anyRuleMatches(page.url, rules) || (secrets && hasSecretInUrl(page.url)))
    .map((page) => page.id);
}

export function decide({
  url,
  mode = MODE.BROAD,
  allowlist = [],
  rules = [],
  hasPasswordField = false,
  incognito = false,
  paused = false,
  // Pure callers and tests leave this out; every caller in the extension
  // passes the stored value through policyInput() in shared/settings.js, so
  // nothing is read before somebody has finished setup and seen what it does.
  setupComplete = true,
}) {
  if (incognito) return { capture: false, reason: 'incognito' };
  if (!setupComplete) return { capture: false, reason: 'setup is not finished' };
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
  if (hasPasswordField) return { capture: false, reason: 'a password or payment field on the page' };
  if (hasSecretInUrl(url)) return { capture: false, reason: 'the address contains a sign-in or access key' };

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
