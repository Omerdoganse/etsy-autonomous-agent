'use strict';
/**
 * ZIP oluşturma: archiver varsa onu kullanır; yoksa Node zlib ile saf JS (deflate) ZIP yazar.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

async function createZip(outPath, files) {
  // files: [{ path: absolute, name: 'in-zip/name.png' }]
  let archiver = null;
  try { archiver = require('archiver'); } catch { /* yedek yol */ }
  if (archiver) {
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(outPath);
      const arc = archiver('zip', { zlib: { level: 9 } });
      out.on('close', resolve);
      arc.on('error', reject);
      arc.pipe(out);
      for (const f of files) arc.file(f.path, { name: f.name });
      arc.finalize();
    });
    return outPath;
  }
  return writeZipNative(outPath, files);
}

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

function writeZipNative(outPath, files) {
  const fd = fs.openSync(outPath, 'w');
  let offset = 0;
  const central = [];
  const { time, date } = dosDateTime(new Date());
  try {
    for (const f of files) {
      const data = fs.readFileSync(f.path);
      const crc = zlib.crc32(data) >>> 0;
      const deflated = zlib.deflateRawSync(data, { level: 9 });
      const useDeflate = deflated.length < data.length;
      const payload = useDeflate ? deflated : data;
      const name = Buffer.from(f.name.replace(/\\/g, '/'), 'utf8');
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
      lh.writeUInt16LE(useDeflate ? 8 : 0, 8); lh.writeUInt16LE(time, 10); lh.writeUInt16LE(date, 12);
      lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(payload.length, 18); lh.writeUInt32LE(data.length, 22);
      lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
      fs.writeSync(fd, lh); fs.writeSync(fd, name); fs.writeSync(fd, payload);
      central.push({ name, crc, csize: payload.length, usize: data.length, method: useDeflate ? 8 : 0, offset });
      offset += lh.length + name.length + payload.length;
    }
    const cdStart = offset;
    for (const c of central) {
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
      ch.writeUInt16LE(c.method, 10); ch.writeUInt16LE(time, 12); ch.writeUInt16LE(date, 14);
      ch.writeUInt32LE(c.crc, 16); ch.writeUInt32LE(c.csize, 20); ch.writeUInt32LE(c.usize, 24);
      ch.writeUInt16LE(c.name.length, 28); ch.writeUInt32LE(c.offset, 42);
      fs.writeSync(fd, ch); fs.writeSync(fd, c.name);
      offset += ch.length + c.name.length;
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(offset - cdStart, 12); end.writeUInt32LE(cdStart, 16);
    fs.writeSync(fd, end);
  } finally { fs.closeSync(fd); }
  return outPath;
}

module.exports = { createZip, writeZipNative, basename: path.basename };
