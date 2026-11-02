// More edit-mode mesh tools (Blender 2.79 semantics), working on MeshData in place:
// Bisect, Edge Split / Rip, Rotate Edge, Fill, Beautify Faces, Bridge Edge Loops, Grid Fill,
// Connect Vertex Path, Unsubdivide, Symmetrize, Snap to Symmetry and slide rails.

import type { MeshData, Vec3 } from './types';
import {
  edgeKey, ensureArrays, flushFromEdges, flushFromFaces, flushFromVerts, polyNormal, polyCenter, rebuildEdges,
  removeVerts, triangulatePoly, add, sub, scale, dot, cross, normalize, length, lerp3,
} from './mesh';
import { knifeApply, type KnifePiece, type KnifePoint } from './knife';

// ------------------------------------------------------------------ helpers

function edgeFaceMap(md: MeshData): Map<string, number[]> {
  const ef = new Map<string, number[]>();
  md.faces.forEach((f, i) => {
    for (let k = 0; k < f.length; k++) {
      const key = edgeKey(f[k], f[(k + 1) % f.length]);
      const l = ef.get(key);
      if (l) l.push(i); else ef.set(key, [i]);
    }
  });
  return ef;
}

function looseEdgeList(md: MeshData): [number, number][] {
  const fe = new Set<string>();
  for (const f of md.faces) for (let k = 0; k < f.length; k++) fe.add(edgeKey(f[k], f[(k + 1) % f.length]));
  return md.edges.filter(([a, b]) => !fe.has(edgeKey(a, b))).map(([a, b]) => [a, b] as [number, number]);
}

/** Rebuild edges from faces plus the given loose edges (stale face edges disappear). */
function rebuildWith(md: MeshData, loose: [number, number][]): void {
  md.edges = loose.filter(([a, b]) => a !== b).map(([a, b]) => (a < b ? [a, b] : [b, a]) as [number, number]);
  md.esel = md.edges.map(() => false);
  rebuildEdges(md);
  ensureArrays(md);
}

function addFaceTo(md: MeshData, f: number[], src: number, sel: boolean): number {
  md.faces.push(f);
  md.faceSmooth.push(src >= 0 ? !!md.faceSmooth[src] : false);
  md.faceMat.push(src >= 0 ? md.faceMat[src] ?? 0 : 0);
  md.fsel.push(sel);
  return md.faces.length - 1;
}

/** Does face f traverse a -> b (1), b -> a (-1) or not contain the edge (0)? */
function dirIn(f: number[], a: number, b: number): number {
  const i = f.indexOf(a);
  if (i < 0) return 0;
  if (f[(i + 1) % f.length] === b) return 1;
  if (f[(i - 1 + f.length) % f.length] === b) return -1;
  return 0;
}

/** Orient a closed loop so that it runs against the faces already using its edges. */
function orientLoop(md: MeshData, loop: number[], ef: Map<string, number[]>): number[] {
  let score = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length];
    for (const fi of ef.get(edgeKey(a, b)) ?? []) score += dirIn(md.faces[fi], a, b);
  }
  return score > 0 ? loop.slice().reverse() : loop;
}

/** Chains (open or closed) formed by a set of edges. */
export function edgeChains(edges: [number, number][]): { verts: number[]; closed: boolean }[] {
  const adj = new Map<number, number[]>();
  for (const [a, b] of edges) {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a)!.push(b); adj.get(b)!.push(a);
  }
  const used = new Set<string>();
  const out: { verts: number[]; closed: boolean }[] = [];
  const walk = (start: number) => {
    const verts = [start];
    let cur = start;
    for (;;) {
      const nx = (adj.get(cur) ?? []).find((n) => !used.has(edgeKey(cur, n)));
      if (nx === undefined) break;
      used.add(edgeKey(cur, nx));
      if (nx === start) { out.push({ verts, closed: true }); return; }
      verts.push(nx);
      cur = nx;
    }
    out.push({ verts, closed: false });
  };
  for (const [v, l] of adj) if (l.length !== 2) for (const n of l) if (!used.has(edgeKey(v, n))) { used.add(edgeKey(v, n)); const ch = walkFrom(v, n); out.push(ch); }
  function walkFrom(a: number, b: number): { verts: number[]; closed: boolean } {
    const verts = [a, b];
    let prev = a, cur = b;
    while ((adj.get(cur)?.length ?? 0) === 2) {
      const nx = adj.get(cur)!.find((n) => n !== prev && !used.has(edgeKey(cur, n)));
      if (nx === undefined) break;
      used.add(edgeKey(cur, nx));
      verts.push(nx);
      prev = cur; cur = nx;
    }
    return { verts, closed: false };
  }
  for (const v of adj.keys()) if ((adj.get(v) ?? []).some((n) => !used.has(edgeKey(v, n)))) walk(v);
  return out;
}

function selectedEdgeList(md: MeshData): [number, number][] {
  return md.edges.filter((_, i) => md.esel[i]).map(([a, b]) => [a, b] as [number, number]);
}

// ================================================================== bisect

export interface BisectOptions { fill?: boolean; clearInner?: boolean; clearOuter?: boolean; threshold?: number }

