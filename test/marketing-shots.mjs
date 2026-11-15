// Website screenshots on CC0 sample RAWs (samples/mk), at 2x, saved as WebP for hollowbit.dev.
import { _electron as electron } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const DEST = process.env.HOME + '/Desktop/Hollowbit/assets/img';
const root = path.resolve(import.meta.dirname, '..');
const app = await electron.launch({ args: ['--force-device-scale-factor=2', root], env: { ...process.env, LIGHTSHAPER_USERDATA: fs.mkdtempSync(path.join(os.tmpdir(), 'ls-mk-')) } });
const w = await app.firstWindow(); w.on('console', (m) => { if (m.text().startsWith('REF')) console.log(m.text().slice(0, 400)); });
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 814));
await w.evaluate((d) => window.ls.addFolder(d), path.join(root, 'samples/mk'));
await w.evaluate(() => location.reload());
await w.waitForSelector('#grid .tile img.ok', { timeout: 30000 });
fs.mkdirSync('test/out', { recursive: true });
const webp = (png, name, q = 86) => { execFileSync('cwebp', ['-q', String(q), '-quiet', png, '-o', `${DEST}/${name}.webp`]); console.log('saved', name); };
const shot = async (name) => { await w.evaluate(() => { document.querySelector('#toast').hidden = true; }); await w.mouse.move(640, 806); await w.waitForTimeout(500); await w.screenshot({ path: `test/out/${name}.png` }); webp(`test/out/${name}.png`, name); };
const open = async (file) => {
  await w.evaluate((f) => { const p = window.__ls.st.photos.find((x) => x.name === f); window.__ls.openEditor(p.id); }, file);
  for (let i = 0; i < 300 && !(await w.evaluate(() => window.__ls.st.loaded && document.querySelector('#busy').hidden)); i++) await w.waitForTimeout(100);
  await w.waitForTimeout(900);
};
const edit = (patch) => w.evaluate((p) => { const L = window.__ls; L.st.s = L.S.complete({ ...L.st.s, ...p }); document.querySelector('#undoBtn').click(); document.querySelector('#redoBtn').click(); L.st.s = L.S.complete({ ...L.st.s, ...p }); }, patch);
const commitEdit = (patch) => w.evaluate((p) => { const L = window.__ls; Object.assign(L.st.s, p); L.chooseLook({ id: 'x', name: 'x', s: { ...L.st.s, geom: undefined } }); }, patch);
const openGrp = (g, scroll) => w.evaluate(([g, scroll]) => { document.querySelectorAll('.grp').forEach((x) => { if (x.dataset.grp && x.dataset.grp !== 'looks') x.classList.add('closed'); }); const e = document.querySelector(`.grp[data-grp="${g}"]`); e.classList.remove('closed'); if (scroll) document.querySelector('#panelScroll').scrollTop = e.offsetTop - 8; else document.querySelector('#panelScroll').scrollTop = 0; }, [g, scroll]);

