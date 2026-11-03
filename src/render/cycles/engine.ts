// Cycles final rendering (F12 / Ctrl+F12): renders the scene camera progressively with the
// shared path tracer, showing the image refine in the Image Editor and 2.79-style progress
// text ("Frame:1 | Time:00:03.12 | Mem:... | Scene, RenderLayer | Path Tracing Sample 12/128").

import { Matrix4 } from 'three';
import { app } from '../../app';
import { ViewState } from '../../editors/view3d/viewstate';
import type { CyclesSceneSettings } from '../../core/types';
import { renderEngines, type EngineRenderContext } from '../render';
import { sceneSettings } from './settings';
import { frameSeed, getTracer, GpuBudget, nextFrame, type Accum, type CameraRays, type PathTracer } from './tracer';

/** True while an F12 render runs (viewport rendering pauses meanwhile). */
export let finalRenderActive = false;

let acc: Accum | null = null;
const budget = new GpuBudget(1 << 24);

/** Total samples per pixel for a render (Square Samples squares the value like Cycles). */
export function totalSamples(s: CyclesSceneSettings, preview: boolean): number {
  const n = preview ? s.previewSamples : s.samples;
  return s.useSquareSamples ? n * n : n;
}

/** Inverse view-projection of the scene camera, framed exactly like the Blender Render result. */
export function renderCamera(w: number, h: number): CameraRays {
  const view = new ViewState();
  view.fitFrame = true;
  view.persp = 'CAMERA';
  view.camOffset.set(0, 0);
  view.setSize(w, h);
  const cam = view.camera();
  cam.updateMatrixWorld(true);
  const m = new Matrix4().multiplyMatrices(cam.matrixWorld, cam.projectionMatrixInverse);
  return { invViewProj: m.elements };
}

export function formatTime(ms: number): string {
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${String(m).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}`;
}

export function formatMem(bytes: number): string {
  return `${(bytes / 1048576).toFixed(2)}M`;
}

/** Blender Render's output post-processing that also applies to Cycles results (BW, stamp). */
function postProcess(out: HTMLCanvasElement): void {
  const rs = app.scene.render;
  const ctx = out.getContext('2d')!;
  const w = out.width, h = out.height;
  if (rs.colorMode === 'BW') {
    const img = ctx.getImageData(0, 0, w, h);
    for (let i = 0; i < img.data.length; i += 4) {
      const l = img.data[i] * 0.2126 + img.data[i + 1] * 0.7152 + img.data[i + 2] * 0.0722;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = l;
    }
    ctx.putImageData(img, 0, 0);
  }
  if (rs.useStamp) {
    const camId = app.scene.camera;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, h - 18, w, 18);
    ctx.fillStyle = '#fff';
    ctx.font = '11px sans-serif';
    ctx.fillText(`${app.doc.filename || 'untitled.blend'} | Frame ${app.scene.frameCurrent} | Camera ${camId ? app.doc.objects[camId]?.name ?? '' : ''}`, 6, h - 5);
  }
}

async function renderCycles(ctx: EngineRenderContext): Promise<HTMLCanvasElement | null> {
  const sc = app.scene;
  if (!sc.camera || !app.doc.objects[sc.camera]) {
    app.report('ERROR', 'No camera found in scene');
    return null;
  }
  let tr: PathTracer;
  try { tr = getTracer(); } catch (err) {
    app.report('ERROR', `Cycles: ${(err as Error).message}`);
    return null;
  }
  finalRenderActive = true;
  const t0 = performance.now();
  const frame = sc.frameCurrent;
  const head = () => `Frame:${frame} | Time:${formatTime(performance.now() - t0)}`;
  try {
    while (!tr.ready()) {
      if (tr.error) { app.report('ERROR', tr.error); return null; }
      ctx.progress(`${head()} | Compiling shaders`);
      await nextFrame();
      if (ctx.cancelled()) return null;
    }
    ctx.progress(`${head()} | Synchronizing object`);
    await nextFrame();
    let status = tr.syncScene();
    const waitStart = performance.now();
    while (status.pendingImages > 0 && performance.now() - waitStart < 15000) {
      ctx.progress(`${head()} | Loading images`);
      await nextFrame();
      if (ctx.cancelled()) return null;
      status = tr.syncScene();
    }
    const s = sceneSettings(sc);
    const total = Math.max(1, totalSamples(s, false));
    const { width: w, height: h } = ctx;
    if (!acc || acc.dead || acc.w !== w || acc.h !== h) {
      tr.freeAccum(acc);
      acc = tr.createAccum(w, h);
    } else tr.clearAccum(acc);
    const a = acc;
    const cam = renderCamera(w, h);
    const seed = frameSeed(s);
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const octx = out.getContext('2d')!;
    const dither = sc.render.ditherIntensity;
    const show = (final: boolean) => {
      const c = tr.display(a, w, h, s, { dither, opaque: !s.filmTransparent, denoise: final && s.useDenoising });
      octx.clearRect(0, 0, w, h);
      octx.drawImage(c, 0, 0);
    };
    const mem = () => formatMem(status.bytes + tr.accumBytes(a));
    budget.reset(tr.gl);
    let lastShow = performance.now();
    while (a.samples < total) {
      if (ctx.cancelled()) break;
      await nextFrame();
      if (tr.lost) { app.report('ERROR', 'Cycles: the WebGL context was lost'); return null; }
      if (!budget.ready(tr.gl)) continue;
      tr.traceBatch(a, budget.pixels, total, cam, s, seed);
      budget.submitted(tr.gl);
      const shown = Math.min(total, a.samples + (a.row > 0 ? 1 : 0));
      ctx.progress(`${head()} | Mem:${mem()}, Peak:${mem()} | ${sc.name}, RenderLayer | Path Tracing Sample ${shown}/${total}`);
      const now = performance.now();
      if (now - lastShow > 400 || a.samples >= total) {
        show(false);
        ctx.update(out);
        lastShow = now;
      }
    }
    if (s.useDenoising && !ctx.cancelled()) ctx.progress(`${head()} | Denoising`);
    show(true);
    postProcess(out);
    ctx.update(out);
    return out;
  } finally {
    finalRenderActive = false;
    // let paused viewports continue
    app.notify('view');
  }
}

renderEngines.CYCLES = { render: renderCycles };
