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
  const { shareBases, ...me } = await (await fetch(`${s.base}/api/me`)).json();
  assert.deepEqual(me, { auth: 'none', user: null, canShare: true, publicUrl: null, signOut: false });
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

test('comments are stamped with who wrote them, and only ever sit on a piece of content', async (t) => {
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
  ] }));
  await wait(300);

  const added = reviewer.seen.filter((m) => m.t === 'op').flatMap((m) => m.ops).filter((o) => o.item && o.item.type === 'comment');
  assert.equal(added.length, 1);
  const c = added[0].item;
  assert.equal(c.name, 'Anna');
  assert.equal(c.color, '#336699');
  assert.equal(c.text, 'Lovely');
  assert.equal(c.rx, 1);
  assert.equal(c.extra, undefined);

  // the only thing about a comment that can change afterwards is whether it is resolved
  reviewer.ws.send(JSON.stringify({ t: 'op', ops: [{ t: 'set', id: 'comment01', patch: { text: 'rewritten', name: 'Ben', done: true } }] }));
  await wait(300);
  const late = await join('Cara');
  t.after(() => late.ws.close());
  const stored = late.seen.find((m) => m.t === 'init').items.find((i) => i.id === 'comment01');
  assert.equal(stored.text, 'Lovely');
  assert.equal(stored.name, 'Anna');
  assert.equal(stored.done, true);
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
    fs.mkdirSync(path.join(data, 'boards'), { recursive: true });
    fs.writeFileSync(path.join(data, 'boards', 'boardone1.json'), JSON.stringify({ id: 'boardone1', name: 'Secret plans', shareToken, items: [] }));
  });
  t.after(s.stop);
  await s.ready;
  const get = (p, opts) => fetch(s.base + p, { redirect: 'manual', ...opts });

  const home = await get('/');
  assert.equal(home.status, 302);
  assert.match(home.headers.get('location'), /^\/auth\/login\?next=%2F$/);
  assert.equal((await get('/b/boardone1')).status, 302);
  assert.equal((await get('/api/boards')).status, 401);
  assert.equal((await get('/api/library')).status, 401);
  assert.equal((await get('/uploads/abc.png')).status, 401);
  assert.equal((await get('/auth/login')).status, 200);
  assert.equal((await get('/style.css')).status, 200);
  assert.equal((await get('/auth/google')).status, 302);

  // a read-only link needs nothing, tells nothing but the name, and cannot reach the editable board
  assert.equal((await get(`/s/${shareToken}`)).status, 200);
  assert.deepEqual(await (await get(`/api/shared/${shareToken}`)).json(), { name: 'Secret plans' });
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
  viewer.ws.send(JSON.stringify({ t: 'present', on: true }));
  // ...except a pointer and the laser, which reach the editors without anything else the viewer claims
  viewer.ws.send(JSON.stringify({ t: 'p', p: { c: [10, 20], l: 1, s: ['imageone1'], v: [0, 0, 1], name: 'Boss' } }));
  viewer.ws.send(JSON.stringify({ t: 'laser', pts: [1, 2, 3, 4] }));
  await wait(250);
  assert.ok(!editor.seen.some((m) => m.t === 'op' && m.from));
  assert.ok(!editor.seen.some((m) => m.t === 'presenter'));
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
  assert.equal((await get('/api/boards')).status, 401);
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
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
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

  const saved = JSON.parse(fs.readFileSync(path.join(data, 'boards', `${board.id}.json`), 'utf8'));
  assert.deepEqual(saved.items.map((i) => i.text), ['said just in time']);
  const second = run();
  t.after(() => second.kill());
  await up();
  assert.equal((await (await fetch(`${base}/api/boards/${board.id}`)).json()).count, 1);
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
