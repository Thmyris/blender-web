// Pose Mode: bone selection, G/R/S of pose bones (in bone space, through the hierarchy), clear
// transforms, copy/paste pose, keyframes on pose bones (F-Curves with `pose.bones["Bone"].…` paths),
// Apply Pose as Rest Pose, IK / bone constraint helpers and the Pose menu.

import { Matrix3, Matrix4, Quaternion, Vector3 } from 'three';
import { app, type OperatorDef } from '../../app';
import type { ArmatureData, BObject, Bone, BoneConstraint, PoseBone, Vec3 } from '../../core/types';
import {
  armatureOf, boneByName, boneLength, boneRestMatrix, defaultPoseBone, evaluatePose, isBoneVisible, poseBasisMatrix, poseBone,
  poseRotationQuat, rollForAxis, setPoseBasis, setPoseRotationQuat, syncPose,
} from '../../core/armature';
import { insertKeyframe, deleteKeyframe, propResolvers } from '../../core/anim';
import { registerEditType, type SelectAction, type TransformPoint } from './edittypes';
import { registerKeymap } from '../../keymap';
import { showMenu, type MenuItem } from '../../ui/menu';
import { pickBone, flipSideName } from './armedit';
import { createObject } from '../../core/scene';
import { activeLayer } from '../../ops/common';
import type { View3D } from './view3d';

export const poseOb = (): BObject | null => {
  if (app.mode !== 'POSE' || !app.editObject) return null;
  const o = app.doc.objects[app.editObject];
  return o?.type === 'ARMATURE' ? o : null;
};
export const poseArm = (): ArmatureData | null => armatureOf(app.doc, poseOb());
const isPose = () => !!poseArm();
const selBones = (arm: ArmatureData) => arm.bones.filter((b) => b.select && isBoneVisible(arm, b));
const anySel = () => { const a = poseArm(); return !!a && selBones(a).length > 0; };

const worldOf = (o: BObject) => app.matrices.world(o);

export function posedMatrices(ob: BObject): Map<string, Matrix4> {
  return evaluatePose(app.doc, ob, { worldOf }).pose;
}

// ------------------------------------------------------------------ selection

function clickSelectPose(view: View3D, ob: BObject, x: number, y: number, extend: boolean): boolean {
  const arm = armatureOf(app.doc, ob);
  if (!arm) return false;
  const hit = pickBone(view, ob, arm, x, y, posedMatrices(ob), false);
  if (!hit) return false;
  selectPoseBone(arm, hit.bone, extend);
  return true;
}

export function selectPoseBone(arm: ArmatureData, b: Bone, extend: boolean): void {
  if (extend) {
    if (b.select && arm.activeBone === b.name) b.select = false;
    else { b.select = true; arm.activeBone = b.name; }
  } else {
    for (const x of arm.bones) x.select = false;
    b.select = true;
    arm.activeBone = b.name;
  }
  app.notify('select', 'data');
}

function regionSelectPose(view: View3D, ob: BObject, inside: (x: number, y: number) => boolean, mode: 'SET' | 'ADD' | 'SUB'): void {
  const arm = armatureOf(app.doc, ob);
  if (!arm) return;
  if (mode === 'SET') for (const b of arm.bones) b.select = false;
  const w = worldOf(ob);
  const mats = posedMatrices(ob);
  for (const b of arm.bones) {
    if (!isBoneVisible(arm, b) || b.hideSelect) continue;
    const m = mats.get(b.name);
    if (!m) continue;
    const L = boneLength(b);
    const pts = [0, 0.5, 1].map((t) => view.view.project(new Vector3(0, L * t, 0).applyMatrix4(m).applyMatrix4(w)));
    if (pts.some((p) => !p.behind && inside(p.x, p.y))) b.select = mode !== 'SUB';
  }
  app.notify('select', 'data');
}

function selectAllPose(arm: ArmatureData, action: SelectAction): void {
  const vis = arm.bones.filter((b) => isBoneVisible(arm, b));
  let a = action;
  if (a === 'TOGGLE') a = vis.some((b) => b.select) ? 'DESELECT' : 'SELECT';
  for (const b of vis) b.select = a === 'SELECT' ? true : a === 'DESELECT' ? false : !b.select;
}

// ------------------------------------------------------------------ transform

let xform: { ob: BObject; mode: string; bones: string[] } | null = null;

