// Armature Edit Mode: selection of bones, heads and tails, G/R/S of joints (connected bones share
// joints, bone roll follows rotations), and the armature.* edit operators (extrude, add, delete,
// duplicate, parenting, roll, merge, subdivide, switch direction, names, symmetrize, hide/reveal).

import { Matrix3, Matrix4, Vector3 } from 'three';
import { app, type ModalHandler, type OperatorDef, type OpContext } from '../../app';
import type { ArmatureData, BObject, Bone, Vec3 } from '../../core/types';
import {
  armatureOf, boneByName, boneRestMatrix, boneRotation, defaultBone, isBoneVisible, rollForAxis, uniqueBoneName, syncPose, renameBone,
} from '../../core/armature';
import { registerEditType, segmentDistance, type TransformPoint, type SelectAction } from './edittypes';
import { registerKeymap } from '../../keymap';
import { showMenu, type MenuItem } from '../../ui/menu';
import { confirmPopup } from '../../ui/popup';
import { startTransform } from './transform';
import { startLasso } from './select';
import { viewOf } from '../../ops/common';
import type { View3D } from './view3d';

// ------------------------------------------------------------------ context

export const editArmOb = (): BObject | null => (app.mode === 'EDIT' && app.editObj?.type === 'ARMATURE' ? app.editObj : null);
export const editArm = (): ArmatureData | null => armatureOf(app.doc, editArmOb());
const isArmEdit = () => !!editArm();
const anyBoneSel = () => !!editArm()?.bones.some((b) => b.select || b.selectHead || b.selectTail);

const v3 = (p: Vec3) => new Vector3(p[0], p[1], p[2]);
const arr = (v: Vector3): Vec3 => [v.x, v.y, v.z];

export function parentOf(arm: ArmatureData, b: Bone): Bone | undefined { return boneByName(arm, b.parent); }

/** Make shared joints of connected bones agree and bone selection imply joint selection. */
export function flushArmSelection(arm: ArmatureData): void {
  for (const b of arm.bones) if (b.select) { b.selectHead = true; b.selectTail = true; }
  for (const b of arm.bones) {
    const p = b.useConnect ? parentOf(arm, b) : undefined;
    if (!p) continue;
    const s = b.selectHead || p.selectTail;
    b.selectHead = s; p.selectTail = s;
  }
  for (const b of arm.bones) if (b.hide) { b.select = false; b.selectHead = false; b.selectTail = false; }
  if (arm.activeBone && !boneByName(arm, arm.activeBone)) arm.activeBone = null;
}

function deselectAll(arm: ArmatureData): void {
  for (const b of arm.bones) { b.select = false; b.selectHead = false; b.selectTail = false; }
}

function selectAllArm(arm: ArmatureData, action: SelectAction): void {
  const vis = arm.bones.filter((b) => isBoneVisible(arm, b));
  let a = action;
  if (a === 'TOGGLE') a = vis.some((b) => b.select || b.selectHead || b.selectTail) ? 'DESELECT' : 'SELECT';
  for (const b of vis) {
    if (a === 'SELECT') { b.select = b.selectHead = b.selectTail = true; }
    else if (a === 'DESELECT') { b.select = b.selectHead = b.selectTail = false; }
    else { const s = !b.select; b.select = b.selectHead = b.selectTail = s; }
  }
  flushArmSelection(arm);
}

/** Deselect a bone, including the joint it shares with a connected parent (unless that parent is selected). */
function deselectBone(arm: ArmatureData, b: Bone): void {
  b.select = false; b.selectHead = false; b.selectTail = false;
  const p = b.useConnect ? parentOf(arm, b) : undefined;
  if (p && !p.select) p.selectTail = false;
  for (const c of arm.bones) if (c.useConnect && c.parent === b.name && !c.select) c.selectHead = false;
}

// ------------------------------------------------------------------ picking

interface ArmHit { bone: Bone; part: 'HEAD' | 'TAIL' | 'BODY'; dist: number }

/** Bone head/tail/body under the mouse, using the rest (edit) or posed bone matrices. */
export function pickBone(view: View3D, ob: BObject, arm: ArmatureData, x: number, y: number, mats?: Map<string, Matrix4>, joints = true): ArmHit | null {
  const w = app.matrices.world(ob);
  let best: ArmHit | null = null;
  for (const b of arm.bones) {
    if (!isBoneVisible(arm, b) || b.hideSelect) continue;
    const m = mats?.get(b.name) ?? boneRestMatrix(b);
    const len = Math.hypot(b.tail[0] - b.head[0], b.tail[1] - b.head[1], b.tail[2] - b.head[2]);
    const h = new Vector3(0, 0, 0).applyMatrix4(m).applyMatrix4(w), t = new Vector3(0, len, 0).applyMatrix4(m).applyMatrix4(w);
    const ph = view.view.project(h), pt = view.view.project(t);
    if (ph.behind && pt.behind) continue;
    if (joints) {
      const dh = Math.hypot(ph.x - x, ph.y - y), dt = Math.hypot(pt.x - x, pt.y - y);
      const jr = Math.max(7, Math.min(14, Math.hypot(pt.x - ph.x, pt.y - ph.y) * 0.07));
      // the head of a connected bone is its parent's tail
      if (!ph.behind && dh < jr && (!best || dh < best.dist) && !b.useConnect) best = { bone: b, part: 'HEAD', dist: dh * 0.5 };
      if (!pt.behind && dt < jr && (!best || dt * 0.5 < best.dist)) best = { bone: b, part: 'TAIL', dist: dt * 0.5 };
    }
    const d = segmentDistance(x, y, ph.x, ph.y, pt.x, pt.y);
    const r = Math.max(6, Math.min(20, Math.hypot(pt.x - ph.x, pt.y - ph.y) * 0.1));
    if (d < r && (!best || d < best.dist)) best = { bone: b, part: 'BODY', dist: d };
  }
  return best;
}

function clickSelectArm(view: View3D, ob: BObject, x: number, y: number, extend: boolean): boolean {
  const arm = armatureOf(app.doc, ob);
  if (!arm) return false;
  const hit = pickBone(view, ob, arm, x, y);
  if (!hit) return false;
  const b = hit.bone;
  if (hit.part === 'BODY') {
    if (extend && b.select && arm.activeBone === b.name) deselectBone(arm, b);
    else {
      if (!extend) deselectAll(arm);
      b.select = b.selectHead = b.selectTail = true;
      arm.activeBone = b.name;
    }
  } else {
    const key = hit.part === 'HEAD' ? 'selectHead' : 'selectTail';
    if (extend && b[key]) {
      b[key] = false;
      if (b.select) b.select = false;
      if (hit.part === 'TAIL') for (const c of arm.bones) if (c.useConnect && c.parent === b.name) { c.selectHead = false; c.select = false; }
    } else {
      if (!extend) deselectAll(arm);
      b[key] = true;
      if (b.selectHead && b.selectTail) b.select = true;
    }
    arm.activeBone = b.name;
  }
  flushArmSelection(arm);
  app.notify('select', 'data');
  return true;
}

