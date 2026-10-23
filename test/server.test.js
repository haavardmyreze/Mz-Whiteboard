'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createAuth } = require('../auth');
const { openStore } = require('../store');

// The pages send X-WB: 1 with every request, which the server wants with every change (see "Requests
// from other sites" in README.md), so these do too. `bareFetch` sends only what it is given.
const bareFetch = globalThis.fetch;
const fetch = (url, options = {}) => bareFetch(url, { ...options, headers: { 'x-wb': '1', ...options.headers } });

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

function start(port, env = {}, seed) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'wipboard-test-'));
  if (seed) seed(data);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    // Never the real Claude, whatever key this machine has: a test that wants it gives a stand-in.
    env: { ...process.env, ANTHROPIC_API_KEY: '', PORT: String(port), HOST: '127.0.0.1', WIPBOARD_DATA: data, WIPBOARD_ENV_FILE: path.join(data, 'no.env'), ...env },
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
    fs.rmSync(data, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
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
  assert.equal((await fetch(`${s.base}/api/library`)).status, 401);
  assert.equal((await fetch(`${s.base}/api/me`, { headers: { 'x-goog-iap-jwt-assertion': 'junk' } })).status, 401);
});

test('without sign-in /api/me reports no user', async (t) => {
  const s = start(4794);
  t.after(s.stop);
  await s.ready;
  const { shareBases, ...me } = await (await fetch(`${s.base}/api/me`)).json();
  assert.deepEqual(me, { auth: 'none', user: null, admin: true, canShare: true, maxUpload: 1024 ** 3, publicUrl: null, signOut: false, ai: null });
  // share links never point at localhost: only at addresses other computers can reach
  assert.ok(shareBases.every((b) => /^http:\/\/\d+\.\d+\.\d+\.\d+:4794$/.test(b) && !b.includes('127.0.0.1')));
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

test('comments are stamped with who wrote them, only ever sit on a piece of content, and only their author edits them', async (t) => {
  const WebSocket = require('ws');
  const s = start(4796);
  t.after(s.stop);
  await s.ready;
  const board = await (await fetch(`${s.base}/api/boards`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Review' }) })).json();

  const join = (name) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:4796/ws?board=${board.id}`);
    const seen = [];
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', name, color: '#336699' })));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      seen.push(msg);
      if (msg.t === 'init') resolve({ ws, seen });
    });
  });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const author = await join('Anna');
  const reviewer = await join('Ben');
  t.after(() => { author.ws.close(); reviewer.ws.close(); });

  author.ws.send(JSON.stringify({ t: 'op', ops: [
    { t: 'add', item: { id: 'imageone1', type: 'image', x: 0, y: 0, w: 100, h: 100, src: '/x.png' } },
    // claims to be somebody else, and carries a field no comment has
    { t: 'add', item: { id: 'comment01', type: 'comment', on: 'imageone1', rx: 4, ry: 0.5, text: ' Lovely ', name: 'Boss', color: '#ff0000', extra: 1 } },
    // not on anything, and empty: both refused
    { t: 'add', item: { id: 'comment02', type: 'comment', x: 5, y: 5, text: 'floating' } },
    { t: 'add', item: { id: 'comment03', type: 'comment', on: 'imageone1', text: '   ' } },
    // about the image as a whole, pointing at no spot on it
    { t: 'add', item: { id: 'comment04', type: 'comment', on: 'imageone1', text: 'Overall: lovely' } },
    // made in 3D: where the view was is kept (cleaned), anything else said to be one is not
    { t: 'add', item: { id: 'comment05', type: 'comment', on: 'imageone1', text: 'From the booth', pov: { p: [1.234567, 2, -3], q: [0, 0, 0, 2], fov: 40.12345, x: 1 } } },
    { t: 'add', item: { id: 'comment06', type: 'comment', on: 'imageone1', text: 'Odd view', pov: { p: [1, 2], q: [0, 0, 0, 1], fov: 40 } } },
    { t: 'add', item: { id: 'comment07', type: 'comment', on: 'imageone1', text: 'Through main', pov: 'main' } },
  ] }));
  await wait(300);

  const added = reviewer.seen.filter((m) => m.t === 'op').flatMap((m) => m.ops).filter((o) => o.item && o.item.type === 'comment');
  assert.equal(added.length, 5);
  assert.deepEqual(added[2].item.pov, { p: [1.2346, 2, -3], q: [0, 0, 0, 1], fov: 40.123 });
  assert.equal(added[3].item.pov, undefined);
  assert.equal(added[4].item.pov, 'main');
  const c = added[0].item;
  assert.equal(c.name, 'Anna');
  assert.equal(c.color, '#336699');
  assert.equal(c.text, 'Lovely');
  assert.equal(c.rx, 1);
  assert.equal(c.extra, undefined);
  assert.equal(added[1].item.text, 'Overall: lovely');
  assert.ok(!('rx' in added[1].item) && !('ry' in added[1].item));

  // the only thing about a comment that can change afterwards is whether it is resolved
  reviewer.ws.send(JSON.stringify({ t: 'op', ops: [{ t: 'set', id: 'comment01', patch: { text: 'rewritten', name: 'Ben', done: true } }] }));
  await wait(300);
  const late = await join('Cara');
  t.after(() => late.ws.close());
  const stored = late.seen.find((m) => m.t === 'init').items.find((i) => i.id === 'comment01');
  assert.equal(stored.text, 'Lovely');
  assert.equal(stored.name, 'Anna');
  assert.equal(stored.done, true);
  assert.equal(stored.edited, undefined);

  // whoever wrote it can change what it says, and it is marked as edited; nothing else about it moves
  author.ws.send(JSON.stringify({ t: 'op', ops: [{ t: 'set', id: 'comment01', patch: { text: '  Lovely, really ', name: 'Boss', on: 'elsewhere' } }] }));
  await wait(300);
  const edit = reviewer.seen.filter((m) => m.t === 'op' && !m.fix).flatMap((m) => m.ops).find((o) => o.t === 'set' && o.patch.text);
  assert.equal(edit.patch.text, 'Lovely, really');
  assert.ok(edit.patch.edited > 0);
  assert.deepEqual(Object.keys(edit.patch).sort(), ['edited', 'text']);
  const last = await join('Dora');
  t.after(() => last.ws.close());
  const now = last.seen.find((m) => m.t === 'init').items.find((i) => i.id === 'comment01');
  assert.equal(now.text, 'Lovely, really');
  assert.equal(now.name, 'Anna');
  assert.equal(now.on, 'imageone1');
});

// ---------------------------------------------------------------- google sign-in

const googleOptions = (extra = {}) => ({
  mode: 'google', clientId: 'client-1', clientSecret: 'shh', publicUrl: 'https://boards.example.com',
  sessionSecret: 'a-long-secret', allowedDomains: 'myreze.com', allowedEmails: 'guest@gmail.com', ...extra,
});

function idToken(claims = {}) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const body = { iss: 'https://accounts.google.com', aud: 'client-1', exp: Math.floor(Date.now() / 1000) + 600, email: 'anna@myreze.com', email_verified: true, name: 'Anna Berg', ...claims };
  return `${enc({ alg: 'RS256' })}.${enc(body)}.sig`;
}

function fakeRes() {
  const res = { status: 0, headers: {}, writeHead(s, h) { res.status = s; res.headers = h; }, end() {} };
  return res;
}

test('google sign-in refuses to start without what it needs', () => {
  assert.throws(() => createAuth(googleOptions({ clientId: '' })), /GOOGLE_CLIENT_ID/);
  assert.throws(() => createAuth(googleOptions({ allowedDomains: '', allowedEmails: '' })), /ALLOWED_EMAILS/);
  assert.throws(() => createAuth(googleOptions({ sessionSecret: '' })), /session secret/);
  assert.throws(() => createAuth(googleOptions({ publicUrl: 'boards.example.com' })), /PUBLIC_URL/);
});

test('a google session cookie is a user, until it is forged, expired or not on the list any more', async () => {
  const auth = createAuth(googleOptions());
  const cookieOf = (a, user) => a.sessionCookie(user).split(';')[0];
  const ask = (a, cookie) => a.authenticate({ headers: { cookie } });
  const good = cookieOf(auth, { email: 'anna@myreze.com', name: 'Anna Berg' });
  const { user } = await ask(auth, good);
  assert.equal(user.email, 'anna@myreze.com');
  assert.equal(user.name, 'Anna Berg');

  assert.equal((await ask(auth, undefined)).status, 401);
  assert.equal((await ask(auth, good.slice(0, -2) + 'xx')).status, 401);
  assert.equal((await ask(createAuth(googleOptions({ sessionSecret: 'another' })), good)).status, 401);
  assert.equal((await ask(createAuth(googleOptions({ now: () => Math.floor(Date.now() / 1000) + 15 * 86400 })), good)).status, 401);
  assert.equal((await ask(createAuth(googleOptions({ allowedDomains: 'other.com' })), good)).status, 403);
  assert.match(auth.sessionCookie({ email: 'a@myreze.com', name: 'A' }), /HttpOnly; SameSite=Lax.*Secure/);
});

function pendingNext(setCookie) {
  const body = setCookie.split(';')[0].split('=')[1].split('.')[0];
  return JSON.parse(Buffer.from(body, 'base64url')).next;
}

test('the google callback checks state, token and allow list before it signs anyone in', async () => {
  let token = idToken();
  const auth = createAuth(googleOptions({ exchange: async () => token }));

  const begin = fakeRes();
  await auth.handle({ headers: {} }, begin, new URL('http://x/auth/google?next=/b/abcd1234'));
  assert.equal(begin.status, 302);
  const to = new URL(begin.headers.Location);
  assert.equal(to.origin + to.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(to.searchParams.get('redirect_uri'), 'https://boards.example.com/auth/callback');
  const pending = begin.headers['Set-Cookie'][0].split(';')[0];
  const state = to.searchParams.get('state');

  const callback = async (query, cookie = pending) => {
    const res = fakeRes();
    await auth.handle({ headers: { cookie } }, res, new URL(`http://x/auth/callback?${query}`));
    return res;
  };
  const ok = await callback(`code=c&state=${state}`);
  assert.equal(ok.headers.Location, '/b/abcd1234');
  assert.ok(ok.headers['Set-Cookie'].some((c) => c.startsWith('wb_session=') && !c.includes('Max-Age=0')));

  assert.match((await callback('code=c&state=wrong')).headers.Location, /error=failed/);
  assert.match((await callback(`code=c&state=${state}`, '')).headers.Location, /error=failed/);
  assert.match((await callback('error=access_denied')).headers.Location, /error=denied/);
  token = idToken({ email: 'stranger@gmail.com' });
  assert.match((await callback(`code=c&state=${state}`)).headers.Location, /error=not-allowed/);
  token = idToken({ aud: 'someone-elses-app' });
  assert.match((await callback(`code=c&state=${state}`)).headers.Location, /error=failed/);
  token = idToken({ email_verified: false });
  assert.match((await callback(`code=c&state=${state}`)).headers.Location, /error=failed/);

  // people are only ever sent back to a page of this app
  const evil = fakeRes();
  await auth.handle({ headers: {} }, evil, new URL('http://x/auth/google?next=//evil.example'));
  assert.equal(pendingNext(evil.headers['Set-Cookie'][0]), '/');
});

test('with google sign-in nothing is served to strangers except the sign-in page and read-only links', async (t) => {
  const shareToken = 'sharedlinktoken123456';
  const s = start(4797, {
    AUTH_MODE: 'google', GOOGLE_CLIENT_ID: 'client-1', GOOGLE_CLIENT_SECRET: 'shh',
    PUBLIC_URL: 'http://localhost:4797', ALLOWED_EMAILS: 'anna@example.com',
  }, (data) => {
    const store = openStore(data);
    store.saveBoard({ id: 'boardone1', name: 'Secret plans', workspace: 'myreze', shareToken, shareAccess: 'view', createdAt: 1, updatedAt: 1 },
      [{ id: 'videoone1', type: 'video', x: 0, y: 0, w: 10, h: 10, src: '/uploads/abc.mp4', th: '/uploads/abc.png', orig: '/uploads/orig.mov' }]);
    store.close();
  });
  t.after(s.stop);
  await s.ready;
  const get = (p, opts) => fetch(s.base + p, { redirect: 'manual', ...opts });

  const home = await get('/');
  assert.equal(home.status, 302);
  assert.match(home.headers.get('location'), /^\/auth\/login\?next=%2F$/);
  assert.equal((await get('/b/boardone1')).status, 302);
  assert.equal((await get('/api/library')).status, 401);
  assert.equal((await get('/uploads/abc.png')).status, 401);
  assert.equal((await get('/auth/login')).status, 200);
  assert.equal((await get('/style.css')).status, 200);
  assert.equal((await get('/auth/google')).status, 302);

  // a read-only link needs nothing, tells nothing but the name, and cannot reach the editable board
  assert.equal((await get(`/s/${shareToken}`)).status, 200);
  assert.deepEqual(await (await get(`/api/shared/${shareToken}`)).json(), { name: 'Secret plans', access: 'view' });
  assert.equal((await get('/api/shared/notarealtokenvalue000')).status, 404);
  assert.equal((await get('/api/boards/boardone1')).status, 401);
  // opening it lets that browser load the files the board shows, which a stranger still cannot; never
  // any other file, nor the file a video was made from
  const page = await get(`/s/${shareToken}`);
  assert.match(page.headers.get('set-cookie'), /wb_view=/);
  const viewing = { headers: { cookie: `wb_view=${shareToken}` } };
  assert.notEqual((await get('/uploads/abc.png', viewing)).status, 401);
  assert.notEqual((await get('/uploads/abc.mp4', viewing)).status, 401);
  assert.equal((await get('/uploads/orig.mov', viewing)).status, 401);
  assert.equal((await get('/uploads/other.png', viewing)).status, 401);
  assert.equal((await get('/uploads/abc.png', { headers: { cookie: 'wb_view=wrongtoken00000000000' } })).status, 401);
});

// ---------------------------------------------------------------- read-only links

test('a read-only link shows the board live, hides comments, accepts no changes and stops when revoked', async (t) => {
  const WebSocket = require('ws');
  const s = start(4798);
  t.after(s.stop);
  await s.ready;
  const json = { 'content-type': 'application/json' };
  const board = await (await fetch(`${s.base}/api/boards`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'Review' }) })).json();
  const { token } = await (await fetch(`${s.base}/api/boards/${board.id}/share`, { method: 'POST' })).json();
  assert.match(token, /^[\w-]{16,}$/);
  assert.equal((await (await fetch(`${s.base}/api/boards/${board.id}/share`, { method: 'POST' })).json()).token, token);

  const open = (query, name) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:4798/ws?${query}`);
    const conn = { ws, seen: [], closed: null };
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', name, color: '#336699' })));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      conn.seen.push(msg);
      if (msg.t === 'init') resolve(conn);
    });
    ws.on('error', reject);
    ws.on('close', (code) => { conn.closed = code; });
  });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const editor = await open(`board=${board.id}`, 'Anna');
  editor.ws.send(JSON.stringify({ t: 'op', ops: [
    { t: 'add', item: { id: 'imageone1', type: 'image', x: 0, y: 0, w: 100, h: 100, src: '/x.png' } },
    { t: 'add', item: { id: 'comment01', type: 'comment', on: 'imageone1', text: 'internal note' } },
  ] }));
  await wait(200);

  const viewer = await open(`share=${token}`, 'Eve');
  t.after(() => { editor.ws.close(); viewer.ws.close(); });
  const init = viewer.seen.find((m) => m.t === 'init');
  assert.deepEqual(init.items.map((i) => i.id), ['imageone1']);
  assert.equal(init.board.id, undefined);
  assert.deepEqual(init.peers.map((p) => p.name), ['Anna']);
  // the editors see the viewer arrive as a pointer carrying the name they gave
  await wait(150);
  const arrival = editor.seen.find((m) => m.t === 'join');
  assert.equal(arrival.peer.name, 'Eve');
  assert.equal(arrival.peer.viewer, true);

  // live changes arrive, minus comments
  editor.ws.send(JSON.stringify({ t: 'op', ops: [
    { t: 'add', item: { id: 'noteone01', type: 'note', x: 5, y: 5, w: 50, h: 50, text: 'hi' } },
    { t: 'add', item: { id: 'comment02', type: 'comment', on: 'imageone1', text: 'second' } },
  ] }));
  await wait(200);
  const live = viewer.seen.filter((m) => m.t === 'op').flatMap((m) => m.ops);
  assert.deepEqual(live.map((o) => o.item.id), ['noteone01']);

  // whatever a viewer sends is ignored
  viewer.ws.send(JSON.stringify({ t: 'op', ops: [{ t: 'add', item: { id: 'vandal001', type: 'note', x: 0, y: 0, w: 1, h: 1 } }, { t: 'del', ids: ['imageone1'] }, { t: 'meta', patch: { name: 'Hacked' } }] }));
  viewer.ws.send(JSON.stringify({ t: 'media', id: 'imageone1', playing: true, time: 3 }));
  // ...except a pointer and the laser, which reach the editors without anything else the viewer claims
  viewer.ws.send(JSON.stringify({ t: 'p', p: { c: [10, 20], l: 1, s: ['imageone1'], v: [0, 0, 1], name: 'Boss' } }));
  viewer.ws.send(JSON.stringify({ t: 'laser', pts: [1, 2, 3, 4] }));
  await wait(250);
  assert.ok(!editor.seen.some((m) => m.t === 'op' && m.from));
  assert.ok(!editor.seen.some((m) => m.t === 'media'));
  const pointer = editor.seen.find((m) => m.t === 'p' && m.id === arrival.peer.id);
  assert.deepEqual(pointer.p, { c: [10, 20], l: 1 });
  assert.deepEqual(editor.seen.find((m) => m.t === 'laser' && m.id === arrival.peer.id).pts, [1, 2, 3, 4]);
  const meta = await (await fetch(`${s.base}/api/boards/${board.id}`)).json();
  assert.equal(meta.name, 'Review');
  assert.equal(meta.online, 1);

  // a wrong link opens nothing; revoking closes the live view and kills the link
  await assert.rejects(open('share=notarealtokenvalue000', 'Mallory'));
  assert.equal((await fetch(`${s.base}/api/boards/${board.id}/share`, { method: 'DELETE' })).status, 200);
  await wait(200);
  assert.equal(viewer.closed, 4005);
  assert.equal((await fetch(`${s.base}/api/shared/${token}`)).status, 404);
});

// ---------------------------------------------------------------- workspaces

test('the Myreze workspace is shared and a personal one is private to its owner', async (t) => {
  const secret = 'workspace-test-secret';
  const mk = createAuth(googleOptions({ sessionSecret: secret, allowedDomains: 'x.com', allowedEmails: '', publicUrl: 'http://localhost:4799' }));
  const cookie = (email, name) => mk.sessionCookie({ email, name }).split(';')[0];
  const anna = cookie('anna@x.com', 'Anna');
  const ben = cookie('ben@x.com', 'Ben');
  const s = start(4799, {
    AUTH_MODE: 'google', GOOGLE_CLIENT_ID: 'client-1', GOOGLE_CLIENT_SECRET: 'shh', PUBLIC_URL: 'http://localhost:4799',
    ALLOWED_DOMAINS: 'x.com', SESSION_SECRET: secret,
  });
  t.after(s.stop);
  await s.ready;
  const call = async (who, method, p, body) => {
    const res = await fetch(s.base + p, { method, headers: { cookie: who, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  const shared = (await call(anna, 'POST', '/api/boards', { name: 'Team board' })).body;
  const mine = (await call(anna, 'POST', '/api/boards', { name: 'Anna private', workspace: 'personal' })).body;
  assert.equal(shared.workspace, 'myreze');
  assert.equal(mine.workspace, 'personal');

  const names = async (who) => (await call(who, 'GET', '/api/library')).body.boards.map((b) => b.name).sort();
  assert.deepEqual(await names(anna), ['Anna private', 'Team board']);
  assert.deepEqual(await names(ben), ['Team board']);
  assert.equal((await call(ben, 'GET', `/api/boards/${mine.id}`)).status, 404);
  assert.equal((await call(ben, 'PATCH', `/api/boards/${mine.id}`, { name: 'mine now' })).status, 404);
  assert.equal((await call(ben, 'DELETE', `/api/boards/${mine.id}`)).status, 404);
  assert.equal((await call(ben, 'POST', `/api/boards/${mine.id}/share`)).status, 404);
  assert.equal((await call(ben, 'GET', `/api/boards/${shared.id}`)).status, 200);

  // folders follow the workspace they are made in, and carry their boards with them when moved
  const folder = (await call(anna, 'POST', '/api/folders', { name: 'Ideas', workspace: 'personal' })).body;
  assert.equal(folder.workspace, 'personal');
  assert.equal((await call(ben, 'PATCH', `/api/folders/${folder.id}`, { name: 'x' })).status, 404);
  const inside = (await call(anna, 'POST', '/api/boards', { name: 'Inside', folderId: folder.id })).body;
  assert.equal(inside.workspace, 'personal');
  assert.equal((await call(anna, 'PATCH', `/api/boards/${shared.id}`, { folderId: folder.id })).status, 400);
  assert.equal((await call(anna, 'POST', '/api/folders', { name: 'Sub', parentId: folder.id })).body.workspace, 'personal');

  assert.equal((await call(anna, 'PATCH', `/api/folders/${folder.id}`, { workspace: 'myreze' })).body.workspace, 'myreze');
  assert.deepEqual(await names(ben), ['Inside', 'Team board']);
  assert.ok((await call(ben, 'GET', '/api/library')).body.folders.some((f) => f.name === 'Ideas' && f.workspace === 'myreze'));

  // a board moved across lands at the top level of the other workspace
  assert.equal((await call(anna, 'PATCH', `/api/boards/${mine.id}`, { workspace: 'myreze' })).body.workspace, 'myreze');
  assert.deepEqual(await names(ben), ['Anna private', 'Inside', 'Team board']);
  assert.equal((await call(anna, 'PATCH', `/api/boards/${shared.id}`, { workspace: 'personal' })).body.workspace, 'personal');
  assert.deepEqual(await names(ben), ['Anna private', 'Inside']);
});

test('without sign-in there is only the shared workspace', async (t) => {
  const s = start(4800);
  t.after(s.stop);
  await s.ready;
  const json = { 'content-type': 'application/json' };
  const board = await (await fetch(`${s.base}/api/boards`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'A', workspace: 'personal' }) })).json();
  assert.equal(board.workspace, 'myreze');
  const moved = await fetch(`${s.base}/api/boards/${board.id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ workspace: 'personal' }) });
  assert.equal(moved.status, 400);
});

// ---------------------------------------------------------------- shared password

const passwordAuth = (extra = {}) => createAuth({ mode: 'password', password: 'team-secret', sessionSecret: 'sess', ...extra });

function fakeReq(body, headers = {}) {
  const { Readable } = require('node:stream');
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.headers = headers;
  req.method = 'POST';
  req.socket = { remoteAddress: '1.2.3.4' };
  return req;
}

function jsonRes() {
  const res = { status: 0, headers: {}, body: '', writeHead(s, h) { res.status = s; res.headers = h; }, end(b) { res.body = b || ''; } };
  return res;
}

test('password sign-in needs a password to start with', () => {
  assert.throws(() => createAuth({ mode: 'password', sessionSecret: 'x' }), /SITE_PASSWORD/);
});

test('the shared password plus a name signs someone in, and nothing else does', async () => {
  const auth = passwordAuth();
  const attempt = async (body, headers) => {
    const res = jsonRes();
    await auth.handle(fakeReq(body, headers), res, new URL('http://x/auth/password'));
    return res;
  };

  const ok = await attempt({ name: '  Anna   Berg ', password: 'team-secret' }, { 'x-forwarded-proto': 'https' });
  assert.equal(ok.status, 200);
  assert.match(ok.headers['Set-Cookie'], /HttpOnly; SameSite=Lax.*Secure/);
  const cookie = ok.headers['Set-Cookie'].split(';')[0];
  const { user } = await auth.authenticate({ headers: { cookie } });
  assert.equal(user.name, 'Anna Berg');
  assert.equal(user.id, 'name:anna berg');

  assert.equal((await attempt({ name: 'Anna', password: 'wrong' })).status, 401);
  assert.equal((await attempt({ name: '', password: 'team-secret' })).status, 400);
  assert.equal((await auth.authenticate({ headers: {} })).status, 401);
  assert.equal((await auth.authenticate({ headers: { cookie: cookie.slice(0, -2) + 'xx' } })).status, 401);
  // changing the password signs everybody out
  assert.equal((await passwordAuth({ password: 'new-secret' }).authenticate({ headers: { cookie } })).status, 401);
  // a session does not outlive its time
  assert.equal((await passwordAuth({ now: () => Math.floor(Date.now() / 1000) + 15 * 86400 }).authenticate({ headers: { cookie } })).status, 401);
});

