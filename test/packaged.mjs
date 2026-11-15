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
await page.evaluate((d) => window.ls.addFolder(d), path.join(root, 'samples'));
await page.evaluate(() => location.reload());
await page.waitForSelector('#grid .tile', { timeout: 15000 });
await page.dblclick('#grid .tile:has-text("canon.CR3")');
let ok = false;
for (let i = 0; i < 200 && !ok; i++) { ok = await page.evaluate(() => window.__ls.st.loaded && document.querySelector('#busy').hidden); if (!ok) await page.waitForTimeout(100); }
console.log('packaged RAW open:', ok ? 'OK' : 'FAILED', errs.length ? errs : '');
await app.close();
process.exit(ok ? 0 : 1);
