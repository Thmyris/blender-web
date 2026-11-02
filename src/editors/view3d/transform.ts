// Interactive transform (Grab/Rotate/Scale) like Blender's transform system:
// axis/plane constraints, numeric input, increment snapping, precision mode,
// proportional editing, pivot points and orientations. Also used by the
// manipulator widget and to re-execute transforms from the redo panel.

import { Euler, Matrix3, Matrix4, Quaternion, Vector3 } from 'three';
import { app, type OpContext, type OpProps, type OperatorDef, type ModalHandler } from '../../app';
import type { BObject, MeshData, PivotPoint, TransformOrientation } from '../../core/types';
import { setBasisFromMatrix, basisMatrix, threeEulerOrder } from '../../core/scene';
import { polyNormal, vertFaces } from '../../core/mesh';
import { insertKeyframe } from '../../core/anim';
import { evalEdges } from '../../core/modifiers';
import type { View3D } from './view3d';

export type TransformMode = 'TRANSLATION' | 'ROTATION' | 'RESIZE' | 'TRACKBALL' | 'SHRINK_FATTEN' | 'TOSPHERE';

interface ObjElem { kind: 'object'; ob: BObject; start: { loc: number[]; rot: number[]; scale: number[] }; world: Matrix4; parentMat: Matrix4; center: Vector3 }
interface VertElem { kind: 'vert'; index: number; start: Vector3; world: Vector3; factor: number; normal: Vector3 }

export interface TransformElems {
  objects: ObjElem[];
  verts: VertElem[];
  mesh: MeshData | null;
  editOb: BObject | null;
  meshWorld: Matrix4;
  meshWorldInv: Matrix4;
}

const AXES = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];

/** Objects that will be transformed: selected, visible, and not children of another selected object. */
function transformObjects(): BObject[] {
  const sel = app.selectedObjects();
  const ids = new Set(sel.map((o) => o.id));
  return sel.filter((o) => {
    let p = o.parent ? app.doc.objects[o.parent] : null;
    while (p) { if (ids.has(p.id)) return false; p = p.parent ? app.doc.objects[p.parent] : null; }
    return true;
  });
}

export function gatherElements(propSize = 0, connected = false): TransformElems {
  const out: TransformElems = { objects: [], verts: [], mesh: null, editOb: null, meshWorld: new Matrix4(), meshWorldInv: new Matrix4() };
  const md = app.editMesh;
  if (md && app.editObj) {
    const ob = app.editObj;
    out.mesh = md;
    out.editOb = ob;
    out.meshWorld = app.matrices.world(ob).clone();
    out.meshWorldInv = out.meshWorld.clone().invert();
    const vf = vertFaces(md);
    const normalOf = (i: number) => {
      const n = new Vector3();
      for (const f of vf[i]) { const fn = polyNormal(md.verts, md.faces[f]); n.x += fn[0]; n.y += fn[1]; n.z += fn[2]; }
      if (n.lengthSq() < 1e-12) n.set(0, 0, 1);
      return n.normalize().transformDirection(out.meshWorld);
    };
    const selWorld: Vector3[] = [];
    md.verts.forEach((v, i) => {
      const local = new Vector3(v[0], v[1], v[2]);
      const world = local.clone().applyMatrix4(out.meshWorld);
      if (md.vsel[i]) {
        out.verts.push({ kind: 'vert', index: i, start: local, world, factor: 1, normal: normalOf(i) });
        selWorld.push(world);
      }
    });
    if (propSize > 0 && selWorld.length) {
      let reach: Set<number> | null = null;
      if (connected) {
        reach = new Set<number>();
        const adj: number[][] = md.verts.map(() => []);
        for (const [a, b] of md.edges) { adj[a].push(b); adj[b].push(a); }
        const stack = md.verts.map((_, i) => i).filter((i) => md.vsel[i]);
        stack.forEach((i) => reach!.add(i));
        while (stack.length) { const i = stack.pop()!; for (const n of adj[i]) if (!reach.has(n)) { reach.add(n); stack.push(n); } }
      }
      md.verts.forEach((v, i) => {
        if (md.vsel[i]) return;
        if (reach && !reach.has(i)) return;
        const local = new Vector3(v[0], v[1], v[2]);
        const world = local.clone().applyMatrix4(out.meshWorld);
        let d = Infinity;
        for (const s of selWorld) d = Math.min(d, s.distanceTo(world));
        if (d < propSize) out.verts.push({ kind: 'vert', index: i, start: local, world, factor: 0, normal: normalOf(i) });
      });
    }
    return out;
  }
  for (const ob of transformObjects()) {
    const world = app.matrices.world(ob).clone();
    const parent = ob.parent ? app.doc.objects[ob.parent] : null;
    const parentMat = parent ? app.matrices.world(parent).clone().multiply(new Matrix4().fromArray(ob.parentInverse)) : new Matrix4();
    out.objects.push({
      kind: 'object', ob, world, parentMat,
      start: { loc: ob.location.slice(), rot: ob.rotation.slice(), scale: ob.scale.slice() },
      center: new Vector3().setFromMatrixPosition(world),
    });
  }
  return out;
}

/** Proportional editing falloff. */
function falloff(type: string, d: number): number {
  const t = Math.min(1, Math.max(0, 1 - d));
  switch (type) {
    case 'SPHERE': return Math.sqrt(2 * t - t * t);
    case 'ROOT': return Math.sqrt(t);
    case 'INVERSE_SQUARE': return t * (2 - t);
    case 'SHARP': return t * t;
    case 'LINEAR': return t;
    case 'CONSTANT': return 1;
    case 'RANDOM': return t * Math.random();
    default: return 3 * t * t - 2 * t * t * t; // SMOOTH
  }
}

export function updatePropFactors(el: TransformElems, size: number, type: string): void {
  if (!el.mesh) return;
  const sel = el.verts.filter((v) => el.mesh!.vsel[v.index]);
  for (const v of el.verts) {
    if (el.mesh.vsel[v.index]) { v.factor = 1; continue; }
    let d = Infinity;
    for (const s of sel) d = Math.min(d, s.world.distanceTo(v.world));
    v.factor = size > 0 ? falloff(type, d / size) : 0;
  }
}

