// Curve evaluation: Bezier handles, NURBS basis functions, spline sampling, moving frames
// (twist), bevel / extrude profiles, filled 2D shapes and the conversion of a curve to a mesh.
// Also the arc-length "path" used by Follow Path, the Curve modifier and Text on Curve.

import type { Vec3 } from './types';
import type { BezierPoint, CurveData, HandleType, Spline, SplinePoint } from './curvetypes';
import type { EvalMesh } from './modifiers';
import { nestRings, triangulate, type P2 } from './triangulate';

// ------------------------------------------------------------------ vector helpers

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: Vec3): Vec3 => { const l = len(a); return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; };
const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
/** Rotate v around the unit axis k by angle a (Rodrigues). */
function rotate(v: Vec3, k: Vec3, a: number): Vec3 {
  const c = Math.cos(a), s = Math.sin(a);
  const kv = cross(k, v), kd = dot(k, v) * (1 - c);
  return [v[0] * c + kv[0] * s + k[0] * kd, v[1] * c + kv[1] * s + k[1] * kd, v[2] * c + kv[2] * s + k[2] * kd];
}

export const curveVec = { sub, add, mul, dot, cross, len, norm, lerp, rotate };

// ------------------------------------------------------------------ data constructors

export function newBezierPoint(co: Vec3, hl: Vec3, hr: Vec3, type: HandleType = 'AUTO', select = false): BezierPoint {
  return {
    co: [...co] as Vec3, handleLeft: [...hl] as Vec3, handleRight: [...hr] as Vec3, handleLeftType: type, handleRightType: type,
    tilt: 0, radius: 1, weightSoftbody: 0.01, select, selectLeft: select, selectRight: select,
  };
}

export function newSplinePoint(co: Vec3, w = 1, select = false): SplinePoint {
  return { co: [...co] as Vec3, w, tilt: 0, radius: 1, weightSoftbody: 0.01, select };
}

export function newSpline(type: Spline['type'], resolution = 12): Spline {
  return {
    type, bezierPoints: [], points: [], pointCountU: 0, pointCountV: 1, orderU: 4, orderV: 4, resolutionU: resolution, resolutionV: resolution,
    useCyclicU: false, useCyclicV: false, useEndpointU: false, useEndpointV: false, useBezierU: false, useBezierV: false,
    useSmooth: true, materialIndex: 0,
  };
}

export function newCurveData(id: string, name: string): CurveData {
  return {
    id, name, splines: [], dimensions: '3D', resolutionU: 12, renderResolutionU: 0, resolutionV: 12, renderResolutionV: 0,
    fillMode: 'FULL', twistMode: 'MINIMUM', twistSmooth: 0, useFillDeform: true, offset: 0, extrude: 0, bevelDepth: 0,
    bevelResolution: 0, bevelObject: null, taperObject: null, useFillCaps: false, useMapTaper: false, usePath: true,
    pathDuration: 100, evalTime: 0, usePathFollow: false, useStretch: false, useDeformBounds: false, useRadius: true,
    showHandles: true, showNormalFace: true, materials: [], activeSpline: 0, activePoint: -1, fakeUser: false,
  };
}

/** Number of control points of a spline (Bezier points or NURBS/poly points). */
export function splinePointCount(sp: Spline): number { return sp.type === 'BEZIER' ? sp.bezierPoints.length : sp.points.length; }

/** Keep pointCountU/V consistent for curves (one row of points). */
export function fixCounts(sp: Spline, isSurface: boolean): void {
  if (sp.type === 'BEZIER') { sp.pointCountU = sp.bezierPoints.length; sp.pointCountV = 1; return; }
  if (!isSurface || sp.pointCountV <= 1) { sp.pointCountU = sp.points.length; sp.pointCountV = 1; }
}

// ------------------------------------------------------------------ Bezier handles

/** Blender's factor for auto handles: makes 4 auto points on a circle a near-perfect circle. */
const AUTO_HANDLE_FAC = 2.5614;

/**
 * Recalculate Auto / Vector / Aligned handles of a Bezier spline. `lead` tells, per point, which
 * handle was edited last ('L' or 'R'), so the other one of an Aligned pair follows it.
 */
