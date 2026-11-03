// Interactive (modal) mesh tools of the 3D View: Bevel (Ctrl+B), Edge Slide, Vertex Slide (Shift+V),
// Shear, Push/Pull and the Bisect line. Each modal previews by re-running its operator's `exec` on a
// snapshot of the mesh; confirming restores the snapshot and calls the operator for real (undo step,
// redo panel, Info log, mesh layer remapping).

import { Matrix3, Vector3 } from 'three';
import { app, operatorHooks, type ModalHandler, type OpContext, type OpProps, type OperatorDef } from '../../app';
import type { MeshData } from '../../core/types';
import { ensureArrays, deselectHidden, selectModeOf } from '../../core/mesh';
import type { View3D } from './view3d';
import { edgeSlideRails, vertNeighbours } from '../../core/meshtools';
import { overlayDrawers } from './overlay';

// ------------------------------------------------------------------ helpers

export function snapshotMesh(md: MeshData): string { return JSON.stringify(md); }

/** Restore a mesh in place from a JSON snapshot (keys added since are removed). */
export function restoreMesh(md: MeshData, snap: string): void {
  const s = JSON.parse(snap) as Record<string, unknown>;
  const m = md as unknown as Record<string, unknown>;
  for (const k of Object.keys(m)) if (!(k in s)) delete m[k];
  Object.assign(m, s);
}

/** Run `fn` like an operator call, so mesh layers (UVs, weights, ...) follow topology changes. */
export function withOperatorHooks<T>(def: OperatorDef, ctx: OpContext, fn: () => T): T {
  const tokens = operatorHooks.map((h) => h.before?.(def, ctx));
  let res: T;
  try { res = fn(); } finally {
    operatorHooks.forEach((h, i) => { try { h.after?.(def, ctx, tokens[i], 'FINISHED'); } catch (e) { console.error(e); } });
  }
  return res;
}

export function meshDone(): void {
  const m = app.editMesh;
  if (m) { ensureArrays(m); deselectHidden(m, selectModeOf(app.scene.toolSettings.meshSelectMode)); app.tagGeometry(m.id); }
  app.notify('geometry', 'select');
}

/** Typed numeric input of a modal operator (digits, '.', '-', simple expressions). */
export class NumInput {
  text = '';
  get active(): boolean { return this.text.length > 0; }
  value(): number | null {
    if (!this.text) return null;
    try {
      const v = Number(Function(`"use strict";return (${this.text.replace(/[^0-9+\-*/.() e]/g, '')})`)());
      return isFinite(v) ? v : null;
    } catch { return null; }
  }
  /** Feed a key; returns true when it was consumed. */
  key(e: KeyboardEvent): boolean {
    const k = e.key;
    if (/^[0-9.]$/.test(k) || k === '-' || ['*', '/', '+', '(', ')'].includes(k) && this.text) { this.text += k; return true; }
    if (k === 'Backspace') { this.text = e.ctrlKey ? '' : this.text.slice(0, -1); return true; }
    return false;
  }
  show(fallback: string): string { return this.text ? `[${this.text}|]` : fallback; }
}

export interface PreviewModal {
  view: View3D;
  opId: string;
  props: OpProps;
  /** Header text. */
  status: () => string;
  /** Compute props from the mouse (viewport coordinates). Return false to skip the preview. */
  mouse?: (x: number, y: number, e: PointerEvent) => boolean | void;
  /** Extra keys; return true when handled (the preview is re-run). */
  key?: (e: KeyboardEvent) => boolean;
  wheel?: (e: WheelEvent) => boolean;
  /** Pivot for the dashed helper line (world space). */
  center?: Vector3;
  cursor?: string;
  onEnd?: (ok: boolean) => void;
}

