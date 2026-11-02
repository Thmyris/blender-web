// Number formatting (with Blender's unit display rules) and a safe expression
// evaluator for values typed into number fields.

import type { UnitSettings } from '../core/types';

export type UnitType = 'NONE' | 'LENGTH' | 'ROTATION' | 'PERCENTAGE' | 'PIXEL' | 'TIME' | 'CAMERA' | 'FACTOR' | 'FRAMES' | 'MASS' | 'ACCELERATION';

let unitSettings: UnitSettings = { system: 'NONE', systemRotation: 'DEGREES', scaleLength: 1, useSeparate: false };

export function setUnitSettings(u: UnitSettings): void { unitSettings = u; }
export function getUnitSettings(): UnitSettings { return unitSettings; }

function integerDigits(v: number): number {
  const a = Math.abs(v);
  return a < 1 ? 0 : Math.floor(Math.log10(a)) + 1;
}

function strip(s: string): string {
  if (!s.includes('.')) return s;
  return s.replace(/0+$/, '').replace(/\.$/, '');
}

/** Blender adjusts the precision of unit values to a number of significant digits and strips trailing zeros. */
function unitString(value: number, prec: number, suffix: string): string {
  let p = prec - integerDigits(value);
  p = Math.min(6, Math.max(0, p));
  let s = strip(value.toFixed(p));
  if (s === '-0') s = '0';
  return `${s}${suffix}`;
}

const LENGTH_METRIC: [number, string][] = [[1000, ' km'], [1, ' m'], [0.01, ' cm'], [0.001, ' mm'], [1e-6, ' µm']];

/** Format a value for display in a number field. */
export function formatValue(value: number, unit: UnitType = 'NONE', precision = 3, isInt = false): string {
  if (!isFinite(value)) return String(value);
  if (isInt) return String(Math.round(value));
  switch (unit) {
    case 'ROTATION':
      if (unitSettings.systemRotation === 'RADIANS') return unitString(value, Math.max(precision, 3), '');
      return unitString((value * 180) / Math.PI, Math.max(precision, 3), '°');
    case 'LENGTH': {
      if (unitSettings.system === 'NONE') return fixed(value, precision);
      const v = value * unitSettings.scaleLength;
      if (unitSettings.system === 'IMPERIAL') {
        const ft = v / 0.3048;
        if (Math.abs(ft) >= 1 || v === 0) return unitString(ft, Math.max(precision, 5), "'");
        return unitString(v / 0.0254, Math.max(precision, 5), '"');
      }
      const a = Math.abs(v);
      for (const [f, s] of LENGTH_METRIC) if (a >= f || f === 1e-6) {
        if (v === 0) return '0 m';
        return unitString(v / f, Math.max(precision, 5), s);
      }
      return fixed(v, precision);
    }
    case 'CAMERA':
      return `${fixed(value, precision)}`;
    case 'PERCENTAGE':
      return `${Math.round(value)}%`;
    case 'PIXEL':
      return `${fixed(value, precision)} px`;
    case 'TIME':
      return fixed(value, precision);
    case 'MASS':
      return unitSettings.system === 'NONE' ? fixed(value, precision) : unitString(value, Math.max(precision, 5), ' kg');
    case 'ACCELERATION':
      return unitSettings.system === 'NONE' ? fixed(value, precision) : unitString(value, Math.max(precision, 5), ' m/s²');
    default:
      return fixed(value, precision);
  }
}

function fixed(v: number, p: number): string {
  const s = v.toFixed(Math.max(0, Math.min(10, p)));
  return s === `-${(0).toFixed(p)}` ? (0).toFixed(p) : s;
}

/** Value shown when entering text edit (full precision, display units). */
export function editString(value: number, unit: UnitType, isInt: boolean): string {
  if (isInt) return String(Math.round(value));
  if (unit === 'ROTATION' && unitSettings.systemRotation === 'DEGREES') return strip(((value * 180) / Math.PI).toFixed(6));
  if (unit === 'LENGTH' && unitSettings.system !== 'NONE') return strip((value * unitSettings.scaleLength).toFixed(6));
  return strip(value.toFixed(6));
}

// ------------------------------------------------------------------ expression evaluation

type Tok = { t: 'num'; v: number } | { t: 'id'; v: string } | { t: 'op'; v: string };

const FUNCS: Record<string, (...a: number[]) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
  sqrt: Math.sqrt, abs: Math.abs, floor: Math.floor, ceil: Math.ceil, round: Math.round, log: Math.log, exp: Math.exp,
  pow: Math.pow, min: Math.min, max: Math.max, radians: (d) => (d * Math.PI) / 180, degrees: (r) => (r * 180) / Math.PI,
};
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 };
const UNIT_FACTORS: Record<string, number> = {
  km: 1000, m: 1, cm: 0.01, mm: 0.001, um: 1e-6, ft: 0.3048, "'": 0.3048, in: 0.0254, '"': 0.0254, mi: 1609.344, yd: 0.9144,
};

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9.]/.test(ch)) {
      const m = /^(\d*\.?\d+(?:[eE][-+]?\d+)?|\d+\.)/.exec(src.slice(i));
      if (!m) throw new Error('bad number');
      out.push({ t: 'num', v: parseFloat(m[1]) });
      i += m[1].length;
      continue;
    }
    if (/[a-zA-Z_µ]/.test(ch)) {
      const m = /^[a-zA-Z_µ][a-zA-Z_0-9]*/.exec(src.slice(i))!;
      out.push({ t: 'id', v: m[0] });
      i += m[0].length;
      continue;
    }
    if (src.startsWith('**', i)) { out.push({ t: 'op', v: '^' }); i += 2; continue; }
    if ('+-*/^(),%\'"°'.includes(ch)) { out.push({ t: 'op', v: ch }); i++; continue; }
    throw new Error(`unexpected "${ch}"`);
  }
  return out;
}

