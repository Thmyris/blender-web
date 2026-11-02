// Collision objects for cloth, soft bodies and particles: the evaluated mesh of every
// object with a Collision modifier, triangulated in world space and stored in a
// uniform spatial hash for nearest-triangle and segment queries.

import type { Matrix4 } from 'three';
import { app } from '../app';
import type { MatrixCache } from '../core/scene';
import type { BObject } from '../core/types';
import { triangulatePoly } from '../core/mesh';
import { defaultCollision, type CollisionSettings } from './types';

export interface Collider {
  ob: BObject;
  settings: CollisionSettings;
  /** Triangle corners (9 floats each) and unit normals (3 floats each), world space. */
  tri: Float64Array;
  nrm: Float64Array;
  count: number;
  cell: number;
  grid: Map<number, number[]>;
  min: [number, number, number];
  max: [number, number, number];
}

export function hasCollision(ob: BObject): boolean {
  return ob.type === 'MESH' && ob.modifiers.some((m) => m.type === 'COLLISION');
}

export function collisionSettings(ob: BObject): CollisionSettings {
  return { ...defaultCollision(), ...(ob.collision ?? {}) };
}

/** Collision objects of the scene (visible layers are not required, like Blender). */
export function collisionObjects(exclude?: string): BObject[] {
  return app.objects().filter((o) => o.id !== exclude && hasCollision(o) && !o.modifiers.some((m) => m.type === 'CLOTH' || m.type === 'SOFT_BODY'));
}