function transformPointsPose(ob: BObject, _propSize: number): TransformPoint[] {
  const arm = armatureOf(app.doc, ob);
  if (!arm) return [];
  syncPose(ob, arm);
  const sel = new Set(selBones(arm).map((b) => b.name));
  // skip bones whose (selected) ancestor is transformed as well
  const top = selBones(arm).filter((b) => {
    for (let p = boneByName(arm, b.parent); p; p = boneByName(arm, p.parent)) if (sel.has(p.name)) return false;
    return true;
  });
  const res = evaluatePose(app.doc, ob, { worldOf });
  const w = worldOf(ob).clone(), wi = w.clone().invert();
  xform = { ob, mode: '', bones: top.map((b) => b.name) };
  return top.map((b): TransformPoint => {
    const pb = poseBone(ob, b.name);
    const start = JSON.parse(JSON.stringify(pb)) as PoseBone;
    const armPose = res.pose.get(b.name)!.clone();
    const basis = poseBasisMatrix(pb);
    const P0 = armPose.clone().multiply(basis.clone().invert());
    const P0i = P0.clone().invert();
    const head = new Vector3().setFromMatrixPosition(armPose).applyMatrix4(w);
    return {
      world: head, selected: true, factor: 1,
      apply: (X, mode) => {
        if (xform) xform.mode = mode;
        const nb = P0i.clone().multiply(wi.clone().multiply(X).multiply(w).multiply(armPose));
        Object.assign(pb, JSON.parse(JSON.stringify(start)));
        const tmp = JSON.parse(JSON.stringify(start)) as PoseBone;
        setPoseBasis(tmp, nb);
        if (mode === 'TRANSLATION') {
          if (!(b.useConnect && b.parent)) pb.location = tmp.location;
        } else if (mode === 'RESIZE') {
          pb.scale = tmp.scale;
          if (!(b.useConnect && b.parent)) pb.location = tmp.location;
        } else {
          pb.rotationQuaternion = tmp.rotationQuaternion; pb.rotationEuler = tmp.rotationEuler; pb.rotationAxisAngle = tmp.rotationAxisAngle;
          if (!(b.useConnect && b.parent)) pb.location = tmp.location;
        }
      },
      restore: () => { Object.assign(pb, JSON.parse(JSON.stringify(start))); },
    };
  });
}

function afterTransformPose(ob: BObject, done: boolean): void {
  if (done && xform && app.scene.toolSettings.useKeyframeInsertAuto) {
    const paths = xform.mode === 'TRANSLATION' ? ['location'] : xform.mode === 'RESIZE' ? ['scale'] : ['rotation'];
    const arm = armatureOf(app.doc, ob);
    if (arm) for (const n of xform.bones) keyBone(ob, n, paths);
  }
  if (done) xform = null;
  app.notify('data', 'scene');
}

// ------------------------------------------------------------------ keyframes

export const bonePath = (bone: string, prop: string) => `pose.bones["${bone}"].${prop}`;

/** Rotation data path of a pose bone in its rotation mode. */
function rotationPath(pb: PoseBone): { prop: string; size: number } {
  if (pb.rotationMode === 'QUATERNION') return { prop: 'rotation_quaternion', size: 4 };
  if (pb.rotationMode === 'AXIS_ANGLE') return { prop: 'rotation_axis_angle', size: 4 };
  return { prop: 'rotation_euler', size: 3 };
}

/** Insert keys for a bone; `what` contains 'location', 'rotation' and/or 'scale'. */
export function keyBone(ob: BObject, bone: string, what: string[]): number {
  const pb = poseBone(ob, bone);
  let n = 0;
  const f = app.scene.frameCurrent;
  for (const w of what) {
    const { prop, size } = w === 'rotation' ? rotationPath(pb) : { prop: w, size: 3 };
    for (let i = 0; i < size; i++) { if (insertKeyframe(ob, bonePath(bone, prop), i, f, undefined, app.prefs.keyframeInterpolation)) n++; }
  }
  return n;
}

const PATH_RE = /^pose\.bones\["(.+)"\]\.(location|rotation_quaternion|rotation_euler|rotation_axis_angle|scale)$/;
const FIELD: Record<string, keyof PoseBone> = { location: 'location', rotation_quaternion: 'rotationQuaternion', rotation_euler: 'rotationEuler', rotation_axis_angle: 'rotationAxisAngle', scale: 'scale' };
const LABEL: Record<string, string> = { location: 'Location', rotation_quaternion: 'Quaternion Rotation', rotation_euler: 'Euler Rotation', rotation_axis_angle: 'Axis-Angle Rotation', scale: 'Scale' };

propResolvers.push({
  get(ob, path, index) {
    const m = PATH_RE.exec(path);
    if (!m || ob.type !== 'ARMATURE') return undefined;
    const pb = ob.pose?.[m[1]];
    if (!pb) return 0;
    const arr = pb[FIELD[m[2]]] as number[];
    return arr[index] ?? 0;
  },
  set(ob, path, index, value) {
    const m = PATH_RE.exec(path);
    if (!m || ob.type !== 'ARMATURE') return false;
    const arm = armatureOf(app.doc, ob);
    if (arm && !boneByName(arm, m[1])) return true;
    const pb = poseBone(ob, m[1]);
    (pb[FIELD[m[2]]] as number[])[index] = value;
    return true;
  },
  label(path, index) {
    const m = PATH_RE.exec(path);
    if (!m) return undefined;
    const axis = m[2] === 'rotation_quaternion' || m[2] === 'rotation_axis_angle' ? 'WXYZ'[index] : 'XYZ'[index];
    return `${axis} ${LABEL[m[2]]} (${m[1]})`;
  },
});

