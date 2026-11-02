// Rigid body world (Bullet in Blender, cannon-es here). Objects with rigid body
// settings become bodies; dynamic bodies show their simulated transform through a
// world-matrix override while the timeline plays, and the start frame restores the
// original transform. Results are cached per frame (cache.ts).

import * as CANNON from 'cannon-es';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js';
import { app } from '../app';
import { evalMeshFromData, type EvalMesh } from '../core/modifiers';
import { triangulatePoly } from '../core/mesh';
import { MatrixCache, worldMatrixOverrides } from '../core/scene';
import type { BObject, Doc, Scene } from '../core/types';
import { evaluateSim, PointCache, resetAtStart, simProviders, type SimDriver } from './cache';
import { collectEffectors, effectorAccel, effectorSignature } from './fields';
import {
  defaultRigidBody, defaultRigidBodyConstraint, defaultRigidBodyWorld, type RigidBodyConstraint, type RigidBodyObject, type RigidBodyWorld,
} from './types';

const FLOATS = 13;

export function rbWorld(scene: Scene = app.scene): RigidBodyWorld | null {
  return scene.rigidBodyWorld ?? null;
}

export function rbOf(ob: BObject): RigidBodyObject | null {
  return ob.rigidBody ? { ...defaultRigidBody(ob.rigidBody.type), ...ob.rigidBody } : null;
}

export function rbcOf(ob: BObject): RigidBodyConstraint | null {
  return ob.rigidBodyConstraint ? { ...defaultRigidBodyConstraint(ob.rigidBodyConstraint.type), ...ob.rigidBodyConstraint } : null;
}

/** Objects taking part in the rigid body world ("RigidBodyWorld" group). */
export function rigidBodyObjects(scene: Scene = app.scene): BObject[] {
  return scene.objects.map((id) => app.doc.objects[id]).filter((o): o is BObject => !!o && !!o.rigidBody && (o.type === 'MESH' || o.type === 'FONT'));
}

export function rigidBodyConstraintObjects(scene: Scene = app.scene): BObject[] {
  return scene.objects.map((id) => app.doc.objects[id]).filter((o): o is BObject => !!o && !!o.rigidBodyConstraint);
}

/** Is the body moved by the simulation (as opposed to following its animation / staying put)? */
export function isSimulated(rb: RigidBodyObject): boolean {
  return rb.type === 'ACTIVE' && rb.enabled && !rb.kinematic;
}

// ------------------------------------------------------------------ collision shapes

/** Mesh used for the collision shape (object space, not scaled). */
function shapeMesh(ob: BObject, rb: RigidBodyObject): EvalMesh | null {
  if (ob.type === 'MESH' && rb.meshSource === 'BASE') {
    const md = app.meshOf(ob);
    return md ? evalMeshFromData(md) : null;
  }
  return app.evalMesh(ob);
}

function bounds(m: EvalMesh, s: Vector3): { min: Vector3; max: Vector3 } {
  const min = new Vector3(Infinity, Infinity, Infinity), max = new Vector3(-Infinity, -Infinity, -Infinity);
  for (const v of m.verts) {
    min.x = Math.min(min.x, v[0] * s.x); min.y = Math.min(min.y, v[1] * s.y); min.z = Math.min(min.z, v[2] * s.z);
    max.x = Math.max(max.x, v[0] * s.x); max.y = Math.max(max.y, v[1] * s.y); max.z = Math.max(max.z, v[2] * s.z);
  }
  if (!m.verts.length) { min.set(-0.5, -0.5, -0.5); max.set(0.5, 0.5, 0.5); }
  return { min, max };
}

/** Dimensions of the shape like Blender (object bounding box, centred on the origin). */
function dims(m: EvalMesh, s: Vector3): Vector3 {
  const b = bounds(m, s);
  return new Vector3(Math.abs(b.max.x - b.min.x), Math.abs(b.max.y - b.min.y), Math.abs(b.max.z - b.min.z));
}

