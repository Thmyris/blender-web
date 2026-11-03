// Per-element mesh data layers (vertex weights, UVs, vertex colours, ...) kept consistent through
// edit-mode operators that change the mesh topology.
//
// Every operator call is wrapped (see `operatorHooks` in app.ts): before an operator runs in mesh
// edit mode, the vertex arrays and every registered layer are captured; afterwards, if the topology
// changed, a mapping from the new to the old elements is computed and each layer remaps its data.
//
// Vertices are tracked by identity (mesh operators move the same `[x, y, z]` array objects around),
// then by exact position (duplicates / extrusions start on top of their source), and new vertices are
// interpolated from already mapped neighbours (subdivide, loop cut, ...).
//
// Register a layer with `registerMeshLayer`. Layers must never leave arrays with mismatched lengths.

import { app, operatorHooks } from '../app';
import type { BObject, MeshData, Vec3 } from './types';

/** One source element with its interpolation weight. */
export interface Source { index: number; weight: number }

export interface TopologyMap {
  /** For each vertex after the operation: the same vertex before it, or -1 when it is new. */
  vertOld: Int32Array;
  /** For each vertex after the operation: old vertices to interpolate from (weights sum to 1; empty when unknown). */
  vertSources: Source[][];
  /** For each face after the operation: the old face it comes from (all its vertices map into it), or -1. */
  faceOld: Int32Array;
  /** Old face and corner for corner `k` of new face `f`, when the corner's vertex maps into that old face. */
  oldCorner(f: number, k: number): { face: number; corner: number } | null;
}

export interface TopologySnapshot {
  mesh: MeshData;
  vertRefs: Vec3[];
  positions: Vec3[];
  faces: number[][];
  /** Captured layer data, by layer name. */
  data: Map<string, unknown>;
  /** Objects that existed before the operation (to detect objects created by it, e.g. Separate). */
  objectIds: Set<string>;
}

export interface MeshLayer {
  name: string;
  /** Does the mesh (of this object) carry this layer? Untracked meshes cost nothing. */
  has(md: MeshData, ob: BObject | null): boolean;
  /** Copy the layer data before the operation (must not alias arrays the operator could mutate). */
  capture(md: MeshData, ob: BObject | null): unknown;
  /** Rebuild the layer on `md` after a topology change. */
  remap(md: MeshData, ob: BObject | null, captured: unknown, map: TopologyMap, snap: TopologySnapshot): void;
  /**
   * Optional: an operator created a new object (`newOb`, e.g. Separate) whose mesh was split off the
   * captured one. `map` maps the new mesh's vertices to the captured (old) mesh.
   */
  remapSplit?(newMd: MeshData, newOb: BObject, captured: unknown, map: TopologyMap, srcOb: BObject | null): void;
}

const layers: MeshLayer[] = [];

export function registerMeshLayer(layer: MeshLayer): void {
  const i = layers.findIndex((l) => l.name === layer.name);
  if (i >= 0) layers[i] = layer; else layers.push(layer);
}

const posKey = (v: Vec3) => `${v[0]},${v[1]},${v[2]}`;

/** Capture the mesh being edited (null when no layer is present). */
export function captureTopology(md: MeshData, ob: BObject | null): TopologySnapshot | null {
  const active = layers.filter((l) => l.has(md, ob));
  if (!active.length) return null;
  const data = new Map<string, unknown>();
  for (const l of active) data.set(l.name, l.capture(md, ob));
  return {
    mesh: md,
    vertRefs: md.verts.slice(),
    positions: md.verts.map((v) => [v[0], v[1], v[2]] as Vec3),
    faces: md.faces.map((f) => f.slice()),
    data,
    objectIds: new Set(Object.keys(app.doc.objects)),
  };
}

function topologyChanged(snap: TopologySnapshot, md: MeshData): boolean {
  if (md.verts.length !== snap.vertRefs.length || md.faces.length !== snap.faces.length) return true;
  for (let i = 0; i < md.verts.length; i++) if (md.verts[i] !== snap.vertRefs[i]) return true;
  for (let i = 0; i < md.faces.length; i++) {
    const a = md.faces[i], b = snap.faces[i];
    if (a.length !== b.length) return true;
    for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return true;
  }
  return false;
}

