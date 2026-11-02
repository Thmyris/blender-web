// Mesh data utilities: topology maintenance, selection flushing, normals,
// triangulation and the standard Blender 2.79 primitives.

import { ShapeUtils, Vector2 } from 'three';
import type { MeshData, Vec3 } from './types';

export const edgeKey = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);

export function createMeshData(id: string, name: string, verts: Vec3[] = [], faces: number[][] = [], looseEdges: [number, number][] = []): MeshData {
  const m: MeshData = {
    id, name, verts: verts.map((v) => [v[0], v[1], v[2]] as Vec3), faces: faces.map((f) => f.slice()), edges: [],
    faceSmooth: [], faceMat: [], vsel: [], esel: [], fsel: [], activeFace: -1,
    materials: [], autoSmooth: false, autoSmoothAngle: (30 * Math.PI) / 180, doubleSided: true, fakeUser: false,
  };
  m.edges = looseEdges.map(([a, b]) => (a < b ? [a, b] : [b, a]) as [number, number]);
  rebuildEdges(m);
  ensureArrays(m);
  return m;
}

/** Make sure per-element arrays match the element counts. */
export function ensureArrays(m: MeshData): void {
  const nv = m.verts.length, ne = m.edges.length, nf = m.faces.length;
  if (m.vsel.length !== nv) m.vsel = resize(m.vsel, nv, false);
  if (m.esel.length !== ne) m.esel = resize(m.esel, ne, false);
  if (m.fsel.length !== nf) m.fsel = resize(m.fsel, nf, false);
  if (m.faceSmooth.length !== nf) m.faceSmooth = resize(m.faceSmooth, nf, m.faceSmooth.length ? m.faceSmooth[m.faceSmooth.length - 1] : false);
  if (m.faceMat.length !== nf) m.faceMat = resize(m.faceMat, nf, 0);
  if (m.activeFace >= nf) m.activeFace = -1;
  if (m.vcol && m.vcol.length !== nv) m.vcol = resize(m.vcol, nv, [1, 1, 1] as [number, number, number]);
  // hidden flags are dropped (everything revealed) when the topology no longer matches
  if (m.vhide && (m.vhide.length !== nv || (m.fhide?.length ?? -1) !== nf)) { delete m.vhide; delete m.fhide; }
}

// ------------------------------------------------------------------ hiding (edit mode)

export function isVertHidden(m: MeshData, v: number): boolean { return !!m.vhide?.[v]; }
export function isFaceHidden(m: MeshData, f: number): boolean { return !!m.fhide?.[f]; }
export function hasHidden(m: MeshData): boolean { return !!m.vhide?.some(Boolean) || !!m.fhide?.some(Boolean); }

/** Edge visibility: both vertices visible, and (if it has faces) at least one visible face. */
export function hiddenEdges(m: MeshData): boolean[] {
  if (!hasHidden(m)) return m.edges.map(() => false);
  const visibleFaceEdge = new Set<string>();
  const anyFaceEdge = new Set<string>();
  m.faces.forEach((f, i) => {
    for (let k = 0; k < f.length; k++) {
      const key = edgeKey(f[k], f[(k + 1) % f.length]);
      anyFaceEdge.add(key);
      if (!m.fhide?.[i]) visibleFaceEdge.add(key);
    }
  });
  return m.edges.map(([a, b]) => {
    if (m.vhide?.[a] || m.vhide?.[b]) return true;
    const key = edgeKey(a, b);
    return anyFaceEdge.has(key) && !visibleFaceEdge.has(key);
  });
}

/** Deselect hidden elements (Blender never keeps hidden geometry selected). */
export function deselectHidden(m: MeshData, mode: SelectMode): void {
  if (!hasHidden(m)) return;
  const he = hiddenEdges(m);
  m.verts.forEach((_, i) => { if (m.vhide?.[i]) m.vsel[i] = false; });
  m.edges.forEach((_, i) => { if (he[i]) m.esel[i] = false; });
  m.faces.forEach((_, i) => { if (m.fhide?.[i]) m.fsel[i] = false; });
  flushSelection(m, mode);
}