/** Convex polygon faces (CCW seen from outside) of the hull of a point set; null when flat. */
function hullPolyhedron(pts: Vector3[]): { verts: Vector3[]; faces: number[][] } | null {
  if (pts.length < 4) return null;
  let hull: ConvexHull;
  try { hull = new ConvexHull().setFromPoints(pts); } catch { return null; }
  if (hull.faces.length < 4) return null;
  const size = pts.reduce((a, p) => Math.max(a, Math.abs(p.x), Math.abs(p.y), Math.abs(p.z)), 1e-6);
  const groups: { n: Vector3; c: number; pts: Vector3[] }[] = [];
  for (const f of hull.faces) {
    let g = groups.find((x) => x.n.dot(f.normal) > 1 - 1e-5 && Math.abs(x.c - f.constant) < 1e-5 * size);
    if (!g) { g = { n: f.normal.clone(), c: f.constant, pts: [] }; groups.push(g); }
    let e = f.edge;
    for (let k = 0; k < 3; k++) {
      const p = e.head().point;
      if (!g.pts.includes(p)) g.pts.push(p);
      e = e.next;
    }
  }
  if (groups.length < 4) return null;
  const index = new Map<Vector3, number>();
  const verts: Vector3[] = [];
  const faces: number[][] = [];
  for (const g of groups) {
    const c = new Vector3();
    for (const p of g.pts) c.add(p);
    c.multiplyScalar(1 / g.pts.length);
    const u = Math.abs(g.n.x) < 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
    u.sub(g.n.clone().multiplyScalar(u.dot(g.n))).normalize();
    const v = new Vector3().crossVectors(g.n, u);
    const sorted = g.pts.slice().sort((a, b) => {
      const da = a.clone().sub(c), db = b.clone().sub(c);
      return Math.atan2(da.dot(v), da.dot(u)) - Math.atan2(db.dot(v), db.dot(u));
    });
    faces.push(sorted.map((p) => {
      let i = index.get(p);
      if (i === undefined) { i = verts.length; index.set(p, i); verts.push(p.clone()); }
      return i;
    }));
  }
  return { verts, faces };
}

function polyShape(verts: Vector3[], faces: number[][]): { shape: CANNON.ConvexPolyhedron; offset: CANNON.Vec3 } {
  const c = new Vector3();
  for (const v of verts) c.add(v);
  c.multiplyScalar(1 / verts.length);
  const shape = new CANNON.ConvexPolyhedron({ vertices: verts.map((v) => new CANNON.Vec3(v.x - c.x, v.y - c.y, v.z - c.z)), faces });
  return { shape, offset: new CANNON.Vec3(c.x, c.y, c.z) };
}

/** Cylinder / cone along the local Z axis (centred), as a convex polyhedron. */
function roundShape(radius: number, height: number, cone: boolean, segs = 16): CANNON.ConvexPolyhedron {
  const verts: CANNON.Vec3[] = [];
  const faces: number[][] = [];
  const h = height / 2;
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    verts.push(new CANNON.Vec3(Math.cos(a) * radius, Math.sin(a) * radius, -h));
  }
  if (cone) {
    verts.push(new CANNON.Vec3(0, 0, h));
    for (let i = 0; i < segs; i++) faces.push([i, (i + 1) % segs, segs]);
  } else {
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      verts.push(new CANNON.Vec3(Math.cos(a) * radius, Math.sin(a) * radius, h));
    }
    for (let i = 0; i < segs; i++) faces.push([i, (i + 1) % segs, segs + (i + 1) % segs, segs + i]);
    faces.push(Array.from({ length: segs }, (_, i) => segs + i));
  }
  faces.push(Array.from({ length: segs }, (_, i) => segs - 1 - i));
  // the cone's centre of volume is below the middle: keep the origin inside for cannon's checks
  return new CANNON.ConvexPolyhedron({ vertices: verts, faces });
}

function boxPoly(min: Vector3, max: Vector3): { verts: Vector3[]; faces: number[][] } {
  const v = [
    new Vector3(min.x, min.y, min.z), new Vector3(max.x, min.y, min.z), new Vector3(max.x, max.y, min.z), new Vector3(min.x, max.y, min.z),
    new Vector3(min.x, min.y, max.z), new Vector3(max.x, min.y, max.z), new Vector3(max.x, max.y, max.z), new Vector3(min.x, max.y, max.z),
  ];
  return { verts: v, faces: [[3, 2, 1, 0], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]] };
}