/** Cut the selected geometry with a plane (local space). Returns false when nothing was cut. */
export function bisectMesh(md: MeshData, co: Vec3, no: Vec3, opt: BisectOptions = {}): boolean {
  ensureArrays(md);
  const n = normalize(no);
  if (length(n) < 1e-12) return false;
  const thr = Math.max(1e-7, opt.threshold ?? 0.0001);
  const nv0 = md.verts.length;
  const selV = md.vsel.slice();
  const d = (p: Vec3) => dot(sub(p, co), n);
  const dist = md.verts.map(d);
  const onPlane = (v: number) => Math.abs(dist[v]) <= thr;
  // snap verts close to the plane onto it
  md.verts.forEach((p, v) => { if (selV[v] && onPlane(v) && dist[v] !== 0) { md.verts[v] = sub(p, scale(n, dist[v])); dist[v] = 0; } });
  const pieces: KnifePiece[] = [];
  const ptOf = (a: number, b: number): KnifePoint | null => {
    if (onPlane(a) || onPlane(b) || (dist[a] > 0) === (dist[b] > 0)) return null;
    const t = dist[a] / (dist[a] - dist[b]);
    return { id: `e${edgeKey(a, b)}`, kind: 'EDGE', e: [a, b], t, co: lerp3(md.verts[a], md.verts[b], t) };
  };
  md.faces.forEach((f, fi) => {
    if (!md.fsel[fi] || md.fhide?.[fi]) return;
    const pts: { p: KnifePoint; pos: Vec3 }[] = [];
    for (let k = 0; k < f.length; k++) {
      const a = f[k], b = f[(k + 1) % f.length];
      if (onPlane(a)) pts.push({ p: { id: `v${a}`, kind: 'VERT', v: a, co: md.verts[a] }, pos: md.verts[a] });
      const e = ptOf(a, b);
      if (e) pts.push({ p: e, pos: e.co });
    }
    if (pts.length < 2) return;
    const dir = normalize(cross(n, polyNormal(md.verts, f)));
    pts.sort((x, y) => dot(x.pos, dir) - dot(y.pos, dir));
    for (let k = 0; k + 1 < pts.length; k += 2) pieces.push({ face: fi, a: pts[k].p, b: pts[k + 1].p });
  });
  // loose selected edges crossing the plane are split
  const fe = new Set<string>();
  for (const f of md.faces) for (let k = 0; k < f.length; k++) fe.add(edgeKey(f[k], f[(k + 1) % f.length]));
  const looseSplits: { a: number; b: number; p: Vec3 }[] = [];
  md.edges.forEach(([a, b], i) => {
    if (!md.esel[i] || fe.has(edgeKey(a, b))) return;
    const e = ptOf(a, b);
    if (e) looseSplits.push({ a, b, p: e.co });
  });
  const res = knifeApply(md, pieces, false);
  for (const s of looseSplits) {
    const v = md.verts.length;
    md.verts.push(s.p); md.vsel.push(true);
    md.edges = md.edges.filter(([x, y]) => edgeKey(x, y) !== edgeKey(s.a, s.b));
    md.edges.push([Math.min(s.a, v), Math.max(s.a, v)], [Math.min(s.b, v), Math.max(s.b, v)]);
  }
  ensureArrays(md);
  if (!res.newEdges.length && !looseSplits.length && !opt.clearInner && !opt.clearOuter && !opt.fill) return pieces.length > 0;
  // geometry considered: the originally selected verts plus everything new
  const consider = md.verts.map((_, v) => v >= nv0 || !!selV[v]);
  const distNow = md.verts.map(d);
  if (opt.clearInner || opt.clearOuter) {
    const rm = md.verts.map((_, v) => consider[v] && ((opt.clearInner && distNow[v] < -thr) || (opt.clearOuter && distNow[v] > thr)));
    if (rm.some(Boolean)) {
      const keep: number[] = [];
      rm.forEach((r, v) => { if (!r) keep.push(v); });
      removeVerts(md, rm);
      // keep track of which verts are new / considered
      const c2 = keep.map((v) => consider[v]);
      consider.length = 0; consider.push(...c2);
    }
  }
  // cut edges: edges lying on the plane among the considered geometry
  const dist2 = md.verts.map(d);
  const cut = md.edges.filter(([a, b]) => consider[a] && consider[b] && Math.abs(dist2[a]) <= thr && Math.abs(dist2[b]) <= thr);
  md.vsel.fill(false); md.esel.fill(false); md.fsel.fill(false);
  if (opt.fill) {
    const ef = edgeFaceMap(md);
    const boundary = cut.filter(([a, b]) => (ef.get(edgeKey(a, b))?.length ?? 0) <= 1);
    for (const ch of edgeChains(boundary)) {
      if (!ch.closed || ch.verts.length < 3) continue;
      let loop = orientLoop(md, ch.verts, ef);
      if (!boundary.some(([a, b]) => ef.get(edgeKey(a, b))?.length)) {
        // free-standing loop: face the normal along +n
        if (dot(polyNormal(md.verts, loop), n) < 0) loop = loop.slice().reverse();
      }
      addFaceTo(md, loop, -1, true);
    }
    rebuildEdges(md);
    ensureArrays(md);
  }
  const ck = new Set(cut.map(([a, b]) => edgeKey(a, b)));
  md.edges.forEach(([a, b], i) => { if (ck.has(edgeKey(a, b))) { md.esel[i] = true; md.vsel[a] = true; md.vsel[b] = true; } });
  if (md.fsel.some(Boolean)) flushFromFaces(md); else flushFromEdges(md);
  return true;
}

// ================================================================== edge split / rip

/**
 * Split the mesh along `split` edges: every vertex on them gets one copy per group of faces that is
 * connected around the vertex without crossing a split edge. Returns vertex -> list of copies (index 0
 * is the original), and for each copy the faces that use it.
 */
export function splitEdges(md: MeshData, split: Set<string>, extraVerts?: Map<number, number[][]>): Map<number, { v: number; faces: number[] }[]> {
  ensureArrays(md);
  const loose = looseEdgeList(md);
  const verts = new Set<number>();
  for (const k of split) for (const v of k.split('_').map(Number)) verts.add(v);
  if (extraVerts) for (const v of extraVerts.keys()) verts.add(v);
  const vf: Map<number, number[]> = new Map();
  md.faces.forEach((f, i) => { for (const v of f) if (verts.has(v)) { const l = vf.get(v) ?? []; l.push(i); vf.set(v, l); } });
  const out = new Map<number, { v: number; faces: number[] }[]>();
  const remap = new Map<string, number>(); // `${face}:${v}` -> new vertex
  for (const v of verts) {
    const faces = vf.get(v) ?? [];
    let groups: number[][];
    const forced = extraVerts?.get(v);
    if (forced) groups = forced;
    else {
      const parent = new Map<number, number>(faces.map((f) => [f, f]));
      const find = (x: number): number => { while (parent.get(x) !== x) x = parent.get(x)!; return x; };
      for (const fa of faces) {
        const f = md.faces[fa];
        const i = f.indexOf(v);
        for (const u of [f[(i + 1) % f.length], f[(i - 1 + f.length) % f.length]]) {
          if (split.has(edgeKey(v, u))) continue;
          for (const fb of faces) if (fb !== fa && md.faces[fb].includes(u) && dirIn(md.faces[fb], v, u) !== 0) parent.set(find(fa), find(fb));
        }
      }
      const g = new Map<number, number[]>();
      for (const f of faces) { const r = find(f); const l = g.get(r) ?? []; l.push(f); g.set(r, l); }
      groups = [...g.values()];
    }
    const list: { v: number; faces: number[] }[] = [];
    groups.forEach((grp, gi) => {
      let nvIdx = v;
      if (gi > 0) {
        nvIdx = md.verts.length;
        md.verts.push([md.verts[v][0], md.verts[v][1], md.verts[v][2]]);
        md.vsel.push(md.vsel[v]);
        if (md.vcol) md.vcol.push([...md.vcol[v]] as Vec3);
      }
      for (const f of grp) remap.set(`${f}:${v}`, nvIdx);
      list.push({ v: nvIdx, faces: grp });
    });
    if (!list.length) list.push({ v, faces: [] });
    out.set(v, list);
  }
  md.faces = md.faces.map((f, fi) => f.map((v) => remap.get(`${fi}:${v}`) ?? v));
  rebuildWith(md, loose);
  return out;
}

