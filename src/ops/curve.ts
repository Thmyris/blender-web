// Curve and NURBS surface operators (bpy.ops.curve.* / bpy.ops.surface.*): Add > Curve and
// Add > Surface, and the edit-mode tools of Blender 2.79 (extrude, Ctrl+click add, make segment,
// subdivide, switch direction, delete, toggle cyclic, handle types, hide/reveal, duplicate,
// separate, radius / tilt, selection tools). Also the edit-mode menus and keymap.

import { Euler, Matrix3, Matrix4, Quaternion, Vector3 } from 'three';
import { app, type OpContext, type OpProps, type OperatorDef } from '../app';
import type { BObject, Vec3 } from '../core/types';
import type { BezierPoint, CurveData, HandleType, Spline, SplinePoint } from '../core/curvetypes';
import { createObject, newId, threeEulerOrder, uniqueNameIn } from '../core/scene';
import { calcHandles, newBezierPoint, newCurveData, newSpline, newSplinePoint } from '../core/curve';
import { curveDataOf } from '../core/curveobj';
import { curvePrimitive, surfacePrimitive, CURVE_PRIM_NAMES, SURFACE_PRIM_NAMES, type CurvePrim, type SurfacePrim } from '../core/curveprims';
import { activeLayer, viewAlignedRotation, viewOf } from './common';
import { startTransform } from '../editors/view3d/transform';
import {
  anyCurveSelected, curveMenus, editCurve, isPointSelected, pickCurveElem, pointCount, recalcCurveHandles, selectAllCurve,
  setPointSelect,
} from '../editors/view3d/curveedit';
import { registerKeymap, type KeyItem } from '../keymap';
import { showMenu, type MenuItem } from '../ui/menu';
import type { View3D } from '../editors/view3d/view3d';

const op = (label: string, id: string, props?: Record<string, unknown>, icon?: string): MenuItem => ({ label, op: id, props, icon });
const sep: MenuItem = { type: 'separator' };
const sub = (label: string, items: MenuItem[] | (() => MenuItem[]), icon?: string): MenuItem => ({ type: 'submenu', label, items, icon });

// ------------------------------------------------------------------ helpers

export function ensureCurveCollections(): void {
  const d = app.doc;
  d.curves ??= {};
  d.metaballs ??= {};
  d.fonts ??= {};
}

export const isCurveEdit = () => app.mode === 'EDIT' && app.editObj?.type === 'CURVE';
export const isSurfaceEdit = () => app.mode === 'EDIT' && app.editObj?.type === 'SURFACE';
const isCurveOrSurfEdit = () => isCurveEdit() || isSurfaceEdit();
const cur = (): CurveData => editCurve()!.cu;
const hasSel = () => { const e = editCurve(); return !!e && anyCurveSelected(e.cu); };

function done(): void {
  const e = editCurve();
  if (e) recalcCurveHandles(e.cu);
  app.notify('geometry', 'select');
}

function grabAfter(ctx: OpContext): void {
  const view = viewOf(ctx);
  if (!view) return;
  const r = view.canvasRect();
  startTransform({ mode: 'TRANSLATION', view, mouse: { x: app.mouse.x - r.left, y: app.mouse.y - r.top } });
}

const cloneBez = (b: BezierPoint): BezierPoint => JSON.parse(JSON.stringify(b)) as BezierPoint;
const clonePt = (p: SplinePoint): SplinePoint => JSON.parse(JSON.stringify(p)) as SplinePoint;
const cloneSpline = (sp: Spline): Spline => JSON.parse(JSON.stringify(sp)) as Spline;

/** Spline with the given points (same settings). */
function withPoints(sp: Spline, bez: BezierPoint[], pts: SplinePoint[]): Spline {
  const s = cloneSpline({ ...sp, bezierPoints: [], points: [] });
  s.bezierPoints = bez;
  s.points = pts;
  s.pointCountU = sp.type === 'BEZIER' ? bez.length : pts.length;
  s.pointCountV = 1;
  return s;
}

/** Runs of consecutive selected points of a curve spline (wrapping for cyclic splines). */
function selectedRuns(sp: Spline): number[][] {
  const n = pointCount(sp);
  const sel = Array.from({ length: n }, (_, i) => isPointSelected(sp, i) && !(sp.type === 'BEZIER' ? sp.bezierPoints[i].hide : sp.points[i].hide));
  if (sel.every(Boolean)) return [Array.from({ length: n }, (_, i) => i)];
  const runs: number[][] = [];
  let curRun: number[] = [];
  for (let i = 0; i < n; i++) {
    if (sel[i]) curRun.push(i);
    else if (curRun.length) { runs.push(curRun); curRun = []; }
  }
  if (curRun.length) runs.push(curRun);
  if (sp.useCyclicU && runs.length > 1 && sel[0] && sel[n - 1]) { const last = runs.pop()!; runs[0] = [...last, ...runs[0]]; }
  return runs;
}

function deselectSpline(sp: Spline): void { for (let i = 0; i < pointCount(sp); i++) setPointSelect(sp, i, false); }

// ------------------------------------------------------------------ add primitives

const commonAddProps = {
  radius: { name: 'Radius', type: 'float' as const, default: 1, min: 0, subtype: 'DISTANCE' as const },
  view_align: { name: 'Align to View', type: 'bool' as const, default: false, description: 'Align the new object to the view' },
  enter_editmode: { name: 'Enter Editmode', type: 'bool' as const, default: false, description: 'Enter editmode when adding this object' },
  location: { name: 'Location', type: 'vector' as const, default: [0, 0, 0], size: 3, subtype: 'TRANSLATION' as const },
  rotation: { name: 'Rotation', type: 'vector' as const, default: [0, 0, 0], size: 3, subtype: 'EULER' as const },
};

function invokeAdd(id: string) {
  return (ctx: OpContext, props: OpProps) => {
    const view = viewOf(ctx);
    props.location = app.scene.cursor.slice();
    props.view_align = props.view_align || app.prefs.alignNewObjects === 'VIEW';
    props.rotation = props.view_align ? viewAlignedRotation(view) : [0, 0, 0];
    props.enter_editmode = props.enter_editmode || app.prefs.enterEditMode;
    return app.operator(id)!.exec!(ctx, props);
  };
}

/** Place a new object at the cursor on the active layer, selected and active. */
export function addObjectAt(ob: BObject, props: OpProps): void {
  const sc = app.scene;
  ob.location = ((props.location as Vec3) ?? sc.cursor).slice() as Vec3;
  ob.rotation = ((props.rotation as Vec3) ?? [0, 0, 0]).slice() as Vec3;
  ob.layers = new Array(20).fill(false);
  ob.layers[activeLayer()] = true;
  sc.objects.push(ob.id);
  app.deselectAll();
  ob.select = true;
  sc.activeObject = ob.id;
}

/** Matrix of the add operator's location / rotation. */
function addMatrix(props: OpProps): Matrix4 {
  const rot = (props.rotation as Vec3) ?? [0, 0, 0];
  return new Matrix4().compose(new Vector3(...((props.location as Vec3) ?? [0, 0, 0])), new Quaternion().setFromEuler(new Euler(rot[0], rot[1], rot[2], threeEulerOrder('XYZ'))), new Vector3(1, 1, 1));
}

function transformSpline(sp: Spline, m: Matrix4): void {
  const t = (v: Vec3): Vec3 => { const p = new Vector3(...v).applyMatrix4(m); return [p.x, p.y, p.z]; };
  for (const b of sp.bezierPoints) { b.co = t(b.co); b.handleLeft = t(b.handleLeft); b.handleRight = t(b.handleRight); }
  for (const p of sp.points) p.co = t(p.co);
}

function addCurveLike(type: 'CURVE' | 'SURFACE', name: string, sp: Spline, props: OpProps, setup?: (cu: CurveData) => void): 'FINISHED' {
  ensureCurveCollections();
  const doc = app.doc;
  const ec = editCurve();
  if (app.mode === 'EDIT' && ec && ec.ob.type === type) {
    // added into the curve being edited, at the cursor, as the only selection
    transformSpline(sp, app.matrices.world(ec.ob).clone().invert().multiply(addMatrix(props)));
    selectAllCurve(ec.cu, 'DESELECT');
    sp.resolutionU = ec.cu.resolutionU;
    ec.cu.splines.push(sp);
    ec.cu.activeSpline = ec.cu.splines.length - 1;
    recalcCurveHandles(ec.cu);
    app.notify('geometry');
    return 'FINISHED';
  }
  const cu = newCurveData(newId(doc, 'CU'), uniqueNameIn(doc, 'curves', name));
  if (type === 'SURFACE') { cu.resolutionU = 4; cu.resolutionV = 4; cu.showNormalFace = false; }
  sp.resolutionU = cu.resolutionU;
  sp.resolutionV = cu.resolutionV;
  cu.splines.push(sp);
  setup?.(cu);
  recalcCurveHandles(cu);
  doc.curves[cu.id] = cu;
  const ob = createObject(doc, type, name, cu.id);
  addObjectAt(ob, props);
  if (props.enter_editmode) { app.mode = 'EDIT'; app.editObject = ob.id; }
  app.notify('geometry');
  return 'FINISHED';
}

