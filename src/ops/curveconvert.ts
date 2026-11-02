// Object-level operators for curves, surfaces and metaballs: Convert to (Alt+C) between curves,
// surfaces, metaballs, text and meshes (with Keep Original), Join (Ctrl+J) of curves and
// surfaces, Separate (P) in curve edit mode, and material slot assignment in curve edit mode.

import { Matrix4, Vector3 } from 'three';
import { app, type OperatorDef, type OpProps } from '../app';
import type { BObject, Vec3 } from '../core/types';
import type { CurveData, Spline } from '../core/curvetypes';
import { createMesh, createObject, newId, uniqueNameIn } from '../core/scene';
import { newCurveData, newSpline, newSplinePoint } from '../core/curve';
import { curveDataOf, isMetaBasis, metaDataOf, metaFamily } from '../core/curveobj';
import { evaluateModifiers } from '../core/modifiers';
import { ensureArrays, rebuildEdges } from '../core/mesh';
import { materialSlots } from '../core/matslots';
import { textToSplines } from '../core/text3d';
import { editCurve, isPointSelected, pointCount, recalcCurveHandles } from '../editors/view3d/curveedit';
import { cloneSpline, deleteVerts, ensureCurveCollections, selectedRuns, withPoints } from './curve';
import { isObjectMode } from './common';
import type { MenuItem } from '../ui/menu';

const op = (label: string, id: string, props?: Record<string, unknown>, icon?: string): MenuItem => ({ label, op: id, props, icon });

function removeObject(ob: BObject): void {
  const doc = app.doc;
  for (const sc of doc.scenes) {
    sc.objects = sc.objects.filter((id) => id !== ob.id);
    if (sc.activeObject === ob.id) sc.activeObject = null;
  }
  for (const o of Object.values(doc.objects)) {
    if (o.parent === ob.id) { o.parent = null; o.parentInverse = new Matrix4().toArray(); }
    for (const c of o.constraints) if (c.target === ob.id) c.target = null;
  }
  delete doc.objects[ob.id];
}

/** Copy an object (transform, layers, parenting) as a new object of another type. */
function cloneObjectAs(src: BObject, type: BObject['type'], data: string | null, name = src.name): BObject {
  const doc = app.doc;
  const ob = createObject(doc, type, name, data);
  const keep: (keyof BObject)[] = ['location', 'rotation', 'scale', 'rotationMode', 'deltaLocation', 'deltaRotation', 'deltaScale', 'parent', 'parentInverse', 'layers', 'drawType', 'color', 'passIndex', 'hideRender'];
  for (const k of keep) (ob as unknown as Record<string, unknown>)[k] = JSON.parse(JSON.stringify(src[k]));
  for (const sc of doc.scenes) { const i = sc.objects.indexOf(src.id); if (i >= 0) sc.objects.splice(i + 1, 0, ob.id); }
  return ob;
}

// ------------------------------------------------------------------ mesh -> curve

/** Poly splines from mesh edges (wire edges, or all edges when the mesh has no wire edges). */
function meshEdgesToSplines(verts: Vec3[], edges: [number, number][]): Spline[] {
  const adj = new Map<number, number[]>();
  for (const [a, b] of edges) { (adj.get(a) ?? adj.set(a, []).get(a)!).push(b); (adj.get(b) ?? adj.set(b, []).get(b)!).push(a); }
  const used = new Set<string>();
  const key = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  const out: Spline[] = [];
  const walk = (start: number, next: number): number[] => {
    const chain = [start];
    let prev = start, curv = next;
    used.add(key(prev, curv));
    for (;;) {
      chain.push(curv);
      const nb = (adj.get(curv) ?? []).filter((x) => !used.has(key(curv, x)));
      if ((adj.get(curv)?.length ?? 0) !== 2 || !nb.length) break;
      prev = curv; curv = nb[0];
      used.add(key(prev, curv));
      void prev;
    }
    return chain;
  };
  const mk = (chain: number[], cyclic: boolean) => {
    const sp = newSpline('POLY');
    for (const v of chain) sp.points.push(newSplinePoint(verts[v]));
    sp.pointCountU = sp.points.length;
    sp.useCyclicU = cyclic;
    sp.useSmooth = false;
    out.push(sp);
  };
  // open chains start at vertices that are not of degree 2
  for (const [v, nb] of adj) {
    if (nb.length === 2) continue;
    for (const n of nb) if (!used.has(key(v, n))) mk(walk(v, n), false);
  }
  // remaining edges form closed loops
  for (const [a, b] of edges) {
    if (used.has(key(a, b))) continue;
    const chain = walk(a, b);
    if (chain[chain.length - 1] === chain[0]) chain.pop();
    mk(chain, true);
  }
  return out;
}

