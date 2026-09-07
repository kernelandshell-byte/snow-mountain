// Normalised URL used as the dedupe key for pages.
//
// Deliberately conservative: merging two genuinely different pages loses
// data, while failing to merge two spellings of the same page only costs
// a duplicate row. So only unambiguous tracking parameters are stripped.
// A bare `ref` is kept, because some sites route real content through it.

const TRACKING_PARAMS = new Set([
  'fbclid', 'gclid', 'msclkid', 'yclid', 'twclid', 'igshid', 'dclid',
  'mc_cid', 'mc_eid', '_hsenc', '_hsmi', 'vero_id', 'ref_src', 'ref_url',
  'spm', 'scm', 'mkt_tok', 'trk', 'oly_enc_id', 'oly_anon_id',
]);

const isTracking = (name) => {
  const n = name.toLowerCase();
  return n.startsWith('utm_') || TRACKING_PARAMS.has(n);
};

export function urlKey(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const port = u.port && u.port !== '80' && u.port !== '443' ? ':' + u.port : '';

  const params = [];
  for (const [k, v] of u.searchParams) {
    if (!isTracking(k)) params.push([k, v]);
  }
  params.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  const query = params.length
    ? '?' + params.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&')
    : '';

  let path = u.pathname;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);

  return u.protocol + '//' + host + port + path + query;
}

// Registrable-ish domain, good enough for site filters and rules.
export function domainOf(rawUrl) {
  try {
    return new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}
