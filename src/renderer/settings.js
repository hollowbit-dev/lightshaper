// Edit settings: their defaults, the sliders that change them, and the built-in looks.
// Sliders store -1..1 (shown as -100..100), except exposure (in stops).

export const HSL_BANDS = [
  { key: 'red', name: 'Red', col: '#ff5a5a' }, { key: 'orange', name: 'Orange', col: '#ff9a3d' },
  { key: 'yellow', name: 'Yellow', col: '#ffd84a' }, { key: 'green', name: 'Green', col: '#5ad86a' },
  { key: 'aqua', name: 'Aqua', col: '#3ed6d6' }, { key: 'blue', name: 'Blue', col: '#4a8dff' },
  { key: 'purple', name: 'Purple', col: '#9a6bff' }, { key: 'magenta', name: 'Magenta', col: '#ff5ad2' },
];

const geom = () => ({ rot90: 0, flipH: false, angle: 0, aspect: 'free', crop: { x: 0, y: 0, w: 1, h: 1 } });

export const DEFAULTS = Object.freeze({
  temp: 0, tint: 0,
  exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
  vibrance: 0, saturation: 0,
  clarity: 0, dehaze: 0, fade: 0, vignette: 0, grain: 0, sharpen: 0.25,
  bw: false,
  gradeHi: { h: 45, s: 0 }, gradeSh: { h: 215, s: 0 },
  hsl: HSL_BANDS.map(() => ({ h: 0, s: 0, l: 0 })),
  look: null,
  geom: geom(),
});

export function fresh() { return clone(DEFAULTS); }
export function clone(s) { return JSON.parse(JSON.stringify(s)); }
// Fills in anything missing (older saved edits, partial looks).
export function complete(s) {
  const d = fresh();
  if (!s) return d;
  const o = { ...d, ...clone(s) };
  o.geom = { ...d.geom, ...(s.geom || {}), crop: { ...d.geom.crop, ...((s.geom || {}).crop || {}) } };
  o.hsl = d.hsl.map((b, i) => ({ ...b, ...((s.hsl || [])[i] || {}) }));
  o.gradeHi = { ...d.gradeHi, ...(s.gradeHi || {}) }; o.gradeSh = { ...d.gradeSh, ...(s.gradeSh || {}) };
  return o;
}
export function isDefault(s) {
  const a = clone(s), b = fresh(); delete a.look; delete b.look;
  return JSON.stringify(a) === JSON.stringify(b);
}

// Panel layout. `range` is what the number shows; `step` is in shown units.
export const GROUPS = [
  { id: 'light', name: 'Light', sliders: [
    { key: 'exposure', name: 'Exposure', min: -5, max: 5, step: 0.05, show: (v) => (v > 0 ? '+' : '') + v.toFixed(2), kind: 'ev' },
    { key: 'contrast', name: 'Contrast' },
    { key: 'highlights', name: 'Highlights' },
    { key: 'shadows', name: 'Shadows' },
    { key: 'whites', name: 'Whites' },
    { key: 'blacks', name: 'Blacks' },
  ] },
  { id: 'colour', name: 'Colour', sliders: [
    { key: 'temp', name: 'Temperature', track: 'linear-gradient(90deg,#5b8cff,#e9e4d8,#ffb347)' },
    { key: 'tint', name: 'Tint', track: 'linear-gradient(90deg,#4fd16b,#e9e4d8,#e05cd6)' },
    { key: 'vibrance', name: 'Vibrance' },
    { key: 'saturation', name: 'Saturation', track: 'linear-gradient(90deg,#8a8a8a,#e9e4d8,#ff5f6d 70%,#ffd25e)' },
  ] },
  { id: 'effects', name: 'Effects', sliders: [
    { key: 'clarity', name: 'Clarity' },
    { key: 'dehaze', name: 'Dehaze' },
    { key: 'fade', name: 'Fade', min: 0, max: 1 },
    { key: 'vignette', name: 'Vignette' },
    { key: 'grain', name: 'Grain', min: 0, max: 1 },
    { key: 'sharpen', name: 'Sharpen', min: 0, max: 1 },
  ] },
];

// Built-in looks. Each one sets only what it names; everything else is reset, except crop.
export const LOOKS = [
  { id: 'none', name: 'Original', s: {} },
  { id: 'auto', name: 'Auto', s: {}, auto: true },
  { id: 'vivid', name: 'Vivid', s: { contrast: .22, vibrance: .38, saturation: .08, clarity: .12, shadows: .1 } },
  { id: 'soft', name: 'Soft', s: { contrast: -.18, highlights: -.25, shadows: .22, clarity: -.18, vibrance: .1, fade: .15 } },
  { id: 'golden', name: 'Golden hour', s: { temp: .32, tint: .06, contrast: .1, highlights: -.2, shadows: .15, vibrance: .22, gradeHi: { h: 40, s: .35 }, gradeSh: { h: 20, s: .12 }, vignette: -.2 } },
  { id: 'cool', name: 'Cool air', s: { temp: -.26, tint: -.03, contrast: .12, vibrance: .18, saturation: -.05, gradeSh: { h: 210, s: .25 }, clarity: .1 } },
  { id: 'film', name: 'Film', s: { contrast: .08, fade: .4, saturation: -.12, gradeHi: { h: 48, s: .25 }, gradeSh: { h: 190, s: .22 }, grain: .32, highlights: -.15, vignette: -.15 } },
  { id: 'matte', name: 'Matte', s: { contrast: -.12, fade: .55, saturation: -.2, shadows: .12, clarity: -.05, gradeSh: { h: 230, s: .12 } } },
  { id: 'moody', name: 'Moody', s: { exposure: -.3, contrast: .3, highlights: -.35, shadows: -.1, saturation: -.25, vibrance: .1, clarity: .2, gradeSh: { h: 200, s: .3 }, gradeHi: { h: 35, s: .15 }, vignette: -.4 } },
  { id: 'crisp', name: 'Crisp', s: { contrast: .18, clarity: .35, dehaze: .15, whites: .12, blacks: -.1, vibrance: .15, sharpen: .55 } },
  { id: 'teal', name: 'Teal & orange', s: { contrast: .15, gradeHi: { h: 30, s: .38 }, gradeSh: { h: 190, s: .45 }, vibrance: .15, hsl: [{}, { s: .15 }, {}, { h: .5, s: -.3 }, { s: .2 }, { h: -.3, s: .1 }, {}, {}] } },
  { id: 'bw', name: 'Black & white', s: { bw: true, contrast: .2, clarity: .15, whites: .1, blacks: -.12 } },
  { id: 'bwsoft', name: 'Silver', s: { bw: true, contrast: -.1, fade: .3, grain: .25, highlights: -.2, shadows: .15 } },
  { id: 'noir', name: 'Noir', s: { bw: true, contrast: .55, clarity: .3, blacks: -.35, vignette: -.5, grain: .2, exposure: -.15 } },
];

// Applies a look over the current settings: keeps crop/turns, resets the rest.
export function applyLook(cur, look) {
  const s = complete(look.s);
  s.geom = clone(cur.geom);
  s.look = look.id;
  return s;
}