/** Centre for the pivot point setting. */
export function pivotCenter(el: TransformElems, pivot: PivotPoint): Vector3 {
  if (pivot === 'CURSOR') return new Vector3(...app.scene.cursor);
  const pts: Vector3[] = el.mesh ? el.verts.filter((v) => el.mesh!.vsel[v.index]).map((v) => v.world) : el.objects.map((o) => o.center);
  if (!pts.length) return new Vector3(...app.scene.cursor);
  if (pivot === 'ACTIVE_ELEMENT') {
    if (el.mesh) {
      const md = el.mesh;
      if (md.activeFace >= 0 && md.fsel[md.activeFace]) {
        const f = md.faces[md.activeFace];
        const c = new Vector3();
        for (const i of f) c.add(new Vector3(...md.verts[i]));
        return c.multiplyScalar(1 / f.length).applyMatrix4(el.meshWorld);
      }
    } else {
      const act = app.activeObject;
      const e = el.objects.find((o) => o.ob === act);
      if (e) return e.center.clone();
    }
  }
  if (pivot === 'BOUNDING_BOX_CENTER' || pivot === 'INDIVIDUAL_ORIGINS' && el.mesh) {
    const min = new Vector3(Infinity, Infinity, Infinity), max = new Vector3(-Infinity, -Infinity, -Infinity);
    for (const p of pts) { min.min(p); max.max(p); }
    return min.add(max).multiplyScalar(0.5);
  }
  const c = new Vector3();
  for (const p of pts) c.add(p);
  return c.multiplyScalar(1 / pts.length);
}

/** Orientation matrix (columns are the X/Y/Z axes). */
export function orientationMatrix(orient: TransformOrientation, view: View3D | null, el?: TransformElems): Matrix3 {
  const m = new Matrix3();
  const rotOf = (ob: BObject) => {
    const q = new Quaternion();
    app.matrices.world(ob).decompose(new Vector3(), q, new Vector3());
    return new Matrix3().setFromMatrix4(new Matrix4().makeRotationFromQuaternion(q));
  };
  switch (orient) {
    case 'LOCAL':
    case 'GIMBAL': {
      const ob = app.editObj ?? app.activeObject;
      return ob ? rotOf(ob) : m;
    }
    case 'NORMAL': {
      if (el?.mesh && el.verts.length) {
        const n = new Vector3();
        for (const v of el.verts) if (el.mesh.vsel[v.index]) n.add(v.normal);
        if (n.lengthSq() > 1e-12) {
          n.normalize();
          const ref = Math.abs(n.z) < 0.9 ? new Vector3(0, 0, 1) : new Vector3(1, 0, 0);
          const x = new Vector3().crossVectors(ref, n).normalize();
          const y = new Vector3().crossVectors(n, x).normalize();
          return new Matrix3().set(x.x, y.x, n.x, x.y, y.y, n.y, x.z, y.z, n.z);
        }
      }
      const ob = app.editObj ?? app.activeObject;
      return ob ? rotOf(ob) : m;
    }
    case 'VIEW': {
      if (!view) return m;
      const q = view.view.camera().quaternion;
      return new Matrix3().setFromMatrix4(new Matrix4().makeRotationFromQuaternion(q));
    }
    default: return m;
  }
}

export function axisVector(om: Matrix3, i: number): Vector3 {
  const e = om.elements; // column-major
  return new Vector3(e[i * 3], e[i * 3 + 1], e[i * 3 + 2]).normalize();
}

/** Apply a world-space transform matrix (built per element) to all elements from their start state. */
export function applyTransform(el: TransformElems, build: (center: Vector3, factor: number) => Matrix4, pivot: PivotPoint, mode: TransformMode, value: number[]): void {
  if (el.mesh) {
    const md = el.mesh;
    const groupCenter = pivotCenter(el, pivot);
    for (const v of el.verts) {
      if (v.factor <= 0) { md.verts[v.index] = [v.start.x, v.start.y, v.start.z]; continue; }
      let p: Vector3;
      if (mode === 'SHRINK_FATTEN') p = v.world.clone().add(v.normal.clone().multiplyScalar(value[0] * v.factor));
      else if (mode === 'TOSPHERE') {
        const sel = el.verts.filter((x) => md.vsel[x.index]);
        let r = 0;
        for (const s of sel) r += s.world.distanceTo(groupCenter);
        r /= Math.max(1, sel.length);
        const d = v.world.clone().sub(groupCenter);
        const target = d.lengthSq() > 1e-12 ? groupCenter.clone().add(d.normalize().multiplyScalar(r)) : v.world.clone();
        p = v.world.clone().lerp(target, value[0] * v.factor);
      } else p = v.world.clone().applyMatrix4(build(groupCenter, v.factor));
      const local = p.applyMatrix4(el.meshWorldInv);
      md.verts[v.index] = [local.x, local.y, local.z];
    }
    app.tagGeometry(md.id);
    return;
  }
  const groupCenter = pivotCenter(el, pivot);
  for (const o of el.objects) {
    const ob = o.ob;
    const center = pivot === 'INDIVIDUAL_ORIGINS' ? o.center : groupCenter;
    const X = build(center, 1);
    // restore start state then compute new basis = P^-1 * X * P * basis
    ob.location = o.start.loc.slice() as [number, number, number];
    ob.rotation = o.start.rot.slice() as [number, number, number];
    ob.scale = o.start.scale.slice() as [number, number, number];
    const basis = basisMatrix(ob);
    const nb = o.parentMat.clone().invert().multiply(X).multiply(o.parentMat).multiply(basis);
    const prevRot = ob.rotation.slice();
    setBasisFromMatrix(ob, nb);
    if (mode === 'TRANSLATION') { ob.rotation = o.start.rot.slice() as [number, number, number]; ob.scale = o.start.scale.slice() as [number, number, number]; }
    else if (mode === 'RESIZE') {
      // keep rotation stable while scaling (avoids decomposition noise)
      if (!hasShear(X, basis)) ob.rotation = o.start.rot.slice() as [number, number, number];
    } else {
      // keep euler values continuous with the starting rotation (e.g. 350° -> 370° rather than 10°)
      ob.rotation = ob.rotation.map((r, i) => compatibleAngle(r, prevRot[i])) as [number, number, number];
      ob.scale = o.start.scale.slice() as [number, number, number];
    }
    for (let i = 0; i < 3; i++) {
      if (ob.lockLocation[i]) ob.location[i] = o.start.loc[i];
      if (ob.lockRotation[i]) ob.rotation[i] = o.start.rot[i];
      if (ob.lockScale[i]) ob.scale[i] = o.start.scale[i];
    }
  }
  app.notify('scene');
}