export function calcHandles(sp: Spline, lead?: Map<number, 'L' | 'R'>): void {
  if (sp.type !== 'BEZIER') return;
  const pts = sp.bezierPoints;
  const n = pts.length;
  const cyclic = sp.useCyclicU && n > 1;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    let prev: Vec3 | null = i > 0 ? pts[i - 1].co : cyclic ? pts[n - 1].co : null;
    let next: Vec3 | null = i < n - 1 ? pts[i + 1].co : cyclic ? pts[0].co : null;
    if (!prev && !next) {
      if (p.handleLeftType === 'AUTO' || p.handleLeftType === 'VECTOR') p.handleLeft = add(p.co, [-1, 0, 0]);
      if (p.handleRightType === 'AUTO' || p.handleRightType === 'VECTOR') p.handleRight = add(p.co, [1, 0, 0]);
      continue;
    }
    // mirror a missing neighbour (ends of open splines)
    if (!prev) prev = sub(mul(p.co, 2), next!);
    if (!next) next = sub(mul(p.co, 2), prev);
    const da = sub(p.co, prev), db = sub(next, p.co);
    let la = len(da), lb = len(db);
    if (la < 1e-9) la = 1;
    if (lb < 1e-9) lb = 1;
    if (p.handleLeftType === 'AUTO' || p.handleRightType === 'AUTO') {
      const t = add(mul(da, 1 / la), mul(db, 1 / lb));
      const tl = len(t) * AUTO_HANDLE_FAC;
      if (tl > 1e-9) {
        if (p.handleLeftType === 'AUTO') p.handleLeft = sub(p.co, mul(t, la / tl));
        if (p.handleRightType === 'AUTO') p.handleRight = add(p.co, mul(t, lb / tl));
      }
    }
    if (p.handleLeftType === 'VECTOR') p.handleLeft = add(p.co, mul(sub(prev, p.co), 1 / 3));
    if (p.handleRightType === 'VECTOR') p.handleRight = add(p.co, mul(sub(next, p.co), 1 / 3));
    // aligned handles: point opposite to the other handle, keeping their own length
    const L = p.handleLeftType === 'ALIGNED', R = p.handleRightType === 'ALIGNED';
    if (L || R) {
      let follow: 'L' | 'R';
      if (L && R) follow = lead?.get(i) === 'L' ? 'R' : lead?.get(i) === 'R' ? 'L' : (p.selectLeft && !p.selectRight ? 'R' : 'L');
      else follow = L ? 'L' : 'R';
      if (follow === 'L') {
        const dir = norm(sub(p.co, p.handleRight));
        const l = len(sub(p.handleLeft, p.co));
        if (len(dir) > 0) p.handleLeft = add(p.co, mul(dir, l));
      } else {
        const dir = norm(sub(p.co, p.handleLeft));
        const l = len(sub(p.handleRight, p.co));
        if (len(dir) > 0) p.handleRight = add(p.co, mul(dir, l));
      }
    }
  }
}

function bezierAt(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, t: number): Vec3 {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1], a * p0[2] + b * p1[2] + c * p2[2] + d * p3[2]];
}

// ------------------------------------------------------------------ NURBS

/** Knot vector for `n` control points and order `k` (cyclic splines wrap k - 1 extra points). */
export function makeKnots(n: number, k: number, cyclic: boolean, endpoint: boolean, bezier: boolean): number[] {
  const count = n + k + (cyclic ? k - 1 : 0);
  const knots: number[] = [];
  if (cyclic) { for (let i = 0; i < count; i++) knots.push(i); return knots; }
  if (bezier) {
    // clamped ends, interior knots repeated (order - 1) times: Bezier-like segments
    const interior = count - 2 * k;
    for (let i = 0; i < k; i++) knots.push(0);
    for (let i = 0; i < interior; i++) knots.push(1 + Math.floor(i / Math.max(1, k - 1)));
    const last = (interior > 0 ? knots[knots.length - 1] : 0) + 1;
    for (let i = 0; i < k; i++) knots.push(last);
    return knots;
  }
  if (endpoint) {
    for (let i = 0; i < count; i++) knots.push(i < k ? 0 : i >= n ? n - k + 1 : i - k + 1);
    return knots;
  }
  for (let i = 0; i < count; i++) knots.push(i);
  return knots;
}

/** Non-zero B-spline basis functions at t: returns [first index, values (length k)]. */
function basis(knots: number[], k: number, nCtrl: number, t: number): [number, number[]] {
  // span index s with knots[s] <= t < knots[s+1], clamped to the valid range
  let s = k - 1;
  const hi = nCtrl;
  while (s < hi - 1 && t >= knots[s + 1]) s++;
  const N = new Array(k).fill(0);
  N[0] = 1;
  const left = new Array(k).fill(0), right = new Array(k).fill(0);
  for (let j = 1; j < k; j++) {
    left[j] = t - knots[s + 1 - j];
    right[j] = knots[s + j] - t;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const den = right[r + 1] + left[j - r];
      const tmp = den !== 0 ? N[r] / den : 0;
      N[r] = saved + right[r + 1] * tmp;
      saved = left[j - r] * tmp;
    }
    N[j] = saved;
  }
  return [s - k + 1, N];
}

interface NurbsInfo { knots: number[]; k: number; n: number; idx: (i: number) => number; t0: number; t1: number; cyclic: boolean }