/** Add the collision shape(s) of an object to a body. */
function addShapes(body: CANNON.Body, ob: BObject, rb: RigidBodyObject, scale: Vector3): void {
  const m = shapeMesh(ob, rb) ?? { verts: [], faces: [], looseEdges: [], faceSmooth: [], faceMat: [] };
  const s = new Vector3(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z));
  const d = dims(m, s);
  const margin = rb.collisionMargin;
  const minThick = Math.max(margin * 2, 0.02);
  switch (rb.collisionShape) {
    case 'BOX':
      body.addShape(new CANNON.Box(new CANNON.Vec3(Math.max(d.x / 2, minThick / 2), Math.max(d.y / 2, minThick / 2), Math.max(d.z / 2, minThick / 2))));
      return;
    case 'SPHERE':
      body.addShape(new CANNON.Sphere(Math.max(Math.max(d.x, d.y, d.z) / 2, 1e-3)));
      return;
    case 'CAPSULE': {
      const r = Math.max(Math.max(d.x, d.y) / 2, 1e-3);
      const h = Math.max(d.z - 2 * r, 0);
      if (h > 1e-4) body.addShape(roundShape(r, h, false));
      body.addShape(new CANNON.Sphere(r), new CANNON.Vec3(0, 0, h / 2));
      body.addShape(new CANNON.Sphere(r), new CANNON.Vec3(0, 0, -h / 2));
      return;
    }
    case 'CYLINDER':
      body.addShape(roundShape(Math.max(Math.max(d.x, d.y) / 2, 1e-3), Math.max(d.z, minThick), false));
      return;
    case 'CONE': {
      const h = Math.max(d.z, minThick);
      const shape = roundShape(Math.max(Math.max(d.x, d.y) / 2, 1e-3), h, true);
      body.addShape(shape);
      return;
    }
    case 'CONVEX_HULL': {
      const pts = m.verts.map((v) => new Vector3(v[0] * scale.x, v[1] * scale.y, v[2] * scale.z));
      const poly = hullPolyhedron(pts);
      if (poly) { const { shape, offset } = polyShape(poly.verts, poly.faces); body.addShape(shape, offset); return; }
      // flat or degenerate: thin box around the points
      const b = bounds(m, scale);
      for (const k of ['x', 'y', 'z'] as const) if (b.max[k] - b.min[k] < minThick) { const c = (b.max[k] + b.min[k]) / 2; b.min[k] = c - minThick / 2; b.max[k] = c + minThick / 2; }
      const bp = boxPoly(b.min, b.max);
      const { shape, offset } = polyShape(bp.verts, bp.faces);
      body.addShape(shape, offset);
      return;
    }
    case 'MESH': {
      // triangle prisms extruded inwards (cannon-es meshes only collide with spheres and planes)
      const pts = m.verts.map((v) => new Vector3(v[0] * scale.x, v[1] * scale.y, v[2] * scale.z));
      const b = bounds(m, scale);
      const ext = b.max.clone().sub(b.min);
      const minDim = Math.min(ext.x, ext.y, ext.z), maxDim = Math.max(ext.x, ext.y, ext.z, 1e-3);
      const flat = minDim < 1e-4 * maxDim + 1e-6;
      const thick = flat ? Math.max(minThick, Math.min(0.5, maxDim * 0.1)) : Math.max(1e-3, Math.min(minDim * 0.25, 0.25));
      let added = 0;
      for (const f of m.faces) {
        const tris = f.length === 3 ? [[0, 1, 2]] : f.length === 4 ? [[0, 1, 2], [0, 2, 3]] : triangulatePoly(m.verts, f);
        for (const t of tris) {
          const a = pts[f[t[0]]], bb = pts[f[t[1]]], c = pts[f[t[2]]];
          const n = new Vector3().crossVectors(bb.clone().sub(a), c.clone().sub(a));
          if (n.lengthSq() < 1e-14) continue;
          n.normalize().multiplyScalar(-thick);
          const verts = [a, bb, c, a.clone().add(n), bb.clone().add(n), c.clone().add(n)];
          const faces = [[0, 1, 2], [5, 4, 3], [0, 3, 4, 1], [1, 4, 5, 2], [2, 5, 3, 0]];
          const { shape, offset } = polyShape(verts, faces);
          body.addShape(shape, offset);
          added++;
        }
      }
      if (!added) {
        const bp = boxPoly(b.min.clone().subScalar(minThick / 2), b.max.clone().addScalar(minThick / 2));
        const { shape, offset } = polyShape(bp.verts, bp.faces);
        body.addShape(shape, offset);
      }
      return;
    }
  }
}

// ------------------------------------------------------------------ slider constraint

