import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, matchesRule, MODE } from '../src/core/capture-policy.js';

const base = { url: 'https://example.com/article', mode: MODE.BROAD };

test('captures an ordinary page', () => {
  assert.equal(decide(base).capture, true);
});

test('a password field blocks capture even on an allowlisted site', () => {
  const r = decide({
    ...base,
    mode: MODE.STRICT,
    allowlist: ['example.com'],
    hasPasswordField: true,
  });
  assert.equal(r.capture, false);
  assert.match(r.reason, /password/);
});

test('incognito and pause both block', () => {
  assert.equal(decide({ ...base, incognito: true }).capture, false);
  assert.equal(decide({ ...base, paused: true }).capture, false);
});

test('non web pages are refused', () => {
  assert.equal(decide({ ...base, url: 'chrome://extensions' }).capture, false);
  assert.equal(decide({ ...base, url: 'file:///tmp/a.html' }).capture, false);
});

test('strict mode captures only what is on the allowlist', () => {
  const strict = { ...base, mode: MODE.STRICT, allowlist: ['docs.example.org'] };
  assert.equal(decide(strict).capture, false);
  assert.equal(decide({ ...strict, url: 'https://docs.example.org/guide' }).capture, true);
});

test('exclusion rules block in broad mode', () => {
  const r = decide({ ...base, url: 'https://mail.google.com/u/0', rules: ['mail.google.com'] });
  assert.equal(r.capture, false);
  assert.match(r.reason, /excluded/);
});

test('rules cover subdomains, and *. excludes the apex', () => {
  assert.equal(matchesRule('https://a.example.com/x', 'example.com'), true);
  assert.equal(matchesRule('https://example.com/x', 'example.com'), true);
  assert.equal(matchesRule('https://a.example.com/x', '*.example.com'), true);
  assert.equal(matchesRule('https://example.com/x', '*.example.com'), false);
});

test('path prefix rules only match that prefix', () => {
  assert.equal(matchesRule('https://e.com/private/doc', 'e.com/private/*'), true);
  assert.equal(matchesRule('https://e.com/public/doc', 'e.com/private/*'), false);
});

test('a rule for another host does not leak', () => {
  assert.equal(matchesRule('https://notexample.com/x', 'example.com'), false);
});

test('a trailing dot on the hostname does not defeat a rule', () => {
  // mail.google.com. navigates identically to mail.google.com; the URL
  // parser keeps the dot in `hostname`, and a naive comparison would let it
  // slip an excluded site straight past its own exclusion rule.
  assert.equal(matchesRule('https://mail.google.com./inbox', 'mail.google.com'), true);
  const r = decide({ ...base, url: 'https://mail.google.com./inbox', rules: ['mail.google.com'] });
  assert.equal(r.capture, false);
});

test('a leading-label wildcard matches any host starting with that label', () => {
  assert.equal(matchesRule('https://webmail.gmx.net/inbox', 'webmail.*'), true);
  assert.equal(matchesRule('https://banking.mybank.example/x', 'banking.*'), true);
  assert.equal(matchesRule('https://notwebmail.example.com/x', 'webmail.*'), false);
});

test('a search results page is excluded by the shipped preset', () => {
  const rules = ['google.com/search', 'duckduckgo.com'];
  assert.equal(decide({ ...base, url: 'https://www.google.com/search?q=retro+fatigue', rules }).capture, false);
  assert.equal(decide({ ...base, url: 'https://duckduckgo.com/?q=retro', rules }).capture, false);
  // The rest of the site is not the results page and stays capturable.
  assert.equal(decide({ ...base, url: 'https://about.google.com/products', rules }).capture, true);
});

test('an address carrying a sign-in or access key is never kept', async () => {
  const { hasSecretInUrl } = await import('../src/core/capture-policy.js');
  for (const url of [
    'https://example.com/reset?token=abc123',
    'https://app.example.com/auth/callback?code=xyz&state=123',
    'https://example.com/#access_token=abc&token_type=bearer',
    'https://bucket.s3.amazonaws.com/file.html?X-Amz-Signature=abc&X-Amz-Credential=x',
    'https://example.com/reset-password/Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA',
    'https://example.com/magic-link/abcdefghijklmnopqrstuvwxyz0123',
    'https://store.blob.core.windows.net/c/page.html?sv=2020&se=2026&sp=r&sig=abc',
  ]) {
    assert.equal(hasSecretInUrl(url), true, url);
    assert.equal(decide({ url }).capture, false, url);
  }
  for (const url of [
    'https://example.com/article?id=5', 'https://github.com/org/repo/search?q=code',
    'https://example.com/docs/auth', 'https://example.com/blog/how-to-reset-your-router',
    'https://example.com/login', 'https://www.youtube.com/watch?v=abc',
  ]) {
    assert.equal(hasSecretInUrl(url), false, url);
  }
});

test('an article under an auth-sounding path is not mistaken for a key', async () => {
  const { hasSecretInUrl } = await import('../src/core/capture-policy.js');
  for (const url of [
    'https://supabase.com/docs/guides/auth/passwords-and-magic-links',
    'https://auth0.com/docs/authenticate/login/auth0-universal-login',
    'https://example.com/verify/how-to-verify-email-addresses-in-2024',
    'https://example.com/blog/invite/inviting-your-team-to-a-workspace',
    'https://stackoverflow.com/questions/123/foo?session=1',
    'https://example.com/search?key=react-hooks-tutorial',
    'https://example.com/settings?reset=true',
    'https://example.com/reset?token=',
  ]) {
    assert.equal(hasSecretInUrl(url), false, url);
  }
  for (const url of [
    'https://example.com/verify/550e8400-e29b-41d4-a716-446655440000',
    'https://example.com/invite/a8Xk29dLq0pZ7mN3vB5c',
    'https://example.com/login?session=a8Xk29dLq0pZ7mN3vB5cQ',
    'https://example.com/auth/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123def456',
    'https://example.com/signin?otp=123456',
  ]) {
    assert.equal(hasSecretInUrl(url), true, url);
  }
});

