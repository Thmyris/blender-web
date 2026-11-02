// Knife cut application (the geometry part of the Knife tool, Knife Project and Bisect).
//
// A cut is described as "pieces": straight cut lines inside one original face, between two points that
// lie on that face (an existing vertex, a point on one of its edges, or a point inside the face).
// Pieces sharing points are linked into chains per face; every chain that runs from one boundary point
// of the face to another splits the face (points inside the face become new vertices of both halves).
// Edge points are inserted into every face using that edge, so the mesh stays watertight.

import type { MeshData, Vec3 } from './types';
import { edgeKey, ensureArrays, flushFromVerts, polyNormal, rebuildEdges, removeVerts, cross, dot, normalize, sub } from './mesh';

export interface KnifePoint {
  /** Stable id: points with equal ids are the same point (e.g. a clicked point shared by two segments). */
  id: string;
  kind: 'VERT' | 'EDGE' | 'FACE';
  v?: number;
  /** Edge (as given) and parameter along it from e[0] to e[1]. */
  e?: [number, number];
  t?: number;
  /** Local-space position (used for EDGE and FACE points). */
  co: Vec3;
}

export interface KnifePiece { face: number; a: KnifePoint; b: KnifePoint }

export interface KnifeResult { newEdges: [number, number][]; newVerts: number[] }

