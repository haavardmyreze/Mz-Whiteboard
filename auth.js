'use strict';

// Who is asking? Three modes:
//   none  Everyone is welcome and picks a display name (local use, a trusted studio network).
//   google  People sign in with their Google account (OpenID Connect, done by this app) and only the
//         emails and domains on the allow list get in. For running from your own machine.
//   iap   The app sits behind Google Cloud's Identity-Aware Proxy. Google signs the user in and adds a
//         signed token to every request; this module checks that token and turns it into a user.
// All fail closed: with AUTH_MODE=iap a request without a valid token never gets through.

const crypto = require('crypto');

const IAP_KEYS_URL = 'https://www.gstatic.com/iap/verify/public_key-jwk';
const IAP_ISSUER = 'https://cloud.google.com/iap';
const COLORS = ['#e88a86', '#e8a875', '#e4c978', '#82c79b', '#74c2b9', '#8bb6e8', '#aa9ce6', '#e090b8'];

const b64 = (s) => Buffer.from(s, 'base64url');
const list = (value) => String(value || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

function nameFromEmail(email) {
  const local = email.split('@')[0].replace(/[._+-]+/g, ' ').trim();
  return local.replace(/(^|\s)\p{L}/gu, (m) => m.toUpperCase()).slice(0, 32) || 'Guest';
}

function colorFor(email) {
  let h = 0;
  for (const ch of email) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

async function fetchIapKeys() {
  const res = await fetch(IAP_KEYS_URL);
  if (!res.ok) throw new Error(`Could not fetch IAP keys (${res.status})`);
  const { keys } = await res.json();
  return new Map(keys.map((jwk) => [jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' })]));
}

function createAuth(options = {}) {
  const mode = options.mode || 'none';
  if (mode === 'none') return { mode, authenticate: async () => ({ user: null }) };
  if (mode === 'google') return createGoogleAuth(options);
  if (mode === 'password') return createPasswordAuth(options);
  if (mode !== 'iap') throw new Error(`Unknown AUTH_MODE "${mode}". Use "none", "password", "google" or "iap".`);
  if (!options.audience) {
    throw new Error('AUTH_MODE=iap needs IAP_AUDIENCE, e.g. /projects/PROJECT_NUMBER/locations/REGION/services/SERVICE_NAME');
  }

  const audience = options.audience;
  const allowedEmails = list(options.allowedEmails);
  const allowedDomains = list(options.allowedDomains);
  const getKeys = options.getKeys || fetchIapKeys;
  const now = options.now || (() => Math.floor(Date.now() / 1000));
  let cache = { keys: null, at: 0 };

  // Keys rotate rarely; refetch when stale, or when a token names a key we do not know (at most
  // once a minute so a flood of bad tokens cannot turn into a flood of fetches).
  async function keyFor(kid) {
    const age = Date.now() - cache.at;
    if (cache.keys && age < 3600e3 && cache.keys.has(kid)) return cache.keys.get(kid);
    if (!cache.keys || age > 60e3) cache = { keys: await getKeys(), at: Date.now() };
    return cache.keys.get(kid) || null;
  }

  const deny = (status) => ({ user: null, status });

  async function authenticate(req) {
    const token = req.headers['x-goog-iap-jwt-assertion'];
    if (typeof token !== 'string') return deny(401);
    const parts = token.split('.');
    if (parts.length !== 3) return deny(401);

    let header;
    let payload;
    try {
      header = JSON.parse(b64(parts[0]));
      payload = JSON.parse(b64(parts[1]));
    } catch {
      return deny(401);
    }
    if (header.alg !== 'ES256') return deny(401);

    let key;
    try {
      key = await keyFor(header.kid);
    } catch (err) {
      console.error(`IAP key lookup failed: ${err.message}`);
      return deny(503);
    }
    if (!key) return deny(401);

    const valid = crypto.verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key, dsaEncoding: 'ieee-p1363' }, b64(parts[2]));
    if (!valid) return deny(401);

    const t = now();
    if (payload.iss !== IAP_ISSUER || payload.aud !== audience || !(payload.exp > t) || payload.iat > t + 60) return deny(401);

    const email = String(payload.email || '').toLowerCase();
    if (!email) return deny(401);

    // IAP already limits who can sign in; this is a second, in-app list for when a smaller group
    // than the whole Google project should see the boards.
    if (allowedEmails.length || allowedDomains.length) {
      const domain = email.split('@')[1];
      if (!allowedEmails.includes(email) && !allowedDomains.includes(domain)) return deny(403);
    }
    return { user: { id: email, email, name: nameFromEmail(email), color: colorFor(email) } };
  }

  return { mode, authenticate };
}

// ---------------------------------------------------------------- google sign-in

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SESSION_COOKIE = 'wb_session';
const STATE_COOKIE = 'wb_oauth';
const SESSION_DAYS = 14;

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// Only ever send people back to a page of this app.
function safeNext(next) {
  return typeof next === 'string' && /^\/(?![/\\])/.test(next) && !next.startsWith('/auth/') && next.length < 300 ? next : '/';
}

function createGoogleAuth(options) {
  const { clientId, clientSecret } = options;
  const publicUrl = String(options.publicUrl || '').replace(/\/+$/, '');
  const allowedEmails = list(options.allowedEmails);
  const allowedDomains = list(options.allowedDomains);
  if (!clientId || !clientSecret || !publicUrl) {
    throw new Error('AUTH_MODE=google needs GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and PUBLIC_URL (see DEPLOY.md).');
  }
  if (!/^https?:\/\//.test(publicUrl)) throw new Error('PUBLIC_URL must start with http:// or https://');
  if (!allowedEmails.length && !allowedDomains.length) {
    throw new Error('AUTH_MODE=google needs ALLOWED_EMAILS and/or ALLOWED_DOMAINS, otherwise nobody could sign in.');
  }
  if (!options.sessionSecret) throw new Error('AUTH_MODE=google needs a session secret.');
  const secret = String(options.sessionSecret);
  const secure = publicUrl.startsWith('https://');
  const redirectUri = `${publicUrl}/auth/callback`;
  const now = options.now || (() => Math.floor(Date.now() / 1000));
  const deny = (status) => ({ user: null, status });

  const mac = (text) => crypto.createHmac('sha256', secret).update(text).digest('base64url');
  const sign = (obj) => {
    const body = Buffer.from(JSON.stringify(obj)).toString('base64url');
    return `${body}.${mac(body)}`;
  };
  function unsign(value) {
    const [body, sig] = String(value || '').split('.');
    if (!body || !sig) return null;
    const want = Buffer.from(mac(body));
    const got = Buffer.from(sig);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
    try {
      return JSON.parse(b64(body));
    } catch {
      return null;
    }
  }

  const allowed = (email) => allowedEmails.includes(email) || allowedDomains.includes(email.split('@')[1]);

  const cookie = (name, value, maxAge) =>
    `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;

  function sessionCookie(user) {
    return cookie(SESSION_COOKIE, sign({ e: user.email, n: user.name, exp: now() + SESSION_DAYS * 86400 }), SESSION_DAYS * 86400);
  }

  async function exchangeWithGoogle(code) {
    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
    });
    if (!res.ok) throw new Error(`Google refused the sign-in (${res.status})`);
    return (await res.json()).id_token;
  }
  const exchange = options.exchange || exchangeWithGoogle;

  // The token comes straight from Google over TLS in exchange for our one-time code, so, as OpenID
  // Connect allows on that path, the claims are checked rather than the signature.
  function claimsOf(idToken) {
    const parts = String(idToken || '').split('.');
    if (parts.length !== 3) throw new Error('Malformed ID token');
    const c = JSON.parse(b64(parts[1]));
    if (!['https://accounts.google.com', 'accounts.google.com'].includes(c.iss) || c.aud !== clientId || !(c.exp > now())) {
      throw new Error('ID token is not for this app');
    }
    if (c.email_verified !== true || !c.email) throw new Error('Google account has no verified email');
    return c;
  }

  async function authenticate(req) {
    const s = unsign(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    if (!s || !(s.exp > now()) || typeof s.e !== 'string') return deny(401);
    if (!allowed(s.e)) return deny(403);
    return { user: { id: s.e, email: s.e, name: String(s.n || nameFromEmail(s.e)).slice(0, 32), color: colorFor(s.e) } };
  }

  function redirect(res, to, cookies = []) {
    res.writeHead(302, { Location: to, 'Set-Cookie': cookies, 'Cache-Control': 'no-store' });
    res.end();
  }

  // /auth/google, /auth/callback and /auth/logout. Returns true when it answered the request.
  async function handle(req, res, url) {
    if (url.pathname === '/auth/info') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ mode: 'google' }));
      return true;
    }
    if (url.pathname === '/auth/google') {
      const state = crypto.randomBytes(18).toString('base64url');
      const q = new URLSearchParams({
        client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid email profile',
        state, prompt: 'select_account',
      });
      const pending = sign({ s: state, next: safeNext(url.searchParams.get('next')), exp: now() + 600 });
      redirect(res, `${GOOGLE_AUTH_URL}?${q}`, [cookie(STATE_COOKIE, pending, 600)]);
      return true;
    }
    if (url.pathname === '/auth/callback') {
      const clear = cookie(STATE_COOKIE, '', 0);
      const fail = (code) => redirect(res, `/auth/login?error=${code}`, [clear]);
      const st = unsign(parseCookies(req.headers.cookie)[STATE_COOKIE]);
      if (url.searchParams.get('error')) {
        fail('denied');
      } else if (!st || !(st.exp > now()) || st.s !== url.searchParams.get('state') || !url.searchParams.get('code')) {
        fail('failed');
      } else {
        try {
          const c = claimsOf(await exchange(url.searchParams.get('code')));
          const email = String(c.email).toLowerCase();
          if (!allowed(email)) {
            fail('not-allowed');
          } else {
            const user = { email, name: String(c.name || nameFromEmail(email)).slice(0, 32) };
            redirect(res, safeNext(st.next), [sessionCookie(user), clear]);
          }
        } catch (err) {
          console.error(`Google sign-in failed: ${err.message}`);
          fail('failed');
        }
      }
      return true;
    }
    if (url.pathname === '/auth/logout') {
      redirect(res, '/auth/login', [cookie(SESSION_COOKIE, '', 0)]);
      return true;
    }
    return false;
  }

  return { mode: 'google', interactive: true, authenticate, handle, publicUrl, sessionCookie };
}

// ---------------------------------------------------------------- shared password

// Everyone who knows the one password gets in and says who they are. The name is only a label, so two
// people can type the same name and then share a personal workspace; nobody is vouching for anyone.
function createPasswordAuth(options) {
  const password = String(options.password || '');
  if (!password) throw new Error('AUTH_MODE=password needs SITE_PASSWORD, the one password everybody uses.');
  if (!options.sessionSecret) throw new Error('AUTH_MODE=password needs a session secret.');
  const now = options.now || (() => Math.floor(Date.now() / 1000));
  const publicUrl = String(options.publicUrl || '').replace(/\/+$/, '');
  const digest = (text) => crypto.createHash('sha256').update(text).digest();
  const passwordHash = digest(password);
  // Changing the password signs everybody out: the sessions are signed with a key that includes it.
  const key = `${options.sessionSecret}:${passwordHash.toString('hex')}`;
  const mac = (text) => crypto.createHmac('sha256', key).update(text).digest('base64url');
  const deny = (status) => ({ user: null, status });

  const sign = (obj) => {
    const body = Buffer.from(JSON.stringify(obj)).toString('base64url');
    return `${body}.${mac(body)}`;
  };
  function unsign(value) {
    const [body, sig] = String(value || '').split('.');
    if (!body || !sig) return null;
    const want = Buffer.from(mac(body));
    const got = Buffer.from(sig);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
    try {
      return JSON.parse(b64(body));
    } catch {
      return null;
    }
  }

  const cleanName = (value) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 32);
  const idOf = (name) => `name:${name.toLowerCase()}`;
  const isHttps = (req) => publicUrl.startsWith('https://') || req.headers['x-forwarded-proto'] === 'https';
  const cookie = (req, value, maxAge) =>
    `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;

  // Guessing is slowed: a few wrong tries from one address, then a wait.
  const misses = new Map();
  const WINDOW = 10 * 60;
  const MAX_MISSES = 8;
  const who = (req) => String(req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '');
  const fresh = (m) => m && now() - m.t <= WINDOW;
  const blocked = (ip) => {
    const m = misses.get(ip);
    if (m && !fresh(m)) misses.delete(ip);
    return (misses.get(ip)?.n || 0) >= MAX_MISSES;
  };
  const miss = (ip) => {
    const m = misses.get(ip);
    misses.set(ip, fresh(m) ? { n: m.n + 1, t: m.t } : { n: 1, t: now() });
    if (misses.size > 5000) misses.clear();
  };

  async function authenticate(req) {
    const s = unsign(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    if (!s || !(s.exp > now()) || typeof s.n !== 'string' || !cleanName(s.n)) return deny(401);
    const name = cleanName(s.n);
    return { user: { id: idOf(name), email: null, name, color: colorFor(idOf(name)) } };
  }

  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  };

  function readBody(req) {
    return new Promise((resolve) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > 4096) req.destroy();
        else chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          resolve({});
        }
      });
      req.on('error', () => resolve({}));
    });
  }

  async function handle(req, res, url) {
    if (url.pathname === '/auth/info') {
      json(res, 200, { mode: 'password' });
      return true;
    }
    if (url.pathname === '/auth/password' && req.method === 'POST') {
      const ip = who(req);
      if (blocked(ip)) {
        json(res, 429, { error: 'Too many wrong tries. Wait a few minutes and try again.' });
        return true;
      }
      const body = await readBody(req);
      const name = cleanName(body.name);
      if (!name) {
        json(res, 400, { error: 'Please enter your name.' });
        return true;
      }
      if (!crypto.timingSafeEqual(digest(String(body.password || '')), passwordHash)) {
        miss(ip);
        json(res, 401, { error: 'That password is not right.' });
        return true;
      }
      misses.delete(ip);
      const maxAge = SESSION_DAYS * 86400;
      json(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, sign({ n: name, exp: now() + maxAge }), maxAge) });
      return true;
    }
    if (url.pathname === '/auth/logout') {
      res.writeHead(302, { Location: '/auth/login', 'Set-Cookie': cookie(req, '', 0), 'Cache-Control': 'no-store' });
      res.end();
      return true;
    }
    return false;
  }

  function sessionCookie(user, req = { headers: {} }) {
    return cookie(req, sign({ n: user.name, exp: now() + SESSION_DAYS * 86400 }), SESSION_DAYS * 86400);
  }

  return { mode: 'password', interactive: true, authenticate, handle, publicUrl: publicUrl || null, sessionCookie };
}

module.exports = { createAuth, nameFromEmail, colorFor, parseCookies, safeNext };