function nurbsInfo(count: number, order: number, cyclic: boolean, endpoint: boolean, bezier: boolean): NurbsInfo | null {
  if (count < 2) return null;
  const k = Math.max(2, Math.min(order, count));
  const n = cyclic ? count + k - 1 : count;
  const knots = makeKnots(count, k, cyclic, endpoint, bezier);
  return { knots, k, n, idx: (i) => i % count, t0: knots[k - 1], t1: knots[n], cyclic };
}

/** Evaluate rational basis weights at t: list of [control index, weight]. */
function nurbsWeights(info: NurbsInfo, t: number, w: (i: number) => number): [number, number][] {
  const [first, N] = basis(info.knots, info.k, info.n, t);
  let sum = 0;
  const out: [number, number][] = [];
  for (let r = 0; r < info.k; r++) {
    const ci = info.idx(first + r);
    const v = N[r] * w(ci);
    sum += v;
    out.push([ci, v]);
  }
  if (sum > 1e-12) for (const o of out) o[1] /= sum;
  return out;
}

// ------------------------------------------------------------------ spline sampling

export interface CurveSample { co: Vec3; tilt: number; radius: number }
export interface SampledSpline { pts: CurveSample[]; cyclic: boolean; spline: Spline }

/** Resolution used for a spline (render resolution overrides when set). */
export function splineResolution(cu: CurveData, sp: Spline, render: boolean): number {
  const r = render && cu.renderResolutionU > 0 ? cu.renderResolutionU : sp.resolutionU;
  return Math.max(1, Math.min(1024, Math.round(r)));
}

/** Sample a curve spline (Bezier / NURBS / poly) into points. */
export function sampleSpline(sp: Spline, res: number): SampledSpline {
  const out: CurveSample[] = [];
  if (sp.type === 'BEZIER') {
    const b = sp.bezierPoints;
    const n = b.length;
    const cyclic = sp.useCyclicU && n > 1;
    if (n === 1) out.push({ co: [...b[0].co] as Vec3, tilt: b[0].tilt, radius: b[0].radius });
    const segs = cyclic ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const p = b[i], q = b[(i + 1) % n];
      for (let s = 0; s < res; s++) {
        const t = s / res;
        out.push({ co: bezierAt(p.co, p.handleRight, q.handleLeft, q.co, t), tilt: p.tilt + (q.tilt - p.tilt) * t, radius: p.radius + (q.radius - p.radius) * t });
      }
    }
    if (!cyclic && n > 1) { const l = b[n - 1]; out.push({ co: [...l.co] as Vec3, tilt: l.tilt, radius: l.radius }); }
    return { pts: out, cyclic, spline: sp };
  }
  const P = sp.points.slice(0, sp.pointCountV > 1 ? sp.pointCountU : sp.points.length);
  const n = P.length;
  const cyclic = sp.useCyclicU && n > 2;
  if (sp.type === 'POLY' || n < 2) {
    for (const p of P) out.push({ co: [...p.co] as Vec3, tilt: p.tilt, radius: p.radius });
    return { pts: out, cyclic: sp.useCyclicU && n > 2, spline: sp };
  }
  const info = nurbsInfo(n, sp.orderU, cyclic, sp.useEndpointU, sp.useBezierU);
  if (!info) return { pts: out, cyclic: false, spline: sp };
  const total = Math.max(2, res * (cyclic ? n : n - 1));
  const steps = cyclic ? total : total - 1;
  for (let s = 0; s <= steps - (cyclic ? 1 : 0); s++) {
    const t = info.t0 + ((info.t1 - info.t0) * s) / steps;
    const ws = nurbsWeights(info, Math.min(t, info.t1 - 1e-9), (i) => P[i].w);
    const co: Vec3 = [0, 0, 0];
    let tilt = 0, radius = 0;
    for (const [ci, w] of ws) { const p = P[ci]; co[0] += p.co[0] * w; co[1] += p.co[1] * w; co[2] += p.co[2] * w; tilt += p.tilt * w; radius += p.radius * w; }
    out.push({ co, tilt, radius });
  }
  return { pts: out, cyclic, spline: sp };
}

// ------------------------------------------------------------------ frames (twist)

export interface Frame { t: Vec3; n: Vec3; u: Vec3 }