// ------------------------------------------------------------------ convert

type ConvertTarget = 'MESH' | 'CURVE';

function convertToMesh(o: BObject, keep: boolean): BObject | null {
  const doc = app.doc;
  if (o.type === 'META' && !isMetaBasis(o)) return null;
  const em = app.evalMesh(o);
  if (!em) return null;
  const mats = (materialSlots(doc, o) ?? []).slice();
  if (o.type === 'MESH') {
    if (keep) {
      const mesh = createMesh(doc, o.name, em.verts, em.faces, em.looseEdges);
      mesh.faceSmooth = em.faceSmooth.slice(); mesh.faceMat = em.faceMat.slice(); mesh.materials = mats;
      ensureArrays(mesh);
      const c = cloneObjectAs(o, 'MESH', mesh.id);
      app.tagGeometry(mesh.id);
      return c;
    }
    const md = app.meshOf(o)!;
    const ev = evaluateModifiers(md, o.modifiers, { frame: app.scene.frameCurrent, render: false, editMode: false, ob: o, doc });
    md.verts = ev.verts; md.faces = ev.faces; md.edges = ev.looseEdges.slice(); md.faceSmooth = ev.faceSmooth; md.faceMat = ev.faceMat;
    md.vsel = []; md.esel = []; md.fsel = []; md.activeFace = -1;
    rebuildEdges(md); ensureArrays(md);
    o.modifiers = [];
    app.tagGeometry(md.id);
    return o;
  }
  const mesh = createMesh(doc, o.name, em.verts.map((v) => [...v] as Vec3), em.faces.map((f) => f.slice()), em.looseEdges.map((e) => [e[0], e[1]] as [number, number]));
  mesh.faceSmooth = em.faceSmooth.slice();
  mesh.faceMat = em.faceMat.slice();
  mesh.materials = mats;
  ensureArrays(mesh);
  const family = o.type === 'META' ? metaFamily(doc, o).filter((x) => x !== o) : [];
  if (keep) {
    const c = cloneObjectAs(o, 'MESH', mesh.id);
    app.tagGeometry(mesh.id);
    return c;
  }
  o.type = 'MESH';
  o.data = mesh.id;
  o.modifiers = [];
  delete o.text;
  // the other metaballs of the family are part of the converted surface
  for (const f of family) removeObject(f);
  app.tagGeometry(mesh.id);
  return o;
}

function convertToCurve(o: BObject, keep: boolean): BObject | null {
  ensureCurveCollections();
  const doc = app.doc;
  let splines: Spline[] = [];
  const cu = newCurveData(newId(doc, 'CU'), uniqueNameIn(doc, 'curves', o.name));
  if (o.type === 'MESH') {
    const md = app.meshOf(o);
    if (!md) return null;
    const em = app.evalMesh(o) ?? null;
    const verts = em ? em.verts : md.verts;
    const edges = em ? (em.looseEdges.length ? em.looseEdges : (() => {
      const seen = new Set<string>(); const out: [number, number][] = [];
      for (const f of em.faces) for (let i = 0; i < f.length; i++) { const a = f[i], b = f[(i + 1) % f.length]; const k = a < b ? `${a}_${b}` : `${b}_${a}`; if (!seen.has(k)) { seen.add(k); out.push([a, b]); } }
      return out;
    })()) : md.edges;
    splines = meshEdgesToSplines(verts, edges);
    cu.materials = md.materials.slice();
  } else if (o.type === 'FONT' && o.text) {
    splines = textToSplines(o);
    cu.dimensions = '2D';
    cu.fillMode = 'FULL';
    cu.extrude = o.text.extrude;
    cu.bevelDepth = o.text.bevelDepth;
    cu.bevelResolution = o.text.bevelResolution;
    cu.resolutionU = Math.max(1, o.text.resolution);
    cu.materials = (o.text.materials ?? []).slice();
  } else return null;
  if (!splines.length) { app.report('WARNING', `Object "${o.name}" has no edges to convert`); return null; }
  for (const sp of splines) { sp.resolutionU = cu.resolutionU; sp.pointCountU = sp.type === 'BEZIER' ? sp.bezierPoints.length : sp.points.length; }
  cu.splines = splines;
  recalcCurveHandles(cu);
  doc.curves[cu.id] = cu;
  if (keep) return cloneObjectAs(o, 'CURVE', cu.id);
  o.type = 'CURVE';
  o.data = cu.id;
  o.modifiers = [];
  delete o.text;
  return o;
}

