// The photo engine. Everything runs on the graphics card in WebGL2, in linear light with 16-bit floats.
// One base texture per photo (never changed), plus a small blurred copy for local tone (clarity, shadows).
// Each slider change re-runs one shader over the visible pixels, so dragging stays smooth.
import { DEFAULTS } from './settings.js';

const VS = `#version 300 es
in vec2 aPos; out vec2 vUv;
void main() { vUv = aPos * .5 + .5; gl_Position = vec4(aPos, 0., 1.); }`;

// Converts the decoded photo into the linear float base texture.
const FS_IMPORT_SRGB = `#version 300 es
precision highp float; uniform sampler2D uSrc; in vec2 vUv; out vec4 o;
void main() { o = vec4(texture(uSrc, vUv).rgb, 1.); }`; // SRGB8 texture: sampling is already linear. Row 0 = top of the photo.
const FS_IMPORT_RAW = `#version 300 es
precision highp float; precision highp usampler2D; uniform usampler2D uSrc; uniform float uScale; in vec2 vUv; out vec4 o;
void main() { ivec2 s = textureSize(uSrc, 0); ivec2 p = ivec2(vUv * vec2(s)); p = min(p, s - 1);
  // LibRaw hands back BT.709-gamma data (power .45, toe slope 4.5); undo it to get linear light.
  vec3 v = vec3(texelFetch(uSrc, p, 0).rgb) * uScale;
  vec3 lin = mix(v / 4.5, pow((v + .099) / 1.099, vec3(1. / .45)), step(.081, v));
  o = vec4(lin, 1.); }`;
// Downsample (mip level) to the small working copy, then a separable blur.
const FS_COPY = `#version 300 es
precision highp float; uniform sampler2D uSrc; uniform float uLod; in vec2 vUv; out vec4 o;
void main() { o = textureLod(uSrc, vUv, uLod); }`;
const FS_SAMPLE = `#version 300 es
precision highp float; uniform sampler2D uSrc; uniform vec2 uC, uR; in vec2 vUv; out vec4 o;
void main() { o = textureLod(uSrc, uC + (vUv - .5) * 2. * uR, 0.); }`;
const FS_BLUR = `#version 300 es
precision highp float; uniform sampler2D uSrc; uniform vec2 uDir; in vec2 vUv; out vec4 o;
void main() {
  const float w[5] = float[](.227027, .1945946, .1216216, .054054, .016216);
  // Blur the log of brightness so bright spots don't bleed into dark areas as much.
  float c = log2(max(dot(texture(uSrc, vUv).rgb, vec3(.2126,.7152,.0722)), 1e-5)) * w[0];
  for (int i = 1; i < 5; i++) {
    vec2 d = uDir * float(i) * 1.6;
    c += log2(max(dot(texture(uSrc, vUv + d).rgb, vec3(.2126,.7152,.0722)), 1e-5)) * w[i];
    c += log2(max(dot(texture(uSrc, vUv - d).rgb, vec3(.2126,.7152,.0722)), 1e-5)) * w[i];
  }
  o = vec4(exp2(c), 0., 0., 1.);
}`;
const FS_BLUR2 = `#version 300 es
precision highp float; uniform sampler2D uSrc; uniform vec2 uDir; in vec2 vUv; out vec4 o;
void main() {
  const float w[5] = float[](.227027, .1945946, .1216216, .054054, .016216);
  float c = log2(max(texture(uSrc, vUv).r, 1e-5)) * w[0];
  for (int i = 1; i < 5; i++) { vec2 d = uDir * float(i) * 1.6;
    c += log2(max(texture(uSrc, vUv + d).r, 1e-5)) * w[i] + log2(max(texture(uSrc, vUv - d).r, 1e-5)) * w[i]; }
  o = vec4(exp2(c), 0., 0., 1.);
}`;

