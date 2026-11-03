// Armatures: bone data, rest/pose matrices (Blender conventions: a bone's Y axis points from head to
// tail and the roll turns it around Y), pose evaluation through the hierarchy with bone constraints
// and IK, and deformation helpers (bone skinning matrices, envelopes).

import { Euler, Matrix3, Matrix4, Quaternion, Vector3 } from 'three';
import type { ArmatureData, BObject, Bone, BoneConstraint, BoneRotationMode, Doc, PoseBone, Vec3 } from './types';
import { MatrixCache, newId, threeEulerOrder, uniqueNameIn } from './scene';

// ------------------------------------------------------------------ data

export function defaultBone(name: string, head: Vec3 = [0, 0, 0], tail: Vec3 = [0, 0, 1]): Bone {
  const layers = new Array(32).fill(false);
  layers[0] = true;
  return {
    name, head: [...head] as Vec3, tail: [...tail] as Vec3, roll: 0, parent: null, useConnect: false, useDeform: true,
    useInheritRotation: true, useInheritScale: true, useLocalLocation: true, useEnvelopeMultiply: false,
    envelopeDistance: 0.25, envelopeWeight: 1, headRadius: 0.1, tailRadius: 0.05, bboneSegments: 1, bboneX: 0.1, bboneZ: 0.1,
    layers, hide: false, hideSelect: false, select: false, selectHead: false, selectTail: false,
  };
}

export function createArmature(doc: Doc, name = 'Armature'): ArmatureData {
  doc.armatures ??= {};
  const layers = new Array(32).fill(false);
  layers[0] = true;
  const a: ArmatureData = {
    id: newId(doc, 'AR'), name: uniqueNameIn(doc, 'armatures', name), bones: [], activeBone: null, drawType: 'OCTAHEDRAL',
    showNames: false, showAxes: false, showGroupColors: true, showBoneCustomShapes: true, useMirrorX: false,
    useDeformPreserveVolume: false, layers, layersProtected: new Array(32).fill(false), posePosition: 'POSE', fakeUser: false,
  };
  doc.armatures[a.id] = a;
  return a;
}

export function defaultPoseBone(): PoseBone {
  return {
    location: [0, 0, 0], rotationQuaternion: [1, 0, 0, 0], rotationEuler: [0, 0, 0], rotationAxisAngle: [0, 0, 1, 0],
    rotationMode: 'QUATERNION', scale: [1, 1, 1], lockLocation: [false, false, false], lockRotation: [false, false, false],
    lockScale: [false, false, false], constraints: [], ikStretch: 0,
  };
}

export function armatureOf(doc: Doc, ob: BObject | null | undefined): ArmatureData | null {
  return ob && ob.type === 'ARMATURE' && ob.data ? doc.armatures?.[ob.data] ?? null : null;
}

export function boneByName(arm: ArmatureData, name: string | null | undefined): Bone | undefined {
  return name ? arm.bones.find((b) => b.name === name) : undefined;
}

/** Pose channel of a bone (created on demand). */
export function poseBone(ob: BObject, name: string): PoseBone {
  ob.pose ??= {};
  let pb = ob.pose[name];
  if (!pb) { pb = defaultPoseBone(); ob.pose[name] = pb; }
  return pb;
}

/** Make sure every bone has a pose channel and drop channels of removed bones. */
export function syncPose(ob: BObject, arm: ArmatureData): void {
  ob.pose ??= {};
  const names = new Set(arm.bones.map((b) => b.name));
  for (const n of Object.keys(ob.pose)) if (!names.has(n)) delete ob.pose[n];
  for (const b of arm.bones) poseBone(ob, b.name);
}

export function uniqueBoneName(arm: ArmatureData, base: string, ignore?: Bone): string {
  const names = new Set(arm.bones.filter((b) => b !== ignore).map((b) => b.name));
  if (!names.has(base)) return base;
  const m = /^(.*)\.(\d{3,})$/.exec(base);
  const stem = m ? m[1] : base;
  for (let i = 1; i < 100000; i++) {
    const c = `${stem}.${String(i).padStart(3, '0')}`;
    if (!names.has(c)) return c;
  }
  return `${stem}.${Date.now()}`;
}

