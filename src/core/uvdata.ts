// UV maps on meshes: layer helpers, default UVs for primitives, joining, and carrying UVs
// through the modifier stack (EvalMesh). Pure data code: no app / DOM imports, so the
// modifier stack can use it.
//
// Storage (see MeshUVLayer in types.ts): `layer.uv[f]` = [u0, v0, u1, v1, ...] for the corners of
// `faces[f]`, optional `layer.flag[f][k]` (1 = UV-selected, 2 = pinned). Consumers must tolerate
// missing / short arrays: use `cornerUV` / `faceUVValid` instead of indexing directly.

import type { MeshData, MeshUVLayer, Modifier, Vec3 } from './types';
import type { EvalMesh } from './modifiers';
import { cross, dot, edgeKey, normalize, polyNormal, sub } from './mesh';

export const UV_SELECT = 1;
export const UV_PIN = 2;

/** UV layer as carried by evaluated meshes. */
export interface EvalUVLayer { name: string; uv: number[][] }

// ------------------------------------------------------------------ layer access

export function uvLayers(md: MeshData | null | undefined): MeshUVLayer[] {
  return md?.uvLayers ?? [];
}

export function activeUVIndex(md: MeshData | null | undefined): number {
  const n = md?.uvLayers?.length ?? 0;
  if (!n) return -1;
  return Math.max(0, Math.min(n - 1, md!.uvActive ?? 0));
}

export function renderUVIndex(md: MeshData | null | undefined): number {
  const n = md?.uvLayers?.length ?? 0;
  if (!n) return -1;
  return Math.max(0, Math.min(n - 1, md!.uvActiveRender ?? 0));
}

export function activeUVLayer(md: MeshData | null | undefined): MeshUVLayer | null {
  const i = activeUVIndex(md);
  return i >= 0 ? md!.uvLayers![i] : null;
}

/** Is the UV data of face `f` complete (one coordinate pair per corner)? */
export function faceUVValid(layer: { uv: number[][] } | null | undefined, md: { faces: number[][] }, f: number): boolean {
  const u = layer?.uv[f];
  return !!u && u.length === md.faces[f].length * 2;
}

/** UV of corner k of face f (0,0 when missing). */
export function cornerUV(layer: { uv: number[][] } | null | undefined, f: number, k: number): [number, number] {
  const u = layer?.uv[f];
  if (!u || u.length < k * 2 + 2) return [0, 0];
  return [u[k * 2], u[k * 2 + 1]];
}

export function cornerFlag(layer: MeshUVLayer | null | undefined, f: number, k: number): number {
  return layer?.flag?.[f]?.[k] ?? 0;
}

/** Make the flag array of a layer complete (allocating it when missing). */
export function ensureFlags(md: MeshData, layer: MeshUVLayer): number[][] {
  if (!layer.flag) layer.flag = [];
  const fl = layer.flag;
  if (fl.length > md.faces.length) fl.length = md.faces.length;
  for (let f = 0; f < md.faces.length; f++) {
    const n = md.faces[f].length;
    const row = fl[f];
    if (!row) fl[f] = new Array(n).fill(0);
    else if (row.length !== n) { const r = row.slice(0, n); while (r.length < n) r.push(0); fl[f] = r; }
  }
  return fl;
}

/** Blender's "Reset" UVs for a face of n corners: quads fill 0..1, other polygons sit on a circle. */
export function resetFaceUV(n: number): number[] {
  if (n === 4) return [0, 0, 1, 0, 1, 1, 0, 1];
  if (n === 3) return [0, 0, 1, 0, 1, 1];
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = Math.PI * 1.25 + (i / n) * Math.PI * 2;
    out.push(0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a));
  }
  return out;
}

/** Make every face of every layer have a complete UV list (fills gaps with reset UVs). */
export function ensureUVShape(md: MeshData): void {
  if (!md.uvLayers) return;
  for (const layer of md.uvLayers) {
    if (layer.uv.length > md.faces.length) layer.uv.length = md.faces.length;
    for (let f = 0; f < md.faces.length; f++) if (!faceUVValid(layer, md, f)) layer.uv[f] = resetFaceUV(md.faces[f].length);
    if (layer.flag) ensureFlags(md, layer);
  }
  const n = md.uvLayers.length;
  if (!n) { delete md.uvActive; delete md.uvActiveRender; return; }
  md.uvActive = Math.max(0, Math.min(n - 1, md.uvActive ?? 0));
  md.uvActiveRender = Math.max(0, Math.min(n - 1, md.uvActiveRender ?? 0));
}

function uniqueLayerName(md: MeshData, base: string): string {
  const names = new Set(uvLayers(md).map((l) => l.name));
  if (!names.has(base)) return base;
  for (let i = 1; ; i++) { const n = `${base}.${String(i).padStart(3, '0')}`; if (!names.has(n)) return n; }
}

