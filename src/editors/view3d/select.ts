// Selection in the 3D viewport: click picking (objects and mesh elements),
// border / circle / lasso selection and edge/face loop selection.

import { Vector3 } from 'three';
import { app, type ModalHandler } from '../../app';
import type { BObject, MeshData } from '../../core/types';
import { edgeIndexMap, edgeKey, flushSelection, polyCenter, selectModeOf, hiddenEdges, deselectHidden, type SelectMode } from '../../core/mesh';
import type { View3D } from './view3d';
import { activeEditType } from './edittypes';
import { hasEvalGeometry } from '../../core/geomtypes';

// ------------------------------------------------------------------ helpers

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function selectMode(): SelectMode { return selectModeOf(app.scene.toolSettings.meshSelectMode); }

// ------------------------------------------------------------------ object picking

export interface ObjectCandidate { ob: BObject; depth: number }

export function objectCandidates(view: View3D, x: number, y: number): ObjectCandidate[] {
  const out: ObjectCandidate[] = [];
  const r = view.renderer;
  for (const h of r.pickMeshes(x, y)) if (!h.ob.hideSelect) out.push({ ob: h.ob, depth: h.depth });
  const camPos = new Vector3().setFromMatrixPosition(view.view.camera().matrixWorld);
  for (const ob of app.objects()) {
    if (ob.type === 'MESH' || ob.hideSelect || !r.objectVisible(ob.id)) continue;
    let best = Infinity;
    let bestDepth = Infinity;
    const segs = r.extraSegments(ob);
    for (let i = 0; i + 1 < segs.length; i += 2) {
      const a = view.view.project(segs[i]), b = view.view.project(segs[i + 1]);
      if (a.behind && b.behind) continue;
      const d = segDist(x, y, a.x, a.y, b.x, b.y);
      if (d < best) { best = d; bestDepth = segs[i].distanceTo(camPos); }
    }
    const c = app.matrices.location(ob);
    const pc = view.view.project(c);
    if (!pc.behind) {
      const d = Math.hypot(pc.x - x, pc.y - y);
      // lamps are drawn as a screen-space circle
      const radius = ob.type === 'LAMP' ? 10 : 5;
      if (d < radius && d < best) { best = d * 0.5; bestDepth = c.distanceTo(camPos); }
    }
    if (best < 7) out.push({ ob, depth: bestDepth });
  }
  out.sort((a, b) => a.depth - b.depth);
  return out;
}

/** Click select in object mode (Blender 2.79 rules: Shift toggles/activates, repeated clicks cycle). */
export function clickSelectObject(view: View3D, x: number, y: number, extend: boolean, deselect = false): boolean {
  const cands = objectCandidates(view, x, y);
  if (!cands.length) return false;
  let pick = cands[0].ob;
  const act = app.activeObject;
  if (!extend && cands.length > 1 && act) {
    const i = cands.findIndex((c) => c.ob === act);
    if (i >= 0 && act.select) pick = cands[(i + 1) % cands.length].ob;
  }
  if (deselect) {
    pick.select = false;
  } else if (extend) {
    if (pick.select && app.activeObject === pick) pick.select = false;
    else { pick.select = true; app.activeObject = pick; }
  } else {
    app.deselectAll();
    pick.select = true;
    app.activeObject = pick;
  }
  app.notify('select');
  return true;
}

// ------------------------------------------------------------------ edit mode picking

interface ElemHit { kind: 'VERT' | 'EDGE' | 'FACE'; index: number; dist: number }

function editWorld(md: MeshData, ob: BObject): Vector3[] {
  const m = app.matrices.world(ob);
  return md.verts.map((v) => new Vector3(v[0], v[1], v[2]).applyMatrix4(m));
}