const CONVERTIBLE = new Set(['MESH', 'CURVE', 'SURFACE', 'META', 'FONT']);

export const convertOperator: OperatorDef = {
  id: 'object.convert', label: 'Convert to', description: 'Convert selected objects to another type', undo: true, register: true,
  poll: () => isObjectMode() && app.selectedObjects().some((o) => CONVERTIBLE.has(o.type)),
  props: {
    target: { name: 'Target', type: 'enum', default: 'MESH', items: [['CURVE', 'Curve from Mesh/Text'], ['MESH', 'Mesh from Curve/Meta/Surf/Text']], description: 'Type of object to convert to' },
    keep_original: { name: 'Keep Original', type: 'bool', default: false, description: 'Keep original objects instead of replacing them' },
  },
  exec: (_c, p: OpProps) => {
    const target = p.target as ConvertTarget;
    const keep = !!p.keep_original;
    const results: BObject[] = [];
    const act = app.activeObject;
    let newActive: BObject | null = null;
    for (const o of app.selectedObjects()) {
      if (!app.doc.objects[o.id]) continue; // removed as part of a metaball family
      let r: BObject | null = null;
      if (target === 'MESH') r = convertToMesh(o, keep);
      else if (o.type === 'MESH' || o.type === 'FONT') r = convertToCurve(o, keep);
      if (!r) continue;
      results.push(r);
      if (o === act) newActive = r;
    }
    if (!results.length) { app.report('WARNING', 'Nothing to convert'); return 'CANCELLED'; }
    if (keep) {
      app.deselectAll();
      for (const r of results) r.select = true;
    }
    if (newActive) app.scene.activeObject = newActive.id;
    app.tagAllGeometry();
    return 'FINISHED';
  },
};

export function convertMenu(): MenuItem[] {
  return [
    op('Curve from Mesh/Text', 'object.convert', { target: 'CURVE' }),
    op('Mesh from Curve/Meta/Surf/Text', 'object.convert', { target: 'MESH' }),
  ];
}

// ------------------------------------------------------------------ join

export function curveJoinPoll(): boolean {
  const act = app.activeObject;
  if (!isObjectMode() || !act || (act.type !== 'CURVE' && act.type !== 'SURFACE')) return false;
  return app.selectedObjects().filter((o) => o.type === act.type).length > 1;
}

export function joinCurves(): 'FINISHED' | 'CANCELLED' {
  const act = app.activeObject!;
  const dst = curveDataOf(app.doc, act);
  if (!dst) return 'CANCELLED';
  const inv = app.matrices.world(act).clone().invert();
  for (const o of app.selectedObjects()) {
    if (o === act || o.type !== act.type) continue;
    const src = curveDataOf(app.doc, o);
    if (!src) continue;
    const m = inv.clone().multiply(app.matrices.world(o));
    const t = (v: Vec3): Vec3 => { const q = new Vector3(...v).applyMatrix4(m); return [q.x, q.y, q.z]; };
    const remap = src.materials.map((mid) => { let i = dst.materials.indexOf(mid); if (i < 0) { dst.materials.push(mid); i = dst.materials.length - 1; } return i; });
    for (const sp of src.splines) {
      const c = cloneSpline(sp);
      for (const b of c.bezierPoints) { b.co = t(b.co); b.handleLeft = t(b.handleLeft); b.handleRight = t(b.handleRight); }
      for (const pt of c.points) pt.co = t(pt.co);
      c.materialIndex = remap[c.materialIndex] ?? 0;
      dst.splines.push(c);
    }
    removeObject(o);
  }
  if (dst.dimensions === '2D') for (const sp of dst.splines) { for (const b of sp.bezierPoints) { b.co[2] = 0; b.handleLeft[2] = 0; b.handleRight[2] = 0; } for (const pt of sp.points) pt.co[2] = 0; }
  recalcCurveHandles(dst);
  act.select = true;
  app.scene.activeObject = act.id;
  app.tagAllGeometry();
  return 'FINISHED';
}

