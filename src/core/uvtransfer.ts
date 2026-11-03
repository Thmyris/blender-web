// Keeps UV maps and seams consistent through edit-mode operators that change the mesh topology
// (extrude, loop cut, subdivide, inset, delete, merge, separate, ... including future ones).
// Registered as a layer of the generic topology hook in meshlayers.ts.
//
// After an operator, every face corner is rebuilt from the mesh as it was before:
//  - each new face picks a "home" face of the old mesh: the one sharing most of its (old) vertices,
//    ties broken by how close its new vertices / centre lie to the candidate;
//  - corners whose vertex existed before copy that vertex's UV in the home face (or in the best
//    old face around the vertex), so seams / islands are respected;
//  - new vertices are located on the old surface (preferring the home face) and interpolated
//    with mean value coordinates in that face's UV space.
// Seams follow their vertices, including edges split by new vertices lying on an old seam.

import type { BObject, MeshData, Vec3 } from './types';
import { registerMeshLayer, type TopologyMap } from './meshlayers';
import { edgeKey } from './mesh';
import { FaceGrid, faceUVValid, polygonWeights, pointPolyDistance, primitiveUVs, resetFaceUV, setInitialUVs, weightedUV, UV_PIN, UV_SELECT } from './uvdata';

interface CapturedLayer { name: string; uv: number[][]; flag?: number[][] }

interface Captured {
  positions: Vec3[];
  faces: number[][];
  layers: CapturedLayer[];
  seams: [number, number][];
}

const pending = new WeakMap<MeshData, { start: number; uvs: number[][] }>();

/** An operator appended faces from `start` on with known UVs (primitives added in edit mode). */
export function notePrimitiveUVs(md: MeshData, start: number, uvs: number[][]): void {
  pending.set(md, { start, uvs });
}

/**
 * Default UVs for a primitive added by Add > Mesh: a new mesh gets a "UVMap" layer; a primitive added
 * in edit mode (faces from `startFace` on) gets its UVs in the existing layers.
 */
export function applyPrimitiveUVs(md: MeshData, kind: string, geom: { verts: Vec3[]; faces: number[][] }, startFace: number): void {
  const uvs = primitiveUVs(kind, geom.verts, geom.faces);
  if (!uvs) return;
  if (startFace === 0 && !md.uvLayers?.length) { setInitialUVs(md, uvs); return; }
  if (!md.uvLayers?.length) return;
  for (const l of md.uvLayers) uvs.forEach((u, i) => { l.uv[startFace + i] = u.slice(); });
  notePrimitiveUVs(md, startFace, uvs);
}

const posKey = (v: Vec3) => `${v[0]},${v[1]},${v[2]}`;

function capture(md: MeshData): Captured {
  return {
    positions: md.verts.map((v) => [v[0], v[1], v[2]] as Vec3),
    faces: md.faces.map((f) => f.slice()),
    layers: (md.uvLayers ?? []).map((l) => ({
      name: l.name,
      uv: md.faces.map((f, i) => (faceUVValid(l, md, i) ? l.uv[i].slice() : resetFaceUV(f.length))),
      flag: l.flag ? md.faces.map((f, i) => { const r = l.flag![i] ?? []; return f.map((_, k) => r[k] ?? 0); }) : undefined,
    })),
    seams: md.seam ? md.edges.filter((_, i) => md.seam![i]).map((e) => [e[0], e[1]] as [number, number]) : [],
  };
}

function polyCentroid(verts: Vec3[], f: number[]): Vec3 {
  const c: Vec3 = [0, 0, 0];
  for (const v of f) { c[0] += verts[v][0]; c[1] += verts[v][1]; c[2] += verts[v][2]; }
  const n = Math.max(1, f.length);
  return [c[0] / n, c[1] / n, c[2] / n];
}