const KEYING: { id: string; label: string; what: string[] }[] = [
  { id: 'Location', label: 'Location', what: ['location'] },
  { id: 'Rotation', label: 'Rotation', what: ['rotation'] },
  { id: 'Scaling', label: 'Scaling', what: ['scale'] },
  { id: 'BUILTIN_KSI_LocRot', label: 'LocRot', what: ['location', 'rotation'] },
  { id: 'LocScale', label: 'LocScale', what: ['location', 'scale'] },
  { id: 'LocRotScale', label: 'LocRotScale', what: ['location', 'rotation', 'scale'] },
  { id: 'RotScale', label: 'RotScale', what: ['rotation', 'scale'] },
  { id: 'WholeCharacter', label: 'Whole Character', what: ['location', 'rotation', 'scale'] },
];

// ------------------------------------------------------------------ copy / paste

let poseClipboard: Record<string, PoseBone> | null = null;

// ------------------------------------------------------------------ operators

const poseOp = (o: Omit<OperatorDef, 'undo' | 'register'> & { undo?: boolean; register?: boolean }): OperatorDef => ({ undo: true, register: true, poll: isPose, ...o });
const done = (): 'FINISHED' => { app.notify('data', 'scene', 'select'); return 'FINISHED'; };
const selAction = { name: 'Action', type: 'enum' as const, default: 'TOGGLE', items: [['TOGGLE', 'Toggle'], ['SELECT', 'Select'], ['DESELECT', 'Deselect'], ['INVERT', 'Invert']] as [string, string][] };

function clearTransforms(what: 'loc' | 'rot' | 'scale'): void {
  const ob = poseOb()!, arm = poseArm()!;
  for (const b of selBones(arm)) {
    const pb = poseBone(ob, b.name);
    for (let i = 0; i < 3; i++) {
      if (what === 'loc' && !pb.lockLocation[i]) pb.location[i] = 0;
      if (what === 'scale' && !pb.lockScale[i]) pb.scale[i] = 1;
    }
    if (what === 'rot') {
      if (!pb.lockRotation.some(Boolean)) { pb.rotationQuaternion = [1, 0, 0, 0]; pb.rotationEuler = [0, 0, 0]; pb.rotationAxisAngle = [0, 0, 1, 0]; }
      else for (let i = 0; i < 3; i++) if (!pb.lockRotation[i]) { pb.rotationEuler[i] = 0; pb.rotationQuaternion[i + 1] = 0; }
    }
  }
}

/** Apply the current pose as the new rest pose (Ctrl+A > Apply Pose as Rest Pose). */
function applyPoseAsRest(ob: BObject, arm: ArmatureData): void {
  const res = evaluatePose(app.doc, ob, { worldOf });
  for (const b of arm.bones) {
    const m = res.pose.get(b.name);
    if (!m) continue;
    const L = boneLength(b);
    const head = new Vector3().setFromMatrixPosition(m);
    const tail = new Vector3(0, L, 0).applyMatrix4(m);
    const z = new Vector3().setFromMatrixColumn(m, 2).normalize();
    b.head = [head.x, head.y, head.z];
    b.tail = [tail.x, tail.y, tail.z];
    b.roll = rollForAxis(b.head, b.tail, z);
  }
  for (const b of arm.bones) {
    const pb = poseBone(ob, b.name);
    const keep = { mode: pb.rotationMode, cons: pb.constraints, ll: pb.lockLocation, lr: pb.lockRotation, ls: pb.lockScale };
    Object.assign(pb, defaultPoseBone(), { rotationMode: keep.mode, constraints: keep.cons, lockLocation: keep.ll, lockRotation: keep.lr, lockScale: keep.ls });
  }
  // connected children keep their head at the parent's tail
  for (const b of arm.bones) { const p = boneByName(arm, b.parent); if (p && b.useConnect) b.head = [...p.tail] as Vec3; }
}

function newBoneConstraint(type: BoneConstraint['type'], existing: BoneConstraint[]): BoneConstraint {
  const label: Record<string, string> = { IK: 'IK', COPY_LOCATION: 'Copy Location', COPY_ROTATION: 'Copy Rotation', DAMPED_TRACK: 'Damped Track', LIMIT_ROTATION: 'Limit Rotation' };
  let name = label[type];
  const names = new Set(existing.map((c) => c.name));
  for (let i = 1; names.has(name); i++) name = `${label[type]}.${String(i).padStart(3, '0')}`;
  const c: BoneConstraint = { type, name, mute: false, showExpanded: true, influence: 1, target: null, subtarget: '' };
  if (type === 'IK') Object.assign(c, { chainCount: 0, useTail: true, iterations: 500, poleTarget: null, poleSubtarget: '', poleAngle: 0, useStretch: true });
  if (type === 'COPY_LOCATION' || type === 'COPY_ROTATION') Object.assign(c, { useX: true, useY: true, useZ: true, invertX: false, invertY: false, invertZ: false, useOffset: false });
  if (type === 'DAMPED_TRACK') Object.assign(c, { trackAxis: 'TRACK_Y' });
  if (type === 'LIMIT_ROTATION') Object.assign(c, { useLimitX: false, useLimitY: false, useLimitZ: false, minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 });
  return c;
}
export { newBoneConstraint };

