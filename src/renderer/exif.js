// Camera info for exported JPEGs. We read a few fields (camera, lens, exposure, date) from the original
// and write a small fresh EXIF block. Location (GPS) and everything else is left out on purpose.

const TAGS = { 0x10f: 'make', 0x110: 'model', 0x132: 'date', 0x829a: 'exposure', 0x829d: 'fnumber', 0x8827: 'iso', 0x9003: 'taken', 0x920a: 'focal', 0xa434: 'lens', 0x8769: 'exifPtr' };

// Reads the fields from a JPEG's APP1 Exif block. Returns {} when there is none.
export function readJpegExif(buf) {
  const b = new Uint8Array(buf); const out = {};
  if (b[0] !== 0xff || b[1] !== 0xd8) return out;
  let i = 2;
  while (i + 4 < b.length && b[i] === 0xff) {
    const marker = b[i + 1], len = (b[i + 2] << 8) | b[i + 3];
    if (marker === 0xe1 && b[i + 4] === 0x45 && b[i + 5] === 0x78 && b[i + 6] === 0x69 && b[i + 7] === 0x66) {
      try { parseTiff(new DataView(b.buffer, b.byteOffset + i + 10, len - 8), out); } catch { /* broken EXIF */ }
      return out;
    }
    if (marker === 0xda) break;
    i += 2 + len;
  }
  return out;
}
function parseTiff(v, out) {
  const le = v.getUint16(0) === 0x4949;
  const u16 = (o) => v.getUint16(o, le), u32 = (o) => v.getUint32(o, le);
  const ifd = (off) => {
    const n = u16(off);
    for (let k = 0; k < n; k++) {
      const e = off + 2 + k * 12, tag = u16(e), type = u16(e + 2), count = u32(e + 4), name = TAGS[tag];
      if (!name) continue;
      const size = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8 }[type] || 1;
      const at = size * count > 4 ? u32(e + 8) : e + 8;
      if (type === 2) { let s = ''; for (let c = 0; c < count - 1 && at + c < v.byteLength; c++) s += String.fromCharCode(v.getUint8(at + c)); out[name] = s.replace(/\0+$/, '').trim(); }
      else if (type === 3) out[name] = u16(at);
      else if (type === 4) out[name] = u32(at);
      else if (type === 5) { const d = u32(at + 4); out[name] = d ? u32(at) / d : 0; }
    }
  };
  ifd(u32(4));
  if (out.exifPtr) ifd(out.exifPtr);
  delete out.exifPtr;
}

// Turns LibRaw's metadata into the same fields.
export function fromLibRaw(m = {}) {
  const pad = (n) => String(n).padStart(2, '0');
  const t = m.timestamp instanceof Date && !isNaN(m.timestamp) && m.timestamp.getFullYear() > 1990 ? m.timestamp : null;
  const date = t ? `${t.getFullYear()}:${pad(t.getMonth() + 1)}:${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}` : null;
  return { make: m.camera_make, model: m.camera_model, iso: m.iso_speed ? Math.round(m.iso_speed) : null, exposure: m.shutter || null, fnumber: m.aperture || null, focal: m.focal_len || null, taken: date, lens: typeof m.lens === 'string' ? m.lens : null };
}

// Builds an APP1 segment (bytes) for the fields.
export function buildExif(f) {
  const ascii = (s) => { const a = [...String(s).slice(0, 120)].map((c) => c.charCodeAt(0) & 0x7f); a.push(0); return a; };
  const rat = (x) => { if (x >= 1 && Math.abs(x - Math.round(x)) < 1e-6) return [Math.round(x), 1]; if (x < 1) { const d = Math.round(1 / x); return Math.abs(1 / d - x) < x * .01 ? [1, d] : [Math.round(x * 100000), 100000]; } return [Math.round(x * 1000), 1000]; };
  const ifd0 = [], exif = [];
  if (f.make) ifd0.push([0x10f, 2, ascii(f.make)]);
  if (f.model) ifd0.push([0x110, 2, ascii(f.model)]);
  ifd0.push([0x112, 3, [1]]);
  ifd0.push([0x131, 2, ascii('Lightshaper')]);
  if (f.taken || f.date) ifd0.push([0x132, 2, ascii(f.taken || f.date)]);
  if (f.exposure) exif.push([0x829a, 5, [rat(f.exposure)]]);
  if (f.fnumber) exif.push([0x829d, 5, [rat(f.fnumber)]]);
  if (f.iso) exif.push([0x8827, 3, [Math.min(65535, f.iso)]]);
  if (f.taken) exif.push([0x9003, 2, ascii(f.taken)]);
  if (f.focal) exif.push([0x920a, 5, [rat(f.focal)]]);
  exif.push([0xa001, 3, [1]]); // sRGB
  if (f.lens) exif.push([0xa434, 2, ascii(f.lens)]);
  ifd0.push([0x8769, 4, [0]]); // filled in below

  const bytes = []; const w8 = (x) => bytes.push(x & 255);
  const w16 = (x) => { w8(x); w8(x >> 8); }, w32 = (x) => { w16(x & 0xffff); w16(x >>> 16); };
  // header (little endian)
  w8(0x49); w8(0x49); w16(42); w32(8);
  const size = (t) => (t[1] === 5 ? 8 * t[2].length : t[1] === 3 ? 2 * t[2].length : t[1] === 4 ? 4 * t[2].length : t[2].length);
  const write = (entries, start, next) => {
    entries.sort((a, b) => a[0] - b[0]);
    let data = start + 2 + entries.length * 12 + 4;
    const blobs = [];
    w16(entries.length);
    for (const t of entries) {
      w16(t[0]); w16(t[1]); w32(t[1] === 5 || t[1] === 3 || t[1] === 4 ? t[2].length : t[2].length);
      const sz = size(t);
      if (sz <= 4) { const before = bytes.length; writeVal(t); while (bytes.length < before + 4) w8(0); }
      else { w32(data); blobs.push(t); data += sz + (sz & 1); }
    }
    w32(next);
    for (const t of blobs) { writeVal(t); if (size(t) & 1) w8(0); }
    return data;
  };
  const writeVal = (t) => { if (t[1] === 2) t[2].forEach(w8); else if (t[1] === 3) t[2].forEach(w16); else if (t[1] === 4) t[2].forEach(w32); else t[2].forEach(([n, d]) => { w32(n); w32(d); }); };
  // Work out where the Exif IFD will start, then write.
  const ifd0Size = 2 + ifd0.length * 12 + 4 + ifd0.reduce((a, t) => a + (size(t) > 4 ? size(t) + (size(t) & 1) : 0), 0);
  ifd0.find((t) => t[0] === 0x8769)[2] = [8 + ifd0Size];
  write(ifd0, 8, 0);
  write(exif, 8 + ifd0Size, 0);
  const head = [0xff, 0xe1, 0, 0, 0x45, 0x78, 0x69, 0x66, 0, 0];
  const len = bytes.length + 8;
  head[2] = len >> 8; head[3] = len & 255;
  return new Uint8Array([...head, ...bytes]);
}

// Puts the EXIF block into a JPEG made by the browser (after its JFIF header).
export function insertExif(jpeg, app1) {
  const b = new Uint8Array(jpeg);
  let at = 2;
  if (b[2] === 0xff && b[3] === 0xe0) at = 4 + ((b[4] << 8) | b[5]);
  const out = new Uint8Array(b.length + app1.length);
  out.set(b.subarray(0, at)); out.set(app1, at); out.set(b.subarray(at), at + app1.length);
  return out.buffer;
}