function hasShear(_x: Matrix4, _b: Matrix4): boolean { return false; }

function compatibleAngle(a: number, ref: number): number {
  const twoPi = Math.PI * 2;
  while (a - ref > Math.PI) a -= twoPi;
  while (a - ref < -Math.PI) a += twoPi;
  return a;
}

export function restoreElements(el: TransformElems): void {
  if (el.mesh) {
    for (const v of el.verts) el.mesh.verts[v.index] = [v.start.x, v.start.y, v.start.z];
    app.tagGeometry(el.mesh.id);
    return;
  }
  for (const o of el.objects) {
    o.ob.location = o.start.loc.slice() as [number, number, number];
    o.ob.rotation = o.start.rot.slice() as [number, number, number];
    o.ob.scale = o.start.scale.slice() as [number, number, number];
  }
  app.notify('scene');
}

// ------------------------------------------------------------------ matrices from values

function translateM(d: Vector3): Matrix4 { return new Matrix4().makeTranslation(d.x, d.y, d.z); }

function aroundCenter(c: Vector3, m: Matrix4): Matrix4 {
  return new Matrix4().makeTranslation(c.x, c.y, c.z).multiply(m).multiply(new Matrix4().makeTranslation(-c.x, -c.y, -c.z));
}

function scaleAlong(om: Matrix3, s: number[]): Matrix4 {
  const R = new Matrix4().setFromMatrix3(om);
  const S = new Matrix4().makeScale(s[0], s[1], s[2]);
  return R.clone().multiply(S).multiply(R.clone().invert());
}

export function buildTransformMatrix(mode: TransformMode, value: number[], axis: Vector3, om: Matrix3) {
  return (center: Vector3, factor: number): Matrix4 => {
    switch (mode) {
      case 'TRANSLATION': return translateM(new Vector3(value[0], value[1], value[2]).multiplyScalar(factor));
      case 'ROTATION': return aroundCenter(center, new Matrix4().makeRotationAxis(axis.clone().normalize(), value[0] * factor));
      case 'TRACKBALL': {
        const q = new Quaternion().setFromAxisAngle(axis, value[0] * factor);
        return aroundCenter(center, new Matrix4().makeRotationFromQuaternion(q));
      }
      case 'RESIZE': return aroundCenter(center, scaleAlong(om, value.map((s) => 1 + (s - 1) * factor)));
      default: return new Matrix4();
    }
  };
}

// ------------------------------------------------------------------ modal

const NAMES = ['X', 'Y', 'Z'];

export interface TransformStart {
  mode: TransformMode;
  view: View3D;
  /** Constraint on start (manipulator). */
  constraint?: boolean[] | null;
  orientation?: TransformOrientation;
  /** Confirm on mouse release (manipulator drag). */
  releaseConfirm?: boolean;
  /** Undo state index before a preceding operation (duplicate + grab = one step). */
  opName?: string;
  onDone?: (ok: boolean) => void;
  mouse: { x: number; y: number };
}