/** Slider: keeps the relative orientation and allows translation along the constraint's X axis only. */
class SliderConstraint extends CANNON.Constraint {
  private eqY: CANNON.ContactEquation;
  private eqZ: CANNON.ContactEquation;
  private limLo: CANNON.ContactEquation;
  private limHi: CANNON.ContactEquation;
  private rot: CANNON.RotationalEquation[];
  /** Pairs of local axes (on A and on B) that must stay perpendicular. */
  private rotAxes: [CANNON.Vec3, CANNON.Vec3][];
  private axisA: CANNON.Vec3;
  private axisY: CANNON.Vec3;
  private axisZ: CANNON.Vec3;
  constructor(a: CANNON.Body, b: CANNON.Body, private pivotA: CANNON.Vec3, private pivotB: CANNON.Vec3, axisA: CANNON.Vec3, axisY: CANNON.Vec3,
    private limits: { use: boolean; lo: number; hi: number }, collide: boolean) {
    super(a, b, { collideConnected: collide });
    const max = 1e6;
    this.axisA = axisA; this.axisY = axisY; this.axisZ = axisA.cross(axisY);
    this.eqY = new CANNON.ContactEquation(a, b); this.eqY.minForce = -max; this.eqY.maxForce = max;
    this.eqZ = new CANNON.ContactEquation(a, b); this.eqZ.minForce = -max; this.eqZ.maxForce = max;
    this.limLo = new CANNON.ContactEquation(a, b); this.limLo.minForce = 0; this.limLo.maxForce = max;
    this.limHi = new CANNON.ContactEquation(a, b); this.limHi.minForce = 0; this.limHi.maxForce = max;
    // lock rotation: three orthogonal axis pairs must stay perpendicular
    const ex = new CANNON.Vec3(1, 0, 0), ey = new CANNON.Vec3(0, 1, 0), ez = new CANNON.Vec3(0, 0, 1);
    const qa = a.quaternion, qb = b.quaternion;
    const rel = (v: CANNON.Vec3) => qb.inverse().vmult(qa.vmult(v));
    this.rotAxes = [[ex, rel(ey)], [ey, rel(ez)], [ez, rel(ex)]];
    this.rot = this.rotAxes.map(() => new CANNON.RotationalEquation(a, b, { maxForce: max }));
    this.equations.push(this.eqY, this.eqZ, ...this.rot);
    if (limits.use) this.equations.push(this.limLo, this.limHi);
  }

  override update(): void {
    const a = this.bodyA, b = this.bodyB;
    const ri = a.quaternion.vmult(this.pivotA), rj = b.quaternion.vmult(this.pivotB);
    const ny = a.quaternion.vmult(this.axisY), nz = a.quaternion.vmult(this.axisZ), nx = a.quaternion.vmult(this.axisA);
    for (const [eq, n] of [[this.eqY, ny], [this.eqZ, nz]] as const) { eq.ri.copy(ri); eq.rj.copy(rj); eq.ni.copy(n); }
    if (this.limits.use) {
      // offset of the pivot of B along the axis, relative to A
      const d = b.position.vadd(rj).vsub(a.position.vadd(ri)).dot(nx);
      this.limLo.ri.copy(ri.vadd(nx.scale(this.limits.lo))); this.limLo.rj.copy(rj); this.limLo.ni.copy(nx);
      this.limHi.ri.copy(ri.vadd(nx.scale(this.limits.hi))); this.limHi.rj.copy(rj); this.limHi.ni.copy(nx.negate());
      this.limLo.enabled = d < this.limits.lo + 1e-3;
      this.limHi.enabled = d > this.limits.hi - 1e-3;
    }
    this.rot.forEach((r, i) => {
      a.vectorToWorldFrame(this.rotAxes[i][0], r.axisA);
      b.vectorToWorldFrame(this.rotAxes[i][1], r.axisB);
    });
  }
}

// ------------------------------------------------------------------ the simulation

interface BodyRec {
  id: string;
  body: CANNON.Body;
  rb: RigidBodyObject;
  scale: Vector3;
  kinematic: boolean;
  /** Previous kinematic target (for velocities). */
  prevPos: Vector3;
  prevQuat: Quaternion;
}

interface ConRec {
  id: string;
  con: RigidBodyConstraint;
  c: CANNON.Constraint | null;
  springs: CANNON.Spring[];
  broken: boolean;
}

const _p = new Vector3(), _q = new Quaternion(), _s = new Vector3();

class RigidBodyDriver implements SimDriver<Float64Array> {
  kind = 'RIGIDBODY' as const;
  obId = null;
  label = 'Rigid Body World';
  cache = new PointCache<Float64Array>();
  world: CANNON.World | null = null;
  bodies: BodyRec[] = [];
  index = new Map<string, number>();
  cons: ConRec[] = [];
  constructor(public key: string, private sceneId: string) {}

