'use strict';

// Every icon the app draws, in one place: drawn on a 24 x 24 grid with a round 1.6 stroke, in the
// colour of the text around them. WB.icon(name, size) gives one as markup; WB.iconSet(size) gives an
// object to look them up by name (ICON.pen), at one size. Loaded after common.js, before the rest.
(() => {
  const PATHS = {
    activity: '<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/>',
    alignC: '<path d="M4 6h16M7 10h10M4 14h16M7 18h10"/>',
    alignL: '<path d="M4 6h16M4 10h10M4 14h16M4 18h10"/>',
    animatic: '<rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M3 10h18M3 14.5h18M9 5v5M15 10v4.5M11 14.5V19"/>',
    arrow: '<path d="M5 19L19 5M9 5h10v10"/>',
    back: '<rect x="4" y="4" width="12" height="12"/><path d="M20 10v9a1 1 0 0 1-1 1h-9" stroke-dasharray="2 3"/>',
    block: '<rect x="3" y="7" width="18" height="10"/><path d="M8 12h8"/>',
    board: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M7.5 9h4v3.5h-4zM14 12.5h2.5V15H14z"/>',
    boards: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
    catalogue: '<path d="M5 4h4v16H5zM10 4h4v16h-4z"/><path d="M15.5 4.6l3.8-1 3.7 15.5-3.8 1z"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    checks: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><path d="M5.5 7l1.3 1.3L9 6"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><path d="M5.5 17l1.3 1.3L9 16"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
    chevron: '<path d="M9 6l6 6-6 6"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    cube: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>',
    cloud: '<path d="M7 18a4.5 4.5 0 0 1-.6-9A6 6 0 0 1 18 9.5 4.3 4.3 0 0 1 17.5 18z"/>',
    comment: '<path d="M4 5h16v11H11l-5 4v-4H4z"/>',
    // An animatic's tracks drawn thin, as an editor's compact tracks.
    compact: '<rect x="3" y="4.5" width="18" height="3.5" rx="1"/><rect x="3" y="10.25" width="18" height="3.5" rx="1"/><rect x="3" y="16" width="18" height="3.5" rx="1"/>',
    dot: '<circle cx="12" cy="12" r="2" fill="currentColor"/>',
    download: '<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>',
    dup: '<rect x="8" y="8" width="12" height="12"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
    eraser: '<path d="M9 20h11M4.6 15.4l9.8-9.8a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8L11 19H8.2a2 2 0 0 1-1.4-.6l-2.2-2.2a2 2 0 0 1 0-2.8z"/><path d="M9 11l5 5"/>',
    eyeOff: '<path d="M2 12s3.6-7 10-7c1.9 0 3.6.6 5 1.5M22 12s-3.6 7-10 7c-1.9 0-3.6-.6-5-1.5"/><path d="M4 20L20 4"/>',
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9.5 12l2.5 5 2.5-5"/>',
    film: '<rect x="3" y="6" width="18" height="12" rx="1.5"/><path d="M8 6v12M16 6v12M3 10h5M3 14h5M16 10h5M16 14h5"/>',
    filter: '<path d="M4 5h16l-6.2 7.6V19l-3.6-1.8v-4.6z"/>',
    fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/><rect x="9" y="9" width="6" height="6"/>',
    focus: '<path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4"/><circle cx="12" cy="12" r="2.5"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    frame: '<path d="M7 3v18M17 3v18M3 7h18M3 17h18"/>',
    frameBack: '<path d="M18 5.5l-9 6.5 9 6.5z" fill="currentColor"/><path d="M6 5v14"/>',
    frameFwd: '<path d="M6 5.5l9 6.5-9 6.5z" fill="currentColor"/><path d="M18 5v14"/>',
    front: '<rect x="8" y="8" width="12" height="12" fill="currentColor"/><path d="M4 14V5a1 1 0 0 1 1-1h9"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.8"/><circle cx="12" cy="17" r="0.6" fill="currentColor"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><circle cx="12" cy="7.8" r="0.6" fill="currentColor"/>',
    home: '<path d="M4 11l8-7 8 7"/><path d="M6 9.5V20h12V9.5"/>',
    import: '<path d="M12 15V4M7.5 8.5L12 4l4.5 4.5M5 14v5h14v-5"/>',
    kept: '<path d="M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z"/><path d="M4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M15.5 7.5L18 10M18 5l2 2"/>',
    laser: '<circle cx="12" cy="12" r="3" fill="currentColor"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2 2M16.4 16.4l2 2M5.6 18.4l2-2M16.4 7.6l2-2"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1" fill="currentColor"/><circle cx="4.5" cy="12" r="1" fill="currentColor"/><circle cx="4.5" cy="18" r="1" fill="currentColor"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    loop: '<path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 0 1 4-4h12"/><path d="M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 0 1-4 4H4"/>',
    moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
    more: '<circle cx="5" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="19" cy="12" r="1.4" fill="currentColor"/>',
    muted: '<path d="M4 9v6h4l5 4V5L8 9zM17 9l5 6M22 9l-5 6"/>',
    next: '<path d="M9 5l7 7-7 7"/>',
    note: '<path d="M5 4h14v10l-5 6H5z"/><path d="M14 20v-6h5"/>',
    out: '<path d="M14 4h5v16h-5M10 8l-4 4 4 4M6 12h11"/>',
    pan: '<path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/>',
    pause: '<path d="M7 4v16M17 4v16" stroke-width="3.5"/>',
    pen: '<path d="M4 20l1-4L16 5l3 3L8 19z"/><path d="M14 7l3 3"/>',
    people: '<circle cx="9" cy="8" r="3.2"/><path d="M3 19c0-3 2.7-5 6-5s6 2 6 5"/><path d="M16 5.2a3.2 3.2 0 0 1 0 5.6M17.5 14.3c2.1.6 3.5 2.3 3.5 4.7"/>',
    person: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-3.5 3-6 7-6s7 2.5 7 6"/>',
    play: '<path d="M7 4l13 8-13 8z" fill="currentColor"/>',
    playlist: '<path d="M4 6h14M4 11h14M4 16h7"/><path d="M15 14.5l5.5 3.5-5.5 3.5z" fill="currentColor"/>',
    playSolid: '<path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    prev: '<path d="M15 5l-7 7 7 7"/>',
    project: '<path d="M12 3l9 4.5-9 4.5-9-4.5z"/><path d="M3 12l9 4.5 9-4.5M3 16.5L12 21l9-4.5"/>',
    redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
    restore: '<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4h4"/><path d="M12 8v4l3 2"/>',
    retry: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v4h-4"/>',
    rows: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    scribble: '<path d="M3 16c2.5-5 4.5-8 6.5-8 2.5 0-1 9 2 9 2.5 0 3.5-7 6-7 1.5 0 2 2 3.5 3"/>',
    scissors: '<circle cx="6" cy="7" r="2.5"/><circle cx="6" cy="17" r="2.5"/><path d="M8.2 8.4L20 17.5M8.2 15.6L20 6.5"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4-4"/>',
    select: '<path d="M5 3l5.5 16 2.5-6.5L19.5 10z"/>',
    set: '<path d="M3 20h18M5 20V9.5L12 5l7 4.5V20"/><path d="M9.5 20v-5h5v5"/>',
    // A choice of one among several: what a player or an edit shows (which task, which pass).
    pick: '<circle cx="6" cy="7" r="2"/><circle cx="6" cy="17" r="2" fill="currentColor"/><path d="M11 7h9M11 17h9"/>',
    settings: '<path d="M4 7h9M19 7h1M4 17h3M13 17h7"/><circle cx="16" cy="7" r="2.5"/><circle cx="10" cy="17" r="2.5"/>',
    shield: '<path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z"/>',
    // A ball lit from one side: how the venue is drawn (its light and shade).
    shade: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>',
    snap: '<path d="M6 3v8a6 6 0 0 0 12 0V3h-4v8a2 2 0 0 1-4 0V3z"/><path d="M6 7h4M14 7h4"/>',
    sparkle: '<path d="M10 3.5l1.6 4.4a3 3 0 0 0 1.8 1.8l4.4 1.6-4.4 1.6a3 3 0 0 0-1.8 1.8L10 19.1l-1.6-4.4a3 3 0 0 0-1.8-1.8L2.2 11.3l4.4-1.6a3 3 0 0 0 1.8-1.8z"/><path d="M18 3v4M16 5h4M19 16v3M17.5 17.5h3"/>',
    sound: '<path d="M4 9v6h4l5 4V5L8 9zM17 8a5 5 0 0 1 0 8"/>',
    // Prints one on another: the versions of a piece.
    stack: '<rect x="3.5" y="9" width="11.5" height="11.5"/><path d="M7 6h11v11M10.5 3H21v10.5"/>',
    // A picture over a thin strip: the animatic's timeline as a strip, for watching.
    strip: '<rect x="3" y="4" width="18" height="11" rx="1.5"/><path d="M3 19.5h18" stroke-width="2.4"/>',
    star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/>',
    table: '<rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><path d="M3.5 9.5h17M3.5 14.5h17M9.5 9.5v10"/>',
    tag: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.3"/>',
    text: '<path d="M5 7V4h14v3M12 4v16M9 20h6"/>',
    tidy: '<rect x="3" y="4" width="8" height="7"/><rect x="13" y="4" width="8" height="7"/><rect x="3" y="13" width="5" height="7"/><rect x="10" y="13" width="11" height="7"/>',
    // Track select tools: everything from here on along the tracks, or everything up to here.
    trackBack: '<path d="M20 4v16"/><path d="M16 12H4M8 8l-4 4 4 4"/>',
    trackFwd: '<path d="M4 4v16"/><path d="M8 12h12M16 8l4 4-4 4"/>',
    trash: '<path d="M4 7h16M10 4h4M6 7l1 13h10l1-13M10 11v5M14 11v5"/>',
    undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
    upload: '<rect x="3" y="5" width="18" height="14"/><circle cx="8.5" cy="10" r="1.5"/><path d="M21 15l-5-5-8 9"/>',
    warn: '<path d="M12 4l9 16H3z"/><path d="M12 10v4.5"/><circle cx="12" cy="17.3" r="0.6" fill="currentColor"/>',
  };
  const made = new Map();
  function icon(name, size = 20) {
    const key = `${name}|${size}`;
    if (!made.has(key)) {
      const d = PATHS[name];
      if (d === undefined) throw new Error(`No icon called ${name}`);
      made.set(key, `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`);
    }
    return made.get(key);
  }
  const iconSet = (size = 20) => new Proxy({}, { get: (_, name) => (typeof name === 'string' ? icon(name, size) : undefined) });
  Object.assign(WB, { icon, iconSet });
})();
