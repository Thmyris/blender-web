// Metaballs: the implicit field of meta elements and its polygonisation with surface nets
// (one vertex per boundary cell, one quad per grid edge crossing the iso surface).

import { Matrix4, Quaternion, Vector3 } from 'three';
import type { Vec3 } from './types';
import type { MetaBallData, MetaElement, MetaElementType } from './curvetypes';
import type { EvalMesh } from './modifiers';

export function newMetaElement(type: MetaElementType, co: Vec3 = [0, 0, 0], radius = 2): MetaElement {
  const size: Record<MetaElementType, Vec3> = { BALL: [1, 1, 1], CAPSULE: [1, 1, 1], PLANE: [1, 1, 1], ELLIPSOID: [1.2, 0.8, 1], CUBE: [1, 1, 1] };
  return {
    type, co: [...co] as Vec3, rotation: [1, 0, 0, 0], radius, stiffness: 2, sizeX: size[type][0], sizeY: size[type][1], sizeZ: size[type][2],
    useNegative: false, hide: false, select: true,
  };
}

export function newMetaBallData(id: string, name: string): MetaBallData {
  return { id, name, elements: [], resolution: 0.4, renderResolution: 0.2, threshold: 0.6, updateMode: 'UPDATE_ALWAYS', materials: [], activeElement: 0, fakeUser: false };
}

/** Local element matrix: translation to `co` and the element rotation. */
export function elementMatrix(el: MetaElement): Matrix4 {
  const [w, x, y, z] = el.rotation;
  return new Matrix4().compose(new Vector3(...el.co), new Quaternion(x, y, z, w).normalize(), new Vector3(1, 1, 1));
}

/** Field value of one element at a point given in element space. */
export function elementField(el: MetaElement, x: number, y: number, z: number): number {
  const t = el.type;
  if (t === 'CUBE') z = z > el.sizeZ ? z - el.sizeZ : z < -el.sizeZ ? z + el.sizeZ : 0;
  if (t === 'CUBE' || t === 'PLANE') y = y > el.sizeY ? y - el.sizeY : y < -el.sizeY ? y + el.sizeY : 0;
  if (t === 'CUBE' || t === 'PLANE' || t === 'CAPSULE') x = x > el.sizeX ? x - el.sizeX : x < -el.sizeX ? x + el.sizeX : 0;
  if (t === 'ELLIPSOID') { x /= el.sizeX || 1; y /= el.sizeY || 1; z /= el.sizeZ || 1; }
  const r2 = el.radius * el.radius;
  if (r2 <= 0) return 0;
  const d = 1 - (x * x + y * y + z * z) / r2;
  if (d <= 0) return 0;
  const v = el.stiffness * d * d * d;
  return el.useNegative ? -v : v;
}

/** Half extents of an element's influence in element space. */
function elementExtent(el: MetaElement): Vec3 {
  const r = el.radius;
  switch (el.type) {
    case 'CAPSULE': return [r + el.sizeX, r, r];
    case 'PLANE': return [r + el.sizeX, r + el.sizeY, r];
    case 'CUBE': return [r + el.sizeX, r + el.sizeY, r + el.sizeZ];
    case 'ELLIPSOID': return [r * el.sizeX, r * el.sizeY, r * el.sizeZ];
    default: return [r, r, r];
  }
}

/** An element placed in the space of the polygonised (basis) object. */
export interface PlacedElement { el: MetaElement; toBase: Matrix4 }

const MAX_CELLS = 96;

