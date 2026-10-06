'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createAuth } = require('../auth');

// ---------------------------------------------------------------- sign-in

const AUDIENCE = '/projects/123/locations/europe-west1/services/wipboard';
const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });

function token(claims = {}, key = privateKey, kid = 'k1') {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = enc({ alg: 'ES256', typ: 'JWT', kid });
  const body = enc({ iss: 'https://cloud.google.com/iap', aud: AUDIENCE, iat: now - 5, exp: now + 600, email: 'haavard.vikesland@myreze.com', ...claims });
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${head}.${body}.${sig}`;
}

const iap = (extra = {}) => createAuth({ mode: 'iap', audience: AUDIENCE, getKeys: async () => new Map([['k1', publicKey]]), ...extra });
const asRequest = (jwt) => ({ headers: jwt ? { 'x-goog-iap-jwt-assertion': jwt } : {} });

test('no sign-in mode lets everyone in without an identity', async () => {
  assert.deepEqual(await createAuth({ mode: 'none' }).authenticate(asRequest()), { user: null });
});

test('a valid token becomes a user', async () => {
  const { user, status } = await iap().authenticate(asRequest(token()));
  assert.equal(status, undefined);
  assert.equal(user.email, 'haavard.vikesland@myreze.com');
  assert.equal(user.name, 'Haavard Vikesland');
  assert.match(user.color, /^#[0-9a-f]{6}$/);
});

test('anything that is not a valid token is refused', async () => {
  const auth = iap();
  assert.equal((await auth.authenticate(asRequest())).status, 401);
  assert.equal((await auth.authenticate(asRequest('not.a.token'))).status, 401);
  assert.equal((await auth.authenticate(asRequest(token({ aud: '/projects/9/other' })))).status, 401);
  assert.equal((await auth.authenticate(asRequest(token({ exp: Math.floor(Date.now() / 1000) - 10 })))).status, 401);
  assert.equal((await auth.authenticate(asRequest(token({ iss: 'https://evil.example' })))).status, 401);
  assert.equal((await auth.authenticate(asRequest(token({ email: undefined })))).status, 401);
  // signed by somebody else's key
  const other = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
  assert.equal((await auth.authenticate(asRequest(token({}, other)))).status, 401);
  // a token whose payload was edited after signing
  const [h, , s] = token().split('.');
  const forged = Buffer.from(JSON.stringify({ iss: 'https://cloud.google.com/iap', aud: AUDIENCE, exp: 9999999999, email: 'x@evil.example' })).toString('base64url');
  assert.equal((await auth.authenticate(asRequest(`${h}.${forged}.${s}`))).status, 401);
});

test('the in-app allow list can narrow who gets in', async () => {
  const auth = iap({ allowedDomains: 'myreze.com', allowedEmails: 'guest@gmail.com' });
  assert.ok((await auth.authenticate(asRequest(token()))).user);
  assert.ok((await auth.authenticate(asRequest(token({ email: 'guest@gmail.com' })))).user);
  assert.equal((await auth.authenticate(asRequest(token({ email: 'someone@gmail.com' })))).status, 403);
});

test('a misconfigured sign-in refuses to start', () => {
  assert.throws(() => createAuth({ mode: 'iap' }), /IAP_AUDIENCE/);
  assert.throws(() => createAuth({ mode: 'oauth' }), /Unknown AUTH_MODE/);
});

// ---------------------------------------------------------------- the running server

function start(port, env = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'wipboard-test-'));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', WIPBOARD_DATA: data, ...env },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  const ready = (async () => {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`${base}/healthz`)).ok) return;
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('server did not start');
  })();
  const stop = () => {
    child.kill();
    fs.rmSync(data, { recursive: true, force: true });
  };
  return { base, ready, stop };
}

test('uploads in pieces come back as the same bytes', async (t) => {
  const s = start(4791);
  t.after(s.stop);
  await s.ready;

  const bytes = crypto.randomBytes(20 * 1024 * 1024 + 123);
  const uid = 'testupload1';
  const piece = 8 * 1024 * 1024;
  let result;
  for (let offset = 0; offset < bytes.length; offset += piece) {
    const end = Math.min(bytes.length, offset + piece);
    const res = await fetch(`${s.base}/api/upload?name=a.webm&uid=${uid}&offset=${offset}&done=${end >= bytes.length ? 1 : 0}`, { method: 'POST', body: bytes.subarray(offset, end) });
    assert.equal(res.status, 200);
    result = await res.json();
  }
  assert.equal(result.size, bytes.length);
  const back = Buffer.from(await (await fetch(s.base + result.url)).arrayBuffer());
  assert.ok(back.equals(bytes));
});

test('a plain single upload still works, and a missing piece is caught', async (t) => {
  const s = start(4792);
  t.after(s.stop);
  await s.ready;

  const small = crypto.randomBytes(5000);
  const ok = await fetch(`${s.base}/api/upload?name=b.png`, { method: 'POST', body: small });
  assert.equal(ok.status, 200);
  const { url } = await ok.json();
  assert.ok(Buffer.from(await (await fetch(s.base + url)).arrayBuffer()).equals(small));

  // pieces 0 and 2 arrive, piece 1 never does
  await fetch(`${s.base}/api/upload?name=c.png&uid=gapupload1&offset=0&done=0`, { method: 'POST', body: Buffer.alloc(100) });
  const gap = await fetch(`${s.base}/api/upload?name=c.png&uid=gapupload1&offset=300&done=1`, { method: 'POST', body: Buffer.alloc(100) });
  assert.equal(gap.status, 409);

  const bad = await fetch(`${s.base}/api/upload?name=d.exe`, { method: 'POST', body: small });
  assert.equal(bad.status, 415);
});

test('behind sign-in the server answers the health check but nothing else without a token', async (t) => {
  const s = start(4793, { AUTH_MODE: 'iap', IAP_AUDIENCE: AUDIENCE });
  t.after(s.stop);
  await s.ready;
  assert.equal((await fetch(`${s.base}/healthz`)).status, 200);
  assert.equal((await fetch(`${s.base}/`)).status, 401);
  assert.equal((await fetch(`${s.base}/api/boards`)).status, 401);
  assert.equal((await fetch(`${s.base}/api/me`, { headers: { 'x-goog-iap-jwt-assertion': 'junk' } })).status, 401);
});

test('without sign-in /api/me reports no user', async (t) => {
  const s = start(4794);
  t.after(s.stop);
  await s.ready;
  assert.deepEqual(await (await fetch(`${s.base}/api/me`)).json(), { auth: 'none', user: null });
});

test('the in-browser video encoder is served as a module', async (t) => {
  const s = start(4795);
  t.after(s.stop);
  await s.ready;
  const res = await fetch(`${s.base}/vendor/mediabunny.mjs`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
  assert.match(await res.text(), /Conversion/);
});
