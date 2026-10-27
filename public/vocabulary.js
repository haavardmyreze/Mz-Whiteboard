'use strict';

// The Vocabulary (#/vocabulary): the words the app uses, each for one thing. Four short chapters, one shown at a
// time (#/vocabulary/<chapter>): where things are, what a version's name says, the three kinds of review, and
// every word. The first three are each a picture whose words can be picked; the one picked is said
// beside it, so each word is explained in one place only, WORDS. Each word has the icon it has elsewhere
// in the app. README.md lists the same words ("The words it uses"); a new word goes in both. Loaded
// after icons.js, before home.js.
const WBVocabulary = (() => {
  const { el } = WB;
  const icon = (name, size = 16) => WB.icon(name, size);

  // Every word, by what it is about: its icon, the word, and what it is.
  const WORDS = [
    ['Where things are', [
      ['home', 'Workspace', 'The top level of everything. Myreze is shared by the whole studio. Personal is your own, and nobody else can see what is in it.'],
      ['folder', 'Folder', 'Keeps boards, playlists and other folders together, like a folder on disk. Deleting a folder doesn’t delete what was in it: that moves up a level.'],
      ['project', 'Project', 'A folder for a production. Besides its boards, it keeps a catalogue of everything being made for it and every version delivered. Any folder can become one: Make it a project, in its menu.'],
    ]],
    ['What a project makes', [
      ['catalogue', 'Catalogue', 'The list of everything a project makes: its assets, its sets and its shots, laid out the way the project is on disk. The switch beside its title shows the same place as every version filed of it instead.'],
      ['tag', 'Entity', 'One thing the project makes and delivers versions of: an asset (char-robot), a set (harbour) or a shot (kilo-0010). Which of the three it is, is its type.'],
      ['film', 'Sequence', 'Shots that belong together, like a scene. You don’t make one separately: kilo-0010 and kilo-0020 are in the sequence kilo because their names start with it.'],
      ['checks', 'Task', 'The stage of work a version is for, such as anim, light or comp. Each task counts its own versions, so lookdev can be on v1 while model is on v10. A project that doesn’t work in tasks can turn them off.'],
      ['stack', 'Version', 'One delivery of an entity for a task. Versions count up, v1, v2, v3, and the highest is the newest. You file them from a board (select, then Shift+V) or by dropping files on the catalogue.'],
      ['pick', 'Pass', 'One way of seeing a version, when every version needs more than one. On projection work, say, the flat picture (cmp) and how it looks projected (bty). The project lists its passes in its settings, and each is its own file.'],
      ['file', 'Attachment', 'An extra file that belongs to one version only, under a label you give it: a full-size still to check detail, or the same frame lit another way. Unlike a pass, it isn’t something every version has.'],
    ]],
    ['Looking at work together', [
      ['boards', 'Review', 'Anything the team looks at work in together and gives notes on: a board, a playlist or an animatic. A project lists all of them on its Reviews page.'],
      ['board', 'Board', 'An open canvas. Lay images and videos out freely, add headings, sticky notes and frames, and draw. Good for standups, look development and putting things side by side.'],
      ['playlist', 'Playlist', 'Versions in a set order, played one at a time with notes on each, the way a dailies session goes through them.'],
      ['animatic', 'Animatic', 'An edit of the project’s shots on a timeline. Each clip points at a shot, not a file, so it always plays that shot’s newest version: the cut keeps up as work is filed.'],
      ['comment', 'Comment', 'A note on a picture or a video, written in the player. It can carry a drawing that shows what it means, and replies to it make a thread. A comment on a version stays with it wherever the version is shown.'],
      ['note', 'Sticky note', 'Text placed on a board as part of its layout. It isn’t a comment: it doesn’t belong to any piece of work, only to the board.'],
      ['activity', 'Activity', 'Everything that has happened in a project since it started: versions filed, comments, new playlists and animatics. For you narrows it to what concerns you.'],
    ]],
    ['People and sharing', [
      ['person', 'Artist, CC', 'Set on each entity: the artists who make it, and the people cc’d to follow it. Both see its new versions and comments under For you.'],
      ['people', 'Role, group', 'A role says what someone may do on a folder or a board: view, comment, edit or manage. A group is people who get the same roles. Admins set them up; for now they are recorded but not yet enforced.'],
      ['link', 'Share link', 'A link to one board for someone without an account, such as a client. You choose whether they can only look, also read the comments, or also comment.'],
      ['eye', 'Present link', 'A link to watch you present. Whoever opens it sees exactly what you show, as you show it, and can’t go anywhere else.'],
    ]],
    ['Seeing the work in 3D', [
      ['cube', 'Venue', 'A 3D model of the place the work will be shown, such as a dome or a stage. Add one in a project’s settings to see the work on it.'],
      ['frame', 'Screen', 'The surfaces in the venue that the picture plays on.'],
      ['focus', 'Main camera', 'The camera in the venue model that sees what the audience will see. The 3D view starts there, so the work is judged as it will be seen.'],
      ['pan', 'Flying', 'Moving freely around the venue, with the mouse or W A S D, away from the main camera. The project’s settings set how wide its lens is.'],
    ]],
  ];
  const ABOUT = new Map(WORDS.flatMap(([group, list]) => list.map(([ic, word, say]) => [word, { ic, say, group }])));

  // A chapter's figure: its picture on a plate, and beside it (under it on a narrow window) the word picked
  // in the picture and what it is, as a caption is. `pick(word, text)` is a word in the picture, and
  // `marks(word)` makes anything else stand for it (a place's outline, a bracket, a sketch): picking either
  // lights both. The picture's first word, as it is read, is said to begin with.
  function figure(draw) {
    const say = el('div', { class: 'vc-say', 'aria-live': 'polite' });
    const parts = [];
    const show = (word) => {
      const { ic, say: text, group } = ABOUT.get(word);
      for (const n of parts) {
        const on = n.dataset.word === word;
        n.classList.toggle('on', on);
        if (n.tagName === 'BUTTON') n.setAttribute('aria-pressed', String(on));
      }
      say.replaceChildren(
        el('span', { class: 'vc-say-group', text: group }),
        el('div', { class: 'vc-say-word' }, el('span', { html: icon(ic) }), el('b', { text: word })),
        el('p', { text }));
    };
    const pick = (word, text = word) => {
      const b = el('button', { type: 'button', class: 'vc-pick', 'data-word': word, text, onclick: (e) => { e.stopPropagation(); show(word); } });
      parts.push(b);
      return b;
    };
    const marks = (node, word) => {
      node.dataset.word = word;
      node.addEventListener('click', (e) => { e.stopPropagation(); show(word); });
      parts.push(node);
      return node;
    };
    const picture = draw(pick, marks);
    show(picture.querySelector('[data-word]').dataset.word);
    return [el('div', { class: 'vc-figure' }, el('div', { class: 'vc-plate' }, picture), say)];
  }

  // Where things are: each place an outline around the next, its word in its corner, and a project's three
  // parts side by side in it. Picking a place lights its outline.
  function places(pick, marks) {
    const place = (word, text, cls, ...kids) => marks(el('div', { class: `vc-place ${cls}` }, pick(word, text), ...kids), word);
    return el('div', { class: 'vc-places' },
      place('Workspace', 'Workspace', 'vc-ws',
        place('Folder', 'Folder', 'vc-folder',
          place('Project', 'Project', 'vc-project',
            el('div', { class: 'vc-parts' },
              place('Catalogue', 'Catalogue', 'vc-part'),
              place('Review', 'Reviews', 'vc-part'),
              place('Activity', 'Activity', 'vc-part'))))));
  }

  // A version's name, taken apart: the sequence over its start; the entity, task and count under it, each
  // on a bracket; and what comes with every version beneath.
  function version(pick, marks) {
    const brace = (col, word, at) => marks(el('div', { class: `vc-brace vc-${at}`, style: { gridColumn: col } }, pick(word)), word);
    return el('div', { class: 'vc-version' },
      el('div', { class: 'vc-name' },
        brace('1', 'Sequence', 'over'),
        ...['kilo', '-0010', 'comp', 'v3'].map((t, i) => el('span', { class: 'vc-tok', style: { gridColumn: String([1, 2, 4, 6][i]) }, text: t })),
        brace('1 / 3', 'Entity', 'under'),
        brace('4', 'Task', 'under'),
        brace('6', 'Version', 'under')),
      el('div', { class: 'vc-with' },
        el('span', { text: 'A version can also have' }),
        pick('Pass', 'passes'), pick('Attachment', 'attachments'), pick('Comment', 'comments')));
  }

  // The three kinds of review, each drawn small with its word beneath, as a print is: a board's pieces
  // laid out on its dots, a playlist's versions in order, an animatic's shots on a timeline under the
  // playhead.
  function reviews(pick, marks) {
    const n = (cls, k = 'i') => el(k, { class: cls });
    const sketch = {
      Board: () => [n('h'), n('p a'), n('p b'), n('p c'), n('t a'), n('t b'), n('t c')],
      Playlist: () => [1, 2, 3, 4].map((k) => el('div', { class: 'r' }, el('span', { text: String(k) }), n('th'), n('ln'))),
      Animatic: () => [n('ruler'), el('div', { class: 'track' }, n('s a'), n('s b'), n('s c'), n('s d')), n('ph', 'b')],
    };
    return el('div', { class: 'vc-reviews' }, Object.keys(sketch).map((word) => el('div', { class: 'vc-review' },
      marks(el('div', { class: `vc-sk vc-sk-${word.toLowerCase()}` }, sketch[word]()), word),
      pick(word))));
  }

  // Every word, by what it is about.
  const words = () => el('div', { class: 'vc-all' }, WORDS.map(([group, list]) => el('section', { class: 'vc-group' },
    el('h3', { class: 'vc-group-head', text: group }),
    el('dl', { class: 'vc-words' }, list.flatMap(([ic, word, say]) => [
      el('dt', {}, el('span', { class: 'vc-ic', html: icon(ic) }), word),
      el('dd', { text: say }),
    ])))));

  const CHAPTERS = [
    {
      id: 'places', label: 'Where things are', body: () => figure(places),
      lead: 'Everything you make lives in a workspace, kept in folders. A folder that holds a production becomes a project, which also keeps track of everything being made for it. Click any part of the picture to read what it is.',
    },
    {
      id: 'version', label: 'Versions', body: () => figure(version),
      lead: 'Every piece of work you deliver is filed as a version of something. Its name says exactly what it is: which shot or asset, which stage of the work, and which attempt. Click a part of the name to read about it.',
    },
    {
      id: 'reviews', label: 'Reviews', body: () => figure(reviews),
      lead: 'Reviews are where the team looks at versions together and gives notes. There are three kinds, for three ways of working. Click one to read when it is the right one.',
    },
    {
      id: 'words', label: 'All words', body: () => [words()],
      lead: 'The app uses each of these words for one thing only, on every page. Wherever you see “pass” or “version”, it means what it says here.',
    },
  ];

  // `chapter` is the id after #/vocabulary/, the first chapter if there is none.
  function view(chapter) {
    const i = Math.max(0, CHAPTERS.findIndex((c) => c.id === chapter));
    const c = CHAPTERS[i];
    const next = CHAPTERS[i + 1];
    return [
      el('nav', { class: 'vc-tabs', 'aria-label': 'Chapters' }, CHAPTERS.map((t) => el('a', {
        class: `vc-tab${t === c ? ' on' : ''}`, href: `#/vocabulary/${t.id}`, text: t.label, 'aria-current': t === c ? 'page' : null,
      }))),
      el('p', { class: 'vc-lead', text: c.lead }),
      el('div', { class: 'vc-body' }, ...c.body()),
      next && el('a', { class: 'vc-next', href: `#/vocabulary/${next.id}` }, el('span', { text: `Next: ${next.label}` }), el('span', { html: icon('next', 14) })),
    ];
  }

  return { view };
})();
