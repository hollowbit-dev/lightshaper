// Lightshaper by Hollowbit Studio: a free, offline photo editor.
// Your original photos are only ever read. Edits live in Lightshaper's own data folder,
// and exports are written as new files.
const { app, BrowserWindow, ipcMain, shell, nativeTheme, nativeImage, dialog, protocol, net } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');
const { setupUpdates } = require('./update-check');
const lib = require('./library');

const IS_MAC = process.platform === 'darwin';
if (process.env.LIGHTSHAPER_USERDATA) app.setPath('userData', process.env.LIGHTSHAPER_USERDATA);
const settings = () => require('./settings');
const edits = () => require('./edits');

protocol.registerSchemesAsPrivileged([{ scheme: 'ls', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

let win;
const RENDERER = path.join(__dirname, 'renderer');
const LIBRAW = path.dirname(require.resolve('libraw-wasm/dist/index.js'));
const thumbDir = () => path.join(app.getPath('userData'), 'thumbs');

// Only photos inside folders the user opened (or files they dropped) can be read by the window.
const allowed = new Map(); // id -> absolute path
const idOf = (p) => crypto.createHash('sha1').update(p).digest('hex').slice(0, 16);
function allow(p) { const id = idOf(p); allowed.set(id, p); return id; }

function inside(base, p) { const r = path.relative(base, p); return r && !r.startsWith('..') && !path.isAbsolute(r); }

async function serve(req) {
  const u = new URL(req.url);
  const rel = decodeURIComponent(u.pathname);
  if (u.host === 'app') {
    const p = rel.startsWith('/lib/') ? path.join(LIBRAW, rel.slice(5)) : path.join(RENDERER, rel);
    if (!inside(RENDERER, p) && !inside(LIBRAW, p)) return new Response('no', { status: 403 });
    return net.fetch(pathToFileURL(p).toString());
  }
  if (u.host === 'photo') {
    const p = allowed.get(rel.slice(1));
    if (!p) return new Response('no', { status: 404 });
    return net.fetch(pathToFileURL(p).toString());
  }
  if (u.host === 'thumb') {
    const id = rel.slice(1);
    const p = allowed.get(id);
    if (!p) return new Response('no', { status: 404 });
    const file = await thumbFor(id, p);
    if (!file) return new Response('none', { status: 404 });
    return net.fetch(pathToFileURL(file).toString(), { headers: { 'Cache-Control': 'no-cache' } });
  }
  return new Response('no', { status: 404 });
}

// Thumbnails: an edited photo's own preview (saved by the editor), otherwise the system's thumbnail.
const thumbJobs = new Map();
async function thumbFor(id, p) {
  const edited = path.join(thumbDir(), `${id}-edit.jpg`);
  if (edits().get(p) && fs.existsSync(edited)) return edited;
  let st; try { st = await fsp.stat(p); } catch { return null; }
  const file = path.join(thumbDir(), `${id}-${st.mtimeMs | 0}.jpg`);
  if (fs.existsSync(file)) return file;
  if (thumbJobs.has(file)) return thumbJobs.get(file);
  const job = (async () => {
    try {
      const img = await nativeImage.createThumbnailFromPath(p, { width: 480, height: 480 });
      if (img.isEmpty()) return null;
      await fsp.mkdir(thumbDir(), { recursive: true });
      await fsp.writeFile(file, img.toJPEG(86));
      return file;
    } catch { return null; } finally { thumbJobs.delete(file); }
  })();
  thumbJobs.set(file, job);
  return job;
}

function create() {
  nativeTheme.themeSource = 'dark';
  win = new BrowserWindow({
    width: 1320, height: 860, minWidth: 980, minHeight: 640,
    backgroundColor: '#111017',
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'hidden',
    titleBarOverlay: IS_MAC ? undefined : { color: '#111017', symbolColor: '#a8a3b8', height: 36 },
    trafficLightPosition: { x: 18, y: 18 },
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('ls://app/')) { e.preventDefault(); if (/^https:\/\//.test(url)) shell.openExternal(url); } });
  win.loadURL('ls://app/index.html');
}

// The only network request: once a day, if not turned off, ask GitHub for the latest version number.
const updates = setupUpdates({
  app, repo: 'hollowbit-dev/lightshaper',
  getSettings: () => settings().get(), setSettings: (p) => settings().set(p),
  send: (st) => { if (win && !win.isDestroyed()) win.webContents.send('update', st); },
});
ipcMain.handle('settings', () => ({ ...settings().get(), version: app.getVersion() }));
ipcMain.handle('set-settings', (e, patch) => {
  const ok = {};
  if ('autoUpdate' in patch) ok.autoUpdate = patch.autoUpdate !== false;
  if (patch.skipVersion) ok.skipVersion = String(patch.skipVersion);
  if (patch.export && typeof patch.export === 'object') ok.export = patch.export;
  if (Array.isArray(patch.presets)) ok.presets = patch.presets.slice(0, 200);
  if (typeof patch.thumbSize === 'number') ok.thumbSize = patch.thumbSize;
  if (typeof patch.lastPlace === 'string') ok.lastPlace = patch.lastPlace;
  return settings().set(ok);
});
ipcMain.handle('check-updates', () => updates.check({ manual: true }));
ipcMain.handle('open-update', (e, url) => /^https:\/\/github\.com\/hollowbit-dev\/lightshaper\//.test(url) && shell.openExternal(url));

// ---------- folders ----------
function folders() { return (settings().get().folders || []).filter((f) => fs.existsSync(f)); }

async function listing(dir) {
  const photos = await lib.scan(dir);
  return photos.map((p) => ({ ...p, id: allow(p.path), edited: !!edits().get(p.path), rating: edits().rating(p.path) }));
}

ipcMain.handle('folders', () => folders().map((f) => ({ path: f, name: path.basename(f) })));
// Opens photos or a folder. On a Mac one window can pick either; Windows can't mix them, so
// `mode` 'files' asks for photos and anything else asks for a folder.
const PHOTO_EXT = () => [...lib.IMG, ...Object.keys(lib.EXTRA), ...lib.RAW];
// Photos opened on their own (not as a folder) are kept in a "Recent photos" list.
function recentFiles() { return (settings().get().recent || []).filter((f) => fs.existsSync(f)); }
async function addRecent(paths) {
  const ok = (await lib.describe(paths)).map((p) => p.path);
  if (ok.length) settings().set({ recent: [...ok, ...recentFiles().filter((f) => !ok.includes(f))].slice(0, 500) });
  return ok;
}
ipcMain.handle('recent', async () => (await lib.describe(recentFiles())).map((p) => ({ ...p, id: allow(p.path), edited: !!edits().get(p.path), rating: edits().rating(p.path) })));
ipcMain.handle('clear-recent', () => { settings().set({ recent: [] }); return true; });

ipcMain.handle('add-folder', async (e, given, mode) => {
  // Dropped items: loose photos go to Recent photos; a dropped folder opens as a folder.
  if (Array.isArray(given)) {
    const paths = given.map(String);
    const dirs = [], files = [];
    for (const p of paths) { try { ((await fsp.stat(p)).isDirectory() ? dirs : files).push(p); } catch { /* gone */ } }
    if (files.length) { const ok = await addRecent(files); return ok.length ? { recent: true, select: ok.map((p) => path.basename(p)) } : null; }
    given = dirs[0];
    if (!given) return null;
  }
  let dir = given, select = [];
  if (!dir) {
    const files = mode === 'files' || IS_MAC;
    const r = await dialog.showOpenDialog(win, {
      properties: IS_MAC ? ['openFile', 'openDirectory', 'multiSelections'] : files ? ['openFile', 'multiSelections'] : ['openDirectory'],
      title: files ? 'Open photos or a folder' : 'Open a folder of photos', buttonLabel: 'Open',
      ...(files ? { filters: [{ name: 'Photos', extensions: PHOTO_EXT() }, { name: 'All files', extensions: ['*'] }] } : {}),
    });
    if (r.canceled || !r.filePaths[0]) return null;
    dir = r.filePaths[0];
    try { if (!(await fsp.stat(dir)).isDirectory()) { const ok = await addRecent(r.filePaths); return ok.length ? { recent: true, select: ok.map((p) => path.basename(p)) } : null; } } catch { return null; }
  }
  try { if (!(await fsp.stat(dir)).isDirectory()) dir = path.dirname(dir); else select = []; } catch { return null; }
  const list = [dir, ...folders().filter((f) => f !== dir)].slice(0, 30);
  settings().set({ folders: list });
  return { path: dir, name: path.basename(dir), select };
});
ipcMain.handle('remove-folder', (e, dir) => { settings().set({ folders: folders().filter((f) => f !== dir) }); return true; });
ipcMain.handle('list', (e, dir) => (folders().includes(dir) ? listing(dir) : []));
// A single reference photo from anywhere (for "Match a photo"). Only that file becomes readable.
ipcMain.handle('pick-image', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], title: 'Choose a photo to match', buttonLabel: 'Match this',
    filters: [{ name: 'Photos', extensions: [...lib.IMG, ...Object.keys(lib.EXTRA), ...lib.RAW] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  const p = r.filePaths[0], k = lib.kind(path.basename(p));
  if (!k) return null;
  return { id: allow(p), name: path.basename(p), kind: k };
});
// Preset files (.xmp / .lrtemplate): only their text is read, and only files with those endings.
async function readPresets(paths) {
  const out = [];
  for (const p of paths.slice(0, 500)) {
    if (!/\.(xmp|lrtemplate)$/i.test(p)) continue;
    try { const st = await fsp.stat(p); if (st.size > 2e6) continue; out.push({ name: path.basename(p), text: await fsp.readFile(p, 'utf8') }); } catch { /* skip */ }
  }
  return out;
}
ipcMain.handle('pick-presets', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], title: 'Import presets', buttonLabel: 'Import',
    filters: [{ name: 'Lightroom presets', extensions: ['xmp', 'lrtemplate'] }] });
  return r.canceled ? [] : readPresets(r.filePaths);
});
ipcMain.handle('read-presets', (e, paths) => readPresets([].concat(paths).map(String)));
ipcMain.handle('reveal', (e, id) => { const p = allowed.get(id); if (p) shell.showItemInFolder(p); return !!p; });

// ---------- edits ----------
ipcMain.handle('get-edit', (e, id) => { const p = allowed.get(id); return p ? edits().get(p) : null; });
ipcMain.handle('save-edit', async (e, id, s, thumbJpeg) => {
  const p = allowed.get(id);
  if (!p) return false;
  edits().set(p, s);
  const file = path.join(thumbDir(), `${id}-edit.jpg`);
  if (s && thumbJpeg) { await fsp.mkdir(thumbDir(), { recursive: true }); await fsp.writeFile(file, Buffer.from(thumbJpeg)); }
  if (!s) await fsp.rm(file, { force: true });
  return true;
});

ipcMain.handle('set-rating', (e, ids, n) => {
  const v = Math.max(0, Math.min(5, n | 0));
  for (const id of [].concat(ids)) { const p = allowed.get(id); if (p) edits().setRating(p, v); }
  return true;
});

// ---------- export ----------
ipcMain.handle('pick-export-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], title: 'Save edited copies to', buttonLabel: 'Choose' });
  if (r.canceled) return null;
  exportDirs.add(r.filePaths[0]);
  return r.filePaths[0];
});
// The window can only write into a folder the user picked, or a "Lightshaper edits" folder beside the photo.
const exportDirs = new Set();
const savedDir = () => { const d = (settings().get().export || {}).dir; return d && d !== ':beside' ? d : null; };
ipcMain.handle('export-write', async (e, id, dir, ext, bytes) => {
  const src = allowed.get(id);
  if (!src || !dir || !/^(jpg|png|webp|tif)$/.test(ext)) return { ok: false, error: 'bad request' };
  if (dir === ':beside') dir = path.join(path.dirname(src), 'Lightshaper edits');
  else if (!exportDirs.has(dir) && dir !== savedDir()) return { ok: false, error: 'Pick the folder again' };
  await fsp.mkdir(dir, { recursive: true });
  const base = path.basename(src, path.extname(src));
  let out = path.join(dir, `${base}.${ext}`);
  for (let i = 2; fs.existsSync(out) || out === src; i++) out = path.join(dir, `${base} (${i}).${ext}`);
  await fsp.writeFile(out, Buffer.from(bytes));
  exported.add(out);
  return { ok: true, path: out };
});
// Only files Lightshaper just exported can be shown in Finder / Explorer from the window.
const exported = new Set();
ipcMain.handle('show-export', (e, p) => { if (exported.has(p) && fs.existsSync(p)) shell.showItemInFolder(p); return true; });

app.whenReady().then(() => { require('./discord-menu').addDiscordMenu();
  protocol.handle('ls', serve);
  create();
  updates.schedule();
});
app.on('window-all-closed', () => app.quit());