test('local network addresses are recognised', async () => {
  const { isPrivateHost } = await import('../src/core/capture-policy.js');
  for (const host of ['10.0.0.1', '192.168.1.1', '172.16.0.1', '172.31.255.1', '127.0.0.1', '169.254.1.1', '[::1]', '[fd00::1]', '[fe80::1]', 'wiki', 'router']) {
    assert.equal(isPrivateHost(host), true, host);
  }
  for (const host of ['8.8.8.8', '172.32.0.1', '192.169.1.1', 'example.com', '[2001:db8::1]']) {
    assert.equal(isPrivateHost(host), false, host);
  }
});

// --- rules as people type them ---------------------------------------------

import { normaliseRule, hasSecretInUrl as secretIn, isPrivateHost as privateHost } from '../src/core/capture-policy.js';
import { PRESETS, rulesFor as presetRules } from '../src/shared/presets.js';

test('a rule typed with www., a scheme, a port or a trailing slash still means the site', () => {
  for (const typed of ['www.facebook.com', 'https://www.facebook.com/', 'HTTP://Facebook.com', 'facebook.com:443', 'facebook.com/']) {
    assert.equal(matchesRule('https://www.facebook.com/somepage', typed), true, typed);
    assert.equal(normaliseRule(typed), 'facebook.com', typed);
  }
});

test('a pasted address with a path becomes a path rule, and drops its query', () => {
  assert.equal(normaliseRule('https://www.example.com/private/?x=1#top'), 'example.com/private/*');
  assert.equal(matchesRule('https://example.com/private/notes', 'https://www.example.com/private/'), true);
  assert.equal(matchesRule('https://example.com/public', 'https://www.example.com/private/'), false);
});

test('a path rule covers the path itself, not only what is under it', () => {
  assert.equal(matchesRule('https://x.com/messages', 'x.com/messages/*'), true);
  assert.equal(matchesRule('https://x.com/messages/123-456', 'x.com/messages/*'), true);
  assert.equal(matchesRule('https://x.com/messagesfoo', 'x.com/messages/*'), false);
  assert.equal(matchesRule('https://example.com/about/', 'example.com/about'), true);
});

test('every shipped rule is already in the form it is matched in', () => {
  for (const [name, list] of Object.entries(PRESETS)) {
    for (const rule of list) assert.equal(normaliseRule(rule), rule, name + ': ' + rule);
  }
});

test('nothing is kept before setup is finished', () => {
  const r = decide({ ...base, setupComplete: false });
  assert.equal(r.capture, false);
  assert.match(r.reason, /setup/);
});

test('framework reset, confirmation and invite links are keys', () => {
  for (const url of [
    'https://app.example.com/users/password/edit?reset_password_token=Ab3dEfGhIjKlMnOp',
    'https://app.example.com/users/confirmation?confirmation_token=Ab3dEf9h',
    'https://app.example.com/users/invitation/accept?invitation_token=Ab3dEf9hIjKl',
    'https://gitlab.example.com/x?private_token=glpat-Ab3dEf9hIjKlMn0p',
    'https://x.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=Ab3dEf9hIjKlMn0pQrSt',
    'https://example.com/share?access_key=Ab3dEf9hIjKlMn0p',
  ]) assert.equal(secretIn(url), true, url);
});

test('ordinary parameters that end the same way are not keys', () => {
  for (const url of [
    'https://example.com/list?sort_key=date',
    'https://example.com/?key=react',
    'https://example.com/?page_token=abc',
    'https://example.com/promo?code=SUMMER24',
  ]) assert.equal(secretIn(url), false, url);
});

test('a pagination token is a place in a list, not a key', () => {
  for (const url of [
    'https://www.youtube.com/results?search_query=bread&pageToken=CBQQAA3dEf9hIjKl',
    'https://console.example.com/logs?nextToken=eyJ2IjoxLCJvZmZzZXQiOjUwfQ',
    'https://example.com/odata/Items?$skiptoken=Ab3dEf9hIjKlMn0p',
  ]) assert.equal(secretIn(url), false, url);
});

test('an IPv4 address written as IPv6 is judged as the address it is', () => {
  assert.equal(privateHost(new URL('http://[::ffff:192.168.1.1]/').hostname), true);
  assert.equal(privateHost(new URL('http://[::ffff:10.0.0.1]/').hostname), true);
  assert.equal(privateHost(new URL('http://[::ffff:8.8.8.8]/').hostname), false);
});

test('AI chats, password managers and routers are covered by the shipped lists', () => {
  const rules = presetRules(Object.fromEntries(Object.keys(PRESETS).map((key) => [key, true])), []);
  for (const url of [
    'https://chatgpt.com/c/abc', 'https://claude.ai/chat/abc', 'https://gemini.google.com/app/abc',
    'https://vault.bitwarden.com/#/vault', 'https://my.1password.com/vaults', 'https://myaccount.google.com/',
    'http://fritz.box/', 'http://printer.home/', 'https://x.com/i/chat/123',
  ]) assert.equal(decide({ ...base, url, rules }).capture, false, url);
});