function regionSelectArm(view: View3D, ob: BObject, inside: (x: number, y: number) => boolean, mode: 'SET' | 'ADD' | 'SUB'): void {
  const arm = armatureOf(app.doc, ob);
  if (!arm) return;
  if (mode === 'SET') deselectAll(arm);
  const w = app.matrices.world(ob);
  const val = mode !== 'SUB';
  for (const b of arm.bones) {
    if (!isBoneVisible(arm, b) || b.hideSelect) continue;
    const ph = view.view.project(v3(b.head).applyMatrix4(w)), pt = view.view.project(v3(b.tail).applyMatrix4(w));
    const hi = !ph.behind && inside(ph.x, ph.y), ti = !pt.behind && inside(pt.x, pt.y);
    if (hi) b.selectHead = val;
    if (ti) b.selectTail = val;
    if (hi && ti) b.select = val;
    else if (!val && (hi || ti)) b.select = false;
  }
  flushArmSelection(arm);
  app.notify('select', 'data');
}

// ------------------------------------------------------------------ transform

interface RollTrack { bone: Bone; z: Vector3; roll: number }
let xformX: Matrix4 | null = null;
let rollTracks: RollTrack[] = [];
/** Mirror edits across X (X-Axis Mirror option, or forced by Extrude Forked). */
let forceMirror = false;

/** Name with the side flipped: "Arm.L" <-> "Arm.R", "Left" <-> "Right", "_l" <-> "_r", ... */
export function flipSideName(name: string): string {
  const swaps: [RegExp, (m: string) => string][] = [
    [/([._\- ])([LlRr])(\.\d+)?$/, (m) => m.replace(/([._\- ])([LlRr])(\.\d+)?$/, (_a, sep: string, s: string, num: string | undefined) => `${sep}${({ L: 'R', R: 'L', l: 'r', r: 'l' } as Record<string, string>)[s]}${num ?? ''}`)],
    [/^([LlRr])([._\- ])/, (m) => m.replace(/^([LlRr])([._\- ])/, (_a, s: string, sep: string) => `${({ L: 'R', R: 'L', l: 'r', r: 'l' } as Record<string, string>)[s]}${sep}`)],
    [/(Left|Right|left|right|LEFT|RIGHT)/, (m) => m.replace(/(Left|Right|left|right|LEFT|RIGHT)/, (s) => ({ Left: 'Right', Right: 'Left', left: 'right', right: 'left', LEFT: 'RIGHT', RIGHT: 'LEFT' } as Record<string, string>)[s])],
  ];
  for (const [re, fn] of swaps) if (re.test(name)) return fn(name);
  return name;
}

function mirrorBones(arm: ArmatureData): void {
  if (!arm.useMirrorX && !forceMirror) return;
  for (const b of arm.bones) {
    if (!(b.selectHead || b.selectTail)) continue;
    const mn = flipSideName(b.name);
    if (mn === b.name) continue;
    const m = boneByName(arm, mn);
    if (!m || m.select || (m.selectHead && m.selectTail)) continue;
    if (b.selectHead && !m.selectHead) m.head = [-b.head[0], b.head[1], b.head[2]];
    if (b.selectTail && !m.selectTail) m.tail = [-b.tail[0], b.tail[1], b.tail[2]];
    m.roll = -b.roll;
    if (b.select) { m.envelopeDistance = b.envelopeDistance; m.headRadius = b.headRadius; m.tailRadius = b.tailRadius; }
  }
}

function syncConnected(arm: ArmatureData): void {
  for (const b of arm.bones) {
    const p = b.useConnect ? parentOf(arm, b) : undefined;
    if (p) b.head = [...p.tail] as Vec3;
  }
}

function transformPointsArm(ob: BObject, propSize: number): TransformPoint[] {
  const arm = armatureOf(app.doc, ob);
  if (!arm) return [];
  flushArmSelection(arm);
  const w = app.matrices.world(ob).clone();
  const wi = w.clone().invert();
  const pts: TransformPoint[] = [];
  xformX = null;
  rollTracks = arm.bones.filter((b) => b.select).map((b) => ({ bone: b, z: new Vector3().setFromMatrixColumn(boneRotation(b.head, b.tail, b.roll), 2), roll: b.roll }));
  const joint = (b: Bone, end: 'head' | 'tail', selected: boolean) => {
    const start = [...b[end]] as Vec3;
    const world = v3(start).applyMatrix4(w);
    pts.push({
      world: world.clone(), selected, factor: selected ? 1 : 0,
      apply: (X) => {
        const p = world.clone().applyMatrix4(X).applyMatrix4(wi);
        b[end] = arr(p);
        if (selected) xformX = X;
      },
      restore: () => { b[end] = [...start] as Vec3; },
    });
  };
  for (const b of arm.bones) {
    if (!isBoneVisible(arm, b)) continue;
    if (!b.useConnect || !parentOf(arm, b)) {
      if (b.selectHead) joint(b, 'head', true);
      else if (propSize > 0) joint(b, 'head', false);
    }
    if (b.selectTail) joint(b, 'tail', true);
    else if (propSize > 0) joint(b, 'tail', false);
  }
  if (propSize > 0) {
    const sel = pts.filter((p) => p.selected).map((p) => p.world);
    return pts.filter((p) => p.selected || sel.some((s) => s.distanceTo(p.world) < propSize));
  }
  return pts;
}

function afterTransformArm(ob: BObject, done: boolean): void {
  const arm = armatureOf(app.doc, ob);
  if (!arm) return;
  syncConnected(arm);
  // the roll of fully selected bones follows the rotation
  if (xformX) {
    const rot = new Matrix4().extractRotation(xformX);
    const w = app.matrices.world(ob);
    const wr = new Matrix4().extractRotation(w);
    const local = wr.clone().invert().multiply(rot).multiply(wr);
    for (const t of rollTracks) {
      const z = t.z.clone().applyMatrix4(local).normalize();
      t.bone.roll = rollForAxis(t.bone.head, t.bone.tail, z);
    }
  }
  mirrorBones(arm);
  syncConnected(arm);
  if (done) { forceMirror = false; xformX = null; }
  app.notify('data');
}

function selectedPointsArm(ob: BObject): Vector3[] {
  const arm = armatureOf(app.doc, ob);
  if (!arm) return [];
  const w = app.matrices.world(ob);
  const out: Vector3[] = [];
  for (const b of arm.bones) {
    if (b.selectHead && !(b.useConnect && parentOf(arm, b))) out.push(v3(b.head).applyMatrix4(w));
    if (b.selectTail) out.push(v3(b.tail).applyMatrix4(w));
  }
  return out;
}

// ------------------------------------------------------------------ helpers for operators

function ctxView(ctx: OpContext): View3D | null { return viewOf(ctx); }

function grab(ctx: OpContext): void {
  const view = ctxView(ctx);
  if (!view) return;
  const r = view.canvasRect();
  startTransform({ mode: 'TRANSLATION', view, mouse: { x: app.mouse.x - r.left, y: app.mouse.y - r.top } });
}

