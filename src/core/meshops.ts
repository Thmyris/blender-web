// Edit-mode mesh operators (Blender 2.79b semantics) working directly on MeshData.
//
// Every operator mutates the mesh in place and leaves the MeshData invariants intact:
//  - faces are valid polygons (>= 3 unique verts, CCW seen from outside),
//  - `edges` contains every face edge plus loose edges, unique with a < b,
//  - selection / attribute arrays are parallel to their element arrays.
//
// The general pattern used by the topology operators is:
//  1. read the current topology (edge -> faces maps, loose edges, ...),
//  2. append new verts with `addVert` and build the new face list in a `FaceList`,
//  3. install the faces and rebuild the edge list from the faces plus an explicit list of
//     loose edges (`rebuildEdgesWith`), so edges that no longer belong to any face vanish,
//  4. drop vertices that became unused and flush the selection.

import type { MeshData, Vec3 } from './types';
import {
  edgeKey, rebuildEdges, ensureArrays, flushFromVerts, flushFromEdges, flushFromFaces, flushSelection,
  edgeIndexMap, removeVerts, filterFaces, addFace, addVert, polyNormal, polyCenter, vertexNormals,
  edgeFaces, recalcNormalsOutside, triangulatePoly, selectAllMesh, faceEdgeSet,
  add, sub, scale, dot, cross, normalize, length, lerp3,
} from './mesh';
import type { SelectMode } from './mesh';

type Edge = [number, number];

/** A standalone piece of mesh geometry (indices based at 0), e.g. the result of Separate. */
export interface MeshPart {
  verts: Vec3[];
  faces: number[][];
  edges: [number, number][];
  faceSmooth: boolean[];
  faceMat: number[];
}

// =================================================================== internal helpers

const normEdge = (a: number, b: number): Edge => (a < b ? [a, b] : [b, a]);

