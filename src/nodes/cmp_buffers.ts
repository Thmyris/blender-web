// Float image buffers for the compositor: socket values that are either constants or images,
// type conversion, per-pixel mapping, sampling, filters (blur, convolution), colour helpers,
// the 2.79 Mix blend modes, curve mapping and colour ramp evaluation.

import type { SocketType } from './nodes';

/** RGBA (premultiplied, linear), RGB vectors or single values, row 0 = bottom of the image. */
export interface Img { w: number; h: number; ch: number; data: Float32Array }

export type Val = { img: Img } | { c: number[] };

export function isImg(v: Val): v is { img: Img } { return 'img' in v; }

export function newImg(w: number, h: number, ch: number): Img {
  return { w, h, ch, data: new Float32Array(w * h * ch) };
}

export function channelsOf(t: SocketType): number { return t === 'RGBA' ? 4 : t === 'VECTOR' ? 3 : t === 'SHADER' ? 4 : 1; }

/** Luminance as in 2.79's rgb_to_bw. */
export function bw(r: number, g: number, b: number): number { return r * 0.35 + g * 0.45 + b * 0.2; }

function convertPixel(src: ArrayLike<number>, o: number, sch: number, dst: Float32Array | number[], d: number, dch: number): void {
  if (sch === dch) { for (let i = 0; i < dch; i++) dst[d + i] = src[o + i]; return; }
  if (dch === 1) {
    dst[d] = sch === 4 ? bw(src[o], src[o + 1], src[o + 2]) : sch === 3 ? (src[o] + src[o + 1] + src[o + 2]) / 3 : src[o];
    return;
  }
  if (sch === 1) { const v = src[o]; dst[d] = v; dst[d + 1] = v; dst[d + 2] = v; if (dch === 4) dst[d + 3] = 1; return; }
  // 3 <-> 4
  dst[d] = src[o]; dst[d + 1] = src[o + 1]; dst[d + 2] = src[o + 2];
  if (dch === 4) dst[d + 3] = 1;
}

/** Convert a value to the given channel count. */
export function convert(v: Val, ch: number): Val {
  if (!isImg(v)) {
    if (v.c.length === ch) return v;
    const out = new Array<number>(ch).fill(0);
    convertPixel(v.c, 0, v.c.length, out, 0, ch);
    return { c: out };
  }
  const img = v.img;
  if (img.ch === ch) return v;
  const out = newImg(img.w, img.h, ch);
  const n = img.w * img.h;
  for (let i = 0; i < n; i++) convertPixel(img.data, i * img.ch, img.ch, out.data, i * ch, ch);
  return { img: out };
}

export function constOf(v: Val, fallback: number[] = [0]): number[] {
  if (isImg(v)) {
    // average of the image (used where a node needs a single number)
    const img = v.img;
    const out = new Array<number>(img.ch).fill(0);
    const n = img.w * img.h;
    if (!n) return fallback;
    for (let i = 0; i < n; i++) for (let c = 0; c < img.ch; c++) out[c] += img.data[i * img.ch + c];
    return out.map((x) => x / n);
  }
  return v.c;
}

/** Read pixel (x, y) of `v` into `out` (images of a different size are centred like Blender's compositor). */
export function samplePixel(v: Val, x: number, y: number, w: number, h: number, out: Float32Array | number[]): void {
  if (!isImg(v)) { for (let i = 0; i < v.c.length; i++) out[i] = v.c[i]; return; }
  const img = v.img;
  let sx = x, sy = y;
  if (img.w !== w || img.h !== h) { sx = x + ((img.w - w) >> 1); sy = y + ((img.h - h) >> 1); }
  if (sx < 0 || sy < 0 || sx >= img.w || sy >= img.h) { for (let i = 0; i < img.ch; i++) out[i] = 0; return; }
  const o = (sy * img.w + sx) * img.ch;
  for (let i = 0; i < img.ch; i++) out[i] = img.data[o + i];
}