// The main develop shader.
const FS_DEVELOP = `#version 300 es
precision highp float;
uniform sampler2D uBase, uBlur;
uniform mat3 uToSrc;      // canvas uv -> photo uv
uniform mat3 uToOut;      // canvas uv -> cropped-photo uv (0..1 inside the crop)
uniform vec2 uOutPx;      // size of the cropped photo in pixels
uniform vec2 uTexel;      // one photo pixel in uv
uniform vec3 uBg;
uniform vec3 uWB;
uniform float uExp, uCon, uHi, uSh, uWh, uBl, uVib, uSat, uClar, uHaze, uVig, uGrain, uSharp, uBW, uRaw, uFade, uBaseEV;
uniform vec3 uSplitHi, uSplitSh; // colour grading tints (already scaled)
uniform vec4 uHslHue[2], uHslSat[2], uHslLum[2]; // 8 colour bands
uniform sampler2D uCurve; uniform float uUseCurve;   // tone curve lookup (R, G, B)
uniform float uNoise, uCNoise, uClip;
uniform vec4 uCrop; uniform vec2 uFramePx;           // crop in frame uv, frame size in pixels
#define MAXM 8
uniform int uMaskN;
uniform vec4 uMaskA[MAXM]; // type (1 gradient, 2 radial), invert, feather, angle
uniform vec4 uMaskB[MAXM]; // gradient: x0 y0 x1 y1 (frame px) / radial: cx cy rx ry (frame px)
uniform vec4 uMaskL[MAXM]; // exposure, temp, tint, clarity
uniform vec4 uMaskK[MAXM]; // saturation, highlights, shadows, dehaze
in vec2 vUv; out vec4 o;

const vec3 LUM = vec3(.2126, .7152, .0722);
float enc(float x) { return x <= .0031308 ? x * 12.92 : 1.055 * pow(x, 1. / 2.4) - .055; }
float dec(float x) { return x <= .04045 ? x / 12.92 : pow((x + .055) / 1.055, 2.4); }
vec3 enc3(vec3 c) { return vec3(enc(c.r), enc(c.g), enc(c.b)); }
vec3 dec3(vec3 c) { return vec3(dec(c.r), dec(c.g), dec(c.b)); }
float hash(vec2 p) { p = fract(p * vec2(443.897, 441.423)); p += dot(p, p.yx + 19.19); return fract((p.x + p.y) * p.x) - .5; }
float vnoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
vec3 rgb2hsv(vec3 c) { vec4 K = vec4(0., -1. / 3., 2. / 3., -1.); vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r)); float d = q.x - min(q.w, q.y);
  return vec3(abs(q.z + (q.w - q.y) / (6. * d + 1e-10)), d / (q.x + 1e-10), q.x); }
vec3 hsv2rgb(vec3 c) { vec3 p = abs(fract(c.xxx + vec3(1., 2. / 3., 1. / 3.)) * 6. - 3.); return c.z * mix(vec3(1.), clamp(p - 1., 0., 1.), c.y); }
float band(float h, float centre) { float d = abs(fract(h - centre + .5) - .5) * 8.; return max(0., 1. - d); }

float aces(float x) { x *= .8; return clamp(x * (2.51 * x + .03) / (x * (2.43 * x + .59) + .14), 0., 1.2); }

// Shape one brightness value (0..1, perceptual) with the light sliders.
float tone(float p, float pb, float mSh, float mHi) {
  // Blacks and whites move the ends.
  p += uBl * .14 * pow(max(1. - p, 0.), 5.);
  p += uWh * .16 * pow(clamp(p, 0., 1.4), 4.);
  // Shadows and highlights act on a mix of the pixel and its neighbourhood, so detail survives.
  float m = mix(p, pb, .55);
  float sh = pow(max(1. - m, 0.), 2.6) * smoothstep(-.02, .22, p);
  float hi = pow(clamp(m, 0., 1.3), 2.2) * smoothstep(1.25, .35, p - .25);
  p += (uSh + mSh) * .32 * sh;
  p += (uHi + mHi) * .30 * hi;
  // Contrast: an S curve around middle grey that keeps black and white in place.
  float k = exp(uCon * .85);
  float pv = .42;
  float q = clamp(p, 0., 1.);
  float s = q < pv ? pv * pow(q / pv, k) : 1. - (1. - pv) * pow((1. - q) / (1. - pv), k);
  p = s + max(p - 1., 0.);
  // Highlights that would clip roll off softly instead of turning flat white.
  if (p > .82) p = .82 + .18 * tanh((p - .82) / .18);
  // Fade lifts the blacks for a matte look.
  p = mix(p, .06 + p * .94, uFade);
  return clamp(p, 0., 1.);
}

float maskW(int i, vec2 fp) {
  vec4 a = uMaskA[i], b = uMaskB[i];
  float w;
  if (a.x < 1.5) {
    vec2 d = b.zw - b.xy;
    float t = dot(fp - b.xy, d) / max(dot(d, d), 1e-6);
    w = 1. - smoothstep(0., 1., clamp(t, 0., 1.));
  } else {
    vec2 q = fp - b.xy; float ca = cos(a.w), sa = sin(a.w);
    q = vec2(ca * q.x + sa * q.y, -sa * q.x + ca * q.y) / max(b.zw, vec2(1.));
    float f = max(a.z, .02);
    w = 1. - smoothstep(1. - f, 1., length(q));
  }
  return a.y > .5 ? 1. - w : w;
}

vec3 develop(vec2 suv, vec2 ouv) {
  vec3 c = texture(uBase, suv).rgb;
  // Noise reduction: smooth brightness with edge-aware weights, and colour speckles over a wider area.
  if (uNoise > 0. || uCNoise > 0.) {
    float y0 = max(dot(c, LUM), 1e-5);
    vec3 chroma = c / y0;
    if (uCNoise > 0.) {
      vec3 acc = chroma; float wsum = 1.;
      float rad = 2. + uCNoise * 5.;
      for (int i = 0; i < 12; i++) {
        float ang = float(i) * 2.0944 + float(i / 3) * .785;
        float rr = rad * (.45 + .55 * float(i % 3) / 2.);
        vec3 s = texture(uBase, suv + vec2(cos(ang), sin(ang)) * rr * uTexel).rgb;
        float ys = max(dot(s, LUM), 1e-5);
        float wgt = exp(-pow(log2(ys / y0) * 1.5, 2.));
        acc += s / ys * wgt; wsum += wgt;
      }
      chroma = mix(chroma, acc / wsum, min(1., uCNoise * 1.3));
    }
    float ny = y0;
    if (uNoise > 0.) {
      float sig = .02 + uNoise * .09; float acc = y0, wsum = 1.;
      for (int i = 0; i < 8; i++) {
        float ang = float(i) * .785;
        vec2 off = vec2(cos(ang), sin(ang)) * (1. + uNoise * 1.5) * uTexel;
        float ys = dot(texture(uBase, suv + off).rgb, LUM);
        float wgt = exp(-pow((sqrt(max(ys, 0.)) - sqrt(y0)) / sig, 2.));
        acc += ys * wgt; wsum += wgt;
      }
      ny = mix(y0, acc / wsum, min(1., uNoise * 1.2));
    }
    c = chroma * ny;
  }
  // Masks (gradients and radials) add their own local adjustments.
  vec4 mL = vec4(0.), mK = vec4(0.);
  if (uMaskN > 0) {
    vec2 fp = (uCrop.xy + ouv * uCrop.zw) * uFramePx;
    for (int i = 0; i < MAXM; i++) {
      if (i >= uMaskN) break;
      float w = maskW(i, fp);
      mL += uMaskL[i] * w; mK += uMaskK[i] * w;
    }
    vec3 mwb = vec3(exp(mL.y * .32), exp(-mL.z * .22), exp(-mL.y * .32));
    mwb /= dot(mwb, LUM);
    c *= mwb * exp2(mL.x);
  }
  // Sharpening at the photo's own pixel scale (only visible near 100%).
  if (uSharp > 0.) {
    vec3 n = texture(uBase, suv + vec2(uTexel.x, 0.)).rgb + texture(uBase, suv - vec2(uTexel.x, 0.)).rgb
           + texture(uBase, suv + vec2(0., uTexel.y)).rgb + texture(uBase, suv - vec2(0., uTexel.y)).rgb;
    float y0 = dot(c, LUM), yn = dot(n * .25, LUM);
    float d = clamp(y0 - yn, -.08, .08);
    c *= max(0., 1. + uSharp * 1.6 * d / max(y0, 1e-4));
  }
  float gain = exp2(uExp + uBaseEV);
  c *= uWB * gain;
  float blur = texture(uBlur, suv).r * dot(uWB, LUM) * gain * exp2(mL.x);
  float clar = uClar + mL.w, haze = uHaze + mK.w;

  float y = max(dot(c, LUM), 1e-6);
  // Clarity: local contrast in the midtones, measured against the blurred copy.
  if (clar != 0.) {
    float r = clamp(log2(y / max(blur, 1e-6)), -3., 3.);
    float mid = smoothstep(0., .25, enc(y)) * smoothstep(1.1, .55, enc(y));
    float ny = y * exp2(clar * .55 * r * mid);
    c *= ny / y; y = ny;
  }
  // Dehaze: remove (or add) a flat veil of light.
  if (haze != 0.) {
    float v = .028 * haze;
    c = haze > 0. ? max(c - v, 0.) / (1. - v) : mix(c, vec3(.42), -haze * .26);
    y = max(dot(c, LUM), 1e-6);
  }

  // RAW photos get a film-like base curve (deep blacks, soft highlight shoulder), like a camera's own JPEG.
  if (uRaw > .5) {
    float ny = aces(y), nb = aces(blur);
    c *= ny / y; y = max(ny, 1e-6); blur = nb;
  }
  float p = enc(min(y, 8.));
  float pb = enc(min(blur, 8.));
  float np = tone(p, pb, mK.z, mK.y);
  float ny = dec(np);
  vec3 col = c * (ny / y);
  // Keep colours inside the screen's range by easing them toward white instead of clipping.
  float mx = max(col.r, max(col.g, col.b));
  if (mx > 1.) col = mix(vec3(ny), col, clamp((1. - ny) / max(mx - ny, 1e-5), 0., 1.));

  vec3 e = enc3(clamp(col, 0., 1.));
  // Tone curve.
  if (uUseCurve > .5) {
    vec3 t = e * (255. / 256.) + .5 / 256.;
    e = vec3(texture(uCurve, vec2(t.r, .5)).r, texture(uCurve, vec2(t.g, .5)).g, texture(uCurve, vec2(t.b, .5)).b);
  }
  // Colour bands (8 hues): hue shift, saturation, brightness.
  vec3 hsv = rgb2hsv(e);
  float dh = 0., ds = 0., dl = 0.;
  float centres[8] = float[](0., .083, .167, .333, .5, .611, .75, .875);
  for (int i = 0; i < 8; i++) {
    float w = band(hsv.x, centres[i]) * smoothstep(.02, .18, hsv.y);
    int a = i / 4, b = i - a * 4;
    dh += w * uHslHue[a][b]; ds += w * uHslSat[a][b]; dl += w * uHslLum[a][b];
  }
  if (dh != 0. || ds != 0. || dl != 0.) {
    hsv.x = fract(hsv.x + dh * .08);
    hsv.y = clamp(hsv.y * (1. + ds), 0., 1.);
    hsv.z = clamp(hsv.z * (1. + dl * .35 * hsv.y), 0., 1.);
    e = hsv2rgb(hsv);
  }
  float g = dot(e, LUM);
  // Vibrance boosts quiet colours more than strong ones; saturation boosts all.
  float sat = max(e.r, max(e.g, e.b)) - min(e.r, min(e.g, e.b));
  e = g + (e - g) * (1. + uVib * (1. - sat) * 1.1 * (uVib > 0. ? 1. : .9));
  e = g + (e - g) * (1. + uSat + mK.x);
  // Colour grading: tint shadows and highlights.
  e += uSplitSh * pow(1. - g, 2.) + uSplitHi * pow(g, 2.);
  if (uBW > .5) { float l = dot(clamp(e, 0., 1.), vec3(.30, .59, .11)); e = vec3(l); }
  // Vignette, measured on the cropped frame.
  if (uVig != 0.) {
    vec2 q = (ouv - .5) * vec2(uOutPx.x / max(uOutPx.x, uOutPx.y), uOutPx.y / max(uOutPx.x, uOutPx.y)) * 2.;
    float r = smoothstep(.35, 1.25, length(q));
    e = uVig < 0. ? e * (1. + uVig * .8 * r) : mix(e, vec3(1.), uVig * .6 * r);
  }
  // Film grain, sized to the photo (not the screen).
  if (uGrain > 0.) {
    vec2 gp = ouv * uOutPx / max(1.4, max(uOutPx.x, uOutPx.y) / 2600.);
    float n = vnoise(gp) * .75 + vnoise(gp * 2.3 + 7.1) * .45;
    e += n * uGrain * .16 * (1. - abs(g - .5) * .9);
  }
  e = clamp(e, 0., 1.);
  // Clipping warning: pure white areas turn red, pure black areas turn blue.
  if (uClip > .5) {
    // Only real loss of detail: all colours blown to white, or crushed to black.
    if (min(e.r, min(e.g, e.b)) > .985 || dot(e, LUM) > .99) e = vec3(1., .22, .3);
    else if (max(e.r, max(e.g, e.b)) < .012) e = vec3(.2, .45, 1.);
  }
  return e;
}

void main() {
  vec3 sp = uToSrc * vec3(vUv, 1.);
  vec3 op = uToOut * vec3(vUv, 1.);
  vec2 suv = sp.xy, ouv = op.xy;
  if (ouv.x < 0. || ouv.y < 0. || ouv.x > 1. || ouv.y > 1. || suv.x < 0. || suv.y < 0. || suv.x > 1. || suv.y > 1.) { o = vec4(uBg, 1.); return; }
  o = vec4(develop(suv, ouv), 1.);
}`;

