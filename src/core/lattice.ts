// Lattice objects: a U×V×W grid of control points (rest grid spans -0.5..0.5 on each axis) and the
// free-form deformation used by the Lattice modifier, with Linear / Cardinal / B-Spline interpolation.

import type { Doc, LatticeData, LatticeInterpolation, Vec3 } from './types';
import { newId, uniqueNameIn } from './scene';

export function latticeRestPoint(lt: { pointsU: number; pointsV: number; pointsW: number }, u: number, v: number, w: number): Vec3 {
  const f = (i: number, n: number) => (n > 1 ? i / (n - 1) - 0.5 : 0);
  return [f(u, lt.pointsU), f(v, lt.pointsV), f(w, lt.pointsW)];
}

export function latticeIndex(lt: LatticeData, u: number, v: number, w: number): number {
  return (w * lt.pointsV + v) * lt.pointsU + u;
}

export function createLattice(doc: Doc, name = 'Lattice'): LatticeData {
  doc.lattices ??= {};
  const lt: LatticeData = {
    id: newId(doc, 'LT'), name: uniqueNameIn(doc, 'lattices', name), pointsU: 2, pointsV: 2, pointsW: 2,
    interpolationU: 'KEY_BSPLINE', interpolationV: 'KEY_BSPLINE', interpolationW: 'KEY_BSPLINE', useOutside: false,
    points: [], select: [], vertexGroup: '', fakeUser: false,
  };
  regrid(lt, 2, 2, 2, false);
  doc.lattices[lt.id] = lt;
  return lt;
}

/** Interpolation weights of the 4 points around parameter `t` (index space) for an axis of `n` points. */
function axisWeights(t: number, n: number, type: LatticeInterpolation): { idx: number[]; w: number[] } {
  if (n <= 1) return { idx: [0], w: [1] };
  const i = Math.max(0, Math.min(n - 2, Math.floor(t)));
  const f = t - i;
  if (type === 'KEY_LINEAR') return { idx: [i, i + 1], w: [1 - f, f] };
  let w: number[];
  if (type === 'KEY_CARDINAL') {
    const f2 = f * f, f3 = f2 * f;
    w = [-0.5 * f3 + f2 - 0.5 * f, 1.5 * f3 - 2.5 * f2 + 1, -1.5 * f3 + 2 * f2 + 0.5 * f, 0.5 * f3 - 0.5 * f2];
  } else {
    const f2 = f * f, f3 = f2 * f, g = 1 - f;
    w = [g * g * g / 6, (3 * f3 - 6 * f2 + 4) / 6, (-3 * f3 + 3 * f2 + 3 * f + 1) / 6, f3 / 6];
  }
  const idx = [i - 1, i, i + 1, i + 2].map((k) => Math.max(0, Math.min(n - 1, k)));
  return { idx, w };
}

/**
 * Displacement of a point `p` (lattice object space) by the lattice: sum of weighted point offsets
 * from their rest positions. Points outside the lattice are not deformed unless "Outside" is on.
 */
export function latticeOffset(lt: LatticeData, p: Vec3): Vec3 {
  const out: Vec3 = [0, 0, 0];
  const n = [lt.pointsU, lt.pointsV, lt.pointsW];
  const t = [0, 1, 2].map((a) => (p[a] + 0.5) * (n[a] - 1));
  if (!lt.useOutside) {
    // fade out outside the unit box (Blender clamps the parameters)
    for (let a = 0; a < 3; a++) t[a] = Math.max(0, Math.min(n[a] - 1, t[a]));
  }
  const wu = axisWeights(t[0], n[0], lt.interpolationU);
  const wv = axisWeights(t[1], n[1], lt.interpolationV);
  const ww = axisWeights(t[2], n[2], lt.interpolationW);
  for (let c = 0; c < ww.idx.length; c++) {
    for (let b = 0; b < wv.idx.length; b++) {
      for (let a = 0; a < wu.idx.length; a++) {
        const wt = wu.w[a] * wv.w[b] * ww.w[c];
        if (Math.abs(wt) < 1e-9) continue;
        const i = latticeIndex(lt, wu.idx[a], wv.idx[b], ww.idx[c]);
        const P = lt.points[i];
        if (!P) continue;
        const R = latticeRestPoint(lt, wu.idx[a], wv.idx[b], ww.idx[c]);
        out[0] += wt * (P[0] - R[0]);
        out[1] += wt * (P[1] - R[1]);
        out[2] += wt * (P[2] - R[2]);
      }
    }
  }
  return out;
}

/** Change the resolution, keeping the current deformation (new points are sampled from it). */
export function regrid(lt: LatticeData, nu: number, nv: number, nw: number, keepShape = true): void {
  nu = Math.max(1, Math.min(64, Math.round(nu)));
  nv = Math.max(1, Math.min(64, Math.round(nv)));
  nw = Math.max(1, Math.min(64, Math.round(nw)));
  const old = keepShape && lt.points.length === lt.pointsU * lt.pointsV * lt.pointsW ? { ...lt, points: lt.points.map((p) => [...p] as Vec3) } : null;
  const pts: Vec3[] = [];
  const dims = { pointsU: nu, pointsV: nv, pointsW: nw };
  for (let w = 0; w < nw; w++) for (let v = 0; v < nv; v++) for (let u = 0; u < nu; u++) {
    const r = latticeRestPoint(dims, u, v, w);
    if (old) {
      const o = latticeOffset({ ...old, interpolationU: 'KEY_LINEAR', interpolationV: 'KEY_LINEAR', interpolationW: 'KEY_LINEAR' }, r);
      pts.push([r[0] + o[0], r[1] + o[1], r[2] + o[2]]);
    } else pts.push(r);
  }
  lt.pointsU = nu; lt.pointsV = nv; lt.pointsW = nw;
  lt.points = pts;
  lt.select = pts.map(() => false);
}

/** Edges of the lattice grid (pairs of point indices). */
export function latticeEdges(lt: LatticeData): [number, number][] {
  const out: [number, number][] = [];
  for (let w = 0; w < lt.pointsW; w++) for (let v = 0; v < lt.pointsV; v++) for (let u = 0; u < lt.pointsU; u++) {
    const i = latticeIndex(lt, u, v, w);
    if (u + 1 < lt.pointsU) out.push([i, latticeIndex(lt, u + 1, v, w)]);
    if (v + 1 < lt.pointsV) out.push([i, latticeIndex(lt, u, v + 1, w)]);
    if (w + 1 < lt.pointsW) out.push([i, latticeIndex(lt, u, v, w + 1)]);
  }
  return out;
}
