// Lightshaper window: the Library (folders and photos) and the Editor (live preview, sliders, looks, crop).
import { Engine, frameSize, outToSrc, curveLUT, M } from './engine.js';
import { buildExif, insertExif } from './exif.js';
import { measure, matchSettings, blend } from './match.js';
import { parsePreset } from './presets.js';
import { decode } from './decode.js';
import * as S from './settings.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const api = window.ls;
document.body.classList.toggle('win', api.platform === 'win32');
const DPR = () => window.devicePixelRatio || 1;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const st = {
  mode: 'library', folders: [], folder: null, photos: [], byId: new Map(),
  sel: new Set(), anchor: null, active: null, clip: null, prefs: {},
  s: null, hist: [], hi: -1, token: 0, loaded: false, zoom: null, before: false, cropping: false,
  autoCache: new Map(), dirty: new Set(),
};

// ---------- engines ----------
const engine = new Engine($('#view'));
// A second, hidden engine for exports and batch previews, so the editor is never interrupted.
const worker = new Engine(document.createElement('canvas'));

// ---------- small helpers ----------
function toast(msg, action, fn, ms = 4200) {
  const t = $('#toast');
  t.innerHTML = ''; t.append(Object.assign(document.createElement('span'), { textContent: msg }));
  if (action) { const b = document.createElement('button'); b.textContent = action; b.onclick = () => { t.hidden = true; fn(); }; t.append(b); }
  t.hidden = false; clearTimeout(toast.t); if (ms) toast.t = setTimeout(() => (t.hidden = true), ms);
}
async function jpeg(px, w, h, q = .86) {
  const c = new OffscreenCanvas(w, h); c.getContext('2d').putImageData(new ImageData(px, w, h), 0, 0);
  return (await c.convertToBlob({ type: 'image/jpeg', quality: q })).arrayBuffer();
}
const fit = (w, h, long) => { const k = long / Math.max(w, h); return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))]; };
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ---------- mode switch ----------
function setMode(m) {
  st.mode = m;
  $$('#modes button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  $('#library').classList.toggle('on', m === 'library');
  $('#edit').classList.toggle('on', m === 'edit');
  movePill();
  if (m === 'library') { exitCrop(false); flushSave(); renderGrid(); }
  else requestRender();
  updateExportBtn();
}
function movePill() {
  const on = $('#modes button.on'); const pill = $('#modes .seg-pill');
  if (!on) return;
  pill.style.width = on.offsetWidth + 'px'; pill.style.transform = `translateX(${on.offsetLeft}px)`;
}
$$('#modes button').forEach((b) => (b.onclick = () => { if (b.dataset.mode === 'edit' && !st.active) return; if (b.dataset.mode === 'edit' && st.mode !== 'edit') openEditor(st.active); else setMode(b.dataset.mode); }));

// ---------- folders + library ----------
async function loadFolders(open) {
  st.folders = await api.folders();
  const box = $('#folders'); box.innerHTML = '';
  for (const f of st.folders) {
    const b = document.createElement('button');
    b.className = 'folder' + (st.folder === f.path ? ' on' : '');
    b.title = f.path;
    b.innerHTML = `<svg viewBox="0 0 16 16" width="15" height="15"><path fill="currentColor" d="M1.5 3.5c0-.6.4-1 1-1h3.6l1.4 1.5h6c.6 0 1 .4 1 1v7.5c0 .6-.4 1-1 1h-11c-.6 0-1-.4-1-1z"/></svg><span>${esc(f.name)}</span><i class="x" title="Remove from the list">×</i>`;
    b.onclick = (e) => { if (e.target.classList.contains('x')) { removeFolder(f.path); return; } openFolder(f.path); };
    box.append(b);
  }
  if (open && st.folders.length) openFolder(open === true ? st.folders[0].path : open);
  if (!st.folders.length) { st.folder = null; st.photos = []; renderGrid(); }
}
async function removeFolder(p) {
  await api.removeFolder(p);
  if (st.folder === p) st.folder = null;
  loadFolders(st.folder ? null : true);
}
async function addFolder(p) {
  const f = await api.addFolder(p);
  if (f) { await loadFolders(); openFolder(f.path); }
}
async function openFolder(p) {
  st.folder = p;
  $$('.folder').forEach((b) => b.classList.toggle('on', b.title === p));
  const list = await api.list(p);
  st.photos = list; st.byId = new Map(list.map((x) => [x.id, x]));
  st.sel.clear(); st.anchor = null;
  if (st.mode === 'edit') setMode('library');
  renderGrid();
}

function thumbUrl(p) { return `ls://thumb/${p.id}?v=${p.v || 0}`; }
function tileHtml(p) {
  return `<img loading="lazy" decoding="async" src="${thumbUrl(p)}" alt=""><div class="badges">${p.kind === 'raw' ? `<span class="badge">${esc(p.ext)}</span>` : ''}${p.edited ? '<span class="badge ed">EDITED</span>' : ''}</div><div class="nm">${esc(p.name)}</div>${p.rating ? `<div class="stars">${'★'.repeat(p.rating)}</div>` : ''}${st.dirty.has(p.id) ? '<i class="work-dot"></i>' : ''}`;
}
function makeTile(p, small) {
  const t = document.createElement('div');
  t.className = 'tile'; t.dataset.id = p.id; t.title = small ? p.name : '';
  t.innerHTML = tileHtml(p);
  hookImg(t, p);
  return t;
}
function hookImg(t, p) {
  const img = t.querySelector('img');
  img.onload = () => img.classList.add('ok');
  img.onerror = () => fallbackThumb(p).then((u) => { if (u) { img.src = u; } });
}
function renderGrid() {
  const grid = $('#grid');
  const has = !!st.folder;
  $('#empty').hidden = has;
  $('#libBar').hidden = !has;
  if (!has) { grid.innerHTML = ''; $('#empty').hidden = false; updateSel(); return; }
  $('#folderName').textContent = st.folders.find((f) => f.path === st.folder)?.name || '';
  $('#photoCount').textContent = st.photos.length ? `${st.photos.length} photo${st.photos.length === 1 ? '' : 's'}` : 'No photos in this folder';
  const frag = document.createDocumentFragment();
  for (const p of shown()) frag.append(makeTile(p));
  grid.innerHTML = ''; grid.append(frag);
  updateSel();
}
function refreshTile(p) {
  p.v = Date.now();
  for (const t of $$(`.tile[data-id="${p.id}"]`)) { t.innerHTML = tileHtml(p); hookImg(t, p); }
}
// When the system has no thumbnail (e.g. RAW on Windows without the codec), make one here.
const fallbacks = new Map();
function fallbackThumb(p) {
  if (fallbacks.has(p.id)) return fallbacks.get(p.id);
  const job = (async () => {
    try {
      const src = await decode(p, { half: true });
      worker.load(src);
      if (src.ref) { worker.calibrate(src.ref); src.ref.close(); }
      if (src.bitmap) src.bitmap.close();
      const s = S.complete(await api.getEdit(p.id));
      const [w, h] = fit(...worker.outSize(s), 480);
      const buf = await jpeg(worker.pixels(s, w, h), w, h);
      return URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
    } catch { return null; }
  })();
  fallbacks.set(p.id, job);
  return job;
}

// selection
function updateSel() {
  for (const t of $$('#grid .tile')) t.classList.toggle('sel', st.sel.has(t.dataset.id));
  const n = st.sel.size;
  $('#selCount').textContent = n ? `${n} selected` : '';
  $('#copyEdits').disabled = n !== 1;
  $('#pasteEdits').disabled = !st.clip || !n;
  $('#resetSel').disabled = !n;
  $('#lookMenuBtn').disabled = !n;
  updateExportBtn();
}
function updateExportBtn() {
  const n = st.mode === 'edit' ? (st.active ? 1 : 0) : (st.sel.size || st.photos.length);
  const b = $('#exportBtn'); b.disabled = !n;
  b.textContent = st.mode === 'library' && n > 1 ? `Export ${n}` : 'Export';
}
$('#grid').addEventListener('click', (e) => {
  const t = e.target.closest('.tile');
  if (!t) { st.sel.clear(); updateSel(); return; }
  const id = t.dataset.id;
  if (e.shiftKey && st.anchor) {
    const ids = st.photos.map((p) => p.id); const a = ids.indexOf(st.anchor), b = ids.indexOf(id);
    if (!(e.metaKey || e.ctrlKey)) st.sel.clear();
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) st.sel.add(ids[i]);
  } else if (e.metaKey || e.ctrlKey) { st.sel.has(id) ? st.sel.delete(id) : st.sel.add(id); st.anchor = id; }
  else { st.sel.clear(); st.sel.add(id); st.anchor = id; }
  updateSel();
});
$('#grid').addEventListener('dblclick', (e) => { const t = e.target.closest('.tile'); if (t) openEditor(t.dataset.id); });
$('#thumbSize').oninput = (e) => { $('#grid').style.setProperty('--tile', e.target.value + 'px'); };
$('#thumbSize').onchange = (e) => api.setSettings({ thumbSize: +e.target.value });
$('#addFolder').onclick = () => addFolder();
$('#openFirst').onclick = () => addFolder();