function compile(gl, vs, fs) {
  const sh = (t, src) => { const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const p = gl.createProgram();
  gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, 'aPos'); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name); }
  return { p, u };
}

// 3x3 affine helpers (column-major for WebGL).
const M = {
  id: () => [1, 0, 0, 0, 1, 0, 0, 0, 1],
  mul(a, b) { const o = new Array(9); for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) o[c * 3 + r] = a[r] * b[c * 3] + a[3 + r] * b[c * 3 + 1] + a[6 + r] * b[c * 3 + 2]; return o; },
  t: (x, y) => [1, 0, 0, 0, 1, 0, x, y, 1],
  s: (x, y) => [x, 0, 0, 0, y, 0, 0, 0, 1],
  r: (a) => [Math.cos(a), Math.sin(a), 0, -Math.sin(a), Math.cos(a), 0, 0, 0, 1],
  apply: (m, x, y) => [m[0] * x + m[3] * y + m[6], m[1] * x + m[4] * y + m[7]],
};

// The frame after turning (90° steps) and flipping: its size in pixels.
export function frameSize(w, h, g) { return g.rot90 % 2 ? [h, w] : [w, h]; }
// How much straightening zooms in so no empty corners show.
export function straightenScale(fw, fh, deg) {
  const a = Math.abs(deg) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return Math.max((fw * c + fh * s) / fw, (fw * s + fh * c) / fh);
}
// Map from a point in the cropped output (0..1, y down) to photo uv (0..1, y down).
export function outToSrc(w, h, g, crop = g.crop) {
  const [fw, fh] = frameSize(w, h, g);
  let m = M.mul(M.t(crop.x, crop.y), M.s(crop.w, crop.h));        // out -> frame uv
  m = M.mul(M.t(-.5, -.5), m);                                       // centred
  m = M.mul(M.s(fw, fh), m);                                         // pixels
  m = M.mul(M.s(1 / straightenScale(fw, fh, g.angle), 1 / straightenScale(fw, fh, g.angle)), m);
  m = M.mul(M.r(-g.angle * Math.PI / 180), m);
  m = M.mul(M.r(-g.rot90 * Math.PI / 2), m);                         // undo the quarter turns
  if (g.flipH) m = M.mul(M.s(-1, 1), m);
  m = M.mul(M.s(1 / w, 1 / h), m);
  return M.mul(M.t(.5, .5), m);
}