export function pickEditElement(view: View3D, x: number, y: number, mode: SelectMode = selectMode()): ElemHit | null {
  const md = app.editMesh, ob = app.editObj;
  if (!md || !ob) return null;
  const world = editWorld(md, ob);
  const proj = world.map((p) => view.view.project(p));
  const r = view.renderer;
  if (mode === 'VERT') {
    const cands: { i: number; d: number }[] = [];
    proj.forEach((p, i) => {
      if (p.behind || md.vhide?.[i]) return;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < 40) cands.push({ i, d });
    });
    cands.sort((a, b) => a.d - b.d);
    // prefer unselected vertices slightly (Blender bias), and skip occluded ones
    for (const c of cands.slice(0, 24)) {
      if (r.editPointVisible(world[c.i])) return { kind: 'VERT', index: c.i, dist: c.d };
    }
    return null;
  }
  if (mode === 'EDGE') {
    const cands: { i: number; d: number }[] = [];
    const ehid = hiddenEdges(md);
    md.edges.forEach(([a, b], i) => {
      if (ehid[i]) return;
      const pa = proj[a], pb = proj[b];
      if (pa.behind || pb.behind) return;
      const d = segDist(x, y, pa.x, pa.y, pb.x, pb.y);
      if (d < 25) cands.push({ i, d });
    });
    cands.sort((a, b) => a.d - b.d);
    for (const c of cands.slice(0, 24)) {
      const [a, b] = md.edges[c.i];
      // check visibility at the point on the edge nearest the cursor (fall back to the midpoint)
      const mid = world[a].clone().add(world[b]).multiplyScalar(0.5);
      if (r.editPointVisible(mid) || r.editPointVisible(world[a]) || r.editPointVisible(world[b])) return { kind: 'EDGE', index: c.i, dist: c.d };
    }
    return null;
  }
  const hit = r.pickEditFace(x, y);
  if (hit) return { kind: 'FACE', index: hit.face, dist: 0 };
  if (!view.renderer.display.useOcclude || true) {
    // nearest face dot
    let best = -1, bd = 30;
    const m = app.matrices.world(ob);
    md.faces.forEach((f, i) => {
      if (md.fhide?.[i]) return;
      const c = new Vector3(...polyCenter(md.verts, f)).applyMatrix4(m);
      const p = view.view.project(c);
      if (p.behind) return;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bd && r.editPointVisible(c)) { bd = d; best = i; }
    });
    if (best >= 0) return { kind: 'FACE', index: best, dist: bd };
  }
  return null;
}

export function clickSelectEdit(view: View3D, x: number, y: number, extend: boolean): boolean {
  const et = activeEditType();
  if (et) { const hit = et.handler.clickSelect(view, et.ob, x, y, extend); app.notify('select'); return hit; }
  const md = app.editMesh;
  if (!md) return false;
  const mode = selectMode();
  const hit = pickEditElement(view, x, y, mode);
  if (!hit) return false;
  const emap = edgeIndexMap(md);
  if (!extend) { md.vsel.fill(false); md.esel.fill(false); md.fsel.fill(false); }
  if (hit.kind === 'VERT') {
    const cur = md.vsel[hit.index];
    md.vsel[hit.index] = extend ? !cur : true;
    flushSelection(md, 'VERT');
  } else if (hit.kind === 'EDGE') {
    const cur = md.esel[hit.index];
    md.esel[hit.index] = extend ? !cur : true;
    flushSelection(md, 'EDGE');
  } else {
    const cur = md.fsel[hit.index];
    const deselecting = extend && cur && md.activeFace === hit.index;
    md.fsel[hit.index] = deselecting ? false : true;
    flushSelection(md, 'FACE');
    md.activeFace = deselecting ? -1 : hit.index;
  }
  if (hit.kind !== 'FACE') {
    // the active face follows a selected face containing the picked element when possible
    if (md.activeFace >= 0 && !md.fsel[md.activeFace]) md.activeFace = -1;
  }
  void emap;
  deselectHidden(md, mode);
  app.notify('select');
  view.renderer.invalidateEdit();
  return true;
}

// ------------------------------------------------------------------ loops

/** Edge loop through quads starting at edge index `ei` (Alt+click). */
export function edgeLoop(md: MeshData, ei: number): number[] {
  const emap = edgeIndexMap(md);
  const edgeFacesMap = new Map<string, number[]>();
  md.faces.forEach((f, fi) => { for (let k = 0; k < f.length; k++) { const key = edgeKey(f[k], f[(k + 1) % f.length]); (edgeFacesMap.get(key) ?? edgeFacesMap.set(key, []).get(key)!).push(fi); } });
  const vEdges: number[][] = md.verts.map(() => []);
  md.edges.forEach(([a, b], i) => { vEdges[a].push(i); vEdges[b].push(i); });
  const result = new Set<number>([ei]);
  const walk = (startEdge: number, fromVert: number) => {
    let e = startEdge, v = fromVert;
    for (let guard = 0; guard < 100000; guard++) {
      const [a, b] = md.edges[e];
      const next = a === v ? b : a; // vertex at the far end
      if (vEdges[next].length !== 4) return;
      const faces = edgeFacesMap.get(edgeKey(a, b)) ?? [];
      // candidate: edge at `next` that shares no face with e
      const cand = vEdges[next].find((x) => {
        if (x === e) return false;
        const fk = edgeFacesMap.get(edgeKey(md.edges[x][0], md.edges[x][1])) ?? [];
        return !fk.some((f) => faces.includes(f));
      });
      if (cand === undefined || result.has(cand)) return;
      result.add(cand);
      e = cand;
      v = next;
    }
  };
  const [a, b] = md.edges[ei];
  walk(ei, a);
  walk(ei, b);
  void emap;
  return [...result];
}