// copy / paste / looks / reset for the selection
function copyEdits(id) {
  return api.getEdit(id).then((s) => {
    const c = S.complete(s); delete c.geom; st.clip = c;
    toast('Edits copied. Select other photos and paste.'); updateSel();
  });
}
$('#copyEdits').onclick = () => { const [id] = st.sel; if (id) copyEdits(id); };
$('#pasteEdits').onclick = () => pasteTo([...st.sel]);
$('#resetSel').onclick = () => batch([...st.sel], () => null, 'Reset');
async function pasteTo(ids) {
  if (!st.clip) return;
  await batch(ids, (cur) => ({ ...S.clone(st.clip), geom: S.clone(cur.geom) }), 'Pasted edits to');
}
// Change the settings of many photos at once. Previews are redrawn in the background.
async function batch(ids, change, verb) {
  const undo = [];
  for (const id of ids) {
    const before = await api.getEdit(id);
    undo.push([id, before]);
    const next = change(S.complete(before));
    const save = next && !S.isDefault(next) ? next : null;
    await api.saveEdit(id, save, null);
    const p = st.byId.get(id); if (p) { p.edited = !!save; if (save) st.dirty.add(id); refreshTile(p); }
    if (id === st.active && st.s) { st.s = S.complete(save); commit(true); syncPanel(); requestRender(); }
  }
  toast(`${verb} ${ids.length} photo${ids.length === 1 ? '' : 's'}`, 'Undo', async () => {
    for (const [id, s] of undo) { await api.saveEdit(id, s, null); const p = st.byId.get(id); if (p) { p.edited = !!s; if (s) st.dirty.add(id); refreshTile(p); } }
    drainThumbs();
  });
  drainThumbs();
}
let draining = false;
async function drainThumbs() {
  if (draining) return; draining = true;
  try {
    while (st.dirty.size) {
      const [id] = st.dirty; const p = st.byId.get(id);
      if (!p) { st.dirty.delete(id); continue; }
      try {
        const s = await api.getEdit(id);
        if (s) {
          const src = await decode(p, { half: true });
          worker.load(src); if (src.ref) { worker.calibrate(src.ref); src.ref.close(); } if (src.bitmap) src.bitmap.close();
          const c = S.complete(s); const [w, h] = fit(...worker.outSize(c), 480);
          await api.saveEdit(id, s, await jpeg(worker.pixels(c, w, h), w, h));
        }
      } catch { /* keep the old preview */ }
      st.dirty.delete(id); refreshTile(p);
      await wait(10);
    }
  } finally { draining = false; }
}

// look menu (library)
function allLooks() { return [...S.LOOKS.filter((l) => l.id !== 'none'), ...(st.prefs.presets || [])]; }
$('#lookMenuBtn').onclick = (e) => {
  e.stopPropagation();
  const m = $('#lookMenu');
  if (!m.hidden) { m.hidden = true; return; }
  m.innerHTML = '';
  for (const l of allLooks()) {
    const b = document.createElement('button'); b.textContent = l.name;
    b.onclick = () => { m.hidden = true; applyLookTo([...st.sel], l); };
    m.append(b);
  }
  m.hidden = false;
};
document.addEventListener('click', () => { $('#lookMenu').hidden = true; });
async function applyLookTo(ids, look) {
  if (look.auto) {
    // Auto needs each photo's own pixels.
    for (const id of ids) {
      const p = st.byId.get(id);
      try {
        const src = await decode(p, { half: true });
        worker.load(src); if (src.ref) { worker.calibrate(src.ref); src.ref.close(); } if (src.bitmap) src.bitmap.close();
        const cur = S.complete(await api.getEdit(id));
        const s = autoSettings(worker, cur);
        await api.saveEdit(id, s, null); p.edited = true; st.dirty.add(id); refreshTile(p);
      } catch { /* skip */ }
    }
    toast(`Auto adjusted ${ids.length} photo${ids.length === 1 ? '' : 's'}`); drainThumbs();
    return;
  }
  await batch(ids, (cur) => S.applyLook(cur, look), `${look.name} applied to`);
}

// ---------- editor ----------
async function openEditor(id) {
  const p = st.byId.get(id); if (!p) return;
  flushSave();
  st.active = id; st.loaded = false; st.zoom = null; st.before = false;
  const token = ++st.token;
  $('#editTab').disabled = false;
  if (st.mode !== 'edit') setMode('edit');
  exitCrop(false);
  $('#photoName').textContent = p.name;
  showStars();
  $('#errorCard').hidden = true;
  $('#meta').textContent = '';
  renderStrip();
  // Show the thumbnail straight away while the full photo develops.
  const ph = $('#placeholder'); ph.src = thumbUrl(p); ph.hidden = false;
  engine.canvas.style.opacity = 0;
  $('#busyText').textContent = p.kind === 'raw' ? 'Developing RAW…' : 'Opening…';
  $('#busy').hidden = false;
  const saved = await api.getEdit(id);
  if (token !== st.token) return;
  st.s = S.complete(saved);
  st.hist = [S.clone(st.s)]; st.hi = 0;
  syncPanel();
  try {
    // The next photo may already be decoded in the background.
    const pre = st.prefetch && st.prefetch.id === id ? st.prefetch.job : null;
    st.prefetch = null;
    const preSrc = pre ? await pre.catch(() => null) : null;
    if (token !== st.token) { preSrc?.bitmap?.close(); return; }
    if (preSrc) showSource(preSrc, p);
    // RAW: a quick half-size pass first, then the full-size one.
    else if (p.kind === 'raw') {
      const half = await decode(p, { half: true });
      if (token !== st.token) return;
      showSource(half, p);
      const full = await decode(p);
      if (token !== st.token) return;
      showSource(full, p);
    } else {
      const src = await decode(p);
      if (token !== st.token) { src.bitmap?.close(); return; }
      showSource(src, p);
    }
    $('#busy').hidden = true;
    renderLooks();
    preload(1);
    prefetchNext(token);
  } catch (err) {
    if (token !== st.token) return;
    $('#busy').hidden = true; ph.hidden = true;
    const card = $('#errorCard'); card.hidden = false;
    card.textContent = `Lightshaper couldn't open this photo. ${err.message || ''}`;
  }
}
function showSource(src, p) {
  engine.load(src);
  if (src.ref) { engine.calibrate(src.ref); src.ref.close(); }
  if (src.bitmap) src.bitmap.close();
  st.loaded = true;
  st.meta = { ...(src.meta || {}), w: src.width || engine.w, h: src.height || engine.h };
  showMeta(p);
  engine.canvas.style.opacity = 1; $('#placeholder').hidden = true;
  requestRender(true);
}
function showMeta(p) {
  const m = st.meta || {};
  const bits = [];
  const [w, h] = st.s ? engine.outSize(st.s) : [engine.w, engine.h];
  bits.push(`${w} × ${h}`);
  const x = m.exif || {};
  if (x.model || x.make) bits.push(esc(`${x.model || x.make}`.trim()));
  if (x.iso) bits.push(`ISO ${Math.round(x.iso)}`);
  if (x.exposure) bits.push(x.exposure >= 1 ? `${x.exposure.toFixed(1)}s` : `1/${Math.round(1 / x.exposure)}s`);
  if (x.fnumber) bits.push(`f/${(+x.fnumber).toFixed(1)}`);
  if (x.focal) bits.push(`${Math.round(x.focal)} mm`);
  $('#meta').innerHTML = bits.map((b) => `<span>${b}</span>`).join('');
}
// Warm up the next photo's thumbnail so moving through them feels instant.
function preload(d) {
  const i = st.photos.findIndex((x) => x.id === st.active);
  const n = st.photos[i + d]; if (n) { const im = new Image(); im.src = thumbUrl(n); }
}
function step(d) {
  const i = st.photos.findIndex((x) => x.id === st.active);
  const n = st.photos[i + d]; if (n) { st.sel.clear(); st.sel.add(n.id); openEditor(n.id); }
}
function renderStrip() {
  const strip = $('#strip');
  if (strip.dataset.folder !== st.folder || strip.children.length !== st.photos.length) {
    strip.innerHTML = ''; strip.dataset.folder = st.folder;
    for (const p of st.photos) strip.append(makeTile(p, true));
  }
  for (const t of strip.children) t.classList.toggle('active', t.dataset.id === st.active);
  const a = strip.querySelector('.active'); if (a) a.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
}
$('#strip').addEventListener('click', (e) => { const t = e.target.closest('.tile'); if (t && t.dataset.id !== st.active) { st.sel.clear(); st.sel.add(t.dataset.id); openEditor(t.dataset.id); } });
$('#prevBtn').onclick = () => step(-1);
$('#nextBtn').onclick = () => step(1);

// ---------- rendering ----------
let rq = 0, histT = 0;
function requestRender(withHist = true) {
  if (rq) return;
  rq = requestAnimationFrame(() => {
    rq = 0; draw();
    if (withHist) { clearTimeout(histT); histT = setTimeout(drawHist, 90); }
  });
}
const PAD = 18;
function viewFor() {
  const r = $('#stage').getBoundingClientRect(), d = DPR();
  const W = Math.max(2, Math.round(r.width * d)), H = Math.max(2, Math.round(r.height * d));
  return { W, H, d, r };
}
// Where the photo sits on screen, in CSS pixels, plus the engine view.
function layout(full) {
  const { W, H, d } = viewFor();
  const g = st.s.geom;
  const [fw, fh] = frameSize(engine.w, engine.h, g);
  const crop = full ? { w: 1, h: 1 } : g.crop;
  const ow = fw * crop.w, oh = fh * crop.h;
  const pad = (full ? 40 : PAD) * d;
  const fitScale = Math.min((W - 2 * pad) / ow, (H - 2 * pad) / oh);
  let scale = fitScale, cx = .5, cy = .5;
  if (st.zoom && !full) { scale = Math.max(fitScale, st.zoom.scale); cx = st.zoom.cx; cy = st.zoom.cy; }
  const pw = ow * scale / d, ph = oh * scale / d;
  return { view: { w: W, h: H, scale, cx, cy }, rect: { x: (W / d) / 2 - cx * pw, y: (H / d) / 2 - cy * ph, w: pw, h: ph }, fitScale, ow, oh };
}
function draw() {
  if (st.mode !== 'edit' || !st.loaded || !st.s) return;
  const L = layout(st.cropping);
  engine.render(st.s, L.view, { full: st.cropping, neutral: st.before, bg: [.047, .043, .063], clip: st.clip && !st.before });
  st.rect = L.rect;
  drawMaskOverlay();
  $('#baTag').hidden = !st.before;
  const zt = $('#zoomTag');
  zt.hidden = !st.zoom; if (st.zoom) zt.textContent = Math.round(L.view.scale * 100 / 1) + '%';
  $('#zoomBtn').textContent = st.zoom ? '100%' : 'Fit';
  $('#stage').classList.toggle('zoomed', !!st.zoom);
  if (st.cropping) placeCrop();
}
new ResizeObserver(() => { movePill(); requestRender(false); }).observe($('#stage'));
window.addEventListener('resize', movePill);