/** Bilinear sample at continuous coordinates (pixel centres at +0.5); outside is transparent. */
export function bilinear(img: Img, fx: number, fy: number, out: Float32Array | number[], wrap = false): void {
  const x = fx - 0.5, y = fy - 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const tx = x - x0, ty = y - y0;
  const ch = img.ch;
  for (let c = 0; c < ch; c++) out[c] = 0;
  for (let j = 0; j < 2; j++) {
    for (let i = 0; i < 2; i++) {
      let px = x0 + i, py = y0 + j;
      if (wrap) { px = ((px % img.w) + img.w) % img.w; py = ((py % img.h) + img.h) % img.h; }
      if (px < 0 || py < 0 || px >= img.w || py >= img.h) continue;
      const wgt = (i ? tx : 1 - tx) * (j ? ty : 1 - ty);
      const o = (py * img.w + px) * ch;
      for (let c = 0; c < ch; c++) out[c] += img.data[o + c] * wgt;
    }
  }
}

export function nearest(img: Img, fx: number, fy: number, out: Float32Array | number[]): void {
  const px = Math.floor(fx), py = Math.floor(fy);
  const ch = img.ch;
  if (px < 0 || py < 0 || px >= img.w || py >= img.h) { for (let c = 0; c < ch; c++) out[c] = 0; return; }
  const o = (py * img.w + px) * ch;
  for (let c = 0; c < ch; c++) out[c] = img.data[o + c];
}

/** Size of the result of a per-pixel operation: the first image input decides (like Blender). */
export function baseSize(inputs: Val[]): { w: number; h: number } | null {
  for (const v of inputs) if (isImg(v)) return { w: v.img.w, h: v.img.h };
  return null;
}

/**
 * Per-pixel operation. `ins` are converted to the requested channel counts; `fn` receives the pixel
 * values of each input and writes `outCh` channels for each output.
 */
export function mapPixels(ins: Val[], inCh: number[], outCh: number[], fn: (px: Float32Array[], out: Float32Array[], x: number, y: number) => void): Val[] {
  const conv = ins.map((v, i) => convert(v, inCh[i]));
  const px = inCh.map((c) => new Float32Array(c));
  const ob = outCh.map((c) => new Float32Array(c));
  const size = baseSize(conv);
  if (!size) {
    conv.forEach((v, i) => samplePixel(v, 0, 0, 1, 1, px[i]));
    fn(px, ob, 0, 0);
    return ob.map((o) => ({ c: Array.from(o) }));
  }
  const { w, h } = size;
  const outs = outCh.map((c) => newImg(w, h, c));
  // fast paths for inputs of the same size
  const direct = conv.map((v) => isImg(v) && v.img.w === w && v.img.h === h ? v.img : null);
  for (let i = 0; i < conv.length; i++) if (!isImg(conv[i])) samplePixel(conv[i], 0, 0, w, h, px[i]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      for (let i = 0; i < conv.length; i++) {
        const d = direct[i];
        if (d) { const o = p * d.ch, t = px[i]; for (let c = 0; c < d.ch; c++) t[c] = d.data[o + c]; }
        else if (isImg(conv[i])) samplePixel(conv[i], x, y, w, h, px[i]);
      }
      fn(px, ob, x, y);
      for (let k = 0; k < outs.length; k++) { const o = outs[k], b = ob[k]; const oo = p * o.ch; for (let c = 0; c < o.ch; c++) o.data[oo + c] = b[c]; }
    }
  }
  return outs.map((img) => ({ img }));
}

export function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }

// ------------------------------------------------------------------ colour space