/** Edge Split: disconnect faces along the selected edges. */
export function edgeSplitSelected(md: MeshData): number {
  const split = new Set<string>();
  md.edges.forEach(([a, b], i) => { if (md.esel[i]) split.add(edgeKey(a, b)); });
  if (!split.size) return 0;
  const before = md.verts.length;
  const sel = md.vsel.slice();
  splitEdges(md, split);
  for (let i = 0; i < before; i++) md.vsel[i] = sel[i];
  flushFromVerts(md);
  return md.verts.length - before;
}

export interface RipResult { ok: boolean; message?: string }

/**
 * Rip (V): tear the selection off the faces on the far side. `mouseSide(face)` returns a score (lower is
 * closer to the mouse); the copy attached to the closest faces stays selected. With `fill`, the gap is
 * bridged with new faces (Alt+V).
 */
export function ripSelected(md: MeshData, mouseSide: (face: number) => number, fill = false): RipResult {
  ensureArrays(md);
  const ef = edgeFaceMap(md);
  const ripEdges = new Set<string>();
  md.edges.forEach(([a, b], i) => { if (md.esel[i] && (ef.get(edgeKey(a, b))?.length ?? 0) === 2) ripEdges.add(edgeKey(a, b)); });
  const selVerts = md.vsel.map((s, i) => (s ? i : -1)).filter((i) => i >= 0);
  if (!ripEdges.size && selVerts.length !== 1) return { ok: false, message: 'Cannot rip: select edges between two faces, or a single vertex' };
  // forced fan splits for single vertices (vertex rip and the ends of a single-edge rip)
  const forced = new Map<number, number[][]>();
  const fanSplit = (v: number, through: number | null): number[][] | null => {
    const faces: number[] = [];
    md.faces.forEach((f, i) => { if (f.includes(v)) faces.push(i); });
    if (faces.length < 2) return null;
    // order the fan
    const next = new Map<number, number>();
    for (const fi of faces) {
      const f = md.faces[fi];
      const k = f.indexOf(v);
      next.set(f[(k + f.length - 1) % f.length], fi);
    }
    const order: number[] = [];
    let cur = faces[0];
    for (let s = 0; s < faces.length; s++) {
      order.push(cur);
      const f = md.faces[cur];
      const nxt = next.get(f[(f.indexOf(v) + 1) % f.length]);
      if (nxt === undefined || nxt === faces[0]) break;
      cur = nxt;
    }
    if (order.length !== faces.length) return null;
    const n = order.length;
    // contiguous half of the fan closest to the mouse
    const score = order.map(mouseSide);
    let best = 0, bestScore = Infinity;
    const half = Math.max(1, Math.floor(n / 2));
    for (let s = 0; s < n; s++) {
      if (through !== null) {
        // the half must start at the face after the rip edge
        const f = md.faces[order[s]];
        const prev = f[(f.indexOf(v) + f.length - 1) % f.length];
        if (prev !== through && f[(f.indexOf(v) + 1) % f.length] !== through) continue;
      }
      let sc = 0;
      for (let k = 0; k < half; k++) sc += score[(s + k) % n];
      if (sc < bestScore) { bestScore = sc; best = s; }
    }
    const a: number[] = [], b: number[] = [];
    for (let k = 0; k < n; k++) (k < half ? a : b).push(order[(best + k) % n]);
    return [b, a]; // group 0 keeps the vertex, group 1 (closest to the mouse) gets the copy
  };
  if (!ripEdges.size) {
    const g = fanSplit(selVerts[0], null);
    if (!g) return { ok: false, message: 'Cannot rip a vertex on the mesh boundary or with fewer than two faces' };
    forced.set(selVerts[0], g);
  } else {
    // a lone edge: rip its ends as vertices too
    const deg = new Map<number, number>();
    for (const k of ripEdges) for (const v of k.split('_').map(Number)) deg.set(v, (deg.get(v) ?? 0) + 1);
    if (ripEdges.size === 1) {
      const [a, b] = [...ripEdges][0].split('_').map(Number);
      for (const [v, o] of [[a, b], [b, a]]) {
        const g = fanSplit(v, o);
        if (g) forced.set(v, g);
      }
    }
  }
  // which side of each rip edge is closest to the mouse
  const near = new Set<number>();
  for (const k of ripEdges) {
    const fs = ef.get(k)!;
    near.add(mouseSide(fs[0]) <= mouseSide(fs[1]) ? fs[0] : fs[1]);
  }
  for (const g of forced.values()) for (const f of g[1]) near.add(f);
  const oldFaces = md.faces.map((f) => f.slice());
  const copies = splitEdges(md, ripEdges, forced);
  // select the copies on the mouse side
  md.vsel.fill(false); md.esel.fill(false); md.fsel.fill(false);
  const pair = new Map<number, number>(); // original vertex -> its mouse side copy
  for (const [v, list] of copies) {
    const chosen = list.find((c) => c.faces.some((f) => near.has(f))) ?? list[0];
    md.vsel[chosen.v] = true;
    pair.set(v, chosen.v);
  }
  if (fill) {
    const ef2 = edgeFaceMap(md);
    const addFill = (poly: number[]) => {
      const clean = poly.filter((x, i) => poly.indexOf(x) === i);
      if (clean.length < 3) return;
      addFaceTo(md, orientLoop(md, clean, ef2), -1, false);
    };
    for (const k of ripEdges) {
      const [a, b] = k.split('_').map(Number);
      const fKeep = md.faces.find((f) => dirIn(f, a, b) !== 0);
      const a2 = pair.get(a) ?? a, b2 = pair.get(b) ?? b;
      if (fKeep && dirIn(fKeep, a, b) > 0) addFill([b, a, a2, b2]); else addFill([a, b, b2, a2]);
    }
    for (const [v, g] of forced) {
      if (ripEdges.size) continue;
      // vertex rip: triangles across the two split edges
      const v2 = pair.get(v)!;
      const keepFaces = g[0];
      for (const fi of g[1]) {
        const f = oldFaces[fi];
        const k = f.indexOf(v);
        for (const u of [f[(k + 1) % f.length], f[(k + f.length - 1) % f.length]]) {
          if (keepFaces.some((kf) => oldFaces[kf].includes(u) && dirIn(oldFaces[kf], v, u) !== 0)) addFill([v, u, v2]);
        }
      }
    }
    rebuildEdges(md);
    ensureArrays(md);
  }
  flushFromVerts(md);
  return { ok: true };
}

