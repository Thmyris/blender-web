// Text objects (Blender's FONT type): the text and its settings live on the object. Glyph outlines
// come from the bundled DejaVu Sans subset (Blender's "Bfont" is derived from DejaVu Sans) or from
// fonts loaded into the document (VectorFont datablocks, parsed by ttf.ts). Each character is laid
// out on its own (fonts per style, small caps, spacing, underline, material per character, text on
// a curve) and extruded with three's ExtrudeGeometry.

import { BufferGeometry, ExtrudeGeometry, Shape, ShapeGeometry, type Vector2 } from 'three';
import { Font } from 'three/examples/jsm/loaders/FontLoader.js';
import type { BObject, Doc, TextData, Vec3 } from './types';
import type { Spline } from './curvetypes';
export type { TextData } from './types';
import { modifierDef, type EvalMesh } from './modifiers';
import { base64ToBuffer, parseFontFile, type TypefaceData } from './ttf';
import { buildPath, curveVec, newBezierPoint, newSpline, pathAt, type CurvePath } from './curve';

/** Character style flags (TextData.charFormat). */
export const STYLE_BOLD = 1, STYLE_ITALIC = 2, STYLE_UNDERLINE = 4, STYLE_SMALLCAPS = 8;

export function defaultTextData(): TextData {
  return { body: 'Text', size: 1, extrude: 0, bevelDepth: 0, bevelResolution: 0, resolution: 12, align: 'LEFT', lineSpacing: 1, shearX: 0, offsetX: 0, offsetY: 0, cursor: 4 };
}

// ------------------------------------------------------------------ fonts

let bfont: Font | null = null;
let loading: Promise<Font> | null = null;
const loadListeners = new Set<() => void>();
export function onFontLoaded(fn: () => void): void { loadListeners.add(fn); }

/** Load the built-in font (Bfont). */
export function loadFont(): Promise<Font> {
  if (bfont) return Promise.resolve(bfont);
  loading ??= (async () => {
    const data = await import('../assets/fonts/dejavu-sans.typeface.json');
    bfont = new Font(((data as { default: unknown }).default ?? data) as never);
    for (const l of loadListeners) l();
    return bfont;
  })();
  return loading;
}

const vfontCache = new Map<string, Font | null>();

/** Parse a font file (base64) into a three Font; throws on unsupported files. */
export function parseVFont(b64: string): Font {
  const data: TypefaceData = parseFontFile(base64ToBuffer(b64));
  return new Font(data as never);
}

/** Font of a VectorFont datablock id (null id or failures fall back to Bfont). */
export function fontById(doc: Doc | undefined, id: string | null | undefined): Font | null {
  if (!id || !doc) return bfont;
  const vf = doc.fonts?.[id];
  if (!vf) return bfont;
  const key = `${id}:${vf.data.length}`;
  if (!vfontCache.has(key)) {
    let f: Font | null = null;
    try { f = parseVFont(vf.data); } catch (err) { console.warn(`Font "${vf.name}" could not be read:`, (err as Error).message); }
    vfontCache.set(key, f);
  }
  return vfontCache.get(key) ?? bfont;
}

function fontIdFor(t: TextData, flags: number): string | null {
  const b = !!(flags & STYLE_BOLD), i = !!(flags & STYLE_ITALIC);
  if (b && i) return t.fontBoldItalic ?? t.font ?? null;
  if (b) return t.fontBold ?? t.font ?? null;
  if (i) return t.fontItalic ?? t.font ?? null;
  return t.font ?? null;
}

// ------------------------------------------------------------------ layout

export interface CharPlace {
  index: number;
  /** Character drawn (small caps turn lower case into upper case). */
  ch: string;
  font: Font;
  fontKey: string;
  /** Glyph size (text size times the small caps scale). */
  size: number;
  /** Left edge and baseline (before shear / offset). */
  x: number;
  y: number;
  adv: number;
  line: number;
  flags: number;
  mat: number;
}