const CURVE_ADD: [CurvePrim, string, string, string][] = [
  ['BEZIER', 'curve.primitive_bezier_curve_add', 'Add Bezier', 'CURVE_BEZCURVE'],
  ['CIRCLE', 'curve.primitive_bezier_circle_add', 'Add Bezier Circle', 'CURVE_BEZCIRCLE'],
  ['NURBS', 'curve.primitive_nurbs_curve_add', 'Add Nurbs Curve', 'CURVE_NCURVE'],
  ['NURBS_CIRCLE', 'curve.primitive_nurbs_circle_add', 'Add Nurbs Circle', 'CURVE_NCIRCLE'],
  ['PATH', 'curve.primitive_nurbs_path_add', 'Add Path', 'CURVE_PATH'],
];
const SURF_ADD: [SurfacePrim, string, string, string][] = [
  ['CURVE', 'surface.primitive_nurbs_surface_curve_add', 'Add Surface Curve', 'SURFACE_NCURVE'],
  ['CIRCLE', 'surface.primitive_nurbs_surface_circle_add', 'Add Surface Circle', 'SURFACE_NCIRCLE'],
  ['SURFACE', 'surface.primitive_nurbs_surface_surface_add', 'Add Surface Patch', 'SURFACE_NSURFACE'],
  ['CYLINDER', 'surface.primitive_nurbs_surface_cylinder_add', 'Add Surface Cylinder', 'SURFACE_NCYLINDER'],
  ['SPHERE', 'surface.primitive_nurbs_surface_sphere_add', 'Add Surface Sphere', 'SURFACE_NSPHERE'],
  ['TORUS', 'surface.primitive_nurbs_surface_torus_add', 'Add Surface Torus', 'SURFACE_NTORUS'],
];
const addPoll = (type: 'CURVE' | 'SURFACE') => () => app.mode === 'OBJECT' || (app.mode === 'EDIT' && app.editObj?.type === type);

export const CURVE_ADD_OPERATORS: OperatorDef[] = [
  ...CURVE_ADD.map(([prim, id, label, icon]): OperatorDef => ({
    id, label, icon, undo: true, register: true, description: `Construct a ${label.slice(4)} curve`, props: { ...commonAddProps }, poll: addPoll('CURVE'),
    invoke: invokeAdd(id),
    exec: (_c, p) => addCurveLike('CURVE', CURVE_PRIM_NAMES[prim], curvePrimitive(prim, Number(p.radius)), p, (cu) => {
      if (prim === 'PATH') { cu.usePath = true; cu.dimensions = '3D'; }
    }),
  })),
  ...SURF_ADD.map(([prim, id, label, icon]): OperatorDef => ({
    id, label, icon, undo: true, register: true, description: `Construct a Nurbs ${label.slice(12) || 'surface'}`, props: { ...commonAddProps }, poll: addPoll('SURFACE'),
    invoke: invokeAdd(id),
    exec: (_c, p) => addCurveLike('SURFACE', SURFACE_PRIM_NAMES[prim], surfacePrimitive(prim, Number(p.radius)), p),
  })),
];

export function curveAddItems(): MenuItem[] {
  return [
    op('Bezier', 'curve.primitive_bezier_curve_add', {}, 'CURVE_BEZCURVE'),
    op('Circle', 'curve.primitive_bezier_circle_add', {}, 'CURVE_BEZCIRCLE'),
    sep,
    op('Nurbs Curve', 'curve.primitive_nurbs_curve_add', {}, 'CURVE_NCURVE'),
    op('Nurbs Circle', 'curve.primitive_nurbs_circle_add', {}, 'CURVE_NCIRCLE'),
    op('Path', 'curve.primitive_nurbs_path_add', {}, 'CURVE_PATH'),
  ];
}

export function surfaceAddItems(): MenuItem[] {
  return [
    op('Nurbs Curve', 'surface.primitive_nurbs_surface_curve_add', {}, 'SURFACE_NCURVE'),
    op('Nurbs Circle', 'surface.primitive_nurbs_surface_circle_add', {}, 'SURFACE_NCIRCLE'),
    op('Nurbs Surface', 'surface.primitive_nurbs_surface_surface_add', {}, 'SURFACE_NSURFACE'),
    op('Nurbs Cylinder', 'surface.primitive_nurbs_surface_cylinder_add', {}, 'SURFACE_NCYLINDER'),
    op('Nurbs Sphere', 'surface.primitive_nurbs_surface_sphere_add', {}, 'SURFACE_NSPHERE'),
    op('Nurbs Torus', 'surface.primitive_nurbs_surface_torus_add', {}, 'SURFACE_NTORUS'),
  ];
}

// ------------------------------------------------------------------ edit: selection

const selAction = { name: 'Action', type: 'enum' as const, default: 'TOGGLE', items: [['TOGGLE', 'Toggle'], ['SELECT', 'Select'], ['DESELECT', 'Deselect'], ['INVERT', 'Invert']] as [string, string][] };

function neighbours(sp: Spline, i: number): number[] {
  const n = pointCount(sp);
  const out: number[] = [];
  if (sp.pointCountV > 1) {
    const nu = sp.pointCountU, nv = sp.pointCountV;
    const u = i % nu, v = Math.floor(i / nu);
    if (u > 0) out.push(i - 1); else if (sp.useCyclicU) out.push(i + nu - 1);
    if (u < nu - 1) out.push(i + 1); else if (sp.useCyclicU) out.push(i - nu + 1);
    if (v > 0) out.push(i - nu); else if (sp.useCyclicV) out.push(i + nu * (nv - 1));
    if (v < nv - 1) out.push(i + nu); else if (sp.useCyclicV) out.push(i - nu * (nv - 1));
    return out;
  }
  if (i > 0) out.push(i - 1); else if (sp.useCyclicU && n > 2) out.push(n - 1);
  if (i < n - 1) out.push(i + 1); else if (sp.useCyclicU && n > 2) out.push(0);
  return out;
}

function growSelection(more: boolean): void {
  for (const sp of cur().splines) {
    const n = pointCount(sp);
    const sel = Array.from({ length: n }, (_, i) => isPointSelected(sp, i));
    for (let i = 0; i < n; i++) {
      const nb = neighbours(sp, i);
      if (more && !sel[i] && nb.some((j) => sel[j])) setPointSelect(sp, i, true);
      if (!more && sel[i] && nb.some((j) => !sel[j])) setPointSelect(sp, i, false);
    }
  }
}

function seeded(seed: number): () => number {
  let s = (seed * 9301 + 49297) % 233280 || 1;
  return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
}

const editOp = (o: Omit<OperatorDef, 'undo' | 'register'> & { undo?: boolean; register?: boolean }): OperatorDef => ({ undo: true, register: true, poll: isCurveOrSurfEdit, ...o });