function newBone(arm: ArmatureData, name: string, head: Vec3, tail: Vec3, template?: Bone): Bone {
  const b = defaultBone(uniqueBoneName(arm, name), head, tail);
  if (template) {
    b.layers = template.layers.slice();
    b.envelopeDistance = template.envelopeDistance; b.headRadius = template.tailRadius; b.tailRadius = template.tailRadius;
    b.useDeform = template.useDeform; b.roll = template.roll;
  }
  arm.bones.push(b);
  return b;
}

function done(): 'FINISHED' {
  const arm = editArm(), ob = editArmOb();
  if (arm) flushArmSelection(arm);
  if (arm && ob) syncPose(ob, arm);
  app.notify('data', 'select', 'scene');
  return 'FINISHED';
}

/** Selected bones whose tail is selected (extrusion sources). */
function extrudeSources(arm: ArmatureData): { bone: Bone; end: 'head' | 'tail' }[] {
  const out: { bone: Bone; end: 'head' | 'tail' }[] = [];
  for (const b of arm.bones) {
    if (!isBoneVisible(arm, b)) continue;
    if (b.selectTail) out.push({ bone: b, end: 'tail' });
    else if (b.selectHead && !(b.useConnect && parentOf(arm, b))) out.push({ bone: b, end: 'head' });
  }
  return out;
}

function extrude(forked: boolean): boolean {
  const arm = editArm();
  if (!arm) return false;
  const src = extrudeSources(arm);
  if (!src.length) return false;
  const created: Bone[] = [];
  for (const { bone, end } of src) {
    const at = [...bone[end]] as Vec3;
    const sides = forked ? ['_L', '_R'] : [''];
    for (const side of sides) {
      let name = bone.name;
      if (forked) name = `${bone.name.replace(/[._][LR]$/, '')}${side}`;
      const nb = newBone(arm, name, at, [...at] as Vec3, bone);
      nb.roll = bone.roll;
      if (end === 'tail') { nb.parent = bone.name; nb.useConnect = true; }
      else { nb.parent = bone.parent; nb.useConnect = false; }
      created.push(nb);
    }
  }
  deselectAll(arm);
  for (const nb of created) { nb.selectTail = true; }
  arm.activeBone = created[created.length - 1]?.name ?? arm.activeBone;
  forceMirror = forked;
  flushArmSelection(arm);
  return true;
}

function deleteSelected(arm: ArmatureData, ob: BObject): number {
  const del = new Set(arm.bones.filter((b) => b.select).map((b) => b.name));
  if (!del.size) return 0;
  const parentOfDeleted = (name: string | null): string | null => {
    let n = name;
    while (n && del.has(n)) n = boneByName(arm, n)?.parent ?? null;
    return n;
  };
  for (const b of arm.bones) {
    if (del.has(b.name)) continue;
    if (b.parent && del.has(b.parent)) { b.parent = parentOfDeleted(b.parent); b.useConnect = false; }
  }
  arm.bones = arm.bones.filter((b) => !del.has(b.name));
  if (arm.activeBone && del.has(arm.activeBone)) arm.activeBone = null;
  syncPose(ob, arm);
  return del.size;
}

function duplicateSelected(arm: ArmatureData): Bone[] {
  const sel = arm.bones.filter((b) => b.select);
  const map = new Map<string, string>();
  const copies: Bone[] = [];
  for (const b of sel) {
    const c: Bone = JSON.parse(JSON.stringify(b));
    c.name = uniqueBoneName(arm, b.name);
    map.set(b.name, c.name);
    arm.bones.push(c);
    copies.push(c);
  }
  for (const c of copies) {
    if (c.parent && map.has(c.parent)) c.parent = map.get(c.parent)!;
    else c.useConnect = false;
  }
  deselectAll(arm);
  for (const c of copies) c.select = c.selectHead = c.selectTail = true;
  if (arm.activeBone && map.has(arm.activeBone)) arm.activeBone = map.get(arm.activeBone)!;
  return copies;
}

function isAncestor(arm: ArmatureData, anc: Bone, b: Bone): boolean {
  let p = parentOf(arm, b);
  for (let i = 0; p && i < 10000; i++) { if (p === anc) return true; p = parentOf(arm, p); }
  return false;
}

function cursorLocal(ob: BObject): Vec3 {
  const p = v3(app.scene.cursor).applyMatrix4(app.matrices.world(ob).clone().invert());
  return arr(p);
}

/** Roll for Ctrl+N "Recalculate Roll". */
function recalcRoll(arm: ArmatureData, ob: BObject, type: string, view: View3D | null): void {
  const act = boneByName(arm, arm.activeBone);
  const wi = new Matrix3().setFromMatrix4(app.matrices.world(ob)).invert();
  for (const b of arm.bones) {
    if (!b.select) continue;
    let axis: Vector3 | null = null;
    switch (type) {
      case 'POS_X': axis = new Vector3(1, 0, 0); break;
      case 'POS_Y': axis = new Vector3(0, 1, 0); break;
      case 'POS_Z': axis = new Vector3(0, 0, 1); break;
      case 'NEG_X': axis = new Vector3(-1, 0, 0); break;
      case 'NEG_Y': axis = new Vector3(0, -1, 0); break;
      case 'NEG_Z': axis = new Vector3(0, 0, -1); break;
      case 'GLOBAL_POS_X': case 'GLOBAL_POS_Y': case 'GLOBAL_POS_Z': case 'GLOBAL_NEG_X': case 'GLOBAL_NEG_Y': case 'GLOBAL_NEG_Z': {
        const i = 'XYZ'.indexOf(type.slice(-1));
        const g = new Vector3(0, 0, 0).setComponent(i, type.includes('NEG') ? -1 : 1);
        axis = g.applyMatrix3(wi);
        break;
      }
      case 'ACTIVE': if (act && act !== b) axis = new Vector3().setFromMatrixColumn(boneRotation(act.head, act.tail, act.roll), 2); break;
      case 'VIEW': if (view) axis = view.view.viewDir().negate().applyMatrix3(wi); break;
      case 'CURSOR': axis = v3(cursorLocal(ob)).sub(v3(b.head)); break;
    }
    if (type === 'POS_X' || type === 'POS_Z' || type === 'NEG_X' || type === 'NEG_Z' || type === 'POS_Y' || type === 'NEG_Y') {
      // Local tangents: X/Z towards the global axis in armature space
      const i = 'XYZ'.indexOf(type.slice(-1));
      axis = new Vector3(0, 0, 0).setComponent(i, type.startsWith('NEG') ? -1 : 1);
      if (type.endsWith('X')) {
        // the bone's X axis should point along the axis: Z = X × Y
        const y = v3(b.tail).sub(v3(b.head)).normalize();
        axis = new Vector3().crossVectors(axis, y);
      }
    }
    if (axis && axis.lengthSq() > 1e-12) b.roll = rollForAxis(b.head, b.tail, axis.normalize());
  }
}

