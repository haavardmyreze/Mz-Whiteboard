'use strict';

// The Guide (#/guide): the words the app uses, each for one thing, drawn as the app has them. A map of
// where things are (a workspace, its folders, a project and its three parts), a version up close (from a
// sequence down to its passes, attachments and comments), the three kinds of review, and every word with
// what it is. Each word has the icon it has elsewhere in the app. README.md lists the same words ("The
// words it uses"); a new word goes in both. Loaded after icons.js, before home.js.
const WBGuide = (() => {
  const { el } = WB;
  const icon = (name) => WB.icon(name, 16);

  // A word as the Guide draws it: its icon, the word, and an example or a few words under it.
  const term = (ic, word, say, cls = '') => el('div', { class: `gd-term ${cls}`.trim() },
    el('span', { class: 'gd-ic', html: icon(ic) }),
    el('span', { class: 'gd-word' }, el('b', { text: word }), say && el('span', { text: say })));
  const label = (text) => el('div', { class: 'section-label', text });

  // Where things are: places inside places, as tiles (a place keeps a tile), the project's three parts
  // side by side in it.
  function map() {
    const part = (ic, word, say, ...kids) => el('div', { class: 'gd-part' }, term(ic, word, say), ...kids);
    const chips = (...list) => el('div', { class: 'gd-chips' }, list.map(([ic, text]) => el('span', { class: 'gd-chip' }, el('span', { html: icon(ic) }), text)));
    return el('div', { class: 'gd-place gd-ws' },
      term('home', 'Workspace', 'Myreze, shared by everyone, or your Personal one'),
      el('div', { class: 'gd-place gd-folder' },
        term('folder', 'Folder', 'Boards, folders and playlists, kept together'),
        el('div', { class: 'gd-place gd-project' },
          term('project', 'Project', 'A folder with a catalogue'),
          el('div', { class: 'gd-parts' },
            part('catalogue', 'Catalogue', 'Every entity it has',
              chips(['film', 'kilo-0010'], ['film', 'kilo-0020'], ['cube', 'char-robot'], ['set', 'loc-harbour'])),
            part('boards', 'Reviews', 'Where versions are looked at',
              chips(['board', 'Standup'], ['playlist', 'Client review'], ['animatic', 'Cut 3'])),
            part('activity', 'Activity', 'Everything that happened in it',
              chips(['import', 'Filed'], ['comment', 'Commented'], ['playlist', 'Made a playlist']))))));
  }

  // A version up close: from its sequence down to what goes with it, one step to each word.
  function chain() {
    const step = (ic, word, eg, say) => el('li', { class: 'gd-step' },
      el('span', { class: 'gd-ic', html: icon(ic) }),
      el('b', { text: word }),
      el('code', { text: eg }),
      el('span', { text: say }));
    return el('div', { class: 'gd-chain-wrap' },
      el('ol', { class: 'gd-chain' },
        step('film', 'Sequence', 'kilo', 'Shots that go together, by the start of their names'),
        step('tag', 'Entity', 'kilo-0010 · shot', 'An asset, a set or a shot: which of the three is its type'),
        step('checks', 'Task', 'comp', 'A stage of the work: anim, comp, light'),
        step('stack', 'Version', 'kilo-0010 comp v3', 'One result, counted v1, v2, v3')),
      el('div', { class: 'gd-with' },
        el('div', { class: 'gd-with-head', text: 'With a version' }),
        el('div', { class: 'gd-with-list' },
          term('pick', 'Pass', 'cmp, bty: its ways of being seen, each its own file'),
          term('file', 'Attachment', 'light-b, still-1043: any other file, under a label'),
          term('comment', 'Comment', 'What is said about it; a reply makes a thread, and a drawing can go with one'))));
  }

  // The three kinds of review, each drawn small: a canvas, versions in a row, shots on a timeline.
  function reviews() {
    const sketch = (kind) => {
      if (kind === 'board') return el('div', { class: 'gd-sk gd-sk-board' }, el('i', { class: 'a' }), el('i', { class: 'b' }), el('i', { class: 'n' }));
      if (kind === 'playlist') return el('div', { class: 'gd-sk gd-sk-list' }, ['v3', 'v7', 'v2'].map((v, i) => el('i', { text: `${i + 1}` })));
      return el('div', { class: 'gd-sk gd-sk-cut' }, el('i', { class: 'a' }), el('i', { class: 'b' }), el('i', { class: 'c' }), el('b'));
    };
    const card = (kind, ic, word, say) => el('div', { class: 'gd-review' }, sketch(kind), term(ic, word, say));
    return el('div', { class: 'gd-reviews' },
      card('board', 'board', 'Board', 'A canvas to lay work out on, with sticky notes, headings and frames'),
      card('playlist', 'playlist', 'Playlist', 'Versions in an order, played one at a time'),
      card('animatic', 'animatic', 'Animatic', 'Shots cut together on a timeline, each its newest version'));
  }

  // Every word, by what it is about.
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
  function words() {
    return WORDS.map(([group, list]) => el('section', { class: 'gd-group' },
      el('h3', { class: 'gd-group-head', text: group }),
      el('dl', { class: 'gd-words' }, list.flatMap(([ic, word, say]) => [
        el('dt', {}, el('span', { class: 'gd-ic', html: icon(ic) }), word),
        el('dd', { text: say }),
      ]))));
  }

  function view() {
    return [
      el('p', { class: 'gd-lead', text: 'The app has one word for each thing, and uses it everywhere. Here they are, from a workspace down to a version.' }),
      label('Where things are'), map(),
      label('A version, up close'), chain(),
      label('Reviews'), reviews(),
      label('Every word'), el('div', { class: 'gd-all' }, words()),
    ];
  }

  return { view };
})();
