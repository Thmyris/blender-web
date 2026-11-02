// UV unwrapping and UV-space algorithms: seam islands, LSCM (least squares conformal maps) with
// pinned vertices solved by a sparse preconditioned conjugate gradient, an as-rigid-as-possible
// refinement ("Angle Based"), island packing, Smart UV Project, Lightmap Pack, Follow Active
// Quads, cube / cylinder / sphere / view projections and the UV editor's island tools.

import type { MeshData, MeshUVLayer, Vec3 } from './types';
import { cross, dot, edgeKey, length, normalize, polyArea, polyNormal, sub, triangulatePoly } from './mesh';
import { UV_PIN, cornerUV, ensureFlags, resetFaceUV, seamSet } from './uvdata';

// ------------------------------------------------------------------ small helpers

class UnionFind {
  p: Int32Array;
  constructor(n: number) { this.p = new Int32Array(n); for (let i = 0; i < n; i++) this.p[i] = i; }
  find(x: number): number { const p = this.p; while (p[x] !== x) { p[x] = p[p[x]]; x = p[x]; } return x; }
  union(a: number, b: number): void { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.p[Math.max(ra, rb)] = Math.min(ra, rb); }
}

/** Corner offsets: corner (f, k) has the global index `off[f] + k`. */
function cornerOffsets(md: MeshData): Int32Array {
  const off = new Int32Array(md.faces.length + 1);
  for (let f = 0; f < md.faces.length; f++) off[f + 1] = off[f] + md.faces[f].length;
  return off;
}

/** Map from edge key to the (face, corner-of-first-vertex) uses of that edge. */
function edgeUses(md: MeshData, faces: Iterable<number>): Map<string, [number, number][]> {
  const m = new Map<string, [number, number][]>();
  for (const f of faces) {
    const g = md.faces[f];
    for (let k = 0; k < g.length; k++) {
      const key = edgeKey(g[k], g[(k + 1) % g.length]);
      const l = m.get(key);
      if (l) l.push([f, k]); else m.set(key, [[f, k]]);
    }
  }
  return m;
}

// ------------------------------------------------------------------ islands

/** Connected groups of the given faces, split at seams (and at non-manifold edges). */
export function seamIslands(md: MeshData, faces: number[], seams = seamSet(md)): number[][] {
  const uses = edgeUses(md, faces);
  const idx = new Map<number, number>();
  faces.forEach((f, i) => idx.set(f, i));
  const uf = new UnionFind(faces.length);
  uses.forEach((l, key) => {
    if (l.length !== 2 || seams.has(key)) return;
    uf.union(idx.get(l[0][0])!, idx.get(l[1][0])!);
  });
  const groups = new Map<number, number[]>();
  faces.forEach((f, i) => { const r = uf.find(i); const g = groups.get(r); if (g) g.push(f); else groups.set(r, [f]); });
  return [...groups.values()];
}

/**
 * UV vertices of an island: corners of the same mesh vertex joined across non-seam edges.
 * Returns the group of every corner (by global corner index) and the number of groups.
 */
function cornerGroups(md: MeshData, faces: number[], off: Int32Array, seams: Set<string>): { group: Map<number, number>; count: number; vert: number[] } {
  const uses = edgeUses(md, faces);
  const ids: number[] = [];
  for (const f of faces) for (let k = 0; k < md.faces[f].length; k++) ids.push(off[f] + k);
  const local = new Map<number, number>();
  ids.forEach((c, i) => local.set(c, i));
  const uf = new UnionFind(ids.length);
  uses.forEach((l, key) => {
    if (l.length !== 2 || seams.has(key)) return;
    const [[f1, k1], [f2, k2]] = l;
    const g1 = md.faces[f1], g2 = md.faces[f2];
    const a1 = g1[k1], b1 = g1[(k1 + 1) % g1.length];
    // corners of the same vertices in the other face
    const ia = g2.indexOf(a1), ib = g2.indexOf(b1);
    if (ia < 0 || ib < 0) return;
    uf.union(local.get(off[f1] + k1)!, local.get(off[f2] + ia)!);
    uf.union(local.get(off[f1] + (k1 + 1) % g1.length)!, local.get(off[f2] + ib)!);
  });
  const group = new Map<number, number>();
  const rootId = new Map<number, number>();
  const vert: number[] = [];
  ids.forEach((c, i) => {
    const r = uf.find(i);
    let gid = rootId.get(r);
    if (gid === undefined) { gid = vert.length; rootId.set(r, gid); vert.push(-1); }
    group.set(c, gid);
  });
  for (const f of faces) md.faces[f].forEach((v, k) => { vert[group.get(off[f] + k)!] = v; });
  return { group, count: vert.length, vert };
}

/** Islands in UV space: faces connected through edges whose UVs agree on both sides. */
export function uvIslands(md: MeshData, layer: MeshUVLayer, faces: number[], eps = 1e-5): number[][] {
  const uses = edgeUses(md, faces);
  const idx = new Map<number, number>();
  faces.forEach((f, i) => idx.set(f, i));
  const uf = new UnionFind(faces.length);
  const same = (f1: number, v: number, f2: number) => {
    const k1 = md.faces[f1].indexOf(v), k2 = md.faces[f2].indexOf(v);
    const a = cornerUV(layer, f1, k1), b = cornerUV(layer, f2, k2);
    return Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps;
  };
  uses.forEach((l) => {
    if (l.length < 2) return;
    for (let i = 1; i < l.length; i++) {
      const [f1, k1] = l[0], [f2] = l[i];
      const g1 = md.faces[f1];
      const a = g1[k1], b = g1[(k1 + 1) % g1.length];
      if (same(f1, a, f2) && same(f1, b, f2)) uf.union(idx.get(f1)!, idx.get(f2)!);
    }
  });
  const groups = new Map<number, number[]>();
  faces.forEach((f, i) => { const r = uf.find(i); const g = groups.get(r); if (g) g.push(f); else groups.set(r, [f]); });
  return [...groups.values()];
}