/** Small deterministic PRNG (mulberry32). */
function rng32(seed: number): () => number {
  let a = (Math.floor(seed) * 0x9e3779b1) ^ 0x5bd1e995;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Union-find whose roots are always the smallest index of their set. */
class DSU {
  p: Int32Array;
  constructor(n: number) {
    this.p = new Int32Array(n);
    for (let i = 0; i < n; i++) this.p[i] = i;
  }
  find(x: number): number {
    const p = this.p;
    while (p[x] !== x) { p[x] = p[p[x]]; x = p[x]; }
    return x;
  }
  union(a: number, b: number): void {
    a = this.find(a); b = this.find(b);
    if (a === b) return;
    if (a < b) this.p[b] = a; else this.p[a] = b;
  }
}

/**
 * Split a polygon that may contain repeated vertices (e.g. after welding) into valid simple
 * loops. Consecutive repeats are dropped; a vertex that re-appears later closes a sub-loop
 * which is emitted separately. Loops with fewer than 3 vertices are discarded. Winding is kept.
 */
export function cleanPoly(f: number[]): number[][] {
  const out: number[][] = [];
  const stack: number[] = [];
  const pos = new Map<number, number>();
  for (const v of f) {
    const p = pos.get(v);
    if (p !== undefined) {
      const loop = stack.splice(p);
      for (const u of loop) pos.delete(u);
      if (loop.length >= 3) out.push(loop);
    }
    pos.set(v, stack.length);
    stack.push(v);
  }
  if (stack.length >= 3) out.push(stack);
  return out;
}

/** Accumulates a new face list together with its per-face attributes. */
class FaceList {
  faces: number[][] = [];
  smooth: boolean[] = [];
  mat: number[] = [];
  sel: boolean[] = [];
  active = -1;
  push(f: number[], smooth: boolean, mat: number, sel: boolean, active = false): void {
    const polys = f.length >= 3 && new Set(f).size === f.length ? [f] : cleanPoly(f);
    for (const p of polys) {
      if (active && this.active < 0) this.active = this.faces.length;
      this.faces.push(p);
      this.smooth.push(smooth);
      this.mat.push(mat);
      this.sel.push(sel);
    }
  }
  /** Push a face inheriting attributes from face `src` of `md` (src < 0: defaults). */
  pushFrom(md: MeshData, src: number, f: number[], sel: boolean, inheritActive = true): void {
    this.push(f, src >= 0 ? !!md.faceSmooth[src] : false, src >= 0 ? md.faceMat[src] ?? 0 : 0, sel,
      inheritActive && src >= 0 && src === md.activeFace);
  }
  apply(md: MeshData): void {
    md.faces = this.faces;
    md.faceSmooth = this.smooth;
    md.faceMat = this.mat;
    md.fsel = this.sel;
    md.activeFace = this.active;
  }
}

/** Edges that are not used by any face. */
function looseEdges(md: MeshData): Edge[] {
  const fe = faceEdgeSet(md);
  const out: Edge[] = [];
  for (const e of md.edges) if (!fe.has(edgeKey(e[0], e[1]))) out.push([e[0], e[1]]);
  return out;
}

/**
 * Rebuild `md.edges` from the faces plus the given loose edges only (old face edges that no
 * longer belong to a face disappear). Edge selection is reset: every caller re-flushes the
 * selection afterwards (vertex indices may have changed, so old keys are meaningless anyway).
 */
function rebuildEdgesWith(md: MeshData, loose: Edge[]): void {
  md.edges = loose.filter((e) => e[0] !== e[1]).map((e) => normEdge(e[0], e[1]));
  md.esel = md.edges.map(() => false);
  rebuildEdges(md);
  ensureArrays(md);
}

/** Remove those candidate verts that are no longer used by any face or edge. */
function removeUnusedVerts(md: MeshData, candidates: Iterable<number>): void {
  const nv = md.verts.length;
  const used = new Uint8Array(nv);
  for (const f of md.faces) for (const v of f) used[v] = 1;
  for (const e of md.edges) { used[e[0]] = 1; used[e[1]] = 1; }
  const rm: boolean[] = new Array(nv).fill(false);
  let any = false;
  for (const c of candidates) if (c < nv && !used[c]) { rm[c] = true; any = true; }
  if (any) removeVerts(md, rm);
}

/** +1 if polygon f traverses a->b, -1 if it traverses b->a, 0 if a-b is not one of its edges. */
function traverses(f: number[], a: number, b: number): number {
  const n = f.length;
  const i = f.indexOf(a);
  if (i < 0) return 0;
  if (f[(i + 1) % n] === b) return 1;
  if (f[(i + n - 1) % n] === b) return -1;
  return 0;
}

function selectedFaces(md: MeshData): number[] {
  const out: number[] = [];
  for (let i = 0; i < md.faces.length; i++) if (md.fsel[i]) out.push(i);
  return out;
}

/** Connected components (through shared edges) of the given faces. */
function faceRegions(md: MeshData, faces: number[], ef: Map<string, number[]>): number[][] {
  const inSet = new Set(faces);
  const seen = new Set<number>();
  const regions: number[][] = [];
  for (const start of faces) {
    if (seen.has(start)) continue;
    const region: number[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const fi = stack.pop()!;
      region.push(fi);
      const f = md.faces[fi];
      for (let k = 0; k < f.length; k++) {
        for (const g of ef.get(edgeKey(f[k], f[(k + 1) % f.length])) ?? []) {
          if (inSet.has(g) && !seen.has(g)) { seen.add(g); stack.push(g); }
        }
      }
    }
    regions.push(region);
  }
  return regions;
}

/**
 * Boundary edges of a face region, directed as traversed by the region face that uses them.
 * An edge is a boundary edge when exactly one face of the region uses it.
 */
export function faceRegionBoundary(md: MeshData, faceSet: Set<number>): [number, number][] {
  const count = new Map<string, number>();
  faceSet.forEach((fi) => {
    const f = md.faces[fi];
    for (let k = 0; k < f.length; k++) {
      const key = edgeKey(f[k], f[(k + 1) % f.length]);
      count.set(key, (count.get(key) ?? 0) + 1);
    }
  });
  const out: [number, number][] = [];
  faceSet.forEach((fi) => {
    const f = md.faces[fi];
    for (let k = 0; k < f.length; k++) {
      const a = f[k], b = f[(k + 1) % f.length];
      if (count.get(edgeKey(a, b)) === 1) out.push([a, b]);
    }
  });
  return out;
}

/** Vertex adjacency through edges. */
function vertNeighbors(md: MeshData): number[][] {
  const out: number[][] = md.verts.map(() => []);
  for (const [a, b] of md.edges) { out[a].push(b); out[b].push(a); }
  return out;
}

/** Union-find over all verts connected by edges (face edges are always in md.edges). */
function vertComponents(md: MeshData): DSU {
  const dsu = new DSU(md.verts.length);
  for (const [a, b] of md.edges) dsu.union(a, b);
  for (const f of md.faces) for (let k = 1; k < f.length; k++) dsu.union(f[0], f[k]);
  return dsu;
}

/** Remove a face's duplicates of identical vertex sets (keeps the first). */
function faceSetKey(f: number[]): string {
  return f.slice().sort((x, y) => x - y).join(',');
}

// =================================================================== extrude

interface ExtrudeOptions {
  faces: 'REGION' | 'INDIVIDUAL' | 'NONE';
  /** NONFACE: selected edges not belonging to an extruded face; ALL: every selected edge. */
  edges: 'NONFACE' | 'ALL' | 'NONE';
  /** LONE: selected verts not on a selected edge/face; ALL: every selected vert. */
  verts: 'LONE' | 'ALL' | 'NONE';
}

interface NewFace { f: number[]; src: number; sel: boolean; active?: boolean }

/** Shared implementation of all extrude flavours. Returns null when nothing was extruded. */
function extrudeCore(md: MeshData, opt: ExtrudeOptions): { normal: Vec3 } | null {
  ensureArrays(md);
  const nv0 = md.verts.length;
  const nf = md.faces.length;
  const ef = edgeFaces(md);
  const loose = looseEdges(md);
  const newLoose: Edge[] = [];
  const created: NewFace[] = [];
  const removed = new Array<boolean>(nf).fill(false);
  const flipped = new Set<number>();
  const normalSum: Vec3 = [0, 0, 0];

  // One shared duplicate per vertex so that extruded faces, edges and verts stay connected.
  const dupMap = new Map<number, number>();
  const dup = (v: number): number => {
    let d = dupMap.get(v);
    if (d === undefined) { d = addVert(md, md.verts[v]); dupMap.set(v, d); }
    return d;
  };

  const selFaces = opt.faces === 'NONE' ? [] : selectedFaces(md);
  const faceSel = new Set(selFaces);
  const extrudedEdgeKeys = new Set<string>();

  if (opt.faces === 'REGION') {
    for (const region of faceRegions(md, selFaces, ef)) {
      // count region faces per edge; an edge used once is on the region boundary
      const cnt = new Map<string, number>();
      // Like Blender: the original faces are deleted only when the region borders unselected
      // faces; an isolated region (e.g. a lone plane) keeps them, flipped, closing the volume.
      let bordered = false;
      for (const fi of region) {
        const f = md.faces[fi];
        for (let k = 0; k < f.length; k++) {
          const key = edgeKey(f[k], f[(k + 1) % f.length]);
          cnt.set(key, (cnt.get(key) ?? 0) + 1);
          extrudedEdgeKeys.add(key);
          for (const g of ef.get(key)!) if (!faceSel.has(g)) bordered = true;
        }
      }
      for (const fi of region) {
        const f = md.faces[fi];
        const n = polyNormal(md.verts, f);
        normalSum[0] += n[0]; normalSum[1] += n[1]; normalSum[2] += n[2];
        created.push({ f: f.map(dup), src: fi, sel: true, active: fi === md.activeFace });
        for (let k = 0; k < f.length; k++) {
          const a = f[k], b = f[(k + 1) % f.length];
          // side quad traverses a->b (opposite of the neighbour) and b'->a' (opposite of the top)
          if (cnt.get(edgeKey(a, b)) === 1) created.push({ f: [a, b, dup(b), dup(a)], src: fi, sel: false });
        }
        if (bordered) removed[fi] = true; else flipped.add(fi);
      }
    }
  } else if (opt.faces === 'INDIVIDUAL') {
    for (const fi of selFaces) {
      const f = md.faces[fi];
      const n = polyNormal(md.verts, f);
      normalSum[0] += n[0]; normalSum[1] += n[1]; normalSum[2] += n[2];
      const local = f.map((v) => addVert(md, md.verts[v]));
      created.push({ f: local, src: fi, sel: true, active: fi === md.activeFace });
      for (let k = 0; k < f.length; k++) {
        const k2 = (k + 1) % f.length;
        created.push({ f: [f[k], f[k2], local[k2], local[k]], src: fi, sel: false });
        extrudedEdgeKeys.add(edgeKey(f[k], f[k2]));
      }
      removed[fi] = true;
    }
  }

  // edges -> quads
  const onSelEdge = new Uint8Array(nv0);
  if (opt.edges !== 'NONE') {
    for (let i = 0; i < md.edges.length; i++) {
      if (!md.esel[i]) continue;
      const [a, b] = md.edges[i];
      onSelEdge[a] = 1; onSelEdge[b] = 1;
      const key = edgeKey(a, b);
      if (opt.edges === 'NONFACE' && extrudedEdgeKeys.has(key)) continue;
      const adj = ef.get(key) ?? [];
      const src = adj.length ? adj[0] : -1;
      // orient against the adjacent face so the new quad continues its winding
      const q = src >= 0 && traverses(md.faces[src], a, b) === 1 ? [b, a, dup(a), dup(b)] : [a, b, dup(b), dup(a)];
      created.push({ f: q, src, sel: false });
    }
  } else {
    for (let i = 0; i < md.edges.length; i++) if (md.esel[i]) { onSelEdge[md.edges[i][0]] = 1; onSelEdge[md.edges[i][1]] = 1; }
  }

  // verts -> edges
  if (opt.verts !== 'NONE') {
    for (let v = 0; v < nv0; v++) {
      if (!md.vsel[v]) continue;
      if (opt.verts === 'LONE' && (onSelEdge[v] || dupMap.has(v))) continue;
      newLoose.push([v, dup(v)]);
    }
  }

  if (md.verts.length === nv0) return null; // nothing extruded

  const out = new FaceList();
  const removedVerts: number[] = [];
  const activeMoved = created.some((c) => c.active);
  for (let fi = 0; fi < nf; fi++) {
    if (removed[fi]) { removedVerts.push(...md.faces[fi]); continue; }
    const f = flipped.has(fi) ? md.faces[fi].slice().reverse() : md.faces[fi];
    out.pushFrom(md, fi, f, false, !activeMoved);
  }
  for (const c of created) out.pushFrom(md, c.src, c.f, c.sel, !!c.active);
  out.apply(md);
  rebuildEdgesWith(md, [...loose, ...newLoose]);
  md.vsel = md.verts.map((_, i) => i >= nv0);
  removeUnusedVerts(md, removedVerts);
  flushFromVerts(md);
  return { normal: selFaces.length ? normalize(normalSum) : [0, 0, 0] };
}

/**
 * Extrude Region (E). Selected faces are extruded as connected regions; in edge/vertex mode
 * selected edges outside the face region become quads and lone selected verts become edges.
 * Returns the average normal of the extruded faces (zero if only edges/verts were extruded).
 */
export function extrudeRegion(md: MeshData, mode: SelectMode): { normal: Vec3 } {
  const r = extrudeCore(md, {
    faces: 'REGION',
    edges: mode === 'FACE' ? 'NONE' : 'NONFACE',
    verts: mode === 'VERT' ? 'LONE' : 'NONE',
  });
  return r ?? { normal: [0, 0, 0] };
}

/** Extrude Individual Faces: every selected face gets its own side walls. */
export function extrudeIndividual(md: MeshData): void {
  extrudeCore(md, { faces: 'INDIVIDUAL', edges: 'NONE', verts: 'NONE' });
}

/** Extrude Edges Only: every selected edge becomes a quad (faces are ignored). */
export function extrudeEdgesOnly(md: MeshData): void {
  extrudeCore(md, { faces: 'NONE', edges: 'ALL', verts: 'NONE' });
}

/** Extrude Vertices Only: every selected vertex gets a new connected vertex. */
export function extrudeVertsOnly(md: MeshData): void {
  extrudeCore(md, { faces: 'NONE', edges: 'NONE', verts: 'ALL' });
}

// =================================================================== delete

/** Delete menu (X) with Blender semantics. Leaves nothing selected. */
export function deleteElements(md: MeshData, type: 'VERT' | 'EDGE' | 'FACE' | 'EDGE_FACE' | 'ONLY_FACE'): void {
  ensureArrays(md);
  const nv = md.verts.length, nf = md.faces.length, ne = md.edges.length;
  const removeFace = new Array<boolean>(nf).fill(false);
  const removeEdge = new Array<boolean>(ne).fill(false);
  const removeVert = new Array<boolean>(nv).fill(false);
  const emap = edgeIndexMap(md);
  const faceHasSelEdge = (f: number[]) => {
    for (let k = 0; k < f.length; k++) {
      const ei = emap.get(edgeKey(f[k], f[(k + 1) % f.length]));
      if (ei !== undefined && md.esel[ei]) return true;
    }
    return false;
  };
  /** Remove `candidates` verts that no surviving face or edge uses. */
  const removeOrphans = (candidates: Iterable<number>) => {
    const used = new Uint8Array(nv);
    md.faces.forEach((f, i) => { if (!removeFace[i]) for (const v of f) used[v] = 1; });
    md.edges.forEach((e, i) => { if (!removeEdge[i]) { used[e[0]] = 1; used[e[1]] = 1; } });
    for (const v of candidates) if (!used[v]) removeVert[v] = true;
  };

  switch (type) {
    case 'VERT':
      for (let v = 0; v < nv; v++) removeVert[v] = !!md.vsel[v];
      break;
    case 'EDGE': {
      const cand: number[] = [];
      for (let i = 0; i < ne; i++) if (md.esel[i]) { removeEdge[i] = true; cand.push(md.edges[i][0], md.edges[i][1]); }
      md.faces.forEach((f, i) => { if (faceHasSelEdge(f)) removeFace[i] = true; });
      removeOrphans(cand);
      break;
    }
    case 'FACE': {
      const cand: number[] = [];
      for (let i = 0; i < nf; i++) if (md.fsel[i]) { removeFace[i] = true; cand.push(...md.faces[i]); }
      const keptEdges = new Set<string>();
      md.faces.forEach((f, i) => {
        if (!removeFace[i]) for (let k = 0; k < f.length; k++) keptEdges.add(edgeKey(f[k], f[(k + 1) % f.length]));
      });
      md.faces.forEach((f, i) => {
        if (!removeFace[i]) return;
        for (let k = 0; k < f.length; k++) {
          const key = edgeKey(f[k], f[(k + 1) % f.length]);
          const ei = emap.get(key);
          if (ei !== undefined && !keptEdges.has(key)) removeEdge[ei] = true;
        }
      });
      removeOrphans(cand);
      break;
    }
    case 'EDGE_FACE':
      for (let i = 0; i < ne; i++) removeEdge[i] = !!md.esel[i];
      md.faces.forEach((f, i) => { if (md.fsel[i] || faceHasSelEdge(f)) removeFace[i] = true; });
      break;
    case 'ONLY_FACE':
      for (let i = 0; i < nf; i++) removeFace[i] = !!md.fsel[i];
      break;
  }

  filterFaces(md, removeFace.map((r) => !r));
  md.esel = md.esel.filter((_, i) => !removeEdge[i]);
  md.edges = md.edges.filter((_, i) => !removeEdge[i]);
  removeVerts(md, removeVert);
  rebuildEdges(md);
  ensureArrays(md);
  selectAllMesh(md, false);
}

/**
 * Delete Loose: remove loose edges (no faces) and loose verts (no edges). Returns the number of
 * removed elements (edges + verts). With `onlySelected` only selected loose elements are removed.
 */
export function deleteLoose(md: MeshData, onlySelected = false): number {
  ensureArrays(md);
  const fe = faceEdgeSet(md);
  const rmEdge = md.edges.map((e, i) => !fe.has(edgeKey(e[0], e[1])) && (!onlySelected || !!md.esel[i]));
  let count = 0;
  for (const r of rmEdge) if (r) count++;
  md.esel = md.esel.filter((_, i) => !rmEdge[i]);
  md.edges = md.edges.filter((_, i) => !rmEdge[i]);
  const used = new Uint8Array(md.verts.length);
  for (const f of md.faces) for (const v of f) used[v] = 1;
  for (const e of md.edges) { used[e[0]] = 1; used[e[1]] = 1; }
  const rmVert = md.verts.map((_, i) => !used[i] && (!onlySelected || !!md.vsel[i]));
  for (const r of rmVert) if (r) count++;
  removeVerts(md, rmVert);
  ensureArrays(md);
  return count;
}

// =================================================================== make edge / face

/** Pick a winding for a new face: opposite to existing neighbours across shared edges, else outward / +Z. */
function orientNewFace(md: MeshData, f: number[], ef: Map<string, number[]>): { face: number[]; src: number } {
  let vote = 0, src = -1;
  for (let k = 0; k < f.length; k++) {
    const a = f[k], b = f[(k + 1) % f.length];
    for (const g of ef.get(edgeKey(a, b)) ?? []) {
      const t = traverses(md.faces[g], a, b);
      vote -= t; // neighbour traversing a->b means we must traverse b->a
      if (src < 0) src = g;
    }
  }
  if (vote < 0) return { face: f.slice().reverse(), src };
  if (vote > 0) return { face: f, src };
  const n = polyNormal(md.verts, f);
  const fc = polyCenter(md.verts, f);
  // outward guess relative to the mesh centroid
  const c: Vec3 = [0, 0, 0];
  for (const p of md.verts) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
  const mc = scale(c, 1 / Math.max(1, md.verts.length));
  const d = sub(fc, mc);
  const s = dot(n, d);
  if (Math.abs(s) > 1e-5 * Math.max(1e-9, length(d)) && length(d) > 1e-6) return { face: s < 0 ? f.slice().reverse() : f, src };
  // view independent fallback: face +Z (then +Y, then +X)
  const comp = Math.abs(n[2]) > 1e-6 ? n[2] : Math.abs(n[1]) > 1e-6 ? n[1] : n[0];
  return { face: comp < 0 ? f.slice().reverse() : f, src };
}

/**
 * Make Edge/Face (F). 2 selected verts -> edge; closed loops of selected edges -> n-gons;
 * an open chain of selected edges -> face closing the chain; 3-4 unconnected verts -> face sorted
 * around their centroid. Returns an error message or null on success.
 */
export function makeEdgeFace(md: MeshData): string | null {
  ensureArrays(md);
  const sv: number[] = [];
  for (let v = 0; v < md.verts.length; v++) if (md.vsel[v]) sv.push(v);
  if (sv.length < 2) return 'Select at least 2 vertices';
  if (sv.length === 2) {
    const [a, b] = sv;
    const emap = edgeIndexMap(md);
    const ei = emap.get(edgeKey(a, b));
    if (ei === undefined) { md.edges.push(normEdge(a, b)); md.esel.push(true); } else md.esel[ei] = true;
    ensureArrays(md);
    return null;
  }

  const svSet = new Set(sv);
  const adj = new Map<number, number[]>();
  for (const v of sv) adj.set(v, []);
  md.edges.forEach((e, i) => {
    if (md.esel[i] && svSet.has(e[0]) && svSet.has(e[1])) { adj.get(e[0])!.push(e[1]); adj.get(e[1])!.push(e[0]); }
  });

  // walk the components of the selected-edge graph
  const seen = new Set<number>();
  const comps: number[][] = [];
  for (const v of sv) {
    if (seen.has(v)) continue;
    const comp: number[] = [];
    const stack = [v];
    seen.add(v);
    while (stack.length) {
      const x = stack.pop()!;
      comp.push(x);
      for (const y of adj.get(x)!) if (!seen.has(y)) { seen.add(y); stack.push(y); }
    }
    comps.push(comp);
  }
  /** Order a component along its edges (cycle or path); null if it is neither. */
  const orderChain = (comp: number[]): { order: number[]; closed: boolean } | null => {
    const ends = comp.filter((v) => adj.get(v)!.length === 1);
    if (comp.some((v) => adj.get(v)!.length > 2)) return null;
    if (ends.length !== 0 && ends.length !== 2) return null;
    const start = ends.length ? ends[0] : comp[0];
    const order = [start];
    let prev = -1, cur = start;
    for (;;) {
      const nxt = adj.get(cur)!.find((y) => y !== prev && y !== start);
      if (nxt === undefined) break;
      order.push(nxt);
      prev = cur; cur = nxt;
      if (order.length > comp.length) return null;
    }
    if (order.length !== comp.length) return null;
    return { order, closed: ends.length === 0 };
  };

  let polys: number[][] | null = null;
  const chains = comps.map(orderChain);
  if (chains.every((c) => c && c.closed && c.order.length >= 3)) {
    polys = chains.map((c) => c!.order); // every component is a closed loop: fill each
  } else if (comps.length === 1 && chains[0] && !chains[0].closed && chains[0].order.length >= 3) {
    polys = [chains[0].order]; // a single open chain: close it
  } else if (sv.length <= 4) {
    // sort around the centroid in the best-fit plane
    const pts = sv.map((v) => md.verts[v]);
    const c = scale(pts.reduce((acc, p) => add(acc, p), [0, 0, 0] as Vec3), 1 / pts.length);
    let n: Vec3 = [0, 0, 0], best = -1;
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) for (let k = j + 1; k < pts.length; k++) {
      const cr = cross(sub(pts[j], pts[i]), sub(pts[k], pts[i]));
      const l = length(cr);
      if (l > best) { best = l; n = cr; }
    }
    if (best < 1e-12) return 'Selected vertices are collinear';
    n = normalize(n);
    const ref: Vec3 = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const u = normalize(cross(ref, n)), w = cross(n, u);
    const ang = sv.map((v) => { const d = sub(md.verts[v], c); return Math.atan2(dot(d, w), dot(d, u)); });
    polys = [sv.map((v, i) => ({ v, a: ang[i] })).sort((x, y) => x.a - y.a).map((x) => x.v)];
  }
  if (!polys) return 'Could not create a face from the selection';

  const existing = new Set(md.faces.map(faceSetKey));
  const ef = edgeFaces(md);
  let made = 0;
  for (const p of polys) {
    if (existing.has(faceSetKey(p))) continue;
    const { face, src } = orientNewFace(md, p, ef);
    addFace(md, face, { smooth: src >= 0 ? !!md.faceSmooth[src] : false, mat: src >= 0 ? md.faceMat[src] : 0, select: true });
    existing.add(faceSetKey(p));
    made++;
  }
  if (!made) return 'Face already exists';
  rebuildEdges(md);
  ensureArrays(md);
  flushFromVerts(md);
  return null;
}

