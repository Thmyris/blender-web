// Offline rendering ("Blender Render" approximation with three.js): renders the
// scene from the active camera at the render resolution into a canvas.

import { app } from '../app';
import { ViewState } from '../editors/view3d/viewstate';
import { ViewportRenderer, defaultDisplay, type Shading } from '../editors/view3d/draw';

export interface RenderResult {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  frame: number;
  time: number;
  /** For animations: recorded video. */
  video?: Blob;
  label: string;
}

export let renderResult: RenderResult | null = null;
export const renderListeners = new Set<() => void>();
export let renderProgress: string | null = null;
let cancelRequested = false;

function setProgress(s: string | null): void {
  renderProgress = s;
  for (const l of renderListeners) l();
}

/** Context handed to an add-on render engine (Cycles) for one frame. */
export interface EngineRenderContext {
  width: number;
  height: number;
  animation: boolean;
  /** Header text while rendering (null clears it). */
  progress(text: string | null): void;
  /** Show an intermediate result in the Image Editor. */
  update(canvas: HTMLCanvasElement): void;
  /** Esc was pressed. */
  cancelled(): boolean;
}

/** A render engine other than Blender Render: renders the current frame (progressively, asynchronously). */
export interface EngineRenderer {
  render(ctx: EngineRenderContext): Promise<HTMLCanvasElement | null>;
}

/** Render engines by `scene.render.engine` id (registered by src/render/cycles). */
export const renderEngines: Partial<Record<string, EngineRenderer>> = {};

function engineContext(t0: number, frame: number, animation: boolean): EngineRenderContext {
  const { w, h } = renderSize();
  return {
    width: w, height: h, animation,
    progress: (s) => setProgress(s),
    cancelled: () => cancelRequested,
    update: (c) => {
      renderResult = { canvas: c, width: c.width, height: c.height, frame, time: performance.now() - t0, label: 'Render Result' };
      for (const l of renderListeners) l();
    },
  };
}

async function renderStillEngine(engine: EngineRenderer): Promise<boolean> {
  cancelRequested = false;
  const t0 = performance.now();
  const frame = app.scene.frameCurrent;
  showResult();
  const ectx = engineContext(t0, frame, false);
  const canvas = frameHook ? await frameHook(() => engine.render(ectx), 'RENDERED', false) : await engine.render(ectx);
  setProgress(null);
  if (!canvas) { app.notify('render'); return false; }
  const time = performance.now() - t0;
  renderResult = { canvas, width: canvas.width, height: canvas.height, frame, time, label: 'Render Result' };
  app.report('INFO', cancelRequested ? 'Render cancelled' : `Rendered frame ${frame} in ${(time / 1000).toFixed(2)} s`);
  for (const l of renderListeners) l();
  app.notify('render');
  return true;
}

/**
 * Post-processing of every rendered frame (compositing nodes, video sequencer; see src/editors/ext_init.ts).
 * `renderScene` renders the active scene's camera view; the hook may call it (several times, e.g. for
 * sequencer scene strips) or not at all, and returns the final frame.
 */
export type FrameHook = (renderScene: () => Promise<HTMLCanvasElement | null>, shading: Shading, animation: boolean) => Promise<HTMLCanvasElement | null>;
let frameHook: FrameHook | null = null;
export function setFrameHook(hook: FrameHook | null): void { frameHook = hook; }

let offscreen: { canvas: HTMLCanvasElement; view: ViewState; r: ViewportRenderer } | null = null;

function getOffscreen(): { canvas: HTMLCanvasElement; view: ViewState; r: ViewportRenderer } {
  if (!offscreen) {
    const canvas = document.createElement('canvas');
    const view = new ViewState();
    const display = { ...defaultDisplay(), shading: 'RENDERED' as Shading, showOnlyRender: true, manipulator: false, showOutlineSelected: false };
    const r = new ViewportRenderer(canvas, view, display, { alpha: true });
    view.fitFrame = true;
    r.pixelRatio = 1;
    r.renderer.setPixelRatio(1);
    offscreen = { canvas, view, r };
  }
  return offscreen;
}