/** Tangents and normals along sampled points. `is2D` keeps the up vector on +Z. */
export function computeFrames(pts: Vec3[], cyclic: boolean, twist: CurveData['twistMode'], is2D: boolean, tilts?: number[]): Frame[] {
  const n = pts.length;
  const tangents: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const prev = i > 0 ? pts[i - 1] : cyclic ? pts[n - 1] : null;
    const next = i < n - 1 ? pts[i + 1] : cyclic ? pts[0] : null;
    let t: Vec3 = prev && next ? add(norm(sub(next, pts[i])), norm(sub(pts[i], prev))) : next ? sub(next, pts[i]) : prev ? sub(pts[i], prev) : [1, 0, 0];
    if (len(t) < 1e-12) t = next ? sub(next, pts[i]) : [1, 0, 0];
    tangents.push(norm(t));
  }
  // fix zero tangents by copying neighbours
  for (let i = 0; i < n; i++) if (len(tangents[i]) < 0.5) tangents[i] = i > 0 ? tangents[i - 1] : [1, 0, 0];
  const frames: Frame[] = [];
  const zUp = (t: Vec3): Vec3 => {
    let nn = cross(t, [0, 0, 1]);
    if (len(nn) < 1e-6) nn = cross(t, [0, 1, 0]);
    return norm(nn);
  };
  if (is2D || twist === 'Z_UP') {
    for (const t of tangents) { const nn = zUp(t); frames.push({ t, n: nn, u: norm(cross(nn, t)) }); }
  } else if (twist === 'TANGENT') {
    let last: Vec3 | null = null;
    for (let i = 0; i < n; i++) {
      const t = tangents[i];
      const a = tangents[Math.max(0, i - 1)], b = tangents[Math.min(n - 1, i + 1)];
      let bn = cross(a, b);
      let nn: Vec3;
      if (len(bn) > 1e-5) { bn = norm(bn); nn = norm(cross(t, bn)); }
      else nn = last ? norm(sub(last, mul(t, dot(last, t)))) : zUp(t);
      if (len(nn) < 1e-6) nn = zUp(t);
      last = nn;
      frames.push({ t, n: nn, u: norm(cross(nn, t)) });
    }
  } else {
    // minimum twist: parallel transport of the first frame
    let nn = zUp(tangents[0]);
    for (let i = 0; i < n; i++) {
      const t = tangents[i];
      if (i > 0) {
        const tp = tangents[i - 1];
        const ax = cross(tp, t);
        const s = len(ax);
        if (s > 1e-9) nn = rotate(nn, mul(ax, 1 / s), Math.atan2(s, dot(tp, t)));
        nn = norm(sub(nn, mul(t, dot(nn, t))));
      }
      frames.push({ t, n: nn, u: norm(cross(nn, t)) });
    }
    if (cyclic && n > 2) {
      // distribute the closing mismatch along the curve
      const t0 = tangents[0];
      const tl = tangents[n - 1];
      let endN = frames[n - 1].n;
      const ax = cross(tl, t0);
      const s = len(ax);
      if (s > 1e-9) endN = rotate(endN, mul(ax, 1 / s), Math.atan2(s, dot(tl, t0)));
      const f0 = frames[0];
      let ang = Math.atan2(dot(cross(endN, f0.n), t0), dot(endN, f0.n));
      if (!isFinite(ang)) ang = 0;
      for (let i = 1; i < n; i++) {
        const f = frames[i];
        const a = (ang * i) / n;
        f.n = rotate(f.n, f.t, a);
        f.u = norm(cross(f.n, f.t));
      }
    }
  }
  if (tilts) {
    for (let i = 0; i < n; i++) {
      const a = tilts[i];
      if (!a) continue;
      const f = frames[i];
      f.n = rotate(f.n, f.t, a);
      f.u = norm(cross(f.n, f.t));
    }
  }
  return frames;
}

// ------------------------------------------------------------------ bevel profile

export interface Profile { pts: P2[]; closed: boolean }

