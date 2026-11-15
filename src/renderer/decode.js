// Opens a photo for editing. RAW files are developed by LibRaw (WebAssembly, in a background worker)
// into 16-bit linear colour; other formats are decoded by the browser engine.
import LibRaw from '/lib/index.js';
import { readJpegExif, fromLibRaw } from './exif.js';

const RAW_OPTS = {
  outputBps: 16, gamm: [1, 1], noAutoBright: true, useCameraWb: true, outputColor: 1, userQual: 3, highlight: 2,
};

// TIFF, HEIC, JPEG XL and PSD are decoded in a background worker.
const OWN = ['tiff', 'heic', 'jxl', 'psd'];
let fw = null, fwId = 0;
const fwJobs = new Map();
function formatsWorker() {
  if (!fw) {
    fw = new Worker(new URL('./formats.js', import.meta.url), { type: 'module' });
    fw.onmessage = ({ data }) => { const j = fwJobs.get(data.id); if (!j) return; fwJobs.delete(data.id); data.ok ? j.res(data) : j.rej(new Error(data.error)); };
    fw.onerror = (e) => { for (const j of fwJobs.values()) j.rej(new Error(e.message || 'Decoder crashed')); fwJobs.clear(); fw = null; };
  }
  return fw;
}
function decodeOwn(kind, buf) {
  const id = ++fwId;
  return new Promise((res, rej) => { fwJobs.set(id, { res, rej }); formatsWorker().postMessage({ id, kind, buf }, [buf]); });
}

export async function decode(photo, { half = false } = {}) {
  const res = await fetch(`ls://photo/${photo.id}`);
  if (!res.ok) throw new Error('The file could not be read.');
  if (OWN.includes(photo.kind)) {
    const r = await decodeOwn(photo.kind, await res.arrayBuffer());
    return { kind: r.layout, width: r.width, height: r.height, data: r.data, meta: { exif: r.exif || {} } };
  }
  if (photo.kind !== 'raw') {
    const buf = await res.arrayBuffer();
    const exif = photo.kind === 'jpg' ? readJpegExif(buf) : {};
    const bitmap = await createImageBitmap(new Blob([buf]), { imageOrientation: 'from-image', colorSpaceConversion: 'default', premultiplyAlpha: 'none' });
    return { kind: 'bitmap', bitmap, meta: { exif } };
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  const raw = new LibRaw();
  try {
    await raw.open(buf, { ...RAW_OPTS, halfSize: half });
    const meta = await raw.metadata().catch(() => ({}));
    meta.exif = fromLibRaw(meta);
    const img = await raw.imageData();
    if (!img || !img.data || img.colors < 3) throw new Error('This RAW file uses a format LibRaw cannot read yet.');
    // The camera's own preview, used only to match overall brightness.
    let ref = null;
    try {
      const th = await raw.thumbnailData();
      if (th && th.format === 'jpeg' && th.data) ref = await createImageBitmap(new Blob([th.data], { type: 'image/jpeg' }), { resizeWidth: 256, resizeQuality: 'medium' });
    } catch { /* no preview */ }
    return { kind: 'raw', width: img.width, height: img.height, data: img.data, scale: 1, meta, ref };
  } finally {
    raw.dispose();
  }
}
