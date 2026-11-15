// Match a photo: measures a reference photo's brightness spread and colours, then sets this photo's
// ordinary sliders (tone curve, white balance, saturation, colour grading) so it looks alike.
// Plain measurement and arithmetic; everything it sets stays editable.
import * as S from './settings.js';

const LUM = [.2126, .7152, .0722];
const lin = (v) => (v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
// sRGB (0..255) -> OKLab
function oklab(r, g, b) {
  r = lin(r / 255); g = lin(g / 255); b = lin(b / 255);
  const l = Math.cbrt(.4122214708 * r + .5363325363 * g + .0514459929 * b);
  const m = Math.cbrt(.2119034982 * r + .6806995451 * g + .1073969566 * b);
  const s = Math.cbrt(.0883024619 * r + .2817188376 * g + .6299787005 * b);
  return [.2104542553 * l + .793617785 * m - .0040720468 * s, 1.9779984951 * l - 2.428592205 * m + .4505937099 * s, .0259040371 * l + .7827717662 * m - .808675766 * s];
}

const PCT = [.02, .1, .25, .5, .75, .9, .98];
// Measures RGBA pixels.
export function measure(px) {
  const hist = new Float64Array(256); let n = 0;
  let C = 0;
  // Colour cast is read from near-grey pixels only: a blue bag in the photo is not a blue cast.
  const cast = [0, 0, 0], sh = [0, 0, 0], hi = [0, 0, 0];
  for (let i = 0; i < px.length; i += 4) {
    const y = Math.round(px[i] * LUM[0] + px[i + 1] * LUM[1] + px[i + 2] * LUM[2]);
    hist[y]++; n++;
    const [L, a, b] = oklab(px[i], px[i + 1], px[i + 2]);
    const c = Math.hypot(a, b); C += c;
    const w = Math.max(0, 1 - c / .07) * (L > .08 && L < .97 ? 1 : 0);
    if (!w) continue;
    cast[0] += a * w; cast[1] += b * w; cast[2] += w;
    if (L < .45) { sh[0] += a * w; sh[1] += b * w; sh[2] += w; } else if (L > .7) { hi[0] += a * w; hi[1] += b * w; hi[2] += w; }
  }
  const pct = PCT.map((q) => { let acc = 0; for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= n * q) return i / 255; } return 1; });
  const avg = (z) => (z[2] > n * .02 ? [z[0] / z[2], z[1] / z[2]] : null);
  const ca = avg(cast);
  return { pct, chroma: C / n, a: ca ? ca[0] : 0, b: ca ? ca[1] : 0, hasCast: !!ca, sh: avg(sh), hi: avg(hi) };
}

// Builds settings for `cur` (keeps its crop and masks) so its render matches `ref` stats.
// `render(s)` returns small RGBA pixels of the photo with settings s.
export function matchSettings(render, cur, ref) {
  const s = S.complete({ geom: cur.geom, masks: cur.masks });
  if (ref.chroma < .012) s.bw = true;
  // 1. Brightness: a tone curve that maps this photo's brightness spread onto the reference's.
  const src = measure(render(s));
  const pts = [[0, 0]];
  for (let i = 0; i < PCT.length; i++) {
    const x = src.pct[i], y = ref.pct[i];
    if (x > pts[pts.length - 1][0] + .04 && x < .97) pts.push([x, Math.max(pts[pts.length - 1][1], Math.min(1, y))]);
  }
  pts.push([1, Math.max(pts[pts.length - 1][1], ref.pct[PCT.length - 1] > .9 ? 1 : Math.min(1, ref.pct[PCT.length - 1] + .06))]);
  s.curve = { ...s.curve, m: pts.map(([x, y]) => [round(x), round(y)]) };
  if (s.bw) return s;
  // 2. Overall colour cast: find the temperature and tint that move the average colour to the reference's.
  const base = measure(render(s));
  const dT = measure(render({ ...s, temp: .3 })), dN = measure(render({ ...s, tint: .3 }));
  const ta = (dT.a - base.a) / .3, tb = (dT.b - base.b) / .3, na = (dN.a - base.a) / .3, nb = (dN.b - base.b) / .3;
  const ea = ref.a - base.a, eb = ref.b - base.b, det = ta * nb - tb * na;
  if (ref.hasCast && base.hasCast && Math.abs(det) > 1e-6) {
    // Temperature first (limited), then tint for whatever cast is left, so neither overshoots.
    const t = clamp((ea * nb - eb * na) / det, -.5, .5);
    const ra = ea - t * ta, rb = eb - t * tb;
    const n = clamp((ra * na + rb * nb) / Math.max(1e-9, na * na + nb * nb), -.12, .12);
    s.temp = t; s.tint = n;
  }
  // 3. Colourfulness.
  const now = measure(render(s));
  if (now.chroma > .003) s.saturation = clamp(ref.chroma / now.chroma - 1, -.85, .7);
  // 4. Colour in the shadows and highlights (split toning), what's left after the overall cast.
  const after = measure(render(s));
  // If the light itself is very different (temperature at its limit), toning would only fight it.
  const farOff = Math.abs(s.temp) >= .5;
  for (const [key, zone] of farOff ? [] : [['gradeSh', 'sh'], ['gradeHi', 'hi']]) {
    if (!ref[zone] || !after[zone]) continue;
    const da = ref[zone][0] - after[zone][0], db = ref[zone][1] - after[zone][1];
    const mag = Math.hypot(da, db);
    if (mag < .012) continue;
    // Which hue on our grading wheel moves colour in this direction? Try them and keep the best.
    let best = null;
    for (let h = 0; h < 360; h += 15) {
      const m = measure(render({ ...s, [key]: { h, s: .4 } }));
      if (!m[zone]) continue;
      const ma = m[zone][0] - after[zone][0], mb = m[zone][1] - after[zone][1];
      const along = (ma * da + mb * db) / mag; // progress toward the target per 0.4 amount
      if (!best || along > best.along) best = { h, along };
    }
    if (best && best.along > 1e-4) s[key] = { h: best.h, s: round(clamp(.4 * mag / best.along * .7, 0, .35)) };
  }
  for (const k of ['temp', 'tint', 'saturation']) s[k] = round(s[k]);
  return s;
}

// Mixes between no change (0) and the full match (1).
export function blend(cur, full, k) {
  const s = S.clone(full);
  const fresh = S.fresh();
  for (const key of ['temp', 'tint', 'saturation']) s[key] = round(fresh[key] + (full[key] - fresh[key]) * k);
  for (const key of ['gradeSh', 'gradeHi']) s[key] = { h: full[key].h, s: round(full[key].s * k) };
  s.curve = { ...full.curve, m: full.curve.m.map(([x, y]) => [x, round(x + (y - x) * k)]) };
  s.geom = S.clone(cur.geom); s.masks = S.clone(cur.masks || []);
  return s;
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const round = (v) => Math.round(v * 1000) / 1000;
