// Finds the photos in a folder (not its subfolders) and reads only their names, sizes and dates.
const fs = require('fs').promises;
const path = require('path');

const RAW = ['cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'raf', 'orf', 'rw2', 'pef', 'dng', 'srw', 'raw', 'rwl', '3fr', 'erf', 'kdc', 'mrw', 'x3f', 'iiq', 'mef', 'mos'];
const IMG = ['jpg', 'jpeg', 'png', 'webp', 'avif', 'bmp', 'gif'];
const HEIC = process.platform === 'darwin' ? ['heic', 'heif'] : [];

function kind(name) {
  const ext = path.extname(name).slice(1).toLowerCase();
  if (RAW.includes(ext)) return 'raw';
  if (IMG.includes(ext) || HEIC.includes(ext)) return ext === 'jpeg' ? 'jpg' : ext;
  return null;
}

async function scan(dir) {
  let names;
  try { names = await fs.readdir(dir); } catch { return []; }
  const out = [];
  await Promise.all(names.map(async (name) => {
    if (name.startsWith('.')) return;
    const k = kind(name);
    if (!k) return;
    const p = path.join(dir, name);
    try {
      const st = await fs.stat(p);
      if (st.isFile()) out.push({ path: p, name, kind: k, ext: path.extname(name).slice(1).toUpperCase(), size: st.size, time: st.birthtimeMs || st.mtimeMs });
    } catch { /* gone */ }
  }));
  // When a RAW and a JPEG share a name (camera "RAW+JPEG"), keep both but list them together.
  return out.sort((a, b) => a.time - b.time || a.name.localeCompare(b.name));
}

module.exports = { scan, kind };