/**
 * Add a UV map (Data > UV Maps > +). Like Blender, the new map copies the active map; the first map of a
 * mesh gets reset UVs. Returns the new layer (which becomes active).
 */
export function addUVLayer(md: MeshData, name = 'UVMap', uvs?: number[][]): MeshUVLayer {
  const src = activeUVLayer(md);
  const layer: MeshUVLayer = {
    name: uniqueLayerName(md, name),
    uv: uvs ?? md.faces.map((f, i) => (src && faceUVValid(src, md, i) ? src.uv[i].slice() : resetFaceUV(f.length))),
  };
  md.uvLayers ??= [];
  md.uvLayers.push(layer);
  md.uvActive = md.uvLayers.length - 1;
  if (md.uvLayers.length === 1) md.uvActiveRender = 0;
  ensureUVShape(md);
  return layer;
}

export function removeUVLayer(md: MeshData, index: number): void {
  if (!md.uvLayers || index < 0 || index >= md.uvLayers.length) return;
  md.uvLayers.splice(index, 1);
  const fix = (i: number | undefined) => { const v = i ?? 0; return v > index ? v - 1 : Math.min(v, md.uvLayers!.length - 1); };
  md.uvActive = fix(md.uvActive);
  md.uvActiveRender = fix(md.uvActiveRender);
  if (!md.uvLayers.length) { delete md.uvLayers; delete md.uvActive; delete md.uvActiveRender; }
}

/** Active UV layer, created (with reset UVs) when the mesh has none. */
export function ensureActiveUVLayer(md: MeshData): MeshUVLayer {
  const l = activeUVLayer(md);
  if (l) { ensureUVShape(md); return l; }
  return addUVLayer(md);
}

// ------------------------------------------------------------------ seams

export function seamSet(md: MeshData): Set<string> {
  const s = new Set<string>();
  if (!md.seam) return s;
  md.edges.forEach((e, i) => { if (md.seam![i]) s.add(edgeKey(e[0], e[1])); });
  return s;
}

/** Set the seam array from a set of edge keys (drops it when empty). */
export function setSeamsFromSet(md: MeshData, s: Set<string>): void {
  if (!s.size) { delete md.seam; return; }
  md.seam = md.edges.map((e) => s.has(edgeKey(e[0], e[1])));
}

// ------------------------------------------------------------------ primitives

const TAU = Math.PI * 2;

/**
 * Default UVs for a primitive created by Add > Mesh (Blender's "Generate UVs"). `kind` is the
 * primitive name as used by the add operators ('Plane', 'Cube', 'Circle', 'Sphere', 'Icosphere',
 * 'Cylinder', 'Cone', 'Torus', 'Grid'). Returns per-face UV lists or null when unknown.
 */
export function primitiveUVs(kind: string, verts: Vec3[], faces: number[][]): number[][] | null {
  if (!faces.length) return null;
  const k = kind.toLowerCase();
  let min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const v of verts) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], v[a]); max[a] = Math.max(max[a], v[a]); }
  if (!isFinite(min[0])) { min = [0, 0, 0]; max = [1, 1, 1]; }
  const span = (a: number) => Math.max(1e-9, max[a] - min[a]);
  const planar = (cx: number, cy: number, s: number) => faces.map((f) => f.flatMap((v) => [cx + (verts[v][0] - (min[0] + max[0]) / 2) / span(0) * s, cy + (verts[v][1] - (min[1] + max[1]) / 2) / span(1) * s]));
  if (k === 'plane' || k === 'grid') return faces.map((f) => f.flatMap((v) => [(verts[v][0] - min[0]) / span(0), (verts[v][1] - min[1]) / span(1)]));
  if (k === 'circle') return planar(0.5, 0.5, 1);
  if (k === 'cube') return cubeCrossUVs(verts, faces);
  if (k === 'sphere' || k === 'uv sphere' || k === 'icosphere' || k === 'ico sphere') return sphericalUVs(verts, faces);
  if (k === 'torus') return torusUVs(verts, faces);
  if (k === 'cylinder' || k === 'cone') return cylinderUVs(verts, faces, min, max);
  return null;
}