// ------------------------------------------------------------------ sparse solver

/** Symmetric sparse matrix assembled from (row, col, value) contributions. */
class SparseSym {
  rows: Map<number, number>[];
  constructor(public n: number) { this.rows = Array.from({ length: n }, () => new Map()); }
  add(i: number, j: number, v: number): void { const r = this.rows[i]; r.set(j, (r.get(j) ?? 0) + v); }
  toCSR(): { ptr: Int32Array; col: Int32Array; val: Float64Array; diag: Float64Array } {
    let nnz = 0;
    for (const r of this.rows) nnz += r.size;
    const ptr = new Int32Array(this.n + 1), col = new Int32Array(nnz), val = new Float64Array(nnz), diag = new Float64Array(this.n);
    let p = 0;
    this.rows.forEach((r, i) => {
      ptr[i] = p;
      r.forEach((v, j) => { col[p] = j; val[p] = v; if (j === i) diag[i] = v; p++; });
    });
    ptr[this.n] = p;
    return { ptr, col, val, diag };
  }
}

/** Jacobi-preconditioned conjugate gradient for a symmetric positive (semi-)definite system. */
function pcg(A: SparseSym, b: Float64Array, x: Float64Array, maxIter: number, tol = 1e-10): void {
  const { ptr, col, val, diag } = A.toCSR();
  const n = A.n;
  const mul = (v: Float64Array, out: Float64Array) => {
    for (let i = 0; i < n; i++) { let s = 0; for (let p = ptr[i]; p < ptr[i + 1]; p++) s += val[p] * v[col[p]]; out[i] = s; }
  };
  const r = new Float64Array(n), z = new Float64Array(n), p = new Float64Array(n), Ap = new Float64Array(n);
  mul(x, Ap);
  for (let i = 0; i < n; i++) r[i] = b[i] - Ap[i];
  const inv = new Float64Array(n);
  for (let i = 0; i < n; i++) inv[i] = diag[i] > 1e-30 ? 1 / diag[i] : 1;
  for (let i = 0; i < n; i++) { z[i] = r[i] * inv[i]; p[i] = z[i]; }
  let rz = 0, bn = 0;
  for (let i = 0; i < n; i++) { rz += r[i] * z[i]; bn += b[i] * b[i]; }
  const stop = tol * tol * Math.max(bn, 1e-30);
  for (let it = 0; it < maxIter; it++) {
    let rr = 0;
    for (let i = 0; i < n; i++) rr += r[i] * r[i];
    if (rr <= stop) break;
    mul(p, Ap);
    let pAp = 0;
    for (let i = 0; i < n; i++) pAp += p[i] * Ap[i];
    if (Math.abs(pAp) < 1e-300) break;
    const alpha = rz / pAp;
    for (let i = 0; i < n; i++) { x[i] += alpha * p[i]; r[i] -= alpha * Ap[i]; }
    let rz2 = 0;
    for (let i = 0; i < n; i++) { z[i] = r[i] * inv[i]; rz2 += r[i] * z[i]; }
    const beta = rz2 / (rz || 1e-300);
    rz = rz2;
    for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i];
  }
}

// ------------------------------------------------------------------ LSCM

interface Tri { g: [number, number, number]; z: [number, number, number, number, number, number]; area: number; p: [Vec3, Vec3, Vec3] }

function islandTriangles(md: MeshData, faces: number[], off: Int32Array, group: Map<number, number>): Tri[] {
  const tris: Tri[] = [];
  for (const f of faces) {
    const g = md.faces[f];
    for (const t of triangulatePoly(md.verts, g)) {
      const p0 = md.verts[g[t[0]]], p1 = md.verts[g[t[1]]], p2 = md.verts[g[t[2]]];
      const e1 = sub(p1, p0), e2 = sub(p2, p0);
      const l1 = length(e1);
      const area = length(cross(e1, e2)) / 2;
      if (l1 < 1e-12 || area < 1e-14) continue;
      const ex = [e1[0] / l1, e1[1] / l1, e1[2] / l1] as Vec3;
      const x2 = dot(e2, ex);
      const y2 = Math.sqrt(Math.max(0, dot(e2, e2) - x2 * x2));
      tris.push({ g: [group.get(off[f] + t[0])!, group.get(off[f] + t[1])!, group.get(off[f] + t[2])!], z: [0, 0, l1, 0, x2, y2], area, p: [p0, p1, p2] });
    }
  }
  return tris;
}