const SELECT_OPS: OperatorDef[] = [
  editOp({
    id: 'curve.select_all', label: '(De)select All', description: '(De)select all control points', props: { action: selAction },
    exec: (_c, p) => { selectAllCurve(cur(), p.action as 'TOGGLE'); done(); return 'FINISHED'; },
  }),
  editOp({
    id: 'curve.select_linked', label: 'Select Linked All', description: 'Select all control points linked to the current selection',
    exec: () => { for (const sp of cur().splines) if (Array.from({ length: pointCount(sp) }, (_, i) => isPointSelected(sp, i)).some(Boolean)) for (let i = 0; i < pointCount(sp); i++) setPointSelect(sp, i, true); done(); return 'FINISHED'; },
  }),
  editOp({
    id: 'curve.select_linked_pick', label: 'Select Linked', description: 'Select all control points linked to already selected ones',
    props: { deselect: { name: 'Deselect', type: 'bool', default: false, description: 'Deselect linked control points rather than selecting them' } },
    invoke: (ctx, p) => {
      const view = viewOf(ctx);
      const e = editCurve();
      if (!view || !e) return 'CANCELLED';
      const r = view.canvasRect();
      const hit = pickCurveElem(view, e.ob, e.cu, app.mouse.x - r.left, app.mouse.y - r.top, 40);
      if (!hit) return 'CANCELLED';
      const sp = e.cu.splines[hit.si];
      for (let i = 0; i < pointCount(sp); i++) setPointSelect(sp, i, !p.deselect);
      done();
      return 'FINISHED';
    },
  }),
  editOp({ id: 'curve.select_more', label: 'Select More', description: 'Select control points directly linked to already selected ones', exec: () => { growSelection(true); done(); return 'FINISHED'; } }),
  editOp({ id: 'curve.select_less', label: 'Select Less', description: 'Reduce current selection by deselecting boundary elements', exec: () => { growSelection(false); done(); return 'FINISHED'; } }),
  editOp({
    id: 'curve.select_random', label: 'Select Random', description: 'Randomly select some control points',
    props: { percent: { name: 'Percent', type: 'float', default: 50, min: 0, max: 100, subtype: 'PERCENTAGE' }, seed: { name: 'Random Seed', type: 'int', default: 0, min: 0 }, action: { name: 'Action', type: 'enum', default: 'SELECT', items: [['SELECT', 'Select'], ['DESELECT', 'Deselect']] } },
    exec: (_c, p) => {
      const rnd = seeded(Number(p.seed));
      for (const sp of cur().splines) for (let i = 0; i < pointCount(sp); i++) if (rnd() * 100 < Number(p.percent)) setPointSelect(sp, i, p.action === 'SELECT');
      done();
      return 'FINISHED';
    },
  }),
  editOp({
    id: 'curve.select_nth', label: 'Checker Deselect', description: 'Deselect every other vertex',
    props: { nth: { name: 'Nth Selection', type: 'int', default: 2, min: 2 }, skip: { name: 'Skip', type: 'int', default: 1, min: 1 }, offset: { name: 'Offset', type: 'int', default: 0 } },
    poll: hasSel,
    exec: (_c, p) => {
      const nth = Number(p.nth), skip = Number(p.skip), off = Number(p.offset);
      for (const sp of cur().splines) {
        let k = 0;
        for (let i = 0; i < pointCount(sp); i++) {
          if (!isPointSelected(sp, i)) continue;
          const m = ((k + off) % (nth + skip - 1) + (nth + skip - 1)) % (nth + skip - 1);
          if (m >= skip) setPointSelect(sp, i, false);
          k++;
        }
      }
      done();
      return 'FINISHED';
    },
  }),
  ...([['de_select_first', '(De)select First', 0], ['de_select_last', '(De)select Last', -1]] as const).map(([id, label, which]): OperatorDef => editOp({
    id: `curve.${id}`, label, description: `(De)select ${which === 0 ? 'first' : 'last'} of visible part of each NURBS`, poll: isCurveEdit,
    exec: () => {
      for (const sp of cur().splines) { const n = pointCount(sp); if (!n) continue; const i = which === 0 ? 0 : n - 1; setPointSelect(sp, i, !isPointSelected(sp, i)); }
      done();
      return 'FINISHED';
    },
  })),
  ...([['select_next', 'Select Next', 1], ['select_previous', 'Select Previous', -1]] as const).map(([id, label, dir]): OperatorDef => editOp({
    id: `curve.${id}`, label, description: `Select control points following already selected ones along the curves`, poll: isCurveEdit,
    exec: () => {
      for (const sp of cur().splines) {
        const n = pointCount(sp);
        const sel = Array.from({ length: n }, (_, i) => isPointSelected(sp, i));
        for (let i = 0; i < n; i++) {
          if (!sel[i]) continue;
          let j = i + dir;
          if (sp.useCyclicU) j = (j + n) % n;
          if (j >= 0 && j < n) setPointSelect(sp, j, true);
        }
      }
      done();
      return 'FINISHED';
    },
  })),
  editOp({
    id: 'curve.select_row', label: 'Select Control Point Row', description: 'Select a row of control points including active one', poll: isSurfaceEdit,
    exec: () => {
      const cu = cur();
      const sp = cu.splines[cu.activeSpline] ?? cu.splines.find((s) => s.points.some((p) => p.select));
      if (!sp) return 'CANCELLED';
      const nu = sp.pointCountU, nv = sp.pointCountV;
      const act = cu.activePoint >= 0 ? cu.activePoint : sp.points.findIndex((p) => p.select);
      if (act < 0) return 'CANCELLED';
      const u = act % nu, v = Math.floor(act / nu);
      // repeated Shift+R switches between the U row and the V column (like Blender)
      const uRowSelected = Array.from({ length: nu }, (_, i) => sp.points[v * nu + i].select).every(Boolean) && sp.points.filter((p) => p.select).length === nu;
      const rowMode = uRowSelected && nv > 1 ? 'V' : 'U';
      for (const p of sp.points) p.select = false;
      if (rowMode === 'U') for (let i = 0; i < nu; i++) sp.points[v * nu + i].select = true;
      else for (let j = 0; j < nv; j++) sp.points[j * nu + u].select = true;
      done();
      return 'FINISHED';
    },
  }),
];

// ------------------------------------------------------------------ edit: topology

/** Extrude selected end points (curves) or boundary rows (surfaces). Returns false when nothing was extruded. */
function extrudeCurve(cu: CurveData, surface: boolean): boolean {
  let any = false;
  const newSplines: Spline[] = [];
  for (const sp of cu.splines) {
    if (surface && sp.pointCountV > 1) {
      if (extrudeSurfaceSpline(sp)) any = true;
      continue;
    }
    const n = pointCount(sp);
    if (!n || sp.useCyclicU) continue;
    const firstSel = isPointSelected(sp, 0), lastSel = isPointSelected(sp, n - 1);
    if (sp.type === 'BEZIER') {
      const pts = sp.bezierPoints;
      // middle points: Blender creates a new one-segment spline from each
      for (let i = 1; i < n - 1; i++) {
        if (!pts[i].select) continue;
        const a = cloneBez(pts[i]); const b = cloneBez(pts[i]);
        a.select = a.selectLeft = a.selectRight = false;
        newSplines.push(withPoints(sp, [a, b], []));
        pts[i].select = pts[i].selectLeft = pts[i].selectRight = false;
        any = true;
      }
      if (lastSel) { const c = cloneBez(pts[n - 1]); setBez(pts[n - 1], false); setBez(c, true); pts.push(c); any = true; }
      if (firstSel && (n > 1 || !lastSel)) { const c = cloneBez(pts[0]); setBez(pts[0], false); setBez(c, true); pts.unshift(c); any = true; }
    } else {
      const pts = sp.points;
      for (let i = 1; i < n - 1; i++) {
        if (!pts[i].select) continue;
        const a = clonePt(pts[i]); const b = clonePt(pts[i]);
        a.select = false;
        newSplines.push(withPoints(sp, [], [a, b]));
        pts[i].select = false;
        any = true;
      }
      if (lastSel) { const c = clonePt(pts[n - 1]); pts[n - 1].select = false; c.select = true; pts.push(c); any = true; }
      if (firstSel && (n > 1 || !lastSel)) { const c = clonePt(pts[0]); pts[0].select = false; c.select = true; pts.unshift(c); any = true; }
      sp.pointCountU = pts.length;
    }
    sp.pointCountU = pointCount(sp);
  }
  cu.splines.push(...newSplines);
  return any;
}

function setBez(b: BezierPoint, v: boolean): void { b.select = v; b.selectLeft = v; b.selectRight = v; }

/** Extrude a fully selected boundary row / column of a surface spline. */
function extrudeSurfaceSpline(sp: Spline): boolean {
  const nu = sp.pointCountU, nv = sp.pointCountV;
  const P = sp.points;
  const rowSel = (v: number) => Array.from({ length: nu }, (_, u) => P[v * nu + u].select).every(Boolean);
  const colSel = (u: number) => Array.from({ length: nv }, (_, v) => P[v * nu + u].select).every(Boolean);
  const anySel = P.some((p) => p.select);
  if (!anySel) return false;
  if (!sp.useCyclicV && (rowSel(nv - 1) || rowSel(0))) {
    const top = rowSel(nv - 1);
    const v = top ? nv - 1 : 0;
    const row = Array.from({ length: nu }, (_, u) => clonePt(P[v * nu + u]));
    for (const p of P) p.select = false;
    for (const p of row) p.select = true;
    sp.points = top ? [...P, ...row] : [...row, ...P];
    sp.pointCountV = nv + 1;
    return true;
  }
  if (!sp.useCyclicU && (colSel(nu - 1) || colSel(0))) {
    const right = colSel(nu - 1);
    const out: SplinePoint[] = [];
    for (let v = 0; v < nv; v++) {
      const row = P.slice(v * nu, v * nu + nu);
      const c = clonePt(row[right ? nu - 1 : 0]);
      for (const p of row) p.select = false;
      c.select = true;
      out.push(...(right ? [...row, c] : [c, ...row]));
    }
    sp.points = out;
    sp.pointCountU = nu + 1;
    return true;
  }
  return false;
}

