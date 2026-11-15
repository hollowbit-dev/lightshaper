// Opens Lightroom / Camera Raw presets (.xmp, and older .lrtemplate) and turns them into Lightshaper looks.
// Only the global settings we also have are read: light, colour, colour mixer, grading, curve, effects, detail.
// Camera profiles, masks and lens fixes inside a preset are skipped, so results are close, not identical.
import * as S from './settings.js';

const BANDS = ['Red', 'Orange', 'Yellow', 'Green', 'Aqua', 'Blue', 'Purple', 'Magenta'];
const num = (v) => { const n = parseFloat(String(v).replace('+', '')); return Number.isFinite(n) ? n : null; };
const clamp = (v, a = -1, b = 1) => Math.max(a, Math.min(b, v));
const r3 = (v) => Math.round(v * 1000) / 1000;

// Reads crs:* values from an XMP document: attributes, simple elements, and rdf:Seq lists.
function readXmp(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Not a valid preset file');
  const CRS = 'http://ns.adobe.com/camera-raw-settings/1.0/';
  const v = {}, lists = {};
  for (const el of doc.getElementsByTagName('*')) {
    for (const a of el.attributes) if (a.namespaceURI === CRS) v[a.localName] = a.value;
    if (el.namespaceURI === CRS) {
      const lis = el.getElementsByTagNameNS('http://www.w3.org/1999/02/22-rdf-syntax-ns#', 'li');
      if (lis.length) {
        if (el.localName === 'Name' || el.localName === 'Group') v[el.localName] = lis[0].textContent.trim();
        else lists[el.localName] = [...lis].map((li) => li.textContent.trim());
      } else if (!el.children.length) v[el.localName] = el.textContent.trim();
    }
  }
  return { v, lists };
}

// Older Lightroom Classic presets (.lrtemplate) are Lua tables: settings = { Exposure2012 = 0.5, ... }.
function readLrTemplate(text) {
  const v = {}, lists = {};
  const body = text.slice(text.indexOf('settings'));
  for (const m of body.matchAll(/(\w+)\s*=\s*(-?[\d.]+|true|false|"[^"]*")\s*,/g)) v[m[1]] = m[2].replace(/"/g, '');
  for (const m of body.matchAll(/(ToneCurvePV2012\w*)\s*=\s*\{([^}]*)\}/g)) {
    const n = m[2].split(',').map((x) => x.trim()).filter(Boolean).map(Number);
    lists[m[1]] = []; for (let i = 0; i + 1 < n.length; i += 2) lists[m[1]].push(`${n[i]}, ${n[i + 1]}`);
  }
  const t = text.match(/title\s*=\s*(?:ZSTR\s*)?"([^"]+)"/);
  if (t) v.Name = t[1].replace(/^\$\$\$\/[^=]*=/, '');
  return { v, lists };
}

function curveFrom(list) {
  if (!list || list.length < 2) return null;
  const pts = list.map((s) => s.split(',').map((x) => num(x) / 255)).filter((p) => p.every((x) => x != null));
  if (pts.length < 2) return null;
  const c = pts.map(([x, y]) => [r3(clamp(x, 0, 1)), r3(clamp(y, 0, 1))]).sort((a, b) => a[0] - b[0]);
  const identity = c.length === 2 && c[0][0] === 0 && c[0][1] === 0 && c[1][0] === 1 && c[1][1] === 1;
  return identity ? null : c;
}

// Turns a preset file's text into a look { name, s }.
export function parsePreset(text, fileName) {
  const { v, lists } = /<x:xmpmeta|<rdf:RDF|camera-raw-settings/.test(text) ? readXmp(text) : readLrTemplate(text);
  const s = {};
  const set = (key, src, div = 100, lo, hi) => { const n = num(v[src]); if (n != null) s[key] = r3(clamp(n / div, lo, hi)); };
  set('exposure', 'Exposure2012', 1, -5, 5); if (s.exposure == null) set('exposure', 'Exposure', 1, -5, 5);
  set('contrast', 'Contrast2012'); set('highlights', 'Highlights2012'); set('shadows', 'Shadows2012');
  set('whites', 'Whites2012'); set('blacks', 'Blacks2012');
  set('clarity', 'Clarity2012'); if (s.clarity == null) set('clarity', 'Clarity');
  // Texture is a finer kind of clarity; fold a little of it in.
  const tex = num(v.Texture); if (tex) s.clarity = r3(clamp((s.clarity || 0) + tex / 300));
  set('dehaze', 'Dehaze'); set('vibrance', 'Vibrance'); set('saturation', 'Saturation');
  set('vignette', 'PostCropVignetteAmount');
  set('grain', 'GrainAmount', 100, 0, 1);
  set('sharpen', 'Sharpness', 150, 0, 1);
  set('noise', 'LuminanceSmoothing', 100, 0, 1); set('colorNoise', 'ColorNoiseReduction', 100, 0, 1);
  // White balance: presets made for JPEGs use relative values; RAW presets use Kelvin.
  const it = num(v.IncrementalTemperature), itint = num(v.IncrementalTint), k = num(v.Temperature), tint = num(v.Tint);
  if (it != null) s.temp = r3(clamp(it / 100 * .8)); else if (k && v.WhiteBalance !== 'As Shot') s.temp = r3(clamp(Math.log(k / 5500) * 1.4));
  if (itint != null) s.tint = r3(clamp(itint / 100 * .6)); else if (tint != null && v.WhiteBalance !== 'As Shot') s.tint = r3(clamp(tint / 150 * .8));
  if (/^true$/i.test(v.ConvertToGrayscale || '')) s.bw = true;
  // Colour mixer (same 8 colours as ours).
  const hsl = BANDS.map((b) => {
    const h = num(v[`HueAdjustment${b}`]), sat = num(v[`SaturationAdjustment${b}`]), l = num(v[`LuminanceAdjustment${b}`]);
    return { h: h != null ? r3(clamp(h / 100)) : 0, s: sat != null ? r3(clamp(sat / 100)) : 0, l: l != null ? r3(clamp(l / 100)) : 0 };
  });
  if (hsl.some((b) => b.h || b.s || b.l)) s.hsl = hsl;
  // Colour grading (newer) or split toning (older).
  for (const [key, a, b] of [['gradeSh', 'ColorGradeShadow', 'SplitToningShadow'], ['gradeHi', 'ColorGradeHighlight', 'SplitToningHighlight']]) {
    const hue = num(v[`${a}Hue`]) ?? num(v[`${b}Hue`]), sat = num(v[`${a}Sat`]) ?? num(v[`${b}Saturation`]);
    if (sat) s[key] = { h: hue || 0, s: r3(clamp(sat / 100 * .9, 0, 1)) };
  }
  // Tone curves.
  const curve = {};
  for (const [k2, src] of [['m', 'ToneCurvePV2012'], ['r', 'ToneCurvePV2012Red'], ['g', 'ToneCurvePV2012Green'], ['b', 'ToneCurvePV2012Blue']]) {
    const c = curveFrom(lists[src]); if (c) curve[k2] = c;
  }
  if (Object.keys(curve).length) s.curve = { ...S.fresh().curve, ...curve };
  const used = Object.keys(s).length;
  if (!used) throw new Error('No settings Lightshaper can use');
  const name = (v.Name || fileName.replace(/\.(xmp|lrtemplate)$/i, '')).slice(0, 40);
  return { name, group: v.Group || null, s, used };
}
