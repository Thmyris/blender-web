// Edit mode of curves and NURBS surfaces: control points, Bezier handles and the NURBS control
// polygon drawn in the 2.79 theme colours; click / border selection; G/R/S of points with their
// handles following; and helpers shared by the curve operators (src/ops/curve.ts).

import { Group, Matrix4, Vector3 } from 'three';
import { app } from '../../app';
import type { BObject, Vec3 } from '../../core/types';
import type { BezierPoint, CurveData, HandleType, Spline, SplinePoint } from '../../core/curvetypes';
import { curveDataOf } from '../../core/curveobj';
import { calcHandles, computeFrames, sampleSpline, splineResolution, surfaceGridEdges } from '../../core/curve';
import type { MenuItem } from '../../ui/menu';
import {
  registerEditType, segmentDistance, type EditTypeHandler, type RegionMode, type SelectAction, type TransformPoint,
} from './edittypes';
import { editLines, editPoints } from './editdraw';
import type { View3D } from './view3d';

// ------------------------------------------------------------------ theme colours (2.79 default)

const hex = (h: number): Vec3 => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];
const HANDLE: Record<HandleType, [Vec3, Vec3]> = {
  FREE: [hex(0x000000), hex(0x000000)],
  AUTO: [hex(0x909000), hex(0xf0ff40)],
  VECTOR: [hex(0x409030), hex(0x40c030)],
  ALIGNED: [hex(0x803060), hex(0xf090a0)],
};
const NURB_ULINE = hex(0x909000), NURB_SEL_ULINE = hex(0xf0ff40);
const NURB_VLINE = hex(0x803060), NURB_SEL_VLINE = hex(0xf090a0);
const VERT = hex(0x000000), VERT_SEL = hex(0xff8500), ACTIVE_PT = hex(0xffffff);
const WIRE_EDIT = hex(0x000000);
const NORMAL_COL = hex(0x22dddd);

// ------------------------------------------------------------------ element access

export interface CurveElem { si: number; pi: number; /** 0 left handle, 1 point, 2 right handle */ k: 0 | 1 | 2 }

export function editCurve(): { ob: BObject; cu: CurveData } | null {
  const ob = app.editObj;
  if (!ob || (ob.type !== 'CURVE' && ob.type !== 'SURFACE')) return null;
  const cu = curveDataOf(app.doc, ob);
  return cu ? { ob, cu } : null;
}

export function isPointSelected(sp: Spline, i: number): boolean {
  if (sp.type === 'BEZIER') { const b = sp.bezierPoints[i]; return !!b && (b.select || b.selectLeft || b.selectRight); }
  return !!sp.points[i]?.select;
}

export function pointHidden(sp: Spline, i: number): boolean {
  return sp.type === 'BEZIER' ? !!sp.bezierPoints[i]?.hide : !!sp.points[i]?.hide;
}

export function setPointSelect(sp: Spline, i: number, v: boolean): void {
  if (sp.type === 'BEZIER') { const b = sp.bezierPoints[i]; if (b) { b.select = v; b.selectLeft = v; b.selectRight = v; } }
  else if (sp.points[i]) sp.points[i].select = v;
}

export function pointCount(sp: Spline): number { return sp.type === 'BEZIER' ? sp.bezierPoints.length : sp.points.length; }

/** Position of an element (object space). */
export function elemCo(sp: Spline, e: CurveElem): Vec3 {
  if (sp.type === 'BEZIER') { const b = sp.bezierPoints[e.pi]; return e.k === 0 ? b.handleLeft : e.k === 2 ? b.handleRight : b.co; }
  return sp.points[e.pi].co;
}

function elemSelected(sp: Spline, e: CurveElem): boolean {
  if (sp.type === 'BEZIER') { const b = sp.bezierPoints[e.pi]; return e.k === 0 ? b.selectLeft : e.k === 2 ? b.selectRight : b.select; }
  return sp.points[e.pi].select;
}