// =================================================================== subdivide

/** Insert cut verts (map: edge key -> verts ordered from the lower to the higher index) into a polygon. */
function insertCuts(f: number[], cutMap: Map<string, number[]>): number[] {
  const out: number[] = [];
  for (let k = 0; k < f.length; k++) {
    const a = f[k], b = f[(k + 1) % f.length];
    out.push(a);
    const c = cutMap.get(edgeKey(a, b));
    if (c) {
      if (a < b) out.push(...c);
      else for (let i = c.length - 1; i >= 0; i--) out.push(c[i]);
    }
  }
  return out;
}

/**
 * Subdivide selected edges with `cuts` new verts each. Fully selected quads become grids,
 * triangles become triangle grids, n-gons become a fan of quads around a centre vertex.
 * Quads with two opposite cut edges are split into strips, quads with two adjacent cut edges use
 * the "inner vert" corner pattern (all quads); any other partially cut face just gains the new
 * verts on its boundary. `smoothness` bulges new verts along the vertex normals.
 */
export function subdivide(md: MeshData, cuts = 1, smoothness = 0): void {
  ensureArrays(md);
  cuts = Math.max(1, Math.floor(cuts));
  const n = cuts + 1;
  const vnorm = smoothness ? vertexNormals(md) : null;
  const loose = looseEdges(md);
  const cutMap = new Map<string, number[]>();
  let any = false;
  for (let i = 0; i < md.edges.length; i++) {
    if (!md.esel[i]) continue;
    any = true;
    const [a, b] = md.edges[i];
    const pa = md.verts[a], pb = md.verts[b];
    let off: Vec3 = [0, 0, 0];
    if (vnorm) {
      // Bulge like a circular arc through both ends with the vertex normals as radii:
      // sagitta = L/2 * tan(theta/4) where theta is the angle between the end normals.
      const na = vnorm[a], nb = vnorm[b];
      const theta = Math.acos(Math.max(-1, Math.min(1, dot(na, nb))));
      const dir = normalize(add(na, nb));
      off = scale(dir, smoothness * 0.5 * length(sub(pb, pa)) * Math.tan(theta / 4));
    }
    const list: number[] = [];
    for (let k = 1; k <= cuts; k++) {
      const t = k / n;
      list.push(addVert(md, add(lerp3(pa, pb, t), scale(off, 4 * t * (1 - t))), true));
    }
    cutMap.set(edgeKey(a, b), list);
  }
  if (!any) return;

  /** [a, cuts..., b] ordered from a to b, or null if a-b is not cut. */
  const pts = (a: number, b: number): number[] | null => {
    const c = cutMap.get(edgeKey(a, b));
    if (!c) return null;
    return [a, ...(a < b ? c : c.slice().reverse()), b];
  };
  const P = (i: number) => md.verts[i];

  const out = new FaceList();
  md.faces.forEach((f, fi) => {
    const m = f.length;
    const sel = !!md.fsel[fi];
    const push = (g: number[]) => out.pushFrom(md, fi, g, sel);
    const cutK: boolean[] = [];
    let count = 0;
    for (let k = 0; k < m; k++) { const c = cutMap.has(edgeKey(f[k], f[(k + 1) % m])); cutK.push(c); if (c) count++; }
    if (count === 0) { push(f); return; }

    if (count === m && m === 4) {
      // grid: G[i][j], i along v0->v1, j along v0->v3; interior points from a Coons patch
      const [v0, v1, v2, v3] = f;
      const bot = pts(v0, v1)!, top = pts(v3, v2)!, lft = pts(v0, v3)!, rgt = pts(v1, v2)!;
      const G: number[][] = [];
      for (let i = 0; i <= n; i++) {
        G.push([]);
        for (let j = 0; j <= n; j++) {
          if (j === 0) G[i].push(bot[i]);
          else if (j === n) G[i].push(top[i]);
          else if (i === 0) G[i].push(lft[j]);
          else if (i === n) G[i].push(rgt[j]);
          else {
            const u = i / n, v = j / n;
            const p = add(add(scale(P(bot[i]), 1 - v), scale(P(top[i]), v)), add(scale(P(lft[j]), 1 - u), scale(P(rgt[j]), u)));
            const bl = add(add(scale(P(v0), (1 - u) * (1 - v)), scale(P(v1), u * (1 - v))), add(scale(P(v2), u * v), scale(P(v3), (1 - u) * v)));
            G[i].push(addVert(md, sub(p, bl), true));
          }
        }
      }
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) push([G[i][j], G[i + 1][j], G[i + 1][j + 1], G[i][j + 1]]);
      return;
    }

    if (count === m && m === 3) {
      // triangle grid T(i, j), i towards B, j towards C, i + j <= n
      const [A, B, C] = f;
      const ab = pts(A, B)!, ac = pts(A, C)!, bc = pts(B, C)!;
      const T: number[][] = [];
      for (let j = 0; j <= n; j++) {
        T.push([]);
        for (let i = 0; i <= n - j; i++) {
          if (j === 0) T[j].push(ab[i]);
          else if (i === 0) T[j].push(ac[j]);
          else if (i === n - j) T[j].push(bc[j]);
          else T[j].push(addVert(md, lerp3(P(ac[j]), P(bc[j]), i / (n - j)), true));
        }
      }
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n - j; i++) {
          push([T[j][i], T[j][i + 1], T[j + 1][i]]);
          if (i + j < n - 1) push([T[j][i + 1], T[j + 1][i + 1], T[j + 1][i]]);
        }
      }
      return;
    }

    if (count === m) {
      // n-gon: quads around each corner meeting at a centre vertex, triangles for extra cuts
      const ring = insertCuts(f, cutMap);
      const c = addVert(md, polyCenter(md.verts, ring), true);
      for (let k = 0; k < m; k++) {
        const prev = pts(f[(k + m - 1) % m], f[k])!, next = pts(f[k], f[(k + 1) % m])!;
        push([prev[n - 1], f[k], next[1], c]);
        for (let i = 1; i < n - 1; i++) push([next[i], next[i + 1], c]);
      }
      return;
    }

    if (m === 4 && count === 2) {
      const k0 = cutK.findIndex((x) => x);
      if (cutK[(k0 + 2) % 4]) {
        // opposite edges: split into strips
        const q = [0, 1, 2, 3].map((i) => f[(k0 + i) % 4]);
        const bot = pts(q[0], q[1])!, top = pts(q[3], q[2])!;
        for (let i = 0; i < n; i++) push([bot[i], bot[i + 1], top[i + 1], top[i]]);
        return;
      }
      // adjacent edges q0-q1 and q1-q2: nested L-shaped rows with inner verts on the q3->q1 diagonal
      const s = cutK[(k0 + 3) % 4] ? (k0 + 3) % 4 : k0;
      const q = [0, 1, 2, 3].map((i) => f[(s + i) % 4]);
      const a = pts(q[0], q[1])!, b = pts(q[1], q[2])!;
      const x: number[] = [q[3]];
      for (let k = 1; k < n; k++) x.push(addVert(md, lerp3(P(q[3]), P(q[1]), k / n), true));
      push([q[0], a[1], x[1], q[3]]);
      push([q[3], x[1], b[n - 1], q[2]]);
      for (let k = 1; k < n - 1; k++) {
        push([a[k], a[k + 1], x[k + 1], x[k]]);
        push([x[k], x[k + 1], b[n - k - 1], b[n - k]]);
      }
      push([a[n - 1], q[1], b[1], x[n - 1]]);
      return;
    }

    // any other partial case: keep the face, it just gains the new boundary verts
    push(insertCuts(f, cutMap));
  });
  out.apply(md);

  const newLoose: Edge[] = [];
  for (const [a, b] of loose) {
    const chain = pts(a, b);
    if (!chain) { newLoose.push([a, b]); continue; }
    for (let i = 0; i < chain.length - 1; i++) newLoose.push([chain[i], chain[i + 1]]);
  }
  rebuildEdgesWith(md, newLoose);
  flushFromVerts(md);
}