  private scene(): Scene | null { return app.doc.scenes.find((s) => s.id === this.sceneId) ?? null; }
  alive(): boolean { return !!this.scene()?.rigidBodyWorld; }

  settings() {
    const w = this.scene()?.rigidBodyWorld ?? defaultRigidBodyWorld();
    return w.pointCache;
  }

  signature(): string {
    const sc = this.scene();
    if (!sc) return '';
    const w = sc.rigidBodyWorld;
    return JSON.stringify([w, sc.useGravity, sc.gravity, sc.fps, sc.fpsBase,
      rigidBodyObjects(sc).map((o) => [o.id, o.rigidBody, o.modifiers.length]),
      rigidBodyConstraintObjects(sc).map((o) => [o.id, o.rigidBodyConstraint]), effectorSignature()]);
  }

  bytes(s: Float64Array): number { return s.byteLength; }

  /** Build the cannon world from the document (transforms at the cache start frame). */
  init(mats: MatrixCache, frame: number): Float64Array {
    void frame;
    const sc = this.scene() ?? app.scene;
    const w = sc.rigidBodyWorld ?? defaultRigidBodyWorld();
    const world = new CANNON.World({ gravity: new CANNON.Vec3(0, 0, 0), allowSleep: true });
    const solver = new CANNON.GSSolver();
    solver.iterations = Math.max(1, Math.round(w.solverIterations));
    solver.tolerance = 1e-7;
    world.solver = solver;
    world.broadphase = new CANNON.SAPBroadphase(world);
    world.defaultContactMaterial.contactEquationStiffness = 1e8;
    world.defaultContactMaterial.contactEquationRelaxation = 3;
    world.defaultContactMaterial.frictionEquationStiffness = 1e8;
    world.defaultContactMaterial.frictionEquationRelaxation = 3;
    world.quatNormalizeFast = false;
    world.quatNormalizeSkip = 0;
    this.world = world;
    this.bodies = [];
    this.index.clear();
    for (const ob of rigidBodyObjects(sc)) {
      const rb = rbOf(ob)!;
      mats.world(ob).decompose(_p, _q, _s);
      const kinematic = rb.type === 'PASSIVE' ? rb.kinematic : (!rb.enabled || rb.kinematic);
      const dynamic = isSimulated(rb);
      const mat = new CANNON.Material({ friction: rb.friction, restitution: rb.restitution });
      const groups = rb.collisionGroups.reduce((acc, on, i) => (on ? acc | (1 << i) : acc), 0) || 1;
      const body = new CANNON.Body({
        mass: dynamic ? Math.max(rb.mass, 1e-4) : 0,
        type: dynamic ? CANNON.Body.DYNAMIC : kinematic ? CANNON.Body.KINEMATIC : CANNON.Body.STATIC,
        position: new CANNON.Vec3(_p.x, _p.y, _p.z),
        quaternion: new CANNON.Quaternion(_q.x, _q.y, _q.z, _q.w),
        material: mat, linearDamping: rb.linearDamping, angularDamping: rb.angularDamping,
        allowSleep: rb.useDeactivation, sleepSpeedLimit: rb.deactivateLinearVelocity, sleepTimeLimit: 0.5,
        collisionFilterGroup: groups, collisionFilterMask: groups,
      });
      addShapes(body, ob, rb, _s.clone());
      if (dynamic) body.updateMassProperties();
      if (dynamic && rb.useDeactivation && rb.useStartDeactivated) body.sleep();
      world.addBody(body);
      this.index.set(ob.id, this.bodies.length);
      this.bodies.push({ id: ob.id, body, rb, scale: _s.clone(), kinematic, prevPos: _p.clone(), prevQuat: _q.clone() });
    }
    // constraints
    this.cons = [];
    for (const cob of rigidBodyConstraintObjects(sc)) {
      const con = rbcOf(cob)!;
      const rec: ConRec = { id: cob.id, con, c: null, springs: [], broken: false };
      this.cons.push(rec);
      if (!con.enabled || !con.object1 || !con.object2) continue;
      const ia = this.index.get(con.object1), ib = this.index.get(con.object2);
      if (ia === undefined || ib === undefined || ia === ib) continue;
      const A = this.bodies[ia].body, B = this.bodies[ib].body;
      const m = mats.world(cob);
      const pivot = new Vector3().setFromMatrixPosition(m);
      const e = m.elements;
      const ax = new Vector3(e[0], e[1], e[2]).normalize(), ay = new Vector3(e[4], e[5], e[6]).normalize(), az = new Vector3(e[8], e[9], e[10]).normalize();
      const cp = new CANNON.Vec3(pivot.x, pivot.y, pivot.z);
      const pA = A.pointToLocalFrame(cp), pB = B.pointToLocalFrame(cp);
      const toLocal = (b: CANNON.Body, v: Vector3) => b.vectorToLocalFrame(new CANNON.Vec3(v.x, v.y, v.z));
      const collide = !con.disableCollisions;
      let c: CANNON.Constraint | null = null;
      switch (con.type) {
        case 'FIXED': c = new CANNON.LockConstraint(A, B, { maxForce: 1e6 }); c.collideConnected = collide; break;
        case 'POINT': c = new CANNON.PointToPointConstraint(A, pA, B, pB, 1e6); c.collideConnected = collide; break;
        case 'HINGE': c = new CANNON.HingeConstraint(A, B, { pivotA: pA, pivotB: pB, axisA: toLocal(A, az), axisB: toLocal(B, az), collideConnected: collide, maxForce: 1e6 }); break;
        case 'SLIDER':
          c = new SliderConstraint(A, B, pA, pB, toLocal(A, ax), toLocal(A, ay), { use: con.useLimitLinX, lo: con.limitLinXLower, hi: con.limitLinXUpper }, collide);
          break;
        case 'GENERIC_SPRING': {
          const axes: [boolean, number, number][] = [[con.useSpringX, con.springStiffnessX, con.springDampingX], [con.useSpringY, con.springStiffnessY, con.springDampingY], [con.useSpringZ, con.springStiffnessZ, con.springDampingZ]];
          const k = axes.filter((a) => a[0]);
          if (k.length) rec.springs.push(new CANNON.Spring(A, B, { localAnchorA: pA, localAnchorB: pB, restLength: 0, stiffness: k.reduce((s2, a) => s2 + a[1], 0) / k.length, damping: k.reduce((s2, a) => s2 + a[2], 0) / k.length }));
          if (!collide) { c = new CANNON.Constraint(A, B, { collideConnected: false }); }
          break;
        }
        default: break;
      }
      if (c) { world.addConstraint(c); rec.c = c; }
    }
    return this.snapshot();
  }

