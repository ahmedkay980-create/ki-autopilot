'use strict';
// Liest die Videolänge aus MP4/MOV (mvhd-Box), ohne externe Programme.
const fs = require('node:fs');

function readBoxHeader(fd, pos, fileSize) {
  if (pos + 8 > fileSize) return null;
  const buf = Buffer.alloc(16);
  fs.readSync(fd, buf, 0, 16, pos);
  let size = buf.readUInt32BE(0);
  const type = buf.toString('latin1', 4, 8);
  let header = 8;
  if (size === 1) { size = Number(buf.readBigUInt64BE(8)); header = 16; }
  else if (size === 0) size = fileSize - pos;
  if (size < header) return null;
  return { size, type, header };
}

/** Dauer in Sekunden oder null, wenn nicht lesbar. */
function videoDurationSeconds(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const fileSize = fs.fstatSync(fd).size;
    let pos = 0;
    while (pos < fileSize) {
      const box = readBoxHeader(fd, pos, fileSize);
      if (!box) return null;
      if (box.type === 'moov') {
        let inner = pos + box.header;
        const end = pos + box.size;
        while (inner < end) {
          const b = readBoxHeader(fd, inner, fileSize);
          if (!b) return null;
          if (b.type === 'mvhd') {
            const body = Buffer.alloc(32);
            fs.readSync(fd, body, 0, 32, inner + b.header);
            const version = body.readUInt8(0);
            let timescale, duration;
            if (version === 1) {
              timescale = body.readUInt32BE(20);
              duration = Number(body.readBigUInt64BE(24));
            } else {
              timescale = body.readUInt32BE(12);
              duration = body.readUInt32BE(16);
            }
            if (!timescale) return null;
            return Math.round((duration / timescale) * 10) / 10;
          }
          inner += b.size;
        }
        return null;
      }
      pos += box.size;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* egal */ }
  }
}

module.exports = { videoDurationSeconds };