test('too many wrong passwords from one address are turned away', async () => {
  const auth = passwordAuth();
  const attempt = async (password) => {
    const res = jsonRes();
    await auth.handle(fakeReq({ name: 'Eve', password }, { 'cf-connecting-ip': '9.9.9.9' }), res, new URL('http://x/auth/password'));
    return res.status;
  };
  for (let i = 0; i < 8; i++) assert.equal(await attempt('nope'), 401);
  assert.equal(await attempt('nope'), 429);
  assert.equal(await attempt('team-secret'), 429);
});

test('with a shared password strangers see the sign-in page, and each name has its own personal workspace', async (t) => {
  const s = start(4812, { AUTH_MODE: 'password', SITE_PASSWORD: 'team-secret' });
  t.after(s.stop);
  await s.ready;
  const get = (p, opts) => fetch(s.base + p, { redirect: 'manual', ...opts });
  assert.equal((await get('/')).status, 302);
  assert.equal((await get('/api/library')).status, 401);
  assert.deepEqual(await (await get('/auth/info')).json(), { mode: 'password' });

  const login = async (name) => {
    const res = await fetch(`${s.base}/auth/password`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, password: 'team-secret' }) });
    assert.equal(res.status, 200);
    return res.headers.get('set-cookie').split(';')[0];
  };
  const anna = await login('Anna');
  const ben = await login('Ben');
  const call = async (cookie, method, p, body) => (await fetch(s.base + p, { method, headers: { cookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json();

  assert.equal((await call(anna, 'GET', '/api/me')).user.name, 'Anna');
  await call(anna, 'POST', '/api/boards', { name: 'Anna private', workspace: 'personal' });
  await call(anna, 'POST', '/api/boards', { name: 'Everyone' });
  assert.deepEqual((await call(anna, 'GET', '/api/library')).boards.map((b) => b.name).sort(), ['Anna private', 'Everyone']);
  assert.deepEqual((await call(ben, 'GET', '/api/library')).boards.map((b) => b.name), ['Everyone']);
});

// ---------------------------------------------------------------- staying up, and keeping what it was given

// One request line sent as it is, since fetch would tidy a malformed address before sending it.
function rawRequest(port, line) {
  const net = require('node:net');
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(`${line}\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`));
    let reply = '';
    socket.on('data', (d) => { reply += d; });
    socket.on('close', () => resolve(reply.split('\r\n')[0]));
    socket.on('error', () => resolve('no reply'));
  });
}

test('a malformed request is refused and the server carries on', async (t) => {
  const s = start(4813);
  t.after(s.stop);
  await s.ready;
  assert.match(await rawRequest(4813, 'GET // HTTP/1.1'), / 400 /);
  assert.match(await rawRequest(4813, 'GET /%00 HTTP/1.1'), / 400 /);
  assert.match(await rawRequest(4813, 'GET /uploads/%00.png HTTP/1.1'), / 400 /);
  assert.match(await rawRequest(4813, 'GET /%E0%A4%A HTTP/1.1'), / 400 /);
  assert.equal((await fetch(`${s.base}/healthz`)).status, 200);

  // a body that is not a JSON object is the caller's mistake, not a server error
  const post = (body) => fetch(`${s.base}/api/boards`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  assert.equal((await post('{not json')).status, 400);
  assert.equal((await post('[1,2]')).status, 400);
  assert.equal((await post('null')).status, 400);
  assert.equal((await post('{"name":"Fine"}')).status, 201);
});

test('a change made just before shutdown is on disk when the server comes back', async (t) => {
  const WebSocket = require('ws');
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'wipboard-test-'));
  t.after(() => fs.rmSync(data, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const run = () => spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, ANTHROPIC_API_KEY: '', PORT: '4814', HOST: '127.0.0.1', WIPBOARD_DATA: data, WIPBOARD_ENV_FILE: path.join(data, 'no.env') },
    stdio: 'ignore',
  });
  const base = 'http://127.0.0.1:4814';
  const up = async () => {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`${base}/healthz`)).ok) return;
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('server did not start');
  };

  const first = run();
  await up();
  const board = await (await fetch(`${base}/api/boards`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Keep me' }) })).json();
  // long enough for the new board's own save to have finished, so only the edit below is unsaved
  await new Promise((r) => setTimeout(r, 1200));
  const ws = new WebSocket(`ws://127.0.0.1:4814/ws?board=${board.id}`);
  await new Promise((resolve) => {
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', name: 'Anna' })));
    ws.on('message', (raw) => { if (JSON.parse(raw).t === 'init') resolve(); });
  });
  const acked = new Promise((resolve) => ws.on('message', (raw) => { if (JSON.parse(raw).t === 'ack') resolve(); }));
  ws.send(JSON.stringify({ t: 'op', ops: [{ t: 'add', item: { id: 'lastnote1', type: 'note', x: 1, y: 2, w: 100, h: 0, text: 'said just in time' } }] }));
  await acked;
  const gone = new Promise((resolve) => first.on('exit', resolve));
  assert.equal((await fetch(`${base}/__shutdown`, { method: 'POST' })).status, 200);
  await gone;

  const second = run();
  t.after(() => second.kill());
  await up();
  assert.equal((await (await fetch(`${base}/api/boards/${board.id}`)).json()).count, 1);
  const again = await joiner(4814)(`board=${board.id}`, 'Anna');
  again.ws.close();
  assert.deepEqual(again.seen.find((m) => m.t === 'init').items.map((i) => i.text), ['said just in time']);
});

test('files the browser already has are not sent again', async (t) => {
  const s = start(4815);
  t.after(s.stop);
  await s.ready;
  const first = await fetch(`${s.base}/style.css`);
  const etag = first.headers.get('etag');
  assert.ok(etag);
  await first.arrayBuffer();
  const again = await fetch(`${s.base}/style.css`, { headers: { 'if-none-match': etag } });
  assert.equal(again.status, 304);
  assert.equal((await fetch(`${s.base}/style.css`, { headers: { 'if-none-match': '"something-else"' } })).status, 200);
  // where the app does no sign-in of its own, there is no sign-in page
  const login = await fetch(`${s.base}/auth/login`, { redirect: 'manual' });
  assert.equal(login.status, 302);
  assert.equal(login.headers.get('location'), '/');
});

// ---------------------------------------------------------------- who is on a board

function joiner(port) {
  const WebSocket = require('ws');
  return (query, name, options) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?${query}`, options);
    const conn = { ws, seen: [], closed: null };
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', name, color: '#336699' })));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      conn.seen.push(msg);
      if (msg.t === 'init') resolve(conn);
    });
    ws.on('error', reject);
    ws.on('close', (code) => { conn.closed = code; });
  });
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

test('everyone on a board is told about link viewers, whenever they arrive, and other sites cannot connect', async (t) => {
  const s = start(4816);
  t.after(s.stop);
  await s.ready;
  const open = joiner(4816);
  const board = await (await fetch(`${s.base}/api/boards`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Review' }) })).json();
  const { token } = await (await fetch(`${s.base}/api/boards/${board.id}/share`, { method: 'POST' })).json();

  const viewer = await open(`share=${token}`, 'Eve');
  const late = await open(`board=${board.id}`, 'Anna');
  t.after(() => { viewer.ws.close(); late.ws.close(); });
  // the editor who arrived after the viewer knows about them too, so their pointer shows for everyone
  assert.deepEqual(late.seen.find((m) => m.t === 'init').peers.map((p) => [p.name, p.viewer]), [['Eve', true]]);

  // a page on another site cannot open a board from somebody's browser; our own pages can
  await assert.rejects(open(`board=${board.id}`, 'Mallory', { headers: { origin: 'https://evil.example' } }));
  const ours = await open(`board=${board.id}`, 'Ben', { headers: { origin: 'http://127.0.0.1:4816' } });
  ours.ws.close();
});

test('a deleted comment that somebody else undoes comes back as its author wrote it', async (t) => {
  const s = start(4817);
  t.after(s.stop);
  await s.ready;
  const open = joiner(4817);
  const board = await (await fetch(`${s.base}/api/boards`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Review' }) })).json();
  const anna = await open(`board=${board.id}`, 'Anna');
  const ben = await open(`board=${board.id}`, 'Ben');
  t.after(() => { anna.ws.close(); ben.ws.close(); });

  anna.ws.send(JSON.stringify({ t: 'op', ops: [
    { t: 'add', item: { id: 'imageone1', type: 'image', x: 0, y: 0, w: 100, h: 100, src: '/x.png' } },
    { t: 'add', item: { id: 'comment01', type: 'comment', on: 'imageone1', text: 'Mine', t: 1700000000000 } },
  ] }));
  await pause(150);
  // Ben may not delete what Anna wrote: it stays, and his page is given it back before the ack
  ben.ws.send(JSON.stringify({ t: 'op', seq: 1, ops: [{ t: 'del', ids: ['comment01'] }] }));
  await pause(150);
  const fixed = ben.seen.findIndex((m) => m.t === 'op' && m.fix);
  assert.equal(ben.seen[fixed].ops[0].item.id, 'comment01');
  assert.deepEqual(ben.seen[fixed + 1], { t: 'ack', seq: 1 });
  assert.ok(!anna.seen.some((m) => m.t === 'op' && m.ops.some((o) => o.t === 'del')));
  // Anna deletes it, Ben's page undoes that: the comment comes back, and the server must not make it his
  anna.ws.send(JSON.stringify({ t: 'op', ops: [{ t: 'del', ids: ['comment01'] }] }));
  await pause(150);
  ben.ws.send(JSON.stringify({ t: 'op', ops: [{ t: 'add', item: { id: 'comment01', type: 'comment', on: 'imageone1', text: 'Tampered', name: 'Ben' } }] }));
  await pause(150);
  const back = anna.seen.filter((m) => m.t === 'op').flatMap((m) => m.ops).filter((o) => o.t === 'add').pop().item;
  assert.equal(back.name, 'Anna');
  assert.equal(back.text, 'Mine');
  assert.equal(back.t, 1700000000000);
});

test('housekeeping a browser does on opening a board does not count as an edit', async (t) => {
  const s = start(4818);
  t.after(s.stop);
  await s.ready;
  const open = joiner(4818);
  const board = await (await fetch(`${s.base}/api/boards`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Review' }) })).json();
  const anna = await open(`board=${board.id}`, 'Anna');
  t.after(() => anna.ws.close());
  const meta = async () => (await fetch(`${s.base}/api/boards/${board.id}`)).json();

  anna.ws.send(JSON.stringify({ t: 'op', ops: [
    { t: 'add', item: { id: 'imageone1', type: 'image', x: 0, y: 0, w: 100, h: 100, src: '/uploads/big.png' } },
    { t: 'add', item: { id: 'videoone1', type: 'video', x: 0, y: 0, w: 100, h: 100, src: '/uploads/clip.mp4', th: '/uploads/clip.webp' } },
    { t: 'add', item: { id: 'strokeon1', type: 'stroke', x: 0, y: 0, w: 10, h: 10, pts: [0, 0, 1, 1], size: 4 } },
  ] }));
  await pause(150);
  const before = await meta();
  // drawings are not counted one stroke at a time, and a video shows the still made for it
  assert.equal(before.count, 2);
  assert.deepEqual(before.thumbs, ['/uploads/big.png', '/uploads/clip.webp']);

  await pause(20);
  anna.ws.send(JSON.stringify({ t: 'op', quiet: true, ops: [{ t: 'set', id: 'imageone1', patch: { th: '/uploads/small.webp' } }] }));
  await pause(150);
  const after = await meta();
  assert.deepEqual(after.thumbs, ['/uploads/small.webp', '/uploads/clip.webp']);
  assert.equal(after.updatedAt, before.updatedAt);
});

test('moving a board to a personal workspace shows everybody else on it the door', async (t) => {
  const secret = 'move-test-secret';
  const mk = createAuth(googleOptions({ sessionSecret: secret, allowedDomains: 'x.com', allowedEmails: '', publicUrl: 'http://localhost:4819' }));
  const cookie = (email, name) => mk.sessionCookie({ email, name }).split(';')[0];
  const anna = cookie('anna@x.com', 'Anna');
  const ben = cookie('ben@x.com', 'Ben');
  const s = start(4819, {
    AUTH_MODE: 'google', GOOGLE_CLIENT_ID: 'client-1', GOOGLE_CLIENT_SECRET: 'shh', PUBLIC_URL: 'http://localhost:4819',
    ALLOWED_DOMAINS: 'x.com', SESSION_SECRET: secret,
  });
  t.after(s.stop);
  await s.ready;
  const open = joiner(4819);
  const call = (who, method, p, body) => fetch(s.base + p, { method, headers: { cookie: who, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const board = await (await call(anna, 'POST', '/api/boards', { name: 'Team board' })).json();

  const hers = await open(`board=${board.id}`, 'Anna', { headers: { cookie: anna } });
  const his = await open(`board=${board.id}`, 'Ben', { headers: { cookie: ben } });
  t.after(() => { hers.ws.close(); his.ws.close(); });
  assert.equal((await call(anna, 'PATCH', `/api/boards/${board.id}`, { workspace: 'personal' })).status, 200);
  await pause(200);
  assert.equal(his.closed, 4003);
  assert.equal(hers.closed, null);
  await assert.rejects(open(`board=${board.id}`, 'Ben', { headers: { cookie: ben } }));
});

// ---------------------------------------------------------------- the database and the catalogue

test('the catalogue finds frames by name across boards, what they hold, and words in anything', async (t) => {
  const s = start(4821);
  t.after(s.stop);
  await s.ready;
  const open = joiner(4821);
  const mk = async (name) => (await fetch(`${s.base}/api/boards`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) })).json();
  const one = await mk('Monday review');
  const two = await mk('Client round 2');
  const anna = await open(`board=${one.id}`, 'Anna');
  const ben = await open(`board=${two.id}`, 'Ben');
  t.after(() => { anna.ws.close(); ben.ws.close(); });
  anna.ws.send(JSON.stringify({ t: 'op', ops: [
    { t: 'add', item: { id: 'framedesk1', type: 'frame', x: 0, y: 0, w: 400, h: 300, title: 'News desk' } },
    { t: 'add', item: { id: 'imgdesk001', type: 'image', x: 10, y: 40, w: 200, h: 100, src: '/uploads/a1.png', name: 'desk_v001.png', fid: 'framedesk1' } },
    { t: 'add', item: { id: 'framewall1', type: 'frame', x: 500, y: 0, w: 400, h: 300, title: 'Video wall' } },
    { t: 'add', item: { id: 'notewall01', type: 'note', x: 510, y: 40, w: 200, h: 0, text: 'Brighter rim light on the anchor', fid: 'framewall1' } },
  ] }));
  ben.ws.send(JSON.stringify({ t: 'op', ops: [
    { t: 'add', item: { id: 'framedesk2', type: 'frame', x: 0, y: 0, w: 400, h: 300, title: '  NEWS   Desk ' } },
    { t: 'add', item: { id: 'viddesk002', type: 'video', x: 10, y: 40, w: 200, h: 100, src: '/uploads/b2.mp4', name: 'desk_v002.mp4', fid: 'framedesk2', fps: 25, dur: 4 } },
  ] }));
  await pause(200);
  const get = async (query) => (await (await fetch(`${s.base}/api/catalog?${query}`)).json()).items;

  // every frame called "news desk", however it was typed, on every board
  const frames = await get('type=frame&name=News%20desk');
  assert.deepEqual(frames.map((r) => r.board.name).sort(), ['Client round 2', 'Monday review']);
  // what those frames hold, with the frame and board each one is on, and who put it there
  const inside = await get('in=news%20desk&type=image,video');
  assert.deepEqual(inside.map((r) => r.item.name).sort(), ['desk_v001.png', 'desk_v002.mp4']);
  const v2 = inside.find((r) => r.item.id === 'viddesk002');
  assert.equal(v2.frame.title, 'NEWS   Desk');
  assert.equal(v2.createdBy, 'Ben');
  // words anywhere, the last one as the start of a word
  assert.deepEqual((await get('q=rim%20lig')).map((r) => r.item.id), ['notewall01']);
  assert.deepEqual((await get('q=desk_v00')).map((r) => r.item.id).sort(), ['imgdesk001', 'viddesk002']);
  // where one file is used
  assert.deepEqual((await get('media=b2.mp4')).map((r) => r.board.id), [two.id]);

  // a change is found straight away, and a deleted board is not found at all
  ben.ws.send(JSON.stringify({ t: 'op', ops: [{ t: 'set', id: 'framedesk2', patch: { title: 'Desk B' } }] }));
  await pause(100);
  assert.equal((await get('type=frame&name=news%20desk')).length, 1);
  assert.equal((await fetch(`${s.base}/api/boards/${one.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await get('type=frame&name=news%20desk')).length, 0);
});

test('the catalogue only shows what the person asking can see', async (t) => {
  const s = start(4822, { AUTH_MODE: 'password', SITE_PASSWORD: 'pw', SESSION_SECRET: 'catalogue-secret' });
  t.after(s.stop);
  await s.ready;
  const signIn = async (name) => {
    const res = await fetch(`${s.base}/auth/password`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, password: 'pw' }) });
    return res.headers.get('set-cookie').split(';')[0];
  };
  const anna = await signIn('Anna');
  const ben = await signIn('Ben');
  const mine = await (await fetch(`${s.base}/api/boards`, { method: 'POST', headers: { cookie: anna, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Private', workspace: 'personal' }) })).json();
  const conn = await joiner(4822)(`board=${mine.id}`, 'Anna', { headers: { cookie: anna } });
  conn.ws.send(JSON.stringify({ t: 'op', ops: [{ t: 'add', item: { id: 'secretfr1', type: 'frame', x: 0, y: 0, w: 10, h: 10, title: 'Secret' } }] }));
  await pause(150);
  conn.ws.close();
  const find = async (who) => (await (await fetch(`${s.base}/api/catalog?type=frame&name=secret`, { headers: { cookie: who } })).json()).items.length;
  assert.equal(await find(anna), 1);
  assert.equal(await find(ben), 0);
  assert.equal((await fetch(`${s.base}/api/catalog?type=frame`)).status, 401);
});

test('every uploaded file is catalogued, with what the boards using it know about it', async (t) => {
  const s = start(4823);
  t.after(s.stop);
  await s.ready;
  const { url } = await (await fetch(`${s.base}/api/upload?name=file.mp4`, { method: 'POST', body: crypto.randomBytes(3000) })).json();
  const file = url.split('/').pop();
  const board = await (await fetch(`${s.base}/api/boards`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Dailies' }) })).json();
  const conn = await joiner(4823)(`board=${board.id}`, 'Anna');
  t.after(() => conn.ws.close());
  conn.ws.send(JSON.stringify({ t: 'op', ops: [{ t: 'add', item: { id: 'clipone01', type: 'video', x: 0, y: 0, w: 192, h: 108, src: url, name: 'sh010_v003.mov', nw: 1920, nh: 1080, fps: 23.976, dur: 5.005 } }] }));
  await pause(150);
  const res = await (await fetch(`${s.base}/api/catalog/media/${file}`)).json();
  assert.equal(res.media.kind, 'video');
  assert.equal(res.media.size, 3000);
  assert.equal(res.media.original_name, 'sh010_v003.mov');
  assert.equal(res.media.fps, 23.976);
  assert.equal(res.media.width, 1920);
  assert.deepEqual(res.uses.map((r) => r.board.name), ['Dailies']);
  assert.equal((await fetch(`${s.base}/api/catalog/media/nothing.png`)).status, 404);
});

test('a board nobody has open is let go of, and comes back whole when somebody opens it', async (t) => {
  const s = start(4824, { WIPBOARD_IDLE_MS: '300' });
  t.after(s.stop);
  await s.ready;
  const open = joiner(4824);
  const board = await (await fetch(`${s.base}/api/boards`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Quiet' }) })).json();
  const first = await open(`board=${board.id}`, 'Anna');
  first.ws.send(JSON.stringify({ t: 'op', ops: [
    { t: 'add', item: { id: 'imageone1', type: 'image', x: 0, y: 0, w: 100, h: 100, src: '/uploads/one.png' } },
    { t: 'add', item: { id: 'noteone01', type: 'note', x: 0, y: 0, w: 100, h: 0, text: 'still here' } },
  ] }));
  await pause(50);
  // closed before the change has even been written
  first.ws.close();
  await pause(1500);
  // the board list still knows what is on it
  const meta = await (await fetch(`${s.base}/api/boards/${board.id}`)).json();
  assert.equal(meta.count, 2);
  assert.deepEqual(meta.thumbs, ['/uploads/one.png']);
  const again = await open(`board=${board.id}`, 'Anna');
  again.ws.close();
  assert.deepEqual(again.seen.find((m) => m.t === 'init').items.map((i) => i.id), ['imageone1', 'noteone01']);
});

// ---------------------------------------------------------------- what a link allows

test('a link can show the comments, let its holders comment, run out, and be replaced', async (t) => {
  const s = start(4825);
  t.after(s.stop);
  await s.ready;
  const open = joiner(4825);
  const json = (method, p, body) => fetch(s.base + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
  const board = await json('POST', '/api/boards', { name: 'Client review' });
  const editor = await open(`board=${board.id}`, 'Anna');
  t.after(() => editor.ws.close());
  editor.ws.send(JSON.stringify({ t: 'op', ops: [
    { t: 'add', item: { id: 'imageone1', type: 'image', x: 0, y: 0, w: 100, h: 100, src: '/x.png' } },
    { t: 'add', item: { id: 'teamnote1', type: 'comment', on: 'imageone1', text: 'Internal note' } },
  ] }));
  await pause(150);

  // turned on, it starts as look-only
  const on = await json('POST', `/api/boards/${board.id}/share`);
  assert.equal(on.access, 'view');
  assert.equal(on.expiresAt, null);

  // allowed to comment: they see the team's comments and can add their own, under the name they gave, and nothing more
  const changed = await json('PATCH', `/api/boards/${board.id}/share`, { access: 'comment' });
  assert.equal(changed.access, 'comment');
  const guest = await open(`share=${on.token}`, 'Client Carl');
  t.after(() => guest.ws.close());
  const init = guest.seen.find((m) => m.t === 'init');
  assert.equal(init.access, 'comment');
  assert.ok(init.items.some((i) => i.id === 'teamnote1'));
  guest.ws.send(JSON.stringify({ t: 'op', ops: [
    { t: 'add', item: { id: 'guestnote', type: 'comment', on: 'imageone1', text: 'Love it', name: 'The Boss' } },
    { t: 'add', item: { id: 'guestrepl', type: 'comment', on: 'imageone1', re: 'teamnote1', text: 'Agreed' } },
    { t: 'add', item: { id: 'nowhere01', type: 'comment', on: 'missing01', text: 'Lost' } },
    { t: 'set', id: 'teamnote1', patch: { done: true } },
    { t: 'del', ids: ['teamnote1'] },
    { t: 'add', item: { id: 'vandal001', type: 'note', x: 0, y: 0, w: 1, h: 1, text: 'x' } },
  ] }));
  await pause(200);
  const got = editor.seen.filter((m) => m.t === 'op' && m.from).flatMap((m) => m.ops);
  assert.deepEqual(got.map((o) => [o.t, o.item && o.item.id]), [['add', 'guestnote'], ['add', 'guestrepl']]);
  assert.equal(got[0].item.name, 'Client Carl');
  assert.equal(got[0].item.guest, true);

  // changing what the link allows sends whoever is watching to reload
  await json('PATCH', `/api/boards/${board.id}/share`, { access: 'view' });
  await pause(150);
  assert.equal(guest.closed, 4006);
  const looker = await open(`share=${on.token}`, 'Eve');
  t.after(() => looker.ws.close());
  assert.ok(!looker.seen.find((m) => m.t === 'init').items.some((i) => i.type === 'comment'));

  // a new address: the old one stops at once
  const fresh = await json('POST', `/api/boards/${board.id}/share/reset`);
  assert.notEqual(fresh.token, on.token);
  assert.equal(fresh.access, 'view');
  await pause(100);
  assert.equal(looker.closed, 4005);
  assert.equal((await fetch(`${s.base}/api/shared/${on.token}`)).status, 404);
  assert.equal((await fetch(`${s.base}/api/shared/${fresh.token}`)).status, 200);

  // running out
  await json('PATCH', `/api/boards/${board.id}/share`, { expiresAt: Date.now() + 500 });
  assert.equal((await fetch(`${s.base}/api/shared/${fresh.token}`)).status, 200);
  await pause(700);
  assert.equal((await fetch(`${s.base}/api/shared/${fresh.token}`)).status, 404);
  await assert.rejects(open(`share=${fresh.token}`, 'Late'));
  assert.equal((await (await fetch(`${s.base}/api/boards/${board.id}/share`)).json()).token, fresh.token);
});

// ---------------------------------------------------------------- notifications

test('people hear about replies, comments on their work and boards, and mentions, until they read them', async (t) => {
  const s = start(4826);
  t.after(s.stop);
  await s.ready;
  const open = joiner(4826);
  const board = await (await fetch(`${s.base}/api/boards`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Set review', by: 'Anna' }) })).json();
  const people = {};
  for (const name of ['Anna', 'Ben', 'Cleo', 'Dave']) people[name] = await open(`board=${board.id}`, name);
  t.after(() => Object.values(people).forEach((p) => p.ws.close()));
  const say = async (name, ops) => {
    people[name].ws.send(JSON.stringify({ t: 'op', ops }));
    await pause(80);
  };
  await say('Anna', [{ t: 'add', item: { id: 'annaimage', type: 'image', x: 0, y: 0, w: 100, h: 100, src: '/uploads/a.png', name: 'desk_v002.png' } }]);
  await say('Ben', [{ t: 'add', item: { id: 'benimage1', type: 'image', x: 200, y: 0, w: 100, h: 100, src: '/uploads/b.png', name: 'lighting_v001.png' } }]);
  await say('Ben', [{ t: 'add', item: { id: 'bencom001', type: 'comment', on: 'annaimage', text: 'Rim light is too hot' } }]);
  await say('Anna', [{ t: 'add', item: { id: 'annacom01', type: 'comment', on: 'benimage1', text: 'Agree, @cleo can you look?' } }]);
  await say('Cleo', [{ t: 'add', item: { id: 'cleorep01', type: 'comment', on: 'annaimage', re: 'bencom001', text: 'Fixed in v3' } }]);
  await say('Dave', [{ t: 'add', item: { id: 'davecom01', type: 'comment', on: 'benimage1', text: 'Nice notes' } }]);

  const notices = async (name) => (await fetch(`${s.base}/api/notifications?name=${name}`)).json();
  const kinds = (n) => n.items.map((i) => [i.id, i.kind]).sort();
  assert.deepEqual(kinds(await notices('Anna')), [['bencom001', 'work'], ['cleorep01', 'work'], ['davecom01', 'board']]);
  assert.deepEqual(kinds(await notices('Ben')), [['annacom01', 'work'], ['cleorep01', 'reply'], ['davecom01', 'work']]);
  assert.deepEqual(kinds(await notices('Cleo')), [['annacom01', 'mention']]);
  assert.deepEqual(kinds(await notices('Dave')), []);
  const first = (await notices('Anna')).items.find((i) => i.id === 'bencom001');
  assert.equal(first.on, 'desk_v002.png');
  assert.equal(first.author, 'Ben');
  assert.equal(first.board.name, 'Set review');

  // read one, then all
  assert.equal((await notices('Anna')).unread, 3);
  await fetch(`${s.base}/api/notifications/read?name=Anna`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: ['bencom001'] }) });
  const after = await notices('Anna');
  assert.equal(after.unread, 2);
  assert.equal(after.items.find((i) => i.id === 'bencom001').read, true);
  await fetch(`${s.base}/api/notifications/read?name=Anna`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ all: true }) });
  assert.equal((await notices('Anna')).unread, 0);
  // what comes after that is new again, and nobody hears about their own
  await say('Ben', [{ t: 'add', item: { id: 'bencom002', type: 'comment', on: 'annaimage', text: 'One more' } }]);
  assert.equal((await notices('Anna')).unread, 1);
  assert.equal((await notices('Ben')).items.some((i) => i.id === 'bencom002'), false);
});

test('with no sign-in the admin area opens on the machine that runs the server, and nowhere else', async (t) => {
  const s = start(4830, { ADMIN_EMAILS: 'anna@x.com' });
  t.after(s.stop);
  await s.ready;
  assert.equal((await fetch(`${s.base}/admin`)).status, 200);
  assert.equal((await (await fetch(`${s.base}/api/me`)).json()).admin, true);
  let res = await fetch(`${s.base}/api/admin`);
  assert.equal(res.status, 200);
  let view = await res.json();
  assert.equal(view.me, null);
  assert.equal(view.local, true);
  res = await fetch(`${s.base}/api/admin/users`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'ben@x.com', name: 'Ben' }) });
  view = await res.json();
  assert.deepEqual(view.users.map((u) => u.email), ['anna@x.com', 'ben@x.com']);
  // through a tunnel or proxy it is anybody at all
  const far = { 'X-Forwarded-For': '203.0.113.9' };
  res = await fetch(`${s.base}/api/admin`, { headers: far });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /sign-in/);
  assert.equal((await (await fetch(`${s.base}/api/me`, { headers: far })).json()).admin, false);
});