// =================================================================== edge ring / loop cut

interface Ring {
  /** Ring edges, oriented so that edges[i][0] corresponds to edges[i+1][0] across the quads. */
  edges: Edge[];
  /** faces[i] lies between edges[i] and edges[i+1] (and between the last and first if closed). */
  faces: number[];
  closed: boolean;
}

/** Neighbour of `x` in polygon f that is not `y`. */
function otherNeighbour(f: number[], x: number, y: number): number {
  const n = f.length, i = f.indexOf(x);
  const a = f[(i + 1) % n], b = f[(i + n - 1) % n];
  return a === y ? b : a;
}

function walkRing(md: MeshData, edgeIndex: number, ef: Map<string, number[]>): Ring {
  const e = md.edges[edgeIndex];
  if (!e) return { edges: [], faces: [], closed: false };
  const [a0, b0] = e;
  const startKey = edgeKey(a0, b0);
  const adj = ef.get(startKey) ?? [];
  const visited = new Set<number>();
  const walk = (f0: number): { edges: Edge[]; faces: number[]; closed: boolean } => {
    const edges: Edge[] = [], faces: number[] = [];
    let x = a0, y = b0, fi = f0;
    while (fi >= 0 && md.faces[fi].length === 4 && !visited.has(fi)) {
      visited.add(fi);
      const f = md.faces[fi];
      const nx = otherNeighbour(f, x, y), ny = otherNeighbour(f, y, x);
      faces.push(fi);
      const key = edgeKey(nx, ny);
      if (key === startKey) return { edges, faces, closed: true };
      edges.push([nx, ny]);
      const nb = ef.get(key) ?? [];
      if (nb.length !== 2) break; // mesh boundary or non-manifold edge
      fi = nb[0] === fi ? nb[1] : nb[0];
      x = nx; y = ny;
    }
    return { edges, faces, closed: false };
  };
  const fwd = walk(adj.length && adj.length <= 2 ? adj[0] : -1);
  if (fwd.closed) return { edges: [[a0, b0], ...fwd.edges], faces: fwd.faces, closed: true };
  const bwd = walk(adj.length === 2 ? adj[1] : -1);
  return {
    edges: [...bwd.edges.slice().reverse(), [a0, b0], ...fwd.edges],
    faces: [...bwd.faces.slice().reverse(), ...fwd.faces],
    closed: false,
  };
}

/** Edge ring through quads starting at `edgeIndex` (both directions), as edge indices. */
export function edgeRing(md: MeshData, edgeIndex: number): number[] {
  const ring = walkRing(md, edgeIndex, edgeFaces(md));
  const emap = edgeIndexMap(md);
  return ring.edges.map(([a, b]) => emap.get(edgeKey(a, b))!).filter((i) => i !== undefined);
}

/**
 * Loop Cut: insert `cuts` evenly spaced edge loops across the ring of `edgeIndex`. With a single
 * cut, `factor` in [-1, 1] slides it towards edges[edgeIndex][0] (-1) or edges[edgeIndex][1] (+1).
 * Returns the new vertex indices; the new loop ends up selected (only).
 */