function faceSize(verts: Vec3[], f: number[]): number {
  let s = 0;
  for (let k = 0; k < f.length; k++) {
    const a = verts[f[k]], b = verts[f[(k + 1) % f.length]];
    s = Math.max(s, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
  }
  return s;
}

/** Rebuild the UV layers and seams of `md` from the captured (old) mesh. */
function transfer(md: MeshData, cap: Captured, vertOld: Int32Array): void {
  const oldV = cap.positions, oldF = cap.faces;
  const byPos = new Map<string, number[]>();
  oldV.forEach((p, i) => { const k = posKey(p); const l = byPos.get(k); if (l) l.push(i); else byPos.set(k, [i]); });
  const nv = md.verts.length;
  const cands: number[][] = new Array(nv);
  for (let v = 0; v < nv; v++) {
    const o = vertOld[v] ?? -1;
    cands[v] = o >= 0 && o < oldV.length ? [o] : byPos.get(posKey(md.verts[v])) ?? [];
  }
  const oldVertFaces: number[][] = oldV.map(() => []);
  oldF.forEach((f, fi) => { for (const v of f) oldVertFaces[v]?.push(fi); });
  const oldFaceVerts = oldF.map((f) => new Set(f));
  let grid: FaceGrid | null = null;
  const nearestOld = (p: Vec3) => { grid ??= new FaceGrid(oldV, oldF); return grid.nearest(p); };
  const prim = pending.get(md);
  pending.delete(md);

  const L = cap.layers;
  const outUV: number[][][] = L.map(() => []);
  const outFlag: (number[][] | null)[] = L.map((l) => (l.flag ? [] : null));

  md.faces.forEach((g, fi) => {
    const n = g.length;
    if (prim && fi >= prim.start && prim.uvs[fi - prim.start]?.length === n * 2) {
      L.forEach((_, li) => { outUV[li].push(prim.uvs[fi - prim.start].slice()); outFlag[li]?.push(new Array(n).fill(0)); });
      return;
    }
    if (!oldF.length) {
      L.forEach((_, li) => { outUV[li].push(resetFaceUV(n)); outFlag[li]?.push(new Array(n).fill(0)); });
      return;
    }
    const cs = g.map((v) => cands[v] ?? []);
    const centre = polyCentroid(md.verts, g);
    // home face
    const score = new Map<number, number>();
    cs.forEach((c) => {
      const seen = new Set<number>();
      for (const o of c) for (const of of oldVertFaces[o] ?? []) if (!seen.has(of)) { seen.add(of); score.set(of, (score.get(of) ?? 0) + 1); }
    });
    let home = -1;
    if (score.size) {
      let bestS = -1;
      for (const s of score.values()) bestS = Math.max(bestS, s);
      const tied = [...score.entries()].filter(([, s]) => s === bestS).map(([f]) => f);
      if (tied.length === 1) home = tied[0];
      else {
        let bd = Infinity;
        for (const of of tied) {
          let d = pointPolyDistance(centre, oldV, oldF[of]);
          g.forEach((v, k) => { if (!cs[k].length) d += pointPolyDistance(md.verts[v], oldV, oldF[of]); });
          if (d < bd - 1e-12) { bd = d; home = of; }
        }
      }
    } else {
      home = nearestOld(centre)?.face ?? 0;
    }
    const homeSize = faceSize(oldV, oldF[home]);
    const faceUV: number[][] = L.map(() => []);
    const faceFl: number[][] = L.map(() => []);
    g.forEach((v, k) => {
      const c = cs[k];
      let srcFace = -1, srcCorner = -1;
      const inHome = c.find((o) => oldFaceVerts[home].has(o));
      if (inHome !== undefined) { srcFace = home; srcCorner = oldF[home].indexOf(inHome); }
      else if (c.length) {
        // best old face around the vertex: most vertices shared with the new face, then closest to home
        let best = -1, bs = -1, bd = Infinity;
        const hc = polyCentroid(oldV, oldF[home]);
        for (const o of c) for (const of of oldVertFaces[o] ?? []) {
          let s = 0;
          for (const w of g) if ((cands[w] ?? []).some((x) => oldFaceVerts[of].has(x))) s++;
          const d = pointPolyDistance(hc, oldV, oldF[of]);
          if (s > bs || (s === bs && d < bd)) { bs = s; bd = d; best = of; }
        }
        if (best >= 0) { srcFace = best; srcCorner = oldF[best].findIndex((x) => c.includes(x)); }
      }
      if (srcFace >= 0 && srcCorner >= 0) {
        L.forEach((l, li) => {
          faceUV[li].push(l.uv[srcFace][srcCorner * 2], l.uv[srcFace][srcCorner * 2 + 1]);
          faceFl[li].push(l.flag?.[srcFace]?.[srcCorner] ?? 0);
        });
        return;
      }
      // a new vertex: interpolate in the old face it lies on
      const p = md.verts[v];
      let face = home;
      const dHome = pointPolyDistance(p, oldV, oldF[home]);
      if (dHome > homeSize * 1e-4 + 1e-9) {
        const hit = nearestOld(p);
        if (hit && hit.dist * 1.5 + homeSize * 1e-4 < dHome) face = hit.face;
      }
      const w = polygonWeights(p, oldV, oldF[face]);
      let main = 0;
      for (let i = 1; i < w.length; i++) if (w[i] > w[main]) main = i;
      L.forEach((l, li) => {
        const [u, vv] = weightedUV(l.uv[face], w);
        faceUV[li].push(u, vv);
        faceFl[li].push((l.flag?.[face]?.[main] ?? 0) & UV_SELECT & ~UV_PIN);
      });
    });
    L.forEach((_, li) => { outUV[li].push(faceUV[li]); outFlag[li]?.push(faceFl[li]); });
  });

  if (L.length) {
    md.uvLayers = L.map((l, li) => ({ name: l.name, uv: outUV[li], ...(outFlag[li] ? { flag: outFlag[li]! } : {}) }));
    md.uvActive = Math.min(L.length - 1, md.uvActive ?? 0);
    md.uvActiveRender = Math.min(L.length - 1, md.uvActiveRender ?? 0);
  }

  // seams
  if (!cap.seams.length) { delete md.seam; return; }
  const oldSeam = new Set(cap.seams.map(([a, b]) => edgeKey(a, b)));
  // new vertices lying on an old seam edge
  const onSeam = new Map<number, number[]>();
  const segDist = (p: Vec3, a: Vec3, b: Vec3) => {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
    const l2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
    const t = l2 > 0 ? Math.max(0, Math.min(1, (ab[0] * ap[0] + ab[1] * ap[1] + ab[2] * ap[2]) / l2)) : 0;
    return { d: Math.hypot(ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t), len: Math.sqrt(l2) };
  };
  const seamOf = (v: number): number[] => {
    let r = onSeam.get(v);
    if (r) return r;
    r = [];
    if (!cands[v].length) {
      const p = md.verts[v];
      cap.seams.forEach(([a, b], si) => { const { d, len } = segDist(p, oldV[a], oldV[b]); if (d <= len * 1e-5 + 1e-9) r!.push(si); });
    }
    onSeam.set(v, r);
    return r;
  };
  const endsOf = (v: number, si: number) => { const [a, b] = cap.seams[si]; return cands[v].includes(a) || cands[v].includes(b); };
  const seam = md.edges.map(([a, b]) => {
    const ca = cands[a] ?? [], cb = cands[b] ?? [];
    if (ca.length && cb.length) {
      for (const x of ca) for (const y of cb) if (oldSeam.has(edgeKey(x, y))) return true;
      return false;
    }
    const sa = ca.length ? null : seamOf(a), sb = cb.length ? null : seamOf(b);
    if (sa && sb) return sa.some((s) => sb.includes(s));
    if (sa) return sa.some((s) => endsOf(b, s));
    if (sb) return sb.some((s) => endsOf(a, s));
    return false;
  });
  if (seam.some(Boolean)) md.seam = seam; else delete md.seam;
}

registerMeshLayer({
  name: 'uv',
  has: (md: MeshData) => !!md.uvLayers?.length || !!md.seam?.some(Boolean),
  capture: (md: MeshData) => capture(md),
  remap: (md: MeshData, _ob: BObject | null, captured: unknown, map: TopologyMap) => transfer(md, captured as Captured, map.vertOld),
  remapSplit: (md: MeshData, _ob: BObject, captured: unknown, map: TopologyMap) => transfer(md, captured as Captured, map.vertOld),
});

/** For tests: run the transfer directly (old mesh captured before an edit, applied after it). */
export function captureUVs(md: MeshData): unknown { return capture(md); }
export function transferUVs(md: MeshData, captured: unknown, vertOld: Int32Array): void { transfer(md, captured as Captured, vertOld); }
