// Picking photos (not a folder) in the Open window: one photo opens straight into the editor.
import { _electron as electron } from 'playwright';
import fs from 'fs'; import path from 'path'; import os from 'os';
const root = path.resolve(import.meta.dirname, '..');
const app = await electron.launch({ args: [root], env: { ...process.env, LIGHTSHAPER_USERDATA: fs.mkdtempSync(path.join(os.tmpdir(), 'ls-of-')) } });
const page = await app.firstWindow();
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.waitForTimeout(800);
await app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] }); }, path.join(root, 'samples/formats/photo.png'));
await page.click('#openFirst');
let ok = false;
for (let i = 0; i < 100 && !ok; i++) { ok = await page.evaluate(() => window.__ls.st.mode === 'edit' && window.__ls.st.loaded && document.querySelector('#photoName').textContent === 'photo.png'); if (!ok) await page.waitForTimeout(100); }
console.log('picked a PNG -> editor:', ok ? 'OK' : 'FAILED', errs.length ? errs : '');
await page.screenshot({ path: path.join(root, 'test/out/open-png.png') });
await app.close();
process.exit(ok ? 0 : 1);