export const POSE_OPERATORS: OperatorDef[] = [
  poseOp({ id: 'pose.select_all', label: '(De)select All', description: 'Toggle selection status of all bones', props: { action: selAction }, exec: (_c, p) => { selectAllPose(poseArm()!, p.action as SelectAction); return done(); } }),
  poseOp({
    id: 'pose.select_hierarchy', label: 'Select Hierarchy', description: 'Select immediate parent/children of selected bones',
    props: { direction: { name: 'Direction', type: 'enum', default: 'PARENT', items: [['PARENT', 'Select Parent'], ['CHILD', 'Select Child']] }, extend: { name: 'Extend', type: 'bool', default: false } },
    exec: (_c, p) => {
      const arm = poseArm()!;
      const act = boneByName(arm, arm.activeBone);
      if (!act) return 'CANCELLED';
      const next = p.direction === 'PARENT' ? boneByName(arm, act.parent) : arm.bones.find((c) => c.parent === act.name && isBoneVisible(arm, c));
      if (!next) return 'CANCELLED';
      if (!p.extend) for (const b of arm.bones) b.select = false;
      next.select = true;
      arm.activeBone = next.name;
      return done();
    },
  }),
  poseOp({
    id: 'pose.select_linked', label: 'Select Connected', description: 'Select bones related to selected ones by parent/child relationships',
    exec: () => {
      const arm = poseArm()!;
      for (const b of selBones(arm)) {
        let root = b;
        for (let p = boneByName(arm, root.parent); p && root.useConnect; p = boneByName(arm, root.parent)) root = p;
        const stack = [root];
        while (stack.length) { const x = stack.pop()!; x.select = true; for (const c of arm.bones) if (c.parent === x.name && c.useConnect && !c.select) stack.push(c); }
      }
      return done();
    },
  }),
  poseOp({ id: 'pose.select_mirror', label: 'Flip Active/Selected Bone', description: 'Activate the bone with a flipped name', exec: () => {
    const arm = poseArm()!;
    for (const b of selBones(arm)) { const m = boneByName(arm, flipSideName(b.name)); if (m && m !== b) { b.select = false; m.select = true; if (arm.activeBone === b.name) arm.activeBone = m.name; } }
    return done();
  } }),
  poseOp({ id: 'pose.loc_clear', label: 'Clear Pose Location', description: 'Reset locations of selected bones to their default values', poll: anySel, exec: () => { clearTransforms('loc'); return done(); } }),
  poseOp({ id: 'pose.rot_clear', label: 'Clear Pose Rotation', description: 'Reset rotations of selected bones to their default values', poll: anySel, exec: () => { clearTransforms('rot'); return done(); } }),
  poseOp({ id: 'pose.scale_clear', label: 'Clear Pose Scale', description: 'Reset scaling of selected bones to their default values', poll: anySel, exec: () => { clearTransforms('scale'); return done(); } }),
  poseOp({ id: 'pose.transforms_clear', label: 'Clear Pose Transforms', description: 'Reset location, rotation, and scaling of selected bones to their default values', poll: anySel, exec: () => { clearTransforms('loc'); clearTransforms('rot'); clearTransforms('scale'); return done(); } }),
  poseOp({
    id: 'pose.copy', label: 'Copy Pose', description: 'Copies the current pose of the selected bones to copy/paste buffer', undo: false, register: false, poll: anySel,
    exec: () => {
      const ob = poseOb()!, arm = poseArm()!;
      poseClipboard = {};
      for (const b of selBones(arm)) poseClipboard[b.name] = JSON.parse(JSON.stringify(poseBone(ob, b.name)));
      app.report('INFO', `Copied pose of ${Object.keys(poseClipboard).length} bone(s)`);
      return 'FINISHED';
    },
  }),
  poseOp({
    id: 'pose.paste', label: 'Paste Pose', description: 'Paste the stored pose on to the current pose',
    props: { flipped: { name: 'Flipped on X-Axis', type: 'bool', default: false }, selected_mask: { name: 'On Selected Only', type: 'bool', default: false } },
    poll: () => isPose() && !!poseClipboard,
    exec: (_c, p) => {
      const ob = poseOb()!, arm = poseArm()!;
      if (!poseClipboard) return 'CANCELLED';
      for (const [name, src] of Object.entries(poseClipboard)) {
        const target = p.flipped ? flipSideName(name) : name;
        const b = boneByName(arm, target);
        if (!b || (p.selected_mask && !b.select)) continue;
        const pb = poseBone(ob, target);
        pb.location = [...src.location] as Vec3;
        pb.scale = [...src.scale] as Vec3;
        pb.rotationMode = src.rotationMode;
        pb.rotationQuaternion = [...src.rotationQuaternion] as PoseBone['rotationQuaternion'];
        pb.rotationEuler = [...src.rotationEuler] as Vec3;
        pb.rotationAxisAngle = [...src.rotationAxisAngle] as PoseBone['rotationAxisAngle'];
        if (p.flipped) {
          // mirror across the X axis of the armature: negate X location, flip Y/Z rotation
          pb.location[0] = -pb.location[0];
          const q = pb.rotationQuaternion; pb.rotationQuaternion = [q[0], q[1], -q[2], -q[3]];
          const e = pb.rotationEuler; pb.rotationEuler = [e[0], -e[1], -e[2]];
          const a = pb.rotationAxisAngle; pb.rotationAxisAngle = [-a[0], -a[1], a[2], a[3]];
        }
      }
      return done();
    },
  }),
  poseOp({
    id: 'pose.keyframe_insert', label: 'Insert Keyframe', description: 'Insert keyframes on the selected bones for the chosen keying set',
    props: { type: { name: 'Keying Set', type: 'enum', default: 'LocRotScale', items: KEYING.map((k) => [k.id, k.label] as [string, string]) } },
    poll: anySel,
    invoke: (ctx) => {
      showMenu(KEYING.map((k) => ({ label: k.label, action: () => void app.callOperator('pose.keyframe_insert', { type: k.id }, { area: ctx.area, exec: true }) })), app.mouse, { title: 'Insert Keyframe Menu', atMouse: true });
      return 'CANCELLED';
    },
    exec: (_c, p) => {
      const ob = poseOb()!, arm = poseArm()!;
      const ks = KEYING.find((k) => k.id === p.type) ?? KEYING[5];
      let n = 0;
      const bones = ks.id === 'WholeCharacter' ? arm.bones : selBones(arm);
      for (const b of bones) n += keyBone(ob, b.name, ks.what);
      app.report('INFO', `Successfully added ${n} keyframes for keying set '${ks.label}'`);
      return done();
    },
  }),
  poseOp({
    id: 'pose.keyframe_delete', label: 'Delete Keyframe', description: 'Remove keyframes on the current frame for the selected bones', poll: anySel,
    exec: () => {
      const ob = poseOb()!, arm = poseArm()!;
      const f = app.scene.frameCurrent;
      let n = 0;
      for (const b of selBones(arm)) for (const fc of ob.fcurves.filter((x) => x.path.startsWith(`pose.bones["${b.name}"]`))) if (deleteKeyframe(ob, fc.path, fc.index, f)) n++;
      app.report('INFO', `${n} keyframe(s) deleted`);
      return done();
    },
  }),
  poseOp({
    id: 'pose.armature_apply', label: 'Apply Pose as Rest Pose', description: 'Apply the current pose as the new rest pose',
    exec: () => { applyPoseAsRest(poseOb()!, poseArm()!); app.tagAllGeometry(); return done(); },
  }),
  poseOp({
    id: 'pose.visual_transform_apply', label: 'Apply Visual Transform to Pose', description: 'Apply final constrained position of pose bones to their transform', poll: anySel,
    exec: () => {
      const ob = poseOb()!, arm = poseArm()!;
      const res = evaluatePose(app.doc, ob, { worldOf });
      for (const b of selBones(arm)) {
        const m = res.pose.get(b.name)!;
        const parent = boneByName(arm, b.parent);
        const r = boneRestMatrix(b);
        const base = parent ? res.pose.get(parent.name)!.clone().multiply(boneRestMatrix(parent).invert()).multiply(r) : r;
        setPoseBasis(poseBone(ob, b.name), base.invert().multiply(m), false);
      }
      return done();
    },
  }),
  poseOp({
    id: 'pose.hide', label: 'Hide Selected', description: 'Tag selected bones to not be visible in Pose Mode', props: { unselected: { name: 'Unselected', type: 'bool', default: false } },
    exec: (_c, p) => { for (const b of poseArm()!.bones) if (p.unselected ? !b.select : b.select) { b.hide = true; b.select = false; } return done(); },
  }),
  poseOp({ id: 'pose.reveal', label: 'Reveal Selected', description: 'Reveal all bones hidden in Pose Mode', exec: () => { for (const b of poseArm()!.bones) if (b.hide) { b.hide = false; b.select = true; } return done(); } }),
  poseOp({
    id: 'pose.ik_add', label: 'Add IK to Bone', description: 'Add IK Constraint to the active Bone',
    props: { target: { name: 'Target', type: 'enum', default: 'BONE', items: [['BONE', 'To Active Bone'], ['EMPTY', 'To New Empty Object'], ['NONE', 'Without Targets']] } },
    poll: () => isPose() && !!poseArm()?.activeBone,
    invoke: (ctx) => {
      const arm = poseArm()!;
      const others = selBones(arm).filter((b) => b.name !== arm.activeBone);
      const items: MenuItem[] = [];
      if (others.length) items.push({ label: 'To Active Bone', action: () => void app.callOperator('pose.ik_add', { target: 'BONE' }, { area: ctx.area, exec: true }) });
      items.push({ label: 'To New Empty Object', action: () => void app.callOperator('pose.ik_add', { target: 'EMPTY' }, { area: ctx.area, exec: true }) });
      items.push({ label: 'Without Targets', action: () => void app.callOperator('pose.ik_add', { target: 'NONE' }, { area: ctx.area, exec: true }) });
      showMenu(items, app.mouse, { title: 'Add IK', atMouse: true });
      return 'CANCELLED';
    },
    exec: (_c, p) => {
      const ob = poseOb()!, arm = poseArm()!;
      // Blender adds the IK to the active bone with the other selected bone as its target
      const act = boneByName(arm, arm.activeBone)!;
      const pb = poseBone(ob, act.name);
      const c = newBoneConstraint('IK', pb.constraints);
      if (p.target !== 'NONE') {
        const other = selBones(arm).find((b) => b.name !== act.name);
        if (other && p.target === 'BONE') { c.target = ob.id; c.subtarget = other.name; }
        else {
          // new empty at the bone's tail
          const res = evaluatePose(app.doc, ob, { worldOf });
          const tail = new Vector3(0, boneLength(act), 0).applyMatrix4(res.pose.get(act.name)!).applyMatrix4(worldOf(ob));
          const e = createObject(app.doc, 'EMPTY', `${act.name}.IK`, null);
          e.location = [tail.x, tail.y, tail.z];
          e.layers = new Array(20).fill(false); e.layers[activeLayer()] = true;
          e.emptyDrawSize = Math.max(0.1, boneLength(act) * 0.25);
          app.scene.objects.push(e.id);
          c.target = e.id;
        }
      }
      pb.constraints.push(c);
      return done();
    },
  }),
  poseOp({
    id: 'pose.ik_clear', label: 'Remove IK', description: 'Remove all IK Constraints from selected bones', poll: anySel,
    exec: () => { const ob = poseOb()!; for (const b of selBones(poseArm()!)) { const pb = poseBone(ob, b.name); pb.constraints = pb.constraints.filter((c) => c.type !== 'IK'); } return done(); },
  }),
  poseOp({
    id: 'pose.constraint_add', label: 'Add Constraint', description: 'Add a constraint to the active bone',
    props: { type: { name: 'Type', type: 'enum', default: 'COPY_LOCATION', items: [['COPY_LOCATION', 'Copy Location'], ['COPY_ROTATION', 'Copy Rotation'], ['DAMPED_TRACK', 'Damped Track'], ['IK', 'Inverse Kinematics'], ['LIMIT_ROTATION', 'Limit Rotation']] } },
    poll: () => isPose() && !!poseArm()?.activeBone,
    exec: (_c, p) => {
      const ob = poseOb()!, arm = poseArm()!;
      const pb = poseBone(ob, arm.activeBone!);
      pb.constraints.push(newBoneConstraint(p.type as BoneConstraint['type'], pb.constraints));
      return done();
    },
  }),
  poseOp({
    id: 'pose.constraint_add_with_targets', label: 'Add Constraint (with Targets)', description: 'Add a constraint to the active bone, with target (where applicable) set to the selected objects/bones',
    props: { type: { name: 'Type', type: 'enum', default: 'COPY_LOCATION', items: [['COPY_LOCATION', 'Copy Location'], ['COPY_ROTATION', 'Copy Rotation'], ['DAMPED_TRACK', 'Damped Track'], ['IK', 'Inverse Kinematics'], ['LIMIT_ROTATION', 'Limit Rotation']] } },
    poll: () => isPose() && !!poseArm()?.activeBone,
    invoke: (ctx) => {
      showMenu([
        { type: 'label', label: 'Transform' },
        { label: 'Copy Location', icon: 'CONSTRAINT_DATA', action: () => void app.callOperator('pose.constraint_add_with_targets', { type: 'COPY_LOCATION' }, { area: ctx.area, exec: true }) },
        { label: 'Copy Rotation', icon: 'CONSTRAINT_DATA', action: () => void app.callOperator('pose.constraint_add_with_targets', { type: 'COPY_ROTATION' }, { area: ctx.area, exec: true }) },
        { label: 'Limit Rotation', icon: 'CONSTRAINT_DATA', action: () => void app.callOperator('pose.constraint_add_with_targets', { type: 'LIMIT_ROTATION' }, { area: ctx.area, exec: true }) },
        { type: 'label', label: 'Tracking' },
        { label: 'Damped Track', icon: 'CONSTRAINT_DATA', action: () => void app.callOperator('pose.constraint_add_with_targets', { type: 'DAMPED_TRACK' }, { area: ctx.area, exec: true }) },
        { label: 'Inverse Kinematics', icon: 'CONSTRAINT_DATA', action: () => void app.callOperator('pose.constraint_add_with_targets', { type: 'IK' }, { area: ctx.area, exec: true }) },
      ], app.mouse, { title: 'Add Constraint (with Targets)', atMouse: true });
      return 'CANCELLED';
    },
    exec: (_c, p) => {
      const ob = poseOb()!, arm = poseArm()!;
      const pb = poseBone(ob, arm.activeBone!);
      const c = newBoneConstraint(p.type as BoneConstraint['type'], pb.constraints);
      const other = selBones(arm).find((b) => b.name !== arm.activeBone);
      if (other) { c.target = ob.id; c.subtarget = other.name; }
      else { const o = app.selectedObjects().find((x) => x.id !== ob.id); if (o) c.target = o.id; }
      pb.constraints.push(c);
      return done();
    },
  }),
  poseOp({
    id: 'pose.constraints_clear', label: 'Clear Pose Constraints', description: 'Clear all the constraints for the selected bones', poll: anySel,
    exec: () => { const ob = poseOb()!; for (const b of selBones(poseArm()!)) poseBone(ob, b.name).constraints = []; return done(); },
  }),
  poseOp({
    id: 'pose.rotation_mode_set', label: 'Set Rotation Mode', description: 'Set the rotation representation used by selected bones',
    props: { type: { name: 'Rotation Mode', type: 'enum', default: 'QUATERNION', items: [['QUATERNION', 'Quaternion (WXYZ)'], ['XYZ', 'XYZ Euler'], ['XZY', 'XZY Euler'], ['YXZ', 'YXZ Euler'], ['YZX', 'YZX Euler'], ['ZXY', 'ZXY Euler'], ['ZYX', 'ZYX Euler'], ['AXIS_ANGLE', 'Axis Angle']] } },
    poll: anySel,
    exec: (_c, p) => { const ob = poseOb()!; for (const b of selBones(poseArm()!)) setRotationMode(poseBone(ob, b.name), p.type as PoseBone['rotationMode']); return done(); },
  }),
  {
    id: 'object.posemode_toggle', label: 'Toggle Pose Mode', description: 'Enable or disable posing/selecting bones', undo: true, register: true,
    poll: () => app.activeObject?.type === 'ARMATURE' || app.mode === 'POSE',
    exec: (ctx) => app.operator('object.mode_set')!.exec!(ctx, { mode: app.mode === 'POSE' ? 'OBJECT' : 'POSE', toggle: false }) as 'FINISHED',
  },
];

