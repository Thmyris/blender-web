// Interactive tools of the UV editor: click select (RMB, Shift extend, Alt edge loop), border (B)
// and circle (C) select, and the modal Grab / Rotate / Scale transforms with X/Y constraints,
// numeric input, Ctrl snapping (pixels / 5 degrees / 0.1) and Shift precision. Transforms are
// logged and undone like Blender's transform operators and can be adjusted afterwards (F6).

import { app, type ModalHandler, type OperatorDef, type OpContext, type OpProps, type AreaLike } from '../../app';
import type { MeshData, MeshUVLayer } from '../../core/types';
import { edgeKey } from '../../core/mesh';
import { cornerUV } from '../../core/uvdata';
import { uvIslands } from '../../core/unwrap';
import {
  cornerSelected, isSync, selectAllUV, selectedCorners, setCorners, stickyCorners, syncSelectCorners, uvContext, uvSettings,
  vertFacesOf, visibleFaces,
} from './uvsel';

/** What the tools need from the UV/Image Editor. */
export interface UVEditorView {
  area: AreaLike;
  canvasRect(): DOMRect;
  uvToScreen(u: number, v: number): [number, number];
  screenToUV(x: number, y: number): [number, number];
  /** Image size in pixels (256 x 256 when no image is shown). */
  imageSize(): [number, number];
  redraw(): void;
  /** Feedback shapes drawn on top of the canvas. */
  feedback: { rect?: [number, number, number, number]; circle?: { x: number; y: number; r: number }; line?: [number, number, number, number] } | null;
}

function done(md: MeshData): void {
  app.tagGeometry(md.id);
  app.notify('select', 'geometry', 'view');
}

// ------------------------------------------------------------------ picking

interface Pick { f: number; k: number; d: number }

function nearestCorner(v: UVEditorView, md: MeshData, layer: MeshUVLayer, x: number, y: number): Pick | null {
  let best: Pick | null = null;
  for (const f of visibleFaces(md)) md.faces[f].forEach((_, k) => {
    const p = cornerUV(layer, f, k);
    const [sx, sy] = v.uvToScreen(p[0], p[1]);
    const d = Math.hypot(sx - x, sy - y);
    // prefer unselected corners on ties (cycling through stacked UVs like Blender)
    const dd = d + (cornerSelected(md, layer, f, k) ? 0.01 : 0);
    if (!best || dd < best.d) best = { f, k, d: dd };
  });
  return best;
}

function nearestEdge(v: UVEditorView, md: MeshData, layer: MeshUVLayer, x: number, y: number): Pick | null {
  let best: Pick | null = null;
  for (const f of visibleFaces(md)) {
    const n = md.faces[f].length;
    for (let k = 0; k < n; k++) {
      const a = cornerUV(layer, f, k), b = cornerUV(layer, f, (k + 1) % n);
      const [ax, ay] = v.uvToScreen(a[0], a[1]), [bx, by] = v.uvToScreen(b[0], b[1]);
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
      const d = Math.hypot(ax + dx * t - x, ay + dy * t - y);
      if (!best || d < best.d) best = { f, k, d };
    }
  }
  return best;
}

function nearestFace(v: UVEditorView, md: MeshData, layer: MeshUVLayer, x: number, y: number): Pick | null {
  let best: Pick | null = null;
  for (const f of visibleFaces(md)) {
    let cx = 0, cy = 0;
    const n = md.faces[f].length;
    for (let k = 0; k < n; k++) { const p = cornerUV(layer, f, k); const [sx, sy] = v.uvToScreen(p[0], p[1]); cx += sx; cy += sy; }
    const d = Math.hypot(cx / n - x, cy / n - y);
    if (!best || d < best.d) best = { f, k: 0, d };
  }
  return best;
}

const faceCorners = (md: MeshData, f: number): [number, number][] => md.faces[f].map((_, k) => [f, k] as [number, number]);

