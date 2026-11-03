// Bevel (Ctrl+B / Shift+Ctrl+B and the Bevel modifier).
//
// Edge bevel: every selected manifold edge is replaced by a strip of `segments` faces whose cross
// section follows a superellipse "profile". Every vertex touching a bevelled edge (a "bevel vertex")
// is removed: each face around it gets new corner vertices (where the offset lines of bevelled edges
// meet, or slid along non-bevelled edges), and the hole left at the vertex is filled with a patch
// (a k-gon, or a grid of quads built ring by ring when every edge of the vertex is bevelled).
//
// Vertex bevel: every selected vertex is cut off; each face corner at the vertex is replaced by an
// arc between points slid along its two edges, and the hole is filled with the same kind of patch.
//
// The algorithm works on the ordered fan of faces around each vertex. Fans are built from the face
// winding, so meshes must be consistently wound around the vertices being bevelled; vertices with
// non-manifold fans are skipped.

import type { MeshData, Vec3 } from './types';
import {
  edgeKey, ensureArrays, flushFromFaces, flushFromVerts, polyNormal, polyCenter, rebuildEdges, removeVerts,
  add, sub, scale, dot, cross, normalize, length,
} from './mesh';

export type BevelOffsetType = 'OFFSET' | 'WIDTH' | 'DEPTH' | 'PERCENT';

export interface BevelOptions {
  offset: number;
  offsetType?: BevelOffsetType;
  segments?: number;
  /** 0.15..1, 0.5 is a circular profile, 0.25 a straight chamfer, 1 a square corner. */
  profile?: number;
  vertexOnly?: boolean;
  clampOverlap?: boolean;
  loopSlide?: boolean;
  /** Bevel these edges (edge keys) instead of the selected ones. */
  edges?: Set<string>;
  /** Bevel these verts (vertex-only mode) instead of the selected ones. */
  verts?: Set<number>;
  /** Select the new geometry (default true). */
  select?: boolean;
}

interface Fan {
  v: number;
  /** Other endpoint of each edge around v. */
  us: number[];
  /** faces[i] runs us[i] -> v -> us[i + 1]. */
  faces: number[];
  closed: boolean;
}

/** Ordered fan of faces around v, or null if the faces around v do not form a single fan. */
function buildFan(md: MeshData, v: number, vf: number[]): Fan | null {
  if (!vf.length) return null;
  const prevOf = new Map<number, number>(), nextOf = new Map<number, number>();
  const byPrev = new Map<number, number>();
  for (const fi of vf) {
    const f = md.faces[fi];
    const k = f.indexOf(v);
    if (k < 0 || f.indexOf(v, k + 1) >= 0) return null;
    const p = f[(k + f.length - 1) % f.length], n = f[(k + 1) % f.length];
    prevOf.set(fi, p); nextOf.set(fi, n);
    if (byPrev.has(p)) return null; // inconsistent winding or non-manifold
    byPrev.set(p, fi);
  }
  const nexts = new Set(vf.map((fi) => nextOf.get(fi)!));
  // open fan: start at a face whose previous edge is not shared with another face
  let start = vf[0];
  let closed = true;
  for (const fi of vf) if (!nexts.has(prevOf.get(fi)!)) { start = fi; closed = false; break; }
  const us: number[] = [prevOf.get(start)!];
  const faces: number[] = [];
  let cur: number | undefined = start;
  const seen = new Set<number>();
  while (cur !== undefined && !seen.has(cur)) {
    seen.add(cur);
    faces.push(cur);
    const nx: number = nextOf.get(cur)!;
    cur = byPrev.get(nx);
    if (cur === start) break;
    us.push(nx);
  }
  if (closed && cur !== start) return null;
  if (seen.size !== vf.length) return null; // several fans: non-manifold vertex
  if (closed && us.length !== faces.length) return null;
  return { v, us, faces, closed };
}

/** Superellipse exponent for Blender's profile value. */
export function profileExponent(profile: number): number {
  const p = Math.min(1, Math.max(0.05, profile));
  return Math.pow(2, 4 * p - 1);
}