export interface TextLayout {
  chars: CharPlace[];
  /** Cursor anchor per string index (0..body.length): x, baseline y. */
  caret: { x: number; y: number }[];
  lineHeight: number;
  path: CurvePath | null;
}

function glyphAdvance(font: Font, ch: string, size: number): number {
  const d = font.data as unknown as TypefaceData;
  const g = d.glyphs[ch] ?? d.glyphs['?'];
  return g ? (g.ha * size) / d.resolution : size * 0.5;
}

/** Lay out the characters of a text object. Returns null until the built-in font has loaded. */
export function textLayout(ob: BObject, doc?: Doc): TextLayout | null {
  const t = ob.text;
  if (!t) return null;
  if (!bfont) { void loadFont(); return null; }
  const body = t.body || '';
  const fmt = t.charFormat ?? [];
  const mats = t.charMaterial ?? [];
  const lineH = t.size * 1.2 * t.lineSpacing;
  const chars: CharPlace[] = [];
  const caret: { x: number; y: number }[] = [];
  const lines: CharPlace[][] = [[]];
  const lineCarets: number[][] = [[]];
  let x = 0, line = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    caret[i] = { x, y: -line * lineH };
    lineCarets[line].push(i);
    if (c === '\n') { line++; x = 0; lines.push([]); lineCarets.push([]); continue; }
    const flags = fmt[i] ?? 0;
    const fid = fontIdFor(t, flags);
    const font = fontById(doc, fid) ?? bfont;
    let ch = c, size = t.size;
    if (flags & STYLE_SMALLCAPS && c !== c.toUpperCase()) { ch = c.toUpperCase(); size *= t.smallCapsScale ?? 0.75; }
    let adv = glyphAdvance(font, ch, size) * (t.spaceCharacter ?? 1);
    if (c === ' ') adv *= t.spaceWord ?? 1;
    const cp: CharPlace = { index: i, ch, font, fontKey: fid ?? 'BFONT', size, x, y: -line * lineH, adv, line, flags, mat: mats[i] ?? 0 };
    chars.push(cp);
    lines[line].push(cp);
    x += adv;
  }
  caret[body.length] = { x, y: -line * lineH };
  lineCarets[line].push(body.length);
  // alignment per line
  lines.forEach((ln, li) => {
    const w = ln.reduce((s, c) => s + c.adv, 0);
    const dx = t.align === 'CENTER' ? -w / 2 : t.align === 'RIGHT' ? -w : 0;
    if (!dx) return;
    for (const c of ln) c.x += dx;
    for (const ci of lineCarets[li]) if (caret[ci]) caret[ci].x += dx;
  });
  let path: CurvePath | null = null;
  const curveOb = t.followCurve && doc ? doc.objects[t.followCurve] : null;
  if (curveOb && curveOb.type === 'CURVE' && curveOb.data && doc?.curves?.[curveOb.data]) path = buildPath(doc.curves[curveOb.data]);
  return { chars, caret, lineHeight: lineH, path };
}

/** Map a point given relative to a character's anchor (left edge on the baseline) into object space. */
function placePoint(t: TextData, lay: TextLayout, c: { x: number; y: number; adv: number }, gx: number, gy: number, gz: number): Vec3 {
  let x = c.x + gx, y = c.y + gy;
  x += t.shearX * gy;
  x += t.offsetX; y += t.offsetY;
  if (!lay.path || lay.path.total <= 1e-9) return [x, y, gz];
  // text on curve: each character is placed rigidly at the curve point under its centre
  const cx = c.x + c.adv / 2 + t.offsetX;
  const pp = pathAt(lay.path, cx / lay.path.total);
  const f = pp.frame;
  const dx = x - cx;
  return curveVec.add(curveVec.add(curveVec.add(pp.co, curveVec.mul(f.t, dx)), curveVec.mul(f.n, -y)), curveVec.mul(f.u, gz));
}

// ------------------------------------------------------------------ geometry

interface GlyphGeom { verts: Vec3[]; faces: number[][] }
const glyphCache = new Map<string, GlyphGeom>();