/** Profile used along the curve: x along the curve normal (width), y along the up vector. */
export function curveProfile(cu: CurveData, bevelSpline: SampledSpline | null): Profile | null {
  const e = cu.extrude, d = cu.bevelDepth;
  const is2D = cu.dimensions === '2D';
  const fill = cu.fillMode;
  // 2D "Both"/"Front"/"Back" and 3D "Half" use the outer half of the profile only
  const half = is2D ? fill !== 'NONE' : fill === 'HALF';
  let prof: Profile | null = null;
  if (bevelSpline && bevelSpline.pts.length >= 2) {
    prof = { pts: bevelSpline.pts.map((p) => [p.co[0], p.co[1]] as P2), closed: bevelSpline.cyclic };
    if (prof.closed && signedArea(prof.pts) < 0) prof.pts.reverse();
  } else if (d > 0) {
    const q = Math.max(1, cu.bevelResolution + 1); // segments per quarter circle
    const pts: P2[] = [];
    if (half) {
      // bottom (-e-d) to top (+e+d) on the outer side
      for (let i = 0; i <= q; i++) { const a = -Math.PI / 2 + (Math.PI / 2) * (i / q); pts.push([Math.cos(a) * d, -e + Math.sin(a) * d]); }
      for (let i = e > 0 ? 0 : 1; i <= q; i++) { const a = (Math.PI / 2) * (i / q); pts.push([Math.cos(a) * d, e + Math.sin(a) * d]); }
      prof = { pts, closed: false };
    } else {
      // full stadium / circle, counter-clockwise starting at the bottom of the outer side
      for (let i = 0; i <= q; i++) { const a = -Math.PI / 2 + (Math.PI / 2) * (i / q); pts.push([Math.cos(a) * d, -e + Math.sin(a) * d]); }
      for (let i = e > 0 ? 0 : 1; i <= 2 * q; i++) { const a = (Math.PI / 2) * (i / q); pts.push([Math.cos(a) * d, e + Math.sin(a) * d]); }
      for (let i = e > 0 ? 0 : 1; i < q; i++) { const a = Math.PI + (Math.PI / 2) * (i / q); pts.push([Math.cos(a) * d, -e + Math.sin(a) * d]); }
      prof = { pts, closed: true };
      if (!is2D && (fill === 'FRONT' || fill === 'BACK')) {
        const keep = prof.pts.filter((p) => (fill === 'FRONT' ? p[1] >= -1e-9 : p[1] <= 1e-9));
        // order the kept half as an open profile running counter-clockwise
        const startIdx = prof.pts.findIndex((p, i) => {
          const prev = prof!.pts[(i + prof!.pts.length - 1) % prof!.pts.length];
          return (fill === 'FRONT' ? p[1] >= -1e-9 : p[1] <= 1e-9) && !(fill === 'FRONT' ? prev[1] >= -1e-9 : prev[1] <= 1e-9);
        });
        const ordered: P2[] = [];
        for (let i = 0; i < prof.pts.length; i++) { const p = prof.pts[(startIdx + i) % prof.pts.length]; if (keep.includes(p)) ordered.push(p); }
        prof = { pts: ordered, closed: false };
      }
    }
  } else if (e > 0) {
    prof = { pts: [[0, -e], [0, e]], closed: false };
  }
  if (prof && cu.offset) prof.pts = prof.pts.map(([x, y]) => [x + cu.offset, y]);
  return prof;
}

function signedArea(pts: P2[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] - pts[i][0]) * (pts[j][1] + pts[i][1]);
  return a / 2;
}

/** Taper factor at fraction f (0..1) along the curve, from a sampled taper spline. */
function taperAt(taper: SampledSpline | null, f: number): number {
  if (!taper || taper.pts.length < 2) return 1;
  const pts = taper.pts.map((p) => [p.co[0], p.co[1]] as P2);
  const x0 = pts[0][0], x1 = pts[pts.length - 1][0];
  const span = x1 - x0 || 1;
  const x = x0 + span * Math.min(1, Math.max(0, f));
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    if ((x >= a[0] && x <= b[0]) || (x <= a[0] && x >= b[0])) {
      const t = Math.abs(b[0] - a[0]) > 1e-12 ? (x - a[0]) / (b[0] - a[0]) : 0;
      return a[1] + (b[1] - a[1]) * t;
    }
  }
  return pts[pts.length - 1][1];
}

// ------------------------------------------------------------------ curve -> mesh

export interface CurveMeshOptions {
  render: boolean;
  /** Sampled first spline of the bevel / taper objects (in their own object space). */
  bevel?: SampledSpline | null;
  taper?: SampledSpline | null;
}

class MeshBuilder {
  verts: Vec3[] = [];
  faces: number[][] = [];
  faceSmooth: boolean[] = [];
  faceMat: number[] = [];
  looseEdges: [number, number][] = [];
  v(p: Vec3): number { this.verts.push(p); return this.verts.length - 1; }
  f(idx: number[], smooth: boolean, mat: number): void { this.faces.push(idx); this.faceSmooth.push(smooth); this.faceMat.push(mat); }
  build(): EvalMesh { return { verts: this.verts, faces: this.faces, looseEdges: this.looseEdges, faceSmooth: this.faceSmooth, faceMat: this.faceMat }; }
}

/** Sampled splines of a curve (skipping hidden splines is not done: hide is an edit-mode thing). */
export function sampleCurve(cu: CurveData, render: boolean): SampledSpline[] {
  return cu.splines.map((sp) => sampleSpline(sp, splineResolution(cu, sp, render)));
}