export function startTransform(s: TransformStart): void {
  const view = s.view;
  const ts = app.scene.toolSettings;
  const propOn = !!app.editMesh && ts.proportionalEdit !== 'DISABLED';
  let propSize = ts.proportionalSize;
  let el = gatherElements(propOn ? propSize : 0, ts.proportionalEdit === 'CONNECTED');
  if (!el.objects.length && !el.verts.some((v) => v.factor > 0 || el.mesh?.vsel[v.index])) {
    if (!el.mesh || !el.mesh.vsel.some(Boolean)) { s.onDone?.(false); return; }
  }
  if (propOn) updatePropFactors(el, propSize, ts.proportionalFalloff);
  let mode: TransformMode = s.mode;
  const pivot = ts.pivotPoint;
  let center = pivotCenter(el, pivot);
  const rect = () => view.canvasRect();
  const startMouse = { x: s.mouse.x, y: s.mouse.y };
  let mouse = { ...startMouse };
  // constraint state: list of axis flags + orientation
  let constraint: boolean[] | null = s.constraint ?? null;
  let orient: TransformOrientation = s.orientation ?? ts.transformOrientation;
  let axisPresses = 0;
  let lastAxisKey = '';
  let numStr = '';
  let numIndex = 0;
  const numVals = ['', '', ''];
  let precision = false;
  let precisionAnchor = { x: 0, y: 0 };
  let precisionBase = { x: 0, y: 0 };
  let snap = ts.useSnap;
  let snapPoint: Vector3 | null = null;
  const movingIds = new Set(el.objects.map((o) => o.ob.id));
  /** Vertex under the mouse (screen distance) or point on a surface under the mouse. */
  const snapTarget = (kind: 'VERTEX' | 'FACE' | 'EDGE'): Vector3 | null => {
    const m = effectiveMouse();
    if (kind === 'EDGE') {
      let bestE: Vector3 | null = null, bdE = 15;
      const segs = (pts: Vector3[], edges: [number, number][]) => {
        for (const [a, b] of edges) {
          const pa = view.view.project(pts[a]), pb = view.view.project(pts[b]);
          if (pa.behind || pb.behind) continue;
          const dx = pb.x - pa.x, dy = pb.y - pa.y;
          const l2 = dx * dx + dy * dy;
          const t = l2 > 0 ? Math.max(0, Math.min(1, ((m.x - pa.x) * dx + (m.y - pa.y) * dy) / l2)) : 0;
          const dd = Math.hypot(m.x - (pa.x + dx * t), m.y - (pa.y + dy * t));
          if (dd < bdE) { bdE = dd; bestE = pts[a].clone().lerp(pts[b], t); }
        }
      };
      for (const ob of app.visibleObjects()) {
        if (movingIds.has(ob.id) || ob.type !== 'MESH') continue;
        if (el.mesh && ob.id === el.editOb?.id) {
          const md = el.mesh;
          const pts = md.verts.map((v) => new Vector3(...v).applyMatrix4(el.meshWorld));
          segs(pts, md.edges.filter(([a, b]) => !md.vsel[a] && !md.vsel[b]));
          continue;
        }
        const em = app.evalMesh(ob);
        if (!em || em.verts.length > 60000) continue;
        segs(view.renderer.worldVerts(ob), evalEdges(em));
      }
      return bestE;
    }
    if (kind === 'FACE') {
      const hits = view.renderer.pickMeshes(m.x, m.y).filter((h) => !movingIds.has(h.ob.id) && h.ob.id !== el.editOb?.id);
      return hits[0]?.point ?? null;
    }
    let best: Vector3 | null = null, bd = 20;
    const consider = (p: Vector3) => {
      const s = view.view.project(p);
      if (s.behind) return;
      const dd = Math.hypot(s.x - m.x, s.y - m.y);
      if (dd < bd) { bd = dd; best = p; }
    };
    for (const ob of app.visibleObjects()) {
      if (movingIds.has(ob.id) || ob.type !== 'MESH') continue;
      if (el.mesh && ob.id === el.editOb?.id) {
        // other (unselected) vertices of the mesh being edited
        el.mesh.verts.forEach((v, i) => { if (!el.mesh!.vsel[i] && !el.mesh!.vhide?.[i]) consider(new Vector3(...v).applyMatrix4(el.meshWorld)); });
        continue;
      }
      const verts = view.renderer.worldVerts(ob);
      const step = Math.max(1, Math.floor(verts.length / 20000));
      for (let i = 0; i < verts.length; i += step) consider(verts[i]);
    }
    return best;
  };
  const closestSource = (target: Vector3): Vector3 => {
    const pts = el.mesh ? el.verts.filter((v) => el.mesh!.vsel[v.index]).map((v) => v.world) : el.objects.map((o) => o.center);
    let best = center, bd = Infinity;
    for (const p of pts) { const dd = p.distanceTo(target); if (dd < bd) { bd = dd; best = p; } }
    return best;
  };
  let rotAccum = 0;
  let lastAngle: number | null = null;
  let trackball = { x: 0, y: 0 };
  let value: number[] = [0, 0, 0];
  const undoBefore = app.undoHistory().length - 1;
  void undoBefore;

  const pivotScreen = () => view.view.project(center);

  const om = () => orientationMatrix(orient, view, el);

  const effectiveMouse = () => {
    if (!precision) return mouse;
    return { x: precisionBase.x + (mouse.x - precisionAnchor.x) * 0.1, y: precisionBase.y + (mouse.y - precisionAnchor.y) * 0.1 };
  };

  const snapStep = () => {
    const ps = view.view.pixelSizeAtTarget();
    let step = view.display.gridScale || 1;
    if (view.view.persp === 'ORTHO' && view.view.viewName !== 'USER') {
      while (step / ps < 12) step *= 10;
      while (step / ps > 120) step /= 10;
    }
    return precision ? step / 10 : step;
  };

  const constraintAxes = (): Vector3[] => {
    if (!constraint) return [];
    const m = om();
    return constraint.map((c, i) => (c ? axisVector(m, i) : null)).filter((x): x is Vector3 => !!x);
  };

  const computeTranslation = (): Vector3 => {
    const m = effectiveMouse();
    const axes = constraintAxes();
    const r0 = view.view.ray(startMouse.x, startMouse.y);
    const r1 = view.view.ray(m.x, m.y);
    if (axes.length === 1) {
      const a = axes[0];
      const t0 = closestOnLine(center, a, r0.origin, r0.dir);
      const t1 = closestOnLine(center, a, r1.origin, r1.dir);
      return a.clone().multiplyScalar(t1 - t0);
    }
    if (axes.length === 2) {
      const n = new Vector3().crossVectors(axes[0], axes[1]).normalize();
      const p0 = rayPlane(r0.origin, r0.dir, center, n), p1 = rayPlane(r1.origin, r1.dir, center, n);
      if (p0 && p1) return p1.sub(p0);
      return new Vector3();
    }
    const a = view.view.unprojectAtDepth(startMouse.x, startMouse.y, center);
    const b = view.view.unprojectAtDepth(m.x, m.y, center);
    return b.sub(a);
  };

  const apply = () => {
    const m = om();
    const nums = numStr || numVals.some(Boolean) ? parseNums() : null;
    let axis = view.view.viewDir().negate();
    if (mode === 'TRANSLATION') {
      let d: Vector3;
      if (nums) {
        const axes = constraintAxes();
        d = new Vector3();
        if (axes.length === 1) d.copy(axes[0]).multiplyScalar(nums[0]);
        else if (axes.length === 2) d.copy(axes[0]).multiplyScalar(nums[0]).add(axes[1].clone().multiplyScalar(nums[1]));
        else { d.set(nums[0], nums[1], nums[2]); d.applyMatrix3(m); }
      } else {
        d = computeTranslation();
        const snapEl = ts.snapElement;
        const target = snap && (snapEl === 'VERTEX' || snapEl === 'FACE' || snapEl === 'EDGE') ? snapTarget(snapEl) : null;
        if (target) {
          // move the closest selected point onto the snap target (Blender's default "Closest" snap target)
          const src = closestSource(target);
          d = target.clone().sub(src);
          const axes2 = constraintAxes();
          if (axes2.length === 1) d = axes2[0].clone().multiplyScalar(d.dot(axes2[0]));
          else if (axes2.length === 2) { const nrm = new Vector3().crossVectors(axes2[0], axes2[1]).normalize(); d.sub(nrm.multiplyScalar(d.dot(nrm))); }
          snapPoint = target;
        } else if (snap && snapEl === 'INCREMENT') {
          snapPoint = null;
          // snap in the orientation's frame
          const inv = m.clone().invert();
          const local = d.clone().applyMatrix3(inv);
          const st = snapStep();
          local.set(Math.round(local.x / st) * st, Math.round(local.y / st) * st, Math.round(local.z / st) * st);
          d = local.applyMatrix3(m);
        }
      }
      value = [d.x, d.y, d.z];
      applyTransform(el, buildTransformMatrix('TRANSLATION', value, axis, m), pivot, 'TRANSLATION', value);
    } else if (mode === 'ROTATION') {
      const axes = constraintAxes();
      if (axes.length === 1) {
        axis = axes[0].clone();
        // rotate so that screen motion matches: flip when the axis points away from the viewer
        if (axis.dot(view.view.viewDir()) > 0) axis.negate();
      }
      let angle: number;
      if (nums) angle = (nums[0] * Math.PI) / 180 * (axes.length === 1 && axes[0].dot(view.view.viewDir()) > 0 ? -1 : 1);
      else {
        angle = rotAccum;
        if (snap) { const st = ((precision ? 1 : 5) * Math.PI) / 180; angle = Math.round(angle / st) * st; }
      }
      value = [angle];
      applyTransform(el, buildTransformMatrix('ROTATION', value, axis, m), pivot, 'ROTATION', value);
      (apply as unknown as { axis: Vector3 }).axis = axis;
    } else if (mode === 'TRACKBALL') {
      const right = view.view.viewRight(), up = view.view.viewUp();
      const ax = up.clone().multiplyScalar(trackball.x).add(right.clone().multiplyScalar(-trackball.y));
      const ang = ax.length() * 0.01;
      if (ang > 1e-9) ax.normalize(); else ax.set(0, 0, 1);
      value = [ang];
      applyTransform(el, buildTransformMatrix('TRACKBALL', value, ax, m), pivot, 'TRACKBALL', value);
    } else if (mode === 'RESIZE') {
      let f: number;
      if (nums) f = nums[0];
      else {
        const ps = pivotScreen();
        const em = effectiveMouse();
        const d0 = Math.hypot(startMouse.x - ps.x, startMouse.y - ps.y) || 1;
        const v0 = { x: startMouse.x - ps.x, y: startMouse.y - ps.y };
        const v1 = { x: em.x - ps.x, y: em.y - ps.y };
        f = Math.hypot(v1.x, v1.y) / d0;
        if (v0.x * v1.x + v0.y * v1.y < 0) f = -f;
        if (snap) { const st = precision ? 0.01 : 0.1; f = Math.round(f / st) * st; }
      }
      const s3 = constraint ? constraint.map((c) => (c ? f : 1)) : [f, f, f];
      if (nums && constraint) { let k = 0; for (let i = 0; i < 3; i++) if (constraint[i]) s3[i] = nums[k++] ?? f; }
      else if (nums && !constraint && (numVals[1] || numVals[2])) { s3[0] = nums[0]; s3[1] = nums[1] || 1; s3[2] = nums[2] || 1; }
      value = s3;
      applyTransform(el, buildTransformMatrix('RESIZE', value, axis, m), pivot, 'RESIZE', value);
    } else if (mode === 'SHRINK_FATTEN') {
      let d: number;
      if (nums) d = nums[0];
      else {
        const ps = pivotScreen();
        const em = effectiveMouse();
        d = ((Math.hypot(em.x - ps.x, em.y - ps.y) - Math.hypot(startMouse.x - ps.x, startMouse.y - ps.y)) * view.view.pixelSizeAtTarget());
        if (snap) { const st = snapStep() / 10; d = Math.round(d / st) * st; }
      }
      value = [d];
      applyTransform(el, buildTransformMatrix('SHRINK_FATTEN', value, axis, m), pivot, 'SHRINK_FATTEN', value);
    } else if (mode === 'TOSPHERE') {
      let f: number;
      if (nums) f = nums[0];
      else {
        const ps = pivotScreen();
        const em = effectiveMouse();
        f = Math.min(1, Math.max(0, (Math.hypot(em.x - ps.x, em.y - ps.y) - Math.hypot(startMouse.x - ps.x, startMouse.y - ps.y)) / 200));
        if (snap) f = Math.round(f * 10) / 10;
      }
      value = [f];
      applyTransform(el, buildTransformMatrix('TOSPHERE', value, axis, m), pivot, 'TOSPHERE', value);
    }
    view.requestRender();
  };

  const parseNums = (): number[] => {
    const vals = numVals.slice();
    vals[numIndex] = numStr;
    return vals.map((s, i) => {
      if (!s) return mode === 'RESIZE' ? (i === 0 ? 1 : 1) : 0;
      try {
        let v = Number(Function(`"use strict";return (${s.replace(/[^0-9+\-*/.() e]/g, '')})`)());
        if (!isFinite(v)) v = 0;
        return v;
      } catch { return 0; }
    });
  };

  const orientLabel = () => (orient === 'GLOBAL' ? 'global' : orient.toLowerCase());

  const status = (): string => {
    const nums = numStr || numVals.some(Boolean) ? parseNums() : null;
    const cons = constraint ? ` along ${orientLabel()} ${constraint.map((c, i) => (c ? NAMES[i] : '')).join('')}` : '';
    const ns = (i: number) => (numIndex === i && numStr ? `[${numStr}|]` : numVals[i] ? `[${numVals[i]}]` : '');
    switch (mode) {
      case 'TRANSLATION': {
        const axes = constraintAxes();
        if (axes.length === 1) {
          const len = new Vector3(value[0], value[1], value[2]).dot(axes[0]);
          return `D: ${ns(0) || len.toFixed(4)} (${len.toFixed(4)})${cons}`;
        }
        return `Dx: ${ns(0) || value[0].toFixed(4)}   Dy: ${ns(1) || value[1].toFixed(4)}   Dz: ${ns(2) || value[2].toFixed(4)} (${Math.hypot(value[0], value[1], value[2]).toFixed(4)})${cons}`;
      }
      case 'ROTATION': return `Rot: ${ns(0) || ((value[0] * 180) / Math.PI).toFixed(2)}°${cons}`;
      case 'TRACKBALL': return `Trackball: ${((value[0] * 180) / Math.PI).toFixed(2)}°`;
      case 'RESIZE': return `Scale X: ${ns(0) || value[0].toFixed(4)}   Y: ${ns(1) || value[1].toFixed(4)}   Z: ${ns(2) || value[2].toFixed(4)}${cons}`;
      case 'SHRINK_FATTEN': return `Shrink/Fatten: ${ns(0) || value[0].toFixed(4)}`;
      case 'TOSPHERE': return `To Sphere: ${ns(0) || value[0].toFixed(4)}`;
    }
    void nums;
    return '';
  };

  const setConstraint = (axisIdx: number, plane: boolean) => {
    const key = `${axisIdx}${plane}`;
    if (key === lastAxisKey) axisPresses++; else { axisPresses = 1; lastAxisKey = key; }
    const ts0 = ts.transformOrientation;
    // first press: user orientation (global by default); second: local (or global if user orientation isn't global); third: off
    if (axisPresses === 1) orient = s.orientation ?? ts0;
    else if (axisPresses === 2) orient = (s.orientation ?? ts0) === 'GLOBAL' ? 'LOCAL' : 'GLOBAL';
    else { constraint = null; axisPresses = 0; lastAxisKey = ''; apply(); return; }
    constraint = [0, 1, 2].map((i) => (plane ? i !== axisIdx : i === axisIdx));
    apply();
  };

  const finish = (ok: boolean) => {
    window.removeEventListener('keyup', keyUp, true);
    app.endModal(handler);
    view.transformState = null;
    if (!ok) {
      restoreElements(el);
      s.onDone?.(false);
      view.requestRender();
      return;
    }
    // auto keyframing
    if (ts.useKeyframeInsertAuto && !el.mesh) {
      const path = mode === 'TRANSLATION' ? 'location' : mode === 'RESIZE' ? 'scale' : 'rotation_euler';
      for (const o of el.objects) for (let i = 0; i < 3; i++) insertKeyframe(o.ob, path, i, app.scene.frameCurrent, undefined, app.prefs.keyframeInterpolation);
    }
    const opId = mode === 'TRANSLATION' ? 'transform.translate' : mode === 'ROTATION' || mode === 'TRACKBALL' ? (mode === 'TRACKBALL' ? 'transform.trackball' : 'transform.rotate') : mode === 'RESIZE' ? 'transform.resize' : mode === 'SHRINK_FATTEN' ? 'transform.shrink_fatten' : 'transform.tosphere';
    const def = app.operator(opId)!;
    const props: OpProps = { value: mode === 'TRANSLATION' || mode === 'RESIZE' ? value.slice() : value[0], constraint_axis: constraint ? constraint.slice() : [false, false, false], constraint_orientation: orient, proportional: propOn ? ts.proportionalEdit : 'DISABLED', proportional_size: propSize, proportional_edit_falloff: ts.proportionalFalloff };
    if (mode === 'ROTATION') {
      const a = (apply as unknown as { axis?: Vector3 }).axis ?? view.view.viewDir().negate();
      props.axis = [a.x, a.y, a.z];
      props.value = value[0];
    }
    props._pivot = pivot;
    s.onDone?.(true);
    app.finishOperator(def, props, { app, area: view.area }, app.undoHistory().findIndex((h) => h.current));
    view.requestRender();
  };

  const keyUp = (e: KeyboardEvent) => {
    if (e.key === 'Control') { snap = ts.useSnap; apply(); }
    if (e.key === 'Shift') { precision = false; mouse = effectiveMouse(); apply(); }
  };
  window.addEventListener('keyup', keyUp, true);

  const handler: ModalHandler = {
    cursor: mode === 'TRANSLATION' ? 'move' : 'default',
    status,
    cancel: () => finish(false),
    onEvent(e: Event): boolean {
      if (e.type === 'pointermove') {
        const pe = e as PointerEvent;
        const r = rect();
        const nm = { x: pe.clientX - r.left, y: pe.clientY - r.top };
        snap = ts.useSnap !== pe.ctrlKey;
        if (pe.shiftKey && !precision) { precision = true; precisionAnchor = { ...nm }; precisionBase = { ...mouse }; }
        else if (!pe.shiftKey && precision) { mouse = effectiveMouse(); precision = false; }
        if (mode === 'ROTATION') {
          const ps = pivotScreen();
          const em = precision ? { x: precisionBase.x + (nm.x - precisionAnchor.x) * 0.1, y: precisionBase.y + (nm.y - precisionAnchor.y) * 0.1 } : nm;
          const ang = Math.atan2(-(em.y - ps.y), em.x - ps.x);
          if (lastAngle === null) lastAngle = Math.atan2(-(startMouse.y - ps.y), startMouse.x - ps.x);
          let d = ang - lastAngle;
          if (d > Math.PI) d -= Math.PI * 2;
          if (d < -Math.PI) d += Math.PI * 2;
          rotAccum += d;
          lastAngle = ang;
        } else if (mode === 'TRACKBALL') {
          trackball = { x: (nm.x - startMouse.x) * (precision ? 0.1 : 1), y: (nm.y - startMouse.y) * (precision ? 0.1 : 1) };
        }
        if (!precision) mouse = nm; else mouse = nm;
        apply();
        return true;
      }
      if (e.type === 'pointerdown') {
        const pe = e as PointerEvent;
        if (s.releaseConfirm) return true;
        if (pe.button === 0) { finish(true); return true; }
        if (pe.button === 2) { finish(false); return true; }
        return true;
      }
      if (e.type === 'pointerup') {
        const pe = e as PointerEvent;
        if (s.releaseConfirm && pe.button === 0) { finish(true); return true; }
        return true;
      }
      if (e.type === 'wheel') {
        const we = e as WheelEvent;
        if (propOn) {
          propSize = Math.max(0.001, propSize * (we.deltaY > 0 ? 1.1 : 1 / 1.1));
          ts.proportionalSize = propSize;
          restoreElements(el);
          el = gatherElements(propSize, ts.proportionalEdit === 'CONNECTED');
          updatePropFactors(el, propSize, ts.proportionalFalloff);
          apply();
        }
        return true;
      }
      if (e.type === 'keydown') {
        const ke = e as KeyboardEvent;
        const k = ke.key;
        if (k === 'Escape') { finish(false); return true; }
        if (k === 'Enter' || k === ' ' || k === 'NumpadEnter') { finish(true); return true; }
        if (k === 'Control') { snap = !ts.useSnap; apply(); return true; }
        if (k === 'Shift') return true;
        const lower = k.toLowerCase();
        if ((lower === 'x' || lower === 'y' || lower === 'z') && !ke.ctrlKey && !ke.altKey) {
          setConstraint('xyz'.indexOf(lower), ke.shiftKey);
          return true;
        }
        if (lower === 'g' && !ke.ctrlKey && !ke.altKey && mode !== 'TRANSLATION') { restoreElements(el); mode = 'TRANSLATION'; numStr = ''; apply(); return true; }
        if (lower === 'r' && !ke.ctrlKey && !ke.altKey) {
          restoreElements(el);
          mode = mode === 'ROTATION' && !el.mesh ? 'TRACKBALL' : mode === 'ROTATION' ? 'TRACKBALL' : 'ROTATION';
          rotAccum = 0; lastAngle = null; numStr = '';
          apply();
          return true;
        }
        if (lower === 's' && !ke.ctrlKey && !ke.altKey && mode !== 'RESIZE') { restoreElements(el); mode = 'RESIZE'; numStr = ''; apply(); return true; }
        if ((lower === 'o') && !ke.ctrlKey && !ke.altKey && el.mesh) {
          ts.proportionalEdit = ts.proportionalEdit === 'DISABLED' ? 'ENABLED' : 'DISABLED';
          app.report('INFO', `Proportional editing ${ts.proportionalEdit === 'DISABLED' ? 'off' : 'on'}`);
          return true;
        }
        if (k === 'PageUp' || k === 'PageDown') {
          if (propOn) {
            propSize = Math.max(0.001, propSize * (k === 'PageUp' ? 1.1 : 1 / 1.1));
            ts.proportionalSize = propSize;
            restoreElements(el);
            el = gatherElements(propSize, ts.proportionalEdit === 'CONNECTED');
            updatePropFactors(el, propSize, ts.proportionalFalloff);
            apply();
          }
          return true;
        }
        // numeric input
        if (/^[0-9.]$/.test(k) || (k === '-' && !numStr) || ['*', '/', '+', '(', ')'].includes(k) || (k === '-' && numStr)) {
          numStr += k;
          apply();
          return true;
        }
        if (k === 'Backspace') {
          if (ke.ctrlKey) numStr = ''; else numStr = numStr.slice(0, -1);
          apply();
          return true;
        }
        if (k === 'Tab') {
          numVals[numIndex] = numStr;
          numIndex = (numIndex + 1) % (mode === 'TRANSLATION' || mode === 'RESIZE' ? 3 : 1);
          numStr = numVals[numIndex];
          ke.preventDefault();
          apply();
          return true;
        }
        return true;
      }
      if (e.type === 'contextmenu') return true;
      return false;
    },
  };
  view.transformState = { center: () => center, constraint: () => constraint, orient: () => om(), mode: () => mode, propSize: () => (propOn ? propSize : 0), snap: () => (snap ? snapPoint : null) };
  app.startModal(handler);
  center = pivotCenter(el, pivot);
  apply();
}

