'use strict';

// An animatic's cut written out for a playback system or an editor, as the files its download holds (see
// sendAnimaticZip in server.js): OpenTimelineIO, which says all of it (every track, the dissolves and fades, the
// sound), and a CMX 3600 edit decision list for each track, which nearly anything reads but which knows one
// track at a time and nothing of what lies under it. Both name each shot's file by the shot (kilo-0010.mp4), so
// a newer version put over the old file needs no new cut. What each file is goes in a list beside them.
//
// `info` says what the edit itself does not: `lengthOf(clip)` (its source's length in the edit's frames, as
// cut.js counts it), `fileOf(clip)` (the name of its file in the download, or null for a shot with nothing
// filed, which is left out as a gap) and `metaOf(clip)` (what it is: the shot and its version).

const C = require('./public/cut');

// A reel name an edit decision list takes: letters, numbers, - and _, at most 32.
const reelOf = (name) => String(name || 'AX').replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 32) || 'AX';

// The events of a track that have a file, with what comes into and goes out of each: a dissolve from the one
// before (`into`: frames before the cut and after it), a fade from black or to black (`fadeIn`, `fadeOut`).
function plan(doc, track, info) {
  const list = C.events(doc, track.id, info.lengthOf).filter((e) => info.fileOf(e.clip));
  return list.map((e, i) => {
    const prev = list[i - 1];
    const next = list[i + 1];
    const d = e.first ? C.dissolveOf(doc, e.clip) : null;
    const into = d && prev && prev.clip === d.prev && prev.last && prev.start + prev.len === e.start ? { pre: d.pre, post: d.post } : null;
    const nd = next && next.first ? C.dissolveOf(doc, next.clip) : null;
    const out = !!(nd && nd.prev === e.clip && e.last && e.start + e.len === next.start);
    return {
      ...e, into,
      fadeIn: e.first && !into ? Math.min(e.clip.fadeIn || 0, e.len) : 0,
      fadeOut: e.last && !out ? Math.min(e.clip.fadeOut || 0, e.len) : 0,
    };
  });
}

// ---- OpenTimelineIO

function otio(doc, title, info) {
  const rate = doc.fps;
  const time = (value) => ({ OTIO_SCHEMA: 'RationalTime.1', rate, value });
  const range = (start, duration) => ({ OTIO_SCHEMA: 'TimeRange.1', start_time: time(start), duration: time(duration) });
  const gap = (duration) => ({ OTIO_SCHEMA: 'Gap.1', name: '', source_range: range(0, duration), effects: [], markers: [], metadata: {} });
  const dissolve = (name, before, after) => ({ OTIO_SCHEMA: 'Transition.1', name, transition_type: 'SMPTE_Dissolve', in_offset: time(before), out_offset: time(after), metadata: {} });
  const tracks = [...C.videoTracks(doc), ...C.audioTracks(doc)].map((track) => {
    const children = [];
    let at = 0;
    for (const e of plan(doc, track, info)) {
      if (e.start > at) children.push(gap(e.start - at));
      // A fade is a dissolve from or to nothing: black on the lowest track, what lies under it on another.
      if (e.fadeIn) {
        if (!children.length || children[children.length - 1].OTIO_SCHEMA !== 'Gap.1') children.push(gap(0));
        children.push(dissolve('Fade in', 0, e.fadeIn));
      }
      if (e.into) children.push(dissolve('Dissolve', e.into.pre, e.into.post));
      const length = info.lengthOf(e.clip);
      const file = info.fileOf(e.clip);
      children.push({
        OTIO_SCHEMA: 'Clip.1',
        name: info.metaOf(e.clip).name,
        source_range: range(e.from, e.len),
        media_reference: {
          OTIO_SCHEMA: 'ExternalReference.1',
          name: file,
          target_url: file,
          available_range: range(0, Number.isFinite(length) ? C.whole(length) : e.from + e.len),
          metadata: {},
        },
        effects: [],
        markers: [],
        metadata: { boards: { ...info.metaOf(e.clip), ...(e.clip.loop && { loop: true }), ...(e.clip.gain !== undefined && e.clip.gain !== 1 && { gain: e.clip.gain }) } },
      });
      at = e.start + e.len;
      if (e.fadeOut) {
        children.push(dissolve('Fade out', e.fadeOut, 0));
        children.push(gap(0));
      }
    }
    return {
      OTIO_SCHEMA: 'Track.1', name: track.name, kind: track.kind === 'video' ? 'Video' : 'Audio', children, source_range: null, effects: [], markers: [],
      metadata: { boards: { ...(track.hide && { hidden: true }), ...(track.mute && { muted: true }), ...(track.gain !== undefined && track.gain !== 1 && { gain: track.gain }) } },
    };
  });
  return {
    OTIO_SCHEMA: 'Timeline.1',
    name: title,
    global_start_time: time(0),
    metadata: { boards: { fps: doc.fps, width: doc.w, height: doc.h, task: doc.task || null } },
    tracks: { OTIO_SCHEMA: 'Stack.1', name: 'tracks', children: tracks, source_range: null, effects: [], markers: [], metadata: {} },
  };
}