// Give a few photos edits and stars first, so the library looks used.
for (const [f, look, stars] of [['city.RAF', 'cool', 4], ['fruit.CR2', 'film', 3], ['leaves.RW2', 'vivid', 0], ['park.ARW', 'moody', 2], ['desk.NEF', 'crisp', 5]]) {
  await open(f);
  await w.click(`#looks .look[data-id="${look}"]`);
  if (stars) await w.keyboard.press(String(stars));
  await w.waitForTimeout(900);
}
// 1. The editor with a warm look on the ferries.
await open('ferries.ARW');
await w.click('#looks .look[data-id="golden"]');
await w.evaluate(() => { const L = window.__ls; Object.assign(L.st.s, { dehaze: .18, vibrance: .3, contrast: .18 }); L.st.s.look = 'golden'; document.querySelector('#resetBtn'); });
await w.evaluate(() => { const L = window.__ls; L.chooseLook({ id: 'golden', s: { ...L.S.LOOKS.find((l) => l.id === 'golden').s, dehaze: .18, vibrance: .32, contrast: .18 } }); });
await w.keyboard.press('5');
await openGrp('light', false);
await shot('lightshaper-app');
// 2. Masks: darken and deepen the sky over the hills with a gradient.
await open('hills.NEF');
await w.evaluate(() => { const L = window.__ls; L.chooseLook({ id: 'v', s: { exposure: .45, contrast: .2, vibrance: .3, shadows: .35, highlights: -.2, clarity: .15 } }); });
await openGrp('masks', true);
await w.click('#addGrad');
await w.evaluate(() => { const L = window.__ls; const m = L.st.s.masks[0]; Object.assign(m, { x0: .5, y0: .05, x1: .5, y1: .52, adj: { exposure: -.6, dehaze: .3, saturation: .3, temp: -.12 } }); });
await w.evaluate(() => { const L = window.__ls; L.st.s.masks = [...L.st.s.masks]; document.querySelector('#maskList .mask-row').click(); });
await w.waitForTimeout(300);
await w.evaluate(() => window.dispatchEvent(new Event('resize')));
await shot('lightshaper-masks');
// Before / after frames for the website demo, from the same edit.
const frames = await w.evaluate(async () => {
  const L = window.__ls, e = L.engine, s = L.st.s;
  const [ow, oh] = e.outSize(s); const k = 1400 / Math.max(ow, oh); const W = Math.round(ow * k), H = Math.round(oh * k);
  const pic = async (st) => { const c = new OffscreenCanvas(W, H); c.getContext('2d').putImageData(new ImageData(e.pixels(st, W, H), W, H), 0, 0); const b = await c.convertToBlob({ type: 'image/png' }); return new Uint8Array(await b.arrayBuffer()); };
  return { before: [...await pic({ ...L.S.fresh(), geom: s.geom })], after: [...await pic(s)], W, H };
});
fs.writeFileSync('test/out/ls-before.png', Buffer.from(frames.before)); fs.writeFileSync('test/out/ls-after.png', Buffer.from(frames.after));
webp('test/out/ls-before.png', 'lightshaper-before', 82); webp('test/out/ls-after.png', 'lightshaper-after', 82);
console.log('demo frames', frames.W, frames.H);
// 3. Match a photo: the grey park shot matched to the golden ferries.
await open('park.ARW');
await w.click('#looks .look[data-id="none"]');
await openGrp('looks', false);
await w.click('#matchBtn'); await w.waitForTimeout(300);
await w.click('#matchGrid button[title="ferries.ARW"]');
await w.waitForSelector('#matchSheet[hidden]', { state: 'attached', timeout: 60000 });
await w.waitForTimeout(800);
console.log('MATCH', await w.evaluate(() => { const s = window.__ls.st.s; return JSON.stringify({ temp: s.temp, tint: s.tint, sat: s.saturation, sh: s.gradeSh, hi: s.gradeHi, m: s.curve.m }); }));
await w.evaluate(() => { document.querySelector('#panelScroll').scrollTop = document.querySelector('#matchBar').offsetTop - 260; document.querySelector('#toast').hidden = true; });
await shot('lightshaper-match');
// 4. The library with stars and edits.
await w.keyboard.press('Escape'); await w.waitForTimeout(900);
await w.evaluate(() => { const L = window.__ls; L.st.sel.clear(); ['city.RAF', 'fruit.CR2'].forEach((n) => L.st.sel.add(L.st.photos.find((p) => p.name === n).id)); document.querySelector('#grid').click(); });
await w.evaluate(() => { const L = window.__ls; ['city.RAF', 'fruit.CR2'].forEach((n) => L.st.sel.add(L.st.photos.find((p) => p.name === n).id)); document.querySelectorAll('#grid .tile').forEach((t) => t.classList.toggle('sel', L.st.sel.has(t.dataset.id))); document.querySelector('#selCount').textContent = '2 selected'; document.querySelector('#toast').hidden = true; });
await w.waitForTimeout(1500);
await shot('lightshaper-library');
// Icon for the website.
execFileSync('sips', ['-z', '256', '256', 'assets/icon.png', '--out', `${DEST}/lightshaper-icon.png`], { stdio: 'ignore' });
await app.close();
