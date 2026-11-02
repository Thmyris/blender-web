// Text objects (Blender's FONT type): the text and its settings live on the
// object; geometry is generated with three.js's TextGeometry from a bundled
// DejaVu Sans subset (Blender's own "Bfont" is derived from DejaVu Sans).

import { BufferGeometry } from 'three';
import type { BObject, TextData, Vec3 } from './types';
export type { TextData } from './types';
import type { EvalMesh } from './modifiers';
import type { Font } from 'three/examples/jsm/loaders/FontLoader.js';
import type { TextGeometry } from 'three/examples/jsm/geometries/TextGeometry.js';

let TextGeometryCls: typeof TextGeometry | null = null;

export function defaultTextData(): TextData {
  return { body: 'Text', size: 1, extrude: 0, bevelDepth: 0, bevelResolution: 0, resolution: 12, align: 'LEFT', lineSpacing: 1, shearX: 0, offsetX: 0, offsetY: 0, cursor: 4 };
}

let font: Font | null = null;
let loading: Promise<Font> | null = null;
const loadListeners = new Set<() => void>();
export function onFontLoaded(fn: () => void): void { loadListeners.add(fn); }

export function loadFont(): Promise<Font> {
  if (font) return Promise.resolve(font);
  loading ??= (async () => {
    const [{ FontLoader }, { TextGeometry: TG }, data] = await Promise.all([
      import('three/examples/jsm/loaders/FontLoader.js'),
      import('three/examples/jsm/geometries/TextGeometry.js'),
      import('../assets/fonts/dejavu-sans.typeface.json'),
    ]);
    TextGeometryCls = TG;
    font = new FontLoader().parse(((data as { default: unknown }).default ?? data) as never);
    for (const l of loadListeners) l();
    return font;
  })();
  return loading;
}

const cache = new Map<string, EvalMesh>();

/** Evaluated mesh of a text object (empty until the font has loaded). */
export function textEvalMesh(ob: BObject): EvalMesh | null {
  const TextGeometryCtor = TextGeometryCls;
  const t = ob.text;
  if (!t) return null;
  if (!font || !TextGeometryCtor) { void loadFont(); return { verts: [], faces: [], looseEdges: [], faceSmooth: [], faceMat: [] }; }
  const key = JSON.stringify([t.body, t.size, t.extrude, t.bevelDepth, t.bevelResolution, t.resolution, t.align, t.lineSpacing, t.shearX, t.offsetX, t.offsetY]);
  const hit = cache.get(key);
  if (hit) return hit;
  const lines = (t.body || '').split('\n');
  const verts: Vec3[] = [];
  const faces: number[][] = [];
  const lineH = t.size * 1.2 * t.lineSpacing;
  const depth = t.extrude * 2;
  lines.forEach((line, li) => {
    if (!line.trim()) return;
    const geom: BufferGeometry = new TextGeometryCtor(line, {
      font: font!, size: t.size, depth, curveSegments: Math.max(1, Math.round(t.resolution / 3)),
      bevelEnabled: t.bevelDepth > 0, bevelThickness: t.bevelDepth, bevelSize: t.bevelDepth, bevelSegments: Math.max(1, t.bevelResolution + 1),
    });
    geom.computeBoundingBox();
    const bb = geom.boundingBox!;
    const w = bb.max.x - bb.min.x;
    const dx = t.align === 'CENTER' ? -w / 2 - bb.min.x : t.align === 'RIGHT' ? -bb.max.x : 0;
    const pos = geom.getAttribute('position');
    // merge identical positions so the mesh is connected
    const map = new Map<string, number>();
    const idx: number[] = [];
    for (let i = 0; i < pos.count; i++) {
      let x = pos.getX(i) + dx + t.offsetX, y = pos.getY(i) - li * lineH + t.offsetY;
      const z = pos.getZ(i) - t.extrude; // extrude symmetrically around the text plane, like Blender
      x += t.shearX * (y + li * lineH);
      const k = `${x.toFixed(5)},${y.toFixed(5)},${z.toFixed(5)}`;
      let vi = map.get(k);
      if (vi === undefined) { vi = verts.length; verts.push([x, y, z]); map.set(k, vi); }
      idx.push(vi);
    }
    for (let i = 0; i + 2 < idx.length; i += 3) {
      const f = [idx[i], idx[i + 1], idx[i + 2]];
      if (f[0] !== f[1] && f[1] !== f[2] && f[0] !== f[2]) faces.push(f);
    }
    geom.dispose();
  });
  const m: EvalMesh = { verts, faces, looseEdges: [], faceSmooth: faces.map(() => false), faceMat: faces.map(() => 0) };
  if (cache.size > 64) cache.clear();
  cache.set(key, m);
  return m;
}

/** Handle typing while a text object is in edit mode. Returns true when the key was used. */
export function textEditKey(ob: BObject, e: KeyboardEvent): boolean {
  const t = ob.text;
  if (!t || e.ctrlKey || e.metaKey || e.altKey) return false;
  const c = Math.max(0, Math.min(t.cursor ?? t.body.length, t.body.length));
  if (e.key === 'Backspace') { if (c > 0) { t.body = t.body.slice(0, c - 1) + t.body.slice(c); t.cursor = c - 1; } return true; }
  if (e.key === 'Delete') { t.body = t.body.slice(0, c) + t.body.slice(c + 1); return true; }
  if (e.key === 'ArrowLeft') { t.cursor = Math.max(0, c - 1); return true; }
  if (e.key === 'ArrowRight') { t.cursor = Math.min(t.body.length, c + 1); return true; }
  if (e.key === 'Home') { t.cursor = t.body.lastIndexOf('\n', c - 1) + 1; return true; }
  if (e.key === 'End') { const n = t.body.indexOf('\n', c); t.cursor = n < 0 ? t.body.length : n; return true; }
  if (e.key === 'Enter') { t.body = `${t.body.slice(0, c)}\n${t.body.slice(c)}`; t.cursor = c + 1; return true; }
  if (e.key.length === 1) { t.body = t.body.slice(0, c) + e.key + t.body.slice(c); t.cursor = c + 1; return true; }
  return false;
}