/** Generic preview modal: re-runs `opId`'s exec on every change, confirms through the operator system. */
export function runPreviewModal(o: PreviewModal): void {
  const md = app.editMesh;
  const def = app.operator(o.opId);
  if (!md || !def?.exec) return;
  const snap = snapshotMesh(md);
  const ctx: OpContext = { app, area: o.view.area };
  const view = o.view;
  const preview = () => {
    const m = app.editMesh;
    if (!m) return;
    restoreMesh(m, snap);
    try { withOperatorHooks(def, ctx, () => def.exec!(ctx, o.props)); } catch (err) { console.error(err); restoreMesh(m, snap); }
    meshDone();
    view.requestRender();
  };
  const end = (ok: boolean) => {
    app.endModal(h);
    view.transformState = null;
    const m = app.editMesh;
    if (m) restoreMesh(m, snap);
    meshDone();
    if (ok) void app.callOperator(o.opId, o.props, { area: view.area, exec: true }).then(() => o.onEnd?.(true));
    else o.onEnd?.(false);
    view.requestRender();
  };
  const h: ModalHandler = {
    status: o.status,
    cursor: o.cursor,
    cancel: () => end(false),
    onEvent(e) {
      const r = view.canvasRect();
      if (e.type === 'pointermove') {
        const pe = e as PointerEvent;
        if (o.mouse && o.mouse(pe.clientX - r.left, pe.clientY - r.top, pe) !== false) preview();
        return true;
      }
      if (e.type === 'pointerdown') {
        const pe = e as PointerEvent;
        end(pe.button === 0);
        return true;
      }
      if (e.type === 'wheel') { if (o.wheel?.(e as WheelEvent)) preview(); return true; }
      if (e.type === 'keydown') {
        const ke = e as KeyboardEvent;
        if (ke.key === 'Escape') { end(false); return true; }
        if (ke.key === 'Enter' || ke.key === ' ' || ke.code === 'NumpadEnter') { end(true); return true; }
        if (o.key?.(ke)) preview();
        return true;
      }
      return e.type === 'contextmenu' || e.type === 'pointerup';
    },
  };
  app.startModal(h);
  const c = o.center ?? new Vector3();
  view.transformState = { center: () => c, constraint: () => null, orient: () => new Matrix3(), mode: () => (o.center ? 'RESIZE' : 'TRANSLATION'), propSize: () => 0 };
  preview();
}

/** Median of the selected verts of the edit mesh in world space. */
export function selectionCenterWorld(): Vector3 | null {
  const md = app.editMesh, ob = app.editObj;
  if (!md || !ob) return null;
  const w = app.matrices.world(ob);
  const c = new Vector3();
  let n = 0;
  md.verts.forEach((v, i) => { if (md.vsel[i]) { c.add(new Vector3(v[0], v[1], v[2]).applyMatrix4(w)); n++; } });
  return n ? c.multiplyScalar(1 / n) : null;
}

const mouseIn = (view: View3D) => { const r = view.canvasRect(); return { x: app.mouse.x - r.left, y: app.mouse.y - r.top }; };

// ------------------------------------------------------------------ bevel