  private snapshot(): Float64Array {
    const out = new Float64Array(this.bodies.length * FLOATS + this.cons.length);
    this.bodies.forEach((r, i) => {
      const b = r.body, o = i * FLOATS;
      out[o] = b.position.x; out[o + 1] = b.position.y; out[o + 2] = b.position.z;
      out[o + 3] = b.quaternion.x; out[o + 4] = b.quaternion.y; out[o + 5] = b.quaternion.z; out[o + 6] = b.quaternion.w;
      out[o + 7] = b.velocity.x; out[o + 8] = b.velocity.y; out[o + 9] = b.velocity.z;
      out[o + 10] = b.angularVelocity.x; out[o + 11] = b.angularVelocity.y; out[o + 12] = b.angularVelocity.z;
    });
    this.cons.forEach((c, i) => { out[this.bodies.length * FLOATS + i] = c.broken ? 1 : 0; });
    return out;
  }

  restore(state: Float64Array, frame: number): void {
    if (!this.world) {
      const mats = new MatrixCache(app.doc);
      mats.noOverrides = true;
      this.init(mats, frame);
    }
    this.bodies.forEach((r, i) => {
      const b = r.body, o = i * FLOATS;
      if (o + 12 >= state.length) return;
      b.position.set(state[o], state[o + 1], state[o + 2]);
      b.quaternion.set(state[o + 3], state[o + 4], state[o + 5], state[o + 6]);
      b.velocity.set(state[o + 7], state[o + 8], state[o + 9]);
      b.angularVelocity.set(state[o + 10], state[o + 11], state[o + 12]);
      b.previousPosition.copy(b.position);
      b.previousQuaternion.copy(b.quaternion);
      b.aabbNeedsUpdate = true;
      b.wakeUp();
    });
    this.cons.forEach((c, i) => {
      const broken = state[this.bodies.length * FLOATS + i] === 1;
      if (broken && !c.broken && c.c) this.world!.removeConstraint(c.c);
      c.broken = broken;
    });
  }