export function srgbToLinear(c: number): number { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
export function linearToSrgb(c: number): number { return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; }

const SRGB_LUT = new Float32Array(256);
for (let i = 0; i < 256; i++) SRGB_LUT[i] = srgbToLinear(i / 255);

/** 8-bit sRGB canvas pixels (straight alpha, top row first) to a linear premultiplied RGBA image. */
export function imageDataToImg(d: ImageData): Img {
  const img = newImg(d.width, d.height, 4);
  const w = d.width, h = d.height, src = d.data, dst = img.data;
  for (let y = 0; y < h; y++) {
    const sy = h - 1 - y;
    for (let x = 0; x < w; x++) {
      const s = (sy * w + x) * 4, o = (y * w + x) * 4;
      const a = src[s + 3] / 255;
      dst[o] = SRGB_LUT[src[s]] * a; dst[o + 1] = SRGB_LUT[src[s + 1]] * a; dst[o + 2] = SRGB_LUT[src[s + 2]] * a; dst[o + 3] = a;
    }
  }
  return img;
}

export function canvasToImg(c: HTMLCanvasElement | HTMLImageElement | HTMLVideoElement | ImageBitmap, w?: number, h?: number): Img {
  const cw = w ?? ((c as HTMLVideoElement).videoWidth || (c as HTMLImageElement).naturalWidth || c.width);
  const chh = h ?? ((c as HTMLVideoElement).videoHeight || (c as HTMLImageElement).naturalHeight || c.height);
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, cw); cv.height = Math.max(1, chh);
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(c, 0, 0, cv.width, cv.height);
  return imageDataToImg(ctx.getImageData(0, 0, cv.width, cv.height));
}

/** Linear premultiplied image to 8-bit sRGB ImageData (top row first). `alpha` false makes it opaque. */
export function imgToImageData(src: Img, alpha = true): ImageData {
  const img = src.ch === 4 ? src : (convert({ img: src }, 4) as { img: Img }).img;
  const w = img.w, h = img.h;
  const out = new ImageData(Math.max(1, w), Math.max(1, h));
  const d = out.data, s = img.data;
  for (let y = 0; y < h; y++) {
    const dy = h - 1 - y;
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4, p = (dy * w + x) * 4;
      let a = s[o + 3];
      a = a < 0 ? 0 : a > 1 ? 1 : a;
      const inv = alpha && a > 1e-6 ? 1 / a : 1;
      d[p] = Math.round(clamp01(linearToSrgb(Math.max(0, s[o] * inv))) * 255);
      d[p + 1] = Math.round(clamp01(linearToSrgb(Math.max(0, s[o + 1] * inv))) * 255);
      d[p + 2] = Math.round(clamp01(linearToSrgb(Math.max(0, s[o + 2] * inv))) * 255);
      d[p + 3] = alpha ? Math.round(a * 255) : 255;
    }
  }
  return out;
}

export function imgToCanvas(img: Img, alpha = true, canvas?: HTMLCanvasElement): HTMLCanvasElement {
  const c = canvas ?? document.createElement('canvas');
  c.width = Math.max(1, img.w); c.height = Math.max(1, img.h);
  c.getContext('2d')!.putImageData(imgToImageData(img, alpha), 0, 0);
  return c;
}

// ------------------------------------------------------------------ HSV / HSL

export function rgbToHsv(r: number, g: number, b: number, out: number[] | Float32Array): void {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let hh = 0;
  if (d > 1e-8) {
    if (mx === r) hh = ((g - b) / d) % 6;
    else if (mx === g) hh = (b - r) / d + 2;
    else hh = (r - g) / d + 4;
    hh /= 6;
    if (hh < 0) hh += 1;
  }
  out[0] = hh; out[1] = mx > 1e-8 ? d / mx : 0; out[2] = mx;
}

export function hsvToRgb(hh: number, s: number, v: number, out: number[] | Float32Array): void {
  hh = ((hh % 1) + 1) % 1;
  const i = Math.floor(hh * 6), f = hh * 6 - i;
  const p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
  let r = v, g = t, b = p;
  switch (i % 6) {
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    case 5: r = v; g = p; b = q; break;
  }
  out[0] = r; out[1] = g; out[2] = b;
}

// ------------------------------------------------------------------ blend modes (Mix node, Color Ramp, sequencer)