/** The cube's cross layout: four side faces in a column, the +X / -X faces as arms. */
function cubeCrossUVs(verts: Vec3[], faces: number[][]): number[][] {
  // cell (column, row) for each axis direction; cells are 0.25 x 0.25 with the cross centred in 0..1
  const cells: Record<string, [number, number]> = {
    '+Z': [1, 2], '-Y': [1, 1], '-Z': [1, 0], '+Y': [1, 3], '-X': [0, 2], '+X': [2, 2],
  };
  return faces.map((f) => {
    const n = polyNormal(verts, f);
    const ax = Math.abs(n[0]) >= Math.abs(n[1]) && Math.abs(n[0]) >= Math.abs(n[2]) ? 0 : Math.abs(n[1]) >= Math.abs(n[2]) ? 1 : 2;
    const key = `${n[ax] >= 0 ? '+' : '-'}${'XYZ'[ax]}`;
    // in-plane axes so that the face reads unmirrored when seen from outside
    let ua: Vec3, va: Vec3;
    switch (key) {
      case '+Z': ua = [1, 0, 0]; va = [0, 1, 0]; break;
      case '-Z': ua = [1, 0, 0]; va = [0, -1, 0]; break;
      case '-Y': ua = [1, 0, 0]; va = [0, 0, 1]; break;
      case '+Y': ua = [1, 0, 0]; va = [0, 0, -1]; break;
      case '+X': ua = [0, 0, -1]; va = [0, 1, 0]; break;
      default: ua = [0, 0, 1]; va = [0, 1, 0]; break; // -X
    }
    const pts = f.map((v) => [dot(verts[v], ua), dot(verts[v], va)]);
    const mnu = Math.min(...pts.map((p) => p[0])), mxu = Math.max(...pts.map((p) => p[0]));
    const mnv = Math.min(...pts.map((p) => p[1])), mxv = Math.max(...pts.map((p) => p[1]));
    const [cx, cy] = cells[key];
    return pts.flatMap(([u, v]) => [
      0.125 + (cx + (u - mnu) / Math.max(1e-9, mxu - mnu)) * 0.25,
      (cy + (v - mnv) / Math.max(1e-9, mxv - mnv)) * 0.25,
    ]);
  });
}

/** Fix the U wrap of a face (corners on both sides of the seam) and poles (use the face's mean U). */
function wrapFix(us: number[], poles: boolean[]): number[] {
  const out = us.slice();
  const nonPole = out.filter((_, i) => !poles[i]);
  if (nonPole.length) {
    const mx = Math.max(...nonPole), mn = Math.min(...nonPole);
    if (mx - mn > 0.5) for (let i = 0; i < out.length; i++) if (!poles[i] && out[i] < 0.5) out[i] += 1;
    const fixed = out.filter((_, i) => !poles[i]);
    const avg = fixed.reduce((a, b) => a + b, 0) / fixed.length;
    for (let i = 0; i < out.length; i++) if (poles[i]) out[i] = avg;
  }
  return out;
}

function sphericalUVs(verts: Vec3[], faces: number[][]): number[][] {
  const c: Vec3 = [0, 0, 0];
  for (const v of verts) { c[0] += v[0]; c[1] += v[1]; c[2] += v[2]; }
  for (let a = 0; a < 3; a++) c[a] /= Math.max(1, verts.length);
  return faces.map((f) => {
    const ps = f.map((v) => sub(verts[v], c));
    const poles = ps.map((p) => Math.hypot(p[0], p[1]) < 1e-6 * Math.max(1, Math.hypot(p[0], p[1], p[2])));
    const us = ps.map((p) => ((Math.atan2(p[1], p[0]) / TAU) + 1) % 1);
    const vs = ps.map((p) => { const l = Math.hypot(p[0], p[1], p[2]) || 1; return 1 - Math.acos(Math.max(-1, Math.min(1, p[2] / l))) / Math.PI; });
    const uu = wrapFix(us, poles);
    return f.flatMap((_, i) => [uu[i], vs[i]]);
  });
}

function torusUVs(verts: Vec3[], faces: number[][]): number[][] {
  // major angle around Z -> U, minor angle around the ring -> V
  let rMaj = 0;
  for (const v of verts) rMaj += Math.hypot(v[0], v[1]);
  rMaj /= Math.max(1, verts.length);
  return faces.map((f) => {
    const us = f.map((v) => ((Math.atan2(verts[v][1], verts[v][0]) / TAU) + 1) % 1);
    const vs = f.map((v) => ((Math.atan2(verts[v][2], Math.hypot(verts[v][0], verts[v][1]) - rMaj) / TAU) + 1) % 1);
    const none = f.map(() => false);
    const uu = wrapFix(us, none), vv = wrapFix(vs, none);
    return f.flatMap((_, i) => [uu[i], vv[i]]);
  });
}