/** Convert a curve to a mesh: bevelled / extruded tubes, filled 2D shapes or a plain wire. */
export function curveToMesh(cu: CurveData, opts: CurveMeshOptions): EvalMesh {
  const mb = new MeshBuilder();
  const is2D = cu.dimensions === '2D';
  const samples = sampleCurve(cu, opts.render);
  if (is2D) for (const s of samples) for (const p of s.pts) p.co = [p.co[0], p.co[1], 0];
  const profile = curveProfile(cu, opts.bevel ?? null);
  const nMat = Math.max(1, cu.materials.length);
  const fill2D = is2D && cu.fillMode !== 'NONE';
  for (const s of samples) {
    const sp = s.spline;
    const mat = Math.min(nMat - 1, Math.max(0, sp.materialIndex));
    const pts = s.pts.map((p) => p.co);
    const n = pts.length;
    if (n < 2) continue;
    if (!profile) {
      // wire unless it is filled below
      if (fill2D && s.cyclic) continue;
      const base = mb.verts.length;
      for (const p of pts) mb.v([...p] as Vec3);
      for (let i = 0; i + 1 < n; i++) mb.looseEdges.push([base + i, base + i + 1]);
      if (s.cyclic) mb.looseEdges.push([base + n - 1, base]);
      continue;
    }
    const frames = computeFrames(pts, s.cyclic, cu.twistMode, is2D, s.pts.map((p) => p.tilt));
    // cumulative length for the taper
    const dist = [0];
    for (let i = 1; i < n; i++) dist.push(dist[i - 1] + len(sub(pts[i], pts[i - 1])));
    const total = dist[n - 1] || 1;
    const m = profile.pts.length;
    const rings: number[][] = [];
    for (let i = 0; i < n; i++) {
      const f = frames[i];
      let r = s.pts[i].radius;
      if (opts.taper) r *= taperAt(opts.taper, dist[i] / total);
      const ring: number[] = [];
      for (const [px, py] of profile.pts) {
        ring.push(mb.v(add(add(pts[i], mul(f.n, px * r)), mul(f.u, py * r))));
      }
      rings.push(ring);
    }
    // decide the winding once per spline so normals point out of the profile
    const segs = s.cyclic ? n : n - 1;
    const pSegs = profile.closed ? m : m - 1;
    let flip = false;
    test: for (let i = 0; i < segs; i++) {
      for (let j = 0; j < pSegs; j++) {
        const a = rings[i][j], b = rings[(i + 1) % n][j], c = rings[(i + 1) % n][(j + 1) % m];
        const gn = cross(sub(mb.verts[b], mb.verts[a]), sub(mb.verts[c], mb.verts[a]));
        if (len(gn) < 1e-12) continue;
        const p0 = profile.pts[j], p1 = profile.pts[(j + 1) % m];
        const o: P2 = [p1[1] - p0[1], -(p1[0] - p0[0])];
        const f = frames[i];
        const want = add(mul(f.n, o[0]), mul(f.u, o[1]));
        flip = dot(gn, want) < 0;
        break test;
      }
    }
    for (let i = 0; i < segs; i++) {
      const r0 = rings[i], r1 = rings[(i + 1) % n];
      for (let j = 0; j < pSegs; j++) {
        const q = [r0[j], r1[j], r1[(j + 1) % m], r0[(j + 1) % m]];
        mb.f(flip ? q.reverse() : q, sp.useSmooth, mat);
      }
    }
    // end caps of open splines (3D "Fill Caps")
    if (!s.cyclic && profile.closed && cu.useFillCaps && !is2D) {
      const tris = triangulate(profile.pts, profile.pts.map((_, i) => i));
      for (const [a, b, c] of tris) {
        mb.f(flip ? [rings[0][a], rings[0][b], rings[0][c]] : [rings[0][c], rings[0][b], rings[0][a]], false, mat);
        const L = rings[n - 1];
        mb.f(flip ? [L[c], L[b], L[a]] : [L[a], L[b], L[c]], false, mat);
      }
    }
  }
  if (fill2D) fill2DCaps(mb, cu, samples, profile, nMat);
  return mb.build();
}