  step(mats: MatrixCache, frame: number): Float64Array {
    const world = this.world;
    if (!world) return this.init(mats, frame);
    const sc = this.scene() ?? app.scene;
    const w = sc.rigidBodyWorld ?? defaultRigidBodyWorld();
    const fps = sc.fps / (sc.fpsBase || 1);
    const dt = (w.timeScale || 0) / fps;
    const n = Math.max(1, Math.round((w.stepsPerSecond * Math.abs(dt)) || 1));
    const h = dt / n;
    const gw = w.effectorWeights.gravity;
    const g = sc.useGravity ? sc.gravity : [0, 0, 0];
    world.gravity.set(g[0] * gw, g[1] * gw, g[2] * gw);
    // kinematic targets at this frame
    const targets = this.bodies.map((r) => {
      if (!r.kinematic) return null;
      const ob = app.doc.objects[r.id];
      if (!ob) return null;
      const p = new Vector3(), q = new Quaternion(), s = new Vector3();
      mats.world(ob).decompose(p, q, s);
      return { p, q };
    });
    const effs = collectEffectors(mats);
    const acc = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const t = (i + 1) / n;
      this.bodies.forEach((r, k) => {
        const tg = targets[k];
        if (!tg || h === 0) return;
        const p = r.prevPos.clone().lerp(tg.p, t);
        const q = r.prevQuat.clone().slerp(tg.q, t);
        const b = r.body;
        b.velocity.set((p.x - b.position.x) / h, (p.y - b.position.y) / h, (p.z - b.position.z) / h);
        b.position.set(p.x, p.y, p.z);
        b.quaternion.set(q.x, q.y, q.z, q.w);
        b.aabbNeedsUpdate = true;
      });
      if (effs.length) {
        for (const r of this.bodies) {
          if (r.body.type !== CANNON.Body.DYNAMIC) continue;
          const b = r.body;
          acc[0] = acc[1] = acc[2] = 0;
          effectorAccel(effs, w.effectorWeights, b.position.x, b.position.y, b.position.z, b.velocity.x, b.velocity.y, b.velocity.z, frame / fps, acc);
          if (acc[0] || acc[1] || acc[2]) { b.applyForce(new CANNON.Vec3(acc[0] * b.mass, acc[1] * b.mass, acc[2] * b.mass)); b.wakeUp(); }
        }
      }
      for (const c of this.cons) for (const s of c.springs) s.applyForce();
      if (h !== 0) world.step(Math.abs(h));
      // breakable constraints
      for (const c of this.cons) {
        if (!c.c || c.broken || !c.con.useBreaking) continue;
        const impulse = c.c.equations.reduce((m, eq) => Math.max(m, Math.abs(eq.multiplier) * Math.abs(h)), 0);
        if (impulse > c.con.breakingThreshold) { world.removeConstraint(c.c); c.broken = true; }
      }
    }
    this.bodies.forEach((r, k) => { const tg = targets[k]; if (tg) { r.prevPos.copy(tg.p); r.prevQuat.copy(tg.q); } });
    return this.snapshot();
  }

  /** Simulated world matrix of a dynamic body at the cached frame. */
  matrixFrom(state: Float64Array, obId: string): Matrix4 | null {
    const i = this.index.get(obId);
    if (i === undefined) return null;
    const r = this.bodies[i];
    const o = i * FLOATS;
    if (o + 6 >= state.length) return null;
    return new Matrix4().compose(new Vector3(state[o], state[o + 1], state[o + 2]), new Quaternion(state[o + 3], state[o + 4], state[o + 5], state[o + 6]), r.scale);
  }
}

const drivers = new Map<string, RigidBodyDriver>();

export function rigidBodyDriver(scene: Scene = app.scene): RigidBodyDriver | null {
  if (!scene.rigidBodyWorld) return null;
  const key = `RB:${scene.id}`;
  let d = drivers.get(key);
  if (!d) { d = new RigidBodyDriver(key, scene.id); drivers.set(key, d); }
  return d;
}

simProviders.push((scene) => {
  const d = rigidBodyDriver(scene);
  return d ? [d as unknown as SimDriver<unknown>] : [];
});