/** Face loop (ring of quads) through the edge `ei`. */
export function faceLoop(md: MeshData, ei: number): number[] {
  const edgeFacesMap = new Map<string, number[]>();
  md.faces.forEach((f, fi) => { for (let k = 0; k < f.length; k++) { const key = edgeKey(f[k], f[(k + 1) % f.length]); (edgeFacesMap.get(key) ?? edgeFacesMap.set(key, []).get(key)!).push(fi); } });
  const result = new Set<number>();
  const startKey = edgeKey(md.edges[ei][0], md.edges[ei][1]);
  for (const startFace of edgeFacesMap.get(startKey) ?? []) {
    let f = startFace, key = startKey;
    for (let guard = 0; guard < 100000; guard++) {
      if (result.has(f) && f !== startFace) break;
      const poly = md.faces[f];
      if (poly.length !== 4) { result.add(f); break; }
      result.add(f);
      // opposite edge in the quad
      const [ea, eb] = key.split('_').map(Number);
      const i = poly.indexOf(ea), j = poly.indexOf(eb);
      const others = [0, 1, 2, 3].filter((k) => k !== i && k !== j);
      const ok = edgeKey(poly[others[0]], poly[others[1]]);
      const nf = (edgeFacesMap.get(ok) ?? []).find((x) => x !== f);
      if (nf === undefined || result.has(nf)) break;
      f = nf;
      key = ok;
    }
  }
  return [...result];
}

export function loopSelect(view: View3D, x: number, y: number, extend: boolean): boolean {
  const md = app.editMesh;
  if (!md) return false;
  const hit = pickEditElement(view, x, y, 'EDGE');
  if (!hit) return false;
  const mode = selectMode();
  if (!extend) { md.vsel.fill(false); md.esel.fill(false); md.fsel.fill(false); }
  if (mode === 'FACE') {
    for (const f of faceLoop(md, hit.index)) md.fsel[f] = true;
    flushSelection(md, 'FACE');
  } else {
    for (const e of edgeLoop(md, hit.index)) md.esel[e] = true;
    flushSelection(md, 'EDGE');
  }
  app.notify('select');
  view.renderer.invalidateEdit();
  return true;
}

// ------------------------------------------------------------------ region selection (border / circle / lasso)

type Inside = (px: number, py: number) => boolean;

