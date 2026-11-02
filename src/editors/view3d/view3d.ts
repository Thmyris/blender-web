// The 3D View editor: viewport canvas, navigation, selection, tool shelf (T),
// properties region (N) and header.

import { Matrix4, Quaternion, Vector3 } from 'three';
import { app } from '../../app';
import { Editor, registerEditor } from '../../screen/editor';
import type { Area } from '../../screen/screen';
import { h, trackDrag } from '../../ui/dom';
import { PanelRegion, type Layout } from '../../ui/layout';
import { pulldown } from '../../ui/menu';
import { ViewState } from './viewstate';
import { ViewportRenderer, defaultDisplay, type ViewDisplay } from './draw';
import { clickSelectEdit, clickSelectObject, loopSelect, startLasso } from './select';
import { startTransform, setViewResolver, type TransformMode } from './transform';
import { drawOverlay, manipulatorHit, type ManipHit } from './overlay';
import { toolshelfPanels, npanelPanels, redoPanels, TOOL_TABS } from './panels';
import { addMenu, objectMenu, meshMenu, selectMenu, viewMenu } from './menus';
import { drawView3DHeader } from './header';
import { startSculptStroke, sculptKey, sculptMenu } from './sculpt';
import { startPaintStroke, vpaintKey, vpaintMenu, fillVertexColors } from './vpaint';
import { textEditKey } from '../../core/text3d';
import { activeEditType, editTypeHasSelection, editTypeSelectedPoints } from './edittypes';
import { cyclesViewportDestroyed, cyclesViewportOverlay, cyclesViewportUpdate } from '../../render/cycles/viewport';

export interface OverlayShape {
  kind: 'rect' | 'circle' | 'lasso' | 'cross';
  a: { x: number; y: number };
  b: { x: number; y: number };
  r?: number;
  pts?: { x: number; y: number }[];
}

export interface TransformOverlayState {
  center: () => Vector3;
  constraint: () => boolean[] | null;
  orient: () => import('three').Matrix3;
  mode: () => TransformMode;
  propSize: () => number;
  snap?: () => Vector3 | null;
}

export class View3D extends Editor {
  static readonly TYPE = 'VIEW_3D';
  view = new ViewState();
  display: ViewDisplay;
  renderer!: ViewportRenderer;
  canvas: HTMLCanvasElement;
  overlay: HTMLCanvasElement;
  canvasWrap: HTMLElement;
  toolshelf: HTMLElement;
  npanel: HTMLElement;
  private toolRegion: PanelRegion;
  private redoRegion: PanelRegion;
  private nRegion: PanelRegion;
  private tabsEl: HTMLElement;
  localView: Set<string> | null = null;
  private savedView: Record<string, unknown> | null = null;
  overlayShape: OverlayShape | null = null;
  transformState: TransformOverlayState | null = null;
  manipHover: ManipHit | null = null;
  /** Loop-cut preview edges (world space pairs) */
  previewLines: Vector3[] | null = null;
  /** Sculpt brush position (viewport pixels) and the F / Shift+F radial control. */
  brushPos: { x: number; y: number } | null = null;
  radialControl: { center: { x: number; y: number }; which: 'radius' | 'strength' } | null = null;
  private needsRender = true;
  private raf = 0;
  private destroyed = false;
  private mounted = false;
  private lastFrameTime = 0;

