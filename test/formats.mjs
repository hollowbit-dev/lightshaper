// Opens every file in samples/formats through the real app and saves a small render of each to test/out/fmt-*.png.
import { _electron as electron } from 'playwright';
import fs from 'fs'; import path from 'path'; import os from 'os';
const root = path.resolve(import.meta.dirname, '..');
const app = await electron.launch({ args: [root], env: { ...process.env, LIGHTSHAPER_USERDATA: fs.mkdtempSync(path.join(os.tmpdir(), 'ls-fmt-')) } });
const page = await app.firstWindow();
const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await page.waitForTimeout(800);
const res = await page.evaluate(async (dir) => {
  await window.ls.addFolder(dir);
  const list = await window.ls.list(dir);
  const { decode } = await import('/decode.js');
  const { Engine } = await import('/engine.js');
  const S = await import('/settings.js');
  const eng = new Engine(document.createElement('canvas'));
  const out = [];
  for (const p of list) {
    const t = performance.now();
    try {
      const src = await decode(p);
      eng.load(src);
      const s = S.fresh(); const [w, h] = eng.outSize(s); const k = 480 / Math.max(w, h);
      const W = Math.round(w * k), H = Math.round(h * k);
      const c = new OffscreenCanvas(W, H); c.getContext('2d').putImageData(new ImageData(eng.pixels(s, W, H), W, H), 0, 0);
      const b = await c.convertToBlob({ type: 'image/png' }); const r = new FileReader();
      const url = await new Promise((ok) => { r.onload = () => ok(r.result); r.readAsDataURL(b); });
      out.push({ name: p.name, kind: p.kind, layout: src.kind, size: `${src.width || eng.w}x${src.height || eng.h}`, ms: Math.round(performance.now() - t), url });
    } catch (e) { out.push({ name: p.name, kind: p.kind, error: e.message }); }
  }
  return out;
}, path.join(root, 'samples/formats'));
// TIFF export: 16-bit and 8-bit from the 16-bit sample, written to test/out.
const tiffs = await page.evaluate(async (dir) => {
  const list = await window.ls.list(dir);
  const { decode } = await import('/decode.js'); const { Engine } = await import('/engine.js'); const S = await import('/settings.js'); const { encodeTiff } = await import('/tiff-write.js');
  const eng = new Engine(document.createElement('canvas'));
  eng.load(await decode(list.find((p) => p.name === 't16.tif')));
  const s = { ...S.fresh(), contrast: .2, vibrance: .3 };
  const t0 = performance.now();
  const r16 = await eng.exportImage16(s); const b16 = await encodeTiff(r16.data, r16.width, r16.height);
  const t1 = performance.now();
  const img = await eng.exportImage(s); const rgb = new Uint8Array(img.width * img.height * 3);
  for (let i = 0, j = 0; i < img.data.length; i += 4, j += 3) { rgb[j] = img.data[i]; rgb[j + 1] = img.data[i + 1]; rgb[j + 2] = img.data[i + 2]; }
  const b8 = await encodeTiff(rgb, img.width, img.height);
  // distinct 16-bit levels in one channel shows the extra depth is real
  const lv = new Set(); for (let i = 0; i < r16.data.length; i += 3 * 97) lv.add(r16.data[i]);
  return { b16: [...new Uint8Array(b16)], b8: [...new Uint8Array(b8)], ms16: Math.round(t1 - t0), levels: lv.size };
}, path.join(root, 'samples/formats'));
fs.writeFileSync(path.join(root, 'test/out/export16.tif'), Buffer.from(tiffs.b16));
fs.writeFileSync(path.join(root, 'test/out/export8.tif'), Buffer.from(tiffs.b8));
console.log('tiff export: 16-bit', tiffs.b16.length, 'bytes in', tiffs.ms16, 'ms,', tiffs.levels, 'distinct levels | 8-bit', tiffs.b8.length, 'bytes');
for (const r of res) {
  if (r.url) fs.writeFileSync(path.join(root, 'test/out', 'fmt-' + r.name + '.png'), Buffer.from(r.url.split(',')[1], 'base64'));
  console.log(r.name.padEnd(14), (r.kind || '').padEnd(5), r.error ? 'ERROR ' + r.error : `${r.layout} ${r.size} ${r.ms} ms`);
}
console.log('errors:', errs.length ? errs : 'none');
await app.close();
process.exit(res.some((r) => r.error) ? 1 : 0);