function closestOnLine(p: Vector3, a: Vector3, ro: Vector3, rd: Vector3): number {
  // parameter t of the point p + a*t closest to the ray ro + rd*s
  const w0 = p.clone().sub(ro);
  const b = a.dot(rd);
  const d = a.dot(w0), e = rd.dot(w0);
  const denom = 1 - b * b;
  if (Math.abs(denom) < 1e-6) return 0;
  return (b * e - d) / denom;
}

function rayPlane(ro: Vector3, rd: Vector3, p: Vector3, n: Vector3): Vector3 | null {
  const den = rd.dot(n);
  if (Math.abs(den) < 1e-9) return null;
  const t = p.clone().sub(ro).dot(n) / den;
  return ro.clone().add(rd.clone().multiplyScalar(t));
}

// ------------------------------------------------------------------ operator definitions (exec used by redo panel)

const vec3Prop = (name: string, def: number[], subtype: 'TRANSLATION' | 'XYZ' = 'TRANSLATION') => ({ name, type: 'vector' as const, default: def, size: 3, subtype });
const commonProps = {
  constraint_axis: { name: 'Constraint Axis', type: 'bools' as const, default: [false, false, false], size: 3 },
  constraint_orientation: { name: 'Orientation', type: 'enum' as const, default: 'GLOBAL', items: [['GLOBAL', 'Global'], ['LOCAL', 'Local'], ['NORMAL', 'Normal'], ['GIMBAL', 'Gimbal'], ['VIEW', 'View']] as [string, string][] },
  proportional: { name: 'Proportional Editing', type: 'enum' as const, default: 'DISABLED', items: [['DISABLED', 'Disable'], ['ENABLED', 'Enable'], ['CONNECTED', 'Connected']] as [string, string][] },
  proportional_edit_falloff: { name: 'Proportional Editing Falloff', type: 'enum' as const, default: 'SMOOTH', items: [['SMOOTH', 'Smooth'], ['SPHERE', 'Sphere'], ['ROOT', 'Root'], ['INVERSE_SQUARE', 'Inverse Square'], ['SHARP', 'Sharp'], ['LINEAR', 'Linear'], ['CONSTANT', 'Constant'], ['RANDOM', 'Random']] as [string, string][] },
  proportional_size: { name: 'Proportional Size', type: 'float' as const, default: 1, min: 0.001 },
  _pivot: { name: 'Pivot', type: 'string' as const, default: 'MEDIAN_POINT', hidden: true },
};