// ================================================================== rotate edge

/** Rotate each selected edge between two faces one step (cw: clockwise seen from the face normal). */
export function rotateEdges(md: MeshData, cw: boolean, keys?: Set<string>): number {
  ensureArrays(md);
  const target = keys ?? new Set(md.edges.filter((_, i) => md.esel[i]).map(([a, b]) => edgeKey(a, b)));
  const touched = new Set<number>();
  const newSel: [number, number][] = [];
  let count = 0;
  for (const k of target) {
    const ef = edgeFaceMap(md);
    const fs = ef.get(k);
    if (!fs || fs.length !== 2 || touched.has(fs[0]) || touched.has(fs[1])) continue;
    const [a, b] = k.split('_').map(Number);
    let [f1, f2] = fs;
    if (dirIn(md.faces[f1], a, b) < 0) [f1, f2] = [f2, f1];
    const F1 = md.faces[f1], F2 = md.faces[f2];
    if (dirIn(F1, a, b) !== 1 || dirIn(F2, b, a) !== 1) continue;
    // merged polygon: b, (rest of F1 after b) ..., a, (rest of F2 after a) ...
    const rot = (f: number[], start: number) => { const i = f.indexOf(start); return [...f.slice(i), ...f.slice(0, i)]; };
    const r1 = rot(F1, b), r2 = rot(F2, a);
    const M = [...r1.slice(0, -1), ...r2.slice(0, -1)]; // r1 ends with a, r2 ends with b
    const n = M.length;
    const ia = r1.length - 1;
    const step = cw ? -1 : 1;
    const i = (0 + step + n) % n, j = (ia + step + n) % n;
    if (i === j || (i + 1) % n === j || (j + 1) % n === i) continue;
    const split = (from: number, to: number) => { const out: number[] = []; for (let x = from; ; x = (x + 1) % n) { out.push(M[x]); if (x === to) break; } return out; };
    const n1 = split(i, j), n2 = split(j, i);
    if (n1.length < 3 || n2.length < 3) continue;
    md.faces[f1] = n1;
    md.faces[f2] = n2;
    touched.add(f1); touched.add(f2);
    newSel.push([M[i], M[j]]);
    count++;
  }
  if (!count) return 0;
  rebuildWith(md, looseEdgeList(md));
  const sk = new Set(newSel.map(([a, b]) => edgeKey(a, b)));
  md.vsel.fill(false); md.fsel.fill(false);
  md.edges.forEach(([a, b], i) => { md.esel[i] = sk.has(edgeKey(a, b)); });
  flushFromEdges(md);
  return count;
}

// ================================================================== beautify / fill

function minAngle(a: Vec3, b: Vec3, c: Vec3): number {
  const ang = (p: Vec3, q: Vec3, r: Vec3) => { const u = normalize(sub(q, p)), v = normalize(sub(r, p)); return Math.acos(Math.max(-1, Math.min(1, dot(u, v)))); };
  return Math.min(ang(a, b, c), ang(b, c, a), ang(c, a, b));
}