export class Engine {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false, alpha: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('Float rendering is not available');
    gl.getExtension('OES_texture_float_linear');
    this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.progs = {
      srgb: compile(gl, VS, FS_IMPORT_SRGB), raw: compile(gl, VS, FS_IMPORT_RAW), copy: compile(gl, VS, FS_COPY),
      blur: compile(gl, VS, FS_BLUR), blur2: compile(gl, VS, FS_BLUR2), sample: compile(gl, VS, FS_SAMPLE), dev: compile(gl, VS, FS_DEVELOP),
    };
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray(); gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.base = null; this.blur = null; this.w = 0; this.h = 0;
  }

  tex(w, h, internal, format, type, data = null, filter) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
    const f = filter ?? gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f === gl.NEAREST ? gl.NEAREST : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  fbo(t) { const gl = this.gl, f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0); return f; }
  draw(prog, target, w, h, setup) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target); gl.viewport(0, 0, w, h);
    gl.useProgram(prog.p); setup && setup(prog.u); gl.bindVertexArray(this.vao); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  free() {
    const gl = this.gl;
    for (const t of [this.base, this.blur]) if (t) gl.deleteTexture(t);
    this.base = this.blur = null;
  }

  // src: { kind: 'bitmap', bitmap } or { kind: 'raw', width, height, data: Uint16Array (RGB) }
  load(src) {
    const gl = this.gl;
    this.free();
    let w = src.kind === 'bitmap' ? src.bitmap.width : src.width, h = src.kind === 'bitmap' ? src.bitmap.height : src.height;
    const tmp = src.kind === 'bitmap'
      ? (() => { gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); return this.tex(w, h, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, src.bitmap); })()
      : (() => { gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); return this.tex(w, h, gl.RGB16UI, gl.RGB_INTEGER, gl.UNSIGNED_SHORT, src.data, gl.NEAREST); })();
    // Photos bigger than the graphics card allows are scaled down to fit (rare: over 16384 pixels).
    const sc = Math.min(1, this.maxTex / Math.max(w, h));
    const bw = Math.round(w * sc), bh = Math.round(h * sc);
    this.base = this.tex(bw, bh, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, null, gl.LINEAR_MIPMAP_LINEAR);
    const f = this.fbo(this.base);
    this.draw(src.kind === 'bitmap' ? this.progs.srgb : this.progs.raw, f, bw, bh, (u) => {
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tmp); gl.uniform1i(u.uSrc, 0);
      if (u.uScale) gl.uniform1f(u.uScale, (src.scale || 1) / 65535);
    });
    gl.deleteFramebuffer(f); gl.deleteTexture(tmp);
    gl.bindTexture(gl.TEXTURE_2D, this.base); gl.generateMipmap(gl.TEXTURE_2D);
    this.w = bw; this.h = bh;
    this.isRaw = src.kind === 'raw'; this.baseEV = 0;
    this.makeBlur();
  }

  makeBlur() {
    const gl = this.gl;
    const long = 384, s = long / Math.max(this.w, this.h);
    const w = Math.max(8, Math.round(this.w * s)), h = Math.max(8, Math.round(this.h * s));
    const lod = Math.max(0, Math.log2(1 / s));
    const a = this.tex(w, h, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT), b = this.tex(w, h, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT);
    const fa = this.fbo(a), fb = this.fbo(b);
    this.draw(this.progs.copy, fa, w, h, (u) => { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.base); gl.uniform1i(u.uSrc, 0); gl.uniform1f(u.uLod, lod); });
    this.draw(this.progs.blur, fb, w, h, (u) => { gl.bindTexture(gl.TEXTURE_2D, a); gl.uniform1i(u.uSrc, 0); gl.uniform2f(u.uDir, 1 / w, 0); });
    this.draw(this.progs.blur2, fa, w, h, (u) => { gl.bindTexture(gl.TEXTURE_2D, b); gl.uniform1i(u.uSrc, 0); gl.uniform2f(u.uDir, 0, 1 / h); });
    this.draw(this.progs.blur2, fb, w, h, (u) => { gl.bindTexture(gl.TEXTURE_2D, a); gl.uniform1i(u.uSrc, 0); gl.uniform2f(u.uDir, 2 / w, 0); });
    this.draw(this.progs.blur2, fa, w, h, (u) => { gl.bindTexture(gl.TEXTURE_2D, b); gl.uniform1i(u.uSrc, 0); gl.uniform2f(u.uDir, 0, 2 / h); });
    gl.deleteFramebuffer(fa); gl.deleteFramebuffer(fb); gl.deleteTexture(b);
    this.blur = a;
  }

  // Match a RAW's overall brightness to the camera's own preview JPEG (ref: ImageBitmap),
  // so "exposure 0" looks like what the camera showed. Returns the baseline in stops.
  calibrate(ref) {
    const med = (px) => {
      const hist = new Uint32Array(256); let n = 0;
      for (let i = 0; i < px.length; i += 4) { hist[Math.round(px[i] * .2126 + px[i + 1] * .7152 + px[i + 2] * .0722)]++; n++; }
      let acc = 0; for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= n / 2) return i; }
      return 128;
    };
    const k = 128 / Math.max(ref.width, ref.height);
    const cv = new OffscreenCanvas(Math.max(1, Math.round(ref.width * k)), Math.max(1, Math.round(ref.height * k)));
    const cx = cv.getContext('2d'); cx.drawImage(ref, 0, 0, cv.width, cv.height);
    const target = med(cx.getImageData(0, 0, cv.width, cv.height).data);
    const s = { ...DEFAULTS, sharpen: 0, geom: { rot90: 0, flipH: false, angle: 0, crop: { x: 0, y: 0, w: 1, h: 1 } } };
    const w = 128, h = Math.max(1, Math.round(128 * this.h / this.w));
    let lo = -3, hi = 3;
    for (let i = 0; i < 9; i++) {
      this.baseEV = (lo + hi) / 2;
      if (med(this.pixels(s, w, h)) < target) lo = this.baseEV; else hi = this.baseEV;
    }
    this.baseEV = Math.round(((lo + hi) / 2) * 100) / 100;
    return this.baseEV;
  }

  // Average linear colour of the photo around a point (photo uv), for the white balance picker.
  sampleBase(u, v) {
    const gl = this.gl;
    const t = this.tex(8, 8, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT), f = this.fbo(t);
    const r = 10 / Math.max(this.w, this.h);
    this.draw(this.progs.sample, f, 8, 8, (un) => {
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.base); gl.uniform1i(un.uSrc, 0);
      gl.uniform2f(un.uC, u, v); gl.uniform2f(un.uR, r * Math.max(this.w, this.h) / this.w, r * Math.max(this.w, this.h) / this.h);
    });
    const px = new Float32Array(8 * 8 * 4);
    gl.readPixels(0, 0, 8, 8, gl.RGBA, gl.FLOAT, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.deleteFramebuffer(f); gl.deleteTexture(t);
    const c = [0, 0, 0];
    for (let i = 0; i < 64; i++) for (let k = 0; k < 3; k++) c[k] += px[i * 4 + k] / 64;
    return c;
  }

  // Size of the finished (cropped, straightened) photo in pixels.
  outSize(s) {
    const [fw, fh] = frameSize(this.w, this.h, s.geom);
    return [Math.max(1, Math.round(fw * s.geom.crop.w)), Math.max(1, Math.round(fh * s.geom.crop.h))];
  }

  // Draws the photo with settings `s`.
  // view: { w, h } of the target in pixels, plus optional zoom { scale (screen px per photo px), cx, cy (centre in out uv) }.
  // opts.full shows the whole frame (used while cropping). opts.target renders into a framebuffer.
  render(s, view, opts = {}) {
    const gl = this.gl;
    if (!this.base) return;
    const g = s.geom;
    const crop = opts.full ? { x: 0, y: 0, w: 1, h: 1 } : g.crop;
    const [fw, fh] = frameSize(this.w, this.h, g);
    const ow = fw * crop.w, oh = fh * crop.h;
    // canvas uv (y up) -> out uv (y down)
    let scale = view.scale || Math.min(view.w / ow, view.h / oh);
    const cx = view.cx ?? .5, cy = view.cy ?? .5;
    let toOut = M.mul(M.t(cx, cy), M.mul(M.s(view.w / (ow * scale), -view.h / (oh * scale)), M.t(-.5, -.5)));
    if (opts.exact) toOut = M.mul(M.s(1, -1), M.t(0, -1)); // the whole output fills the target exactly
    if (opts.toOut) toOut = opts.toOut;
    const toSrc = M.mul(outToSrc(this.w, this.h, g, crop), toOut);
    const d = { ...DEFAULTS, ...s };
    if (opts.neutral) Object.assign(d, DEFAULTS, { geom: g });
    const tempK = d.temp, tint = d.tint;
    let wb = [Math.exp(tempK * .32), Math.exp(-tint * .22), Math.exp(-tempK * .32)];
    const wl = wb[0] * .2126 + wb[1] * .7152 + wb[2] * .0722; wb = wb.map((v) => v / wl);
    const tgt = opts.target ?? null;
    if (!tgt) { this.canvas.width = view.w; this.canvas.height = view.h; }
    const hue = d.hsl.map((b) => b.h), sat = d.hsl.map((b) => b.s), lum = d.hsl.map((b) => b.l);
    const tint3 = (hueDeg, amt) => { const h = hueDeg / 360; const k = (n) => { const x = (n + h * 12) % 12; return .5 - .5 * Math.max(-1, Math.min(x - 3, 9 - x, 1)); }; return [k(0) - .5, k(8) - .5, k(4) - .5].map((v) => v * amt * .22); };
    this.draw(this.progs.dev, tgt, view.w, view.h, (u) => {
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.base); gl.uniform1i(u.uBase, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.blur); gl.uniform1i(u.uBlur, 1);
      gl.uniformMatrix3fv(u.uToSrc, false, toSrc); gl.uniformMatrix3fv(u.uToOut, false, toOut);
      gl.uniform2f(u.uOutPx, ow, oh); gl.uniform2f(u.uTexel, 1 / this.w, 1 / this.h);
      gl.uniform3fv(u.uBg, opts.bg || [.067, .063, .09]);
      gl.uniform3fv(u.uWB, wb);
      const f = (n, v) => u[n] && gl.uniform1f(u[n], v);
      f('uExp', d.exposure); f('uCon', d.contrast); f('uHi', d.highlights); f('uSh', d.shadows); f('uWh', d.whites); f('uBl', d.blacks);
      f('uVib', d.vibrance); f('uSat', d.saturation); f('uClar', d.clarity); f('uHaze', d.dehaze); f('uVig', d.vignette); f('uGrain', d.grain);
      f('uSharp', opts.noSharp ? 0 : d.sharpen); f('uBW', d.bw ? 1 : 0); f('uRaw', this.isRaw ? 1 : 0); f('uBaseEV', this.baseEV || 0); f('uFade', d.fade);
      gl.uniform3fv(u.uSplitHi, tint3(d.gradeHi.h, d.gradeHi.s)); gl.uniform3fv(u.uSplitSh, tint3(d.gradeSh.h, d.gradeSh.s));
      gl.uniform4fv(u.uHslHue, hue); gl.uniform4fv(u.uHslSat, sat); gl.uniform4fv(u.uHslLum, lum);
      const curve = curveTex.call(this, d.curve);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, curve || this.blur); gl.uniform1i(u.uCurve, 2);
      f('uUseCurve', curve ? 1 : 0);
      f('uNoise', d.noise || 0); f('uCNoise', d.colorNoise || 0); f('uClip', opts.clip ? 1 : 0);
      gl.uniform4f(u.uCrop, crop.x, crop.y, crop.w, crop.h); gl.uniform2f(u.uFramePx, fw, fh);
      const ms = (opts.noMasks ? [] : (d.masks || []).filter((m) => m.on !== false)).slice(0, 8);
      gl.uniform1i(u.uMaskN, ms.length);
      if (ms.length) {
        const A = new Float32Array(32), B = new Float32Array(32), Lm = new Float32Array(32), K = new Float32Array(32);
        const long = Math.max(fw, fh);
        ms.forEach((m, i) => {
          const j = i * 4, a = m.adj || {};
          if (m.type === 'grad') { A.set([1, m.invert ? 1 : 0, 0, 0], j); B.set([m.x0 * fw, m.y0 * fh, m.x1 * fw, m.y1 * fh], j); }
          else { A.set([2, m.invert ? 1 : 0, m.feather ?? .5, (m.angle || 0) * Math.PI / 180], j); B.set([m.cx * fw, m.cy * fh, m.rx * long, m.ry * long], j); }
          Lm.set([a.exposure || 0, a.temp || 0, a.tint || 0, a.clarity || 0], j);
          K.set([a.saturation || 0, a.highlights || 0, a.shadows || 0, a.dehaze || 0], j);
        });
        gl.uniform4fv(u.uMaskA, A); gl.uniform4fv(u.uMaskB, B); gl.uniform4fv(u.uMaskL, Lm); gl.uniform4fv(u.uMaskK, K);
      }
    });
    return { ow, oh, scale };
  }

  // Renders to an offscreen buffer and returns RGBA pixels (top row first).
  pixels(s, w, h, opts = {}) {
    const gl = this.gl;
    const t = this.tex(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
    const f = this.fbo(t);
    this.render(s, { w, h }, { ...opts, target: f, exact: true });
    const px = new Uint8ClampedArray(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(f); gl.deleteTexture(t);
    // readPixels starts at the bottom row; flip.
    const row = w * 4, tmp = new Uint8ClampedArray(row);
    for (let y = 0; y < h >> 1; y++) {
      const a = y * row, b = (h - 1 - y) * row;
      tmp.set(px.subarray(a, a + row)); px.copyWithin(a, b, b + row); px.set(tmp, b);
    }
    return px;
  }

  // Full-size render in tiles (keeps memory and GPU time per step small), returns ImageData.
  async exportImage(s, maxLong = 0) {
    let [w, h] = this.outSize(s);
    if (maxLong && Math.max(w, h) > maxLong) { const k = maxLong / Math.max(w, h); w = Math.round(w * k); h = Math.round(h * k); }
    const tile = 2048;
    const out = new ImageData(w, h);
    const gl = this.gl;
    const t = this.tex(tile, tile, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
    const f = this.fbo(t);
    const buf = new Uint8ClampedArray(tile * tile * 4);
    for (let ty = 0; ty < h; ty += tile) {
      for (let tx = 0; tx < w; tx += tile) {
        const tw = Math.min(tile, w - tx), th = Math.min(tile, h - ty);
        // canvas uv over this tile -> out uv
        const toOut = M.mul(M.t(tx / w, (ty + th) / h), M.s(tw / w, -th / h));
        this.render(s, { w: tw, h: th }, { target: f, toOut, noResize: true });
        gl.readPixels(0, 0, tw, th, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        for (let y = 0; y < th; y++) {
          const src = (th - 1 - y) * tw * 4;
          out.data.set(buf.subarray(src, src + tw * 4), ((ty + y) * w + tx) * 4);
        }
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(f); gl.deleteTexture(t);
    return out;
  }

}

// Tone curve -> 256x1 lookup texture (cached). Points are [x, y] in 0..1; monotone cubic between them.
export function curveLUT(pts) {
  const p = (pts && pts.length >= 2 ? pts : [[0, 0], [1, 1]]).slice().sort((a, b) => a[0] - b[0]);
  const n = p.length, xs = p.map((q) => q[0]), ys = p.map((q) => q[1]);
  const dx = [], dy = [], m = [];
  for (let i = 0; i < n - 1; i++) { dx.push(Math.max(1e-6, xs[i + 1] - xs[i])); dy.push((ys[i + 1] - ys[i]) / Math.max(1e-6, xs[i + 1] - xs[i])); }
  m.push(dy[0]);
  for (let i = 1; i < n - 1; i++) m.push(dy[i - 1] * dy[i] <= 0 ? 0 : (dy[i - 1] + dy[i]) / 2);
  m.push(dy[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (dy[i] === 0) { m[i] = m[i + 1] = 0; continue; }
    const a = m[i] / dy[i], b = m[i + 1] / dy[i], h = a * a + b * b;
    if (h > 9) { const t = 3 / Math.sqrt(h); m[i] = t * a * dy[i]; m[i + 1] = t * b * dy[i]; }
  }
  const out = new Float32Array(256);
  for (let k = 0; k < 256; k++) {
    const x = k / 255;
    if (x <= xs[0]) { out[k] = ys[0]; continue; }
    if (x >= xs[n - 1]) { out[k] = ys[n - 1]; continue; }
    let i = 0; while (x > xs[i + 1]) i++;
    const h = dx[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
    out[k] = (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  }
  return out.map((v) => Math.min(1, Math.max(0, v)));
}
const isIdentity = (c) => !c || c.length === 2 && c[0][0] === 0 && c[0][1] === 0 && c[1][0] === 1 && c[1][1] === 1;
function curveTex(curve) {
  if (!curve || ['m', 'r', 'g', 'b'].every((k) => isIdentity(curve[k]))) return null;
  const key = JSON.stringify(curve);
  if (this._curveKey === key) return this._curve;
  const gl = this.gl;
  const M = curveLUT(curve.m), ch = ['r', 'g', 'b'].map((k) => curveLUT(curve[k]));
  const data = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    for (let c = 0; c < 3; c++) {
      const v = ch[c][Math.round(M[i] * 255)];
      data[i * 4 + c] = Math.round(v * 255);
    }
    data[i * 4 + 3] = 255;
  }
  if (this._curve) gl.deleteTexture(this._curve);
  this._curve = this.tex(256, 1, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, data);
  this._curveKey = key;
  return this._curve;
}

export { M };