export function loopCut(md: MeshData, edgeIndex: number, cuts = 1, factor = 0): number[] {
  ensureArrays(md);
  const ef = edgeFaces(md);
  const ring = walkRing(md, edgeIndex, ef);
  if (!ring.edges.length) return [];
  cuts = Math.max(1, Math.floor(cuts));
  const n = cuts + 1;
  const fac = Math.max(-1, Math.min(1, factor));
  const loose = looseEdges(md);
  const nv0 = md.verts.length;

  const cutMap = new Map<string, number[]>();
  const along: number[][] = []; // per ring edge: [x, cuts..., y]
  for (const [x, y] of ring.edges) {
    const list: number[] = [];
    for (let k = 1; k <= cuts; k++) {
      let t = k / n;
      t = fac >= 0 ? t + fac * (1 - t) : t * (1 + fac);
      list.push(addVert(md, lerp3(md.verts[x], md.verts[y], t)));
    }
    along.push([x, ...list, y]);
    cutMap.set(edgeKey(x, y), x < y ? list : list.slice().reverse());
  }

  const ringFace = new Map<number, number>(); // face -> ring position
  ring.faces.forEach((fi, i) => ringFace.set(fi, i));
  const out = new FaceList();
  md.faces.forEach((f, fi) => {
    const sel = !!md.fsel[fi];
    const i = ringFace.get(fi);
    if (i === undefined) { out.pushFrom(md, fi, insertCuts(f, cutMap), sel); return; }
    const A = along[i], B = along[(i + 1) % along.length];
    const forward = traverses(f, A[0], A[n]) === 1;
    for (let k = 0; k < n; k++) {
      const q = [A[k], A[k + 1], B[k + 1], B[k]];
      out.pushFrom(md, fi, forward ? q : q.reverse(), sel);
    }
  });
  out.apply(md);
  rebuildEdgesWith(md, loose);
  md.vsel = md.verts.map((_, i) => i >= nv0);
  flushFromVerts(md);
  const created: number[] = [];
  for (let v = nv0; v < md.verts.length; v++) created.push(v);
  return created;
}

// =================================================================== inset

/**
 * Inset a set of faces as one region: every boundary "wedge" of a vertex (the fan of region
 * faces between two region-boundary edges) gets an inner copy, offset into the region by
 * `thickness` (even offset). Region faces are rewired to the copies in place and rim quads are
 * returned in `rim`. `depth` moves the inner faces along their normals.
 */
function insetFaces(md: MeshData, region: number[], thickness: number, depth: number, rim: NewFace[]): void {
  const regEdge = new Map<string, number[]>();
  for (const fi of region) {
    const f = md.faces[fi];
    for (let k = 0; k < f.length; k++) {
      const key = edgeKey(f[k], f[(k + 1) % f.length]);
      const l = regEdge.get(key);
      if (l) l.push(fi); else regEdge.set(key, [fi]);
    }
  }
  const isBoundary = (a: number, b: number) => regEdge.get(edgeKey(a, b))!.length !== 2;
  const across = (fi: number, a: number, b: number) => { const l = regEdge.get(edgeKey(a, b))!; return l[0] === fi ? l[1] : l[0]; };
  const normals = new Map<number, Vec3>();
  for (const fi of region) normals.set(fi, polyNormal(md.verts, md.faces[fi]));

  /** Rotate around corner (fi, k) crossing interior edges until a boundary edge is hit. */
  const walk = (fi: number, k: number, outgoing: boolean): [number, number] | null => {
    let g = fi, kk = k;
    const seen = new Set<number>();
    for (;;) {
      seen.add(g);
      const f = md.faces[g], m = f.length, v = f[kk];
      const w = outgoing ? f[(kk + 1) % m] : f[(kk + m - 1) % m];
      if (isBoundary(v, w)) return [g, kk];
      const h = across(g, v, w);
      if (seen.has(h)) return null; // the fan closes: interior vertex
      g = h; kk = md.faces[h].indexOf(v);
    }
  };

  const copies = new Map<string, number>();
  const copyOf = (fi: number, k: number): number => {
    const v = md.faces[fi][k];
    const wo = walk(fi, k, true);
    if (!wo) return v;
    const id = `${wo[0]}:${wo[1]}`;
    const got = copies.get(id);
    if (got !== undefined) return got;
    const wi = walk(fi, k, false) ?? wo;
    const fo = md.faces[wo[0]], fin = md.faces[wi[0]];
    const next = fo[(wo[1] + 1) % fo.length], prev = fin[(wi[1] + fin.length - 1) % fin.length];
    const p = md.verts[v];
    // inward directions of both boundary edges in their face planes (left of a CCW edge)
    const d1 = normalize(cross(normals.get(wi[0])!, sub(p, md.verts[prev])));
    const d2 = normalize(cross(normals.get(wo[0])!, sub(md.verts[next], p)));
    const s = add(d1, d2);
    let off: Vec3;
    if (length(s) < 1e-6) off = scale(d1, thickness);
    else {
      const dir = normalize(s);
      off = scale(dir, thickness / Math.max(dot(dir, d1), 0.25)); // even offset, clamped at sharp corners
    }
    const c = addVert(md, add(p, off));
    copies.set(id, c);
    return c;
  };

  const inner = new Map<number, number[]>();
  for (const fi of region) inner.set(fi, md.faces[fi].map((_, k) => copyOf(fi, k)));
  for (const fi of region) {
    const f = md.faces[fi], nf = inner.get(fi)!, m = f.length;
    for (let k = 0; k < m; k++) {
      const k2 = (k + 1) % m;
      if (isBoundary(f[k], f[k2])) rim.push({ f: [f[k], f[k2], nf[k2], nf[k]], src: fi, sel: false });
    }
  }
  if (depth) {
    const acc = new Map<number, Vec3>();
    for (const fi of region) {
      const nrm = normals.get(fi)!;
      for (const v of inner.get(fi)!) acc.set(v, add(acc.get(v) ?? [0, 0, 0], nrm));
    }
    acc.forEach((nrm, v) => { md.verts[v] = add(md.verts[v], scale(normalize(nrm), depth)); });
  }
  for (const fi of region) md.faces[fi] = inner.get(fi)!;
}

/** Inset Faces (I): region inset by default, per face with `individual`. Inner faces stay selected. */
export function inset(md: MeshData, thickness: number, depth = 0, individual = false): void {
  ensureArrays(md);
  const sel = selectedFaces(md);
  if (!sel.length) return;
  const loose = looseEdges(md);
  const rim: NewFace[] = [];
  if (individual) for (const fi of sel) insetFaces(md, [fi], thickness, depth, rim);
  else insetFaces(md, sel, thickness, depth, rim);
  for (const r of rim) addFace(md, r.f, { smooth: !!md.faceSmooth[r.src], mat: md.faceMat[r.src], select: false });
  rebuildEdgesWith(md, loose);
  flushFromFaces(md);
}

// =================================================================== merge / remove doubles

/**
 * Weld vertices: every vertex v is replaced by rep[v] (rep[rep[v]] === rep[v]). Faces are cleaned
 * (repeated verts removed, degenerate faces dropped, coincident faces de-duplicated), edges are
 * remapped and merged verts removed. Returns the number of removed verts.
 */
function weldVerts(md: MeshData, rep: Int32Array): number {
  const nv = md.verts.length;
  let removed = 0;
  for (let v = 0; v < nv; v++) if (rep[v] !== v) removed++;
  if (!removed) return 0;
  const out = new FaceList();
  const seen = new Set<string>();
  md.faces.forEach((f, fi) => {
    for (const p of cleanPoly(f.map((v) => rep[v]))) {
      const key = faceSetKey(p);
      if (seen.has(key)) continue;
      seen.add(key);
      out.pushFrom(md, fi, p, !!md.fsel[fi]);
    }
  });
  const edges: Edge[] = md.edges.map(([a, b]) => [rep[a], rep[b]] as Edge).filter(([a, b]) => a !== b);
  for (let v = 0; v < nv; v++) if (md.vsel[v]) md.vsel[rep[v]] = true;
  out.apply(md);
  rebuildEdgesWith(md, edges);
  const rm: boolean[] = new Array(nv);
  for (let v = 0; v < nv; v++) rm[v] = rep[v] !== v;
  removeVerts(md, rm);
  flushFromVerts(md);
  return removed;
}

/**
 * Merge selected verts (Alt+M). CENTER / CURSOR / FIRST / LAST merge everything into one vertex;
 * COLLAPSE merges every connected island of selected verts at its own centre. Returns the number
 * of removed verts.
 */
export function mergeVerts(
  md: MeshData, type: 'CENTER' | 'CURSOR' | 'COLLAPSE' | 'FIRST' | 'LAST', cursorLocal: Vec3,
  firstIndex?: number, lastIndex?: number,
): number {
  ensureArrays(md);
  const nv = md.verts.length;
  const sel: number[] = [];
  for (let v = 0; v < nv; v++) if (md.vsel[v]) sel.push(v);
  const rep = new Int32Array(nv);
  for (let v = 0; v < nv; v++) rep[v] = v;
  const centroid = (vs: number[]): Vec3 => {
    const c: Vec3 = [0, 0, 0];
    for (const v of vs) { c[0] += md.verts[v][0]; c[1] += md.verts[v][1]; c[2] += md.verts[v][2]; }
    return scale(c, 1 / Math.max(1, vs.length));
  };

  if (type === 'COLLAPSE') {
    const dsu = new DSU(nv);
    for (const [a, b] of md.edges) if (md.vsel[a] && md.vsel[b]) dsu.union(a, b);
    const groups = new Map<number, number[]>();
    for (const v of sel) {
      const r = dsu.find(v);
      const g = groups.get(r);
      if (g) g.push(v); else groups.set(r, [v]);
    }
    groups.forEach((g, r) => {
      if (g.length < 2) return;
      const c = centroid(g);
      md.verts[r] = c;
      for (const v of g) rep[v] = r;
    });
    return weldVerts(md, rep);
  }

  let target: number | undefined;
  if (type === 'FIRST') target = firstIndex;
  else if (type === 'LAST') target = lastIndex;
  if (target !== undefined && (target < 0 || target >= nv)) target = undefined;
  const group = target !== undefined && !md.vsel[target] ? [...sel, target] : sel;
  if (group.length < 2) return 0;
  let pos: Vec3;
  if (target !== undefined) pos = md.verts[target].slice() as Vec3;
  else if (type === 'CURSOR') pos = [cursorLocal[0], cursorLocal[1], cursorLocal[2]];
  else pos = centroid(group);
  const r = target ?? group[0];
  md.verts[r] = pos;
  for (const v of group) rep[v] = r;
  md.vsel[r] = true;
  return weldVerts(md, rep);
}