/** RMB click select. Returns true when something changed. */
export function uvClickSelect(v: UVEditorView, x: number, y: number, extend: boolean): boolean {
  const c = uvContext();
  if (!c) return false;
  const { md, layer } = c;
  const sync = isSync();
  const ts = app.scene.toolSettings;
  const mode = sync ? (ts.meshSelectMode[0] ? 'VERTEX' : ts.meshSelectMode[1] ? 'EDGE' : 'FACE') : uvSettings().selectMode;
  let corners: [number, number][] = [];
  let kind: 'VERT' | 'EDGE' | 'FACE' = 'VERT';
  let pickedFace = -1;
  const vf = vertFacesOf(md);
  if (mode === 'EDGE') {
    const p = nearestEdge(v, md, layer, x, y);
    if (!p) return false;
    const k2 = (p.k + 1) % md.faces[p.f].length;
    corners = sync ? [[p.f, p.k], [p.f, k2]] : [...stickyCorners(md, layer, p.f, p.k, vf), ...stickyCorners(md, layer, p.f, k2, vf)];
    kind = 'EDGE';
    pickedFace = p.f;
  } else if (mode === 'FACE') {
    const p = nearestFace(v, md, layer, x, y);
    if (!p) return false;
    corners = faceCorners(md, p.f);
    kind = 'FACE';
    pickedFace = p.f;
  } else {
    const p = nearestCorner(v, md, layer, x, y);
    if (!p) return false;
    pickedFace = p.f;
    if (mode === 'ISLAND') {
      const isl = uvIslands(md, layer, visibleFaces(md)).find((i) => i.includes(p.f)) ?? [p.f];
      corners = isl.flatMap((f) => faceCorners(md, f));
      kind = 'FACE';
    } else corners = sync ? [[p.f, p.k]] : stickyCorners(md, layer, p.f, p.k, vf);
  }
  const first = corners[0];
  const wasSelected = kind === 'EDGE'
    ? corners.every(([f, k]) => cornerSelected(md, layer, f, k))
    : kind === 'FACE' ? corners.every(([f, k]) => cornerSelected(md, layer, f, k)) : cornerSelected(md, layer, first[0], first[1]);
  const select = !(extend && wasSelected);
  if (!extend) selectAllUV(md, layer, 'DESELECT');
  if (sync) syncSelectCorners(md, kind === 'EDGE' ? [corners[0], corners[1]] : corners, select, kind);
  else setCorners(md, layer, corners, select);
  if (pickedFace >= 0 && (kind === 'FACE' || sync)) md.activeFace = select ? pickedFace : md.activeFace;
  done(md);
  return true;
}

/** Alt+RMB: select the edge loop under the mouse (through quads). */
export function uvLoopSelect(v: UVEditorView, x: number, y: number, extend: boolean): boolean {
  const c = uvContext();
  if (!c) return false;
  const { md, layer } = c;
  const p = nearestEdge(v, md, layer, x, y);
  if (!p) return false;
  const vis = new Set(visibleFaces(md));
  const g = md.faces[p.f];
  const a0 = g[p.k], b0 = g[(p.k + 1) % g.length];
  // vertex -> visible faces
  const vfAll = vertFacesOf(md);
  const edgeFaces = (a: number, b: number) => vfAll[a].filter((f) => vis.has(f) && md.faces[f].includes(b) && adjacentIn(md.faces[f], a, b));
  const loop = new Set<string>([edgeKey(a0, b0)]);
  const walk = (from: number, to: number) => {
    let a = from, b = to;
    for (let guard = 0; guard < 100000; guard++) {
      // faces around b: the next edge shares b and no face with (a, b), when b is a 4-valent vertex
      const fb = vfAll[b].filter((f) => vis.has(f));
      if (fb.length !== 4 || fb.some((f) => md.faces[f].length !== 4)) return;
      const fab = new Set(edgeFaces(a, b));
      const nbrs = new Set<number>();
      for (const f of fb) { const q = md.faces[f]; const i = q.indexOf(b); nbrs.add(q[(i + 1) % 4]); nbrs.add(q[(i + 3) % 4]); }
      let next = -1;
      for (const n of nbrs) {
        if (n === a) continue;
        const fs = edgeFaces(b, n);
        if (fs.every((f) => !fab.has(f))) { next = n; break; }
      }
      if (next < 0) return;
      const key = edgeKey(b, next);
      if (loop.has(key)) return;
      loop.add(key);
      a = b; b = next;
    }
  };
  walk(a0, b0);
  walk(b0, a0);
  const corners: [number, number][] = [];
  for (const f of vis) {
    const q = md.faces[f];
    for (let k = 0; k < q.length; k++) if (loop.has(edgeKey(q[k], q[(k + 1) % q.length]))) corners.push([f, k], [f, (k + 1) % q.length]);
  }
  if (!extend) selectAllUV(md, layer, 'DESELECT');
  if (isSync()) syncSelectCorners(md, corners, true, 'EDGE'); else setCorners(md, layer, corners, true);
  done(md);
  return true;
}

