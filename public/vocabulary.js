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
    ['Places', [
      ['home', 'Workspace', 'Myreze, shared by everyone, or your Personal one.'],
      ['folder', 'Folder', 'A place in a workspace for boards, folders and playlists.'],
      ['project', 'Project', 'A folder with a catalogue: its entities and their versions, its reviews and its activity.'],
    ]],
    ['What a project makes', [
      ['catalogue', 'Catalogue', 'Every entity a project has.'],
      ['film', 'Sequence', 'Shots that go together, named by the start of their names (kilo in kilo-0010).'],
      ['tag', 'Entity', 'What versions are filed under: an asset, a set or a shot. Which of the three is its type.'],
      ['checks', 'Task', 'A stage of the work a version is for: anim, comp, light.'],
      ['stack', 'Version', 'One result filed of an entity and task, counted v1, v2, v3.'],
      ['pick', 'Pass', 'One of a version’s ways of being seen, each its own file (cmp, bty), as the project names them.'],
      ['file', 'Attachment', 'Any other file filed with a version under a label of its own: a full-size still, another lighting.'],
    ]],
    ['Looking at the work', [
      ['boards', 'Review', 'A board, a playlist or an animatic in a project. Its Reviews page lists them.'],
      ['board', 'Board', 'A canvas to lay work out on, with sticky notes, headings, blocks, frames and drawing.'],
      ['playlist', 'Playlist', 'Versions in an order, played one at a time.'],
      ['animatic', 'Animatic', 'Shots cut together on a timeline, each playing its newest version.'],
      ['comment', 'Comment', 'What is said about a piece of work. A reply answers one, and the two are a thread. One may carry a drawing.'],
      ['note', 'Sticky note', 'A note on a board: part of the board, never a comment.'],
      ['activity', 'Activity', 'Everything that happened in a project, from its start. For you is what concerns you.'],
    ]],
    ['People and sharing', [
      ['person', 'Artist, CC', 'Who makes an entity, and who else follows it. Both see what happens to it under For you.'],
      ['people', 'Role, group', 'What somebody may do (viewer, commenter, editor, manager), and people given roles together.'],
      ['link', 'Share link', 'A board opened without signing in: to look, read the comments, or comment.'],
      ['eye', 'Present link', 'Somebody presenting, watched: whoever opens it sees what they show.'],
    ]],
    ['On the venue, in 3D', [
      ['cube', 'Venue', 'The 3D model of where the work is shown.'],
      ['frame', 'Screen', 'Where the work plays on the venue.'],
      ['focus', 'Main camera', 'The camera the 3D view opens through, where the work is judged from.'],
      ['pan', 'Flying', 'Moving freely, once the view leaves a camera.'],
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
        el('span', { text: 'With each version' }),
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
    { id: 'places', label: 'Places', lead: 'Places inside places. Pick one to read what it is.', body: () => figure(places) },
    { id: 'version', label: 'A version', lead: 'A version’s name says what it is. Pick a part of it.', body: () => figure(version) },
    { id: 'reviews', label: 'Reviews', lead: 'Three ways to look at versions together. Pick one to read what it is.', body: () => figure(reviews) },
    { id: 'words', label: 'Every word', lead: 'Each word the app uses, and what it is.', body: () => [words()] },
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