function shapesGeometry(shapes: Shape[], t: TextData): GlyphGeom {
  const seg = Math.max(1, Math.round(t.resolution / 3));
  let geom: BufferGeometry;
  if (t.extrude <= 0 && t.bevelDepth <= 0) geom = new ShapeGeometry(shapes, seg);
  else {
    geom = new ExtrudeGeometry(shapes, {
      depth: t.extrude * 2, curveSegments: seg, bevelEnabled: t.bevelDepth > 0, bevelThickness: t.bevelDepth, bevelSize: t.bevelDepth,
      bevelSegments: Math.max(1, t.bevelResolution + 1),
    });
  }
  const pos = geom.getAttribute('position');
  const index = geom.getIndex();
  const verts: Vec3[] = [];
  const faces: number[][] = [];
  const map = new Map<string, number>();
  const idx: number[] = [];
  const zOff = t.extrude <= 0 && t.bevelDepth <= 0 ? 0 : -t.extrude; // extruded symmetrically around the text plane
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i) + zOff;
    const k = `${x.toFixed(5)},${y.toFixed(5)},${z.toFixed(5)}`;
    let vi = map.get(k);
    if (vi === undefined) { vi = verts.length; verts.push([x, y, z]); map.set(k, vi); }
    idx.push(vi);
  }
  const tri = index ? Array.from(index.array as ArrayLike<number>) : idx.map((_, i) => i);
  for (let i = 0; i + 2 < tri.length; i += 3) {
    const f = [idx[tri[i]], idx[tri[i + 1]], idx[tri[i + 2]]];
    if (f[0] !== f[1] && f[1] !== f[2] && f[0] !== f[2]) faces.push(f);
  }
  geom.dispose();
  return { verts, faces };
}

function glyphGeometry(c: CharPlace, t: TextData): GlyphGeom | null {
  if (c.ch === ' ' || c.ch === '\t') return null;
  const key = [c.fontKey, c.ch, c.size, t.extrude, t.bevelDepth, t.bevelResolution, t.resolution].join('|');
  let g = glyphCache.get(key);
  if (!g) {
    const shapes = c.font.generateShapes(c.ch, c.size);
    g = shapes.length ? shapesGeometry(shapes, t) : { verts: [], faces: [] };
    if (glyphCache.size > 2000) glyphCache.clear();
    glyphCache.set(key, g);
  }
  return g;
}

/** Underline boxes: runs of underlined characters on the same line. */
function underlineRuns(lay: TextLayout): { x: number; y: number; adv: number; mat: number }[] {
  const out: { x: number; y: number; adv: number; mat: number }[] = [];
  let run: { x: number; y: number; adv: number; mat: number; line: number } | null = null;
  for (const c of lay.chars) {
    if (c.flags & STYLE_UNDERLINE) {
      if (run && run.line === c.line && Math.abs(run.x + run.adv - c.x) < 1e-6) run.adv += c.adv;
      else { if (run) out.push(run); run = { x: c.x, y: c.y, adv: c.adv, mat: c.mat, line: c.line }; }
    } else if (run) { out.push(run); run = null; }
  }
  if (run) out.push(run);
  return out;
}

const meshCache = new Map<string, EvalMesh>();
const EMPTY: EvalMesh = { verts: [], faces: [], looseEdges: [], faceSmooth: [], faceMat: [] };

