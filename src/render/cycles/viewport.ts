// Cycles "Rendered" viewport shading: progressive preview samples that restart on any change
// (view, objects, materials, lamps, world, settings), starting at a coarse resolution and
// refining (Performance > Viewport > Start Resolution), with the work split across animation
// frames by an adaptive GPU budget. The image is handed to the viewport's three.js renderer as a
// texture (ViewportRenderer.externalImage) so wires, lamps and overlays still draw on top.

import { CanvasTexture, LinearFilter, Matrix4, NearestFilter, SRGBColorSpace } from 'three';
import { app } from '../../app';
import type { View3D } from '../../editors/view3d/view3d';
import { finalRenderActive, formatTime, totalSamples } from './engine';
import { isCycles, sceneSettings } from './settings';
import { frameSeed, getTracer, GpuBudget, type Accum, type CameraRays, type PathTracer } from './tracer';

interface ViewportState {
  /** Accumulation targets by resolution divider. */
  accs: Map<number, Accum>;
  divider: number;
  camKey: string;
  version: number;
  changeCount: number;
  started: number;
  tex: CanvasTexture;
  budget: GpuBudget;
  status: string;
  lastSamples: number;
  hasImage: boolean;
}

const states = new Map<View3D, ViewportState>();

/** Incremented on every document change that can affect the render (not on view-only changes). */
let changeCount = 0;
let subscribed = false;
const IGNORED = new Set(['view', 'reports', 'screen', 'prefs', 'select']);

function subscribe(): void {
  if (subscribed) return;
  subscribed = true;
  app.onChange((flags) => {
    for (const f of flags) if (!IGNORED.has(f)) { changeCount++; break; }
  });
}

function freeState(v: View3D, st: ViewportState): void {
  try {
    const tr = getTracer();
    for (const a of st.accs.values()) tr.freeAccum(a);
  } catch { /* no WebGL 2 */ }
  st.tex.dispose();
  states.delete(v);
}

function viewCamera(v: View3D): { rays: CameraRays; key: string } {
  const cam = v.view.camera();
  cam.updateMatrixWorld(true);
  const m = new Matrix4().multiplyMatrices(cam.matrixWorld, cam.projectionMatrixInverse);
  return { rays: { invViewProj: m.elements }, key: Array.from(m.elements, (x) => x.toPrecision(7)).join(',') };
}

/**
 * Called by the 3D View before drawing: advances the progressive render and sets the renderer's
 * external image (or clears it when the view is not in Cycles Rendered shading).
 */
