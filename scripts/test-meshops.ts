// Assertion based tests for src/core/meshops.ts.
// Run:
//   npx --yes esbuild@0.25.0 scripts/test-meshops.ts --bundle --platform=node --format=esm \
//     --outfile=/tmp/meshops-test.mjs && node /tmp/meshops-test.mjs

import type { MeshData, Vec3 } from '../src/core/types';
import {
  createMeshData, primCube, primPlane, primGrid, primCylinder, edgeKey, flushSelection, selectAllMesh,
  polyNormal, cross, dot, length, sub, type SelectMode,
} from '../src/core/mesh';
import * as ops from '../src/core/meshops';
import { bevelMesh } from '../src/core/bevel';
import { primMonkey } from '../src/core/monkey';

// ------------------------------------------------------------------ harness

let passed = 0, failed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    const msg = e instanceof Error ? e.message : String(e);
    failures.push(`${name}: ${msg}`);
    console.log(`  FAIL ${name}\n       ${msg}`);
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
function eq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`);
}
function near(actual: number, expected: number, msg: string, eps = 1e-6): void {
  if (Math.abs(actual - expected) > eps) throw new Error(`${msg}: expected ${expected}, got ${actual}`);
}
function nearVec(a: Vec3, b: Vec3, msg: string, eps = 1e-6): void {
  if (length(sub(a, b)) > eps) throw new Error(`${msg}: expected [${b.join(', ')}], got [${a.join(', ')}]`);
}

// ------------------------------------------------------------------ fixtures

let idc = 0;
const mk = (g: { verts: Vec3[]; faces: number[][]; edges?: [number, number][] }) =>
  createMeshData(`m${idc++}`, 'Mesh', g.verts, g.faces, g.edges ?? []);
const cube = () => mk(primCube());
const plane = () => mk(primPlane());
const grid = (x = 4, y = 4) => mk(primGrid(x, y));
const cylinder = (n = 8) => mk(primCylinder(n));

function selectFaces(md: MeshData, faces: number[]): void {
  selectAllMesh(md, false);
  for (const f of faces) md.fsel[f] = true;
  flushSelection(md, 'FACE');
}
function selectVerts(md: MeshData, verts: number[]): void {
  selectAllMesh(md, false);
  for (const v of verts) md.vsel[v] = true;
  flushSelection(md, 'VERT');
}
function selectEdges(md: MeshData, edges: [number, number][]): void {
  selectAllMesh(md, false);
  const keys = new Set(edges.map(([a, b]) => edgeKey(a, b)));
  md.edges.forEach((e, i) => { md.esel[i] = keys.has(edgeKey(e[0], e[1])); });
  flushSelection(md, 'EDGE');
}
function selectAll(md: MeshData): void { selectAllMesh(md, true); }
const count = (a: boolean[]) => a.filter(Boolean).length;
const edgeIndex = (md: MeshData, a: number, b: number) => md.edges.findIndex((e) => edgeKey(e[0], e[1]) === edgeKey(a, b));

/** Signed volume (positive for a closed, outward wound mesh). */
function volume(md: MeshData): number {
  let v = 0;
  for (const f of md.faces) {
    const p0 = md.verts[f[0]];
    for (let i = 1; i < f.length - 1; i++) v += dot(p0, cross(md.verts[f[i]], md.verts[f[i + 1]])) / 6;
  }
  return v;
}

/** Structural invariants; with `closed` also manifold + consistent winding + outward. */
function checkInvariants(md: MeshData, closed = false): void {
  const nv = md.verts.length, ne = md.edges.length, nf = md.faces.length;
  eq(md.vsel.length, nv, 'vsel length');
  eq(md.esel.length, ne, 'esel length');
  eq(md.fsel.length, nf, 'fsel length');
  eq(md.faceSmooth.length, nf, 'faceSmooth length');
  eq(md.faceMat.length, nf, 'faceMat length');
  assert(md.activeFace >= -1 && md.activeFace < nf, `activeFace ${md.activeFace} out of range`);
  for (const p of md.verts) assert(p.length === 3 && p.every(Number.isFinite), `bad vert ${p}`);
  const ekeys = new Set<string>();
  for (const [a, b] of md.edges) {
    assert(Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b < nv, `edge index out of range ${a},${b}`);
    assert(a < b, `edge not ordered ${a},${b}`);
    const k = edgeKey(a, b);
    assert(!ekeys.has(k), `duplicate edge ${k}`);
    ekeys.add(k);
  }
  const directed = new Map<string, number>();
  const use = new Map<string, number>();
  md.faces.forEach((f, fi) => {
    assert(f.length >= 3, `degenerate face ${fi}: ${f}`);
    assert(new Set(f).size === f.length, `duplicate verts in face ${fi}: ${f}`);
    for (let k = 0; k < f.length; k++) {
      const a = f[k], b = f[(k + 1) % f.length];
      assert(Number.isInteger(a) && a >= 0 && a < nv, `face ${fi} index out of range`);
      const key = edgeKey(a, b);
      assert(ekeys.has(key), `face ${fi} edge ${key} missing from edges`);
      use.set(key, (use.get(key) ?? 0) + 1);
      const dk = `${a}>${b}`;
      directed.set(dk, (directed.get(dk) ?? 0) + 1);
    }
  });
  if (closed) {
    for (const [a, b] of md.edges) {
      const k = edgeKey(a, b);
      eq(use.get(k) ?? 0, 2, `edge ${k} face count (manifold)`);
      eq(directed.get(`${a}>${b}`) ?? 0, 1, `edge ${k} winding (${a}>${b})`);
      eq(directed.get(`${b}>${a}`) ?? 0, 1, `edge ${k} winding (${b}>${a})`);
    }
    assert(volume(md) > 1e-9, `closed mesh should be wound outward (volume ${volume(md)})`);
  }
}

function moveSelected(md: MeshData, d: Vec3): void {
  md.verts.forEach((p, i) => { if (md.vsel[i]) md.verts[i] = [p[0] + d[0], p[1] + d[1], p[2] + d[2]]; });
}

// ------------------------------------------------------------------ extrude

console.log('extrude');
test('extrudeRegion cube top face -> 12 verts, 10 faces, closed', () => {
  const m = cube();
  selectFaces(m, [1]);
  m.activeFace = 1;
  const { normal } = ops.extrudeRegion(m, 'FACE');
  eq(m.verts.length, 12, 'verts');
  eq(m.faces.length, 10, 'faces');
  nearVec(normal, [0, 0, 1], 'normal');
  eq(count(m.fsel), 1, 'selected faces');
  eq(count(m.vsel), 4, 'selected verts');
  eq(count(m.esel), 4, 'selected edges');
  assert(m.fsel[m.activeFace], 'active face moved to new top');
  moveSelected(m, [0, 0, 1]);
  checkInvariants(m, true);
  near(volume(m), 12, 'volume');
});
test('extrudeRegion lone plane keeps the flipped original (closed box)', () => {
  const m = plane();
  selectAll(m);
  const { normal } = ops.extrudeRegion(m, 'FACE');
  eq(m.verts.length, 8, 'verts');
  eq(m.faces.length, 6, 'faces');
  nearVec(normal, [0, 0, 1], 'normal');
  moveSelected(m, [0, 0, 1]);
  checkInvariants(m, true);
  near(volume(m), 4, 'volume');
});
test('extrudeRegion two adjacent cube faces as one region', () => {
  const m = cube();
  selectFaces(m, [1, 2]);
  const { normal } = ops.extrudeRegion(m, 'FACE');
  eq(m.verts.length, 14, 'verts');
  eq(m.faces.length, 12, 'faces');
  nearVec(normal, [Math.SQRT1_2, 0, Math.SQRT1_2], 'normal');
  moveSelected(m, [0.5, 0, 0.5]);
  checkInvariants(m, true);
});
test('extrudeRegion grid 2x2 block removes the interior vertex', () => {
  const m = grid(4, 4);
  selectFaces(m, [0, 1, 3, 4]);
  ops.extrudeRegion(m, 'FACE');
  eq(m.verts.length, 24, 'verts');
  eq(m.faces.length, 17, 'faces');
  eq(count(m.fsel), 4, 'selected faces');
  checkInvariants(m);
});
test('extrudeRegion whole grid (isolated) gives a closed slab', () => {
  const m = grid(4, 4);
  selectAll(m);
  ops.extrudeRegion(m, 'FACE');
  eq(m.verts.length, 32, 'verts');
  eq(m.faces.length, 30, 'faces');
  moveSelected(m, [0, 0, 1]);
  checkInvariants(m, true);
  near(volume(m), 4, 'volume');
});
test('extrudeRegion edge (vertex mode) -> quad, zero normal', () => {
  const m = mk({ verts: [[0, 0, 0], [1, 0, 0]], faces: [], edges: [[0, 1]] });
  selectVerts(m, [0, 1]);
  const { normal } = ops.extrudeRegion(m, 'VERT');
  eq(m.verts.length, 4, 'verts');
  eq(m.faces.length, 1, 'faces');
  nearVec(normal, [0, 0, 0], 'normal');
  eq(count(m.vsel), 2, 'selected verts');
  eq(count(m.fsel), 0, 'selected faces');
  checkInvariants(m);
});
test('extrudeRegion lone vertex -> edge', () => {
  const m = mk({ verts: [[0, 0, 0]], faces: [] });
  selectVerts(m, [0]);
  ops.extrudeRegion(m, 'VERT');
  eq(m.verts.length, 2, 'verts');
  eq(m.edges.length, 1, 'edges');
  eq(m.vsel[1], true, 'new vert selected');
  eq(m.vsel[0], false, 'old vert deselected');
  checkInvariants(m);
});
test('extrudeRegion cube edge orients quad against a neighbour', () => {
  const m = cube();
  selectVerts(m, [4, 5]);
  ops.extrudeRegion(m, 'EDGE');
  eq(m.verts.length, 10, 'verts');
  eq(m.faces.length, 7, 'faces');
  const nf = m.faces[6];
  const a = nf.indexOf(4), b = nf.indexOf(5);
  assert(a >= 0 && b >= 0, 'new quad uses the edge');
  checkInvariants(m);
});
test('extrudeRegion with nothing selected is a no-op', () => {
  const m = cube();
  selectAllMesh(m, false);
  const r = ops.extrudeRegion(m, 'FACE');
  eq(m.verts.length, 8, 'verts');
  nearVec(r.normal, [0, 0, 0], 'normal');
});
test('extrudeIndividual', () => {
  const m = cube();
  selectFaces(m, [1]);
  ops.extrudeIndividual(m);
  eq(m.verts.length, 12, 'verts');
  eq(m.faces.length, 10, 'faces');
  moveSelected(m, [0, 0, 1]);
  checkInvariants(m, true);
  const m2 = cube();
  selectFaces(m2, [1, 2]);
  ops.extrudeIndividual(m2);
  eq(m2.verts.length, 16, 'verts (2 faces)');
  eq(m2.faces.length, 14, 'faces (2 faces)');
  eq(count(m2.fsel), 2, 'selected faces');
  checkInvariants(m2);
});
test('extrudeEdgesOnly / extrudeVertsOnly', () => {
  const m = plane();
  selectAll(m);
  ops.extrudeEdgesOnly(m);
  eq(m.verts.length, 8, 'verts');
  eq(m.faces.length, 5, 'faces');
  eq(count(m.fsel), 0, 'no face selected');
  eq(count(m.esel), 4, 'new edges selected');
  checkInvariants(m);
  const m2 = plane();
  selectAll(m2);
  ops.extrudeVertsOnly(m2);
  eq(m2.verts.length, 8, 'verts');
  eq(m2.edges.length, 8, 'edges');
  eq(m2.faces.length, 1, 'faces');
  checkInvariants(m2);
});

// ------------------------------------------------------------------ delete

console.log('delete');
test('deleteElements VERT', () => {
  const m = cube();
  selectVerts(m, [0]);
  ops.deleteElements(m, 'VERT');
  eq(m.verts.length, 7, 'verts');
  eq(m.faces.length, 3, 'faces');
  eq(m.edges.length, 9, 'edges');
  eq(count(m.vsel), 0, 'nothing selected');
  checkInvariants(m);
});
test('deleteElements EDGE', () => {
  const m = cube();
  selectVerts(m, [4, 5]);
  ops.deleteElements(m, 'EDGE');
  eq(m.verts.length, 8, 'verts');
  eq(m.faces.length, 4, 'faces');
  eq(m.edges.length, 11, 'edges');
  checkInvariants(m);
  const m2 = mk({ verts: [[0, 0, 0], [1, 0, 0], [2, 0, 0]], faces: [], edges: [[0, 1], [1, 2]] });
  selectEdges(m2, [[0, 1]]);
  ops.deleteElements(m2, 'EDGE');
  eq(m2.verts.length, 2, 'verts left after deleting wire edge');
  eq(m2.edges.length, 1, 'edges');
  checkInvariants(m2);
});
test('deleteElements FACE', () => {
  const m = cube();
  selectFaces(m, [1]);
  ops.deleteElements(m, 'FACE');
  eq(m.verts.length, 8, 'verts');
  eq(m.faces.length, 5, 'faces');
  eq(m.edges.length, 12, 'edges');
  checkInvariants(m);
  const m2 = cube();
  selectFaces(m2, [1, 2]);
  ops.deleteElements(m2, 'FACE');
  eq(m2.faces.length, 4, 'faces');
  eq(m2.edges.length, 11, 'edges');
  eq(m2.verts.length, 8, 'verts');
  checkInvariants(m2);
  const m3 = mk({ verts: [...primPlane().verts, [5, 0, 0], [6, 0, 0]], faces: primPlane().faces, edges: [[4, 5]] });
  selectFaces(m3, [0]);
  ops.deleteElements(m3, 'FACE');
  eq(m3.verts.length, 2, 'only loose edge verts left');
  eq(m3.edges.length, 1, 'loose edge kept');
  eq(m3.faces.length, 0, 'faces');
  checkInvariants(m3);
});
test('deleteElements EDGE_FACE / ONLY_FACE', () => {
  const m = plane();
  selectAll(m);
  ops.deleteElements(m, 'EDGE_FACE');
  eq(m.faces.length, 0, 'faces');
  eq(m.edges.length, 0, 'edges');
  eq(m.verts.length, 4, 'verts kept');
  checkInvariants(m);
  const m2 = plane();
  selectAll(m2);
  ops.deleteElements(m2, 'ONLY_FACE');
  eq(m2.faces.length, 0, 'faces');
  eq(m2.edges.length, 4, 'edges kept');
  eq(m2.verts.length, 4, 'verts kept');
  checkInvariants(m2);
});
test('deleteLoose', () => {
  const pp = primPlane();
  const m = mk({ verts: [...pp.verts, [5, 0, 0], [6, 0, 0], [7, 0, 0]], faces: pp.faces, edges: [[5, 6]] });
  eq(ops.deleteLoose(m), 4, 'removed count (1 edge + 3 verts)');
  eq(m.verts.length, 4, 'verts');
  eq(m.edges.length, 4, 'edges');
  eq(m.faces.length, 1, 'faces');
  checkInvariants(m);
});

// ------------------------------------------------------------------ make edge/face

console.log('make edge/face');
test('makeEdgeFace: 2 verts -> edge, 1 vert -> error', () => {
  const m = mk({ verts: [[0, 0, 0], [1, 0, 0]], faces: [] });
  selectVerts(m, [0]);
  assert(typeof ops.makeEdgeFace(m) === 'string', 'error expected');
  selectVerts(m, [0, 1]);
  eq(ops.makeEdgeFace(m), null, 'result');
  eq(m.edges.length, 1, 'edges');
  checkInvariants(m);
});
test('makeEdgeFace: closes a hole consistently with neighbours', () => {
  const m = cube();
  selectFaces(m, [1]);
  ops.deleteElements(m, 'ONLY_FACE');
  selectVerts(m, [4, 5, 6, 7]);
  eq(ops.makeEdgeFace(m), null, 'result');
  eq(m.faces.length, 6, 'faces');
  checkInvariants(m, true);
  eq(count(m.fsel), 1, 'new face selected');
  eq(ops.makeEdgeFace(m), 'Face already exists', 'second call');
});
test('makeEdgeFace: 3 / 4 loose verts sorted, facing +Z', () => {
  const m = mk({ verts: [[0, 0, 0], [1, 1, 0], [1, 0, 0], [0, 1, 0]], faces: [] });
  selectVerts(m, [0, 1, 2, 3]);
  eq(ops.makeEdgeFace(m), null, 'result');
  eq(m.faces.length, 1, 'faces');
  eq(m.edges.length, 4, 'edges (no bow-tie)');
  assert(polyNormal(m.verts, m.faces[0])[2] > 0.99, 'faces +Z');
  checkInvariants(m);
  const t = mk({ verts: [[0, 0, 0], [0, 1, 0], [1, 0, 0]], faces: [] });
  selectVerts(t, [0, 1, 2]);
  eq(ops.makeEdgeFace(t), null, 'tri');
  assert(polyNormal(t.verts, t.faces[0])[2] > 0.99, 'tri faces +Z');
  checkInvariants(t);
});
test('makeEdgeFace: open chain of 5 verts closes into a pentagon', () => {
  const pts: Vec3[] = [];
  for (let i = 0; i < 5; i++) pts.push([Math.cos((i * 2 * Math.PI) / 5), Math.sin((i * 2 * Math.PI) / 5), 0]);
  const m = mk({ verts: pts, faces: [], edges: [[0, 1], [1, 2], [2, 3], [3, 4]] });
  selectVerts(m, [0, 1, 2, 3, 4]);
  eq(ops.makeEdgeFace(m), null, 'result');
  eq(m.faces.length, 1, 'faces');
  eq(m.faces[0].length, 5, 'pentagon');
  eq(m.edges.length, 5, 'edges');
  checkInvariants(m);
});

// ------------------------------------------------------------------ subdivide

console.log('subdivide');
test('subdivide cube, 1 cut -> 26 verts, 24 faces', () => {
  const m = cube();
  selectAll(m);
  ops.subdivide(m, 1);
  eq(m.verts.length, 26, 'verts');
  eq(m.faces.length, 24, 'faces');
  eq(count(m.vsel), 26, 'all verts selected');
  eq(count(m.fsel), 24, 'all faces selected');
  checkInvariants(m, true);
  near(volume(m), 8, 'volume unchanged');
});
test('subdivide cube, 2 cuts -> 56 verts, 54 faces', () => {
  const m = cube();
  selectAll(m);
  ops.subdivide(m, 2);
  eq(m.verts.length, 56, 'verts');
  eq(m.faces.length, 54, 'faces');
  checkInvariants(m, true);
  near(volume(m), 8, 'volume unchanged');
});
test('subdivide triangle 1 and 2 cuts', () => {
  const t = () => mk({ verts: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], faces: [[0, 1, 2]] });
  const m = t();
  selectAll(m);
  ops.subdivide(m, 1);
  eq(m.verts.length, 6, 'verts');
  eq(m.faces.length, 4, 'faces');
  for (const f of m.faces) assert(polyNormal(m.verts, f)[2] > 0.99, 'winding kept');
  checkInvariants(m);
  const m2 = t();
  selectAll(m2);
  ops.subdivide(m2, 2);
  eq(m2.verts.length, 10, 'verts (2 cuts)');
  eq(m2.faces.length, 9, 'faces (2 cuts)');
  for (const f of m2.faces) assert(polyNormal(m2.verts, f)[2] > 0.99, 'winding kept (2 cuts)');
  checkInvariants(m2);
});
test('subdivide cylinder (n-gon caps -> quad fans)', () => {
  const m = cylinder(8);
  selectAll(m);
  ops.subdivide(m, 1);
  // 16 + 24 edge cuts + 8 side-quad centres + 2 cap centres
  eq(m.verts.length, 50, 'verts');
  eq(m.faces.length, 48, 'faces');
  checkInvariants(m, true);
  const m2 = cylinder(8);
  selectAll(m2);
  ops.subdivide(m2, 2);
  checkInvariants(m2, true);
});
test('subdivide single cube edge keeps the mesh watertight', () => {
  const m = cube();
  selectVerts(m, [4, 5]);
  ops.subdivide(m, 1);
  eq(m.verts.length, 9, 'verts');
  eq(m.faces.length, 6, 'faces');
  eq(count(m.vsel), 3, 'selected verts');
  eq(count(m.esel), 2, 'selected edges');
  checkInvariants(m, true);
});
test('subdivide vertical cube edges -> strips (like a loop cut)', () => {
  const m = cube();
  selectEdges(m, [[0, 4], [1, 5], [2, 6], [3, 7]]);
  ops.subdivide(m, 1);
  eq(m.verts.length, 12, 'verts');
  eq(m.faces.length, 10, 'faces');
  checkInvariants(m, true);
});
test('subdivide two adjacent quad edges -> inner vert pattern (all quads)', () => {
  const m = plane();
  selectEdges(m, [[0, 1], [1, 2]]);
  ops.subdivide(m, 1);
  eq(m.verts.length, 7, 'verts');
  eq(m.faces.length, 3, 'faces');
  assert(m.faces.every((f) => f.length === 4), 'all quads');
  for (const f of m.faces) assert(polyNormal(m.verts, f)[2] > 0.99, 'winding kept');
  checkInvariants(m);
  const m2 = plane();
  selectEdges(m2, [[0, 1], [1, 2]]);
  ops.subdivide(m2, 2);
  eq(m2.verts.length, 10, 'verts (2 cuts)');
  eq(m2.faces.length, 5, 'faces (2 cuts)');
  for (const f of m2.faces) assert(polyNormal(m2.verts, f)[2] > 0.99, 'winding kept (2 cuts)');
  checkInvariants(m2);
});
test('subdivide smoothness bulges new verts outward', () => {
  const m = cube();
  selectAll(m);
  ops.subdivide(m, 1, 1);
  const r = Math.max(...m.verts.slice(8).map((p) => length(p)));
  assert(r > Math.SQRT2 + 0.05, `edge midpoints should move out (max radius ${r})`);
  checkInvariants(m, true);
});
test('subdivide loose edge', () => {
  const m = mk({ verts: [[0, 0, 0], [2, 0, 0]], faces: [], edges: [[0, 1]] });
  selectAll(m);
  ops.subdivide(m, 3);
  eq(m.verts.length, 5, 'verts');
  eq(m.edges.length, 4, 'edges');
  checkInvariants(m);
});

// ------------------------------------------------------------------ edge ring / loop cut

console.log('edge ring / loop cut');
test('edgeRing on cube / grid / cylinder', () => {
  const m = cube();
  eq(ops.edgeRing(m, edgeIndex(m, 0, 4)).length, 4, 'cube ring');
  const g = grid(4, 4);
  const r = ops.edgeRing(g, edgeIndex(g, 0, 4));
  eq(r.length, 4, 'grid ring (open)');
  const c = cylinder(8);
  eq(ops.edgeRing(c, edgeIndex(c, 0, 8)).length, 8, 'cylinder side ring');
  eq(ops.edgeRing(c, edgeIndex(c, 0, 1)).length, 2, 'cylinder ring stops at n-gon caps');
});
test('loopCut cube 1 cut -> 12 verts, 10 faces', () => {
  const m = cube();
  const nv = ops.loopCut(m, edgeIndex(m, 0, 4), 1);
  eq(nv.length, 4, 'new verts');
  eq(m.verts.length, 12, 'verts');
  eq(m.faces.length, 10, 'faces');
  eq(count(m.vsel), 4, 'selected verts');
  eq(count(m.esel), 4, 'selected edges (the loop)');
  eq(count(m.fsel), 0, 'selected faces');
  for (const v of nv) near(m.verts[v][2], 0, 'cut in the middle');
  checkInvariants(m, true);
});
test('loopCut cube 2 cuts', () => {
  const m = cube();
  ops.loopCut(m, edgeIndex(m, 0, 4), 2);
  eq(m.verts.length, 16, 'verts');
  eq(m.faces.length, 14, 'faces');
  checkInvariants(m, true);
});
test('loopCut plane (open ring) + factor', () => {
  const m = plane();
  const ei = edgeIndex(m, 0, 1);
  const nv = ops.loopCut(m, ei, 1, 0.5);
  eq(m.verts.length, 6, 'verts');
  eq(m.faces.length, 2, 'faces');
  // edge 0->1 goes from x=-1 to x=1; factor 0.5 puts the cut at t=0.75 -> x=0.5
  near(m.verts[nv[0]][0], 0.5, 'slid cut');
  for (const f of m.faces) assert(polyNormal(m.verts, f)[2] > 0.99, 'winding kept');
  checkInvariants(m);
});
test('loopCut grid open ring', () => {
  const m = grid(4, 4);
  ops.loopCut(m, edgeIndex(m, 0, 4), 1);
  eq(m.verts.length, 20, 'verts');
  eq(m.faces.length, 12, 'faces');
  checkInvariants(m);
});
test('loopCut cylinder (closed ring around the side, and ring ending at caps)', () => {
  const m = cylinder(8);
  ops.loopCut(m, edgeIndex(m, 0, 8), 1);
  eq(m.verts.length, 24, 'verts');
  eq(m.faces.length, 18, 'faces');
  checkInvariants(m, true);
  const m2 = cylinder(8);
  ops.loopCut(m2, edgeIndex(m2, 0, 1), 1);
  eq(m2.verts.length, 18, 'verts');
  eq(m2.faces.length, 11, 'faces');
  checkInvariants(m2, true);
});

// ------------------------------------------------------------------ inset

console.log('inset');
test('inset plane -> 8 verts, 5 faces', () => {
  const m = plane();
  selectAll(m);
  ops.inset(m, 0.2);
  eq(m.verts.length, 8, 'verts');
  eq(m.faces.length, 5, 'faces');
  eq(count(m.fsel), 1, 'inner face selected');
  const inner = m.faces[m.fsel.indexOf(true)];
  for (const v of inner) { near(Math.abs(m.verts[v][0]), 0.8, 'inner x'); near(Math.abs(m.verts[v][1]), 0.8, 'inner y'); }
  for (const f of m.faces) assert(polyNormal(m.verts, f)[2] > 0.99, 'winding kept');
  checkInvariants(m);
});
test('inset depth', () => {
  const m = plane();
  selectAll(m);
  ops.inset(m, 0.2, 0.5);
  const inner = m.faces[m.fsel.indexOf(true)];
  for (const v of inner) near(m.verts[v][2], 0.5, 'inner z');
  checkInvariants(m);
});
test('inset cube faces (single, region, individual)', () => {
  const m = cube();
  selectFaces(m, [1]);
  ops.inset(m, 0.3);
  eq(m.verts.length, 12, 'verts');
  eq(m.faces.length, 10, 'faces');
  checkInvariants(m, true);
  const m2 = cube();
  selectFaces(m2, [1, 2]);
  ops.inset(m2, 0.3);
  eq(m2.verts.length, 14, 'verts (region)');
  eq(m2.faces.length, 12, 'faces (region)');
  eq(count(m2.fsel), 2, 'inner faces selected');
  checkInvariants(m2, true);
  const m3 = cube();
  selectFaces(m3, [1, 2]);
  ops.inset(m3, 0.3, 0, true);
  eq(m3.verts.length, 16, 'verts (individual)');
  eq(m3.faces.length, 14, 'faces (individual)');
  checkInvariants(m3, true);
});
test('inset whole grid region keeps interior verts', () => {
  const m = grid(4, 4);
  selectAll(m);
  ops.inset(m, 0.1);
  eq(m.verts.length, 28, 'verts');
  eq(m.faces.length, 21, 'faces');
  checkInvariants(m);
});

// ------------------------------------------------------------------ merge / doubles

console.log('merge / remove doubles');
test('mergeVerts CENTER on plane', () => {
  const m = plane();
  selectAll(m);
  eq(ops.mergeVerts(m, 'CENTER', [0, 0, 0]), 3, 'removed');
  eq(m.verts.length, 1, 'verts');
  eq(m.faces.length, 0, 'faces');
  eq(m.edges.length, 0, 'edges');
  nearVec(m.verts[0], [0, 0, 0], 'position');
  checkInvariants(m);
});
test('mergeVerts CENTER cube top -> pyramid', () => {
  const m = cube();
  selectVerts(m, [4, 5, 6, 7]);
  eq(ops.mergeVerts(m, 'CENTER', [0, 0, 0]), 3, 'removed');
  eq(m.verts.length, 5, 'verts');
  eq(m.faces.length, 5, 'faces');
  eq(m.edges.length, 8, 'edges');
  checkInvariants(m, true);
});
test('mergeVerts CURSOR / FIRST / LAST', () => {
  const m = plane();
  selectVerts(m, [0, 1]);
  ops.mergeVerts(m, 'CURSOR', [0, -3, 0]);
  eq(m.verts.length, 3, 'verts');
  eq(m.faces.length, 1, 'faces (now a triangle)');
  eq(m.faces[0].length, 3, 'triangle');
  assert(m.verts.some((p) => Math.abs(p[1] + 3) < 1e-9), 'merged at cursor');
  checkInvariants(m);
  const m2 = plane();
  selectVerts(m2, [0, 1]);
  ops.mergeVerts(m2, 'FIRST', [0, 0, 0], 1);
  assert(m2.verts.some((p) => length(sub(p, [1, -1, 0])) < 1e-9), 'merged at first');
  checkInvariants(m2);
  const m3 = plane();
  selectVerts(m3, [0, 1]);
  ops.mergeVerts(m3, 'LAST', [0, 0, 0], undefined, 0);
  assert(m3.verts.some((p) => length(sub(p, [-1, -1, 0])) < 1e-9), 'merged at last');
  const m4 = plane();
  selectVerts(m4, [0, 1]);
  ops.mergeVerts(m4, 'LAST', [0, 0, 0]);
  assert(m4.verts.some((p) => length(sub(p, [0, -1, 0])) < 1e-9), 'fallback to center');
});
test('mergeVerts COLLAPSE merges each island separately', () => {
  const m = grid(4, 4);
  selectEdges(m, [[0, 1], [14, 15]]);
  eq(ops.mergeVerts(m, 'COLLAPSE', [0, 0, 0]), 2, 'removed');
  eq(m.verts.length, 14, 'verts');
  eq(m.faces.length, 9, 'faces');
  checkInvariants(m);
});
test('removeDoubles welds an unwelded cube', () => {
  const c = primCube();
  const verts: Vec3[] = [];
  const faces = c.faces.map((f) => f.map((v) => { verts.push([...c.verts[v]] as Vec3); return verts.length - 1; }));
  const m = mk({ verts, faces });
  eq(m.verts.length, 24, 'verts before');
  selectAll(m);
  eq(ops.removeDoubles(m, 0.0001), 16, 'removed');
  eq(m.verts.length, 8, 'verts');
  eq(m.edges.length, 12, 'edges');
  checkInvariants(m, true);
  const m2 = mk({ verts: verts.map((p) => [p[0] + 1e-6, p[1], p[2]] as Vec3), faces });
  selectAllMesh(m2, false);
  eq(ops.removeDoubles(m2, 0.0001, true), 0, 'only selected -> nothing');
  eq(ops.removeDoubles(m2, 0.0001, false), 16, 'all');
  checkInvariants(m2, true);
});

// ------------------------------------------------------------------ normals

console.log('normals');
test('flipNormals / recalcNormals', () => {
  const m = plane();
  selectAll(m);
  ops.flipNormals(m);
  assert(polyNormal(m.verts, m.faces[0])[2] < -0.99, 'flipped');
  checkInvariants(m);
  const c = cube();
  selectFaces(c, [0, 3]);
  ops.flipNormals(c);
  selectAll(c);
  ops.recalcNormals(c);
  checkInvariants(c, true);
  ops.recalcNormals(c, true);
  assert(volume(c) < 0, 'inside');
});

// ------------------------------------------------------------------ duplicate / separate / split

console.log('duplicate / separate / split');
test('duplicateSelected', () => {
  const m = cube();
  selectFaces(m, [1]);
  ops.duplicateSelected(m);
  eq(m.verts.length, 12, 'verts');
  eq(m.faces.length, 7, 'faces');
  eq(m.edges.length, 16, 'edges');
  eq(count(m.vsel), 4, 'selected verts');
  assert(m.vsel.slice(8).every(Boolean), 'copy selected');
  eq(count(m.fsel), 1, 'one face selected');
  eq(m.fsel[6], true, 'copy face selected');
  eq(count(m.esel), 4, 'selected edges');
  checkInvariants(m);
});
test('separateSelected', () => {
  const m = cube();
  selectFaces(m, [1]);
  const part = ops.separateSelected(m)!;
  assert(part, 'part');
  eq(part.verts.length, 4, 'part verts');
  eq(part.faces.length, 1, 'part faces');
  eq(part.edges.length, 4, 'part edges');
  eq(part.faceSmooth.length, 1, 'part faceSmooth');
  eq(m.verts.length, 8, 'md verts (shared verts kept)');
  eq(m.faces.length, 5, 'md faces');
  eq(m.edges.length, 12, 'md edges');
  checkInvariants(m);
  checkInvariants(createMeshData('p', 'p', part.verts, part.faces, part.edges));
  selectAllMesh(m, false);
  eq(ops.separateSelected(m), null, 'nothing selected');
  selectAll(m);
  const all = ops.separateSelected(m)!;
  eq(all.verts.length, 8, 'everything');
  eq(m.verts.length, 0, 'md empty');
  checkInvariants(m);
});
test('separateLoose', () => {
  const c = primCube(), p = primPlane();
  const verts = [...c.verts, ...p.verts.map((v) => [v[0] + 5, v[1], v[2]] as Vec3), [9, 9, 9] as Vec3];
  const faces = [...c.faces, ...p.faces.map((f) => f.map((v) => v + 8))];
  const m = mk({ verts, faces });
  const parts = ops.separateLoose(m);
  eq(parts.length, 2, 'parts');
  eq(m.verts.length, 8, 'md keeps cube');
  checkInvariants(m, true);
  eq(parts[0].verts.length, 4, 'plane part');
  eq(parts[0].faces.length, 1, 'plane face');
  eq(parts[1].verts.length, 1, 'loose vert part');
});
test('splitSelected', () => {
  const m = cube();
  selectFaces(m, [1]);
  ops.splitSelected(m);
  eq(m.verts.length, 12, 'verts');
  eq(m.faces.length, 6, 'faces');
  eq(m.edges.length, 16, 'edges');
  eq(count(m.fsel), 1, 'split face selected');
  eq(count(m.vsel), 4, 'split verts selected');
  checkInvariants(m);
});

// ------------------------------------------------------------------ smooth / randomize

console.log('smooth / randomize');
test('smoothVerts', () => {
  const m = grid(4, 4);
  m.verts[5][2] = 1;
  selectAll(m);
  ops.smoothVerts(m, 0.5, 1);
  assert(m.verts[5][2] < 1 && m.verts[5][2] > 0, 'bump smoothed');
  near(m.verts[1][1], -1, 'boundary vert stays on boundary');
  const m2 = grid(4, 4);
  m2.verts[5][2] = 1;
  selectAll(m2);
  ops.smoothVerts(m2, 0.5, 1, [true, true, false]);
  near(m2.verts[5][2], 1, 'z axis locked');
  checkInvariants(m);
});
test('randomizeVerts deterministic', () => {
  const a = grid(4, 4), b = grid(4, 4), c = grid(4, 4);
  for (const m of [a, b, c]) selectVerts(m, [0, 1, 2, 3, 4, 5]);
  ops.randomizeVerts(a, 0.1, 7);
  ops.randomizeVerts(b, 0.1, 7);
  ops.randomizeVerts(c, 0.1, 8);
  assert(JSON.stringify(a.verts) === JSON.stringify(b.verts), 'same seed same result');
  assert(JSON.stringify(a.verts) !== JSON.stringify(c.verts), 'different seed differs');
  const g = grid(4, 4);
  nearVec(a.verts[10], g.verts[10], 'unselected unchanged');
  for (let i = 0; i < 6; i++) assert(length(sub(a.verts[i], g.verts[i])) <= 0.1 + 1e-9, 'within amount');
  const n = grid(4, 4);
  selectAll(n);
  ops.randomizeVerts(n, 0.1, 1, 0, 1);
  for (let i = 0; i < 16; i++) { near(n.verts[i][0], g.verts[i][0], 'normal only x'); near(n.verts[i][1], g.verts[i][1], 'normal only y'); }
});

// ------------------------------------------------------------------ tris / quads / dissolve

console.log('tris / quads / dissolve');
test('quadsToTris', () => {
  const m = cube();
  selectAll(m);
  ops.quadsToTris(m);
  eq(m.faces.length, 12, 'faces');
  eq(m.edges.length, 18, 'edges');
  checkInvariants(m, true);
  const c = cylinder(8);
  selectAll(c);
  ops.quadsToTris(c);
  eq(c.faces.length, 28, 'cylinder faces');
  checkInvariants(c, true);
});
test('trisToQuads', () => {
  const m = cube();
  selectAll(m);
  ops.quadsToTris(m);
  ops.trisToQuads(m);
  eq(m.faces.length, 6, 'faces');
  eq(m.edges.length, 12, 'edges');
  assert(m.faces.every((f) => f.length === 4), 'all quads');
  checkInvariants(m, true);
  const c = cylinder(8);
  selectAll(c);
  ops.quadsToTris(c);
  ops.trisToQuads(c);
  checkInvariants(c, true);
  assert(c.faces.length < 28, 'some tris joined');
  // non coplanar pair is not joined
  const t = mk({ verts: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 1]], faces: [[0, 1, 2], [2, 1, 3]] });
  selectAll(t);
  ops.trisToQuads(t, 10);
  eq(t.faces.length, 2, 'folded pair kept');
});
test('dissolveFaces', () => {
  const m = grid(4, 4);
  selectAll(m);
  ops.dissolveFaces(m);
  eq(m.faces.length, 1, 'faces');
  eq(m.verts.length, 12, 'verts');
  eq(m.faces[0].length, 12, 'n-gon');
  eq(m.edges.length, 12, 'edges');
  assert(polyNormal(m.verts, m.faces[0])[2] > 0.99, 'winding kept');
  checkInvariants(m);
  const c = cube();
  selectFaces(c, [1, 2]);
  ops.dissolveFaces(c);
  eq(c.faces.length, 5, 'cube faces');
  eq(c.verts.length, 8, 'cube verts');
  checkInvariants(c, true);
  const c2 = cube();
  selectAll(c2);
  ops.dissolveFaces(c2);
  eq(c2.faces.length, 6, 'closed region unchanged');
  const r = grid(4, 4);
  selectFaces(r, [0, 1, 2, 3, 5, 6, 7, 8]);
  ops.dissolveFaces(r);
  eq(r.faces.length, 9, 'ring region (two loops) unchanged');
});

// ------------------------------------------------------------------ selection

console.log('selection');
test('selectAll', () => {
  const m = cube();
  selectAllMesh(m, false);
  ops.selectAll(m, 'TOGGLE', 'VERT');
  eq(count(m.vsel), 8, 'toggle selects');
  ops.selectAll(m, 'TOGGLE', 'VERT');
  eq(count(m.vsel), 0, 'toggle deselects');
  selectFaces(m, [1]);
  ops.selectAll(m, 'INVERT', 'FACE');
  eq(count(m.fsel), 5, 'invert faces');
  eq(count(m.vsel), 8, 'verts of inverted faces');
  selectVerts(m, [0]);
  ops.selectAll(m, 'INVERT', 'VERT');
  eq(count(m.vsel), 7, 'invert verts');
  eq(count(m.fsel), 3, 'faces flushed');
});
test('selectMore / selectLess', () => {
  const m = grid(5, 5);
  selectVerts(m, [12]);
  ops.selectMore(m, 'VERT');
  eq(count(m.vsel), 9, 'more verts');
  ops.selectLess(m, 'VERT');
  eq(count(m.vsel), 1, 'less verts');
  const g = grid(6, 6); // 5x5 faces, face 12 is the centre
  selectFaces(g, [12]);
  ops.selectMore(g, 'FACE');
  eq(count(g.fsel), 9, 'more faces');
  ops.selectLess(g, 'FACE');
  eq(count(g.fsel), 1, 'less faces');
  eq(g.fsel[12], true, 'centre face kept');
});
test('selectLinked / selectLinkedPick', () => {
  const c = primCube(), p = primPlane();
  const m = mk({ verts: [...c.verts, ...p.verts.map((v) => [v[0] + 5, v[1], v[2]] as Vec3)], faces: [...c.faces, ...p.faces.map((f) => f.map((v) => v + 8))] });
  selectVerts(m, [0]);
  ops.selectLinked(m, 'VERT');
  eq(count(m.vsel), 8, 'cube linked');
  eq(count(m.fsel), 6, 'cube faces');
  ops.selectLinkedPick(m, 9, false, 'VERT');
  eq(count(m.vsel), 12, 'plane picked');
  ops.selectLinkedPick(m, 1, true, 'FACE');
  eq(count(m.fsel), 1, 'cube deselected');
  eq(count(m.vsel), 4, 'plane verts remain');
  selectAllMesh(m, false);
  ops.selectLinkedPick(m, 9, false, 'EDGE');
  eq(count(m.esel), 4, 'edge mode pick');
});
test('selectRandom', () => {
  const a = grid(10, 10), b = grid(10, 10);
  selectAllMesh(a, false); selectAllMesh(b, false);
  ops.selectRandom(a, 50, 3, 'VERT', 'SELECT');
  ops.selectRandom(b, 50, 3, 'VERT', 'SELECT');
  const n = count(a.vsel);
  assert(n > 25 && n < 75, `about half selected (${n})`);
  assert(JSON.stringify(a.vsel) === JSON.stringify(b.vsel), 'deterministic');
  selectAll(a);
  ops.selectRandom(a, 100, 1, 'FACE', 'DESELECT');
  eq(count(a.fsel), 0, 'deselect all faces');
});
test('selectNonManifold / selectLoose', () => {
  const c = cube();
  selectAllMesh(c, false);
  ops.selectNonManifold(c);
  eq(count(c.esel), 0, 'closed cube is manifold');
  selectFaces(c, [1]);
  ops.deleteElements(c, 'ONLY_FACE');
  ops.selectNonManifold(c);
  eq(count(c.esel), 4, 'hole boundary');
  eq(count(c.vsel), 4, 'hole verts');
  const pp = primPlane();
  const m = mk({ verts: [...pp.verts, [5, 0, 0], [6, 0, 0], [7, 0, 0]], faces: pp.faces, edges: [[5, 6]] });
  selectAllMesh(m, false);
  ops.selectLoose(m);
  eq(count(m.vsel), 3, 'loose verts');
  eq(count(m.esel), 1, 'loose edge');
  eq(count(m.fsel), 0, 'no faces');
});
test('selectFaceBySides / selectInteriorFaces / selectSharpEdges', () => {
  const c = cylinder(8);
  selectAllMesh(c, false);
  ops.selectFaceBySides(c, 8, 'EQUAL', false);
  eq(count(c.fsel), 2, 'EQUAL 8');
  ops.selectFaceBySides(c, 5, 'LESS', false);
  eq(count(c.fsel), 8, 'LESS 5');
  ops.selectFaceBySides(c, 4, 'GREATER', true);
  eq(count(c.fsel), 10, 'GREATER 4 extend');
  ops.selectFaceBySides(c, 4, 'NOTEQUAL', false);
  eq(count(c.fsel), 2, 'NOTEQUAL 4');
  // two boxes sharing an inner wall
  const verts: Vec3[] = [];
  for (const x of [0, 1, 2]) for (const [y, z] of [[0, 0], [1, 0], [1, 1], [0, 1]]) verts.push([x, y, z]);
  const q = (x: number) => [x * 4, x * 4 + 1, x * 4 + 2, x * 4 + 3];
  const faces: number[][] = [q(0).reverse(), q(1), q(2)];
  for (const x of [0, 1]) for (let k = 0; k < 4; k++) {
    const a = x * 4 + k, b = x * 4 + ((k + 1) % 4);
    faces.push([a, b, b + 4, a + 4]);
  }
  const w = mk({ verts, faces });
  selectAllMesh(w, false);
  ops.selectInteriorFaces(w);
  eq(count(w.fsel), 1, 'inner wall');
  eq(w.fsel[1], true, 'inner wall is face 1');
  const s = cube();
  selectAllMesh(s, false);
  ops.selectSharpEdges(s, (30 * Math.PI) / 180);
  eq(count(s.esel), 12, 'all cube edges sharp');
  eq(count(s.fsel), 6, 'faces flushed');
  const g = grid(4, 4);
  selectAllMesh(g, false);
  ops.selectSharpEdges(g, (30 * Math.PI) / 180);
  eq(count(g.esel), 0, 'flat grid has none');
});

// ------------------------------------------------------------------ join

console.log('join');
test('joinMeshInto', () => {
  const t = plane();
  t.faceMat = [0];
  const s = cube();
  s.faceMat = [0, 0, 1, 1, 0, 0];
  const mat = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 0, 0, 1];
  ops.joinMeshInto(t, s, mat, [2, 3]);
  eq(t.verts.length, 12, 'verts');
  eq(t.faces.length, 7, 'faces');
  eq(t.edges.length, 16, 'edges');
  nearVec(t.verts[4], [11, 1, -1], 'translated');
  eq(t.faceMat[3], 3, 'material remapped');
  eq(t.faceMat[1], 2, 'material remapped (slot 0)');
  checkInvariants(t);
  const t2 = mk({ verts: [], faces: [] });
  const mirror = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  ops.joinMeshInto(t2, cube(), mirror, []);
  checkInvariants(t2, true);
});

// ------------------------------------------------------------------ mixed sequences

console.log('sequences');
test('extrude -> loopcut -> inset -> subdivide stays closed', () => {
  const m = cube();
  selectFaces(m, [1]);
  ops.extrudeRegion(m, 'FACE');
  moveSelected(m, [0, 0, 1]);
  checkInvariants(m, true);
  ops.loopCut(m, edgeIndex(m, 0, 4), 2);
  checkInvariants(m, true);
  selectFaces(m, [0]);
  ops.inset(m, 0.2, -0.1);
  checkInvariants(m, true);
  selectAll(m);
  ops.subdivide(m, 1);
  checkInvariants(m, true);
  selectAll(m);
  ops.quadsToTris(m);
  ops.trisToQuads(m);
  checkInvariants(m, true);
});
test('modes param accepted for every select mode', () => {
  for (const mode of ['VERT', 'EDGE', 'FACE'] as SelectMode[]) {
    const m = grid(4, 4);
    selectVerts(m, [5]);
    flushSelection(m, mode);
    ops.selectMore(m, mode);
    ops.selectLess(m, mode);
    ops.selectLinked(m, mode);
    checkInvariants(m);
  }
});

// ------------------------------------------------------------------ bevel

console.log('bevel');
const allEdges = (m: MeshData) => { selectAllMesh(m, true); };
test('bevel all cube edges, 1 segment: 24 verts, 26 faces, closed', () => {
  const m = cube();
  allEdges(m);
  assert(bevelMesh(m, { offset: 0.2, segments: 1 }), 'bevelled');
  eq(m.verts.length, 24, 'verts');
  eq(m.faces.length, 26, 'faces');
  checkInvariants(m, true);
  eq(m.faces.filter((f) => f.length === 3).length, 8, 'corner triangles');
});
test('bevel all cube edges, 3 segments: closed quad patches', () => {
  const m = cube();
  allEdges(m);
  bevelMesh(m, { offset: 0.2, segments: 3 });
  eq(m.verts.length, 96, 'verts');
  eq(m.faces.length, 98, 'faces');
  checkInvariants(m, true);
  // every corner vertex lies on the corner sphere (radius = offset)
  for (const p of m.verts) {
    const c = p.map((x) => Math.sign(x) * 0.8) as Vec3;
    const d = sub(p, c).map((x, k) => (Math.abs(p[k]) > 0.8 + 1e-9 ? x : 0)) as Vec3;
    assert(length(d) <= 0.2 + 1e-6, `vertex outside the rounded cube ${p}`);
  }
});
test('bevel all cube edges, 2 and 4 segments stay closed', () => {
  for (const s of [2, 4]) { const m = cube(); allEdges(m); bevelMesh(m, { offset: 0.3, segments: s }); checkInvariants(m, true); }
});
test('bevel one cube edge: pentagon ends', () => {
  const m = cube();
  selectEdges(m, [[0, 1]]);
  bevelMesh(m, { offset: 0.25, segments: 1 });
  eq(m.verts.length, 10, 'verts');
  eq(m.faces.length, 7, 'faces');
  eq(m.faces.filter((f) => f.length === 5).length, 2, 'pentagons');
  checkInvariants(m, true);
  eq(count(m.fsel), 1, 'strip selected');
});
test('bevel one cube edge, 4 segments: rounded ends merged into the end faces', () => {
  const m = cube();
  selectEdges(m, [[0, 1]]);
  bevelMesh(m, { offset: 0.25, segments: 4 });
  eq(m.faces.length, 10, 'faces');
  checkInvariants(m, true);
});
test('bevel top loop of a cube (mitre corners), 1 and 3 segments', () => {
  for (const s of [1, 3]) {
    const m = cube();
    selectEdges(m, [[4, 7], [7, 6], [6, 5], [5, 4]]);
    bevelMesh(m, { offset: 0.2, segments: s });
    eq(m.faces.length, 6 + 4 * s, `faces (${s})`);
    checkInvariants(m, true);
  }
});
test('bevel two edges meeting at a corner', () => {
  const m = cube();
  selectEdges(m, [[4, 7], [4, 5]]);
  bevelMesh(m, { offset: 0.2, segments: 2 });
  checkInvariants(m, true);
});
test('bevel clamps the offset to avoid overlap', () => {
  const m = cube();
  allEdges(m);
  bevelMesh(m, { offset: 5, segments: 2, clampOverlap: true });
  checkInvariants(m, true);
  for (const p of m.verts) for (const x of p) assert(Math.abs(x) <= 1 + 1e-9, 'vertex escaped the cube');
});
test('bevel offset types', () => {
  for (const t of ['WIDTH', 'DEPTH', 'PERCENT'] as const) {
    const m = cube();
    allEdges(m);
    bevelMesh(m, { offset: t === 'PERCENT' ? 10 : 0.2, offsetType: t, segments: 2 });
    checkInvariants(m, true);
  }
  const m = cube();
  selectEdges(m, [[0, 1]]);
  bevelMesh(m, { offset: Math.SQRT2 * 0.25, offsetType: 'WIDTH', segments: 1 });
  assert(m.verts.some((p) => Math.abs(p[0] - 0.75) < 1e-6 && Math.abs(p[2] + 1) < 1e-6), 'width offset on the bottom face');
  assert(m.verts.some((p) => Math.abs(p[0] - 1) < 1e-6 && Math.abs(p[2] + 0.75) < 1e-6), 'width offset on the side face');
});
test('vertex bevel cube corner: triangle, closed', () => {
  const m = cube();
  selectVerts(m, [4]);
  bevelMesh(m, { offset: 0.3, segments: 1, vertexOnly: true });
  eq(m.verts.length, 10, 'verts');
  eq(m.faces.length, 7, 'faces');
  checkInvariants(m, true);
});
test('vertex bevel all cube verts with 3 segments', () => {
  const m = cube();
  selectAll(m);
  bevelMesh(m, { offset: 0.3, segments: 3, vertexOnly: true });
  checkInvariants(m, true);
});
test('vertex bevel plane corners: rounded open corners', () => {
  const m = plane();
  selectAll(m);
  bevelMesh(m, { offset: 0.3, segments: 4, vertexOnly: true });
  eq(m.faces.length, 1, 'faces');
  eq(m.verts.length, 20, 'verts');
  checkInvariants(m);
});
test('bevel grid interior edge loop and boundary-touching loop', () => {
  const m = grid(5, 5);
  selectEdges(m, [[5, 6], [6, 7], [7, 8], [8, 9]]);
  assert(bevelMesh(m, { offset: 0.1, segments: 2 }), 'bevelled');
  checkInvariants(m);
  const m2 = grid(4, 4);
  selectEdges(m2, [[5, 6]]);
  bevelMesh(m2, { offset: 0.1, segments: 1 });
  checkInvariants(m2);
});
test('bevel cylinder rim', () => {
  const m = cylinder(12);
  const top = m.verts.map((p, i) => (p[2] > 0 ? i : -1)).filter((i) => i >= 0);
  selectVerts(m, top);
  flushSelection(m, 'VERT');
  // only rim edges (cap edges are selected too, the cap is an n-gon so its edges are the rim)
  bevelMesh(m, { offset: 0.1, segments: 3 });
  checkInvariants(m, true);
});

// ------------------------------------------------------------------ monkey

console.log('monkey');
test('primMonkey: ~500 verts, quads, closed, mirror symmetric', () => {
  const g = primMonkey(1);
  const m = mk(g);
  assert(m.verts.length > 450 && m.verts.length < 650, `vert count ${m.verts.length}`);
  assert(m.faces.every((f) => f.length === 4), 'all quads');
  checkInvariants(m, true);
  const key = (p: Vec3) => p.map((x) => Math.round(x * 1e5)).join(',');
  const set = new Set(m.verts.map(key));
  for (const p of m.verts) assert(set.has(key([-p[0], p[1], p[2]])), 'mirror counterpart');
  // every separate part is outward wound
  const parts = ops.separateLoose(mk(g));
  for (const part of parts) assert(volume(mk(part)) > 0, 'part wound outward');
  const b = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const p of m.verts) for (let k = 0; k < 3; k++) { b.min[k] = Math.min(b.min[k], p[k]); b.max[k] = Math.max(b.max[k], p[k]); }
  assert(b.max[0] > 1.1 && b.max[0] < 1.5, `ear span ${b.max[0]}`);
  assert(b.min[1] < -0.8, `face points -Y (${b.min[1]})`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  for (const f of failures) console.log(' - ' + f);
  process.exit(1);
}