/** Beautify: flip edges between selected triangles to maximise the smallest angle. */
export function beautifyFaces(md: MeshData, angleLimit = Math.PI): number {
  ensureArrays(md);
  let flips = 0;
  for (let iter = 0; iter < 100; iter++) {
    let changed = false;
    const ef = edgeFaceMap(md);
    const touched = new Set<number>();
    for (const [k, fs] of ef) {
      if (fs.length !== 2) continue;
      const [f1, f2] = fs;
      if (touched.has(f1) || touched.has(f2) || !md.fsel[f1] || !md.fsel[f2]) continue;
      const F1 = md.faces[f1], F2 = md.faces[f2];
      if (F1.length !== 3 || F2.length !== 3) continue;
      if (Math.acos(Math.max(-1, Math.min(1, dot(polyNormal(md.verts, F1), polyNormal(md.verts, F2))))) > angleLimit) continue;
      const [a, b] = k.split('_').map(Number);
      const c = F1.find((v) => v !== a && v !== b)!, d = F2.find((v) => v !== a && v !== b)!;
      const P = md.verts;
      const before = Math.min(minAngle(P[a], P[b], P[c]), minAngle(P[a], P[b], P[d]));
      const after = Math.min(minAngle(P[c], P[d], P[a]), minAngle(P[c], P[d], P[b]));
      if (after <= before + 1e-6) continue;
      // the quad must be convex for the flip to be valid
      const nq = normalize(add(polyNormal(P, F1), polyNormal(P, F2)));
      const side = (p: Vec3, q: Vec3, r: Vec3) => dot(cross(sub(q, p), sub(r, p)), nq);
      if (side(P[c], P[d], P[a]) * side(P[c], P[d], P[b]) >= 0) continue;
      if (rotateEdges(md, false, new Set([k])) || rotateEdges(md, true, new Set([k]))) {
        touched.add(f1); touched.add(f2);
        md.fsel[f1] = true; md.fsel[f2] = true;
        flips++;
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }
  if (flips) { md.vsel.fill(false); md.esel.fill(false); flushFromFaces(md); }
  return flips;
}

/** Fill (Alt+F): triangulate closed loops of selected edges. */
export function fillLoops(md: MeshData, beauty = true): number {
  ensureArrays(md);
  const selFaces = new Set<string>();
  md.faces.forEach((f, i) => { if (md.fsel[i]) for (let k = 0; k < f.length; k++) selFaces.add(edgeKey(f[k], f[(k + 1) % f.length])); });
  const edges = selectedEdgeList(md).filter(([a, b]) => !selFaces.has(edgeKey(a, b)));
  const ef = edgeFaceMap(md);
  let created = 0;
  md.fsel.fill(false);
  for (const ch of edgeChains(edges)) {
    if (!ch.closed || ch.verts.length < 3) continue;
    const loop = orientLoop(md, ch.verts, ef);
    for (const t of triangulatePoly(md.verts, loop)) { addFaceTo(md, [loop[t[0]], loop[t[1]], loop[t[2]]], -1, true); created++; }
  }
  if (!created) return 0;
  rebuildEdges(md);
  ensureArrays(md);
  if (beauty) beautifyFaces(md);
  md.vsel.fill(false); md.esel.fill(false);
  flushFromFaces(md);
  return created;
}

// ================================================================== bridge edge loops

export interface BridgeOptions { cuts?: number; twist?: number; smoothness?: number }

/** Bridge two (or more, in order) edge loops of the selection with quads (triangles when counts differ). */
export function bridgeEdgeLoops(md: MeshData, opt: BridgeOptions = {}): string | null {
  ensureArrays(md);
  // selected faces: bridge their region boundaries, removing the faces (like Blender)
  const selFaces = md.faces.map((_, i) => i).filter((i) => md.fsel[i]);
  if (selFaces.length) {
    const count = new Map<string, number>();
    for (const fi of selFaces) { const f = md.faces[fi]; for (let k = 0; k < f.length; k++) { const key = edgeKey(f[k], f[(k + 1) % f.length]); count.set(key, (count.get(key) ?? 0) + 1); } }
    const keep = md.faces.map((_, i) => !md.fsel[i]);
    const bnd = new Set([...count].filter(([, c]) => c === 1).map(([k]) => k));
    md.faces = md.faces.filter((_, i) => keep[i]);
    md.faceSmooth = md.faceSmooth.filter((_, i) => keep[i]);
    md.faceMat = md.faceMat.filter((_, i) => keep[i]);
    md.fsel = md.fsel.filter((_, i) => keep[i]);
    md.activeFace = -1;
    const loose = looseEdgeList(md);
    rebuildWith(md, loose.concat([...bnd].map((k) => k.split('_').map(Number) as [number, number])));
    md.edges.forEach(([a, b], i) => { md.esel[i] = bnd.has(edgeKey(a, b)); });
    // drop verts that were only used by the removed faces
    const used = new Uint8Array(md.verts.length);
    for (const f of md.faces) for (const v of f) used[v] = 1;
    for (const [a, b] of md.edges) { used[a] = 1; used[b] = 1; }
    if (md.verts.some((_, i) => !used[i])) removeVerts(md, md.verts.map((_, i) => !used[i]));
  }
  const chains = edgeChains(selectedEdgeList(md));
  if (chains.length < 2) return 'Select at least two edge loops';
  // order the loops by proximity (chain them greedily from the first)
  const centre = (c: { verts: number[] }) => scale(c.verts.reduce((s, v) => add(s, md.verts[v]), [0, 0, 0] as Vec3), 1 / c.verts.length);
  const order = [chains[0]];
  const rest = chains.slice(1);
  while (rest.length) {
    const last = centre(order[order.length - 1]);
    let bi = 0, bd = Infinity;
    rest.forEach((c, i) => { const d = length(sub(centre(c), last)); if (d < bd) { bd = d; bi = i; } });
    order.push(rest.splice(bi, 1)[0]);
  }
  const ef = edgeFaceMap(md);
  const cuts = Math.max(0, Math.round(opt.cuts ?? 0));
  const newFaces: number[][] = [];
  for (let li = 0; li + 1 < order.length; li++) {
    const A = order[li], B = order[li + 1];
    if (A.closed !== B.closed) return 'Cannot bridge an open edge loop with a closed one';
    let a = A.verts.slice(), b = B.verts.slice();
    // orient: loop A runs against its faces; B must run the other way round
    if (A.closed) {
      a = orientLoop(md, a, ef);
      // pick B's direction and rotation that best matches A
      const nb = b.length;
      let best = { d: Infinity, rev: false, off: 0 };
      for (const rev of [false, true]) {
        const bb = rev ? b.slice().reverse() : b;
        for (let off = 0; off < nb; off++) {
          let s = 0;
          for (let i = 0; i < a.length; i++) s += length(sub(md.verts[a[i]], md.verts[bb[(off + Math.round((i * nb) / a.length)) % nb]]));
          if (s < best.d) best = { d: s, rev, off };
        }
      }
      b = best.rev ? b.slice().reverse() : b;
      const off = (best.off + Math.round(opt.twist ?? 0)) % nb;
      b = [...b.slice((off + nb) % nb), ...b.slice(0, (off + nb) % nb)];
    } else {
      const d1 = length(sub(md.verts[a[0]], md.verts[b[0]])) + length(sub(md.verts[a[a.length - 1]], md.verts[b[b.length - 1]]));
      const d2 = length(sub(md.verts[a[0]], md.verts[b[b.length - 1]])) + length(sub(md.verts[a[a.length - 1]], md.verts[b[0]]));
      if (d2 < d1) b = b.reverse();
    }
    // intermediate rings
    const rings: number[][] = [a];
    if (a.length === b.length) {
      for (let c = 1; c <= cuts; c++) {
        const t = c / (cuts + 1);
        rings.push(a.map((va, i) => { md.verts.push(lerp3(md.verts[va], md.verts[b[i]], t)); md.vsel.push(true); return md.verts.length - 1; }));
      }
    }
    rings.push(b);
    for (let r = 0; r + 1 < rings.length; r++) {
      const p = rings[r], q = rings[r + 1];
      const np = p.length, nq = q.length;
      const segs = A.closed ? Math.max(np, nq) : Math.max(np, nq) - 1;
      if (np === nq) {
        for (let i = 0; i < segs; i++) {
          const i2 = (i + 1) % np;
          newFaces.push([p[i], p[i2], q[i2], q[i]]);
        }
      } else {
        // different counts: walk both loops, emitting triangles (and quads when both advance)
        let i = 0, j = 0;
        const endI = A.closed ? np : np - 1, endJ = A.closed ? nq : nq - 1;
        while (i < endI || j < endJ) {
          const ti = (i + 1) / Math.max(1, endI), tj = (j + 1) / Math.max(1, endJ);
          if (j >= endJ || (i < endI && ti <= tj)) { newFaces.push([p[i % np], p[(i + 1) % np], q[j % nq]]); i++; }
          else { newFaces.push([p[i % np], q[(j + 1) % nq], q[j % nq]]); j++; }
        }
      }
    }
  }
  // orientation: the first new face must run against loop A's existing faces
  const firstLoop = order[0].verts;
  let flip = false;
  if (newFaces.length) {
    const f = newFaces[0];
    for (let k = 0; k < f.length; k++) {
      const x = f[k], y = f[(k + 1) % f.length];
      if (!firstLoop.includes(x) || !firstLoop.includes(y)) continue;
      for (const fi of ef.get(edgeKey(x, y)) ?? []) if (dirIn(md.faces[fi], x, y) === 1) flip = true;
    }
    if (!(ef.get(edgeKey(firstLoop[0], firstLoop[1]))?.length)) {
      // free loops: outward from the bridge's centre
      const c = scale(newFaces.flat().reduce((s, v) => add(s, md.verts[v]), [0, 0, 0] as Vec3), 1 / newFaces.flat().length);
      const fc = polyCenter(md.verts, f);
      flip = dot(polyNormal(md.verts, f), sub(fc, c)) < 0;
    }
  }
  md.fsel.fill(false);
  for (const f of newFaces) addFaceTo(md, flip ? f.slice().reverse() : f, -1, true);
  rebuildEdges(md);
  ensureArrays(md);
  md.vsel.fill(false); md.esel.fill(false);
  flushFromFaces(md);
  return null;
}

// ================================================================== grid fill

/** Grid Fill: fill a closed loop of selected edges with a grid of quads. */
export function gridFill(md: MeshData, span: number, offset: number): string | null {
  ensureArrays(md);
  const chains = edgeChains(selectedEdgeList(md)).filter((c) => c.closed);
  if (!chains.length) return 'Select a closed edge loop';
  const ef = edgeFaceMap(md);
  md.fsel.fill(false);
  for (const ch of chains) {
    let loop = orientLoop(md, ch.verts, ef);
    const N = loop.length;
    if (N < 4 || N % 2) return 'Grid Fill needs a loop with an even number of edges';
    const half = N / 2;
    const w = Math.max(1, Math.min(half - 1, Math.round(span)));
    const h = half - w;
    const off = ((Math.round(offset) % N) + N) % N;
    loop = [...loop.slice(off), ...loop.slice(0, off)];
    // sides: bottom 0..w, right w..w+h, top w+h..2w+h, left 2w+h..N
    const at = (i: number) => loop[((i % N) + N) % N];
    const grid: number[][] = [];
    for (let j = 0; j <= h; j++) {
      grid.push([]);
      for (let i = 0; i <= w; i++) {
        if (j === 0) grid[j].push(at(i));
        else if (j === h) grid[j].push(at(2 * w + h - i));
        else if (i === 0) grid[j].push(at(N - j));
        else if (i === w) grid[j].push(at(w + j));
        else grid[j].push(-1);
      }
    }
    const P = (v: number) => md.verts[v];
    for (let j = 1; j < h; j++) {
      for (let i = 1; i < w; i++) {
        const u = i / w, v = j / h;
        // Coons patch
        const bottom = P(grid[0][i]), top = P(grid[h][i]), left = P(grid[j][0]), right = P(grid[j][w]);
        const c00 = P(grid[0][0]), c10 = P(grid[0][w]), c01 = P(grid[h][0]), c11 = P(grid[h][w]);
        const lc = add(scale(left, 1 - u), scale(right, u));
        const ld = add(scale(bottom, 1 - v), scale(top, v));
        const b = add(add(scale(c00, (1 - u) * (1 - v)), scale(c10, u * (1 - v))), add(scale(c01, (1 - u) * v), scale(c11, u * v)));
        md.verts.push(sub(add(lc, ld), b)); md.vsel.push(true);
        grid[j][i] = md.verts.length - 1;
      }
    }
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) addFaceTo(md, [grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]], -1, true);
  }
  rebuildEdges(md);
  ensureArrays(md);
  md.vsel.fill(false); md.esel.fill(false);
  flushFromFaces(md);
  return null;
}