/** Front / back faces of closed 2D splines, with holes (even-odd nesting). */
function fill2DCaps(mb: MeshBuilder, cu: CurveData, samples: SampledSpline[], profile: Profile | null, nMat: number): void {
  const closed = samples.filter((s) => s.cyclic && s.pts.length >= 3);
  if (!closed.length) return;
  // cap heights and outline offsets from the profile ends (bottom = back, top = front)
  let back = { x: cu.offset, y: 0 }, front = { x: cu.offset, y: 0 };
  if (profile && profile.pts.length) {
    if (profile.closed) {
      // full profile (shouldn't happen for filled 2D curves, which use the half profile)
      let lo = profile.pts[0], hi = profile.pts[0];
      for (const p of profile.pts) { if (p[1] < lo[1]) lo = p; if (p[1] > hi[1]) hi = p; }
      back = { x: lo[0], y: lo[1] }; front = { x: hi[0], y: hi[1] };
    } else {
      const a = profile.pts[0], b = profile.pts[profile.pts.length - 1];
      back = a[1] <= b[1] ? { x: a[0], y: a[1] } : { x: b[0], y: b[1] };
      front = a[1] <= b[1] ? { x: b[0], y: b[1] } : { x: a[0], y: a[1] };
    }
  }
  const flat = Math.abs(front.y - back.y) < 1e-9;
  const outlines = (cap: { x: number; y: number }) => closed.map((s) => {
    const pts = s.pts.map((p) => p.co);
    const fr = computeFrames(pts, true, 'Z_UP', true);
    return pts.map((p, i) => [p[0] + fr[i].n[0] * cap.x * s.pts[i].radius, p[1] + fr[i].n[1] * cap.x * s.pts[i].radius] as P2);
  });
  const doCap = (cap: { x: number; y: number }, up: boolean) => {
    const rings = outlines(cap);
    const groups = nestRings(rings);
    for (const [outer, holes] of groups) {
      const pts2: P2[] = [];
      const ringIdx = (ri: number) => rings[ri].map((p) => { pts2.push(p); return pts2.length - 1; });
      const o = ringIdx(outer);
      const hs = holes.map(ringIdx);
      const tris = triangulate(pts2, o, hs);
      const vi = pts2.map((p) => mb.v([p[0], p[1], cap.y]));
      const mat = Math.min(nMat - 1, Math.max(0, closed[outer].spline.materialIndex));
      for (const [a, b, c] of tris) mb.f(up ? [vi[a], vi[b], vi[c]] : [vi[c], vi[b], vi[a]], false, mat);
    }
  };
  const mode = cu.fillMode;
  if (flat) { if (mode === 'BACK') doCap(back, false); else doCap(front, true); return; }
  if (mode === 'FULL' || mode === 'FRONT') doCap(front, true);
  if (mode === 'FULL' || mode === 'BACK') doCap(back, false);
}

// ------------------------------------------------------------------ path (arc length)

export interface CurvePath {
  pts: Vec3[];
  frames: Frame[];
  radius: number[];
  tilt: number[];
  /** Cumulative distance per point. */
  dist: number[];
  total: number;
  cyclic: boolean;
}

/** Arc-length path along the first spline of a curve (Blender's curve path). */
export function buildPath(cu: CurveData, render = false): CurvePath | null {
  const sp = cu.splines[0];
  if (!sp) return null;
  const s = sampleSpline(sp, splineResolution(cu, sp, render));
  if (s.pts.length < 2) return null;
  const pts = s.pts.map((p) => (cu.dimensions === '2D' ? [p.co[0], p.co[1], 0] as Vec3 : p.co));
  const frames = computeFrames(pts, s.cyclic, cu.twistMode, cu.dimensions === '2D', s.pts.map((p) => p.tilt));
  const dist = [0];
  for (let i = 1; i < pts.length; i++) dist.push(dist[i - 1] + len(sub(pts[i], pts[i - 1])));
  let total = dist[dist.length - 1];
  if (s.cyclic) { total += len(sub(pts[0], pts[pts.length - 1])); }
  return { pts, frames, radius: s.pts.map((p) => p.radius), tilt: s.pts.map((p) => p.tilt), dist, total, cyclic: s.cyclic };
}

export interface PathPoint { co: Vec3; frame: Frame; radius: number; tilt: number }

/** Point on the path at fraction t (0..1); open paths are extended linearly beyond their ends. */
export function pathAt(path: CurvePath, t: number): PathPoint {
  const n = path.pts.length;
  let d = t * path.total;
  if (path.cyclic) { d = ((d % path.total) + path.total) % path.total; }
  if (!path.cyclic && d <= 0) {
    const f = path.frames[0];
    return { co: add(path.pts[0], mul(f.t, d)), frame: f, radius: path.radius[0], tilt: path.tilt[0] };
  }
  if (!path.cyclic && d >= path.dist[n - 1]) {
    const f = path.frames[n - 1];
    return { co: add(path.pts[n - 1], mul(f.t, d - path.dist[n - 1])), frame: f, radius: path.radius[n - 1], tilt: path.tilt[n - 1] };
  }
  // binary search segment
  let lo = 0, hi = n - 1;
  if (path.cyclic && d >= path.dist[n - 1]) {
    lo = n - 1;
  } else {
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (path.dist[mid] <= d) lo = mid; else hi = mid; }
  }
  const i0 = lo, i1 = (lo + 1) % n;
  const segLen = (i1 === 0 ? path.total : path.dist[i1]) - path.dist[i0];
  const f = segLen > 1e-12 ? (d - path.dist[i0]) / segLen : 0;
  const fa = path.frames[i0], fb = path.frames[i1];
  const tt = norm(lerp(fa.t, fb.t, f));
  let nn = norm(lerp(fa.n, fb.n, f));
  nn = norm(sub(nn, mul(tt, dot(nn, tt))));
  return {
    co: lerp(path.pts[i0], path.pts[i1], f), frame: { t: tt, n: nn, u: norm(cross(nn, tt)) },
    radius: path.radius[i0] + (path.radius[i1] - path.radius[i0]) * f, tilt: path.tilt[i0] + (path.tilt[i1] - path.tilt[i0]) * f,
  };
}