function setElemSelected(cu: CurveData, sp: Spline, e: CurveElem, v: boolean): void {
  if (sp.type === 'BEZIER') {
    const b = sp.bezierPoints[e.pi];
    // with handles hidden (or on the control point) the whole triple is selected
    if (e.k === 1 || !cu.showHandles) { b.select = v; b.selectLeft = v; b.selectRight = v; }
    else if (e.k === 0) b.selectLeft = v; else b.selectRight = v;
  } else sp.points[e.pi].select = v;
}

/** All visible, pickable elements. */
export function curveElems(cu: CurveData): CurveElem[] {
  const out: CurveElem[] = [];
  cu.splines.forEach((sp, si) => {
    if (sp.hide) return;
    const n = pointCount(sp);
    for (let pi = 0; pi < n; pi++) {
      if (pointHidden(sp, pi)) continue;
      if (sp.type === 'BEZIER') {
        out.push({ si, pi, k: 1 });
        if (cu.showHandles) { out.push({ si, pi, k: 0 }); out.push({ si, pi, k: 2 }); }
      } else out.push({ si, pi, k: 1 });
    }
  });
  return out;
}

export function anyCurveSelected(cu: CurveData): boolean {
  return cu.splines.some((sp) => (sp.type === 'BEZIER' ? sp.bezierPoints.some((b) => !b.hide && (b.select || b.selectLeft || b.selectRight)) : sp.points.some((p) => !p.hide && p.select)));
}

export function selectAllCurve(cu: CurveData, action: SelectAction): void {
  let a = action;
  if (a === 'TOGGLE') a = anyCurveSelected(cu) ? 'DESELECT' : 'SELECT';
  for (const sp of cu.splines) {
    for (const b of sp.bezierPoints) {
      if (b.hide) continue;
      if (a === 'INVERT') { b.select = !b.select; b.selectLeft = !b.selectLeft; b.selectRight = !b.selectRight; }
      else { b.select = b.selectLeft = b.selectRight = a === 'SELECT'; }
    }
    for (const p of sp.points) { if (p.hide) continue; p.select = a === 'INVERT' ? !p.select : a === 'SELECT'; }
  }
}

/** Recalculate the handles of every Bezier spline. */
export function recalcCurveHandles(cu: CurveData, lead?: Map<string, 'L' | 'R'>): void {
  cu.splines.forEach((sp, si) => {
    if (sp.type !== 'BEZIER') return;
    const m = new Map<number, 'L' | 'R'>();
    if (lead) for (const [k, v] of lead) { const [s, p] = k.split(':').map(Number); if (s === si) m.set(p, v); }
    calcHandles(sp, m);
  });
}

/** Tag a curve as changed (evaluated mesh and overlay). */
export function curveChanged(): void { app.notify('geometry', 'select'); }

// ------------------------------------------------------------------ overlay

function overlayKey(ob: BObject): string {
  const cu = curveDataOf(app.doc, ob);
  return cu ? JSON.stringify(cu) : '';
}

