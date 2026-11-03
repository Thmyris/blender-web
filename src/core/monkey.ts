// "Suzanne": a stylised monkey head built procedurally (an original design, not Blender's data).
// A quad sphere is sculpted with smooth falloff functions (muzzle, brow, eye sockets, mouth groove,
// cheeks), and a pair of torus ears and dome eyes are added. Everything is mirror-symmetric in X,
// all faces are quads, and every part is a closed, outward wound surface. Faces -Y like Blender's.

import type { Vec3 } from './types';
import type { PrimitiveGeometry } from './mesh';

const gauss = (x: number, w: number) => Math.exp(-(x * x) / (w * w));
const smoothstep = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Quad sphere: an n x n grid on each cube face, projected onto the unit sphere (welded). */
function quadSphere(n: number): PrimitiveGeometry {
  const verts: Vec3[] = [];
  const faces: number[][] = [];
  const index = new Map<string, number>();
  const vert = (p: Vec3): number => {
    const k = p.map((x) => Math.round(x * 1e6)).join(',');
    let i = index.get(k);
    if (i === undefined) { i = verts.length; verts.push(p); index.set(k, i); }
    return i;
  };
  // (normal axis, sign); u x v = outward normal so the grid winds counter-clockwise from outside
  const sides: [Vec3, Vec3, Vec3][] = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
  ];
  for (const [nrm, u, v] of sides) {
    const ids: number[][] = [];
    for (let i = 0; i <= n; i++) {
      ids.push([]);
      for (let j = 0; j <= n; j++) {
        // equal-angle spacing gives a more even sphere than a linear grid
        const a = Math.tan(((i / n) * 2 - 1) * Math.PI / 4), b = Math.tan(((j / n) * 2 - 1) * Math.PI / 4);
        const p: Vec3 = [nrm[0] + u[0] * a + v[0] * b, nrm[1] + u[1] * a + v[1] * b, nrm[2] + u[2] * a + v[2] * b];
        const l = Math.hypot(p[0], p[1], p[2]);
        ids[i].push(vert([p[0] / l, p[1] / l, p[2] / l]));
      }
    }
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) faces.push([ids[i][j], ids[i + 1][j], ids[i + 1][j + 1], ids[i][j + 1]]);
  }
  return { verts, faces };
}

/** Head shape: unit direction -> surface point. */
function sculptHead(d: Vec3): Vec3 {
  const [x, y, z] = d;
  const ax = Math.abs(x);
  const front = smoothstep(-0.1, -0.75, y); // 1 on the face side
  let px = x * 0.88, py = y * 0.74, pz = z * 0.88;
  // the skull is a little fuller at the back and the top
  py += 0.1 * smoothstep(0, 0.9, y) * smoothstep(-0.6, 0.5, z);
  pz += 0.06 * smoothstep(0.2, 1, z);
  // flat-ish face plate
  py += 0.12 * front * gauss(z - 0.1, 0.7);
  // muzzle: a broad snout on the lower front
  const muzzle = front * gauss(z + 0.38, 0.32) * gauss(x, 0.62);
  py -= 0.48 * muzzle;
  pz -= 0.06 * muzzle;
  px *= 1 + 0.12 * muzzle;
  // mouth groove across the muzzle
  py += 0.06 * front * gauss(z + 0.47, 0.06) * gauss(x, 0.45);
  // nostrils
  py += 0.035 * front * gauss(z + 0.25, 0.06) * gauss(ax - 0.1, 0.06);
  // brow ridge over the eyes
  const brow = front * gauss(z - 0.4, 0.13) * gauss(ax - 0.33, 0.35);
  py -= 0.11 * brow;
  // eye sockets
  const socket = front * gauss(z - 0.2, 0.2) * gauss(ax - 0.35, 0.2);
  py += 0.15 * socket;
  // cheeks
  px += Math.sign(x) * 0.05 * gauss(z + 0.15, 0.25) * gauss(y + 0.35, 0.3);
  // narrower jaw at the bottom
  px *= 1 - 0.12 * smoothstep(-0.2, -1, z);
  return [px, py, pz];
}

/** Torus around the local Z axis (major/minor segments), as a flattened ring. */
function ring(major: number, minor: number, R: number, r: number, flat: number): PrimitiveGeometry {
  const verts: Vec3[] = [];
  const faces: number[][] = [];
  for (let i = 0; i < major; i++) {
    const u = (i / major) * Math.PI * 2;
    for (let j = 0; j < minor; j++) {
      const v = (j / minor) * Math.PI * 2;
      const rr = R + Math.cos(v) * r;
      verts.push([Math.cos(u) * rr, Math.sin(u) * rr, Math.sin(v) * r * flat]);
    }
  }
  const id = (i: number, j: number) => (i % major) * minor + (j % minor);
  for (let i = 0; i < major; i++) for (let j = 0; j < minor; j++) faces.push([id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j + 1)]);
  return { verts, faces };
}

function transformed(g: PrimitiveGeometry, fn: (p: Vec3) => Vec3): PrimitiveGeometry {
  return { verts: g.verts.map(fn), faces: g.faces.map((f) => f.slice()) };
}

/** Rotation matrix rows from yaw (about Z) then pitch (about local X). */
function rotate(p: Vec3, yaw: number, pitch: number, roll: number): Vec3 {
  let [x, y, z] = p;
  // roll about X
  let c = Math.cos(roll), s = Math.sin(roll);
  [y, z] = [y * c - z * s, y * s + z * c];
  // pitch about Y
  c = Math.cos(pitch); s = Math.sin(pitch);
  [x, z] = [x * c + z * s, -x * s + z * c];
  // yaw about Z
  c = Math.cos(yaw); s = Math.sin(yaw);
  [x, y] = [x * c - y * s, x * s + y * c];
  return [x, y, z];
}

/** The monkey head (about 530 verts, all quads) scaled to `size` (Blender's "radius"). */
export function primMonkey(size = 1): PrimitiveGeometry {
  const parts: PrimitiveGeometry[] = [];
  const head = quadSphere(8);
  parts.push(transformed(head, sculptHead));
  // right ear: a flat ring standing on the side of the head, facing outwards and a little forward
  const ear = ring(12, 4, 0.3, 0.12, 0.5);
  const earR = transformed(ear, (p) => {
    const q: Vec3 = [p[0] * 1.25, p[1] * 1.05, p[2]];
    const r = rotate(q, -0.75, Math.PI / 2, 0.25); // ring axis (local Z) -> +X, yawed towards the front
    return [r[0] + 1.02, r[1] + 0.22, r[2] + 0.3];
  });
  // right eye: a dome sitting in the socket
  const eye = quadSphere(2);
  const eyeR = transformed(eye, (p) => [p[0] * 0.19 + 0.35, p[1] * 0.09 - 0.63, p[2] * 0.17 + 0.2]);
  for (const g of [earR, eyeR]) {
    parts.push(g);
    // mirrored copy (reversed winding keeps it outward facing)
    parts.push({ verts: g.verts.map((p) => [-p[0], p[1], p[2]] as Vec3), faces: g.faces.map((f) => f.slice().reverse()) });
  }
  const verts: Vec3[] = [];
  const faces: number[][] = [];
  for (const g of parts) {
    const off = verts.length;
    for (const p of g.verts) verts.push([p[0] * size, p[1] * size, p[2] * size]);
    for (const f of g.faces) faces.push(f.map((i) => i + off));
  }
  return { verts, faces };
}
