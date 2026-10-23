'use strict';

// An animatic's page (docs/animatic.md): the edit playing above, its timeline below, the project's shots to put
// on it down the left, and what is said about the shot on screen down the right. What the edit shows and plays at
// each frame, and every change made to it, is worked out by cut.js; this draws it, plays it and takes the changes.
// Loaded after cut.js, cuttrack.js and viewer.js; opened by home.js.
const WBAnimatic = (() => {
  const { el, clamp, store } = WB;
  const C = WBCut;
  const V = WBViewer;
  const FR = WBCutTrack.frames;
  const N = WBNaming;
  const ICON = WB.iconSet(18);

  const RULER = 24;                     // the ruler along the top of the timeline
  const LANE = { video: 56, audio: 40 }; // a track's height
  const BAND = 15;                      // the band along the top of a clip, with its name
  const SPLIT = 8;                      // between the video tracks and the sound tracks
  const EDGE = 6;                       // how near its edge a press takes hold of a clip's edge
  const SNAP_PX = 8;                    // how near a place an edge lines up with it
  const AHEAD = 1.5;                    // seconds: clips about to start are made ready this far ahead
  const POOL = 6;                       // video elements, at most, for the clips showing and those coming
  const PPF = [0.02, 40];               // how far the timeline can be drawn in and out, in pixels a frame
  const UNDO = 200;
  const SAVE_AFTER = 500;
  const PULL_EVERY = 15000;
  const AUDIO_EXT = /\.(wav|mp3|m4a|aac|ogg|oga|opus|flac)$/i;
  // The timeline is a dark bed in both themes, as the Timeline's close-up is, so pictures read the same on it.
  const BED = '#0c0c0c';
  const LANE_BG = ['#121212', '#151515'];
  const CLIP_BG = '#1a1a1a';
  const BAND_BG = '#2e2e2e';
  const BAND_ON = '#e6e6e6';
  const TEXT = '#f2f2f2';
  const QUIET = 'rgba(255, 255, 255, 0.6)';
  const FONT = (w, px) => `${w} ${px}px Inter, system-ui, sans-serif`;
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  // "anim v3" from a version's label "kilo-0010 anim v3".
  const versionPart = (label, name) => (label && name && label.startsWith(name) ? label.slice(name.length).trim() : label || '');

  function open(host, { project, id, me, onName = () => {}, onGone = () => {} }) {
    let doc = null;
    let rev = 0;
    let shots = {};
    let name = '';
    let closed = false;
    let sel = new Set();
    let ph = 0;
    let playing = false;
    let looping = store('wb:an:loop') !== false;
    let soundOn = store('wb:an:sound') !== false;
    let snapping = store('wb:an:snap') !== false;
    let undo = [];
    let redo = [];
    let saveTimer = 0;
    let saving = false;
    let dirty = false;
    let held = null; // what a hand is doing on the timeline
    let ghost = null; // shots dragged over the timeline from the list: where they would land
    let guide = null; // the frame an edge has lined up with
    let hover = null;
    let catalogue = null;
    const narrow = () => innerWidth < 700;
    const newId = () => WB.uid().slice(0, 12);

    // ---- what each clip plays

    const versionOf = (c) => (c.shot && shots[c.shot] ? shots[c.shot].version : null);
    const lookOf = (c) => {
      const v = versionOf(c);
      return v ? V.inView(v.look, doc.view) : null;
    };
    const srcOf = (look) => (look ? WB.playable(look) : null);
    const sounds = new Map(); // a sound file's address -> { buffer, peaks } once read, or 'loading' / 'failed'
    // How long a clip's source is, in the edit's frames: a still, or a shot with nothing filed, as long as it is wanted.
    const lengthOf = (c) => {
      if (c.media) {
        const s = sounds.get(c.media);
        if (s && s.buffer) return s.buffer.duration * doc.fps;
        return c.dur ? c.dur * doc.fps : Infinity;
      }
      const look = lookOf(c);
      return look && look.type === 'video' && look.dur > 0 ? look.dur * doc.fps : Infinity;
    };
    const frames = (seconds) => Math.max(1, Math.round(seconds * doc.fps));
    const endFrame = () => C.editEnd(doc);
    const fmt = (f) => V.fmtMoment(f / doc.fps, doc.fps);

    // ---- the page

    const binList = el('div', { class: 'an-bin-list' });
    const binSearch = el('input', { type: 'search', class: 'an-bin-q', placeholder: 'Find a shot', 'aria-label': 'Find a shot', autocomplete: 'off', spellcheck: 'false', oninput: () => paintBin() });
    const soundInput = el('input', { type: 'file', accept: 'audio/*,.wav,.mp3,.m4a,.aac,.ogg,.flac', multiple: true, hidden: true, onchange: () => { addSounds([...soundInput.files]); soundInput.value = ''; } });
    const bin = el('aside', { class: 'an-bin', 'aria-label': 'Shots to put on the edit' },
      el('div', { class: 'an-bin-head' }, binSearch),
      binList,
      el('div', { class: 'an-bin-foot' },
        el('button', { type: 'button', class: 'btn small', html: `${ICON.sound}<span>Add sound file…</span>`, title: 'A sound file to cut to: music, a temp track, a voice-over', onclick: () => soundInput.click() }),
        soundInput));

    const frame = el('div', { class: 'an-frame' });
    const emptyNote = el('div', { class: 'an-empty', hidden: true });
    const stage = el('div', { class: 'an-stage' }, frame, emptyNote);

    const notesTitle = el('div', { class: 'an-notes-title' });
    const notesList = el('div', { class: 'an-notes-list' });
    const noteBox = el('textarea', { class: 'an-note-box', rows: 2, placeholder: 'Comment on this shot', 'aria-label': 'Comment on the shot on screen' });
    const noteAt = el('span', { class: 'an-note-at' });
    const noteSend = el('button', { type: 'button', class: 'btn small primary', text: 'Send', onclick: () => sendNote() });
    const notes = el('aside', { class: 'an-notes', 'aria-label': 'Comments on the shot on screen', hidden: store('wb:an:notes') === false },
      el('div', { class: 'an-notes-head' }, notesTitle),
      notesList,
      el('div', { class: 'an-note-compose' }, noteBox, el('div', { class: 'an-note-row' }, noteAt, el('span', { class: 'spacer' }), noteSend)));

    const playBtn = el('button', { type: 'button', class: 'iconbtn', html: ICON.play, title: 'Play (Space)', 'aria-label': 'Play', onclick: () => (playing ? stop() : play()) });
    const timeBtn = el('button', { type: 'button', class: 'an-time', title: 'Click to switch between minutes, frames and timecode', onclick: () => V.cycleTimeMode() });
    const loopBtn = el('button', { type: 'button', class: `iconbtn an-loop${looping ? ' active' : ''}`, html: ICON.loop, title: 'Play round from the start at the end', 'aria-pressed': String(looping), onclick: () => setLoop(!looping) });
    const onNow = el('span', { class: 'an-now' });
    const splitBtn = el('button', { type: 'button', class: 'iconbtn an-wide', html: ICON.scissors, title: 'Cut in two at the playhead (Ctrl+B)', 'aria-label': 'Cut in two at the playhead', onclick: () => splitAtPlayhead() });
    const snapBtn = el('button', { type: 'button', class: `iconbtn an-wide${snapping ? ' active' : ''}`, html: ICON.snap, title: 'Line edges up with cuts and the playhead (hold Ctrl to skip)', 'aria-pressed': String(snapping), onclick: () => setSnap(!snapping) });
    const soundBtn = el('button', { type: 'button', class: 'iconbtn', title: 'Sound (M)', onclick: () => setSound(!soundOn) });
    const fitBtn = el('button', { type: 'button', class: 'iconbtn an-wide', html: ICON.fit, title: 'Show the whole edit (Shift+Z)', 'aria-label': 'Show the whole edit', onclick: () => fitAll() });
    const notesBtn = el('button', { type: 'button', class: `iconbtn an-wide${notes.hidden ? '' : ' active'}`, html: ICON.comment, title: 'Comments on the shot on screen (Shift+C)', 'aria-pressed': String(!notes.hidden), onclick: () => toggleNotes() });
    let options = null;
    const optionsSlot = el('span', { class: 'an-opts' });
    const bar = el('div', { class: 'an-bar' },
      playBtn,
      el('button', { type: 'button', class: 'iconbtn', html: ICON.frameBack, title: 'A frame back (,)', 'aria-label': 'A frame back', onclick: () => step(-1) }),
      el('button', { type: 'button', class: 'iconbtn', html: ICON.frameFwd, title: 'A frame on (.)', 'aria-label': 'A frame on', onclick: () => step(1) }),
      timeBtn, loopBtn, onNow, el('span', { class: 'spacer' }),
      splitBtn, snapBtn, optionsSlot, soundBtn, fitBtn, notesBtn);

    const cv = el('canvas', { class: 'an-canvas' });
    const space = el('div', { class: 'an-space' }, cv);
    const scroller = el('div', { class: 'an-scroll', tabindex: '-1' }, space);
    const headsIn = el('div', { class: 'an-heads-in' });
    const heads = el('div', { class: 'an-heads' }, headsIn);
    const grip = el('div', { class: 'an-grip', role: 'separator', 'aria-orientation': 'horizontal', title: 'Drag to give the timeline more room or less' });
    const tl = el('div', { class: 'an-tl' }, heads, scroller);
    const top = el('div', { class: 'an-top' }, bin, stage, notes);
    const page = el('div', { class: 'an' }, top, bar, grip, tl);
    host.replaceChildren(page);
    document.body.classList.add('an-on');
    const tlHeight = store('wb:an:tl');
    if (Number.isFinite(tlHeight)) tl.style.height = `${tlHeight}px`;

    // ---- loading, saving, and taking what others saved

    function take(data) {
      doc = data.doc;
      rev = data.rev;
      shots = { ...shots, ...data.shots };
      if (data.animatic && data.animatic.name !== name) {
        name = data.animatic.name;
        onName(name);
      }
      for (const c of doc.clips) if (c.media) loadSound(c.media);
    }

    async function load() {
      try {
        take(await WB.api('GET', `/api/animatics/${id}`));
      } catch (err) {
        if (closed) return;
        if (err.status === 404) return onGone();
        page.replaceChildren(el('p', { class: 'home-empty', text: err.message }));
        return;
      }
      if (closed) return;
      fitAll(true);
      paintOptions();
      paintAll();
      loadCatalogue();
    }

    // Each change is saved a moment after the last, over the save it was made from. One somebody else saved
    // first is taken in its place; the change refused is a step back in the undo, to be made again.
    function scheduleSave() {
      dirty = true;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(save, SAVE_AFTER);
    }
    async function save() {
      if (closed || !dirty) return;
      if (saving) return scheduleSave();
      saving = true;
      dirty = false;
      const sent = doc;
      try {
        const data = await WB.api('PATCH', `/api/animatics/${id}`, { doc: sent, rev, by: me.name });
        rev = data.rev;
        shots = { ...shots, ...data.shots };
        // What the server kept is what is: the same edit, unless it left something out.
        if (doc === sent && JSON.stringify(data.doc) !== JSON.stringify(sent)) doc = data.doc;
      } catch (err) {
        if (err.status === 409 && err.data && err.data.doc) {
          undo.push(sent);
          take(err.data);
          WB.toast(`${err.message}. You are seeing theirs; Undo brings yours back.`, { ms: 8000 });
        } else if (err.status === 404) {
          saving = false;
          return onGone();
        } else {
          dirty = true;
          WB.toast(`Not saved yet: ${err.message}. Trying again.`, { key: 'an-save' });
          saveTimer = setTimeout(save, 5000);
        }
      }
      saving = false;
      paintAll();
    }

    // What others saved, and new versions of the shots, are brought in every little while (and on coming
    // back to the window), unless a change of ours is on its way.
    async function pull() {
      if (closed || dirty || saving || held) return;
      try {
        const data = await WB.api('GET', `/api/animatics/${id}`);
        if (closed || dirty || saving || held) return;
        const was = JSON.stringify([doc, shots]);
        if (data.rev !== rev && data.animatic.updatedBy && data.animatic.updatedBy !== me.name) WB.toast(`${data.animatic.updatedBy} changed the edit`, { key: 'an-pull' });
        take(data);
        if (JSON.stringify([doc, shots]) !== was) paintAll();
      } catch (err) {
        if (err.status === 404) onGone();
      }
    }
    const pullTimer = setInterval(pull, PULL_EVERY);
    const onFocus = () => pull();
    window.addEventListener('focus', onFocus);

    function commit(next) {
      if (!next || next === doc) return;
      undo.push(doc);
      if (undo.length > UNDO) undo.shift();
      redo = [];
      doc = next;
      sel = new Set([...sel].filter((x) => doc.clips.some((c) => c.id === x)));
      scheduleSave();
      paintAll();
    }
    function undoStep(back) {
      const from = back ? undo : redo;
      const to = back ? redo : undo;
      if (!from.length) return;
      to.push(doc);
      doc = from.pop();
      sel = new Set([...sel].filter((x) => doc.clips.some((c) => c.id === x)));
      scheduleSave();
      paintAll();
    }

    // ---- the project's shots, to put on

    async function loadCatalogue() {
      try {
        catalogue = await WB.api('GET', `/api/projects/${project.id}`);
      } catch {
        catalogue = { entities: [], tasks: [] };
      }
      if (closed) return;
      paintBin();
      paintOptions();
    }
    const projectShots = () => (catalogue ? catalogue.entities.filter((e) => e.tier === 'shot').sort((a, b) => N.shotOrder(project.settings && project.settings.seqs)(a.name, b.name)) : []);
    // A shot's newest version as the edit plays it (of its task), from what the catalogue says: enough to
    // put it on and play it until the server says it all.
    function provisional(e) {
      if (shots[e.id] && shots[e.id].version !== undefined && doc.clips.some((c) => c.shot === e.id)) return shots[e.id];
      const head = doc.task ? e.heads && e.heads[doc.task] : e.newest;
      const version = head ? { id: head.id, task: doc.task || head.task || null, number: head.number, label: N.label(e.name, doc.task || head.task || null, head.number), kind: head.look && head.look.type, look: head.look } : null;
      return { id: e.id, name: e.name, seq: N.seqOf(e.name), version };
    }

    function paintBin() {
      if (!catalogue) {
        binList.replaceChildren(el('p', { class: 'an-bin-note', text: 'Loading…' }));
        return;
      }
      const q = binSearch.value.trim().toLowerCase();
      const list = projectShots().filter((e) => !q || e.name.toLowerCase().includes(q));
      if (!list.length) {
        binList.replaceChildren(el('p', { class: 'an-bin-note', text: q ? `No shot matches "${binSearch.value.trim()}".` : 'This project has no shots yet. Add them above its catalogue.' }));
        return;
      }
      const groups = [];
      for (const e of list) {
        const seq = N.seqOf(e.name) || '';
        if (!groups.length || groups[groups.length - 1].seq !== seq) groups.push({ seq, list: [] });
        groups[groups.length - 1].list.push(e);
      }
      binList.replaceChildren(...groups.flatMap((g) => [
        groups.length > 1 && el('div', { class: 'an-bin-seq' },
          el('span', { text: g.seq || 'Other shots' }),
          el('button', { type: 'button', class: 'an-act', text: 'Add all', title: `Every shot of ${g.seq || 'these'} at the end of V1, in order`, onclick: () => appendShots(g.list) })),
        ...g.list.map((e) => {
          const p = provisional(e);
          const v = p.version;
          const thumb = (doc && doc.task && e.heads && e.heads[doc.task] ? e.heads[doc.task].thumb : e.thumb) || null;
          const look = v && v.look;
          const row = el('div', {
            class: `an-shot${v ? '' : ' none'}`, draggable: 'true', tabindex: '0',
            title: `${e.name}${v ? ` · ${versionPart(v.label, e.name)}` : ' · nothing filed'}. Drag it onto the timeline, or double-click to put it at the playhead`,
            ondragstart: (ev) => {
              const pick = [e.id];
              ev.dataTransfer.setData('application/x-wb-shots', JSON.stringify(pick));
              ev.dataTransfer.setData('text/plain', e.name);
              ev.dataTransfer.effectAllowed = 'copy';
              dragShots = pick;
            },
            ondragend: () => { dragShots = null; ghost = null; draw(); },
            ondblclick: () => putAtPlayhead([e.id]),
            onkeydown: (ev) => { if (ev.key === 'Enter') putAtPlayhead([e.id]); },
          },
          el('span', { class: 'an-shot-still' }, thumb && el('img', { src: thumb, alt: '', loading: 'lazy', draggable: 'false' })),
          el('span', { class: 'an-shot-text' },
            el('span', { class: 'an-shot-name', text: e.name }),
            el('span', { class: 'an-shot-meta', text: v ? `${versionPart(v.label, e.name)}${look && look.type === 'video' && look.dur ? ` · ${V.fmtMoment(look.dur, look.fps || doc.fps)}` : ''}` : 'nothing filed' })));
          return row;
        }),
      ].filter(Boolean)));
    }
    let dragShots = null;

    // Shots as clips, one after another from `at` on `track`, each as long as its newest version.
    function clipsOf(ids, track, at) {
      const out = [];
      for (const sid of ids) {
        const e = catalogue && catalogue.entities.find((x) => x.id === sid);
        if (!e) continue;
        const p = provisional(e);
        shots[sid] = shots[sid] || p;
        const look = p.version ? V.inView(p.version.look, doc.view) : null;
        const len = look && look.type === 'video' && look.dur > 0 ? frames(look.dur) : frames(3);
        out.push({ id: newId(), track, start: at, len, in: 0, fadeIn: 0, fadeOut: 0, dissolve: 0, gain: 1, shot: sid, loop: false });
        at += len;
      }
      return out;
    }
    const v1 = () => C.videoTracks(doc)[0];
    function appendShots(list) {
      const track = v1();
      const at = C.onTrack(doc, track.id).reduce((n, c) => Math.max(n, C.clipEnd(c)), 0);
      const placed = clipsOf(list.map((e) => e.id), track.id, at);
      if (!placed.length) return;
      commit(C.place(doc, placed, newId, lengthOf));
      sel = new Set(placed.map((c) => c.id));
      paintAll();
    }
    // The track in use: the one of what is selected, or V1.
    const trackInUse = () => {
      const c = doc.clips.find((x) => sel.has(x.id) && x.shot);
      return c ? c.track : v1().id;
    };
    function putAtPlayhead(ids) {
      const placed = clipsOf(ids, trackInUse(), Math.round(ph));
      if (!placed.length) return;
      commit(C.place(doc, placed, newId, lengthOf));
      sel = new Set(placed.map((c) => c.id));
      paintAll();
    }

    // ---- sound files

    function ensureAudio() {
      if (!actx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        actx = new Ctx();
        master = actx.createGain();
        master.gain.value = soundOn ? 1 : 0;
        master.connect(actx.destination);
      }
      return actx;
    }
    let actx = null;
    let master = null;
    async function loadSound(src) {
      if (sounds.has(src)) return;
      sounds.set(src, 'loading');
      try {
        const res = await fetch(src);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buffer = await ensureAudio().decodeAudioData(await res.arrayBuffer());
        sounds.set(src, { buffer, peaks: peaksOf(buffer) });
      } catch {
        sounds.set(src, 'failed');
      }
      if (closed) return;
      draw();
      if (playing) startSound(ph);
    }
    // The loudest of each hundredth of a second, for drawing it: as a share of the loudest of all, so a quiet
    // file shows its shape as plainly as a loud one.
    function peaksOf(buffer) {
      const per = Math.max(1, Math.round(buffer.sampleRate / 100));
      const n = Math.ceil(buffer.length / per);
      const out = new Float32Array(n);
      for (let ch = 0; ch < Math.min(2, buffer.numberOfChannels); ch++) {
        const data = buffer.getChannelData(ch);
        for (let i = 0; i < n; i++) {
          let m = out[i];
          const end = Math.min(data.length, (i + 1) * per);
          for (let j = i * per; j < end; j += 4) {
            const a = Math.abs(data[j]);
            if (a > m) m = a;
          }
          out[i] = m;
        }
      }
      let top = 0;
      for (const m of out) if (m > top) top = m;
      if (top > 0) for (let i = 0; i < n; i++) out[i] /= top;
      return out;
    }

    // Sound files brought in: each is read here (its length, and that this browser can play it), sent up as
    // it is, and put on the first sound track with room, at the playhead, or at `at` on `track` where dropped.
    // The first sound in the edit turns the shots' own sound off: an animatic is heard through its sound file.
    async function addSounds(files, { track = null, at = null } = {}) {
      const list = files.filter((f) => AUDIO_EXT.test(f.name) || /^audio\//.test(f.type));
      if (!list.length) return void WB.toast('Only sound files can go on a sound track: WAV, MP3, M4A, AAC, OGG or FLAC.');
      let start = at ?? Math.round(ph);
      for (const file of list) {
        const ext = (AUDIO_EXT.exec(file.name) || [`.${(file.type.split('/')[1] || 'wav').replace('mpeg', 'mp3').replace('x-wav', 'wav')}`])[0].toLowerCase();
        WB.toast(`Reading ${file.name}…`, { sticky: true, key: 'an-sound' });
        let buffer;
        try {
          buffer = await ensureAudio().decodeAudioData(await file.arrayBuffer());
        } catch {
          WB.toast(`${file.name} is not a sound file this browser can play.`, { key: 'an-sound' });
          continue;
        }
        let up;
        try {
          const note = WB.toast(`Sending ${file.name}…`, { sticky: true, key: 'an-sound' });
          up = await WBIngest.upload(file, ext, (p) => note.set(`Sending ${file.name}… ${Math.round(p * 100)}%`));
        } catch (err) {
          WB.toast(`${file.name} did not go up: ${err.message}`, { key: 'an-sound' });
          continue;
        }
        if (closed) return;
        sounds.set(up.url, { buffer, peaks: peaksOf(buffer) });
        const len = frames(buffer.duration);
        // Where it was dropped, or the first sound track with room for it, or a new one: a sound already on
        // the edit is never written over unless it was dropped on.
        let base = doc;
        const free = (t) => !base.clips.some((c) => c.track === t.id && c.start < start + len && C.clipEnd(c) > start);
        let target = (track && C.audioTracks(base).find((t) => t.id === track)) || C.audioTracks(base).find(free);
        if (!target) {
          if (base.tracks.length >= 16) {
            WB.toast('There is no sound track with room for it, and an edit has sixteen tracks at most.', { key: 'an-sound' });
            continue;
          }
          base = withTrack(base, 'audio');
          target = C.audioTracks(base).at(-1);
        }
        const clip = { id: newId(), track: target.id, start, len, in: 0, fadeIn: 0, fadeOut: 0, dissolve: 0, gain: 1, media: up.url, name: file.name, dur: buffer.duration };
        let next = C.place(base, [clip], newId, lengthOf);
        if (!doc.clips.some((c) => c.media)) next = { ...next, tracks: next.tracks.map((t) => (t.kind === 'video' ? { ...t, mute: true } : t)) };
        commit(next);
        sel = new Set([clip.id]);
        WB.toast(`${file.name} is on ${target.name}${doc.clips.filter((c) => c.media).length === 1 ? '. The shots’ own sound is off; turn it on beside each video track' : ''}.`, { key: 'an-sound', ms: 6000 });
        start += len;
      }
      paintAll();
    }

    // ---- the player: the edit drawn as layers of video, each shown whole on black, the highest on top

    const pool = []; // { video, clip, src, used }
    const stills = new Map(); // clip id -> <img> or slate
    let wantNow = new Set();
    function videoFor(clip, src) {
      let ent = pool.find((p) => p.clip === clip.id);
      if (!ent) {
        ent = pool.find((p) => !wantNow.has(p.clip) && p.src === src)
          || (pool.length < POOL ? newVideo() : pool.filter((p) => !wantNow.has(p.clip)).sort((a, b) => a.used - b.used)[0]);
        if (!ent) return null;
        ent.clip = clip.id;
      }
      if (ent.src !== src) {
        ent.src = src;
        ent.video.src = src;
      }
      ent.used = performance.now();
      return ent;
    }
    function newVideo() {
      const video = el('video', { class: 'an-layer', playsinline: '', preload: 'auto' });
      video.disablePictureInPicture = true;
      frame.append(video);
      const ent = { video, clip: null, src: null, used: 0 };
      pool.push(ent);
      return ent;
    }
    function stillFor(clip, look, p) {
      const key = `${clip.id}|${look ? look.prev || look.src : 'slate'}`;
      let node = stills.get(clip.id);
      if (node && node.dataset.key !== key) {
        node.remove();
        node = null;
      }
      if (!node) {
        node = look
          ? el('img', { class: 'an-layer', src: look.prev || look.src, alt: '', draggable: 'false' })
          : el('div', { class: 'an-layer an-slate' }, el('b', { text: p ? p.name : '' }), el('span', { text: doc.task ? `No ${doc.task} filed yet` : 'Nothing filed yet' }));
        node.dataset.key = key;
        frame.append(node);
        stills.set(clip.id, node);
      }
      return node;
    }
    const hide = (node) => {
      node.style.visibility = 'hidden';
      node.style.zIndex = '0';
    };

    // Shows the edit at frame `f` (a fraction while playing): the clips that show, at their opacity, each
    // video on its frame; the clips about to start made ready; everything else let go of.
    function render(f) {
      if (!doc) return;
      const fi = Math.floor(f);
      const layers = C.layersAt(doc, fi, lengthOf);
      const ahead = Math.round(doc.fps * AHEAD);
      const soon = playing ? C.coming(doc, fi, ahead, lengthOf) : [];
      // A clip covered now that shows again soon (as what is over it fades) plays on unseen, in step, so it is
      // there when it is uncovered.
      const shownIds = new Set(layers.map((l) => l.clip.id));
      const under = playing ? C.layersAt(doc, fi + ahead, lengthOf).map((l) => l.clip).filter((c) => !shownIds.has(c.id) && !soon.some((x) => x.clip === c)) : [];
      const covered = under.filter((c) => {
        const sp = C.span(doc, c, lengthOf);
        return fi >= sp.from && fi < sp.to;
      });
      wantNow = new Set([...layers.map((l) => l.clip.id), ...soon.map((x) => x.clip.id), ...covered.map((c) => c.id)]);
      const shown = new Set();
      layers.forEach((l, i) => {
        const look = lookOf(l.clip);
        const p = shots[l.clip.shot];
        let node;
        if (look && look.type === 'video') {
          const ent = videoFor(l.clip, srcOf(look));
          if (!ent) return;
          node = ent.video;
          const sp = C.span(doc, l.clip, lengthOf);
          keepTime(ent, l.clip, (l.frame + (f - fi)) / doc.fps, sp.length / doc.fps);
          const gain = soundOn && !l.track.mute ? C.rampAt(sp.sound, fi) * (l.clip.gain ?? 1) : 0;
          node.volume = clamp(gain, 0, 1);
          node.muted = gain <= 0;
        } else {
          node = stillFor(l.clip, look, p);
        }
        node.style.visibility = 'visible';
        node.style.zIndex = String(i + 1);
        node.style.opacity = String(l.opacity);
        shown.add(node);
      });
      for (const s of soon) {
        const look = lookOf(s.clip);
        if (!look || look.type !== 'video') continue;
        const ent = videoFor(s.clip, srcOf(look));
        if (!ent || shown.has(ent.video)) continue;
        if (!ent.video.paused) ent.video.pause();
        if (Math.abs(V.whereOf(ent.video) - V.frameTime(s.frame, doc.fps)) > 0.5 / doc.fps) V.goTo(ent.video, V.frameTime(s.frame, doc.fps));
        hide(ent.video);
      }
      for (const c of covered) {
        const look = lookOf(c);
        if (!look || look.type !== 'video') continue;
        const ent = videoFor(c, srcOf(look));
        if (!ent || shown.has(ent.video)) continue;
        const sp = C.span(doc, c, lengthOf);
        keepTime(ent, c, (C.sourceFrame(c, fi, sp.length) + (f - fi)) / doc.fps, sp.length / doc.fps);
        ent.video.muted = true;
        hide(ent.video);
        shown.add(ent.video);
      }
      for (const ent of pool) {
        if (shown.has(ent.video)) continue;
        if (!wantNow.has(ent.clip)) {
          if (!ent.video.paused) ent.video.pause();
          hide(ent.video);
        }
      }
      for (const [cid, node] of stills) {
        if (shown.has(node)) continue;
        if (!doc.clips.some((c) => c.id === cid)) {
          node.remove();
          stills.delete(cid);
        } else hide(node);
      }
      emptyNote.hidden = !!doc.clips.length;
      paintNow(layers);
    }

    // Keeps a video on the moment the edit is at: stopped, exactly on its frame; playing, in step with the
    // clock, a touch quicker or slower when a little off, and put right with a jump when far off. A looping
    // clip's video loops by itself, so going round is no jump.
    function keepTime(ent, clip, t, dur) {
      const v = ent.video;
      v.loop = !!clip.loop;
      if (!playing) {
        if (!v.paused) v.pause();
        v.playbackRate = 1;
        const at = Math.floor(t * doc.fps + 1e-6);
        if (Math.abs(V.whereOf(v) - V.frameTime(at, doc.fps)) > 0.5 / doc.fps) V.goTo(v, V.frameTime(at, doc.fps));
        return;
      }
      let drift = V.whereOf(v) - t;
      if (clip.loop && Number.isFinite(dur) && dur > 0) drift = (((drift + dur / 2) % dur) + dur) % dur - dur / 2;
      if (v.paused) {
        if (Math.abs(drift) > 0.5 / doc.fps) V.goTo(v, t);
        v.play().catch(() => {});
        return;
      }
      if (Math.abs(drift) > 0.3) {
        v.playbackRate = 1;
        V.goTo(v, t + 0.05);
      } else v.playbackRate = clamp(1 - drift * 2, 0.9, 1.1);
    }

    // ---- playing: the clock is the sound's, so pictures and sound keep together

    let clockAt = 0; // the sound clock's time when playing started from `clockFrom`
    let clockFrom = 0;
    let raf = 0;
    let voices = [];
    const clockFrame = () => clockFrom + Math.max(0, actx.currentTime - clockAt) * doc.fps;
    function play() {
      if (!doc || playing || !doc.clips.length) return;
      ensureAudio();
      actx.resume().catch(() => {});
      if (ph >= endFrame() - 1) ph = 0;
      playing = true;
      clockFrom = ph;
      clockAt = actx.currentTime + 0.05;
      startSound(ph);
      paintPlay();
      keepAhead();
      tick();
    }
    function stop() {
      if (!playing) return;
      playing = false;
      cancelAnimationFrame(raf);
      stopSound();
      ph = Math.min(Math.floor(ph), Math.max(0, endFrame()));
      for (const ent of pool) {
        ent.video.pause();
        ent.video.playbackRate = 1;
      }
      paintPlay();
      render(ph);
      draw();
      paintTime();
    }
    function tick() {
      if (!playing || closed) return;
      const end = endFrame();
      let f = clockFrame();
      if (f >= end) {
        if (!looping || !end) {
          ph = end;
          stop();
          return;
        }
        restartAt(0);
        f = 0;
      }
      ph = f;
      render(ph);
      follow();
      draw();
      paintTime();
      raf = requestAnimationFrame(tick);
    }
    // Playing on from another frame: the clock and the sound start again there.
    function restartAt(f) {
      ph = f;
      clockFrom = f;
      clockAt = actx.currentTime + 0.05;
      startSound(f);
    }
    // The sound files from frame `f`, each scheduled on the sound clock to the sample, its fades as ramps.
    function startSound(f) {
      stopSound();
      if (!actx || !playing) return;
      const base = clockAt + Math.max(0, f - clockFrom) / doc.fps;
      for (const c of doc.clips) {
        if (!c.media) continue;
        const track = C.trackOf(doc, c);
        const s = sounds.get(c.media);
        if (!track || track.mute || !s || !s.buffer) continue;
        const sp = C.span(doc, c, lengthOf);
        if (sp.to <= f) continue;
        const from = Math.max(f, sp.from);
        let when = base + (from - f) / doc.fps;
        let offset = (c.in + (from - c.start)) / doc.fps;
        if (offset < 0) {
          when -= offset;
          offset = 0;
        }
        const dur = (sp.to - from) / doc.fps;
        if (dur <= 0 || offset >= s.buffer.duration) continue;
        const src = actx.createBufferSource();
        src.buffer = s.buffer;
        const g = actx.createGain();
        const level = (c.gain ?? 1) * (track.gain ?? 1);
        const at = (x) => base + (x - f) / doc.fps;
        g.gain.setValueAtTime(level * C.rampAt(sp.sound, Math.floor(from)), Math.max(actx.currentTime, when));
        for (const [x, y] of sp.sound) if (x > from) g.gain.linearRampToValueAtTime(level * y, at(x));
        src.connect(g).connect(master);
        src.start(Math.max(actx.currentTime, when), offset, dur);
        voices.push(src);
      }
    }
    function stopSound() {
      for (const v of voices) {
        try {
          v.stop();
        } catch {
          // never started
        }
        v.disconnect();
      }
      voices = [];
    }
    // Goes to frame `f`: playing, it plays on from there.
    function seek(f) {
      const to = clamp(Math.round(f), 0, Math.max(0, endFrame()));
      if (playing) restartAt(to);
      else ph = to;
      render(ph);
      draw();
      paintTime();
    }
    const step = (n) => {
      if (playing) stop();
      seek(Math.round(ph) + n);
    };
    // The cut before or after the playhead, on any track.
    function toCut(dir) {
      if (playing) stop();
      const at = Math.round(ph);
      const cuts = [...new Set(doc.clips.flatMap((c) => [c.start, C.clipEnd(c)]))].sort((a, b) => a - b);
      const to = dir > 0 ? cuts.find((x) => x > at) : [...cuts].reverse().find((x) => x < at);
      if (to !== undefined) seek(to);
    }
    // Playing, the timeline keeps the playhead in sight, a page at a time.
    function follow() {
      const x = ph * ppf - scroller.scrollLeft;
      if (x > W - 40 || x < 0) scroller.scrollLeft = Math.max(0, ph * ppf - 40);
    }
    // What the edit plays is kept on this computer, from the playhead on (media.js).
    function keepAhead() {
      if (!doc) return;
      const order = doc.clips.filter((c) => c.shot).sort((a, b) => ((a.start < ph) - (b.start < ph)) || a.start - b.start);
      const srcs = order.map((c) => {
        const look = lookOf(c);
        return look && look.type === 'video' ? srcOf(look) : null;
      }).filter(Boolean);
      WB.media.want('animatic', srcs, { rank: WB.media.RANK.timeline, hold: true });
    }

    function setLoop(on) {
      looping = on;
      store('wb:an:loop', on);
      loopBtn.classList.toggle('active', on);
      loopBtn.setAttribute('aria-pressed', String(on));
    }
    function setSnap(on) {
      snapping = on;
      store('wb:an:snap', on);
      snapBtn.classList.toggle('active', on);
      snapBtn.setAttribute('aria-pressed', String(on));
    }
    function setSound(on) {
      soundOn = on;
      store('wb:an:sound', on);
      if (master) master.gain.value = on ? 1 : 0;
      paintSound();
      render(ph);
    }
    const paintSound = () => {
      soundBtn.innerHTML = soundOn ? ICON.sound : ICON.muted;
      soundBtn.setAttribute('aria-label', soundOn ? 'Sound is on' : 'Sound is off');
      soundBtn.classList.toggle('off', !soundOn);
    };
    const paintPlay = () => {
      playBtn.innerHTML = playing ? ICON.pause : ICON.play;
      playBtn.title = playing ? 'Stop (Space)' : 'Play (Space)';
      playBtn.setAttribute('aria-label', playing ? 'Stop' : 'Play');
    };
    function paintTime() {
      if (!doc) return;
      timeBtn.textContent = V.timeLabel(ph / doc.fps, endFrame() / doc.fps, doc.fps);
    }
    // Which shot is on screen and its version, in the bar: the one on top.
    let nowKey = null;
    function paintNow(layers) {
      const l = layers[layers.length - 1];
      const c = l ? l.clip : null;
      const p = c && c.shot ? shots[c.shot] : null;
      const key = `${c ? c.id : ''}|${p && p.version ? p.version.id : ''}`;
      if (key === nowKey) return;
      nowKey = key;
      onNow.replaceChildren(...(p ? [el('b', { text: p.name }), el('span', { text: p.version ? versionPart(p.version.label, p.name) : 'nothing filed' })] : []));
      joinShot(c);
    }

    // The task each clip plays the newest of, and the view, where there is a choice.
    function paintOptions() {
      if (!doc) return;
      const tasks = (catalogue && catalogue.tasks) || [];
      const views = catalogue && Array.isArray(catalogue.viewList) ? catalogue.viewList : [];
      options = V.optionsButton(() => [
        { name: 'Task', value: doc.task || '', def: '', options: tasks.length > 1 || doc.task ? [['', 'Newest of any task'], ...tasks.map((x) => [x, `Newest ${x}`])] : [], pick: (v) => setChoice({ task: v || null }) },
        ...(views.length > 1 ? [V.viewGroup(['', ...views.slice(1)], doc.view || '', (v) => setChoice({ view: v }), views)] : []),
      ], { title: 'What the edit plays' });
      optionsSlot.replaceChildren(options);
    }
    async function setChoice(patch) {
      commit({ ...doc, ...patch });
      clearTimeout(saveTimer);
      await save();
      paintOptions();
      paintBin();
      paintAll();
    }

    // ---- the timeline

    let W = 0;
    let H = 0;
    let dpr = 1;
    let ppf = 2;
    let rows = []; // { track, y, h }
    let accentNow = '#5ba0fa';
    const xOf = (f) => f * ppf - scroller.scrollLeft;
    const fAt = (x) => (x + scroller.scrollLeft) / ppf;
    const yOf = (row) => RULER + row.y - scroller.scrollTop;
    function layoutRows() {
      rows = [];
      let y = 0;
      const vids = C.videoTracks(doc).slice().reverse();
      for (const t of vids) {
        rows.push({ track: t, y, h: LANE.video });
        y += LANE.video;
      }
      y += SPLIT;
      for (const t of C.audioTracks(doc)) {
        rows.push({ track: t, y, h: LANE.audio });
        y += LANE.audio;
      }
      return y;
    }
    const rowOf = (trackId) => rows.find((r) => r.track.id === trackId) || null;
    function resize() {
      const r = scroller.getBoundingClientRect();
      dpr = window.devicePixelRatio || 1;
      W = Math.round(scroller.clientWidth);
      H = Math.round(scroller.clientHeight);
      if (!W || !H || !r.width) return;
      cv.width = Math.max(1, Math.round(W * dpr));
      cv.height = Math.max(1, Math.round(H * dpr));
      cv.style.width = `${W}px`;
      cv.style.height = `${H}px`;
      sizeSpace();
      fitFrame();
      draw();
    }
    function sizeSpace() {
      if (!doc) return;
      const tall = layoutRows();
      const wide = Math.max(W, (endFrame() + doc.fps * 30) * ppf);
      space.style.width = `${Math.ceil(wide)}px`;
      space.style.height = `${Math.max(H, RULER + tall + 24)}px`;
    }
    const watch = new ResizeObserver(resize);
    watch.observe(scroller);
    watch.observe(stage);
    scroller.addEventListener('scroll', () => {
      headsIn.style.transform = `translateY(${-scroller.scrollTop}px)`;
      draw();
    });

    // The picture fits the stage, in the edit's shape.
    function fitFrame() {
      if (!doc) return;
      const r = stage.getBoundingClientRect();
      const pad = narrow() ? 0 : 12;
      const k = Math.min((r.width - pad * 2) / doc.w, (r.height - pad * 2) / doc.h);
      if (!(k > 0)) return;
      frame.style.width = `${Math.floor(doc.w * k)}px`;
      frame.style.height = `${Math.floor(doc.h * k)}px`;
    }

    function zoomTo(next, aboutX = W / 2) {
      const at = fAt(aboutX);
      ppf = clamp(next, PPF[0], PPF[1]);
      sizeSpace();
      scroller.scrollLeft = Math.max(0, at * ppf - aboutX);
      draw();
    }
    // The whole edit in the width there is (a new one, some ten seconds a screen).
    function fitAll(first = false) {
      if (!doc) return;
      const w = scroller.clientWidth || 800;
      const end = endFrame();
      ppf = clamp(end ? (w - 40) / end : w / (doc.fps * 20), PPF[0], first ? 12 : PPF[1]);
      sizeSpace();
      scroller.scrollLeft = 0;
      draw();
    }

    function draw() {
      if (!doc || !W || !H) return;
      const ctx = cv.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = BED;
      ctx.fillRect(0, 0, W, H);
      const accent = cssVar('--accent') || '#5ba0fa';
      accentNow = accent;
      const end = endFrame();
      // The tracks, in turn a shade apart; past the end of the edit, darker.
      rows.forEach((r, i) => {
        const y = yOf(r);
        if (y > H || y + r.h < RULER) return;
        ctx.fillStyle = LANE_BG[i % 2];
        ctx.fillRect(0, y, W, r.h);
        if ((r.track.mute && r.track.kind === 'audio') || r.track.hide) {
          ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
          ctx.fillRect(0, y, W, r.h);
        }
      });
      if (xOf(end) < W) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
        ctx.fillRect(Math.max(0, xOf(end)), RULER, W, H);
      }
      const want = [];
      const moving = held && held.preview ? held.preview : null;
      const skip = moving ? new Set(moving.map((c) => c.id)) : null;
      for (const c of doc.clips) {
        if (skip && skip.has(c.id) && !held.copy) continue;
        drawClip(ctx, c, { want, faded: !!(skip && skip.has(c.id)) });
      }
      for (const c of moving || []) drawClip(ctx, c, { want, lifted: true });
      for (const c of ghost || []) drawClip(ctx, c, { want, lifted: true });
      // The dissolves, over the cuts they are on.
      for (const c of doc.clips) {
        const d = C.dissolveOf(doc, c);
        const r = rowOf(c.track);
        if (!d || !r) continue;
        const xa = xOf(c.start - d.pre);
        const xb = xOf(c.start + d.post);
        if (xb < 0 || xa > W) continue;
        const y = yOf(r) + 2;
        const h = r.h - 4;
        ctx.save();
        ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
        ctx.fillRect(xa, y + BAND, xb - xa, h - BAND);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.moveTo(xa, y + h);
        ctx.lineTo(xb, y + BAND);
        ctx.moveTo(xa, y + BAND);
        ctx.lineTo(xb, y + h);
        ctx.stroke();
        ctx.restore();
      }
      if (held && held.kind === 'box') {
        const [x0, x1] = [Math.min(held.x0, held.x1), Math.max(held.x0, held.x1)];
        const [y0, y1] = [Math.min(held.y0, held.y1), Math.max(held.y0, held.y1)];
        ctx.fillStyle = 'rgba(91, 160, 250, 0.12)';
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
        ctx.strokeStyle = accent;
        ctx.lineWidth = 1;
        ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0, y1 - y0);
      }
      drawRuler(ctx);
      // What an edge lined up with.
      if (guide !== null) {
        ctx.fillStyle = cssVar('--guide') || '#ff3d9a';
        ctx.fillRect(Math.round(xOf(guide)) - 0.5, RULER, 1, H - RULER);
      }
      // The playhead, in the accent, down the whole timeline.
      const px = Math.round(xOf(ph));
      if (px >= -6 && px <= W + 6) {
        ctx.fillStyle = accent;
        ctx.fillRect(px - 0.5, RULER - 4, 1.5, H);
        ctx.beginPath();
        ctx.moveTo(px - 6, 2);
        ctx.lineTo(px + 6.5, 2);
        ctx.lineTo(px + 6.5, RULER - 9);
        ctx.lineTo(px + 0.5, RULER - 3);
        ctx.lineTo(px - 6, RULER - 9);
        ctx.closePath();
        ctx.fill();
      }
      want.sort((a, b) => a.d - b.d);
      FR.ask(want.slice(0, 200));
    }

    function drawRuler(ctx) {
      ctx.fillStyle = '#161616';
      ctx.fillRect(0, 0, W, RULER);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
      ctx.fillRect(0, RULER - 1, W, 1);
      const fps = doc.fps;
      // A labelled mark at least seventy pixels apart, at a step an editor would count in.
      const steps = [1, 2, 5, 10, Math.round(fps / 2), Math.round(fps), 2 * fps, 5 * fps, 10 * fps, 15 * fps, 30 * fps, 60 * fps, 120 * fps, 300 * fps, 600 * fps, 1800 * fps];
      const big = steps.find((s) => s * ppf >= 70) || steps[steps.length - 1];
      const small = steps.slice().reverse().find((s) => s < big && s * ppf >= 8 && big % s < 1e-6) || null;
      const f0 = Math.max(0, Math.floor(fAt(0) / big) * big);
      const f1 = fAt(W);
      ctx.font = FONT(500, 10);
      ctx.textBaseline = 'alphabetic';
      if (small) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
        for (let f = Math.floor(fAt(0) / small) * small; f <= f1; f += small) {
          if (f < 0) continue;
          ctx.fillRect(Math.round(xOf(f)), RULER - 5, 1, 4);
        }
      }
      for (let f = f0; f <= f1; f += big) {
        const x = Math.round(xOf(f));
        ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
        ctx.fillRect(x, RULER - 10, 1, 9);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.62)';
        ctx.fillText(fmt(Math.round(f)), x + 4, 12);
      }
    }

    function drawClip(ctx, c, { want, faded = false, lifted = false }) {
      const r = rowOf(c.track);
      if (!r) return;
      const x0 = xOf(c.start);
      const x1 = xOf(C.clipEnd(c));
      if (x1 < -2 || x0 > W + 2) return;
      const y = yOf(r) + 2;
      const h = r.h - 4;
      if (y > H || y + h < RULER) return;
      const length = lengthOf(c);
      const own = C.filled(c, length);
      const xf = xOf(c.start + own);
      const on = sel.has(c.id);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, RULER, W, H - RULER);
      ctx.clip();
      ctx.globalAlpha = faded ? 0.35 : lifted ? 0.85 : 1;
      const left = Math.max(x0, -2);
      const right = Math.min(xf, W + 2);
      // What its source fills: its pictures, or its sound, under a band with its name.
      if (right > left) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0 + 0.5, y, xf - x0 - 1, h);
        ctx.clip();
        ctx.fillStyle = CLIP_BG;
        ctx.fillRect(left, y, right - left, h);
        if (c.media) drawWave(ctx, c, x0, y + BAND, h - BAND, left, right);
        else drawPictures(ctx, c, length, x0, y + BAND, h - BAND, left, right, want);
        ctx.fillStyle = on ? BAND_ON : BAND_BG;
        ctx.fillRect(left, y, right - left, BAND);
        drawFades(ctx, c, x0, xf, y, h);
        drawLabel(ctx, c, x0, xf, y, on);
        ctx.restore();
      }
      // What a short version leaves of it: its outline only, and how short it came up.
      if (xf < x1 - 1) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.setLineDash([3, 3]);
        ctx.lineWidth = 1;
        ctx.strokeRect(Math.max(xf, -2) + 0.5, y + 0.5, Math.min(x1, W + 2) - Math.max(xf, -2) - 1, h - 1);
        ctx.setLineDash([]);
        const short = c.len - own;
        const text = own ? `${short} ${short === 1 ? 'frame' : 'frames'} short` : 'nothing to play from here';
        ctx.font = FONT(400, 10);
        if (ctx.measureText(text).width + 12 < x1 - xf) {
          ctx.fillStyle = QUIET;
          ctx.fillText(text, Math.max(xf, 0) + 6, y + h / 2 + 4);
        }
      }
      // Where a loop starts over.
      if (c.loop && Number.isFinite(length) && length >= 1) {
        const n = Math.floor(length);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
        for (let k = n - c.in; k < c.len; k += n) {
          if (k <= 0) continue;
          const x = xOf(c.start + k);
          if (x < 0 || x > W) continue;
          ctx.fillRect(Math.round(x), y + BAND, 1, h - BAND);
          ctx.beginPath();
          ctx.arc(Math.round(x) + 0.5, y + BAND + 4, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      if (on) {
        ctx.strokeStyle = accentNow;
        ctx.lineWidth = 2;
        ctx.strokeRect(x0 + 1, y + 1, Math.max(2, x1 - x0 - 2), h - 2);
      }
      // The handles that draw out its fades, on what is picked or under the pointer, just under its band.
      if ((on || (hover && hover.clip === c.id)) && !lifted && xf - x0 > 28) {
        const [hx0, hx1] = fadeHandles(c, x0, xf);
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.lineWidth = 1;
        for (const hx of [hx0, hx1]) {
          ctx.beginPath();
          ctx.rect(Math.round(hx) - 3.5, y + BAND + 2.5, 7, 7);
          ctx.fill();
          ctx.stroke();
        }
      }
      ctx.restore();
    }
    // Where a clip's fade handles are: at the end of its fade in (or the dissolve into it), and at the start
    // of its fade out.
    function fadeHandles(c, x0, xf) {
      const d = C.dissolveOf(doc, c);
      const hx0 = x0 + 6 + (d ? d.post : c.fadeIn || 0) * ppf;
      const hx1 = xf - 6 - (c.fadeOut || 0) * ppf;
      return [Math.min(hx0, xf - 6), Math.max(hx1, x0 + 6)];
    }

    function drawPictures(ctx, c, length, x0, y, h, left, right, want) {
      const look = lookOf(c);
      if (!look) {
        // Nothing filed: a slate's stripes.
        ctx.strokeStyle = '#242424';
        ctx.lineWidth = 6;
        for (let x = Math.floor(left / 14) * 14 - h; x < right + h; x += 14) {
          ctx.beginPath();
          ctx.moveTo(x, y + h);
          ctx.lineTo(x + h, y);
          ctx.stroke();
        }
        return;
      }
      const aspect = look.nw && look.nh ? look.nw / look.nh : 16 / 9;
      const tileW = Math.max(8, h * aspect);
      const first = Math.max(0, Math.floor((left - x0) / tileW));
      const last = Math.ceil((right - x0) / tileW);
      const src = look.type === 'video' ? srcOf(look) : null;
      const still = look.type === 'video' ? null : FR.imageOf(look.prev || look.src);
      const poster = look.type === 'video' && (look.th || look.poster) ? FR.imageOf(look.th || look.poster) : null;
      for (let k = first; k < last; k++) {
        const x = x0 + k * tileW;
        const fEdit = c.start + (k * tileW) / ppf;
        let pic = still;
        if (src) {
          const sf = C.sourceFrame(c, Math.floor(fEdit), length);
          const at = Math.round((sf / doc.fps) * 24) / 24;
          const key = FR.key(src, at);
          pic = FR.take(key);
          if (!pic) {
            want.push({ key, src, at, d: Math.abs(fEdit - ph) });
            const rgb = look.dur ? FR.colourAt(look, clamp(at / look.dur, 0, 1)) : null;
            if (rgb) {
              ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
              ctx.fillRect(x, y, tileW, h / 2);
              ctx.fillStyle = `rgb(${rgb[3]},${rgb[4]},${rgb[5]})`;
              ctx.fillRect(x, y + h / 2, tileW, h - h / 2);
            } else pic = poster;
          }
        }
        if (pic) FR.drawCover(ctx, pic, x, y, tileW, h);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
        ctx.fillRect(x + tileW - 1, y, 1, h);
      }
    }

    function drawWave(ctx, c, x0, y, h, left, right) {
      const s = sounds.get(c.media);
      const mid = y + h / 2;
      if (!s || !s.peaks) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
        ctx.fillRect(left, mid, right - left, 1);
        return;
      }
      const per = 100 / doc.fps; // peaks a frame
      ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
      for (let x = Math.floor(left); x < right; x++) {
        const fa = c.in + (x - x0) / ppf;
        const fb = c.in + (x + 1 - x0) / ppf;
        let m = 0;
        for (let i = Math.floor(fa * per); i < Math.ceil(fb * per) && i < s.peaks.length; i++) if (i >= 0 && s.peaks[i] > m) m = s.peaks[i];
        const a = Math.max(0.5, m * (h / 2 - 2));
        ctx.fillRect(x, mid - a, 1, a * 2);
      }
    }

    function drawFades(ctx, c, x0, xf, y, h) {
      const d = C.dissolveOf(doc, c);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.lineWidth = 1;
      const fin = d ? 0 : Math.min(c.fadeIn || 0, c.len);
      if (fin > 0) {
        const xa = x0 + fin * ppf;
        ctx.beginPath();
        ctx.moveTo(x0, y + BAND);
        ctx.lineTo(xa, y + BAND);
        ctx.lineTo(x0, y + h);
        ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(x0, y + h);
        ctx.lineTo(xa, y + BAND);
        ctx.stroke();
      }
      const fout = c.fadeOut || 0;
      if (fout > 0 && !(C.after(doc, c) && C.dissolveOf(doc, C.after(doc, c)))) {
        const xa = xf - fout * ppf;
        ctx.beginPath();
        ctx.moveTo(xf, y + BAND);
        ctx.lineTo(xa, y + BAND);
        ctx.lineTo(xf, y + h);
        ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(xa, y + BAND);
        ctx.lineTo(xf, y + h);
        ctx.stroke();
      }
    }

    function drawLabel(ctx, c, x0, xf, y, on) {
      const p = c.shot ? shots[c.shot] : null;
      const name = p ? p.name : c.name || 'Sound';
      const rest = p ? (p.version ? versionPart(p.version.label, p.name) : 'nothing filed') : '';
      ctx.font = FONT(600, 11);
      const nw = ctx.measureText(name).width;
      ctx.font = FONT(400, 11);
      const rw = rest ? ctx.measureText(rest).width + 6 : 0;
      // Held at the left of the timeline while the rest of the clip is still in sight.
      const tx = clamp(Math.max(x0, 0) + 6, x0 + 6, Math.max(x0 + 6, xf - nw - rw - 6));
      const base = y + BAND - 4;
      ctx.fillStyle = on ? '#111' : TEXT;
      ctx.font = FONT(600, 11);
      ctx.fillText(name, tx, base);
      if (rest) {
        ctx.fillStyle = on ? 'rgba(0, 0, 0, 0.6)' : QUIET;
        ctx.font = FONT(400, 11);
        ctx.fillText(rest, tx + nw + 6, base);
      }
    }

    // ---- taking hold of the timeline

    const local = (e) => {
      const r = cv.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    function rowAt(y) {
      return rows.find((r) => y >= yOf(r) && y < yOf(r) + r.h) || null;
    }
    // What is under a point: the ruler, a clip (its body, an edge, or a fade handle), or a track's empty place.
    function hitAt(x, y) {
      if (y < RULER) return { kind: 'ruler' };
      const r = rowAt(y);
      if (!r) return { kind: 'none' };
      const f = fAt(x);
      const list = C.onTrack(doc, r.track.id).reverse();
      for (const c of list) {
        const x0 = xOf(c.start);
        const x1 = xOf(C.clipEnd(c));
        if (x < x0 - EDGE / 2 || x > x1 + EDGE / 2) continue;
        const xf = xOf(c.start + C.filled(c, lengthOf(c)));
        const top = yOf(r) + 2;
        if ((sel.has(c.id) || (hover && hover.clip === c.id)) && xf - x0 > 28 && y >= top + BAND - 2 && y < top + BAND + 13) {
          const [hx0, hx1] = fadeHandles(c, x0, xf);
          if (Math.abs(x - hx0) <= 6) return { kind: 'clip', clip: c, part: 'fadeIn', row: r };
          if (Math.abs(x - hx1) <= 6) return { kind: 'clip', clip: c, part: 'fadeOut', row: r };
        }
        if (x1 - x0 > EDGE * 3) {
          if (Math.abs(x - x0) <= EDGE) return { kind: 'clip', clip: c, part: 'start', row: r };
          if (Math.abs(x - x1) <= EDGE) return { kind: 'clip', clip: c, part: 'end', row: r };
        }
        if (f >= c.start && f < C.clipEnd(c)) return { kind: 'clip', clip: c, part: 'body', row: r };
      }
      return { kind: 'lane', row: r };
    }
    const CURSOR = { start: 'ew-resize', end: 'ew-resize', fadeIn: 'col-resize', fadeOut: 'col-resize', body: 'grab' };

    // An edge lined up with what is near it: the snapped frame, or the one given.
    function snapped(f, skip, e) {
      guide = null;
      if (!snapping || e.ctrlKey || e.metaKey) return f;
      const near = C.nearest(f, C.snapPoints(doc, skip, Math.round(ph)), SNAP_PX / ppf);
      if (near === null) return f;
      guide = near;
      return near;
    }

    cv.addEventListener('pointerdown', (e) => {
      if (!doc || e.button !== 0) return;
      scroller.focus({ preventScroll: true });
      const p = local(e);
      const hit = hitAt(p.x, p.y);
      try {
        cv.setPointerCapture(e.pointerId);
      } catch {
        // capture is a nicety
      }
      if (hit.kind === 'ruler') {
        const wasPlaying = playing;
        if (playing) stop();
        held = { kind: 'scrub', pid: e.pointerId, wasPlaying };
        seek(fAt(p.x));
        return;
      }
      if (hit.kind === 'clip') {
        const c = hit.clip;
        if (e.shiftKey) {
          if (sel.has(c.id)) sel.delete(c.id);
          else sel.add(c.id);
        } else if (!sel.has(c.id) || hit.part !== 'body') sel = new Set([c.id]);
        held = { kind: hit.part, pid: e.pointerId, x: p.x, y: p.y, clip: c, row: hit.row, copy: e.altKey, moved: false, solo: !e.shiftKey && sel.size > 1 && hit.part === 'body' };
        draw();
        return;
      }
      if (hit.kind === 'lane' || hit.kind === 'none') {
        if (!e.shiftKey) sel = new Set();
        held = { kind: 'box', pid: e.pointerId, x0: p.x, y0: p.y, x1: p.x, y1: p.y, base: new Set(sel), moved: false };
        draw();
      }
    });

    cv.addEventListener('pointermove', (e) => {
      if (!doc) return;
      const p = local(e);
      if (!held) {
        const hit = hitAt(p.x, p.y);
        const was = hover && hover.clip;
        hover = hit.kind === 'clip' ? { clip: hit.clip.id, part: hit.part } : null;
        cv.style.cursor = hit.kind === 'clip' ? CURSOR[hit.part] : hit.kind === 'ruler' ? 'text' : 'default';
        if ((hover && hover.clip) !== was) draw();
        return;
      }
      if (e.pointerId !== held.pid) return;
      if (held.kind === 'scrub') return void seek(fAt(p.x));
      if (held.kind === 'box') {
        held.x1 = p.x;
        held.y1 = p.y;
        held.moved = true;
        const [fa, fb] = [fAt(Math.min(held.x0, p.x)), fAt(Math.max(held.x0, p.x))];
        const [ya, yb] = [Math.min(held.y0, p.y), Math.max(held.y0, p.y)];
        sel = new Set(held.base);
        for (const c of doc.clips) {
          const r = rowOf(c.track);
          if (r && C.clipEnd(c) > fa && c.start < fb && yOf(r) + r.h > ya && yOf(r) < yb) sel.add(c.id);
        }
        return void draw();
      }
      const dx = p.x - held.x;
      if (!held.moved && Math.abs(dx) < 3 && Math.abs(p.y - held.y) < 3) return;
      held.moved = true;
      const c = held.clip;
      const length = lengthOf(c);
      if (held.kind === 'body') {
        const moving = doc.clips.filter((x) => sel.has(x.id));
        const skip = new Set(moving.map((x) => x.id));
        let df = Math.round(dx / ppf);
        const lo = Math.min(...moving.map((x) => x.start));
        df = Math.max(df, -lo);
        // The edge of the group nearest a place lines up with it.
        if (snapping && !(e.ctrlKey || e.metaKey)) {
          guide = null;
          let best = null;
          const points = C.snapPoints(doc, skip, Math.round(ph));
          for (const x of moving) {
            for (const edge of [x.start + df, C.clipEnd(x) + df]) {
              const near = C.nearest(edge, points, SNAP_PX / ppf);
              if (near !== null && (best === null || Math.abs(near - edge) < Math.abs(best.d))) best = { d: near - edge, at: near };
            }
          }
          if (best) {
            df += best.d;
            guide = best.at;
          }
        } else guide = null;
        // Up or down a track, among tracks of their kind; never off the end.
        const r = rowAt(p.y);
        let dt = 0;
        if (r) {
          const kinds = (k) => doc.tracks.filter((t) => t.kind === k);
          const list = kinds(C.trackOf(doc, c).kind);
          const from = list.findIndex((t) => t.id === c.track);
          const to = list.findIndex((t) => t.id === r.track.id);
          if (to >= 0) {
            dt = to - from;
            for (const x of moving) {
              const l2 = kinds(C.trackOf(doc, x).kind);
              const i = l2.findIndex((t) => t.id === x.track) + dt;
              if (i < 0 || i >= l2.length) dt = 0;
            }
          }
        }
        held.preview = moving.map((x) => {
          const l2 = doc.tracks.filter((t) => t.kind === C.trackOf(doc, x).kind);
          const track = l2[l2.findIndex((t) => t.id === x.track) + dt].id;
          return { ...x, start: x.start + df, track };
        });
      } else if (held.kind === 'start') {
        const want = snapped(c.start + Math.round(dx / ppf), new Set([c.id]), e);
        held.preview = [C.trimStart(c, want - c.start, length)];
      } else if (held.kind === 'end') {
        const want = snapped(C.clipEnd(c) + Math.round(dx / ppf), new Set([c.id]), e);
        held.preview = [C.trimEnd(c, want - C.clipEnd(c), length)];
      } else if (held.kind === 'fadeIn' || held.kind === 'fadeOut') {
        const own = C.filled(c, length);
        const prev = C.before(doc, c);
        const next = C.after(doc, c);
        if (held.kind === 'fadeIn') {
          const n = clamp(Math.round((p.x - xOf(c.start) - 6) / ppf), 0, own);
          // At a cut, the handle makes a dissolve; elsewhere a fade from what is under it.
          held.result = prev ? { id: c.id, patch: { dissolve: Math.min(n * 2, c.len, prev.len), fadeIn: 0 } } : { id: c.id, patch: { fadeIn: Math.min(n, own - (c.fadeOut || 0)) } };
        } else {
          const n = clamp(Math.round((xOf(c.start + own) - 6 - p.x) / ppf), 0, own);
          held.result = next && own === c.len
            ? { id: next.id, patch: { dissolve: Math.min(n * 2, next.len, c.len), fadeIn: 0 }, also: { id: c.id, patch: { fadeOut: 0 } } }
            : { id: c.id, patch: { fadeOut: Math.min(n, own - (c.fadeIn || 0)) } };
        }
        held.preview = null;
        const patched = applyPatch(doc, held.result);
        held.shadow = patched;
        drawWith(patched);
        return;
      }
      draw();
    });

    // Draws the timeline as if the edit were `d`, while a fade is drawn out.
    function drawWith(d) {
      const keep = doc;
      doc = d;
      draw();
      doc = keep;
    }
    function applyPatch(d, result) {
      let clips = d.clips.map((x) => (x.id === result.id ? { ...x, ...result.patch } : x));
      if (result.also) clips = clips.map((x) => (x.id === result.also.id ? { ...x, ...result.also.patch } : x));
      return { ...d, clips };
    }

    const letGo = (e) => {
      if (!held || e.pointerId !== held.pid) return;
      const h = held;
      held = null;
      guide = null;
      if (h.kind === 'scrub') {
        if (h.wasPlaying) play();
        return;
      }
      if (h.kind === 'box') {
        // A click on an empty place goes there.
        if (!h.moved) seek(fAt(h.x0));
        return void draw();
      }
      if (!h.moved) {
        // A click on one of several picked picks it alone.
        if (h.solo && e.type === 'pointerup') sel = new Set([h.clip.id]);
        return void draw();
      }
      if (e.type === 'pointercancel') return void draw();
      if (h.kind === 'fadeIn' || h.kind === 'fadeOut') return void commit(h.shadow || doc);
      if (!h.preview || !h.preview.length) return void draw();
      const placed = h.copy && h.kind === 'body' ? h.preview.map((c) => ({ ...c, id: newId() })) : h.preview;
      commit(C.place(doc, placed, newId, lengthOf));
      sel = new Set(placed.map((c) => c.id));
      paintAll();
    };
    cv.addEventListener('pointerup', letGo);
    cv.addEventListener('pointercancel', letGo);
    cv.addEventListener('pointerleave', () => {
      if (!held && hover) {
        hover = null;
        draw();
      }
    });
    cv.addEventListener('dblclick', (e) => {
      const p = local(e);
      const hit = hitAt(p.x, p.y);
      if (hit.kind === 'clip') seek(fAt(p.x));
    });

    // The wheel moves along the timeline (down a long list of tracks only where there are that many); with
    // Ctrl or Cmd, or a pinch, it draws the timeline in or out about the pointer.
    scroller.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoomTo(ppf * Math.exp(-e.deltaY * 0.0025), local(e).x);
        return;
      }
      const tall = scroller.scrollHeight > scroller.clientHeight + 1;
      if (!tall && Math.abs(e.deltaY) > Math.abs(e.deltaX) && !e.shiftKey) {
        e.preventDefault();
        scroller.scrollLeft += e.deltaY * (e.deltaMode === 1 ? 16 : 1);
      }
    }, { passive: false });

    // Shots dragged from the list, and sound files from the desktop, land where they are let go.
    function dropAt(e) {
      const p = local(e);
      const r = rowAt(p.y);
      return { r, f: Math.max(0, Math.round(fAt(p.x))) };
    }
    scroller.addEventListener('dragover', (e) => {
      const types = [...e.dataTransfer.types];
      if (!types.includes('application/x-wb-shots') && !types.includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      if (!types.includes('application/x-wb-shots') || !dragShots) return;
      const { r, f } = dropAt(e);
      const track = r && r.track.kind === 'video' ? r.track.id : trackInUse();
      const list = clipsOf(dragShots, track, f);
      const at = snapped(f, new Set(), e);
      ghost = list.map((c) => ({ ...c, start: c.start - f + at }));
      draw();
    });
    scroller.addEventListener('dragleave', (e) => {
      if (e.relatedTarget && scroller.contains(e.relatedTarget)) return;
      ghost = null;
      guide = null;
      draw();
    });
    scroller.addEventListener('drop', (e) => {
      e.preventDefault();
      const { r, f } = dropAt(e);
      const raw = e.dataTransfer.getData('application/x-wb-shots');
      if (raw) {
        let ids = [];
        try {
          ids = JSON.parse(raw);
        } catch {
          // not ours
        }
        const placed = ghost && ghost.length ? ghost : clipsOf(ids, r && r.track.kind === 'video' ? r.track.id : trackInUse(), f);
        ghost = null;
        guide = null;
        dragShots = null;
        if (!placed.length) return void draw();
        commit(C.place(doc, placed, newId, lengthOf));
        sel = new Set(placed.map((c) => c.id));
        return void paintAll();
      }
      const files = [...e.dataTransfer.files];
      if (files.length) addSounds(files, { track: r && r.track.kind === 'audio' ? r.track.id : null, at: f });
    });
    // Sound files dropped anywhere else on the page go at the playhead.
    const pageDrop = (e) => {
      if (![...e.dataTransfer.types].includes('Files')) return;
      e.preventDefault();
      if (e.type === 'drop') addSounds([...e.dataTransfer.files]);
    };
    top.addEventListener('dragover', pageDrop);
    top.addEventListener('drop', pageDrop);

    // A clip's own menu.
    cv.addEventListener('contextmenu', (e) => {
      const p = local(e);
      const hit = hitAt(p.x, p.y);
      if (hit.kind !== 'clip') return;
      e.preventDefault();
      if (!sel.has(hit.clip.id)) sel = new Set([hit.clip.id]);
      draw();
      const anchor = el('span', { class: 'an-anchor', style: { left: `${e.clientX}px`, top: `${e.clientY - 4}px` } });
      document.body.append(anchor);
      WB.menu(anchor, clipMenu(hit.clip), { align: 'left' });
      setTimeout(() => anchor.remove(), 0);
    });
    function clipMenu(c) {
      const picked = doc.clips.filter((x) => sel.has(x.id));
      const many = picked.length > 1;
      const shotsPicked = picked.filter((x) => x.shot);
      const second = frames(1);
      const patchAll = (fn) => commit({ ...doc, clips: doc.clips.map((x) => (sel.has(x.id) ? fn(x) : x)) });
      const loopOn = shotsPicked.length && shotsPicked.every((x) => x.loop);
      return [
        shotsPicked.length > 0 && [loopOn ? 'Stop looping' : 'Loop', () => patchAll((x) => (x.shot ? { ...x, loop: !loopOn } : x))],
        ['Fade in and out by a second', () => patchAll((x) => {
          const own = C.filled(x, lengthOf(x));
          const n = Math.min(second, Math.floor(own / 2));
          return { ...x, fadeIn: n, fadeOut: n };
        })],
        ['No fades', () => patchAll((x) => ({ ...x, fadeIn: 0, fadeOut: 0, dissolve: 0 }))],
        c.start < ph && C.clipEnd(c) > ph && ['Cut in two at the playhead', () => splitAtPlayhead()],
        !many && c.shot && ['Open the shot', () => { location.hash = WB.href.catalogue(project.id, { entity: c.shot }); }],
        [many ? `Delete ${picked.length} clips` : 'Delete', () => removePicked(), true],
      ];
    }

    function removePicked() {
      if (!sel.size) return;
      commit({ ...doc, clips: doc.clips.filter((c) => !sel.has(c.id)) });
      sel = new Set();
      paintAll();
    }
    // What is picked under the playhead, or everything under it when nothing picked is, cut in two there.
    function splitAtPlayhead() {
      const at = Math.round(ph);
      const under = doc.clips.filter((c) => c.start < at && C.clipEnd(c) > at);
      const which = under.some((c) => sel.has(c.id)) ? under.filter((c) => sel.has(c.id)) : under;
      if (!which.length) return;
      const halves = new Map(which.map((c) => [c.id, C.split(c, at, newId(), lengthOf(c))]));
      const clips = doc.clips.flatMap((c) => halves.get(c.id) || [c]);
      commit({ ...doc, clips: clips.sort((a, b) => a.start - b.start) });
      sel = new Set([...halves.values()].map((h) => h[1].id));
      paintAll();
    }

    // ---- the tracks' heads: each with its name, its sound and (a video track) whether it shows

    function paintHeads() {
      if (!doc) return;
      headsIn.replaceChildren(
        el('div', { class: 'an-head-ruler' },
          el('button', { type: 'button', class: 'iconbtn an-zoom', text: '−', title: 'Show more of the edit (Ctrl + wheel)', 'aria-label': 'Show more of the edit', onclick: () => zoomTo(ppf / 1.5) }),
          el('button', { type: 'button', class: 'iconbtn an-zoom', text: '+', title: 'Show less of it, closer (Ctrl + wheel)', 'aria-label': 'Show less of the edit, closer', onclick: () => zoomTo(ppf * 1.5) })),
        ...rows.flatMap((r, i) => {
          const t = r.track;
          const gap = i > 0 && rows[i - 1].track.kind !== t.kind ? [el('div', { class: 'an-head-gap', style: { height: `${SPLIT}px` } })] : [];
          const setTrack = (patch) => commit({ ...doc, tracks: doc.tracks.map((x) => (x.id === t.id ? { ...x, ...patch } : x)) });
          return [...gap, el('div', { class: `an-head ${t.kind}${t.mute ? ' muted' : ''}${t.hide ? ' hidden-track' : ''}`, style: { height: `${r.h}px` } },
            el('span', { class: 'an-head-name', text: t.name, title: t.name }),
            t.kind === 'video' && el('button', { type: 'button', class: `iconbtn${t.hide ? ' off' : ''}`, html: t.hide ? ICON.eyeOff : ICON.eye, title: t.hide ? 'Hidden: click to show it' : 'Shown: click to hide it', 'aria-pressed': String(!t.hide), onclick: () => setTrack({ hide: !t.hide }) }),
            el('button', { type: 'button', class: `iconbtn${t.mute ? ' off' : ''}`, html: t.mute ? ICON.muted : ICON.sound, title: t.mute ? 'Its sound is off: click to hear it' : 'Its sound is on: click to turn it off', 'aria-pressed': String(!t.mute), onclick: () => setTrack({ mute: !t.mute }) }),
            el('button', { type: 'button', class: 'iconbtn', html: ICON.more, title: 'More', 'aria-haspopup': 'menu', onclick: (e) => WB.menu(e.currentTarget, trackMenu(t)) }))];
        }),
        el('div', { class: 'an-head-add' },
          el('button', { type: 'button', class: 'btn small ghost', html: `${ICON.plus}<span>Video track</span>`, onclick: () => addTrack('video') }),
          el('button', { type: 'button', class: 'btn small ghost', html: `${ICON.plus}<span>Sound track</span>`, onclick: () => addTrack('audio') })));
    }
    // An edit with one more track of a kind, above the others of it: a video track's own sound is off once the
    // edit has a sound file.
    function withTrack(d, kind) {
      const n = d.tracks.filter((t) => t.kind === kind).length + 1;
      let tid = `${kind === 'video' ? 'v' : 'a'}${n}`;
      while (d.tracks.some((t) => t.id === tid)) tid = `${tid}x`;
      const track = kind === 'video' ? { id: tid, kind, name: `V${n}`, mute: d.clips.some((c) => c.media), hide: false } : { id: tid, kind, name: `A${n}`, mute: false, gain: 1 };
      return { ...d, tracks: [...d.tracks, track] };
    }
    function addTrack(kind) {
      if (doc.tracks.length >= 16) return void WB.toast('An edit has sixteen tracks at most.');
      commit(withTrack(doc, kind));
    }
    function trackMenu(t) {
      const same = doc.tracks.filter((x) => x.kind === t.kind);
      const has = doc.clips.filter((c) => c.track === t.id).length;
      return [
        ['Rename…', async () => {
          const v = await WB.dialog({ title: 'Rename track', value: t.name, placeholder: 'Track name', ok: 'Rename', maxlength: 40 });
          if (v && v !== t.name) commit({ ...doc, tracks: doc.tracks.map((x) => (x.id === t.id ? { ...x, name: v } : x)) });
        }],
        t.kind === 'audio' && ['Louder or quieter…', async () => {
          const v = await WB.dialog({ title: `${t.name}'s level`, text: 'As a percentage: 100 is as it is, 50 half as loud, up to 200.', value: String(Math.round((t.gain ?? 1) * 100)), ok: 'Set', maxlength: 3 });
          const n = Number(v);
          if (v !== null && Number.isFinite(n)) commit({ ...doc, tracks: doc.tracks.map((x) => (x.id === t.id ? { ...x, gain: clamp(n / 100, 0, 2) } : x)) });
        }],
        same.length > 1 && [has ? `Delete track and its ${has} ${has === 1 ? 'clip' : 'clips'}` : 'Delete track', () => commit({ ...doc, tracks: doc.tracks.filter((x) => x.id !== t.id), clips: doc.clips.filter((c) => c.track !== t.id) }), true],
      ];
    }

    // ---- what is said about the shot on screen: its version's comments, live, in the shot's room

    let room = null;
    let roomOf = null;
    let roomNotes = [];
    let joinTimer = 0;
    let nowVersion = null;
    let nowShotClip = null;
    function joinShot(c) {
      const v = c && c.shot ? versionOf(c) : null;
      nowShotClip = v ? c : null;
      nowVersion = v;
      paintNotes();
      clearTimeout(joinTimer);
      const shot = v ? c.shot : null;
      if (shot === roomOf) return;
      // A beat later, so playing through does not hop from room to room.
      joinTimer = setTimeout(() => {
        if (closed || shot === roomOf) return;
        if (room) room.close();
        room = null;
        roomOf = shot;
        roomNotes = [];
        if (shot) {
          room = V.entityRoom(shot, me, (list) => {
            roomNotes = list;
            paintNotes();
          });
        }
        paintNotes();
      }, roomOf ? 400 : 0);
    }
    function toggleNotes() {
      notes.hidden = !notes.hidden;
      store('wb:an:notes', !notes.hidden);
      notesBtn.classList.toggle('active', !notes.hidden);
      notesBtn.setAttribute('aria-pressed', String(!notes.hidden));
      fitFrame();
      paintNotes();
    }
    // Where in its version a frame of the edit is: { at (seconds), fr (its own frame) }.
    function momentIn(c, f) {
      const look = lookOf(c);
      const sf = C.sourceFrame(c, Math.floor(f), lengthOf(c));
      const at = V.frameTime(sf, doc.fps);
      return { at, fr: look && look.fps ? Math.floor(at * look.fps + 1e-3) : null };
    }
    // The frame of the edit a comment is about, where its clip shows that moment, or null.
    function frameOfNote(n) {
      if (!nowShotClip || !Number.isFinite(n.at)) return null;
      const c = nowShotClip;
      const f = c.start + Math.floor(n.at * doc.fps) - c.in;
      return f >= c.start && f < c.start + C.filled(c, lengthOf(c)) ? f : null;
    }
    function paintNotes() {
      if (notes.hidden) return;
      const v = nowVersion;
      const p = nowShotClip ? shots[nowShotClip.shot] : null;
      notesTitle.replaceChildren(...(p && v ? [el('b', { text: p.name }), el('span', { text: versionPart(v.label, p.name) })] : [el('span', { text: 'Comments on the shot on screen' })]));
      noteBox.disabled = !v;
      noteSend.disabled = !v;
      noteBox.placeholder = v ? `Comment on ${p.name}` : 'Nothing filed is on screen to comment on';
      if (v) {
        const m = momentIn(nowShotClip, ph);
        noteAt.textContent = `at ${V.fmtMoment(m.at, lookOf(nowShotClip)?.fps || doc.fps)} in ${versionPart(v.label, p.name) || 'it'}`;
      } else noteAt.textContent = '';
      if (!v) return void notesList.replaceChildren();
      const mine = roomNotes.filter((n) => n.type === 'comment' && n.on === v.id);
      const roots = mine.filter((n) => !n.re).sort((a, b) => (a.at ?? -1) - (b.at ?? -1) || a.t - b.t);
      if (!roots.length) return void notesList.replaceChildren(el('p', { class: 'an-notes-empty', text: roomOf === nowShotClip.shot ? 'Nothing said about this version yet.' : 'Loading…' }));
      notesList.replaceChildren(...roots.map((n) => {
        const replies = mine.filter((x) => x.re === n.id).sort((a, b) => a.t - b.t);
        const f = frameOfNote(n);
        const line = (x) => el('div', { class: 'an-note' },
          el('div', { class: 'an-note-who' },
            el('i', { class: 'an-note-dot', style: { background: x.color || '#888' } }),
            el('b', { text: x.name || 'Somebody' }),
            el('span', { text: WB.ago(x.t) }),
            x === n && Number.isFinite(x.at) && el('span', { class: 'an-note-when', text: V.fmtMoment(x.at, lookOf(nowShotClip)?.fps || doc.fps) })),
          el('p', { text: x.text }));
        return el('div', {
          class: `an-thread${n.done ? ' done' : ''}${f !== null ? ' seekable' : ''}`,
          onclick: (e) => { if (f !== null && !e.target.closest('button')) seek(f); },
        },
        line(n), ...replies.map(line),
        el('div', { class: 'an-thread-acts' },
          el('button', { type: 'button', class: 'an-act', text: 'Reply', onclick: () => replyTo(n) }),
          el('button', { type: 'button', class: 'an-act', text: n.done ? 'Open again' : 'Resolve', onclick: () => room && room.send([{ t: 'set', id: n.id, patch: { done: !n.done } }]) }),
          n.name === me.name && el('button', { type: 'button', class: 'an-act danger', text: 'Delete', onclick: () => deleteNote(n) })));
      }));
    }
    let replyRoot = null;
    function replyTo(n) {
      replyRoot = n;
      noteBox.placeholder = `Reply to ${n.name}`;
      noteBox.focus();
    }
    function sendNote() {
      const text = noteBox.value.trim();
      if (!text || !nowVersion || !nowShotClip) return;
      const c = { id: WB.uid(), type: 'comment', text: text.slice(0, 2000), name: me.name, color: me.color, t: Date.now(), done: false, on: nowVersion.id };
      if (replyRoot && replyRoot.on === nowVersion.id) c.re = replyRoot.id;
      else Object.assign(c, momentIn(nowShotClip, ph));
      if (c.fr === null) delete c.fr;
      roomNotes = [...roomNotes, c];
      if (!room || roomOf !== nowShotClip.shot) {
        if (room) room.close();
        roomOf = nowShotClip.shot;
        room = V.entityRoom(roomOf, me, (list) => {
          roomNotes = list;
          paintNotes();
        });
      }
      room.send([{ t: 'add', item: c }]);
      noteBox.value = '';
      replyRoot = null;
      noteBox.blur();
      paintNotes();
    }
    async function deleteNote(n) {
      const sure = await WB.dialog({ title: 'Delete it?', text: 'It goes for everyone, on every board the version is on.', ok: 'Delete', danger: true });
      if (!sure || !room) return;
      roomNotes = roomNotes.filter((x) => x.id !== n.id && x.re !== n.id);
      room.send([{ t: 'del', ids: [n.id] }]);
      paintNotes();
    }
    noteBox.addEventListener('focus', () => { if (playing) stop(); });
    noteBox.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendNote();
      } else if (e.key === 'Escape') {
        replyRoot = null;
        noteBox.blur();
        paintNotes();
      }
      e.stopPropagation();
    });

    // ---- the keys

    function onKey(e) {
      if (!doc || closed || e.defaultPrevented) return;
      if (WB.isTyping(e.target) || (e.target instanceof HTMLInputElement) || document.querySelector('dialog[open]')) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key;
      let done = true;
      if (k === ' ' || (k === 'k' && !mod)) playing ? stop() : play();
      else if (k === ',' || k === '<') step(e.shiftKey ? -Math.round(doc.fps) : -1);
      else if (k === '.' || k === '>') step(e.shiftKey ? Math.round(doc.fps) : 1);
      else if (k === 'ArrowLeft' && !mod) toCut(-1);
      else if (k === 'ArrowRight' && !mod) toCut(1);
      else if (k === 'Home') seek(0);
      else if (k === 'End') seek(endFrame());
      else if (k === 'Delete' || k === 'Backspace') removePicked();
      else if (mod && (k === 'b' || k === 'B')) splitAtPlayhead();
      else if (mod && !e.shiftKey && (k === 'z' || k === 'Z')) undoStep(true);
      else if (mod && ((e.shiftKey && (k === 'z' || k === 'Z')) || k === 'y')) undoStep(false);
      else if (mod && (k === 'a' || k === 'A')) {
        sel = new Set(doc.clips.map((c) => c.id));
        draw();
      } else if (k === 'Escape' && sel.size) {
        sel = new Set();
        draw();
      } else if ((k === 'm' || k === 'M') && !mod) setSound(!soundOn);
      else if ((k === 'C') && e.shiftKey && !mod) toggleNotes();
      else if ((k === 'c' || k === 'C') && !mod && !e.shiftKey) {
        if (notes.hidden) toggleNotes();
        if (nowVersion) noteBox.focus();
      } else if ((k === 'Z') && e.shiftKey && !mod) fitAll();
      else if ((k === '=' || k === '+') && !mod) zoomTo(ppf * 1.5);
      else if ((k === '-' || k === '_') && !mod) zoomTo(ppf / 1.5);
      else done = false;
      if (done) e.preventDefault();
    }
    window.addEventListener('keydown', onKey);
    const onTimeMode = () => {
      paintTime();
      draw();
      paintNotes();
    };
    window.addEventListener('wb:timemode', onTimeMode);

    // Dragging the line between the picture and the timeline gives either more room; kept for next time.
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      const startY = e.clientY;
      const startH = tl.getBoundingClientRect().height;
      const move = (ev) => {
        const h = clamp(startH - (ev.clientY - startY), 120, page.getBoundingClientRect().height - 200);
        tl.style.height = `${h}px`;
      };
      const up = () => {
        grip.removeEventListener('pointermove', move);
        store('wb:an:tl', Math.round(tl.getBoundingClientRect().height));
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up, { once: true });
      grip.addEventListener('pointercancel', up, { once: true });
    });

    // ---- its rate and shape

    const RATES = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60];
    const SHAPES = [[1920, 1080, '16:9'], [3840, 2160, '16:9, UHD'], [2048, 858, '2.39:1'], [1998, 1080, '1.85:1'], [1080, 1080, 'square'], [1080, 1920, 'upright']];
    // Every position counted again at another rate, each cut staying where it is in time (to the nearest frame).
    function retime(d, fps) {
      const k = fps / d.fps;
      const at = (f) => Math.round(f * k);
      return {
        ...d, fps,
        clips: d.clips.map((c) => {
          const start = at(c.start);
          const len = Math.max(1, at(c.start + c.len) - start);
          return { ...c, start, len, in: at(c.in), fadeIn: Math.min(len, at(c.fadeIn || 0)), fadeOut: Math.min(len, at(c.fadeOut || 0)), dissolve: Math.min(len, at(c.dissolve || 0)) };
        }),
      };
    }
    async function settings() {
      if (!doc) return;
      const rate = el('select', { 'aria-label': 'Frame rate' }, RATES.map((r) => el('option', { value: String(r), text: `${r} frames a second`, selected: r === doc.fps })));
      const shapes = SHAPES.some(([w, h]) => w === doc.w && h === doc.h) ? SHAPES : [[doc.w, doc.h, 'as it is'], ...SHAPES];
      const shape = el('select', { 'aria-label': 'Shape' }, shapes.map(([w, h, what]) => el('option', { value: `${w}x${h}`, text: `${w} × ${h} (${what})`, selected: w === doc.w && h === doc.h })));
      const ok = await new Promise((resolve) => {
        let done = false;
        const dlg = el('dialog', { class: 'dlg' },
          el('form', { method: 'dialog', onsubmit: () => { done = true; } },
            el('h2', { text: 'Frame rate and shape' }),
            el('p', { text: 'Every position in the edit is a frame at this rate. Changed, each cut stays where it is in time. The shots are fitted into the shape, on black.' }),
            el('label', { class: 'dlg-field' }, el('span', { text: 'Frame rate' }), rate),
            el('label', { class: 'dlg-field' }, el('span', { text: 'Shape' }), shape),
            el('div', { class: 'dlg-actions' },
              el('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: () => dlg.close() }),
              el('button', { type: 'submit', class: 'btn primary', text: 'Set' }))));
        dlg.addEventListener('close', () => {
          dlg.remove();
          resolve(done);
        });
        document.body.append(dlg);
        dlg.showModal();
      });
      if (!ok) return;
      const fps = Number(rate.value);
      const [w, h] = shape.value.split('x').map(Number);
      if (fps === doc.fps && w === doc.w && h === doc.h) return;
      const k = fps / doc.fps;
      ph = Math.round(ph * k);
      ppf /= k;
      commit({ ...retime(doc, fps), w, h });
    }

    // ---- painting all of it

    const stopFrames = FR.listen(() => draw());
    function paintAll() {
      if (!doc || closed) return;
      ph = Math.min(ph, endFrame());
      sizeSpace();
      paintHeads();
      fitFrame();
      render(ph);
      draw();
      paintTime();
      paintPlay();
      paintSound();
      keepAhead();
      emptyNote.replaceChildren(
        el('p', { text: 'Drag shots here from the list, or put the project’s filed shots on V1 in their order.' }),
        el('button', { type: 'button', class: 'btn small', text: 'Put every filed shot on', onclick: () => appendShots(projectShots().filter((e) => provisional(e).version)) }));
      if (catalogue) paintBin();
    }
    // The cut for a playback system or an editor, as one zip made by the server (cutfiles.js): saved first, so
    // it is the edit as it is on screen.
    async function download() {
      if (!doc) return;
      const files = new Set(doc.clips.filter((c) => (c.shot ? versionOf(c) : c.media)).map((c) => c.shot || c.media)).size;
      const ok = await WB.dialog({
        title: 'Download for a playback system',
        text: `One zip: the cut as OpenTimelineIO (every track, dissolve and fade), as an edit decision list for each track, and the ${files} ${files === 1 ? 'file' : 'files'} it plays, each shot's newest version named by the shot. A newer version put over its file in the playback system needs no new cut.`,
        ok: 'Download',
      });
      if (!ok) return;
      if (dirty) {
        clearTimeout(saveTimer);
        await save();
      }
      const a = el('a', { href: `/api/animatics/${id}/download`, download: '' });
      document.body.append(a);
      a.click();
      a.remove();
    }

    paintSound();
    paintPlay();
    load();

    function close() {
      if (closed) return;
      if (dirty) {
        clearTimeout(saveTimer);
        // Whatever was not saved yet goes now, as the page goes.
        fetch(`/api/animatics/${id}`, { method: 'PATCH', keepalive: true, headers: { 'X-WB': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ doc, rev, by: me.name }) }).catch(() => {});
      }
      closed = true;
      stop();
      playing = false;
      cancelAnimationFrame(raf);
      clearInterval(pullTimer);
      clearTimeout(joinTimer);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('wb:timemode', onTimeMode);
      watch.disconnect();
      stopFrames();
      FR.ask([]);
      WB.media.want('animatic', []);
      if (room) room.close();
      for (const ent of pool) {
        ent.video.pause();
        ent.video.removeAttribute('src');
        ent.video.load();
      }
      stopSound();
      if (actx) actx.close().catch(() => {});
      document.body.classList.remove('an-on');
    }

    return { id, close, settings, download: () => download(), name: () => name };
  }

  return { open };
})();
