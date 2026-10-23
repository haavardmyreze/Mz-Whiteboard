'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cut = require('../public/cut');

const tracks = [
  { id: 'v1', kind: 'video', name: 'V1' },
  { id: 'v2', kind: 'video', name: 'V2' },
  { id: 'a1', kind: 'audio', name: 'A1', gain: 1 },
];
const clip = (id, track, start, len, more = {}) => ({ id, track, start, len, in: 0, fadeIn: 0, fadeOut: 0, dissolve: 0, gain: 1, shot: id, ...more });
const edit = (...clips) => ({ fps: 25, tracks: tracks.map((t) => ({ ...t })), clips });
// Every source is 100 frames long unless said.
const lengths = (map = {}) => (c) => map[c.id] ?? 100;
const ids = (layers) => layers.map((l) => l.clip.id);

test('cut: a clip shows its source from its in point, and nothing past its end', () => {
  const doc = edit(clip('a', 'v1', 10, 20, { in: 5 }));
  assert.deepEqual(ids(cut.layersAt(doc, 9, lengths())), []);
  assert.deepEqual(cut.layersAt(doc, 10, lengths()).map((l) => [l.clip.id, l.frame, l.opacity]), [['a', 5, 1]]);
  assert.equal(cut.layersAt(doc, 29, lengths())[0].frame, 24);
  assert.deepEqual(ids(cut.layersAt(doc, 30, lengths())), []);
});

test('cut: a version shorter than its clip leaves the clip short, without holding its last frame', () => {
  const doc = edit(clip('low', 'v1', 0, 100), clip('a', 'v2', 0, 50, { in: 10 }));
  // the version is 30 frames: from frame 10 it fills 20 of the clip's 50
  const len = lengths({ a: 30 });
  assert.equal(cut.filled(doc.clips[1], 30), 20);
  assert.deepEqual(ids(cut.layersAt(doc, 19, len)), ['a']);
  assert.equal(cut.layersAt(doc, 19, len)[0].frame, 29);
  // past it, what is under it shows
  assert.deepEqual(ids(cut.layersAt(doc, 20, len)), ['low']);
  // a version with nothing past the in point leaves nothing at all
  assert.equal(cut.filled(doc.clips[1], 8), 0);
  assert.deepEqual(ids(cut.layersAt(doc, 0, lengths({ a: 8 }))), ['low']);
});

test('cut: a looping clip goes round its whole source, from its in point', () => {
  const doc = edit(clip('a', 'v1', 0, 100, { loop: true, in: 8 }));
  const len = lengths({ a: 10 });
  assert.deepEqual([0, 1, 2, 11, 12, 99].map((f) => cut.layersAt(doc, f, len)[0].frame), [8, 9, 0, 9, 0, 7]);
});

test('cut: a clip over another covers it, and the one under is not decoded', () => {
  const doc = edit(clip('a', 'v1', 0, 50), clip('b', 'v2', 10, 10));
  assert.deepEqual(ids(cut.layersAt(doc, 5, lengths())), ['a']);
  assert.deepEqual(ids(cut.layersAt(doc, 15, lengths())), ['b']);
  // a hidden track shows nothing
  doc.tracks[1].hide = true;
  assert.deepEqual(ids(cut.layersAt(doc, 15, lengths())), ['a']);
});

test('cut: a fade on the lowest track is to black; over another clip it dissolves into it', () => {
  const doc = edit(clip('a', 'v1', 0, 40, { fadeIn: 4, fadeOut: 4 }), clip('b', 'v2', 10, 20, { fadeIn: 10 }));
  assert.deepEqual([0, 1, 2, 3, 4].map((f) => cut.layersAt(doc, f, lengths())[0].opacity), [0.125, 0.375, 0.625, 0.875, 1]);
  assert.deepEqual([36, 39].map((f) => cut.layersAt(doc, f, lengths())[0].opacity), [0.875, 0.125]);
  // b comes in over a: both show until b is whole
  const mid = cut.layersAt(doc, 14, lengths());
  assert.deepEqual(ids(mid), ['a', 'b']);
  assert.equal(mid[1].opacity, 0.45);
  assert.deepEqual(ids(cut.layersAt(doc, 20, lengths())), ['b']);
});

