// UV/Image Editor: shows the render result or an image datablock (zoom with the wheel, pan with
// MMB), edits the UV layout of the mesh in edit mode (selection, transforms, UV tools), paints on
// images in Paint mode, and has a tool shelf (T) and properties region (N) like Blender 2.79.

import { app } from '../app';
import { Editor, registerEditor } from '../screen/editor';
import type { Area } from '../screen/screen';
import { h, trackDrag } from '../ui/dom';
import { pulldown, showMenu, type MenuItem } from '../ui/menu';
import { PanelRegion, type Layout } from '../ui/layout';
import { renderResult, renderListeners, renderProgress } from '../render/render';
import type { BImage } from '../core/types';
import { activeUVIndex } from '../core/uvdata';
import { getImage, imageCanvas, imageList, imageUsers, onImagesChanged } from '../paint/images';
import { defaultUVDisplay, drawCursor2D, drawUVBackground, drawUVs, type UVDisplay } from './uvedit/uvdraw';
import { uvContext, uvSettings, selectedCorners, isSync } from './uvedit/uvsel';
import {
  startUVBorderSelect, startUVCircleSelect, startUVTransform, uvClickSelect, uvLoopSelect, type UVEditorView, type UVTransformMode,
} from './uvedit/uvtools';
import { imageEditorHeaderExtras, imageEditorMenus, imageToolPanels, imageNPanels } from './uvedit/uvpanels';
import { imagePaintKey, imagePaintStroke, drawImageBrush } from '../paint/texpaint';
import { cornerUV } from '../core/uvdata';

export type ImageEditorMode = 'VIEW' | 'PAINT' | 'MASK';

export class ImageEditor extends Editor implements UVEditorView {
  static readonly TYPE = 'IMAGE_EDITOR';
  private canvas: HTMLCanvasElement;
  private region: HTMLElement;
  private info: HTMLElement;
  private unsub: () => void;
  private unsubImg: () => void;
  toolshelf: HTMLElement;
  npanel: HTMLElement;
  private toolRegion: PanelRegion;
  private nRegion: PanelRegion;
  feedback: UVEditorView['feedback'] = null;
  /** Brush position in canvas pixels (paint mode). */
  brushPos: { x: number; y: number } | null = null;
  radialControl: { center: { x: number; y: number }; which: 'radius' | 'strength' } | null = null;
  private raf = 0;