test('the admin area stays closed with a sign-in that does not say who people are', async (t) => {
  const s = start(4832, { AUTH_MODE: 'password', SITE_PASSWORD: 'open sesame' });
  t.after(s.stop);
  await s.ready;
  const signIn = await fetch(`${s.base}/auth/password`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Anna', password: 'open sesame' }) });
  assert.equal(signIn.status, 200);
  const cookie = signIn.headers.get('set-cookie').split(';')[0];
  const res = await fetch(`${s.base}/api/admin`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /sign-in/);
});

test('admins manage people, groups and permissions on shared boards and folders, and nobody else can', async (t) => {
  const secret = 'admin-test-secret';
  const mk = createAuth(googleOptions({ sessionSecret: secret, allowedDomains: 'x.com', allowedEmails: '', publicUrl: 'http://localhost:4831' }));
  const cookie = (email, name) => mk.sessionCookie({ email, name }).split(';')[0];
  const anna = cookie('anna@x.com', 'Anna');
  const ben = cookie('ben@x.com', 'Ben');
  const s = start(4831, {
    AUTH_MODE: 'google', GOOGLE_CLIENT_ID: 'client-1', GOOGLE_CLIENT_SECRET: 'shh', PUBLIC_URL: 'http://localhost:4831',
    ALLOWED_DOMAINS: 'x.com', SESSION_SECRET: secret, ADMIN_EMAILS: 'Anna@x.com',
  });
  t.after(s.stop);
  await s.ready;
  const call = async (who, method, p, body, headers = {}) => {
    const res = await fetch(s.base + p, { method, headers: { cookie: who, 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  assert.equal((await call(anna, 'GET', '/api/me')).body.admin, true);
  assert.equal((await call(ben, 'GET', '/api/me')).body.admin, false);
  assert.equal((await call(ben, 'GET', '/api/admin')).status, 403);

  // everyone who signs in is known from then on; the admins from ADMIN_EMAILS are there from the start
  let view = (await call(anna, 'GET', '/api/admin')).body;
  assert.deepEqual(view.users.map((u) => [u.email, u.name, u.admin, u.fixed]), [['anna@x.com', 'Anna', true, true], ['ben@x.com', 'Ben', false, false]]);
  assert.ok(view.users.every((u) => u.lastSeenAt > 0));

  // changes only from our own pages
  assert.equal((await call(anna, 'POST', '/api/admin/users', { email: 'carl@x.com' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await call(anna, 'POST', '/api/admin/users', { email: 'not an email' })).status, 400);
  view = (await call(anna, 'POST', '/api/admin/users', { email: ' Carl@X.com ', name: 'Carl' })).body;
  assert.ok(view.users.some((u) => u.email === 'carl@x.com' && u.name === 'Carl' && !u.lastSeenAt));
  assert.equal((await call(anna, 'POST', '/api/admin/users', { email: 'carl@x.com' })).status, 409);

  // admins can make admins, but nobody unmakes themselves or an admin named in ADMIN_EMAILS
  await call(anna, 'PATCH', '/api/admin/users/ben%40x.com', { admin: true });
  assert.equal((await call(ben, 'GET', '/api/admin')).status, 200);
  assert.equal((await call(ben, 'PATCH', '/api/admin/users/ben%40x.com', { admin: false })).status, 400);
  assert.equal((await call(ben, 'PATCH', '/api/admin/users/anna%40x.com', { admin: false })).status, 400);
  assert.equal((await call(ben, 'DELETE', '/api/admin/users/ben%40x.com')).status, 400);
  await call(anna, 'PATCH', '/api/admin/users/ben%40x.com', { admin: false });
  assert.equal((await call(ben, 'GET', '/api/admin')).status, 403);

  view = (await call(anna, 'POST', '/api/admin/groups', { name: 'Lighting' })).body;
  const lighting = view.groups.find((g) => g.name === 'Lighting');
  await call(anna, 'PUT', `/api/admin/groups/${lighting.id}/members/carl%40x.com`);
  view = (await call(anna, 'PUT', `/api/admin/groups/${lighting.id}/members/ben%40x.com`)).body;
  assert.deepEqual(view.groups[0].members, ['ben@x.com', 'carl@x.com']);
  assert.equal((await call(anna, 'PUT', `/api/admin/groups/${lighting.id}/members/nobody%40x.com`)).status, 404);
  assert.equal((await call(anna, 'PATCH', `/api/admin/groups/${lighting.id}`, { name: 'Lookdev' })).body.groups[0].name, 'Lookdev');

  // permissions go on boards and folders in the shared workspace; granting again changes the role
  const team = (await call(anna, 'POST', '/api/boards', { name: 'Team board' })).body;
  const mine = (await call(anna, 'POST', '/api/boards', { name: 'Anna private', workspace: 'personal' })).body;
  const folder = (await call(anna, 'POST', '/api/folders', { name: 'Shots' })).body;
  view = (await call(anna, 'GET', '/api/admin')).body;
  assert.deepEqual(view.targets.boards.map((b) => b.name), ['Team board']);
  const onTeam = { target: { type: 'board', id: team.id }, principal: { type: 'group', id: lighting.id } };
  await call(anna, 'POST', '/api/admin/grants', { ...onTeam, role: 'editor' });
  view = (await call(anna, 'POST', '/api/admin/grants', { ...onTeam, role: 'viewer' })).body;
  assert.deepEqual(view.grants.map((g) => [g.target.id, g.principal.id, g.role, g.createdBy]), [[team.id, lighting.id, 'viewer', 'anna@x.com']]);
  assert.equal((await call(anna, 'POST', '/api/admin/grants', { ...onTeam, role: 'owner' })).status, 400);
  assert.equal((await call(anna, 'POST', '/api/admin/grants', { ...onTeam, target: { type: 'board', id: mine.id }, role: 'viewer' })).status, 400);
  assert.equal((await call(anna, 'POST', '/api/admin/grants', { ...onTeam, principal: { type: 'group', id: 'nope' }, role: 'viewer' })).status, 400);
  await call(anna, 'POST', '/api/admin/grants', { target: { type: 'folder', id: folder.id }, principal: { type: 'user', id: 'carl@x.com' }, role: 'manager' });
  assert.equal((await call(anna, 'GET', '/api/admin')).body.grants.length, 2);

  // whatever goes takes its grants and memberships with it
  await call(anna, 'DELETE', `/api/folders/${folder.id}`);
  view = (await call(anna, 'GET', '/api/admin')).body;
  assert.deepEqual(view.grants.map((g) => g.target.type), ['board']);
  await call(anna, 'POST', '/api/admin/grants', { target: { type: 'board', id: team.id }, principal: { type: 'user', id: 'carl@x.com' }, role: 'commenter' });
  view = (await call(anna, 'DELETE', '/api/admin/users/carl%40x.com')).body;
  assert.deepEqual(view.groups[0].members, ['ben@x.com']);
  assert.deepEqual(view.grants.map((g) => g.principal.type), ['group']);
  view = (await call(anna, 'DELETE', `/api/admin/groups/${lighting.id}`)).body;
  assert.deepEqual([view.groups, view.grants], [[], []]);
});

// What a zip holds, read the way an unpacker reads it: from the index at the end.
function unzip(buf) {
  const end = buf.length - 22;
  assert.equal(buf.readUInt32LE(end), 0x06054b50);
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const files = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(at), 0x02014b50);
    const crc = buf.readUInt32LE(at + 16);
    const size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    assert.equal(buf.readUInt32LE(local), 0x04034b50);
    assert.equal(buf.readUInt32LE(local + 14), crc);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    assert.equal(require('node:zlib').crc32(data), crc);
    files.push({ name, data });
    at += 46 + nameLen + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
  }
  return files;
}

test('a video keeps the file it was made from, a board comes down as one zip, and link viewers are not told of originals', async (t) => {
  const s = start(4833);
  t.after(s.stop);
  await s.ready;
  const json = { 'content-type': 'application/json' };
  const put = async (name, bytes) => (await (await fetch(`${s.base}/api/upload?name=${name}`, { method: 'POST', body: bytes })).json()).url;
  const copy = crypto.randomBytes(5000);
  const original = crypto.randomBytes(90000);
  const picture = crypto.randomBytes(700);
  const other = crypto.randomBytes(800);
  const old = crypto.randomBytes(900);
  const [copyUrl, originalUrl, pictureUrl, otherUrl, oldUrl] = [await put('a.mp4', copy), await put('a.mov', original), await put('a.png', picture), await put('b.png', other), await put('c.mp4', old)];

  assert.equal(typeof (await (await fetch(`${s.base}/api/me`)).json()).maxUpload, 'number');
  const board = await (await fetch(`${s.base}/api/boards`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'Shots: act 1' }) })).json();
  assert.equal((await fetch(`${s.base}/api/boards/${board.id}/media.zip`)).status, 404); // nothing on it yet
  assert.equal((await fetch(`${s.base}/api/boards/nosuchboard/media.zip`)).status, 404);
  const { token } = await (await fetch(`${s.base}/api/boards/${board.id}/share`, { method: 'POST' })).json();

  const open = joiner(4833);
  const anna = await open(`board=${board.id}`, 'Anna');
  t.after(() => anna.ws.close());
  const at = { x: 0, y: 0, w: 160, h: 90 };
  anna.ws.send(JSON.stringify({ t: 'op', ops: [
    { t: 'add', item: { id: 'video0001', type: 'video', ...at, src: copyUrl, orig: originalUrl, name: 'sh010_v003.mov' } },
    { t: 'add', item: { id: 'image0001', type: 'image', ...at, src: pictureUrl, name: 'ref.png' } },
    { t: 'add', item: { id: 'image0002', type: 'image', ...at, src: pictureUrl, name: 'ref.png' } }, // the same file twice
    { t: 'add', item: { id: 'image0003', type: 'image', ...at, src: otherUrl, name: 'ref.png' } }, // another file of the same name
    { t: 'add', item: { id: 'video0002', type: 'video', ...at, src: oldUrl, name: 'old/take:2.mov' } }, // from before originals were kept
    { t: 'add', item: { id: 'image0004', type: 'image', ...at, src: 'https://example.com/elsewhere.png', name: 'elsewhere.png' } },
    { t: 'add', item: { id: 'note00001', type: 'note', x: 0, y: 0, w: 100, h: 100, text: 'not a file' } },
  ] }));
  await pause(150);

  const res = await fetch(`${s.base}/api/boards/${board.id}/media.zip`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  assert.match(res.headers.get('content-disposition'), /^attachment; filename="Shots_ act 1\.zip"/);
  const body = Buffer.from(await res.arrayBuffer());
  assert.equal(Number(res.headers.get('content-length')), body.length);
  const head = await fetch(`${s.base}/api/boards/${board.id}/media.zip`, { method: 'HEAD' });
  assert.deepEqual([head.status, Number(head.headers.get('content-length'))], [200, body.length]);
  const files = unzip(body);
  assert.deepEqual(files.map((f) => f.name), ['sh010_v003.mov', 'ref.png', 'ref (2).png', 'old_take_2.mp4']);
  assert.ok(files[0].data.equals(original));
  assert.ok(files[1].data.equals(picture));
  assert.ok(files[2].data.equals(other));
  assert.ok(files[3].data.equals(old));

  // A download that was cut off is taken up where it stopped: any part of the archive can be asked for.
  const zipUrl = `${s.base}/api/boards/${board.id}/media.zip`;
  const tag = res.headers.get('etag');
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  for (const [range, a, b] of [['10-99', 10, 99], ['4990-5200', 4990, 5200], [`${body.length - 400}-`, body.length - 400, body.length - 1], ['-64', body.length - 64, body.length - 1]]) {
    const part = await fetch(zipUrl, { headers: { range: `bytes=${range}`, 'if-range': tag } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), `bytes ${a}-${b}/${body.length}`);
    assert.ok(Buffer.from(await part.arrayBuffer()).equals(body.subarray(a, b + 1)), `bytes ${range}`);
  }
  const stale = await fetch(zipUrl, { headers: { range: 'bytes=10-99', 'if-range': '"another-archive"' } });
  assert.deepEqual([stale.status, (await stale.arrayBuffer()).byteLength], [200, body.length]);
  assert.equal((await fetch(zipUrl, { headers: { range: `bytes=${body.length}-` } })).status, 416);

  // Somebody holding the link sees the video, and nothing of where its original is, then or later.
  const eve = await open(`share=${token}`, 'Eve');
  t.after(() => eve.ws.close());
  const shown = eve.seen.find((m) => m.t === 'init').items.find((it) => it.id === 'video0001');
  assert.equal(shown.src, copyUrl);
  assert.equal('orig' in shown, false);
  const ben = await open(`board=${board.id}`, 'Ben');
  t.after(() => ben.ws.close());
  anna.ws.send(JSON.stringify({ t: 'op', ops: [{ t: 'set', id: 'video0002', patch: { orig: originalUrl } }, { t: 'set', id: 'image0001', patch: { x: 40, orig: originalUrl } }] }));
  await pause(150);
  const sets = (conn) => conn.seen.filter((m) => m.t === 'op').flatMap((m) => m.ops).filter((op) => op.t === 'set');
  assert.deepEqual(sets(ben).map((op) => op.patch), [{ orig: originalUrl }, { x: 40, orig: originalUrl }]);
  assert.deepEqual(sets(eve).map((op) => op.patch), [{ x: 40 }]);
});

test('a zip of files past the old size limits is laid out the long way', () => {
  const { layout } = require('../zip');
  const GB = 1024 ** 3;
  const small = layout([{ name: 'a.mov', size: 10, mtime: 0 }, { name: 'b.mov', size: 20, mtime: 0 }]);
  assert.equal(small.longEnd, false);
  assert.equal(small.size, (30 + 5 + 10) + (30 + 5 + 20) + 2 * (46 + 5) + 22);
  const large = layout([{ name: 'a.mov', size: 5 * GB, mtime: 0 }, { name: 'b.mov', size: 20, mtime: 0 }]);
  assert.deepEqual(large.placed.map((e) => [e.long, e.longInIndex]), [[true, true], [false, true]]);
  assert.equal(large.longEnd, true);
  assert.equal(large.size, (30 + 5 + 20 + 5 * GB) + (30 + 5 + 20) + 2 * (46 + 5 + 28) + 76 + 22);
});

test('a board remembers what it is set to, and who opened and changed it', async (t) => {
  const s = start(4834);
  t.after(s.stop);
  await s.ready;
  const json = { 'content-type': 'application/json' };
  const board = await (await fetch(`${s.base}/api/boards`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'Layout' }) })).json();
  assert.deepEqual(board.settings, {});
  const open = joiner(4834);
  const anna = await open(`board=${board.id}`, 'Anna');
  t.after(() => anna.ws.close());
  const ben = await open(`board=${board.id}`, 'Ben');
  t.after(() => ben.ws.close());
  const ops = (conn, list, extra = {}) => conn.ws.send(JSON.stringify({ t: 'op', ops: list, ...extra }));
  const at = { x: 0, y: 0, w: 100, h: 100 };

  // What the board is set to goes to everyone on it and is kept; only settings there are are taken.
  assert.deepEqual(ben.seen.find((m) => m.t === 'init').board.settings, {});
  ops(anna, [{ t: 'meta', patch: { settings: { names: true, nonsense: true, other: 'x' } } }]);
  await pause(150);
  assert.deepEqual(ben.seen.filter((m) => m.t === 'op').pop().ops, [{ t: 'meta', patch: { settings: { names: true } } }]);
  assert.deepEqual((await (await fetch(`${s.base}/api/boards/${board.id}`)).json()).settings, { names: true });
  const carla = await open(`board=${board.id}`, 'Carla');
  t.after(() => carla.ws.close());
  assert.deepEqual(carla.seen.find((m) => m.t === 'init').board.settings, { names: true });

  ops(anna, [{ t: 'add', item: { id: 'noteone01', type: 'note', ...at, text: 'first' } }, { t: 'add', item: { id: 'notetwo01', type: 'note', ...at, text: 'second' } }]);
  ops(anna, [{ t: 'set', id: 'noteone01', patch: { x: 5 } }], { quiet: true }); // housekeeping is not somebody changing the board
  ops(ben, [{ t: 'add', item: { id: 'comment01', type: 'comment', on: 'noteone01', text: 'nice' } }]);
  await pause(150);
  const seen = await (await fetch(`${s.base}/api/boards/${board.id}/activity`)).json();
  // The same thing done again soon after is one line, counted.
  assert.deepEqual(seen.events.map((e) => `${e.who} ${e.what} ${e.n}`).sort(), ['Anna edit 3', 'Anna open 1', 'Ben comment 1', 'Ben open 1', 'Carla open 1']);
  assert.ok(seen.events.every((e) => Math.abs(Date.now() - e.at) < 10000));
  assert.equal((await fetch(`${s.base}/api/boards/nosuchboard/activity`)).status, 404);
});

test('a board is kept as it was before each round of changes, and can be put back to any of them', async (t) => {
  // A round is whatever follows a quiet spell: ten minutes as it runs, a moment here.
  const s = start(4835, { WIPBOARD_SNAPSHOT_MS: '250' });
  t.after(s.stop);
  await s.ready;
  const json = { 'content-type': 'application/json' };
  const board = await (await fetch(`${s.base}/api/boards`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'Layout' }) })).json();
  const open = joiner(4835);
  const anna = await open(`board=${board.id}`, 'Anna');
  t.after(() => anna.ws.close());
  const ben = await open(`board=${board.id}`, 'Ben');
  t.after(() => ben.ws.close());
  const ops = (conn, list) => conn.ws.send(JSON.stringify({ t: 'op', ops: list }));
  const note = (id, text) => ({ id, type: 'note', x: 0, y: 0, w: 100, h: 100, text });
  const snapshots = async () => (await (await fetch(`${s.base}/api/boards/${board.id}/activity`)).json()).snapshots;

  ops(anna, [{ t: 'add', item: note('noteone01', 'first') }]);
  await pause(150);
  assert.deepEqual(await snapshots(), []); // there was nothing on it to keep
  await pause(300);
  ops(anna, [{ t: 'add', item: note('notetwo01', 'second') }]);
  ops(anna, [{ t: 'set', id: 'notetwo01', patch: { x: 9 } }]); // the same round
  await pause(400);
  ops(ben, [{ t: 'del', ids: ['noteone01'] }]);
  await pause(150);
  let kept = await snapshots();
  assert.deepEqual(kept.map((v) => [v.who, v.count]), [['Ben', 2], ['Anna', 1]]);

  // Back to the oldest: one note. Everybody on the board is given it afresh, without themselves among the others.
  const before = [anna.seen.length, ben.seen.length];
  const put = await fetch(`${s.base}/api/boards/${board.id}/snapshots/${kept[1].at}/restore`, { method: 'POST', headers: json, body: JSON.stringify({ by: 'Anna' }) });
  assert.equal(put.status, 200);
  await pause(150);
  for (const [conn, from] of [[anna, before[0]], [ben, before[1]]]) {
    const init = conn.seen.slice(from).find((m) => m.t === 'init');
    assert.deepEqual(init.items.map((it) => [it.id, it.text]), [['noteone01', 'first']]);
    // marked as put back, so each page lets go of what it could undo
    assert.equal(init.restored, true);
    assert.equal(init.peers.length, 1);
    assert.notEqual(init.peers[0].id, init.you);
  }
  // Somebody arriving later finds the same, and what was replaced was kept, so it can be had back too.
  const carla = await open(`board=${board.id}`, 'Carla');
  t.after(() => carla.ws.close());
  assert.deepEqual(carla.seen.find((m) => m.t === 'init').items.map((it) => it.id), ['noteone01']);
  kept = await snapshots();
  assert.deepEqual(kept.map((v) => [v.who, v.count]), [['Anna', 1], ['Ben', 2], ['Anna', 1]]);
  await fetch(`${s.base}/api/boards/${board.id}/snapshots/${kept[0].at}/restore`, { method: 'POST', headers: json, body: JSON.stringify({ by: 'Ben' }) });
  await pause(150);
  assert.deepEqual(anna.seen.filter((m) => m.t === 'init').pop().items.map((it) => [it.id, it.x]), [['notetwo01', 9]]);
  const events = (await (await fetch(`${s.base}/api/boards/${board.id}/activity`)).json()).events;
  assert.deepEqual(events.filter((e) => e.what === 'restore').map((e) => e.who).sort(), ['Anna', 'Ben']);
  assert.equal((await fetch(`${s.base}/api/boards/${board.id}/snapshots/12345/restore`, { method: 'POST', headers: json, body: '{}' })).status, 404);
});