/** Hide selected (or unselected) geometry. */
export function hideMesh(m: MeshData, unselected: boolean, mode: SelectMode): void {
  ensureArrays(m);
  const vh = m.vhide?.slice() ?? m.verts.map(() => false);
  const fh = m.fhide?.slice() ?? m.faces.map(() => false);
  if (mode === 'FACE') {
    m.faces.forEach((_, i) => { if (m.fsel[i] !== unselected) fh[i] = true; });
    // vertices are hidden when every face using them is hidden (loose verts follow their selection)
    const used = m.verts.map(() => false), visible = m.verts.map(() => false);
    m.faces.forEach((f, i) => { for (const v of f) { used[v] = true; if (!fh[i]) visible[v] = true; } });
    m.verts.forEach((_, v) => { if (used[v] ? !visible[v] : m.vsel[v] !== unselected) vh[v] = true; });
  } else {
    m.verts.forEach((_, v) => { if (m.vsel[v] !== unselected) vh[v] = true; });
    m.faces.forEach((f, i) => { if (f.some((v) => vh[v])) fh[i] = true; });
  }
  m.vhide = vh;
  m.fhide = fh;
  deselectHidden(m, mode);
}

/** Reveal everything; revealed elements become selected (Blender's Alt+H). */
export function revealMesh(m: MeshData, mode: SelectMode): void {
  if (!hasHidden(m)) return;
  const he = hiddenEdges(m);
  m.verts.forEach((_, i) => { if (m.vhide?.[i]) m.vsel[i] = true; });
  m.edges.forEach((_, i) => { if (he[i]) m.esel[i] = true; });
  m.faces.forEach((_, i) => { if (m.fhide?.[i]) m.fsel[i] = true; });
  delete m.vhide;
  delete m.fhide;
  if (mode === 'FACE') flushFromFaces(m); else if (mode === 'EDGE') flushFromEdges(m); else flushFromVerts(m);
}

function resize<T>(arr: T[], n: number, fill: T): T[] {
  if (arr.length > n) return arr.slice(0, n);
  const out = arr.slice();
  while (out.length < n) out.push(fill);
  return out;
}

/**
 * Recompute the edge list from the faces, keeping loose edges that are still valid
 * and preserving the selection state of edges that survive.
 */
export function rebuildEdges(m: MeshData): void {
  const oldSel = new Map<string, boolean>();
  m.edges.forEach((e, i) => oldSel.set(edgeKey(e[0], e[1]), !!m.esel[i]));
  const seen = new Set<string>();
  const edges: [number, number][] = [];
  const esel: boolean[] = [];
  const add = (a: number, b: number) => {
    if (a === b) return;
    const k = edgeKey(a, b);
    if (seen.has(k)) return;
    seen.add(k);
    edges.push(a < b ? [a, b] : [b, a]);
    esel.push(oldSel.get(k) ?? false);
  };
  for (const f of m.faces) for (let i = 0; i < f.length; i++) add(f[i], f[(i + 1) % f.length]);
  const nv = m.verts.length;
  for (const e of m.edges) if (e[0] < nv && e[1] < nv) add(e[0], e[1]);
  m.edges = edges;
  m.esel = esel;
}

/** Edges that belong to at least one face. */
export function faceEdgeSet(m: MeshData): Set<string> {
  const s = new Set<string>();
  for (const f of m.faces) for (let i = 0; i < f.length; i++) s.add(edgeKey(f[i], f[(i + 1) % f.length]));
  return s;
}

export function edgeIndexMap(m: MeshData): Map<string, number> {
  const map = new Map<string, number>();
  m.edges.forEach((e, i) => map.set(edgeKey(e[0], e[1]), i));
  return map;
}

// ------------------------------------------------------------------ selection

export type SelectMode = 'VERT' | 'EDGE' | 'FACE';

export function selectModeOf(mode: [boolean, boolean, boolean]): SelectMode {
  if (mode[0]) return 'VERT';
  if (mode[1]) return 'EDGE';
  return 'FACE';
}