/** Points of a profile arc from a to b around the corner k (segments + 1 points, endpoints included). */
export function arcPoints(a: Vec3, b: Vec3, k: Vec3, segments: number, r: number): Vec3[] {
  const out: Vec3[] = [];
  const ka = sub(a, k), kb = sub(b, k);
  for (let j = 0; j <= segments; j++) {
    const phi = (j / segments) * Math.PI / 2;
    const s = j === segments ? 1 : Math.pow(Math.sin(phi), 2 / r);
    const c = j === 0 ? 1 : Math.pow(Math.max(0, Math.cos(phi)), 2 / r);
    out.push(add(k, add(scale(ka, 1 - s), scale(kb, 1 - c))));
  }
  return out;
}

const sinBetween = (a: Vec3, b: Vec3) => length(cross(a, b));

/**
 * Bevel the selected edges (or verts with `vertexOnly`). Returns false when nothing could be bevelled.
 */
export function bevelMesh(md: MeshData, opt: BevelOptions): boolean {
  ensureArrays(md);
  const segs = Math.max(1, Math.round(opt.segments ?? 1));
  const r = profileExponent(opt.profile ?? 0.5);
  const offsetType = opt.offsetType ?? 'OFFSET';
  const select = opt.select !== false;
  const nv0 = md.verts.length;
  const vf: number[][] = md.verts.map(() => []);
  md.faces.forEach((f, i) => { for (const v of f) vf[v].push(i); });
  const ef = new Map<string, number[]>();
  md.faces.forEach((f, i) => {
    for (let k = 0; k < f.length; k++) {
      const key = edgeKey(f[k], f[(k + 1) % f.length]);
      const l = ef.get(key);
      if (l) l.push(i); else ef.set(key, [i]);
    }
  });
  const fnormal = md.faces.map((f) => polyNormal(md.verts, f));
  const P = (v: number) => md.verts[v];

  // ------------------------------------------------------------ choose elements, build fans
  const fans = new Map<number, Fan>();
  let bevEdges = new Set<string>();
  if (opt.vertexOnly) {
    const cand = opt.verts ?? new Set(md.verts.map((_, i) => i).filter((i) => md.vsel[i] && !md.vhide?.[i]));
    for (const v of cand) {
      const fan = buildFan(md, v, vf[v]);
      if (fan && fan.us.length >= 2) fans.set(v, fan);
    }
    if (!fans.size) return false;
  } else {
    if (opt.edges) bevEdges = new Set(opt.edges);
    else md.edges.forEach((e, i) => { if (md.esel[i]) bevEdges.add(edgeKey(e[0], e[1])); });
    for (const k of [...bevEdges]) if ((ef.get(k)?.length ?? 0) !== 2) bevEdges.delete(k);
    // drop edges touching vertices without a valid fan (repeat until stable)
    for (;;) {
      const bad: string[] = [];
      for (const k of bevEdges) {
        for (const v of k.split('_').map(Number)) {
          if (fans.has(v)) continue;
          const fan = buildFan(md, v, vf[v]);
          if (fan) fans.set(v, fan); else bad.push(k);
        }
      }
      if (!bad.length) break;
      for (const k of bad) bevEdges.delete(k);
    }
    for (const v of [...fans.keys()]) {
      const fan = fans.get(v)!;
      if (!fan.us.some((u) => bevEdges.has(edgeKey(v, u)))) fans.delete(v);
    }
    if (!bevEdges.size) return false;
  }

  // ------------------------------------------------------------ offsets per bevelled edge
  const edgeOffset = new Map<string, number>();
  const baseOff = Math.max(0, opt.offset);
  const otherEdgeAvg = (a: number, b: number): number => {
    let sum = 0, n = 0;
    for (const v of [a, b]) {
      const fan = fans.get(v);
      if (!fan) continue;
      for (const u of fan.us) if (u !== a && u !== b) { sum += length(sub(P(u), P(v))); n++; }
    }
    return n ? sum / n : length(sub(P(a), P(b)));
  };
  if (!opt.vertexOnly) {
    for (const k of bevEdges) {
      const [a, b] = k.split('_').map(Number);
      const [f1, f2] = ef.get(k)!;
      const cphi = Math.min(1, Math.max(-1, dot(fnormal[f1], fnormal[f2])));
      const phi = Math.acos(cphi); // angle between the face normals
      let d = baseOff;
      if (offsetType === 'WIDTH') d = baseOff / (2 * Math.max(0.05, Math.cos(phi / 2)));
      else if (offsetType === 'DEPTH') d = baseOff / Math.max(0.05, Math.sin(phi / 2));
      else if (offsetType === 'PERCENT') d = (baseOff / 100) * otherEdgeAvg(a, b);
      edgeOffset.set(k, d);
    }
  }

  // ------------------------------------------------------------ boundary points (as displacements from v)
  interface BV {
    fan: Fan;
    n: number;
    dirs: Vec3[];
    lens: number[];
    bev: boolean[];
    /** displacement of the point on edge i (non-bevelled edges / vertex mode), null otherwise */
    nbDisp: (Vec3 | null)[];
    /** displacement of the meeting point in face i (both edges bevelled), null otherwise */
    xDisp: (Vec3 | null)[];
    nb: number[];
    x: number[];
  }
  const bvs = new Map<number, BV>();
  for (const [v, fan] of fans) {
    const n = fan.us.length;
    const dirs = fan.us.map((u) => normalize(sub(P(u), P(v))));
    const lens = fan.us.map((u) => length(sub(P(u), P(v))));
    const bev = fan.us.map((u) => !opt.vertexOnly && bevEdges.has(edgeKey(v, u)));
    const nbDisp: (Vec3 | null)[] = new Array(n).fill(null);
    const xDisp: (Vec3 | null)[] = new Array(fan.faces.length).fill(null);
    const dOf = (i: number) => edgeOffset.get(edgeKey(v, fan.us[i])) ?? baseOff;
    const faceAt = (i: number): number => (i >= 0 && i < fan.faces.length ? fan.faces[i] : fan.closed ? fan.faces[(i + n) % n] : -1);
    const nextIdx = (i: number) => (i + 1) % n;
    if (opt.vertexOnly) {
      for (let i = 0; i < n; i++) {
        const t = offsetType === 'PERCENT' ? (baseOff / 100) * lens[i] : baseOff;
        nbDisp[i] = scale(dirs[i], t);
      }
    } else {
      // meeting points of two offset lines
      for (let i = 0; i < fan.faces.length; i++) {
        const j = nextIdx(i);
        if (!bev[i] || !bev[j]) continue;
        const a = dirs[i], b = dirs[j];
        const d1 = dOf(i), d2 = dOf(j);
        const s = sinBetween(a, b);
        if (s < 1e-3) {
          const fi = fan.faces[i];
          let perp = normalize(cross(fnormal[fi], a));
          if (dot(perp, sub(polyCenter(md.verts, md.faces[fi]), P(v))) < 0) perp = scale(perp, -1);
          xDisp[i] = scale(perp, (d1 + d2) / 2);
        } else xDisp[i] = add(scale(a, d2 / s), scale(b, d1 / s));
      }
      // slide points on non-bevelled edges
      const avgD = (() => { let s = 0, c = 0; for (let i = 0; i < n; i++) if (bev[i]) { s += dOf(i); c++; } return c ? s / c : baseOff; })();
      for (let i = 0; i < n; i++) {
        if (bev[i]) continue;
        const ts: number[] = [];
        const prev = (i - 1 + n) % n, next = nextIdx(i);
        if (faceAt(i - 1) >= 0 && bev[prev] && (fan.closed || i > 0)) {
          const s = sinBetween(dirs[prev], dirs[i]);
          ts.push(s > 0.05 ? dOf(prev) / s : dOf(prev));
        }
        if (faceAt(i) >= 0 && (fan.closed || i < n - 1) && bev[next]) {
          const s = sinBetween(dirs[i], dirs[next]);
          ts.push(s > 0.05 ? dOf(next) / s : dOf(next));
        }
        const t = ts.length ? ts.reduce((x, y) => x + y, 0) / ts.length : avgD;
        nbDisp[i] = scale(dirs[i], t);
      }
    }
    bvs.set(v, { fan, n, dirs, lens, bev, nbDisp, xDisp, nb: new Array(n).fill(-1), x: new Array(fan.faces.length).fill(-1) });
  }

  // ------------------------------------------------------------ clamp overlap
  let sc = 1;
  if (opt.clampOverlap !== false) {
    let sMax = Infinity;
    const limit = (len: number, use: number) => { if (use > 1e-12) sMax = Math.min(sMax, len / use); };
    const usage = new Map<string, number>();
    const addUse = (k: string, u: number) => usage.set(k, (usage.get(k) ?? 0) + u);
    for (const [v, b] of bvs) {
      for (let i = 0; i < b.n; i++) {
        const k = edgeKey(v, b.fan.us[i]);
        if (!b.bev[i]) addUse(k, length(b.nbDisp[i] ?? [0, 0, 0]));
        else {
          // how far the boundary points next to a bevelled edge reach along it
          let reach = 0;
          for (const fi of [i - 1, i]) {
            const ff = b.fan.closed ? (fi + b.n) % b.n : fi;
            if (ff < 0 || ff >= b.fan.faces.length) continue;
            const other = ff === i ? (i + 1) % b.n : ff;
            const disp = b.xDisp[ff] ?? b.nbDisp[other];
            if (disp) reach = Math.max(reach, dot(disp, b.dirs[i]));
          }
          addUse(k, Math.max(0, reach));
        }
      }
    }
    for (const [k, u] of usage) {
      const [a, b] = k.split('_').map(Number);
      limit(length(sub(P(a), P(b))), u);
    }
    if (sMax < 1) sc = Math.max(0, sMax * 0.999);
  }

  // ------------------------------------------------------------ create the boundary verts
  const newVert = (p: Vec3): number => { md.verts.push([p[0], p[1], p[2]]); md.vsel.push(false); return md.verts.length - 1; };
  for (const [v, b] of bvs) {
    for (let i = 0; i < b.n; i++) if (b.nbDisp[i]) b.nb[i] = newVert(add(P(v), scale(b.nbDisp[i]!, sc)));
    for (let i = 0; i < b.fan.faces.length; i++) if (b.xDisp[i]) b.x[i] = newVert(add(P(v), scale(b.xDisp[i]!, sc)));
  }

  /** Corner replacement of v in each fan face. */
  const repl = new Map<string, number[]>(); // `${v}:${face}`
  const newFaces: { f: number[]; src: number; sel: boolean }[] = [];
  const patchVerts = new Set<number>();

  // boundary point of bevelled edge i on the side of fan face fi (fi = i - 1 or i)
  const bp = (b: BV, i: number, fi: number): number => {
    const ff = b.fan.closed ? (fi + b.n) % b.n : fi;
    if (ff < 0 || ff >= b.fan.faces.length) return -1;
    if (b.x[ff] >= 0) return b.x[ff];
    const other = ff === i ? (i + 1) % b.n : ff;
    return b.nb[other];
  };

  if (opt.vertexOnly) {
    for (const [v, b] of bvs) {
      const arcs: number[][] = [];
      for (let i = 0; i < b.fan.faces.length; i++) {
        const j = (i + 1) % b.n;
        let arc: number[] = [b.nb[i], b.nb[j]];
        if (segs > 1) {
          const pts = arcPoints(P(b.nb[i]), P(b.nb[j]), P(v), segs, r);
          arc = [b.nb[i], ...pts.slice(1, -1).map((p) => newVert(p)), b.nb[j]];
        }
        arcs.push(arc);
        repl.set(`${v}:${b.fan.faces[i]}`, arc);
      }
      if (b.fan.closed && b.n >= 3) {
        const boundary: number[] = [];
        for (let i = b.n - 1; i >= 0; i--) boundary.push(...arcs[i].slice().reverse().slice(0, -1));
        const centers = arcs.map((a) => (segs > 1 ? sub(add(P(a[0]), P(a[a.length - 1])), P(v)) : null)).filter((c): c is Vec3 => !!c);
        fillPatch(md, boundary, b.n, segs, b.fan.faces[0], newFaces, newVert, patchVerts, centers, r);
      }
    }
  } else {
    // arcs per (bevel vertex, bevelled fan edge): from the f(i-1) side to the f(i) side
    const arcOf = new Map<string, number[]>(); // `${v}:${i}`
    const mitre = new Set<number>();
    for (const [v, b] of bvs) {
      const bevIdx: number[] = [];
      for (let i = 0; i < b.n; i++) if (b.bev[i]) bevIdx.push(i);
      // two bevelled edges whose ends meet at the same two points share one arc (mitre)
      if (bevIdx.length === 2) {
        const [i1, i2] = bevIdx;
        const a1 = bp(b, i1, i1 - 1), b1 = bp(b, i1, i1), a2 = bp(b, i2, i2 - 1), b2 = bp(b, i2, i2);
        if (a1 >= 0 && b1 >= 0 && a1 === b2 && b1 === a2 && a1 !== b1) {
          const pts = arcPoints(P(a1), P(b1), P(v), segs, r);
          const arc = [a1, ...pts.slice(1, -1).map((p) => newVert(p)), b1];
          arcOf.set(`${v}:${i1}`, arc);
          arcOf.set(`${v}:${i2}`, arc.slice().reverse());
          mitre.add(v);
          continue;
        }
      }
      for (const i of bevIdx) {
        const A = bp(b, i, i - 1), B = bp(b, i, i);
        if (A < 0 || B < 0) continue;
        if (segs === 1) { arcOf.set(`${v}:${i}`, [A, B]); continue; }
        const dir = b.dirs[i];
        const ta = dot(sub(P(A), P(v)), dir), tb = dot(sub(P(B), P(v)), dir);
        const K = add(P(v), scale(dir, (ta + tb) / 2));
        const pts = arcPoints(P(A), P(B), K, segs, r);
        arcOf.set(`${v}:${i}`, [A, ...pts.slice(1, -1).map((p) => newVert(p)), B]);
      }
    }
    // corner replacements
    for (const [v, b] of bvs) {
      const bevCount = b.bev.filter(Boolean).length;
      let mergeFace = -1;
      if (b.fan.closed && b.n === 3 && bevCount === 1 && segs > 1) {
        const i = b.bev.indexOf(true);
        mergeFace = (i + 1) % 3; // the face between the two non-bevelled edges
      }
      for (let fi = 0; fi < b.fan.faces.length; fi++) {
        const i = fi, j = (fi + 1) % b.n;
        let list: number[];
        if (b.bev[i] && b.bev[j]) list = [b.x[fi]];
        else if (b.bev[i]) list = [b.nb[j]];
        else if (b.bev[j]) list = [b.nb[i]];
        else if (fi === mergeFace) {
          const bi = b.bev.indexOf(true);
          list = (arcOf.get(`${v}:${bi}`) ?? [b.nb[i], b.nb[j]]).slice().reverse();
        } else list = [b.nb[i], b.nb[j]];
        repl.set(`${v}:${b.fan.faces[fi]}`, list);
      }
      // patch filling the hole at v
      if (!b.fan.closed || mergeFace >= 0 || mitre.has(v)) continue;
      const boundary: number[] = [];
      for (let i = b.n - 1; i >= 0; i--) {
        if (b.bev[i]) {
          const arc = arcOf.get(`${v}:${i}`);
          if (arc) boundary.push(...arc.slice().reverse());
        } else boundary.push(b.nb[i]);
      }
      const loop: number[] = [];
      for (const x of boundary) if (loop[loop.length - 1] !== x) loop.push(x);
      while (loop.length > 1 && loop[0] === loop[loop.length - 1]) loop.pop();
      if (loop.length < 3) continue;
      const allBev = bevCount === b.n && b.n >= 3;
      const centers: Vec3[] = [];
      if (segs > 1) {
        for (let i = 0; i < b.n; i++) {
          const arc = arcOf.get(`${v}:${i}`);
          if (!arc || !b.bev[i]) continue;
          const dir = b.dirs[i];
          const A = P(arc[0]), B = P(arc[arc.length - 1]);
          const ta = dot(sub(A, P(v)), dir), tb = dot(sub(B, P(v)), dir);
          const K = add(P(v), scale(dir, (ta + tb) / 2));
          centers.push(sub(add(A, B), K));
        }
      }
      if (allBev && loop.length === b.n * segs) fillPatch(md, loop, b.n, segs, b.fan.faces[0], newFaces, newVert, patchVerts, centers, r);
      else { newFaces.push({ f: loop, src: b.fan.faces[0], sel: true }); }
    }
    // strips along the bevelled edges
    for (const k of bevEdges) {
      const [a, bb] = k.split('_').map(Number);
      const A = bvs.get(a), B = bvs.get(bb);
      if (!A || !B) continue;
      const ia = A.fan.us.indexOf(bb), ib = B.fan.us.indexOf(a);
      const arcA = arcOf.get(`${a}:${ia}`), arcB = arcOf.get(`${bb}:${ib}`);
      if (!arcA || !arcB) continue;
      const Pa = arcA, Pb = arcB.slice().reverse();
      const fa = A.fan.faces[(ia - 1 + A.n) % A.n];
      for (let j = 0; j < segs; j++) newFaces.push({ f: [Pb[j], Pa[j], Pa[j + 1], Pb[j + 1]], src: fa, sel: true });
    }
  }

  // ------------------------------------------------------------ rebuild the face list
  const faces: number[][] = [], fsm: boolean[] = [], fmat: number[] = [], fsel: boolean[] = [];
  let active = -1;
  const push = (f: number[], src: number, sel: boolean) => {
    const clean: number[] = [];
    for (const x of f) if (clean[clean.length - 1] !== x) clean.push(x);
    while (clean.length > 1 && clean[0] === clean[clean.length - 1]) clean.pop();
    if (clean.length < 3 || new Set(clean).size !== clean.length) return;
    if (src === md.activeFace && active < 0 && !sel) active = faces.length;
    faces.push(clean); fsm.push(src >= 0 ? !!md.faceSmooth[src] : false); fmat.push(src >= 0 ? md.faceMat[src] ?? 0 : 0); fsel.push(sel);
  };
  md.faces.forEach((f, fi) => {
    const out: number[] = [];
    for (const v of f) {
      const rl = repl.get(`${v}:${fi}`);
      if (rl) out.push(...rl); else out.push(v);
    }
    push(out, fi, select ? false : !!md.fsel[fi]);
  });
  for (const nf of newFaces) push(nf.f, nf.src, select && nf.sel);
  md.faces = faces; md.faceSmooth = fsm; md.faceMat = fmat; md.fsel = fsel; md.activeFace = active;
  // loose edges are kept unless they used a removed vertex
  const faceEdgeKeys = new Set<string>();
  for (const f of faces) for (let k = 0; k < f.length; k++) faceEdgeKeys.add(edgeKey(f[k], f[(k + 1) % f.length]));
  md.edges = md.edges.filter(([a, b]) => !faceEdgeKeys.has(edgeKey(a, b)) && !bvs.has(a) && !bvs.has(b));
  md.esel = md.edges.map(() => false);
  rebuildEdges(md);
  ensureArrays(md);
  // remove the bevelled verts that are no longer used
  const used = new Uint8Array(md.verts.length);
  for (const f of md.faces) for (const v of f) used[v] = 1;
  for (const [a, b] of md.edges) { used[a] = 1; used[b] = 1; }
  const rm = md.verts.map((_, i) => i < nv0 && bvs.has(i) && !used[i]);
  if (select) {
    md.vsel.fill(false);
    md.esel.fill(false);
  }
  if (rm.some(Boolean)) removeVerts(md, rm);
  if (select) {
    if (md.fsel.some(Boolean)) flushFromFaces(md);
    else {
      // open vertex bevels create no faces: select the new verts
      for (let i = nv0 - rm.filter(Boolean).length; i < md.verts.length; i++) md.vsel[i] = true;
      flushFromVerts(md);
    }
  }
  void patchVerts;
  return true;
}