/** Select everything inside a screen-space region. */
export function regionSelect(view: View3D, inside: Inside, bounds: { x0: number; y0: number; x1: number; y1: number }, mode: 'SET' | 'ADD' | 'SUB'): void {
  const et = activeEditType();
  if (et) { et.handler.regionSelect(view, et.ob, inside, mode); app.notify('select'); return; }
  const md = app.editMesh, ob = app.editObj;
  if (md && ob) {
    const sm = selectMode();
    if (mode === 'SET') { md.vsel.fill(false); md.esel.fill(false); md.fsel.fill(false); }
    const val = mode !== 'SUB';
    const world = editWorld(md, ob);
    const proj = world.map((p) => view.view.project(p));
    const vis = (i: number) => view.renderer.editPointVisible(world[i]);
    const inV = proj.map((p, i) => !md.vhide?.[i] && !p.behind && inside(p.x, p.y) && vis(i));
    if (sm === 'VERT') {
      inV.forEach((v, i) => { if (v) md.vsel[i] = val; });
      flushSelection(md, 'VERT');
    } else if (sm === 'EDGE') {
      md.edges.forEach(([a, b], i) => {
        // edge is selected when both ends are inside (or the edge midpoint for border select)
        const pa = proj[a], pb = proj[b];
        const mid = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
        if ((inV[a] && inV[b]) || (inside(mid.x, mid.y) && !pa.behind && !pb.behind && vis(a) && vis(b) && (inV[a] || inV[b]))) md.esel[i] = val;
      });
      flushSelection(md, 'EDGE');
    } else {
      const m = app.matrices.world(ob);
      md.faces.forEach((f, i) => {
        if (md.fhide?.[i]) return;
        const c = new Vector3(...polyCenter(md.verts, f)).applyMatrix4(m);
        const p = view.view.project(c);
        if (!p.behind && inside(p.x, p.y) && view.renderer.editPointVisible(c)) md.fsel[i] = val;
      });
      flushSelection(md, 'FACE');
    }
    deselectHidden(md, sm);
    view.renderer.invalidateEdit();
    app.notify('select');
    return;
  }
  if (mode === 'SET') app.deselectAll();
  for (const o of app.objects()) {
    if (o.hideSelect || !view.renderer.objectVisible(o.id)) continue;
    let hit = false;
    const c = view.view.project(app.matrices.location(o));
    if (!c.behind && inside(c.x, c.y)) hit = true;
    if (!hit && hasEvalGeometry(o.type)) {
      const verts = view.renderer.worldVerts(o);
      const step = Math.max(1, Math.floor(verts.length / 5000));
      for (let i = 0; i < verts.length && !hit; i += step) {
        const p = view.view.project(verts[i]);
        if (!p.behind && p.x >= bounds.x0 && p.x <= bounds.x1 && p.y >= bounds.y0 && p.y <= bounds.y1 && inside(p.x, p.y)) hit = true;
      }
    }
    if (!hit && o.type !== 'MESH') {
      const segs = view.renderer.extraSegments(o);
      for (const s of segs) { const p = view.view.project(s); if (!p.behind && inside(p.x, p.y)) { hit = true; break; } }
    }
    if (hit) {
      o.select = mode !== 'SUB';
      if (mode !== 'SUB' && !app.activeObject?.select) app.activeObject = o;
    }
  }
  app.notify('select');
}

/** Border select (B): first click-drag defines the rectangle. LMB selects, MMB deselects. */
export function startBorderSelect(view: View3D, immediate: { x: number; y: number; mode: 'SET' | 'ADD' | 'SUB' } | null = null): void {
  let start: { x: number; y: number } | null = immediate ? { x: immediate.x, y: immediate.y } : null;
  let cur = { x: 0, y: 0 };
  let selMode: 'SET' | 'ADD' | 'SUB' = immediate?.mode ?? 'ADD';
  const done = () => { view.overlayShape = null; app.endModal(h); view.requestRender(); };
  const h: ModalHandler = {
    cursor: 'crosshair',
    status: () => 'Border select: LMB drag to select, MMB drag to deselect, Esc/RMB to cancel',
    cancel: done,
    onEvent(e) {
      const r = view.canvasRect();
      if (e.type === 'pointermove') {
        const pe = e as PointerEvent;
        cur = { x: pe.clientX - r.left, y: pe.clientY - r.top };
        view.overlayShape = start ? { kind: 'rect', a: start, b: cur } : { kind: 'cross', a: cur, b: cur };
        view.requestRender();
        return true;
      }
      if (e.type === 'pointerdown') {
        const pe = e as PointerEvent;
        if (pe.button === 2 && !start) { done(); return true; }
        start = { x: pe.clientX - r.left, y: pe.clientY - r.top };
        cur = { ...start };
        selMode = pe.button === 1 || pe.shiftKey && pe.button === 0 && false ? 'SUB' : 'ADD';
        if (pe.button === 1) selMode = 'SUB';
        return true;
      }
      if (e.type === 'pointerup') {
        if (!start) return true;
        const x0 = Math.min(start.x, cur.x), x1 = Math.max(start.x, cur.x), y0 = Math.min(start.y, cur.y), y1 = Math.max(start.y, cur.y);
        if (x1 - x0 > 1 || y1 - y0 > 1) {
          regionSelect(view, (px, py) => px >= x0 && px <= x1 && py >= y0 && py <= y1, { x0, y0, x1, y1 }, selMode);
          app.pushUndo('Border Select');
          app.report('OPERATOR', `bpy.ops.view3d.select_border(gesture_mode=${selMode === 'SUB' ? 4 : 3}, xmin=${Math.round(x0)}, xmax=${Math.round(x1)}, ymin=${Math.round(y0)}, ymax=${Math.round(y1)}, extend=True)`);
        }
        done();
        return true;
      }
      if (e.type === 'keydown') { if ((e as KeyboardEvent).key === 'Escape') done(); return true; }
      return true;
    },
  };
  if (immediate) view.overlayShape = { kind: 'rect', a: start!, b: start! };
  app.startModal(h);
}