/** Rename a bone, updating children, pose channels, vertex groups, F-Curves and bone constraints. */
export function renameBone(doc: Doc, arm: ArmatureData, bone: Bone, name: string): void {
  const old = bone.name;
  const nn = uniqueBoneName(arm, name.trim() || old, bone);
  if (nn === old) return;
  bone.name = nn;
  for (const b of arm.bones) if (b.parent === old) b.parent = nn;
  if (arm.activeBone === old) arm.activeBone = nn;
  for (const ob of Object.values(doc.objects)) {
    if (ob.data === arm.id && ob.pose?.[old]) { ob.pose[nn] = ob.pose[old]; delete ob.pose[old]; }
    if (ob.data === arm.id) for (const fc of ob.fcurves) fc.path = fc.path.replace(`pose.bones["${old}"]`, `pose.bones["${nn}"]`);
    // vertex groups of meshes deformed by this armature
    const usesArm = ob.modifiers.some((m) => m.type === 'ARMATURE' && m.object && doc.objects[m.object as string]?.data === arm.id) || (ob.parent && doc.objects[ob.parent]?.data === arm.id);
    if (usesArm) for (const g of ob.vertexGroups ?? []) if (g.name === old) g.name = nn;
    if (ob.parentBone === old && ob.parent && doc.objects[ob.parent]?.data === arm.id) ob.parentBone = nn;
    for (const pb of Object.values(ob.pose ?? {})) for (const c of pb.constraints) if (c.subtarget === old && c.target && doc.objects[c.target]?.data === arm.id) c.subtarget = nn;
  }
}

export function boneChildren(arm: ArmatureData, name: string): Bone[] {
  return arm.bones.filter((b) => b.parent === name);
}

/** Bones ordered so that parents come before their children. */
export function hierarchyOrder(arm: ArmatureData): Bone[] {
  const out: Bone[] = [];
  const seen = new Set<string>();
  const byName = new Map(arm.bones.map((b) => [b.name, b]));
  const visit = (b: Bone, depth: number) => {
    if (seen.has(b.name) || depth > 1000) return;
    const p = b.parent ? byName.get(b.parent) : undefined;
    if (p && !seen.has(p.name)) visit(p, depth + 1);
    if (seen.has(b.name)) return;
    seen.add(b.name);
    out.push(b);
  };
  for (const b of arm.bones) visit(b, 0);
  return out;
}

export function isBoneVisible(arm: ArmatureData, b: Bone): boolean {
  return !b.hide && b.layers.some((l, i) => l && arm.layers[i]);
}

// ------------------------------------------------------------------ rest matrices

const _Y = new Vector3(0, 1, 0);

/** Rotation that maps the bone's local axes into armature space (Y along the bone, rolled). */
export function boneRotation(head: Vec3, tail: Vec3, roll: number): Matrix4 {
  const dir = new Vector3(tail[0] - head[0], tail[1] - head[1], tail[2] - head[2]);
  if (dir.lengthSq() < 1e-20) dir.set(0, 1, 0);
  dir.normalize();
  const m = new Matrix4();
  if (dir.y < -0.999999) {
    // pointing down -Y: rotate 180° about Z
    m.makeRotationZ(Math.PI);
  } else {
    m.makeRotationFromQuaternion(new Quaternion().setFromUnitVectors(_Y, dir));
  }
  return m.multiply(new Matrix4().makeRotationY(roll));
}

/** Rest matrix of a bone in armature space (origin at the head). */
export function boneRestMatrix(b: Bone): Matrix4 {
  const m = boneRotation(b.head, b.tail, b.roll);
  m.setPosition(b.head[0], b.head[1], b.head[2]);
  return m;
}

export function boneLength(b: Bone): number {
  return Math.hypot(b.tail[0] - b.head[0], b.tail[1] - b.head[1], b.tail[2] - b.head[2]);
}

