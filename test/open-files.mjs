// Opening photos without folders, click-to-edit and tick-to-select.
import { _electron as electron } from 'playwright';
import fs from 'fs'; import path from 'path'; import os from 'os';
const root = path.resolve(import.meta.dirname, '..');
const app = await electron.launch({ args: [root], env: { ...process.env, LIGHTSHAPER_USERDATA: fs.mkdtempSync(path.join(os.tmpdir(), 'ls-of-')) } });
const page = await app.firstWindow();
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.waitForTimeout(800);
const results = [];
const check = (name, ok) => { results.push(ok); console.log(name.padEnd(46), ok ? 'OK' : 'FAILED'); };
const until = async (fn, arg) => { for (let i = 0; i < 100; i++) { if (await page.evaluate(fn, arg)) return true; await page.waitForTimeout(100); } return false; };
const pick = (files) => app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: f }); }, files.map((f) => path.join(root, 'samples/formats', f)));

// 1. Pick two photos: no folder appears, they're in Recent photos, the first opens in the editor.
await pick(['photo.png', 'photo.heic']);
await page.click('#openFirst');
check('two photos -> editor on the first', await until(() => window.__ls.st.mode === 'edit' && window.__ls.st.loaded && document.querySelector('#photoName').textContent === 'photo.png'));
check('only the picked photos are listed', await page.evaluate(() => window.__ls.st.photos.length === 2 && window.__ls.st.folder === ':recent' && window.__ls.st.folders.length === 0));

// 2. Library: one click on a photo opens the editor.
await page.click('#modes button[data-mode="library"]'); await page.waitForTimeout(400);
await page.screenshot({ path: path.join(root, 'test/out/library-hint.png') });
await page.click('#grid .tile:has-text("photo.heic")');
check('click a photo -> editor', await until(() => window.__ls.st.mode === 'edit' && document.querySelector('#photoName').textContent === 'photo.heic'));

// 3. The tick selects without opening; after that, clicks select too.
await page.click('#modes button[data-mode="library"]'); await page.waitForTimeout(400);
await page.hover('#grid .tile:has-text("photo.png")');
await page.click('#grid .tile:has-text("photo.png") .tick');
await page.click('#grid .tile:has-text("photo.heic")');
check('tick + click select two, stay in Library', await page.evaluate(() => window.__ls.st.mode === 'library' && window.__ls.st.sel.size === 2 && !document.querySelector('#selActions').hidden));
await page.screenshot({ path: path.join(root, 'test/out/select.png') });

// 4. The Edit tab works without opening anything first.
await page.click('#selectNone');
await page.click('#modes button[data-mode="edit"]');
check('Edit tab opens a photo', await until(() => window.__ls.st.mode === 'edit' && window.__ls.st.loaded));

// 5. Opening the same photo again doesn't add it twice.
await pick(['photo.png']);
await page.click('#modes button[data-mode="library"]'); await page.waitForTimeout(300);
await page.click('#addFolder');
check('no duplicates in Recent photos', await until(() => window.__ls.st.photos.length === 2 && window.__ls.st.mode === 'edit'));

// 6. A folder still opens as a folder.
await app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] }); }, path.join(root, 'samples/formats'));
await page.click('#modes button[data-mode="library"]'); await page.waitForTimeout(300);
await page.click('#addFolder');
check('a folder opens with all its photos', await until(() => window.__ls.st.folders.length === 1 && window.__ls.st.photos.length >= 6));

console.log(errs.length ? errs : 'no page errors');
await app.close();
process.exit(results.every(Boolean) && !errs.length ? 0 : 1);