  constructor(area: Area, state: Record<string, unknown>) {
    super(area, state);
    this.headerPosition = 'bottom';
    this.display = { ...defaultDisplay(), ...(state.display as Partial<ViewDisplay> ?? {}) };
    state.display = this.display;
    this.view.fromJSON(state.view as Record<string, unknown> | undefined);
    state.showToolshelf ??= true;
    state.showNPanel ??= false;
    state.toolTab ??= 'Tools';
    state.toolshelfWidth ??= 170;
    state.npanelWidth ??= 230;

    this.canvas = h('canvas', { style: { position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'block' } }) as HTMLCanvasElement;
    this.overlay = h('canvas', { style: { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none' } }) as HTMLCanvasElement;
    this.canvasWrap = h('div', { class: 'region view3d-window', style: { flex: '1 1 auto', position: 'relative', overflow: 'hidden', background: '#393939', minWidth: '0' } }, this.canvas, this.overlay);

    // tool shelf (left)
    this.tabsEl = h('div', { class: 'tool-tabs' });
    this.toolRegion = new PanelRegion(() => toolshelfPanels(this), area, `${area.id}:tools:`);
    this.redoRegion = new PanelRegion(() => redoPanels(this), area, `${area.id}:redo:`);
    const redoWrap = h('div', { class: 'redo-region' }, this.redoRegion.el);
    this.redoRegion.el.style.position = 'relative';
    this.redoRegion.el.style.minHeight = '0';
    (this.redoRegion.el.firstChild as HTMLElement).style.position = 'relative';
    const tsContent = h('div', { class: 'toolshelf-content' }, h('div', { class: 'toolshelf-panels' }, this.toolRegion.el), redoWrap);
    (this.toolRegion.el as HTMLElement).style.position = 'absolute';
    (this.toolRegion.el as HTMLElement).style.inset = '0';
    this.toolshelf = h('div', { class: 'side-region left' }, this.tabsEl, tsContent, this.resizeHandle('left'));
    // properties region (right)
    this.nRegion = new PanelRegion(() => npanelPanels(this), area, `${area.id}:ui:`);
    this.npanel = h('div', { class: 'side-region right' }, this.nRegion.el, this.resizeHandle('right'));
    this.main.append(this.toolshelf, this.canvasWrap, this.npanel);
    this.buildTabs();
    this.applyRegionVisibility();
    this.bindEvents();
  }

  get type(): string { return View3D.TYPE; }

  // ---------------------------------------------------------------- lifecycle

  override mount(): void {
    if (this.mounted) return;
    this.mounted = true;
    this.renderer = new ViewportRenderer(this.canvas, this.view, this.display);
    this.resize();
    this.loop();
  }

  override destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    cyclesViewportDestroyed(this);
    this.renderer?.dispose();
    this.saveState();
  }

  private saveState(): void {
    this.state.view = this.view.toJSON();
  }

  override resize(): void {
    if (!this.renderer) return;
    const w = this.canvasWrap.clientWidth, hgt = this.canvasWrap.clientHeight;
    if (w < 1 || hgt < 1) return;
    this.view.setSize(w, hgt);
    this.renderer.setSize(w, hgt);
    const dpr = this.renderer.pixelRatio;
    this.overlay.width = Math.floor(w * dpr);
    this.overlay.height = Math.floor(hgt * dpr);
    this.requestRender();
  }

  requestRender(): void { this.needsRender = true; }

  canvasRect(): DOMRect { return this.canvasWrap.getBoundingClientRect(); }

  private loop = (): void => {
    if (this.destroyed) return;
    this.raf = requestAnimationFrame(this.loop);
    if (!this.renderer) return;
    if (this.area.el.style.display === 'none') return;
    if (this.needsRender || this.view.animating || app.playing) {
      this.needsRender = false;
      this.draw();
    }
  };

  private draw(): void {
    const t0 = performance.now();
    try {
      this.renderer.sync(this.localView);
      cyclesViewportUpdate(this);
      this.renderer.render(this.localView);
      drawOverlay(this);
      cyclesViewportOverlay(this);
    } catch (err) {
      console.error('viewport draw', err);
    }
    this.lastFrameTime = performance.now() - t0;
    this.saveState();
  }

  override refresh(flags: Set<string>): void {
    this.requestRender();
    if (flags.has('select') || flags.has('geometry') || flags.has('all')) this.renderer?.invalidateEdit();
    if (this.state.showToolshelf) {
      this.toolRegion.refresh();
      this.redoRegion.refresh();
    }
    if (this.state.showNPanel) this.nRegion.refresh();
    this.buildTabs();
  }

  // ---------------------------------------------------------------- regions

  private resizeHandle(side: 'left' | 'right'): HTMLElement {
    const el = h('div', { class: 'region-resize' });
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const key = side === 'left' ? 'toolshelfWidth' : 'npanelWidth';
      const start = this.state[key] as number;
      trackDrag(e, (_ev, dx) => {
        const w = Math.max(110, Math.min(600, start + (side === 'left' ? dx : -dx)));
        this.state[key] = w;
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
    // small "+" handles to bring hidden regions back
    this.canvasWrap.querySelectorAll('.region-hidden-handle').forEach((x) => x.remove());
    if (!this.state.showToolshelf) {
      const hnd = h('div', { class: 'region-hidden-handle left', title: 'Show Tool Shelf (T)' }, '+');
      hnd.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.toggleRegion('toolshelf'); });
      this.canvasWrap.append(hnd);
    }
    if (!this.state.showNPanel) {
      const hnd = h('div', { class: 'region-hidden-handle right', title: 'Show Properties (N)' }, '+');
      hnd.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.toggleRegion('npanel'); });
      this.canvasWrap.append(hnd);
    }
    requestAnimationFrame(() => this.resize());
  }