/** Best-fit planar projection basis of an island (area weighted normal). */
function islandBasis(md: MeshData, faces: number[]): { ax: Vec3; ay: Vec3 } {
  const n: Vec3 = [0, 0, 0];
  for (const f of faces) { const fn = polyNormal(md.verts, md.faces[f]); const a = polyArea(md.verts, md.faces[f]); n[0] += fn[0] * a; n[1] += fn[1] * a; n[2] += fn[2] * a; }
  let nn = normalize(n);
  if (length(nn) < 0.5) nn = [0, 0, 1];
  const ref: Vec3 = Math.abs(nn[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
  const ax = normalize(cross(ref, nn));
  const ay = cross(nn, ax);
  return { ax, ay };
}

export interface UnwrapOptions {
  method: 'ANGLE_BASED' | 'CONFORMAL';
  /** Respect corners flagged as pinned (they keep their UVs). */
  usePins: boolean;
  /** Image aspect (width / height) for "Correct Aspect". */
  aspect: number;
}

/**
 * Unwrap one seam island with LSCM. Writes the UVs of every corner of `faces` into the layer.
 * Returns true when the island had at least two pinned UV vertices (it then stays in place).
 */
export function lscmIsland(md: MeshData, layer: MeshUVLayer, faces: number[], seams: Set<string>, opts: UnwrapOptions): boolean {
  const off = cornerOffsets(md);
  const { group, count } = cornerGroups(md, faces, off, seams);
  const tris = islandTriangles(md, faces, off, group);
  // pinned groups (user pins)
  const pinned = new Map<number, [number, number]>();
  if (opts.usePins && layer.flag) {
    for (const f of faces) md.faces[f].forEach((_, k) => {
      if ((layer.flag![f]?.[k] ?? 0) & UV_PIN) {
        const u = cornerUV(layer, f, k);
        pinned.set(group.get(off[f] + k)!, [u[0] * opts.aspect, u[1]]);
      }
    });
  }
  const userPinned = pinned.size >= 2;
  // initial guess: planar projection
  const { ax, ay } = islandBasis(md, faces);
  const init = new Float64Array(count * 2);
  const gVert = new Int32Array(count).fill(-1);
  for (const f of faces) md.faces[f].forEach((v, k) => { gVert[group.get(off[f] + k)!] = v; });
  for (let g = 0; g < count; g++) { const p = md.verts[gVert[g]] ?? [0, 0, 0]; init[g * 2] = dot(p, ax); init[g * 2 + 1] = dot(p, ay); }
  if (pinned.size === 1) {
    // a single pin only fixes the position: keep it and add one automatic pin
    const [[g0, uv0]] = [...pinned.entries()];
    const dx = uv0[0] - init[g0 * 2], dy = uv0[1] - init[g0 * 2 + 1];
    for (let g = 0; g < count; g++) { init[g * 2] += dx; init[g * 2 + 1] += dy; }
  }
  if (pinned.size < 2) {
    // automatic pins: the two extreme vertices along the longest axis of the island
    let best: [number, number] = [0, 0], bestD = -1;
    for (let a = 0; a < 3; a++) {
      let mn = 0, mx = 0;
      for (let g = 1; g < count; g++) {
        const p = md.verts[gVert[g]], pm = md.verts[gVert[mn]], pM = md.verts[gVert[mx]];
        if (p[a] < pm[a]) mn = g;
        if (p[a] > pM[a]) mx = g;
      }
      const d = md.verts[gVert[mx]][a] - md.verts[gVert[mn]][a];
      if (d > bestD) { bestD = d; best = [mn, mx]; }
    }
    for (const g of best) if (!pinned.has(g)) pinned.set(g, [init[g * 2], init[g * 2 + 1]]);
    if (pinned.size < 2) {
      // degenerate island (a single UV vertex)
      for (const f of faces) layer.uv[f] = md.faces[f].flatMap((_, k) => { const g = group.get(off[f] + k)!; return [init[g * 2] / opts.aspect, init[g * 2 + 1]]; });
      return userPinned;
    }
  }
  // unknown numbering
  const col = new Int32Array(count).fill(-1);
  let nFree = 0;
  for (let g = 0; g < count; g++) if (!pinned.has(g)) col[g] = nFree++;
  const sol = new Float64Array(count * 2);
  for (let g = 0; g < count; g++) {
    const p = pinned.get(g);
    sol[g * 2] = p ? p[0] : init[g * 2];
    sol[g * 2 + 1] = p ? p[1] : init[g * 2 + 1];
  }
  if (nFree > 0 && tris.length) {
    const A = new SparseSym(nFree * 2);
    const rhs = new Float64Array(nFree * 2);
    const x = new Float64Array(nFree * 2);
    for (let g = 0; g < count; g++) if (col[g] >= 0) { x[col[g] * 2] = sol[g * 2]; x[col[g] * 2 + 1] = sol[g * 2 + 1]; }
    for (const t of tris) {
      const z = t.z;
      const s = 1 / Math.sqrt(2 * t.area);
      // W_j = z_{j+2} - z_{j+1} (complex), the conformality condition is sum_j W_j U_j = 0
      const W: [number, number][] = [0, 1, 2].map((j) => {
        const a = (j + 1) % 3, b = (j + 2) % 3;
        return [(z[b * 2] - z[a * 2]) * s, (z[b * 2 + 1] - z[a * 2 + 1]) * s];
      });
      // two real rows: Re = sum(a u - b v), Im = sum(b u + a v)
      for (const row of [0, 1]) {
        const idx: number[] = [], val: number[] = [];
        let constant = 0;
        for (let j = 0; j < 3; j++) {
          const g = t.g[j];
          const [a, b] = W[j];
          const cu = row === 0 ? a : b, cv = row === 0 ? -b : a;
          if (col[g] >= 0) { idx.push(col[g] * 2, col[g] * 2 + 1); val.push(cu, cv); }
          else constant += cu * sol[g * 2] + cv * sol[g * 2 + 1];
        }
        for (let i = 0; i < idx.length; i++) {
          rhs[idx[i]] -= val[i] * constant;
          for (let k = 0; k < idx.length; k++) A.add(idx[i], idx[k], val[i] * val[k]);
        }
      }
    }
    // tiny regularisation keeps unconstrained components (isolated parts) finite
    for (let i = 0; i < nFree * 2; i++) A.add(i, i, 1e-12);
    pcg(A, rhs, x, Math.max(200, nFree * 8), 1e-9);
    for (let g = 0; g < count; g++) if (col[g] >= 0) { sol[g * 2] = x[col[g] * 2]; sol[g * 2 + 1] = x[col[g] * 2 + 1]; }
    if (opts.method === 'ANGLE_BASED') arapRefine(tris, count, sol, pinned, userPinned ? 6 : 8);
  }
  // auto-pinned solutions are mirrored when the island was seen from behind: make it face up
  if (!userPinned) {
    let signed = 0;
    for (const t of tris) {
      const [a, b, c] = t.g;
      signed += (sol[b * 2] - sol[a * 2]) * (sol[c * 2 + 1] - sol[a * 2 + 1]) - (sol[c * 2] - sol[a * 2]) * (sol[b * 2 + 1] - sol[a * 2 + 1]);
    }
    if (signed < 0) for (let g = 0; g < count; g++) sol[g * 2] = -sol[g * 2];
  }
  for (const f of faces) {
    layer.uv[f] = md.faces[f].flatMap((_, k) => { const g = group.get(off[f] + k)!; return [sol[g * 2] / opts.aspect, sol[g * 2 + 1]]; });
  }
  return userPinned;
}

/**
 * As-rigid-as-possible refinement (local rotations + global cotangent Laplacian solve), started
 * from the conformal solution. Gives more even areas, similar to Blender's angle based unwrap.
 */
function arapRefine(tris: Tri[], count: number, sol: Float64Array, pinned: Map<number, [number, number]>, iterations: number): void {
  // pins: with auto pins (only fixing a similarity), keep just the first one to allow uniform scale
  const fixed = new Map<number, [number, number]>();
  for (const [g] of pinned) fixed.set(g, [sol[g * 2], sol[g * 2 + 1]]);
  if (fixed.size < 1) return;
  const col = new Int32Array(count).fill(-1);
  let nFree = 0;
  for (let g = 0; g < count; g++) if (!fixed.has(g)) col[g] = nFree++;
  if (!nFree) return;
  // cotangent weights per triangle edge (opposite angle)
  const cots = tris.map((t) => {
    const z = t.z;
    const P = [[z[0], z[1]], [z[2], z[3]], [z[4], z[5]]];
    return [0, 1, 2].map((i) => {
      const a = P[(i + 1) % 3], b = P[(i + 2) % 3], c = P[i];
      const u = [a[0] - c[0], a[1] - c[1]], v = [b[0] - c[0], b[1] - c[1]];
      const cr = Math.abs(u[0] * v[1] - u[1] * v[0]);
      return Math.max(-50, Math.min(50, (u[0] * v[0] + u[1] * v[1]) / Math.max(cr, 1e-12)));
    });
  });
  const L = new SparseSym(nFree);
  tris.forEach((t, ti) => {
    for (let i = 0; i < 3; i++) {
      const a = t.g[(i + 1) % 3], b = t.g[(i + 2) % 3];
      const w = Math.max(1e-6, cots[ti][i] * 0.5);
      if (col[a] >= 0) L.add(col[a], col[a], w);
      if (col[b] >= 0) L.add(col[b], col[b], w);
      if (col[a] >= 0 && col[b] >= 0) { L.add(col[a], col[b], -w); L.add(col[b], col[a], -w); }
    }
  });
  // rest scale: keep the overall size of the conformal solution
  let area2d = 0, area3d = 0;
  for (const t of tris) {
    const [a, b, c] = t.g;
    area2d += Math.abs((sol[b * 2] - sol[a * 2]) * (sol[c * 2 + 1] - sol[a * 2 + 1]) - (sol[c * 2] - sol[a * 2]) * (sol[b * 2 + 1] - sol[a * 2 + 1])) / 2;
    area3d += t.area;
  }
  const scl = area3d > 0 ? Math.sqrt(area2d / area3d) : 1;
  const xu = new Float64Array(nFree), xv = new Float64Array(nFree);
  for (let it = 0; it < iterations; it++) {
    // local step: best rotation per triangle
    const rots = tris.map((t, ti) => {
      const z = t.z;
      let s00 = 0, s01 = 0, s10 = 0, s11 = 0;
      for (let i = 0; i < 3; i++) {
        const a = (i + 1) % 3, b = (i + 2) % 3;
        const w = cots[ti][i];
        const ex = (z[a * 2] - z[b * 2]) * scl, ey = (z[a * 2 + 1] - z[b * 2 + 1]) * scl;
        const ux = sol[t.g[a] * 2] - sol[t.g[b] * 2], uy = sol[t.g[a] * 2 + 1] - sol[t.g[b] * 2 + 1];
        s00 += w * ux * ex; s01 += w * ux * ey; s10 += w * uy * ex; s11 += w * uy * ey;
      }
      // closest rotation to S (2x2 polar decomposition)
      const ang = Math.atan2(s10 - s01, s00 + s11);
      return [Math.cos(ang), Math.sin(ang)];
    });
    // global step: L x = b
    const bu = new Float64Array(nFree), bv = new Float64Array(nFree);
    tris.forEach((t, ti) => {
      const [c, s] = rots[ti];
      const z = t.z;
      for (let i = 0; i < 3; i++) {
        const a = (i + 1) % 3, b = (i + 2) % 3;
        const w = Math.max(1e-6, cots[ti][i] * 0.5);
        const ex = (z[a * 2] - z[b * 2]) * scl, ey = (z[a * 2 + 1] - z[b * 2 + 1]) * scl;
        const rx = c * ex - s * ey, ry = s * ex + c * ey;
        const ga = t.g[a], gb = t.g[b];
        if (col[ga] >= 0) { bu[col[ga]] += w * rx; bv[col[ga]] += w * ry; }
        if (col[gb] >= 0) { bu[col[gb]] -= w * rx; bv[col[gb]] -= w * ry; }
        // fixed neighbours move to the right-hand side
        if (col[ga] >= 0 && col[gb] < 0) { bu[col[ga]] += w * sol[gb * 2]; bv[col[ga]] += w * sol[gb * 2 + 1]; }
        if (col[gb] >= 0 && col[ga] < 0) { bu[col[gb]] += w * sol[ga * 2]; bv[col[gb]] += w * sol[ga * 2 + 1]; }
      }
    });
    for (let g = 0; g < count; g++) if (col[g] >= 0) { xu[col[g]] = sol[g * 2]; xv[col[g]] = sol[g * 2 + 1]; }
    pcg(L, bu, xu, Math.max(100, nFree * 2), 1e-8);
    pcg(L, bv, xv, Math.max(100, nFree * 2), 1e-8);
    for (let g = 0; g < count; g++) if (col[g] >= 0) { sol[g * 2] = xu[col[g]]; sol[g * 2 + 1] = xv[col[g]]; }
  }
}

// ------------------------------------------------------------------ packing

interface PackItem { faces: number[]; minU: number; minV: number; w: number; h: number; rotated: boolean }

function islandPoints(md: MeshData, layer: MeshUVLayer, faces: number[]): [number, number][] {
  const pts: [number, number][] = [];
  for (const f of faces) md.faces[f].forEach((_, k) => pts.push(cornerUV(layer, f, k)));
  return pts;
}

function transformIsland(md: MeshData, layer: MeshUVLayer, faces: number[], fn: (u: number, v: number) => [number, number]): void {
  for (const f of faces) {
    const u = layer.uv[f];
    if (!u) continue;
    for (let k = 0; k < md.faces[f].length; k++) { const r = fn(u[k * 2], u[k * 2 + 1]); u[k * 2] = r[0]; u[k * 2 + 1] = r[1]; }
  }
}

/** Convex hull (monotone chain). */
function convexHull(pts: [number, number][]): [number, number][] {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cr = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [], upper: [number, number][] = [];
  for (const q of p) { while (lower.length >= 2 && cr(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cr(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Rotate an island so its bounding rectangle has minimal area. */
export function rotateIslandMinArea(md: MeshData, layer: MeshUVLayer, faces: number[]): void {
  const hull = convexHull(islandPoints(md, layer, faces));
  if (hull.length < 3) return;
  let bestA = Infinity, bestAng = 0;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const c = Math.cos(-ang), s = Math.sin(-ang);
    let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
    for (const [x, y] of hull) { const rx = x * c - y * s, ry = x * s + y * c; mnx = Math.min(mnx, rx); mxx = Math.max(mxx, rx); mny = Math.min(mny, ry); mxy = Math.max(mxy, ry); }
    const area = (mxx - mnx) * (mxy - mny);
    if (area < bestA - 1e-12) { bestA = area; bestAng = ang; }
  }
  const c = Math.cos(-bestAng), s = Math.sin(-bestAng);
  transformIsland(md, layer, faces, (u, v) => [u * c - v * s, u * s + v * c]);
}

/**
 * Pack islands into the 0..1 UV square with a margin (fraction of the square). Islands are
 * rotated to their tightest bounding box when `rotate` is set, and scaled uniformly together.
 */
export function packIslands(md: MeshData, layer: MeshUVLayer, islands: number[][], margin = 0.001, rotate = true): void {
  if (!islands.length) return;
  if (rotate) for (const isl of islands) rotateIslandMinArea(md, layer, isl);
  const items: PackItem[] = islands.map((faces) => {
    const pts = islandPoints(md, layer, faces);
    let mnu = Infinity, mnv = Infinity, mxu = -Infinity, mxv = -Infinity;
    for (const [u, v] of pts) { mnu = Math.min(mnu, u); mxu = Math.max(mxu, u); mnv = Math.min(mnv, v); mxv = Math.max(mxv, v); }
    if (!isFinite(mnu)) { mnu = mnv = 0; mxu = mxv = 0; }
    return { faces, minU: mnu, minV: mnv, w: mxu - mnu, h: mxv - mnv, rotated: false };
  });
  // landscape boxes pack better on shelves
  if (rotate) for (const it of items) if (it.h > it.w * 1.0001) {
    rotateIsland90(md, layer, it.faces);
    const pts = islandPoints(md, layer, it.faces);
    let mnu = Infinity, mnv = Infinity, mxu = -Infinity, mxv = -Infinity;
    for (const [u, v] of pts) { mnu = Math.min(mnu, u); mxu = Math.max(mxu, u); mnv = Math.min(mnv, v); mxv = Math.max(mxv, v); }
    it.minU = mnu; it.minV = mnv; it.w = mxu - mnu; it.h = mxv - mnv;
  }
  let total = 0, maxDim = 0;
  for (const it of items) { total += Math.max(it.w, 1e-9) * Math.max(it.h, 1e-9); maxDim = Math.max(maxDim, it.w, it.h); }
  const unit = Math.sqrt(Math.max(total, 1e-12));
  const pad = margin * unit * 2;
  const boxes = items.map((it, i) => ({ i, w: it.w + pad, h: it.h + pad }));
  boxes.sort((a, b) => b.h - a.h || b.w - a.w);
  let best: { x: number; y: number }[] | null = null, bestSize = Infinity;
  const minW = Math.max(maxDim + pad, unit * 0.5);
  for (let t = 0; t < 24; t++) {
    const W = minW * Math.pow(1.08, t);
    const pos: { x: number; y: number }[] = new Array(items.length);
    let x = 0, y = 0, shelfH = 0, usedW = 0;
    for (const b of boxes) {
      if (x > 0 && x + b.w > W) { x = 0; y += shelfH; shelfH = 0; }
      pos[b.i] = { x, y };
      x += b.w; usedW = Math.max(usedW, x); shelfH = Math.max(shelfH, b.h);
    }
    const size = Math.max(usedW, y + shelfH);
    if (size < bestSize) { bestSize = size; best = pos; }
  }
  if (!best || !isFinite(bestSize) || bestSize <= 0) return;
  const s = 1 / bestSize;
  items.forEach((it, i) => {
    const p = best![i];
    transformIsland(md, layer, it.faces, (u, v) => [(u - it.minU + p.x + pad / 2) * s, (v - it.minV + p.y + pad / 2) * s]);
  });
}

/** Rotate an island 90 degrees about its bounding box corner (used by packing). */
export function rotateIsland90(md: MeshData, layer: MeshUVLayer, faces: number[]): void {
  transformIsland(md, layer, faces, (u, v) => [-v, u]);
}

/** Scale islands so their UV areas are proportional to their 3D areas (Average Islands Scale). */
export function averageIslandScale(md: MeshData, layer: MeshUVLayer, islands: number[][]): void {
  const info = islands.map((faces) => {
    let a3 = 0, a2 = 0, cu = 0, cv = 0, n = 0;
    for (const f of faces) {
      a3 += polyArea(md.verts, md.faces[f]);
      a2 += Math.abs(uvPolyArea(layer.uv[f] ?? []));
      md.faces[f].forEach((_, k) => { const p = cornerUV(layer, f, k); cu += p[0]; cv += p[1]; n++; });
    }
    return { faces, a3, a2, cu: cu / Math.max(1, n), cv: cv / Math.max(1, n) };
  });
  const t3 = info.reduce((s, i) => s + i.a3, 0), t2 = info.reduce((s, i) => s + i.a2, 0);
  if (t3 <= 0 || t2 <= 0) return;
  for (const i of info) {
    if (i.a2 <= 1e-14 || i.a3 <= 0) continue;
    const s = Math.sqrt((i.a3 / t3) / (i.a2 / t2));
    transformIsland(md, layer, i.faces, (u, v) => [i.cu + (u - i.cu) * s, i.cv + (v - i.cv) * s]);
  }
}

export function uvPolyArea(u: number[]): number {
  let a = 0;
  const n = u.length / 2;
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; a += u[i * 2] * u[j * 2 + 1] - u[j * 2] * u[i * 2 + 1]; }
  return a / 2;
}

// ------------------------------------------------------------------ unwrap entry point

export interface UnwrapResult { islands: number; }

/** Unwrap the given faces: LSCM per seam island, then pack the islands that are not pinned. */
export function unwrapFaces(md: MeshData, layer: MeshUVLayer, faces: number[], opts: UnwrapOptions & { margin: number; fillHoles?: boolean }): UnwrapResult {
  const seams = seamSet(md);
  const islands = seamIslands(md, faces, seams);
  const toPack: number[][] = [];
  for (const isl of islands) {
    const pinnedIsland = lscmIsland(md, layer, isl, seams, { ...opts, aspect: 1 });
    if (!pinnedIsland) toPack.push(isl);
  }
  if (toPack.length) {
    // islands come out at 3D scale: make them proportional before packing
    averageIslandScale(md, layer, toPack);
    packIslands(md, layer, toPack, opts.margin, true);
    // Correct Aspect: squares in 3D stay square in pixels of a non-square image
    if (opts.aspect > 1) for (const isl of toPack) transformIsland(md, layer, isl, (u, v) => [u / opts.aspect, v]);
    else if (opts.aspect < 1 && opts.aspect > 0) for (const isl of toPack) transformIsland(md, layer, isl, (u, v) => [u, v * opts.aspect]);
  }
  return { islands: islands.length };
}

// ------------------------------------------------------------------ Smart UV Project

/** Smart UV Project: group faces by normal direction (angle limit), project each group, pack. */
export function smartProject(md: MeshData, layer: MeshUVLayer, faces: number[], angleLimitDeg: number, islandMargin: number, areaWeight: number): void {
  if (!faces.length) return;
  const normals = new Map<number, Vec3>();
  const areas = new Map<number, number>();
  for (const f of faces) { normals.set(f, polyNormal(md.verts, md.faces[f])); areas.set(f, polyArea(md.verts, md.faces[f])); }
  const cosLimit = Math.cos((Math.max(1, Math.min(89, angleLimitDeg)) * Math.PI) / 180);
  // choose projection directions greedily
  const dirs: Vec3[] = [];
  const unassigned = new Set(faces);
  const sorted = faces.slice().sort((a, b) => areas.get(b)! - areas.get(a)!);
  for (const f of sorted) {
    if (!unassigned.has(f)) continue;
    // average of the normals within the limit of this face's normal (weighted by area)
    const n0 = normals.get(f)!;
    let acc: Vec3 = [0, 0, 0];
    for (const g of unassigned) {
      const n = normals.get(g)!;
      if (dot(n, n0) >= cosLimit) {
        const ww = areaWeight > 0 ? Math.max(1e-6, (1 - areaWeight) + areaWeight * areas.get(g)!) : 1;
        acc = [acc[0] + n[0] * ww, acc[1] + n[1] * ww, acc[2] + n[2] * ww];
      }
    }
    let d = normalize(acc);
    if (length(d) < 0.5) d = n0;
    dirs.push(d);
    for (const g of [...unassigned]) if (dot(normals.get(g)!, d) >= cosLimit || dot(normals.get(g)!, n0) >= cosLimit) unassigned.delete(g);
    if (dirs.length > 512) break;
  }
  // assign each face to its best direction, split into connected groups
  const dirOf = new Map<number, number>();
  for (const f of faces) {
    let best = 0, bd = -Infinity;
    dirs.forEach((d, i) => { const v = dot(d, normals.get(f)!); if (v > bd) { bd = v; best = i; } });
    dirOf.set(f, best);
  }
  const uses = edgeUses(md, faces);
  const idx = new Map<number, number>();
  faces.forEach((f, i) => idx.set(f, i));
  const uf = new UnionFind(faces.length);
  uses.forEach((l) => { if (l.length === 2 && dirOf.get(l[0][0]) === dirOf.get(l[1][0])) uf.union(idx.get(l[0][0])!, idx.get(l[1][0])!); });
  const groups = new Map<number, number[]>();
  faces.forEach((f, i) => { const r = uf.find(i); const g = groups.get(r); if (g) g.push(f); else groups.set(r, [f]); });
  const islands = [...groups.values()];
  for (const isl of islands) {
    const d = dirs[dirOf.get(isl[0])!];
    const ref: Vec3 = Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
    const ax = normalize(cross(ref, d)), ay = cross(d, ax);
    for (const f of isl) layer.uv[f] = md.faces[f].flatMap((v) => [dot(md.verts[v], ax), dot(md.verts[v], ay)]);
  }
  packIslands(md, layer, islands, islandMargin, true);
}

// ------------------------------------------------------------------ Lightmap Pack

/** Lightmap Pack: every face (quads, or pairs of triangles) gets its own box in the layout. */
export function lightmapPack(md: MeshData, layer: MeshUVLayer, faces: number[], margin: number): void {
  const islands: number[][] = [];
  const used = new Set<number>();
  const uses = edgeUses(md, faces);
  for (const f of faces) {
    if (used.has(f)) continue;
    used.add(f);
    const g = md.faces[f];
    const n = polyNormal(md.verts, g);
    const ref: Vec3 = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
    const ax = normalize(cross(ref, n)), ay = cross(n, ax);
    layer.uv[f] = g.flatMap((v) => [dot(md.verts[v], ax), dot(md.verts[v], ay)]);
    const isl = [f];
    if (g.length === 3) {
      // pair with a neighbouring triangle sharing its longest edge
      let bestK = 0, bestL = -1;
      for (let k = 0; k < 3; k++) { const l = length(sub(md.verts[g[k]], md.verts[g[(k + 1) % 3]])); if (l > bestL) { bestL = l; bestK = k; } }
      const other = (uses.get(edgeKey(g[bestK], g[(bestK + 1) % 3])) ?? []).map(([h]) => h).find((h) => h !== f && !used.has(h) && md.faces[h].length === 3);
      if (other !== undefined) {
        used.add(other);
        // unfold the partner triangle into the same plane across the shared edge
        const h = md.faces[other];
        const a = g[bestK], b = g[(bestK + 1) % 3];
        const c = h.find((v) => v !== a && v !== b)!;
        const ua = cornerUV(layer, f, bestK), ub = cornerUV(layer, f, (bestK + 1) % 3);
        const pa = md.verts[a], pb = md.verts[b], pc = md.verts[c];
        const e = sub(pb, pa), el = length(e) || 1;
        const t = dot(sub(pc, pa), e) / (el * el);
        const foot = [pa[0] + e[0] * t, pa[1] + e[1] * t, pa[2] + e[2] * t] as Vec3;
        const hgt = length(sub(pc, foot));
        const du = [ub[0] - ua[0], ub[1] - ua[1]];
        const dl = Math.hypot(du[0], du[1]) || 1;
        // perpendicular pointing away from the first triangle's third corner
        const third = cornerUV(layer, f, (bestK + 2) % 3);
        let px = -du[1] / dl, py = du[0] / dl;
        if ((third[0] - ua[0]) * px + (third[1] - ua[1]) * py > 0) { px = -px; py = -py; }
        const uc: [number, number] = [ua[0] + du[0] * t + px * hgt, ua[1] + du[1] * t + py * hgt];
        layer.uv[other] = h.flatMap((v) => (v === a ? ua : v === b ? ub : uc));
        isl.push(other);
      }
    }
    islands.push(isl);
  }
  packIslands(md, layer, islands, margin, true);
}

// ------------------------------------------------------------------ Follow Active Quads

/** Follow Active Quads: propagate the active quad's UV layout across connected selected quads. */
export function followActiveQuads(md: MeshData, layer: MeshUVLayer, faces: number[], active: number, mode: 'EVEN' | 'LENGTH' | 'LENGTH_AVERAGE'): boolean {
  if (active < 0 || md.faces[active]?.length !== 4 || !faces.includes(active)) return false;
  const quads = new Set(faces.filter((f) => md.faces[f].length === 4));
  const uses = edgeUses(md, quads);
  const done = new Set<number>([active]);
  const queue = [active];
  const elen = (a: number, b: number) => length(sub(md.verts[a], md.verts[b]));
  // LENGTH_AVERAGE: average length of each edge loop ring step (approximated per edge ring)
  while (queue.length) {
    const f = queue.shift()!;
    const g = md.faces[f];
    for (let k = 0; k < 4; k++) {
      const a = g[k], b = g[(k + 1) % 4];
      for (const [h] of uses.get(edgeKey(a, b)) ?? []) {
        if (done.has(h)) continue;
        const q = md.faces[h];
        const ia = q.indexOf(a), ib = q.indexOf(b);
        if (ia < 0 || ib < 0) continue;
        // in the neighbour, the corner after b (going away from a) and the corner before a
        const step = (ib - ia + 4) % 4 === 1 ? 1 : -1;
        const ic = (ib + step + 4) % 4, id = (ia - step + 4) % 4;
        const c = q[ic], d = q[id];
        // in the source face, the corners opposite a and b
        const a2 = g[(k + 3) % 4], b2 = g[(k + 2) % 4];
        const ua = cornerUV(layer, f, k), ub = cornerUV(layer, f, (k + 1) % 4);
        const ua2 = cornerUV(layer, f, (k + 3) % 4), ub2 = cornerUV(layer, f, (k + 2) % 4);
        let fa = 1, fb = 1;
        if (mode !== 'EVEN') {
          const la = elen(a, a2), lb = elen(b, b2), lc = elen(b, c), ld = elen(a, d);
          if (mode === 'LENGTH') { fa = la > 1e-12 ? ld / la : 1; fb = lb > 1e-12 ? lc / lb : 1; }
          else { const avgS = (la + lb) / 2, avgD = (lc + ld) / 2; fa = fb = avgS > 1e-12 ? avgD / avgS : 1; }
        }
        const uc: [number, number] = [ub[0] + (ub[0] - ub2[0]) * fb, ub[1] + (ub[1] - ub2[1]) * fb];
        const ud: [number, number] = [ua[0] + (ua[0] - ua2[0]) * fa, ua[1] + (ua[1] - ua2[1]) * fa];
        const out: number[] = new Array(8);
        const put = (i: number, p: [number, number]) => { out[i * 2] = p[0]; out[i * 2 + 1] = p[1]; };
        put(ia, ua); put(ib, ub); put(ic, uc); put(id, ud);
        layer.uv[h] = out;
        done.add(h);
        queue.push(h);
      }
    }
  }
  return true;
}

// ------------------------------------------------------------------ projections

/** Cube projection: each face onto the plane of its dominant normal axis. */
export function cubeProject(md: MeshData, layer: MeshUVLayer, faces: number[], cubeSize: number, center: Vec3): void {
  const s = cubeSize > 1e-9 ? 1 / (2 * cubeSize) : 1;
  for (const f of faces) {
    const n = polyNormal(md.verts, md.faces[f]);
    const ax = Math.abs(n[0]) >= Math.abs(n[1]) && Math.abs(n[0]) >= Math.abs(n[2]) ? 0 : Math.abs(n[1]) >= Math.abs(n[2]) ? 1 : 2;
    const [cu, cv] = ax === 0 ? [1, 2] : ax === 1 ? [0, 2] : [0, 1];
    layer.uv[f] = md.faces[f].flatMap((v) => [0.5 + (md.verts[v][cu] - center[cu]) * s, 0.5 + (md.verts[v][cv] - center[cv]) * s]);
  }
}

/** Cylinder or sphere projection around an axis frame (rows of `rot` are the frame axes, z = the pole axis). */
export function wrapProject(md: MeshData, layer: MeshUVLayer, faces: number[], kind: 'CYLINDER' | 'SPHERE', center: Vec3, frame: [Vec3, Vec3, Vec3], radius: number): void {
  const [X, Y, Z] = frame;
  for (const f of faces) {
    const g = md.faces[f];
    const loc = g.map((v) => { const p = sub(md.verts[v], center); return [dot(p, X), dot(p, Y), dot(p, Z)] as Vec3; });
    const poles = loc.map((p) => Math.hypot(p[0], p[1]) < 1e-9);
    let us = loc.map((p) => (Math.atan2(p[1], p[0]) / (2 * Math.PI)) + 0.5);
    // faces crossing the seam
    const np = us.filter((_, i) => !poles[i]);
    if (np.length && Math.max(...np) - Math.min(...np) > 0.5) us = us.map((u, i) => (!poles[i] && u < 0.5 ? u + 1 : u));
    const avg = np.length ? us.filter((_, i) => !poles[i]).reduce((a, b) => a + b, 0) / np.length : 0.5;
    us = us.map((u, i) => (poles[i] ? avg : u));
    const vs = loc.map((p) => {
      if (kind === 'CYLINDER') return p[2] / Math.max(1e-9, radius * 2) + 0.5;
      const l = Math.hypot(p[0], p[1], p[2]) || 1;
      return Math.asin(Math.max(-1, Math.min(1, p[2] / l))) / Math.PI + 0.5;
    });
    layer.uv[f] = g.flatMap((_, i) => [us[i], vs[i]]);
  }
}

/** Fit (scale_to_bounds) or clamp (clip_to_bounds) the UVs of faces into 0..1. */
export function boundsFit(md: MeshData, layer: MeshUVLayer, faces: number[], scale: boolean, clip: boolean): void {
  if (scale) {
    let mnu = Infinity, mnv = Infinity, mxu = -Infinity, mxv = -Infinity;
    for (const f of faces) md.faces[f].forEach((_, k) => { const p = cornerUV(layer, f, k); mnu = Math.min(mnu, p[0]); mxu = Math.max(mxu, p[0]); mnv = Math.min(mnv, p[1]); mxv = Math.max(mxv, p[1]); });
    const du = mxu - mnu, dv = mxv - mnv;
    if (isFinite(du)) transformIsland(md, layer, faces, (u, v) => [du > 1e-12 ? (u - mnu) / du : 0.5, dv > 1e-12 ? (v - mnv) / dv : 0.5]);
  } else if (clip) {
    transformIsland(md, layer, faces, (u, v) => [Math.min(1, Math.max(0, u)), Math.min(1, Math.max(0, v))]);
  }
}

/** Reset UVs of faces (each face covers the whole UV square). */
export function resetFaces(md: MeshData, layer: MeshUVLayer, faces: number[]): void {
  for (const f of faces) layer.uv[f] = resetFaceUV(md.faces[f].length);
}

// ------------------------------------------------------------------ UV editor tools

/** Seams From Islands: mark seams on edges whose UVs differ between their two faces (or on UV boundaries). */
export function seamsFromIslands(md: MeshData, layer: MeshUVLayer, faces: number[]): Set<string> {
  const uses = edgeUses(md, faces);
  const out = new Set<string>();
  const eps = 1e-5;
  uses.forEach((l, key) => {
    if (l.length !== 2) return;
    const [[f1, k1], [f2]] = l;
    const g1 = md.faces[f1], g2 = md.faces[f2];
    for (const v of [g1[k1], g1[(k1 + 1) % g1.length]]) {
      const a = cornerUV(layer, f1, g1.indexOf(v)), b = cornerUV(layer, f2, g2.indexOf(v));
      if (Math.abs(a[0] - b[0]) > eps || Math.abs(a[1] - b[1]) > eps) { out.add(key); break; }
    }
  });
  return out;
}

/** Minimize Stretch (approximation): relax unpinned UVs towards an as-rigid-as-possible layout per UV island. */
export function minimizeStretch(md: MeshData, layer: MeshUVLayer, faces: number[], iterations: number, blend: number): void {
  const fl = ensureFlags(md, layer);
  const seams = seamsFromIslands(md, layer, faces);
  for (const isl of seamIslands(md, faces, seams)) {
    const off = cornerOffsets(md);
    const { group, count } = cornerGroups(md, isl, off, seams);
    const tris = islandTriangles(md, isl, off, group);
    const sol = new Float64Array(count * 2);
    const pinned = new Map<number, [number, number]>();
    for (const f of isl) md.faces[f].forEach((_, k) => {
      const g = group.get(off[f] + k)!;
      const u = cornerUV(layer, f, k);
      sol[g * 2] = u[0]; sol[g * 2 + 1] = u[1];
      if (fl[f][k] & UV_PIN) pinned.set(g, u);
    });
    // keep at least one vertex fixed
    if (!pinned.size && count) pinned.set(0, [sol[0], sol[1]]);
    const before = sol.slice();
    arapRefine(tris, count, sol, pinned, Math.max(1, Math.min(50, iterations)));
    for (const f of isl) layer.uv[f] = md.faces[f].flatMap((_, k) => {
      const g = group.get(off[f] + k)!;
      return [before[g * 2] + (sol[g * 2] - before[g * 2]) * (1 - blend), before[g * 2 + 1] + (sol[g * 2 + 1] - before[g * 2 + 1]) * (1 - blend)];
    });
  }
}