/** Roll that makes the bone's Z axis as close as possible to `axis` (armature space). */
export function rollForAxis(head: Vec3, tail: Vec3, axis: Vector3): number {
  const m0 = boneRotation(head, tail, 0);
  const y = new Vector3().setFromMatrixColumn(m0, 1);
  const z0 = new Vector3().setFromMatrixColumn(m0, 2);
  const x0 = new Vector3().setFromMatrixColumn(m0, 0);
  const a = axis.clone().sub(y.clone().multiplyScalar(axis.dot(y)));
  if (a.lengthSq() < 1e-12) return 0;
  a.normalize();
  // rotating about Y by roll maps z0 -> z0*cos(r) - x0*sin(r)... solve for the angle
  return Math.atan2(-a.dot(x0), a.dot(z0));
}

// ------------------------------------------------------------------ pose basis

export function poseRotationQuat(pb: PoseBone): Quaternion {
  const mode: BoneRotationMode = pb.rotationMode;
  if (mode === 'QUATERNION') {
    const [w, x, y, z] = pb.rotationQuaternion;
    const q = new Quaternion(x, y, z, w);
    return q.lengthSq() > 1e-12 ? q.normalize() : new Quaternion();
  }
  if (mode === 'AXIS_ANGLE') {
    const [a, x, y, z] = pb.rotationAxisAngle;
    const axis = new Vector3(x, y, z);
    if (axis.lengthSq() < 1e-12) return new Quaternion();
    return new Quaternion().setFromAxisAngle(axis.normalize(), a);
  }
  return new Quaternion().setFromEuler(new Euler(pb.rotationEuler[0], pb.rotationEuler[1], pb.rotationEuler[2], threeEulerOrder(mode)));
}

/** Set the rotation channel of `pb` (in its rotation mode) from a quaternion. */
export function setPoseRotationQuat(pb: PoseBone, q: Quaternion, compatible = true): void {
  const mode = pb.rotationMode;
  if (mode === 'QUATERNION') {
    // keep the hemisphere continuous with the previous value
    const [w0, x0, y0, z0] = pb.rotationQuaternion;
    let s = 1;
    if (compatible && w0 * q.w + x0 * q.x + y0 * q.y + z0 * q.z < 0) s = -1;
    pb.rotationQuaternion = [q.w * s, q.x * s, q.y * s, q.z * s];
  } else if (mode === 'AXIS_ANGLE') {
    const qq = q.clone().normalize();
    const ang = 2 * Math.acos(Math.min(1, Math.max(-1, qq.w)));
    const s = Math.sqrt(Math.max(0, 1 - qq.w * qq.w));
    pb.rotationAxisAngle = s < 1e-6 ? [0, pb.rotationAxisAngle[1], pb.rotationAxisAngle[2], pb.rotationAxisAngle[3]] : [ang, qq.x / s, qq.y / s, qq.z / s];
  } else {
    const e = new Euler().setFromQuaternion(q, threeEulerOrder(mode));
    const prev = pb.rotationEuler;
    const comp = (a: number, r: number) => { while (a - r > Math.PI) a -= Math.PI * 2; while (a - r < -Math.PI) a += Math.PI * 2; return a; };
    pb.rotationEuler = compatible ? [comp(e.x, prev[0]), comp(e.y, prev[1]), comp(e.z, prev[2])] : [e.x, e.y, e.z];
  }
}

/** Local pose matrix (bone space): T(loc) R S. */
export function poseBasisMatrix(pb: PoseBone | undefined): Matrix4 {
  if (!pb) return new Matrix4();
  return new Matrix4().compose(new Vector3(...pb.location), poseRotationQuat(pb), new Vector3(...pb.scale));
}

/** Set loc/rot/scale of a pose bone from a basis matrix (respecting locks). */
export function setPoseBasis(pb: PoseBone, m: Matrix4, locks = true): void {
  const p = new Vector3(), q = new Quaternion(), s = new Vector3();
  m.decompose(p, q, s);
  const oldLoc = pb.location.slice(), oldScale = pb.scale.slice();
  const oldRot = { q: pb.rotationQuaternion.slice(), e: pb.rotationEuler.slice(), a: pb.rotationAxisAngle.slice() };
  pb.location = [p.x, p.y, p.z];
  pb.scale = [s.x, s.y, s.z];
  setPoseRotationQuat(pb, q);
  if (!locks) return;
  for (let i = 0; i < 3; i++) {
    if (pb.lockLocation[i]) pb.location[i] = oldLoc[i];
    if (pb.lockScale[i]) pb.scale[i] = oldScale[i];
    if (pb.lockRotation[i]) {
      if (pb.rotationMode === 'QUATERNION') pb.rotationQuaternion[i + 1] = oldRot.q[i + 1];
      else if (pb.rotationMode === 'AXIS_ANGLE') pb.rotationAxisAngle[i + 1] = oldRot.a[i + 1];
      else pb.rotationEuler[i] = oldRot.e[i];
    }
  }
}

