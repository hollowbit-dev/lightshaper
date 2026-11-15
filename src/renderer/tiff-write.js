// Writes a TIFF: RGB, 8 or 16 bits per channel, Deflate-compressed with the horizontal predictor
// (lossless, and the most widely supported compressed TIFF). Strips of 32 rows.
const ROWS = 32;

async function deflate(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

// data: Uint8Array (8-bit) or Uint16Array (16-bit), RGB interleaved, width * height * 3 values.
export async function encodeTiff(data, width, height, { software = 'Lightshaper' } = {}) {
  const bits = data instanceof Uint16Array ? 16 : 8;
  const bpp = bits / 8, rowBytes = width * 3 * bpp;
  const strips = [];
  for (let y = 0; y < height; y += ROWS) {
    const rows = Math.min(ROWS, height - y);
    const raw = new Uint8Array(rows * rowBytes);
    const dv = new DataView(raw.buffer);
    for (let r = 0; r < rows; r++) {
      const src = (y + r) * width * 3, dst = r * rowBytes;
      // Horizontal predictor: store each sample as the difference from the one to its left.
      for (let x = 0; x < width * 3; x++) {
        const v = data[src + x], prev = x >= 3 ? data[src + x - 3] : 0;
        if (bits === 16) dv.setUint16(dst + x * 2, (v - prev) & 0xffff, true);
        else raw[dst + x] = (v - prev) & 0xff;
      }
    }
    strips.push(await deflate(raw));
  }
  // Layout: header, image strips, then the tag directory and its values.
  const tags = [];
  const T = (tag, type, values) => tags.push({ tag, type, values: [].concat(values) });
  const ascii = (s) => [...(s + '\0')].map((c) => c.charCodeAt(0) & 0x7f);
  let off = 8;
  const stripOffsets = strips.map((s) => { const o = off; off += s.length + (s.length & 1); return o; });
  T(256, 4, width); T(257, 4, height); T(258, 3, [bits, bits, bits]); T(259, 3, 8); T(262, 3, 2);
  T(273, 4, stripOffsets); T(274, 3, 1); T(277, 3, 3); T(278, 4, ROWS); T(279, 4, strips.map((s) => s.length));
  T(282, 5, [[72, 1]]); T(283, 5, [[72, 1]]); T(284, 3, 1); T(296, 3, 2); T(305, 2, ascii(software)); T(317, 3, 2);
  tags.sort((a, b) => a.tag - b.tag);
  const size = (t) => t.values.length * ({ 2: 1, 3: 2, 4: 4, 5: 8 }[t.type]);
  const ifdOff = off;
  let extra = ifdOff + 2 + tags.length * 12 + 4;
  const total = extra + tags.reduce((a, t) => a + (size(t) > 4 ? size(t) + (size(t) & 1) : 0), 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  out[0] = 0x49; out[1] = 0x49; dv.setUint16(2, 42, true); dv.setUint32(4, ifdOff, true);
  strips.forEach((s, i) => out.set(s, stripOffsets[i]));
  const put = (t, at) => {
    let p = at;
    for (const v of t.values) {
      if (t.type === 2) dv.setUint8(p++, v);
      else if (t.type === 3) { dv.setUint16(p, v, true); p += 2; }
      else if (t.type === 4) { dv.setUint32(p, v, true); p += 4; }
      else { dv.setUint32(p, v[0], true); dv.setUint32(p + 4, v[1], true); p += 8; }
    }
  };
  let p = ifdOff;
  dv.setUint16(p, tags.length, true); p += 2;
  for (const t of tags) {
    dv.setUint16(p, t.tag, true); dv.setUint16(p + 2, t.type, true); dv.setUint32(p + 4, t.values.length, true);
    if (size(t) <= 4) put(t, p + 8);
    else { dv.setUint32(p + 8, extra, true); put(t, extra); extra += size(t) + (size(t) & 1); }
    p += 12;
  }
  dv.setUint32(p, 0, true);
  return out.buffer;
}