/** Cylinder / cone: the side as a strip in the lower half, the caps as circles in the upper half. */
function cylinderUVs(verts: Vec3[], faces: number[][], min: Vec3, max: Vec3): number[][] {
  const h = Math.max(1e-9, max[2] - min[2]);
  const rad = Math.max(1e-9, (max[0] - min[0]) / 2, (max[1] - min[1]) / 2);
  return faces.map((f) => {
    const n = polyNormal(verts, f);
    if (Math.abs(n[2]) > 0.999 && f.length >= 3 && f.every((v) => Math.abs(verts[v][2] - verts[f[0]][2]) < 1e-6 * h + 1e-9)) {
      // cap (n-gon or triangle fan)
      const top = n[2] > 0;
      const cx = top ? 0.75 : 0.25, cy = 0.75;
      return f.flatMap((v) => [cx + (verts[v][0] / rad) * 0.24 * (top ? 1 : -1), cy + (verts[v][1] / rad) * 0.24]);
    }
    // side: angle measured from +Y towards -X like the primitive's ring order
    const ang = f.map((v) => {
      const p = verts[v];
      return Math.hypot(p[0], p[1]) < 1e-9 ? NaN : ((Math.atan2(-p[0], p[1]) / TAU) + 1) % 1;
    });
    const poles = ang.map((a) => isNaN(a));
    const uu = wrapFix(ang.map((a) => (isNaN(a) ? 0 : a)), poles);
    return f.flatMap((v, i) => [uu[i], ((verts[v][2] - min[2]) / h) * 0.5]);
  });
}

/** Give a freshly created mesh a "UVMap" layer from per-face UVs (no-op when null). */
export function setInitialUVs(md: MeshData, uvs: number[][] | null): void {
  if (!uvs || uvs.length !== md.faces.length) return;
  md.uvLayers = [{ name: 'UVMap', uv: uvs.map((u) => u.slice()) }];
  md.uvActive = 0;
  md.uvActiveRender = 0;
}

// ------------------------------------------------------------------ join (Ctrl+J)

/**
 * After `joinMeshInto(target, source, ...)` appended the source faces at `faceOffset` (vertices at
 * `vertOffset`, reversed when `flipped`): carry UV maps (matched by name, like Blender) and seams.
 */
export function joinMeshLayers(target: MeshData, source: MeshData, faceOffset: number, vertOffset: number, sourceToTarget: number[]): void {
  const m = sourceToTarget;
  const flipped = m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]) < 0;
  const tl = target.uvLayers ?? [], sl = source.uvLayers ?? [];
  if (tl.length || sl.length) {
    const names = [...tl.map((l) => l.name)];
    for (const l of sl) if (!names.includes(l.name)) names.push(l.name);
    const out: MeshUVLayer[] = names.map((name, li) => {
      const t = tl.find((l) => l.name === name) ?? null;
      // a source map without a match in the target fills the target's faces from its first map
      const s = sl.find((l) => l.name === name) ?? (li === 0 ? sl[0] ?? null : null);
      const uv: number[][] = [];
      for (let f = 0; f < faceOffset; f++) uv.push(t && t.uv[f] && t.uv[f].length === target.faces[f].length * 2 ? t.uv[f].slice() : resetFaceUV(target.faces[f].length));
      for (let f = 0; f < source.faces.length; f++) {
        const n = source.faces[f].length;
        let u = s && s.uv[f] && s.uv[f].length === n * 2 ? s.uv[f].slice() : resetFaceUV(n);
        if (flipped) { const r: number[] = []; for (let k = n - 1; k >= 0; k--) r.push(u[k * 2], u[k * 2 + 1]); u = r; }
        uv.push(u);
      }
      return { name, uv };
    });
    target.uvLayers = out;
    target.uvActive = Math.min(out.length - 1, target.uvActive ?? 0);
    target.uvActiveRender = Math.min(out.length - 1, target.uvActiveRender ?? 0);
    ensureUVShape(target);
  }
  if (source.seam?.some(Boolean)) {
    const s = seamSet(target);
    source.edges.forEach((e, i) => { if (source.seam![i]) s.add(edgeKey(e[0] + vertOffset, e[1] + vertOffset)); });
    setSeamsFromSet(target, s);
  }
}

/**
 * Applying modifiers (Apply / Convert to Mesh): take the evaluated UV maps, and keep the seams
 * (`oldSeams`, captured before the mesh was replaced) between vertices that still exist.
 */
export function applyEvalLayers(md: MeshData, ev: EvalMesh, oldSeams: Set<string>): void {
  if (ev.uvLayers?.length && ev.uvLayers.every((l) => l.uv.length === md.faces.length)) {
    md.uvLayers = ev.uvLayers.map((l) => ({ name: l.name, uv: l.uv.map((u) => u.slice()) }));
    md.uvActive = Math.min(md.uvLayers.length - 1, md.uvActive ?? 0);
    md.uvActiveRender = Math.min(md.uvLayers.length - 1, md.uvActiveRender ?? 0);
    ensureUVShape(md);
  } else if (md.uvLayers) {
    delete md.uvLayers; delete md.uvActive; delete md.uvActiveRender;
  }
  setSeamsFromSet(md, oldSeams);
  if (!(md.seam ?? []).some(Boolean)) delete md.seam;
}

// ------------------------------------------------------------------ evaluated meshes (modifier stack)