// ================================================================== connect vertex path

/** Connect selected vertices (J): split faces between consecutive selected verts sharing a face. */
export function connectVertexPath(md: MeshData, order?: number[]): number {
  ensureArrays(md);
  let sel = order ?? md.vsel.map((s, i) => (s ? i : -1)).filter((i) => i >= 0);
  if (sel.length < 2) return 0;
  const shareFace = (a: number, b: number) => md.faces.some((f) => f.includes(a) && f.includes(b));
  if (!order) {
    // greedy path through verts that share faces, starting at an end (fewest partners)
    const partners = (v: number) => sel.filter((u) => u !== v && shareFace(u, v)).length;
    const remaining = new Set(sel);
    let cur = sel.slice().sort((x, y) => partners(x) - partners(y))[0];
    const path = [cur];
    remaining.delete(cur);
    while (remaining.size) {
      let best = -1, bd = Infinity;
      for (const u of remaining) {
        if (!shareFace(cur, u)) continue;
        const d = length(sub(md.verts[u], md.verts[cur]));
        if (d < bd) { bd = d; best = u; }
      }
      if (best < 0) break;
      path.push(best); remaining.delete(best); cur = best;
    }
    sel = path;
  }
  const pieces: KnifePiece[] = [];
  for (let i = 0; i + 1 < sel.length; i++) {
    const a = sel[i], b = sel[i + 1];
    md.faces.forEach((f, fi) => {
      if (!f.includes(a) || !f.includes(b) || dirIn(f, a, b) !== 0) return;
      pieces.push({ face: fi, a: { id: `v${a}`, kind: 'VERT', v: a, co: md.verts[a] }, b: { id: `v${b}`, kind: 'VERT', v: b, co: md.verts[b] } });
    });
  }
  const selV = md.vsel.slice();
  const res = knifeApply(md, pieces, false);
  md.vsel = selV.slice(0, md.verts.length);
  ensureArrays(md);
  md.esel.fill(false); md.fsel.fill(false);
  const nk = new Set(res.newEdges.map(([a, b]) => edgeKey(a, b)));
  md.edges.forEach(([a, b], i) => { if (nk.has(edgeKey(a, b))) md.esel[i] = true; });
  return res.newEdges.length;
}

// ================================================================== unsubdivide

/**
 * Un-Subdivide: remove every other edge loop of quad-grid regions (the inverse of Subdivide).
 * Returns an error message when the selected topology has no grid structure.
 */
export function unsubdivide(md: MeshData, iterations = 2, onlySelected = true): string | null {
  for (let it = 0; it < Math.max(1, iterations); it++) {
    const err = unsubdivideOnce(md, onlySelected);
    if (err) return it ? null : err;
  }
  return null;
}

