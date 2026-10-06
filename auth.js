'use strict';

// Who is asking? Two modes:
//   none  Everyone is welcome and picks a display name (local use, a trusted studio network).
//   iap   The app sits behind Google Cloud's Identity-Aware Proxy. Google signs the user in and adds a
//         signed token to every request; this module checks that token and turns it into a user.
// Both fail closed: with AUTH_MODE=iap a request without a valid token never gets through.

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
  if (mode !== 'iap') throw new Error(`Unknown AUTH_MODE "${mode}". Use "none" or "iap".`);
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
    return { user: { email, name: nameFromEmail(email), color: colorFor(email) } };
  }

  return { mode, authenticate };
}

module.exports = { createAuth, nameFromEmail, colorFor };
