'use strict';

// A zip file written straight onto a response, from files that lie on disk as they are to be sent.
//
// Nothing is compressed: what goes in is pictures and video, which are compressed already, so every
// file's place and the size of the whole are known before the first byte is sent. The browser is told
// how much is coming and can show how far along it is, and nothing is held in memory but the piece of
// a file that is on its way. Files and archives past 4 GB are written the ZIP64 way.

const fs = require('node:fs');
const zlib = require('node:zlib');

const MAX32 = 0xffffffff;
const UTF8_NAMES = 0x0800;

// The checksum the format asks for with every file.
async function crcOfFile(file) {
  let crc = 0;
  for await (const chunk of fs.createReadStream(file)) crc = zlib.crc32(chunk, crc);
  return crc >>> 0;
}

// Names as they are safe to unpack anywhere: no folders, nothing Windows refuses, and no two the same.
function safeNames(names) {
  const taken = new Set();
  return names.map((raw) => {
    let name = String(raw || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim().slice(0, 180) || 'file';
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${stem} (${n})${ext}`;
    taken.add(name.toLowerCase());
    return name;
  });
}

function dosTime(ms) {
  const d = new Date(ms);
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

const big = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

// Where everything goes. `entries` are { name, size, mtime }; each comes back with the bytes of its
// name, whether it needs the long form, and where its header starts.
function layout(entries) {
  let offset = 0;
  const placed = entries.map((e) => {
    const name = Buffer.from(e.name, 'utf8');
    const long = e.size >= MAX32;
    const at = offset;
    offset += 30 + name.length + (long ? 20 : 0) + e.size;
    return { ...e, nameBytes: name, long, at, longInIndex: long || at >= MAX32 };
  });
  const indexAt = offset;
  const indexSize = placed.reduce((sum, e) => sum + 46 + e.nameBytes.length + (e.longInIndex ? 28 : 0), 0);
  const longEnd = placed.length >= 0xffff || indexAt >= MAX32 || indexSize >= MAX32 || placed.some((e) => e.longInIndex);
  return { placed, indexAt, indexSize, longEnd, size: indexAt + indexSize + (longEnd ? 76 : 0) + 22 };
}

function fileHeader(e, crc) {
  const { time, date } = dosTime(e.mtime);
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(e.long ? 45 : 20, 4);
  h.writeUInt16LE(UTF8_NAMES, 6);
  h.writeUInt16LE(0, 8); // stored, not compressed
  h.writeUInt16LE(time, 10);
  h.writeUInt16LE(date, 12);
  h.writeUInt32LE(crc, 14);
  h.writeUInt32LE(e.long ? MAX32 : e.size, 18);
  h.writeUInt32LE(e.long ? MAX32 : e.size, 22);
  h.writeUInt16LE(e.nameBytes.length, 26);
  h.writeUInt16LE(e.long ? 20 : 0, 28);
  const parts = [h, e.nameBytes];
  if (e.long) {
    const x = Buffer.alloc(4);
    x.writeUInt16LE(1, 0);
    x.writeUInt16LE(16, 2);
    parts.push(x, big(e.size), big(e.size));
  }
  return Buffer.concat(parts);
}

function indexEntry(e, crc) {
  const { time, date } = dosTime(e.mtime);
  const h = Buffer.alloc(46);
  h.writeUInt32LE(0x02014b50, 0);
  h.writeUInt16LE(45, 4);
  h.writeUInt16LE(e.longInIndex ? 45 : 20, 6);
  h.writeUInt16LE(UTF8_NAMES, 8);
  h.writeUInt16LE(0, 10);
  h.writeUInt16LE(time, 12);
  h.writeUInt16LE(date, 14);
  h.writeUInt32LE(crc, 16);
  h.writeUInt32LE(e.longInIndex ? MAX32 : e.size, 20);
  h.writeUInt32LE(e.longInIndex ? MAX32 : e.size, 24);
  h.writeUInt16LE(e.nameBytes.length, 28);
  h.writeUInt16LE(e.longInIndex ? 28 : 0, 30);
  h.writeUInt32LE(e.longInIndex ? MAX32 : e.at, 42);
  const parts = [h, e.nameBytes];
  if (e.longInIndex) {
    const x = Buffer.alloc(4);
    x.writeUInt16LE(1, 0);
    x.writeUInt16LE(24, 2);
    parts.push(x, big(e.size), big(e.size), big(e.at));
  }
  return Buffer.concat(parts);
}

function ending(plan) {
  const count = plan.placed.length;
  const parts = [];
  if (plan.longEnd) {
    const r = Buffer.alloc(56);
    r.writeUInt32LE(0x06064b50, 0);
    r.writeBigUInt64LE(44n, 4);
    r.writeUInt16LE(45, 12);
    r.writeUInt16LE(45, 14);
    r.writeBigUInt64LE(BigInt(count), 24);
    r.writeBigUInt64LE(BigInt(count), 32);
    r.writeBigUInt64LE(BigInt(plan.indexSize), 40);
    r.writeBigUInt64LE(BigInt(plan.indexAt), 48);
    const l = Buffer.alloc(20);
    l.writeUInt32LE(0x07064b50, 0);
    l.writeBigUInt64LE(BigInt(plan.indexAt + plan.indexSize), 8);
    l.writeUInt32LE(1, 16);
    parts.push(r, l);
  }
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0);
  e.writeUInt16LE(Math.min(count, 0xffff), 8);
  e.writeUInt16LE(Math.min(count, 0xffff), 10);
  e.writeUInt32LE(Math.min(plan.indexSize, MAX32), 12);
  e.writeUInt32LE(Math.min(plan.indexAt, MAX32), 16);
  parts.push(e);
  return Buffer.concat(parts);
}

// Writes the archive to `out`, or the part of it from byte `start` to byte `end`: a download that was
// cut off can be taken up where it stopped, since every byte's place is known. The plan's entries are
// { name, file, size, mtime }; `crcOf(entry)` gives a file's checksum, and may take its time over one it
// has not seen before. Stops quietly if `out` goes away.
async function writeZip(out, plan, crcOf, start = 0, end = plan.size - 1) {
  let gone = false;
  out.on('close', () => { gone = true; });
  const put = (buf) => new Promise((resolve) => {
    if (gone) return resolve();
    if (out.write(buf)) return resolve();
    // Whichever comes: room for more, or nobody left to send it to.
    const on = () => {
      out.off('drain', on);
      out.off('close', on);
      resolve();
    };
    out.on('drain', on);
    out.on('close', on);
  });
  const crcs = [];
  const crc = async (i) => (crcs[i] ??= await crcOf(plan.placed[i]));
  // Where in the archive the next piece begins.
  let pos = 0;
  // A piece made in memory: sent, in whole or in part, only if any of it is asked for.
  const piece = async (size, make) => {
    const a = Math.max(start, pos);
    const b = Math.min(end, pos + size - 1);
    if (a <= b && !gone) await put((await make()).subarray(a - pos, b - pos + 1));
    pos += size;
  };
  for (let i = 0; i < plan.placed.length && pos <= end && !gone; i++) {
    const e = plan.placed[i];
    await piece(30 + e.nameBytes.length + (e.long ? 20 : 0), async () => fileHeader(e, await crc(i)));
    const a = Math.max(start, pos);
    const b = Math.min(end, pos + e.size - 1);
    if (a <= b) {
      for await (const chunk of fs.createReadStream(e.file, { start: a - pos, end: b - pos })) {
        if (gone) return;
        await put(chunk);
      }
    }
    pos += e.size;
  }
  pos = plan.indexAt;
  for (let i = 0; i < plan.placed.length && pos <= end && !gone; i++) {
    const e = plan.placed[i];
    await piece(46 + e.nameBytes.length + (e.longInIndex ? 28 : 0), async () => indexEntry(e, await crc(i)));
  }
  if (pos <= end) await piece((plan.longEnd ? 76 : 0) + 22, async () => ending(plan));
  if (!gone) out.end();
}

module.exports = { layout, writeZip, crcOfFile, safeNames };