export const BLEND_MODES: [string, string][] = [
  ['MIX', 'Mix'], ['ADD', 'Add'], ['MULTIPLY', 'Multiply'], ['SUBTRACT', 'Subtract'], ['SCREEN', 'Screen'], ['DIVIDE', 'Divide'],
  ['DIFFERENCE', 'Difference'], ['DARKEN', 'Darken'], ['LIGHTEN', 'Lighten'], ['OVERLAY', 'Overlay'], ['DODGE', 'Dodge'], ['BURN', 'Burn'],
  ['HUE', 'Hue'], ['SATURATION', 'Saturation'], ['VALUE', 'Value'], ['COLOR', 'Color'], ['SOFT_LIGHT', 'Soft Light'], ['LINEAR_LIGHT', 'Linear Light'],
];

const hA = [0, 0, 0], hB = [0, 0, 0], tmp3 = [0, 0, 0];

/** Blend colour `b` over `a` (both RGB, in place in `a`) with factor `fac` (Blender's ramp_blend). */
export function blendRGB(mode: string, a: number[] | Float32Array, b: ArrayLike<number>, fac: number): void {
  const facm = 1 - fac;
  switch (mode) {
    case 'MIX': for (let i = 0; i < 3; i++) a[i] = facm * a[i] + fac * b[i]; break;
    case 'ADD': for (let i = 0; i < 3; i++) a[i] += fac * b[i]; break;
    case 'MULTIPLY': for (let i = 0; i < 3; i++) a[i] *= facm + fac * b[i]; break;
    case 'SUBTRACT': for (let i = 0; i < 3; i++) a[i] -= fac * b[i]; break;
    case 'SCREEN': for (let i = 0; i < 3; i++) a[i] = 1 - (facm + fac * (1 - b[i])) * (1 - a[i]); break;
    case 'DIVIDE': for (let i = 0; i < 3; i++) if (b[i] !== 0) a[i] = facm * a[i] + fac * a[i] / b[i]; break;
    case 'DIFFERENCE': for (let i = 0; i < 3; i++) a[i] = facm * a[i] + fac * Math.abs(a[i] - b[i]); break;
    case 'DARKEN': for (let i = 0; i < 3; i++) a[i] = facm * a[i] + fac * Math.min(a[i], b[i]); break;
    case 'LIGHTEN': for (let i = 0; i < 3; i++) a[i] = facm * a[i] + fac * Math.max(a[i], b[i]); break;
    case 'OVERLAY': for (let i = 0; i < 3; i++) a[i] = a[i] < 0.5 ? a[i] * (facm + 2 * fac * b[i]) : 1 - (facm + 2 * fac * (1 - b[i])) * (1 - a[i]); break;
    case 'DODGE':
      for (let i = 0; i < 3; i++) {
        if (a[i] === 0) continue;
        const t = 1 - fac * b[i];
        a[i] = t <= 0 ? 1 : Math.min(1, a[i] / t);
      }
      break;
    case 'BURN':
      for (let i = 0; i < 3; i++) {
        const t = facm + fac * b[i];
        a[i] = t <= 0 ? 0 : clamp01(1 - (1 - a[i]) / t);
      }
      break;
    case 'HUE': {
      rgbToHsv(b[0], b[1], b[2], hB);
      if (hB[1] !== 0) {
        rgbToHsv(a[0], a[1], a[2], hA);
        hsvToRgb(hB[0], hA[1], hA[2], tmp3);
        for (let i = 0; i < 3; i++) a[i] = facm * a[i] + fac * tmp3[i];
      }
      break;
    }
    case 'SATURATION': {
      rgbToHsv(a[0], a[1], a[2], hA);
      if (hA[1] !== 0) {
        rgbToHsv(b[0], b[1], b[2], hB);
        hsvToRgb(hA[0], facm * hA[1] + fac * hB[1], hA[2], tmp3);
        for (let i = 0; i < 3; i++) a[i] = tmp3[i];
      }
      break;
    }
    case 'VALUE': {
      rgbToHsv(a[0], a[1], a[2], hA);
      rgbToHsv(b[0], b[1], b[2], hB);
      hsvToRgb(hA[0], hA[1], facm * hA[2] + fac * hB[2], tmp3);
      for (let i = 0; i < 3; i++) a[i] = tmp3[i];
      break;
    }
    case 'COLOR': {
      rgbToHsv(b[0], b[1], b[2], hB);
      if (hB[1] !== 0) {
        rgbToHsv(a[0], a[1], a[2], hA);
        hsvToRgb(hB[0], hB[1], hA[2], tmp3);
        for (let i = 0; i < 3; i++) a[i] = facm * a[i] + fac * tmp3[i];
      }
      break;
    }
    case 'SOFT_LIGHT':
      for (let i = 0; i < 3; i++) {
        const scr = 1 - (1 - b[i]) * (1 - a[i]);
        a[i] = facm * a[i] + fac * ((1 - a[i]) * b[i] * a[i] + a[i] * scr);
      }
      break;
    case 'LINEAR_LIGHT':
      for (let i = 0; i < 3; i++) a[i] = b[i] > 0.5 ? a[i] + fac * (2 * (b[i] - 0.5)) : a[i] + fac * (2 * b[i] - 1);
      break;
    default: for (let i = 0; i < 3; i++) a[i] = facm * a[i] + fac * b[i];
  }
}