function execTransform(mode: TransformMode, props: OpProps, view: View3D | null): 'FINISHED' {
  const prop = props.proportional as string;
  const size = props.proportional_size as number;
  const el = gatherElements(app.editMesh && prop !== 'DISABLED' ? size : 0, prop === 'CONNECTED');
  if (app.editMesh && prop !== 'DISABLED') updatePropFactors(el, size, props.proportional_edit_falloff as string);
  const om = orientationMatrix((props.constraint_orientation as TransformOrientation) ?? 'GLOBAL', view, el);
  const pivot = (props._pivot as PivotPoint) ?? app.scene.toolSettings.pivotPoint;
  const v = props.value as number[] | number;
  const value = Array.isArray(v) ? v.slice() : [v];
  let axis = new Vector3(0, 0, 1);
  if (Array.isArray(props.axis)) axis = new Vector3(...(props.axis as [number, number, number]));
  applyTransform(el, buildTransformMatrix(mode, value, axis, om), pivot, mode, value);
  return 'FINISHED';
}

function invokeTransform(mode: TransformMode) {
  return (ctx: OpContext, props: OpProps) => {
    const view = viewFromCtx(ctx);
    if (!view) return execTransform(mode, props, null);
    const r = view.canvasRect();
    const c = props.constraint_axis as boolean[] | undefined;
    startTransform({
      mode, view, mouse: { x: app.mouse.x - r.left, y: app.mouse.y - r.top },
      constraint: c && c.some(Boolean) ? c : null,
    });
    return 'RUNNING_MODAL' as const;
  };
}