/** Lasso select (Ctrl+LMB drag). */
export function startLasso(view: View3D, x: number, y: number, mode: 'ADD' | 'SUB'): void {
  const pts: { x: number; y: number }[] = [{ x, y }];
  const h: ModalHandler = {
    cursor: 'crosshair',
    status: () => 'Lasso select',
    cancel: () => { view.overlayShape = null; app.endModal(h); },
    onEvent(e) {
      const r = view.canvasRect();
      if (e.type === 'pointermove') {
        const pe = e as PointerEvent;
        pts.push({ x: pe.clientX - r.left, y: pe.clientY - r.top });
        view.overlayShape = { kind: 'lasso', a: pts[0], b: pts[0], pts };
        view.requestRender();
        return true;
      }
      if (e.type === 'pointerup') {
        view.overlayShape = null;
        app.endModal(h);
        if (pts.length > 2) {
          const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
          const bounds = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
          regionSelect(view, (px, py) => pointInPoly(px, py, pts), bounds, mode);
          app.pushUndo('Lasso Select');
        }
        view.requestRender();
        return true;
      }
      return true;
    },
  };
  app.startModal(h);
}

function pointInPoly(x: number, y: number, pts: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Circle select (C): paint selection with LMB, deselect with MMB, wheel changes radius. */
export function startCircleSelect(view: View3D): void {
  let radius = (view.state.circleRadius as number) ?? 25;
  let painting: 'ADD' | 'SUB' | null = null;
  let pos = { x: 0, y: 0 };
  const r0 = view.canvasRect();
  pos = { x: app.mouse.x - r0.left, y: app.mouse.y - r0.top };
  const paint = () => {
    if (!painting) return;
    const { x, y } = pos;
    regionSelect(view, (px, py) => Math.hypot(px - x, py - y) <= radius, { x0: x - radius, y0: y - radius, x1: x + radius, y1: y + radius }, painting);
  };
  const end = () => { view.overlayShape = null; view.state.circleRadius = radius; app.endModal(h); app.pushUndo('Circle Select'); view.requestRender(); };
  const h: ModalHandler = {
    status: () => 'Circle select: LMB select, MMB deselect, Wheel/+/- radius, RMB/Esc/Enter to finish',
    cursor: 'crosshair',
    cancel: end,
    onEvent(e) {
      const r = view.canvasRect();
      if (e.type === 'pointermove') {
        const pe = e as PointerEvent;
        pos = { x: pe.clientX - r.left, y: pe.clientY - r.top };
        view.overlayShape = { kind: 'circle', a: pos, b: pos, r: radius };
        paint();
        view.requestRender();
        return true;
      }
      if (e.type === 'pointerdown') {
        const pe = e as PointerEvent;
        if (pe.button === 2) { end(); return true; }
        painting = pe.button === 1 || pe.shiftKey ? 'SUB' : 'ADD';
        paint();
        return true;
      }
      if (e.type === 'pointerup') { painting = null; return true; }
      if (e.type === 'wheel') {
        radius = Math.max(2, Math.min(500, radius * ((e as WheelEvent).deltaY > 0 ? 1.1 : 1 / 1.1)));
        view.overlayShape = { kind: 'circle', a: pos, b: pos, r: radius };
        view.requestRender();
        return true;
      }
      if (e.type === 'keydown') {
        const k = (e as KeyboardEvent).key;
        if (k === 'Escape' || k === 'Enter' || k === ' ') end();
        if (k === '+' || k === '=') radius *= 1.1;
        if (k === '-') radius /= 1.1;
        view.overlayShape = { kind: 'circle', a: pos, b: pos, r: radius };
        view.requestRender();
        return true;
      }
      return true;
    },
  };
  view.overlayShape = { kind: 'circle', a: pos, b: pos, r: radius };
  app.startModal(h);
  view.requestRender();
}