// ---------------------------------------------------------------- the catalogue: projects, versions, notes

const naming = require('../public/naming');

test('a file name fills in what it can, and a name that says nothing is no trouble', () => {
  assert.deepEqual(naming.parse('kilo-0010_anim_erik_v012.mov'), { entity: 'kilo-0010', tier: 'shot', task: 'anim', descriptor: null, artist: 'erik', hip: 12, view: null });
  // An asset or a set is read when the project has it, or names like it.
  const known = [{ name: 'char-dog', tier: 'asset' }, { name: 'set-harbour', tier: 'set' }];
  assert.deepEqual(naming.parse('char-robot_lookdev_metal_worn_anna_v3.png', known), { entity: 'char-robot', tier: 'asset', task: 'lookdev', descriptor: 'metal_worn', artist: 'anna', hip: 3, view: null });
  assert.equal(naming.parse('char-robot_lookdev_metal_worn_anna_v3.png').entity, null);
  assert.equal(naming.parse('set-living-room_dressing_v001.jpg', known).task, 'dressing');
  assert.equal(naming.parse('set-living-room_erik_v001.jpg', known).artist, 'erik');
  assert.deepEqual(naming.parse('screenshoot_090126.png'), { entity: null, tier: null, task: null, descriptor: null, artist: null, hip: null, view: null });
  // A word after the version is the view the file shows.
  assert.equal(naming.parse('ch04-0030_comp_erik_v110_bty-left.mp4').view, 'bty-left');
  assert.equal(naming.parse('ch04-0030_comp_erik_v110_bty-left.mp4').hip, 110);
  assert.equal(naming.parse('Robot Final v3.png').hip, 3);
  assert.equal(naming.tierOf('kilo-0010'), 'shot');
  assert.equal(naming.tierOf('veh-truck'), null);
  assert.equal(naming.kindOf('veh-truck', [{ name: 'veh-car', tier: 'asset' }]), 'asset');
  assert.equal(naming.tierOf('robot'), null);
  assert.equal(naming.tokenize('  Living Room! '), 'living-room');
  assert.equal(naming.seqOf('kilo-0010'), 'kilo');
  assert.equal(naming.seqOf('ch01-0010'), 'ch01');
  assert.equal(naming.tierOf('ch01-0010'), 'shot');
  assert.equal(naming.label('kilo-0010', 'anim', 5), 'kilo-0010 anim v5');
  assert.equal(naming.label('char-robot', null, 2), 'char-robot v2');
});