/** Ctrl+click: add a point at the mouse (extending a selected end point) or start a new spline. */
export function addVertexAtMouse(view: View3D, x: number, y: number): boolean {
  const e = editCurve();
  if (!e || e.ob.type !== 'CURVE') return false;
  const cu = e.cu;
  const W = app.matrices.world(e.ob);
  const Winv = W.clone().invert();
  // a selected end point to extend
  let target: { sp: Spline; end: 'first' | 'last' } | null = null;
  for (const sp of cu.splines) {
    const n = pointCount(sp);
    if (!n || sp.useCyclicU || sp.hide) continue;
    if (isPointSelected(sp, n - 1)) { target = { sp, end: 'last' }; break; }
    if (isPointSelected(sp, 0)) { target = { sp, end: 'first' }; break; }
  }
  const refLocal: Vec3 = target
    ? (target.sp.type === 'BEZIER' ? target.sp.bezierPoints[target.end === 'last' ? pointCount(target.sp) - 1 : 0].co : target.sp.points[target.end === 'last' ? pointCount(target.sp) - 1 : 0].co)
    : (() => { const c = new Vector3(...app.scene.cursor).applyMatrix4(Winv); return [c.x, c.y, c.z] as Vec3; })();
  const refWorld = new Vector3(...refLocal).applyMatrix4(W);
  const hit = view.view.unprojectAtDepth(x, y, refWorld).applyMatrix4(Winv);
  let co: Vec3 = [hit.x, hit.y, hit.z];
  if (cu.dimensions === '2D') co = [co[0], co[1], 0];
  selectAllCurve(cu, 'DESELECT');
  if (!target) {
    const sp = newSpline('BEZIER', cu.resolutionU);
    sp.bezierPoints.push(newBezierPoint(co, [co[0] - 0.5, co[1], co[2]], [co[0] + 0.5, co[1], co[2]], 'AUTO', true));
    sp.pointCountU = 1;
    cu.splines.push(sp);
    cu.activeSpline = cu.splines.length - 1;
    cu.activePoint = 0;
  } else {
    const sp = target.sp;
    const n = pointCount(sp);
    const endIdx = target.end === 'last' ? n - 1 : 0;
    if (sp.type === 'BEZIER') {
      const src = sp.bezierPoints[endIdx];
      const c = cloneBez(src);
      const d: Vec3 = [co[0] - src.co[0], co[1] - src.co[1], co[2] - src.co[2]];
      const mv = (v: Vec3): Vec3 => [v[0] + d[0], v[1] + d[1], v[2] + d[2]];
      c.co = co; c.handleLeft = mv(src.handleLeft); c.handleRight = mv(src.handleRight);
      setBez(c, true);
      if (target.end === 'last') sp.bezierPoints.push(c); else sp.bezierPoints.unshift(c);
    } else {
      const c = clonePt(sp.points[endIdx]);
      c.co = co; c.select = true;
      if (target.end === 'last') sp.points.push(c); else sp.points.unshift(c);
    }
    sp.pointCountU = pointCount(sp);
    cu.activeSpline = cu.splines.indexOf(sp);
    cu.activePoint = target.end === 'last' ? n : 0;
  }
  recalcCurveHandles(cu);
  app.notify('geometry', 'select');
  return true;
}

function deleteVerts(cu: CurveData): void {
  const out: Spline[] = [];
  for (const sp of cu.splines) {
    if (sp.pointCountV > 1) {
      // surfaces: remove fully selected rows / columns
      const nu = sp.pointCountU, nv = sp.pointCountV;
      const rows = Array.from({ length: nv }, (_, v) => Array.from({ length: nu }, (_, u) => sp.points[v * nu + u].select).every(Boolean));
      const cols = Array.from({ length: nu }, (_, u) => Array.from({ length: nv }, (_, v) => sp.points[v * nu + u].select).every(Boolean));
      if (rows.every(Boolean)) continue;
      const keepRows = rows.filter((r) => !r).length, keepCols = cols.filter((c) => !c).length;
      if (rows.some(Boolean) && keepRows >= 1) {
        sp.points = sp.points.filter((_, i) => !rows[Math.floor(i / nu)]);
        sp.pointCountV = keepRows;
      } else if (cols.some(Boolean) && keepCols >= 1) {
        sp.points = sp.points.filter((_, i) => !cols[i % nu]);
        sp.pointCountU = keepCols;
      }
      if (sp.pointCountV === 1) sp.pointCountU = sp.points.length;
      out.push(sp);
      continue;
    }
    if (sp.type === 'BEZIER') sp.bezierPoints = sp.bezierPoints.filter((b) => !b.select);
    else sp.points = sp.points.filter((p) => !p.select);
    sp.pointCountU = pointCount(sp);
    if (pointCount(sp) > 0) out.push(sp);
  }
  cu.splines = out;
}

function deleteSegments(cu: CurveData): void {
  const out: Spline[] = [];
  for (const sp of cu.splines) {
    const n = pointCount(sp);
    if (sp.pointCountV > 1 || n < 2) { out.push(sp); continue; }
    const segs = sp.useCyclicU ? n : n - 1;
    const cut = Array.from({ length: segs }, (_, i) => isPointSelected(sp, i) && isPointSelected(sp, (i + 1) % n));
    if (!cut.some(Boolean)) { out.push(sp); continue; }
    // walk the points, starting after a cut segment for cyclic splines
    const start = sp.useCyclicU ? (cut.indexOf(true) + 1) % n : 0;
    const pieces: number[][] = [];
    let piece: number[] = [start];
    for (let k = 0; k < (sp.useCyclicU ? n - 1 : n - 1); k++) {
      const i = (start + k) % n;
      const j = (i + 1) % n;
      if (cut[i]) { pieces.push(piece); piece = [j]; } else piece.push(j);
    }
    pieces.push(piece);
    for (const pc of pieces) {
      if (pc.length < 2) continue;
      const s = withPoints(sp, sp.type === 'BEZIER' ? pc.map((i) => cloneBez(sp.bezierPoints[i])) : [], sp.type === 'BEZIER' ? [] : pc.map((i) => clonePt(sp.points[i])));
      s.useCyclicU = false;
      out.push(s);
    }
  }
  cu.splines = out;
}

function subdivide(cu: CurveData, cuts: number): void {
  for (const sp of cu.splines) {
    if (sp.pointCountV > 1) continue;
    const n = pointCount(sp);
    const segs = sp.useCyclicU ? n : n - 1;
    if (sp.type === 'BEZIER') {
      const src = sp.bezierPoints;
      const out: BezierPoint[] = [];
      for (let i = 0; i < n; i++) {
        out.push(src[i]);
        if (i >= segs) continue;
        const a = src[i], b = src[(i + 1) % n];
        if (!(isPointSelected(sp, i) && isPointSelected(sp, (i + 1) % n))) continue;
        // split the segment at evenly spaced parameters with de Casteljau (shape preserving)
        let p0 = a.co, p1 = a.handleRight, p2 = b.handleLeft;
        const p3 = b.co;
        const created: BezierPoint[] = [];
        for (let c = 0; c < cuts; c++) {
          const t = 1 / (cuts + 1 - c);
          const l = (u: Vec3, v: Vec3): Vec3 => [u[0] + (v[0] - u[0]) * t, u[1] + (v[1] - u[1]) * t, u[2] + (v[2] - u[2]) * t];
          const q0 = l(p0, p1), q1 = l(p1, p2), q2 = l(p2, p3);
          const r0 = l(q0, q1), r1 = l(q1, q2);
          const m = l(r0, r1);
          if (c === 0) { a.handleRight = q0; if (a.handleRightType === 'AUTO' || a.handleRightType === 'VECTOR') a.handleRightType = 'FREE'; if (a.handleLeftType === 'AUTO') a.handleLeftType = 'ALIGNED'; }
          else created[created.length - 1].handleRight = q0;
          const np = newBezierPoint(m, r0, r1, 'ALIGNED', true);
          np.tilt = a.tilt + (b.tilt - a.tilt) * ((c + 1) / (cuts + 1));
          np.radius = a.radius + (b.radius - a.radius) * ((c + 1) / (cuts + 1));
          created.push(np);
          p0 = m; p1 = r1; p2 = q2;
        }
        created[created.length - 1].handleRight = p1;
        b.handleLeft = p2;
        if (b.handleLeftType === 'AUTO' || b.handleLeftType === 'VECTOR') b.handleLeftType = 'FREE';
        if (b.handleRightType === 'AUTO') b.handleRightType = 'ALIGNED';
        out.push(...created);
      }
      sp.bezierPoints = out;
    } else {
      const src = sp.points;
      const out: SplinePoint[] = [];
      for (let i = 0; i < n; i++) {
        out.push(src[i]);
        if (i >= segs) continue;
        const a = src[i], b = src[(i + 1) % n];
        if (!(a.select && b.select)) continue;
        for (let c = 1; c <= cuts; c++) {
          const t = c / (cuts + 1);
          const p = newSplinePoint([a.co[0] + (b.co[0] - a.co[0]) * t, a.co[1] + (b.co[1] - a.co[1]) * t, a.co[2] + (b.co[2] - a.co[2]) * t], a.w + (b.w - a.w) * t, true);
          p.tilt = a.tilt + (b.tilt - a.tilt) * t; p.radius = a.radius + (b.radius - a.radius) * t;
          out.push(p);
        }
      }
      sp.points = out;
    }
    sp.pointCountU = pointCount(sp);
  }
}

function switchDirection(sp: Spline): void {
  if (sp.pointCountV > 1) {
    const nu = sp.pointCountU, nv = sp.pointCountV;
    const out: SplinePoint[] = [];
    for (let v = 0; v < nv; v++) out.push(...sp.points.slice(v * nu, v * nu + nu).reverse());
    sp.points = out;
    return;
  }
  if (sp.type === 'BEZIER') {
    sp.bezierPoints.reverse();
    for (const b of sp.bezierPoints) {
      [b.handleLeft, b.handleRight] = [b.handleRight, b.handleLeft];
      [b.handleLeftType, b.handleRightType] = [b.handleRightType, b.handleLeftType];
      [b.selectLeft, b.selectRight] = [b.selectRight, b.selectLeft];
      b.tilt = -b.tilt;
    }
  } else { sp.points.reverse(); for (const p of sp.points) p.tilt = -p.tilt; }
}

