'use strict';

// A project's timeline: every shot in order, sequence by sequence, laid out as clips on a track the
// way an editor lays out an edit, each as long as its newest version (of one task, or of any). It is
// only for looking: one monitor plays the whole run through, the playhead can be dragged, a shot can
// be stepped to, and a clip opens in the player with a double-click. Nothing is edited here.
//
// WBTimeline.mount(box, { project, load(task) -> { shots, tasks }, open(shotId, versionId) }) fills the
// box and returns { destroy }.

window.WBTimeline = (() => {
  const { el, store } = WB;
  const STILL = 3;   // seconds an image is held
  const EMPTY = 2;   // seconds a shot with nothing filed is held, on a slate
  const GUESS = 4;   // seconds a video counts for until its length is known

  const icon = (d, size = 16) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const ICON = {
    play: icon('<path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>'),
    pause: icon('<path d="M8 5v14M16 5v14" stroke-width="2.4"/>'),
    prev: icon('<path d="M18 6l-8 6 8 6zM6 6v12"/>'),
    next: icon('<path d="M6 6l8 6-8 6zM18 6v12"/>'),
    sound: icon('<path d="M4 9v6h4l5 4V5L8 9zM17 8a5 5 0 0 1 0 8"/>'),
    muted: icon('<path d="M4 9v6h4l5 4V5L8 9zM17 9l5 6M22 9l-5 6"/>'),
  };
  const fmt = (t) => {
    const s = Math.max(0, Math.floor(t));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  function mount(box, { key = '', load, open }) {
    let shots = [];
    let clips = [];        // { shot, start, dur, kind: 'video' | 'image' | 'empty', src, poster }
    let total = 0;
    let t = 0;             // where the playhead is, in seconds from the start of the run
    let playing = false;
    let task = store('wb:tl:task') || '';
    let showEmpty = store('wb:tl:empty') !== false;
    let seq = store(`wb:tl:seq:${key}`) || '';   // one sequence, or '' for all of them
    let zoom = 1;          // 1 fits the whole run to the width
    let muted = store('wb:tl:muted') === true;
    let raf = 0;
    let gone = false;

    // ---- the monitor: two videos, so the next shot is ready while one plays, an image, and a slate
    const vids = [0, 1].map(() => el('video', { class: 'tl-mon-media', playsinline: '', preload: 'auto' }));
    for (const v of vids) v.muted = muted;
    const still = el('img', { class: 'tl-mon-media', alt: '', hidden: true });
    const slate = el('div', { class: 'tl-slate', hidden: true });
    const caption = el('div', { class: 'tl-caption' });
    const monitor = el('div', { class: 'tl-monitor' }, ...vids, still, slate, caption);
    let live = 0;          // which of the two videos is showing
    let showing = -1;      // the clip on the monitor

    // ---- the bar
    const taskSel = el('select', { 'aria-label': 'Which task' });
    taskSel.addEventListener('change', () => {
      task = taskSel.value;
      store('wb:tl:task', task);
      refresh();
    });
    const seqSel = el('select', { 'aria-label': 'Which sequence' });
    seqSel.addEventListener('change', () => pickSeq(seqSel.value));
    function pickSeq(next) {
      seq = next;
      seqSel.value = seq;
      store(`wb:tl:seq:${key}`, seq);
      t = 0;
      zoom = 1;
      zoomIn.value = '1';
      layout();
      track.scrollLeft = 0;
    }
    const emptyBox = el('input', { type: 'checkbox', checked: showEmpty });
    emptyBox.addEventListener('change', () => {
      showEmpty = emptyBox.checked;
      store('wb:tl:empty', showEmpty);
      layout();
    });
    const playBtn = el('button', { type: 'button', class: 'iconbtn', title: 'Play or pause (Space)', html: ICON.play, onclick: () => setPlaying(!playing) });
    const soundBtn = el('button', { type: 'button', class: 'iconbtn', html: muted ? ICON.muted : ICON.sound, title: 'Sound on / off (M)', onclick: () => setMuted(!muted) });
    const time = el('span', { class: 'tl-clock' });
    const zoomIn = el('input', { type: 'range', min: '1', max: '12', step: '0.25', value: '1', 'aria-label': 'Zoom', title: 'Zoom in on the track' });
    zoomIn.addEventListener('input', () => {
      const keep = t;
      zoom = Number(zoomIn.value);
      paintTrack();
      follow(keep, true);
    });
    const ICON_FULL = icon('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>');
    const fullBtn = el('button', { type: 'button', class: 'iconbtn', html: ICON_FULL, title: 'Full screen (F)', onclick: () => toggleFull() });
    const toggleFull = () => {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else view.requestFullscreen?.().catch(() => {});
    };
    const bar = el('div', { class: 'tl-bar' },
      el('button', { type: 'button', class: 'iconbtn', title: 'Previous shot (←)', html: ICON.prev, onclick: () => stepShot(-1) }),
      playBtn,
      el('button', { type: 'button', class: 'iconbtn', title: 'Next shot (→)', html: ICON.next, onclick: () => stepShot(1) }),
      time,
      el('span', { class: 'tl-gap' }),
      el('label', { class: 'tl-opt' }, el('span', { text: 'Sequence' }), seqSel),
      el('label', { class: 'tl-opt' }, el('span', { text: 'Latest of' }), taskSel),
      el('label', { class: 'tl-opt' }, emptyBox, el('span', { text: 'Shots with nothing filed' })),
      el('label', { class: 'tl-opt' }, el('span', { text: 'Zoom' }), zoomIn),
      soundBtn, fullBtn);

    // ---- the track: sequences above, shots below, and the playhead over both
    const seqRow = el('div', { class: 'tl-seqs' });
    const clipRow = el('div', { class: 'tl-clips' });
    const head = el('i', { class: 'tl-playhead' });
    const lane = el('div', { class: 'tl-lane' }, seqRow, clipRow, head);
    const track = el('div', { class: 'tl-track-wrap' }, lane);
    const note = el('p', { class: 'home-empty', hidden: true });
    const view = el('div', { class: 'tl-view' }, monitor, bar, track, note);
    box.replaceChildren(view);
    // Full screen, or back, and the track fits the width it now has.
    document.addEventListener('fullscreenchange', () => { if (!gone) paintTrack(); });

    const pxPerSec = () => (track.clientWidth - 2) / Math.max(total, 1) * zoom;
    const clipAt = (at) => {
      for (let i = clips.length - 1; i >= 0; i--) if (at >= clips[i].start) return i;
      return 0;
    };

    function layout() {
      clips = [];
      let at = 0;
      for (const shot of shots) {
        const v = shot.version;
        if (!v && !showEmpty) continue;
        if (seq && (shot.seq || '') !== seq) continue;
        const kind = !v ? 'empty' : v.look.type === 'video' ? 'video' : 'image';
        const dur = kind === 'empty' ? EMPTY : kind === 'image' ? STILL : v.look.dur > 0 ? v.look.dur : GUESS;
        clips.push({ shot, start: at, dur, kind, src: v && v.look.src, poster: v && (v.look.poster || v.look.th) });
        at += dur;
      }
      total = at;
      note.hidden = !!clips.length;
      note.textContent = shots.length ? 'No shot has anything filed yet. Tick "Shots with nothing filed" to see them all.' : 'This project has no shots yet. Add them in the catalogue ("Add assets, sets & shots"), or file versions of them.';
      t = Math.min(t, Math.max(0, total - 0.001));
      showing = -1;
      paintTrack();
      show(true);
      learnLengths();
    }

    // A video whose length was not recorded is measured, and the run laid out again with it.
    function learnLengths() {
      for (const c of clips) {
        if (c.kind !== 'video' || c.shot.version.look.dur > 0 || c.measuring) continue;
        c.measuring = true;
        const probe = el('video', { preload: 'metadata', src: c.src });
        probe.addEventListener('loadedmetadata', () => {
          if (probe.duration > 0 && isFinite(probe.duration)) {
            c.shot.version.look.dur = probe.duration;
            const keep = t;
            layout();
            t = keep;
          }
          probe.removeAttribute('src');
          probe.load();
        }, { once: true });
      }
    }

    function paintTrack() {
      const px = pxPerSec();
      lane.style.width = `${Math.max(track.clientWidth - 2, total * px)}px`;
      // Sequences: one band over the run of shots in each.
      const bands = [];
      for (const c of clips) {
        const seq = c.shot.seq || '—';
        const last = bands[bands.length - 1];
        if (last && last.seq === seq) last.end = c.start + c.dur;
        else bands.push({ seq, start: c.start, end: c.start + c.dur });
      }
      seqRow.replaceChildren(...bands.map((b) => el('div', { class: 'tl-seq', style: { left: `${b.start * px}px`, width: `${(b.end - b.start) * px}px` }, title: seq ? `${b.seq}. Show every sequence with All` : `Show only ${b.seq}` },
        el('button', { type: 'button', text: b.seq, onpointerdown: (e) => e.stopPropagation(), onclick: () => pickSeq(seq ? '' : b.seq) }))));
      clipRow.replaceChildren(...clips.map((c, i) => {
        const node = el('div', {
          class: `tl-clip ${c.kind}`, style: { left: `${c.start * px}px`, width: `${c.dur * px}px` },
          title: c.shot.version ? `${c.shot.version.label}${c.shot.artists && c.shot.artists.length ? ` · ${c.shot.artists.join(', ')}` : ''}\nDouble-click to open it` : `${c.shot.name}: nothing filed yet`,
        },
        c.poster && el('span', { class: 'tl-clip-pic', style: { backgroundImage: `url("${c.poster}")` } }),
        el('span', { class: 'tl-clip-name', text: c.shot.name }),
        c.shot.version && el('span', { class: 'tl-clip-ver', text: c.shot.version.label.slice(c.shot.name.length).trim() }));
        node.dataset.i = i;
        return node;
      }));
      paintHead();
    }

    function paintHead() {
      head.style.left = `${t * pxPerSec()}px`;
      time.textContent = `${fmt(t)} / ${fmt(total)}`;
      const i = clips.length ? clipAt(t) : -1;
      for (const n of clipRow.children) n.classList.toggle('at', Number(n.dataset.i) === i);
    }

    // Keeps the playhead in view as it runs; `centre` puts it in the middle.
    function follow(at = t, centre = false) {
      const x = at * pxPerSec();
      const { scrollLeft, clientWidth } = track;
      if (centre || x < scrollLeft || x > scrollLeft + clientWidth - 40) track.scrollLeft = Math.max(0, x - (centre ? clientWidth / 2 : 40));
    }

    // Puts what is at the playhead on the monitor; `seek` moves the video there even when it is close.
    function show(seek = false) {
      if (!clips.length) {
        for (const v of vids) v.hidden = true;
        still.hidden = true;
        slate.hidden = true;
        caption.textContent = '';
        return;
      }
      const i = clipAt(t);
      const c = clips[i];
      const local = t - c.start;
      const changed = i !== showing;
      showing = i;
      if (changed) {
        caption.replaceChildren(...[el('b', { text: c.shot.version ? c.shot.version.label : c.shot.name }),
          c.shot.artists && c.shot.artists.length && el('span', { text: c.shot.artists.join(', ') })].filter(Boolean));
      }
      if (c.kind === 'video') {
        // The one already holding this shot shows it; otherwise the other one is loaded with it.
        let v = vids[live];
        if (v.dataset.src !== c.src) {
          const other = vids[1 - live];
          if (other.dataset.src === c.src) live = 1 - live;
          else {
            v.dataset.src = c.src;
            v.src = c.src;
          }
          v = vids[live];
        }
        for (const x of vids) x.hidden = x !== v;
        still.hidden = true;
        slate.hidden = true;
        if (seek || Math.abs(v.currentTime - local) > 0.3) {
          try { v.currentTime = Math.min(local, Math.max(0, c.dur - 0.04)); } catch { /* not loaded yet: it starts at 0 */ }
        }
        if (playing && v.paused) v.play().catch(() => {});
        if (!playing && !v.paused) v.pause();
        for (const x of vids) if (x !== v && !x.paused) x.pause();
        // The next shot, if it is a video, waits in the other one.
        const next = clips[i + 1];
        const spare = vids[1 - live];
        if (next && next.kind === 'video' && spare.dataset.src !== next.src) {
          spare.dataset.src = next.src;
          spare.src = next.src;
          spare.preload = 'auto';
        }
      } else {
        for (const x of vids) { x.hidden = true; if (!x.paused) x.pause(); }
        still.hidden = c.kind !== 'image';
        slate.hidden = c.kind !== 'empty';
        if (c.kind === 'image' && still.getAttribute('src') !== c.src) still.src = c.src;
        if (c.kind === 'empty') slate.replaceChildren(el('b', { text: c.shot.name }), el('span', { text: 'Nothing filed yet' }));
      }
    }

    let last = 0;
    function tick(now) {
      raf = 0;
      if (!playing || gone) return;
      const dt = last ? Math.min(0.25, (now - last) / 1000) : 0;
      last = now;
      const i = clipAt(t);
      const c = clips[i];
      if (c && c.kind === 'video') {
        const v = vids[live];
        const local = v.currentTime;
        const ended = v.ended || local >= c.dur - 0.05;
        t = ended ? c.start + c.dur : c.start + Math.min(local, c.dur);
        if (ended && v.dataset.src === c.src && c.dur > v.duration + 0.5 && v.duration > 0) c.dur = v.duration; // shorter than recorded
      } else t += dt;
      if (t >= total - 0.001) {
        // The run starts again from the top, as a video loops in the player, unless that is turned off.
        if (store('wb:loop') === false) {
          t = Math.max(0, total - 0.001);
          setPlaying(false);
          return;
        }
        t = 0;
        show(true);
      } else if (clipAt(t) !== showing) show(true);
      paintHead();
      follow();
      raf = requestAnimationFrame(tick);
    }

    function setPlaying(on) {
      if (!clips.length) return;
      playing = on;
      playBtn.innerHTML = on ? ICON.pause : ICON.play;
      if (on && t >= total - 0.01) t = 0;
      last = 0;
      show(true);
      if (on && !raf) raf = requestAnimationFrame(tick);
    }

    function setMuted(on) {
      muted = on;
      store('wb:tl:muted', on);
      for (const v of vids) v.muted = on;
      soundBtn.innerHTML = on ? ICON.muted : ICON.sound;
    }

    function seekTo(at) {
      t = Math.max(0, Math.min(at, Math.max(0, total - 0.001)));
      show(true);
      paintHead();
    }

    function stepShot(dir) {
      if (!clips.length) return;
      const i = clipAt(t);
      const local = t - clips[i].start;
      const to = dir < 0 && local > 0.5 ? i : Math.max(0, Math.min(clips.length - 1, i + dir));
      seekTo(clips[to].start);
      follow(t, false);
    }

    // Dragging on the track moves the playhead, as on any editor's timeline.
    lane.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const at = (ev) => (ev.clientX - lane.getBoundingClientRect().left) / pxPerSec();
      const wasPlaying = playing;
      if (playing) setPlaying(false);
      seekTo(at(e));
      lane.setPointerCapture(e.pointerId);
      const move = (ev) => seekTo(at(ev));
      const up = () => {
        lane.removeEventListener('pointermove', move);
        lane.removeEventListener('pointerup', up);
        if (wasPlaying) setPlaying(true);
      };
      lane.addEventListener('pointermove', move);
      lane.addEventListener('pointerup', up);
    });
    // A double-click on a clip opens it in the player (the track holds the pointer while it is pressed,
    // so the clip is found by where the click was).
    lane.addEventListener('dblclick', (e) => {
      const at = (e.clientX - lane.getBoundingClientRect().left) / pxPerSec();
      const c = clips[clipAt(at)];
      if (!c || !c.shot.version || at > c.start + c.dur) return;
      setPlaying(false);
      open(c.shot.id, c.shot.version.id);
    });
    track.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoom = Math.max(1, Math.min(12, zoom * Math.exp(-e.deltaY * 0.002)));
      zoomIn.value = String(zoom);
      paintTrack();
      follow(t, true);
    }, { passive: false });

    const keys = (e) => {
      if (gone || e.target.closest('input, textarea, select') || document.querySelector('dialog[open]') || !document.querySelector('.viewer[hidden]') && document.querySelector('.viewer')) return;
      if (e.code === 'Space' || e.key === 'k') setPlaying(!playing);
      else if (e.key === 'ArrowRight') stepShot(1);
      else if (e.key === 'ArrowLeft') stepShot(-1);
      else if (e.key === 'Home') seekTo(0);
      else if (e.key === 'm') setMuted(!muted);
      else if (e.key === 'f') toggleFull();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', keys);
    const resize = () => paintTrack();
    window.addEventListener('resize', resize);

    async function refresh() {
      let data;
      try {
        data = await load(task);
      } catch (err) {
        note.hidden = false;
        note.textContent = err.message;
        return;
      }
      if (gone) return;
      taskSel.replaceChildren(el('option', { value: '', text: 'any task' }), ...data.tasks.map((x) => el('option', { value: x, text: x })));
      if (task && !data.tasks.includes(task)) task = '';
      taskSel.value = task;
      shots = data.shots;
      const seqs = [...new Set(shots.map((x) => x.seq).filter(Boolean))];
      seqSel.replaceChildren(el('option', { value: '', text: 'All' }), ...seqs.map((x) => el('option', { value: x, text: x })));
      if (seq && !seqs.includes(seq)) seq = '';
      seqSel.value = seq;
      layout();
    }
    refresh();

    return {
      destroy() {
        gone = true;
        playing = false;
        for (const v of vids) {
          v.pause();
          v.removeAttribute('src');
          v.load();
        }
        window.removeEventListener('keydown', keys);
        window.removeEventListener('resize', resize);
      },
    };
  }

  return { mount };
})();