function buildOverlay(ob: BObject, group: Group): void {
  const cu = curveDataOf(app.doc, ob);
  if (!cu) return;
  const lp: number[] = [], lc: number[] = [];
  const pp: number[] = [], pc: number[] = [];
  const line = (a: Vec3, b: Vec3, c: Vec3, c2: Vec3 = c) => { lp.push(...a, ...b); lc.push(...c, ...c2); };
  const isSurf = ob.type === 'SURFACE';
  const is2D = cu.dimensions === '2D' && !isSurf;
  // evaluated curve (black) and normals
  const wp: number[] = [], wc: number[] = [];
  if (!isSurf) {
    for (const sp of cu.splines) {
      if (sp.hide) continue;
      const s = sampleSpline(sp, splineResolution(cu, sp, false));
      const pts = s.pts.map((p) => (is2D ? [p.co[0], p.co[1], 0] as Vec3 : p.co));
      for (let i = 0; i + 1 < pts.length; i++) { wp.push(...pts[i], ...pts[i + 1]); wc.push(...WIRE_EDIT, ...WIRE_EDIT); }
      if (s.cyclic && pts.length > 2) { wp.push(...pts[pts.length - 1], ...pts[0]); wc.push(...WIRE_EDIT, ...WIRE_EDIT); }
      if (cu.showNormalFace && !is2D && pts.length > 1) {
        const fr = computeFrames(pts, s.cyclic, cu.twistMode, false, s.pts.map((p) => p.tilt));
        const size = 0.1;
        pts.forEach((p, i) => {
          const f = fr[i];
          const r = s.pts[i].radius;
          const a: Vec3 = [p[0] + (f.n[0] - f.t[0]) * size * r, p[1] + (f.n[1] - f.t[1]) * size * r, p[2] + (f.n[2] - f.t[2]) * size * r];
          const b: Vec3 = [p[0] + (-f.n[0] - f.t[0]) * size * r, p[1] + (-f.n[1] - f.t[1]) * size * r, p[2] + (-f.n[2] - f.t[2]) * size * r];
          wp.push(...p, ...a, ...p, ...b);
          wc.push(...NORMAL_COL, ...NORMAL_COL, ...NORMAL_COL, ...NORMAL_COL);
        });
      }
    }
  }
  cu.splines.forEach((sp, si) => {
    if (sp.hide) return;
    if (sp.type === 'BEZIER') {
      sp.bezierPoints.forEach((b, pi) => {
        if (b.hide) return;
        if (cu.showHandles) {
          line(b.co, b.handleLeft, HANDLE[b.handleLeftType][b.selectLeft ? 1 : 0]);
          line(b.co, b.handleRight, HANDLE[b.handleRightType][b.selectRight ? 1 : 0]);
          pp.push(...b.handleLeft, ...b.handleRight);
          pc.push(...(b.selectLeft ? VERT_SEL : VERT), ...(b.selectRight ? VERT_SEL : VERT));
        }
        const act = si === cu.activeSpline && pi === cu.activePoint && b.select;
        pp.push(...b.co);
        pc.push(...(act ? ACTIVE_PT : b.select ? VERT_SEL : VERT));
      });
      return;
    }
    // NURBS / poly control polygon (surfaces: U lines and V lines)
    const nu = sp.pointCountV > 1 ? sp.pointCountU : sp.points.length;
    const edges = isSurf ? surfaceGridEdges(sp) : (() => {
      const e: [number, number][] = [];
      for (let i = 0; i + 1 < nu; i++) e.push([i, i + 1]);
      if (sp.useCyclicU && nu > 2) e.push([nu - 1, 0]);
      return e;
    })();
    for (const [a, b] of edges) {
      const pa = sp.points[a], pb = sp.points[b];
      if (!pa || !pb || pa.hide || pb.hide) continue;
      const isV = isSurf && sp.pointCountU > 0 && Math.floor(a / sp.pointCountU) !== Math.floor(b / sp.pointCountU);
      const sel = pa.select && pb.select;
      const col = isV ? (sel ? NURB_SEL_VLINE : NURB_VLINE) : (sel ? NURB_SEL_ULINE : NURB_ULINE);
      line(pa.co, pb.co, col);
    }
    sp.points.forEach((p, pi) => {
      if (p.hide) return;
      const act = si === cu.activeSpline && pi === cu.activePoint && p.select;
      pp.push(...p.co);
      pc.push(...(act ? ACTIVE_PT : p.select ? VERT_SEL : VERT));
    });
  });
  if (wp.length) { const w = editLines(wp, wc, { depthTest: true }); w.renderOrder = 30; group.add(w); }
  if (lp.length) group.add(editLines(lp, lc));
  if (pp.length) group.add(editPoints(pp, pc, 5));
}

// ------------------------------------------------------------------ picking

function worldOf(ob: BObject, co: Vec3): Vector3 {
  return new Vector3(co[0], co[1], co[2]).applyMatrix4(app.matrices.world(ob));
}