/** World matrix of a rigid body at the current frame (null: use the regular transform). */
function rigidBodyOverride(ob: BObject, doc: Doc): Matrix4 | null {
  if (!ob.rigidBody || doc !== app.doc) return null;
  const sc = app.scene;
  const w = sc.rigidBodyWorld;
  if (!w || !w.enabled || !sc.objects.includes(ob.id)) return null;
  const rb = rbOf(ob)!;
  if (!isSimulated(rb)) return null;
  const d = rigidBodyDriver(sc);
  if (!d) return null;
  const frame = sc.frameCurrent;
  if (frame <= w.pointCache.frameStart) { resetAtStart(d); return null; }
  const state = evaluateSim(d, frame);
  if (!state) return null;
  // the body list may have been rebuilt from a baked cache that no longer matches
  if (d.index.size === 0 && !d.world) return null;
  return d.matrixFrom(state, ob.id);
}

worldMatrixOverrides.push(rigidBodyOverride);

/** Simulated world matrix of a rigid body object at any frame (for Bake To Keyframes). */
export function rigidBodyMatrixAt(ob: BObject, frame: number): Matrix4 | null {
  const sc = app.scene;
  const w = sc.rigidBodyWorld;
  const d = rigidBodyDriver(sc);
  if (!w || !d) return null;
  const state = evaluateSim(d, Math.max(frame, w.pointCache.frameStart));
  return state ? d.matrixFrom(state, ob.id) : null;
}

// ------------------------------------------------------------------ mass

/** Densities in kg/m³ for "Calculate Mass" (common physical values). */
export const MASS_MATERIALS: [string, number][] = [
  ['Air', 1.0], ['Acrylic', 1400], ['Asphalt (Crushed)', 721], ['Bark', 240], ['Beans (Cocoa)', 593], ['Beans (Soy)', 721],
  ['Brick (Pressed)', 2400], ['Brick (Common)', 2000], ['Brick (Soft)', 1600], ['Brass', 8216], ['Bronze', 8860],
  ['Carbon (Solid)', 2146], ['Cardboard', 689], ['Cast Iron', 7150], ['Chalk (Solid)', 2499], ['Concrete', 2320],
  ['Charcoal', 208], ['Cork', 240], ['Copper', 8933], ['Garbage', 481], ['Glass (Broken)', 1940], ['Glass (Solid)', 2190],
  ['Gold', 19282], ['Granite (Broken)', 1650], ['Granite (Solid)', 2691], ['Gravel', 2780], ['Ice (Crushed)', 593],
  ['Ice (Solid)', 919], ['Iron', 7874], ['Lead', 11342], ['Limestone (Broken)', 1554], ['Limestone (Solid)', 2611],
  ['Marble (Broken)', 1570], ['Marble (Solid)', 2563], ['Paper', 1201], ['Peanuts (Shelled)', 641], ['Peanuts (Not Shelled)', 272],
  ['Plaster', 849], ['Plastic', 1200], ['Polystyrene', 1050], ['Rubber', 1522], ['Silver', 10501], ['Steel', 7860],
  ['Stone', 2515], ['Stone (Crushed)', 1602], ['Timber', 610],
];

/** Volume of the collision shape of an object (m³, object scale applied). */
export function shapeVolume(ob: BObject, rb: RigidBodyObject): number {
  const m = shapeMesh(ob, rb);
  if (!m) return 0;
  const mats = app.matrices.world(ob);
  const s = new Vector3();
  mats.decompose(new Vector3(), new Quaternion(), s);
  const d = dims(m, new Vector3(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z)));
  switch (rb.collisionShape) {
    case 'BOX': return d.x * d.y * d.z;
    case 'SPHERE': { const r = Math.max(d.x, d.y, d.z) / 2; return (4 / 3) * Math.PI * r ** 3; }
    case 'CYLINDER': { const r = Math.max(d.x, d.y) / 2; return Math.PI * r * r * d.z; }
    case 'CONE': { const r = Math.max(d.x, d.y) / 2; return (Math.PI * r * r * d.z) / 3; }
    case 'CAPSULE': { const r = Math.max(d.x, d.y) / 2; const hh = Math.max(0, d.z - 2 * r); return Math.PI * r * r * hh + (4 / 3) * Math.PI * r ** 3; }
    default: {
      // signed tetrahedron volume of the closed mesh
      let v = 0;
      for (const f of m.faces) {
        for (let i = 1; i + 1 < f.length; i++) {
          const a = m.verts[f[0]], b = m.verts[f[i]], c = m.verts[f[i + 1]];
          v += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
        }
      }
      v = Math.abs(v * s.x * s.y * s.z);
      return v > 1e-9 ? v : d.x * d.y * d.z;
    }
  }
}