/**
 * Fill the hole at a bevel vertex. `boundary` runs around the hole in the winding of the new face(s);
 * when it consists of `k` sides of `m` segments each (corners at indices 0, m, 2m, ...) a grid of quads
 * is built ring by ring, otherwise a single polygon is used. Interior verts are relaxed and pushed onto
 * the sphere through the profile arcs (for round profiles).
 */
function fillPatch(
  md: MeshData, boundary: number[], k: number, m: number, src: number,
  out: { f: number[]; src: number; sel: boolean }[], newVert: (p: Vec3) => number, patchVerts: Set<number>,
  arcCenters: Vec3[], r: number,
): void {
  if (boundary.length !== k * m || m < 2 || k < 3) { out.push({ f: boundary.slice(), src, sel: true }); return; }
  const centroid: Vec3 = [0, 0, 0];
  for (const v of boundary) { centroid[0] += md.verts[v][0]; centroid[1] += md.verts[v][1]; centroid[2] += md.verts[v][2]; }
  const cen = scale(centroid, 1 / boundary.length);
  const interior: number[] = [];
  const nv = () => { const i = newVert(cen); interior.push(i); patchVerts.add(i); return i; };
  const faces: number[][] = [];
  const ring = (outer: number[], mm: number): void => {
    const L = outer.length;
    const at = (i: number) => outer[((i % L) + L) % L];
    if (mm === 1) { faces.push(outer.slice()); return; }
    if (mm === 2) {
      const c = nv();
      for (let i = 0; i < k; i++) faces.push([at(i * mm - 1), at(i * mm), at(i * mm + 1), c]);
      return;
    }
    const im = mm - 2;
    const inner: number[] = [];
    for (let i = 0; i < k * im; i++) inner.push(nv());
    const inAt = (i: number) => inner[((i % inner.length) + inner.length) % inner.length];
    for (let i = 0; i < k; i++) {
      faces.push([at(i * mm - 1), at(i * mm), at(i * mm + 1), inAt(i * im)]);
      for (let j = 0; j < mm - 2; j++) faces.push([at(i * mm + 1 + j), at(i * mm + 2 + j), inAt(i * im + j + 1), inAt(i * im + j)]);
    }
    ring(inner, im);
  };
  ring(boundary, m);
  // relax interior verts (boundary fixed)
  const nbr = new Map<number, Set<number>>();
  for (const f of faces) for (let i = 0; i < f.length; i++) {
    const a = f[i], b = f[(i + 1) % f.length];
    if (!nbr.has(a)) nbr.set(a, new Set());
    if (!nbr.has(b)) nbr.set(b, new Set());
    nbr.get(a)!.add(b); nbr.get(b)!.add(a);
  }
  for (let it = 0; it < 12 * m; it++) {
    const next = new Map<number, Vec3>();
    for (const v of interior) {
      const ns = nbr.get(v);
      if (!ns || !ns.size) continue;
      const s: Vec3 = [0, 0, 0];
      ns.forEach((u) => { s[0] += md.verts[u][0]; s[1] += md.verts[u][1]; s[2] += md.verts[u][2]; });
      next.set(v, scale(s, 1 / ns.size));
    }
    next.forEach((p, v) => { md.verts[v] = p; });
  }
  // project onto the sphere through the arcs (round profiles)
  const w = r <= 1 ? 0 : r >= 2 ? 1 : r - 1;
  if (w > 0 && arcCenters.length) {
    const c = scale(arcCenters.reduce((a, b) => add(a, b), [0, 0, 0] as Vec3), 1 / arcCenters.length);
    let rad = 0;
    for (const v of boundary) rad += length(sub(md.verts[v], c));
    rad /= boundary.length;
    if (rad > 1e-9) {
      for (const v of interior) {
        const d = sub(md.verts[v], c);
        const l = length(d);
        if (l < 1e-12) continue;
        const onSphere = add(c, scale(d, rad / l));
        md.verts[v] = add(scale(md.verts[v], 1 - w), scale(onSphere, w));
      }
    }
  }
  for (const f of faces) out.push({ f, src, sel: true });
}
