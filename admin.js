'use strict';

// The admin area: the people who sign in, the groups they are put in, and who may do what with which
// board or folder. This is where all that is kept and managed; none of it changes what anyone can do
// yet. Who gets in is still decided by the sign-in and its allow list, and what people see still follows
// the workspaces. The grants are there for that to be built on.
//
// Admins are people, known by their sign-in email, so the admin area only opens with a sign-in that
// gives one (AUTH_MODE google or iap). The first admins are named by ADMIN_EMAILS; they can make others
// admins here, but cannot be unmade here themselves.

const ROLES = ['viewer', 'commenter', 'editor', 'manager'];
const TARGETS = ['board', 'folder'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// How often someone's "last seen" is written: not on every request.
const SEEN_EVERY = 10 * 60 * 1000;

const list = (value) => String(value || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const emailOf = (value) => {
  const email = String(value ?? '').trim().toLowerCase();
  return email.length <= 254 && EMAIL.test(email) ? email : null;
};
const refusal = (status, message) => Object.assign(new Error(message), { status });

// `targets()` gives the boards and folders grants may be put on: those in the shared workspace. A
// personal workspace stays its owner's alone. `sameOrigin(req)` says whether a request came from our pages.
function createAdmin({ store, adminEmails, newId, readJson, sendJson, cleanName, targets, sameOrigin }) {
  const fixed = new Set(list(adminEmails));
  for (const email of fixed) store.addUser({ email });
  const lastSeen = new Map();

  const isAdmin = (user) => !!(user && user.email) && (fixed.has(user.email) || !!store.user(user.email)?.admin);

  function seen(user) {
    if (!user || !user.email) return;
    const now = Date.now();
    if (now - (lastSeen.get(user.email) || 0) < SEEN_EVERY) return;
    lastSeen.set(user.email, now);
    store.seeUser(user.email, user.name || null, now);
  }

  function overview(me) {
    return {
      me: me.email,
      roles: ROLES,
      users: store.users().map((u) => ({ ...u, admin: u.admin || fixed.has(u.email), fixed: fixed.has(u.email) })),
      groups: store.groups(),
      grants: store.grants(),
      targets: targets(),
    };
  }

  function grantFrom(body, by) {
    const target = body.target || {};
    const principal = body.principal || {};
    if (!ROLES.includes(body.role)) throw refusal(400, `The role must be one of ${ROLES.join(', ')}`);
    if (!TARGETS.includes(target.type)) throw refusal(400, 'Permissions go on a board or a folder');
    const { boards, folders } = targets();
    if (!(target.type === 'board' ? boards : folders).some((t) => t.id === target.id)) {
      throw refusal(400, `No such ${target.type} in the shared workspace`);
    }
    if (principal.type === 'user') {
      if (!store.user(principal.id)) throw refusal(400, 'No such person');
    } else if (principal.type === 'group') {
      if (!store.groups().some((g) => g.id === principal.id)) throw refusal(400, 'No such group');
    } else {
      throw refusal(400, 'Permissions are given to a person or a group');
    }
    return { id: newId(), target: { type: target.type, id: target.id }, principal: { type: principal.type, id: principal.id }, role: body.role, by };
  }

  // Answers /api/admin/...; `parts` is what follows /api/admin. Every change answers with the whole
  // overview again, which is small, so the page simply shows what it is given.
  async function handle(req, res, parts) {
    const me = req.user;
    if (!isAdmin(me)) {
      const why = me && me.email ? 'Only admins can open the admin area' : 'The admin area needs sign-in with Google (AUTH_MODE google or iap)';
      return sendJson(res, 403, { error: why });
    }
    if (req.method !== 'GET' && !sameOrigin(req)) return sendJson(res, 403, { error: 'Not from this site' });
    const [kind, id, sub, subId] = parts.map((p) => decodeURIComponent(p));
    const done = () => sendJson(res, 200, overview(me));

    if (!kind && req.method === 'GET') return done();

    if (kind === 'users') {
      if (!id && req.method === 'POST') {
        const body = await readJson(req);
        const email = emailOf(body.email);
        if (!email) return sendJson(res, 400, { error: 'That is not an email address' });
        if (!store.addUser({ email, name: cleanName(body.name, null), admin: body.admin === true })) {
          return sendJson(res, 409, { error: 'That person is already on the list' });
        }
        return done();
      }
      const email = emailOf(id);
      if (!email || !store.user(email)) return sendJson(res, 404, { error: 'No such person' });
      if (req.method === 'PATCH') {
        const body = await readJson(req);
        if (typeof body.admin === 'boolean') {
          if (!body.admin && fixed.has(email)) return sendJson(res, 400, { error: 'This admin is named in ADMIN_EMAILS; change it there' });
          if (!body.admin && email === me.email) return sendJson(res, 400, { error: 'You cannot take away your own admin rights' });
          store.setAdmin(email, body.admin);
        }
        return done();
      }
      if (req.method === 'DELETE') {
        if (email === me.email) return sendJson(res, 400, { error: 'You cannot remove yourself' });
        store.removeUser(email);
        lastSeen.delete(email);
        return done();
      }
    }

    if (kind === 'groups') {
      if (!id && req.method === 'POST') {
        const body = await readJson(req);
        const name = cleanName(body.name, null);
        if (!name) return sendJson(res, 400, { error: 'A group needs a name' });
        store.addGroup(newId(), name);
        return done();
      }
      if (!store.groups().some((g) => g.id === id)) return sendJson(res, 404, { error: 'No such group' });
      if (!sub && req.method === 'PATCH') {
        const name = cleanName((await readJson(req)).name, null);
        if (!name) return sendJson(res, 400, { error: 'A group needs a name' });
        store.renameGroup(id, name);
        return done();
      }
      if (!sub && req.method === 'DELETE') {
        store.removeGroup(id);
        return done();
      }
      if (sub === 'members' && subId) {
        const email = emailOf(subId);
        if (!email || !store.user(email)) return sendJson(res, 404, { error: 'No such person' });
        if (req.method === 'PUT') store.addMember(id, email);
        else if (req.method === 'DELETE') store.removeMember(id, email);
        else return sendJson(res, 405, { error: 'Method not allowed' });
        return done();
      }
    }

    if (kind === 'grants') {
      if (!id && req.method === 'POST') {
        store.setGrant(grantFrom(await readJson(req), me.email));
        return done();
      }
      if (id && req.method === 'DELETE') {
        if (!store.removeGrant(id)) return sendJson(res, 404, { error: 'No such permission' });
        return done();
      }
    }

    return sendJson(res, 404, { error: 'Not found' });
  }

  return { isAdmin, seen, handle };
}

module.exports = { createAdmin, ROLES };