function drawHist() {
  if (!st.loaded || !st.s) return;
  const [w, h] = fit(...engine.outSize(st.s), 220);
  const px = engine.pixels(st.before ? { ...S.fresh(), geom: st.s.geom } : st.s, w, h, { noSharp: true });
  const R = new Float32Array(256), G = new Float32Array(256), B = new Float32Array(256);
  const Lh = new Float32Array(256);
  for (let i = 0; i < px.length; i += 4) { R[px[i]]++; G[px[i + 1]]++; B[px[i + 2]]++; Lh[Math.round(px[i] * .2126 + px[i + 1] * .7152 + px[i + 2] * .0722)]++; }
  st.lumHist = Lh; if (curveDrag == null) drawCurve();
  const c = $('#hist'), x = c.getContext('2d'), W = c.width, H = c.height;
  x.clearRect(0, 0, W, H);
  let mx = 1; for (let i = 2; i < 254; i++) mx = Math.max(mx, R[i], G[i], B[i]);
  x.globalCompositeOperation = 'lighter';
  for (const [arr, col] of [[R, 'rgba(255,84,84,.55)'], [G, 'rgba(84,214,110,.55)'], [B, 'rgba(84,140,255,.6)']]) {
    x.beginPath(); x.moveTo(0, H);
    for (let i = 0; i < 256; i++) x.lineTo(i / 255 * W, H - Math.min(1, Math.sqrt(arr[i] / mx)) * (H - 6));
    x.lineTo(W, H); x.closePath(); x.fillStyle = col; x.fill();
  }
  x.globalCompositeOperation = 'source-over';
}

// ---------- zoom + pan ----------
const stage = $('#stage');
let drag = null;
stage.addEventListener('pointerdown', (e) => {
  if (st.picking) { pickAt(e); return; }
  if (e.target.closest('#maskSvg [data-k]')) return;
  if (st.cropping || !st.loaded || e.button !== 0 || e.target.closest('.crop-layer')) return;
  drag = { x: e.clientX, y: e.clientY, moved: false, z: st.zoom && { ...st.zoom } };
  stage.setPointerCapture(e.pointerId);
});
stage.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
  if (st.zoom && drag.z && drag.moved) {
    stage.classList.add('dragging');
    const L = layout(false);
    st.zoom.cx = clampC(drag.z.cx - dx / L.rect.w, L.rect.w, $('#stage').clientWidth);
    st.zoom.cy = clampC(drag.z.cy - dy / L.rect.h, L.rect.h, $('#stage').clientHeight);
    requestRender(false);
  }
});
stage.addEventListener('pointerup', (e) => {
  stage.classList.remove('dragging');
  if (drag && !drag.moved) toggleZoom(e);
  drag = null;
});
function clampC(c, size, view) { if (size <= view) return .5; const m = view / 2 / size; return Math.min(1 - m, Math.max(m, c)); }
function toggleZoom(e) {
  if (!st.loaded) return;
  if (st.zoom) { st.zoom = null; requestRender(false); return; }
  const L = layout(false);
  let cx = .5, cy = .5;
  if (e && e.clientX != null) { const r = stage.getBoundingClientRect(); cx = (e.clientX - r.left - L.rect.x) / L.rect.w; cy = (e.clientY - r.top - L.rect.y) / L.rect.h; }
  const scale = 1; // one photo pixel per screen pixel
  const pw = L.ow * scale / DPR(), ph = L.oh * scale / DPR();
  st.zoom = { scale, cx: clampC(cx, pw, stage.clientWidth), cy: clampC(cy, ph, stage.clientHeight) };
  requestRender(false);
}
$('#zoomBtn').onclick = () => toggleZoom();

// before / after: hold the button or the \ key
const baOn = () => { if (!st.before) { st.before = true; $('#baBtn').classList.add('on'); requestRender(); } };
const baOff = () => { if (st.before) { st.before = false; $('#baBtn').classList.remove('on'); requestRender(); } };
$('#baBtn').addEventListener('pointerdown', baOn);
$('#baBtn').addEventListener('pointerup', baOff);
$('#baBtn').addEventListener('pointerleave', baOff);

// ---------- panel ----------
const sliders = new Map(); // key -> { input, val, def, conf }
function sliderEl(conf, get, set, def) {
  const min = conf.min ?? -1, max = conf.max ?? 1;
  const ev = conf.kind === 'ev';
  const k = ev ? 1 : 100;
  const wrap = document.createElement('div'); wrap.className = 'sl';
  wrap.innerHTML = `<label>${esc(conf.name)}</label><span class="v"></span><input type="range" min="${min * k}" max="${max * k}" step="${conf.step ?? 1}">`;
  const input = wrap.querySelector('input'), v = wrap.querySelector('.v');
  if (conf.track) { input.classList.add('custom'); input.style.setProperty('--track', conf.track); }
  const show = (val) => {
    input.value = val * k;
    v.textContent = conf.show ? conf.show(val) : (Math.round(val * 100) > 0 && min < 0 ? '+' : '') + Math.round(val * 100);
    const z = (0 - min) / (max - min) * 100, p = (val - min) / (max - min) * 100;
    input.style.setProperty('--fill-a', Math.min(z, p) + '%'); input.style.setProperty('--fill-b', Math.max(z, p) + '%');
    wrap.classList.toggle('changed', Math.abs(val - def) > 1e-6);
  };
  input.addEventListener('input', () => { const val = +input.value / k; set(val); show(val); if (!conf.keepLook) { st.s.look = null; markLook(); } requestRender(); });
  input.addEventListener('change', () => commit());
  const reset = () => { set(def); show(def); requestRender(); commit(); };
  wrap.querySelector('label').addEventListener('dblclick', reset);
  input.addEventListener('dblclick', reset);
  return { wrap, sync: () => show(get()) };
}
function buildPanel() {
  const box = $('#groups'); box.innerHTML = '';
  for (const g of S.GROUPS) {
    const sec = document.createElement('section'); sec.className = 'grp' + (g.closed ? ' closed' : ''); sec.dataset.grp = g.id;
    sec.innerHTML = `<h3><button class="grp-h">${g.name}</button></h3><div class="grp-b"></div>`;
    const body = sec.querySelector('.grp-b');
    if (g.id === 'light') {
      const auto = document.createElement('button'); auto.className = 'auto-btn'; auto.textContent = 'Auto'; auto.title = 'Balance the light automatically';
      auto.onclick = (e) => { e.stopPropagation(); runAuto(); };
      sec.querySelector('.grp-h').before(auto); sec.querySelector('h3').style.display = 'flex'; sec.querySelector('h3').style.alignItems = 'center';
      sec.querySelector('h3').prepend(sec.querySelector('.grp-h')); sec.querySelector('.grp-h').style.flex = '1';
    }
    if (g.id === 'colour') {
      const pick = document.createElement('button'); pick.className = 'auto-btn'; pick.id = 'wbPick'; pick.title = 'White balance: click something white or grey in the photo (W)';
      pick.innerHTML = '<svg viewBox="0 0 16 16" width="13" height="13" style="vertical-align:-2px"><path fill="currentColor" d="M13.6 2.4a2 2 0 0 0-2.8 0L9 4.2l-.7-.7-1 1 .7.7-5.3 5.3-.6 2.6-.6.6 1 1 .6-.6 2.6-.6L11 8.1l.7.7 1-1-.7-.7 1.8-1.8a2 2 0 0 0 0-2.8zM4.9 12.8l-1.3.3.3-1.3L9 6.7 9.9 7.6z"/></svg> Pick';
      pick.onclick = (e) => { e.stopPropagation(); startPick(); };
      const h3 = sec.querySelector('h3'); h3.style.display = 'flex'; h3.style.alignItems = 'center'; sec.querySelector('.grp-h').style.flex = '1'; h3.append(pick);
    }
    if (g.note) body.append(Object.assign(document.createElement('div'), { className: 'hint', textContent: g.note }));
    for (const c of g.sliders) {
      const el = sliderEl(c, () => st.s[c.key], (v) => { st.s[c.key] = v; }, S.DEFAULTS[c.key]);
      sliders.set(c.key, el); body.append(el.wrap);
    }
    if (g.id === 'colour') {
      const row = document.createElement('label'); row.className = 'sw-row';
      row.innerHTML = '<span>Black &amp; white</span><input type="checkbox" id="bwToggle">';
      row.querySelector('input').onchange = (e) => { st.s.bw = e.target.checked; st.s.look = null; markLook(); requestRender(); commit(); };
      body.append(row);
    }
    box.append(sec);
    if (g.id === 'light') box.append(buildCurve());
    if (g.id === 'detail') box.append(buildMasks());
  }
  buildMixer('h');
  buildGrade();
  buildStraighten();
  $$('.grp-h').forEach((h) => (h.onclick = () => h.closest('.grp').classList.toggle('closed')));
}
let mixerMode = 'h';
function buildMixer(m) {
  mixerMode = m;
  $$('#mixerSeg button').forEach((b) => b.classList.toggle('on', b.dataset.m === m));
  const box = $('#mixer'); box.innerHTML = '';
  S.HSL_BANDS.forEach((band, i) => {
    const prev = S.HSL_BANDS[(i + 7) % 8].col, next = S.HSL_BANDS[(i + 1) % 8].col;
    const track = m === 'h' ? `linear-gradient(90deg, ${prev}, ${band.col}, ${next})` : m === 's' ? `linear-gradient(90deg, #8a8a8a, ${band.col})` : `linear-gradient(90deg, #111, ${band.col}, #fff)`;
    const el = sliderEl({ name: band.name, track }, () => st.s.hsl[i][m], (v) => { st.s.hsl[i][m] = v; }, 0);
    sliders.set(`hsl${i}`, el); box.append(el.wrap);
  });
  syncPanel();
}
$$('#mixerSeg button').forEach((b) => (b.onclick = () => buildMixer(b.dataset.m)));
function buildGrade() {
  const box = $('#grade'); box.innerHTML = '';
  const rainbow = 'linear-gradient(90deg,#ff5a5a,#ffd84a,#5ad86a,#3ed6d6,#4a8dff,#9a6bff,#ff5ad2,#ff5a5a)';
  for (const [key, name] of [['gradeSh', 'Shadows'], ['gradeHi', 'Highlights']]) {
    const h = document.createElement('div'); h.className = 'sub-h'; h.textContent = name; box.append(h);
    const hue = sliderEl({ name: 'Hue', min: 0, max: 3.6, track: rainbow, show: (v) => Math.round(v * 100) + '°' }, () => st.s[key].h / 100, (v) => { st.s[key].h = v * 100; }, S.DEFAULTS[key].h / 100);
    const amt = sliderEl({ name: 'Amount', min: 0, max: 1 }, () => st.s[key].s, (v) => { st.s[key].s = v; }, 0);
    sliders.set(key + 'h', hue); sliders.set(key + 's', amt);
    box.append(hue.wrap, amt.wrap);
  }
}
function syncPanel() {
  if (!st.s) return;
  for (const el of sliders.values()) el.sync();
  const bw = $('#bwToggle'); if (bw) bw.checked = !!st.s.bw;
  drawCurve(); renderMaskList();
  markLook();
  $('#undoBtn').disabled = st.hi <= 0; $('#redoBtn').disabled = st.hi >= st.hist.length - 1;
}