// ------------------------------------------------------------------ pose evaluation

export interface PoseResult {
  /** Pose matrix of each bone in armature space (origin at the posed head). */
  pose: Map<string, Matrix4>;
  /** Rest matrix of each bone in armature space. */
  rest: Map<string, Matrix4>;
  /** Skinning matrices: pose * rest^-1 (armature space). */
  skin: Map<string, Matrix4>;
}

const poseCache = new WeakMap<BObject, { key: string; res: PoseResult }>();

/**
 * Evaluate the pose of an armature object (armature space). `rest` ignores the pose (Rest Position or
 * edit mode). `worldOf` resolves object world matrices for constraint targets.
 */
export function evaluatePose(doc: Doc, ob: BObject, opts: { rest?: boolean; worldOf?: (o: BObject) => Matrix4 } = {}): PoseResult {
  const arm = armatureOf(doc, ob);
  const empty: PoseResult = { pose: new Map(), rest: new Map(), skin: new Map() };
  if (!arm) return empty;
  const rest = !!opts.rest || arm.posePosition === 'REST';
  const worldOf = opts.worldOf ?? ((o: BObject) => new MatrixCache(doc).world(o));
  const hasCons = !rest && Object.values(ob.pose ?? {}).some((pb) => pb.constraints?.some((c) => !c.mute));
  const targetKey = hasCons ? JSON.stringify(Object.values(ob.pose ?? {}).flatMap((pb) => pb.constraints.map((c) => {
    const t = c.target ? doc.objects[c.target] : null;
    const p = c.poleTarget ? doc.objects[c.poleTarget as string] : null;
    return [t && t.id !== ob.id ? worldOf(t).elements : 0, t && t.id !== ob.id && t.type === 'ARMATURE' ? JSON.stringify(t.pose) : 0, p && p.id !== ob.id ? worldOf(p).elements : 0];
  }))) + JSON.stringify(worldOf(ob).elements) : '';
  const key = JSON.stringify([arm.bones, rest ? 0 : ob.pose, rest]) + targetKey;
  const hit = poseCache.get(ob);
  if (hit && hit.key === key) return hit.res;

  const order = hierarchyOrder(arm);
  const restM = new Map<string, Matrix4>();
  for (const b of order) restM.set(b.name, boneRestMatrix(b));
  const byName = new Map(arm.bones.map((b) => [b.name, b]));
  const obWorld = hasCons ? worldOf(ob) : new Matrix4();
  const obWorldInv = obWorld.clone().invert();

  const compute = (overrides: Map<string, Matrix4> | null, applyCons: boolean): Map<string, Matrix4> => {
    const pose = new Map<string, Matrix4>();
    for (const b of order) {
      const o = overrides?.get(b.name);
      if (o) { pose.set(b.name, o.clone()); continue; }
      const r = restM.get(b.name)!;
      const basis = rest ? new Matrix4() : poseBasisMatrix(ob.pose?.[b.name]);
      const parent = b.parent ? byName.get(b.parent) : undefined;
      let m: Matrix4;
      if (parent && pose.has(parent.name)) {
        const pp = pose.get(parent.name)!;
        const pr = restM.get(parent.name)!;
        const offs = pr.clone().invert().multiply(r);
        if (b.useInheritRotation && b.useInheritScale) {
          m = pp.clone().multiply(offs).multiply(basis);
        } else {
          // inherit only what is requested: build the head position from the full chain and the
          // rotation/scale from the parts that are inherited
          const full = pp.clone().multiply(offs);
          const pos = new Vector3().setFromMatrixPosition(full);
          const pq = new Quaternion(), ps = new Vector3();
          pp.decompose(new Vector3(), pq, ps);
          const rq = new Quaternion(), rp = new Vector3(), rs = new Vector3();
          pr.decompose(rp, rq, rs);
          const delta = new Matrix4().makeRotationFromQuaternion(b.useInheritRotation ? pq.clone().multiply(rq.clone().invert()) : new Quaternion());
          if (b.useInheritScale) delta.scale(ps);
          const rot = delta.multiply(new Matrix4().extractRotation(r));
          rot.setPosition(pos);
          m = rot.multiply(basis);
        }
      } else {
        m = r.clone().multiply(basis);
      }
      if (applyCons && !rest) applyBoneConstraints(doc, ob, b, m, pose, obWorld, obWorldInv, worldOf, false);
      pose.set(b.name, m);
    }
    return pose;
  };

  let pose = compute(null, true);
  // IK: solve each chain, then recompute everything else with the chain bones fixed
  if (!rest) {
    const overrides = new Map<string, Matrix4>();
    for (const b of order) {
      const pb = ob.pose?.[b.name];
      for (const c of pb?.constraints ?? []) {
        if (c.type !== 'IK' || c.mute || c.influence <= 0) continue;
        solveIK(doc, ob, arm, b, c, pose, restM, obWorld, obWorldInv, worldOf, overrides);
        pose = compute(overrides, true);
      }
    }
  }
  const skin = new Map<string, Matrix4>();
  for (const b of order) skin.set(b.name, pose.get(b.name)!.clone().multiply(restM.get(b.name)!.clone().invert()));
  const res: PoseResult = { pose, rest: restM, skin };
  poseCache.set(ob, { key, res });
  return res;
}