/**
 * Evaluate a Python-like arithmetic expression ("2*pi", "1m + 20cm", "90°").
 * `unit` gives the context: rotations are entered in degrees, lengths in scene units.
 */
export function evalExpression(src: string, unit: UnitType = 'NONE'): number {
  const toks = tokenize(src.replace(/,(?=\d{3}\b)/g, ''));
  let pos = 0;
  let sawUnit = false;
  const peek = () => toks[pos];
  const next = () => toks[pos++];
  const expect = (v: string) => { const t = next(); if (!t || t.t !== 'op' || t.v !== v) throw new Error(`expected ${v}`); };

  function primary(): number {
    const t = next();
    if (!t) throw new Error('unexpected end');
    if (t.t === 'num') return postfixUnit(t.v);
    if (t.t === 'op' && t.v === '(') { const v = expr(); expect(')'); return postfixUnit(v); }
    if (t.t === 'op' && t.v === '-') return -unary();
    if (t.t === 'op' && t.v === '+') return unary();
    if (t.t === 'id') {
      if (FUNCS[t.v] && peek()?.t === 'op' && (peek() as { v: string }).v === '(') {
        next();
        const args: number[] = [];
        if (!(peek()?.t === 'op' && (peek() as { v: string }).v === ')')) {
          args.push(expr());
          while (peek()?.t === 'op' && (peek() as { v: string }).v === ',') { next(); args.push(expr()); }
        }
        expect(')');
        return postfixUnit(FUNCS[t.v](...args));
      }
      if (t.v in CONSTS) return postfixUnit(CONSTS[t.v]);
      throw new Error(`unknown name "${t.v}"`);
    }
    throw new Error('syntax error');
  }
  function postfixUnit(v: number): number {
    const t = peek();
    if (!t) return v;
    if (t.t === 'id' && t.v in UNIT_FACTORS) { next(); sawUnit = true; return v * UNIT_FACTORS[t.v]; }
    if (t.t === 'op' && (t.v === "'" || t.v === '"')) { next(); sawUnit = true; return v * UNIT_FACTORS[t.v]; }
    if (t.t === 'op' && t.v === '°') { next(); return v; }
    if (t.t === 'id' && (t.v === 'd' || t.v === 'deg')) { next(); return v; }
    if (t.t === 'id' && (t.v === 'r' || t.v === 'rad')) { next(); return (v * 180) / Math.PI; }
    return v;
  }
  function unary(): number { return power(); }
  function power(): number {
    const b = primary();
    if (peek()?.t === 'op' && (peek() as { v: string }).v === '^') { next(); return Math.pow(b, unary()); }
    return b;
  }
  function term(): number {
    let v = unary();
    for (;;) {
      const t = peek();
      if (t?.t === 'op' && (t.v === '*' || t.v === '/' || t.v === '%')) {
        next();
        const r = unary();
        v = t.v === '*' ? v * r : t.v === '/' ? v / r : v % r;
      } else if (t && (t.t === 'num' || (t.t === 'op' && t.v === '('))) {
        v = v + unary(); // "1m 20cm" style concatenation adds
      } else return v;
    }
  }
  function expr(): number {
    let v = term();
    for (;;) {
      const t = peek();
      if (t?.t === 'op' && (t.v === '+' || t.v === '-')) { next(); const r = term(); v = t.v === '+' ? v + r : v - r; } else return v;
    }
  }
  const result = expr();
  if (pos < toks.length) throw new Error('syntax error');
  if (!isFinite(result)) throw new Error('not a number');
  // convert from display units back to internal values
  if (unit === 'ROTATION') return unitSettings.systemRotation === 'DEGREES' ? (result * Math.PI) / 180 : result;
  if (unit === 'LENGTH' && unitSettings.system !== 'NONE') return sawUnit ? result / unitSettings.scaleLength : result / unitSettings.scaleLength;
  return result;
}

/** Convert a 0..1 linear colour channel to a hex byte (Blender 2.79 shows display-space hex). */
export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function colorToCss(rgb: number[], alpha = 1): string {
  const r = Math.round(Math.min(1, Math.max(0, linearToSrgb(rgb[0]))) * 255);
  const g = Math.round(Math.min(1, Math.max(0, linearToSrgb(rgb[1]))) * 255);
  const b = Math.round(Math.min(1, Math.max(0, linearToSrgb(rgb[2]))) * 255);
  return alpha >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha})`;
}

export function colorToHex(rgb: number[]): string {
  return rgb.slice(0, 3).map((c) => Math.round(Math.min(1, Math.max(0, linearToSrgb(c))) * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
}

export function hexToColor(hex: string): number[] | null {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim());
  if (!m) return null;
  let s = m[1];
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => srgbToLinear(parseInt(s.slice(i, i + 2), 16) / 255));
}

export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let hh = 0;
  if (d > 1e-9) {
    if (max === r) hh = ((g - b) / d) % 6;
    else if (max === g) hh = (b - r) / d + 2;
    else hh = (r - g) / d + 4;
    hh /= 6;
    if (hh < 0) hh += 1;
  }
  return [hh, max <= 0 ? 0 : d / max, max];
}

export function hsvToRgb(hh: number, s: number, v: number): [number, number, number] {
  const i = Math.floor(hh * 6);
  const f = hh * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  switch (((i % 6) + 6) % 6) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q];
  }
}