/** F: join the two selected end points (two splines) or close a spline. */
function makeSegment(cu: CurveData): string | null {
  const ends: { si: number; first: boolean }[] = [];
  cu.splines.forEach((sp, si) => {
    const n = pointCount(sp);
    if (!n || sp.useCyclicU || sp.pointCountV > 1) return;
    if (isPointSelected(sp, 0)) ends.push({ si, first: true });
    if (n > 1 && isPointSelected(sp, n - 1)) ends.push({ si, first: false });
  });
  if (ends.length !== 2) return 'Select exactly two end points';
  const [a, b] = ends;
  if (a.si === b.si) { cu.splines[a.si].useCyclicU = true; return null; }
  let sa = cu.splines[a.si], sb = cu.splines[b.si];
  if (sa.type !== sb.type) return 'Cannot join splines of different types';
  // orient: sa ends at its selected end, sb starts at its selected end
  if (a.first) switchDirection(sa);
  if (!b.first) switchDirection(sb);
  sa = cu.splines[a.si]; sb = cu.splines[b.si];
  if (sa.type === 'BEZIER') sa.bezierPoints.push(...sb.bezierPoints); else sa.points.push(...sb.points);
  sa.pointCountU = pointCount(sa);
  cu.splines.splice(b.si, 1);
  return null;
}

function duplicateSelected(cu: CurveData): void {
  const added: Spline[] = [];
  for (const sp of cu.splines) {
    if (sp.pointCountV > 1) {
      if (sp.points.every((p) => p.select)) { const c = cloneSpline(sp); added.push(c); for (const p of sp.points) p.select = false; }
      continue;
    }
    const runs = selectedRuns(sp);
    for (const run of runs) {
      const whole = run.length === pointCount(sp);
      const s = withPoints(sp, sp.type === 'BEZIER' ? run.map((i) => cloneBez(sp.bezierPoints[i])) : [], sp.type === 'BEZIER' ? [] : run.map((i) => clonePt(sp.points[i])));
      s.useCyclicU = whole && sp.useCyclicU;
      added.push(s);
    }
    if (runs.length) deselectSpline(sp);
  }
  cu.splines.push(...added);
}

function setHandleType(cu: CurveData, type: string): void {
  for (const sp of cu.splines) {
    if (sp.type !== 'BEZIER') continue;
    for (const b of sp.bezierPoints) {
      if (b.hide) continue;
      const left = b.select || b.selectLeft, right = b.select || b.selectRight;
      if (!left && !right) continue;
      const apply = (t: HandleType) => { if (left) b.handleLeftType = t; if (right) b.handleRightType = t; };
      switch (type) {
        case 'AUTOMATIC': apply('AUTO'); break;
        case 'VECTOR': apply('VECTOR'); break;
        case 'ALIGNED': apply('ALIGNED'); break;
        case 'FREE_ALIGN': apply('FREE'); break;
        case 'TOGGLE_FREE_ALIGN': {
          const isFree = (left ? b.handleLeftType === 'FREE' : true) && (right ? b.handleRightType === 'FREE' : true);
          apply(isFree ? 'ALIGNED' : 'FREE');
          break;
        }
      }
    }
  }
}

function hideCurve(cu: CurveData, unselected: boolean): void {
  for (const sp of cu.splines) {
    for (const b of sp.bezierPoints) { const s = b.select || b.selectLeft || b.selectRight; if (s !== unselected) { b.hide = true; setBez(b, false); } }
    for (const p of sp.points) if (p.select !== unselected) { p.hide = true; p.select = false; }
  }
}

function revealCurve(cu: CurveData): void {
  for (const sp of cu.splines) {
    for (const b of sp.bezierPoints) if (b.hide) { b.hide = false; setBez(b, true); }
    for (const p of sp.points) if (p.hide) { p.hide = false; p.select = true; }
    sp.hide = false;
  }
}

/** Convert selected splines to another type. */
function setSplineType(cu: CurveData, type: Spline['type']): void {
  for (const sp of cu.splines) {
    if (sp.type === type || sp.pointCountV > 1) continue;
    const n = pointCount(sp);
    if (!Array.from({ length: n }, (_, i) => isPointSelected(sp, i)).some(Boolean)) continue;
    if (sp.type === 'BEZIER') {
      const pts: SplinePoint[] = [];
      if (type === 'POLY') for (const b of sp.bezierPoints) { const p = newSplinePoint(b.co, 1, b.select); p.tilt = b.tilt; p.radius = b.radius; pts.push(p); }
      else {
        sp.bezierPoints.forEach((b, i) => {
          if (sp.useCyclicU || i > 0) pts.push(newSplinePoint(b.handleLeft, 1, b.select));
          const p = newSplinePoint(b.co, 1, b.select); p.tilt = b.tilt; p.radius = b.radius; pts.push(p);
          if (sp.useCyclicU || i < n - 1) pts.push(newSplinePoint(b.handleRight, 1, b.select));
        });
        sp.orderU = 4; sp.useBezierU = true; sp.useEndpointU = false;
      }
      sp.points = pts;
      sp.bezierPoints = [];
    } else if (type === 'BEZIER') {
      sp.bezierPoints = sp.points.map((p) => {
        const b = newBezierPoint(p.co, p.co, p.co, sp.type === 'POLY' ? 'VECTOR' : 'AUTO', p.select);
        b.tilt = p.tilt; b.radius = p.radius;
        return b;
      });
      sp.points = [];
    }
    sp.type = type;
    sp.pointCountU = pointCount(sp);
    sp.pointCountV = 1;
    if (type === 'BEZIER') calcHandles(sp);
  }
}

function smoothPositions(cu: CurveData): void {
  for (const sp of cu.splines) {
    if (sp.pointCountV > 1) continue;
    const n = pointCount(sp);
    const co = (i: number) => (sp.type === 'BEZIER' ? sp.bezierPoints[i].co : sp.points[i].co);
    const next: (Vec3 | null)[] = [];
    for (let i = 0; i < n; i++) {
      if (!isPointSelected(sp, i)) { next.push(null); continue; }
      const nb = neighbours(sp, i);
      if (nb.length < 2) { next.push(null); continue; }
      const a = co(nb[0]), b = co(nb[1]), c = co(i);
      next.push([(a[0] + b[0]) / 4 + c[0] / 2, (a[1] + b[1]) / 4 + c[1] / 2, (a[2] + b[2]) / 4 + c[2] / 2]);
    }
    next.forEach((p, i) => {
      if (!p) return;
      if (sp.type === 'BEZIER') {
        const b = sp.bezierPoints[i];
        const d: Vec3 = [p[0] - b.co[0], p[1] - b.co[1], p[2] - b.co[2]];
        b.co = p; b.handleLeft = [b.handleLeft[0] + d[0], b.handleLeft[1] + d[1], b.handleLeft[2] + d[2]]; b.handleRight = [b.handleRight[0] + d[0], b.handleRight[1] + d[1], b.handleRight[2] + d[2]];
      } else sp.points[i].co = p;
    });
  }
}

function smoothAttr(cu: CurveData, key: 'radius' | 'tilt' | 'weightSoftbody'): void {
  for (const sp of cu.splines) {
    if (sp.pointCountV > 1) continue;
    const n = pointCount(sp);
    const get = (i: number) => (sp.type === 'BEZIER' ? sp.bezierPoints[i][key] : sp.points[i][key]);
    const vals: (number | null)[] = [];
    for (let i = 0; i < n; i++) {
      const nb = neighbours(sp, i);
      vals.push(isPointSelected(sp, i) && nb.length ? (get(i) * 2 + nb.reduce((s, j) => s + get(j), 0) * (2 / nb.length)) / 4 : null);
    }
    vals.forEach((v, i) => { if (v === null) return; if (sp.type === 'BEZIER') sp.bezierPoints[i][key] = v; else sp.points[i][key] = v; });
  }
}

function forSelectedPoints(cu: CurveData, fn: (p: BezierPoint | SplinePoint) => void): void {
  for (const sp of cu.splines) for (let i = 0; i < pointCount(sp); i++) if (isPointSelected(sp, i)) fn(sp.type === 'BEZIER' ? sp.bezierPoints[i] : sp.points[i]);
}

// ------------------------------------------------------------------ radius / tilt modal (Alt+S, Ctrl+T)