/** World-space target point / matrix of a constraint (object or bone of an armature). */
function targetMatrix(doc: Doc, self: BObject, c: BoneConstraint | { target: string | null; subtarget: string }, pose: Map<string, Matrix4>, obWorld: Matrix4, worldOf: (o: BObject) => Matrix4, useTail = false): Matrix4 | null {
  const t = c.target ? doc.objects[c.target] : null;
  if (!t) return null;
  const sub = c.subtarget;
  if (t.type === 'ARMATURE' && sub) {
    let bm: Matrix4 | undefined;
    if (t.id === self.id) bm = pose.get(sub);
    else bm = evaluatePose(doc, t, { worldOf }).pose.get(sub);
    const tw = t.id === self.id ? obWorld : worldOf(t);
    if (!bm) return tw.clone();
    const m = bm.clone();
    if (useTail) {
      const arm = armatureOf(doc, t);
      const bone = arm ? boneByName(arm, sub) : undefined;
      if (bone) m.multiply(new Matrix4().makeTranslation(0, boneLength(bone), 0));
    }
    return tw.clone().multiply(m);
  }
  return worldOf(t).clone();
}

function applyBoneConstraints(doc: Doc, ob: BObject, b: Bone, m: Matrix4, pose: Map<string, Matrix4>, obWorld: Matrix4, obWorldInv: Matrix4, worldOf: (o: BObject) => Matrix4, _ik: boolean): void {
  const pb = ob.pose?.[b.name];
  if (!pb?.constraints?.length) return;
  for (const c of pb.constraints) {
    if (c.mute || c.influence <= 0 || c.type === 'IK') continue;
    const tw = targetMatrix(doc, ob, c, pose, obWorld, worldOf, !!c.useTail);
    // constraint work happens in world space
    const world = obWorld.clone().multiply(m);
    const pos = new Vector3(), quat = new Quaternion(), scl = new Vector3();
    world.decompose(pos, quat, scl);
    const before = { pos: pos.clone(), quat: quat.clone(), scl: scl.clone() };
    const axes = [c.useX !== false, c.useY !== false, c.useZ !== false];
    switch (c.type) {
      case 'COPY_LOCATION': {
        if (!tw) continue;
        const tp = new Vector3().setFromMatrixPosition(tw);
        const off = c.useOffset ? before.pos : new Vector3();
        if (axes[0]) pos.x = tp.x * (c.invertX ? -1 : 1) + (c.useOffset ? off.x : 0);
        if (axes[1]) pos.y = tp.y * (c.invertY ? -1 : 1) + (c.useOffset ? off.y : 0);
        if (axes[2]) pos.z = tp.z * (c.invertZ ? -1 : 1) + (c.useOffset ? off.z : 0);
        break;
      }
      case 'COPY_ROTATION': {
        if (!tw) continue;
        const tq = new Quaternion();
        tw.decompose(new Vector3(), tq, new Vector3());
        if (axes.every(Boolean) && !c.invertX && !c.invertY && !c.invertZ) { quat.copy(c.useOffset ? tq.clone().multiply(quat) : tq); break; }
        const te = new Euler().setFromQuaternion(tq, 'ZYX');
        const oe = new Euler().setFromQuaternion(quat, 'ZYX');
        if (axes[0]) oe.x = te.x * (c.invertX ? -1 : 1);
        if (axes[1]) oe.y = te.y * (c.invertY ? -1 : 1);
        if (axes[2]) oe.z = te.z * (c.invertZ ? -1 : 1);
        quat.setFromEuler(oe);
        break;
      }
      case 'DAMPED_TRACK': {
        if (!tw) continue;
        const tp = new Vector3().setFromMatrixPosition(tw);
        const dir = tp.sub(pos);
        if (dir.lengthSq() < 1e-12) continue;
        dir.normalize();
        const ta = (c.trackAxis as string) ?? 'TRACK_Y';
        const local: Record<string, Vector3> = {
          TRACK_X: new Vector3(1, 0, 0), TRACK_Y: new Vector3(0, 1, 0), TRACK_Z: new Vector3(0, 0, 1),
          TRACK_NEGATIVE_X: new Vector3(-1, 0, 0), TRACK_NEGATIVE_Y: new Vector3(0, -1, 0), TRACK_NEGATIVE_Z: new Vector3(0, 0, -1),
        };
        const cur = (local[ta] ?? local.TRACK_Y).clone().applyQuaternion(quat).normalize();
        quat.premultiply(new Quaternion().setFromUnitVectors(cur, dir));
        break;
      }
      case 'LIMIT_ROTATION': {
        // limits apply to the bone's local rotation (relative to its rest orientation in the parent)
        const parentRestInv = new Matrix4();
        const local = obWorldInv.clone().multiply(new Matrix4().compose(pos, quat, scl));
        const r = boneRestMatrix(b);
        const parent = b.parent ? pose.get(b.parent) : undefined;
        const arm = armatureOf(doc, ob);
        const pBone = arm && b.parent ? boneByName(arm, b.parent) : undefined;
        const ref = parent && pBone ? parent.clone().multiply(boneRestMatrix(pBone).invert()).multiply(r) : r.clone();
        void parentRestInv;
        const basis = ref.clone().invert().multiply(local);
        const bq = new Quaternion();
        basis.decompose(new Vector3(), bq, new Vector3());
        const e = new Euler().setFromQuaternion(bq, 'ZYX');
        const lim = (v: number, use: unknown, mn: unknown, mx: unknown) => (use ? Math.min(Math.max(v, Number(mn) || 0), Number(mx) || 0) : v);
        e.x = lim(e.x, c.useLimitX, c.minX, c.maxX);
        e.y = lim(e.y, c.useLimitY, c.minY, c.maxY);
        e.z = lim(e.z, c.useLimitZ, c.minZ, c.maxZ);
        bq.setFromEuler(e);
        const nb = new Matrix4().compose(new Vector3().setFromMatrixPosition(basis), bq, new Vector3(1, 1, 1));
        const nw = obWorld.clone().multiply(ref).multiply(nb);
        nw.decompose(new Vector3(), quat, new Vector3());
        break;
      }
    }
    const t = Math.min(1, c.influence);
    if (t < 1) {
      pos.lerpVectors(before.pos, pos, t);
      quat.copy(before.quat.clone().slerp(quat, t));
      scl.lerpVectors(before.scl, scl, t);
    }
    m.copy(obWorldInv.clone().multiply(new Matrix4().compose(pos, quat, scl)));
  }
}

