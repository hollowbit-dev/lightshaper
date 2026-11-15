// Decoders for the formats the browser engine can't open: TIFF (8 and 16-bit), HEIC/HEIF, JPEG XL and PSD.
// Runs in a background worker so big files don't freeze the window.
// Returns { width, height, data, layout } where layout is 'rgba8' (Uint8ClampedArray RGBA)
// or 'rgb16' (Uint16Array RGB, sRGB-encoded), plus a few camera fields when the file has them.

let heif = null;
async function heifLib() {
  if (!heif) {
    const factory = (await import('./vendor/heif.js')).default;
    let lib = factory();
    if (lib && typeof lib.then === 'function') lib = await lib;
    if (lib && lib.ready && typeof lib.ready.then === 'function') await lib.ready;
    heif = lib;
  }
  return heif;
}

// Rotates / flips pixel data to match an EXIF/TIFF orientation (1-8). c = values per pixel.
function orient(data, w, h, c, o) {
  if (!o || o === 1) return { data, width: w, height: h };
  const swap = o >= 5;
  const W = swap ? h : w, H = swap ? w : h;
  const out = new data.constructor(W * H * c);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let X, Y;
      switch (o) {
        case 2: X = w - 1 - x; Y = y; break;
        case 3: X = w - 1 - x; Y = h - 1 - y; break;
        case 4: X = x; Y = h - 1 - y; break;
        case 5: X = y; Y = x; break;
        case 6: X = h - 1 - y; Y = x; break;
        case 7: X = h - 1 - y; Y = w - 1 - x; break;
        case 8: X = y; Y = w - 1 - x; break;
        default: X = x; Y = y;
      }
      const s = (y * w + x) * c, d = (Y * W + X) * c;
      for (let k = 0; k < c; k++) out[d + k] = data[s + k];
    }
  }
  return { data: out, width: W, height: H };
}

async function tiff(buf) {
  const UTIF = (await import('./vendor/utif.js')).default;
  const ifds = UTIF.decode(buf);
  // Pick the biggest image (TIFFs can also hold small previews).
  let best = null;
  for (const ifd of ifds) {
    const w = (ifd.t256 || [0])[0], h = (ifd.t257 || [0])[0];
    if (w * h > (best ? best.w * best.h : 0)) best = { ifd, w, h };
  }
  if (!best) throw new Error('This TIFF has no image in it.');
  const ifd = best.ifd;
  UTIF.decodeImage(buf, ifd, ifds);
  const w = ifd.width, h = ifd.height;
  const bps = (ifd.t258 || [8])[0], spp = (ifd.t277 || [1])[0], photo = (ifd.t262 || [2])[0], planar = (ifd.t284 || [1])[0];
  const o = (ifd.t274 || [1])[0];
  const exif = { make: (ifd.t271 || [])[0], model: (ifd.t272 || [])[0] };
  // 16-bit RGB or grey keeps its full depth.
  if (bps === 16 && (photo === 2 || photo === 1) && planar === 1 && ifd.data && ifd.data.length >= w * h * spp * 2) {
    const le = true; // UTIF hands back 16-bit samples in little-endian order, whatever the file used
    const dv = new DataView(ifd.data.buffer, ifd.data.byteOffset, ifd.data.byteLength);
    const out = new Uint16Array(w * h * 3);
    for (let i = 0, n = w * h; i < n; i++) {
      const s = i * spp * 2;
      if (photo === 2) { out[i * 3] = dv.getUint16(s, le); out[i * 3 + 1] = dv.getUint16(s + 2, le); out[i * 3 + 2] = dv.getUint16(s + 4, le); }
      else { const v = dv.getUint16(s, le); out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = v; }
    }
    const r = orient(out, w, h, 3, o);
    return { ...r, layout: 'rgb16', exif };
  }
  const rgba = new Uint8ClampedArray(UTIF.toRGBA8(ifd).buffer);
  const r = orient(rgba, w, h, 4, o);
  return { ...r, layout: 'rgba8', exif };
}

async function heic(buf) {
  const lib = await heifLib();
  const dec = new lib.HeifDecoder();
  const images = dec.decode(new Uint8Array(buf));
  if (!images || !images.length) throw new Error('This HEIC file has no image in it.');
  const img = images[0];
  const width = img.get_width(), height = img.get_height();
  const data = await new Promise((res, rej) => {
    img.display({ data: new Uint8ClampedArray(width * height * 4), width, height }, (d) => (d ? res(d.data) : rej(new Error('HEIC decoding failed'))));
  });
  try { for (const i of images) i.free && i.free(); } catch { /* fine */ }
  return { width, height, data, layout: 'rgba8', exif: {} };
}

async function jxl(buf) {
  const decode = (await import('./vendor/jxl.js')).default;
  const img = await decode(buf);
  return { width: img.width, height: img.height, data: img.data, layout: 'rgba8', exif: {} };
}

async function psd(buf) {
  const { readPsd, initializeCanvas } = await import('./vendor/psd.js');
  initializeCanvas((w, h) => new OffscreenCanvas(w, h), (w, h) => new ImageData(w, h));
  const doc = readPsd(buf, { useImageData: true, skipLayerImageData: true, skipThumbnail: true });
  if (!doc.imageData) throw new Error('This PSD has no flattened image. In Photoshop, save it with “Maximize compatibility” on.');
  const d = doc.imageData;
  // 16-bit PSDs come back as Uint16 RGBA.
  if (d.data instanceof Uint16Array) {
    const out = new Uint16Array(d.width * d.height * 3);
    for (let i = 0, n = d.width * d.height; i < n; i++) { out[i * 3] = d.data[i * 4]; out[i * 3 + 1] = d.data[i * 4 + 1]; out[i * 3 + 2] = d.data[i * 4 + 2]; }
    return { width: d.width, height: d.height, data: out, layout: 'rgb16', exif: {} };
  }
  return { width: d.width, height: d.height, data: new Uint8ClampedArray(d.data.buffer, d.data.byteOffset, d.data.byteLength), layout: 'rgba8', exif: {} };
}

const DECODERS = { tiff, heic, jxl, psd };

self.onmessage = async ({ data: { id, kind, buf } }) => {
  try {
    const r = await DECODERS[kind](buf);
    // Transparent areas are shown over white, like most viewers.
    if (r.layout === 'rgba8') {
      const d = r.data;
      for (let i = 3; i < d.length; i += 4) {
        const a = d[i];
        if (a < 255) { const k = a / 255; d[i - 3] = d[i - 3] * k + 255 * (1 - k); d[i - 2] = d[i - 2] * k + 255 * (1 - k); d[i - 1] = d[i - 1] * k + 255 * (1 - k); d[i] = 255; }
      }
    }
    self.postMessage({ id, ok: true, ...r }, [r.data.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