test('cut: a fade out comes at the end of what a short version fills', () => {
  const doc = edit(clip('a', 'v1', 0, 50, { fadeOut: 10 }));
  const len = lengths({ a: 20 });
  assert.ok(Math.abs(cut.layersAt(doc, 19, len)[0].opacity - 0.05) < 1e-9);
  assert.equal(cut.layersAt(doc, 9, len)[0].opacity, 1);
});

test('cut: a dissolve at a cut on one track is centred on it, the clip before playing on under the later one', () => {
  const doc = edit(clip('a', 'v1', 0, 20), clip('b', 'v1', 20, 20, { dissolve: 6, in: 10 }));
  // three frames before the cut and three after
  assert.deepEqual(ids(cut.layersAt(doc, 16, lengths())), ['a']);
  const first = cut.layersAt(doc, 17, lengths());
  assert.deepEqual(first.map((l) => [l.clip.id, l.frame]), [['a', 17], ['b', 7]]);
  assert.equal(first[1].opacity, 0.5 / 6);
  const last = cut.layersAt(doc, 22, lengths());
  assert.deepEqual(last.map((l) => [l.clip.id, l.frame]), [['a', 22], ['b', 12]]);
  assert.deepEqual(ids(cut.layersAt(doc, 23, lengths())), ['b']);
  // the sound crosses over: one goes as the other comes
  const heard = cut.soundsAt(doc, 20, lengths());
  assert.deepEqual(heard.map((x) => [x.clip.id, Math.round(x.gain * 1000) / 1000]), [['a', 0.417], ['b', 0.583]]);
});

test('cut: a dissolve with no frames to spare shows the nearest, and one before a short clip plays from under it', () => {
  // b from its first frame: its early part is its first frame; a to the end of its version: its last
  const doc = edit(clip('a', 'v1', 0, 20), clip('b', 'v1', 20, 20, { dissolve: 4 }));
  const len = lengths({ a: 20 });
  assert.deepEqual(cut.layersAt(doc, 18, len).map((l) => [l.clip.id, l.frame]), [['a', 18], ['b', 0]]);
  assert.deepEqual(cut.layersAt(doc, 21, len).map((l) => [l.clip.id, l.frame]), [['a', 19], ['b', 1]]);
  // a version that does not reach the cut does not play on: b comes in over black
  const short = lengths({ a: 15 });
  assert.deepEqual(ids(cut.layersAt(doc, 19, short)), ['b']);
  assert.deepEqual(ids(cut.layersAt(doc, 16, short)), []);
});

test('cut: what is heard is every track not muted, at its gain', () => {
  const doc = edit(clip('a', 'v1', 0, 20), clip('m', 'a1', 0, 100, { media: '/uploads/m.wav', shot: undefined, gain: 0.5 }));
  doc.tracks[2].gain = 0.8;
  assert.deepEqual(cut.soundsAt(doc, 5, lengths()).map((x) => [x.clip.id, x.gain]), [['a', 1], ['m', 0.4]]);
  doc.tracks[0].mute = true;
  assert.deepEqual(cut.soundsAt(doc, 5, lengths()).map((x) => x.clip.id), ['m']);
});

test('cut: the clips about to start are known ahead, soonest first', () => {
  const doc = edit(clip('a', 'v1', 0, 20), clip('b', 'v1', 20, 20), clip('c', 'v2', 30, 5, { in: 3 }), clip('d', 'v2', 90, 5));
  assert.deepEqual(cut.coming(doc, 10, 25, lengths()).map((x) => [x.clip.id, x.at, x.frame]), [['b', 20, 0], ['c', 30, 3]]);
});

test('cut: a clip put down overwrites what its track has there, and nothing else moves', () => {
  let n = 0;
  const newId = () => `n${++n}`;
  const doc = edit(clip('a', 'v1', 0, 30), clip('b', 'v1', 30, 30), clip('c', 'v1', 60, 10), clip('o', 'v2', 0, 100));
  const done = cut.place(doc, [clip('x', 'v1', 20, 45)], newId, lengths());
  const v1 = cut.onTrack(done, 'v1').map((c) => [c.id, c.start, c.len, c.in]);
  assert.deepEqual(v1, [['a', 0, 20, 0], ['x', 20, 45, 0], ['c', 65, 5, 5]]);
  assert.deepEqual(cut.onTrack(done, 'v2').map((c) => [c.id, c.start, c.len]), [['o', 0, 100]]);
  // one put inside another cuts it in two
  const inside = cut.place(doc, [clip('y', 'v2', 40, 10)], newId, lengths());
  assert.deepEqual(cut.onTrack(inside, 'v2').map((c) => [c.id, c.start, c.len, c.in]), [['o', 0, 40, 0], ['y', 40, 10, 0], ['n1', 50, 50, 50]]);
  // moved: it is taken from where it was
  const moved = cut.place(doc, [{ ...doc.clips[2], start: 80 }], newId, lengths());
  assert.deepEqual(cut.onTrack(moved, 'v1').map((c) => [c.id, c.start]), [['a', 0], ['b', 30], ['c', 80]]);
  // the edit given is as it was
  assert.equal(doc.clips[0].len, 30);
});