/** Solve an IK chain ending at `tip` (FABRIK on joint positions, then rotate the bones onto them). */
function solveIK(doc: Doc, ob: BObject, arm: ArmatureData, tip: Bone, c: BoneConstraint, pose: Map<string, Matrix4>, restM: Map<string, Matrix4>, obWorld: Matrix4, obWorldInv: Matrix4, worldOf: (o: BObject) => Matrix4, overrides: Map<string, Matrix4>): void {
  const tw = targetMatrix(doc, ob, c, pose, obWorld, worldOf, false);
  if (!tw) return;
  const target = new Vector3().setFromMatrixPosition(tw).applyMatrix4(obWorldInv);
  // chain from the tip up the hierarchy
  const chain: Bone[] = [];
  const byName = new Map(arm.bones.map((b) => [b.name, b]));
  const max = Math.max(0, Math.round(Number(c.chainCount) || 0));
  let cur: Bone | undefined = tip;
  while (cur && (max === 0 || chain.length < max)) {
    chain.unshift(cur);
    cur = cur.parent ? byName.get(cur.parent) : undefined;
  }
  if (!chain.length) return;
  const useTail = c.useTail !== false;
  const mats = chain.map((b) => pose.get(b.name)!.clone());
  const lengths = chain.map((b) => boneLength(b) * new Vector3().setFromMatrixColumn(mats[chain.indexOf(b)], 1).length());
  // joints: heads of each bone + tail of the last one
  const joints: Vector3[] = mats.map((m) => new Vector3().setFromMatrixPosition(m));
  const tipTail = new Vector3(0, boneLength(chain[chain.length - 1]), 0).applyMatrix4(mats[mats.length - 1]);
  joints.push(tipTail);
  const n = joints.length;
  // the end effector is the tail (Use Tail) or the head of the tip bone
  const effIndex = useTail ? n - 1 : n - 2;
  if (effIndex <= 0) return;
  const segLen: number[] = [];
  for (let i = 0; i < n - 1; i++) segLen.push(joints[i].distanceTo(joints[i + 1]));
  void lengths;
  const root = joints[0].clone();
  const total = segLen.slice(0, effIndex).reduce((a, b) => a + b, 0);
  const goal = target.clone();
  const iterations = Math.max(1, Math.round(Number(c.iterations) || 500));
  const P = joints.map((j) => j.clone());
  // pole target: start from a configuration bent towards the pole
  const poleOb = c.poleTarget ? doc.objects[c.poleTarget as string] : null;
  let pole: Vector3 | null = null;
  if (poleOb) {
    const pm = targetMatrix(doc, ob, { target: poleOb.id, subtarget: String(c.poleSubtarget ?? '') }, pose, obWorld, worldOf);
    if (pm) pole = new Vector3().setFromMatrixPosition(pm).applyMatrix4(obWorldInv);
  }
  if (root.distanceTo(goal) >= total) {
    const dir = goal.clone().sub(root).normalize();
    for (let i = 1; i <= effIndex; i++) P[i] = P[i - 1].clone().add(dir.clone().multiplyScalar(segLen[i - 1]));
  } else {
    if (pole) {
      // pre-bend: push middle joints towards the pole
      for (let i = 1; i < effIndex; i++) P[i].lerp(pole, 0.1);
    }
    for (let it = 0; it < Math.min(iterations, 60); it++) {
      P[effIndex].copy(goal);
      for (let i = effIndex - 1; i >= 0; i--) {
        const d = P[i].clone().sub(P[i + 1]);
        P[i] = P[i + 1].clone().add(d.normalize().multiplyScalar(segLen[i]));
      }
      P[0].copy(root);
      for (let i = 0; i < effIndex; i++) {
        const d = P[i + 1].clone().sub(P[i]);
        P[i + 1] = P[i].clone().add(d.normalize().multiplyScalar(segLen[i]));
      }
      if (P[effIndex].distanceTo(goal) < 1e-5) break;
    }
    if (pole) {
      // rotate the solved chain about the root->effector axis so that it faces the pole
      const axis = P[effIndex].clone().sub(P[0]).normalize();
      const mid = P[Math.max(1, Math.floor(effIndex / 2))].clone().sub(P[0]);
      const pv = pole.clone().sub(P[0]);
      const proj = (v: Vector3) => v.clone().sub(axis.clone().multiplyScalar(v.dot(axis)));
      const a = proj(mid), b = proj(pv);
      if (a.lengthSq() > 1e-10 && b.lengthSq() > 1e-10) {
        a.normalize(); b.normalize();
        let ang = Math.acos(Math.min(1, Math.max(-1, a.dot(b))));
        if (new Vector3().crossVectors(a, b).dot(axis) < 0) ang = -ang;
        ang += Number(c.poleAngle) || 0;
        const q = new Quaternion().setFromAxisAngle(axis, ang);
        for (let i = 1; i < n; i++) P[i] = P[i].clone().sub(P[0]).applyQuaternion(q).add(P[0]);
      }
    }
  }
  // rotate each chain bone so that its Y axis points to the next joint (minimal rotation keeps the roll)
  const infl = Math.min(1, c.influence);
  let parentNew: Matrix4 | null = null;
  for (let i = 0; i < chain.length && i < effIndex; i++) {
    const b = chain[i];
    let m = mats[i];
    if (parentNew && b.parent === chain[i - 1].name) {
      // follow the new parent (FK through the solved parent)
      const pr = restM.get(chain[i - 1].name)!, r = restM.get(b.name)!;
      m = parentNew.clone().multiply(pr.clone().invert().multiply(r)).multiply(poseBasisMatrix(ob.pose?.[b.name]));
    }
    const head = new Vector3().setFromMatrixPosition(m);
    const yAxis = new Vector3().setFromMatrixColumn(m, 1).normalize();
    const want = P[i + 1].clone().sub(head);
    if (want.lengthSq() > 1e-12) {
      const q = new Quaternion().setFromUnitVectors(yAxis, want.normalize());
      if (infl < 1) q.slerp(new Quaternion(), 1 - infl);
      const rot = new Matrix4().makeRotationFromQuaternion(q);
      const t = new Matrix4().makeTranslation(head.x, head.y, head.z).multiply(rot).multiply(new Matrix4().makeTranslation(-head.x, -head.y, -head.z));
      m = t.multiply(m);
    }
    overrides.set(b.name, m);
    parentNew = m;
  }
}

