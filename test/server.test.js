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
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', WIPBOARD_DATA: data, WIPBOARD_ENV_FILE: path.join(data, 'no.env'), ...env },
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
  assert.deepEqual(me, { auth: 'none', user: null, admin: true, canShare: true, maxUpload: 1024 ** 3, publicUrl: null, signOut: false });
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
  ] }));
  await wait(300);

  const added = reviewer.seen.filter((m) => m.t === 'op').flatMap((m) => m.ops).filter((o) => o.item && o.item.type === 'comment');
  assert.equal(added.length, 2);
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
  const edit = reviewer.seen.filter((m) => m.t === 'op').flatMap((m) => m.ops).find((o) => o.t === 'set' && o.patch.text);
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
    store.saveBoard({ id: 'boardone1', name: 'Secret plans', workspace: 'myreze', shareToken, shareAccess: 'view', createdAt: 1, updatedAt: 1 });
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
  // opening it lets that browser load the board's files, which a stranger still cannot
  const page = await get(`/s/${shareToken}`);
  assert.match(page.headers.get('set-cookie'), /wb_view=/);
  assert.notEqual((await get('/uploads/abc.png', { headers: { cookie: `wb_view=${shareToken}` } })).status, 401);
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
    env: { ...process.env, PORT: '4814', HOST: '127.0.0.1', WIPBOARD_DATA: data, WIPBOARD_ENV_FILE: path.join(data, 'no.env') },
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
  // Ben deletes it, then undoes: his browser sends the comment back, and the server must not make it his
  ben.ws.send(JSON.stringify({ t: 'op', ops: [{ t: 'del', ids: ['comment01'] }] }));
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
  const s = start(4835, { WIPBOARD_VERSION_MS: '250' });
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
  const versions = async () => (await (await fetch(`${s.base}/api/boards/${board.id}/activity`)).json()).versions;

  ops(anna, [{ t: 'add', item: note('noteone01', 'first') }]);
  await pause(150);
  assert.deepEqual(await versions(), []); // there was nothing on it to keep
  await pause(300);
  ops(anna, [{ t: 'add', item: note('notetwo01', 'second') }]);
  ops(anna, [{ t: 'set', id: 'notetwo01', patch: { x: 9 } }]); // the same round
  await pause(400);
  ops(ben, [{ t: 'del', ids: ['noteone01'] }]);
  await pause(150);
  let kept = await versions();
  assert.deepEqual(kept.map((v) => [v.who, v.count]), [['Ben', 2], ['Anna', 1]]);

  // Back to the oldest: one note. Everybody on the board is given it afresh, without themselves among the others.
  const before = [anna.seen.length, ben.seen.length];
  const put = await fetch(`${s.base}/api/boards/${board.id}/versions/${kept[1].at}/restore`, { method: 'POST', headers: json, body: JSON.stringify({ by: 'Anna' }) });
  assert.equal(put.status, 200);
  await pause(150);
  for (const [conn, from] of [[anna, before[0]], [ben, before[1]]]) {
    const init = conn.seen.slice(from).find((m) => m.t === 'init');
    assert.deepEqual(init.items.map((it) => [it.id, it.text]), [['noteone01', 'first']]);
    assert.equal(init.peers.length, 1);
    assert.notEqual(init.peers[0].id, init.you);
  }
  // Somebody arriving later finds the same, and what was replaced was kept, so it can be had back too.
  const carla = await open(`board=${board.id}`, 'Carla');
  t.after(() => carla.ws.close());
  assert.deepEqual(carla.seen.find((m) => m.t === 'init').items.map((it) => it.id), ['noteone01']);
  kept = await versions();
  assert.deepEqual(kept.map((v) => [v.who, v.count]), [['Anna', 1], ['Ben', 2], ['Anna', 1]]);
  await fetch(`${s.base}/api/boards/${board.id}/versions/${kept[0].at}/restore`, { method: 'POST', headers: json, body: JSON.stringify({ by: 'Ben' }) });
  await pause(150);
  assert.deepEqual(anna.seen.filter((m) => m.t === 'init').pop().items.map((it) => [it.id, it.x]), [['notetwo01', 9]]);
  const events = (await (await fetch(`${s.base}/api/boards/${board.id}/activity`)).json()).events;
  assert.deepEqual(events.filter((e) => e.what === 'restore').map((e) => e.who).sort(), ['Anna', 'Ben']);
  assert.equal((await fetch(`${s.base}/api/boards/${board.id}/versions/12345/restore`, { method: 'POST', headers: json, body: '{}' })).status, 404);
});