// ------------------------------------------------------------------ curve mapping (RGB Curves, Vector Curves)

export type CurvePoint = [number, number];

export interface CurveMapping {
  /** Combined (C), R, G, B curves (or X, Y, Z for vector curves). */
  curves: CurvePoint[][];
  black: number[];
  white: number[];
  active: number;
  /** Selected point index in the active curve. */
  sel: number;
}

export function defaultCurveMapping(n = 4): CurveMapping {
  return { curves: Array.from({ length: n }, () => [[0, 0], [1, 1]] as CurvePoint[]), black: [0, 0, 0], white: [1, 1, 1], active: 0, sel: -1 };
}

/** Smooth monotone curve through the points (Fritsch-Carlson), horizontal extension outside. */
export function curveLUT(pts: CurvePoint[], n = 256): Float32Array {
  const p = pts.slice().sort((a, b) => a[0] - b[0]);
  const lut = new Float32Array(n);
  if (p.length === 1) { lut.fill(p[0][1]); return lut; }
  const k = p.length;
  const d: number[] = [], m: number[] = new Array(k).fill(0);
  for (let i = 0; i < k - 1; i++) d.push((p[i + 1][1] - p[i][1]) / Math.max(1e-6, p[i + 1][0] - p[i][0]));
  m[0] = d[0]; m[k - 1] = d[k - 2];
  for (let i = 1; i < k - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < k - 1; i++) {
    if (Math.abs(d[i]) < 1e-9) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  for (let j = 0; j < n; j++) {
    const x = j / (n - 1);
    if (x <= p[0][0]) { lut[j] = p[0][1]; continue; }
    if (x >= p[k - 1][0]) { lut[j] = p[k - 1][1]; continue; }
    let i = 0;
    while (i < k - 2 && x > p[i + 1][0]) i++;
    const hh = p[i + 1][0] - p[i][0], t = (x - p[i][0]) / hh;
    const t2 = t * t, t3 = t2 * t;
    lut[j] = (2 * t3 - 3 * t2 + 1) * p[i][1] + (t3 - 2 * t2 + t) * hh * m[i] + (-2 * t3 + 3 * t2) * p[i + 1][1] + (t3 - t2) * hh * m[i + 1];
  }
  return lut;
}

export function lutEval(lut: Float32Array, x: number): number {
  const n = lut.length - 1;
  if (x <= 0) return lut[0] + (x < 0 ? 0 : 0);
  if (x >= 1) return lut[n];
  const f = x * n, i = Math.floor(f), t = f - i;
  return lut[i] * (1 - t) + lut[Math.min(n, i + 1)] * t;
}

// ------------------------------------------------------------------ colour ramp

export interface ColorRampData {
  interpolation: 'EASE' | 'CARDINAL' | 'LINEAR' | 'B_SPLINE' | 'CONSTANT';
  colorMode: 'RGB' | 'HSV' | 'HSL';
  elements: { pos: number; color: number[] }[];
  active: number;
}

export function defaultColorRamp(): ColorRampData {
  return { interpolation: 'LINEAR', colorMode: 'RGB', elements: [{ pos: 0, color: [0, 0, 0, 1] }, { pos: 1, color: [1, 1, 1, 1] }], active: 0 };
}

export function evalColorRamp(r: ColorRampData, t: number, out: number[] | Float32Array): void {
  const els = r.elements.slice().sort((a, b) => a.pos - b.pos);
  if (!els.length) { out[0] = out[1] = out[2] = 0; out[3] = 1; return; }
  if (t <= els[0].pos) { for (let i = 0; i < 4; i++) out[i] = els[0].color[i]; return; }
  const last = els[els.length - 1];
  if (t >= last.pos) { for (let i = 0; i < 4; i++) out[i] = last.color[i]; return; }
  let i = 0;
  while (i < els.length - 2 && t > els[i + 1].pos) i++;
  const a = els[i], b = els[i + 1];
  let f = (t - a.pos) / Math.max(1e-9, b.pos - a.pos);
  if (r.interpolation === 'CONSTANT') { for (let k = 0; k < 4; k++) out[k] = a.color[k]; return; }
  if (r.interpolation === 'EASE') f = f * f * (3 - 2 * f);
  else if (r.interpolation === 'B_SPLINE' || r.interpolation === 'CARDINAL') f = f * f * (3 - 2 * f) * 0.5 + f * 0.5;
  if (r.colorMode !== 'RGB') {
    const ha = [0, 0, 0], hb = [0, 0, 0];
    rgbToHsv(a.color[0], a.color[1], a.color[2], ha);
    rgbToHsv(b.color[0], b.color[1], b.color[2], hb);
    let dh = hb[0] - ha[0];
    if (dh > 0.5) dh -= 1; else if (dh < -0.5) dh += 1;
    hsvToRgb(ha[0] + dh * f, ha[1] + (hb[1] - ha[1]) * f, ha[2] + (hb[2] - ha[2]) * f, out);
    out[3] = a.color[3] + (b.color[3] - a.color[3]) * f;
    return;
  }
  for (let k = 0; k < 4; k++) out[k] = a.color[k] + (b.color[k] - a.color[k]) * f;
}

// ------------------------------------------------------------------ filters

/** Separable blur in place on a copy. `kernel` returns weights for offsets 0..r. */
function separable(img: Img, rx: number, ry: number, weight: (t: number) => number): Img {
  const pass = (src: Img, r: number, horizontal: boolean): Img => {
    if (r < 0.5) return src;
    const rad = Math.ceil(r);
    const ws: number[] = [];
    let sum = 0;
    for (let i = -rad; i <= rad; i++) { const v = weight(Math.abs(i) / (r + 1e-9)); ws.push(v); sum += v; }
    for (let i = 0; i < ws.length; i++) ws[i] /= sum || 1;
    const out = newImg(src.w, src.h, src.ch);
    const { w, h, ch } = src;
    const s = src.data, d = out.data;
    const acc = new Float32Array(ch);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        acc.fill(0);
        let wsum = 0;
        for (let k = -rad; k <= rad; k++) {
          const xx = horizontal ? x + k : x, yy = horizontal ? y : y + k;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const wt = ws[k + rad];
          wsum += wt;
          const o = (yy * w + xx) * ch;
          for (let c = 0; c < ch; c++) acc[c] += s[o + c] * wt;
        }
        const o = (y * w + x) * ch;
        const inv = wsum > 0 ? 1 / wsum : 0;
        for (let c = 0; c < ch; c++) d[o + c] = acc[c] * inv;
      }
    }
    return out;
  };
  return pass(pass(img, rx, true), ry, false);
}

