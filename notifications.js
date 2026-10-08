'use strict';

// What someone is told about on the home page, worked out from the comments themselves rather than
// kept as a separate list. A comment by somebody else is news to you when it
//   mentions you        "@Anna" or "@Anna Berg" anywhere in it
//   replies to you      it is in a thread you wrote in
//   is on your work     it is on something you added to a board
//   is on your board    it is on a board you made
// in that order: each comment is told about once, for the first of these that fits. People are matched
// by name, which behind a sign-in is the name it gives and otherwise the name each person typed.

const DAYS = 30;
const LIMIT = 100;
const KEPT_READ = 500;

const lower = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

function mentions(text, name) {
  const body = lower(text);
  const full = lower(name);
  const first = full.split(/\s+/)[0];
  const at = (n) => {
    if (!n) return false;
    for (let i = body.indexOf(`@${n}`); i >= 0; i = body.indexOf(`@${n}`, i + 1)) {
      const next = body[i + n.length + 1];
      if (!next || !/[\p{L}\p{N}_]/u.test(next)) return true;
    }
    return false;
  };
  return at(full) || (first.length >= 2 && at(first));
}

// `who` is { user, name }: the key their read state is kept under, and the name they comment as.
function noticesFor(store, who, spaces, now = Date.now()) {
  const since = now - DAYS * 864e5;
  const me = lower(who.name);
  const isMe = (name) => lower(name) === me;
  const rows = store.commentsForNotices(spaces, since);

  // Who has written in each thread.
  const threads = new Map();
  for (const r of rows) {
    const key = `${r.board_id}:${r.comment.re || r.comment.id}`;
    if (!threads.has(key)) threads.set(key, new Set());
    threads.get(key).add(lower(r.comment.name));
  }

  const state = store.getState(who.user, 'notices') || { upTo: 0, read: [] };
  const read = new Set(state.read);
  const items = [];
  for (const r of rows) {
    const c = r.comment;
    if (r.created_at <= since || isMe(c.name) || typeof c.text !== 'string') continue;
    let kind = null;
    if (mentions(c.text, who.name)) kind = 'mention';
    else if (c.re && threads.get(`${r.board_id}:${c.re}`).has(me)) kind = 'reply';
    else if (isMe(r.host_by)) kind = 'work';
    else if (isMe(r.board_by)) kind = 'board';
    if (!kind) continue;
    items.push({
      id: c.id,
      kind,
      board: { id: r.board_id, name: r.board_name },
      on: r.host_label || (r.host_type === 'video' ? 'a video' : 'an image'),
      author: c.name,
      color: c.color,
      guest: !!c.guest,
      text: c.text.slice(0, 280),
      at: r.created_at,
      read: r.created_at <= state.upTo || read.has(c.id),
    });
  }
  items.sort((a, b) => b.at - a.at);
  const shown = items.slice(0, LIMIT);
  return { items: shown, unread: shown.filter((n) => !n.read).length };
}

// Marks some as read, or everything up to now.
function markRead(store, who, { ids, all }, now = Date.now()) {
  if (all) return store.setState(who.user, 'notices', { upTo: now, read: [] });
  const state = store.getState(who.user, 'notices') || { upTo: 0, read: [] };
  const add = (Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && id.length <= 40);
  store.setState(who.user, 'notices', { upTo: state.upTo, read: [...new Set([...state.read, ...add])].slice(-KEPT_READ) });
}

module.exports = { noticesFor, markRead, mentions };