/** Flush selection after vertices changed (vertex select mode). */
export function flushFromVerts(m: MeshData): void {
  ensureArrays(m);
  m.edges.forEach((e, i) => (m.esel[i] = m.vsel[e[0]] && m.vsel[e[1]]));
  m.faces.forEach((f, i) => (m.fsel[i] = f.every((v) => m.vsel[v])));
}

/** Flush selection after edges changed (edge select mode). */
export function flushFromEdges(m: MeshData): void {
  ensureArrays(m);
  m.vsel.fill(false);
  m.edges.forEach((e, i) => {
    if (m.esel[i]) { m.vsel[e[0]] = true; m.vsel[e[1]] = true; }
  });
  const emap = edgeIndexMap(m);
  m.faces.forEach((f, i) => {
    let all = true;
    for (let k = 0; k < f.length; k++) {
      const ei = emap.get(edgeKey(f[k], f[(k + 1) % f.length]));
      if (ei === undefined || !m.esel[ei]) { all = false; break; }
    }
    m.fsel[i] = all;
  });
}

/** Flush selection after faces changed (face select mode). */
export function flushFromFaces(m: MeshData): void {
  ensureArrays(m);
  m.vsel.fill(false);
  m.esel.fill(false);
  const emap = edgeIndexMap(m);
  m.faces.forEach((f, i) => {
    if (!m.fsel[i]) return;
    for (let k = 0; k < f.length; k++) {
      m.vsel[f[k]] = true;
      const ei = emap.get(edgeKey(f[k], f[(k + 1) % f.length]));
      if (ei !== undefined) m.esel[ei] = true;
    }
  });
}

export function flushSelection(m: MeshData, mode: SelectMode): void {
  if (mode === 'VERT') flushFromVerts(m);
  else if (mode === 'EDGE') flushFromEdges(m);
  else flushFromFaces(m);
}

export function selectAllMesh(m: MeshData, select: boolean): void {
  ensureArrays(m);
  m.vsel.fill(select);
  m.esel.fill(select);
  m.fsel.fill(select);
}

export function anySelected(m: MeshData): boolean {
  return m.vsel.some(Boolean);
}

// ------------------------------------------------------------------ geometry