/** Box blur using running sums (fast for large radii). */
function boxBlur(img: Img, rx: number, ry: number): Img {
  const pass = (src: Img, r: number, horizontal: boolean): Img => {
    const rad = Math.round(r);
    if (rad < 1) return src;
    const out = newImg(src.w, src.h, src.ch);
    const { w, h, ch } = src;
    const s = src.data, d = out.data;
    const len = horizontal ? w : h, lines = horizontal ? h : w;
    const acc = new Float64Array(ch);
    for (let line = 0; line < lines; line++) {
      const idx = (i: number) => (horizontal ? line * w + i : i * w + line) * ch;
      acc.fill(0);
      let count = 0;
      for (let i = 0; i <= Math.min(rad, len - 1); i++) { const o = idx(i); for (let c = 0; c < ch; c++) acc[c] += s[o + c]; count++; }
      for (let i = 0; i < len; i++) {
        const o = idx(i);
        for (let c = 0; c < ch; c++) d[o + c] = acc[c] / count;
        const add = i + rad + 1, rem = i - rad;
        if (add < len) { const a = idx(add); for (let c = 0; c < ch; c++) acc[c] += s[a + c]; count++; }
        if (rem >= 0) { const r2 = idx(rem); for (let c = 0; c < ch; c++) acc[c] -= s[r2 + c]; count--; }
      }
    }
    return out;
  };
  return pass(pass(img, rx, true), ry, false);
}