/** Evaluated mesh of a text object (empty until the font has loaded). */
export function textEvalMesh(ob: BObject, doc?: Doc, opts: { render?: boolean; frame?: number } = {}): EvalMesh | null {
  const t = ob.text;
  if (!t) return null;
  if (!bfont) { void loadFont(); return EMPTY; }
  const curveOb = t.followCurve && doc ? doc.objects[t.followCurve] : null;
  const fontKeys = [t.font, t.fontBold, t.fontItalic, t.fontBoldItalic].map((id) => (id && doc?.fonts?.[id] ? `${id}:${doc.fonts[id].data.length}` : ''));
  const key = JSON.stringify([t.body, t.size, t.extrude, t.bevelDepth, t.bevelResolution, t.resolution, t.align, t.lineSpacing, t.shearX, t.offsetX, t.offsetY, t.charFormat, t.charMaterial,
    t.smallCapsScale, t.spaceCharacter, t.spaceWord, t.underlinePosition, t.underlineHeight, fontKeys, t.materials?.length ?? 0,
    curveOb?.data ? JSON.stringify(doc?.curves?.[curveOb.data] ?? null) : '', ob.modifiers, opts.render ?? false]);
  const ck = `${ob.id}|${opts.render ?? false}`;
  const hit = meshCache.get(ck);
  if (hit && (hit as EvalMesh & { _key?: string })._key === key) return hit;
  const lay = textLayout(ob, doc);
  if (!lay) return EMPTY;
  const verts: Vec3[] = [], faces: number[][] = [], faceMat: number[] = [];
  const nMat = Math.max(1, t.materials?.length ?? 0);
  const addGeom = (g: GlyphGeom, c: { x: number; y: number; adv: number }, mat: number) => {
    const base = verts.length;
    for (const v of g.verts) verts.push(placePoint(t, lay, c, v[0], v[1], v[2]));
    for (const f of g.faces) { faces.push(f.map((i) => i + base)); faceMat.push(Math.min(nMat - 1, Math.max(0, mat))); }
  };
  for (const c of lay.chars) { const g = glyphGeometry(c, t); if (g) addGeom(g, c, c.mat); }
  // underline
  const ulPos = t.underlinePosition ?? 0, ulH = t.underlineHeight ?? 0.05;
  for (const r of underlineRuns(lay)) {
    const top = (ulPos - 0.08) * t.size, h = Math.max(1e-4, ulH * t.size);
    const sh = new Shape();
    sh.moveTo(0, top - h); sh.lineTo(r.adv, top - h); sh.lineTo(r.adv, top); sh.lineTo(0, top); sh.closePath();
    addGeom(shapesGeometry([sh], t), r, r.mat);
  }
  let m: EvalMesh = { verts, faces, looseEdges: [], faceSmooth: faces.map(() => false), faceMat };
  for (const mod of ob.modifiers) {
    if (opts.render ? !mod.showRender : !mod.showViewport) continue;
    const def = modifierDef(mod.type);
    if (!def?.apply || !m.verts.length) continue;
    try { m = def.apply(m, mod, { frame: opts.frame ?? 1, render: !!opts.render, editMode: false, ob, doc }); } catch (err) { console.warn('modifier failed', mod.type, err); }
  }
  (m as EvalMesh & { _key?: string })._key = key;
  if (meshCache.size > 64) meshCache.clear();
  meshCache.set(ck, m);
  return m;
}

// ------------------------------------------------------------------ text -> curve