// ------------------------------------------------------------------ separate (P in curve edit mode)

export const separateOperator: OperatorDef = {
  id: 'curve.separate', label: 'Separate', description: 'Separate selected points from connected unselected points into a new object', undo: true, register: true,
  poll: () => {
    const e = editCurve();
    return !!e && e.cu.splines.some((sp) => Array.from({ length: pointCount(sp) }, (_, i) => isPointSelected(sp, i)).some(Boolean));
  },
  exec: () => {
    const e = editCurve()!;
    const cu = e.cu;
    const doc = app.doc;
    const parts: Spline[] = [];
    for (const sp of cu.splines) {
      if (sp.pointCountV > 1) {
        if (sp.points.every((p) => p.select)) parts.push(cloneSpline(sp));
        continue;
      }
      for (const run of selectedRuns(sp)) {
        const whole = run.length === pointCount(sp);
        const s = withPoints(sp, sp.type === 'BEZIER' ? run.map((i) => JSON.parse(JSON.stringify(sp.bezierPoints[i]))) : [], sp.type === 'BEZIER' ? [] : run.map((i) => JSON.parse(JSON.stringify(sp.points[i]))));
        s.useCyclicU = whole && sp.useCyclicU;
        parts.push(s);
      }
    }
    if (!parts.length) return 'CANCELLED';
    // surfaces: fully selected splines are moved whole
    cu.splines = cu.splines.filter((sp) => !(sp.pointCountV > 1 && sp.points.every((p) => p.select)));
    deleteVerts(cu);
    const nc: CurveData = { ...JSON.parse(JSON.stringify({ ...cu, splines: [] })), id: newId(doc, 'CU'), name: uniqueNameIn(doc, 'curves', cu.name) };
    nc.splines = parts;
    for (const sp of nc.splines) { for (const b of sp.bezierPoints) b.select = b.selectLeft = b.selectRight = false; for (const pt of sp.points) pt.select = false; }
    nc.activeSpline = 0; nc.activePoint = -1;
    doc.curves[nc.id] = nc;
    const no = cloneObjectAs(e.ob, e.ob.type, nc.id);
    no.modifiers = JSON.parse(JSON.stringify(e.ob.modifiers));
    no.select = false;
    recalcCurveHandles(cu);
    recalcCurveHandles(nc);
    app.notify('geometry', 'scene');
    return 'FINISHED';
  },
};

// ------------------------------------------------------------------ material slots in curve / text edit mode

/** Assign / select / deselect by the active material slot for curves (per spline). Returns null when not a curve. */
export function curveMaterialSlotOp(kind: 'assign' | 'select' | 'deselect'): boolean | null {
  const e = editCurve();
  if (!e) return null;
  const idx = e.ob.activeMaterialIndex;
  for (const sp of e.cu.splines) {
    const n = pointCount(sp);
    const anySel = Array.from({ length: n }, (_, i) => isPointSelected(sp, i)).some(Boolean);
    if (kind === 'assign') { if (anySel) sp.materialIndex = idx; continue; }
    if (sp.materialIndex !== idx) continue;
    for (const b of sp.bezierPoints) b.select = b.selectLeft = b.selectRight = kind === 'select';
    for (const pt of sp.points) pt.select = kind === 'select';
  }
  app.notify('geometry', 'select');
  return true;
}

export const META_TYPES_FOR_DATA = (o: BObject) => metaDataOf(app.doc, o);