/** Modal value edit for selected points: Alt+S scales radius, Ctrl+T rotates tilt. */
export function startPointValueModal(ctx: OpContext, kind: 'radius' | 'tilt', opId: string): 'RUNNING_MODAL' | 'CANCELLED' {
  const view = viewOf(ctx);
  const e = editCurve();
  if (!view || !e || !anyCurveSelected(e.cu)) return 'CANCELLED';
  const cu = e.cu;
  const items: { p: BezierPoint | SplinePoint; start: number }[] = [];
  forSelectedPoints(cu, (p) => items.push({ p, start: p[kind] }));
  const W = app.matrices.world(e.ob);
  const center = new Vector3();
  forSelectedPoints(cu, (p) => center.add(new Vector3(...p.co).applyMatrix4(W)));
  center.multiplyScalar(1 / Math.max(1, items.length));
  const r = view.canvasRect();
  const pc = view.view.project(center);
  const m0 = { x: app.mouse.x - r.left, y: app.mouse.y - r.top };
  const d0 = Math.max(1, Math.hypot(m0.x - pc.x, m0.y - pc.y));
  const a0 = Math.atan2(m0.y - pc.y, m0.x - pc.x);
  let value = kind === 'radius' ? 1 : 0;
  let typed = '';
  let accum = 0, lastA = a0;
  const apply = () => {
    const v = typed ? Number(typed) || 0 : value;
    for (const it of items) it.p[kind] = kind === 'radius' ? Math.max(0, it.start * v) : it.start + (v * Math.PI) / 180;
    app.notify('geometry');
    view.requestRender();
  };
  const finish = (ok: boolean) => {
    app.endModal(h);
    view.transformState = null;
    if (!ok) { for (const it of items) it.p[kind] = it.start; app.notify('geometry'); return; }
    const def = app.operator(opId)!;
    app.finishOperator(def, { value: typed ? Number(typed) || 0 : value }, ctx);
  };
  const h = {
    cursor: 'default',
    status: () => (kind === 'radius' ? `Shrink/Fatten: ${typed ? `[${typed}|]` : value.toFixed(3)}` : `Tilt: ${typed ? `[${typed}|]` : value.toFixed(2)}°`),
    cancel: () => finish(false),
    onEvent: (ev: Event): boolean => {
      if (ev.type === 'pointermove') {
        const pe = ev as PointerEvent;
        const m = { x: pe.clientX - r.left, y: pe.clientY - r.top };
        if (kind === 'radius') {
          value = Math.hypot(m.x - pc.x, m.y - pc.y) / d0;
          if (pe.ctrlKey) value = Math.round(value * 10) / 10;
        } else {
          const a = Math.atan2(m.y - pc.y, m.x - pc.x);
          let d = a - lastA;
          if (d > Math.PI) d -= 2 * Math.PI;
          if (d < -Math.PI) d += 2 * Math.PI;
          accum += d; lastA = a;
          value = (-accum * 180) / Math.PI;
          if (pe.ctrlKey) value = Math.round(value / 5) * 5;
        }
        apply();
        return true;
      }
      if (ev.type === 'pointerdown') { finish((ev as PointerEvent).button === 0); return true; }
      if (ev.type === 'keydown') {
        const k = (ev as KeyboardEvent).key;
        if (k === 'Escape') finish(false);
        else if (k === 'Enter' || k === ' ') finish(true);
        else if (/^[0-9.\-]$/.test(k)) { typed += k; apply(); }
        else if (k === 'Backspace') { typed = typed.slice(0, -1); apply(); }
        return true;
      }
      return ev.type === 'pointerup' || ev.type === 'wheel' || ev.type === 'contextmenu';
    },
  };
  view.transformState = { center: () => center, constraint: () => null, orient: () => new Matrix3(), mode: () => (kind === 'radius' ? 'RESIZE' : 'ROTATION'), propSize: () => 0 };
  app.startModal(h);
  return 'RUNNING_MODAL';
}

// ------------------------------------------------------------------ edit operators