/** Bezier splines of the glyph outlines (Convert to Curve), in object space. */
export function textToSplines(ob: BObject, doc?: Doc): Spline[] {
  const t = ob.text;
  const lay = t ? textLayout(ob, doc) : null;
  if (!t || !lay) return [];
  const out: Spline[] = [];
  const toSpline = (pts: { co: Vec3; hl: Vec3; hr: Vec3 }[], mat: number) => {
    if (pts.length < 2) return;
    const sp = newSpline('BEZIER', t.resolution);
    for (const p of pts) sp.bezierPoints.push(newBezierPoint(p.co, p.hl, p.hr, 'FREE'));
    sp.useCyclicU = true;
    sp.pointCountU = sp.bezierPoints.length;
    sp.materialIndex = mat;
    sp.useSmooth = false;
    out.push(sp);
  };
  /** Convert a three Path (lines, quadratic and cubic curves) into cyclic Bezier points. */
  const pathToPoints = (curves: { type: string; v0?: Vector2; v1?: Vector2; v2?: Vector2; v3?: Vector2 }[], place: (x: number, y: number) => Vec3) => {
    const pts: { co: Vec3; hl: Vec3; hr: Vec3 }[] = [];
    for (const cv of curves) {
      let a: Vector2, c1: Vector2, c2: Vector2, b: Vector2;
      if (cv.type === 'LineCurve' && cv.v1 && cv.v2) { a = cv.v1; b = cv.v2; c1 = a.clone().lerp(b, 1 / 3); c2 = a.clone().lerp(b, 2 / 3); }
      else if (cv.type === 'QuadraticBezierCurve' && cv.v0 && cv.v1 && cv.v2) { a = cv.v0; b = cv.v2; c1 = a.clone().lerp(cv.v1, 2 / 3); c2 = b.clone().lerp(cv.v1, 2 / 3); }
      else if (cv.type === 'CubicBezierCurve' && cv.v0 && cv.v1 && cv.v2 && cv.v3) { a = cv.v0; c1 = cv.v1; c2 = cv.v2; b = cv.v3; }
      else continue;
      const last = pts[pts.length - 1];
      if (!last || Math.hypot(last.co[0] - place(a.x, a.y)[0], last.co[1] - place(a.x, a.y)[1]) > 1e-7) pts.push({ co: place(a.x, a.y), hl: place(a.x, a.y), hr: place(c1.x, c1.y) });
      else last.hr = place(c1.x, c1.y);
      pts.push({ co: place(b.x, b.y), hl: place(c2.x, c2.y), hr: place(b.x, b.y) });
    }
    // closing point equal to the first one
    if (pts.length > 2) {
      const f = pts[0], l = pts[pts.length - 1];
      if (Math.hypot(f.co[0] - l.co[0], f.co[1] - l.co[1], f.co[2] - l.co[2]) < 1e-7) { f.hl = l.hl; pts.pop(); }
    }
    return pts;
  };
  for (const c of lay.chars) {
    if (c.ch === ' ') continue;
    const place = (x: number, y: number) => placePoint(t, lay, c, x, y, 0);
    for (const sh of c.font.generateShapes(c.ch, c.size)) {
      toSpline(pathToPoints(sh.curves as never, place), c.mat);
      for (const hole of sh.holes) toSpline(pathToPoints(hole.curves as never, place), c.mat);
    }
  }
  const ulPos = t.underlinePosition ?? 0, ulH = t.underlineHeight ?? 0.05;
  for (const r of underlineRuns(lay)) {
    const top = (ulPos - 0.08) * t.size, h = Math.max(1e-4, ulH * t.size);
    const corners: [number, number][] = [[0, top - h], [r.adv, top - h], [r.adv, top], [0, top]];
    const pts = corners.map(([x, y], i) => {
      const prev = corners[(i + 3) % 4], next = corners[(i + 1) % 4];
      const co = placePoint(t, lay, r, x, y, 0);
      return { co, hl: placePoint(t, lay, r, x + (prev[0] - x) / 3, y + (prev[1] - y) / 3, 0), hr: placePoint(t, lay, r, x + (next[0] - x) / 3, y + (next[1] - y) / 3, 0) };
    });
    toSpline(pts, r.mat);
  }
  return out;
}

// ------------------------------------------------------------------ edit mode

/** Cursor and selection outlines (object space polylines) for drawing in edit mode. */
export function textCursorShapes(ob: BObject, doc?: Doc): { cursor: Vec3[]; selection: Vec3[][] } | null {
  const t = ob.text;
  const lay = t ? textLayout(ob, doc) : null;
  if (!t || !lay) return null;
  const n = t.body.length;
  const c = Math.max(0, Math.min(t.cursor ?? n, n));
  const at = lay.caret[c] ?? { x: 0, y: 0 };
  const anchor = { x: at.x, y: at.y, adv: 0 };
  const cursor = [placePoint(t, lay, anchor, 0, -0.2 * t.size, 0), placePoint(t, lay, anchor, 0, 0.8 * t.size, 0)];
  const selection: Vec3[][] = [];
  const s = t.selStart ?? c;
  if (s !== c) {
    const a = Math.min(s, c), b = Math.max(s, c);
    for (const ch of lay.chars) {
      if (ch.index < a || ch.index >= b) continue;
      const q = (x: number, y: number) => placePoint(t, lay, ch, x, y, 0);
      selection.push([q(0, -0.2 * t.size), q(ch.adv, -0.2 * t.size), q(ch.adv, 0.8 * t.size), q(0, 0.8 * t.size)]);
    }
  }
  return { cursor, selection };
}