function adjacentIn(f: number[], a: number, b: number): boolean {
  const i = f.indexOf(a), j = f.indexOf(b);
  return i >= 0 && j >= 0 && ((i + 1) % f.length === j || (j + 1) % f.length === i);
}

/** Corners (or faces in face mode) inside a screen-space predicate. */
function cornersWhere(v: UVEditorView, md: MeshData, layer: MeshUVLayer, inside: (x: number, y: number) => boolean): { corners: [number, number][]; kind: 'VERT' | 'FACE' } {
  const sync = isSync();
  const faceMode = sync ? !app.scene.toolSettings.meshSelectMode[0] && app.scene.toolSettings.meshSelectMode[2] : uvSettings().selectMode === 'FACE';
  const corners: [number, number][] = [];
  for (const f of visibleFaces(md)) {
    const n = md.faces[f].length;
    if (faceMode) {
      let cx = 0, cy = 0;
      for (let k = 0; k < n; k++) { const p = cornerUV(layer, f, k); const [sx, sy] = v.uvToScreen(p[0], p[1]); cx += sx; cy += sy; }
      if (inside(cx / n, cy / n)) corners.push(...faceCorners(md, f));
    } else {
      for (let k = 0; k < n; k++) { const p = cornerUV(layer, f, k); const [sx, sy] = v.uvToScreen(p[0], p[1]); if (inside(sx, sy)) corners.push([f, k]); }
    }
  }
  return { corners, kind: faceMode ? 'FACE' : 'VERT' };
}

function applyRegion(md: MeshData, layer: MeshUVLayer, corners: [number, number][], kind: 'VERT' | 'FACE', select: boolean): void {
  if (isSync()) {
    syncSelectCorners(md, corners, select, kind);
    return;
  }
  // sticky selection extends region selections too
  const vf = vertFacesOf(md);
  const all = kind === 'FACE' ? corners : corners.flatMap(([f, k]) => stickyCorners(md, layer, f, k, vf));
  setCorners(md, layer, all, select);
}