export type BlurFilter = 'FLAT' | 'TENT' | 'QUAD' | 'CUBIC' | 'GAUSS' | 'FAST_GAUSS' | 'CATROM' | 'MITCH';

export function blur(img: Img, rx: number, ry: number, filter: BlurFilter = 'GAUSS'): Img {
  if (rx < 0.5 && ry < 0.5) return img;
  switch (filter) {
    case 'FLAT': return boxBlur(img, rx, ry);
    case 'FAST_GAUSS': return boxBlur(boxBlur(boxBlur(img, rx / 1.7, ry / 1.7), rx / 1.7, ry / 1.7), rx / 1.7, ry / 1.7);
    case 'TENT': return separable(img, rx, ry, (t) => Math.max(0, 1 - t));
    case 'QUAD': return separable(img, rx, ry, (t) => Math.max(0, 1 - t * t));
    case 'CUBIC': return separable(img, rx, ry, (t) => { const u = Math.max(0, 1 - t); return u * u * u; });
    case 'CATROM': case 'MITCH': return separable(img, rx, ry, (t) => { const x = t * 2; return x < 1 ? 1.5 * x * x * x - 2.5 * x * x + 1 : x < 2 ? Math.max(0, -0.5 * x * x * x + 2.5 * x * x - 4 * x + 2) : 0; });
    default: return separable(img, rx, ry, (t) => Math.exp(-t * t * 4.5));
  }
}

/** 3x3 convolution (kernel rows top to bottom as seen on screen). */
export function convolve3(img: Img, k: number[], out?: Img, absolute = false): Img {
  const o = out ?? newImg(img.w, img.h, img.ch);
  const { w, h, ch } = img;
  const s = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < ch; c++) {
        let acc = 0;
        for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
          const xx = Math.min(w - 1, Math.max(0, x + i)), yy = Math.min(h - 1, Math.max(0, y - j));
          acc += s[(yy * w + xx) * ch + c] * k[(j + 1) * 3 + (i + 1)];
        }
        o.data[(y * w + x) * ch + c] = absolute ? Math.abs(acc) : acc;
      }
    }
  }
  return o;
}

export function copyImg(img: Img): Img { return { w: img.w, h: img.h, ch: img.ch, data: new Float32Array(img.data) }; }