// ------------------------------------------------------------------ NURBS surfaces

/** Evaluate a NURBS surface spline into a quad grid. */
export function surfaceToMesh(cu: CurveData, render: boolean): EvalMesh {
  const mb = new MeshBuilder();
  const nMat = Math.max(1, cu.materials.length);
  for (const sp of cu.splines) {
    const nu = sp.pointCountU, nv = sp.pointCountV;
    const mat = Math.min(nMat - 1, Math.max(0, sp.materialIndex));
    if (nu < 1 || nv < 1 || sp.points.length < nu * nv) continue;
    if (nv === 1) {
      // a single row: a NURBS curve drawn as a wire
      const s = sampleSpline({ ...sp, pointCountV: 1, points: sp.points.slice(0, nu) }, Math.max(1, render && cu.renderResolutionU > 0 ? cu.renderResolutionU : sp.resolutionU));
      const base = mb.verts.length;
      for (const p of s.pts) mb.v(p.co);
      for (let i = 0; i + 1 < s.pts.length; i++) mb.looseEdges.push([base + i, base + i + 1]);
      if (s.cyclic && s.pts.length > 2) mb.looseEdges.push([base + s.pts.length - 1, base]);
      continue;
    }
    const cycU = sp.useCyclicU && nu > 2, cycV = sp.useCyclicV && nv > 2;
    const iu = nurbsInfo(nu, sp.orderU, cycU, sp.useEndpointU, sp.useBezierU);
    const iv = nurbsInfo(nv, sp.orderV, cycV, sp.useEndpointV, sp.useBezierV);
    if (!iu || !iv) continue;
    const resU = Math.max(1, render && cu.renderResolutionU > 0 ? cu.renderResolutionU : sp.resolutionU);
    const resV = Math.max(1, render && cu.renderResolutionV > 0 ? cu.renderResolutionV : sp.resolutionV);
    const su = Math.max(2, resU * (cycU ? nu : nu - 1)), sv = Math.max(2, resV * (cycV ? nv : nv - 1));
    const stepsU = cycU ? su : su - 1, stepsV = cycV ? sv : sv - 1;
    const countU = cycU ? su : su, countV = cycV ? sv : sv;
    const grid: number[][] = [];
    const wU: [number, number][][] = [], wV: [number, number][][] = [];
    for (let a = 0; a < countU; a++) { const t = iu.t0 + ((iu.t1 - iu.t0) * a) / stepsU; wU.push(nurbsWeights(iu, Math.min(t, iu.t1 - 1e-9), () => 1)); }
    for (let b = 0; b < countV; b++) { const t = iv.t0 + ((iv.t1 - iv.t0) * b) / stepsV; wV.push(nurbsWeights(iv, Math.min(t, iv.t1 - 1e-9), () => 1)); }
    for (let b = 0; b < countV; b++) {
      const row: number[] = [];
      for (let a = 0; a < countU; a++) {
        const co: Vec3 = [0, 0, 0];
        let wsum = 0;
        for (const [cu2, bu] of wU[a]) for (const [cv, bv] of wV[b]) {
          const p = sp.points[cv * nu + cu2];
          const w = bu * bv * p.w;
          co[0] += p.co[0] * w; co[1] += p.co[1] * w; co[2] += p.co[2] * w; wsum += w;
        }
        row.push(mb.v(wsum > 1e-12 ? mul(co, 1 / wsum) : co));
      }
      grid.push(row);
    }
    const segU = cycU ? countU : countU - 1, segV = cycV ? countV : countV - 1;
    for (let b = 0; b < segV; b++) {
      for (let a = 0; a < segU; a++) {
        const a1 = (a + 1) % countU, b1 = (b + 1) % countV;
        mb.f([grid[b][a], grid[b][a1], grid[b1][a1], grid[b1][a]], sp.useSmooth, mat);
      }
    }
  }
  return mb.build();
}

/** Control-polygon index pairs of a surface spline (U rows and V columns). */
export function surfaceGridEdges(sp: Spline): [number, number][] {
  const nu = sp.pointCountU, nv = Math.max(1, sp.pointCountV);
  const out: [number, number][] = [];
  for (let v = 0; v < nv; v++) {
    for (let u = 0; u + 1 < nu; u++) out.push([v * nu + u, v * nu + u + 1]);
    if (sp.useCyclicU && nu > 2) out.push([v * nu + nu - 1, v * nu]);
  }
  if (nv > 1) {
    for (let u = 0; u < nu; u++) {
      for (let v = 0; v + 1 < nv; v++) out.push([v * nu + u, (v + 1) * nu + u]);
      if (sp.useCyclicV && nv > 2) out.push([(nv - 1) * nu + u, u]);
    }
  }
  return out;
}