/** Merge chains of selected connected bones into single bones (Alt+M "Within Chains"). */
function mergeChains(arm: ArmatureData): number {
  let merged = 0;
  const sel = new Set(arm.bones.filter((b) => b.select).map((b) => b.name));
  for (const start of arm.bones.filter((b) => b.select)) {
    if (!sel.has(start.name)) continue;
    const p = parentOf(arm, start);
    if (p && start.useConnect && sel.has(p.name)) continue; // not a chain start
    const chain: Bone[] = [start];
    let cur = start;
    for (;;) {
      const kids = arm.bones.filter((c) => c.parent === cur.name && c.useConnect && sel.has(c.name));
      if (kids.length !== 1) break;
      cur = kids[0];
      chain.push(cur);
    }
    if (chain.length < 2) continue;
    const last = chain[chain.length - 1];
    start.tail = [...last.tail] as Vec3;
    const names = new Set(chain.slice(1).map((b) => b.name));
    for (const b of arm.bones) if (b.parent && names.has(b.parent)) b.parent = start.name;
    arm.bones = arm.bones.filter((b) => !names.has(b.name));
    for (const n of names) sel.delete(n);
    merged += chain.length - 1;
  }
  return merged;
}

function subdivideBones(arm: ArmatureData, cuts: number): void {
  for (const b of arm.bones.filter((x) => x.select)) {
    const kids = arm.bones.filter((c) => c.parent === b.name);
    const head = v3(b.head), tail = v3(b.tail);
    let prev = b;
    const n = cuts + 1;
    b.tail = arr(head.clone().lerp(tail, 1 / n));
    for (let i = 1; i < n; i++) {
      const nb = newBone(arm, b.name, arr(head.clone().lerp(tail, i / n)), arr(head.clone().lerp(tail, (i + 1) / n)), b);
      nb.roll = b.roll;
      nb.parent = prev.name;
      nb.useConnect = true;
      nb.select = nb.selectHead = nb.selectTail = true;
      prev = nb;
    }
    for (const k of kids) k.parent = prev.name;
  }
}

function switchDirection(arm: ArmatureData): void {
  const sel = arm.bones.filter((b) => b.select);
  const selNames = new Set(sel.map((b) => b.name));
  // chains of selected connected bones are reversed as a whole
  const visited = new Set<string>();
  for (const b of sel) {
    if (visited.has(b.name)) continue;
    // find chain root
    let root = b;
    for (let p = parentOf(arm, root); p && root.useConnect && selNames.has(p.name); p = parentOf(arm, root)) root = p;
    const chain: Bone[] = [root];
    let cur = root;
    for (;;) {
      const kids = arm.bones.filter((c) => c.parent === cur.name && c.useConnect && selNames.has(c.name));
      if (kids.length !== 1) break;
      cur = kids[0];
      chain.push(cur);
    }
    for (const c of chain) visited.add(c.name);
    const outerParent = root.parent && !selNames.has(root.parent) ? root.parent : null;
    for (const c of chain) { const h = c.head; c.head = c.tail; c.tail = h; c.roll = -c.roll; }
    // reverse parenting
    for (let i = chain.length - 1; i >= 0; i--) {
      chain[i].parent = i < chain.length - 1 ? chain[i + 1].name : null;
      chain[i].useConnect = i < chain.length - 1;
    }
    void outerParent;
  }
}

function autosideName(name: string, side: string): string {
  const base = name.replace(/[._][LRlrFfBbTt]$|[._](Left|Right|Front|Back|Top|Bottom)$/i, '');
  return `${base}.${side}`;
}

// ------------------------------------------------------------------ roll modal (Ctrl+R)

function startRollModal(view: View3D): void {
  const arm = editArm(), ob = editArmOb();
  if (!arm || !ob) return;
  const bones = arm.bones.filter((b) => b.select);
  if (!bones.length) return;
  const start = bones.map((b) => b.roll);
  const w = app.matrices.world(ob);
  const c = new Vector3();
  for (const b of bones) c.add(v3(b.head).add(v3(b.tail)).multiplyScalar(0.5).applyMatrix4(w));
  c.multiplyScalar(1 / bones.length);
  const r = view.canvasRect();
  const cp = view.view.project(c);
  const ang0 = Math.atan2(-(app.mouse.y - r.top - cp.y), app.mouse.x - r.left - cp.x);
  let acc = 0, last = ang0, num = '';
  let value = 0;
  const apply = () => {
    value = num ? (parseFloat(num) || 0) * Math.PI / 180 : acc;
    bones.forEach((b, i) => { b.roll = start[i] + value; });
    app.notify('data');
    view.requestRender();
  };
  const finish = (ok: boolean) => {
    app.endModal(h);
    if (!ok) { bones.forEach((b, i) => { b.roll = start[i]; }); app.notify('data'); return; }
    const def = app.operator('transform.transform')!;
    app.finishOperator(def, { mode: 'BONE_ROLL', value: [value, 0, 0, 0] }, { app, area: view.area });
  };
  const h: ModalHandler = {
    status: () => `Roll: ${num ? `[${num}|]` : ((value * 180) / Math.PI).toFixed(2)}°`,
    cancel: () => finish(false),
    onEvent(e) {
      if (e.type === 'pointermove') {
        const pe = e as PointerEvent;
        const rr = view.canvasRect();
        const a = Math.atan2(-(pe.clientY - rr.top - cp.y), pe.clientX - rr.left - cp.x);
        let d = a - last;
        if (d > Math.PI) d -= Math.PI * 2;
        if (d < -Math.PI) d += Math.PI * 2;
        acc += d * (pe.shiftKey ? 0.1 : 1);
        last = a;
        if (pe.ctrlKey) acc = Math.round(acc / (Math.PI / 36)) * (Math.PI / 36);
        apply();
        return true;
      }
      if (e.type === 'pointerdown') { finish((e as PointerEvent).button === 0); return true; }
      if (e.type === 'keydown') {
        const k = (e as KeyboardEvent).key;
        if (k === 'Escape') finish(false);
        else if (k === 'Enter' || k === ' ') finish(true);
        else if (/^[0-9.\-]$/.test(k)) { num += k; apply(); }
        else if (k === 'Backspace') { num = num.slice(0, -1); apply(); }
        return true;
      }
      return true;
    },
  };
  app.startModal(h);
  apply();
}

// ------------------------------------------------------------------ operators

const armOp = (o: Omit<OperatorDef, 'undo' | 'register'> & { undo?: boolean; register?: boolean }): OperatorDef => ({ undo: true, register: true, poll: isArmEdit, ...o });
const selAction = { name: 'Action', type: 'enum' as const, default: 'TOGGLE', items: [['TOGGLE', 'Toggle'], ['SELECT', 'Select'], ['DESELECT', 'Deselect'], ['INVERT', 'Invert']] as [string, string][] };