/** Is point p inside polygon f (projected on its plane)? */
function pointInFace(verts: Vec3[], f: number[], p: Vec3): boolean {
  const n = polyNormal(verts, f);
  const ref: Vec3 = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u = normalize(cross(ref, n)), v = cross(n, u);
  const px = dot(p, u), py = dot(p, v);
  let inside = false;
  for (let i = 0, j = f.length - 1; i < f.length; j = i++) {
    const xi = dot(verts[f[i]], u), yi = dot(verts[f[i]], v), xj = dot(verts[f[j]], u), yj = dot(verts[f[j]], v);
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Apply knife pieces. Returns the new cut edges (vertex pairs) and new verts. When `select` is set the
 * cut verts/edges become the selection.
 */
export function knifeApply(md: MeshData, pieces: KnifePiece[], select = true): KnifeResult {
  ensureArrays(md);
  const nv0 = md.verts.length;
  const vertOf = new Map<string, number>();
  // loose edges survive; face edges are rebuilt from the new faces
  const faceEdges0 = new Set<string>();
  for (const f of md.faces) for (let k = 0; k < f.length; k++) faceEdges0.add(edgeKey(f[k], f[(k + 1) % f.length]));
  const loose0 = md.edges.filter(([a, b]) => !faceEdges0.has(edgeKey(a, b)));
  const EPS_T = 1e-5;

  // ---------------------------------------------------------- 1. points -> vertices
  const edgeCuts = new Map<string, { t: number; id: string; co: Vec3 }[]>();
  const allPoints = new Map<string, KnifePoint>();
  for (const p of pieces) for (const q of [p.a, p.b]) allPoints.set(q.id, q);
  for (const q of allPoints.values()) {
    if (q.kind === 'VERT' && q.v !== undefined) vertOf.set(q.id, q.v);
    else if (q.kind === 'EDGE' && q.e) {
      let [a, b] = q.e;
      let t = q.t ?? 0.5;
      if (a > b) { [a, b] = [b, a]; t = 1 - t; }
      if (t <= EPS_T) { vertOf.set(q.id, a); continue; }
      if (t >= 1 - EPS_T) { vertOf.set(q.id, b); continue; }
      const k = edgeKey(a, b);
      const list = edgeCuts.get(k) ?? [];
      list.push({ t, id: q.id, co: q.co });
      edgeCuts.set(k, list);
    }
  }
  const newVert = (co: Vec3): number => { md.verts.push([co[0], co[1], co[2]]); md.vsel.push(false); return md.verts.length - 1; };
  const inserts = new Map<string, number[]>(); // canonical edge key -> new verts ordered from min to max
  for (const [k, list] of edgeCuts) {
    list.sort((x, y) => x.t - y.t);
    const ids: number[] = [];
    let lastT = -1, lastV = -1;
    for (const c of list) {
      if (lastV >= 0 && c.t - lastT < EPS_T) { vertOf.set(c.id, lastV); continue; }
      lastV = newVert(c.co); lastT = c.t;
      vertOf.set(c.id, lastV);
      ids.push(lastV);
    }
    inserts.set(k, ids);
  }
  for (const q of allPoints.values()) if (q.kind === 'FACE' && !vertOf.has(q.id)) vertOf.set(q.id, newVert(q.co));
  // insert edge points into every face using the edge
  if (inserts.size) {
    md.faces = md.faces.map((f) => {
      const out: number[] = [];
      for (let i = 0; i < f.length; i++) {
        const a = f[i], b = f[(i + 1) % f.length];
        out.push(a);
        const ins = inserts.get(edgeKey(a, b));
        if (ins) out.push(...(a < b ? ins : ins.slice().reverse()));
      }
      return out;
    });
  }

  // ---------------------------------------------------------- 2. chains per original face
  const byFace = new Map<number, [string, string][]>();
  for (const p of pieces) {
    if (p.a.id === p.b.id) continue;
    const l = byFace.get(p.face) ?? [];
    l.push([p.a.id, p.b.id]);
    byFace.set(p.face, l);
  }
  const subFaces = new Map<number, number[]>(); // original face -> current face indices
  const newEdges: [number, number][] = [];
  const faceSplit = (fi: number, s: number, e: number, inner: number[]): number => {
    const f = md.faces[fi];
    const is = f.indexOf(s), ie = f.indexOf(e);
    const n = f.length;
    const f1: number[] = [], f2: number[] = [];
    for (let i = is; ; i = (i + 1) % n) { f1.push(f[i]); if (i === ie) break; }
    for (let i = ie; ; i = (i + 1) % n) { f2.push(f[i]); if (i === is) break; }
    f1.push(...inner.slice().reverse());
    f2.push(...inner);
    md.faces[fi] = f1;
    md.faces.push(f2);
    md.faceSmooth.push(!!md.faceSmooth[fi]);
    md.faceMat.push(md.faceMat[fi] ?? 0);
    md.fsel.push(!!md.fsel[fi]);
    return md.faces.length - 1;
  };
  for (const [orig, links] of byFace) {
    // adjacency of point ids inside this face
    const adj = new Map<string, string[]>();
    for (const [a, b] of links) {
      if (!adj.has(a)) adj.set(a, []);
      if (!adj.has(b)) adj.set(b, []);
      if (!adj.get(a)!.includes(b)) adj.get(a)!.push(b);
      if (!adj.get(b)!.includes(a)) adj.get(b)!.push(a);
    }
    const used = new Set<string>();
    const chains: string[][] = [];
    const walk = (start: string) => {
      const chain = [start];
      used.add(start);
      let cur = start;
      for (;;) {
        const nx = (adj.get(cur) ?? []).find((x) => !used.has(x));
        if (!nx) break;
        chain.push(nx); used.add(nx); cur = nx;
      }
      chains.push(chain);
    };
    for (const [id, l] of adj) if (l.length === 1 && !used.has(id)) walk(id);
    for (const id of adj.keys()) if (!used.has(id)) walk(id); // closed loops / branches
    if (!subFaces.has(orig)) subFaces.set(orig, [orig]);
    for (const chain of chains) {
      const vs = chain.map((id) => vertOf.get(id)!).filter((v) => v !== undefined);
      const onBoundary = (v: number) => subFaces.get(orig)!.some((fi) => md.faces[fi].includes(v));
      let i = 0;
      while (i < vs.length - 1) {
        if (!onBoundary(vs[i])) { i++; continue; }
        let j = i + 1;
        while (j < vs.length && !onBoundary(vs[j])) j++;
        if (j >= vs.length) break;
        const s = vs[i], e = vs[j], inner = vs.slice(i + 1, j);
        if (s !== e) {
          const cands = subFaces.get(orig)!.filter((fi) => md.faces[fi].includes(s) && md.faces[fi].includes(e));
          let fi = cands[0];
          if (cands.length > 1) {
            // pick the sub-face containing the cut (its middle point)
            const mid: Vec3 = inner.length ? md.verts[inner[Math.floor(inner.length / 2)]] : [
              (md.verts[s][0] + md.verts[e][0]) / 2, (md.verts[s][1] + md.verts[e][1]) / 2, (md.verts[s][2] + md.verts[e][2]) / 2];
            fi = cands.find((c) => pointInFace(md.verts, md.faces[c], mid)) ?? cands[0];
          }
          if (fi !== undefined) {
            const f = md.faces[fi];
            const is = f.indexOf(s), ie = f.indexOf(e);
            const adjacent = (is + 1) % f.length === ie || (ie + 1) % f.length === is;
            if (!(adjacent && !inner.length)) {
              const nf = faceSplit(fi, s, e, inner);
              subFaces.get(orig)!.push(nf);
              const path = [s, ...inner, e];
              for (let k = 0; k + 1 < path.length; k++) newEdges.push([path[k], path[k + 1]]);
            }
          }
        }
        i = j;
      }
    }
  }

  // ---------------------------------------------------------- 3. cleanup + selection
  md.edges = loose0;
  md.esel = md.edges.map(() => false);
  rebuildEdges(md);
  ensureArrays(md);
  const usedV = new Uint8Array(md.verts.length);
  for (const f of md.faces) for (const v of f) usedV[v] = 1;
  for (const [a, b] of md.edges) { usedV[a] = 1; usedV[b] = 1; }
  const rm = md.verts.map((_, i) => i >= nv0 && !usedV[i]);
  const remap: number[] = [];
  let k = 0;
  for (let i = 0; i < md.verts.length; i++) remap.push(rm[i] ? -1 : k++);
  if (rm.some(Boolean)) removeVerts(md, rm);
  const edgesOut = newEdges.map(([a, b]) => [remap[a], remap[b]] as [number, number]).filter(([a, b]) => a >= 0 && b >= 0);
  const vertsOut: number[] = [];
  for (let i = nv0; i < rm.length; i++) if (!rm[i]) vertsOut.push(remap[i]);
  if (select && edgesOut.length) {
    md.vsel.fill(false); md.esel.fill(false); md.fsel.fill(false);
    for (const [a, b] of edgesOut) { md.vsel[a] = true; md.vsel[b] = true; }
    flushFromVerts(md);
  }
  void sub;
  return { newEdges: edgesOut, newVerts: vertsOut };
}