/** UV layers for an EvalMesh built from mesh data (only faces with complete UVs keep theirs). */
export function evalUVLayersFromData(md: MeshData): EvalUVLayer[] | undefined {
  if (!md.uvLayers?.length) return undefined;
  return md.uvLayers.map((l) => ({ name: l.name, uv: md.faces.map((f, i) => (faceUVValid(l, md, i) ? l.uv[i] : resetFaceUV(f.length))) }));
}

/** Are the UV layers of an evaluated mesh consistent with its faces? */
function evalUVValid(m: EvalMesh): boolean {
  if (!m.uvLayers) return false;
  for (const l of m.uvLayers) {
    if (l.uv.length !== m.faces.length) return false;
    for (let f = 0; f < m.faces.length; f++) if (!l.uv[f] || l.uv[f].length !== m.faces[f].length * 2) return false;
  }
  return true;
}

const numv = (v: unknown, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d);

/**
 * Give the output of a modifier the UV layers of its input. Deform modifiers keep the face
 * structure (copied as is); the generate modifiers of the stack are reproduced structurally; any
 * other modifier falls back to projecting each output corner into the nearest input face.
 */
export function propagateEvalUVs(before: EvalMesh, after: EvalMesh, mod: Modifier, ctx: { render: boolean }): void {
  if (!before.uvLayers?.length) { if (after.uvLayers && !evalUVValid(after)) after.uvLayers = undefined; return; }
  after.uvRender = before.uvRender;
  if (after.uvLayers && evalUVValid(after)) return;
  const layers = before.uvLayers;
  let out: number[][][] | null = null;
  try {
    out = structuralUVs(before, after, mod, ctx);
    if (!out && mod.type !== 'WIREFRAME') out = layers.map((l) => geometricUVs(before, l.uv, after));
  } catch { out = null; }
  if (!out) { after.uvLayers = undefined; return; }
  after.uvLayers = layers.map((l, i) => ({ name: l.name, uv: out![i] }));
  if (!evalUVValid(after)) after.uvLayers = undefined;
}

const sameSizes = (a: number[][], b: number[][]) => a.length === b.length && a.every((f, i) => f.length === b[i].length);
const reverseUV = (u: number[]) => { const r: number[] = []; for (let k = u.length / 2 - 1; k >= 0; k--) r.push(u[k * 2], u[k * 2 + 1]); return r; };