export const ARMATURE_EDIT_OPERATORS: OperatorDef[] = [
  armOp({
    id: 'armature.select_all', label: '(De)select All', description: 'Toggle selection status of all bones', props: { action: selAction },
    exec: (_c, p) => { selectAllArm(editArm()!, p.action as SelectAction); return done(); },
  }),
  armOp({
    id: 'armature.select_linked', label: 'Select Connected', description: 'Select bones related to selected ones by parent/child relationships',
    exec: () => {
      const arm = editArm()!;
      const sel = arm.bones.filter((b) => b.select || b.selectHead || b.selectTail);
      const out = new Set<Bone>();
      for (const b of sel) {
        // walk up connected parents, then all connected descendants
        let root = b;
        for (let p = parentOf(arm, root); p && root.useConnect; p = parentOf(arm, root)) root = p;
        const stack = [root];
        while (stack.length) { const x = stack.pop()!; if (out.has(x)) continue; out.add(x); for (const c of arm.bones) if (c.parent === x.name && c.useConnect) stack.push(c); }
      }
      for (const b of out) if (isBoneVisible(arm, b)) b.select = b.selectHead = b.selectTail = true;
      return done();
    },
  }),
  armOp({
    id: 'armature.select_hierarchy', label: 'Select Hierarchy', description: 'Select immediate parent/children of selected bones',
    props: { direction: { name: 'Direction', type: 'enum', default: 'PARENT', items: [['PARENT', 'Select Parent'], ['CHILD', 'Select Child']] }, extend: { name: 'Extend', type: 'bool', default: false } },
    exec: (_c, p) => {
      const arm = editArm()!;
      const act = boneByName(arm, arm.activeBone) ?? arm.bones.find((b) => b.select);
      if (!act) return 'CANCELLED';
      const next = p.direction === 'PARENT' ? parentOf(arm, act) : arm.bones.find((c) => c.parent === act.name && isBoneVisible(arm, c));
      if (!next) return 'CANCELLED';
      if (!p.extend) deselectAll(arm);
      next.select = next.selectHead = next.selectTail = true;
      arm.activeBone = next.name;
      return done();
    },
  }),
  armOp({
    id: 'armature.select_more', label: 'Select More', description: 'Select those bones connected to the initial selection',
    exec: () => {
      const arm = editArm()!;
      const sel = arm.bones.filter((b) => b.select);
      for (const b of sel) { const p = parentOf(arm, b); if (p) p.select = true; for (const c of arm.bones) if (c.parent === b.name) c.select = true; }
      return done();
    },
  }),
  armOp({
    id: 'armature.select_less', label: 'Select Less', description: 'Deselect those bones at the boundary of each selection region',
    exec: () => {
      const arm = editArm()!;
      const sel = new Set(arm.bones.filter((b) => b.select));
      const edge = [...sel].filter((b) => { const p = parentOf(arm, b); const kids = arm.bones.filter((c) => c.parent === b.name); return !p || !sel.has(p) || kids.some((k) => !sel.has(k)) || !kids.length; });
      for (const b of edge) deselectBone(arm, b);
      return done();
    },
  }),
  armOp({
    id: 'armature.extrude_move', label: 'Extrude', description: 'Create new bones from the selected joints and move them', undo: false, register: false, poll: () => isArmEdit() && anyBoneSel(),
    exec: (ctx) => {
      if (!extrude(false)) return 'CANCELLED';
      done();
      app.pushUndo('Extrude');
      app.report('OPERATOR', 'bpy.ops.armature.extrude_move(ARMATURE_OT_extrude={"forked":False}, TRANSFORM_OT_translate={"value":(0, 0, 0)})');
      grab(ctx);
      return 'FINISHED';
    },
  }),
  armOp({
    id: 'armature.extrude_forked', label: 'Extrude Forked', description: 'Create new mirrored bones from the selected joints and move them', undo: false, register: false, poll: () => isArmEdit() && anyBoneSel(),
    exec: (ctx) => {
      if (!extrude(true)) return 'CANCELLED';
      done();
      app.pushUndo('Extrude Forked');
      app.report('OPERATOR', 'bpy.ops.armature.extrude_forked(ARMATURE_OT_extrude={"forked":True}, TRANSFORM_OT_translate={"value":(0, 0, 0)})');
      grab(ctx);
      return 'FINISHED';
    },
  }),
  armOp({
    id: 'armature.bone_primitive_add', label: 'Add Bone', description: 'Add a new bone located at the 3D-Cursor', props: { name: { name: 'Name', type: 'string', default: 'Bone' } },
    exec: (_c, p) => {
      const arm = editArm()!, ob = editArmOb()!;
      const h = cursorLocal(ob);
      deselectAll(arm);
      const b = newBone(arm, String(p.name || 'Bone'), h, [h[0], h[1], h[2] + 1]);
      b.select = b.selectHead = b.selectTail = true;
      arm.activeBone = b.name;
      return done();
    },
  }),
  armOp({
    id: 'armature.click_extrude', label: 'Click-Extrude', description: 'Create a new bone going from the last selected joint to the mouse position',
    exec: (ctx) => {
      const arm = editArm()!, ob = editArmOb()!;
      const view = ctxView(ctx);
      if (!view) return 'CANCELLED';
      const r = view.canvasRect();
      const act = boneByName(arm, arm.activeBone);
      const from: Vec3 = act && (act.selectTail || act.select) ? [...act.tail] as Vec3 : act && act.selectHead ? [...act.head] as Vec3 : cursorLocal(ob);
      const w = app.matrices.world(ob);
      const depth = v3(from).applyMatrix4(w);
      const target = view.view.unprojectAtDepth(app.mouse.x - r.left, app.mouse.y - r.top, depth).applyMatrix4(w.clone().invert());
      const nb = newBone(arm, act?.name ?? 'Bone', from, arr(target), act);
      if (act && (act.selectTail || act.select)) { nb.parent = act.name; nb.useConnect = true; }
      else if (act && act.selectHead) { nb.parent = act.parent; nb.useConnect = false; }
      deselectAll(arm);
      nb.selectTail = true;
      arm.activeBone = nb.name;
      return done();
    },
  }),
  armOp({
    id: 'armature.delete', label: 'Delete Selected Bone(s)', description: 'Remove selected bones from the armature', poll: () => isArmEdit() && !!editArm()?.bones.some((b) => b.select),
    invoke: (ctx, p) => {
      confirmPopup('OK?', 'Delete Selected Bone(s)', () => {
        const def = app.operator('armature.delete')!;
        const before = app.undoHistory().findIndex((x) => x.current);
        if (def.exec!(ctx, p) === 'FINISHED') app.finishOperator(def, p, ctx, before);
      });
      return 'CANCELLED';
    },
    exec: () => { const n = deleteSelected(editArm()!, editArmOb()!); return n ? done() : 'CANCELLED'; },
  }),
  armOp({
    id: 'armature.duplicate_move', label: 'Duplicate', description: 'Make copies of the selected bones within the same armature and move them', undo: false, register: false,
    poll: () => isArmEdit() && !!editArm()?.bones.some((b) => b.select),
    exec: (ctx) => {
      duplicateSelected(editArm()!);
      done();
      app.pushUndo('Duplicate');
      app.report('OPERATOR', 'bpy.ops.armature.duplicate_move(ARMATURE_OT_duplicate={}, TRANSFORM_OT_translate={"value":(0, 0, 0)})');
      grab(ctx);
      return 'FINISHED';
    },
  }),
  armOp({
    id: 'armature.parent_set', label: 'Make Parent', description: 'Set the active bone as the parent of the selected bones',
    props: { type: { name: 'ParentType', type: 'enum', default: 'CONNECTED', items: [['CONNECTED', 'Connected'], ['OFFSET', 'Keep Offset']] } },
    poll: () => isArmEdit() && !!editArm()?.activeBone && editArm()!.bones.filter((b) => b.select).length > 1,
    invoke: (ctx) => {
      showMenu([
        { label: 'Connected', action: () => void app.callOperator('armature.parent_set', { type: 'CONNECTED' }, { area: ctx.area, exec: true }) },
        { label: 'Keep Offset', action: () => void app.callOperator('armature.parent_set', { type: 'OFFSET' }, { area: ctx.area, exec: true }) },
      ], app.mouse, { title: 'Make Parent', atMouse: true });
      return 'CANCELLED';
    },
    exec: (_c, p) => {
      const arm = editArm()!;
      const par = boneByName(arm, arm.activeBone)!;
      for (const b of arm.bones) {
        if (!b.select || b === par) continue;
        if (isAncestor(arm, b, par)) continue;
        b.parent = par.name;
        if (p.type === 'CONNECTED') {
          const d = v3(par.tail).sub(v3(b.head));
          b.head = [...par.tail] as Vec3;
          b.tail = arr(v3(b.tail).add(d));
          b.useConnect = true;
        } else b.useConnect = false;
      }
      return done();
    },
  }),
  armOp({
    id: 'armature.parent_clear', label: 'Clear Parent', description: 'Remove the parent-child relationship between selected bones and their parents',
    props: { type: { name: 'ClearType', type: 'enum', default: 'CLEAR', items: [['CLEAR', 'Clear Parent'], ['DISCONNECT', 'Disconnect Bone']] } },
    poll: () => isArmEdit() && !!editArm()?.bones.some((b) => b.select),
    invoke: (ctx) => {
      showMenu([
        { label: 'Clear Parent', action: () => void app.callOperator('armature.parent_clear', { type: 'CLEAR' }, { area: ctx.area, exec: true }) },
        { label: 'Disconnect Bone', action: () => void app.callOperator('armature.parent_clear', { type: 'DISCONNECT' }, { area: ctx.area, exec: true }) },
      ], app.mouse, { title: 'Clear Parent', atMouse: true });
      return 'CANCELLED';
    },
    exec: (_c, p) => {
      for (const b of editArm()!.bones) {
        if (!b.select) continue;
        if (p.type === 'CLEAR') b.parent = null;
        b.useConnect = false;
      }
      return done();
    },
  }),
  armOp({
    id: 'transform.transform', label: 'Transform', description: 'Transform selected items by mode type',
    props: { mode: { name: 'Mode', type: 'enum', default: 'BONE_ROLL', items: [['BONE_ROLL', 'Roll']] }, value: { name: 'Values', type: 'vector', default: [0, 0, 0, 0], size: 4 } },
    poll: () => isArmEdit() && !!editArm()?.bones.some((b) => b.select),
    invoke: (ctx) => { const v = ctxView(ctx); if (!v) return 'CANCELLED'; startRollModal(v); return 'RUNNING_MODAL'; },
    exec: (_c, p) => {
      const val = (p.value as number[])[0] ?? 0;
      for (const b of editArm()!.bones) if (b.select) b.roll += val;
      return done();
    },
  }),
  armOp({
    id: 'armature.calculate_roll', label: 'Recalculate Roll', description: 'Automatically fix alignment of select bones\' axes',
    props: {
      type: { name: 'Type', type: 'enum', default: 'POS_X', items: [['POS_X', 'Local + X Tangent'], ['POS_Z', 'Local + Z Tangent'], ['GLOBAL_POS_X', 'Global + X Axis'], ['GLOBAL_POS_Y', 'Global + Y Axis'], ['GLOBAL_POS_Z', 'Global + Z Axis'], ['NEG_X', 'Local - X Tangent'], ['NEG_Z', 'Local - Z Tangent'], ['GLOBAL_NEG_X', 'Global - X Axis'], ['GLOBAL_NEG_Y', 'Global - Y Axis'], ['GLOBAL_NEG_Z', 'Global - Z Axis'], ['ACTIVE', 'Active Bone'], ['VIEW', 'View Axis'], ['CURSOR', 'Cursor']] },
    },
    poll: () => isArmEdit() && !!editArm()?.bones.some((b) => b.select),
    invoke: (ctx) => {
      const items: [string, string][] = [['POS_X', 'Local + X Tangent'], ['POS_Z', 'Local + Z Tangent'], ['GLOBAL_POS_X', 'Global + X Axis'], ['GLOBAL_POS_Y', 'Global + Y Axis'], ['GLOBAL_POS_Z', 'Global + Z Axis'], ['NEG_X', 'Local - X Tangent'], ['NEG_Z', 'Local - Z Tangent'], ['GLOBAL_NEG_X', 'Global - X Axis'], ['GLOBAL_NEG_Y', 'Global - Y Axis'], ['GLOBAL_NEG_Z', 'Global - Z Axis'], ['ACTIVE', 'Active Bone'], ['VIEW', 'View Axis'], ['CURSOR', 'Cursor']];
      showMenu(items.map(([t, l]) => ({ label: l, action: () => void app.callOperator('armature.calculate_roll', { type: t }, { area: ctx.area, exec: true }) })), app.mouse, { title: 'Recalculate Roll', atMouse: true });
      return 'CANCELLED';
    },
    exec: (ctx, p) => { recalcRoll(editArm()!, editArmOb()!, String(p.type), ctxView(ctx)); return done(); },
  }),
  armOp({
    id: 'armature.merge', label: 'Merge Bones', description: 'Merge continuous chains of selected bones',
    props: { type: { name: 'Type', type: 'enum', default: 'WITHIN_CHAIN', items: [['WITHIN_CHAIN', 'Within Chains']] } },
    poll: () => isArmEdit() && !!editArm()?.bones.some((b) => b.select),
    invoke: (ctx) => {
      showMenu([{ label: 'Within Chains', action: () => void app.callOperator('armature.merge', { type: 'WITHIN_CHAIN' }, { area: ctx.area, exec: true }) }], app.mouse, { title: 'Merge Selected Bones', atMouse: true });
      return 'CANCELLED';
    },
    exec: () => { const n = mergeChains(editArm()!); if (!n) { app.report('WARNING', 'No connected chains of selected bones to merge'); return 'CANCELLED'; } return done(); },
  }),
  armOp({
    id: 'armature.subdivide', label: 'Subdivide Multi', description: 'Break selected bones into chains of smaller bones',
    props: { number_cuts: { name: 'Number of Cuts', type: 'int', default: 1, min: 1, max: 1000 } },
    poll: () => isArmEdit() && !!editArm()?.bones.some((b) => b.select),
    exec: (_c, p) => { subdivideBones(editArm()!, Math.max(1, Math.round(Number(p.number_cuts)))); return done(); },
  }),
  armOp({
    id: 'armature.switch_direction', label: 'Switch Direction', description: 'Change the direction that a chain of bones points in (head <-> tail swap)',
    poll: () => isArmEdit() && !!editArm()?.bones.some((b) => b.select),
    exec: () => { switchDirection(editArm()!); return done(); },
  }),
  armOp({
    id: 'armature.flip_names', label: 'Flip Names', description: 'Flips (and corrects) the axis suffixes of the names of selected bones',
    poll: () => isArmEdit() && !!editArm()?.bones.some((b) => b.select),
    exec: () => {
      const arm = editArm()!;
      for (const b of arm.bones.filter((x) => x.select)) {
        const n = flipSideName(b.name);
        if (n !== b.name) renameBoneEdit(arm, b, n);
      }
      return done();
    },
  }),
  armOp({
    id: 'armature.autoside_names', label: 'AutoName by Axis', description: 'Automatically renames the selected bones according to which side of the target axis they fall on',
    props: { type: { name: 'Axis', type: 'enum', default: 'XAXIS', items: [['XAXIS', 'X-Axis'], ['YAXIS', 'Y-Axis'], ['ZAXIS', 'Z-Axis']] } },
    poll: () => isArmEdit() && !!editArm()?.bones.some((b) => b.select),
    exec: (_c, p) => {
      const arm = editArm()!;
      const ax = p.type === 'YAXIS' ? 1 : p.type === 'ZAXIS' ? 2 : 0;
      for (const b of arm.bones.filter((x) => x.select)) {
        const c = (b.head[ax] + b.tail[ax]) / 2;
        if (Math.abs(c) < 1e-5) continue;
        const side = ax === 0 ? (c > 0 ? 'L' : 'R') : ax === 1 ? (c < 0 ? 'Fr' : 'Bk') : (c > 0 ? 'Top' : 'Bot');
        renameBoneEdit(arm, b, autosideName(b.name, side));
      }
      return done();
    },
  }),
  armOp({
    id: 'armature.symmetrize', label: 'Symmetrize', description: 'Enforce symmetry, make copies of the selection or use existing',
    props: { direction: { name: 'Direction', type: 'enum', default: 'NEGATIVE_X', items: [['NEGATIVE_X', '-X to +X'], ['POSITIVE_X', '+X to -X']] } },
    poll: () => isArmEdit() && !!editArm()?.bones.some((b) => b.select),
    exec: () => {
      const arm = editArm()!;
      const sel = arm.bones.filter((b) => b.select);
      const created = new Map<string, Bone>();
      for (const b of sel) {
        const mn = flipSideName(b.name);
        if (mn === b.name) continue;
        let m = boneByName(arm, mn);
        if (!m) { m = defaultBone(mn); arm.bones.push(m); created.set(mn, m); }
        m.head = [-b.head[0], b.head[1], b.head[2]];
        m.tail = [-b.tail[0], b.tail[1], b.tail[2]];
        m.roll = -b.roll;
        m.useConnect = b.useConnect; m.useDeform = b.useDeform;
        m.envelopeDistance = b.envelopeDistance; m.headRadius = b.headRadius; m.tailRadius = b.tailRadius; m.envelopeWeight = b.envelopeWeight;
        m.layers = b.layers.slice();
      }
      for (const b of sel) {
        const m = boneByName(arm, flipSideName(b.name));
        if (!m || m === b) continue;
        if (b.parent) { const pm = flipSideName(b.parent); m.parent = boneByName(arm, pm) ? pm : b.parent; }
        else m.parent = null;
      }
      return done();
    },
  }),
  armOp({
    id: 'armature.hide', label: 'Hide Selected Bones', description: 'Tag selected bones to not be visible in Edit Mode', props: { unselected: { name: 'Unselected', type: 'bool', default: false } },
    exec: (_c, p) => {
      for (const b of editArm()!.bones) if (p.unselected ? !(b.select || b.selectHead || b.selectTail) : b.select) b.hide = true;
      return done();
    },
  }),
  armOp({
    id: 'armature.reveal', label: 'Reveal Bones', description: 'Unhide all bones that have been tagged to be hidden in Edit Mode',
    exec: () => { for (const b of editArm()!.bones) if (b.hide) { b.hide = false; b.select = b.selectHead = b.selectTail = true; } return done(); },
  }),
];