const hashKey = (x: number, y: number, z: number) => ((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) | 0;

export function buildCollider(ob: BObject, world: Matrix4): Collider | null {
  const em = app.evalMesh(ob);
  if (!em || !em.faces.length) return null;
  const e = world.elements;
  const wv = new Float64Array(em.verts.length * 3);
  em.verts.forEach((v, i) => {
    wv[i * 3] = e[0] * v[0] + e[4] * v[1] + e[8] * v[2] + e[12];
    wv[i * 3 + 1] = e[1] * v[0] + e[5] * v[1] + e[9] * v[2] + e[13];
    wv[i * 3 + 2] = e[2] * v[0] + e[6] * v[1] + e[10] * v[2] + e[14];
  });
  const tris: number[] = [];
  for (const f of em.faces) {
    if (f.length === 3) { tris.push(f[0], f[1], f[2]); continue; }
    if (f.length === 4) { tris.push(f[0], f[1], f[2], f[0], f[2], f[3]); continue; }
    for (const t of triangulatePoly(em.verts, f)) tris.push(f[t[0]], f[t[1]], f[t[2]]);
  }
  const count = tris.length / 3;
  const tri = new Float64Array(count * 9);
  const nrm = new Float64Array(count * 3);
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let edgeSum = 0;
  for (let t = 0; t < count; t++) {
    for (let k = 0; k < 3; k++) {
      const vi = tris[t * 3 + k];
      for (let c = 0; c < 3; c++) {
        const val = wv[vi * 3 + c];
        tri[t * 9 + k * 3 + c] = val;
        if (val < min[c]) min[c] = val;
        if (val > max[c]) max[c] = val;
      }
    }
    const o = t * 9;
    const ux = tri[o + 3] - tri[o], uy = tri[o + 4] - tri[o + 1], uz = tri[o + 5] - tri[o + 2];
    const vx = tri[o + 6] - tri[o], vy = tri[o + 7] - tri[o + 1], vz = tri[o + 8] - tri[o + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    nrm[t * 3] = nx; nrm[t * 3 + 1] = ny; nrm[t * 3 + 2] = nz;
    edgeSum += Math.hypot(ux, uy, uz) + Math.hypot(vx, vy, vz);
  }
  const avgEdge = edgeSum / Math.max(1, count * 2);
  const ext = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 1e-3);
  const cell = Math.max(avgEdge * 1.5, ext / 64, 0.02);
  const settings = collisionSettings(ob);
  const pad = Math.max(settings.thicknessOuter, settings.thicknessInner, 0.05);
  const grid = new Map<number, number[]>();
  for (let t = 0; t < count; t++) {
    const o = t * 9;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let k = 0; k < 3; k++) {
      const x = tri[o + k * 3], y = tri[o + k * 3 + 1], z = tri[o + k * 3 + 2];
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    const cx0 = Math.floor((x0 - pad) / cell), cx1 = Math.floor((x1 + pad) / cell);
    const cy0 = Math.floor((y0 - pad) / cell), cy1 = Math.floor((y1 + pad) / cell);
    const cz0 = Math.floor((z0 - pad) / cell), cz1 = Math.floor((z1 + pad) / cell);
    for (let x = cx0; x <= cx1; x++) for (let y = cy0; y <= cy1; y++) for (let z = cz0; z <= cz1; z++) {
      const k = hashKey(x, y, z);
      const l = grid.get(k);
      if (l) l.push(t); else grid.set(k, [t]);
    }
  }
  return { ob, settings, tri, nrm, count, cell, grid, min: [min[0] - pad, min[1] - pad, min[2] - pad], max: [max[0] + pad, max[1] + pad, max[2] + pad] };
}

/** All collision objects at the frame the matrices were evaluated for. */
export function buildColliders(mats: MatrixCache, exclude?: string): Collider[] {
  const out: Collider[] = [];
  for (const ob of collisionObjects(exclude)) {
    const c = buildCollider(ob, mats.world(ob));
    if (c) out.push(c);
  }
  return out;
}

// ------------------------------------------------------------------ geometry queries

/** Closest point on triangle (a, b, c) to p; writes into out and returns squared distance. */
function closestOnTri(tri: Float64Array, o: number, px: number, py: number, pz: number, out: number[]): number {
  const ax = tri[o], ay = tri[o + 1], az = tri[o + 2];
  const bx = tri[o + 3], by = tri[o + 4], bz = tri[o + 5];
  const cx = tri[o + 6], cy = tri[o + 7], cz = tri[o + 8];
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let rx: number, ry: number, rz: number;
  if (d1 <= 0 && d2 <= 0) { rx = ax; ry = ay; rz = az; }
  else {
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { rx = bx; ry = by; rz = bz; }
    else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); rx = ax + abx * v; ry = ay + aby * v; rz = az + abz * v; }
      else {
        const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
        const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
        if (d6 >= 0 && d5 <= d6) { rx = cx; ry = cy; rz = cz; }
        else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); rx = ax + acx * w; ry = ay + acy * w; rz = az + acz * w; }
          else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
              const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
              rx = bx + (cx - bx) * w; ry = by + (cy - by) * w; rz = bz + (cz - bz) * w;
            } else {
              const den = 1 / (va + vb + vc);
              const v = vb * den, w = vc * den;
              rx = ax + abx * v + acx * w; ry = ay + aby * v + acy * w; rz = az + abz * v + acz * w;
            }
          }
        }
      }
    }
  }
  out[0] = rx; out[1] = ry; out[2] = rz;
  return (px - rx) ** 2 + (py - ry) ** 2 + (pz - rz) ** 2;
}

export interface ClosestHit {
  collider: Collider;
  tri: number;
  /** Closest point on the surface. */
  point: [number, number, number];
  /** Face normal. */
  normal: [number, number, number];
  /** Signed distance along the face normal (negative = behind the face). */
  dist: number;
}

const tmp = [0, 0, 0];
const seen = new Set<number>();