function structuralUVs(before: EvalMesh, after: EvalMesh, mod: Modifier, ctx: { render: boolean }): number[][][] | null {
  const L = before.uvLayers!;
  const bf = before.faces, af = after.faces;
  // deform modifiers / edge split: same face structure
  if (sameSizes(bf, af)) return L.map((l) => l.uv.map((u) => u.slice()));
  switch (mod.type) {
    case 'SUBSURF': {
      let cur = L.map((l) => l.uv);
      let sizes = bf.map((f) => f.length);
      let count = bf.length;
      for (let it = 0; it < 7 && count < af.length; it++) {
        cur = cur.map((uvs) => {
          const nxt: number[][] = [];
          uvs.forEach((u, fi) => {
            const n = sizes[fi];
            let cx = 0, cy = 0;
            for (let k = 0; k < n; k++) { cx += u[k * 2]; cy += u[k * 2 + 1]; }
            cx /= n; cy /= n;
            for (let i = 0; i < n; i++) {
              const j = (i + 1) % n, p = (i - 1 + n) % n;
              nxt.push([u[i * 2], u[i * 2 + 1], (u[i * 2] + u[j * 2]) / 2, (u[i * 2 + 1] + u[j * 2 + 1]) / 2, cx, cy, (u[p * 2] + u[i * 2]) / 2, (u[p * 2 + 1] + u[i * 2 + 1]) / 2]);
            }
          });
          return nxt;
        });
        sizes = new Array(cur[0].length).fill(4);
        count = cur[0].length;
      }
      return count === af.length ? cur : null;
    }
    case 'MIRROR': {
      // faces: original ones, then mirrored copies (reversed) per enabled axis, skipping faces in the plane
      const merge = mod.useMirrorMerge !== false, thr = numv(mod.mergeThreshold, 0.001);
      let src = bf.map((_, i) => i);
      let rev = bf.map(() => false);
      for (const [axis, on] of [[0, mod.useX !== false], [1, mod.useY === true], [2, mod.useZ === true]] as [number, boolean][]) {
        if (!on) continue;
        const ns = src.slice(), nr = rev.slice();
        src.forEach((s, i) => {
          if (merge && bf[s].every((v) => Math.abs(before.verts[v][axis]) <= thr)) return;
          ns.push(s); nr.push(!rev[i]);
        });
        src = ns; rev = nr;
      }
      if (src.length !== af.length) return null;
      return L.map((l) => src.map((s, i) => (rev[i] ? reverseUV(l.uv[s]) : l.uv[s].slice())));
    }
    case 'ARRAY': {
      if (af.length % Math.max(1, bf.length) !== 0) return null;
      const out = L.map((l) => af.map((_, i) => l.uv[i % bf.length].slice()));
      return af.every((f, i) => f.length === bf[i % bf.length].length) ? out : null;
    }
    case 'SOLIDIFY': {
      const flip = mod.useFlipNormals === true;
      const res: number[][][] = L.map(() => []);
      bf.forEach((_, fi) => L.forEach((l, li) => {
        const u = l.uv[fi];
        res[li].push(flip ? reverseUV(u) : u.slice());
        res[li].push(flip ? u.slice() : reverseUV(u));
      }));
      if (mod.useRim !== false) {
        const count = new Map<string, number>();
        const dir = new Map<string, [number, number]>();
        bf.forEach((f, fi) => { for (let i = 0; i < f.length; i++) { const k = edgeKey(f[i], f[(i + 1) % f.length]); count.set(k, (count.get(k) ?? 0) + 1); dir.set(k, [fi, i]); } });
        count.forEach((c, k) => {
          if (c !== 1) return;
          const [fi, i] = dir.get(k)!;
          const n = bf[fi].length, j = (i + 1) % n;
          L.forEach((l, li) => {
            const u = l.uv[fi];
            const q = [u[j * 2], u[j * 2 + 1], u[i * 2], u[i * 2 + 1], u[i * 2], u[i * 2 + 1], u[j * 2], u[j * 2 + 1]];
            res[li].push(flip ? reverseUV(q) : q);
          });
        });
      }
      return res[0].length === af.length ? res : null;
    }
    case 'TRIANGULATE': {
      const res: number[][][] = L.map(() => []);
      let j = 0;
      for (let fi = 0; fi < bf.length; fi++) {
        const f = bf[fi];
        for (let t = 0; t < f.length - 2; t++, j++) {
          const g = af[j];
          if (!g) return null;
          const ks = g.map((v) => f.indexOf(v));
          if (ks.some((k) => k < 0)) return null;
          L.forEach((l, li) => res[li].push(ks.flatMap((k) => [l.uv[fi][k * 2], l.uv[fi][k * 2 + 1]])));
        }
      }
      return j === af.length ? res : null;
    }
    case 'SCREW': return screwUVs(before, after, mod, ctx);
    case 'WIREFRAME': return null;
    default: {
      // filters (Build, Mask, ...): output faces are a subsequence of the input faces
      const res: number[][][] = L.map(() => []);
      let i = 0;
      for (const g of af) {
        while (i < bf.length && !(bf[i].length === g.length && bf[i].every((v, k) => v === g[k]))) i++;
        if (i >= bf.length) return null;
        L.forEach((l, li) => res[li].push(l.uv[i].slice()));
        i++;
      }
      return res;
    }
  }
}

/** Screw: U along the steps, V along the profile (normalised cumulative edge length). */
function screwUVs(before: EvalMesh, after: EvalMesh, mod: Modifier, ctx: { render: boolean }): number[][][] | null {
  const steps = Math.max(2, Math.round(numv(ctx.render ? mod.renderSteps : mod.steps, 16)));
  const iterations = Math.max(1, Math.round(numv(mod.iterations, 1)));
  const total = steps * iterations;
  const edges: [number, number][] = [];
  const seen = new Set<string>();
  const push = (a: number, b: number) => { const k = edgeKey(a, b); if (!seen.has(k)) { seen.add(k); edges.push([a, b]); } };
  for (const f of before.faces) for (let i = 0; i < f.length; i++) push(f[i], f[(i + 1) % f.length]);
  for (const e of before.looseEdges) push(e[0], e[1]);
  if (total * edges.length !== after.faces.length) return null;
  // profile parameter: walk from an end vertex accumulating edge lengths
  const nv = before.verts.length;
  const adj: number[][] = Array.from({ length: nv }, () => []);
  for (const [a, b] of edges) { adj[a].push(b); adj[b].push(a); }
  const t = new Float64Array(nv).fill(-1);
  let acc = 0;
  for (let s = 0; s < nv; s++) {
    if (t[s] >= 0 || !adj[s].length) continue;
    let start = s;
    for (let i = 0; i < nv; i++) if (t[i] < 0 && adj[i].length === 1) { start = i; break; }
    const stack = [start];
    t[start] = acc;
    while (stack.length) {
      const v = stack.pop()!;
      for (const w of adj[v]) if (t[w] < 0) { t[w] = t[v] + Math.hypot(...sub(before.verts[w], before.verts[v])); acc = Math.max(acc, t[w]); stack.push(w); }
    }
  }
  const tl = Math.max(1e-9, acc);
  const flip = mod.useNormalFlip === true;
  const uv: number[][] = [];
  for (let s = 0; s < total; s++) {
    const u0 = s / total, u1 = (s + 1) / total;
    for (const [a, b] of edges) {
      const q = [u0, Math.max(0, t[a]) / tl, u0, Math.max(0, t[b]) / tl, u1, Math.max(0, t[b]) / tl, u1, Math.max(0, t[a]) / tl];
      uv.push(flip ? q : reverseUV(q));
    }
  }
  return before.uvLayers!.map(() => uv.map((u) => u.slice()));
}