/**
 * Remove Doubles: merge verts closer than `threshold` (spatial hash, O(n) on average) into the
 * first vertex found in their neighbourhood. Returns the number of removed verts.
 */
export function removeDoubles(md: MeshData, threshold = 0.0001, onlySelected = true): number {
  ensureArrays(md);
  const nv = md.verts.length;
  const thr = Math.max(threshold, 1e-9);
  const thr2 = thr * thr;
  const rep = new Int32Array(nv);
  const grid = new Map<string, number[]>();
  for (let v = 0; v < nv; v++) {
    rep[v] = v;
    if (onlySelected && !md.vsel[v]) continue;
    const p = md.verts[v];
    const ix = Math.floor(p[0] / thr), iy = Math.floor(p[1] / thr), iz = Math.floor(p[2] / thr);
    let found = -1;
    for (let dx = -1; dx <= 1 && found < 0; dx++) {
      for (let dy = -1; dy <= 1 && found < 0; dy++) {
        for (let dz = -1; dz <= 1 && found < 0; dz++) {
          const cell = grid.get(`${ix + dx},${iy + dy},${iz + dz}`);
          if (!cell) continue;
          for (const r of cell) {
            const q = md.verts[r];
            const ddx = p[0] - q[0], ddy = p[1] - q[1], ddz = p[2] - q[2];
            if (ddx * ddx + ddy * ddy + ddz * ddz <= thr2) { found = r; break; }
          }
        }
      }
    }
    if (found >= 0) rep[v] = found;
    else {
      const key = `${ix},${iy},${iz}`;
      const cell = grid.get(key);
      if (cell) cell.push(v); else grid.set(key, [v]);
    }
  }
  return weldVerts(md, rep);
}

// =================================================================== normals

/** Flip Normals: reverse the winding of the selected faces. */
export function flipNormals(md: MeshData): void {
  ensureArrays(md);
  md.faces.forEach((f, i) => { if (md.fsel[i]) f.reverse(); });
}

/** Recalculate Normals (Ctrl+N, or Ctrl+Shift+N with `inside`) for the selected faces. */
export function recalcNormals(md: MeshData, inside = false): void {
  ensureArrays(md);
  recalcNormalsOutside(md, true);
  if (inside) flipNormals(md);
}

// =================================================================== duplicate / separate / split

/** Duplicate (Shift+D): copies the selected verts/edges/faces; the copy becomes the selection. */
export function duplicateSelected(md: MeshData): void {
  ensureArrays(md);
  const nv0 = md.verts.length;
  const map = new Map<number, number>();
  const dup = (v: number) => {
    let d = map.get(v);
    if (d === undefined) { d = addVert(md, md.verts[v]); map.set(v, d); }
    return d;
  };
  for (let v = 0; v < nv0; v++) if (md.vsel[v]) dup(v);
  const newEdges: Edge[] = [];
  md.edges.forEach((e, i) => { if (md.esel[i]) newEdges.push([dup(e[0]), dup(e[1])]); });
  const nf0 = md.faces.length;
  let active = -1;
  for (let fi = 0; fi < nf0; fi++) {
    if (!md.fsel[fi]) continue;
    const f = md.faces[fi];
    const idx = addFace(md, f.map(dup), { smooth: !!md.faceSmooth[fi], mat: md.faceMat[fi], select: true });
    if (fi === md.activeFace) active = idx;
  }
  if (!map.size) return;
  for (let fi = 0; fi < nf0; fi++) md.fsel[fi] = false;
  md.activeFace = active;
  const loose = [...looseEdges(md), ...newEdges];
  rebuildEdgesWith(md, loose);
  md.vsel = md.verts.map((_, i) => i >= nv0);
  md.esel = md.edges.map((e) => e[0] >= nv0 && e[1] >= nv0);
}

/** Build a standalone part from the given elements of `md` (indices re-based to 0). */
function buildPart(md: MeshData, vertIds: number[], faceIds: number[], edgeIds: number[]): MeshPart {
  const remap = new Map<number, number>();
  vertIds.forEach((v, i) => remap.set(v, i));
  const verts = vertIds.map((v) => [md.verts[v][0], md.verts[v][1], md.verts[v][2]] as Vec3);
  const faces = faceIds.map((fi) => md.faces[fi].map((v) => remap.get(v)!));
  const seen = new Set<string>();
  const edges: Edge[] = [];
  const addE = (a: number, b: number) => {
    if (a === b) return;
    const k = edgeKey(a, b);
    if (seen.has(k)) return;
    seen.add(k);
    edges.push(normEdge(a, b));
  };
  for (const f of faces) for (let k = 0; k < f.length; k++) addE(f[k], f[(k + 1) % f.length]);
  for (const ei of edgeIds) {
    const a = remap.get(md.edges[ei][0]), b = remap.get(md.edges[ei][1]);
    if (a !== undefined && b !== undefined) addE(a, b);
  }
  return {
    verts, faces, edges,
    faceSmooth: faceIds.map((fi) => !!md.faceSmooth[fi]),
    faceMat: faceIds.map((fi) => md.faceMat[fi] ?? 0),
  };
}

/**
 * Separate Selection (P): removes the selected geometry from `md` and returns it as a standalone
 * part. Verts shared with unselected geometry stay in `md` too (both get a copy).
 */
export function separateSelected(md: MeshData): MeshPart | null {
  ensureArrays(md);
  const nv = md.verts.length;
  const faceIds = selectedFaces(md);
  const edgeIds: number[] = [];
  md.esel.forEach((s, i) => { if (s) edgeIds.push(i); });
  const inPart = new Uint8Array(nv);
  for (let v = 0; v < nv; v++) if (md.vsel[v]) inPart[v] = 1;
  for (const ei of edgeIds) { inPart[md.edges[ei][0]] = 1; inPart[md.edges[ei][1]] = 1; }
  for (const fi of faceIds) for (const v of md.faces[fi]) inPart[v] = 1;
  const vertIds: number[] = [];
  for (let v = 0; v < nv; v++) if (inPart[v]) vertIds.push(v);
  if (!vertIds.length) return null;
  const part = buildPart(md, vertIds, faceIds, edgeIds);

  // remove from md: selected faces, then part edges/verts that nothing remaining uses
  const keepFace = md.faces.map((_, i) => !md.fsel[i]);
  const keptEdges = new Set<string>();
  const used = new Uint8Array(nv);
  md.faces.forEach((f, i) => {
    if (!keepFace[i]) return;
    for (let k = 0; k < f.length; k++) { keptEdges.add(edgeKey(f[k], f[(k + 1) % f.length])); used[f[k]] = 1; }
  });
  const partEdgeKeys = new Set<string>(part.edges.map(([a, b]) => edgeKey(vertIds[a], vertIds[b])));
  const keepEdge = md.edges.map((e) => {
    const k = edgeKey(e[0], e[1]);
    return keptEdges.has(k) || !partEdgeKeys.has(k);
  });
  md.edges.forEach((e, i) => { if (keepEdge[i]) { used[e[0]] = 1; used[e[1]] = 1; } });
  filterFaces(md, keepFace);
  md.esel = md.esel.filter((_, i) => keepEdge[i]);
  md.edges = md.edges.filter((_, i) => keepEdge[i]);
  removeVerts(md, md.verts.map((_, v) => !!inPart[v] && !used[v]));
  rebuildEdges(md);
  ensureArrays(md);
  selectAllMesh(md, false);
  return part;
}

/**
 * Separate by Loose Parts: `md` keeps the connected component containing the lowest vertex index,
 * every other component is removed and returned as a part.
 */
export function separateLoose(md: MeshData): MeshPart[] {
  ensureArrays(md);
  const nv = md.verts.length;
  if (!nv) return [];
  const dsu = vertComponents(md);
  const comps = new Map<number, { verts: number[]; faces: number[]; edges: number[] }>();
  for (let v = 0; v < nv; v++) {
    const r = dsu.find(v);
    let c = comps.get(r);
    if (!c) { c = { verts: [], faces: [], edges: [] }; comps.set(r, c); }
    c.verts.push(v);
  }
  if (comps.size <= 1) return [];
  md.faces.forEach((f, fi) => comps.get(dsu.find(f[0]))!.faces.push(fi));
  md.edges.forEach((e, ei) => comps.get(dsu.find(e[0]))!.edges.push(ei));
  const first = dsu.find(0);
  const parts: MeshPart[] = [];
  comps.forEach((c, r) => { if (r !== first) parts.push(buildPart(md, c.verts, c.faces, c.edges)); });
  removeVerts(md, md.verts.map((_, v) => dsu.find(v) !== first));
  return parts;
}

/** Split (Y): disconnect the selected faces from the rest by duplicating the shared verts. */
export function splitSelected(md: MeshData): void {
  ensureArrays(md);
  const sel = selectedFaces(md);
  if (!sel.length) return;
  const loose = looseEdges(md);
  const usedByOther = new Uint8Array(md.verts.length);
  md.faces.forEach((f, i) => { if (!md.fsel[i]) for (const v of f) usedByOther[v] = 1; });
  const map = new Map<number, number>();
  for (const fi of sel) {
    md.faces[fi] = md.faces[fi].map((v) => {
      if (!usedByOther[v]) return v;
      let d = map.get(v);
      if (d === undefined) { d = addVert(md, md.verts[v]); map.set(v, d); }
      return d;
    });
  }
  rebuildEdgesWith(md, loose);
  flushFromFaces(md);
}

// =================================================================== smooth / randomize

/**
 * Smooth Vertex: Laplacian smoothing of the selected verts towards the average of their edge
 * neighbours. Verts on a mesh boundary only use their boundary neighbours (keeps outlines).
 */