export function renderSize(): { w: number; h: number } {
  const rs = app.scene.render;
  const pct = rs.resolutionPercentage / 100;
  return { w: Math.max(4, Math.round(rs.resolutionX * pct)), h: Math.max(4, Math.round(rs.resolutionY * pct)) };
}

/** Render one frame from the scene camera. `shading` = 'RENDERED' for F12, the viewport shading for OpenGL renders. */
export function renderFrame(shading: Shading = 'RENDERED'): HTMLCanvasElement | null {
  const camId = app.scene.camera;
  if (!camId || !app.doc.objects[camId]) {
    app.report('ERROR', 'No camera found in scene');
    return null;
  }
  const t0 = performance.now();
  const o = getOffscreen();
  const { w, h } = renderSize();
  o.view.persp = 'CAMERA';
  o.view.camOffset.set(0, 0);
  // anti-aliasing: MSAA plus supersampling for the higher sample counts (5/8/11/16 like Blender Internal)
  const rs = app.scene.render;
  const ss = !rs.useAntialiasing ? 1 : rs.antialiasingSamples === '16' ? 2 : rs.antialiasingSamples === '11' ? 1.5 : 1;
  const rw = Math.round(w * ss), rh = Math.round(h * ss);
  o.view.setSize(rw, rh);
  o.r.display.shading = shading;
  o.r.display.showWorld = true;
  o.r.setSize(rw, rh);
  const transparent = app.scene.render.alphaMode === 'TRANSPARENT';
  o.r.transparentBackground = transparent;
  o.r.sync(null);
  o.r.render(null);
  // copy out (the WebGL canvas is reused)
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(o.canvas, 0, 0, rw, rh, 0, 0, w, h);
  if (app.scene.render.colorMode === 'BW') {
    const img = ctx.getImageData(0, 0, w, h);
    for (let i = 0; i < img.data.length; i += 4) {
      const l = img.data[i] * 0.2126 + img.data[i + 1] * 0.7152 + img.data[i + 2] * 0.0722;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = l;
    }
    ctx.putImageData(img, 0, 0);
  }
  if (app.scene.render.useStamp) {
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, h - 18, w, 18);
    ctx.fillStyle = '#fff';
    ctx.font = '11px sans-serif';
    ctx.fillText(`${app.doc.filename || 'untitled.blend'} | Frame ${app.scene.frameCurrent} | Camera ${app.doc.objects[camId].name}`, 6, h - 5);
  }
  void t0;
  return out;
}

function showResult(): void {
  const display = app.scene.render.display;
  if (display === 'NONE') return;
  const screen = app.screen as unknown as { biggestArea(t?: string): { type: string; setTemp(t: string): void; restoreTemp(): boolean } | null; areas(): { type: string }[]; toggleMaximize?(a: unknown, f?: boolean): void } | null;
  if (!screen) return;
  const existing = (screen.areas() as unknown as { type: string; setTemp(t: string): void }[]).find((a) => a.type === 'IMAGE_EDITOR');
  if (existing) return;
  const big = screen.biggestArea();
  if (!big) return;
  big.setTemp('IMAGE_EDITOR');
  if (display === 'SCREEN' || display === 'WINDOW') screen.toggleMaximize?.(big, display === 'SCREEN');
}

export async function renderStill(shading: Shading = 'RENDERED'): Promise<boolean> {
  const engine = shading === 'RENDERED' ? renderEngines[app.scene.render.engine] : undefined;
  if (engine) return renderStillEngine(engine);
  setProgress('Rendering...');
  await new Promise((r) => setTimeout(r, 20));
  const t0 = performance.now();
  const canvas = frameHook ? await frameHook(async () => renderFrame(shading), shading, false) : renderFrame(shading);
  setProgress(null);
  if (!canvas) return false;
  const time = performance.now() - t0;
  renderResult = { canvas, width: canvas.width, height: canvas.height, frame: app.scene.frameCurrent, time, label: shading === 'RENDERED' ? 'Render Result' : 'OpenGL Render' };
  app.report('INFO', `Rendered frame ${app.scene.frameCurrent} in ${(time / 1000).toFixed(2)} s`);
  showResult();
  for (const l of renderListeners) l();
  app.notify('render');
  return true;
}