/** Change a pose bone's rotation mode keeping the same orientation. */
export function setRotationMode(pb: PoseBone, mode: PoseBone['rotationMode']): void {
  if (pb.rotationMode === mode) return;
  const q = poseRotationQuat(pb);
  pb.rotationMode = mode;
  setPoseRotationQuat(pb, q, false);
}

// ------------------------------------------------------------------ menus

const op = (label: string, id: string, props?: Record<string, unknown>, icon?: string): MenuItem => ({ label, op: id, props, icon });
const sep: MenuItem = { type: 'separator' };

export function poseMenu(): MenuItem[] {
  return [
    op('Undo History', 'ed.undo_history'), op('Redo', 'ed.redo'), op('Undo', 'ed.undo'),
    sep,
    { type: 'submenu', label: 'Transform', items: [op('Grab/Move', 'transform.translate'), op('Rotate', 'transform.rotate'), op('Scale', 'transform.resize')] },
    { type: 'submenu', label: 'Clear Transform', items: [op('All', 'pose.transforms_clear'), sep, op('Location', 'pose.loc_clear'), op('Rotation', 'pose.rot_clear'), op('Scale', 'pose.scale_clear')] },
    { type: 'submenu', label: 'Apply', items: [op('Apply Pose as Rest Pose', 'pose.armature_apply'), op('Apply Visual Transform to Pose', 'pose.visual_transform_apply')] },
    sep,
    { type: 'submenu', label: 'Animation', items: [op('Insert Keyframe...', 'pose.keyframe_insert'), op('Delete Keyframes...', 'pose.keyframe_delete')] },
    sep,
    op('Copy Pose', 'pose.copy'),
    op('Paste Pose', 'pose.paste', { flipped: false }),
    op('Paste X-Flipped Pose', 'pose.paste', { flipped: true }),
    sep,
    { type: 'submenu', label: 'Constraints', items: [op('Add (With Targets)...', 'pose.constraint_add_with_targets'), op('Clear Pose Constraints', 'pose.constraints_clear')] },
    { type: 'submenu', label: 'Inverse Kinematics', items: [op('Add IK...', 'pose.ik_add'), op('Clear IK', 'pose.ik_clear')] },
    sep,
    { type: 'submenu', label: 'Rotation Mode', items: [['QUATERNION', 'Quaternion (WXYZ)'], ['XYZ', 'XYZ Euler'], ['XZY', 'XZY Euler'], ['YXZ', 'YXZ Euler'], ['YZX', 'YZX Euler'], ['ZXY', 'ZXY Euler'], ['ZYX', 'ZYX Euler'], ['AXIS_ANGLE', 'Axis Angle']].map(([t, l]) => op(l, 'pose.rotation_mode_set', { type: t })) },
    sep,
    { type: 'submenu', label: 'Show/Hide', items: [op('Show Hidden', 'pose.reveal'), op('Hide Selected', 'pose.hide', { unselected: false }), op('Hide Unselected', 'pose.hide', { unselected: true })] },
  ];
}