// ------------------------------------------------------------------ geometric transfer

/** Uniform grid over face bounding boxes for nearest-face queries. */
export class FaceGrid {
  private cell: number;
  private map = new Map<string, number[]>();
  private boxes: Float64Array;
  constructor(private verts: Vec3[], private faces: number[][]) {
    let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    this.boxes = new Float64Array(faces.length * 6);
    let edgeSum = 0, edgeN = 0;
    faces.forEach((f, fi) => {
      const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (let k = 0; k < f.length; k++) {
        const p = verts[f[k]];
        for (let a = 0; a < 3; a++) { b[a] = Math.min(b[a], p[a]); b[a + 3] = Math.max(b[a + 3], p[a]); }
        const q = verts[f[(k + 1) % f.length]];
        edgeSum += Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); edgeN++;
      }
      this.boxes.set(b, fi * 6);
      for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], b[a]); max[a] = Math.max(max[a], b[a + 3]); }
    });
    const ext = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 1e-6);
    this.cell = Math.max(edgeN ? (edgeSum / edgeN) * 2 : ext / 8, ext / 256, 1e-6);
    faces.forEach((_, fi) => {
      const b = this.boxes.subarray(fi * 6, fi * 6 + 6);
      const c0 = [0, 1, 2].map((a) => Math.floor(b[a] / this.cell)), c1 = [0, 1, 2].map((a) => Math.floor(b[a + 3] / this.cell));
      if ((c1[0] - c0[0] + 1) * (c1[1] - c0[1] + 1) * (c1[2] - c0[2] + 1) > 4096) { c1[0] = c0[0]; c1[1] = c0[1]; c1[2] = c0[2]; }
      for (let x = c0[0]; x <= c1[0]; x++) for (let y = c0[1]; y <= c1[1]; y++) for (let z = c0[2]; z <= c1[2]; z++) {
        const k = `${x},${y},${z}`;
        const l = this.map.get(k);
        if (l) l.push(fi); else this.map.set(k, [fi]);
      }
    });
  }

  /** Nearest face to p (by point-polygon distance), optionally restricted to `filter`. */
  nearest(p: Vec3, filter?: (f: number) => boolean): { face: number; dist: number } | null {
    const c = [0, 1, 2].map((a) => Math.floor(p[a] / this.cell));
    let best = -1, bd = Infinity;
    const tested = new Set<number>();
    for (let r = 0; r < 64; r++) {
      for (let x = c[0] - r; x <= c[0] + r; x++) for (let y = c[1] - r; y <= c[1] + r; y++) for (let z = c[2] - r; z <= c[2] + r; z++) {
        if (Math.max(Math.abs(x - c[0]), Math.abs(y - c[1]), Math.abs(z - c[2])) !== r) continue;
        for (const fi of this.map.get(`${x},${y},${z}`) ?? []) {
          if (tested.has(fi) || (filter && !filter(fi))) continue;
          tested.add(fi);
          const d = pointPolyDistance(p, this.verts, this.faces[fi]);
          if (d < bd) { bd = d; best = fi; }
        }
      }
      // anything farther than r cells away cannot beat a hit closer than r * cell
      if (best >= 0 && bd <= r * this.cell) break;
      if (r > 8 && tested.size === 0 && this.map.size < (2 * r + 1) ** 3) {
        // sparse grid: brute force
        this.faces.forEach((_, fi) => { if (filter && !filter(fi)) return; const d = pointPolyDistance(p, this.verts, this.faces[fi]); if (d < bd) { bd = d; best = fi; } });
        break;
      }
    }
    return best >= 0 ? { face: best, dist: bd } : null;
  }
}

/** Distance from p to a polygon (triangulated). */
export function pointPolyDistance(p: Vec3, verts: Vec3[], f: number[]): number {
  if (f.length < 3) return Infinity;
  let best = Infinity;
  for (let i = 1; i < f.length - 1; i++) best = Math.min(best, pointTriDistance(p, verts[f[0]], verts[f[i]], verts[f[i + 1]]));
  return best;
}