export function cyclesViewportUpdate(v: View3D): void {
  const r = v.renderer;
  const active = v.display.shading === 'RENDERED' && isCycles(app.scene);
  let st = states.get(v);
  if (!active) {
    if (st) freeState(v, st);
    if (r.externalImage) r.externalImage = null;
    return;
  }
  subscribe();
  let tr: PathTracer;
  try { tr = getTracer(); } catch {
    r.externalImage = null;
    return;
  }
  if (!st) {
    const tex = new CanvasTexture(tr.canvas);
    tex.colorSpace = SRGBColorSpace;
    tex.generateMipmaps = false;
    st = { accs: new Map(), divider: 1, camKey: '', version: -1, changeCount: -1, started: performance.now(), tex, budget: new GpuBudget(1 << 22), status: '', lastSamples: -1, hasImage: false };
    states.set(v, st);
  }
  if (!tr.ready()) {
    st.status = tr.error ? 'Error: could not compile the Cycles shaders' : 'Compiling shaders';
    r.externalImage = null;
    if (!tr.error) v.requestRender();
    return;
  }
  if (finalRenderActive) {
    st.status = 'Paused (rendering)';
    v.requestRender();
    return;
  }
  // scene changes
  if (st.changeCount !== changeCount || st.version !== tr.version) {
    try {
      tr.syncScene({ layers: r.viewLayers(), localView: v.localView, onImage: () => { changeCount++; v.requestRender(); } });
    } catch (err) {
      st.status = `Error: ${(err as Error).message}`;
      r.externalImage = null;
      return;
    }
    st.changeCount = changeCount;
  }
  const s = sceneSettings(app.scene);
  const { rays, key } = viewCamera(v);
  const W = Math.max(1, Math.round(v.view.width)), H = Math.max(1, Math.round(v.view.height));
  const camKey = `${key}|${W}x${H}`;
  const restart = camKey !== st.camKey || st.version !== tr.version;
  if (restart) {
    st.camKey = camKey;
    st.version = tr.version;
    st.started = performance.now();
    // start coarse: the longest side about "Start Resolution" pixels, then refine
    const start = Math.max(8, s.previewStartResolution || 64);
    let d = 1;
    while (Math.max(W, H) / (d * 2) >= start && d < 64) d *= 2;
    st.divider = d;
    for (const a of st.accs.values()) a.samples = a.row = 0;
    st.budget.reset(tr.gl);
  }
  const total = totalSamples(s, true);
  const target = total > 0 ? total : 1 << 30;
  const d = st.divider;
  const w = Math.max(1, Math.ceil(W / d)), h = Math.max(1, Math.ceil(H / d));
  let acc = st.accs.get(d);
  if (!acc || acc.dead || acc.w !== w || acc.h !== h) {
    if (acc) tr.freeAccum(acc);
    acc = tr.createAccum(w, h);
    st.accs.set(d, acc);
  }
  if (restart || (acc.samples === 0 && acc.row === 0)) tr.clearAccum(acc);
  let traced = false;
  if (acc.samples < (d > 1 ? 1 : target) && st.budget.ready(tr.gl)) {
    // coarse levels: one whole sample at once; full resolution: as much as the budget allows
    const pixels = d > 1 ? w * h : st.budget.pixels;
    tr.traceBatch(acc, pixels, d > 1 ? 1 : target, rays, s, frameSeed(s));
    st.budget.submitted(tr.gl);
    traced = true;
  }
  if (traced || !st.hasImage || st.lastSamples !== acc.samples) {
    tr.display(acc, w, h, s, { opaque: !s.filmTransparent });
    st.tex.image = tr.canvas;
    const filter = d > 1 ? NearestFilter : LinearFilter;
    if (st.tex.magFilter !== filter) { st.tex.magFilter = filter; st.tex.minFilter = filter; }
    st.tex.needsUpdate = true;
    st.hasImage = true;
    st.lastSamples = acc.samples;
  }
  r.externalImage = st.tex;
  // refine: coarse level finished -> next finer level
  if (d > 1 && acc.samples >= 1) {
    st.divider = d / 2;
    const next = st.accs.get(st.divider);
    if (next) { next.samples = 0; next.row = 0; }
  }
  const shown = d > 1 ? 0 : Math.min(target, acc.samples + (acc.row > 0 ? 1 : 0));
  const time = formatTime(performance.now() - st.started);
  st.status = total > 0 ? `Time:${time} | Path Tracing Sample ${shown}/${total}` : `Time:${time} | Path Tracing Sample ${shown}`;
  if (d > 1 || acc.samples < target) v.requestRender();
}

/** Called after the overlay is drawn: the Cycles status line under the view name. */
export function cyclesViewportOverlay(v: View3D): void {
  const st = states.get(v);
  if (!st || !st.status) return;
  const ctx = v.overlay.getContext('2d');
  if (!ctx) return;
  const dpr = v.renderer.pixelRatio;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = '11px "DejaVu Sans", Verdana, sans-serif';
  ctx.textBaseline = 'alphabetic';
  const y = app.prefs.showViewName ? 36 : 20;
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillText(st.status, 11, y + 1);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(st.status, 10, y);
}

/** Free the GPU resources of views that were closed. */
export function cyclesViewportDestroyed(v: View3D): void {
  const st = states.get(v);
  if (st) freeState(v, st);
}