// ---------- history + saving ----------
function commit(skipSave) {
  if (!st.s) return;
  const snap = S.clone(st.s);
  const last = st.hist[st.hi];
  if (last && JSON.stringify(last) === JSON.stringify(snap)) return;
  st.hist = st.hist.slice(0, st.hi + 1); st.hist.push(snap);
  if (st.hist.length > 150) st.hist.shift();
  st.hi = st.hist.length - 1;
  syncPanel();
  if (!skipSave) scheduleSave();
}
function undo() { if (st.hi > 0) { st.hi--; st.s = S.clone(st.hist[st.hi]); afterJump(); } }
function redo() { if (st.hi < st.hist.length - 1) { st.hi++; st.s = S.clone(st.hist[st.hi]); afterJump(); } }
function afterJump() { syncPanel(); requestRender(); scheduleSave(); showMeta(st.byId.get(st.active)); }
$('#undoBtn').onclick = undo; $('#redoBtn').onclick = redo;
$('#resetBtn').onclick = () => { st.s = S.fresh(); commit(); syncPanel(); requestRender(); renderLooks(); showMeta(st.byId.get(st.active)); };

let saveT = 0, pending = null;
function scheduleSave() {
  pending = { id: st.active, s: S.clone(st.s) };
  clearTimeout(saveT); saveT = setTimeout(flushSave, 600);
}
async function flushSave() {
  clearTimeout(saveT);
  const job = pending; pending = null;
  if (!job || !st.loaded) return;
  const p = st.byId.get(job.id); if (!p) return;
  const isDef = S.isDefault(job.s);
  let thumb = null;
  if (!isDef && job.id === st.active) {
    const [w, h] = fit(...engine.outSize(job.s), 480);
    thumb = await jpeg(engine.pixels(job.s, w, h), w, h);
  }
  await api.saveEdit(job.id, isDef ? null : job.s, thumb);
  p.edited = !isDef; refreshTile(p);
}
window.addEventListener('beforeunload', () => { flushSave(); });

// ---------- looks ----------
function markLook() { $$('#looks .look').forEach((b) => b.classList.toggle('on', !!st.s && b.dataset.id === st.s.look)); const mb = $('#matchBar'); if (mb) mb.hidden = !(st.s && st.s.look === 'match' && st.match && st.match.id === st.active); }
function renderLooks() {
  const box = $('#looks'); box.innerHTML = '';
  if (!st.s) return;
  const list = [...S.LOOKS, ...(st.prefs.presets || [])];
  for (const l of list) {
    const b = document.createElement('button'); b.className = 'look'; b.dataset.id = l.id;
    const c = document.createElement('canvas'); b.append(c);
    b.append(Object.assign(document.createElement('span'), { textContent: l.name }));
    if (l.user) { const d = document.createElement('i'); d.className = 'del'; d.textContent = '×'; d.title = 'Delete this look'; d.onclick = (e) => { e.stopPropagation(); deleteLook(l.id); }; b.append(d); }
    b.onclick = () => chooseLook(l);
    box.append(b);
  }
  markLook();
  if (!st.loaded) return;
  // Little previews of each look on this photo.
  const tiles = $$('#looks .look');
  let i = 0;
  const geom = st.s.geom;
  const next = () => {
    if (i >= list.length || !st.loaded) return;
    const l = list[i], canvas = tiles[i].querySelector('canvas'); i++;
    const s = l.auto ? autoFor() : { ...S.applyLook({ geom }, l) };
    const [w, h] = fit(...engine.outSize(s), 150);
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').putImageData(new ImageData(engine.pixels(s, w, h, { noSharp: true }), w, h), 0, 0);
    canvas.style.objectFit = 'cover';
    requestAnimationFrame(next);
  };
  requestAnimationFrame(next);
}
function autoFor() {
  const key = st.active + ':' + JSON.stringify(st.s.geom);
  if (!st.autoCache.has(key)) st.autoCache.set(key, autoSettings(engine, { ...S.fresh(), geom: st.s.geom }));
  return { ...S.clone(st.autoCache.get(key)), geom: S.clone(st.s.geom) };
}
function chooseLook(l) {
  st.s = l.auto ? { ...autoFor(), look: 'auto' } : S.applyLook(st.s, l);
  commit(); syncPanel(); requestRender();
}
function runAuto() {
  const a = autoSettings(engine, st.s);
  st.s = a; commit(); syncPanel(); requestRender();
}
// Auto: measures the photo and sets the light sliders so it spans the full range with
// middle tones in the middle. Plain arithmetic on the histogram.
function autoSettings(eng, cur) {
  const s = S.complete(cur);
  Object.assign(s, { exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0 });
  const [w, h] = fit(...eng.outSize(s), 160);
  const measure = () => {
    const px = eng.pixels(s, w, h, { noSharp: true }); const hist = new Uint32Array(256); let n = 0;
    for (let i = 0; i < px.length; i += 4) { hist[Math.round(px[i] * .2126 + px[i + 1] * .7152 + px[i + 2] * .0722)]++; n++; }
    const pct = (q) => { let a = 0; for (let i = 0; i < 256; i++) { a += hist[i]; if (a >= n * q) return i / 255; } return 1; };
    return { lo: pct(.005), med: pct(.5), hi: pct(.995), clip: hist[255] / n };
  };
  let m = measure();
  let lo = -2, hi = 2;
  for (let i = 0; i < 8; i++) { s.exposure = (lo + hi) / 2; m = measure(); if (m.med < .45) lo = s.exposure; else hi = s.exposure; }
  s.exposure = Math.round(((lo + hi) / 2) * .8 * 20) / 20; // don't go all the way: keep some of the photo's own mood
  m = measure();
  if (m.clip > .01 || m.hi > .985) s.highlights = -Math.min(.6, .2 + m.clip * 6);
  if (m.hi < .93) s.whites = Math.min(.6, (.96 - m.hi) * 3);
  if (m.lo > .04) s.blacks = -Math.min(.6, m.lo * 3.5);
  if (m.med < .32) s.shadows = Math.min(.5, (.42 - m.med) * 2.5);
  s.vibrance = Math.max(s.vibrance, .12);
  s.look = 'auto';
  for (const k of ['highlights', 'whites', 'blacks', 'shadows']) s[k] = Math.round(s[k] * 100) / 100;
  return s;
}
// Saving your own looks
$('#saveLook').onclick = () => {
  const btn = $('#saveLook');
  const input = document.createElement('input');
  input.className = 'save-look'; input.placeholder = 'Name this look, then press Enter'; input.maxLength = 40;
  btn.replaceWith(input); input.focus();
  const done = async (ok) => {
    input.replaceWith(btn);
    if (!ok || !input.value.trim()) return;
    const s = S.clone(st.s); delete s.geom; delete s.look;
    const look = { id: 'u' + Date.now(), name: input.value.trim(), s, user: true };
    st.prefs.presets = [...(st.prefs.presets || []), look];
    await api.setSettings({ presets: st.prefs.presets });
    st.s.look = look.id; renderLooks(); commit();
    toast(`Saved “${look.name}”. It's in Looks, and in Apply look in the Library.`);
  };
  input.onkeydown = (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); e.stopPropagation(); };
  input.onblur = () => done(true);
};
async function deleteLook(id) {
  const l = (st.prefs.presets || []).find((x) => x.id === id);
  st.prefs.presets = (st.prefs.presets || []).filter((x) => x.id !== id);
  await api.setSettings({ presets: st.prefs.presets });
  renderLooks();
  toast(`Deleted “${l ? l.name : 'look'}”`, 'Undo', async () => { st.prefs.presets = [...st.prefs.presets, l]; await api.setSettings({ presets: st.prefs.presets }); renderLooks(); });
}