/** Render all frames and record them into a WebM video (played back at the scene frame rate). */
export async function renderAnimation(shading: Shading = 'RENDERED'): Promise<boolean> {
  const sc = app.scene;
  const { w, h } = renderSize();
  const start = sc.frameStart, end = sc.frameEnd, step = Math.max(1, sc.frameStep);
  const fps = sc.fps / (sc.fpsBase || 1);
  const rec = document.createElement('canvas');
  rec.width = w; rec.height = h;
  const rctx = rec.getContext('2d')!;
  let recorder: MediaRecorder | null = null;
  const chunks: Blob[] = [];
  const stream = (rec as HTMLCanvasElement & { captureStream?: (fps?: number) => MediaStream }).captureStream?.(0);
  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m));
  if (stream && mime) {
    recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.start();
  }
  const track = stream?.getVideoTracks()[0] as (MediaStreamTrack & { requestFrame?: () => void }) | undefined;
  const origFrame = sc.frameCurrent;
  const engine = shading === 'RENDERED' ? renderEngines[sc.render.engine] : undefined;
  // slow (progressive) engines: record only while a finished frame is shown, so the video keeps its frame rate
  if (engine && recorder) recorder.pause();
  cancelRequested = false;
  const t0 = performance.now();
  let last: HTMLCanvasElement | null = null;
  showResult();
  for (let f = start; f <= end; f += step) {
    if (cancelRequested) break;
    app.setFrame(f);
    app.flush();
    setProgress(`Rendering frame ${f} / ${end}  (Esc to cancel)`);
    const frameStart = performance.now();
    const produce = async () => (engine ? engine.render(engineContext(t0, f, true)) : renderFrame(shading));
    const c = frameHook ? await frameHook(produce, shading, true) : await produce();
    if (!c) { setProgress(null); return false; }
    if (engine && cancelRequested) break;
    last = c;
    rctx.drawImage(c, 0, 0);
    if (engine && recorder) recorder.resume();
    track?.requestFrame?.();
    renderResult = { canvas: c, width: w, height: h, frame: f, time: performance.now() - t0, label: 'Render Result' };
    for (const l of renderListeners) l();
    // keep real-time pacing so the recording has the right frame rate
    const wait = engine ? 1000 / fps : Math.max(0, 1000 / fps - (performance.now() - frameStart));
    await new Promise((r) => setTimeout(r, wait));
    if (engine && recorder) recorder.pause();
  }
  if (engine && recorder?.state === 'paused') recorder.resume();
  let video: Blob | undefined;
  if (recorder) {
    await new Promise<void>((resolve) => { recorder!.onstop = () => resolve(); recorder!.stop(); });
    video = new Blob(chunks, { type: 'video/webm' });
  }
  app.setFrame(origFrame);
  setProgress(null);
  if (last) renderResult = { canvas: last, width: w, height: h, frame: end, time: performance.now() - t0, video, label: 'Render Result' };
  app.report('INFO', cancelRequested ? 'Render cancelled' : `Rendered animation (${Math.floor((end - start) / step) + 1} frames) in ${((performance.now() - t0) / 1000).toFixed(1)} s${video ? ' — use Image > Save Animation to download the video' : ''}`);
  for (const l of renderListeners) l();
  app.notify('render');
  return true;
}

export function cancelRender(): void { cancelRequested = true; }

/** Encode the current render result for download. */
export function renderResultBlob(format = app.scene.render.fileFormat): Promise<Blob | null> {
  const r = renderResult;
  if (!r) return Promise.resolve(null);
  const mime = format === 'JPEG' ? 'image/jpeg' : format === 'WEBP' ? 'image/webp' : format === 'BMP' ? 'image/bmp' : 'image/png';
  let src = r.canvas;
  if (format === 'JPEG' || app.scene.render.colorMode === 'RGB') {
    // flatten alpha onto black like Blender's RGB output
    const c = document.createElement('canvas');
    c.width = r.width; c.height = r.height;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(r.canvas, 0, 0);
    src = c;
  }
  return new Promise((resolve) => src.toBlob((b) => resolve(b), mime, app.scene.render.quality / 100));
}
