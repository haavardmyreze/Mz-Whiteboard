'use strict';

// Answers the pages' requests for uploaded files from the copies kept on this computer (media.js keeps
// them), so a <video> anywhere (a card scrubbed on hover, the timeline's next shot, a board) plays and
// scrubs from the disk. Asked for part of a file, as a video is while it scrubs, it gives that part.
// What is not kept goes to the server as it always did; nothing is kept from here.

const CACHE = 'wb-media-1'; // the same cache media.js keeps videos in

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith('/uploads/')) return;
  event.respondWith(answer(req, url, event.clientId));
});

// The page is told a kept video was played, so it is not the first to make room (media.js touch()).
const told = new Map(); // src -> when
function used(clientId, src) {
  if (Date.now() - (told.get(src) || 0) < 60000) return;
  told.set(src, Date.now());
  self.clients.get(clientId).then((c) => c && c.postMessage({ t: 'used', src })).catch(() => {});
}

async function answer(req, url, clientId) {
  let hit = null;
  try {
    const cache = await caches.open(CACHE);
    hit = await cache.match(url.pathname);
  } catch {
    // nowhere to look: the server answers
  }
  if (!hit) return fetch(req);
  if (clientId) used(clientId, url.pathname);
  // Gone between finding it and reading it (made room for, or cleared): the server answers instead.
  try {
    return await fromKept(hit, req);
  } catch {
    return fetch(req);
  }
}

async function fromKept(hit, req) {
  const range = req.headers.get('range');
  const type = hit.headers.get('content-type') || 'application/octet-stream';
  if (!range) {
    const headers = new Headers(hit.headers);
    headers.set('Accept-Ranges', 'bytes');
    return new Response(hit.body, { status: 200, headers });
  }
  const blob = await hit.blob();
  const size = blob.size;
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  let start = 0;
  let end = size - 1;
  if (m && m[1] !== '') {
    start = Number(m[1]);
    if (m[2] !== '') end = Math.min(Number(m[2]), size - 1);
  } else if (m && m[2] !== '') {
    start = Math.max(0, size - Number(m[2]));
  }
  if (!m || start >= size || start > end) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': type,
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
    },
  });
}
