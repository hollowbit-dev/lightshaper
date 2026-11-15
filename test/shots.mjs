// Drives the real app on the sample photos: library, editor, looks, crop, export. Saves screenshots to test/out.
import { _electron as electron } from 'playwright';
import fs from 'fs'; import path from 'path'; import os from 'os';
const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'test/out'); fs.mkdirSync(out, { recursive: true });
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-shots-'));
const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-export-'));
const app = await electron.launch({ args: [root], env: { ...process.env, LIGHTSHAPER_USERDATA: ud } });
const page = await app.firstWindow();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
await page.waitForTimeout(600);
await page.screenshot({ path: `${out}/01-empty.png` });
await page.evaluate((d) => window.ls.addFolder(d), path.join(root, 'samples'));
await page.evaluate(() => location.reload());
await page.waitForSelector('#grid .tile img.ok', { timeout: 20000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/02-library.png` });
const pick = process.env.PHOTO || 'nikon.NEF';
await page.dblclick(`#grid .tile:has-text("${pick}")`);
const t0 = Date.now();
for (let i = 0; i < 300 && !(await page.evaluate(() => window.__ls.st.loaded && document.querySelector('#busy').hidden)); i++) await page.waitForTimeout(100);
console.log('opened in', Date.now() - t0, 'ms');
await page.waitForTimeout(1200);
await page.screenshot({ path: `${out}/03-edit.png` });
// move some sliders through the real UI
async function setSlider(name, v) {
  await page.evaluate(([name, v]) => {
    const sl = [...document.querySelectorAll('.sl')].find((x) => x.querySelector('label').textContent === name);
    const i = sl.querySelector('input'); i.value = v; i.dispatchEvent(new Event('input')); i.dispatchEvent(new Event('change'));
  }, [name, v]);
}
await setSlider('Exposure', 0.4); await setSlider('Contrast', 25); await setSlider('Shadows', 40); await setSlider('Vibrance', 30); await setSlider('Clarity', 20);
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/04-sliders.png` });
// render timing with 4x CPU throttle
const cdp = await page.context().newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
const ms = await page.evaluate(async () => {
  const t = performance.now(); const { st, engine } = window.__ls;
  for (let i = 0; i < 20; i++) { st.s.exposure = i / 40; document.querySelector('#view'); window.__ls.engine.render(st.s, { w: 2400, h: 1500 }); engine.gl.finish(); }
  return (performance.now() - t) / 20;
});
console.log('render per frame (4x throttle, 2400x1500):', ms.toFixed(1), 'ms');
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
for (const look of ['film', 'bw', 'golden']) {
  await page.click(`#looks .look[data-id="${look}"]`); await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/05-look-${look}.png` });
}
await page.click('#looks .look[data-id="auto"]'); await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/06-auto.png` });
// crop
await page.click('#cropBtn'); await page.waitForTimeout(300);
await page.click('#aspects button[data-a="1:1"]');
await page.evaluate(() => { const i = document.querySelector('#straighten input'); i.value = 8; i.dispatchEvent(new Event('input')); });
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}/07-crop.png` });
await page.click('#cropDone'); await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/08-cropped.png` });
// zoom
await page.click('#zoomBtn'); await page.waitForTimeout(300);
await page.screenshot({ path: `${out}/09-zoom.png` });
await page.click('#zoomBtn');
// undo
await page.keyboard.press('Meta+z'); await page.waitForTimeout(200);
const undone = await page.evaluate(() => window.__ls.st.s.geom.crop.w);
console.log('after undo crop w =', undone);
await page.keyboard.press('Meta+Shift+z');
// export (pick folder is a native dialog, so set it like the dialog would)
await page.evaluate(async () => { await new Promise((r) => setTimeout(r, 800)); });
await app.evaluate(({ dialog }, d) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [d] }); }, exportDir);
await page.click('#exportBtn'); await page.waitForTimeout(200);
await page.click('#exWhere button[data-v="pick"]'); await page.waitForTimeout(200);
await page.screenshot({ path: `${out}/10-export.png` });
await page.click('#exGo');
await page.waitForSelector('#toast:has-text("Exported")', { timeout: 60000 });
console.log('exported:', fs.readdirSync(exportDir));
// back to library: edited badge + batch paste
await page.keyboard.press('Escape'); await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/11-library-edited.png` });
console.log('errors:', errors.length ? errors : 'none');
await app.close();