/** Rename through the shared helper so pose channels, vertex groups and F-Curves follow. */
function renameBoneEdit(arm: ArmatureData, b: Bone, name: string): void { renameBone(app.doc, arm, b, name); }

// ------------------------------------------------------------------ menus

const op = (label: string, id: string, props?: Record<string, unknown>, icon?: string): MenuItem => ({ label, op: id, props, icon });
const sep: MenuItem = { type: 'separator' };

export function armatureSpecialsMenu(): MenuItem[] {
  return [
    op('Subdivide', 'armature.subdivide'),
    op('Switch Direction', 'armature.switch_direction'),
    sep,
    op('Flip Names', 'armature.flip_names'),
    sep,
    op('AutoName Left/Right', 'armature.autoside_names', { type: 'XAXIS' }),
    op('AutoName Front/Back', 'armature.autoside_names', { type: 'YAXIS' }),
    op('AutoName Top/Bottom', 'armature.autoside_names', { type: 'ZAXIS' }),
    sep,
    op('Symmetrize', 'armature.symmetrize'),
  ];
}

export function armatureMenu(): MenuItem[] {
  return [
    op('Undo History', 'ed.undo_history'), op('Redo', 'ed.redo'), op('Undo', 'ed.undo'),
    sep,
    { type: 'submenu', label: 'Transform', items: [op('Grab/Move', 'transform.translate'), op('Rotate', 'transform.rotate'), op('Scale', 'transform.resize'), sep, op('Roll', 'transform.transform', { mode: 'BONE_ROLL' })] },
    { type: 'submenu', label: 'Snap', items: () => [] },
    { type: 'submenu', label: 'Bone Roll', items: [op('Set Roll', 'transform.transform', { mode: 'BONE_ROLL' }), op('Recalculate Roll', 'armature.calculate_roll')] },
    sep,
    op('Extrude', 'armature.extrude_move'),
    op('Extrude Forked', 'armature.extrude_forked'),
    op('Duplicate', 'armature.duplicate_move'),
    op('Merge Bones', 'armature.merge'),
    op('Fill Between Joints', 'armature.fill'),
    op('Delete', 'armature.delete'),
    sep,
    op('Subdivide', 'armature.subdivide'),
    op('Switch Direction', 'armature.switch_direction'),
    sep,
    op('Symmetrize', 'armature.symmetrize'),
    { type: 'submenu', label: 'AutoName', items: [op('AutoName Left/Right', 'armature.autoside_names', { type: 'XAXIS' }), op('AutoName Front/Back', 'armature.autoside_names', { type: 'YAXIS' }), op('AutoName Top/Bottom', 'armature.autoside_names', { type: 'ZAXIS' })] },
    op('Flip Names', 'armature.flip_names'),
    sep,
    { type: 'submenu', label: 'Parent', items: [op('Make Parent...', 'armature.parent_set'), op('Clear Parent...', 'armature.parent_clear')] },
    sep,
    { type: 'submenu', label: 'Show/Hide', items: [op('Show Hidden', 'armature.reveal'), op('Hide Selected', 'armature.hide', { unselected: false }), op('Hide Unselected', 'armature.hide', { unselected: true })] },
  ];
}