// ---------- crop ----------
const ASPECTS = [['free', 'Free'], ['orig', 'Original'], ['1:1', '1:1'], ['4:5', '4:5'], ['3:2', '3:2'], ['16:9', '16:9'], ['5:4', '5:4'], ['9:16', '9:16']];
let straightenEl;
function buildStraighten() {
  const box = $('#aspects'); box.innerHTML = '';
  for (const [id, name] of ASPECTS) {
    const b = document.createElement('button'); b.dataset.a = id; b.textContent = name;
    b.onclick = () => setAspect(id);
    box.append(b);
  }
  straightenEl = sliderEl({ name: 'Straighten', min: -.45, max: .45, step: .1, show: (v) => (v * 100).toFixed(1) + '°' }, () => st.s.geom.angle / 100, (v) => { st.s.geom.angle = v * 100; }, 0);
  $('#straighten').innerHTML = ''; $('#straighten').append(straightenEl.wrap);
  sliders.set('angle', straightenEl);
}
function ratioOf(a) {
  const [fw, fh] = frameSize(engine.w, engine.h, st.s.geom);
  if (a === 'orig') return fw / fh;
  if (a === 'free') return null;
  const [x, y] = a.split(':').map(Number); return x / y;
}
function setAspect(a, keepCentre = true) {
  const g = st.s.geom; g.aspect = a;
  const r = ratioOf(a);
  if (r) {
    const [fw, fh] = frameSize(engine.w, engine.h, g);
    const c = g.crop, cx = c.x + c.w / 2, cy = c.y + c.h / 2;
    // Largest rectangle with this shape that fits in the frame, centred where the crop was.
    let w = 1, h = (fw / r) / fh;
    if (h > 1) { h = 1; w = (fh * r) / fw; }
    const k = keepCentre ? Math.min(1, Math.max(c.w / w, c.h / h)) : 1;
    w *= k; h *= k;
    g.crop = { x: Math.min(1 - w, Math.max(0, cx - w / 2)), y: Math.min(1 - h, Math.max(0, cy - h / 2)), w, h };
  }
  $$('#aspects button').forEach((b) => b.classList.toggle('on', b.dataset.a === a));
  requestRender(false);
}
function enterCrop() {
  if (!st.loaded || st.cropping) return;
  st.cropping = true; st.zoom = null; st.cropStart = S.clone(st.s.geom);
  $('#cropLayer').hidden = false; $('#cropGrp').hidden = false; $('#cropBtn').classList.add('on');
  $$('#aspects button').forEach((b) => b.classList.toggle('on', b.dataset.a === (st.s.geom.aspect || 'free')));
  $('#cropGrp').scrollIntoView({ block: 'nearest' });
  $('#panelScroll').scrollTop = $('#panelScroll').scrollHeight;
  requestRender(false);
}
function exitCrop(apply = true) {
  if (!st.cropping) return;
  st.cropping = false;
  $('#cropLayer').hidden = true; $('#cropGrp').hidden = true; $('#cropBtn').classList.remove('on');
  if (apply) { commit(); renderLooks(); showMeta(st.byId.get(st.active)); }
  requestRender();
}
$('#cropBtn').onclick = () => (st.cropping ? exitCrop(true) : enterCrop());
$('#cropDone').onclick = () => exitCrop(true);
$('#cropReset').onclick = () => { st.s.geom = { ...S.fresh().geom }; syncPanel(); setAspect('free'); };
$('#rotL').onclick = () => turn(3);
$('#rotR').onclick = () => turn(1);
$('#flipH').onclick = () => { st.s.geom.flipH = !st.s.geom.flipH; const c = st.s.geom.crop; c.x = 1 - c.x - c.w; requestRender(false); };
function turn(d) {
  const g = st.s.geom; g.rot90 = (g.rot90 + d) % 4;
  g.crop = { x: 0, y: 0, w: 1, h: 1 };
  if (g.aspect && g.aspect !== 'free' && g.aspect !== 'orig') { const [a, b] = g.aspect.split(':'); g.aspect = `${b}:${a}`; }
  setAspect(g.aspect || 'free', false);
}
function placeCrop() {
  const r = st.rect, c = st.s.geom.crop, box = $('#cropBox');
  box.style.left = r.x + c.x * r.w + 'px'; box.style.top = r.y + c.y * r.h + 'px';
  box.style.width = c.w * r.w + 'px'; box.style.height = c.h * r.h + 'px';
}
let cd = null;
$('#cropBox').addEventListener('pointerdown', (e) => {
  e.preventDefault(); e.stopPropagation();
  cd = { h: e.target.dataset.h || 'move', x: e.clientX, y: e.clientY, c: { ...st.s.geom.crop } };
  e.currentTarget.setPointerCapture(e.pointerId);
});
$('#cropBox').addEventListener('pointermove', (e) => {
  if (!cd) return;
  const r = st.rect, dx = (e.clientX - cd.x) / r.w, dy = (e.clientY - cd.y) / r.h;
  const o = cd.c; let { x, y, w, h } = o; const MIN = .04;
  if (cd.h === 'move') { x = Math.min(1 - w, Math.max(0, o.x + dx)); y = Math.min(1 - h, Math.max(0, o.y + dy)); }
  else {
    let l = o.x, t = o.y, rt = o.x + o.w, b = o.y + o.h;
    if (cd.h.includes('w')) l = Math.min(rt - MIN, Math.max(0, o.x + dx));
    if (cd.h.includes('e')) rt = Math.max(l + MIN, Math.min(1, o.x + o.w + dx));
    if (cd.h.includes('n')) t = Math.min(b - MIN, Math.max(0, o.y + dy));
    if (cd.h.includes('s')) b = Math.max(t + MIN, Math.min(1, o.y + o.h + dy));
    const ratio = ratioOf(st.s.geom.aspect || 'free');
    if (ratio) {
      const [fw, fh] = frameSize(engine.w, engine.h, st.s.geom);
      const rr = ratio * fh / fw; // w/h in crop units
      let nw = rt - l, nh = b - t;
      if (cd.h === 'n' || cd.h === 's') nw = nh * rr; else if (cd.h === 'e' || cd.h === 'w') nh = nw / rr; else if (nw / nh > rr) nh = nw / rr; else nw = nh * rr;
      // Keep it inside the frame.
      const ax = cd.h.includes('w') ? o.x + o.w : cd.h.includes('e') ? o.x : o.x + o.w / 2;
      const ay = cd.h.includes('n') ? o.y + o.h : cd.h.includes('s') ? o.y : o.y + o.h / 2;
      const maxW = cd.h.includes('w') ? ax : cd.h.includes('e') ? 1 - ax : 2 * Math.min(ax, 1 - ax);
      const maxH = cd.h.includes('n') ? ay : cd.h.includes('s') ? 1 - ay : 2 * Math.min(ay, 1 - ay);
      const k = Math.min(1, maxW / nw, maxH / nh); nw *= k; nh *= k;
      l = cd.h.includes('w') ? ax - nw : cd.h.includes('e') ? ax : ax - nw / 2;
      t = cd.h.includes('n') ? ay - nh : cd.h.includes('s') ? ay : ay - nh / 2;
      rt = l + nw; b = t + nh;
    }
    x = l; y = t; w = rt - l; h = b - t;
  }
  st.s.geom.crop = { x, y, w, h };
  placeCrop();
});
$('#cropBox').addEventListener('pointerup', () => { cd = null; });

// ---------- export ----------
const ex = { format: 'jpg', quality: 92, size: 0, where: ':beside', dir: null, exif: true };
function exportIds() {
  if (st.mode === 'edit') return st.active ? [st.active] : [];
  return st.sel.size ? st.photos.filter((p) => st.sel.has(p.id)).map((p) => p.id) : st.photos.map((p) => p.id);
}
function openExport() {
  const ids = exportIds(); if (!ids.length) return;
  flushSave();
  Object.assign(ex, st.prefs.export || {});
  $('#exSub').textContent = ids.length === 1 ? `1 photo: ${st.byId.get(ids[0]).name}` : `${ids.length} photos`;
  $('#exGo').textContent = ids.length === 1 ? 'Export' : `Export ${ids.length}`;
  const seg = (id, v) => $$(`#${id} button`).forEach((b) => b.classList.toggle('on', b.dataset.v === String(v)));
  seg('exFormat', ex.format); seg('exSize', ex.size); seg('exWhere', ex.where === ':beside' ? ':beside' : 'pick');
  $('#exQuality').value = ex.quality; $('#exQualityV').textContent = ex.quality;
  $('#exQualityRow').hidden = ex.format === 'png';
  $('#exExif').checked = ex.exif !== false; $('#exExifRow').hidden = ex.format !== 'jpg';
  $('#exWhereNote').textContent = ex.where === ':beside' ? 'In a new “Lightshaper edits” folder' : ex.dir || '';
  $('#exProgress').hidden = true; $('#exGo').disabled = false;
  $('#exportSheet').hidden = false;
}
$('#exportBtn').onclick = openExport;
for (const id of ['exFormat', 'exSize']) {
  $$(`#${id} button`).forEach((b) => (b.onclick = () => {
    $$(`#${id} button`).forEach((x) => x.classList.toggle('on', x === b));
    if (id === 'exFormat') { ex.format = b.dataset.v; $('#exQualityRow').hidden = ex.format === 'png'; $('#exExifRow').hidden = ex.format !== 'jpg'; } else ex.size = +b.dataset.v;
  }));
}
$$('#exWhere button').forEach((b) => (b.onclick = async () => {
  if (b.dataset.v === 'pick') {
    const d = await api.pickExportFolder(); if (!d) return;
    ex.where = 'pick'; ex.dir = d;
  } else ex.where = ':beside';
  $$('#exWhere button').forEach((x) => x.classList.toggle('on', x === b));
  $('#exWhereNote').textContent = ex.where === ':beside' ? 'In a new “Lightshaper edits” folder' : ex.dir;
}));
$('#exExif').onchange = (e) => { ex.exif = e.target.checked; };
$('#exQuality').oninput = (e) => { ex.quality = +e.target.value; $('#exQualityV').textContent = ex.quality; };
let exporting = false;
$('#exCancel').onclick = () => { if (exporting) exporting = 'stop'; else $('#exportSheet').hidden = true; };
$('#exGo').onclick = async () => {
  const ids = exportIds(); if (!ids.length || exporting) return;
  api.setSettings({ export: { ...ex } }); st.prefs.export = { ...ex };
  exporting = true; $('#exGo').disabled = true; $('#exProgress').hidden = false;
  const bar = $('#exProgress i'); bar.style.width = '2%';
  const dir = ex.where === ':beside' ? ':beside' : ex.dir;
  let done = 0, last = null; const fails = [];
  await flushSave();
  for (const id of ids) {
    if (exporting === 'stop') break;
    const p = st.byId.get(id);
    try {
      const s = S.complete(id === st.active && st.s ? st.s : await api.getEdit(id));
      const src = await decode(p);
      worker.load(src); if (src.ref) { worker.calibrate(src.ref); src.ref.close(); } if (src.bitmap) src.bitmap.close();
      const img = await worker.exportImage(s, ex.size);
      const c = new OffscreenCanvas(img.width, img.height); c.getContext('2d').putImageData(img, 0, 0);
      const type = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[ex.format];
      const blob = await c.convertToBlob({ type, quality: ex.quality / 100 });
      let bytes = await blob.arrayBuffer();
      if (ex.format === 'jpg' && ex.exif !== false) { try { bytes = insertExif(bytes, buildExif((src.meta && src.meta.exif) || {})); } catch { /* write without it */ } }
      const r = await api.exportWrite(id, dir, ex.format, bytes);
      if (!r.ok) throw new Error(r.error);
      last = r.path;
    } catch (err) { fails.push(p.name); console.error(err); }
    done++; bar.style.width = Math.round(done / ids.length * 100) + '%';
  }
  const stopped = exporting === 'stop';
  exporting = false;
  $('#exportSheet').hidden = true;
  const ok = done - fails.length;
  if (fails.length) toast(`Exported ${ok} of ${ids.length}. Couldn't export: ${fails.slice(0, 3).join(', ')}${fails.length > 3 ? '…' : ''}`, last ? 'Show' : null, () => api.showExport(last), 8000);
  else toast(`${stopped ? 'Stopped. ' : ''}Exported ${ok} photo${ok === 1 ? '' : 's'}`, last ? 'Show' : null, () => api.showExport(last), 7000);
};