/** Polygonise the field of the elements (all in basis object space) at the given resolution. */
export function polygonizeMeta(elements: PlacedElement[], resolution: number, threshold: number): EvalMesh {
  const empty: EvalMesh = { verts: [], faces: [], looseEdges: [], faceSmooth: [], faceMat: [] };
  const live = elements.filter((e) => !e.el.hide && e.el.radius > 0 && e.el.stiffness !== 0);
  if (!live.length) return empty;
  // bounds of the positive elements
  const min = new Vector3(Infinity, Infinity, Infinity), max = new Vector3(-Infinity, -Infinity, -Infinity);
  const inv: Matrix4[] = [];
  const boxes: { min: Vector3; max: Vector3 }[] = [];
  for (const e of live) {
    const m = e.toBase.clone().multiply(elementMatrix(e.el));
    inv.push(m.clone().invert());
    const ex = elementExtent(e.el);
    const bmin = new Vector3(Infinity, Infinity, Infinity), bmax = new Vector3(-Infinity, -Infinity, -Infinity);
    for (let i = 0; i < 8; i++) {
      const p = new Vector3(i & 1 ? ex[0] : -ex[0], i & 2 ? ex[1] : -ex[1], i & 4 ? ex[2] : -ex[2]).applyMatrix4(m);
      bmin.min(p); bmax.max(p);
    }
    boxes.push({ min: bmin, max: bmax });
    if (!e.el.useNegative) { min.min(bmin); max.max(bmax); }
  }
  if (!isFinite(min.x)) return empty;
  let cell = Math.max(1e-3, resolution);
  const size = max.clone().sub(min);
  const biggest = Math.max(size.x, size.y, size.z);
  if (biggest / cell > MAX_CELLS) cell = biggest / MAX_CELLS;
  // one cell of padding so the surface is closed
  min.subScalar(cell); max.addScalar(cell);
  const nx = Math.max(1, Math.ceil((max.x - min.x) / cell)), ny = Math.max(1, Math.ceil((max.y - min.y) / cell)), nz = Math.max(1, Math.ceil((max.z - min.z) / cell));
  const px = nx + 1, py = ny + 1, pz = nz + 1;
  const field = new Float32Array(px * py * pz);
  const gi = (i: number, j: number, k: number) => i + px * (j + py * k);
  // accumulate each element only inside its influence box
  const tmp = new Vector3();
  live.forEach((e, ei) => {
    const b = boxes[ei];
    const i0 = Math.max(0, Math.floor((b.min.x - min.x) / cell)), i1 = Math.min(nx, Math.ceil((b.max.x - min.x) / cell));
    const j0 = Math.max(0, Math.floor((b.min.y - min.y) / cell)), j1 = Math.min(ny, Math.ceil((b.max.y - min.y) / cell));
    const k0 = Math.max(0, Math.floor((b.min.z - min.z) / cell)), k1 = Math.min(nz, Math.ceil((b.max.z - min.z) / cell));
    const m = inv[ei];
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      tmp.set(min.x + i * cell, min.y + j * cell, min.z + k * cell).applyMatrix4(m);
      const v = elementField(e.el, tmp.x, tmp.y, tmp.z);
      if (v) field[gi(i, j, k)] += v;
    }
  });
  for (let i = 0; i < field.length; i++) field[i] -= threshold;
  // one vertex per cell that the surface passes through
  const cellVert = new Int32Array(nx * ny * nz).fill(-1);
  const ci = (i: number, j: number, k: number) => i + nx * (j + ny * k);
  const verts: Vec3[] = [];
  const corner = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const val = new Float32Array(8);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    let inside = 0;
    for (let c = 0; c < 8; c++) { val[c] = field[gi(i + corner[c][0], j + corner[c][1], k + corner[c][2])]; if (val[c] > 0) inside++; }
    if (inside === 0 || inside === 8) continue;
    let sx = 0, sy = 0, sz = 0, cnt = 0;
    for (const [a, b] of edges) {
      const va = val[a], vb = val[b];
      if ((va > 0) === (vb > 0)) continue;
      const t = va / (va - vb);
      sx += corner[a][0] + (corner[b][0] - corner[a][0]) * t;
      sy += corner[a][1] + (corner[b][1] - corner[a][1]) * t;
      sz += corner[a][2] + (corner[b][2] - corner[a][2]) * t;
      cnt++;
    }
    cellVert[ci(i, j, k)] = verts.length;
    verts.push([min.x + (i + sx / cnt) * cell, min.y + (j + sy / cnt) * cell, min.z + (k + sz / cnt) * cell]);
  }
  // one quad per grid edge with a sign change, joining the four cells around it
  const faces: number[][] = [];
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    faces.push(flip ? [a, d, c, b] : [a, b, c, d]);
  };
  for (let k = 0; k <= nz; k++) for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
    const v0 = field[gi(i, j, k)] > 0;
    // X edge: cells (i, j-1..j, k-1..k)
    if (i < nx && j > 0 && k > 0 && j < ny + 0 && k < nz + 0 && v0 !== (field[gi(i + 1, j, k)] > 0)) {
      quad(cellVert[ci(i, j - 1, k - 1)], cellVert[ci(i, j, k - 1)], cellVert[ci(i, j, k)], cellVert[ci(i, j - 1, k)], !v0);
    }
    if (j < ny && i > 0 && k > 0 && i < nx && k < nz && v0 !== (field[gi(i, j + 1, k)] > 0)) {
      quad(cellVert[ci(i - 1, j, k - 1)], cellVert[ci(i - 1, j, k)], cellVert[ci(i, j, k)], cellVert[ci(i, j, k - 1)], !v0);
    }
    if (k < nz && i > 0 && j > 0 && i < nx && j < ny && v0 !== (field[gi(i, j, k + 1)] > 0)) {
      quad(cellVert[ci(i - 1, j - 1, k)], cellVert[ci(i, j - 1, k)], cellVert[ci(i, j, k)], cellVert[ci(i - 1, j, k)], !v0);
    }
  }
  return { verts, faces, looseEdges: [], faceSmooth: faces.map(() => true), faceMat: faces.map(() => 0) };
}