function armatureSelectMenu(): MenuItem[] {
  return [
    op('Border Select', 'view3d.select_border'), op('Circle Select', 'view3d.select_circle'),
    sep,
    op('(De)select All', 'armature.select_all', { action: 'TOGGLE' }), op('Inverse', 'armature.select_all', { action: 'INVERT' }),
    sep,
    op('Parent', 'armature.select_hierarchy', { direction: 'PARENT', extend: false }),
    op('Child', 'armature.select_hierarchy', { direction: 'CHILD', extend: false }),
    op('Extend Parent', 'armature.select_hierarchy', { direction: 'PARENT', extend: true }),
    op('Extend Child', 'armature.select_hierarchy', { direction: 'CHILD', extend: true }),
    sep,
    op('More', 'armature.select_more'), op('Less', 'armature.select_less'),
    sep,
    op('Connected', 'armature.select_linked'),
  ];
}

// fill between joints (F)
ARMATURE_EDIT_OPERATORS.push(armOp({
  id: 'armature.fill', label: 'Fill Between Joints', description: 'Add bone between selected joint(s) and/or 3D-Cursor',
  exec: () => {
    const arm = editArm()!, ob = editArmOb()!;
    const joints: { p: Vec3; bone: Bone; end: 'head' | 'tail' }[] = [];
    for (const b of arm.bones) {
      if (b.selectHead && !(b.useConnect && parentOf(arm, b))) joints.push({ p: [...b.head] as Vec3, bone: b, end: 'head' });
      if (b.selectTail) joints.push({ p: [...b.tail] as Vec3, bone: b, end: 'tail' });
    }
    if (joints.length === 1) {
      const j = joints[0];
      const nb = newBone(arm, 'Bone', j.p, cursorLocal(ob));
      if (j.end === 'tail') { nb.parent = j.bone.name; nb.useConnect = true; }
    } else if (joints.length === 2) {
      const [a, b] = joints;
      const nb = newBone(arm, 'Bone', a.p, b.p);
      if (a.end === 'tail') { nb.parent = a.bone.name; nb.useConnect = true; }
    } else { app.report('ERROR', 'Too many/few joints selected (select one or two joints)'); return 'CANCELLED'; }
    return done();
  },
}));