let textClipboard: { body: string; fmt: number[] } = { body: '', fmt: [] };

function selRange(t: TextData): [number, number] | null {
  const c = t.cursor ?? t.body.length, s = t.selStart ?? c;
  return s === c ? null : [Math.min(s, c), Math.max(s, c)];
}

function spliceText(t: TextData, a: number, b: number, insert: string, fmt: number[], mat: number): void {
  const f = t.charFormat ?? [], m = t.charMaterial ?? [];
  t.body = t.body.slice(0, a) + insert + t.body.slice(b);
  f.splice(a, b - a, ...Array.from({ length: insert.length }, (_, i) => fmt[i] ?? 0));
  m.splice(a, b - a, ...Array.from({ length: insert.length }, () => mat));
  t.charFormat = f.length ? f : undefined;
  t.charMaterial = m.some(Boolean) ? m : undefined;
  if (t.charFormat && !t.charFormat.some(Boolean)) t.charFormat = undefined;
  t.cursor = a + insert.length;
  t.selStart = t.cursor;
}

/** Toggle a style flag (Ctrl+B / I / U / P) on the selection, or for newly typed text. */
export function toggleTextStyle(t: TextData, flag: number): void {
  const r = selRange(t);
  if (!r) { t.editFormat = (t.editFormat ?? 0) ^ flag; return; }
  const f = t.charFormat ?? new Array(t.body.length).fill(0);
  while (f.length < t.body.length) f.push(0);
  const allOn = f.slice(r[0], r[1]).every((x) => x & flag);
  for (let i = r[0]; i < r[1]; i++) f[i] = allOn ? f[i] & ~flag : f[i] | flag;
  t.charFormat = f;
  t.editFormat = allOn ? (t.editFormat ?? 0) & ~flag : (t.editFormat ?? 0) | flag;
}

/** Set a style flag on (the selection or) the whole text. */
export function setTextStyle(t: TextData, flag: number, on: boolean, whole: boolean): void {
  const r = whole ? [0, t.body.length] : selRange(t);
  t.editFormat = on ? (t.editFormat ?? 0) | flag : (t.editFormat ?? 0) & ~flag;
  if (!r) return;
  const f = t.charFormat ?? new Array(t.body.length).fill(0);
  while (f.length < t.body.length) f.push(0);
  for (let i = r[0]; i < r[1]; i++) f[i] = on ? f[i] | flag : f[i] & ~flag;
  t.charFormat = f;
}

/** Is a style flag active (for the panel toggles): edit format, or every selected character. */
export function textStyleActive(t: TextData, flag: number): boolean {
  const r = selRange(t);
  if (r) return (t.charFormat ?? []).slice(r[0], r[1]).every((x) => !!(x & flag)) && r[1] > r[0];
  return !!((t.editFormat ?? 0) & flag);
}

export function textSelectAll(t: TextData): void { t.selStart = 0; t.cursor = t.body.length; }

export function textCopy(t: TextData, cut: boolean): void {
  const r = selRange(t);
  if (!r) return;
  textClipboard = { body: t.body.slice(r[0], r[1]), fmt: (t.charFormat ?? []).slice(r[0], r[1]) };
  try { void navigator.clipboard?.writeText(textClipboard.body); } catch { /* not allowed */ }
  if (cut) spliceText(t, r[0], r[1], '', [], 0);
}