test('a project is a folder with a catalogue: not inside another project, and not dissolved like a folder', async (t) => {
  const s = start(4836);
  t.after(s.stop);
  await s.ready;
  const json = { 'content-type': 'application/json' };
  const call = async (method, url, body) => {
    const res = await fetch(s.base + url, { method, headers: json, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const kilo = (await call('POST', '/api/folders', { name: 'Kilo' })).body;
  const inside = (await call('POST', '/api/folders', { name: 'Reviews', parentId: kilo.id })).body;
  const other = (await call('POST', '/api/folders', { name: 'Other' })).body;

  const marked = await call('PATCH', `/api/folders/${kilo.id}`, { project: true });
  assert.equal(marked.status, 200);
  assert.equal(marked.body.project, true);
  assert.equal((await call('GET', '/api/library')).body.folders.find((f) => f.id === kilo.id).project, true);
  // not inside it, nor around it
  assert.equal((await call('PATCH', `/api/folders/${inside.id}`, { project: true })).status, 400);
  const around = (await call('POST', '/api/folders', { name: 'Studio' })).body;
  await call('PATCH', `/api/folders/${kilo.id}`, { parentId: around.id });
  assert.equal((await call('PATCH', `/api/folders/${around.id}`, { project: true })).status, 400);
  await call('PATCH', `/api/folders/${other.id}`, { project: true });
  assert.equal((await call('PATCH', `/api/folders/${other.id}`, { parentId: inside.id })).status, 400);

  // its catalogue
  const robot = await call('POST', `/api/projects/${kilo.id}/entities`, { name: 'Char Robot' });
  assert.equal(robot.status, 201);
  assert.equal(robot.body.name, 'char-robot');
  assert.equal(robot.body.tier, 'asset');
  const shot = (await call('POST', `/api/projects/${kilo.id}/entities`, { name: 'kilo-0010' })).body;
  assert.equal(shot.tier, 'shot');
  assert.equal((await call('POST', `/api/projects/${kilo.id}/entities`, { name: 'kilo-0010' })).body.id, shot.id);
  const cat = (await call('GET', `/api/projects/${kilo.id}`)).body;
  assert.deepEqual(cat.entities.map((e) => e.name), ['char-robot', 'kilo-0010']);
  assert.ok(cat.tasks.includes('anim'));
  assert.equal((await call('GET', `/api/projects/${inside.id}`)).status, 404);

  // a project is not deleted, and one with a catalogue stays a project
  assert.equal((await call('DELETE', `/api/folders/${kilo.id}`)).status, 409);
  assert.equal((await call('PATCH', `/api/folders/${kilo.id}`, { project: false })).status, 409);
  assert.equal((await call('PATCH', `/api/folders/${other.id}`, { project: false })).status, 200);
  assert.equal((await call('DELETE', `/api/folders/${inside.id}`)).status, 200);
});

test('media filed as a version takes its notes along, and they show on every board the version is on', async (t) => {
  const s = start(4837);
  t.after(s.stop);
  await s.ready;
  const json = { 'content-type': 'application/json' };
  const call = async (method, url, body) => {
    const res = await fetch(s.base + url, { method, headers: json, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const project = (await call('POST', '/api/folders', { name: 'Kilo' })).body;
  await call('PATCH', `/api/folders/${project.id}`, { project: true });
  const standup = (await call('POST', '/api/boards', { name: 'Standup', folderId: project.id })).body;
  const client = (await call('POST', '/api/boards', { name: 'Client call', folderId: project.id })).body;
  const loose = (await call('POST', '/api/boards', { name: 'Elsewhere' })).body;
  const up = async (name) => (await (await fetch(`${s.base}/api/upload?name=${name}`, { method: 'POST', body: crypto.randomBytes(400) })).json()).url;
  const shotA = await up('a.png');
  const shotB = await up('b.png');

  const open = joiner(4837);
  const anna = await open(`board=${standup.id}`, 'Anna');
  t.after(() => anna.ws.close());
  const ops = (conn, list) => conn.ws.send(JSON.stringify({ t: 'op', ops: list }));
  const at = { x: 0, y: 0, w: 100, h: 100 };
  ops(anna, [
    { t: 'add', item: { id: 'imageone1', type: 'image', ...at, src: shotA, name: 'screenshoot_090126.png', nw: 1920, nh: 1080 } },
    { t: 'add', item: { id: 'comment01', type: 'comment', on: 'imageone1', text: 'Darker sky' } },
  ]);
  await pause(200);
  ops(anna, [{ t: 'add', item: { id: 'comment02', type: 'comment', on: 'imageone1', re: 'comment01', text: 'Agreed' } }]);
  await pause(200);

  // filed under a shot made on the way, with a task: the first version of it
  const filed = await call('POST', `/api/projects/${project.id}/versions`, { entity: { name: 'kilo-0010' }, task: 'anim', files: [{ board: standup.id, item: 'imageone1' }] });
  assert.equal(filed.status, 201);
  const v1 = filed.body.versions[0];
  assert.equal(v1.label, 'kilo-0010 anim v1');
  assert.equal(v1.look.src, shotA);
  await pause(200);
  // everybody on the board is told the piece is that version now, and what it is called
  const set = anna.seen.filter((m) => m.t === 'op').flatMap((m) => m.ops).find((o) => o.t === 'set' && o.id === 'imageone1');
  assert.deepEqual(set.patch, { ver: v1.id });
  assert.equal(anna.seen.filter((m) => m.t === 'versions').pop().list[0].label, 'kilo-0010 anim v1');
  // a piece is filed once; a board outside the project cannot file into it
  assert.equal((await call('POST', `/api/projects/${project.id}/versions`, { entity: v1.entityId, files: [{ board: standup.id, item: 'imageone1' }] })).status, 409);
  assert.equal((await call('POST', `/api/projects/${project.id}/versions`, { entity: v1.entityId, files: [{ board: loose.id, item: 'x' }] })).status, 400);

  // the version on another board brings what was said about it, saying where it was said
  const ben = await open(`board=${client.id}`, 'Ben');
  t.after(() => ben.ws.close());
  ops(ben, [{ t: 'add', item: { id: 'placed001', type: 'image', ...at, src: shotA, ver: v1.id } }]);
  await pause(250);
  const brought = ben.seen.filter((m) => m.t === 'op').flatMap((m) => m.ops).filter((o) => o.t === 'add' && o.item.type === 'comment').map((o) => o.item);
  assert.deepEqual(brought.map((c) => [c.id, c.on, c.ob, c.obn]), [['comment01', 'placed001', standup.id, 'Standup'], ['comment02', 'placed001', standup.id, 'Standup']]);
  assert.equal(ben.seen.filter((m) => m.t === 'versions').pop().list[0].label, 'kilo-0010 anim v1');
  // a note made there is on the standup board too, live
  ops(ben, [{ t: 'add', item: { id: 'comment03', type: 'comment', on: 'placed001', text: 'Client likes it' } }]);
  await pause(250);
  const arrived = anna.seen.filter((m) => m.t === 'op').flatMap((m) => m.ops).find((o) => o.t === 'add' && o.item.id === 'comment03');
  assert.equal(arrived.item.on, 'imageone1');
  assert.equal(arrived.item.ob, client.id);
  assert.equal(arrived.item.name, 'Ben');

  // a link to the client board shows only what was said on it
  const { token } = (await call('POST', `/api/boards/${client.id}/share`, { access: 'comments' })).body;
  await call('PATCH', `/api/boards/${client.id}/share`, { access: 'comments' });
  const eve = await open(`share=${token}`, 'Eve');
  t.after(() => eve.ws.close());
  assert.deepEqual(eve.seen.find((m) => m.t === 'init').items.filter((it) => it.type === 'comment').map((c) => c.id), ['comment03']);

  // taking the version off the client board leaves its notes alone; the standup board still has them all
  ops(ben, [{ t: 'del', ids: ['placed001', 'comment01', 'comment02', 'comment03'] }]);
  await pause(250);
  const later = await open(`board=${standup.id}`, 'Cara');
  t.after(() => later.ws.close());
  assert.deepEqual(later.seen.find((m) => m.t === 'init').items.filter((it) => it.type === 'comment').map((c) => c.id).sort(), ['comment01', 'comment02', 'comment03']);
  // deleting a thread is deleting it, everywhere; undo brings it back as it was written
  ops(anna, [{ t: 'del', ids: ['comment01', 'comment02'] }]);
  await pause(200);
  const entity = (await call('GET', `/api/entities/${v1.entityId}`)).body;
  assert.deepEqual(entity.notes.map((n) => n.id), ['comment03']);
  ops(anna, [{ t: 'add', item: { id: 'comment01', type: 'comment', on: 'imageone1', text: 'Tampered', name: 'Mallory' } }]);
  await pause(200);
  const back = (await call('GET', `/api/entities/${v1.entityId}`)).body.notes.find((n) => n.id === 'comment01');
  assert.equal(back.text, 'Darker sky');
  assert.equal(back.name, 'Anna');
  assert.equal(back.board.name, 'Standup');

  // more versions of the shot and task count on, each told to the boards showing an older one
  ops(anna, [{ t: 'add', item: { id: 'imagetwo1', type: 'image', ...at, src: shotB, name: 'kilo-0010_anim_erik_v012.png' } }]);
  await pause(200);
  const v2 = (await call('POST', `/api/projects/${project.id}/versions`, { files: [{ board: standup.id, item: 'imagetwo1' }] })).body.versions[0];
  assert.equal(v2.label, 'kilo-0010 anim v2');
  // the v012 in its name is not shown anywhere: the catalogue's own number is the one
  assert.equal(v2.hip, undefined);
  assert.equal(v2.artist, 'erik');
  assert.equal(v2.entityId, v1.entityId);
  await pause(200);
  const told = anna.seen.filter((m) => m.t === 'versions').pop().list.find((v) => v.id === v1.id);
  assert.deepEqual(told.newest, { id: v2.id, number: 2 });
  // hidden, it no longer counts as the newest
  await call('PATCH', `/api/versions/${v2.id}`, { hidden: true });
  await pause(150);
  assert.equal(anna.seen.filter((m) => m.t === 'versions').pop().list.find((v) => v.id === v1.id).newest, null);
  const lighting = (await call('POST', `/api/projects/${project.id}/versions`, { task: 'lighting', entity: v1.entityId, files: [{ look: { type: 'video', src: shotB, name: 'x.mp4', wf: { c: 'AAEC', p: 'AwQF', junk: 1 }, fps: 24 } }] })).body.versions[0];
  assert.equal(lighting.label, 'kilo-0010 lighting v1');
  // a video keeps its timeline strip and frame rate, whatever it came with besides
  assert.deepEqual(lighting.look.wf, { c: 'AAEC', p: 'AwQF' });
  assert.equal(lighting.look.fps, 24);
  assert.equal((await call('POST', `/api/projects/${project.id}/versions`, { entity: v1.entityId, files: [{ look: { type: 'image', src: '/uploads/nothere.png' } }] })).status, 400);

  // the entity lists every version, where each is, and what was said
  const page = (await call('GET', `/api/entities/${v1.entityId}`)).body;
  assert.deepEqual(page.versions.map((v) => v.label).sort(), ['kilo-0010 anim v1', 'kilo-0010 anim v2', 'kilo-0010 lighting v1']);
  assert.deepEqual(page.versions.find((v) => v.id === v1.id).boards.map((b) => b.name), ['Standup']);
});

test('putting a board back moves what is on it, never what was said', async (t) => {
  const s = start(4838, { WIPBOARD_SNAPSHOT_MS: '200' });
  t.after(s.stop);
  await s.ready;
  const json = { 'content-type': 'application/json' };
  const board = await (await fetch(`${s.base}/api/boards`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'Layout' }) })).json();
  const open = joiner(4838);
  const anna = await open(`board=${board.id}`, 'Anna');
  t.after(() => anna.ws.close());
  const ops = (list) => anna.ws.send(JSON.stringify({ t: 'op', ops: list }));
  ops([{ t: 'add', item: { id: 'imageone1', type: 'image', x: 0, y: 0, w: 100, h: 100, src: '/x.png' } }]);
  await pause(300);
  ops([{ t: 'set', id: 'imageone1', patch: { x: 50 } }]);
  await pause(100);
  ops([{ t: 'add', item: { id: 'comment01', type: 'comment', on: 'imageone1', text: 'Keep me' } }]);
  await pause(150);
  const kept = (await (await fetch(`${s.base}/api/boards/${board.id}/activity`)).json()).snapshots;
  assert.equal(kept.length, 1);
  await fetch(`${s.base}/api/boards/${board.id}/snapshots/${kept[0].at}/restore`, { method: 'POST', headers: json, body: '{}' });
  await pause(150);
  const init = anna.seen.filter((m) => m.t === 'init').pop();
  assert.deepEqual(init.items.map((it) => [it.id, it.x ?? null]), [['imageone1', 0], ['comment01', null]]);
});

test('the catalogue viewer has every note on an entity live, and what is written there reaches the boards', async (t) => {
  const s = start(4839);
  t.after(s.stop);
  await s.ready;
  const json = { 'content-type': 'application/json' };
  const call = async (method, url, body) => (await fetch(s.base + url, { method, headers: json, body: body && JSON.stringify(body) })).json();
  const project = await call('POST', '/api/folders', { name: 'Kilo' });
  await call('PATCH', `/api/folders/${project.id}`, { project: true });
  const board = await call('POST', '/api/boards', { name: 'Standup', folderId: project.id });
  const src = (await (await fetch(`${s.base}/api/upload?name=a.png`, { method: 'POST', body: crypto.randomBytes(300) })).json()).url;
  const [v1] = (await call('POST', `/api/projects/${project.id}/versions`, { entity: { name: 'kilo-0010' }, files: [{ look: { type: 'image', src, nw: 100, nh: 50 } }] })).versions;

  const open = joiner(4839);
  const anna = await open(`board=${board.id}`, 'Anna');
  t.after(() => anna.ws.close());
  anna.ws.send(JSON.stringify({ t: 'op', ops: [{ t: 'add', item: { id: 'placed001', type: 'image', x: 0, y: 0, w: 100, h: 50, src, ver: v1.id } }] }));
  await pause(200);
  const ben = await open(`entity=${v1.entityId}`, 'Ben');
  t.after(() => ben.ws.close());
  assert.deepEqual(ben.seen.find((m) => m.t === 'init').notes, []);

  // written in the catalogue, with a drawing: on the board at once, saying where it was said
  const drawing = [{ x: 10, y: 10, w: 100, h: 50, pts: [0, 0, 1, 1], ws: [0.5, 0.5], size: 4, color: '#2f7df6', junk: 1 }];
  ben.ws.send(JSON.stringify({ t: 'op', ops: [{ t: 'add', item: { id: 'catnote01', type: 'comment', on: v1.id, text: 'From the catalogue', drawing } }] }));
  await pause(250);
  const there = anna.seen.filter((m) => m.t === 'op').flatMap((m) => m.ops).find((o) => o.t === 'add' && o.item.id === 'catnote01').item;
  assert.equal(there.on, 'placed001');
  assert.equal(there.name, 'Ben');
  assert.equal(there.obn, 'the catalogue');
  assert.deepEqual(there.drawing, [{ x: 10, y: 10, w: 100, h: 50, pts: [0, 0, 1, 1], size: 4, color: '#2f7df6', ws: [0.5, 0.5] }]);
  // a reply on the board reaches the room
  anna.ws.send(JSON.stringify({ t: 'op', ops: [{ t: 'add', item: { id: 'reply0001', type: 'comment', on: 'placed001', re: 'catnote01', text: 'Agreed' } }] }));
  await pause(250);
  const told = ben.seen.filter((m) => m.t === 'notes').pop().notes;
  assert.deepEqual(told.map((n) => [n.id, n.on, n.obn]), [['catnote01', v1.id, 'the catalogue'], ['reply0001', v1.id, 'Standup']]);
  // resolved and deleted from the room, as on a board; nothing outside the entity is touched
  ben.ws.send(JSON.stringify({ t: 'op', ops: [{ t: 'set', id: 'catnote01', patch: { done: true, text: 'Reworded', name: 'X' } }] }));
  await pause(200);
  const resolved = anna.seen.filter((m) => m.t === 'op').flatMap((m) => m.ops).filter((o) => o.t === 'add' && o.item.id === 'catnote01').pop().item;
  assert.equal(resolved.done, true);
  assert.equal(resolved.text, 'Reworded');
  assert.ok(resolved.edited > 0);
  assert.equal(resolved.name, 'Ben');
  ben.ws.send(JSON.stringify({ t: 'op', ops: [{ t: 'del', ids: ['catnote01', 'reply0001'] }] }));
  await pause(250);
  assert.ok(anna.seen.filter((m) => m.t === 'op').flatMap((m) => m.ops).some((o) => o.t === 'del' && o.ids.includes('catnote01')));
  assert.deepEqual(ben.seen.filter((m) => m.t === 'notes').pop().notes, []);
});

test('a version can be filed as something else, archived, and deleted once no board shows it', async (t) => {
  const s = start(4840);
  t.after(s.stop);
  await s.ready;
  const json = { 'content-type': 'application/json' };
  const call = async (method, url, body) => {
    const res = await fetch(s.base + url, { method, headers: json, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const project = (await call('POST', '/api/folders', { name: 'Kilo' })).body;
  await call('PATCH', `/api/folders/${project.id}`, { project: true });
  const board = (await call('POST', '/api/boards', { name: 'Standup', folderId: project.id })).body;
  const up = async (name) => (await (await fetch(`${s.base}/api/upload?name=${name}`, { method: 'POST', body: crypto.randomBytes(400) })).json()).url;
  const file = async (name, extra) => (await call('POST', `/api/projects/${project.id}/versions`, { ...extra, files: [{ look: { type: 'image', src: await up('a.png'), name } }] })).body.versions[0];
  const v1 = await file('kilo-0010_anim_erik_v003.png');
  const v2 = await file('kilo-0010_anim_erik_v004.png');
  assert.deepEqual([v1.label, v2.label], ['kilo-0010 anim v1', 'kilo-0010 anim v2']);

  const open = joiner(4840);
  const anna = await open(`board=${board.id}`, 'Anna');
  t.after(() => anna.ws.close());
  const ops = (list) => anna.ws.send(JSON.stringify({ t: 'op', ops: list }));
  ops([
    { t: 'add', item: { id: 'placed001', type: 'image', x: 0, y: 0, w: 100, h: 100, src: v2.look.src, ver: v2.id } },
    { t: 'add', item: { id: 'comment01', type: 'comment', on: 'placed001', text: 'Darker' } },
  ]);
  await pause(250);

  // filed as another shot and task: its name, and the board's chip, follow; its notes go with it
  const moved = await call('PATCH', `/api/versions/${v2.id}`, { entity: { name: 'kilo-0020' }, task: 'comp', artist: 'ben' });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.label, 'kilo-0020 comp v1');
  assert.equal(moved.body.artist, 'ben');
  await pause(150);
  assert.equal(anna.seen.filter((m) => m.t === 'versions').pop().list.find((v) => v.id === v2.id).label, 'kilo-0020 comp v1');
  assert.deepEqual((await call('GET', `/api/entities/${moved.body.entityId}`)).body.notes.map((n) => n.text), ['Darker']);
  // a number some other version has is refused
  const v3 = await file('x.png', { entity: { name: 'kilo-0020' }, task: 'comp' });
  assert.equal(v3.label, 'kilo-0020 comp v2');
  const clash = await call('PATCH', `/api/versions/${v3.id}`, { number: 1 });
  assert.equal(clash.status, 409);
  assert.match(clash.body.error, /kilo-0020 comp v1 already/);
  assert.equal((await call('PATCH', `/api/versions/${v3.id}`, { number: 0 })).status, 400);
  assert.equal((await call('PATCH', `/api/versions/${v3.id}`, { number: 7 })).body.label, 'kilo-0020 comp v7');

  // archived, it is still listed (marked) but no longer the newest
  await call('PATCH', `/api/versions/${v3.id}`, { hidden: true });
  assert.equal((await call('GET', `/api/entities/${v3.entityId}`)).body.versions.find((v) => v.id === v3.id).hidden, true);

  // a version on a board is not deleted: it says which board
  const refused = await call('DELETE', `/api/versions/${v2.id}`);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /“Standup”/);
  // one on no board is; it is gone from the catalogue, its number is not given out again, and it can be brought back
  assert.equal((await call('DELETE', `/api/versions/${v3.id}`)).status, 200);
  assert.deepEqual((await call('GET', `/api/entities/${v3.entityId}`)).body.versions.map((v) => v.id), [v2.id]);
  assert.equal((await call('GET', `/api/versions/${v3.id}`)).status, 404);
  assert.match((await call('PATCH', `/api/versions/${v2.id}`, { number: 7 })).body.error, /deleted/);
  assert.equal((await file('y.png', { entity: { name: 'kilo-0020' }, task: 'comp' })).label, 'kilo-0020 comp v8');
  assert.equal((await call('PATCH', `/api/versions/${v3.id}`, { hidden: false })).status, 404);
  const back = await call('PATCH', `/api/versions/${v3.id}`, { deleted: false });
  assert.equal(back.body.label, 'kilo-0020 comp v7');
  // a board cannot put a deleted version back by naming it
  await call('DELETE', `/api/versions/${v3.id}`);
  ops([{ t: 'add', item: { id: 'placed002', type: 'image', x: 0, y: 0, w: 100, h: 100, src: v2.look.src, ver: v3.id } }]);
  await pause(200);
  const ben = await open(`board=${board.id}`, 'Ben');
  t.after(() => ben.ws.close());
  const added = ben.seen.find((m) => m.t === 'init').items.find((it) => it.id === 'placed002');
  assert.equal(added.type, 'image');
  assert.equal(added.ver, undefined);
});

test('a project is set up with its assets, sets and shots ahead, each with artists and people cc\'d', async (t) => {
  const s = start(4841);
  t.after(s.stop);
  await s.ready;
  const json = { 'content-type': 'application/json' };
  const call = async (method, url, body) => {
    const res = await fetch(s.base + url, { method, headers: json, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const project = (await call('POST', '/api/folders', { name: 'Kilo' })).body;
  await call('PATCH', `/api/folders/${project.id}`, { project: true });

  // many at once: a shot by its shape, anything else an asset unless said; one the project has is left alone
  const setUp = await call('POST', `/api/projects/${project.id}/entities`, { names: ['kilo-0010', 'Kilo-0020 ', 'char-robot', 'kilo-0010', ''] });
  assert.equal(setUp.status, 201);
  assert.deepEqual(setUp.body.made.map((e) => [e.name, e.tier]), [['kilo-0010', 'shot'], ['kilo-0020', 'shot'], ['char-robot', 'asset']]);
  await call('POST', `/api/projects/${project.id}/entities`, { names: ['set-harbour'], tier: 'set' });
  // A new name is what the project's names starting the same way are.
  const guessed = (await call('POST', `/api/projects/${project.id}/entities`, { names: ['set-street', 'char-dog'] })).body;
  assert.deepEqual(guessed.made.map((e) => [e.name, e.tier]), [['set-street', 'set'], ['char-dog', 'asset']]);
  const again = (await call('POST', `/api/projects/${project.id}/entities`, { names: ['kilo-0010', 'mystery'], tier: 'asset' })).body;
  assert.deepEqual([again.had, again.made.map((e) => [e.name, e.tier])], [['kilo-0010'], [['mystery', 'asset']]]);
  const cat = (await call('GET', `/api/projects/${project.id}`)).body;
  assert.equal(cat.entities.length, 7);
  assert.ok(cat.entities.every((e) => e.versions === 0));

  // artists and cc
  const shot = setUp.body.made[0];
  const set = await call('PATCH', `/api/entities/${shot.id}`, { artists: ['Erik', 'Erik', ' '], cc: ['Anna'] });
  assert.deepEqual([set.body.artists, set.body.cc], [['Erik'], ['Anna']]);
  assert.equal((await call('PATCH', `/api/entities/${shot.id}`, { name: 'kilo-0020' })).status, 409);
  assert.equal((await call('PATCH', `/api/entities/${shot.id}`, { tier: 'planet' })).status, 400);
  assert.deepEqual((await call('GET', '/api/people')).body.people, ['Anna', 'Erik']);
});

test('a project\'s timeline is every shot in order with its newest version, and a card knows its newest', async (t) => {
  const s = start(4842);
  t.after(s.stop);
  await s.ready;
  const json = { 'content-type': 'application/json' };
  const call = async (method, url, body) => {
    const res = await fetch(s.base + url, { method, headers: json, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const project = (await call('POST', '/api/folders', { name: 'Kilo' })).body;
  await call('PATCH', `/api/folders/${project.id}`, { project: true });
  await call('POST', `/api/projects/${project.id}/entities`, { names: ['kilo-0100', 'kilo-0020', 'kilo-0010', 'abc-0010', 'char-robot'] });
  const up = async () => (await (await fetch(`${s.base}/api/upload?name=a.mp4`, { method: 'POST', body: crypto.randomBytes(300) })).json()).url;
  const file = async (name, task, dur) => (await call('POST', `/api/projects/${project.id}/versions`, { entity: { name }, task, files: [{ look: { type: 'video', src: await up(), name: 'x.mp4', dur } }] })).body.versions[0];
  await file('kilo-0010', 'anim', 4);
  const comp = await file('kilo-0010', 'comp', 5);
  await file('kilo-0020', 'anim', 3);

  const tl = (await call('GET', `/api/projects/${project.id}/timeline`)).body;
  // shots only, by sequence and number (0100 after 0020), each with its newest version of any task
  assert.deepEqual(tl.shots.map((x) => [x.name, x.seq, x.version && x.version.label]), [['abc-0010', 'abc', null], ['kilo-0010', 'kilo', 'kilo-0010 comp v1'], ['kilo-0020', 'kilo', 'kilo-0020 anim v1'], ['kilo-0100', 'kilo', null]]);
  assert.equal(tl.shots[1].version.look.dur, 5);
  assert.deepEqual(tl.tasks, ['anim', 'comp']);
  const anim = (await call('GET', `/api/projects/${project.id}/timeline?task=anim`)).body;
  assert.deepEqual(anim.shots.map((x) => x.version && x.version.label), [null, 'kilo-0010 anim v1', 'kilo-0020 anim v1', null]);
  // the catalogue's cards carry their newest version, to scrub and to play
  const cat = (await call('GET', `/api/projects/${project.id}`)).body;
  const k10 = cat.entities.find((e) => e.name === 'kilo-0010');
  assert.equal(k10.newest.id, comp.id);
  assert.equal(k10.newest.look.type, 'video');
  assert.equal(cat.entities.find((e) => e.name === 'char-robot').newest, null);
  // the project's home: what was filed in it lately, newest first
  const act = (await call('GET', `/api/projects/${project.id}/activity`)).body;
  assert.deepEqual(act.items.map((x) => [x.kind, x.version.label, x.entity.project]), [['version', 'kilo-0020 anim v1', 'Kilo'], ['version', 'kilo-0010 comp v1', 'Kilo'], ['version', 'kilo-0010 anim v1', 'Kilo']]);
});

test('a file brought in can ask for its version number, and the catalogue says what the next one is', async (t) => {
  const s = start(4843);
  t.after(s.stop);
  await s.ready;
  const json = { 'content-type': 'application/json' };
  const call = async (method, url, body) => {
    const res = await fetch(s.base + url, { method, headers: json, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const project = (await call('POST', '/api/folders', { name: 'Kilo' })).body;
  await call('PATCH', `/api/folders/${project.id}`, { project: true });
  const up = async () => (await (await fetch(`${s.base}/api/upload?name=a.png`, { method: 'POST', body: crypto.randomBytes(300) })).json()).url;
  const file = async (task, number) => call('POST', `/api/projects/${project.id}/versions`, { entity: { name: 'kilo-0010' }, files: [{ task, number, look: { type: 'image', src: await up(), name: 'a.png' } }] });
  assert.equal((await file('anim')).body.versions[0].label, 'kilo-0010 anim v1');
  assert.equal((await file('anim', 7)).body.versions[0].label, 'kilo-0010 anim v7');
  assert.equal((await file('anim')).body.versions[0].label, 'kilo-0010 anim v8');
  const clash = await file('anim', 7);
  assert.equal(clash.status, 409);
  assert.match(clash.body.error, /kilo-0010 anim v7 already/);
  assert.equal((await file('anim', 0)).status, 400);
  assert.equal((await file(null, 3)).body.versions[0].label, 'kilo-0010 v3');
  const e = (await call('GET', `/api/projects/${project.id}`)).body.entities[0];
  assert.deepEqual(e.tops, { anim: 8, '': 3 });
});

test('a project can count without tasks, learn how names from elsewhere read, and take a filing straight back', async (t) => {
  const s = start(4860);
  t.after(s.stop);
  await s.ready;
  const json = { 'content-type': 'application/json' };
  const call = async (method, url, body) => {
    const res = await fetch(s.base + url, { method, headers: json, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const project = (await call('POST', '/api/folders', { name: 'Kilo' })).body;
  await call('PATCH', `/api/folders/${project.id}`, { project: true });
  const up = async (name) => (await (await fetch(`${s.base}/api/upload?name=${name}`, { method: 'POST', body: crypto.randomBytes(300) })).json()).url;
  const file = async (name, task, extra = {}) => call('POST', `/api/projects/${project.id}/versions`, { entity: { name }, files: [{ task, look: { type: 'image', src: await up('a.png'), name: 'kilo-0010_anim_v3.png' }, ...extra }] });

  // Without tasks, a task asked for (or read from the file's name) is not counted by.
  const off = await call('PATCH', `/api/folders/${project.id}`, { settings: { tasks: false, rules: [{ word: 'klo', seq: 'kilo' }, { word: 'Bad Word', seq: 'x' }, { word: 'robot', name: 'char-robot' }, { word: 'x', seq: 'not a token!' }] } });
  assert.equal(off.status, 200);
  let settings = (await call('GET', `/api/projects/${project.id}`)).body.project.settings;
  assert.equal(settings.tasks, false);
  assert.deepEqual(settings.rules, [{ word: 'klo', seq: 'kilo' }, { word: 'robot', name: 'char-robot' }]);
  assert.equal((await file('kilo-0010', 'anim')).body.versions[0].label, 'kilo-0010 v1');
  assert.equal((await file('kilo-0010')).body.versions[0].label, 'kilo-0010 v2');
  // Turned on again, a task counts from v1, and the catalogue says each task's newest.
  await call('PATCH', `/api/folders/${project.id}`, { settings: { tasks: true } });
  settings = (await call('GET', `/api/projects/${project.id}`)).body.project.settings;
  assert.equal(settings.tasks, undefined);
  assert.deepEqual(settings.rules.map((r) => r.word), ['klo', 'robot']);
  const anim = (await file('kilo-0010', 'anim')).body.versions[0];
  assert.equal(anim.label, 'kilo-0010 anim v1');
  let e = (await call('GET', `/api/projects/${project.id}`)).body.entities[0];
  assert.deepEqual(Object.keys(e.heads).sort(), ['', 'anim']);
  assert.equal(e.heads[''].number, 2);
  assert.equal(e.heads.anim.id, anim.id);
  // A whole name's pattern is kept as it is, with what was learned it renames; one with no sequence and
  // shot in it, or a word that is not one, is not.
  const nh = { pattern: ['nhmoc', '{seq}', '{shot}', '{view}', '{version}'], like: 'NHMoc_CHAP01_010_cmp_v111', as: 'chap01-0010 v111' };
  await call('PATCH', `/api/folders/${project.id}`, { settings: { rules: [
    nh, { pattern: ['{seq}', '{shot}', '*'], seqs: { klo: 'kilo', 'Bad!': 'x' } },
    { pattern: ['nhmoc', '{version}'] }, { pattern: ['NH MOC', '{seq}', '{shot}'] }, { pattern: ['{seq}', '{shot}', '{nonsense}'] },
  ] } });
  assert.deepEqual((await call('GET', `/api/projects/${project.id}`)).body.project.settings.rules, [
    nh, { pattern: ['{seq}', '{shot}', '*'], seqs: { klo: 'kilo' }, like: '', as: '' },
  ]);
  // Two learned one after the other while filing one batch are both kept, each added to what is there by then;
  // one it has already is not kept twice.
  const ranged = { pattern: ['psh26', '{seq}', '{shot}', '*', '{version}', '*', '*'], like: 'PSH26_HAUS_0110_vr_v500.[00000-00299]', as: 'haus-0110 v500' };
  const plain = { pattern: ['psh26', '{seq}', '{shot}', '*', '{version}'], like: 'PSH26_HAUS_0090_vr_v100', as: 'haus-0090 v100' };
  await call('PATCH', `/api/folders/${project.id}`, { settings: { addRules: [ranged] } });
  await call('PATCH', `/api/folders/${project.id}`, { settings: { addRules: [plain, nh] } });
  assert.deepEqual((await call('GET', `/api/projects/${project.id}`)).body.project.settings.rules.map((r) => r.like),
    ['NHMoc_CHAP01_010_cmp_v111', '', 'PSH26_HAUS_0110_vr_v500.[00000-00299]', 'PSH26_HAUS_0090_vr_v100']);
  // An empty list forgets them all.
  await call('PATCH', `/api/folders/${project.id}`, { settings: { rules: [] } });
  assert.equal((await call('GET', `/api/projects/${project.id}`)).body.project.settings.rules, undefined);

  // Taken back straight after: gone, number and all, and so is a shot made for it.
  const made = (await file('kilo-0020', 'anim')).body.versions[0];
  assert.equal((await call('POST', `/api/versions/${made.id}/unfile`, {})).body.entityDropped, true);
  assert.equal((await call('GET', `/api/versions/${made.id}`)).status, 404);
  e = (await call('GET', `/api/projects/${project.id}`)).body.entities;
  assert.deepEqual(e.map((x) => x.name), ['kilo-0010']);
  const again = (await file('kilo-0010', 'anim')).body.versions[0];
  assert.equal(again.label, 'kilo-0010 anim v2');
  assert.equal((await call('POST', `/api/versions/${again.id}/unfile`, {})).body.entityDropped, false);
  assert.equal((await file('kilo-0010', 'anim')).body.versions[0].label, 'kilo-0010 anim v2');
  // Not one that has been talked about since.
  const talked = (await file('kilo-0010', 'anim')).body.versions[0];
  const open = joiner(4860);
  const room = await open(`entity=${talked.entityId}`, 'Anna');
  t.after(() => room.ws.close());
  room.ws.send(JSON.stringify({ t: 'op', ops: [{ t: 'add', item: { id: 'note00001', type: 'comment', on: talked.id, text: 'Nice' } }] }));
  await pause(300);
  const refused = await call('POST', `/api/versions/${talked.id}/unfile`, {});
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /Something has been said about kilo-0010 anim v3/);

  // What a video looks like a new version of, by its length and picture.
  const strip = Buffer.from(Array.from({ length: 512 * 6 }, (_, i) => Math.round(128 + 100 * Math.sin(Math.floor(i / 6) / 9)))).toString('base64');
  const video = (await call('POST', `/api/projects/${project.id}/versions`, { entity: { name: 'kilo-0030' }, files: [{ task: 'anim', look: { type: 'video', src: await up('a.mp4'), name: 'a.mp4', dur: 5, fps: 24, nw: 640, nh: 360, wf: { c: strip } } }] })).body.versions[0];
  const like = await call('POST', `/api/projects/${project.id}/likely`, { looks: [
    { key: 'same', type: 'video', dur: 5, fps: 24, nw: 640, nh: 360, wf: strip },
    { key: 'longer', type: 'video', dur: 30, fps: 25, nw: 1920, nh: 1080 },
    { key: 'still', type: 'image', nw: 640, nh: 360 },
  ] });
  assert.equal(like.status, 200);
  assert.deepEqual(like.body.answers.same.map((a) => [a.entity, a.task, a.number]), [['kilo-0030', 'anim', video.number]]);
  assert.deepEqual(like.body.answers.same[0].why, ['same length', 'looks alike']);
  assert.deepEqual(like.body.answers.longer, []);
  assert.deepEqual(like.body.answers.still, []);
});

test('a version can be shown more than one way: each view is filed with it, by name, and none twice', async (t) => {
  const s = start(4898);
  t.after(s.stop);
  await s.ready;
  const json = { 'content-type': 'application/json' };
  const call = async (method, url, body) => {
    const res = await fetch(s.base + url, { method, headers: json, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const project = (await call('POST', '/api/folders', { name: 'Kilo' })).body;
  await call('PATCH', `/api/folders/${project.id}`, { project: true });
  const up = async () => (await (await fetch(`${s.base}/api/upload?name=a.mp4`, { method: 'POST', body: crypto.randomBytes(300) })).json()).url;
  const file = async (files) => call('POST', `/api/projects/${project.id}/versions`, { entity: { name: 'kilo-0010' }, task: 'comp', files });
  const look = async (name) => ({ type: 'video', src: await up(), name, dur: 4 });
  // Shown one way (as every project starts), a view asked for is no view: each file is a version. Nor is
  // one its look carries of its own (a piece copied from a view, say), nor views it says it has.
  assert.equal((await call('GET', `/api/projects/${project.id}`)).body.viewList, null);
  const plain = (await file([{ view: 'bty', look: await look('z_bty.mp4') }])).body.versions[0];
  assert.equal(plain.label, 'kilo-0010 comp v1');
  assert.equal(plain.look.view, undefined);
  const carried = (await file([{ look: { ...(await look('y.mp4')), view: 'bty', views: [{ ...(await look('x.mp4')), view: 'top' }] } }])).body.versions[0];
  assert.equal(carried.label, 'kilo-0010 comp v2');
  assert.equal(carried.look.view, undefined);
  assert.equal(carried.look.views, undefined);
  await call('POST', `/api/versions/${carried.id}/unfile`, {});
  // Its views named, the main one first: a file of the main one is a version of its own.
  await call('PATCH', `/api/folders/${project.id}`, { settings: { views: ['CMP', 'bty', 'top', 'bty'] } });
  assert.deepEqual((await call('GET', `/api/projects/${project.id}`)).body.viewList, ['cmp', 'bty', 'top']);
  const cmp = (await file([{ view: 'cmp', look: await look('a_cmp.mp4') }])).body.versions[0];
  assert.equal(cmp.label, 'kilo-0010 comp v2');
  assert.equal(cmp.look.view, undefined);
  // A bty of the same number goes with it rather than being refused.
  const bty = (await file([{ view: 'bty', number: 2, look: await look('a_bty.mp4') }])).body.versions[0];
  assert.equal(bty.id, cmp.id);
  assert.equal(bty.filedView, 'bty');
  assert.deepEqual(bty.look.views.map((v) => v.view), ['bty']);
  // A view it has already, a number taken without saying a view, or a view the project has not got, is refused.
  assert.equal((await file([{ view: 'BTY', number: 2, look: await look('b.mp4') }])).status, 409);
  assert.equal((await file([{ number: 2, look: await look('c.mp4') }])).status, 409);
  const odd = await file([{ view: 'side', look: await look('s.mp4') }]);
  assert.equal(odd.status, 400);
  assert.match(odd.body.error, /“side” is not one of this project's views \(cmp, bty, top\)/);
  // A view with no number goes with the newest version that lacks it.
  const top = (await file([{ view: 'top', look: await look('d.mp4') }])).body.versions[0];
  assert.equal(top.id, cmp.id);
  // The main one and a view of a new version brought in together: one version, two ways.
  const two = (await file([{ view: 'cmp', number: 3, look: await look('e.mp4') }, { view: 'bty', number: 3, look: await look('f.mp4') }])).body.versions;
  assert.equal(two[0].id, two[1].id);
  assert.deepEqual(two[1].look.views.map((v) => v.view), ['bty']);
  // The timeline and the catalogue carry the views, and the project knows their names.
  const tl = (await call('GET', `/api/projects/${project.id}/timeline`)).body;
  assert.deepEqual(tl.views, ['bty', 'top']);
  assert.equal(tl.shots[0].version.look.view, undefined);
  assert.deepEqual(tl.shots[0].version.look.views.map((v) => v.view), ['bty']);
  // Shown one way again: views filed stay, and none is filed.
  await call('PATCH', `/api/folders/${project.id}`, { settings: { views: false } });
  assert.equal((await call('GET', `/api/projects/${project.id}`)).body.viewList, null);
  assert.equal((await file([{ view: 'bty', look: await look('g.mp4') }])).body.versions[0].label, 'kilo-0010 comp v4');
});

test('a version can have extras: more files under labels of their own, added to the version, and taken back', async (t) => {
  const s = start(4901);
  t.after(s.stop);
  await s.ready;
  const json = { 'content-type': 'application/json' };
  const call = async (method, url, body) => {
    const res = await fetch(s.base + url, { method, headers: json, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const project = (await call('POST', '/api/folders', { name: 'Kilo' })).body;
  await call('PATCH', `/api/folders/${project.id}`, { project: true });
  const up = async () => (await (await fetch(`${s.base}/api/upload?name=a.png`, { method: 'POST', body: crypto.randomBytes(300) })).json()).url;
  const file = async (files) => call('POST', `/api/projects/${project.id}/versions`, { entity: { name: 'kilo-0010' }, task: 'comp', files });
  const still = async (name) => ({ type: 'image', src: await up(), name, nw: 12288, nh: 6144 });
  // Nothing to add it to yet: refused, and nothing is filed.
  const none = await file([{ extra: 'light-a', look: await still('a.png') }]);
  assert.equal(none.status, 409);
  assert.match(none.body.error, /kilo-0010 comp has no version to add “light-a” to/);
  // A version and its extras brought in together: one version, its own file and two more.
  const lot = (await file([{ look: { type: 'video', src: await up(), name: 'v.mp4', dur: 4 } }, { extra: 'Light A', look: await still('a.png') }, { extra: 'light-b', look: await still('b.png') }])).body.versions;
  assert.equal(lot[0].label, 'kilo-0010 comp v1');
  assert.deepEqual(lot.map((v) => v.id), [lot[0].id, lot[0].id, lot[0].id]);
  assert.deepEqual(lot.map((v) => v.filedExtra), [undefined, 'light-a', 'light-b']);
  assert.deepEqual(lot[2].look.extras.map((x) => [x.label, x.type, x.nw]), [['light-a', 'image', 12288], ['light-b', 'image', 12288]]);
  assert.equal(lot[2].look.type, 'video');
  // With no number, an extra goes with the newest version; with one, with that version; never twice by label.
  const v2 = (await file([{ look: await still('c.png') }])).body.versions[0];
  assert.equal((await file([{ extra: 'warm', look: await still('d.png') }])).body.versions[0].id, v2.id);
  assert.equal((await file([{ extra: 'warm', number: 1, look: await still('e.png') }])).body.versions[0].id, lot[0].id);
  const twice = await file([{ extra: 'warm', number: 1, look: await still('f.png') }]);
  assert.equal(twice.status, 409);
  assert.match(twice.body.error, /kilo-0010 comp v1 has an extra called “warm” already/);
  assert.equal((await file([{ extra: 'cool', number: 9, look: await still('g.png') }])).status, 409);
  // An extra makes no version: the count goes on from v2.
  assert.equal((await file([{ look: await still('h.png') }])).body.versions[0].label, 'kilo-0010 comp v3');
  // The entity's page has them in full, and the Versions list by label.
  const entity = (await call('GET', `/api/projects/${project.id}`)).body.entities.find((e) => e.name === 'kilo-0010');
  const page = (await call('GET', `/api/entities/${entity.id}`)).body;
  assert.deepEqual(page.versions.find((v) => v.id === lot[0].id).look.extras.map((x) => x.label), ['light-a', 'light-b', 'warm']);
  const listed = (await call('GET', `/api/projects/${project.id}/versions`)).body.versions;
  assert.deepEqual(listed.find((v) => v.id === lot[0].id).extras, ['light-a', 'light-b', 'warm']);
  // Taken back straight after: the version stays, without it. A version with extras is not taken back whole.
  assert.equal((await call('POST', `/api/versions/${lot[0].id}/unfile`, {})).status, 409);
  assert.equal((await call('POST', `/api/versions/${lot[0].id}/unfile`, { extra: 'light-b' })).status, 200);
  const after = (await call('GET', `/api/versions/${lot[0].id}`)).body;
  assert.deepEqual(after.look.extras.map((x) => x.label), ['light-a', 'warm']);
  assert.equal((await call('POST', `/api/versions/${lot[0].id}/unfile`, { extra: 'light-b' })).status, 404);
});

test('a project\'s versions can be found by task, sequence, tier, filer and words, sorted, newest only, and changed many at once', async (t) => {
  const s = start(4861);
  t.after(s.stop);
  await s.ready;
  const json = { 'content-type': 'application/json' };
  const call = async (method, url, body) => {
    const res = await fetch(s.base + url, { method, headers: json, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const project = (await call('POST', '/api/folders', { name: 'Kilo' })).body;
  await call('PATCH', `/api/folders/${project.id}`, { project: true });
  const up = async () => (await (await fetch(`${s.base}/api/upload?name=a.png`, { method: 'POST', body: crypto.randomBytes(300) })).json()).url;
  const file = async (name, task, by, filename = 'a.png') => (await call('POST', `/api/projects/${project.id}/versions`, { entity: { name }, by, files: [{ task, look: { type: 'image', src: await up(), name: filename } }] })).body.versions[0];
  const a1 = await file('kilo-0010', 'anim', 'Anna', 'take_one.png');
  const a2 = await file('kilo-0010', 'anim', 'Ben');
  const l1 = await file('kilo-0010', 'lighting', 'Anna');
  const c1 = await file('ch02-0010', 'anim', 'Ben');
  const r1 = await file('char-robot', 'model', 'Anna');
  await file('kilo-0100', null, 'Anna');
  const find = async (query) => (await call('GET', `/api/projects/${project.id}/versions?find=1&${query}`)).body;
  const labels = async (query) => (await find(query)).versions.map((v) => v.label);
  const first = await find('');
  assert.equal(first.total, 6);
  assert.deepEqual(first.facets.tasks, ['anim', 'lighting', 'model']);
  assert.deepEqual(first.facets.seqs, ['ch02', 'kilo']);
  assert.deepEqual(first.facets.filers, ['Anna', 'Ben']);
  assert.deepEqual(first.facets.tiers.map((x) => x.id), ['asset', 'shot']);
  assert.equal(first.facets.untasked, true);
  assert.deepEqual(await labels('task=anim&sort=old'), ['kilo-0010 anim v1', 'kilo-0010 anim v2', 'ch02-0010 anim v1']);
  assert.deepEqual(await labels('task=&sort=old'), ['kilo-0100 v1']);
  assert.deepEqual(await labels('seq=kilo&sort=name'), ['kilo-0010 anim v2', 'kilo-0010 anim v1', 'kilo-0010 lighting v1', 'kilo-0100 v1']);
  assert.deepEqual(await labels('tier=asset'), ['char-robot model v1']);
  assert.deepEqual(await labels('by=ben&sort=old'), ['kilo-0010 anim v2', 'ch02-0010 anim v1']);
  assert.deepEqual(await labels('seq=kilo&task=anim&newest=1'), ['kilo-0010 anim v2']);
  assert.deepEqual(await labels('q=take_one'), ['kilo-0010 anim v1']);
  assert.deepEqual(await labels('q=kilo%20v2'), ['kilo-0010 anim v2']);

  // Many at once: moved to another shot (made on the way) in their order, given a task and artist, archived.
  const moved = await call('PATCH', `/api/projects/${project.id}/versions`, { edits: [
    { id: a1.id, entity: { name: 'kilo-0020' } }, { id: a2.id, entity: { name: 'kilo-0020' } }, { id: l1.id, artist: 'erik' }, { id: r1.id, hidden: true },
  ] });
  assert.equal(moved.status, 200);
  assert.deepEqual(moved.body.versions.map((v) => v.label), ['kilo-0020 anim v1', 'kilo-0020 anim v2', 'kilo-0010 lighting v1', 'char-robot model v1']);
  assert.deepEqual(await labels('tier=asset'), []);
  assert.deepEqual(await labels('tier=asset&archived=1'), ['char-robot model v1']);
  assert.deepEqual(await labels('artist=erik'), ['kilo-0010 lighting v1']);
  // A number taken anywhere changes none of them.
  const clash = await call('PATCH', `/api/projects/${project.id}/versions`, { edits: [{ id: c1.id, artist: 'anna' }, { id: l1.id, entity: { name: 'kilo-0020' }, task: 'anim', number: 1 }] });
  assert.equal(clash.status, 409);
  assert.deepEqual(await labels('artist=anna'), []);
});

test('a project can hold a 3D model of its venue, uploaded as a .glb, and let it go again', async (t) => {
  const s = start(4897);
  t.after(s.stop);
  await s.ready;
  const json = { 'content-type': 'application/json' };
  const call = async (method, url, body) => {
    const res = await fetch(s.base + url, { method, headers: json, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const project = (await call('POST', '/api/folders', { name: 'Kilo' })).body;
  await call('PATCH', `/api/folders/${project.id}`, { project: true });
  const up = async (name) => (await (await fetch(`${s.base}/api/upload?name=${name}`, { method: 'POST', body: crypto.randomBytes(300) })).json()).url;
  const glb = await up('venue.glb');
  assert.match(glb, /\.glb$/);
  const set = async (preview3d) => (await call('PATCH', `/api/folders/${project.id}`, { settings: { preview3d } })).body.settings;
  // the model, the screen's material (screen unless said) and the view that goes on it (as a token)
  assert.deepEqual((await set({ model: glb, name: 'venue.glb', screen: ' ', view: 'CMP' })).preview3d, { model: glb, name: 'venue.glb', screen: 'screen', view: 'cmp', camera: '' });
  // and the camera it opens through, by its name in the model
  assert.equal((await set({ model: glb, name: 'venue.glb', camera: 'booth' })).preview3d.camera, 'booth');
  // anything that is not an uploaded .glb is not a model, and leaves the setting as it was
  assert.equal((await set({ model: await up('a.png') })).preview3d.model, glb);
  assert.equal((await set({ model: '/uploads/nothere.glb' })).preview3d.model, glb);
  // and null takes it away
  assert.equal((await set(null)).preview3d, undefined);
});

test('many assets, sets and shots are edited at once: artists and cc added, taken off or set, and what they are', async (t) => {
  const s = start(4844);
  t.after(s.stop);
  await s.ready;
  const json = { 'content-type': 'application/json' };
  const call = async (method, url, body) => {
    const res = await fetch(s.base + url, { method, headers: json, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const project = (await call('POST', '/api/folders', { name: 'Kilo' })).body;
  await call('PATCH', `/api/folders/${project.id}`, { project: true });
  const other = (await call('POST', '/api/folders', { name: 'Lima' })).body;
  await call('PATCH', `/api/folders/${other.id}`, { project: true });
  const made = (await call('POST', `/api/projects/${project.id}/entities`, { names: ['kilo-0010', 'kilo-0020', 'kilo-0030'] })).body.made;
  const [a, b, c] = made.map((e) => e.id);
  await call('PATCH', `/api/entities/${a}`, { artists: ['Erik'], cc: ['Anna'] });
  const url = `/api/projects/${project.id}/entities`;
  // added to each, never twice; the rest left as each had it
  let res = await call('PATCH', url, { ids: [a, b], artists: { add: ['Ben', 'erik'] } });
  assert.deepEqual(res.body.entities.map((e) => [e.name, e.artists, e.cc]), [['kilo-0010', ['Erik', 'Ben'], ['Anna']], ['kilo-0020', ['Ben', 'erik'], []]]);
  // taken off, whatever the case; set outright; and the tier
  res = await call('PATCH', url, { ids: [a, b, c], artists: { remove: ['ERIK'] }, cc: { set: ['Dina'] }, tier: 'asset' });
  assert.deepEqual(res.body.entities.map((e) => [e.artists, e.cc, e.tier]), [[['Ben'], ['Dina'], 'asset'], [['Ben'], ['Dina'], 'asset'], [[], ['Dina'], 'asset']]);
  // something of another project, or a tier that is none, changes nothing at all
  const lima = (await call('POST', `/api/projects/${other.id}/entities`, { names: ['lima-0010'] })).body.made[0];
  assert.equal((await call('PATCH', url, { ids: [a, lima.id], tier: 'shot' })).status, 400);
  assert.equal((await call('PATCH', url, { ids: [a], tier: 'planet' })).status, 400);
  assert.equal((await call('GET', `/api/projects/${project.id}`)).body.entities.find((e) => e.id === a).tier, 'asset');
});

test('a project lists its versions newest first, and puts chosen ones on one of its boards', async (t) => {
  const s = start(4845);
  t.after(s.stop);
  await s.ready;
  const json = { 'content-type': 'application/json' };
  const call = async (method, url, body) => {
    const res = await fetch(s.base + url, { method, headers: json, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const project = (await call('POST', '/api/folders', { name: 'Kilo' })).body;
  await call('PATCH', `/api/folders/${project.id}`, { project: true });
  const board = (await call('POST', '/api/boards', { name: 'Dailies', folderId: project.id })).body;
  const loose = (await call('POST', '/api/boards', { name: 'Elsewhere' })).body;
  const up = async () => (await (await fetch(`${s.base}/api/upload?name=a.png`, { method: 'POST', body: crypto.randomBytes(300) })).json()).url;
  const file = async (name, task, by) => (await call('POST', `/api/projects/${project.id}/versions`, { by, entity: { name }, task, files: [{ look: { type: 'image', src: await up(), name: 'a.png', nw: 1600, nh: 900 } }] })).body.versions[0];
  const a = await file('kilo-0010', 'anim', 'Erik');
  const b = await file('kilo-0020', 'comp', 'Anna');
  const c = await file('kilo-0010', 'anim', 'Erik');
  await call('PATCH', `/api/versions/${b.id}`, { hidden: true });

  const list = (await call('GET', `/api/projects/${project.id}/versions`)).body;
  assert.deepEqual(list.versions.map((v) => [v.label, v.createdBy]), [['kilo-0010 anim v2', 'Erik'], ['kilo-0010 anim v1', 'Erik']]);
  assert.equal(list.versions[0].entity, 'kilo-0010');
  assert.equal(list.more, false);

  // on the board, below what is there, as those versions
  const open = joiner(4845);
  const anna = await open(`board=${board.id}`, 'Anna');
  t.after(() => anna.ws.close());
  anna.ws.send(JSON.stringify({ t: 'op', ops: [{ t: 'add', item: { id: 'noteitem1', type: 'note', x: 100, y: 50, w: 260, h: 200, text: 'Plan' } }] }));
  await pause(200);
  const placed = await call('POST', `/api/projects/${project.id}/place`, { board: board.id, versions: [c.id, a.id] });
  assert.equal(placed.status, 200);
  assert.equal(placed.body.placed.length, 2);
  await pause(200);
  const added = anna.seen.filter((m) => m.t === 'op').flatMap((m) => m.ops).filter((o) => o.t === 'add' && o.item.ver).map((o) => o.item);
  assert.deepEqual(added.map((it) => [it.ver, it.type, it.w, it.h]), [[c.id, 'image', 750, 422], [a.id, 'image', 750, 422]]);
  // side by side, in a row starting at the left of what is there, below it
  assert.deepEqual(added.map((it) => [it.x, it.y]), [[100, 410], [874, 410]]);
  assert.deepEqual((await call('GET', `/api/projects/${project.id}/versions`)).body.versions[0].boards.map((x) => x.name), ['Dailies']);
  // laid out by sequence: a column each, shots going down in order, assets after
  const fresh = (await call('POST', '/api/boards', { name: 'Review', folderId: project.id })).body;
  const d = await file('abc-0020', 'anim', 'Ben');
  const e = await file('abc-0010', 'anim', 'Ben');
  const robot = await file('char-robot', 'model', 'Ben');
  const watch = await open(`board=${fresh.id}`, 'Ben');
  t.after(() => watch.ws.close());
  await call('POST', `/api/projects/${project.id}/place`, { board: fresh.id, versions: [robot.id, d.id, c.id, e.id], layout: 'sequences' });
  await pause(200);
  const laid = watch.seen.filter((m) => m.t === 'op').flatMap((m) => m.ops).filter((o) => o.t === 'add').map((o) => o.item);
  assert.deepEqual(laid.map((it) => [it.ver, it.x, it.y]), [[e.id, 0, 0], [d.id, 0, 446], [c.id, 870, 0], [robot.id, 1740, 0]]);
  // not a board of another project, nor versions of nothing
  assert.equal((await call('POST', `/api/projects/${project.id}/place`, { board: loose.id, versions: [a.id] })).status, 404);
  assert.equal((await call('POST', `/api/projects/${project.id}/place`, { board: board.id, versions: ['nothing1'] })).status, 400);
});

// ---------------------------------------------------------------- requests from other sites, and who is guessing

// A request for some address (its Host header), which fetch would not let us choose.
function askFor(port, host, method = 'GET', p = '/api/library', headers = {}) {
  return new Promise((resolve, reject) => {
    const req = require('node:http').request({ host: '127.0.0.1', port, path: p, method, headers: { host, ...headers } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

test('the server answers only to its own addresses, and takes changes only with X-WB', async (t) => {
  const s = start(4846, { ALLOWED_HOSTS: 'boards.example.com, *.studio.test' });
  t.after(s.stop);
  await s.ready;
  // a page on another site that points its own name at this server gets nothing back
  assert.equal(await askFor(4846, 'evil.example'), 421);
  assert.equal(await askFor(4846, 'evil.example:4846', 'GET', '/'), 421);
  assert.equal(await askFor(4846, 'evil.example', 'GET', '/healthz'), 200);
  for (const host of ['127.0.0.1:4846', 'localhost:4846', '[::1]:4846', 'boards.example.com', 'pc-3.studio.test', `${os.hostname()}:4846`, 'abc.trycloudflare.com']) {
    assert.equal(await askFor(4846, host), 200, host);
  }
  await assert.rejects(joiner(4846)('board=nothing', 'Mallory', { headers: { host: 'evil.example' } }));

  // reading needs nothing more; a change without the header is refused, and so is stopping the server
  assert.equal((await bareFetch(`${s.base}/api/library`)).status, 200);
  const bare = await bareFetch(`${s.base}/api/boards`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"x"}' });
  assert.equal(bare.status, 403);
  assert.match((await bare.json()).error, /X-WB/i);
  assert.equal((await bareFetch(`${s.base}/api/upload?name=a.png`, { method: 'POST', body: 'x' })).status, 403);
  assert.equal((await bareFetch(`${s.base}/__shutdown`, { method: 'POST' })).status, 403);
  assert.equal((await fetch(`${s.base}/api/boards`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"x"}' })).status, 201);
  assert.equal((await fetch(`${s.base}/healthz`)).status, 200);
});

test('wrong passwords are counted by the address a trusted proxy names, only when it is trusted, and a flood does not wipe the count', async () => {
  const { clientAddress } = require('../auth');
  const at = (remoteAddress, headers) => ({ socket: { remoteAddress }, headers });
  // without TRUST_PROXY anybody could write those headers, so they are not believed, even from this machine
  assert.equal(clientAddress(at('127.0.0.1', { 'cf-connecting-ip': '9.9.9.9', 'x-forwarded-for': '8.8.8.8' })), '127.0.0.1');
  assert.equal(clientAddress(at('127.0.0.1', { 'cf-connecting-ip': '9.9.9.9' }), 'cloudflare'), '9.9.9.9');
  // a proxy adds the address it saw last; whatever came before is the visitor's to make up
  assert.equal(clientAddress(at('10.0.0.1', { 'x-forwarded-for': '1.1.1.1, 5.5.5.5' }), '1'), '5.5.5.5');
  assert.equal(clientAddress(at('10.0.0.1', {}), '1'), '10.0.0.1');

  const attempt = async (auth, headers, remote = '127.0.0.1') => {
    const req = fakeReq({ name: 'Eve', password: 'nope' }, headers);
    req.socket = { remoteAddress: remote };
    const res = jsonRes();
    await auth.handle(req, res, new URL('http://x/auth/password'));
    return res.status;
  };
  // made-up headers do not buy more tries
  const plain = passwordAuth();
  for (let i = 0; i < 8; i++) assert.equal(await attempt(plain, { 'cf-connecting-ip': `9.9.9.${i}` }), 401);
  assert.equal(await attempt(plain, { 'cf-connecting-ip': '9.9.9.99' }), 429);
  // behind Cloudflare each visitor has their own count
  const cf = passwordAuth({ trustProxy: 'cloudflare' });
  for (let i = 0; i < 8; i++) await attempt(cf, { 'cf-connecting-ip': '7.7.7.7' });
  assert.equal(await attempt(cf, { 'cf-connecting-ip': '7.7.7.7' }), 429);
  assert.equal(await attempt(cf, { 'cf-connecting-ip': '7.7.7.8' }), 401);
  // thousands of other addresses make room by forgetting the oldest, not everybody
  const flood = passwordAuth();
  for (let i = 0; i < 5000; i++) await attempt(flood, {}, `10.${i >> 8}.${i & 255}.1`);
  for (let i = 0; i < 8; i++) await attempt(flood, {}, '6.6.6.6');
  for (let i = 0; i < 200; i++) await attempt(flood, {}, `11.0.${i}.1`);
  assert.equal(await attempt(flood, {}, '6.6.6.6'), 429);
});

// ---------------------------------------------------------------- workspaces, and what each person sees of others'

test('what is shared stays shared, rooms and boards follow who may see them, and other people\'s board names stay theirs', async (t) => {
  const secret = 'share-guard-secret';
  const mk = createAuth(googleOptions({ sessionSecret: secret, allowedDomains: 'x.com', allowedEmails: '', publicUrl: 'http://localhost:4847' }));
  const cookie = (email, name) => mk.sessionCookie({ email, name }).split(';')[0];
  const anna = cookie('anna@x.com', 'Anna');
  const ben = cookie('ben@x.com', 'Ben');
  const boss = cookie('boss@x.com', 'Boss');
  const s = start(4847, {
    AUTH_MODE: 'google', GOOGLE_CLIENT_ID: 'client-1', GOOGLE_CLIENT_SECRET: 'shh', PUBLIC_URL: 'http://localhost:4847',
    ALLOWED_DOMAINS: 'x.com', SESSION_SECRET: secret, ADMIN_EMAILS: 'boss@x.com',
  });
  t.after(s.stop);
  await s.ready;
  const call = async (who, method, p, body) => {
    const res = await fetch(s.base + p, { method, headers: { cookie: who, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const open = joiner(4847);

  // a folder with something in it, or somebody else's board, is not taken out of the shared workspace
  const full = (await call(anna, 'POST', '/api/folders', { name: 'Shared stuff' })).body;
  await call(anna, 'POST', '/api/boards', { name: 'Inside', folderId: full.id });
  const refused = await call(ben, 'PATCH', `/api/folders/${full.id}`, { workspace: 'personal' });
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /admin/);
  assert.equal((await call(anna, 'PATCH', `/api/folders/${full.id}`, { workspace: 'personal' })).status, 403);
  const empty = (await call(anna, 'POST', '/api/folders', { name: 'Empty' })).body;
  assert.equal((await call(ben, 'PATCH', `/api/folders/${empty.id}`, { workspace: 'personal' })).body.workspace, 'personal');
  const team = (await call(anna, 'POST', '/api/boards', { name: 'Team board' })).body;
  assert.equal((await call(ben, 'PATCH', `/api/boards/${team.id}`, { workspace: 'personal' })).status, 403);
  assert.equal((await call(ben, 'GET', `/api/boards/${team.id}`)).status, 200);
  assert.equal((await call(anna, 'PATCH', `/api/boards/${team.id}`, { workspace: 'personal' })).body.workspace, 'personal');
  assert.equal((await call(anna, 'PATCH', `/api/boards/${team.id}`, { workspace: 'myreze' })).status, 200);
  // and a folder that is not there is not found, wherever it is named
  assert.equal((await call(anna, 'POST', '/api/boards', { name: 'x', folderId: 'nosuchfolder' })).status, 404);
  assert.equal((await call(anna, 'POST', '/api/folders', { name: 'x', parentId: 'nosuchfolder' })).status, 404);
  assert.equal((await call(anna, 'PATCH', `/api/boards/${team.id}`, { folderId: 'nosuchfolder' })).status, 404);

  // a shared project with a version, which Anna also puts on a board of her own and talks about there
  const kilo = (await call(boss, 'POST', '/api/folders', { name: 'Kilo' })).body;
  await call(boss, 'PATCH', `/api/folders/${kilo.id}`, { project: true });
  const src = (await (await fetch(`${s.base}/api/upload?name=a.png`, { method: 'POST', headers: { cookie: boss }, body: crypto.randomBytes(300) })).json()).url;
  const [v1] = (await call(boss, 'POST', `/api/projects/${kilo.id}/versions`, { entity: { name: 'kilo-0010' }, files: [{ look: { type: 'image', src } }] })).body.versions;
  const hers = (await call(anna, 'POST', '/api/boards', { name: 'Anna secret plans', workspace: 'personal' })).body;
  const annaConn = await open(`board=${hers.id}`, 'Anna', { headers: { cookie: anna } });
  t.after(() => annaConn.ws.close());
  annaConn.ws.send(JSON.stringify({ t: 'op', ops: [
    { t: 'add', item: { id: 'placed001', type: 'image', x: 0, y: 0, w: 10, h: 10, src, ver: v1.id } },
    { t: 'add', item: { id: 'annanote1', type: 'comment', on: 'placed001', text: 'Mine' } },
  ] }));
  await pause(250);
  const named = async (who) => (await call(who, 'GET', `/api/entities/${v1.entityId}`)).body.notes.find((n) => n.id === 'annanote1').board;
  assert.deepEqual(await named(anna), { id: hers.id, name: 'Anna secret plans' });
  assert.deepEqual(await named(ben), { id: hers.id, name: null });
  // on a shared board showing the same version, nor does the thread say where it was made
  const benConn = await open(`board=${team.id}`, 'Ben', { headers: { cookie: ben } });
  t.after(() => benConn.ws.close());
  benConn.ws.send(JSON.stringify({ t: 'op', ops: [{ t: 'add', item: { id: 'placed002', type: 'image', x: 0, y: 0, w: 10, h: 10, src, ver: v1.id } }] }));
  await pause(250);
  const brought = benConn.seen.filter((m) => m.t === 'op').flatMap((m) => m.ops).find((o) => o.t === 'add' && o.item.id === 'annanote1').item;
  assert.equal(brought.ob, hers.id);
  assert.equal(brought.obn, null);
  const room = await open(`entity=${v1.entityId}`, 'Ben', { headers: { cookie: ben } });
  assert.equal(room.seen.find((m) => m.t === 'init').notes.find((n) => n.id === 'annanote1').obn, null);

  // a version of a project in somebody's personal workspace never goes on a shared board
  const mine = (await call(anna, 'POST', '/api/folders', { name: 'Side project', workspace: 'personal' })).body;
  await call(anna, 'PATCH', `/api/folders/${mine.id}`, { project: true });
  const [own] = (await call(anna, 'POST', `/api/projects/${mine.id}/versions`, { entity: { name: 'char-cat' }, files: [{ look: { type: 'image', src } }] })).body.versions;
  const annaOnTeam = await open(`board=${team.id}`, 'Anna', { headers: { cookie: anna } });
  t.after(() => annaOnTeam.ws.close());
  annaOnTeam.ws.send(JSON.stringify({ t: 'op', ops: [{ t: 'add', item: { id: 'leaked001', type: 'image', x: 0, y: 0, w: 10, h: 10, src, ver: own.id } }] }));
  await pause(200);
  assert.equal(benConn.seen.filter((m) => m.t === 'op').flatMap((m) => m.ops).find((o) => o.t === 'add' && o.item.id === 'leaked001').item.ver, undefined);
  // and Anna's own page is told it is plain media there
  const fix = annaOnTeam.seen.find((m) => m.t === 'op' && m.fix).ops[0];
  assert.deepEqual([fix.t, fix.item.id, fix.item.ver], ['add', 'leaked001', undefined]);

  // only an admin moves a project out of the shared workspace; whoever has it open and may no longer see it is shown the door
  assert.equal((await call(anna, 'PATCH', `/api/folders/${kilo.id}`, { workspace: 'personal' })).status, 403);
  assert.equal((await call(boss, 'PATCH', `/api/folders/${kilo.id}`, { workspace: 'personal' })).status, 200);
  await pause(200);
  assert.equal(room.closed, 4003);
  await assert.rejects(open(`entity=${v1.entityId}`, 'Ben', { headers: { cookie: ben } }));
});

// ---------------------------------------------------------------- the board's own socket

test('a round of changes sent twice is applied once, and the sender is told what the server made of it', async (t) => {
  const s = start(4848);
  t.after(s.stop);
  await s.ready;
  const WebSocket = require('ws');
  const json = { 'content-type': 'application/json' };
  const board = await (await fetch(`${s.base}/api/boards`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'Sync' }) })).json();
  const join = (name, cid) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:4848/ws?board=${board.id}`);
    const conn = { ws, seen: [] };
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', name, cid })));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      conn.seen.push(msg);
      if (msg.t === 'init') resolve(conn);
    });
    ws.on('error', reject);
  });
  const anna = await join('Anna', 'page-anna-1');
  const ben = await join('Ben', 'page-ben-1');
  t.after(() => { anna.ws.close(); ben.ws.close(); });
  const send = (conn, seq, ops) => conn.ws.send(JSON.stringify({ t: 'op', seq, ops }));
  const added = (conn) => conn.seen.filter((m) => m.t === 'op' && !m.fix).flatMap((m) => m.ops).filter((o) => o.t === 'add').map((o) => o.item.id);

  send(anna, 1, [{ t: 'add', item: { id: 'noteone01', type: 'note', x: 0, y: 0, w: 10, h: 10, text: 'once' } }]);
  await pause(150);
  // the connection dropped before the ack came, so the page sends it again, on a new connection
  const again = await join('Anna', 'page-anna-1');
  t.after(() => again.ws.close());
  send(again, 1, [{ t: 'add', item: { id: 'notetwo01', type: 'note', x: 0, y: 0, w: 10, h: 10, text: 'twice' } }]);
  await pause(150);
  assert.deepEqual(again.seen.filter((m) => m.t === 'ack'), [{ t: 'ack', seq: 1 }]);
  assert.deepEqual(added(ben), ['noteone01']);
  // a page without numbers is acked as before
  anna.ws.send(JSON.stringify({ t: 'op', ops: [] }));
  await pause(100);
  assert.deepEqual(anna.seen.filter((m) => m.t === 'ack').pop(), { t: 'ack' });

  // files only from here, or written in; an image may be shown from another site, its still may not
  send(anna, 2, [{ t: 'add', item: { id: 'imageone1', type: 'image', x: 0, y: 0, w: 10, h: 10, src: 'https://example.com/a.png', th: 'https://evil.example/t.png', prev: 'data:image/webp;base64,AAAA', orig: 'javascript:alert(1)' } },
    { t: 'add', item: { id: 'videoone1', type: 'video', x: 0, y: 0, w: 10, h: 10, src: 'https://example.com/a.mp4', poster: '/uploads/p.webp', wf: { c: 'AAEC', x: 1 } } }]);
  await pause(150);
  const at = anna.seen.findIndex((m) => m.t === 'op' && m.fix);
  const [image, video] = anna.seen[at].ops.map((o) => o.item);
  assert.deepEqual([image.src, image.th, image.prev, image.orig], ['https://example.com/a.png', undefined, 'data:image/webp;base64,AAAA', undefined]);
  assert.deepEqual([video.src, video.poster, video.wf], [undefined, '/uploads/p.webp', { c: 'AAEC' }]);
  // the server's version comes just before the ack
  assert.deepEqual(anna.seen[at + 1], { t: 'ack', seq: 2 });

  // what a pointer says is only what pointers say
  ben.ws.send(JSON.stringify({ t: 'p', p: { c: [1, 2], s: ['imageone1', 7], v: [0, 0, 100, 50], junk: 'x'.repeat(1000), f: { not: 'an id' } } }));
  await pause(100);
  assert.deepEqual(anna.seen.filter((m) => m.t === 'p').pop().p, { c: [1, 2], s: ['imageone1'], v: [0, 0, 100, 50] });
});

test('deleting a thread takes its replies with it, undo brings them back, and only a note shown here can be brought back', async (t) => {
  const s = start(4849);
  t.after(s.stop);
  await s.ready;
  const json = { 'content-type': 'application/json' };
  const mk = async (name) => (await fetch(`${s.base}/api/boards`, { method: 'POST', headers: json, body: JSON.stringify({ name }) })).json();
  const one = await mk('One');
  const two = await mk('Two');
  const open = joiner(4849);
  const anna = await open(`board=${one.id}`, 'Anna');
  const ben = await open(`board=${one.id}`, 'Ben');
  const elsewhere = await open(`board=${two.id}`, 'Anna');
  t.after(() => { anna.ws.close(); ben.ws.close(); elsewhere.ws.close(); });
  const ops = (conn, list) => conn.ws.send(JSON.stringify({ t: 'op', ops: list }));
  const image = (id) => ({ t: 'add', item: { id, type: 'image', x: 0, y: 0, w: 10, h: 10, src: '/uploads/a.png' } });
  ops(anna, [image('imageone1'), { t: 'add', item: { id: 'thread001', type: 'comment', on: 'imageone1', text: 'Darker?' } }]);
  await pause(150);
  ops(ben, [{ t: 'add', item: { id: 'reply0001', type: 'comment', on: 'imageone1', re: 'thread001', text: 'On it' } }]);
  await pause(150);
  // Anna deletes her thread: Ben's reply goes with it, for everybody
  ops(anna, [{ t: 'del', ids: ['thread001'] }]);
  await pause(200);
  const shown = async () => (await open(`board=${one.id}`, 'Cara')).seen.find((m) => m.t === 'init').items.filter((i) => i.type === 'comment').map((i) => i.id).sort();
  assert.deepEqual(await shown(), []);
  assert.ok(ben.seen.some((m) => m.t === 'op' && m.ops.some((o) => o.t === 'del' && o.ids.includes('reply0001'))));
  // undo brings the thread back, with the reply
  ops(anna, [{ t: 'add', item: { id: 'thread001', type: 'comment', on: 'imageone1', text: 'Darker?' } }]);
  await pause(200);
  assert.deepEqual(await shown(), ['reply0001', 'thread001']);

  // a note on another board, deleted there, cannot be brought back from here by naming it
  ops(elsewhere, [image('imagetwo1'), { t: 'add', item: { id: 'othernote', type: 'comment', on: 'imagetwo1', text: 'Elsewhere' } }]);
  await pause(150);
  ops(elsewhere, [{ t: 'del', ids: ['othernote'] }]);
  await pause(150);
  ops(anna, [{ t: 'add', item: { id: 'othernote', type: 'comment', on: 'imageone1', text: 'Elsewhere' } }]);
  await pause(200);
  const later = await open(`board=${two.id}`, 'Dora');
  assert.deepEqual(later.seen.find((m) => m.t === 'init').items.filter((i) => i.type === 'comment'), []);
  assert.deepEqual(anna.seen.filter((m) => m.t === 'op' && m.fix).pop().ops, [{ t: 'del', ids: ['othernote'] }]);
});

// ---------------------------------------------------------------- the catalogue

test('filing checks everything before it files anything, and so does changing a version', async (t) => {
  const s = start(4850);
  t.after(s.stop);
  await s.ready;
  const json = { 'content-type': 'application/json' };
  const call = async (method, url, body) => {
    const res = await fetch(s.base + url, { method, headers: json, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const project = (await call('POST', '/api/folders', { name: 'Kilo' })).body;
  await call('PATCH', `/api/folders/${project.id}`, { project: true });
  const board = (await call('POST', '/api/boards', { name: 'Standup', folderId: project.id })).body;
  const up = async () => (await (await fetch(`${s.base}/api/upload?name=a.png`, { method: 'POST', body: crypto.randomBytes(300) })).json()).url;
  const src = await up();
  const conn = await joiner(4850)(`board=${board.id}`, 'Anna');
  t.after(() => conn.ws.close());
  conn.ws.send(JSON.stringify({ t: 'op', ops: [{ t: 'add', item: { id: 'imageone1', type: 'image', x: 0, y: 0, w: 10, h: 10, src, name: 'a.png' } }] }));
  await pause(200);
  const entities = async () => (await call('GET', `/api/projects/${project.id}`)).body.entities;
  const piece = { board: board.id, item: 'imageone1' };

  // a bad file after a good one, the same piece twice, a number asked for twice: nothing is filed, nothing made
  assert.equal((await call('POST', `/api/projects/${project.id}/versions`, { entity: { name: 'kilo-0010' }, files: [piece, { look: { type: 'image', src: '/uploads/nothere.png' } }] })).status, 400);
  assert.equal((await call('POST', `/api/projects/${project.id}/versions`, { entity: { name: 'kilo-0010' }, files: [piece, piece] })).status, 400);
  const twice = await call('POST', `/api/projects/${project.id}/versions`, { entity: { name: 'kilo-0010' }, files: [{ number: 3, look: { type: 'image', src } }, { number: 3, look: { type: 'image', src } }] });
  assert.equal(twice.status, 409);
  assert.equal((await call('POST', `/api/projects/${project.id}/versions`, { entity: { name: 'kilo-0010' }, files: [{ look: { type: 'image', src } }, { number: 0, look: { type: 'image', src } }] })).status, 400);
  assert.deepEqual(await entities(), []);
  assert.ok(!conn.seen.some((m) => m.t === 'op' && m.ops.some((o) => o.t === 'set')));

  const [v1, v2] = (await call('POST', `/api/projects/${project.id}/versions`, { entity: { name: 'kilo-0010' }, task: 'anim', files: [{ look: { type: 'image', src } }, { look: { type: 'image', src } }] })).body.versions;
  assert.deepEqual([v1.label, v2.label], ['kilo-0010 anim v1', 'kilo-0010 anim v2']);
  // a refused change changes nothing it came with: not archived, no entity made
  assert.equal((await call('PATCH', `/api/versions/${v2.id}`, { hidden: true, number: 1 })).status, 409);
  assert.equal((await call('GET', `/api/versions/${v2.id}`)).body.hidden, false);
  assert.equal((await call('PATCH', `/api/versions/${v2.id}`, { entity: { name: 'kilo-0099' }, number: 0 })).status, 400);
  assert.deepEqual((await entities()).map((e) => e.name), ['kilo-0010']);
  // moved to a new entity, it is made then
  assert.equal((await call('PATCH', `/api/versions/${v2.id}`, { entity: { name: 'kilo-0099' } })).body.label, 'kilo-0099 anim v1');
  assert.equal((await call('PUT', `/api/versions/${v2.id}`, {})).status, 405);
});

test('a catalogue note that mentions somebody tells them, and says where in the catalogue it is', async (t) => {
  const s = start(4851);
  t.after(s.stop);
  await s.ready;
  const json = { 'content-type': 'application/json' };
  const call = async (method, url, body) => (await fetch(s.base + url, { method, headers: json, body: body && JSON.stringify(body) })).json();
  const project = await call('POST', '/api/folders', { name: 'Kilo' });
  await call('PATCH', `/api/folders/${project.id}`, { project: true });
  const src = (await (await fetch(`${s.base}/api/upload?name=a.png`, { method: 'POST', body: crypto.randomBytes(300) })).json()).url;
  const [v] = (await call('POST', `/api/projects/${project.id}/versions`, { by: 'Ben', entity: { name: 'kilo-0010' }, task: 'anim', files: [{ look: { type: 'image', src } }] })).versions;
  const room = await joiner(4851)(`entity=${v.entityId}`, 'Anna');
  t.after(() => room.ws.close());
  room.ws.send(JSON.stringify({ t: 'op', ops: [{ t: 'add', item: { id: 'catnote01', type: 'comment', on: v.id, text: '@Cleo can you look?' } }] }));
  await pause(200);
  const [cleo] = (await call('GET', '/api/notifications?name=Cleo')).items;
  assert.deepEqual(
    [cleo.id, cleo.kind, cleo.board, cleo.entityId, cleo.projectId, cleo.versionId, cleo.on, cleo.author],
    ['catnote01', 'mention', null, v.entityId, project.id, v.id, 'kilo-0010 anim v1', 'Anna'],
  );
  // Ben filed the version: a note on it is on his work
  assert.deepEqual((await call('GET', '/api/notifications?name=Ben')).items.map((i) => [i.id, i.kind]), [['catnote01', 'work']]);
});

test('the newest version is one thing everywhere, and a project\'s versions page through ties without skipping', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wipboard-newest-'));
  try {
    const store = openStore(dir);
    store.saveFolders([{ id: 'kilo', name: 'Kilo', workspace: 'myreze', createdAt: 1, project: true }]);
    store.addEntity({ id: 'shot1', projectId: 'kilo', tier: 'shot', name: 'kilo-0010' });
    const look = { type: 'image', src: '/uploads/a.png' };
    const file = (id, task, at, number = null) => store.addVersion({ id, entityId: 'shot1', task, number, kind: 'image', look, at });
    file('anim1', 'anim', 10);
    file('anim7', 'anim', 20, 7); // numbered by hand: the newest of anim, though another comes after it
    file('anim3', 'anim', 30, 3);
    file('comp1', 'comp', 15);
    // of a task, the highest number; of the entity, the latest filed of those
    assert.equal(store.newestVersion('shot1', 'anim').id, 'anim7');
    assert.equal(store.newestOfTask('shot1', 'anim').id, 'anim7');
    assert.equal(store.entities('kilo')[0].newest.id, 'anim7');
    assert.equal(store.entityCards(['shot1']).get('shot1').newest.id, 'anim7');
    file('comp2', 'comp', 25);
    assert.equal(store.entities('kilo')[0].newest.id, 'comp2');

    // many filed in the same millisecond still come one page after another, each once
    for (let i = 0; i < 7; i++) file(`same${i}`, 'light', 99);
    const seen = [];
    let after;
    for (;;) {
      const page = store.projectVersions('kilo', { limit: 3, ...(after && { after }) });
      seen.push(...page.map((v) => v.id));
      if (page.length < 3) break;
      const last = page.at(-1);
      after = [last.createdAt, last.number, last.id];
    }
    assert.equal(seen.length, 12);
    assert.equal(new Set(seen).size, 12);
    // a version with no task is stored as '' and comes out as none
    file('plain1', null, 5);
    assert.equal(store.version('plain1').task, null);
    assert.throws(() => file('plain2', null, 6, 1), /taken/);
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the Versions list hands out where its next page starts, and still takes a time', async (t) => {
  const s = start(4852);
  t.after(s.stop);
  await s.ready;
  const json = { 'content-type': 'application/json' };
  const call = async (method, url, body) => {
    const res = await fetch(s.base + url, { method, headers: json, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const project = (await call('POST', '/api/folders', { name: 'Kilo' })).body;
  await call('PATCH', `/api/folders/${project.id}`, { project: true });
  const src = (await (await fetch(`${s.base}/api/upload?name=a.png`, { method: 'POST', body: crypto.randomBytes(300) })).json()).url;
  const [v] = (await call('POST', `/api/projects/${project.id}/versions`, { entity: { name: 'kilo-0010' }, files: [{ look: { type: 'image', src } }] })).body.versions;
  const first = (await call('GET', `/api/projects/${project.id}/versions`)).body;
  assert.deepEqual([first.versions.length, first.more, first.next], [1, false, null]);
  assert.equal((await call('GET', `/api/projects/${project.id}/versions?before=${v.createdAt}`)).body.versions.length, 0);
  assert.equal((await call('GET', `/api/projects/${project.id}/versions?before=${v.createdAt + 1}`)).body.versions.length, 1);
  const cursor = Buffer.from(JSON.stringify([v.createdAt, v.number + 1, ''])).toString('base64url');
  assert.equal((await call('GET', `/api/projects/${project.id}/versions?before=${cursor}`)).body.versions.length, 1);
  assert.equal((await call('GET', `/api/projects/${project.id}/versions?before=not-a-page`)).status, 400);
});

test('shot names are read by the project\'s naming rules, whatever their sequence is called', {
}, async (t) => {
  const s = start(4853);
  t.after(s.stop);
  await s.ready;
  const json = { 'content-type': 'application/json' };
  const call = async (method, url, body) => (await fetch(s.base + url, { method, headers: json, body: body && JSON.stringify(body) })).json();
  const project = await call('POST', '/api/folders', { name: 'Kilo' });
  await call('PATCH', `/api/folders/${project.id}`, { project: true });
  const { made } = await call('POST', `/api/projects/${project.id}/entities`, { names: ['ch01-0010', 'kilo-0010', 'char-robot'] });
  assert.deepEqual(made.map((e) => [e.name, e.tier]), [['ch01-0010', 'shot'], ['kilo-0010', 'shot'], ['char-robot', 'asset']]);
  const tl = await call('GET', `/api/projects/${project.id}/timeline`);
  assert.deepEqual(tl.shots.map((x) => [x.name, x.seq]), [['ch01-0010', 'ch01'], ['kilo-0010', 'kilo']]);
});

// ---------------------------------------------------------------- the database, brought up to date

test('nobody has more than twenty files on their way in at once', async (t) => {
  const s = start(4854);
  t.after(s.stop);
  await s.ready;
  const piece = (uid, offset, done) => fetch(`${s.base}/api/upload?name=a.png&uid=${uid}&offset=${offset}&done=${done}`, { method: 'POST', body: Buffer.alloc(10) });
  for (let i = 0; i < 20; i++) assert.equal((await piece(`waiting${String(i).padStart(2, '0')}`, 0, 0)).status, 200);
  assert.equal((await piece('waiting20', 0, 0)).status, 429);
  // one already on its way carries on, and once it is in there is room again
  assert.equal((await piece('waiting00', 10, 1)).status, 200);
  assert.equal((await piece('waiting20', 0, 0)).status, 200);
});

// ---------------------------------------------------------------- Claude

test('Claude suggests names for files and renames, through the server, without changing anything itself', async (t) => {
  // Claude stood in for by a small server that answers whatever tool it is asked to call.
  const http = require('node:http');
  const asked = [];
  const claude = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      asked.push({ key: req.headers['x-api-key'], body });
      const input = body.tool_choice.name === 'file_versions'
        ? { files: [{ key: 'r0', entity: 'ch02-0010', tier: 'shot', task: 'anim', version: 4, view: 'bty', note: 'v4 in the name' }] }
        : { entities: [{ id: body.messages[0].content.match(/\n(\S+)\topening/)[1], name: 'ch02-0020', tier: 'shot', note: 'the opening shot' }] };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ stop_reason: 'tool_use', content: [{ type: 'tool_use', name: body.tool_choice.name, input }] }));
    });
  });
  await new Promise((r) => claude.listen(0, '127.0.0.1', r));
  t.after(() => claude.close());
  const s = start(4891, { ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_BASE_URL: `http://127.0.0.1:${claude.address().port}`, AI_MODEL: '' });
  t.after(s.stop);
  await s.ready;
  const call = async (method, url, body) => {
    const res = await fetch(s.base + url, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  assert.deepEqual((await call('GET', '/api/me')).body.ai, { model: 'claude-haiku-5-5' });
  const kilo = (await call('POST', '/api/folders', { name: 'Kilo' })).body;
  await call('PATCH', `/api/folders/${kilo.id}`, { project: true });
  await call('PATCH', `/api/folders/${kilo.id}`, { settings: { views: ['cmp', 'bty'] } });
  const made = (await call('POST', `/api/projects/${kilo.id}/entities`, { names: ['opening', 'char-robot', 'set-kitchen'], tier: 'asset' })).body.made;
  const [opening, robot, kitchen] = ['opening', 'char-robot', 'set-kitchen'].map((n) => made.find((e) => e.name === n));

  const files = await call('POST', `/api/projects/${kilo.id}/ai/files`, { instruction: 'all shots of ch02', files: [{ key: 'r0', filename: 'Robot walk v4.mov' }] });
  assert.equal(files.status, 200);
  assert.deepEqual(files.body.answers.r0, { entity: 'ch02-0010', tier: 'shot', task: 'anim', version: 4, view: 'bty', note: 'v4 in the name', fits: true });
  assert.equal(asked[0].key, 'sk-test');
  assert.match(asked[0].body.system, /char-robot \(asset\)/, 'the project\'s names go along');
  assert.match(asked[0].body.messages[0].content, /all shots of ch02/);
  // With views off, a view Claude names is no view, and it is told there are none.
  await call('PATCH', `/api/folders/${kilo.id}`, { settings: { views: false } });
  const plain = await call('POST', `/api/projects/${kilo.id}/ai/files`, { files: [{ key: 'r0', filename: 'Robot walk v4.mov' }] });
  assert.equal(plain.body.answers.r0.view, null);
  assert.match(asked[1].body.system, /view: always null/);
  await call('PATCH', `/api/folders/${kilo.id}`, { settings: { views: ['cmp', 'bty'] } });

  const ren = await call('POST', `/api/projects/${kilo.id}/ai/entities`, { instruction: 'opening is the first shot', ids: [opening.id] });
  assert.equal(ren.status, 200);
  assert.deepEqual(ren.body.answers[opening.id], { name: 'ch02-0020', tier: 'shot', note: 'the opening shot', fits: true });
  assert.equal((await call('GET', `/api/entities/${opening.id}`)).body.entity.name, 'opening', 'only suggested');
  assert.equal((await call('POST', `/api/projects/${kilo.id}/ai/entities`, { ids: ['nope'] })).status, 400);

  // Applied as one change: each its own name and tier; names can go round among them; all or nothing.
  const ids = [opening.id, robot.id];
  const swap = await call('PATCH', `/api/projects/${kilo.id}/entities`, { ids, names: { [opening.id]: 'char-robot', [robot.id]: 'opening' }, tiers: { [robot.id]: 'shot' } });
  assert.equal(swap.status, 200);
  const named = (id) => swap.body.entities.find((e) => e.id === id);
  assert.deepEqual([named(opening.id).name, named(opening.id).tier, named(robot.id).name, named(robot.id).tier], ['char-robot', 'asset', 'opening', 'shot']);
  assert.equal((await call('PATCH', `/api/projects/${kilo.id}/entities`, { ids, names: { [opening.id]: 'set-kitchen' } })).status, 409, 'another has that name');
  assert.equal((await call('PATCH', `/api/projects/${kilo.id}/entities`, { ids, names: { [opening.id]: 'x', [robot.id]: 'x' } })).status, 409, 'two would share it');
  assert.equal((await call('PATCH', `/api/projects/${kilo.id}/entities`, { ids, names: { [kitchen.id]: 'y' } })).status, 400, 'only what is picked');
  assert.equal((await call('GET', `/api/entities/${opening.id}`)).body.entity.name, 'char-robot', 'refused changes change nothing');
});

test('without a key Claude is off, and the pages are told', async (t) => {
  const s = start(4892, { ANTHROPIC_API_KEY: '' });
  t.after(s.stop);
  await s.ready;
  assert.equal((await (await fetch(`${s.base}/api/me`)).json()).ai, null);
  const kilo = await (await fetch(`${s.base}/api/folders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Kilo' }) })).json();
  await fetch(`${s.base}/api/folders/${kilo.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: true }) });
  const res = await fetch(`${s.base}/api/projects/${kilo.id}/ai/files`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ files: [{ key: '0', filename: 'a.mov' }] }) });
  assert.equal(res.status, 503);
});

// ---------------------------------------------------------------- presenting a project

test('a project is presented through a link of its presenter: live only while they present, showing only what they show', async (t) => {
  const WebSocket = require('ws');
  const port = 4931;
  const s = start(port, { AUTH_MODE: 'password', SITE_PASSWORD: 'team-secret' });
  t.after(s.stop);
  await s.ready;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const login = async (name) => {
    const res = await fetch(`${s.base}/auth/password`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, password: 'team-secret' }) });
    return res.headers.get('set-cookie').split(';')[0];
  };
  const anna = await login('Anna');
  const ben = await login('Ben');
  const call = async (cookie, method, p, body) => {
    const res = await fetch(s.base + p, { method, headers: { ...(cookie && { cookie }), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
  };
  const upload = async (name) => (await (await fetch(`${s.base}/api/upload?name=${name}&uid=up${name.replace(/\W/g, '')}&offset=0&done=1`, { method: 'POST', headers: { cookie: anna }, body: crypto.randomBytes(2000) })).json()).url;
  const open = (query, cookie, hello) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?${query}`, { headers: cookie ? { cookie } : {} });
    const conn = { ws, seen: [], closed: null };
    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'hello', ...hello }));
      setTimeout(() => resolve(conn), 250);
    });
    ws.on('message', (raw) => conn.seen.push(JSON.parse(raw)));
    ws.on('error', reject);
    ws.on('close', (code) => { conn.closed = code; });
  });
  const last = (conn, type) => conn.seen.filter((m) => m.t === type).pop();

  // A project with two shots filed, and a board in it with a picture on it.
  const kilo = (await call(anna, 'POST', '/api/folders', { name: 'Kilo' })).body;
  await call(anna, 'PATCH', `/api/folders/${kilo.id}`, { project: true });
  const board = (await call(anna, 'POST', '/api/boards', { name: 'Standup', folderId: kilo.id })).body;
  const [a, b, c] = [await upload('a.webm'), await upload('b.webm'), await upload('c.png')];
  await call(anna, 'POST', `/api/projects/${kilo.id}/versions`, { files: [
    { look: { type: 'video', src: a, nw: 640, nh: 360, name: 'a.webm' }, entity: { name: 'kilo-0010', tier: 'shot' }, task: 'anim' },
    { look: { type: 'video', src: b, nw: 640, nh: 360, name: 'b.webm' }, entity: { name: 'kilo-0020', tier: 'shot' }, task: 'anim' },
  ] });
  const shots = (await call(anna, 'GET', `/api/projects/${kilo.id}`)).body.entities;
  const e10 = shots.find((e) => e.name === 'kilo-0010');
  const e20 = shots.find((e) => e.name === 'kilo-0020');
  const v10 = (await call(anna, 'GET', `/api/entities/${e10.id}`)).body.versions[0].id;
  const editor = await open(`board=${board.id}`, anna, {});
  editor.ws.send(JSON.stringify({ t: 'op', ops: [{ t: 'add', item: { id: 'picture1', type: 'image', x: 0, y: 0, w: 100, h: 100, src: c } }] }));
  await wait(200);

  // One link per person per project, the same each time it is asked for.
  assert.deepEqual((await call(anna, 'GET', `/api/projects/${kilo.id}/present`)).body, { token: null });
  const made = (await call(anna, 'POST', `/api/projects/${kilo.id}/present`, {})).body;
  assert.match(made.token, /^[\w-]{20,}$/);
  assert.equal(made.access, 'view');
  assert.equal(made.live, false);
  assert.equal((await call(anna, 'POST', `/api/projects/${kilo.id}/present`, {})).body.token, made.token);
  assert.equal((await call(anna, 'GET', `/api/projects/${kilo.id}/present`)).body.token, made.token);
  assert.deepEqual((await call(ben, 'GET', `/api/projects/${kilo.id}/present`)).body, { token: null }, "Anna's is hers");
  assert.equal((await call(null, 'GET', `/api/projects/${kilo.id}/present`)).status, 401);
  const token = made.token;

  // The link needs no sign-in: its page (which lets the browser load what is shown), and what it is.
  const page = await call(null, 'GET', `/p/${token}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('set-cookie'), /wb_watch=/);
  assert.deepEqual((await call(null, 'GET', `/api/watch/${token}`)).body, { project: { name: 'Kilo' }, presenter: { name: 'Anna', color: '#888888' }, access: 'view', live: false });
  assert.equal((await call(null, 'GET', '/api/watch/notarealtokenvalue000')).status, 404);
  const watching = `wb_watch=${token}`;
  const file = async (src, cookie = watching) => (await fetch(s.base + src, { headers: { cookie } })).status;

  // Somebody watching before it is live waits, and can load nothing.
  const carla = await open(`watch=${token}`, null, { name: 'Carla' });
  assert.equal(last(carla, 'init').live, false);
  assert.equal(last(carla, 'init').scene, null);
  assert.equal(await file(a), 401);
  assert.equal((await call(null, 'GET', `/api/watch/${token}/entity/${e10.id}`)).status, 404);

  // Nobody else presents through Anna's link.
  const benHost = await open(`present=${token}`, ben, { name: 'Ben' });
  await wait(100);
  assert.equal(benHost.closed, 4003);

  // Anna presents: those watching are told, and she sees who they are.
  const host = await open(`present=${token}`, anna, { name: 'Anna' });
  assert.equal(last(carla, 'live').presenter.name, 'Anna');
  assert.deepEqual(last(host, 'watchers').list.map((w) => w.name), ['Carla']);
  assert.equal(last(host, 'watchers').list[0].cache, null, 'nothing said about the cache yet');

  // She sees how much of what is shown Carla has cached, cleaned of anything else.
  carla.ws.send(JSON.stringify({ t: 'cache', k: 0.456, v: [1, 3], m: 0.2, off: 'data', evil: 'x' }));
  await wait(150);
  assert.deepEqual(last(host, 'watchers').list[0].cache, { k: 0.456, v: [1, 3], m: 0.2, off: 'data' });
  carla.ws.send(JSON.stringify({ t: 'cache', k: 7, v: [9, 3], m: 'x', off: 'because' }));
  await wait(150);
  assert.deepEqual(last(host, 'watchers').list[0].cache, { k: 1, v: [3, 3], m: null, off: null });
  carla.ws.send(JSON.stringify({ t: 'cache', k: 'lots' }));
  await wait(150);
  assert.equal(last(host, 'watchers').list[0].cache, null);
  carla.ws.send(JSON.stringify({ t: 'cache', k: 1, v: [2, 2], m: null, off: null }));
  await wait(150);
  assert.equal(last(host, 'watchers').list[0].cache.k, 1);
  assert.deepEqual((await call(ben, 'GET', '/api/library')).body.presenting.map((p) => [p.projectId, p.name, p.token]), [[kilo.id, 'Anna', token]], 'the team sees who presents');

  // She opens a shot's versions: those watching are shown it, and only it.
  host.ws.send(JSON.stringify({ t: 'scene', scene: { k: 'entity', entity: e10.id, view: '' }, p: { f: v10, m: [v10, 1.5, 1], evil: 'x' } }));
  await wait(200);
  const scene = last(carla, 'scene');
  assert.deepEqual(scene.scene, { k: 'entity', entity: e10.id, view: '' });
  assert.deepEqual(scene.p, { f: v10, m: [v10, 1.5, 1] });
  assert.deepEqual(last(host, 'watchers').list[0].cache, { wait: true }, 'a new scene: what they had cached was for the one before');
  const shown = await call(null, 'GET', `/api/watch/${token}/entity/${e10.id}`);
  assert.equal(shown.status, 200);
  assert.deepEqual(shown.body.versions.map((v) => v.label), ['kilo-0010 anim v1']);
  assert.equal(shown.body.versions[0].look.src, a);
  assert.equal((await call(null, 'GET', `/api/watch/${token}/entity/${e20.id}`)).status, 404, 'not shown');
  assert.equal(await file(a), 200);
  assert.equal(await file(b), 401);
  assert.equal(await file(c), 401);
  assert.equal(await file(a, 'wb_watch=notarealtokenvalue000'), 401);

  // What the player does reaches them, and nothing it should not.
  host.ws.send(JSON.stringify({ t: 'p', p: { t: 'thread01', z: [500, 280, 2], x: 'light-b', name: 'Boss', s: ['x'] } }));
  host.ws.send(JSON.stringify({ t: 'laser', on: v10, pts: [1, 2, 3, 4] }));
  await wait(200);
  assert.deepEqual(last(carla, 'p').p, { t: 'thread01', z: [500, 280, 2], x: 'light-b' });
  assert.deepEqual(last(carla, 'laser').pts, [1, 2, 3, 4]);
  // Another tab of hers, left open, says nothing to anyone.
  const otherTab = await open(`present=${token}`, anna, { name: 'Anna' });
  otherTab.ws.send(JSON.stringify({ t: 'p', p: { f: 'elsewhere' } }));
  await wait(150);
  assert.notEqual(last(carla, 'p').p.f, 'elsewhere');
  otherTab.ws.close();

  // The timeline: its shots can be loaded, as it plays them.
  host.ws.send(JSON.stringify({ t: 'scene', scene: { k: 'run', seq: '', task: '', empty: true, view: '' } }));
  await wait(150);
  const run = await call(null, 'GET', `/api/watch/${token}/timeline`);
  assert.equal(run.status, 200);
  assert.deepEqual(run.body.shots.map((x) => x.version && x.version.label), ['kilo-0010 anim v1', 'kilo-0020 anim v1']);
  assert.equal(await file(b), 200);
  assert.equal((await call(null, 'GET', `/api/watch/${token}/timeline?task=comp`)).status, 404, 'not the one shown');

  // The board: watched through the link, following her own peer on it.
  editor.ws.send(JSON.stringify({ t: 'lead', present: token }));
  host.ws.send(JSON.stringify({ t: 'scene', scene: { k: 'board', board: board.id } }));
  await wait(150);
  assert.deepEqual(last(carla, 'scene').scene, { k: 'board', board: board.id });
  assert.equal(await file(c), 200);
  const onBoard = await open(`watch=${token}&board=${board.id}`, null, { name: 'Carla' });
  const boardInit = last(onBoard, 'init');
  assert.deepEqual(boardInit.items.map((i) => i.id), ['picture1']);
  assert.ok(boardInit.lead);
  assert.equal(boardInit.peers.find((p) => p.name === 'Anna').lead, boardInit.lead);
  // ...and seen by the team as a pointer, unable to change anything.
  onBoard.ws.send(JSON.stringify({ t: 'op', ops: [{ t: 'del', ids: ['picture1'] }] }));
  await wait(150);
  assert.ok(!editor.seen.some((m) => m.t === 'op' && m.from));
  // A board never shown cannot be watched through it.
  const other = (await call(anna, 'POST', '/api/boards', { name: 'Secret', folderId: kilo.id })).body;
  await assert.rejects(open(`watch=${token}&board=${other.id}`, null, { name: 'Carla' }));
  // Something outside the project is shown as nothing.
  const elsewhere = (await call(anna, 'POST', '/api/boards', { name: 'Elsewhere' })).body;
  host.ws.send(JSON.stringify({ t: 'scene', scene: { k: 'board', board: elsewhere.id } }));
  await wait(150);
  assert.deepEqual(last(carla, 'scene').scene, { k: 'idle' });

  // Stopping: those watching are told, the board watched through it closes, and nothing more loads.
  host.ws.send(JSON.stringify({ t: 'end' }));
  await wait(200);
  assert.ok(last(carla, 'ended'));
  assert.equal(onBoard.closed, 4007);
  assert.equal(await file(a), 401);
  assert.equal((await call(null, 'GET', `/api/watch/${token}`)).body.live, false);

  // Changing what it shows is said at once; a new link stops the old one for whoever has it.
  assert.equal((await call(anna, 'PATCH', `/api/projects/${kilo.id}/present`, { access: 'comments' })).body.access, 'comments');
  await wait(100);
  assert.equal(last(carla, 'access').access, 'comments');
  const fresh = (await call(anna, 'POST', `/api/projects/${kilo.id}/present/reset`, {})).body;
  assert.notEqual(fresh.token, token);
  assert.equal(fresh.access, 'comments');
  await wait(150);
  assert.equal(carla.closed, 4005);
  assert.equal(host.closed, 4005);
  assert.equal((await call(null, 'GET', `/api/watch/${token}`)).status, 404);
  assert.equal((await call(null, 'GET', `/api/watch/${fresh.token}`)).status, 200);
  assert.deepEqual((await call(anna, 'DELETE', `/api/projects/${kilo.id}/present`)).body, { token: null });
  assert.equal((await call(null, 'GET', `/api/watch/${fresh.token}`)).status, 404);
  assert.equal((await call(null, 'GET', `/p/${fresh.token}`)).headers.get('set-cookie'), null);
  editor.ws.close();
});

test("on a board in a project with a model of its venue, a catalogued piece that has the model's view can be seen on it", async (t) => {
  const WebSocket = require('ws');
  const port = 4932;
  const s = start(port);
  t.after(s.stop);
  await s.ready;
  const call = async (method, p, body) => {
    const res = await fetch(s.base + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const upload = async (name) => (await (await fetch(`${s.base}/api/upload?name=${name}&uid=up${name.replace(/\W/g, '')}&offset=0&done=1`, { method: 'POST', body: crypto.randomBytes(2000) })).json()).url;
  const open = (query) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?${query}`);
    const conn = { ws, seen: [] };
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', name: 'Anna' })));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      conn.seen.push(msg);
      if (msg.t === 'init') resolve(conn);
    });
    ws.on('error', reject);
  });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const kilo = (await call('POST', '/api/folders', { name: 'Kilo' })).body;
  await call('PATCH', `/api/folders/${kilo.id}`, { project: true });
  await call('PATCH', `/api/folders/${kilo.id}`, { settings: { views: ['cmp', 'bty'] } });
  const board = (await call('POST', '/api/boards', { name: 'Review', folderId: kilo.id })).body;
  const [cmp, bty, other, model] = [await upload('cmp.webm'), await upload('bty.webm'), await upload('other.webm'), await upload('venue.glb')];
  const look = (src, name) => ({ type: 'video', src, nw: 1920, nh: 1080, name });
  // kilo-0010 v1 in two views, cmp and bty; kilo-0020 v1 in bty only.
  await call('POST', `/api/projects/${kilo.id}/versions`, { files: [
    { look: look(cmp, 'kilo-0010_comp_v001_cmp.webm'), entity: { name: 'kilo-0010', tier: 'shot' }, task: 'comp', number: 1, view: 'cmp' },
    { look: look(bty, 'kilo-0010_comp_v001_bty.webm'), entity: { name: 'kilo-0010', tier: 'shot' }, task: 'comp', number: 1, view: 'bty' },
    { look: look(other, 'kilo-0020_comp_v001_bty.webm'), entity: { name: 'kilo-0020', tier: 'shot' }, task: 'comp', number: 1, view: 'bty' },
  ] });
  const shots = (await call('GET', `/api/projects/${kilo.id}`)).body.entities;
  const versionOf = async (name) => (await call('GET', `/api/entities/${shots.find((e) => e.name === name).id}`)).body.versions[0];
  const [v10, v20] = [await versionOf('kilo-0010'), await versionOf('kilo-0020')];
  assert.deepEqual(v10.look.views.map((x) => x.view), ['bty']);

  // Without a model, nothing is said of 3D.
  await call('POST', `/api/projects/${kilo.id}/place`, { board: board.id, versions: [v10.id, v20.id] });
  const before = await open(`board=${board.id}`);
  const init0 = before.seen.find((m) => m.t === 'init');
  assert.equal(init0.view3d, null);
  assert.ok(init0.versions.every((v) => !v.look3d));

  // With one that shows the cmp view, the board is told so, and kilo-0010 is seen in its cmp view; kilo-0020,
  // which has none, is not seen in 3D.
  await call('PATCH', `/api/folders/${kilo.id}`, { settings: { preview3d: { model, screen: 'screen', view: 'cmp' } } });
  await wait(150);
  const told = before.seen.find((m) => m.t === 'view3d');
  assert.equal(told.view3d.model, model);
  assert.equal(told.view3d.view, 'cmp');
  const byId = (list) => Object.fromEntries(list.map((v) => [v.id, v]));
  assert.equal(byId(told.versions)[v10.id].look3d.src, cmp);
  // (The main view's file is the version's own, named by the project: it carries no view of its own.)
  assert.equal(byId(told.versions)[v10.id].look3d.view, undefined);
  assert.equal(byId(told.versions)[v20.id].look3d, undefined);
  const after = await open(`board=${board.id}`);
  const init1 = after.seen.find((m) => m.t === 'init');
  assert.equal(init1.view3d.key, kilo.id);
  assert.equal(byId(init1.versions)[v10.id].look3d.src, cmp);

  // A project whose model takes the main view shows every catalogued picture and video in it.
  await call('PATCH', `/api/folders/${kilo.id}`, { settings: { preview3d: { model, screen: 'screen', view: '' } } });
  await wait(150);
  const main = byId(before.seen.filter((m) => m.t === 'view3d').pop().versions);
  assert.equal(main[v20.id].look3d.src, other);

  // How the open piece is seen in 3D goes to whoever follows, and nothing that is not its shape.
  before.ws.send(JSON.stringify({ t: 'p', p: { d: { on: 1, c: 1, junk: 'x' } } }));
  before.ws.send(JSON.stringify({ t: 'p', p: { d: { on: 1, f: { p: [0, 1, 2], q: [0, 0, 0, 1], fov: 50 } } } }));
  await wait(150);
  const seen = after.seen.filter((m) => m.t === 'p').map((m) => m.p.d);
  assert.deepEqual(seen, [{ on: 1, c: 1 }, { on: 1, f: { p: [0, 1, 2], q: [0, 0, 0, 1], fov: 50 } }]);
  before.ws.close();
  after.ws.close();
});

test('a video is given a phone copy by one browser, and it is put everywhere the video is shown', async (t) => {
  const WebSocket = require('ws');
  const port = 4933;
  const s = start(port);
  t.after(s.stop);
  await s.ready;
  const call = async (method, p, body) => {
    const res = await fetch(s.base + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const upload = async (name, size) => (await (await fetch(`${s.base}/api/upload?name=${name}&uid=up${name.replace(/\W/g, '')}&offset=0&done=1`, { method: 'POST', body: crypto.randomBytes(size) })).json()).url;
  const kilo = (await call('POST', '/api/folders', { name: 'Kilo' })).body;
  await call('PATCH', `/api/folders/${kilo.id}`, { project: true });
  const board = (await call('POST', '/api/boards', { name: 'Review', folderId: kilo.id })).body;
  const [review, phone, bigger, light] = [await upload('review.webm', 50000), await upload('phone.webm', 9000), await upload('bigger.webm', 60000), await upload('light.webm', 4000)];
  await call('POST', `/api/projects/${kilo.id}/versions`, { files: [{ look: { type: 'video', src: review, nw: 1920, nh: 1080, name: 'a.webm' }, entity: { name: 'kilo-0010', tier: 'shot' }, task: 'anim' }] });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?board=${board.id}`);
  const seen = [];
  await new Promise((resolve) => {
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', name: 'Anna' })));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      seen.push(msg);
      if (msg.t === 'init') resolve();
    });
  });
  t.after(() => ws.close());
  ws.send(JSON.stringify({ t: 'op', ops: [
    { t: 'add', item: { id: 'videoone', type: 'video', x: 0, y: 0, w: 100, h: 56, src: review } },
    { t: 'add', item: { id: 'videotwo', type: 'video', x: 200, y: 0, w: 100, h: 56, src: review } },
  ] }));
  await new Promise((r) => setTimeout(r, 200));

  // One browser at a time makes it.
  assert.deepEqual((await call('POST', '/api/phone-copy/claim', { src: review })).body, { go: true });
  assert.deepEqual((await call('POST', '/api/phone-copy/claim', { src: review })).body, { busy: true });
  assert.equal((await call('POST', '/api/phone-copy/claim', { src: '/uploads/nothere.webm' })).status, 404);
  // Only ever a lighter file than the review copy.
  assert.equal((await call('POST', '/api/phone-copy', { src: review, lo: bigger })).status, 400);
  const done = (await call('POST', '/api/phone-copy', { src: review, lo: phone })).body;
  assert.deepEqual(done, { lo: phone, pieces: 2, versions: 1 });
  // Everybody on the board is told, and the version has it.
  await new Promise((r) => setTimeout(r, 150));
  const told = seen.filter((m) => m.t === 'op' && m.from === null).flatMap((m) => m.ops);
  assert.deepEqual(told.map((op) => [op.id, op.patch.lo]).sort(), [['videoone', phone], ['videotwo', phone]]);
  const shot = (await call('GET', `/api/projects/${kilo.id}`)).body.entities[0];
  assert.equal((await call('GET', `/api/entities/${shot.id}`)).body.versions[0].look.lo, phone);
  // Asked again (the same file put on another board, say), it is there already, and put there too.
  ws.send(JSON.stringify({ t: 'op', ops: [{ t: 'add', item: { id: 'videothree', type: 'video', x: 400, y: 0, w: 100, h: 56, src: review } }] }));
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual((await call('POST', '/api/phone-copy/claim', { src: review })).body, { lo: phone, pieces: 1, versions: 0 });
  // A review copy as light as a phone copy is its own.
  assert.deepEqual((await call('POST', '/api/phone-copy/claim', { src: light })).body, { go: true });
  assert.equal((await call('POST', '/api/phone-copy', { src: light, lo: light })).body.lo, light);
});

test('a playlist holds some of a project\'s versions in an order, which can be changed, and only its own', async (t) => {
  const s = start(4899);
  t.after(s.stop);
  await s.ready;
  const json = { 'content-type': 'application/json' };
  const call = async (method, url, body) => {
    const res = await fetch(s.base + url, { method, headers: json, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const project = (await call('POST', '/api/folders', { name: 'Kilo' })).body;
  await call('PATCH', `/api/folders/${project.id}`, { project: true });
  const other = (await call('POST', '/api/folders', { name: 'Lima' })).body;
  await call('PATCH', `/api/folders/${other.id}`, { project: true });
  const up = async (name) => (await (await fetch(`${s.base}/api/upload?name=${name}`, { method: 'POST', body: crypto.randomBytes(400) })).json()).url;
  const file = async (p, name) => (await call('POST', `/api/projects/${p.id}/versions`, { files: [{ look: { type: 'image', src: await up('a.png'), name } }] })).body.versions[0];
  const a = await file(project, 'kilo-0010_comp_v001.png');
  const b = await file(project, 'kilo-0020_comp_v001.png');
  const c = await file(project, 'kilo-0030_comp_v001.png');
  const theirs = await file(other, 'lima-0010_comp_v001.png');

  // the Versions page asks for a page of them at a time, and is told how many there are and what to filter by
  const page2 = (await call('GET', `/api/projects/${project.id}/versions?find=1&sort=name&limit=2&offset=2`)).body;
  assert.deepEqual([page2.versions.map((v) => v.label), page2.total, page2.more], [['kilo-0030 comp v1'], 3, false]);
  assert.ok(page2.facets);

  // made with some versions; one of another project, and one given twice, are left out
  assert.equal((await call('POST', `/api/projects/${project.id}/playlists`, { name: '  ' })).status, 400);
  const made = await call('POST', `/api/projects/${project.id}/playlists`, { name: 'Dailies', versions: [b.id, a.id, b.id, theirs.id], by: 'Anna' });
  assert.equal(made.status, 200);
  assert.equal(made.body.count, 2);
  const id = made.body.id;
  const order = async () => (await call('GET', `/api/playlists/${id}`)).body.versions.map((v) => v.label);
  assert.deepEqual(await order(), ['kilo-0020 comp v1', 'kilo-0010 comp v1']);
  // each is whole, as the player plays it
  assert.equal((await call('GET', `/api/playlists/${id}`)).body.versions[0].look.name, 'kilo-0020_comp_v001.png');

  // more put at the end, what it has already stays where it is
  await call('PATCH', `/api/playlists/${id}`, { add: [a.id, c.id] });
  assert.deepEqual(await order(), ['kilo-0020 comp v1', 'kilo-0010 comp v1', 'kilo-0030 comp v1']);
  // moved and taken off by giving the list anew
  await call('PATCH', `/api/playlists/${id}`, { versions: [c.id, b.id] });
  assert.deepEqual(await order(), ['kilo-0030 comp v1', 'kilo-0020 comp v1']);
  // renamed; the project lists it, with how many it has
  assert.equal((await call('PATCH', `/api/playlists/${id}`, { name: '' })).status, 400);
  await call('PATCH', `/api/playlists/${id}`, { name: 'Dailies Tuesday' });
  const listed = (await call('GET', `/api/projects/${project.id}/playlists`)).body.playlists;
  assert.deepEqual(listed.map((p) => [p.name, p.count, p.createdBy]), [['Dailies Tuesday', 2, 'Anna']]);
  assert.deepEqual((await call('GET', `/api/projects/${project.id}`)).body.playlists.map((p) => p.name), ['Dailies Tuesday']);
  assert.deepEqual((await call('GET', `/api/projects/${other.id}/playlists`)).body.playlists, []);

  // a version deleted since is left out
  await call('DELETE', `/api/versions/${c.id}`);
  assert.deepEqual(await order(), ['kilo-0020 comp v1']);

  // made from a board of the project: the versions it shows, in the order it reads (rows, then left to right)
  const board = (await call('POST', '/api/boards', { name: 'Standup', folderId: project.id })).body;
  const anna = await joiner(4899)(`board=${board.id}`, 'Anna');
  t.after(() => anna.ws.close());
  anna.ws.send(JSON.stringify({ t: 'op', ops: [
    { t: 'add', item: { id: 'piece0001', type: 'image', x: 600, y: 0, w: 400, h: 200, src: a.look.src, ver: a.id } },
    { t: 'add', item: { id: 'piece0002', type: 'image', x: 0, y: 20, w: 400, h: 200, src: b.look.src, ver: b.id } },
    { t: 'add', item: { id: 'piece0003', type: 'image', x: 0, y: 500, w: 400, h: 200, src: a.look.src, ver: a.id } },
    { t: 'add', item: { id: 'piece0004', type: 'image', x: 0, y: 900, w: 400, h: 200, src: a.look.src } },
  ] }));
  await pause(300);
  const fromBoard = await call('POST', `/api/projects/${project.id}/playlists`, { name: 'From the standup', board: board.id });
  assert.equal(fromBoard.status, 200);
  assert.deepEqual((await call('GET', `/api/playlists/${fromBoard.body.id}`)).body.versions.map((v) => v.label), ['kilo-0020 comp v1', 'kilo-0010 comp v1']);
  const empty = (await call('POST', '/api/boards', { name: 'Empty', folderId: project.id })).body;
  assert.equal((await call('POST', `/api/projects/${project.id}/playlists`, { name: 'Nothing', board: empty.id })).status, 400);

  // deleted, and its versions are still there
  assert.equal((await call('DELETE', `/api/playlists/${id}`)).status, 200);
  assert.equal((await call('GET', `/api/playlists/${id}`)).status, 404);
  assert.equal((await call('GET', `/api/versions/${b.id}`)).status, 200);
});

test('a project puts its sequences in the order it is given, and those it does not name after them by name', async (t) => {
  const s = start(4900);
  t.after(s.stop);
  await s.ready;
  const json = { 'content-type': 'application/json' };
  const call = async (method, url, body) => {
    const res = await fetch(s.base + url, { method, headers: json, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const project = (await call('POST', '/api/folders', { name: 'Haus' })).body;
  await call('PATCH', `/api/folders/${project.id}`, { project: true });
  await call('POST', `/api/projects/${project.id}/entities`, { names: ['elec-0010', 'haus-0020', 'kine-0010', 'haus-0010', 'zulu-0010', 'char-rock'] });
  const seqs = async () => [...new Set((await call('GET', `/api/projects/${project.id}/timeline`)).body.shots.map((x) => x.name))];
  // without an order, by name
  assert.deepEqual(await seqs(), ['elec-0010', 'haus-0010', 'haus-0020', 'kine-0010', 'zulu-0010']);
  // in the order given; one it does not name (zulu) after, and a name that is no sequence is left out
  const set = await call('PATCH', `/api/folders/${project.id}`, { settings: { seqs: ['kine', 'haus', 'elec', 'Not One', 'kine'] } });
  assert.equal(set.status, 200);
  assert.deepEqual(set.body.settings.seqs, ['kine', 'haus', 'elec']);
  assert.deepEqual(await seqs(), ['kine-0010', 'haus-0010', 'haus-0020', 'elec-0010', 'zulu-0010']);
  assert.deepEqual((await call('GET', `/api/projects/${project.id}/versions?find=1`)).body.facets.seqs, ['kine', 'haus', 'elec', 'zulu']);
  // an empty order goes back to by name
  await call('PATCH', `/api/folders/${project.id}`, { settings: { seqs: [] } });
  assert.deepEqual(await seqs(), ['elec-0010', 'haus-0010', 'haus-0020', 'kine-0010', 'zulu-0010']);
});