/** B: border select (LMB drag selects, MMB / Shift+LMB drag deselects). */
export function startUVBorderSelect(v: UVEditorView): void {
  if (!uvContext()) return;
  let start: [number, number] | null = null;
  let deselect = false;
  const local = (e: PointerEvent): [number, number] => { const r = v.canvasRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const end = () => { v.feedback = null; app.endModal(h); v.redraw(); };
  const h: ModalHandler = {
    status: () => 'Border Select: LMB drag to select, MMB / Shift+LMB drag to deselect, RMB / Esc to cancel',
    cursor: 'crosshair',
    cancel: end,
    onEvent(e) {
      if (e.type === 'pointerdown') {
        const pe = e as PointerEvent;
        if (pe.button === 2) { end(); return true; }
        start = local(pe);
        deselect = pe.button === 1 || pe.shiftKey;
        v.feedback = { rect: [start[0], start[1], start[0], start[1]] };
        v.redraw();
        return true;
      }
      if (e.type === 'pointermove') {
        const p = local(e as PointerEvent);
        if (start) v.feedback = { rect: [start[0], start[1], p[0], p[1]] };
        else v.feedback = { line: [p[0], 0, p[0], 100000] };
        v.redraw();
        return true;
      }
      if (e.type === 'pointerup' && start) {
        const p = local(e as PointerEvent);
        const x0 = Math.min(start[0], p[0]), x1 = Math.max(start[0], p[0]), y0 = Math.min(start[1], p[1]), y1 = Math.max(start[1], p[1]);
        const c = uvContext();
        if (c) {
          const { corners, kind } = cornersWhere(v, c.md, c.layer, (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1);
          applyRegion(c.md, c.layer, corners, kind, !deselect);
          done(c.md);
          app.pushUndo('Border Select');
          app.report('OPERATOR', `bpy.ops.uv.select_border(gesture_mode=${deselect ? 4 : 3}, xmin=${Math.round(x0)}, xmax=${Math.round(x1)}, ymin=${Math.round(y0)}, ymax=${Math.round(y1)}, extend=True)`);
        }
        end();
        return true;
      }
      if (e.type === 'keydown' && (e as KeyboardEvent).key === 'Escape') { end(); return true; }
      return true;
    },
  };
  app.startModal(h);
}

/** C: circle select (LMB paint selects, MMB / Shift deselects, wheel / +- radius, RMB / Esc ends). */
export function startUVCircleSelect(v: UVEditorView, state: { radius: number }): void {
  if (!uvContext()) return;
  let painting: 'SELECT' | 'DESELECT' | null = null;
  const r0 = v.canvasRect();
  let pos: [number, number] = [app.mouse.x - r0.left, app.mouse.y - r0.top];
  const local = (e: PointerEvent): [number, number] => { const r = v.canvasRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const show = () => { v.feedback = { circle: { x: pos[0], y: pos[1], r: state.radius } }; v.redraw(); };
  const apply = () => {
    const c = uvContext();
    if (!c || !painting) return;
    const rr = state.radius;
    const { corners, kind } = cornersWhere(v, c.md, c.layer, (x, y) => Math.hypot(x - pos[0], y - pos[1]) <= rr);
    if (corners.length) { applyRegion(c.md, c.layer, corners, kind, painting === 'SELECT'); done(c.md); }
  };
  let changed = false;
  const end = () => { v.feedback = null; app.endModal(h); if (changed) app.pushUndo('Circle Select'); v.redraw(); };
  const h: ModalHandler = {
    status: () => 'Circle Select: LMB select, MMB / Shift+LMB deselect, wheel to change size, RMB / Esc / Enter to finish',
    cursor: 'crosshair',
    cancel: end,
    onEvent(e) {
      if (e.type === 'pointermove') { pos = local(e as PointerEvent); if (painting) { apply(); changed = true; } show(); return true; }
      if (e.type === 'pointerdown') {
        const pe = e as PointerEvent;
        if (pe.button === 2) { end(); return true; }
        pos = local(pe);
        painting = pe.button === 1 || pe.shiftKey ? 'DESELECT' : 'SELECT';
        apply(); changed = true; show();
        return true;
      }
      if (e.type === 'pointerup') { painting = null; return true; }
      if (e.type === 'wheel') { state.radius = Math.max(4, Math.min(500, state.radius * ((e as WheelEvent).deltaY < 0 ? 1.1 : 0.9))); show(); return true; }
      if (e.type === 'keydown') {
        const k = (e as KeyboardEvent).key;
        if (k === 'Escape' || k === 'Enter') end();
        if (k === '+' || k === '=') { state.radius = Math.min(500, state.radius * 1.1); show(); }
        if (k === '-') { state.radius = Math.max(4, state.radius * 0.9); show(); }
        return true;
      }
      return true;
    },
  };
  app.startModal(h);
  show();
}

// ------------------------------------------------------------------ transforms

export type UVTransformMode = 'TRANSLATION' | 'ROTATION' | 'RESIZE';

interface Elem { f: number; k: number; u: number; v: number; cu: number; cv: number }

/** Selected corners with their pivot (per-island centres for Individual Origins). */
function gatherElems(md: MeshData, layer: MeshUVLayer): Elem[] {
  const sel = selectedCorners(md, layer);
  const pivot = uvSettings().pivot;
  const elems: Elem[] = sel.map(([f, k]) => { const p = cornerUV(layer, f, k); return { f, k, u: p[0], v: p[1], cu: 0, cv: 0 }; });
  if (!elems.length) return elems;
  if (pivot === 'INDIVIDUAL_ORIGINS') {
    const islands = uvIslands(md, layer, visibleFaces(md));
    const islandOf = new Map<number, number>();
    islands.forEach((isl, i) => isl.forEach((f) => islandOf.set(f, i)));
    const acc = new Map<number, [number, number, number]>();
    for (const e of elems) { const i = islandOf.get(e.f) ?? -1; const a = acc.get(i) ?? [0, 0, 0]; a[0] += e.u; a[1] += e.v; a[2]++; acc.set(i, a); }
    for (const e of elems) { const a = acc.get(islandOf.get(e.f) ?? -1)!; e.cu = a[0] / a[2]; e.cv = a[1] / a[2]; }
    return elems;
  }
  let cu = 0, cv = 0;
  if (pivot === 'CURSOR') [cu, cv] = uvSettings().cursor;
  else if (pivot === 'MEDIAN_POINT') { for (const e of elems) { cu += e.u; cv += e.v; } cu /= elems.length; cv /= elems.length; }
  else {
    let mnu = Infinity, mxu = -Infinity, mnv = Infinity, mxv = -Infinity;
    for (const e of elems) { mnu = Math.min(mnu, e.u); mxu = Math.max(mxu, e.u); mnv = Math.min(mnv, e.v); mxv = Math.max(mxv, e.v); }
    cu = (mnu + mxu) / 2; cv = (mnv + mxv) / 2;
  }
  for (const e of elems) { e.cu = cu; e.cv = cv; }
  return elems;
}

/** Apply a transform to the gathered elements (rotation / scale in pixel space for the aspect). */
function applyTransform(layer: MeshUVLayer, elems: Elem[], mode: UVTransformMode, value: number[], aspect: number): void {
  for (const e of elems) {
    let u = e.u, v = e.v;
    if (mode === 'TRANSLATION') { u += value[0]; v += value[1]; }
    else if (mode === 'ROTATION') {
      const c = Math.cos(value[0]), s = Math.sin(value[0]);
      const x = (e.u - e.cu) * aspect, y = e.v - e.cv;
      u = e.cu + (x * c - y * s) / aspect; v = e.cv + x * s + y * c;
    } else { u = e.cu + (e.u - e.cu) * value[0]; v = e.cv + (e.v - e.cv) * value[1]; }
    const a = layer.uv[e.f];
    if (a) { a[e.k * 2] = u; a[e.k * 2 + 1] = v; }
  }
}

const OP_IDS: Record<UVTransformMode, [string, string]> = { TRANSLATION: ['transform.translate', 'Translate'], ROTATION: ['transform.rotate', 'Rotate'], RESIZE: ['transform.resize', 'Resize'] };

function aspectOf(ctx: OpContext | null): number {
  const st = ctx?.area?.editor as { imageAspect?: () => number } | undefined;
  return st?.imageAspect ? st.imageAspect() : 1;
}

/** Operator definition used to log, undo and re-run (Adjust Last Operation) a UV transform. */
function transformDef(mode: UVTransformMode): OperatorDef {
  const [id, label] = OP_IDS[mode];
  const props: OperatorDef['props'] = mode === 'ROTATION'
    ? { value: { name: 'Angle', type: 'float', default: 0, subtype: 'ANGLE' }, constraint_axis: { name: 'Constraint Axis', type: 'bools', default: [false, false, false], size: 3 } }
    : { value: { name: mode === 'TRANSLATION' ? 'Vector' : 'Vector', type: 'vector', default: mode === 'TRANSLATION' ? [0, 0, 0] : [1, 1, 1], size: 3, subtype: mode === 'TRANSLATION' ? 'TRANSLATION' : 'XYZ' }, constraint_axis: { name: 'Constraint Axis', type: 'bools', default: [false, false, false], size: 3 } };
  return {
    id, label, undo: true, register: true, props,
    exec: (ctx, p) => {
      const c = uvContext();
      if (!c) return 'CANCELLED';
      const elems = gatherElems(c.md, c.layer);
      const val = Array.isArray(p.value) ? (p.value as number[]) : [Number(p.value)];
      applyTransform(c.layer, elems, mode, mode === 'ROTATION' ? [Number(val[0])] : [val[0], val[1]], aspectOf(ctx));
      done(c.md);
      return 'FINISHED';
    },
  };
}

/** Run a UV transform non-interactively (menus: Mirror X/Y, ...). */
export function uvTransformExec(area: AreaLike | null, mode: UVTransformMode, props: OpProps, idOverride?: [string, string]): void {
  const def = transformDef(mode);
  if (idOverride) { def.id = idOverride[0]; def.label = idOverride[1]; }
  const ctx: OpContext = { app, area };
  const full = app.defaultProps(def, props);
  if (def.exec!(ctx, full) === 'FINISHED') app.finishOperator(def, full, ctx);
}

/** G / R / S in the UV editor. */
export function startUVTransform(v: UVEditorView, mode: UVTransformMode, opts: { releaseConfirm?: boolean } = {}): void {
  const c = uvContext();
  if (!c) return;
  const { md, layer } = c;
  const elems = gatherElems(md, layer);
  if (!elems.length) return;
  const aspect = (() => { const [w, h] = v.imageSize(); return h > 0 ? w / h : 1; })();
  const r0 = v.canvasRect();
  const start: [number, number] = [app.mouse.x - r0.left, app.mouse.y - r0.top];
  const pc = v.uvToScreen(elems[0].cu, elems[0].cv);
  let constraint: 0 | 1 | null = null;
  let typed = '';
  let value: number[] = mode === 'RESIZE' ? [1, 1] : [0, 0];
  let lastMouse = start;
  let precise = false;
  let snap = false;
  // accumulate with precision handling
  let base = start;
  let acc = mode === 'RESIZE' ? [1, 1] : [0, 0];
  const [iw, ih] = v.imageSize();
  const compute = (m: [number, number]) => {
    if (typed) {
      const n = parseFloat(typed);
      const x = isFinite(n) ? n : 0;
      if (mode === 'TRANSLATION') {
        // typed values are pixels like Blender's UV editor
        const du = x / iw, dv = x / ih;
        value = constraint === 1 ? [0, dv] : constraint === 0 ? [du, 0] : [du, 0];
      } else if (mode === 'ROTATION') value = [(x * Math.PI) / 180];
      else value = constraint === 0 ? [x, 1] : constraint === 1 ? [1, x] : [x, x];
      return;
    }
    const f = precise ? 0.1 : 1;
    if (mode === 'TRANSLATION') {
      const a = v.screenToUV(base[0], base[1]), b = v.screenToUV(m[0], m[1]);
      let du = acc[0] + (b[0] - a[0]) * f, dv = acc[1] + (b[1] - a[1]) * f;
      if (snap) { du = Math.round(du * iw) / iw; dv = Math.round(dv * ih) / ih; }
      value = [constraint === 1 ? 0 : du, constraint === 0 ? 0 : dv];
    } else if (mode === 'ROTATION') {
      const a0 = Math.atan2(start[1] - pc[1], start[0] - pc[0]);
      const a1 = Math.atan2(m[1] - pc[1], m[0] - pc[0]);
      let ang = -(a1 - a0);
      if (snap) ang = Math.round(ang / (Math.PI / 36)) * (Math.PI / 36);
      value = [ang];
    } else {
      const d0 = Math.hypot(base[0] - pc[0], base[1] - pc[1]) || 1;
      const d1 = Math.hypot(m[0] - pc[0], m[1] - pc[1]);
      let s = acc[0] * (1 + (d1 / d0 - 1) * f);
      if (snap) s = Math.round(s * 10) / 10;
      value = constraint === 0 ? [s, 1] : constraint === 1 ? [1, s] : [s, s];
    }
  };
  const apply = () => { applyTransform(layer, elems, mode, value, aspect); done(md); v.redraw(); };
  const restore = () => { for (const e of elems) { const a = layer.uv[e.f]; if (a) { a[e.k * 2] = e.u; a[e.k * 2 + 1] = e.v; } } done(md); };
  const finish = (ok: boolean) => {
    app.endModal(h);
    v.feedback = null;
    if (!ok) { restore(); v.redraw(); return; }
    const def = transformDef(mode);
    const ax = [constraint === 0, constraint === 1, false];
    const props: OpProps = mode === 'ROTATION' ? { value: value[0], constraint_axis: ax } : { value: [value[0], value[1], mode === 'RESIZE' ? 1 : 0], constraint_axis: ax };
    app.finishOperator(def, props, { app, area: v.area });
    v.redraw();
  };
  const status = () => {
    const ax = constraint === null ? '' : constraint === 0 ? ' along X' : ' along Y';
    if (mode === 'TRANSLATION') return `D: ${(value[0] * iw).toFixed(2)} | ${(value[1] * ih).toFixed(2)} px${ax}${typed ? ` [${typed}]` : ''}`;
    if (mode === 'ROTATION') return `Rot: ${((value[0] * 180) / Math.PI).toFixed(2)}°${typed ? ` [${typed}]` : ''}`;
    return `Scale X: ${value[0].toFixed(4)}  Y: ${value[1].toFixed(4)}${ax}${typed ? ` [${typed}]` : ''}`;
  };
  const h: ModalHandler = {
    status,
    cursor: mode === 'TRANSLATION' ? 'move' : 'crosshair',
    cancel: () => finish(false),
    onEvent(e) {
      const r = v.canvasRect();
      if (e.type === 'pointermove') {
        const pe = e as PointerEvent;
        const m: [number, number] = [pe.clientX - r.left, pe.clientY - r.top];
        if (pe.shiftKey !== precise) {
          // re-base so that toggling precision does not jump
          compute(lastMouse);
          acc = mode === 'RESIZE' ? [value[0] || 1, value[1] || 1] : [value[0], value[1]];
          base = lastMouse;
          precise = pe.shiftKey;
        }
        snap = pe.ctrlKey;
        lastMouse = m;
        compute(m);
        if (mode !== 'TRANSLATION') v.feedback = { line: [pc[0], pc[1], m[0], m[1]] };
        apply();
        app.notify('screen');
        return true;
      }
      if (e.type === 'pointerdown') {
        const pe = e as PointerEvent;
        finish(pe.button === 0);
        return true;
      }
      if (e.type === 'pointerup' && opts.releaseConfirm) { finish(true); return true; }
      if (e.type === 'keydown') {
        const ke = e as KeyboardEvent;
        const k = ke.key;
        if (k === 'Escape') { finish(false); return true; }
        if (k === 'Enter') { finish(true); return true; }
        if (k === 'x' || k === 'X') { constraint = constraint === 0 ? null : 0; }
        else if (k === 'y' || k === 'Y') { constraint = constraint === 1 ? null : 1; }
        else if (/^[0-9.]$/.test(k)) typed += k;
        else if (k === '-') typed = typed.startsWith('-') ? typed.slice(1) : `-${typed}`;
        else if (k === 'Backspace') typed = typed.slice(0, -1);
        else if (k === 'Control') snap = true;
        else return true;
        compute(lastMouse);
        apply();
        app.notify('screen');
        return true;
      }
      if (e.type === 'keyup') { if ((e as KeyboardEvent).key === 'Control') { snap = false; compute(lastMouse); apply(); } return true; }
      return true;
    },
  };
  app.startModal(h);
  compute(start);
}
