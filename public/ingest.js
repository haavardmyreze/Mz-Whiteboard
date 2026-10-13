'use strict';

// Bringing media in: everything that happens to a file between being chosen and being something the
// app can show, wherever it is brought in (dropped on a board, or on a project's Import page). An image
// goes up as it is, with a small still and, when it is large, a preview. A video is turned into a review
// copy here, in the browser, which is what is played everywhere; the file it was made from is kept too.
// Its timeline strip (the colours of its picture and the loudness of its sound) and its frame rate are
// read from the file on the way.
//
// `ingest(file)` does all of it and resolves with what a board or the catalogue needs to show the file:
//   { type, src, orig?, prev?, pw?, th?, poster?, nw, nh, fps?, dur?, wf?, name }
// A video's `orig` is only there when it went up as it came (it is its own original); otherwise the
// caller keeps the original with `upload(file, ext, onProgress, true)`, behind everything else.
const WBIngest = (() => {
  const { el } = WB;
  const PREVIEW_MAX = 2048;
  const THUMB_MAX = 480;
  // A video's poster: big enough to look sharp filling the screen on a laptop, small enough to load at once.
  const POSTER_MAX = 1600;
  // What a video looks and sounds like along its length: the colours of its picture and the loudness of
  // its sound, drawn along the timeline of the video that is open.
  const WAVE_COLS = 512;
  const WAVE_BARS = 1024;
  const IMG_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;
  const VID_EXT = /\.(mp4|m4v|webm|mov)$/i;
  const EXT_BY_TYPE = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/avif': '.avif',
    'image/bmp': '.bmp', 'image/svg+xml': '.svg', 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
  };
  let mediabunny;
  const uid = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => (b % 36).toString(36)).join('');

  // ---- the picture and sound of a video, along its timeline
  const STRIP_PICTURE = 0.85;

  const toB64 = (bytes) => {
    let out = '';
    for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(out);
  };
  const fromB64 = (text) => Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));

  // The average colour of the top and of the bottom of a small copy of a frame.
  function frameColours(ctx) {
    const { data } = ctx.getImageData(0, 0, 16, 8);
    const sum = [0, 0, 0, 0, 0, 0];
    for (let p = 0; p < 128; p++) {
      const half = p < 64 ? 0 : 3;
      for (let c = 0; c < 3; c++) sum[half + c] += data[p * 4 + c];
    }
    return sum.map((v) => Math.round(v / 64));
  }

  // A strip with holes in it is worse than none: a missed moment takes its neighbour's colour, and if
  // more than a few are missed there is no strip at all, to be tried again another time.
  function closeHoles(cols) {
    const missed = cols.filter((c) => !c).length;
    if (missed > cols.length * 0.05) return null;
    const out = new Uint8Array(cols.length * 6);
    for (let i = 0; i < cols.length; i++) {
      let c = cols[i];
      for (let d = 1; !c && d < cols.length; d++) c = cols[i - d] || cols[i + d];
      if (!c) return null;
      out.set(c, i * 6);
    }
    return out;
  }

  // The picture at evenly spaced moments along the timeline, each column the frame that is on show at the
  // middle of its stretch. The frames are decoded here by their timestamps, and each one's own timestamp is
  // checked against the moment asked for, so a column can only ever hold the colour of its own moment.
  // (Seeking a video element and copying what it shows is not that: the browser may report the seek done
  // while the old frame is still on show, and the same colour then runs on for minutes.)
  async function colourStrip(file, url, dur, report = () => {}, fallback = true) {
    let input;
    try {
      const mb = mediabunny || (mediabunny = await import('/vendor/mediabunny.mjs'));
      input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
      const track = await input.getPrimaryVideoTrack();
      if (!track || !(await track.canDecode())) throw new Error('cannot decode');
      const first = await track.getFirstTimestamp();
      if (!(dur > 0)) dur = await input.computeDuration();
      if (!(dur > 0)) return null;
      const step = dur / WAVE_COLS;
      const times = Array.from({ length: WAVE_COLS }, (_, i) => Math.max(first, step * (i + 0.5)));
      const sink = new mb.CanvasSink(track, { width: 16, height: 8, fit: 'fill', poolSize: 1 });
      const cols = [];
      let before = -Infinity;
      for await (const frame of sink.canvasesAtTimestamps(times)) {
        // The frame on show at a moment starts at or before it, and never before the one for the moment earlier.
        const right = frame && frame.timestamp <= times[cols.length] + 0.001 && frame.timestamp >= before;
        if (right) before = frame.timestamp;
        cols.push(right ? frameColours(frame.canvas.getContext('2d', { willReadFrequently: true })) : null);
        report(cols.length / WAVE_COLS);
      }
      const colours = cols.length === WAVE_COLS ? closeHoles(cols) : null;
      if (colours) return { colours, dur };
    } catch {
      // A browser that cannot decode it here still has its video element.
    } finally {
      if (input) input.dispose?.();
    }
    return fallback ? colourStripByElement(url, report) : null;
  }

  // The same from a video element, for a browser that cannot decode the file itself. Each seek is only
  // believed once the element says which frame it has put on show.
  async function colourStripByElement(url, report = () => {}) {
    const video = el('video', { muted: '', playsinline: '', preload: 'auto' });
    video.muted = true;
    if (!video.requestVideoFrameCallback) return null;
    const ready = new Promise((resolve, reject) => {
      video.addEventListener('loadeddata', resolve, { once: true });
      video.addEventListener('error', reject, { once: true });
      setTimeout(reject, 20000);
    });
    video.src = url;
    try {
      await ready;
      const dur = video.duration;
      if (!(dur > 0) || !isFinite(dur)) return null;
      const canvas = el('canvas', { width: 16, height: 8 });
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const step = dur / WAVE_COLS;
      const cols = [];
      let missed = 0;
      for (let i = 0; i < WAVE_COLS && missed <= WAVE_COLS * 0.05; i++) {
        const t = step * (i + 0.5);
        const shown = await new Promise((resolve) => {
          const late = setTimeout(() => resolve(null), 3000);
          video.requestVideoFrameCallback((now, meta) => { clearTimeout(late); resolve(meta.mediaTime); });
          video.currentTime = t;
        });
        if (shown != null && Math.abs(shown - t) <= Math.max(1, step * 2)) {
          ctx.drawImage(video, 0, 0, 16, 8);
          cols.push(frameColours(ctx));
        } else {
          cols.push(null);
          missed++;
        }
        report(cols.length / WAVE_COLS);
      }
      const colours = cols.length === WAVE_COLS ? closeHoles(cols) : null;
      return colours ? { colours, dur } : null;
    } catch {
      return null;
    } finally {
      video.removeAttribute('src');
      video.load();
    }
  }

  // How loud the sound is, in even steps along the video; null where there is none.
  async function soundPeaks(file, dur, report = () => {}) {
    let input;
    try {
      const mb = mediabunny || (mediabunny = await import('/vendor/mediabunny.mjs'));
      input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
      const track = await input.getPrimaryAudioTrack();
      if (!track || !(await track.canDecode())) return null;
      const peaks = new Float32Array(WAVE_BARS);
      const sink = new mb.AudioSampleSink(track);
      let told = 0;
      for await (const sample of sink.samples()) {
        if (sample.timestamp / dur - told >= 0.02) report((told = sample.timestamp / dur));
        const data = new Float32Array(sample.numberOfFrames);
        sample.copyTo(data, { planeIndex: 0, format: 'f32-planar' });
        const rate = sample.sampleRate;
        for (let j = 0; j < data.length; j++) {
          const b = Math.min(WAVE_BARS - 1, Math.floor(((sample.timestamp + j / rate) / dur) * WAVE_BARS));
          const v = Math.abs(data[j]);
          if (b >= 0 && v > peaks[b]) peaks[b] = v;
        }
        sample.close();
      }
      const top = Math.max(...peaks);
      if (!(top > 0.002)) return null;
      return Uint8Array.from(peaks, (v) => Math.round(255 * Math.sqrt(v / top)));
    } catch {
      return null;
    } finally {
      if (input) input.dispose?.();
    }
  }


  // The strip for a video file about to be uploaded; null if it cannot be made, and the bar stays plain.
  // `report` hears how far along it is, from 0 to 1: the picture is most of the work, the sound the rest.
  async function videoWave(file, url, dur, report = () => {}, fallback = true) {
    try {
      const strip = await colourStrip(file, url, dur, (k) => report(k * STRIP_PICTURE), fallback);
      if (!strip) return null;
      const peaks = await soundPeaks(file, strip.dur, (k) => report(STRIP_PICTURE + k * (1 - STRIP_PICTURE)));
      return { c: toB64(strip.colours), p: peaks ? toB64(peaks) : '' };
    } catch {
      return null;
    } finally {
      report(1);
    }
  }


  // ---- the frame rate

  // Rates as cameras and editors write them: a measured rate within 1.5% of one of them is the nearest.
  const RATES = [23.976, 24, 25, 29.97, 30, 47.952, 48, 50, 59.94, 60, 100, 119.88, 120];
  function snapRate(r) {
    if (!(r > 0) || !isFinite(r)) return 0;
    const near = RATES.reduce((a, b) => (Math.abs(b - r) < Math.abs(a - r) ? b : a));
    return Math.abs(near - r) / near < 0.015 ? near : Math.round(r * 1000) / 1000;
  }

  // How many frames a second a video has, read from the file itself (a file, or the address of one).
  async function readRate(source) {
    let mb;
    try {
      mb = mediabunny || (mediabunny = await import('/vendor/mediabunny.mjs'));
    } catch {
      return 0;
    }
    const input = new mb.Input({ source: typeof source === 'string' ? new mb.UrlSource(source) : new mb.BlobSource(source), formats: mb.ALL_FORMATS });
    try {
      const track = await input.getPrimaryVideoTrack();
      if (!track) return 0;
      return snapRate((await track.computePacketStats(120)).averagePacketRate);
    } catch {
      return 0;
    } finally {
      input.dispose();
    }
  }

  // ------------------------------------------------------------- adding media

  function fileExt(file) {
    const m = /\.[a-z0-9]+$/i.exec(file.name || '');
    const ext = m ? m[0].toLowerCase() : '';
    if (IMG_EXT.test(ext) || VID_EXT.test(ext)) return ext;
    return EXT_BY_TYPE[file.type] || '';
  }

  // Files go up in pieces, in order. Hosting front ends cap the size of a request (Cloud Run allows
  // about 32 MB), so nothing larger than a piece is ever sent at once; the server joins them when the
  // last one lands. A dropped piece is retried instead of restarting the file.
  const UPLOAD_PIECE = 8 * 1024 * 1024;

  function sendPiece(piece, query, onSent) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/upload?${query}`);
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onSent(e.loaded); };
      xhr.onload = () => {
        let data = {};
        try {
          data = JSON.parse(xhr.responseText);
        } catch {
          // fall through to the generic error
        }
        if (xhr.status === 200) resolve(data);
        else reject(Object.assign(new Error(data.error || 'Upload failed'), { fatal: xhr.status < 500 }));
      };
      xhr.onerror = () => reject(new Error('Upload failed'));
      xhr.send(piece);
    });
  }

  // `behind` is for a file nobody is waiting for (a video's original, see below): between its pieces it
  // gives way to whatever the board is waiting for.
  let awaited = 0;
  async function upload(blob, ext, onProgress, behind = false) {
    if (!behind) awaited++;
    try {
      return await sendWhole(blob, ext, onProgress, behind);
    } finally {
      if (!behind) awaited--;
    }
  }

  async function sendWhole(blob, ext, onProgress, behind) {
    const id = uid();
    let offset = 0;
    let result = {};
    do {
      while (behind && awaited > 0) await new Promise((resolve) => setTimeout(resolve, 400));
      const end = Math.min(blob.size, offset + UPLOAD_PIECE);
      const query = `name=file${ext}&uid=${id}&offset=${offset}&done=${end >= blob.size ? 1 : 0}`;
      for (let attempt = 1; ; attempt++) {
        try {
          result = await sendPiece(blob.slice(offset, end), query, (sent) => {
            if (onProgress) onProgress((offset + sent) / Math.max(1, blob.size));
          });
          break;
        } catch (err) {
          if (err.fatal || attempt >= 3) throw err;
          await new Promise((resolve) => setTimeout(resolve, 600 * attempt));
        }
      }
      offset = end;
    } while (offset < blob.size);
    return result;
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('This image could not be read'));
      img.src = url;
    });
  }

  function probeVideo(url) {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      const fail = () => reject(new Error('This browser cannot play that video. Export H.264 MP4 or WebM instead'));
      const timer = setTimeout(fail, 15000);
      video.muted = true;
      video.preload = 'metadata';
      video.onloadedmetadata = () => {
        clearTimeout(timer);
        if (!video.videoWidth) return fail();
        resolve({ w: video.videoWidth, h: video.videoHeight, video });
      };
      video.onerror = () => { clearTimeout(timer); fail(); };
      video.src = url;
    });
  }

  // A small still of an image or of a video frame, for the board list: opening the list should never
  // mean fetching originals. Best effort; without one the list falls back to what it showed before.
  async function makeThumb(source, w, h) {
    try {
      const k = Math.min(1, THUMB_MAX / Math.max(w, h));
      const canvas = el('canvas', { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) });
      canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.8));
      return blob ? (await upload(blob, EXT_BY_TYPE[blob.type] || '.webp')).url : null;
    } catch {
      return null;
    }
  }

  const seekFrame = (video, t) => new Promise((resolve, reject) => {
    const timer = setTimeout(reject, 5000);
    video.onseeked = () => { clearTimeout(timer); resolve(); };
    video.onerror = () => { clearTimeout(timer); reject(); };
    video.currentTime = t;
  }).then(() => (video.requestVideoFrameCallback
    ? new Promise((done) => { const late = setTimeout(done, 250); video.requestVideoFrameCallback(() => { clearTimeout(late); done(); }); })
    : null));

  // How bright the frame on show is, 0 to 255; a black or not yet painted frame is close to 0.
  function brightness(video) {
    try {
      const canvas = el('canvas', { width: 32, height: 18 });
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(video, 0, 0, 32, 18);
      const { data } = ctx.getImageData(0, 0, 32, 18);
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
      return sum / (data.length / 4);
    } catch {
      return 255;
    }
  }

  // Stops on a frame from a little way into the video, where there is more to see than on the first one,
  // and moves on if that one is black: a fade in, a slate, a frame the browser had not painted yet.
  // A video that is dark all through gets its brightest candidate.
  async function pickFrame(video) {
    const dur = video.duration || 0;
    const first = Math.max(0.01, Math.min(1, dur / 3));
    const times = [first, ...[0.1, 0.25, 0.5, 0.75, 0.9].map((k) => dur * k).filter((t) => t > 0.01 && t !== first)];
    let best = { t: first, b: -1 };
    for (const t of times) {
      // One that has failed will not seek, and each try would wait out its full time.
      if (video.error) break;
      try {
        await seekFrame(video, t);
      } catch {
        continue;
      }
      const b = brightness(video);
      if (b >= 14) return true;
      if (b > best.b) best = { t, b };
    }
    if (best.b < 0) return false;
    await seekFrame(video, best.t).catch(() => {});
    return true;
  }

  // Every video is turned into a review copy here, on the uploader's own machine, before it goes
  // anywhere: H.264 in an MP4 that starts playing before it has all arrived (VP9 in WebM where the
  // browser cannot encode H.264), at most 1080p, audio kept,
  // and a key frame every quarter of a second. Browsers can only show a frame by decoding from the key frame
  // before it, and renders and camera files often have one every few seconds, so stepping or scrubbing
  // backwards through them stalls. With key frames this close together it is instant both ways.
  // A browser that cannot encode video uploads the file as it is.
  const VIDEO_BITRATE = 12e6;
  const VIDEO_MIN_BITRATE = 3e6;
  const VIDEO_KEY_INTERVAL = 0.25;
  const VIDEO_LONG_SIDE = 1920;
  const VIDEO_SHORT_SIDE = 1080;

  // Whether the key frames, as far as the first two minutes show, are never much more than a second apart.
  async function closeKeyFrames(mb, track, duration) {
    try {
      const sink = new mb.EncodedPacketSink(track);
      let last = -1;
      let keys = 0;
      let widest = 0;
      for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true })) {
        if (packet.timestamp > 120) break;
        if (packet.type !== 'key') continue;
        if (last >= 0) widest = Math.max(widest, packet.timestamp - last);
        last = packet.timestamp;
        keys++;
      }
      return keys >= 2 ? widest <= VIDEO_KEY_INTERVAL * 2.1 : keys === 1 && duration <= VIDEO_KEY_INTERVAL * 2;
    } catch {
      return false;
    }
  }

  // ---- what a browser cannot do
  //
  // A video only belongs on a board as its review copy: without one it is the file as it came, many times
  // the size, slow to scrub and with no strip for its timeline. Browsers differ in what they can read
  // (Safari stops at frames that Chrome and Firefox take in their stride), so a video this browser cannot
  // make a copy of is not added at all, and whoever brought it is told to bring it in another browser.
  //
  // The one exception is a browser with no way of making copies of anything: a plain http address, where
  // browsers withhold that machinery, or a very old browser. There every video goes up as it is, as it
  // always has, since refusing would mean no video at all.
  const canCopyVideo = typeof VideoDecoder !== 'undefined' && typeof VideoEncoder !== 'undefined';
  const OTHER_BROWSERS = /Firefox\//.test(navigator.userAgent) ? 'Chrome or Edge'
    : /Safari\//.test(navigator.userAgent) && !/Chrom(e|ium)\//.test(navigator.userAgent) ? 'Chrome, Edge or Firefox'
      : 'Firefox';
  const refusal = (dims) => Object.assign(new Error('This browser cannot process this video'), { refused: true, dims });

  // ---- what Firefox's H.264 encoder gets wrong
  //
  // Two things, and either one leaves a copy that will not play. It describes its stream with a header
  // in which each parameter set starts with its first byte twice, and Chrome refuses a file that carries
  // it. And once it puts frames out of order, as it does in every profile but the plainest, it stamps
  // each with the moment it ends instead of the moment it begins: every frame then sits one late, and a
  // first frame of an odd length lands after a frame that needs it, which Firefox itself will not play.
  //
  // So every browser is asked for the stream as it comes off the encoder, parameter sets and all, and
  // what goes into the file is made from that here: a header holding the parameter sets, and frames
  // holding only their picture. (Parameter sets left in the frames as well are no better: Firefox,
  // going to a key frame that carries them, shows the frame after it.) And Firefox is asked for the
  // plainest profile, which keeps its frames in order. Mediabunny gives no say in any of this when it
  // converts a file, so it is done where the encoder is set up and where its frames come out.
  const IN_ORDER_ONLY = /Firefox\//.test(navigator.userAgent);
  const nalType = (nal) => nal[0] & 31;

  // The units of a stream in which each follows a 00 00 01.
  function nalUnits(data) {
    const units = [];
    let from = -1;
    for (let i = 0; i + 2 < data.length; i++) {
      if (data[i] || data[i + 1] || data[i + 2] !== 1) continue;
      if (from >= 0) units.push(data.subarray(from, i));
      from = i + 3;
      i += 2;
    }
    if (from >= 0) units.push(data.subarray(from));
    // Zeros before the next 00 00 01 belong to neither.
    return units.map((u) => {
      let end = u.length;
      while (end > 0 && !u[end - 1]) end--;
      return u.subarray(0, end);
    }).filter((u) => u.length);
  }

  function avcHeader(sps, pps) {
    const sets = (list) => list.flatMap((n) => [n.length >> 8, n.length & 255, ...n]);
    // The High profile says its chroma and bit depth here as well: 4:2:0 at 8 bits, all it allows.
    const high = sps[0][1] === 100 ? [0xfd, 0xf8, 0xf8, 0] : [];
    return new Uint8Array([1, sps[0][1], sps[0][2], sps[0][3], 0xff, 0xe0 | sps.length, ...sets(sps), pps.length, ...sets(pps), ...high]);
  }

  // One frame off the encoder as it goes into the file, with the header it is to be read by.
  function fileFrame(chunk, meta, state) {
    const raw = new Uint8Array(chunk.byteLength);
    chunk.copyTo(raw);
    const units = nalUnits(raw);
    const sps = units.filter((u) => nalType(u) === 7);
    const pps = units.filter((u) => nalType(u) === 8);
    if (sps.length && pps.length) state.header = avcHeader(sps, pps);
    const picture = units.filter((u) => ![7, 8, 9].includes(nalType(u)));
    const data = new Uint8Array(picture.reduce((sum, u) => sum + 4 + u.length, 0));
    let at = 0;
    for (const u of picture) {
      new DataView(data.buffer).setUint32(at, u.length);
      data.set(u, at + 4);
      at += 4 + u.length;
    }
    const frame = new EncodedVideoChunk({ type: chunk.type, timestamp: chunk.timestamp, duration: chunk.duration ?? undefined, data });
    const said = meta && meta.decoderConfig && state.header ? { ...meta, decoderConfig: { ...meta.decoderConfig, description: state.header } } : meta;
    return [frame, said];
  }

  if (canCopyVideo) {
    const Encoder = window.VideoEncoder;
    window.VideoEncoder = class extends Encoder {
      constructor(init) {
        const state = { h264: false, header: null };
        super({ ...init, output: (chunk, meta) => (state.h264 ? init.output(...fileFrame(chunk, meta, state)) : init.output(chunk, meta)) });
        this.wbState = state;
      }

      configure(config) {
        this.wbState.h264 = /^avc1\./i.test((config && config.codec) || '');
        if (!this.wbState.h264) return super.configure(config);
        return super.configure({
          ...config,
          avc: { format: 'annexb' },
          ...(IN_ORDER_ONLY && { codec: config.codec.replace(/^avc1\.[0-9a-f]{4}/i, 'avc1.42e0') }),
        });
      }
    };
  }

  // The size of a video's picture if this browser cannot read it to make a copy; otherwise nothing.
  async function beyondThisBrowser(file) {
    if (!canCopyVideo) return null;
    let input;
    try {
      const mb = mediabunny || (mediabunny = await import('/vendor/mediabunny.mjs'));
      input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
      const track = await input.getPrimaryVideoTrack();
      if (!track || (await track.canDecode())) return null;
      return `${track.displayWidth}×${track.displayHeight}`;
    } catch {
      return null;
    } finally {
      if (input) input.dispose();
    }
  }

  function tellRefused(list) {
    if (!list.length) return;
    const one = list.length === 1;
    WB.dialog({
      title: one ? 'This video needs a different browser' : 'These videos need a different browser',
      text: `${list.map((r) => (r.dims ? `${r.name} (${r.dims})` : r.name)).join(', ')} ${one ? 'is' : 'are'} more than this browser can process, so ${one ? 'it was' : 'they were'} not added. Add ${one ? 'it' : 'them'} from ${OTHER_BROWSERS} instead.`,
      cancellable: false,
    });
  }

  // Whether an H.264 file's header can be passed on as it is. One written by Firefox's encoder cannot (its
  // parameter sets start with their first byte twice), so such a file gets a new encode, and a new header with it.
  async function soundHeader(track) {
    try {
      const d = (await track.getDecoderConfig())?.description;
      if (!d) return true;
      const b = ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(d);
      return b.length > 9 && (b[4] & 0xfc) === 0xfc && (b[5] & 0xe0) === 0xe0 && b[8] !== b[9];
    } catch {
      return false;
    }
  }

  // `plan` hears what is about to be done, before any of it is: 'wrap' or 'encode', how long the video is,
  // and about how large the copy will be. It hears nothing when the file goes up as it is.
  async function reviewCopy(file, report, plan = () => {}) {
    let mb;
    try {
      mb = mediabunny || (mediabunny = await import('/vendor/mediabunny.mjs'));
    } catch {
      return file;
    }
    const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
    try {
      const track = await input.getPrimaryVideoTrack();
      if (!track || !canCopyVideo) return file;
      if (!(await track.canDecode())) throw refusal(`${track.displayWidth}×${track.displayHeight}`);
      const w = track.displayWidth;
      const h = track.displayHeight;
      const duration = await input.computeDuration();
      const bitrate = duration > 0 ? (file.size * 8) / duration : VIDEO_BITRATE;
      // Fit inside 1920x1080 (or 1080x1920), keeping the shape; encoders want even sizes.
      const k = Math.min(1, VIDEO_LONG_SIDE / Math.max(w, h), VIDEO_SHORT_SIDE / Math.min(w, h));
      const width = Math.max(2, Math.round((w * k) / 2) * 2);
      const height = Math.max(2, Math.round((h * k) / 2) * 2);
      // A file that is already H.264 within 1080p with a key frame about every half second needs no new
      // encode, only a new wrapper: seconds instead of minutes.
      if (track.codec === 'avc' && k === 1 && (await soundHeader(track)) && (await closeKeyFrames(mb, track, duration))) {
        const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new mb.BufferTarget() });
        const conversion = await mb.Conversion.init({ input, output });
        if (conversion.isValid && !conversion.discardedTracks.some((d) => d.track.type === 'video')) {
          plan('wrap', duration, file.size);
          conversion.onProgress = (p) => report(p);
          await conversion.execute();
          return new File([output.target.buffer], `${file.name.replace(/\.[^.]+$/, '')}.mp4`, { type: 'video/mp4' });
        }
      }
      // Close key frames cost bits, so a lean source gets some headroom rather than losing detail.
      const target = Math.round(Math.min(VIDEO_BITRATE, Math.max(VIDEO_MIN_BITRATE, bitrate * 1.5)));
      const codec = await mb.getFirstEncodableVideoCodec(['avc', 'vp9'], { width, height, bitrate: target });
      if (!codec) throw refusal(`${w}×${h}`);
      const mp4 = codec === 'avc';
      plan('encode', duration, (target * duration) / 8);
      const encode = async (hardwareAcceleration) => {
        const format = mp4 ? new mb.Mp4OutputFormat({ fastStart: 'in-memory' }) : new mb.WebMOutputFormat();
        const output = new mb.Output({ format, target: new mb.BufferTarget() });
        const conversion = await mb.Conversion.init({
          input, output,
          video: { codec, width, height, fit: 'contain', bitrate: target, keyFrameInterval: VIDEO_KEY_INTERVAL, forceTranscode: true, hardwareAcceleration },
        });
        if (!conversion.isValid) return null;
        conversion.onProgress = (p) => report(p);
        await conversion.execute();
        return output.target.buffer;
      };
      // The graphics card's encoder (NVENC, Quick Sync, AMD) is several times faster than the processor
      // where the browser has one. Otherwise, or if it gives up part way, the processor does it.
      let buffer = null;
      if (await mb.canEncodeVideo(codec, { width, height, bitrate: target, hardwareAcceleration: 'prefer-hardware' }).catch(() => false)) {
        try {
          buffer = await encode('prefer-hardware');
        } catch (err) {
          console.warn('The hardware encoder failed, using the processor:', err);
          report(0);
        }
      }
      if (!buffer) buffer = await encode('no-preference');
      if (!buffer) throw refusal(`${w}×${h}`);
      const ext = mp4 ? 'mp4' : 'webm';
      return new File([buffer], `${file.name.replace(/\.[^.]+$/, '')}.${ext}`, { type: `video/${ext}` });
    } catch (err) {
      if (err.refused) throw err;
      // It read the file and then gave up part way: the same answer as not being able to read it.
      console.warn('Could not make a review copy:', err);
      throw refusal();
    } finally {
      input.dispose();
    }
  }

  // The still a video shows until it is played: the frame its thumbnail is made from, large enough to fill the item.
  async function videoPoster(video) {
    const k = Math.min(1, POSTER_MAX / Math.max(video.videoWidth, video.videoHeight));
    const canvas = el('canvas', { width: Math.round(video.videoWidth * k), height: Math.round(video.videoHeight * k) });
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.86));
    return blob ? (await upload(blob, EXT_BY_TYPE[blob.type] || '.webp')).url : null;
  }

  async function ingest(file, onProgress, { onPhase = () => {}, onStrip = () => {}, onPlan = () => {} } = {}) {
    const ext = fileExt(file);
    const url = URL.createObjectURL(file);
    try {
      if (VID_EXT.test(ext)) {
        let planned = false;
        const prepared = await reviewCopy(file, onPhase, (...plan) => {
          planned = true;
          onPlan(...plan);
        });
        const preparedUrl = prepared === file ? url : URL.createObjectURL(prepared);
        try {
          // A copy made here that this browser then cannot show a frame of is a broken copy, and would be
          // a black rectangle on the board for everyone. A file that went up as it came may still play elsewhere.
          const made = prepared !== file;
          const { w, h, video } = await probeVideo(preparedUrl).catch((err) => { throw made ? refusal() : err; });
          const shows = await pickFrame(video).catch(() => false);
          if (!shows && made) throw refusal(`${w}×${h}`);
          const th = shows ? await makeThumb(video, video.videoWidth, video.videoHeight) : null;
          const poster = shows ? await videoPoster(video).catch(() => null) : null;
          // Read from the file as it came: a re-encoded copy keeps the rate, but not every container records it as exactly.
          const fps = await readRate(file);
          const dur = isFinite(video.duration) ? Math.round(video.duration * 1000) / 1000 : 0;
          if (!planned) onPlan('none', dur, prepared.size);
          onPhase(1);
          onProgress(0);
          // The strip is read from the copy here while it uploads, so it only costs a wait where the upload is the quicker of the two.
          const [up, wf] = await Promise.all([upload(prepared, fileExt(prepared), onProgress), videoWave(prepared, preparedUrl, dur, onStrip)]);
          // One that went up as it came is its own original.
          return { type: 'video', src: up.url, ...(!made && { orig: up.url }), nw: w, nh: h, name: file.name, ...(th && { th }), ...(poster && { poster }), ...(fps && { fps }), ...(dur && { dur }), ...(wf && { wf }) };
        } finally {
          if (preparedUrl !== url) URL.revokeObjectURL(preparedUrl);
        }
      }
      const img = await loadImage(url);
      const nw = img.naturalWidth || 512;
      const nh = img.naturalHeight || 512;
      const out = { type: 'image', nw, nh, name: file.name };
      if (Math.max(nw, nh) > PREVIEW_MAX * 1.25 && ext !== '.gif' && ext !== '.svg') {
        try {
          const k = PREVIEW_MAX / Math.max(nw, nh);
          const canvas = el('canvas', { width: Math.round(nw * k), height: Math.round(nh * k) });
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.86));
          if (blob) {
            out.prev = (await upload(blob, EXT_BY_TYPE[blob.type] || '.webp')).url;
            out.pw = canvas.width;
          }
        } catch {
          // Without a preview the board just shows the original.
        }
      }
      if (Math.max(nw, nh) > THUMB_MAX * 1.5) {
        const th = await makeThumb(img, nw, nh);
        if (th) out.th = th;
      }
      out.src = (await upload(file, ext, onProgress)).url;
      return out;
    } finally {
      URL.revokeObjectURL(url);
    }
  }


  return {
    IMG_EXT, VID_EXT, EXT_BY_TYPE, canCopyVideo, OTHER_BROWSERS,
    fileExt, upload, loadImage, probeVideo, brightness, pickFrame, beyondThisBrowser, tellRefused, ingest, videoWave, readRate, snapRate,
  };
})();