const TOPO_OPS: OperatorDef[] = [
  editOp({
    id: 'curve.extrude_move', label: 'Extrude Curve and Move', description: 'Extrude curve and move result', undo: false, register: false, poll: () => isCurveOrSurfEdit() && hasSel(),
    exec: (ctx) => {
      const ec = editCurve()!;
      if (!extrudeCurve(ec.cu, ec.ob.type === 'SURFACE')) { app.report('WARNING', 'Nothing to extrude: select end points (or a boundary row of a surface)'); return 'CANCELLED'; }
      done();
      app.report('OPERATOR', 'bpy.ops.curve.extrude_move(CURVE_OT_extrude={"mode":\'TRANSLATION\'}, TRANSFORM_OT_translate={"value":(0, 0, 0)})');
      grabAfter(ctx);
      return 'FINISHED';
    },
  }),
  editOp({
    id: 'curve.vertex_add', label: 'Add Vertex', description: 'Add a new control point (linked to only selected end-curve one, if any)', poll: isCurveEdit,
    props: { location: { name: 'Location', type: 'vector', default: [0, 0, 0], size: 3, subtype: 'TRANSLATION' } },
    invoke: (ctx) => {
      const view = viewOf(ctx);
      if (!view) return 'CANCELLED';
      const r = view.canvasRect();
      return addVertexAtMouse(view, app.mouse.x - r.left, app.mouse.y - r.top) ? 'FINISHED' : 'CANCELLED';
    },
    exec: () => 'CANCELLED',
  }),
  editOp({
    id: 'curve.make_segment', label: 'Make Segment', description: 'Join two curves by their selected ends', poll: () => isCurveOrSurfEdit() && hasSel(),
    exec: () => { const err = makeSegment(cur()); if (err) { app.report('ERROR', err); return 'CANCELLED'; } done(); return 'FINISHED'; },
  }),
  editOp({
    id: 'curve.subdivide', label: 'Subdivide', description: 'Subdivide selected segments', poll: () => isCurveOrSurfEdit() && hasSel(),
    props: { number_cuts: { name: 'Number of cuts', type: 'int', default: 1, min: 1, max: 1000, softMax: 50 } },
    exec: (_c, p) => { subdivide(cur(), Math.max(1, Number(p.number_cuts))); done(); return 'FINISHED'; },
  }),
  editOp({
    id: 'curve.switch_direction', label: 'Switch Direction', description: 'Switch direction of selected splines', poll: () => isCurveOrSurfEdit() && hasSel(),
    exec: () => {
      for (const sp of cur().splines) if (Array.from({ length: pointCount(sp) }, (_, i) => isPointSelected(sp, i)).some(Boolean)) switchDirection(sp);
      done();
      return 'FINISHED';
    },
  }),
  editOp({
    id: 'curve.delete', label: 'Delete', description: 'Delete selected control points or segments', poll: () => isCurveOrSurfEdit() && hasSel(),
    props: { type: { name: 'Type', type: 'enum', default: 'VERT', items: [['VERT', 'Vertices'], ['SEGMENT', 'Segments']] } },
    invoke: (ctx, p) => { void ctx; void p; showDeleteMenu(); return 'CANCELLED'; },
    exec: (_c, p) => {
      const cu = cur();
      if (p.type === 'SEGMENT') deleteSegments(cu); else deleteVerts(cu);
      cu.activePoint = -1;
      cu.activeSpline = Math.min(cu.activeSpline, Math.max(0, cu.splines.length - 1));
      done();
      return 'FINISHED';
    },
  }),
  editOp({
    id: 'curve.dissolve_verts', label: 'Dissolve Vertices', description: 'Delete selected control points, correcting surrounding handles', poll: () => isCurveEdit() && hasSel(),
    exec: () => { deleteVerts(cur()); done(); return 'FINISHED'; },
  }),
  editOp({
    id: 'curve.cyclic_toggle', label: 'Toggle Cyclic', description: 'Make active spline closed/opened loop', poll: () => isCurveOrSurfEdit() && hasSel(),
    props: { direction: { name: 'Direction', type: 'enum', default: 'CYCLIC_U', items: [['CYCLIC_U', 'Cyclic U'], ['CYCLIC_V', 'Cyclic V']] } },
    exec: (_c, p) => {
      for (const sp of cur().splines) {
        if (!Array.from({ length: pointCount(sp) }, (_, i) => isPointSelected(sp, i)).some(Boolean)) continue;
        if (p.direction === 'CYCLIC_V' && sp.pointCountV > 1) sp.useCyclicV = !sp.useCyclicV;
        else sp.useCyclicU = !sp.useCyclicU;
      }
      done();
      return 'FINISHED';
    },
  }),
  editOp({
    id: 'curve.handle_type_set', label: 'Set Handle Type', description: 'Set type of handles for selected control points', poll: () => isCurveEdit() && hasSel(),
    props: { type: { name: 'Type', type: 'enum', default: 'AUTOMATIC', items: [['AUTOMATIC', 'Automatic'], ['VECTOR', 'Vector'], ['ALIGNED', 'Aligned'], ['FREE_ALIGN', 'Free'], ['TOGGLE_FREE_ALIGN', 'Toggle Free/Align']] } },
    exec: (_c, p) => { setHandleType(cur(), String(p.type)); done(); return 'FINISHED'; },
  }),
  editOp({
    id: 'curve.normals_make_consistent', label: 'Recalc Normals', description: 'Recalculate the direction of selected handles', poll: () => isCurveEdit() && hasSel(),
    props: { calc_length: { name: 'Length', type: 'bool', default: false, description: 'Recalculate handle length' } },
    exec: () => {
      for (const sp of cur().splines) {
        if (sp.type !== 'BEZIER') continue;
        const saved = sp.bezierPoints.map((b) => [b.handleLeftType, b.handleRightType] as const);
        sp.bezierPoints.forEach((b) => { if (b.select || b.selectLeft || b.selectRight) { b.handleLeftType = b.handleLeftType === 'VECTOR' ? 'VECTOR' : 'AUTO'; b.handleRightType = b.handleRightType === 'VECTOR' ? 'VECTOR' : 'AUTO'; } });
        calcHandles(sp);
        sp.bezierPoints.forEach((b, i) => { b.handleLeftType = saved[i][0]; b.handleRightType = saved[i][1]; });
      }
      done();
      return 'FINISHED';
    },
  }),
  editOp({
    id: 'curve.hide', label: 'Hide Selected', description: 'Hide (un)selected control points',
    props: { unselected: { name: 'Unselected', type: 'bool', default: false, description: 'Hide unselected rather than selected' } },
    exec: (_c, p) => { hideCurve(cur(), !!p.unselected); done(); return 'FINISHED'; },
  }),
  editOp({ id: 'curve.reveal', label: 'Reveal Hidden', description: 'Show again hidden control points', exec: () => { revealCurve(cur()); done(); return 'FINISHED'; } }),
  editOp({
    id: 'curve.duplicate_move', label: 'Duplicate Curve and Move', description: 'Duplicate curve and move', undo: false, register: false, poll: () => isCurveOrSurfEdit() && hasSel(),
    exec: (ctx) => {
      duplicateSelected(cur());
      done();
      app.report('OPERATOR', 'bpy.ops.curve.duplicate_move(CURVE_OT_duplicate={}, TRANSFORM_OT_translate={"value":(0, 0, 0)})');
      grabAfter(ctx);
      return 'FINISHED';
    },
  }),
  editOp({
    id: 'curve.split', label: 'Split', description: 'Split off selected points from connected unselected ones', poll: () => isCurveEdit() && hasSel(),
    exec: () => { splitCurve(cur()); done(); return 'FINISHED'; },
  }),
  editOp({
    id: 'curve.spline_type_set', label: 'Set Spline Type', description: 'Set type of active spline', poll: () => isCurveEdit() && hasSel(),
    props: { type: { name: 'Type', type: 'enum', default: 'POLY', items: [['POLY', 'Poly'], ['BEZIER', 'Bezier'], ['NURBS', 'NURBS']] }, use_handles: { name: 'Handles', type: 'bool', default: false } },
    exec: (_c, p) => { setSplineType(cur(), p.type as Spline['type']); done(); return 'FINISHED'; },
  }),
  editOp({ id: 'curve.smooth', label: 'Smooth', description: 'Flatten angles of selected points', poll: () => isCurveEdit() && hasSel(), exec: () => { smoothPositions(cur()); done(); return 'FINISHED'; } }),
  editOp({ id: 'curve.smooth_radius', label: 'Smooth Curve Radius', description: 'Interpolate radii of selected points', poll: () => isCurveEdit() && hasSel(), exec: () => { smoothAttr(cur(), 'radius'); done(); return 'FINISHED'; } }),
  editOp({ id: 'curve.smooth_tilt', label: 'Smooth Curve Tilt', description: 'Interpolate tilt of selected points', poll: () => isCurveEdit() && hasSel(), exec: () => { smoothAttr(cur(), 'tilt'); done(); return 'FINISHED'; } }),
  editOp({ id: 'curve.smooth_weight', label: 'Smooth Curve Weight', description: 'Interpolate weight of selected points', poll: () => isCurveEdit() && hasSel(), exec: () => { smoothAttr(cur(), 'weightSoftbody'); done(); return 'FINISHED'; } }),
  editOp({
    id: 'curve.radius_set', label: 'Set Curve Radius', description: 'Set per-point radius which is used for bevel tapering', poll: () => isCurveEdit() && hasSel(),
    props: { radius: { name: 'Radius', type: 'float', default: 1, min: 0 } },
    exec: (_c, p) => { forSelectedPoints(cur(), (pt) => { pt.radius = Number(p.radius); }); done(); return 'FINISHED'; },
  }),
  editOp({
    id: 'curve.spline_weight_set', label: 'Set Goal Weight', description: 'Set softbody goal weight for selected points', poll: () => isCurveOrSurfEdit() && hasSel(),
    props: { weight: { name: 'Weight', type: 'float', default: 1, min: 0, max: 1, subtype: 'FACTOR' } },
    exec: (_c, p) => { forSelectedPoints(cur(), (pt) => { pt.weightSoftbody = Number(p.weight); }); done(); return 'FINISHED'; },
  }),
  editOp({
    id: 'curve.tilt_clear', label: 'Clear Tilt', description: 'Clear the tilt of selected control points', poll: () => isCurveEdit() && hasSel(),
    exec: () => { forSelectedPoints(cur(), (pt) => { pt.tilt = 0; }); done(); return 'FINISHED'; },
  }),
  editOp({
    id: 'transform.tilt', label: 'Tilt', description: 'Tilt selected control vertices of 3D curve', poll: () => isCurveEdit() && hasSel(),
    props: { value: { name: 'Angle', type: 'float', default: 0 } },
    invoke: (ctx) => startPointValueModal(ctx, 'tilt', 'transform.tilt'),
    exec: (_c, p) => { forSelectedPoints(cur(), (pt) => { pt.tilt += (Number(p.value) * Math.PI) / 180; }); done(); return 'FINISHED'; },
  }),
  editOp({
    id: 'curve.shrink_fatten', label: 'Shrink/Fatten Curve Radius', description: 'Scale the radius of selected control points (transform.transform mode CURVE_SHRINKFATTEN)', poll: () => isCurveEdit() && hasSel(),
    props: { value: { name: 'Factor', type: 'float', default: 1, min: 0 } },
    invoke: (ctx) => startPointValueModal(ctx, 'radius', 'curve.shrink_fatten'),
    exec: (_c, p) => { forSelectedPoints(cur(), (pt) => { pt.radius *= Number(p.value); }); done(); return 'FINISHED'; },
  }),
];

/** Split: the selected points become separate splines (the old ones lose them). */
function splitCurve(cu: CurveData): void {
  const sel = cu.splines.map((sp) => Array.from({ length: pointCount(sp) }, (_, i) => isPointSelected(sp, i)));
  duplicateSelected(cu);
  // remove the originally selected points from the old splines (those are the first sel.length splines)
  const old = cu.splines.slice(0, sel.length);
  const fresh = cu.splines.slice(sel.length);
  old.forEach((sp, si) => sel[si].forEach((s, i) => setPointSelect(sp, i, s)));
  cu.splines = old;
  deleteVerts(cu);
  cu.splines.push(...fresh);
}

function showDeleteMenu(): void {
  showMenu(isSurfaceEdit() ? [op('Vertices', 'curve.delete', { type: 'VERT' })] : curveDeleteMenu(), app.mouse, { title: 'Delete', atMouse: true });
}

// ------------------------------------------------------------------ menus

export function curveDeleteMenu(): MenuItem[] {
  return [
    op('Vertices', 'curve.delete', { type: 'VERT' }),
    op('Segments', 'curve.delete', { type: 'SEGMENT' }),
    sep,
    op('Dissolve Vertices', 'curve.dissolve_verts'),
  ];
}

export function handleTypeMenu(): MenuItem[] {
  return [
    op('Automatic', 'curve.handle_type_set', { type: 'AUTOMATIC' }, 'HANDLETYPE_AUTO_VEC'),
    op('Vector', 'curve.handle_type_set', { type: 'VECTOR' }, 'HANDLETYPE_VECTOR_VEC'),
    op('Aligned', 'curve.handle_type_set', { type: 'ALIGNED' }, 'HANDLETYPE_ALIGNED_VEC'),
    op('Free', 'curve.handle_type_set', { type: 'FREE_ALIGN' }, 'HANDLETYPE_FREE_VEC'),
    sep,
    op('Toggle Free/Align', 'curve.handle_type_set', { type: 'TOGGLE_FREE_ALIGN' }),
  ];
}

export function curveSpecialsMenu(): MenuItem[] {
  return [
    op('Subdivide', 'curve.subdivide'),
    op('Switch Direction', 'curve.switch_direction'),
    op('Set Goal Weight', 'curve.spline_weight_set'),
    op('Set Radius', 'curve.radius_set'),
    sep,
    op('Smooth', 'curve.smooth'),
    op('Smooth Curve Weight', 'curve.smooth_weight'),
    op('Smooth Curve Radius', 'curve.smooth_radius'),
    op('Smooth Curve Tilt', 'curve.smooth_tilt'),
  ];
}

function surfaceSpecialsMenu(): MenuItem[] {
  return [op('Subdivide', 'curve.subdivide'), op('Switch Direction', 'curve.switch_direction'), op('Set Goal Weight', 'curve.spline_weight_set')];
}

function transformMenu(): MenuItem[] {
  return [
    op('Grab/Move', 'transform.translate'),
    op('Rotate', 'transform.rotate'),
    op('Scale', 'transform.resize'),
    sep,
    op('To Sphere', 'transform.tosphere'),
    op('Tilt', 'transform.tilt'),
    op('Shrink/Fatten Radius', 'curve.shrink_fatten'),
  ];
}

