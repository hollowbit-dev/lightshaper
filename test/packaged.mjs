// Opens a RAW in the packaged app (dist) to prove LibRaw loads from inside the bundle.
import { _electron as electron } from 'playwright';
import fs from 'fs'; import path from 'path'; import os from 'os';
const root = path.resolve(import.meta.dirname, '..');
const exe = process.platform === 'darwin' ? path.join(root, 'dist/mac-arm64/Lightshaper.app/Contents/MacOS/Lightshaper') : path.join(root, 'dist/win-unpacked/Lightshaper.exe');
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-pkg-'));
const app = await electron.launch({ executablePath: exe, env: { ...process.env, LIGHTSHAPER_USERDATA: ud } });
const page = await app.firstWindow();
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.waitForTimeout(800);
let ok = true;
for (const [dir, name] of [['samples', 'canon.CR3'], ['samples/formats', 'photo.heic'], ['samples/formats', 'photo.jxl'], ['samples/formats', 't16.tif'], ['samples/formats', 'photo.psd']]) {
  await page.evaluate((d) => window.ls.addFolder(d), path.join(root, dir));
  await page.evaluate(() => location.reload());
  await page.waitForSelector('#grid .tile', { timeout: 15000 });
  await page.dblclick(`#grid .tile:has-text("${name}")`);
  let done = false;
  for (let i = 0; i < 200 && !done; i++) { done = await page.evaluate((n) => window.__ls.st.loaded && document.querySelector('#busy').hidden && document.querySelector('#photoName').textContent === n, name); if (!done) await page.waitForTimeout(100); }
  console.log('packaged open', name.padEnd(10), done ? 'OK' : 'FAILED');
  ok = ok && done;
}
console.log(errs.length ? errs : 'no page errors');
await app.close();
process.exit(ok && !errs.length ? 0 : 1);