test('cut: trimming keeps what shows where it is, never runs past the source, and loops go round', () => {
  const a = clip('a', 'v1', 10, 20, { in: 5 });
  assert.deepEqual(cut.trimStart(a, -3, 100), { ...a, start: 7, len: 23, in: 2 });
  // no earlier than the source's first frame
  assert.deepEqual([cut.trimStart(a, -9, 100).start, cut.trimStart(a, -9, 100).in], [5, 0]);
  // a frame at least
  assert.equal(cut.trimStart(a, 50, 100).len, 1);
  // the end, no further than the source goes
  assert.equal(cut.trimEnd(a, 100, 40).len, 35);
  // one a shorter version left short keeps its length, and can still be made shorter
  const long = clip('b', 'v1', 0, 50);
  assert.equal(cut.trimEnd(long, 10, 30).len, 50);
  assert.equal(cut.trimEnd(long, -5, 30).len, 45);
  // a loop goes on as far as it is drawn, and its start goes round its source
  const loop = clip('l', 'v1', 20, 10, { loop: true, in: 2 });
  assert.equal(cut.trimEnd(loop, 100, 10).len, 110);
  assert.deepEqual([cut.trimStart(loop, -5, 10).start, cut.trimStart(loop, -5, 10).in], [15, 7]);
});

test('cut: a clip cut in two shows the same frames, each half keeping its own end\'s fade', () => {
  const a = clip('a', 'v1', 10, 20, { in: 5, fadeIn: 3, fadeOut: 4, dissolve: 2 });
  const [l, r] = cut.split(a, 18, 'r', 100);
  assert.deepEqual([l.start, l.len, l.in, l.fadeIn, l.fadeOut, l.dissolve], [10, 8, 5, 3, 0, 2]);
  assert.deepEqual([r.id, r.start, r.len, r.in, r.fadeIn, r.fadeOut, r.dissolve], ['r', 18, 12, 13, 0, 4, 0]);
  assert.equal(cut.split(a, 10, 'r'), null);
  // a loop's second half goes on round
  const loop = clip('l', 'v1', 0, 30, { loop: true });
  assert.equal(cut.split(loop, 25, 'r', 10)[1].in, 5);
});

test('cut: edges line up with other clips and the playhead', () => {
  const doc = edit(clip('a', 'v1', 0, 30), clip('b', 'v2', 45, 10));
  const points = cut.snapPoints(doc, new Set(['a']), 70);
  assert.deepEqual(points.sort((x, y) => x - y), [0, 45, 55, 70]);
  assert.equal(cut.nearest(52, points, 4), 55);
  assert.equal(cut.nearest(62, points, 4), null);
  assert.equal(cut.editEnd(doc), 55);
});

test('cut: time as a timecode at the edit\'s rate', () => {
  assert.equal(cut.timecode(0, 25), '00:00:00:00');
  assert.equal(cut.timecode(25 * 3661 + 7, 25), '01:01:01:07');
  assert.equal(cut.timecode(59, 29.97), '00:00:01:29');
});

// ---------------------------------------------------------------- the cut, written out (cutfiles.js)

const cutfiles = require('../cutfiles');
const infoFor = (map = {}) => ({
  lengthOf: lengths(map),
  fileOf: (c) => (c.id === 'none' ? null : `${c.id}.mp4`),
  metaOf: (c) => ({ name: c.id === 'm' ? 'music.wav' : `kilo-${c.id}` }),
});
const edlLines = (text) => text.split('\r\n').filter((l) => /^\d{3} /.test(l));