function poseSelectMenu(): MenuItem[] {
  return [
    op('Border Select', 'view3d.select_border'), op('Circle Select', 'view3d.select_circle'),
    sep,
    op('(De)select All', 'pose.select_all', { action: 'TOGGLE' }), op('Inverse', 'pose.select_all', { action: 'INVERT' }),
    sep,
    op('Parent', 'pose.select_hierarchy', { direction: 'PARENT', extend: false }),
    op('Child', 'pose.select_hierarchy', { direction: 'CHILD', extend: false }),
    op('Extend Parent', 'pose.select_hierarchy', { direction: 'PARENT', extend: true }),
    op('Extend Child', 'pose.select_hierarchy', { direction: 'CHILD', extend: true }),
    sep,
    op('Connected', 'pose.select_linked'),
    op('Flip Active', 'pose.select_mirror'),
  ];
}

// ------------------------------------------------------------------ registration

registerEditType({
  types: ['ARMATURE'],
  mode: 'POSE',
  enter: (ob) => { const arm = armatureOf(app.doc, ob); if (arm) syncPose(ob, arm); },
  clickSelect: clickSelectPose,
  regionSelect: regionSelectPose,
  selectAll: (ob, a) => { const arm = armatureOf(app.doc, ob); if (arm) selectAllPose(arm, a); },
  hasSelection: (ob) => { const arm = armatureOf(app.doc, ob); return !!arm && selBones(arm).length > 0; },
  transformPoints: transformPointsPose,
  afterTransform: afterTransformPose,
  selectedPoints: (ob) => {
    const arm = armatureOf(app.doc, ob);
    if (!arm) return [];
    const mats = posedMatrices(ob);
    const w = worldOf(ob);
    return selBones(arm).map((b) => new Vector3().setFromMatrixPosition(mats.get(b.name) ?? new Matrix4()).applyMatrix4(w));
  },
  activePoint: (ob) => {
    const arm = armatureOf(app.doc, ob);
    const b = arm ? boneByName(arm, arm.activeBone) : undefined;
    const m = b ? posedMatrices(ob).get(b.name) : undefined;
    return m ? new Vector3().setFromMatrixPosition(m).applyMatrix4(worldOf(ob)) : null;
  },
  orientation: (ob, orient) => {
    if (orient === 'GLOBAL' || orient === 'VIEW') return null;
    const arm = armatureOf(app.doc, ob);
    const b = arm ? boneByName(arm, arm.activeBone) ?? selBones(arm)[0] : undefined;
    const m = b ? posedMatrices(ob).get(b.name) : undefined;
    if (!m) return null;
    const q = new Quaternion();
    worldOf(ob).clone().multiply(m).decompose(new Vector3(), q, new Vector3());
    return new Matrix3().setFromMatrix4(new Matrix4().makeRotationFromQuaternion(q));
  },
  menuLabel: 'Pose',
  menu: poseMenu,
  selectMenu: poseSelectMenu,
});