export function startBevelModal(view: View3D, vertexOnly: boolean, base: OpProps): void {
  const center = selectionCenterWorld();
  if (!center) return;
  const pc = view.view.project(center);
  const m0 = mouseIn(view);
  const startDist = Math.hypot(m0.x - pc.x, m0.y - pc.y);
  const props: OpProps = { ...base, vertex_only: vertexOnly, offset: 0 };
  const num = new NumInput();
  let precision = false, lastDist = startDist, offset = 0;
  let profileMode = false;
  const ps = () => view.view.pixelSize(center);
  const status = () => {
    const off = num.show(Number(props.offset).toFixed(4));
    return `Mode: ${props.offset_type === 'PERCENT' ? 'Percent' : props.offset_type === 'WIDTH' ? 'Width' : props.offset_type === 'DEPTH' ? 'Depth' : 'Offset'} (M), ${profileMode ? `Profile: ${Number(props.profile).toFixed(3)}` : `Offset: ${off}`}, Segments: ${props.segments}, Profile (P): ${Number(props.profile).toFixed(3)}, Vertex Only (V): ${props.vertex_only ? 'On' : 'Off'}, Clamp Overlap (C): ${props.clamp_overlap ? 'On' : 'Off'}, Loop Slide (S): ${props.loop_slide ? 'On' : 'Off'}`;
  };
  runPreviewModal({
    view, opId: 'mesh.bevel', props, status, center,
    mouse: (x, y, e) => {
      if (num.active) return false;
      const d = Math.hypot(x - pc.x, y - pc.y);
      if (e.shiftKey !== precision) { precision = e.shiftKey; lastDist = d; }
      const delta = (d - lastDist) * (precision ? 0.1 : 1);
      lastDist = d;
      if (profileMode) { props.profile = Math.min(1, Math.max(0.15, Number(props.profile) + delta / 200)); return true; }
      offset = Math.max(0, offset + delta * (props.offset_type === 'PERCENT' ? 0.25 : ps()));
      props.offset = e.ctrlKey ? Math.round(offset * 10) / 10 : offset;
      return true;
    },
    wheel: (e) => { props.segments = Math.max(1, Math.min(1000, Number(props.segments) + (e.deltaY < 0 ? 1 : -1))); return true; },
    key: (e) => {
      const k = e.key.toLowerCase();
      if (e.key === 'PageUp' || (e.key === '+' && !num.active)) { props.segments = Math.min(1000, Number(props.segments) + 1); return true; }
      if (e.key === 'PageDown') { props.segments = Math.max(1, Number(props.segments) - 1); return true; }
      if (num.key(e)) { const v = num.value(); if (v !== null) props.offset = Math.max(0, v); return true; }
      if (k === 'v') { props.vertex_only = !props.vertex_only; return true; }
      if (k === 'c') { props.clamp_overlap = !props.clamp_overlap; return true; }
      if (k === 's') { props.loop_slide = !props.loop_slide; return true; }
      if (k === 'p') { profileMode = !profileMode; return true; }
      if (k === 'm') {
        const types = ['OFFSET', 'WIDTH', 'DEPTH', 'PERCENT'];
        props.offset_type = types[(types.indexOf(String(props.offset_type)) + 1) % types.length];
        return true;
      }
      return false;
    },
  });
}

// ------------------------------------------------------------------ simple value modals (shear, push/pull, slide)

/**
 * A modal that maps the mouse to one float property `value` of an operator: `fromMouse` turns the
 * viewport mouse position into the value (precision with Shift, typed numbers override it).
 */
export function startValueModal(view: View3D, opId: string, label: string, props: OpProps, fromMouse: (x: number, y: number) => number, opts: { center?: Vector3; snap?: number; key?: (e: KeyboardEvent) => boolean; extra?: () => string } = {}): void {
  const num = new NumInput();
  const m0 = mouseIn(view);
  let anchor = { ...m0 }, base = { ...m0 }, precision = false;
  runPreviewModal({
    view, opId, props, center: opts.center,
    status: () => `${label}: ${num.show(Number(props.value).toFixed(4))}${opts.extra ? opts.extra() : ''}`,
    mouse: (x, y, e) => {
      if (num.active) return false;
      if (e.shiftKey !== precision) {
        if (e.shiftKey) { anchor = { x, y }; } else { base = { x: base.x + (x - anchor.x) * 0.1, y: base.y + (y - anchor.y) * 0.1 }; anchor = { x, y }; }
        precision = e.shiftKey;
      }
      const ex = precision ? base.x + (x - anchor.x) * 0.1 : base.x + (x - anchor.x);
      const ey = precision ? base.y + (y - anchor.y) * 0.1 : base.y + (y - anchor.y);
      let v = fromMouse(ex, ey);
      if (e.ctrlKey && opts.snap) v = Math.round(v / opts.snap) * opts.snap;
      props.value = v;
      return true;
    },
    key: (e) => {
      if (num.key(e)) { const v = num.value(); if (v !== null) props.value = v; return true; }
      return opts.key?.(e) ?? false;
    },
  });
}

// ------------------------------------------------------------------ edge slide / vertex slide


