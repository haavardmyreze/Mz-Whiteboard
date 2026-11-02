'use strict';

// What a web link on a board shows of its page: the page's title, a line about it, the site it is on and
// its picture. The server reads them, not the browser, which may not read another site's pages. Most
// sites say all four in the head of the page for exactly this (Open Graph tags, og:title and so on, or
// Twitter's), and the page's own <title> and description stand in where they do not. The picture is
// fetched too and kept on this machine like any upload, so the board shows it from here, to whoever
// opens it, and it stays when the page changes or goes.

const dns = require('dns').promises;
const net = require('net');

const TIMEOUT = 8000;
const MAX_PAGE = 1024 * 1024; // the head is all that is read; a page this far in without one has none
const MAX_PICTURE = 8 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const PICTURE_TYPES = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/avif': '.avif' };
// Some sites answer a plain script with a page asking it to sign in, and a browser with the real page.
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; Boards by Myreze; link preview)',
  'Accept-Language': 'en;q=0.9, *;q=0.5',
};

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', middot: '·', bull: '•', copy: '©', reg: '®', trade: '™' };
function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code) => {
    if (code[0] !== '#') return NAMED[code.toLowerCase()] ?? all;
    const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
  });
}

const tidy = (s, max) => {
  const t = decode(String(s || '')).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

// The attributes of one tag, by lower-case name.
function attributes(tag) {
  const out = {};
  for (const m of tag.matchAll(/([^\s=/>"']+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return out;
}

// What the head of a page says about it. `pageUrl` is where it was read from, for a picture given by a
// path on the same site.
function readPage(html, pageUrl) {
  const head = html.slice(0, (html.search(/<body[\s>]/i) + 1 || html.length + 1) - 1);
  const meta = new Map();
  const links = [];
  for (const m of head.matchAll(/<(meta|link)\s[^>]*>/gi)) {
    const a = attributes(m[0].slice(m[1].length + 1));
    if (m[1].toLowerCase() === 'link') links.push(a);
    const key = (a.property || a.name || a.itemprop || '').toLowerCase();
    if (key && a.content != null && !meta.has(key)) meta.set(key, a.content);
  }
  const first = (...keys) => keys.map((k) => meta.get(k)).find((v) => v && v.trim()) || '';
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head);
  const base = /<base\s[^>]*>/i.exec(head);
  const at = (v) => {
    try {
      const u = new URL(decode(v.trim()), new URL(base ? attributes(base[0].slice(5)).href || '' : '', pageUrl));
      return /^https?:$/.test(u.protocol) ? u.href : null;
    } catch {
      return null;
    }
  };
  const picture = first('og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src', 'image')
    || (links.find((l) => /(^|\s)image_src(\s|$)/i.test(l.rel || '')) || {}).href || '';
  return {
    title: tidy(first('og:title', 'twitter:title') || (titleTag ? titleTag[1] : ''), 300),
    desc: tidy(first('og:description', 'twitter:description', 'description'), 500),
    site: tidy(first('og:site_name', 'application-name'), 100),
    picture: picture ? at(picture) : null,
  };
}

// A cloud machine answers on a link-local address (169.254.169.254) with what it knows about itself:
// never somewhere a link on a board is read from.
async function allowed(u) {
  if (!/^https?:$/.test(u.protocol)) return false;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  return addresses.length > 0 && !addresses.some((a) => /^169\.254\./.test(a) || /^fe[89ab][0-9a-f]:/i.test(a) || /^::ffff:169\.254\./i.test(a));
}

// Fetches `url`, following redirects one at a time so each place it goes is checked.
async function get(url, accept, fetchImpl, signal) {
  let at = new URL(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!(await allowed(at))) throw Object.assign(new Error('That address cannot be read from here'), { status: 400 });
    const res = await fetchImpl(at.href, { headers: { ...HEADERS, Accept: accept }, redirect: 'manual', signal });
    const to = res.status >= 300 && res.status < 400 && res.headers.get('location');
    if (!to) return { res, url: at.href };
    res.body?.cancel().catch(() => {});
    at = new URL(to, at);
  }
  throw Object.assign(new Error('The page sends the reader on too many times'), { status: 502 });
}

// At most `max` bytes of a response; `enough(bytes)` may stop it sooner.
async function readSome(res, max, enough = () => false) {
  const chunks = [];
  let size = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
      if (size >= max || enough(Buffer.concat(chunks))) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).subarray(0, max);
}

function charsetOf(type, bytes) {
  const said = /charset=["']?([\w-]+)/i.exec(type || '') || /<meta[^>]+charset=["']?([\w-]+)/i.exec(bytes.subarray(0, 4096).toString('latin1'));
  try {
    return new TextDecoder(said ? said[1] : 'utf-8');
  } catch {
    return new TextDecoder('utf-8');
  }
}

// What a web link shows: { url, title, desc, site, picture: { bytes, ext } | null }. `url` is where the
// page ended up after its redirects. A page that is itself a picture is its own picture.
async function unfurl(url, { fetchImpl = fetch, timeout = TIMEOUT } = {}) {
  const signal = AbortSignal.timeout(timeout);
  const page = await get(url, 'text/html,application/xhtml+xml;q=0.9,image/*;q=0.8,*/*;q=0.5', fetchImpl, signal);
  if (!page.res.ok) throw Object.assign(new Error(`The page answered ${page.res.status}`), { status: 502 });
  const type = (page.res.headers.get('content-type') || '').toLowerCase();
  const last = new URL(page.url).pathname.split('/').pop() || '';
  let name = last;
  try {
    name = decodeURIComponent(last);
  } catch {
    // written as it came
  }
  name = name || new URL(page.url).hostname;
  if (PICTURE_TYPES[type.split(';')[0].trim()]) {
    return { url: page.url, title: tidy(name, 300), desc: '', site: '', picture: await pictureFrom(page.res) };
  }
  let info = { title: '', desc: '', site: '', picture: null };
  if (/html|xml/.test(type) || !type) {
    const bytes = await readSome(page.res, MAX_PAGE, (b) => b.includes('</head>') || b.includes('</HEAD>'));
    info = readPage(charsetOf(type, bytes).decode(bytes), page.url);
  } else {
    page.res.body?.cancel().catch(() => {});
  }
  let picture = null;
  if (info.picture) {
    try {
      const got = await get(info.picture, 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9', fetchImpl, signal);
      if (got.res.ok) picture = await pictureFrom(got.res);
      else got.res.body?.cancel().catch(() => {});
    } catch {
      // a page without its picture is still worth showing
    }
  }
  return { url: page.url, title: info.title, desc: info.desc, site: info.site, picture };
}

async function pictureFrom(res) {
  const ext = PICTURE_TYPES[(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()];
  const length = Number(res.headers.get('content-length'));
  if (!ext || length > MAX_PICTURE) {
    res.body?.cancel().catch(() => {});
    return null;
  }
  const bytes = await readSome(res, MAX_PICTURE + 1);
  return bytes.length && bytes.length <= MAX_PICTURE ? { bytes, ext } : null;
}

module.exports = { unfurl, readPage };
