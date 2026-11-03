// Shared base of the strip editors (NLA, Video Sequencer): a horizontal frame axis with Blender's
// View2D behaviour (MMB pan, wheel zoom, Ctrl+wheel scroll), channel rows, scrubbing with LMB on the
// frame numbers, the current frame indicator and markers.

import { app } from '../app';
import { Editor } from '../screen/editor';
import type { Area } from '../screen/screen';
import { h, trackDrag } from '../ui/dom';

export const FONT = '11px "DejaVu Sans", Verdana, sans-serif';

export abstract class TimeAxisEditor extends Editor {
  canvas: HTMLCanvasElement;
  region: HTMLElement;
  protected dpr = Math.min(2, window.devicePixelRatio || 1);
  protected raf = 0;
  /** Height of the frame number bar at the bottom. */
  protected scrubH = 18;

  constructor(area: Area, state: Record<string, unknown>) {
    super(area, state);
    state.viewStart ??= app.scene.frameStart - 10;
    state.viewEnd ??= app.scene.frameEnd + 10;
    state.scrollY ??= 0;
    this.canvas = h('canvas') as HTMLCanvasElement;
    this.region = h('div', { class: 'strip-region' }, this.canvas);
    this.region.addEventListener('contextmenu', (e) => e.preventDefault());
    this.region.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.region.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
  }

  get vs(): number { return this.state.viewStart as number; }
  get ve(): number { return this.state.viewEnd as number; }
  get scrollY(): number { return this.state.scrollY as number; }
  get width(): number { return this.region.clientWidth; }
  get height(): number { return this.region.clientHeight; }
  frameToX(f: number): number { return ((f - this.vs) / (this.ve - this.vs)) * this.width; }
  xToFrame(x: number): number { return this.vs + (x / Math.max(1, this.width)) * (this.ve - this.vs); }
  pxPerFrame(): number { return this.width / Math.max(1e-6, this.ve - this.vs); }
  localPos(e: { clientX: number; clientY: number }): [number, number] {
    const r = this.region.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  override resize(): void {
    this.canvas.width = Math.max(1, Math.floor(this.width * this.dpr));
    this.canvas.height = Math.max(1, Math.floor(this.height * this.dpr));
    this.draw();
  }

  override refresh(): void {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.draw());
  }

  override destroy(): void { cancelAnimationFrame(this.raf); }

  protected ctx2d(): CanvasRenderingContext2D | null {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    return ctx;
  }

  viewRange(a: number, b: number): void {
    const pad = Math.max(2, (b - a) * 0.04);
    this.state.viewStart = a - pad;
    this.state.viewEnd = b + pad;
    this.draw();
  }

  protected scrub(e: PointerEvent): void {
    const set = (ev: PointerEvent) => app.setFrame(Math.round(this.xToFrame(this.localPos(ev)[0])));
    set(e);
    trackDrag(e, (ev) => set(ev), () => app.pushUndo('Change Frame'), { threshold: 0 });
  }

  protected panDrag(e: PointerEvent): void {
    let lx = e.clientX, ly = e.clientY;
    trackDrag(e, (ev) => {
      const dx = ev.clientX - lx, dy = ev.clientY - ly;
      lx = ev.clientX; ly = ev.clientY;
      if (e.ctrlKey) {
        const c = this.xToFrame(this.localPos(e)[0]);
        const f = Math.pow(1.01, -dx);
        this.state.viewStart = c - (c - this.vs) * f;
        this.state.viewEnd = c + (this.ve - c) * f;
        this.zoomVertical(Math.pow(1.01, dy));
      } else {
        const df = (dx / this.width) * (this.ve - this.vs);
        this.state.viewStart = this.vs - df;
        this.state.viewEnd = this.ve - df;
        this.scrollBy(-dy);
      }
      this.draw();
    }, undefined, { threshold: 0, cursor: 'move' });
  }

  protected scrollBy(dy: number): void { this.state.scrollY = Math.min(0, this.scrollY + dy); }
  protected zoomVertical(_f: number): void {}