let viewFromCtx: (ctx: OpContext) => View3D | null = () => null;
export function setViewResolver(fn: (ctx: OpContext) => View3D | null): void { viewFromCtx = fn; }

const pollTransform = () => app.mode === 'SCULPT' || app.mode === 'VERTEX_PAINT' ? false : app.mode === 'EDIT' ? !!app.editMesh?.vsel.some(Boolean) : app.selectedObjects().length > 0;

export const TRANSFORM_OPERATORS: OperatorDef[] = [
  { id: 'transform.translate', label: 'Move', description: 'Translate (move) selected items', undo: true, register: true, poll: pollTransform,
    props: { value: vec3Prop('Vector', [0, 0, 0]), ...commonProps }, invoke: invokeTransform('TRANSLATION'), exec: (ctx, p) => execTransform('TRANSLATION', p, viewFromCtx(ctx)) },
  { id: 'transform.rotate', label: 'Rotate', description: 'Rotate selected items', undo: true, register: true, poll: pollTransform,
    props: { value: { name: 'Angle', type: 'float', default: 0, subtype: 'ANGLE' }, axis: vec3Prop('Axis', [0, 0, 1], 'XYZ'), ...commonProps }, invoke: invokeTransform('ROTATION'), exec: (ctx, p) => execTransform('ROTATION', p, viewFromCtx(ctx)) },
  { id: 'transform.trackball', label: 'Trackball', description: 'Trackball style rotation of selected items', undo: true, register: true, poll: pollTransform,
    props: { value: { name: 'Angle', type: 'float', default: 0, subtype: 'ANGLE' }, axis: vec3Prop('Axis', [0, 0, 1], 'XYZ'), ...commonProps }, invoke: invokeTransform('TRACKBALL'), exec: (ctx, p) => execTransform('TRACKBALL', p, viewFromCtx(ctx)) },
  { id: 'transform.resize', label: 'Resize', description: 'Scale (resize) selected items', undo: true, register: true, poll: pollTransform,
    props: { value: vec3Prop('Vector', [1, 1, 1], 'XYZ'), ...commonProps }, invoke: invokeTransform('RESIZE'), exec: (ctx, p) => execTransform('RESIZE', p, viewFromCtx(ctx)) },
  { id: 'transform.shrink_fatten', label: 'Shrink/Fatten', description: 'Shrink/fatten selected vertices along normals', undo: true, register: true, poll: () => app.mode === 'EDIT' && !!app.editMesh?.vsel.some(Boolean),
    props: { value: { name: 'Offset', type: 'float', default: 0, subtype: 'DISTANCE' }, ...commonProps }, invoke: invokeTransform('SHRINK_FATTEN'), exec: (ctx, p) => execTransform('SHRINK_FATTEN', p, viewFromCtx(ctx)) },
  { id: 'transform.tosphere', label: 'To Sphere', description: 'Move selected vertices outward in a spherical shape around mesh center', undo: true, register: true, poll: () => app.mode === 'EDIT' && !!app.editMesh?.vsel.some(Boolean),
    props: { value: { name: 'Factor', type: 'float', default: 0, min: 0, max: 1, subtype: 'FACTOR' }, ...commonProps }, invoke: invokeTransform('TOSPHERE'), exec: (ctx, p) => execTransform('TOSPHERE', p, viewFromCtx(ctx)) },
];

/** Euler compatible helper exported for other modules. */
export function eulerFromQuat(q: Quaternion, ob: BObject): Euler {
  return new Euler().setFromQuaternion(q, threeEulerOrder(ob.rotationMode));
}