export function textPaste(t: TextData, text?: string): void {
  const body = text ?? textClipboard.body;
  const fmt = text === undefined ? textClipboard.fmt : [];
  const c = t.cursor ?? t.body.length;
  const r = selRange(t) ?? [c, c];
  spliceText(t, r[0], r[1], body, fmt, (t.charMaterial ?? [])[Math.max(0, r[0] - 1)] ?? 0);
}

/** Insert text at the cursor (replacing the selection) with the current edit style. */
export function textInsert(t: TextData, s: string): void {
  const c = t.cursor ?? t.body.length;
  const r = selRange(t) ?? [c, c];
  spliceText(t, r[0], r[1], s, Array.from({ length: s.length }, () => t.editFormat ?? 0), (t.charMaterial ?? [])[Math.max(0, r[0] - 1)] ?? 0);
}

/** Handle typing while a text object is in edit mode. Returns true when the key was used. */
export function textEditKey(ob: BObject, e: KeyboardEvent): boolean {
  const t = ob.text;
  if (!t || e.metaKey) return false;
  const n = t.body.length;
  const c = Math.max(0, Math.min(t.cursor ?? n, n));
  t.cursor = c;
  if (t.selStart === undefined || t.selStart > n) t.selStart = c;
  const move = (to: number) => { t.cursor = Math.max(0, Math.min(n, to)); if (!e.shiftKey) t.selStart = t.cursor; };
  if (e.ctrlKey && !e.altKey) {
    switch (e.code) {
      case 'KeyA': textSelectAll(t); return true;
      case 'KeyC': textCopy(t, false); return true;
      case 'KeyX': textCopy(t, true); return true;
      case 'KeyV': textPaste(t); return true;
      case 'KeyB': toggleTextStyle(t, STYLE_BOLD); return true;
      case 'KeyI': toggleTextStyle(t, STYLE_ITALIC); return true;
      case 'KeyU': toggleTextStyle(t, STYLE_UNDERLINE); return true;
      case 'KeyP': toggleTextStyle(t, STYLE_SMALLCAPS); return true;
      case 'ArrowLeft': { let i = c - 1; while (i > 0 && /\s/.test(t.body[i - 1])) i--; while (i > 0 && !/\s/.test(t.body[i - 1])) i--; move(i); return true; }
      case 'ArrowRight': { let i = c; while (i < n && !/\s/.test(t.body[i])) i++; while (i < n && /\s/.test(t.body[i])) i++; move(i); return true; }
      default: return false;
    }
  }
  if (e.altKey) return false;
  const r = selRange(t);
  if (e.key === 'Backspace') { if (r) spliceText(t, r[0], r[1], '', [], 0); else if (c > 0) spliceText(t, c - 1, c, '', [], 0); return true; }
  if (e.key === 'Delete') { if (r) spliceText(t, r[0], r[1], '', [], 0); else if (c < n) spliceText(t, c, c + 1, '', [], 0); return true; }
  if (e.key === 'ArrowLeft') { move(r && !e.shiftKey ? r[0] : c - 1); return true; }
  if (e.key === 'ArrowRight') { move(r && !e.shiftKey ? r[1] : c + 1); return true; }
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    const ls = t.body.lastIndexOf('\n', c - 1) + 1;
    const col = c - ls;
    if (e.key === 'ArrowUp') { if (ls === 0) return true; const ps = t.body.lastIndexOf('\n', ls - 2) + 1; move(Math.min(ps + col, ls - 1)); }
    else { const ne = t.body.indexOf('\n', c); if (ne < 0) return true; const ee = t.body.indexOf('\n', ne + 1); move(Math.min(ne + 1 + col, ee < 0 ? n : ee)); }
    return true;
  }
  if (e.key === 'Home') { move(t.body.lastIndexOf('\n', c - 1) + 1); return true; }
  if (e.key === 'End') { const i = t.body.indexOf('\n', c); move(i < 0 ? n : i); return true; }
  if (e.key === 'Enter') { textInsert(t, '\n'); return true; }
  if (e.key.length === 1) { textInsert(t, e.key); return true; }
  return false;
}