  protected onWheel(e: WheelEvent): void {
    e.preventDefault();
    if (e.ctrlKey) {
      const df = (e.deltaY > 0 ? 1 : -1) * (this.ve - this.vs) * 0.1;
      this.state.viewStart = this.vs + df;
      this.state.viewEnd = this.ve + df;
    } else if (e.shiftKey) {
      this.scrollBy(e.deltaY > 0 ? -20 : 20);
    } else {
      const c = this.xToFrame(this.localPos(e)[0]);
      const f = e.deltaY > 0 ? 1.15 : 1 / 1.15;
      this.state.viewStart = c - (c - this.vs) * f;
      this.state.viewEnd = c + (this.ve - c) * f;
    }
    this.draw();
    this.afterView();
  }

  /** Called after the view changed (e.g. to scroll the channel list). */
  protected afterView(): void {}

  protected abstract onPointerDown(e: PointerEvent): void;
  abstract draw(): void;

  /** Vertical frame lines with numbers along the bottom, darkened area outside the scene range. */
  protected drawTimeGrid(ctx: CanvasRenderingContext2D, w: number, hh: number, bg: string, rangeShade = true): void {
    const s = app.scene;
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, hh);
    if (rangeShade) {
      ctx.fillStyle = 'rgba(0,0,0,0.12)';
      const x0 = this.frameToX(s.usePreviewRange ? s.previewStart : s.frameStart), x1 = this.frameToX((s.usePreviewRange ? s.previewEnd : s.frameEnd) + 1);
      ctx.fillRect(0, 0, Math.max(0, x0), hh);
      ctx.fillRect(x1, 0, Math.max(0, w - x1), hh);
    }
    const span = this.ve - this.vs;
    const raw = (span / Math.max(1, w)) * 50;
    const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000];
    const step = steps.find((x) => x >= raw) ?? 20000;
    ctx.strokeStyle = 'rgba(0,0,0,0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let f = Math.ceil(this.vs / step) * step; f <= this.ve; f += step) {
      const x = Math.round(this.frameToX(f)) + 0.5;
      ctx.moveTo(x, 0); ctx.lineTo(x, hh - this.scrubH);
    }
    ctx.stroke();
  }

  protected drawScrubArea(ctx: CanvasRenderingContext2D, w: number, hh: number): void {
    ctx.fillStyle = 'rgba(70,70,70,0.85)';
    ctx.fillRect(0, hh - this.scrubH, w, this.scrubH);
    const span = this.ve - this.vs;
    const raw = (span / Math.max(1, w)) * 50;
    const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000];
    const step = steps.find((x) => x >= raw) ?? 20000;
    ctx.fillStyle = '#ddd';
    ctx.font = FONT;
    ctx.textAlign = 'center';
    for (let f = Math.ceil(this.vs / step) * step; f <= this.ve; f += step) ctx.fillText(String(f), Math.round(this.frameToX(f)), hh - 5);
  }

  protected drawCurrentFrame(ctx: CanvasRenderingContext2D, hh: number): void {
    const f = app.scene.frameCurrent;
    const x = Math.round(this.frameToX(f)) + 0.5;
    ctx.strokeStyle = '#60c040';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, hh); ctx.stroke();
    ctx.font = FONT;
    const label = String(f);
    const tw = ctx.measureText(label).width + 8;
    ctx.fillStyle = '#60c040';
    ctx.fillRect(x - tw / 2, hh - this.scrubH + 1, tw, this.scrubH - 2);
    ctx.fillStyle = '#000';
    ctx.textAlign = 'center';
    ctx.fillText(label, x, hh - 5);
  }

  protected drawMarkers(ctx: CanvasRenderingContext2D, hh: number): void {
    ctx.font = FONT;
    ctx.textAlign = 'left';
    for (const m of app.scene.markers) {
      const x = this.frameToX(m.frame);
      ctx.fillStyle = m.select ? '#fff' : '#000';
      const y = hh - this.scrubH - 2;
      ctx.beginPath(); ctx.moveTo(x - 5, y); ctx.lineTo(x + 5, y); ctx.lineTo(x, y - 6); ctx.closePath(); ctx.fill();
      ctx.fillText(m.name, x + 6, y);
    }
  }

  /** True if the event is on the frame-number bar (LMB there always scrubs). */
  protected onScrubBar(y: number): boolean { return y > this.height - this.scrubH; }
}

/** Rounded rectangle path. */
export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, hh: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, hh / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + hh - rr);
  ctx.quadraticCurveTo(x + w, y + hh, x + w - rr, y + hh);
  ctx.lineTo(x + rr, y + hh);
  ctx.quadraticCurveTo(x, y + hh, x, y + hh - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}
