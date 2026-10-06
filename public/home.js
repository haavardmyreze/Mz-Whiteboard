'use strict';

(async () => {
  const { el, api, ago } = WB;
  const grid = document.getElementById('boards');
  const empty = document.getElementById('empty');
  const meBtn = document.getElementById('me');

  let me = await WB.askName();
  meBtn.textContent = me.name;
  meBtn.addEventListener('click', async () => {
    me = await WB.askName(true);
    meBtn.textContent = me.name;
  });

  function card(board) {
    const thumbs = el('div', { class: `card-thumbs n${Math.min(board.thumbs.length, 4)}` },
      board.thumbs.map((src) => el('img', { src, alt: '', loading: 'lazy' })));
    const details = [
      `${board.count} item${board.count === 1 ? '' : 's'}`,
      `edited ${ago(board.updatedAt)}`,
    ];
    return el('a', { class: 'card', href: `/b/${board.id}` },
      thumbs,
      el('div', { class: 'card-body' },
        el('div', { class: 'card-name', text: board.name }),
        el('div', { class: 'card-meta' },
          details.join(' · '),
          board.online > 0 && el('span', { class: 'card-live', text: `${board.online} here now` }))),
      el('div', { class: 'card-actions' },
        el('button', { class: 'btn small', text: 'Rename', onclick: (e) => rename(e, board) }),
        el('button', { class: 'btn small danger', text: 'Delete', onclick: (e) => remove(e, board) })));
  }

  async function refresh() {
    try {
      const boards = await api('GET', '/api/boards');
      grid.replaceChildren(...boards.map(card));
      empty.hidden = boards.length > 0;
    } catch (err) {
      empty.hidden = false;
      empty.textContent = `Could not load boards: ${err.message}`;
    }
  }

  async function rename(e, board) {
    e.preventDefault();
    const name = await WB.dialog({ title: 'Rename board', value: board.name, placeholder: 'Board name', ok: 'Rename' });
    if (!name || name === board.name) return;
    await api('PATCH', `/api/boards/${board.id}`, { name });
    refresh();
  }

  async function remove(e, board) {
    e.preventDefault();
    const sure = await WB.dialog({
      title: `Delete "${board.name}"?`,
      text: 'It disappears for everyone. The board is moved to the trash folder on the server, so whoever runs the server can still restore it.',
      ok: 'Delete board',
      danger: true,
    });
    if (!sure) return;
    await api('DELETE', `/api/boards/${board.id}`);
    refresh();
  }

  document.getElementById('new').addEventListener('click', async () => {
    const name = await WB.dialog({ title: 'New board', value: `Standup ${new Date().toLocaleDateString()}`, placeholder: 'Board name', ok: 'Create board' });
    if (!name) return;
    const board = await api('POST', '/api/boards', { name });
    location.href = `/b/${board.id}`;
  });

  refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, 15000);
})();