const C = { ctrl: true }, S = { shift: true }, A = { alt: true }, CS = { ctrl: true, shift: true }, CA = { ctrl: true, alt: true };
const K = (code: string, op: string, props: Record<string, unknown> = {}, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}) => ({ code, space: 'VIEW_3D' as const, op, props, mode: 'POSE' as const, poll: isPose, ...mods });
registerKeymap([
  K('KeyA', 'pose.select_all', { action: 'TOGGLE' }),
  K('KeyI', 'pose.select_all', { action: 'INVERT' }, C),
  K('KeyG', 'pose.loc_clear', {}, A),
  K('KeyR', 'pose.rot_clear', {}, A),
  K('KeyS', 'pose.scale_clear', {}, A),
  K('KeyC', 'pose.copy', {}, C),
  K('KeyV', 'pose.paste', { flipped: false }, C),
  K('KeyV', 'pose.paste', { flipped: true }, CS),
  K('KeyI', 'pose.keyframe_insert'),
  K('KeyI', 'pose.keyframe_delete', {}, A),
  K('KeyI', 'pose.ik_add', {}, S),
  K('KeyI', 'pose.ik_clear', {}, CA),
  K('KeyC', 'pose.constraint_add_with_targets', {}, CS),
  K('KeyL', 'pose.select_linked'),
  K('BracketLeft', 'pose.select_hierarchy', { direction: 'PARENT', extend: false }),
  K('BracketRight', 'pose.select_hierarchy', { direction: 'CHILD', extend: false }),
  K('BracketLeft', 'pose.select_hierarchy', { direction: 'PARENT', extend: true }, S),
  K('BracketRight', 'pose.select_hierarchy', { direction: 'CHILD', extend: true }, S),
  K('KeyH', 'pose.hide', { unselected: false }),
  K('KeyH', 'pose.hide', { unselected: true }, S),
  K('KeyH', 'pose.reveal', {}, A),
  { code: 'KeyA', space: 'VIEW_3D', mode: 'POSE', poll: isPose, ctrl: true, title: 'Apply', menu: () => [op('Apply Pose as Rest Pose', 'pose.armature_apply'), op('Apply Visual Transform to Pose', 'pose.visual_transform_apply')] },
  { code: 'Tab', space: 'VIEW_3D', op: 'object.posemode_toggle', props: {}, mode: 'POSE', ctrl: true, poll: isPose },
  { code: 'Tab', space: 'VIEW_3D', op: 'object.posemode_toggle', props: {}, mode: 'OBJECT', ctrl: true, poll: () => app.activeObject?.type === 'ARMATURE' },
  { code: 'Tab', space: 'VIEW_3D', op: 'object.posemode_toggle', props: {}, mode: 'EDIT', ctrl: true, poll: () => app.editObj?.type === 'ARMATURE' },
]);