/** Nearest collider triangle within `radius` of p. */
export function closestHit(cols: Collider[], px: number, py: number, pz: number, radius: number): ClosestHit | null {
  let best: ClosestHit | null = null;
  let bestD = radius * radius;
  for (const c of cols) {
    if (px < c.min[0] - radius || py < c.min[1] - radius || pz < c.min[2] - radius || px > c.max[0] + radius || py > c.max[1] + radius || pz > c.max[2] + radius) continue;
    const cs = c.cell;
    const x0 = Math.floor((px - radius) / cs), x1 = Math.floor((px + radius) / cs);
    const y0 = Math.floor((py - radius) / cs), y1 = Math.floor((py + radius) / cs);
    const z0 = Math.floor((pz - radius) / cs), z1 = Math.floor((pz + radius) / cs);
    seen.clear();
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
      const l = c.grid.get(hashKey(x, y, z));
      if (!l) continue;
      for (const t of l) {
        if (seen.has(t)) continue;
        seen.add(t);
        const d = closestOnTri(c.tri, t * 9, px, py, pz, tmp);
        if (d < bestD) {
          bestD = d;
          const nx = c.nrm[t * 3], ny = c.nrm[t * 3 + 1], nz = c.nrm[t * 3 + 2];
          const sd = (px - tmp[0]) * nx + (py - tmp[1]) * ny + (pz - tmp[2]) * nz;
          best = { collider: c, tri: t, point: [tmp[0], tmp[1], tmp[2]], normal: [nx, ny, nz], dist: sd };
        }
      }
    }
  }
  return best;
}

export interface SegmentHit {
  collider: Collider;
  tri: number;
  /** Parameter along the segment (0..1). */
  t: number;
  normal: [number, number, number];
  /** True when the segment starts on the front side of the face. */
  front: boolean;
}

/** First collider triangle crossed by the segment p -> q. */
export function segmentHit(cols: Collider[], px: number, py: number, pz: number, qx: number, qy: number, qz: number): SegmentHit | null {
  let best: SegmentHit | null = null;
  let bestT = 1;
  const dx = qx - px, dy = qy - py, dz = qz - pz;
  for (const c of cols) {
    const lx = Math.min(px, qx), hx = Math.max(px, qx), ly = Math.min(py, qy), hy = Math.max(py, qy), lz = Math.min(pz, qz), hz = Math.max(pz, qz);
    if (hx < c.min[0] || hy < c.min[1] || hz < c.min[2] || lx > c.max[0] || ly > c.max[1] || lz > c.max[2]) continue;
    const cs = c.cell;
    const x0 = Math.floor(lx / cs), x1 = Math.floor(hx / cs), y0 = Math.floor(ly / cs), y1 = Math.floor(hy / cs), z0 = Math.floor(lz / cs), z1 = Math.floor(hz / cs);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > 4096) continue;
    seen.clear();
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
      const l = c.grid.get(hashKey(x, y, z));
      if (!l) continue;
      for (const t of l) {
        if (seen.has(t)) continue;
        seen.add(t);
        const o = t * 9;
        const tri = c.tri;
        // Moller-Trumbore
        const e1x = tri[o + 3] - tri[o], e1y = tri[o + 4] - tri[o + 1], e1z = tri[o + 5] - tri[o + 2];
        const e2x = tri[o + 6] - tri[o], e2y = tri[o + 7] - tri[o + 1], e2z = tri[o + 8] - tri[o + 2];
        const hx2 = dy * e2z - dz * e2y, hy2 = dz * e2x - dx * e2z, hz2 = dx * e2y - dy * e2x;
        const a = e1x * hx2 + e1y * hy2 + e1z * hz2;
        if (Math.abs(a) < 1e-12) continue;
        const f = 1 / a;
        const sx = px - tri[o], sy = py - tri[o + 1], sz = pz - tri[o + 2];
        const u = f * (sx * hx2 + sy * hy2 + sz * hz2);
        if (u < -1e-6 || u > 1 + 1e-6) continue;
        const qx2 = sy * e1z - sz * e1y, qy2 = sz * e1x - sx * e1z, qz2 = sx * e1y - sy * e1x;
        const v = f * (dx * qx2 + dy * qy2 + dz * qz2);
        if (v < -1e-6 || u + v > 1 + 1e-6) continue;
        const tt = f * (e2x * qx2 + e2y * qy2 + e2z * qz2);
        if (tt < 0 || tt > bestT) continue;
        bestT = tt;
        const nx = c.nrm[t * 3], ny = c.nrm[t * 3 + 1], nz = c.nrm[t * 3 + 2];
        best = { collider: c, tri: t, t: tt, normal: [nx, ny, nz], front: dx * nx + dy * ny + dz * nz < 0 };
      }
    }
  }
  return best;
}