export function smoothVerts(md: MeshData, factor = 0.5, repeat = 1, axes: [boolean, boolean, boolean] | boolean[] = [true, true, true]): void {
  ensureArrays(md);
  const nv = md.verts.length;
  const ef = edgeFaces(md);
  const nb: number[][] = md.verts.map(() => []);
  const bnb: number[][] = md.verts.map(() => []);
  for (const [a, b] of md.edges) {
    nb[a].push(b); nb[b].push(a);
    if ((ef.get(edgeKey(a, b))?.length ?? 0) === 1) { bnb[a].push(b); bnb[b].push(a); }
  }
  for (let it = 0; it < Math.max(1, Math.floor(repeat)); it++) {
    const next = md.verts.map((p) => [p[0], p[1], p[2]] as Vec3);
    for (let v = 0; v < nv; v++) {
      if (!md.vsel[v]) continue;
      const list = bnb[v].length ? bnb[v] : nb[v];
      if (!list.length) continue;
      const avg: Vec3 = [0, 0, 0];
      for (const u of list) { avg[0] += md.verts[u][0]; avg[1] += md.verts[u][1]; avg[2] += md.verts[u][2]; }
      for (let k = 0; k < 3; k++) {
        if (!axes[k]) continue;
        next[v][k] = md.verts[v][k] + factor * (avg[k] / list.length - md.verts[v][k]);
      }
    }
    md.verts = next;
  }
}

/**
 * Randomize: offset selected verts by a seeded random amount. `uniform` (0..1) reduces the
 * per-vertex variation of the length, `normal` (0..1) blends the direction towards the vertex normal.
 */
export function randomizeVerts(md: MeshData, amount: number, seed = 0, uniform = 0, normal = 0): void {
  ensureArrays(md);
  const rnd = rng32(seed);
  const vn = normal ? vertexNormals(md) : null;
  for (let v = 0; v < md.verts.length; v++) {
    if (!md.vsel[v]) continue;
    // uniformly distributed direction on the unit sphere
    const z = rnd() * 2 - 1, phi = rnd() * Math.PI * 2, r = Math.sqrt(Math.max(0, 1 - z * z));
    const dir: Vec3 = [r * Math.cos(phi), r * Math.sin(phi), z];
    const len = amount * (1 - uniform * rnd()) * rnd();
    const along = rnd() * 2 - 1;
    let off = scale(dir, len * (1 - normal));
    if (vn) off = add(off, scale(vn[v], amount * normal * along));
    md.verts[v] = add(md.verts[v], off);
  }
}

// =================================================================== tris <-> quads, dissolve

/**
 * Tris to Quads (Alt+J): greedily joins pairs of selected triangles sharing a manifold edge whose
 * normals differ by less than `maxAngleDeg` and whose union is a convex quad. Best pairs (smallest
 * normal angle + corner deviation from 90 degrees) are joined first.
 */
export function trisToQuads(md: MeshData, maxAngleDeg = 40): void {
  ensureArrays(md);
  const ef = edgeFaces(md);
  const maxA = (maxAngleDeg * Math.PI) / 180;
  const cands: { t1: number; t2: number; quad: number[]; score: number }[] = [];
  ef.forEach((fl) => {
    if (fl.length !== 2) return;
    const [t1, t2] = fl;
    const f1 = md.faces[t1], f2 = md.faces[t2];
    if (f1.length !== 3 || f2.length !== 3 || !md.fsel[t1] || !md.fsel[t2]) return;
    // find shared edge a->b as traversed by t1
    let a = -1, b = -1, c = -1;
    for (let k = 0; k < 3; k++) {
      if (f2.includes(f1[k]) && f2.includes(f1[(k + 1) % 3])) { a = f1[k]; b = f1[(k + 1) % 3]; c = f1[(k + 2) % 3]; }
    }
    if (a < 0 || traverses(f2, b, a) !== 1) return; // inconsistent winding
    const d = f2.find((v) => v !== a && v !== b)!;
    if (d === c) return;
    const quad = [b, c, a, d];
    const n1 = polyNormal(md.verts, f1), n2 = polyNormal(md.verts, f2);
    const ang = Math.acos(Math.max(-1, Math.min(1, dot(n1, n2))));
    if (ang > maxA) return;
    const nq = normalize(add(n1, n2));
    let convex = true, shape = 0;
    for (let k = 0; k < 4; k++) {
      const p0 = md.verts[quad[(k + 3) % 4]], p1 = md.verts[quad[k]], p2 = md.verts[quad[(k + 1) % 4]];
      const e1 = sub(p1, p0), e2 = sub(p2, p1);
      if (dot(cross(e1, e2), nq) <= 1e-12) { convex = false; break; }
      const ca = dot(normalize(scale(e1, -1)), normalize(e2));
      shape += Math.abs(Math.acos(Math.max(-1, Math.min(1, ca))) - Math.PI / 2);
    }
    if (!convex) return;
    cands.push({ t1, t2, quad, score: ang + shape / 4 });
  });
  if (!cands.length) return;
  cands.sort((x, y) => x.score - y.score);
  const used = new Set<number>();
  const replace = new Map<number, number[]>();
  const drop = new Set<number>();
  for (const c of cands) {
    if (used.has(c.t1) || used.has(c.t2)) continue;
    used.add(c.t1); used.add(c.t2);
    replace.set(c.t1, c.quad);
    drop.add(c.t2);
  }
  const loose = looseEdges(md);
  const out = new FaceList();
  md.faces.forEach((f, fi) => {
    if (drop.has(fi)) return;
    out.pushFrom(md, fi, replace.get(fi) ?? f, !!md.fsel[fi]);
  });
  out.apply(md);
  rebuildEdgesWith(md, loose);
  flushFromVerts(md);
}

/** Triangulate Faces (Ctrl+T): triangulate the selected faces keeping their winding. */
export function quadsToTris(md: MeshData): void {
  ensureArrays(md);
  const out = new FaceList();
  md.faces.forEach((f, fi) => {
    if (!md.fsel[fi] || f.length <= 3) { out.pushFrom(md, fi, f, !!md.fsel[fi]); return; }
    const n = polyNormal(md.verts, f);
    const tris = triangulatePoly(md.verts, f).map((t) => [f[t[0]], f[t[1]], f[t[2]]]);
    // the ear clipper may emit the opposite winding: compare the summed orientation to the face normal
    let s = 0;
    for (const t of tris) {
      const [p, q, r] = t.map((v) => md.verts[v]);
      s += dot(cross(sub(q, p), sub(r, p)), n);
    }
    for (const t of tris) out.pushFrom(md, fi, s < 0 ? t.reverse() : t, true);
  });
  out.apply(md);
  rebuildEdges(md);
  ensureArrays(md);
  flushFromVerts(md);
}

/**
 * Dissolve Faces: every connected region of selected faces whose boundary is one simple loop is
 * replaced by a single n-gon; interior edges and verts are removed.
 */
export function dissolveFaces(md: MeshData): void {
  ensureArrays(md);
  const ef = edgeFaces(md);
  const loose = looseEdges(md);
  const sel = selectedFaces(md);
  const remove = new Set<number>();
  const added: NewFace[] = [];
  const candidates: number[] = [];
  for (const region of faceRegions(md, sel, ef)) {
    if (region.length < 2) continue;
    const bnd = faceRegionBoundary(md, new Set(region));
    if (bnd.length < 3) continue;
    const next = new Map<number, number>();
    let simple = true;
    for (const [a, b] of bnd) { if (next.has(a)) { simple = false; break; } next.set(a, b); }
    if (!simple) continue;
    const loop: number[] = [bnd[0][0]];
    for (let v = next.get(bnd[0][0]); v !== undefined && v !== bnd[0][0]; v = next.get(v)) {
      loop.push(v);
      if (loop.length > bnd.length) break;
    }
    if (loop.length !== bnd.length) continue; // several loops (holes) or open chain
    const src = region.includes(md.activeFace) ? md.activeFace : region[0];
    added.push({ f: loop, src, sel: true, active: region.includes(md.activeFace) });
    for (const fi of region) { remove.add(fi); candidates.push(...md.faces[fi]); }
  }
  if (!added.length) return;
  const out = new FaceList();
  md.faces.forEach((f, fi) => { if (!remove.has(fi)) out.pushFrom(md, fi, f, !!md.fsel[fi]); });
  for (const a of added) out.pushFrom(md, a.src, a.f, true, !!a.active);
  out.apply(md);
  rebuildEdgesWith(md, loose);
  removeUnusedVerts(md, candidates);
  flushFromFaces(md);
}

// =================================================================== selection

/** Select / deselect / toggle / invert all (A, Ctrl+I). */
export function selectAll(md: MeshData, action: 'TOGGLE' | 'SELECT' | 'DESELECT' | 'INVERT', mode: SelectMode): void {
  ensureArrays(md);
  if (action === 'TOGGLE') action = md.vsel.some(Boolean) || md.esel.some(Boolean) || md.fsel.some(Boolean) ? 'DESELECT' : 'SELECT';
  if (action === 'SELECT') { selectAllMesh(md, true); return; }
  if (action === 'DESELECT') { selectAllMesh(md, false); return; }
  if (mode === 'VERT') md.vsel = md.vsel.map((s) => !s);
  else if (mode === 'EDGE') md.esel = md.esel.map((s) => !s);
  else md.fsel = md.fsel.map((s) => !s);
  flushSelection(md, mode);
}

/** Select More (Ctrl+Numpad+): grow by one ring, stepping across faces. */
export function selectMore(md: MeshData, mode: SelectMode): void {
  ensureArrays(md);
  if (mode === 'FACE') {
    const touched = new Uint8Array(md.verts.length);
    md.faces.forEach((f, i) => { if (md.fsel[i]) for (const v of f) touched[v] = 1; });
    md.faces.forEach((f, i) => { if (f.some((v) => touched[v])) md.fsel[i] = true; });
    flushFromFaces(md);
    return;
  }
  const nsel = md.vsel.slice();
  for (const f of md.faces) if (f.some((v) => md.vsel[v])) for (const v of f) nsel[v] = true;
  for (const [a, b] of md.edges) if (md.vsel[a] || md.vsel[b]) { nsel[a] = true; nsel[b] = true; }
  md.vsel = nsel;
  flushFromVerts(md);
}