  constructor(area: Area, state: Record<string, unknown>) {
    super(area, state);
    state.zoom ??= 0;
    state.panX ??= 0;
    state.panY ??= 0;
    state.channels ??= 'COLOR';
    state.image ??= null;
    state.mode ??= 'VIEW';
    state.showToolshelf ??= false;
    state.showNPanel ??= false;
    state.toolshelfWidth ??= 170;
    state.npanelWidth ??= 220;
    state.uvDisplay = { ...defaultUVDisplay(), ...(state.uvDisplay as Partial<UVDisplay> ?? {}) };
    state.circleRadius ??= 25;
    this.canvas = h('canvas', { style: { position: 'absolute', inset: '0', width: '100%', height: '100%' } }) as HTMLCanvasElement;
    this.info = h('div', { class: 'render-progress' });
    this.region = h('div', { class: 'region', style: { flex: '1 1 auto', background: '#303030', position: 'relative', overflow: 'hidden', minWidth: '0' } }, this.canvas, this.info);
    this.toolRegion = new PanelRegion(() => imageToolPanels(this), area, `${area.id}:imgtools:`);
    this.nRegion = new PanelRegion(() => imageNPanels(this), area, `${area.id}:imgui:`);
    this.toolshelf = h('div', { class: 'side-region left' }, this.toolRegion.el, this.resizeHandle('left'));
    this.npanel = h('div', { class: 'side-region right' }, this.nRegion.el, this.resizeHandle('right'));
    this.main.append(this.toolshelf, this.region, this.npanel);
    this.applyRegionVisibility();
    this.region.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (app.modal) return;
      this.zoomAt(e.deltaY < 0 ? 1.25 : 0.8, this.local(e));
    }, { passive: false });
    this.region.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.region.addEventListener('pointermove', (e) => {
      if (this.mode === 'PAINT' && this.paintTarget()) { this.brushPos = this.local(e); this.redraw(); }
    });
    this.region.addEventListener('pointerleave', () => { if (this.brushPos) { this.brushPos = null; this.redraw(); } });
    this.region.addEventListener('contextmenu', (e) => e.preventDefault());
    const l = () => {
      // a new render result is shown in place of an image only when nothing else is displayed
      this.redraw();
      this.rebuildHeader();
    };
    renderListeners.add(l);
    this.unsub = () => renderListeners.delete(l);
    this.unsubImg = onImagesChanged(() => this.redraw());
  }

  get type(): string { return ImageEditor.TYPE; }
  override destroy(): void { this.unsub(); this.unsubImg(); cancelAnimationFrame(this.raf); }

  get mode(): ImageEditorMode { return (this.state.mode as ImageEditorMode) ?? 'VIEW'; }
  get display(): UVDisplay { return this.state.uvDisplay as UVDisplay; }

  // ---------------------------------------------------------------- shown image

  /** Image datablock shown (null = render result / nothing). */
  get image(): BImage | null { return getImage(typeof this.state.image === 'string' ? this.state.image : null); }

  /** Is the render result shown? */
  showsRender(): boolean { return !this.image && !!renderResult && this.state.image !== 'NONE'; }

  /** Image being painted on in Paint mode. */
  paintTarget(): BImage | null { return this.mode === 'PAINT' ? this.image : null; }

  imageSize(): [number, number] {
    const img = this.image;
    if (img) { const c = imageCanvas(img); return [c.width || img.width, c.height || img.height]; }
    if (this.showsRender() && !this.editingUVs()) return [renderResult!.width, renderResult!.height];
    return [256, 256];
  }

  imageAspect(): number { const [w, hh] = this.imageSize(); return hh > 0 ? w / hh : 1; }

  /** Are UVs shown / edited (mesh edit mode, view mode)? */
  editingUVs(): boolean { return app.mode === 'EDIT' && !!app.editMesh && this.mode === 'VIEW'; }

  // ---------------------------------------------------------------- view mapping

  local(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.canvasRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  canvasRect(): DOMRect { return this.region.getBoundingClientRect(); }

  private fitZoom(): number {
    const [iw, ih] = this.imageSize();
    const w = this.region.clientWidth, hh = this.region.clientHeight;
    const z = Math.min((w - 40) / iw, (hh - 40) / ih);
    return this.image || this.editingUVs() ? Math.max(0.01, z) : Math.min(1, z);
  }

  get zoom(): number { return (this.state.zoom as number) || this.fitZoom(); }

  /** Screen position (canvas px) of UV (0, 0) and the size of the 0..1 square. */
  private frame(): { x0: number; y0: number; w: number; h: number } {
    const [iw, ih] = this.imageSize();
    const z = this.zoom;
    const w = iw * z, hh = ih * z;
    const cw = this.region.clientWidth, ch = this.region.clientHeight;
    const x0 = (cw - w) / 2 + (this.state.panX as number);
    const y0 = (ch - hh) / 2 + (this.state.panY as number);
    return { x0, y0: y0 + hh, w, h: hh };
  }

  uvToScreen(u: number, v: number): [number, number] {
    const f = this.frame();
    return [f.x0 + u * f.w, f.y0 - v * f.h];
  }

  screenToUV(x: number, y: number): [number, number] {
    const f = this.frame();
    return [(x - f.x0) / f.w, (f.y0 - y) / f.h];
  }

  zoomAt(factor: number, at?: { x: number; y: number }): void {
    const z0 = this.zoom;
    const z1 = Math.max(0.02, Math.min(64, z0 * factor));
    const cw = this.region.clientWidth, ch = this.region.clientHeight;
    const p = at ?? { x: cw / 2, y: ch / 2 };
    // keep the point under the mouse fixed
    const px = this.state.panX as number, py = this.state.panY as number;
    const k = z1 / z0;
    this.state.panX = (p.x - cw / 2) - (p.x - cw / 2 - px) * k;
    this.state.panY = (p.y - ch / 2) - (p.y - ch / 2 - py) * k;
    this.state.zoom = z1;
    this.redraw();
  }

  setZoomRatio(r: number): void { this.state.zoom = r; this.redraw(); }

  viewAll(): void { this.state.zoom = 0; this.state.panX = 0; this.state.panY = 0; this.redraw(); }

  /** Frame the selected UVs (View Selected). */
  viewSelected(): void {
    const c = uvContext();
    if (!c || !this.editingUVs()) { this.viewAll(); return; }
    const sel = selectedCorners(c.md, c.layer);
    if (!sel.length) return;
    let mnu = Infinity, mxu = -Infinity, mnv = Infinity, mxv = -Infinity;
    for (const [f, k] of sel) { const p = cornerUV(c.layer, f, k); mnu = Math.min(mnu, p[0]); mxu = Math.max(mxu, p[0]); mnv = Math.min(mnv, p[1]); mxv = Math.max(mxv, p[1]); }
    const [iw, ih] = this.imageSize();
    const w = this.region.clientWidth, hh = this.region.clientHeight;
    const du = Math.max(mxu - mnu, 0.02) * iw, dv = Math.max(mxv - mnv, 0.02) * ih;
    const z = Math.min((w * 0.8) / du, (hh * 0.8) / dv, 64);
    this.state.zoom = z;
    // centre (u, v) of the selection on screen
    const cu = (mnu + mxu) / 2, cv = (mnv + mxv) / 2;
    this.state.panX = -(cu - 0.5) * iw * z;
    this.state.panY = (cv - 0.5) * ih * z;
    this.redraw();
  }

  // ---------------------------------------------------------------- regions

  private resizeHandle(side: 'left' | 'right'): HTMLElement {
    const el = h('div', { class: 'region-resize' });
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const key = side === 'left' ? 'toolshelfWidth' : 'npanelWidth';
      const start = this.state[key] as number;
      trackDrag(e, (_ev, dx) => {
        this.state[key] = Math.max(110, Math.min(600, start + (side === 'left' ? dx : -dx)));
        this.applyRegionVisibility();
      }, undefined, { threshold: 0, cursor: 'col-resize' });
    });
    return el;
  }

  applyRegionVisibility(): void {
    this.toolshelf.style.display = this.state.showToolshelf ? '' : 'none';
    this.toolshelf.style.width = `${this.state.toolshelfWidth}px`;
    this.npanel.style.display = this.state.showNPanel ? '' : 'none';
    this.npanel.style.width = `${this.state.npanelWidth}px`;
    this.region.querySelectorAll('.region-hidden-handle').forEach((x) => x.remove());
    if (!this.state.showToolshelf) {
      const hnd = h('div', { class: 'region-hidden-handle left', title: 'Show Tool Shelf (T)' }, '+');
      hnd.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.toggleRegion('toolshelf'); });
      this.region.append(hnd);
    }
    if (!this.state.showNPanel) {
      const hnd = h('div', { class: 'region-hidden-handle right', title: 'Show Properties (N)' }, '+');
      hnd.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.toggleRegion('npanel'); });
      this.region.append(hnd);
    }
    requestAnimationFrame(() => this.resize());
  }

  toggleRegion(which: 'toolshelf' | 'npanel'): void {
    if (which === 'toolshelf') this.state.showToolshelf = !this.state.showToolshelf;
    else this.state.showNPanel = !this.state.showNPanel;
    this.applyRegionVisibility();
    this.refresh(new Set(['all']));
  }

  // ---------------------------------------------------------------- drawing

  override resize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(1, this.region.clientWidth * dpr);
    this.canvas.height = Math.max(1, this.region.clientHeight * dpr);
    this.draw();
  }

  override refresh(): void {
    this.redraw();
    if (this.state.showToolshelf) this.toolRegion.refresh();
    if (this.state.showNPanel) this.nRegion.refresh();
  }

  redraw(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); });
  }

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
    const img = this.image;
    const editing = this.editingUVs();
    const f = this.frame();
    const x = Math.round(f.x0), y = Math.round(f.y0 - f.h), iw = Math.round(f.w), ih = Math.round(f.h);
    if (img || (this.showsRender() && !editing)) {
      const src: CanvasImageSource = img ? imageCanvas(img) : renderResult!.canvas;
      // checkerboard for alpha
      const cs = 8;
      ctx.save();
      ctx.beginPath(); ctx.rect(x, y, iw, ih); ctx.clip();
      for (let yy = 0; yy < ih; yy += cs) for (let xx = 0; xx < iw; xx += cs) {
        ctx.fillStyle = ((xx / cs + yy / cs) & 1) ? '#6b6b6b' : '#999';
        ctx.fillRect(x + xx, y + yy, cs, cs);
      }
      ctx.imageSmoothingEnabled = this.zoom < 1;
      if (this.state.channels === 'ALPHA') {
        ctx.fillStyle = '#000'; ctx.fillRect(x, y, iw, ih);
        ctx.globalCompositeOperation = 'lighter';
        ctx.filter = 'grayscale(1) brightness(1000%)';
      }
      if (this.state.channels === 'COLOR') {
        // without alpha: draw over an opaque background
        ctx.fillStyle = '#000'; ctx.fillRect(x, y, iw, ih);
      }
      ctx.drawImage(src, x, y, iw, ih);
      ctx.restore();
      ctx.globalCompositeOperation = 'source-over';
      ctx.filter = 'none';
    } else if (editing) {
      drawUVBackground(ctx, x, y, iw, ih);
    } else if (!img) {
      ctx.fillStyle = '#aaa';
      ctx.font = '12px "DejaVu Sans", Verdana, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No image — press F12 to render, or Image > New / Open', w / 2, hh / 2);
    }
    if (editing) {
      const c = uvContext();
      if (c) drawUVs(ctx, c.md, c.layer, this, this.display, this.imageAspect());
      const cur = uvSettings().cursor;
      const [cx, cy] = this.uvToScreen(cur[0], cur[1]);
      drawCursor2D(ctx, cx, cy);
    }
    // gesture feedback
    const fb = this.feedback;
    if (fb) {
      ctx.save();
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#fff';
      ctx.setLineDash([4, 3]);
      if (fb.rect) { const [a, b, c2, d] = fb.rect; ctx.strokeRect(Math.min(a, c2) + 0.5, Math.min(b, d) + 0.5, Math.abs(c2 - a), Math.abs(d - b)); }
      if (fb.circle) { ctx.beginPath(); ctx.arc(fb.circle.x, fb.circle.y, fb.circle.r, 0, Math.PI * 2); ctx.stroke(); }
      if (fb.line) { ctx.strokeStyle = '#000'; ctx.beginPath(); ctx.moveTo(fb.line[0], fb.line[1]); ctx.lineTo(fb.line[2], fb.line[3]); ctx.stroke(); }
      ctx.restore();
    }
    if (this.paintTarget()) drawImageBrush(ctx, this);
    // info text
    ctx.fillStyle = '#fff';
    ctx.font = '11px "DejaVu Sans", Verdana, sans-serif';
    ctx.textAlign = 'left';
    if (this.showsRender() && !img && !editing) {
      const r = renderResult!;
      ctx.fillText(`Frame:${r.frame} | Time:${(r.time / 1000).toFixed(2)}s | ${r.width} x ${r.height}`, 8, 16);
    }
  }

  // ---------------------------------------------------------------- header

  override headerKey(): string {
    return [app.mode, this.mode, !!this.image, !!renderResult, this.editingUVs(), isSync(), uvSettings().selectMode, activeUVIndex(app.editMesh), app.editMesh?.uvLayers?.length ?? 0, app.modal ? 'modal' : '', this.area.tempPrevType ?? ''].join('|');
  }

  override drawHeader(l: Layout): void {
    if (app.modal?.status && (app.modal as { uvEditor?: unknown }).uvEditor === undefined && this.area.el.contains(document.elementFromPoint(app.mouse.x, app.mouse.y))) {
      // like the 3D View, show the modal status in the header while transforming
      l.el.append(h('div', { class: 'header-status' }, ''));
      const upd = () => { const s = l.el.querySelector('.header-status'); if (s && app.modal?.status) s.textContent = app.modal.status(); };
      this.headerRoot.widgets.push({ update: upd });
      upd();
      return;
    }
    const area = () => this.area;
    const row = l.row();
    row.el.classList.add('header-row');
    row.el.style.flex = '0 0 auto';
    for (const m of imageEditorMenus(this)) row.el.append(pulldown({ label: m.label, items: m.items }, area));
    imageEditorHeaderExtras(this, l);
    if (this.area.tempPrevType) {
      const back = l.button('Back to Previous', () => this.area.restoreTemp(), { tip: 'Return to the previous editor (Esc)' });
      back.style.flex = '0 0 130px';
    }
  }

  // ---------------------------------------------------------------- input

  private get selectButton(): number { return app.prefs.selectMouse === 'RIGHT' ? 2 : 0; }
  private get actionButton(): number { return app.prefs.selectMouse === 'RIGHT' ? 0 : 2; }

  private onPointerDown(e: PointerEvent): void {
    if (app.modal) return;
    const p = this.local(e);
    if (e.button === 1 || (e.button === 0 && e.altKey && app.prefs.emulate3Button)) {
      e.preventDefault();
      let lx = e.clientX, ly = e.clientY;
      const zoom = e.ctrlKey;
      trackDrag(e, (ev) => {
        if (zoom) this.zoomAt(Math.pow(1.01, -(ev.clientY - ly)), p);
        else { this.state.panX = (this.state.panX as number) + ev.clientX - lx; this.state.panY = (this.state.panY as number) + ev.clientY - ly; this.redraw(); }
        lx = ev.clientX; ly = ev.clientY;
      }, undefined, { threshold: 0 });
      return;
    }
    if (this.paintTarget() && e.button === this.actionButton) {
      e.preventDefault();
      imagePaintStroke(this, e);
      return;
    }
    if (!this.editingUVs()) return;
    if (e.button === this.selectButton) {
      e.preventDefault();
      const changed = e.altKey ? uvLoopSelect(this, p.x, p.y, e.shiftKey) : uvClickSelect(this, p.x, p.y, e.shiftKey);
      if (changed) app.pushUndo('Select');
      this.redraw();
      if (!e.altKey) this.tweakToGrab(e);
      return;
    }
    if (e.button === this.actionButton) {
      e.preventDefault();
      // LMB places the 2D cursor
      trackDrag(e, (ev) => { const q = this.local(ev); uvSettings().cursor = this.screenToUV(q.x, q.y); this.redraw(); }, () => app.notify('view'), { threshold: 0 });
      uvSettings().cursor = this.screenToUV(p.x, p.y);
      this.redraw();
    }
  }

  /** Dragging after a select-click grabs the selection (released to confirm). */
  private tweakToGrab(e: PointerEvent): void {
    const sx = e.clientX, sy = e.clientY, button = e.button;
    const move = (ev: PointerEvent) => {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < app.prefs.dragThreshold + 3) return;
      cleanup();
      if (app.modal || !uvContext()) return;
      app.mouse.x = sx; app.mouse.y = sy;
      startUVTransform(this, 'TRANSLATION', { releaseConfirm: true });
      app.modal?.onEvent(ev);
    };
    const up = (ev: PointerEvent) => { if (ev.button === button) cleanup(); };
    const cleanup = () => { window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', up, true); };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
  }

  startTransform(mode: UVTransformMode): void {
    if (!this.editingUVs() || !uvContext()) return;
    startUVTransform(this, mode);
  }

  override onKey(e: KeyboardEvent): boolean {
    const ctrl = e.ctrlKey || e.metaKey;
    const plain = !ctrl && !e.altKey && !e.shiftKey;
    // view navigation (any mode)
    if (e.code === 'Home' && !ctrl) { this.viewAll(); return true; }
    if (e.code === 'NumpadDecimal' && plain) { this.viewSelected(); return true; }
    if ((e.code === 'NumpadAdd' || (e.code === 'Equal' && ctrl)) && !e.altKey) { this.zoomAt(1.25); return true; }
    if ((e.code === 'NumpadSubtract' || (e.code === 'Minus' && ctrl)) && !e.altKey) { this.zoomAt(0.8); return true; }
    const ratios: Record<string, number> = { Numpad1: 1, Numpad2: 2, Numpad4: 4, Numpad8: 8 };
    if (ratios[e.code] && !e.altKey) { this.setZoomRatio(ctrl ? ratios[e.code] : 1 / ratios[e.code]); return true; }
    if (e.code === 'KeyT' && plain) { this.toggleRegion('toolshelf'); return true; }
    if (e.code === 'KeyN' && plain) { this.toggleRegion('npanel'); return true; }
    if (e.code === 'F3' && plain) { void app.callOperator('image.save_as', {}, { area: this.area }); return true; }
    if (this.paintTarget() && imagePaintKey(this, e)) return true;
    if (!this.editingUVs()) return false;
    if (plain) {
      switch (e.code) {
        case 'KeyG': this.startTransform('TRANSLATION'); return true;
        case 'KeyR': this.startTransform('ROTATION'); return true;
        case 'KeyS': this.startTransform('RESIZE'); return true;
        case 'KeyB': startUVBorderSelect(this); return true;
        case 'KeyC': startUVCircleSelect(this, this.circleState()); return true;
        case 'KeyE': void app.callOperator('uv.unwrap', {}, { area: this.area }); return true;
        case 'KeyL': this.pickLinked(false); return true;
        default: break;
      }
    }
    if (e.code === 'KeyL' && e.shiftKey && !ctrl && !e.altKey) { this.pickLinked(true); return true; }
    if (e.code === 'Tab' && ctrl && !e.shiftKey) { showMenu(this.selectModeItems(), app.mouse, { title: 'UV Select Mode', atMouse: true, area: this.area }); return true; }
    return false;
  }

  private circleState(): { radius: number } {
    const st = this.state;
    return { get radius() { return st.circleRadius as number; }, set radius(v: number) { st.circleRadius = v; } };
  }

  private pickLinked(deselect: boolean): void {
    const r = this.canvasRect();
    const loc = this.screenToUV(app.mouse.x - r.left, app.mouse.y - r.top);
    void app.callOperator('uv.select_linked_pick', { extend: true, deselect, location: loc }, { area: this.area, exec: true });
  }

  selectModeItems(): MenuItem[] {
    const s = uvSettings();
    const set = (m: typeof s.selectMode) => () => { s.selectMode = m; app.notify('all'); };
    return [
      { label: 'Vertex', icon: 'UV_VERTEXSEL', checked: s.selectMode === 'VERTEX', action: set('VERTEX') },
      { label: 'Edge', icon: 'UV_EDGESEL', checked: s.selectMode === 'EDGE', action: set('EDGE') },
      { label: 'Face', icon: 'UV_FACESEL', checked: s.selectMode === 'FACE', action: set('FACE') },
      { label: 'Island', icon: 'UV_ISLANDSEL', checked: s.selectMode === 'ISLAND', action: set('ISLAND') },
    ];
  }

  /** Users of the shown image (for the ID template). */
  imageUsers(): number { const img = this.image; return img ? imageUsers(img.id) : 0; }

  allImages(): BImage[] { return imageList(); }
}

registerEditor({ type: ImageEditor.TYPE, label: 'UV/Image Editor', icon: 'IMAGE_COL', create: (area, state) => new ImageEditor(area, state) });