// ---- CMX 3600

// One track's events. Each is cut in, or dissolved in from the clip before it or from black; a fade out is a
// dissolve to black. Timecode counts from zero, at the edit's rate (non-drop). A sound track's events are
// for both channels (AA).
function edl(doc, track, title, info) {
  const tc = (f) => C.timecode(f, doc.fps);
  const ch = track.kind === 'video' ? 'V' : 'AA';
  const edits = [];
  for (const e of plan(doc, track, info)) {
    const reel = reelOf(info.metaOf(e.clip).name);
    const file = info.fileOf(e.clip);
    const line = { reel, file, cut: 'C', sIn: e.from, sOut: e.from + e.len, rIn: e.start, rOut: e.start + e.len };
    if (e.into) {
      // Centred on the cut: the clip before ends where the dissolve begins, and this one starts that early,
      // as far as it has frames before its in point.
      const pre = Math.min(e.into.pre, e.from);
      const before = edits[edits.length - 1];
      const last = before && before.lines[before.lines.length - 1];
      if (last) {
        last.rOut -= pre;
        last.sOut -= pre;
      }
      line.rIn -= pre;
      line.sIn -= pre;
      edits.push({ lines: [{ ...(last || { reel: 'BL', file: null }), cut: 'C', sIn: last ? last.sOut : 0, sOut: last ? last.sOut : 0, rIn: line.rIn, rOut: line.rIn }, { ...line, cut: 'D', dur: pre + e.into.post }] });
    } else if (e.fadeIn) {
      edits.push({ lines: [{ reel: 'BL', file: null, cut: 'C', sIn: 0, sOut: 0, rIn: line.rIn, rOut: line.rIn }, { ...line, cut: 'D', dur: e.fadeIn }] });
    } else edits.push({ lines: [line] });
    if (e.fadeOut) {
      const own = edits[edits.length - 1].lines[edits[edits.length - 1].lines.length - 1];
      const n = Math.min(e.fadeOut, own.rOut - own.rIn);
      own.rOut -= n;
      own.sOut -= n;
      edits.push({ lines: [{ ...own, cut: 'C', sIn: own.sOut, sOut: own.sOut, rIn: own.rOut, rOut: own.rOut }, { reel: 'BL', file: null, cut: 'D', dur: n, sIn: 0, sOut: n, rIn: own.rOut, rOut: own.rOut + n }] });
    }
  }
  const out = [`TITLE: ${title} ${track.name}`.slice(0, 70), 'FCM: NON-DROP FRAME', ''];
  edits.forEach((edit, i) => {
    const num = String(i + 1).padStart(3, '0');
    for (const l of edit.lines) {
      const how = l.cut === 'C' ? 'C        ' : `D    ${String(l.dur).padStart(3, '0')} `;
      out.push(`${num}  ${l.reel.padEnd(8)} ${ch.padEnd(5)} ${how}${tc(l.sIn)} ${tc(l.sOut)} ${tc(l.rIn)} ${tc(l.rOut)}`);
    }
    const [from, to] = edit.lines.length > 1 ? edit.lines : [edit.lines[0], null];
    if (from.file) out.push(`* FROM CLIP NAME: ${from.file}`);
    if (to && to.file) out.push(`* TO CLIP NAME: ${to.file}`);
    out.push('');
  });
  return `${out.join('\r\n')}\r\n`;
}

// ---- what each file is

function versionList(rows) {
  const cell = (v) => (/[",\r\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
  return `${['File', 'Shot', 'Version', 'Task', 'Number', 'Filed', 'Filed by', 'Original file'].join(',')}\r\n${rows.map((r) => [r.file, r.shot, r.label, r.task, r.number, r.filed, r.by, r.original].map(cell).join(',')).join('\r\n')}\r\n`;
}

module.exports = { otio, edl, versionList, reelOf };