/** Select Less (Ctrl+Numpad-): shrink by one ring. */
export function selectLess(md: MeshData, mode: SelectMode): void {
  ensureArrays(md);
  if (mode === 'FACE') {
    const touched = new Uint8Array(md.verts.length);
    md.faces.forEach((f, i) => { if (!md.fsel[i]) for (const v of f) touched[v] = 1; });
    md.faces.forEach((f, i) => { if (md.fsel[i] && f.some((v) => touched[v])) md.fsel[i] = false; });
    flushFromFaces(md);
    return;
  }
  const bad = new Uint8Array(md.verts.length);
  for (const f of md.faces) if (f.some((v) => !md.vsel[v])) for (const v of f) bad[v] = 1;
  for (const [a, b] of md.edges) if (!md.vsel[a] || !md.vsel[b]) { bad[a] = 1; bad[b] = 1; }
  md.vsel = md.vsel.map((s, v) => s && !bad[v]);
  flushFromVerts(md);
}

/** Select Linked (Ctrl+L): everything connected to the current selection. */
export function selectLinked(md: MeshData, mode: SelectMode): void {
  ensureArrays(md);
  const dsu = vertComponents(md);
  const roots = new Set<number>();
  if (mode === 'FACE') md.faces.forEach((f, i) => { if (md.fsel[i]) roots.add(dsu.find(f[0])); });
  else md.vsel.forEach((s, v) => { if (s) roots.add(dsu.find(v)); });
  if (mode === 'FACE') {
    md.faces.forEach((f, i) => { if (roots.has(dsu.find(f[0]))) md.fsel[i] = true; });
    flushFromFaces(md);
  } else {
    md.vsel = md.vsel.map((s, v) => s || roots.has(dsu.find(v)));
    flushFromVerts(md);
  }
}

/** Select Linked Pick (L / Shift+L): (de)select the component containing `vertIndex`. */
export function selectLinkedPick(md: MeshData, vertIndex: number, deselect: boolean, mode: SelectMode): void {
  ensureArrays(md);
  if (vertIndex < 0 || vertIndex >= md.verts.length) return;
  const dsu = vertComponents(md);
  const root = dsu.find(vertIndex);
  const val = !deselect;
  if (mode === 'FACE') md.faces.forEach((f, i) => { if (dsu.find(f[0]) === root) md.fsel[i] = val; });
  else if (mode === 'EDGE') md.edges.forEach((e, i) => { if (dsu.find(e[0]) === root) md.esel[i] = val; });
  else md.vsel.forEach((_, v) => { if (dsu.find(v) === root) md.vsel[v] = val; });
  // a component with no edges (lone vert) in edge mode still toggles its vert
  if (mode === 'EDGE') {
    flushFromEdges(md);
    if (!md.edges.some((e) => dsu.find(e[0]) === root)) md.vsel[vertIndex] = val;
  } else flushSelection(md, mode);
}

/** Select Random: applies `action` to roughly `percent` % of the elements of the current mode. */
export function selectRandom(md: MeshData, percent: number, seed: number, mode: SelectMode, action: 'SELECT' | 'DESELECT'): void {
  ensureArrays(md);
  const rnd = rng32(seed);
  const p = percent / 100;
  const val = action === 'SELECT';
  const arr = mode === 'VERT' ? md.vsel : mode === 'EDGE' ? md.esel : md.fsel;
  for (let i = 0; i < arr.length; i++) if (rnd() < p) arr[i] = val;
  flushSelection(md, mode);
}

/** Additively select faces (with their verts and edges). */
function selectFacesAdd(md: MeshData, faces: number[]): void {
  const emap = edgeIndexMap(md);
  for (const fi of faces) {
    const f = md.faces[fi];
    md.fsel[fi] = true;
    for (let k = 0; k < f.length; k++) {
      md.vsel[f[k]] = true;
      const ei = emap.get(edgeKey(f[k], f[(k + 1) % f.length]));
      if (ei !== undefined) md.esel[ei] = true;
    }
  }
}

/** Additively select edges (with their verts); faces whose edges are now all selected get selected. */
function selectEdgesAdd(md: MeshData, edges: number[]): void {
  for (const ei of edges) { md.esel[ei] = true; md.vsel[md.edges[ei][0]] = true; md.vsel[md.edges[ei][1]] = true; }
  const emap = edgeIndexMap(md);
  md.faces.forEach((f, i) => {
    if (md.fsel[i]) return;
    let all = true;
    for (let k = 0; k < f.length && all; k++) {
      const ei = emap.get(edgeKey(f[k], f[(k + 1) % f.length]));
      if (ei === undefined || !md.esel[ei]) all = false;
    }
    if (all) md.fsel[i] = true;
  });
}

/**
 * Select Non Manifold (Shift+Ctrl+Alt+M): wire edges, boundary edges, edges with more than two
 * faces and edges whose two faces have inconsistent winding.
 */
export function selectNonManifold(md: MeshData, extend = true): void {
  ensureArrays(md);
  if (!extend) selectAllMesh(md, false);
  const ef = edgeFaces(md);
  const hits: number[] = [];
  md.edges.forEach(([a, b], i) => {
    const fl = ef.get(edgeKey(a, b)) ?? [];
    if (fl.length !== 2) { hits.push(i); return; }
    if (traverses(md.faces[fl[0]], a, b) === traverses(md.faces[fl[1]], a, b)) hits.push(i);
  });
  selectEdgesAdd(md, hits);
}

/** Select Loose: verts without edges and edges without faces. */
export function selectLoose(md: MeshData, extend = true): void {
  ensureArrays(md);
  if (!extend) selectAllMesh(md, false);
  const fe = faceEdgeSet(md);
  const hasEdge = new Uint8Array(md.verts.length);
  const hits: number[] = [];
  md.edges.forEach(([a, b], i) => {
    hasEdge[a] = 1; hasEdge[b] = 1;
    if (!fe.has(edgeKey(a, b))) hits.push(i);
  });
  for (const ei of hits) { md.esel[ei] = true; md.vsel[md.edges[ei][0]] = true; md.vsel[md.edges[ei][1]] = true; }
  for (let v = 0; v < md.verts.length; v++) if (!hasEdge[v]) md.vsel[v] = true;
}

/** Select Faces by Sides. */
export function selectFaceBySides(md: MeshData, sides: number, compare: 'EQUAL' | 'GREATER' | 'LESS' | 'NOTEQUAL', extend: boolean): void {
  ensureArrays(md);
  if (!extend) selectAllMesh(md, false);
  const hits: number[] = [];
  md.faces.forEach((f, i) => {
    const n = f.length;
    const ok = compare === 'EQUAL' ? n === sides : compare === 'GREATER' ? n > sides : compare === 'LESS' ? n < sides : n !== sides;
    if (ok) hits.push(i);
  });
  selectFacesAdd(md, hits);
}

/** Select Interior Faces: faces whose every edge is used by more than two faces. */
export function selectInteriorFaces(md: MeshData): void {
  ensureArrays(md);
  const ef = edgeFaces(md);
  const hits: number[] = [];
  md.faces.forEach((f, i) => {
    let all = true;
    for (let k = 0; k < f.length && all; k++) if ((ef.get(edgeKey(f[k], f[(k + 1) % f.length]))?.length ?? 0) <= 2) all = false;
    if (all) hits.push(i);
  });
  selectFacesAdd(md, hits);
}

/** Select Sharp Edges: manifold edges whose face normals differ by more than `angleRad`. */
export function selectSharpEdges(md: MeshData, angleRad: number): void {
  ensureArrays(md);
  const ef = edgeFaces(md);
  const normals = md.faces.map((f) => polyNormal(md.verts, f));
  const hits: number[] = [];
  md.edges.forEach(([a, b], i) => {
    const fl = ef.get(edgeKey(a, b));
    if (!fl || fl.length !== 2) return;
    const ang = Math.acos(Math.max(-1, Math.min(1, dot(normals[fl[0]], normals[fl[1]]))));
    if (ang > angleRad) hits.push(i);
  });
  selectEdgesAdd(md, hits);
}

// =================================================================== join

/**
 * Join (Ctrl+J): append `source` into `target`. `sourceToTarget` is a column-major 4x4 matrix from
 * source object space to target object space; `materialRemap[i]` maps source slot i to a target slot.
 * A mirroring matrix (negative determinant) flips the appended faces to keep them facing outward.
 */
export function joinMeshInto(target: MeshData, source: MeshData, sourceToTarget: number[], materialRemap: number[]): void {
  ensureArrays(target);
  const m = sourceToTarget;
  const off = target.verts.length;
  const det = m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
  const flip = det < 0;
  for (let i = 0; i < source.verts.length; i++) {
    const [x, y, z] = source.verts[i];
    target.verts.push([
      m[0] * x + m[4] * y + m[8] * z + m[12],
      m[1] * x + m[5] * y + m[9] * z + m[13],
      m[2] * x + m[6] * y + m[10] * z + m[14],
    ]);
    target.vsel.push(!!source.vsel[i]);
  }
  source.edges.forEach((e, i) => {
    target.edges.push([e[0] + off, e[1] + off]);
    target.esel.push(!!source.esel[i]);
  });
  source.faces.forEach((f, i) => {
    const g = f.map((v) => v + off);
    if (flip) g.reverse();
    const mat = source.faceMat[i] ?? 0;
    addFace(target, g, { smooth: !!source.faceSmooth[i], mat: materialRemap[mat] ?? 0, select: !!source.fsel[i] });
  });
  rebuildEdges(target);
  ensureArrays(target);
}
