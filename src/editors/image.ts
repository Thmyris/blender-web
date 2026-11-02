// UV/Image Editor: shows the render result (zoom with the wheel, pan with MMB).

import { app } from '../app';
import { Editor, registerEditor } from '../screen/editor';
import type { Area } from '../screen/screen';
import { h, trackDrag } from '../ui/dom';
import { pulldown } from '../ui/menu';
import type { Layout } from '../ui/layout';
import { renderResult, renderListeners, renderProgress } from '../render/render';

export class ImageEditor extends Editor {
  static readonly TYPE = 'IMAGE_EDITOR';
  private canvas: HTMLCanvasElement;
  private region: HTMLElement;
  private info: HTMLElement;
  private unsub: () => void;

  constructor(area: Area, state: Record<string, unknown>) {
    super(area, state);
    state.zoom ??= 0;
    state.panX ??= 0;
    state.panY ??= 0;
    state.channels ??= 'COLOR';
    this.canvas = h('canvas', { style: { position: 'absolute', inset: '0', width: '100%', height: '100%' } }) as HTMLCanvasElement;
    this.info = h('div', { class: 'render-progress' });
    this.region = h('div', { class: 'region', style: { flex: '1 1 auto', background: '#303030' } }, this.canvas, this.info);
    this.main.append(this.region);
    this.region.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.state.zoom = (this.state.zoom as number) || this.fitZoom();
      this.state.zoom = Math.max(0.05, Math.min(32, (this.state.zoom as number) * (e.deltaY < 0 ? 1.25 : 0.8)));
      this.draw();
    }, { passive: false });
    this.region.addEventListener('pointerdown', (e) => {
      if (e.button !== 1 && !(e.button === 0 && e.altKey)) return;
      e.preventDefault();
      let lx = e.clientX, ly = e.clientY;
      trackDrag(e, (ev) => { this.state.panX = (this.state.panX as number) + ev.clientX - lx; this.state.panY = (this.state.panY as number) + ev.clientY - ly; lx = ev.clientX; ly = ev.clientY; this.draw(); }, undefined, { threshold: 0 });
    });
    this.region.addEventListener('contextmenu', (e) => e.preventDefault());
    const l = () => { this.draw(); this.rebuildHeader(); };
    renderListeners.add(l);
    this.unsub = () => renderListeners.delete(l);
  }

  get type(): string { return ImageEditor.TYPE; }
  override destroy(): void { this.unsub(); }

  private fitZoom(): number {
    const r = renderResult;
    if (!r) return 1;
    const w = this.region.clientWidth, hh = this.region.clientHeight;
    return Math.min(1, (w - 20) / r.width, (hh - 20) / r.height);
  }

  override resize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(1, this.region.clientWidth * dpr);
    this.canvas.height = Math.max(1, this.region.clientHeight * dpr);
    this.draw();
  }

  override refresh(): void { this.draw(); }

  private draw(): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.canvas.width / dpr, hh = this.canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#303030';
    ctx.fillRect(0, 0, w, hh);
    this.info.textContent = renderProgress ?? '';
    this.info.style.display = renderProgress ? '' : 'none';
    const r = renderResult;
    if (!r) {
      ctx.fillStyle = '#aaa';
      ctx.font = '12px "DejaVu Sans", Verdana, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No render result yet — press F12 (Render > Render Image)', w / 2, hh / 2);
      return;
    }
    const z = (this.state.zoom as number) || this.fitZoom();
    const iw = r.width * z, ih = r.height * z;
    const x = Math.round((w - iw) / 2 + (this.state.panX as number)), y = Math.round((hh - ih) / 2 + (this.state.panY as number));
    // checkerboard for alpha
    const cs = 8;
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, iw, ih); ctx.clip();
    for (let yy = 0; yy < ih; yy += cs) for (let xx = 0; xx < iw; xx += cs) {
      ctx.fillStyle = ((xx / cs + yy / cs) & 1) ? '#6b6b6b' : '#999';
      ctx.fillRect(x + xx, y + yy, cs, cs);
    }
    ctx.imageSmoothingEnabled = z < 1;
    if (this.state.channels === 'ALPHA') {
      ctx.fillStyle = '#000'; ctx.fillRect(x, y, iw, ih);
      ctx.globalCompositeOperation = 'lighter';
      ctx.filter = 'grayscale(1) brightness(1000%)';
    }
    ctx.drawImage(r.canvas, x, y, iw, ih);
    ctx.restore();
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    ctx.fillStyle = '#fff';
    ctx.font = '11px "DejaVu Sans", Verdana, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`Frame:${r.frame} | Time:${(r.time / 1000).toFixed(2)}s | ${r.width} x ${r.height}`, 8, 16);
  }

  override drawHeader(l: Layout): void {
    const area = () => this.area;
    const row = l.row();
    row.el.classList.add('header-row');
    row.el.style.flex = '0 0 auto';
    row.el.append(
      pulldown({ label: 'View', items: () => [
        { label: 'View Fit', shortcut: 'Shift Home', action: () => { this.state.zoom = 0; this.state.panX = 0; this.state.panY = 0; this.draw(); } },
        { label: 'Zoom 1:1', shortcut: 'Numpad 1', action: () => { this.state.zoom = 1; this.draw(); } },
        { label: 'Zoom 2:1', action: () => { this.state.zoom = 2; this.draw(); } },
        { label: 'Zoom 1:2', action: () => { this.state.zoom = 0.5; this.draw(); } },
        { type: 'separator' },
        { label: 'Toggle Maximize Area', op: 'screen.screen_full_area' },
      ] }, area),
      pulldown({ label: 'Image', items: () => [
        { label: 'Save As Image', shortcut: 'Shift Alt S', op: 'image.save_as' },
        { label: 'Save Animation (.webm)', op: 'image.save_animation' },
      ] }, area),
    );
    const nm = l.prop({ kind: 'string', name: '', get: () => renderResult?.label ?? 'Render Result', set: () => {}, disabled: () => true, undo: false }, { icon: 'IMAGE_DATA', text: '' });
    nm.style.flex = '0 0 160px';
    const slot = l.prop({ kind: 'enum', name: 'Slot', items: Array.from({ length: 8 }, (_, i) => ({ id: String(i), label: `Slot ${i + 1}`, disabled: i > 0 })), get: () => '0', set: () => {}, undo: false }, { noLabel: true });
    slot.style.flex = '0 0 80px';
    const ch = l.prop({ kind: 'enum', name: 'Draw Channels', items: [{ id: 'COLOR', label: 'Color', icon: 'IMAGE_DATA' }, { id: 'ALPHA', label: 'Alpha' }], get: () => String(this.state.channels), set: (v) => { this.state.channels = v; this.draw(); }, undo: false }, { iconOnly: true });
    ch.style.flex = '0 0 36px';
    if (this.area.tempPrevType) {
      const back = l.button('Back to Previous', () => this.area.restoreTemp(), { tip: 'Return to the previous editor (Esc)' });
      back.style.flex = '0 0 130px';
    }
  }

  override onKey(e: KeyboardEvent): boolean {
    if (e.code === 'Home') { this.state.zoom = 0; this.state.panX = 0; this.state.panY = 0; this.draw(); return true; }
    if (e.altKey && e.shiftKey && e.code === 'KeyS') { void app.callOperator('image.save_as'); return true; }
    if (e.code === 'F3') { void app.callOperator('image.save_as'); return true; }
    return false;
  }
}

registerEditor({ type: ImageEditor.TYPE, label: 'UV/Image Editor', icon: 'IMAGE_COL', create: (area, state) => new ImageEditor(area, state) });