  toggleRegion(which: 'toolshelf' | 'npanel'): void {
    if (which === 'toolshelf') this.state.showToolshelf = !this.state.showToolshelf;
    else this.state.showNPanel = !this.state.showNPanel;
    this.applyRegionVisibility();
    this.refresh(new Set(['all']));
  }

  private tabsKey = '';
  private buildTabs(): void {
    const tabs = TOOL_TABS.filter((t) => t.poll());
    const key = tabs.map((t) => t.id).join() + this.state.toolTab;
    if (key === this.tabsKey) return;
    this.tabsKey = key;
    this.tabsEl.innerHTML = '';
    if (!tabs.some((t) => t.id === this.state.toolTab)) this.state.toolTab = tabs[0]?.id ?? 'Tools';
    for (const t of tabs) {
      const el = h('div', { class: `tool-tab${t.id === this.state.toolTab ? ' active' : ''}` }, t.label);
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.state.toolTab = t.id;
        this.tabsKey = '';
        this.buildTabs();
        this.toolRegion.refresh(true);
      });
      this.tabsEl.append(el);
    }
  }

  // ---------------------------------------------------------------- header

  override headerKey(): string {
    return [app.mode, app.activeObject?.type ?? '', this.display.shading, this.display.manipulator, app.scene.toolSettings.proportionalEdit !== 'DISABLED', app.modal ? 'modal' : '', app.editMesh ? 'em' : ''].join('|');
  }

  override drawHeader(l: Layout): void {
    if (app.modal?.status && this.transformState) {
      // During transform Blender replaces the header with the status text.
      l.el.append(h('div', { class: 'header-status' }, ''));
      const upd = () => {
        const s = l.el.querySelector('.header-status');
        if (s && app.modal?.status) s.textContent = app.modal.status();
      };
      this.headerRoot.widgets.push({ update: upd });
      upd();
      return;
    }
    const area = () => this.area;
    const row = l.row();
    row.el.classList.add('header-row');
    row.el.style.flex = '0 0 auto';
    row.el.append(
      pulldown({ label: 'View', items: () => viewMenu(this) }, area, true),
      pulldown({ label: 'Select', items: () => selectMenu() }, area, true),
      pulldown({ label: 'Add', items: () => addMenu() }, area, true),
      activeEditType()?.handler.menu ? pulldown({ label: activeEditType()!.handler.menuLabel ?? 'Edit', items: () => activeEditType()?.handler.menu?.() ?? [] }, area, true)
      : app.mode === 'EDIT' ? pulldown({ label: 'Mesh', items: () => meshMenu() }, area, true)
        : app.mode === 'SCULPT' ? pulldown({ label: 'Sculpt', items: () => sculptMenu() }, area, true)
          : app.mode === 'VERTEX_PAINT' ? pulldown({ label: 'Paint', items: () => vpaintMenu() }, area, true)
          : pulldown({ label: 'Object', items: () => objectMenu() }, area, true),
    );
    drawView3DHeader(this, l);
  }

  override headerMenuItems() { return []; }

  override onKey(e: KeyboardEvent): boolean {
    const et = activeEditType();
    if (et?.handler.key?.(this, et.ob, e)) return true;
    if (app.mode === 'SCULPT') return sculptKey(this, e);
    const eo = app.editObj;
    if (app.mode === 'EDIT' && eo?.type === 'FONT') {
      if (textEditKey(eo, e)) { app.notify('geometry', 'scene'); this.requestRender(); return true; }
      return false;
    }
    if (app.mode === 'VERTEX_PAINT') {
      if (e.shiftKey && e.code === 'KeyK') { fillVertexColors(); return true; }
      return vpaintKey(this, e);
    }
    return false;
  }

  // ---------------------------------------------------------------- events

  private bindEvents(): void {
    const el = this.canvasWrap;
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    el.addEventListener('pointermove', (e) => this.onHover(e));
    el.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    el.addEventListener('dblclick', (e) => e.preventDefault());
  }

  local(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.canvasRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private get selectButton(): number { return app.prefs.selectMouse === 'RIGHT' ? 2 : 0; }
  private get actionButton(): number { return app.prefs.selectMouse === 'RIGHT' ? 0 : 2; }

  private onHover(e: PointerEvent): void {
    if (app.mode === 'SCULPT' || app.mode === 'VERTEX_PAINT' || activeEditType()?.handler.trackBrush) { this.brushPos = this.local(e); this.requestRender(); }
    if (app.modal || e.buttons) return;
    const p = this.local(e);
    const hit = this.display.manipulator && this.renderer ? manipulatorHit(this, p.x, p.y) : null;
    const key = hit ? `${hit.kind}${hit.axis}` : '';
    const prev = this.manipHover ? `${this.manipHover.kind}${this.manipHover.axis}` : '';
    if (key !== prev) { this.manipHover = hit; this.requestRender(); }
  }

  private onPointerDown(e: PointerEvent): void {
    if (app.modal) return; // handled by the global modal dispatcher
    const p = this.local(e);
    const emulate = app.prefs.emulate3Button && e.altKey && e.button === 0;
    if (e.button === 1 || emulate) {
      e.preventDefault();
      this.navigateDrag(e, emulate);
      return;
    }
    const et = activeEditType();
    if (et?.handler.pointerDown && (e.button === this.actionButton || e.button === this.selectButton)
      && et.handler.pointerDown(this, et.ob, e, e.button === this.actionButton ? 'ACTION' : 'SELECT')) { e.preventDefault(); return; }
    if (app.mode === 'SCULPT' && e.button === this.actionButton) {
      e.preventDefault();
      startSculptStroke(this, e);
      return;
    }
    if (app.mode === 'VERTEX_PAINT' && e.button === this.actionButton) {
      e.preventDefault();
      startPaintStroke(this, e);
      return;
    }
    if ((app.mode === 'SCULPT' || app.mode === 'VERTEX_PAINT') && e.button === this.selectButton) { e.preventDefault(); return; }
    if (e.button === this.actionButton) {
      e.preventDefault();
      // manipulator
      if (this.display.manipulator) {
        const hit = manipulatorHit(this, p.x, p.y);
        if (hit) { this.startManipulator(hit, p); return; }
      }
      if (e.ctrlKey && !e.altKey) { startLasso(this, p.x, p.y, e.shiftKey ? 'SUB' : 'ADD'); return; }
      // click: place 3D cursor (at the depth of the current cursor, like Blender 2.79)
      trackDrag(e, () => {}, (up, moved) => {
        if (moved) return;
        const q = this.local(up);
        const cur = new Vector3(...app.scene.cursor);
        const np = this.view.unprojectAtDepth(q.x, q.y, cur);
        app.scene.cursor = [np.x, np.y, np.z];
        app.notify('view');
        this.requestRender();
      }, { threshold: 4 });
      return;
    }
    if (e.button === this.selectButton) {
      e.preventDefault();
      const extend = e.shiftKey;
      if (app.mode === 'EDIT' || et) {
        if (e.altKey) { if (loopSelect(this, p.x, p.y, extend)) app.pushUndo('Loop Select'); return; }
        const ok = clickSelectEdit(this, p.x, p.y, extend);
        if (ok) app.pushUndo('Select');
        // tweak: drag after selecting moves the selection
        this.tweakToGrab(e);
        return;
      }
      const ok = clickSelectObject(this, p.x, p.y, extend);
      if (ok) app.pushUndo('Select');
      this.tweakToGrab(e);
    }
  }

  /** Drag with the select button after selecting starts a grab that ends on release. */
  private tweakToGrab(e: PointerEvent): void {
    const sx = e.clientX, sy = e.clientY;
    const button = e.button;
    const move = (ev: PointerEvent) => {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < app.prefs.dragThreshold + 3) return;
      cleanup();
      if (app.modal) return;
      const valid = app.mode === 'EDIT' ? !!app.editMesh?.vsel.some(Boolean) || editTypeHasSelection() : app.selectedObjects().length > 0;
      if (!valid) return;
      startTransform({ mode: 'TRANSLATION', view: this, mouse: this.local({ clientX: sx, clientY: sy }), releaseConfirm: true });
      // feed the current position immediately
      (app.modal as import('../../app').ModalHandler | null)?.onEvent(ev);
    };
    const up = (ev: PointerEvent) => { if (ev.button === button) cleanup(); };
    const cleanup = () => { window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', up, true); };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
  }

  private startManipulator(hit: ManipHit, p: { x: number; y: number }): void {
    const mode: TransformMode = hit.kind === 'translate' ? 'TRANSLATION' : hit.kind === 'rotate' ? (hit.axis === 'trackball' ? 'TRACKBALL' : 'ROTATION') : 'RESIZE';
    const constraint = typeof hit.axis === 'number' ? [0, 1, 2].map((i) => i === hit.axis) : null;
    startTransform({ mode, view: this, mouse: p, constraint, orientation: app.scene.toolSettings.transformOrientation, releaseConfirm: true });
  }

  private navigateDrag(e: PointerEvent, emulated: boolean): void {
    const mode = e.shiftKey ? 'pan' : e.ctrlKey ? 'zoom' : 'orbit';
    let lx = e.clientX, ly = e.clientY;
    const startY = e.clientY;
    void startY;
    if (app.prefs.orbitAroundSelection && mode === 'orbit') this.orbitAroundSelection();
    trackDrag(e, (ev) => {
      const dx = ev.clientX - lx, dy = ev.clientY - ly;
      lx = ev.clientX; ly = ev.clientY;
      if (mode === 'orbit') this.view.orbit(dx, dy, app.prefs.orbitStyle === 'TRACKBALL');
      else if (mode === 'pan') this.view.pan(dx, dy);
      else this.view.zoom(Math.pow(1.01, dy), undefined, undefined);
      this.requestRender();
      app.notify('view');
    }, undefined, { threshold: 0, cursor: mode === 'pan' ? 'move' : 'default' });
    void emulated;
  }

  private orbitAroundSelection(): void {
    const c = this.selectionCenter();
    if (!c) return;
    // move pivot without moving the eye
    const eye = this.view.eye();
    this.view.target.copy(c);
    this.view.dist = Math.max(0.01, eye.distanceTo(c));
    const up = new Vector3(0, 1, 0).applyQuaternion(this.view.rot);
    const m = new Matrix4().lookAt(eye, c, up);
    this.view.rot.copy(new Quaternion().setFromRotationMatrix(m));
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    if (app.modal) { app.modal.onEvent(e); return; }
    const p = this.local(e);
    const pinch = e.ctrlKey && Math.abs(e.deltaY) < 10 && !Number.isInteger(e.deltaY);
    if (e.ctrlKey && !pinch) this.view.pan(e.deltaY > 0 ? -20 : 20, 0);
    else if (e.shiftKey) this.view.pan(0, e.deltaY > 0 ? -20 : 20);
    else {
      let d = e.deltaY;
      if (app.prefs.invertZoomWheel) d = -d;
      const steps = pinch ? d / 25 : Math.sign(d) * Math.min(3, Math.max(1, Math.abs(d) / 100));
      this.view.zoom(Math.pow(1.2, steps), p.x, p.y);
    }
    this.requestRender();
    app.notify('view');
  }

  // ---------------------------------------------------------------- helpers for operators

  /** Centre of the current selection in world space. */
  selectionCenter(): Vector3 | null {
    const etPts = editTypeSelectedPoints();
    if (etPts) return etPts.length ? etPts.reduce((a, p) => a.add(p), new Vector3()).multiplyScalar(1 / etPts.length) : null;
    const md = app.editMesh, ob = app.editObj;
    if (md && ob) {
      const m = app.matrices.world(ob);
      const c = new Vector3();
      let n = 0;
      md.verts.forEach((v, i) => { if (md.vsel[i]) { c.add(new Vector3(...v).applyMatrix4(m)); n++; } });
      return n ? c.multiplyScalar(1 / n) : null;
    }
    const sel = app.selectedObjects();
    if (!sel.length) return null;
    const c = new Vector3();
    for (const o of sel) c.add(app.matrices.location(o));
    return c.multiplyScalar(1 / sel.length);
  }

  /** Bounding sphere of selected (or all visible) geometry, for View Selected / View All. */
  boundsOf(selectedOnly: boolean): { center: Vector3; radius: number } | null {
    const pts: Vector3[] = [];
    const md = app.editMesh, eob = app.editObj;
    const etPts = selectedOnly ? editTypeSelectedPoints() : null;
    if (etPts) pts.push(...etPts);
    else if (selectedOnly && md && eob) {
      const m = app.matrices.world(eob);
      md.verts.forEach((v, i) => { if (md.vsel[i]) pts.push(new Vector3(...v).applyMatrix4(m)); });
    } else {
      for (const ob of app.objects()) {
        if (!this.renderer.isVisible(ob, this.localView)) continue;
        if (selectedOnly && !ob.select) continue;
        if (ob.type === 'MESH') {
          const em = app.evalMesh(ob);
          const m = app.matrices.world(ob);
          if (em && em.verts.length) {
            const step = Math.max(1, Math.floor(em.verts.length / 2000));
            for (let i = 0; i < em.verts.length; i += step) pts.push(new Vector3(...em.verts[i]).applyMatrix4(m));
            continue;
          }
        }
        const c = app.matrices.location(ob);
        pts.push(c.clone().addScalar(0.5), c.clone().addScalar(-0.5));
      }
    }
    if (!pts.length) return null;
    const min = new Vector3(Infinity, Infinity, Infinity), max = new Vector3(-Infinity, -Infinity, -Infinity);
    for (const p of pts) { min.min(p); max.max(p); }
    const center = min.clone().add(max).multiplyScalar(0.5);
    let radius = 0;
    for (const p of pts) radius = Math.max(radius, p.distanceTo(center));
    return { center, radius: Math.max(radius, 0.1) };
  }

  toggleLocalView(): void {
    if (this.localView) {
      this.localView = null;
      if (this.savedView) this.view.fromJSON(this.savedView);
      this.savedView = null;
    } else {
      const sel = app.selectedObjects();
      if (!sel.length) { app.report('WARNING', 'No object selected'); return; }
      this.savedView = this.view.toJSON();
      this.localView = new Set(sel.map((o) => o.id));
      const b = this.boundsOf(true);
      if (b) this.view.frameBounds(b.center, b.radius);
    }
    this.requestRender();
    app.notify('view');
  }

  get frameTime(): number { return this.lastFrameTime; }
}


setViewResolver((ctx) => {
  const a = ctx.area as Area | null | undefined;
  if (a && a.editor instanceof View3D) return a.editor;
  return null;
});

registerEditor({ type: View3D.TYPE, label: '3D View', icon: 'VIEW3D', create: (area, state) => new View3D(area, state) });