function pointTriDistance(p: Vec3, a: Vec3, b: Vec3, c: Vec3): number {
  // closest point on triangle (Ericson)
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  const dist = (q: Vec3) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  if (d1 <= 0 && d2 <= 0) return dist(a);
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return dist(b);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return dist([a[0] + ab[0] * v, a[1] + ab[1] * v, a[2] + ab[2] * v]); }
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return dist(c);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return dist([a[0] + ac[0] * w, a[1] + ac[1] * w, a[2] + ac[2] * w]); }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return dist([b[0] + (c[0] - b[0]) * w, b[1] + (c[1] - b[1]) * w, b[2] + (c[2] - b[2]) * w]);
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  return dist([a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w]);
}

/**
 * Generalised barycentric (mean value) coordinates of p in polygon f, computed in the polygon's
 * plane. Points outside the polygon are first moved to the nearest point of its boundary, so the
 * result is always a convex combination. Returns one weight per corner.
 */
export function polygonWeights(p: Vec3, verts: Vec3[], f: number[]): number[] {
  const n = f.length;
  const nrm = polyNormal(verts, f);
  const ref: Vec3 = Math.abs(nrm[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const ax = normalize(cross(ref, nrm));
  const ay = cross(nrm, ax);
  const q = f.map((v) => [dot(verts[v], ax), dot(verts[v], ay)]);
  const px = dot(p, ax), py = dot(p, ay);
  let size = 0;
  for (let i = 0; i < n; i++) size = Math.max(size, Math.hypot(q[i][0] - q[(i + 1) % n][0], q[i][1] - q[(i + 1) % n][1]));
  const eps = Math.max(1e-12, size * 1e-7);
  const w = new Array(n).fill(0);
  // inside test (even-odd)
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    if ((q[i][1] > py) !== (q[j][1] > py) && px < ((q[j][0] - q[i][0]) * (py - q[i][1])) / (q[j][1] - q[i][1] || 1e-30) + q[i][0]) inside = !inside;
  }
  // on a vertex / an edge (or outside: clamp onto the nearest edge)
  let bestE = -1, bestT = 0, bestD = Infinity;
  for (let i = 0; i < n; i++) {
    const a = q[i], b = q[(i + 1) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / l2)) : 0;
    const d = Math.hypot(a[0] + dx * t - px, a[1] + dy * t - py);
    if (d < bestD) { bestD = d; bestE = i; bestT = t; }
  }
  if (!inside || bestD <= eps) {
    const i = bestE, j = (bestE + 1) % n;
    w[i] = 1 - bestT; w[j] += bestT;
    return w;
  }
  // mean value coordinates
  const r = q.map(([x, y]) => Math.hypot(x - px, y - py));
  const tanHalf = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const a = q[i], b = q[(i + 1) % n];
    const ax2 = a[0] - px, ay2 = a[1] - py, bx = b[0] - px, by = b[1] - py;
    const crossv = ax2 * by - ay2 * bx, dotv = ax2 * bx + ay2 * by;
    const ang = Math.atan2(crossv, dotv);
    tanHalf[i] = Math.tan(ang / 2);
  }
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const wi = (tanHalf[(i - 1 + n) % n] + tanHalf[i]) / Math.max(1e-30, r[i]);
    w[i] = wi; sum += wi;
  }
  if (!isFinite(sum) || Math.abs(sum) < 1e-30 || w.some((x) => !isFinite(x))) {
    // degenerate polygon: use the nearest corner
    let bi = 0;
    for (let i = 1; i < n; i++) if (r[i] < r[bi]) bi = i;
    w.fill(0);
    w[bi] = 1;
    return w;
  }
  for (let i = 0; i < n; i++) w[i] /= sum;
  return w;
}

/** Interpolate the UV of a polygon at the given corner weights. */
export function weightedUV(u: number[], w: number[]): [number, number] {
  let x = 0, y = 0;
  for (let k = 0; k < w.length; k++) { if (!w[k]) continue; x += (u[k * 2] ?? 0) * w[k]; y += (u[k * 2 + 1] ?? 0) * w[k]; }
  return [x, y];
}

/** Fallback: each output face takes the UV space of the input face nearest to its centre. */
function geometricUVs(before: EvalMesh, uvs: number[][], after: EvalMesh): number[][] {
  if (!before.faces.length) return after.faces.map((f) => resetFaceUV(f.length));
  const grid = new FaceGrid(before.verts, before.faces);
  return after.faces.map((g) => {
    const c: Vec3 = [0, 0, 0];
    for (const v of g) { c[0] += after.verts[v][0]; c[1] += after.verts[v][1]; c[2] += after.verts[v][2]; }
    for (let a = 0; a < 3; a++) c[a] /= g.length;
    const hit = grid.nearest(c);
    if (!hit) return resetFaceUV(g.length);
    const src = before.faces[hit.face];
    const u = uvs[hit.face];
    return g.flatMap((v) => weightedUV(u, polygonWeights(after.verts[v], before.verts, src)));
  });
}