// ---------- settings + updates ----------
$('#gear').onclick = async () => {
  const s = await api.settings();
  $('#versionLine').textContent = `Version ${s.version}`;
  $('#autoUpdate').checked = s.autoUpdate !== false;
  $('#settingsSheet').hidden = false;
};
$('#autoUpdate').onchange = (e) => api.setSettings({ autoUpdate: e.target.checked });
$('#settingsDone').onclick = () => ($('#settingsSheet').hidden = true);
$('#checkNow').onclick = async () => {
  const r = await api.checkUpdates();
  if (r.state === 'latest') toast(`You have the latest version (${r.version}).`);
  else if (r.state === 'error') toast("Couldn't reach GitHub. Try again later.");
};
api.onUpdate((u) => {
  const bar = $('#updateBar');
  bar.innerHTML = `<span>Lightshaper ${esc(u.version)} is out.</span><button class="primary sm">Download</button><button class="ghost sm">Later</button>`;
  bar.querySelector('.primary').onclick = () => { api.openUpdate(u.url); bar.hidden = true; };
  bar.querySelector('.ghost').onclick = () => { api.setSettings({ skipVersion: u.version }); bar.hidden = true; };
  bar.hidden = false;
});
for (const id of ['exportSheet', 'settingsSheet', 'matchSheet']) $('#' + id).addEventListener('pointerdown', (e) => { if (e.target.id === id && !exporting) e.target.hidden = true; });

// ---------- drag and drop ----------
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('#dropping').hidden = false; });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropping').hidden = true; } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault(); dragDepth = 0; $('#dropping').hidden = true;
  const presetFiles = [...e.dataTransfer.files].filter((x) => /\.(xmp|lrtemplate)$/i.test(x.name));
  if (presetFiles.length) { importPresets(await api.readPresets(presetFiles.map((x) => api.pathOf(x)))); return; }
  const f = e.dataTransfer.files[0]; if (!f) return;
  const p = api.pathOf(f); if (!p) return;
  const name = f.name;
  await addFolder(p);
  const hit = st.photos.find((x) => x.name === name);
  if (hit) { st.sel.clear(); st.sel.add(hit.id); updateSel(); openEditor(hit.id); }
});

// ---------- keyboard ----------
window.addEventListener('keydown', (e) => {
  if (e.target.matches('input[type=text], input:not([type]), textarea')) return;
  if (!$('#exportSheet').hidden || !$('#settingsSheet').hidden) { if (e.key === 'Escape') { $('#settingsSheet').hidden = true; if (!exporting) $('#exportSheet').hidden = true; } return; }
  const mod = e.metaKey || e.ctrlKey;
  if (st.mode === 'edit') {
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (mod && e.key.toLowerCase() === 'c' && !window.getSelection().toString()) { e.preventDefault(); copyEdits(st.active); return; }
    if (mod && e.key.toLowerCase() === 'v' && st.clip) { e.preventDefault(); pasteTo([st.active]); return; }
    if (e.target.matches('input[type=range]') && e.key.startsWith('Arrow')) return;
    if (e.key === 'ArrowRight') { step(1); return; }
    if (e.key === 'ArrowLeft') { step(-1); return; }
    if (e.key === '\\' && !e.repeat) { baOn(); return; }
    if (e.key === 'z' || e.key === 'Z') { toggleZoom(); return; }
    if (e.key === 'j' || e.key === 'J') { toggleClip(); return; }
    if (e.key === 'w' || e.key === 'W') { startPick(); return; }
    if (/^[0-5]$/.test(e.key) && !mod) { rate([st.active], +e.key); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && st.maskSel) { deleteMask(st.maskSel); return; }
    if (e.key === 'c' || e.key === 'C') { st.cropping ? exitCrop(true) : enterCrop(); return; }
    if (e.key === 'Enter' && st.cropping) { exitCrop(true); return; }
    if (e.key === 'Escape' && st.picking) { stopPick(); return; }
    if (e.key === 'Escape') { if (st.cropping) { st.s.geom = st.cropStart; exitCrop(false); } else setMode('library'); return; }
    if (e.key === 'g' || e.key === 'G') { setMode('library'); return; }
  } else {
    if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); st.photos.forEach((p) => st.sel.add(p.id)); updateSel(); return; }
    if (mod && e.key.toLowerCase() === 'c' && st.sel.size === 1) { e.preventDefault(); copyEdits([...st.sel][0]); return; }
    if (mod && e.key.toLowerCase() === 'v' && st.clip && st.sel.size) { e.preventDefault(); pasteTo([...st.sel]); return; }
    if ((e.key === 'Enter' || e.key === 'e' || e.key === 'E') && st.sel.size) { openEditor([...st.sel].pop()); return; }
    if (e.key === 'Escape') { st.sel.clear(); updateSel(); return; }
    if (/^[0-5]$/.test(e.key) && !mod && st.sel.size) { rate([...st.sel], +e.key); return; }
    if (e.key.startsWith('Arrow') && st.photos.length) {
      const ids = shown().map((p) => p.id);
      const cur = st.anchor ? ids.indexOf(st.anchor) : -1;
      const cols = Math.max(1, Math.round($('#grid').clientWidth / (($('#grid .tile') || {}).offsetWidth + 10 || 200)));
      const d = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key];
      const n = Math.min(ids.length - 1, Math.max(0, cur + d));
      st.sel.clear(); st.sel.add(ids[n]); st.anchor = ids[n]; updateSel();
      $(`#grid .tile[data-id="${ids[n]}"]`)?.scrollIntoView({ block: 'nearest' });
      e.preventDefault();
    }
  }
});
window.addEventListener('keyup', (e) => { if (e.key === '\\') baOff(); });