const worldOf = (p: number[]): Vector3 => new Vector3(p[0], p[1], p[2]).applyMatrix4(app.matrices.world(app.editObj!));

export function startEdgeSlide(view: View3D): boolean {
  const md = app.editMesh;
  if (!md) return false;
  const rails = edgeSlideRails(md);
  if (!rails) { app.report('ERROR', 'Invalid selection: select edges with faces on either side to slide'); return false; }
  const m0 = mouseIn(view);
  // reference vertex: the rail vertex nearest the mouse
  let ref = -1, bd = Infinity;
  for (const v of rails.rails.keys()) { const s = view.view.project(worldOf(md.verts[v])); const d = Math.hypot(s.x - m0.x, s.y - m0.y); if (d < bd) { bd = d; ref = v; } }
  const [A, B] = rails.rails.get(ref)!;
  const s0 = view.view.project(worldOf(md.verts[ref]));
  const sA = A ? view.view.project(worldOf(A)) : null, sB = B ? view.view.project(worldOf(B)) : null;
  const props: OpProps = { value: 0, use_even: false, flipped: false, use_clamp: true };
  const along = (s: { x: number; y: number } | null, x: number, y: number) => {
    if (!s) return -Infinity;
    const vx = s.x - s0.x, vy = s.y - s0.y, l2 = vx * vx + vy * vy;
    return l2 > 1e-6 ? ((x - m0.x) * vx + (y - m0.y) * vy) / l2 : -Infinity;
  };
  startValueModal(view, 'transform.edge_slide', 'Edge Slide', props, (x, y) => {
    const fa = along(sA, x, y), fb = along(sB, x, y);
    const v = fa >= fb ? fa : -fb;
    return props.use_clamp ? Math.max(-1, Math.min(1, v)) : v;
  }, {
    snap: 0.1,
    extra: () => `   (E)ven: ${props.use_even ? 'ON' : 'OFF'}, (F)lipped: ${props.flipped ? 'ON' : 'OFF'}, Alt or (C)lamp: ${props.use_clamp ? 'ON' : 'OFF'}`,
    key: (e) => {
      const k = e.key.toLowerCase();
      if (k === 'e') { props.use_even = !props.use_even; return true; }
      if (k === 'f') { props.flipped = !props.flipped; return true; }
      if (k === 'c' || e.key === 'Alt') { props.use_clamp = !props.use_clamp; return true; }
      return false;
    },
  });
  return true;
}

export function startVertexSlide(view: View3D): boolean {
  const md = app.editMesh;
  if (!md) return false;
  const sel = md.vsel.map((s, i) => (s ? i : -1)).filter((i) => i >= 0);
  if (!sel.length) return false;
  const m0 = mouseIn(view);
  let ref = sel[0], bd = Infinity;
  for (const v of sel) { const s = view.view.project(worldOf(md.verts[v])); const d = Math.hypot(s.x - m0.x, s.y - m0.y); if (d < bd) { bd = d; ref = v; } }
  const nbrs = vertNeighbours(md, ref);
  if (!nbrs.length) return false;
  const sv = view.view.project(worldOf(md.verts[ref]));
  const props: OpProps = { value: 0, direction: [0, 0, 0], use_even: false, flipped: false };
  startValueModal(view, 'transform.vert_slide', 'Vertex Slide', props, (x, y) => {
    // the edge whose screen direction matches the mouse best
    let best = nbrs[0], bs = -Infinity, bl2 = 1;
    for (const u of nbrs) {
      const su = view.view.project(worldOf(md.verts[u]));
      const vx = su.x - sv.x, vy = su.y - sv.y, l = Math.hypot(vx, vy);
      if (l < 1e-6) continue;
      const mx = x - sv.x, my = y - sv.y, ml = Math.hypot(mx, my) || 1;
      const sc = (vx * mx + vy * my) / (l * ml);
      if (sc > bs) { bs = sc; best = u; bl2 = l * l; }
    }
    const su = view.view.project(worldOf(md.verts[best]));
    const p = md.verts[ref], q = md.verts[best];
    props.direction = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
    return Math.max(0, Math.min(1, ((x - sv.x) * (su.x - sv.x) + (y - sv.y) * (su.y - sv.y)) / bl2));
  });
  return true;
}