/** Build the new -> old mapping of `md` against a snapshot. `byIdentity` is false for split-off meshes. */
export function buildTopologyMap(snap: TopologySnapshot, md: MeshData, byIdentity = true): TopologyMap {
  const nv = md.verts.length;
  const vertOld = new Int32Array(nv).fill(-1);
  const refIndex = new Map<Vec3, number>();
  if (byIdentity) snap.vertRefs.forEach((v, i) => refIndex.set(v, i));
  const byPos = new Map<string, number>();
  snap.positions.forEach((p, i) => { const k = posKey(p); if (!byPos.has(k)) byPos.set(k, i); });
  const usedOld = new Set<number>();
  // 1) identity
  for (let i = 0; i < nv; i++) {
    const o = refIndex.get(md.verts[i]);
    if (o !== undefined && !usedOld.has(o)) { vertOld[i] = o; usedOld.add(o); }
  }
  const sources: Source[][] = new Array(nv);
  // 2) exact position (duplicates keep the data of their source; new copies are "new" but sourced)
  for (let i = 0; i < nv; i++) {
    if (vertOld[i] >= 0) { sources[i] = [{ index: vertOld[i], weight: 1 }]; continue; }
    const o = byPos.get(posKey(md.verts[i]));
    if (o !== undefined) {
      if (!usedOld.has(o) && !byIdentity) { vertOld[i] = o; usedOld.add(o); }
      sources[i] = [{ index: o, weight: 1 }];
    }
  }
  // 3) interpolate from mapped neighbours (inverse distance), spreading outwards
  const adj: number[][] = Array.from({ length: nv }, () => []);
  for (const [a, b] of md.edges) { if (a < nv && b < nv) { adj[a].push(b); adj[b].push(a); } }
  for (const f of md.faces) for (let k = 0; k < f.length; k++) {
    const a = f[k], b = f[(k + 1) % f.length];
    if (a < nv && b < nv && !adj[a].includes(b)) { adj[a].push(b); adj[b].push(a); }
  }
  let pending: number[] = [];
  for (let i = 0; i < nv; i++) if (!sources[i]) pending.push(i);
  for (let pass = 0; pass < 64 && pending.length; pass++) {
    const next: number[] = [];
    const assigned: [number, Source[]][] = [];
    for (const i of pending) {
      const nb = adj[i].filter((j) => sources[j]);
      if (!nb.length) { next.push(i); continue; }
      const acc = new Map<number, number>();
      let total = 0;
      const p = md.verts[i];
      for (const j of nb) {
        const q = md.verts[j];
        const w = 1 / Math.max(1e-6, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
        total += w;
        for (const s of sources[j]) acc.set(s.index, (acc.get(s.index) ?? 0) + s.weight * w);
      }
      assigned.push([i, [...acc.entries()].map(([index, w]) => ({ index, weight: w / total }))]);
    }
    for (const [i, s] of assigned) sources[i] = s;
    if (next.length === pending.length) break;
    pending = next;
  }
  // 4) isolated new vertices: nearest old position
  for (const i of pending) {
    if (sources[i]) continue;
    let best = -1, bd = Infinity;
    const p = md.verts[i];
    snap.positions.forEach((q, j) => { const d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2; if (d < bd) { bd = d; best = j; } });
    sources[i] = best >= 0 ? [{ index: best, weight: 1 }] : [];
  }
  // faces: a new face maps to an old face containing all of its (mapped) vertices
  const oldVertFaces: number[][] = snap.positions.map(() => []);
  snap.faces.forEach((f, fi) => { for (const v of f) oldVertFaces[v]?.push(fi); });
  const primary = (v: number) => (vertOld[v] >= 0 ? vertOld[v] : sources[v]?.length === 1 ? sources[v][0].index : -1);
  const faceOld = new Int32Array(md.faces.length).fill(-1);
  md.faces.forEach((f, fi) => {
    const olds = f.map(primary);
    if (olds.some((o) => o < 0)) return;
    let cands = oldVertFaces[olds[0]] ?? [];
    for (const o of olds.slice(1)) { const s = new Set(oldVertFaces[o] ?? []); cands = cands.filter((c) => s.has(c)); if (!cands.length) break; }
    if (cands.length) faceOld[fi] = cands[0];
  });
  return {
    vertOld, vertSources: sources, faceOld,
    oldCorner(f, k) {
      const of = faceOld[f];
      const v = md.faces[f]?.[k];
      if (v === undefined) return null;
      const o = primary(v);
      if (o < 0) return null;
      if (of >= 0) { const c = snap.faces[of].indexOf(o); if (c >= 0) return { face: of, corner: c }; }
      // any old face using that vertex
      const any = oldVertFaces[o]?.[0];
      if (any === undefined) return null;
      return { face: any, corner: snap.faces[any].indexOf(o) };
    },
  };
}

/** Apply the remap after an operation (no-op when the topology did not change). */
export function applyTopology(snap: TopologySnapshot, ob: BObject | null): void {
  const md = snap.mesh;
  const map = topologyChanged(snap, md) ? buildTopologyMap(snap, md) : null;
  for (const l of layers) {
    if (!snap.data.has(l.name)) continue;
    if (map) l.remap(md, ob, snap.data.get(l.name), map, snap);
  }
  // objects created by the operator from this mesh (Separate)
  for (const [id, nob] of Object.entries(app.doc.objects)) {
    if (snap.objectIds.has(id) || nob.type !== 'MESH' || !nob.data) continue;
    const nmd = app.doc.meshes[nob.data];
    if (!nmd || nmd === md) continue;
    const m = buildTopologyMap(snap, nmd, false);
    for (const l of layers) if (snap.data.has(l.name)) l.remapSplit?.(nmd, nob, snap.data.get(l.name), m, ob);
  }
}

/** Interpolate a numeric per-vertex value through a topology map. */
export function interpolateScalar(old: ArrayLike<number>, map: TopologyMap, fallback = 0): number[] {
  return Array.from(map.vertSources, (src) => {
    if (!src.length) return fallback;
    let v = 0;
    for (const s of src) v += (old[s.index] ?? fallback) * s.weight;
    return v;
  });
}

// ------------------------------------------------------------------ operator hook

operatorHooks.push({
  before() {
    if (app.mode !== 'EDIT') return null;
    const md = app.editMesh;
    if (!md) return null;
    return captureTopology(md, app.editObj);
  },
  after(_def, _ctx, token) {
    const snap = token as TopologySnapshot | null;
    if (!snap) return;
    // the edit mesh may have been replaced (undo inside an operator is not expected, but be safe)
    if (!app.doc.meshes[snap.mesh.id] || app.doc.meshes[snap.mesh.id] !== snap.mesh) return;
    const ob = Object.values(app.doc.objects).find((o) => o.data === snap.mesh.id) ?? null;
    applyTopology(snap, app.editObj?.data === snap.mesh.id ? app.editObj : ob);
  },
});