// ---------- tone curve ----------
let curveCh = 'm', curveDrag = null;
function buildCurve() {
  const sec = document.createElement('section'); sec.className = 'grp closed'; sec.dataset.grp = 'curve';
  sec.innerHTML = `<h3><button class="grp-h">Tone curve</button></h3><div class="grp-b">
    <div class="mini-seg" id="curveSeg"><button data-c="m" class="on">RGB</button><button data-c="r">Red</button><button data-c="g">Green</button><button data-c="b">Blue</button></div>
    <div class="curve-box"><canvas id="curveCv" width="540" height="540"></canvas></div>
    <div class="hint">Click to add a point, drag to shape. Double-click a point to remove it.</div></div>`;
  sec.querySelectorAll('#curveSeg button').forEach((b) => (b.onclick = () => { curveCh = b.dataset.c; sec.querySelectorAll('#curveSeg button').forEach((x) => x.classList.toggle('on', x === b)); drawCurve(); }));
  const cv = sec.querySelector('canvas');
  const pos = (e) => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, 1 - (e.clientY - r.top) / r.height, r]; };
  const near = (pts, x, y, r) => pts.findIndex((p) => Math.hypot((p[0] - x) * r.width, (p[1] - y) * r.height) < 12);
  cv.addEventListener('pointerdown', (e) => {
    if (!st.s) return;
    const [x, y, r] = pos(e); const pts = st.s.curve[curveCh];
    let i = near(pts, x, y, r);
    if (i < 0) {
      if (pts.length >= 14) return;
      pts.push([Math.min(.99, Math.max(.01, x)), Math.min(1, Math.max(0, y))]); pts.sort((a, b) => a[0] - b[0]);
      i = pts.findIndex((p) => p[0] === Math.min(.99, Math.max(.01, x)));
    }
    curveDrag = i; cv.setPointerCapture(e.pointerId); st.s.look = null; drawCurve(); requestRender();
  });
  cv.addEventListener('pointermove', (e) => {
    if (curveDrag == null) return;
    const [x, y] = pos(e); const pts = st.s.curve[curveCh]; const i = curveDrag;
    const end = i === 0 || i === pts.length - 1;
    const lo = end ? pts[i][0] : pts[i - 1][0] + .01, hi = end ? pts[i][0] : pts[i + 1][0] - .01;
    pts[i] = [i === 0 ? Math.max(0, Math.min(pts[1][0] - .01, x)) : i === pts.length - 1 ? Math.min(1, Math.max(pts[i - 1][0] + .01, x)) : Math.min(hi, Math.max(lo, x)), Math.min(1, Math.max(0, y))];
    drawCurve(); requestRender();
  });
  cv.addEventListener('pointerup', () => { if (curveDrag != null) { curveDrag = null; commit(); } });
  cv.addEventListener('dblclick', (e) => {
    const [x, y, r] = pos(e); const pts = st.s.curve[curveCh]; const i = near(pts, x, y, r);
    if (i > 0 && i < pts.length - 1) { pts.splice(i, 1); drawCurve(); requestRender(); commit(); }
    else if (i < 0) { st.s.curve[curveCh] = [[0, 0], [1, 1]]; drawCurve(); requestRender(); commit(); }
  });
  return sec;
}
function drawCurve() {
  const cv = $('#curveCv'); if (!cv || !st.s) return;
  const x = cv.getContext('2d'), W = cv.width, H = cv.height;
  x.clearRect(0, 0, W, H);
  x.fillStyle = 'rgba(0,0,0,.25)'; x.fillRect(0, 0, W, H);
  if (st.lumHist) {
    let mx = 1; for (let i = 3; i < 253; i++) mx = Math.max(mx, st.lumHist[i]);
    x.beginPath(); x.moveTo(0, H);
    for (let i = 0; i < 256; i++) x.lineTo(i / 255 * W, H - Math.min(1, Math.sqrt(st.lumHist[i] / mx)) * H * .5);
    x.lineTo(W, H); x.fillStyle = 'rgba(255,255,255,.06)'; x.fill();
  }
  x.strokeStyle = 'rgba(255,255,255,.08)'; x.lineWidth = 1.5;
  for (let k = 1; k < 4; k++) { x.beginPath(); x.moveTo(k * W / 4, 0); x.lineTo(k * W / 4, H); x.moveTo(0, k * H / 4); x.lineTo(W, k * H / 4); x.stroke(); }
  x.beginPath(); x.moveTo(0, H); x.lineTo(W, 0); x.strokeStyle = 'rgba(255,255,255,.12)'; x.stroke();
  const col = { m: '#f3f2f8', r: '#ff6b6b', g: '#5ad86a', b: '#5b8cff' }[curveCh];
  for (const k of ['r', 'g', 'b', 'm']) {
    if (k === curveCh) continue;
    const c = st.s.curve[k]; if (c.length === 2 && c[0][1] === 0 && c[1][1] === 1 && c[0][0] === 0 && c[1][0] === 1) continue;
    const lut = curveLUT(c); x.beginPath();
    for (let i = 0; i < 256; i++) x.lineTo(i / 255 * W, H - lut[i] * H);
    x.strokeStyle = { m: 'rgba(255,255,255,.25)', r: 'rgba(255,107,107,.35)', g: 'rgba(90,216,106,.35)', b: 'rgba(91,140,255,.35)' }[k]; x.lineWidth = 2; x.stroke();
  }
  const pts = st.s.curve[curveCh], lut = curveLUT(pts);
  x.beginPath(); for (let i = 0; i < 256; i++) x.lineTo(i / 255 * W, H - lut[i] * H);
  x.strokeStyle = col; x.lineWidth = 3; x.stroke();
  for (const p of pts) { x.beginPath(); x.arc(p[0] * W, H - p[1] * H, 9, 0, 7); x.fillStyle = col; x.fill(); x.lineWidth = 3; x.strokeStyle = '#111017'; x.stroke(); }
}

// ---------- masks ----------
function buildMasks() {
  const sec = document.createElement('section'); sec.className = 'grp closed'; sec.dataset.grp = 'masks';
  sec.innerHTML = `<h3><button class="grp-h">Masks <span class="count-pill" id="maskCount"></span></button></h3><div class="grp-b">
    <div class="hint">Change just part of the photo: darken a sky, brighten a face.</div>
    <div class="mask-add"><button class="ghost sm" id="addGrad">＋ Gradient</button><button class="ghost sm" id="addRadial">＋ Radial</button></div>
    <div id="maskList" class="mask-list"></div><div id="maskEdit"></div></div>`;
  sec.querySelector('#addGrad').onclick = () => addMask('grad');
  sec.querySelector('#addRadial').onclick = () => addMask('radial');
  sec.querySelector('.grp-h').addEventListener('click', () => setTimeout(() => requestRender(false), 0));
  return sec;
}
function addMask(type) {
  const m = S.newMask(type);
  st.s.masks.push(m); st.maskSel = m.id; st.s.look = null;
  renderMaskList(); requestRender(); commit();
}
function deleteMask(id) {
  st.s.masks = st.s.masks.filter((m) => m.id !== id);
  if (st.maskSel === id) st.maskSel = null;
  renderMaskList(); requestRender(); commit();
}
function masksOpen() { const g = document.querySelector('.grp[data-grp="masks"]'); return g && !g.classList.contains('closed'); }
function renderMaskList() {
  const list = $('#maskList'); if (!list || !st.s) return;
  const ms = st.s.masks || [];
  $('#maskCount').textContent = ms.length || '';
  if (!ms.find((m) => m.id === st.maskSel)) st.maskSel = ms.length ? ms[ms.length - 1].id : null;
  list.innerHTML = '';
  let n = { grad: 0, radial: 0 };
  for (const m of ms) {
    n[m.type]++;
    const row = document.createElement('div'); row.className = 'mask-row' + (m.id === st.maskSel ? ' on' : '') + (m.on === false ? ' off' : '');
    row.innerHTML = `<span class="mi ${m.type}"></span><span class="mn">${m.type === 'grad' ? 'Gradient' : 'Radial'} ${n[m.type]}</span><button class="eye" title="Show or hide">${m.on === false ? '○' : '●'}</button><button class="mdel" title="Delete (⌫)">×</button>`;
    row.onclick = (e) => {
      if (e.target.classList.contains('eye')) { m.on = m.on === false; renderMaskList(); requestRender(); commit(); return; }
      if (e.target.classList.contains('mdel')) { deleteMask(m.id); return; }
      st.maskSel = m.id; renderMaskList(); requestRender(false);
    };
    list.append(row);
  }
  const ed = $('#maskEdit'); ed.innerHTML = '';
  const m = ms.find((x) => x.id === st.maskSel);
  if (!m) return;
  m.adj = m.adj || {};
  for (const c of S.MASK_SLIDERS) {
    const el = sliderEl(c, () => m.adj[c.key] || 0, (v) => { m.adj[c.key] = v; }, 0);
    el.sync(); ed.append(el.wrap);
  }
  if (m.type === 'radial') { const f = sliderEl({ name: 'Feather', min: 0, max: 1 }, () => m.feather ?? .5, (v) => { m.feather = v; }, .5); f.sync(); ed.append(f.wrap); }
  const inv = document.createElement('label'); inv.className = 'sw-row';
  inv.innerHTML = `<span>${m.type === 'grad' ? 'Flip direction' : 'Affect the outside instead'}</span><input type="checkbox" ${m.invert ? 'checked' : ''}>`;
  inv.querySelector('input').onchange = (e) => { m.invert = e.target.checked; requestRender(); commit(); };
  ed.append(inv);
}
const SVGNS = 'http://www.w3.org/2000/svg';
function drawMaskOverlay() {
  let svg = $('#maskSvg');
  if (!svg) { svg = document.createElementNS(SVGNS, 'svg'); svg.id = 'maskSvg'; $('#stage').append(svg); hookMaskDrag(svg); }
  const m = st.s && (st.s.masks || []).find((x) => x.id === st.maskSel);
  const show = m && masksOpen() && !st.cropping && !st.before && st.loaded;
  svg.style.display = show ? '' : 'none';
  if (!show) return;
  const r = st.rect, g = st.s.geom, c = g.crop;
  const [fw, fh] = frameSize(engine.w, engine.h, g);
  const toS = (u, v) => [r.x + (u - c.x) / c.w * r.w, r.y + (v - c.y) / c.h * r.h];
  const pxPerFrame = r.w / (c.w * fw); // screen px per frame px
  let h = '';
  if (m.type === 'grad') {
    const [ax, ay] = toS(m.x0, m.y0), [bx, by] = toS(m.x1, m.y1);
    let dx = bx - ax, dy = by - ay; const L = Math.hypot(dx, dy) || 1; const nx = -dy / L * 3000, ny = dx / L * 3000;
    const line = (x, y, op, dash) => `<line x1="${x - nx}" y1="${y - ny}" x2="${x + nx}" y2="${y + ny}" stroke="white" stroke-opacity="${op}" stroke-width="1.5" ${dash ? 'stroke-dasharray="5 5"' : ''}/>`;
    h += line(ax, ay, .9) + line((ax + bx) / 2, (ay + by) / 2, .45, true) + line(bx, by, .9, true);
    h += `<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="white" stroke-opacity=".5" stroke-width="1"/>`;
    h += handle(ax, ay, 'a') + handle(bx, by, 'b') + handle((ax + bx) / 2, (ay + by) / 2, 'move', true);
  } else {
    const [cx, cy] = toS(m.cx, m.cy); const long = Math.max(fw, fh);
    const rx = m.rx * long * pxPerFrame, ry = m.ry * long * pxPerFrame, a = m.angle || 0, rad = a * Math.PI / 180;
    const inner = 1 - (m.feather ?? .5);
    h += `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" transform="rotate(${a} ${cx} ${cy})" fill="none" stroke="white" stroke-opacity=".9" stroke-width="1.5"/>`;
    h += `<ellipse cx="${cx}" cy="${cy}" rx="${rx * inner}" ry="${ry * inner}" transform="rotate(${a} ${cx} ${cy})" fill="none" stroke="white" stroke-opacity=".4" stroke-dasharray="5 5" stroke-width="1.2"/>`;
    h += handle(cx + Math.cos(rad) * rx, cy + Math.sin(rad) * rx, 'rx') + handle(cx - Math.sin(rad) * ry, cy + Math.cos(rad) * ry, 'ry') + handle(cx, cy, 'move', true);
  }
  svg.innerHTML = h;
}
function handle(x, y, k, big) { return `<circle data-k="${k}" cx="${x}" cy="${y}" r="${big ? 9 : 7}" fill="${big ? 'rgba(169,139,255,.95)' : 'white'}" stroke="rgba(0,0,0,.55)" stroke-width="1.5"/>`; }
function hookMaskDrag(svg) {
  let d = null;
  svg.addEventListener('pointerdown', (e) => {
    const k = e.target.dataset && e.target.dataset.k; if (!k) return;
    e.stopPropagation(); e.preventDefault();
    const m = st.s.masks.find((x) => x.id === st.maskSel);
    d = { k, m, start: S.clone(m), x: e.clientX, y: e.clientY };
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener('pointermove', (e) => {
    if (!d) return;
    const r = st.rect, g = st.s.geom, c = g.crop, [fw, fh] = frameSize(engine.w, engine.h, g);
    const sr = $('#stage').getBoundingClientRect();
    const u = c.x + (e.clientX - sr.left - r.x) / r.w * c.w, v = c.y + (e.clientY - sr.top - r.y) / r.h * c.h;
    const du = (e.clientX - d.x) / r.w * c.w, dv = (e.clientY - d.y) / r.h * c.h;
    const m = d.m, o = d.start;
    if (m.type === 'grad') {
      if (d.k === 'a') { m.x0 = u; m.y0 = v; } else if (d.k === 'b') { m.x1 = u; m.y1 = v; }
      else { m.x0 = o.x0 + du; m.y0 = o.y0 + dv; m.x1 = o.x1 + du; m.y1 = o.y1 + dv; }
    } else {
      const long = Math.max(fw, fh);
      const px = (u - m.cx) * fw, py = (v - m.cy) * fh;
      if (d.k === 'move') { m.cx = o.cx + du; m.cy = o.cy + dv; }
      else if (d.k === 'rx') { m.rx = Math.max(.01, Math.hypot(px, py) / long); m.angle = Math.atan2(py, px) * 180 / Math.PI; }
      else { const rad = (m.angle || 0) * Math.PI / 180; m.ry = Math.max(.01, Math.abs(-Math.sin(rad) * px + Math.cos(rad) * py) / long); }
    }
    requestRender();
  });
  svg.addEventListener('pointerup', () => { if (d) { d = null; commit(); } });
}

// ---------- white balance picker ----------
function startPick() { if (!st.loaded) return; st.picking = true; $('#stage').classList.add('picking'); $('#wbPick')?.classList.add('on'); toast('Click something that should be white or grey.', null, null, 3000); }
function stopPick() { st.picking = false; $('#stage').classList.remove('picking'); $('#wbPick')?.classList.remove('on'); }
function pickAt(e) {
  const sr = $('#stage').getBoundingClientRect(), r = st.rect;
  const ou = (e.clientX - sr.left - r.x) / r.w, ov = (e.clientY - sr.top - r.y) / r.h;
  stopPick();
  if (ou < 0 || ov < 0 || ou > 1 || ov > 1) return;
  const [u, v] = M.apply(outToSrc(engine.w, engine.h, st.s.geom), ou, ov);
  const [R, G, B] = engine.sampleBase(u, v);
  if (!(R > 1e-4 && G > 1e-4 && B > 1e-4)) { toast('That spot is too dark to measure. Try a lighter grey.'); return; }
  const cl = (x) => Math.max(-1, Math.min(1, Math.round(x * 100) / 100));
  st.s.temp = cl(Math.log(B / R) / .64);
  st.s.tint = cl(Math.log(G / Math.sqrt(R * B)) / .22);
  st.s.look = null; syncPanel(); requestRender(); commit();
}

// ---------- clipping ----------
function toggleClip() { st.clip = !st.clip; $('#clipBtn').classList.toggle('on', st.clip); requestRender(false); }
$('#clipBtn').onclick = toggleClip;

// ---------- ratings ----------
function shown() {
  const f = st.filter || 'all';
  if (f === 'all') return st.photos;
  if (f === 'edited') return st.photos.filter((p) => p.edited);
  return st.photos.filter((p) => (p.rating || 0) >= +f);
}
async function rate(ids, n) {
  ids = ids.filter(Boolean); if (!ids.length) return;
  await api.setRating(ids, n);
  for (const id of ids) { const p = st.byId.get(id); if (p) { p.rating = n; refreshTile(p); } }
  if (st.mode === 'edit') showStars();
  toast(n ? `${'★'.repeat(n)} ${ids.length > 1 ? `on ${ids.length} photos` : ''}` : 'Rating removed', null, null, 1500);
  if (st.filter && st.filter !== 'all' && st.mode === 'library') renderGrid();
}
function showStars() {
  const p = st.byId.get(st.active); const box = $('#stars'); if (!box) return;
  box.innerHTML = [1, 2, 3, 4, 5].map((i) => `<button data-n="${i}" class="${p && p.rating >= i ? 'on' : ''}" title="${i} star${i > 1 ? 's' : ''} (${i})">★</button>`).join('');
}
$('#stars').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; const p = st.byId.get(st.active); const n = +b.dataset.n; rate([st.active], p && p.rating === n ? 0 : n); });
$('#filter').onchange = (e) => { st.filter = e.target.value; st.sel.clear(); renderGrid(); };