// ------------------------------------------------------------------ registration

registerEditType({
  types: ['ARMATURE'],
  mode: 'EDIT',
  enter: (ob) => { const arm = armatureOf(app.doc, ob); if (arm) flushArmSelection(arm); },
  exit: (ob) => { const arm = armatureOf(app.doc, ob); if (arm) syncPose(ob, arm); },
  clickSelect: clickSelectArm,
  regionSelect: regionSelectArm,
  selectAll: (ob, action) => { const arm = armatureOf(app.doc, ob); if (arm) selectAllArm(arm, action); },
  hasSelection: (ob) => !!armatureOf(app.doc, ob)?.bones.some((b) => b.selectHead || b.selectTail || b.select),
  transformPoints: transformPointsArm,
  afterTransform: afterTransformArm,
  selectedPoints: selectedPointsArm,
  activePoint: (ob) => {
    const arm = armatureOf(app.doc, ob);
    const b = arm ? boneByName(arm, arm.activeBone) : undefined;
    return b ? v3(b.head).applyMatrix4(app.matrices.world(ob)) : null;
  },
  orientation: (ob, orient) => {
    if (orient !== 'NORMAL') return null;
    const arm = armatureOf(app.doc, ob);
    const b = arm ? boneByName(arm, arm.activeBone) : undefined;
    if (!b) return null;
    const m = app.matrices.world(ob).clone().multiply(boneRotation(b.head, b.tail, b.roll));
    return new Matrix3().setFromMatrix4(new Matrix4().extractRotation(m));
  },
  menuLabel: 'Armature',
  menu: armatureMenu,
  selectMenu: armatureSelectMenu,
  addMenu: () => [op('Single Bone', 'armature.bone_primitive_add', {}, 'BONE_DATA')],
  pointerDown: (view, _ob, e, button) => {
    if (button !== 'ACTION' || !e.ctrlKey || e.altKey) return false;
    // Ctrl+LMB: click to extrude, drag to lasso
    const sx = e.clientX, sy = e.clientY;
    const p = view.local(e);
    const move = (ev: PointerEvent) => {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
      cleanup();
      startLasso(view, p.x, p.y, e.shiftKey ? 'SUB' : 'ADD');
    };
    const up = () => { cleanup(); void app.callOperator('armature.click_extrude', {}, { area: view.area }); };
    const cleanup = () => { window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', up, true); };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    return true;
  },
});

const C = { ctrl: true }, S = { shift: true }, A = { alt: true };
const K = (code: string, op: string, props: Record<string, unknown> = {}, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}) => ({ code, space: 'VIEW_3D' as const, op, props, mode: 'EDIT' as const, poll: isArmEdit, ...mods });
registerKeymap([
  K('KeyA', 'armature.select_all', { action: 'TOGGLE' }),
  K('KeyI', 'armature.select_all', { action: 'INVERT' }, C),
  { code: 'KeyA', space: 'VIEW_3D', mode: 'EDIT', poll: isArmEdit, shift: true, title: 'Add', menu: () => [op('Single Bone', 'armature.bone_primitive_add', {}, 'BONE_DATA')] },
  K('KeyE', 'armature.extrude_move'),
  K('KeyE', 'armature.extrude_forked', {}, S),
  K('KeyX', 'armature.delete'),
  K('Delete', 'armature.delete'),
  K('KeyD', 'armature.duplicate_move', {}, S),
  K('KeyP', 'armature.parent_set', {}, C),
  K('KeyP', 'armature.parent_clear', {}, A),
  K('KeyR', 'transform.transform', { mode: 'BONE_ROLL' }, C),
  K('KeyN', 'armature.calculate_roll', {}, C),
  K('KeyM', 'armature.merge', {}, A),
  K('KeyF', 'armature.switch_direction', {}, A),
  K('KeyF', 'armature.fill'),
  { code: 'KeyW', space: 'VIEW_3D', mode: 'EDIT', poll: isArmEdit, title: 'Specials', menu: armatureSpecialsMenu },
  K('KeyL', 'armature.select_linked'),
  K('KeyL', 'armature.select_linked', {}, C),
  K('BracketLeft', 'armature.select_hierarchy', { direction: 'PARENT', extend: false }),
  K('BracketRight', 'armature.select_hierarchy', { direction: 'CHILD', extend: false }),
  K('BracketLeft', 'armature.select_hierarchy', { direction: 'PARENT', extend: true }, S),
  K('BracketRight', 'armature.select_hierarchy', { direction: 'CHILD', extend: true }, S),
  K('NumpadAdd', 'armature.select_more', {}, C),
  K('NumpadSubtract', 'armature.select_less', {}, C),
  K('KeyH', 'armature.hide', { unselected: false }),
  K('KeyH', 'armature.hide', { unselected: true }, S),
  K('KeyH', 'armature.reveal', {}, A),
]);