/** Pose matrix of a bone with the origin moved to its tail (used for bone parenting). */
export function boneTailPoseMatrix(doc: Doc, armOb: BObject, boneName: string, worldOf?: (o: BObject) => Matrix4): Matrix4 | null {
  const arm = armatureOf(doc, armOb);
  const bone = arm ? boneByName(arm, boneName) : undefined;
  if (!arm || !bone) return null;
  const res = evaluatePose(doc, armOb, { worldOf });
  const m = res.pose.get(bone.name);
  if (!m) return null;
  return m.clone().multiply(new Matrix4().makeTranslation(0, boneLength(bone), 0));
}

// ------------------------------------------------------------------ envelopes

/** Distance-based envelope weight of a point (armature space) for a bone (Blender-like falloff). */
export function envelopeWeight(b: Bone, p: Vector3): number {
  const h = new Vector3(...b.head), t = new Vector3(...b.tail);
  const ht = t.clone().sub(h);
  const l2 = ht.lengthSq();
  let u = l2 > 0 ? p.clone().sub(h).dot(ht) / l2 : 0;
  u = Math.max(0, Math.min(1, u));
  const closest = h.clone().add(ht.multiplyScalar(u));
  const rad = b.headRadius + (b.tailRadius - b.headRadius) * u;
  const d = p.distanceTo(closest);
  if (d <= rad) return b.envelopeWeight;
  const dist = b.envelopeDistance;
  if (dist <= 0 || d > rad + dist) return 0;
  const f = 1 - (d - rad) / dist;
  return b.envelopeWeight * f * f;
}

/** Rotation part helper used by the transform code. */
export function rotationOnly(m: Matrix4): Matrix3 {
  return new Matrix3().setFromMatrix4(new Matrix4().extractRotation(m));
}

/** Install the bone-parent resolver in the matrix cache (Ctrl+P > Bone). */
export function boneParentMatrix(doc: Doc, parent: BObject, bone: string, worldOf: (o: BObject) => Matrix4): Matrix4 | null {
  const m = boneTailPoseMatrix(doc, parent, bone, worldOf);
  return m ? worldOf(parent).clone().multiply(m) : null;
}