export function sub(a: Vec3, b: Vec3): Vec3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
export function add(a: Vec3, b: Vec3): Vec3 { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
export function scale(a: Vec3, s: number): Vec3 { return [a[0] * s, a[1] * s, a[2] * s]; }
export function dot(a: Vec3, b: Vec3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
export function cross(a: Vec3, b: Vec3): Vec3 { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
export function length(a: Vec3): number { return Math.hypot(a[0], a[1], a[2]); }
export function normalize(a: Vec3): Vec3 { const l = length(a); return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; }
export function lerp3(a: Vec3, b: Vec3, t: number): Vec3 { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }

/** Newell's method: robust normal for any planar or non-planar polygon. */
export function polyNormal(verts: Vec3[], f: number[]): Vec3 {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < f.length; i++) {
    const a = verts[f[i]], b = verts[f[(i + 1) % f.length]];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return normalize([nx, ny, nz]);
}

export function polyCenter(verts: Vec3[], f: number[]): Vec3 {
  const c: Vec3 = [0, 0, 0];
  for (const i of f) { c[0] += verts[i][0]; c[1] += verts[i][1]; c[2] += verts[i][2]; }
  return f.length ? scale(c, 1 / f.length) : c;
}

export function polyArea(verts: Vec3[], f: number[]): number {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < f.length; i++) {
    const a = verts[f[i]], b = verts[f[(i + 1) % f.length]];
    const c = cross(a, b);
    nx += c[0]; ny += c[1]; nz += c[2];
  }
  return 0.5 * Math.hypot(nx, ny, nz);
}

/**
 * Triangulate a polygon. Returns triples of indices into `f` (local corner indices).
 * Convex fans are used for triangles and quads; n-gons are ear clipped in their best-fit plane.
 */
export function triangulatePoly(verts: Vec3[], f: number[]): [number, number, number][] {
  const n = f.length;
  if (n < 3) return [];
  if (n === 3) return [[0, 1, 2]];
  if (n === 4) {
    // split along the shorter diagonal to match Blender's beauty-ish behaviour
    const d02 = length(sub(verts[f[0]], verts[f[2]]));
    const d13 = length(sub(verts[f[1]], verts[f[3]]));
    return d02 <= d13 + 1e-9 ? [[0, 1, 2], [0, 2, 3]] : [[0, 1, 3], [1, 2, 3]];
  }
  const nrm = polyNormal(verts, f);
  // build a 2D basis for the polygon plane
  const ref: Vec3 = Math.abs(nrm[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u = normalize(cross(ref, nrm));
  const v = cross(nrm, u);
  const pts = f.map((i) => new Vector2(dot(verts[i], u), dot(verts[i], v)));
  try {
    const tris = ShapeUtils.triangulateShape(pts, []);
    if (tris.length === n - 2) return tris.map((t) => [t[0], t[1], t[2]] as [number, number, number]);
  } catch {
    /* fall through to fan */
  }
  const out: [number, number, number][] = [];
  for (let i = 1; i < n - 1; i++) out.push([0, i, i + 1]);
  return out;
}

export function meshBounds(verts: Vec3[]): { min: Vec3; max: Vec3 } {
  if (!verts.length) return { min: [-1, -1, -1], max: [1, 1, 1] };
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of verts) for (let k = 0; k < 3; k++) { if (p[k] < min[k]) min[k] = p[k]; if (p[k] > max[k]) max[k] = p[k]; }
  return { min, max };
}

// ------------------------------------------------------------------ topology edits

/** Remove vertices (and every edge/face that uses them). `remove[i] === true` removes vertex i. */
export function removeVerts(m: MeshData, remove: boolean[]): void {
  const remap: number[] = new Array(m.verts.length);
  const verts: Vec3[] = [];
  const vsel: boolean[] = [];
  m.verts.forEach((v, i) => {
    if (remove[i]) remap[i] = -1;
    else { remap[i] = verts.length; verts.push(v); vsel.push(!!m.vsel[i]); }
  });
  const keepFace = m.faces.map((f) => f.every((v) => remap[v] >= 0));
  filterFaces(m, keepFace);
  m.faces = m.faces.map((f) => f.map((v) => remap[v]));
  const edges: [number, number][] = [];
  const esel: boolean[] = [];
  m.edges.forEach((e, i) => {
    const a = remap[e[0]], b = remap[e[1]];
    if (a >= 0 && b >= 0) { edges.push([a, b]); esel.push(!!m.esel[i]); }
  });
  m.verts = verts;
  m.vsel = vsel;
  m.edges = edges;
  m.esel = esel;
  ensureArrays(m);
}

/** Keep only faces where keep[i] is true (vertices are untouched). */
export function filterFaces(m: MeshData, keep: boolean[]): void {
  const faces: number[][] = [], fs: boolean[] = [], sm: boolean[] = [], mt: number[] = [];
  let active = -1;
  m.faces.forEach((f, i) => {
    if (!keep[i]) return;
    if (i === m.activeFace) active = faces.length;
    faces.push(f); fs.push(!!m.fsel[i]); sm.push(!!m.faceSmooth[i]); mt.push(m.faceMat[i] ?? 0);
  });
  m.faces = faces; m.fsel = fs; m.faceSmooth = sm; m.faceMat = mt; m.activeFace = active;
}

/** Remove vertices not used by any face or edge. */
export function removeLooseVerts(m: MeshData): void {
  const used = new Array(m.verts.length).fill(false);
  for (const f of m.faces) for (const v of f) used[v] = true;
  for (const e of m.edges) { used[e[0]] = true; used[e[1]] = true; }
  removeVerts(m, used.map((u) => !u));
}

/** Append a face with attributes. Returns its index. */
export function addFace(m: MeshData, f: number[], opts: { smooth?: boolean; mat?: number; select?: boolean } = {}): number {
  m.faces.push(f);
  m.faceSmooth.push(opts.smooth ?? false);
  m.faceMat.push(opts.mat ?? 0);
  m.fsel.push(opts.select ?? false);
  return m.faces.length - 1;
}

export function addVert(m: MeshData, p: Vec3, select = false): number {
  m.verts.push([p[0], p[1], p[2]]);
  m.vsel.push(select);
  return m.verts.length - 1;
}

/** Translate all verts so that `offset` is subtracted (used for origin changes). */
export function translateVerts(m: MeshData, offset: Vec3): void {
  for (const v of m.verts) { v[0] -= offset[0]; v[1] -= offset[1]; v[2] -= offset[2]; }
}

/** Compute per-vertex normals (area weighted average of face normals). */
export function vertexNormals(m: MeshData): Vec3[] {
  const out: Vec3[] = m.verts.map(() => [0, 0, 0] as Vec3);
  for (const f of m.faces) {
    const n = polyNormal(m.verts, f);
    const a = polyArea(m.verts, f) || 1e-6;
    for (const v of f) { out[v][0] += n[0] * a; out[v][1] += n[1] * a; out[v][2] += n[2] * a; }
  }
  return out.map((n) => {
    const l = length(n);
    return l > 1e-12 ? scale(n, 1 / l) : ([0, 0, 1] as Vec3);
  });
}

/** Faces adjacent to each vertex. */
export function vertFaces(m: MeshData): number[][] {
  const out: number[][] = m.verts.map(() => []);
  m.faces.forEach((f, i) => { for (const v of f) out[v].push(i); });
  return out;
}

/** Map from edge key to the faces using that edge. */
export function edgeFaces(m: MeshData): Map<string, number[]> {
  const map = new Map<string, number[]>();
  m.faces.forEach((f, i) => {
    for (let k = 0; k < f.length; k++) {
      const key = edgeKey(f[k], f[(k + 1) % f.length]);
      const l = map.get(key);
      if (l) l.push(i); else map.set(key, [i]);
    }
  });
  return map;
}

/** Make face windings consistent and pointing outwards (approximation of Blender's Recalculate Outside). */
export function recalcNormalsOutside(m: MeshData, onlySelected = false): void {
  const ef = edgeFaces(m);
  const visited = new Array(m.faces.length).fill(false);
  const consider = (i: number) => !onlySelected || m.fsel[i];
  for (let start = 0; start < m.faces.length; start++) {
    if (visited[start] || !consider(start)) continue;
    // BFS one connected island, aligning winding with the start face
    const island: number[] = [];
    const queue = [start];
    visited[start] = true;
    while (queue.length) {
      const fi = queue.shift()!;
      island.push(fi);
      const f = m.faces[fi];
      for (let k = 0; k < f.length; k++) {
        const a = f[k], b = f[(k + 1) % f.length];
        for (const nb of ef.get(edgeKey(a, b)) ?? []) {
          if (nb === fi || visited[nb] || !consider(nb)) continue;
          const g = m.faces[nb];
          // consistent winding means the neighbour traverses the shared edge b->a
          const ia = g.indexOf(a), ib = g.indexOf(b);
          const sameDir = (ia + 1) % g.length === ib;
          if (sameDir) g.reverse();
          visited[nb] = true;
          queue.push(nb);
        }
      }
    }
    // orient the island outward: signed volume relative to the island centroid should be positive
    const verts = new Set<number>();
    for (const fi of island) for (const v of m.faces[fi]) verts.add(v);
    const c: Vec3 = [0, 0, 0];
    verts.forEach((v) => { c[0] += m.verts[v][0]; c[1] += m.verts[v][1]; c[2] += m.verts[v][2]; });
    const cc = scale(c, 1 / Math.max(1, verts.size));
    let vol = 0;
    for (const fi of island) {
      const f = m.faces[fi];
      const n = polyNormal(m.verts, f);
      const fc = polyCenter(m.verts, f);
      vol += dot(n, sub(fc, cc)) * polyArea(m.verts, f);
    }
    if (vol < 0) for (const fi of island) m.faces[fi].reverse();
  }
}

// ------------------------------------------------------------------ primitives

export interface PrimitiveGeometry { verts: Vec3[]; faces: number[][]; edges?: [number, number][] }

export function primPlane(radius = 1): PrimitiveGeometry {
  const r = radius;
  return { verts: [[-r, -r, 0], [r, -r, 0], [r, r, 0], [-r, r, 0]], faces: [[0, 1, 2, 3]] };
}

export function primCube(radius = 1): PrimitiveGeometry {
  const r = radius;
  const verts: Vec3[] = [
    [r, r, -r], [r, -r, -r], [-r, -r, -r], [-r, r, -r],
    [r, r, r], [r, -r, r], [-r, -r, r], [-r, r, r],
  ];
  const faces = [
    [0, 1, 2, 3], // bottom (-Z)
    [4, 7, 6, 5], // top (+Z)
    [0, 4, 5, 1], // +X
    [1, 5, 6, 2], // -Y
    [2, 6, 7, 3], // -X
    [4, 0, 3, 7], // +Y
  ];
  return { verts, faces };
}

export function primCircle(vertices = 32, radius = 1, fill: 'NOTHING' | 'NGON' | 'TRIFAN' = 'NOTHING'): PrimitiveGeometry {
  const verts: Vec3[] = [];
  for (let i = 0; i < vertices; i++) {
    // Blender starts at the top (+Y) and goes clockwise when viewed from above... use CCW from +Y
    const a = (i / vertices) * Math.PI * 2;
    verts.push([-Math.sin(a) * radius, Math.cos(a) * radius, 0]);
  }
  const ring = verts.map((_, i) => i);
  if (fill === 'NGON') return { verts, faces: [ring] };
  if (fill === 'TRIFAN') {
    const c = verts.length;
    verts.push([0, 0, 0]);
    return { verts, faces: ring.map((i) => [c, i, (i + 1) % vertices]) };
  }
  const edges: [number, number][] = ring.map((i) => [i, (i + 1) % vertices]);
  return { verts, faces: [], edges };
}

export function primUVSphere(segments = 32, rings = 16, size = 1): PrimitiveGeometry {
  const verts: Vec3[] = [];
  const faces: number[][] = [];
  verts.push([0, 0, size]); // top pole
  for (let r = 1; r < rings; r++) {
    const phi = (r / rings) * Math.PI;
    const z = Math.cos(phi) * size, rad = Math.sin(phi) * size;
    for (let s = 0; s < segments; s++) {
      const th = (s / segments) * Math.PI * 2;
      verts.push([Math.cos(th) * rad, Math.sin(th) * rad, z]);
    }
  }
  const bottom = verts.length;
  verts.push([0, 0, -size]);
  const idx = (r: number, s: number) => 1 + (r - 1) * segments + (s % segments);
  for (let s = 0; s < segments; s++) faces.push([0, idx(1, s), idx(1, s + 1)]);
  for (let r = 1; r < rings - 1; r++) {
    for (let s = 0; s < segments; s++) faces.push([idx(r, s), idx(r + 1, s), idx(r + 1, s + 1), idx(r, s + 1)]);
  }
  for (let s = 0; s < segments; s++) faces.push([idx(rings - 1, s + 1), idx(rings - 1, s), bottom]);
  return { verts, faces };
}

export function primIcoSphere(subdivisions = 2, size = 1): PrimitiveGeometry {
  const t = (1 + Math.sqrt(5)) / 2;
  let verts: Vec3[] = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map((v) => normalize(v as Vec3));
  let faces: number[][] = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  // Blender's "subdivisions = 1" is the plain icosahedron.
  for (let s = 1; s < subdivisions; s++) {
    const cache = new Map<string, number>();
    const mid = (a: number, b: number) => {
      const k = edgeKey(a, b);
      let i = cache.get(k);
      if (i === undefined) {
        i = verts.length;
        verts.push(normalize(lerp3(verts[a], verts[b], 0.5)));
        cache.set(k, i);
      }
      return i;
    };
    const nf: number[][] = [];
    for (const [a, b, c] of faces) {
      const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
      nf.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = nf;
  }
  verts = verts.map((v) => scale(v, size));
  return { verts, faces };
}

export function primCylinder(vertices = 32, radius = 1, depth = 2, capFill: 'NOTHING' | 'NGON' | 'TRIFAN' = 'NGON'): PrimitiveGeometry {
  return primCone(vertices, radius, radius, depth, capFill, capFill);
}

export function primCone(
  vertices = 32, radius1 = 1, radius2 = 0, depth = 2,
  baseFill: 'NOTHING' | 'NGON' | 'TRIFAN' = 'NGON', topFill: 'NOTHING' | 'NGON' | 'TRIFAN' = 'NGON',
): PrimitiveGeometry {
  const verts: Vec3[] = [];
  const faces: number[][] = [];
  const h = depth / 2;
  const ring = (r: number, z: number) => {
    const start = verts.length;
    for (let i = 0; i < vertices; i++) {
      const a = (i / vertices) * Math.PI * 2;
      verts.push([-Math.sin(a) * r, Math.cos(a) * r, z]);
    }
    return start;
  };
  const b = ring(radius1, -h);
  const topIsPoint = radius2 <= 0;
  if (topIsPoint) {
    const tip = verts.length;
    verts.push([0, 0, h]);
    for (let i = 0; i < vertices; i++) faces.push([b + i, b + ((i + 1) % vertices), tip]);
  } else {
    const t = ring(radius2, h);
    for (let i = 0; i < vertices; i++) {
      const j = (i + 1) % vertices;
      faces.push([b + i, b + j, t + j, t + i]);
    }
    if (topFill === 'NGON') faces.push(Array.from({ length: vertices }, (_, i) => t + i));
    else if (topFill === 'TRIFAN') {
      const c = verts.length;
      verts.push([0, 0, h]);
      for (let i = 0; i < vertices; i++) faces.push([t + i, t + ((i + 1) % vertices), c]);
    }
  }
  // base faces downwards: reverse winding
  if (baseFill === 'NGON') faces.push(Array.from({ length: vertices }, (_, i) => b + (vertices - 1 - i)));
  else if (baseFill === 'TRIFAN') {
    const c = verts.length;
    verts.push([0, 0, -h]);
    for (let i = 0; i < vertices; i++) faces.push([b + ((i + 1) % vertices), b + i, c]);
  }
  // cones and cylinders in Blender have side faces winding outward; ours go CCW seen from outside:
  // ring goes counter-clockwise seen from +Z (starting at +Y, towards -X), so [b+i, b+j, t+j, t+i] faces outward.
  return { verts, faces };
}

export function primTorus(majorSegments = 48, minorSegments = 12, majorRadius = 1, minorRadius = 0.25): PrimitiveGeometry {
  const verts: Vec3[] = [];
  const faces: number[][] = [];
  for (let i = 0; i < majorSegments; i++) {
    const u = (i / majorSegments) * Math.PI * 2;
    for (let j = 0; j < minorSegments; j++) {
      const v = (j / minorSegments) * Math.PI * 2;
      const r = majorRadius + Math.cos(v) * minorRadius;
      verts.push([Math.cos(u) * r, Math.sin(u) * r, Math.sin(v) * minorRadius]);
    }
  }
  const id = (i: number, j: number) => (i % majorSegments) * minorSegments + (j % minorSegments);
  for (let i = 0; i < majorSegments; i++) {
    for (let j = 0; j < minorSegments; j++) faces.push([id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j + 1)]);
  }
  return { verts, faces };
}

export function primGrid(xSub = 10, ySub = 10, radius = 1): PrimitiveGeometry {
  const verts: Vec3[] = [];
  const faces: number[][] = [];
  const nx = Math.max(2, xSub), ny = Math.max(2, ySub);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) verts.push([(i / (nx - 1) * 2 - 1) * radius, (j / (ny - 1) * 2 - 1) * radius, 0]);
  }
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      faces.push([a, a + 1, a + nx + 1, a + nx]);
    }
  }
  return { verts, faces };
}

/** Deep copy of mesh data under a new id/name. */
export function copyMeshData(src: MeshData, id: string, name: string): MeshData {
  const m: MeshData = JSON.parse(JSON.stringify(src));
  m.id = id;
  m.name = name;
  m.fakeUser = false;
  return m;
}