function unsubdivideOnce(md: MeshData, onlySelected: boolean): string | null {
  ensureArrays(md);
  const faces = md.faces.map((_, i) => i).filter((i) => (!onlySelected || md.fsel[i]) && md.faces[i].length === 4);
  if (!faces.length) return 'Un-Subdivide needs selected quads';
  const inSet = new Set(faces);
  const vfaces = new Map<number, number[]>();
  for (const fi of faces) for (const v of md.faces[fi]) { const l = vfaces.get(v) ?? []; l.push(fi); vfaces.set(v, l); }
  // label: 0 = kept corner, 1 = edge midpoint, 2 = face centre
  const label = new Map<number, number>();
  const allVF = new Map<number, number>();
  md.faces.forEach((f) => { for (const v of f) allVF.set(v, (allVF.get(v) ?? 0) + 1); });
  // seed: a vertex that cannot be a centre: valence != 4 inside the region, or a region corner
  let seed = -1;
  for (const [v, fs] of vfaces) if (fs.length === 1) { seed = v; break; }
  if (seed < 0) for (const [v, fs] of vfaces) if (fs.length !== 4 && fs.length !== 2) { seed = v; break; }
  if (seed < 0) seed = vfaces.keys().next().value as number;
  const queue: number[] = [];
  const done = new Set<number>();
  label.set(seed, 0);
  for (const fi of vfaces.get(seed)!) queue.push(fi);
  let conflict = false;
  const setLabel = (v: number, l: number) => { const o = label.get(v); if (o === undefined) label.set(v, l); else if (o !== l) conflict = true; };
  while (queue.length) {
    const fi = queue.shift()!;
    if (done.has(fi)) continue;
    const f = md.faces[fi];
    const k = f.findIndex((v) => label.has(v));
    if (k < 0) { queue.push(fi); continue; }
    done.add(fi);
    const l0 = label.get(f[k])!;
    const opp = l0 === 0 ? 2 : l0 === 2 ? 0 : 1;
    // corners adjacent to f[k]: if f[k] is a corner/centre they are mids; if a mid, one of them is a corner, the other a centre
    setLabel(f[(k + 2) % 4], opp);
    if (l0 !== 1) { setLabel(f[(k + 1) % 4], 1); setLabel(f[(k + 3) % 4], 1); }
    else {
      const n1 = f[(k + 1) % 4], n3 = f[(k + 3) % 4];
      const l1 = label.get(n1), l3 = label.get(n3);
      if (l1 !== undefined) setLabel(n3, l1 === 0 ? 2 : 0);
      else if (l3 !== undefined) setLabel(n1, l3 === 0 ? 2 : 0);
      else { queue.push(fi); done.delete(fi); if (queue.every((q) => md.faces[q].every((v) => !label.has(v) || label.get(v) === 1))) { setLabel(n1, (allVF.get(n1) ?? 0) === 4 ? 2 : 0); setLabel(n3, label.get(n1) === 0 ? 2 : 0); } continue; }
    }
    for (const v of f) for (const g of vfaces.get(v) ?? []) if (!done.has(g) && inSet.has(g)) queue.push(g);
    if (conflict) break;
  }
  if (conflict) return 'Selection is not a regular quad grid';
  // every centre vertex with 4 region faces becomes one big quad
  const newFaces: { f: number[]; src: number }[] = [];
  const removeFace = new Set<number>();
  for (const [v, l] of label) {
    if (l !== 2) continue;
    const fs = vfaces.get(v) ?? [];
    if (fs.length !== 4) continue;
    // order the 4 faces around v and take each face's corner opposite to v
    const corners: number[] = [];
    const nextOf = new Map<number, number>();
    for (const fi of fs) { const f = md.faces[fi]; const k = f.indexOf(v); nextOf.set(f[(k + 3) % 4], fi); }
    let cur = fs[0];
    for (let s = 0; s < 4; s++) {
      const f = md.faces[cur];
      const k = f.indexOf(v);
      corners.push(f[(k + 2) % 4]);
      const nx = nextOf.get(f[(k + 1) % 4]);
      if (nx === undefined) break;
      cur = nx;
    }
    if (corners.length !== 4 || new Set(corners).size !== 4) continue;
    if (corners.some((c) => label.get(c) !== 0)) continue;
    for (const fi of fs) removeFace.add(fi);
    newFaces.push({ f: corners, src: fs[0] });
  }
  if (!newFaces.length) return 'Nothing to un-subdivide';
  const keep = md.faces.map((_, i) => !removeFace.has(i));
  const sel = md.fsel.slice();
  const nf: number[][] = [], ns: boolean[] = [], nm: number[] = [], nsel: boolean[] = [];
  md.faces.forEach((f, i) => { if (keep[i]) { nf.push(f); ns.push(!!md.faceSmooth[i]); nm.push(md.faceMat[i] ?? 0); nsel.push(!!sel[i]); } });
  for (const x of newFaces) { nf.push(x.f); ns.push(!!md.faceSmooth[x.src]); nm.push(md.faceMat[x.src] ?? 0); nsel.push(true); }
  md.faces = nf; md.faceSmooth = ns; md.faceMat = nm; md.fsel = nsel; md.activeFace = -1;
  rebuildWith(md, looseEdgeList(md));
  // remove orphaned mid/centre verts; mids on the region boundary stay as part of neighbouring faces
  const used = new Uint8Array(md.verts.length);
  for (const f of md.faces) for (const v of f) used[v] = 1;
  for (const [a, b] of md.edges) { used[a] = 1; used[b] = 1; }
  // dissolve boundary mids that now sit on a straight run between two kept corners of the new faces
  const rm = md.verts.map((_, i) => !used[i]);
  removeVerts(md, rm);
  md.vsel.fill(false); md.esel.fill(false);
  flushFromFaces(md);
  return null;
}

// ================================================================== symmetrize / snap to symmetry

export type SymDirection = 'NEGATIVE_X' | 'POSITIVE_X' | 'NEGATIVE_Y' | 'POSITIVE_Y' | 'NEGATIVE_Z' | 'POSITIVE_Z';

/** Symmetrize: replace the target half of the selection with a mirror copy of the source half. */
export function symmetrize(md: MeshData, direction: SymDirection, threshold = 0.0001): boolean {
  ensureArrays(md);
  const axis = direction.endsWith('X') ? 0 : direction.endsWith('Y') ? 1 : 2;
  // NEGATIVE_X: copy -X to +X (the source side is negative)
  const srcSign = direction.startsWith('NEGATIVE') ? -1 : 1;
  const side = (p: Vec3) => (Math.abs(p[axis]) <= threshold ? 0 : Math.sign(p[axis]) === srcSign ? 1 : -1);
  const sel = md.vsel.slice();
  // 1. remove selected geometry on the target side
  const rm = md.verts.map((p, v) => sel[v] && side(p) === -1);
  const keepIdx: number[] = [];
  rm.forEach((r, v) => { if (!r) keepIdx.push(v); });
  if (rm.some(Boolean)) removeVerts(md, rm);
  const sel2 = keepIdx.map((v) => sel[v]);
  // 2. snap centre verts onto the plane
  md.verts.forEach((p, v) => { if (sel2[v] && side(p) === 0) p[axis] = 0; });
  // 3. mirror the selected source geometry
  const nv = md.verts.length;
  const map = new Int32Array(nv).fill(-1);
  for (let v = 0; v < nv; v++) {
    if (!sel2[v]) continue;
    if (side(md.verts[v]) === 0) { map[v] = v; continue; }
    const p = md.verts[v].slice() as Vec3;
    p[axis] = -p[axis];
    map[v] = md.verts.length;
    md.verts.push(p); md.vsel.push(true);
    if (md.vcol) md.vcol.push([...md.vcol[v]] as Vec3);
  }
  const nfaces = md.faces.length;
  for (let fi = 0; fi < nfaces; fi++) {
    const f = md.faces[fi];
    if (!f.every((v) => map[v] >= 0)) continue;
    const g = f.map((v) => map[v]).reverse();
    if (g.every((v, k) => v === f[f.length - 1 - k])) continue; // lies in the plane
    addFaceTo(md, g, fi, !!md.fsel[fi]);
  }
  const extra: [number, number][] = [];
  for (const [a, b] of md.edges) if (map[a] >= 0 && map[b] >= 0 && (map[a] !== a || map[b] !== b)) extra.push([map[a], map[b]]);
  md.edges.push(...extra.map(([a, b]) => (a < b ? [a, b] : [b, a]) as [number, number]));
  md.esel = md.edges.map(() => false);
  rebuildEdges(md);
  ensureArrays(md);
  flushFromVerts(md);
  return true;
}