/** Nearest element to the viewport pixel (x, y) within `radius` pixels. */
export function pickCurveElem(view: View3D, ob: BObject, cu: CurveData, x: number, y: number, radius = 15): CurveElem | null {
  let best: CurveElem | null = null, bd = radius;
  for (const e of curveElems(cu)) {
    const sp = cu.splines[e.si];
    const p = view.view.project(worldOf(ob, elemCo(sp, e)));
    if (p.behind) continue;
    // control points win over handles at the same distance; unselected slightly preferred (like Blender)
    let d = Math.hypot(p.x - x, p.y - y) - (e.k === 1 ? 0.5 : 0);
    if (elemSelected(sp, e)) d += 2;
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}

function clickSelect(view: View3D, ob: BObject, x: number, y: number, extend: boolean): boolean {
  const cu = curveDataOf(app.doc, ob);
  if (!cu) return false;
  const e = pickCurveElem(view, ob, cu, x, y);
  if (!e) {
    if (!extend) selectAllCurve(cu, 'DESELECT');
    return false;
  }
  const sp = cu.splines[e.si];
  if (extend) {
    const cur = elemSelected(sp, e);
    const isActive = cu.activeSpline === e.si && cu.activePoint === e.pi;
    if (cur && (isActive || e.k !== 1)) setElemSelected(cu, sp, e, false);
    else setElemSelected(cu, sp, e, true);
  } else {
    selectAllCurve(cu, 'DESELECT');
    setElemSelected(cu, sp, e, true);
  }
  if (isPointSelected(sp, e.pi)) { cu.activeSpline = e.si; cu.activePoint = e.pi; }
  return true;
}

function regionSelect(view: View3D, ob: BObject, inside: (px: number, py: number) => boolean, mode: RegionMode): void {
  const cu = curveDataOf(app.doc, ob);
  if (!cu) return;
  if (mode === 'SET') selectAllCurve(cu, 'DESELECT');
  for (const e of curveElems(cu)) {
    const sp = cu.splines[e.si];
    const p = view.view.project(worldOf(ob, elemCo(sp, e)));
    if (p.behind || !inside(p.x, p.y)) continue;
    if (sp.type === 'BEZIER') {
      const b = sp.bezierPoints[e.pi];
      const v = mode !== 'SUB';
      if (!cu.showHandles) { b.select = b.selectLeft = b.selectRight = v; }
      else if (e.k === 0) b.selectLeft = v; else if (e.k === 2) b.selectRight = v; else b.select = v;
    } else sp.points[e.pi].select = mode !== 'SUB';
  }
}

// ------------------------------------------------------------------ transform

/** Which handle of an Aligned pair was moved (key "spline:point"). */
let lastLead = new Map<string, 'L' | 'R'>();

function transformPoints(ob: BObject, propSize: number): TransformPoint[] {
  const cu = curveDataOf(app.doc, ob);
  if (!cu) return [];
  const W = app.matrices.world(ob).clone();
  const Winv = W.clone().invert();
  const out: TransformPoint[] = [];
  lastLead = new Map();
  const toWorld = (v: Vec3) => new Vector3(v[0], v[1], v[2]).applyMatrix4(W);
  const local = (m: Matrix4) => Winv.clone().multiply(m).multiply(W);
  const xf = (v: Vec3, m: Matrix4): Vec3 => { const p = new Vector3(v[0], v[1], v[2]).applyMatrix4(m); return [p.x, p.y, p.z]; };
  const withProp = propSize > 0;
  cu.splines.forEach((sp, si) => {
    if (sp.hide) return;
    if (sp.type === 'BEZIER') {
      sp.bezierPoints.forEach((b, pi) => {
        if (b.hide) return;
        const start = { co: [...b.co] as Vec3, hl: [...b.handleLeft] as Vec3, hr: [...b.handleRight] as Vec3, tl: b.handleLeftType, tr: b.handleRightType };
        const restore = () => { b.co = [...start.co] as Vec3; b.handleLeft = [...start.hl] as Vec3; b.handleRight = [...start.hr] as Vec3; b.handleLeftType = start.tl; b.handleRightType = start.tr; };
        if (b.select || (!b.selectLeft && !b.selectRight && withProp)) {
          // the control point carries its handles
          out.push({
            world: toWorld(start.co), selected: b.select, factor: b.select ? 1 : 0,
            apply: (m) => { const L = local(m); b.co = xf(start.co, L); b.handleLeft = xf(start.hl, L); b.handleRight = xf(start.hr, L); },
            restore,
          });
          return;
        }
        // handles moved on their own: Auto handles become Aligned, Vector handles Free (like Blender)
        const handle = (side: 'L' | 'R') => {
          const s0 = side === 'L' ? start.hl : start.hr;
          out.push({
            world: toWorld(s0), selected: true, factor: 1,
            apply: (m) => {
              const L = local(m);
              const p = xf(s0, L);
              if (side === 'L') b.handleLeft = p; else b.handleRight = p;
              const t = side === 'L' ? b.handleLeftType : b.handleRightType;
              if (t === 'AUTO') { b.handleLeftType = 'ALIGNED'; b.handleRightType = 'ALIGNED'; }
              if (t === 'VECTOR') { if (side === 'L') b.handleLeftType = 'FREE'; else b.handleRightType = 'FREE'; }
              lastLead.set(`${si}:${pi}`, side);
            },
            restore,
          });
        };
        if (b.selectLeft) handle('L');
        if (b.selectRight) handle('R');
      });
      return;
    }
    sp.points.forEach((p: SplinePoint) => {
      if (p.hide || (!p.select && !withProp)) return;
      const s0 = [...p.co] as Vec3;
      out.push({
        world: toWorld(s0), selected: p.select, factor: p.select ? 1 : 0,
        apply: (m) => { p.co = xf(s0, local(m)); },
        restore: () => { p.co = [...s0] as Vec3; },
      });
    });
  });
  return out;
}

function afterTransform(ob: BObject): void {
  const cu = curveDataOf(app.doc, ob);
  if (!cu) return;
  recalcCurveHandles(cu, lastLead);
  app.notify('geometry');
}

function selectedPoints(ob: BObject): Vector3[] {
  const cu = curveDataOf(app.doc, ob);
  if (!cu) return [];
  const out: Vector3[] = [];
  for (const sp of cu.splines) {
    if (sp.hide) continue;
    for (const b of sp.bezierPoints) {
      if (b.hide) continue;
      if (b.select) out.push(worldOf(ob, b.co));
      else { if (b.selectLeft) out.push(worldOf(ob, b.handleLeft)); if (b.selectRight) out.push(worldOf(ob, b.handleRight)); }
    }
    for (const p of sp.points) if (!p.hide && p.select) out.push(worldOf(ob, p.co));
  }
  return out;
}

function activePoint(ob: BObject): Vector3 | null {
  const cu = curveDataOf(app.doc, ob);
  const sp = cu?.splines[cu.activeSpline];
  if (!cu || !sp || cu.activePoint < 0) return null;
  if (sp.type === 'BEZIER') { const b = sp.bezierPoints[cu.activePoint]; return b?.select ? worldOf(ob, b.co) : null; }
  const p = sp.points[cu.activePoint];
  return p?.select ? worldOf(ob, p.co) : null;
}

// ------------------------------------------------------------------ registration

/** Menus come from the curve operators module (set there to avoid an import cycle). */
export const curveMenus: { curve?: () => MenuItem[]; surface?: () => MenuItem[]; select?: () => MenuItem[]; add?: () => MenuItem[]; addSurface?: () => MenuItem[] } = {};

function handler(type: 'CURVE' | 'SURFACE'): EditTypeHandler {
  return {
    types: [type],
    menuLabel: type === 'CURVE' ? 'Curve' : 'Surface',
    menu: () => (type === 'CURVE' ? curveMenus.curve?.() : curveMenus.surface?.()) ?? [],
    selectMenu: () => curveMenus.select?.() ?? [],
    addMenu: () => (type === 'CURVE' ? curveMenus.add?.() : curveMenus.addSurface?.()) ?? [],
    enter: (ob) => { const cu = curveDataOf(app.doc, ob); if (cu) recalcCurveHandles(cu); },
    clickSelect, regionSelect,
    selectAll: (ob, action) => { const cu = curveDataOf(app.doc, ob); if (cu) selectAllCurve(cu, action); },
    hasSelection: (ob) => { const cu = curveDataOf(app.doc, ob); return !!cu && anyCurveSelected(cu); },
    transformPoints, afterTransform, selectedPoints, activePoint,
    overlayKey, buildOverlay: (ob, group) => buildOverlay(ob, group),
  };
}

registerEditType(handler('CURVE'));
registerEditType(handler('SURFACE'));

export type { BezierPoint };
