'use strict';

// An animatic's arithmetic: what an edit shows and plays at each frame, and the changes made to it. No DOM, no
// player: animatic.js gives the edit and draws it. Also loaded by the tests.
//
// An edit (`doc`, see cleanAnimatic in server.js) is tracks and clips, every position in whole frames of its own
// rate. A clip sits at `start` for `len` frames and plays its source from `in` frames into it. Its source is the
// newest version of its shot (or a sound file), whose length in the edit's frames is given by `lengthOf(clip)`:
// Infinity for a still, which lasts as long as it is wanted. A version shorter than its clip leaves the clip short:
// it ends where the version ends, and its last frame is not held. A looping clip goes round its whole source
// instead, as often as it needs to, `in` being where in the source it starts.
//
// Fades are ramps, a frame's value taken at its middle. A clip fades in from and out to whatever is under it: on
// the lowest track that is black, and over another clip it is a dissolve between them. A dissolve between two
// clips side by side on one track is the later one's (`dissolve`, in frames): centred on the cut, the later clip
// starts half of it early over the one before, which plays half of it on past the cut. Where either has no frames
// there (the first clip from its very first frame, or the one before to the end of its version), the dissolve
// shows its nearest frame. The one before only plays on if its version reaches the cut.
(function (root, make) {
  if (typeof module === 'object' && module.exports) module.exports = make();
  else root.WBCut = make();
})(typeof self !== 'undefined' ? self : this, () => {
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const mod = (a, n) => ((a % n) + n) % n;
  // A source's length in whole frames of the edit. Its length in seconds times the edit's rate seldom comes out
  // whole: at 23.976 or 29.97 a version of exactly 100 frames is 99.99997 of them, and one whose file says it
  // runs a hair short is the same. Counted down, each such clip would end a frame early and show a frame of
  // black at its cut. So it is rounded, as a clip put on the edit is cut to its source's length.
  const whole = (length) => Math.round(length);

  const videoTracks = (doc) => doc.tracks.filter((t) => t.kind === 'video');
  const audioTracks = (doc) => doc.tracks.filter((t) => t.kind === 'audio');
  const trackOf = (doc, clip) => doc.tracks.find((t) => t.id === clip.track) || null;
  const onTrack = (doc, id) => doc.clips.filter((c) => c.track === id).sort((a, b) => a.start - b.start);
  const clipEnd = (c) => c.start + c.len;
  // Where the edit ends: the end of its last clip, as cut.
  const editEnd = (doc) => doc.clips.reduce((n, c) => Math.max(n, clipEnd(c)), 0);

  // How many of a clip's frames its source fills: all of them when it loops (or is a still), else as far as
  // its source goes from its in point.
  function filled(clip, length) {
    if (clip.loop || !Number.isFinite(length)) return clip.len;
    return clamp(whole(length) - clip.in, 0, clip.len);
  }
  // The clip just before this one on its track, when it ends exactly where this one starts.
  const before = (doc, clip) => doc.clips.find((c) => c !== clip && c.track === clip.track && clipEnd(c) === clip.start) || null;
  const after = (doc, clip) => doc.clips.find((c) => c !== clip && c.track === clip.track && c.start === clipEnd(clip)) || null;
  // A dissolve as it plays: no longer than either clip, split about the cut ({ d, pre, post }), or null.
  function dissolveOf(doc, clip) {
    const prev = clip.dissolve > 0 && before(doc, clip);
    if (!prev) return null;
    const d = Math.min(clip.dissolve, clip.len, prev.len);
    const pre = Math.floor(d / 2);
    return { d, pre, post: d - pre, prev };
  }

  // A ramp through some points [[frame, value], ...], read at the middle of frame `f`.
  function rampAt(points, f) {
    const x = f + 0.5;
    if (!points.length) return 1;
    if (x <= points[0][0]) return points[0][1];
    for (let i = 1; i < points.length; i++) {
      const [x1, y1] = points[i];
      if (x <= x1) {
        const [x0, y0] = points[i - 1];
        return x1 === x0 ? y1 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
      }
    }
    return points[points.length - 1][1];
  }

  // Where a clip plays and how it comes and goes: { from, to } (frames, `to` not included), `show` (its
  // picture's opacity) and `sound` (its loudness, before its own and its track's gain) as ramps. A clip that a
  // short version leaves with nothing (`to <= from`) plays nowhere.
  function span(doc, clip, lengthOf) {
    const length = lengthOf(clip);
    const own = filled(clip, length);
    const s = clip.start;
    const end = s + own;
    const din = dissolveOf(doc, clip);
    const next = after(doc, clip);
    const dout = next && own === clip.len ? dissolveOf(doc, next) : null;
    const from = din ? s - din.pre : s;
    const to = own === 0 ? s : dout ? end + dout.post : end;
    const show = [];
    const sound = [];
    if (din) {
      show.push([from, 0], [s + din.post, 1]);
      sound.push([from, 0], [s + din.post, 1]);
    } else if (clip.fadeIn > 0) {
      show.push([s, 0], [s + Math.min(clip.fadeIn, own), 1]);
      sound.push([s, 0], [s + Math.min(clip.fadeIn, own), 1]);
    }
    if (dout) {
      // Under the dissolve the clip before stays whole, and the later one comes in over it; its sound goes
      // as the later one's comes.
      sound.push([end - dout.pre, 1], [to, 0]);
    } else if (clip.fadeOut > 0 && own > 0) {
      const f0 = Math.max(s, end - clip.fadeOut);
      show.push([f0, 1], [end, 0]);
      sound.push([f0, 1], [end, 0]);
    }
    return { from, to, show, sound, length };
  }

  // Which frame of its source a clip shows at frame `f` of the edit: round its source when it loops; else
  // held at either end, which only a dissolve reaches.
  function sourceFrame(clip, f, length) {
    const k = f - clip.start;
    if (!Number.isFinite(length)) return Math.max(0, clip.in + k);
    const n = Math.max(1, whole(length));
    return clip.loop ? mod(clip.in + k, n) : clamp(clip.in + k, 0, n - 1);
  }

  // What shows at frame `f`: the clips of the video tracks that are not hidden, lowest first, each with its
  // opacity and the frame of its source: [{ clip, track, opacity, frame }]. Whatever is wholly covered by a clip
  // over it (each is shown whole on black, so covers the frame) is left out: it need not be decoded.
  function layersAt(doc, f, lengthOf) {
    const out = [];
    videoTracks(doc).forEach((track) => {
      if (track.hide) return;
      for (const clip of onTrack(doc, track.id)) {
        const sp = span(doc, clip, lengthOf);
        if (f < sp.from || f >= sp.to) continue;
        const opacity = rampAt(sp.show, f);
        if (opacity <= 0) continue;
        out.push({ clip, track, opacity, frame: sourceFrame(clip, f, sp.length) });
      }
    });
    for (let i = out.length - 1; i > 0; i--) {
      if (out[i].opacity >= 1) return out.slice(i);
    }
    return out;
  }

  // What is heard at frame `f`: every clip whose track is not muted, with its loudness (its fades, its own
  // gain and its track's) and the frame of its source: [{ clip, track, gain, frame }]. Video clips are heard
  // too, from their own sound, covered or not (the player hears only those it shows, as it decodes no more).
  function soundsAt(doc, f, lengthOf) {
    const out = [];
    for (const track of doc.tracks) {
      if (track.mute) continue;
      for (const clip of onTrack(doc, track.id)) {
        const sp = span(doc, clip, lengthOf);
        if (f < sp.from || f >= sp.to) continue;
        const gain = rampAt(sp.sound, f) * (clip.gain ?? 1) * (track.gain ?? 1);
        if (gain > 0) out.push({ clip, track, gain, frame: sourceFrame(clip, f, sp.length) });
      }
    }
    return out;
  }

  // The clips that start to play within `ahead` frames after `f`, soonest first: they are made ready before
  // they are wanted, so the cut to them is clean.
  function coming(doc, f, ahead, lengthOf, kind = 'video') {
    const out = [];
    for (const track of doc.tracks) {
      if (track.kind !== kind || track.hide) continue;
      for (const clip of doc.clips) {
        if (clip.track !== track.id) continue;
        const sp = span(doc, clip, lengthOf);
        if (sp.to > sp.from && sp.from > f && sp.from <= f + ahead) out.push({ clip, track, at: sp.from, frame: sourceFrame(clip, sp.from, sp.length) });
      }
    }
    return out.sort((a, b) => a.at - b.at);
  }

  // A track as plain events, as an edit decision list has them: each clip as the stretches of its source it
  // plays, one after another ({ clip, start, len, from }, in the edit's frames), a loop written out as each time
  // round, and a clip a short version leaves short only as long as it plays. `first` and `last` say which
  // stretch begins and ends its clip, where its fades and the dissolve into it go.
  function events(doc, trackId, lengthOf) {
    const out = [];
    for (const clip of onTrack(doc, trackId)) {
      const length = lengthOf(clip);
      const own = filled(clip, length);
      if (!own) continue;
      const n = Math.max(1, whole(length));
      const parts = [];
      if (!clip.loop || !Number.isFinite(length)) parts.push({ start: clip.start, len: own, from: clip.in });
      else {
        for (let k = 0; k < own;) {
          const from = mod(clip.in + k, n);
          const len = Math.min(own - k, n - from);
          parts.push({ start: clip.start + k, len, from });
          k += len;
        }
      }
      parts.forEach((p, i) => out.push({ clip, ...p, first: i === 0, last: i === parts.length - 1 }));
    }
    return out;
  }

  // ---- changes, each giving a new edit and leaving the one given as it was

  const withClips = (doc, clips) => ({ ...doc, clips: clips.sort((a, b) => a.start - b.start) });

  // The places a moved or trimmed edge lines up with: the start and end of every other clip (on every track),
  // the start of the edit and the playhead.
  function snapPoints(doc, skip = new Set(), playhead = null) {
    const set = new Set([0]);
    for (const c of doc.clips) {
      if (skip.has(c.id)) continue;
      set.add(c.start);
      set.add(clipEnd(c));
    }
    if (playhead !== null) set.add(playhead);
    return [...set];
  }
  // The point nearest `v` within `reach`, or null.
  function nearest(v, points, reach) {
    let best = null;
    for (const p of points) if (Math.abs(p - v) <= reach && (best === null || Math.abs(p - v) < Math.abs(best - v))) best = p;
    return best;
  }

  // Clears frames [from, to) of a track for something put there, as an editor's overwrite does: a clip wholly
  // inside goes, one across an edge is trimmed back to it, and one across both is cut in two. `keep` are the
  // clips being put there. `newId` names the second half of a clip cut in two. Nothing else moves.
  function clear(doc, track, from, to, keep, newId, lengthOf) {
    const clips = [];
    for (const c of doc.clips) {
      if (c.track !== track || keep.has(c.id) || clipEnd(c) <= from || c.start >= to) {
        clips.push(c);
        continue;
      }
      if (c.start < from) clips.push(trimEnd(c, from - c.start - c.len, lengthOf ? lengthOf(c) : Infinity, true));
      if (clipEnd(c) > to) {
        const cut = to - c.start;
        clips.push({ ...trimStart(c, cut, lengthOf ? lengthOf(c) : Infinity), id: c.start < from ? newId() : c.id, dissolve: 0 });
      }
    }
    return withClips(doc, clips);
  }

  // Clips put on the edit (new, or moved there): each overwrites what its track has where it lands.
  function place(doc, placed, newId, lengthOf) {
    const ids = new Set(placed.map((c) => c.id));
    let next = withClips(doc, doc.clips.filter((c) => !ids.has(c.id)));
    for (const c of placed) next = clear(next, c.track, c.start, clipEnd(c), ids, newId, lengthOf);
    return withClips(next, [...next.clips, ...placed]);
  }

  // A clip's start moved by `df` frames, its source moving with it, so what it shows at each frame of the edit
  // stays as it was: its in point goes no earlier than its source's first frame, and it keeps a frame at least.
  // A looping clip has no first frame to stop at: its in point goes round its source.
  function trimStart(clip, df, length = Infinity) {
    const looped = clip.loop && Number.isFinite(length);
    const d = Math.min(Math.max(df, -clip.start, looped ? -Infinity : -clip.in), clip.len - 1);
    const at = clip.in + d;
    return { ...clip, start: clip.start + d, len: clip.len - d, in: looped ? mod(at, Math.max(1, whole(length))) : at };
  }
  // A clip's end moved by `df` frames. It is never drawn out past the end of its source unless it loops (or
  // `free` says so); one a shorter version already leaves short keeps the length it was cut to.
  function trimEnd(clip, df, length = Infinity, free = false) {
    let len = Math.max(1, clip.len + df);
    if (!free && !clip.loop && Number.isFinite(length)) len = Math.min(len, Math.max(whole(length) - clip.in, clip.len));
    return { ...clip, len, fadeIn: Math.min(clip.fadeIn || 0, len), fadeOut: Math.min(clip.fadeOut || 0, len - Math.min(clip.fadeIn || 0, len)) };
  }

  // The gap on a track at frame `f`: the empty frames there between the clip before (or the start of the edit)
  // and the next clip, { track, from, to }; null where a clip is, or where nothing comes after.
  function gapAt(doc, trackId, f) {
    const list = onTrack(doc, trackId);
    if (list.some((c) => f >= c.start && f < clipEnd(c))) return null;
    const next = list.find((c) => c.start > f);
    if (!next) return null;
    const from = list.reduce((n, c) => (clipEnd(c) <= f ? Math.max(n, clipEnd(c)) : n), 0);
    return next.start > from ? { track: trackId, from, to: next.start } : null;
  }
  // A gap closed, as an editor's ripple delete does: every clip after it on its track moves back by its length,
  // and the clips on other tracks stay where they are.
  function closeGap(doc, gap) {
    const by = gap.to - gap.from;
    if (by <= 0) return doc;
    return withClips(doc, doc.clips.map((c) => (c.track === gap.track && c.start >= gap.to ? { ...c, start: c.start - by } : c)));
  }

  // A clip cut in two at frame `f`: the first half keeps its id, its fade in and the dissolve before it; the
  // second, `id`, its fade out. Null if `f` is not inside it.
  function split(clip, f, id, length = Infinity) {
    if (f <= clip.start || f >= clipEnd(clip)) return null;
    const left = { ...clip, len: f - clip.start, fadeOut: 0 };
    left.fadeIn = Math.min(left.fadeIn || 0, left.len);
    const right = { ...trimStart(clip, f - clip.start, length), id, fadeIn: 0, dissolve: 0 };
    right.fadeOut = Math.min(right.fadeOut || 0, right.len);
    return [left, right];
  }

  // ---- time, as the edit counts it

  // Frames as a timecode, hours:minutes:seconds:frames, counted at the edit's rate rounded (29.97 counts 30 a
  // second, not dropping any).
  function timecode(frames, fps) {
    const base = Math.round(fps);
    const f = Math.max(0, Math.round(frames));
    const pad = (n) => String(n).padStart(2, '0');
    const s = Math.floor(f / base);
    return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}:${pad(f % base)}`;
  }

  return {
    videoTracks, audioTracks, trackOf, onTrack, clipEnd, editEnd, filled, before, after, dissolveOf, rampAt, span, sourceFrame,
    whole, layersAt, soundsAt, coming, events, snapPoints, nearest, clear, place, trimStart, trimEnd, gapAt, closeGap, split, timecode,
  };
});