/** Snap to Symmetry: move selected verts so that mirrored pairs are exactly symmetric. */
export function snapToSymmetry(md: MeshData, direction: SymDirection, threshold = 0.05, factor = 0.5, useCenter = true): number {
  ensureArrays(md);
  const axis = direction.endsWith('X') ? 0 : direction.endsWith('Y') ? 1 : 2;
  const srcSign = direction.startsWith('NEGATIVE') ? -1 : 1;
  const cell = Math.max(threshold, 1e-6) * 2;
  const grid = new Map<string, number[]>();
  const key = (p: Vec3) => `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)},${Math.floor(p[2] / cell)}`;
  md.verts.forEach((p, v) => { const k = key(p); const l = grid.get(k); if (l) l.push(v); else grid.set(k, [v]); });
  const done = new Set<number>();
  let n = 0;
  for (let v = 0; v < md.verts.length; v++) {
    if (!md.vsel[v] || done.has(v)) continue;
    const p = md.verts[v];
    if (Math.abs(p[axis]) <= threshold) {
      if (useCenter) { p[axis] = 0; n++; }
      done.add(v);
      continue;
    }
    const m = p.slice() as Vec3; m[axis] = -m[axis];
    let best = -1, bd = threshold;
    const cx = Math.floor(m[0] / cell), cy = Math.floor(m[1] / cell), cz = Math.floor(m[2] / cell);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const u of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
        if (u === v || done.has(u)) continue;
        const d = length(sub(md.verts[u], m));
        if (d <= bd) { bd = d; best = u; }
      }
    }
    if (best < 0) continue;
    const q = md.verts[best];
    // blend between the source side (factor 0 keeps the source) and the average
    const src = Math.sign(p[axis]) === srcSign ? p : q;
    const dst = src === p ? q : p;
    const target: Vec3 = [src[0], src[1], src[2]];
    target[axis] = -target[axis];
    const avgSrc: Vec3 = lerp3(src, [dst[0], dst[1], dst[2]].map((x, k) => (k === axis ? -x : x)) as Vec3, factor);
    void target;
    const ns = avgSrc;
    const nd = ns.slice() as Vec3; nd[axis] = -nd[axis];
    src[0] = ns[0]; src[1] = ns[1]; src[2] = ns[2];
    dst[0] = nd[0]; dst[1] = nd[1]; dst[2] = nd[2];
    done.add(v); done.add(best);
    n += 2;
  }
  return n;
}

// ================================================================== slide rails

export interface SlideRails {
  /** Vertex index -> [target on side A, target on side B] (positions), or null for one side. */
  rails: Map<number, [Vec3 | null, Vec3 | null]>;
}

/** Rails for Edge Slide: for each vertex of the selected edges, the far ends of the adjacent edges on both sides. */
export function edgeSlideRails(md: MeshData): SlideRails | null {
  ensureArrays(md);
  const sel = selectedEdgeList(md);
  if (!sel.length) return null;
  const selKeys = new Set(sel.map(([a, b]) => edgeKey(a, b)));
  const ef = edgeFaceMap(md);
  const acc = new Map<number, [Vec3[], Vec3[]]>();
  const push = (v: number, side: 0 | 1, p: Vec3) => { if (!acc.has(v)) acc.set(v, [[], []]); acc.get(v)![side].push(p); };
  for (const ch of edgeChains(sel)) {
    const vs = ch.verts;
    const segs = ch.closed ? vs.length : vs.length - 1;
    for (let i = 0; i < segs; i++) {
      const a = vs[i], b = vs[(i + 1) % vs.length];
      for (const fi of ef.get(edgeKey(a, b)) ?? []) {
        const f = md.faces[fi];
        const side: 0 | 1 = dirIn(f, a, b) > 0 ? 0 : 1;
        // rail at a and b: the face edges leaving the selected edge
        for (const [v, o] of [[a, b], [b, a]]) {
          const k = f.indexOf(v);
          const nb = [f[(k + 1) % f.length], f[(k + f.length - 1) % f.length]].find((u) => u !== o && !selKeys.has(edgeKey(v, u)));
          if (nb !== undefined) push(v, side, md.verts[nb]);
        }
      }
    }
  }
  if (!acc.size) return null;
  const rails = new Map<number, [Vec3 | null, Vec3 | null]>();
  const avg = (l: Vec3[]) => (l.length ? scale(l.reduce((s, p) => add(s, p), [0, 0, 0] as Vec3), 1 / l.length) : null);
  for (const [v, [A, B]] of acc) rails.set(v, [avg(A), avg(B)]);
  return { rails };
}

/** Apply an edge slide: factor in -1..1 (positive towards side A). `even` keeps the slid loop parallel. */
export function applyEdgeSlide(md: MeshData, rails: SlideRails, start: Map<number, Vec3>, factor: number, even = false, flipped = false): void {
  let refLen = 0;
  if (even) {
    // the distance along the rail of the longest rail
    for (const [v, [A, B]] of rails.rails) { const T = factor >= 0 ? A : B; if (T) refLen = Math.max(refLen, length(sub(T, start.get(v)!))); }
  }
  for (const [v, [A, B]] of rails.rails) {
    const s = start.get(v)!;
    const T = factor >= 0 ? (flipped ? B : A) : (flipped ? A : B);
    if (!T) { md.verts[v] = [s[0], s[1], s[2]]; continue; }
    const f = Math.abs(factor);
    if (even && refLen > 0) {
      const dir = normalize(sub(T, s));
      const l = Math.min(length(sub(T, s)), f * refLen);
      md.verts[v] = add(s, scale(dir, l));
    } else md.verts[v] = lerp3(s, T, f);
  }
}

/** Neighbour verts of v (through edges). */
export function vertNeighbours(md: MeshData, v: number): number[] {
  const out: number[] = [];
  for (const [a, b] of md.edges) { if (a === v) out.push(b); else if (b === v) out.push(a); }
  return out;
}

void polyCenter;