function mirrorMenu(): MenuItem[] {
  return [
    op('X Global', 'transform.mirror', { constraint_axis: [true, false, false] }),
    op('Y Global', 'transform.mirror', { constraint_axis: [false, true, false] }),
    op('Z Global', 'transform.mirror', { constraint_axis: [false, false, true] }),
  ];
}

function snapMenu(): MenuItem[] {
  return [
    op('Selection to Grid', 'view3d.snap_selected_to_grid'),
    op('Selection to Cursor', 'view3d.snap_selected_to_cursor', { use_offset: false }),
    sep,
    op('Cursor to Selected', 'view3d.snap_cursor_to_selected'),
    op('Cursor to Center', 'view3d.snap_cursor_to_center'),
    op('Cursor to Grid', 'view3d.snap_cursor_to_grid'),
  ];
}

function proportionalMenu(): MenuItem[] {
  const ts = app.scene.toolSettings;
  return (['DISABLED', 'ENABLED', 'CONNECTED'] as const).map((v) => ({ label: v === 'DISABLED' ? 'Disable' : v === 'ENABLED' ? 'Enable' : 'Connected', checked: ts.proportionalEdit === v, action: () => { ts.proportionalEdit = v; app.notify('view'); } }));
}

function showHideMenu(): MenuItem[] {
  return [op('Show Hidden', 'curve.reveal'), op('Hide Selected', 'curve.hide', { unselected: false }), op('Hide Unselected', 'curve.hide', { unselected: true })];
}

function curveMenu(): MenuItem[] {
  return [
    op('Undo History', 'ed.undo_history'), op('Redo', 'ed.redo'), op('Undo', 'ed.undo'),
    sep,
    sub('Transform', transformMenu), sub('Mirror', mirrorMenu), sub('Snap', snapMenu),
    sep,
    op('Extrude and Move', 'curve.extrude_move'),
    op('Duplicate', 'curve.duplicate_move'),
    op('Split', 'curve.split'),
    op('Separate', 'curve.separate'),
    op('Make Segment', 'curve.make_segment'),
    op('Toggle Cyclic', 'curve.cyclic_toggle'),
    sub('Delete', curveDeleteMenu),
    sep,
    sub('Control Points', [
      op('Tilt', 'transform.tilt'),
      op('Clear Tilt', 'curve.tilt_clear'),
      op('Shrink/Fatten Radius', 'curve.shrink_fatten'),
      sep,
      sub('Set Handle Type', handleTypeMenu),
      op('Recalc Normals', 'curve.normals_make_consistent'),
      sep,
      sub('Set Spline Type', [op('Poly', 'curve.spline_type_set', { type: 'POLY' }), op('Bezier', 'curve.spline_type_set', { type: 'BEZIER' }), op('NURBS', 'curve.spline_type_set', { type: 'NURBS' })]),
    ]),
    sub('Segments', [op('Subdivide', 'curve.subdivide'), op('Switch Direction', 'curve.switch_direction')]),
    sep,
    sub('Proportional Editing', proportionalMenu),
    sep,
    sub('Show/Hide', showHideMenu),
  ];
}

function surfaceMenu(): MenuItem[] {
  return [
    op('Undo History', 'ed.undo_history'), op('Redo', 'ed.redo'), op('Undo', 'ed.undo'),
    sep,
    sub('Transform', [op('Grab/Move', 'transform.translate'), op('Rotate', 'transform.rotate'), op('Scale', 'transform.resize')]),
    sub('Mirror', mirrorMenu), sub('Snap', snapMenu),
    sep,
    op('Extrude and Move', 'curve.extrude_move'),
    op('Duplicate', 'curve.duplicate_move'),
    op('Separate', 'curve.separate'),
    sub('Toggle Cyclic', [op('Cyclic U', 'curve.cyclic_toggle', { direction: 'CYCLIC_U' }), op('Cyclic V', 'curve.cyclic_toggle', { direction: 'CYCLIC_V' })]),
    sub('Delete', [op('Vertices', 'curve.delete', { type: 'VERT' })]),
    sep,
    sub('Segments', [op('Subdivide', 'curve.subdivide'), op('Switch Direction', 'curve.switch_direction')]),
    sep,
    sub('Proportional Editing', proportionalMenu),
    sep,
    sub('Show/Hide', showHideMenu),
  ];
}

function curveSelectMenu(): MenuItem[] {
  const surf = isSurfaceEdit();
  return [
    op('Border Select', 'view3d.select_border'),
    op('Circle Select', 'view3d.select_circle'),
    sep,
    op('(De)select All', 'curve.select_all', { action: 'TOGGLE' }),
    op('Inverse', 'curve.select_all', { action: 'INVERT' }),
    op('Random', 'curve.select_random'),
    op('Checker Deselect', 'curve.select_nth'),
    sep,
    op('Select Linked', 'curve.select_linked'),
    sep,
    ...(surf ? [op('Control Point Row', 'curve.select_row')] : [
      op('(De)select First', 'curve.de_select_first'),
      op('(De)select Last', 'curve.de_select_last'),
      op('Select Next', 'curve.select_next'),
      op('Select Previous', 'curve.select_previous'),
    ]),
    sep,
    op('Select More', 'curve.select_more'),
    op('Select Less', 'curve.select_less'),
  ];
}

curveMenus.curve = curveMenu;
curveMenus.surface = surfaceMenu;
curveMenus.select = curveSelectMenu;
curveMenus.add = curveAddItems;
curveMenus.addSurface = surfaceAddItems;

// ------------------------------------------------------------------ keymap

export function registerCurveKeymap(): void {
  const S = { shift: true }, C = { ctrl: true }, A = { alt: true };
  const K = (code: string, opId: string, props: Record<string, unknown> = {}, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}, poll = isCurveOrSurfEdit): KeyItem => ({ code, space: 'VIEW_3D', op: opId, props, mode: 'EDIT', poll, ...mods });
  const M = (code: string, title: string, menu: () => MenuItem[], mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}, poll = isCurveOrSurfEdit): KeyItem => ({ code, space: 'VIEW_3D', title, menu, mode: 'EDIT', poll, ...mods });
  registerKeymap([
    K('KeyA', 'curve.select_all', { action: 'TOGGLE' }),
    K('KeyI', 'curve.select_all', { action: 'INVERT' }, C),
    K('KeyL', 'curve.select_linked', {}, C),
    K('KeyL', 'curve.select_linked_pick', { deselect: false }),
    K('KeyL', 'curve.select_linked_pick', { deselect: true }, S),
    K('NumpadAdd', 'curve.select_more', {}, C),
    K('NumpadSubtract', 'curve.select_less', {}, C),
    K('KeyR', 'curve.select_row', {}, S, isSurfaceEdit),
    M('KeyA', 'Add', () => (isSurfaceEdit() ? surfaceAddItems() : curveAddItems()), S),
    K('KeyE', 'curve.extrude_move'),
    K('KeyF', 'curve.make_segment'),
    M('KeyX', 'Delete', () => (isSurfaceEdit() ? [op('Vertices', 'curve.delete', { type: 'VERT' })] : curveDeleteMenu())),
    M('Delete', 'Delete', () => (isSurfaceEdit() ? [op('Vertices', 'curve.delete', { type: 'VERT' })] : curveDeleteMenu())),
    K('KeyX', 'curve.dissolve_verts', {}, C, isCurveEdit),
    M('KeyW', 'Specials', () => (isSurfaceEdit() ? surfaceSpecialsMenu() : curveSpecialsMenu())),
    K('KeyC', 'curve.cyclic_toggle', { direction: 'CYCLIC_U' }, A, isCurveEdit),
    M('KeyC', 'Toggle Cyclic', () => [op('Cyclic U', 'curve.cyclic_toggle', { direction: 'CYCLIC_U' }), op('Cyclic V', 'curve.cyclic_toggle', { direction: 'CYCLIC_V' })], A, isSurfaceEdit),
    M('KeyV', 'Set Handle Type', handleTypeMenu, {}, isCurveEdit),
    K('KeyN', 'curve.normals_make_consistent', {}, S, isCurveEdit),
    K('KeyH', 'curve.hide', { unselected: false }),
    K('KeyH', 'curve.hide', { unselected: true }, S),
    K('KeyH', 'curve.reveal', {}, A),
    K('KeyD', 'curve.duplicate_move', {}, S),
    K('KeyP', 'curve.separate'),
    K('KeyY', 'curve.split', {}, {}, isCurveEdit),
    K('KeyT', 'transform.tilt', {}, C, isCurveEdit),
    K('KeyT', 'curve.tilt_clear', {}, A, isCurveEdit),
    K('KeyS', 'curve.shrink_fatten', {}, A, isCurveEdit),
  ]);
}

export const CURVE_EDIT_OPERATORS: OperatorDef[] = [...SELECT_OPS, ...TOPO_OPS];

// re-exports used by other curve modules
export { cloneBez, clonePt, cloneSpline, selectedRuns, withPoints, deleteVerts, setBez };
export type { OpContext };