// ------------------------------------------------------------------ shear / push-pull

export function startShear(view: View3D): boolean {
  const center = selectionCenterWorld();
  if (!center) return false;
  const right = view.view.viewRight(), up = view.view.viewUp();
  const m0 = mouseIn(view);
  const props: OpProps = { value: 0, axis: [right.x, right.y, right.z], axis_ortho: [up.x, up.y, up.z], center: [center.x, center.y, center.z] };
  startValueModal(view, 'transform.shear', 'Shear', props, (x) => (x - m0.x) / 100, { center, snap: 0.05 });
  return true;
}

export function startPushPull(view: View3D): boolean {
  const center = selectionCenterWorld();
  if (!center) return false;
  const pc = view.view.project(center);
  const m0 = mouseIn(view);
  const d0 = Math.hypot(m0.x - pc.x, m0.y - pc.y);
  const ps = view.view.pixelSize(center);
  const props: OpProps = { value: 0, center: [center.x, center.y, center.z] };
  startValueModal(view, 'transform.push_pull', 'Push/Pull', props, (x, y) => (d0 - Math.hypot(x - pc.x, y - pc.y)) * ps, { center, snap: 0.1 });
  return true;
}

// ------------------------------------------------------------------ bisect line

let lineGesture: { view: View3D; a: { x: number; y: number }; b: { x: number; y: number } | null } | null = null;
overlayDrawers.push((view, ctx) => {
  const g = lineGesture;
  if (!g || g.view !== view || !g.b) return;
  ctx.save();
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#000';
  ctx.beginPath(); ctx.moveTo(g.a.x + 1, g.a.y + 1); ctx.lineTo(g.b.x + 1, g.b.y + 1); ctx.stroke();
  ctx.strokeStyle = '#fff';
  ctx.beginPath(); ctx.moveTo(g.a.x, g.a.y); ctx.lineTo(g.b.x, g.b.y); ctx.stroke();
  ctx.restore();
});

/**
 * Straight-line gesture (Bisect): press LMB, drag, release. Calls `done` with the two viewport points.
 */
export function startLineGesture(view: View3D, label: string, done: (a: { x: number; y: number }, b: { x: number; y: number }) => void): void {
  let pressed = false;
  const end = (ok: boolean) => {
    app.endModal(h);
    const g = lineGesture;
    lineGesture = null;
    view.transformState = null;
    view.requestRender();
    if (ok && g?.b && Math.hypot(g.b.x - g.a.x, g.b.y - g.a.y) > 3) done(g.a, g.b);
  };
  const h: ModalHandler = {
    cursor: 'crosshair',
    status: () => `${label}: drag a line with LMB, Esc or RMB to cancel`,
    cancel: () => end(false),
    onEvent(e) {
      const r = view.canvasRect();
      if (e.type === 'pointerdown') {
        const pe = e as PointerEvent;
        if (pe.button !== 0) { end(false); return true; }
        pressed = true;
        lineGesture = { view, a: { x: pe.clientX - r.left, y: pe.clientY - r.top }, b: null };
        return true;
      }
      if (e.type === 'pointermove') {
        if (pressed && lineGesture) { const pe = e as PointerEvent; lineGesture.b = { x: pe.clientX - r.left, y: pe.clientY - r.top }; view.requestRender(); }
        return true;
      }
      if (e.type === 'pointerup') { if (pressed) end(true); return true; }
      if (e.type === 'keydown') { if ((e as KeyboardEvent).key === 'Escape') end(false); return true; }
      return true;
    },
  };
  app.startModal(h);
  view.transformState = { center: () => new Vector3(), constraint: () => null, orient: () => new Matrix3(), mode: () => 'TRANSLATION', propSize: () => 0 };
}
