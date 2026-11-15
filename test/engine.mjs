// Renders the sample photos through the real engine and saves PNGs to test/out (for eyeballing).
import { _electron as electron } from 'playwright';
import fs from 'fs'; import path from 'path'; import os from 'os';
const root = path.resolve(import.meta.dirname, '..');
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-test-'));
const app = await electron.launch({ args: [root], env: { ...process.env, LIGHTSHAPER_USERDATA: ud } });
const page = await app.firstWindow();
page.on('console', (m) => console.log('[page]', m.text()));
await page.waitForLoadState('domcontentloaded');
const looks = process.argv[2] ? process.argv[2].split(',') : ['none'];
const res = await page.evaluate(async ({ dir, looks }) => {
  await window.ls.addFolder(dir);
  const list = await window.ls.list(dir);
  const { Engine } = await import('/engine.js');
  const { decode } = await import('/decode.js');
  const S = await import('/settings.js');
  const eng = new Engine(document.getElementById('c'));
  const out = [];
  for (const p of list) {
    const t0 = performance.now();
    const src = await decode(p);
    const t1 = performance.now();
    eng.load(src);
    const base = src.ref ? eng.calibrate(src.ref) : 0;
    const t2 = performance.now();
    for (const id of looks) {
      const look = S.LOOKS.find((l) => l.id === id);
      const s = S.applyLook(S.fresh(), look);
      const [w, h] = eng.outSize(s); const k = 900 / Math.max(w, h);
      const t3 = performance.now();
      const px = eng.pixels(s, Math.round(w * k), Math.round(h * k));
      const t4 = performance.now();
      const cv = new OffscreenCanvas(Math.round(w * k), Math.round(h * k)); cv.getContext('2d').putImageData(new ImageData(px, cv.width, cv.height), 0, 0);
      const b = await cv.convertToBlob({ type: 'image/png' });
      const r = new FileReader(); const url = await new Promise((ok) => { r.onload = () => ok(r.result); r.readAsDataURL(b); });
      out.push({ name: p.name + '-' + id, url, ms: { decode: Math.round(t1 - t0), load: Math.round(t2 - t1), render: Math.round(t4 - t3) }, base });
    }
  }
  return out;
}, { dir: path.join(root, 'samples'), looks });
for (const r of res) { fs.writeFileSync(path.join(root, 'test/out', r.name + '.png'), Buffer.from(r.url.split(',')[1], 'base64')); console.log(r.name, r.ms, r.base); }
await app.close();