test('cutfiles: an edit decision list cuts, dissolves centred on the cut, and fades from and to black', () => {
  const doc = edit(clip('a', 'v1', 0, 50, { fadeIn: 10 }), clip('b', 'v1', 50, 50, { dissolve: 10, in: 20, fadeOut: 25 }));
  const lines = edlLines(cutfiles.edl(doc, doc.tracks[0], 'Cut', infoFor()));
  assert.deepEqual(lines, [
    '001  BL       V     C        00:00:00:00 00:00:00:00 00:00:00:00 00:00:00:00',
    '001  kilo-a   V     D    010 00:00:00:00 00:00:01:20 00:00:00:00 00:00:01:20',
    '002  kilo-a   V     C        00:00:01:20 00:00:01:20 00:00:01:20 00:00:01:20',
    '002  kilo-b   V     D    010 00:00:00:15 00:00:01:20 00:00:01:20 00:00:03:00',
    '003  kilo-b   V     C        00:00:01:20 00:00:01:20 00:00:03:00 00:00:03:00',
    '003  BL       V     D    025 00:00:00:00 00:00:01:00 00:00:03:00 00:00:04:00',
  ]);
  assert.match(cutfiles.edl(doc, doc.tracks[0], 'Cut', infoFor()), /\* FROM CLIP NAME: a\.mp4\r\n\* TO CLIP NAME: b\.mp4/);
});

test('cutfiles: a loop is written out each time round, a short clip as far as it plays, and a shot with nothing filed is a gap', () => {
  const doc = edit(clip('l', 'v1', 0, 25, { loop: true, in: 4 }), clip('none', 'v1', 25, 10), clip('s', 'v1', 35, 40));
  const lines = edlLines(cutfiles.edl(doc, doc.tracks[0], 'Cut', infoFor({ l: 10, s: 30 })));
  assert.deepEqual(lines.map((l) => l.slice(5, 13).trim() + ' ' + l.slice(-47)), [
    'kilo-l 00:00:00:04 00:00:00:10 00:00:00:00 00:00:00:06',
    'kilo-l 00:00:00:00 00:00:00:10 00:00:00:06 00:00:00:16',
    'kilo-l 00:00:00:00 00:00:00:09 00:00:00:16 00:00:01:00',
    'kilo-s 00:00:00:00 00:00:01:05 00:00:01:10 00:00:02:15',
  ]);
});

test('cutfiles: OpenTimelineIO has every track, its gaps, the dissolves and the fades, and the sound', () => {
  const doc = edit(clip('a', 'v1', 10, 40), clip('b', 'v1', 50, 30, { dissolve: 6 }), clip('o', 'v2', 0, 20, { fadeIn: 5, fadeOut: 5 }),
    clip('m', 'a1', 0, 100, { media: '/uploads/m.wav', shot: undefined, gain: 0.5 }));
  const t = cutfiles.otio(doc, 'Cut A', infoFor());
  assert.equal(t.OTIO_SCHEMA, 'Timeline.1');
  const [v1, v2, a1] = t.tracks.children;
  assert.deepEqual([v1.kind, v2.kind, a1.kind], ['Video', 'Video', 'Audio']);
  assert.deepEqual(v1.children.map((x) => x.OTIO_SCHEMA), ['Gap.1', 'Clip.1', 'Transition.1', 'Clip.1']);
  assert.deepEqual([v1.children[2].in_offset.value, v1.children[2].out_offset.value], [3, 3]);
  assert.deepEqual([v1.children[1].source_range.duration.value, v1.children[1].media_reference.target_url], [40, 'a.mp4']);
  // a fade is a dissolve from and to nothing
  assert.deepEqual(v2.children.map((x) => x.OTIO_SCHEMA + (x.name ? ` ${x.name}` : '')), ['Gap.1', 'Transition.1 Fade in', 'Clip.1 kilo-o', 'Transition.1 Fade out', 'Gap.1']);
  assert.equal(a1.children[0].metadata.boards.gain, 0.5);
  assert.equal(t.tracks.children[0].children[1].source_range.start_time.rate, 25);
});

test('cutfiles: the list of versions is a plain table, with what needs quoting quoted', () => {
  const csv = cutfiles.versionList([{ file: 'kilo-0010.mp4', shot: 'kilo-0010', label: 'kilo-0010 anim v3', task: 'anim', number: 3, filed: '2026-10-01', by: 'Anna', original: 'a, "b".mov' }]);
  assert.equal(csv.split('\r\n')[1], 'kilo-0010.mp4,kilo-0010,kilo-0010 anim v3,anim,3,2026-10-01,Anna,"a, ""b"".mov"');
});