// ---------- prefetch ----------
function prefetchNext(token) {
  const i = st.photos.findIndex((x) => x.id === st.active);
  const n = st.photos[i + 1];
  if (!n || (st.prefetch && st.prefetch.id === n.id)) return;
  if (st.prefetch) st.prefetch.job.then((x) => x?.bitmap?.close()).catch(() => {});
  // Wait a moment so the current photo's looks and histogram go first.
  const job = wait(700).then(() => (token === st.token ? decode(n) : null));
  st.prefetch = { id: n.id, job };
}

// ---------- match a photo ----------
function openMatch() {
  if (!st.loaded) return;
  const grid = $('#matchGrid'); grid.innerHTML = '';
  for (const p of st.photos) {
    if (p.id === st.active) continue;
    const b = document.createElement('button'); b.title = p.name;
    b.innerHTML = `<img src="${thumbUrl(p)}" alt="" loading="lazy">`;
    b.onclick = () => runMatch(p, b);
    grid.append(b);
  }
  if (!grid.children.length) grid.innerHTML = '<p class="muted">No other photos in this folder. Choose a file instead.</p>';
  $('#matchSheet').hidden = false;
}
$('#matchBtn').onclick = openMatch;
$('#matchCancel').onclick = () => { $('#matchSheet').hidden = true; };
$('#matchSheet').addEventListener('pointerdown', (e) => { if (e.target.id === 'matchSheet') e.target.hidden = true; });
$('#matchFile').onclick = async () => { const p = await api.pickImage(); if (p) runMatch(p, null); };
async function runMatch(ref, btn) {
  if (btn) btn.insertAdjacentHTML('beforeend', '<span class="busy-dot"><span class="spin"></span></span>');
  try {
    const src = await decode(ref, { half: true });
    worker.load(src); if (src.ref) { worker.calibrate(src.ref); src.ref.close(); } if (src.bitmap) src.bitmap.close();
    const plain = S.fresh();
    const [rw, rh] = fit(...worker.outSize(plain), 200);
    const refStats = measure(worker.pixels(plain, rw, rh, { noSharp: true }));
    const [w, h] = fit(...engine.outSize(st.s), 160);
    const full = matchSettings((x) => engine.pixels(x, w, h, { noSharp: true, noMasks: true }), st.s, refStats);
    full.look = 'match';
    const thumb = ref.kind === 'raw' || st.byId.has(ref.id) ? thumbUrl(ref) : `ls://photo/${ref.id}`;
    st.match = { id: st.active, full, name: ref.name, thumb, k: 1 };
    st.s = blend(st.s, full, 1); st.s.look = 'match';
    $('#matchSheet').hidden = true;
    showMatchBar(); commit(); syncPanel(); requestRender();
    toast(`Matched to ${ref.name}. Every change is in the sliders, so you can fine-tune it.`);
  } catch (err) {
    console.error(err); toast("Couldn't read that photo.");
  } finally { btn?.querySelector('.busy-dot')?.remove(); }
}
let matchSl;
function showMatchBar() {
  const m = st.match;
  $('#matchName').textContent = m.name; $('#matchThumb').src = m.thumb;
  if (!matchSl) {
    matchSl = sliderEl({ name: 'Strength', min: 0, max: 1, keepLook: true }, () => st.match.k, (v) => { st.match.k = v; st.s = blend(st.s, st.match.full, v); st.s.look = 'match'; syncPanel(); }, 1);
    $('#matchStrength').append(matchSl.wrap);
  }
  matchSl.sync(); markLook();
}

// ---------- import Lightroom presets ----------
async function importPresets(files) {
  if (!files || !files.length) return;
  const added = [], bad = [];
  const have = new Set((st.prefs.presets || []).map((l) => l.name));
  for (const f of files) {
    try {
      const p = parsePreset(f.text, f.name);
      let name = p.name, i = 2; while (have.has(name)) name = `${p.name} ${i++}`;
      have.add(name);
      added.push({ id: 'u' + Date.now().toString(36) + added.length, name, s: p.s, user: true, imported: true });
    } catch { bad.push(f.name); }
  }
  if (added.length) {
    st.prefs.presets = [...(st.prefs.presets || []), ...added];
    await api.setSettings({ presets: st.prefs.presets });
    renderLooks();
  }
  const msg = added.length ? `Imported ${added.length} look${added.length === 1 ? '' : 's'}. Find them in Looks${st.mode === 'library' ? ' and in Apply look' : ''}.` : 'No presets could be read.';
  toast(bad.length ? `${msg} ${bad.length} file${bad.length === 1 ? '' : 's'} skipped.` : msg, added.length && st.mode === 'edit' ? 'Try the first' : null, () => chooseLook(added[0]), 6000);
}
$('#importPresets').onclick = async () => importPresets(await api.pickPresets());

// ---------- start ----------
(async () => {
  st.prefs = await api.settings();
  if (st.prefs.thumbSize) { $('#thumbSize').value = st.prefs.thumbSize; $('#grid').style.setProperty('--tile', st.prefs.thumbSize + 'px'); }
  buildPanel();
  await loadFolders(true);
  movePill();
  window.__ls = { st, engine, worker, openEditor, openFolder, setMode, chooseLook, runAuto, enterCrop, exitCrop, setAspect, toggleZoom, S };
})();
