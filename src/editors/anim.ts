// Animation editors: Timeline, Dope Sheet and Graph Editor (sharing a time axis).

import { app, type ModalHandler } from '../app';
import { Editor, registerEditor } from '../screen/editor';
import type { Area } from '../screen/screen';
import { h, trackDrag } from '../ui/dom';
import { icon } from '../ui/icons';
import { pulldown, showMenu, type MenuItem } from '../ui/menu';
import type { Layout } from '../ui/layout';
import { ANIMATABLE, evaluateFCurve, objectKeyFrames, sortKeys, KEYING_SETS, channelLabel } from '../core/anim';
import type { BObject, FCurve, Interpolation, Keyframe } from '../core/types';
import { confirmPopup } from '../ui/popup';

const AXIS = ['X', 'Y', 'Z'];
const CURVE_COL = ['#ff5050', '#50ff50', '#5080ff'];

function fcurveLabel(fc: FCurve): string {
  const info = ANIMATABLE[fc.path];
  return info?.size ? `${AXIS[fc.index]} ${info.label}` : info?.label ?? channelLabel(fc.path, fc.index);
}

function animObjects(onlySelected: boolean): BObject[] {
  return app.objects().filter((o) => o.fcurves.length && (!onlySelected || o.select) && !o.hide);
}

function afterKeyEdit(name: string): void {
  for (const o of app.objects()) for (const fc of o.fcurves) sortKeys(fc);
  app.evaluateAnimation();
  app.pushUndo(name);
  app.notify('frame', 'scene', 'data');
}

// ------------------------------------------------------------------ shared time axis editor

abstract class TimeEditor extends Editor {
  protected canvas: HTMLCanvasElement;
  protected region: HTMLElement;
  protected channels: HTMLElement | null = null;
  protected dpr = Math.min(2, window.devicePixelRatio || 1);
  protected raf = 0;

  constructor(area: Area, state: Record<string, unknown>, withChannels: boolean) {
    super(area, state);
    state.viewStart ??= app.scene.frameStart - 10;
    state.viewEnd ??= app.scene.frameEnd + 10;
    state.onlySelected ??= true;
    this.canvas = h('canvas', { style: { position: 'absolute', inset: '0', width: '100%', height: '100%' } }) as HTMLCanvasElement;
    this.region = h('div', { class: 'region', style: { flex: '1 1 auto', position: 'relative' } }, this.canvas);
    if (withChannels) {
      this.channels = h('div', { class: 'region-scroll', style: { position: 'relative', background: '#727272', borderRight: '1px solid #3a3a3a', overflowY: 'hidden' } });
      const wrap = h('div', { class: 'region', style: { flex: '0 0 200px', position: 'relative' } }, this.channels);
      this.main.append(wrap);
    }
    this.main.append(this.region);
    this.region.addEventListener('contextmenu', (e) => e.preventDefault());
    this.region.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.region.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
  }

  get vs(): number { return this.state.viewStart as number; }
  get ve(): number { return this.state.viewEnd as number; }
  get width(): number { return this.region.clientWidth; }
  get height(): number { return this.region.clientHeight; }
  frameToX(f: number): number { return ((f - this.vs) / (this.ve - this.vs)) * this.width; }
  xToFrame(x: number): number { return this.vs + (x / Math.max(1, this.width)) * (this.ve - this.vs); }

  viewAll(): void {
    const s = app.scene;
    const pad = Math.max(2, (s.frameEnd - s.frameStart) * 0.04);
    this.state.viewStart = s.frameStart - pad;
    this.state.viewEnd = s.frameEnd + pad;
    this.draw();
  }

  override resize(): void {
    this.canvas.width = Math.max(1, Math.floor(this.width * this.dpr));
    this.canvas.height = Math.max(1, Math.floor(this.height * this.dpr));
    this.draw();
  }

  override refresh(): void {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => { this.draw(); this.drawChannels(); });
  }

  protected drawChannels(): void {}

  protected scrub(e: PointerEvent): void {
    const set = (ev: PointerEvent) => {
      const r = this.region.getBoundingClientRect();
      app.setFrame(Math.round(this.xToFrame(ev.clientX - r.left)));
    };
    set(e);
    trackDrag(e, (ev) => set(ev), () => app.pushUndo('Change Frame'), { threshold: 0 });
  }

  protected panDrag(e: PointerEvent, vertical = false): void {
    let lx = e.clientX, ly = e.clientY;
    trackDrag(e, (ev) => {
      const dx = ev.clientX - lx, dy = ev.clientY - ly;
      lx = ev.clientX; ly = ev.clientY;
      if (e.ctrlKey) {
        // zoom around the cursor
        const c = this.xToFrame(ev.clientX - this.region.getBoundingClientRect().left);
        const f = Math.pow(1.01, -dx);
        this.state.viewStart = c - (c - this.vs) * f;
        this.state.viewEnd = c + (this.ve - c) * f;
      } else {
        const df = (dx / this.width) * (this.ve - this.vs);
        this.state.viewStart = this.vs - df;
        this.state.viewEnd = this.ve - df;
        if (vertical) this.panVertical(dy);
      }
      this.draw();
    }, undefined, { threshold: 0 });
  }

  protected panVertical(_dy: number): void {}

  protected onWheel(e: WheelEvent): void {
    e.preventDefault();
    if (e.ctrlKey || e.shiftKey) {
      const df = (e.deltaY > 0 ? 1 : -1) * (this.ve - this.vs) * 0.1;
      this.state.viewStart = this.vs + df;
      this.state.viewEnd = this.ve + df;
    } else {
      const r = this.region.getBoundingClientRect();
      const c = this.xToFrame(e.clientX - r.left);
      const f = e.deltaY > 0 ? 1.15 : 1 / 1.15;
      this.state.viewStart = c - (c - this.vs) * f;
      this.state.viewEnd = c + (this.ve - c) * f;
    }
    this.draw();
  }

  protected abstract onPointerDown(e: PointerEvent): void;
  protected abstract draw(): void;

  /** Frame grid with numbers, scene range shading and the current frame indicator. */
  protected drawTimeBase(ctx: CanvasRenderingContext2D, w: number, hh: number, bg = '#737373'): void {
    const s = app.scene;
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, hh);
    // outside the scene range is darkened
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    const x0 = this.frameToX(s.usePreviewRange ? s.previewStart : s.frameStart), x1 = this.frameToX(s.usePreviewRange ? s.previewEnd : s.frameEnd);
    ctx.fillRect(0, 0, Math.max(0, x0), hh);
    ctx.fillRect(x1, 0, Math.max(0, w - x1), hh);
    // grid
    const span = this.ve - this.vs;
    const targetPx = 50;
    const raw = (span / w) * targetPx;
    const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
    const step = steps.find((x) => x >= raw) ?? 10000;
    ctx.strokeStyle = 'rgba(0,0,0,0.18)';
    ctx.fillStyle = '#000';
    ctx.font = '11px "DejaVu Sans", Verdana, sans-serif';
    ctx.textAlign = 'center';
    ctx.lineWidth = 1;
    for (let f = Math.ceil(this.vs / step) * step; f <= this.ve; f += step) {
      const x = Math.round(this.frameToX(f)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, hh - 16); ctx.stroke();
      ctx.fillText(String(f), x, hh - 4);
    }
  }

  protected drawCurrentFrame(ctx: CanvasRenderingContext2D, hh: number): void {
    const f = app.scene.frameCurrent;
    const x = Math.round(this.frameToX(f)) + 0.5;
    ctx.strokeStyle = '#60c040';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, hh); ctx.stroke();
    ctx.font = '11px "DejaVu Sans", Verdana, sans-serif';
    const label = String(f);
    const tw = ctx.measureText(label).width + 8;
    ctx.fillStyle = '#60c040';
    ctx.fillRect(x - tw / 2, hh - 17, tw, 16);
    ctx.fillStyle = '#000';
    ctx.textAlign = 'center';
    ctx.fillText(label, x, hh - 5);
  }

  protected drawMarkers(ctx: CanvasRenderingContext2D, hh: number): void {
    ctx.font = '11px "DejaVu Sans", Verdana, sans-serif';
    ctx.textAlign = 'left';
    for (const m of app.scene.markers) {
      const x = this.frameToX(m.frame);
      ctx.fillStyle = m.select ? '#fff' : '#000';
      ctx.beginPath(); ctx.moveTo(x - 5, hh - 20); ctx.lineTo(x + 5, hh - 20); ctx.lineTo(x, hh - 26); ctx.closePath(); ctx.fill();
      ctx.fillText(m.name, x + 6, hh - 20);
      ctx.strokeStyle = 'rgba(0,0,0,0.3)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, hh - 26); ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  protected ctx(): CanvasRenderingContext2D | null {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    return ctx;
  }

  protected markerMenu(): MenuItem[] {
    return [
      { label: 'Add Marker', op: 'marker.add' },
      { label: 'Rename Marker', op: 'marker.rename' },
      { label: 'Delete Marker', op: 'marker.delete' },
    ];
  }

  protected frameMenu(): MenuItem[] {
    return [
      { label: 'Set Start Frame', op: 'time.start_frame_set' },
      { label: 'Set End Frame', op: 'time.end_frame_set' },
      { type: 'separator' },
      { label: 'Jump to Start', op: 'screen.frame_jump', props: { end: false } },
      { label: 'Jump to End', op: 'screen.frame_jump', props: { end: true } },
      { label: 'Jump to Next Keyframe', op: 'screen.keyframe_jump', props: { next: true } },
      { label: 'Jump to Previous Keyframe', op: 'screen.keyframe_jump', props: { next: false } },
    ];
  }

  protected playbackControls(l: Layout): void {
    const pb = l.row(true);
    pb.el.style.flex = '0 0 auto';
    pb.operator('screen.frame_jump', { iconOnly: true, icon: 'REW', props: { end: false } });
    pb.operator('screen.keyframe_jump', { iconOnly: true, icon: 'PREV_KEYFRAME', props: { next: false } });
    const rev = pb.button('', () => { if (app.playing) app.stop(); else void app.callOperator('screen.animation_play', { reverse: true }); }, { icon: 'PLAY_REVERSE', iconOnly: true, tip: 'Play animation in reverse' });
    const play = pb.button('', () => { if (app.playing) app.stop(); else void app.callOperator('screen.animation_play', { reverse: false }); }, { icon: 'PLAY', iconOnly: true, tip: 'Play animation (Alt+A)' });
    pb.operator('screen.keyframe_jump', { iconOnly: true, icon: 'NEXT_KEYFRAME', props: { next: true } });
    pb.operator('screen.frame_jump', { iconOnly: true, icon: 'FF', props: { end: true } });
    this.headerRoot.widgets.push({
      update: () => {
        play.innerHTML = '';
        play.append(icon(app.playing === 1 ? 'PAUSE' : 'PLAY'));
        rev.innerHTML = '';
        rev.append(icon(app.playing === -1 ? 'PAUSE' : 'PLAY_REVERSE'));
      },
    });
  }

  protected rangeFields(l: Layout): void {
    const s = () => app.scene;
    const r = l.row(true);
    r.el.style.flex = '0 0 auto';
    r.prop({ kind: 'bool', name: 'Use Preview Range', get: () => s().usePreviewRange, set: (v) => { const sc = s(); sc.usePreviewRange = v; if (v) { sc.previewStart = sc.frameStart; sc.previewEnd = sc.frameEnd; } }, notify: ['frame'], description: 'Use an alternative start/end frame range for animation playback' }, { iconOnly: true, icon: 'TIME' });
    const se = l.row(true);
    se.el.style.flex = '0 0 auto';
    se.el.style.width = '230px';
    se.prop({ kind: 'int', name: s().usePreviewRange ? 'P.Start' : 'Start', min: 0, max: 1048574, get: () => (s().usePreviewRange ? s().previewStart : s().frameStart), set: (v) => { const sc = s(); if (sc.usePreviewRange) sc.previewStart = v; else { sc.frameStart = v; if (sc.frameEnd < v) sc.frameEnd = v; } }, notify: ['frame'], description: 'First frame of the playback/rendering range' });
    se.prop({ kind: 'int', name: s().usePreviewRange ? 'P.End' : 'End', min: 0, max: 1048574, get: () => (s().usePreviewRange ? s().previewEnd : s().frameEnd), set: (v) => { const sc = s(); if (sc.usePreviewRange) sc.previewEnd = v; else { sc.frameEnd = v; if (sc.frameStart > v) sc.frameStart = v; } }, notify: ['frame'], description: 'Final frame of the playback/rendering range' });
    const cf = l.prop({ kind: 'int', name: '', min: -1048574, max: 1048574, get: () => s().frameCurrent, set: (v) => app.setFrame(v), notify: ['frame'], undo: 'Change Frame', description: 'Current Frame' }, { text: '' });
    cf.style.flex = '0 0 60px';
  }
}

// ------------------------------------------------------------------ Timeline

export class Timeline extends TimeEditor {
  static readonly TYPE = 'TIMELINE';
  constructor(area: Area, state: Record<string, unknown>) {
    super(area, state, false);
    this.headerPosition = 'bottom';
  }
  get type(): string { return Timeline.TYPE; }

  override headerKey(): string { return `${app.scene.usePreviewRange}${app.scene.toolSettings.useKeyframeInsertAuto}`; }

  override drawHeader(l: Layout): void {
    const area = () => this.area;
    const row = l.row();
    row.el.classList.add('header-row');
    row.el.style.flex = '0 0 auto';
    row.el.append(
      pulldown({ label: 'View', items: () => [
        { label: 'Show Frame Number Indicator', checked: true, disabled: true },
        { label: 'Only Keyframes from Selected Channels', checked: !!this.state.onlySelected, action: () => { this.state.onlySelected = !this.state.onlySelected; this.draw(); } },
        { type: 'separator' },
        { label: 'View All', op: 'time.view_all' },
        { label: 'Toggle Maximize Area', op: 'screen.screen_full_area' },
      ] }, area, true),
      pulldown({ label: 'Marker', items: () => this.markerMenu() }, area, true),
      pulldown({ label: 'Frame', items: () => this.frameMenu() }, area, true),
      pulldown({ label: 'Playback', items: () => [
        { label: 'Audio Scrubbing', disabled: true },
        { label: 'AV-sync', checked: app.scene.syncMode === 'AUDIO_SYNC', action: () => { app.scene.syncMode = 'AUDIO_SYNC'; } },
        { label: 'Frame Dropping', checked: app.scene.syncMode === 'FRAME_DROP', action: () => { app.scene.syncMode = 'FRAME_DROP'; } },
        { label: 'No Sync', checked: app.scene.syncMode === 'NONE', action: () => { app.scene.syncMode = 'NONE'; } },
      ] }, area, true),
    );
    this.rangeFields(l);
    this.playbackControls(l);
    const rec = l.row(true);
    rec.el.style.flex = '0 0 auto';
    rec.prop({ kind: 'bool', name: 'Auto Keying', get: () => app.scene.toolSettings.useKeyframeInsertAuto, set: (v) => { app.scene.toolSettings.useKeyframeInsertAuto = v; }, description: 'Automatic keyframe insertion for Objects and Bones', notify: ['view'] }, { iconOnly: true, icon: 'REC', iconOn: 'REC_ON' });
    const ks = l.prop({ kind: 'enum', name: 'Active Keying Set', items: [{ id: '', label: '' }, ...KEYING_SETS.map((k) => ({ id: k.id, label: k.label }))], get: () => app.scene.keyingSet, set: (v) => { app.scene.keyingSet = v; }, description: 'Active Keying Set' }, { noLabel: true, icon: 'KEYINGSET' });
    ks.style.flex = '0 0 120px';
    const kb = l.row(true);
    kb.el.style.flex = '0 0 auto';
    kb.operator('anim.keyframe_insert_menu', { iconOnly: true, icon: 'KEY_HLT' });
    kb.operator('anim.keyframe_delete_v3d', { iconOnly: true, icon: 'KEY_DEHLT', props: {} });
  }

  protected draw(): void {
    const ctx = this.ctx();
    if (!ctx) return;
    const w = this.width, hh = this.height;
    this.drawTimeBase(ctx, w, hh);
    // keyframes of selected (or active) objects
    const obs = this.state.onlySelected ? app.selectedObjects() : app.objects();
    const frames = new Set<number>();
    for (const o of obs) for (const f of objectKeyFrames(o)) frames.add(f);
    ctx.strokeStyle = '#e8d84a';
    ctx.lineWidth = 2;
    for (const f of frames) {
      const x = Math.round(this.frameToX(f)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, hh - 18); ctx.stroke();
    }
    this.drawMarkers(ctx, hh);
    this.drawCurrentFrame(ctx, hh);
  }

  protected onPointerDown(e: PointerEvent): void {
    if (e.button === 0) this.scrub(e);
    else if (e.button === 1) this.panDrag(e);
    else if (e.button === 2) {
      // select markers
      const r = this.region.getBoundingClientRect();
      const x = e.clientX - r.left;
      const m = app.scene.markers.find((mk) => Math.abs(this.frameToX(mk.frame) - x) < 6);
      if (!e.shiftKey) for (const mk of app.scene.markers) mk.select = false;
      if (m) { m.select = !m.select || !e.shiftKey; app.pushUndo('Select Marker'); }
      this.draw();
    }
  }
}

// ------------------------------------------------------------------ Dope Sheet / Graph Editor shared channel logic

interface Channel { kind: 'summary' | 'object' | 'fcurve'; ob?: BObject; fc?: FCurve; label: string; y: number }

abstract class KeyEditor extends TimeEditor {
  protected rowH = 20;
  protected channelList: Channel[] = [];

  constructor(area: Area, state: Record<string, unknown>) {
    super(area, state, true);
    state.collapsed ??= {};
  }

  protected buildChannels(): Channel[] {
    const out: Channel[] = [];
    let y = 0;
    const obs = animObjects(!!this.state.onlySelected);
    out.push({ kind: 'summary', label: 'Summary', y: y++ });
    for (const ob of obs) {
      out.push({ kind: 'object', ob, label: ob.name, y: y++ });
      if ((this.state.collapsed as Record<string, boolean>)[ob.id]) continue;
      for (const fc of ob.fcurves) out.push({ kind: 'fcurve', ob, fc, label: fcurveLabel(fc), y: y++ });
    }
    return out;
  }

  protected allSelectedKeys(): { ob: BObject; fc: FCurve; k: Keyframe }[] {
    const out: { ob: BObject; fc: FCurve; k: Keyframe }[] = [];
    for (const ob of animObjects(!!this.state.onlySelected)) for (const fc of ob.fcurves) for (const k of fc.keys) if (k.select) out.push({ ob, fc, k });
    return out;
  }

  protected allKeys(): { ob: BObject; fc: FCurve; k: Keyframe }[] {
    const out: { ob: BObject; fc: FCurve; k: Keyframe }[] = [];
    for (const ob of animObjects(!!this.state.onlySelected)) for (const fc of ob.fcurves) for (const k of fc.keys) out.push({ ob, fc, k });
    return out;
  }

  protected override drawChannels(): void {
    const el = this.channels;
    if (!el) return;
    this.channelList = this.buildChannels();
    el.innerHTML = '';
    for (const c of this.channelList) {
      const indent = c.kind === 'fcurve' ? 26 : c.kind === 'object' ? 8 : 4;
      const bg = c.kind === 'summary' ? '#4e4e6a' : c.kind === 'object' ? '#5a5a5a' : 'transparent';
      const row = h('div', { style: { height: `${this.rowH}px`, display: 'flex', alignItems: 'center', gap: '4px', paddingLeft: `${indent}px`, background: bg, color: c.kind === 'fcurve' ? '#000' : '#fff', borderBottom: '1px solid rgba(0,0,0,0.12)' } });
      if (c.kind === 'object' && c.ob) {
        const ob = c.ob;
        const col = (this.state.collapsed as Record<string, boolean>)[ob.id];
        const tri = icon(col ? 'DISCLOSURE_TRI_RIGHT' : 'DISCLOSURE_TRI_DOWN');
        tri.style.cursor = 'pointer';
        tri.addEventListener('pointerdown', (e) => { e.stopPropagation(); (this.state.collapsed as Record<string, boolean>)[ob.id] = !col; this.refresh(); });
        row.append(tri, icon('OBJECT_DATA'));
      }
      if (c.kind === 'fcurve' && c.fc) {
        const sw = h('div', { style: { width: '10px', height: '10px', background: CURVE_COL[c.fc.index] ?? '#ccc', border: '1px solid #000' } });
        row.append(sw);
      }
      const label = h('div', { style: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: c.fc?.select || c.ob?.select && c.kind === 'object' ? 'bold' : 'normal' } }, c.label);
      row.append(label);
      if (c.kind === 'fcurve' && c.fc) {
        const fc = c.fc;
        const mute = h('div', { class: 'icon-btn', title: 'Mute (does not contribute to the result)' }, icon(fc.mute ? 'CHECKBOX_DEHLT' : 'CHECKBOX_HLT'));
        mute.addEventListener('pointerdown', (e) => { e.stopPropagation(); fc.mute = !fc.mute; afterKeyEdit('Mute Channel'); });
        row.append(mute);
      }
      row.addEventListener('pointerdown', (e) => {
        if (c.kind === 'object' && c.ob) {
          if (!e.shiftKey && !e.ctrlKey) app.deselectAll();
          c.ob.select = true;
          app.activeObject = c.ob;
          app.pushUndo('Select');
          app.notify('select');
        } else if (c.fc) {
          for (const o of app.objects()) for (const f of o.fcurves) if (!e.shiftKey) f.select = false;
          c.fc.select = !c.fc.select || !e.shiftKey;
          this.refresh();
        }
      });
      el.append(row);
    }
  }

  // key operations
  protected deleteKeys(): void {
    const sel = this.allSelectedKeys();
    if (!sel.length) return;
    for (const ob of app.objects()) {
      for (const fc of ob.fcurves) fc.keys = fc.keys.filter((k) => !k.select);
      ob.fcurves = ob.fcurves.filter((fc) => fc.keys.length);
    }
    afterKeyEdit('Delete Keyframes');
  }

  protected setInterpolation(interp: Interpolation): void {
    for (const { k } of this.allSelectedKeys()) k.interpolation = interp;
    afterKeyEdit('Set Keyframe Interpolation');
  }

  protected selectAllKeys(): void {
    const keys = this.allKeys();
    const any = keys.some((x) => x.k.select);
    for (const { k } of keys) k.select = !any;
    app.pushUndo('Select All');
    this.refresh();
  }

  protected duplicateKeys(): void {
    for (const { fc, k } of this.allSelectedKeys()) { k.select = false; fc.keys.push({ ...k, select: true }); }
    this.grabKeys(false);
  }

  /** Move selected keys with the mouse (G). Graph editor also moves values. */
  protected grabKeys(values: boolean): void {
    const sel = this.allSelectedKeys();
    if (!sel.length) return;
    const start = sel.map((s) => ({ f: s.k.frame, v: s.k.value }));
    const r = this.region.getBoundingClientRect();
    const sx = app.mouse.x - r.left, sy = app.mouse.y - r.top;
    const fpp = (this.ve - this.vs) / Math.max(1, this.width);
    const vpp = this.valuePerPixel();
    const h2: ModalHandler = {
      status: () => `Move keyframes — LMB/Enter confirm, RMB/Esc cancel`,
      cancel: () => { sel.forEach((s, i) => { s.k.frame = start[i].f; s.k.value = start[i].v; }); app.endModal(h2); afterKeyEdit('Cancel'); },
      onEvent: (e) => {
        if (e.type === 'pointermove') {
          const pe = e as PointerEvent;
          const df = Math.round((pe.clientX - r.left - sx) * fpp);
          const dv = values ? -(pe.clientY - r.top - sy) * vpp : 0;
          sel.forEach((s, i) => { s.k.frame = start[i].f + (pe.ctrlKey && !values ? 0 : df); s.k.value = start[i].v + dv; });
          app.evaluateAnimation();
          app.notify('frame', 'scene');
          return true;
        }
        if (e.type === 'pointerdown' || e.type === 'keydown') {
          const ok = e.type === 'pointerdown' ? (e as PointerEvent).button === 0 : (e as KeyboardEvent).key === 'Enter';
          const cancel = e.type === 'pointerdown' ? (e as PointerEvent).button === 2 : (e as KeyboardEvent).key === 'Escape';
          if (ok) { app.endModal(h2); afterKeyEdit('Transform Keyframes'); }
          else if (cancel) h2.cancel();
          return true;
        }
        return true;
      },
    };
    app.startModal(h2);
  }

  protected valuePerPixel(): number { return 0; }

  protected keyMenu(): MenuItem[] {
    return [
      { label: 'Duplicate', shortcut: 'Shift D', action: () => this.duplicateKeys() },
      { label: 'Delete Keyframes', shortcut: 'X', action: () => this.deleteKeys() },
      { type: 'separator' },
      { type: 'submenu', label: 'Interpolation Mode', items: [
        { label: 'Constant', action: () => this.setInterpolation('CONSTANT') },
        { label: 'Linear', action: () => this.setInterpolation('LINEAR') },
        { label: 'Bezier', action: () => this.setInterpolation('BEZIER') },
      ] },
      { type: 'separator' },
      { label: 'Insert Keyframes', op: 'anim.keyframe_insert_menu' },
    ];
  }

  protected selectMenu(): MenuItem[] {
    return [
      { label: '(De)select All', shortcut: 'A', action: () => this.selectAllKeys() },
      { label: 'Inverse', shortcut: 'Ctrl I', action: () => { for (const { k } of this.allKeys()) k.select = !k.select; app.pushUndo('Select Inverse'); this.refresh(); } },
      { type: 'separator' },
      { label: 'Columns on Selected Keys', action: () => { const fr = new Set(this.allSelectedKeys().map((x) => x.k.frame)); for (const { k } of this.allKeys()) if (fr.has(k.frame)) k.select = true; this.refresh(); } },
      { label: 'Column on Current Frame', action: () => { for (const { k } of this.allKeys()) k.select = Math.abs(k.frame - app.scene.frameCurrent) < 1e-4; this.refresh(); } },
      { type: 'separator' },
      { label: 'Before Current Frame', action: () => { for (const { k } of this.allKeys()) k.select = k.frame < app.scene.frameCurrent; this.refresh(); } },
      { label: 'After Current Frame', action: () => { for (const { k } of this.allKeys()) k.select = k.frame > app.scene.frameCurrent; this.refresh(); } },
    ];
  }

  override onKey(e: KeyboardEvent): boolean {
    const k = e.key.toLowerCase();
    if (k === 'a' && !e.ctrlKey && !e.altKey) { this.selectAllKeys(); return true; }
    if (k === 'i' && e.ctrlKey) { for (const { k: kf } of this.allKeys()) kf.select = !kf.select; this.refresh(); return true; }
    if ((k === 'x' || e.key === 'Delete') && !e.ctrlKey) { confirmPopup('OK?', 'Delete Keyframes', () => this.deleteKeys()); return true; }
    if (k === 'g' && !e.ctrlKey) { this.grabKeys(this instanceof GraphEditor); return true; }
    if (k === 'd' && e.shiftKey) { this.duplicateKeys(); return true; }
    if (k === 't' && !e.ctrlKey) {
      showMenu([{ label: 'Constant', action: () => this.setInterpolation('CONSTANT') }, { label: 'Linear', action: () => this.setInterpolation('LINEAR') }, { label: 'Bezier', action: () => this.setInterpolation('BEZIER') }], app.mouse, { title: 'Set Keyframe Interpolation', atMouse: true });
      return true;
    }
    if (e.key === 'Home') { this.viewAll(); return true; }
    return false;
  }
}

// ------------------------------------------------------------------ Dope Sheet

export class DopeSheet extends KeyEditor {
  static readonly TYPE = 'DOPESHEET_EDITOR';
  get type(): string { return DopeSheet.TYPE; }

  override drawHeader(l: Layout): void {
    const area = () => this.area;
    const row = l.row();
    row.el.classList.add('header-row');
    row.el.style.flex = '0 0 auto';
    row.el.append(
      pulldown({ label: 'View', items: () => [{ label: 'View All', shortcut: 'Home', action: () => this.viewAll() }, { label: 'Only Selected', checked: !!this.state.onlySelected, action: () => { this.state.onlySelected = !this.state.onlySelected; this.refresh(); } }] }, area),
      pulldown({ label: 'Select', items: () => this.selectMenu() }, area),
      pulldown({ label: 'Marker', items: () => this.markerMenu() }, area),
      pulldown({ label: 'Channel', items: () => [{ label: 'Expand All', action: () => { this.state.collapsed = {}; this.refresh(); } }, { label: 'Collapse All', action: () => { for (const o of app.objects()) (this.state.collapsed as Record<string, boolean>)[o.id] = true; this.refresh(); } }] }, area),
      pulldown({ label: 'Key', items: () => this.keyMenu() }, area),
    );
    const m = l.prop({ kind: 'enum', name: 'Mode', items: [{ id: 'DOPESHEET', label: 'Dope Sheet', icon: 'ACTION' }, { id: 'ACTION', label: 'Action Editor', disabled: true }, { id: 'SHAPEKEY', label: 'ShapeKey Editor', disabled: true }, { id: 'GPENCIL', label: 'Grease Pencil', disabled: true }, { id: 'MASK', label: 'Mask', disabled: true }, { id: 'CACHEFILE', label: 'Cache File', disabled: true }], get: () => 'DOPESHEET', set: () => {}, undo: false }, { noLabel: true });
    m.style.flex = '0 0 120px';
    l.prop({ kind: 'bool', name: 'Only Selected', get: () => !!this.state.onlySelected, set: (v) => { this.state.onlySelected = v; this.refresh(); }, undo: false, description: 'Only include channels relating to selected objects and data' }, { iconOnly: true, icon: 'RESTRICT_SELECT_OFF' });
  }

  protected draw(): void {
    const ctx = this.ctx();
    if (!ctx) return;
    const w = this.width, hh = this.height;
    this.drawTimeBase(ctx, w, hh);
    const ch = this.channelList.length ? this.channelList : this.buildChannels();
    for (const c of ch) {
      const y = c.y * this.rowH;
      ctx.fillStyle = c.kind === 'summary' ? 'rgba(80,80,120,0.35)' : c.kind === 'object' ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.03)';
      ctx.fillRect(0, y, w, this.rowH - 1);
      // diamonds
      let keys: { frame: number; sel: boolean }[] = [];
      if (c.kind === 'fcurve' && c.fc) keys = c.fc.keys.map((k) => ({ frame: k.frame, sel: k.select }));
      else {
        const src = c.kind === 'object' && c.ob ? [c.ob] : animObjects(!!this.state.onlySelected);
        const map = new Map<number, boolean>();
        for (const o of src) for (const fc of o.fcurves) for (const k of fc.keys) map.set(k.frame, (map.get(k.frame) ?? false) || k.select);
        keys = [...map.entries()].map(([frame, sel]) => ({ frame, sel }));
      }
      for (const k of keys) {
        const x = this.frameToX(k.frame);
        const cy = y + this.rowH / 2 - 0.5;
        const s = c.kind === 'fcurve' ? 5 : 6;
        ctx.fillStyle = k.sel ? '#ffbe33' : '#e8e8e8';
        ctx.strokeStyle = '#000';
        ctx.beginPath(); ctx.moveTo(x, cy - s); ctx.lineTo(x + s, cy); ctx.lineTo(x, cy + s); ctx.lineTo(x - s, cy); ctx.closePath(); ctx.fill(); ctx.stroke();
      }
    }
    this.drawMarkers(ctx, hh);
    this.drawCurrentFrame(ctx, hh);
  }

  protected onPointerDown(e: PointerEvent): void {
    const r = this.region.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (e.button === 1) { this.panDrag(e); return; }
    if (e.button === 0) { this.scrub(e); return; }
    // RMB select key(s)
    const ch = this.channelList.find((c) => y >= c.y * this.rowH && y < (c.y + 1) * this.rowH);
    if (!e.shiftKey) for (const { k } of this.allKeys()) k.select = false;
    if (ch) {
      const hits: Keyframe[] = [];
      const fcs = ch.kind === 'fcurve' && ch.fc ? [ch.fc] : (ch.kind === 'object' && ch.ob ? ch.ob.fcurves : animObjects(!!this.state.onlySelected).flatMap((o) => o.fcurves));
      let best = Infinity;
      for (const fc of fcs) for (const k of fc.keys) { const d = Math.abs(this.frameToX(k.frame) - x); if (d < 7) { if (d < best - 0.5) { hits.length = 0; best = d; } hits.push(k); } }
      const nearest = hits.length ? hits[0].frame : null;
      for (const fc of fcs) for (const k of fc.keys) if (nearest !== null && Math.abs(k.frame - nearest) < 1e-4) k.select = e.shiftKey ? !k.select : true;
    }
    app.pushUndo('Select Keyframes');
    this.refresh();
    // drag to move
    const sx = e.clientX;
    trackDrag(e, (ev) => { if (Math.abs(ev.clientX - sx) > 4 && !app.modal) this.grabKeys(false); }, undefined, { threshold: 4 });
  }
}

// ------------------------------------------------------------------ Graph Editor

export class GraphEditor extends KeyEditor {
  static readonly TYPE = 'GRAPH_EDITOR';
  constructor(area: Area, state: Record<string, unknown>) {
    super(area, state);
    state.vmin ??= -5;
    state.vmax ??= 5;
  }
  get type(): string { return GraphEditor.TYPE; }

  get vmin(): number { return this.state.vmin as number; }
  get vmax(): number { return this.state.vmax as number; }
  valueToY(v: number): number { return (1 - (v - this.vmin) / (this.vmax - this.vmin)) * (this.height - 20); }
  protected override valuePerPixel(): number { return (this.vmax - this.vmin) / Math.max(1, this.height - 20); }
  protected override panVertical(dy: number): void { const d = dy * this.valuePerPixel(); this.state.vmin = this.vmin + d; this.state.vmax = this.vmax + d; }

  override viewAll(): void {
    const keys = this.allKeys();
    if (!keys.length) { super.viewAll(); return; }
    const fs = keys.map((k) => k.k.frame), vs = keys.map((k) => k.k.value);
    const f0 = Math.min(...fs), f1 = Math.max(...fs), v0 = Math.min(...vs), v1 = Math.max(...vs);
    const fp = Math.max(2, (f1 - f0) * 0.1), vp = Math.max(0.2, (v1 - v0) * 0.15);
    this.state.viewStart = f0 - fp; this.state.viewEnd = f1 + fp;
    this.state.vmin = v0 - vp; this.state.vmax = v1 + vp;
    this.draw();
  }

  override drawHeader(l: Layout): void {
    const area = () => this.area;
    const row = l.row();
    row.el.classList.add('header-row');
    row.el.style.flex = '0 0 auto';
    row.el.append(
      pulldown({ label: 'View', items: () => [{ label: 'View All', shortcut: 'Home', action: () => this.viewAll() }, { label: 'Only Selected', checked: !!this.state.onlySelected, action: () => { this.state.onlySelected = !this.state.onlySelected; this.refresh(); } }] }, area),
      pulldown({ label: 'Select', items: () => this.selectMenu() }, area),
      pulldown({ label: 'Marker', items: () => this.markerMenu() }, area),
      pulldown({ label: 'Channel', items: () => [{ label: 'Expand All', action: () => { this.state.collapsed = {}; this.refresh(); } }] }, area),
      pulldown({ label: 'Key', items: () => this.keyMenu() }, area),
    );
    const m = l.prop({ kind: 'enum', name: 'Mode', items: [{ id: 'FCURVES', label: 'F-Curve', icon: 'IPO' }, { id: 'DRIVERS', label: 'Drivers', disabled: true }], get: () => 'FCURVES', set: () => {}, undo: false }, { noLabel: true });
    m.style.flex = '0 0 100px';
    l.prop({ kind: 'bool', name: 'Only Selected', get: () => !!this.state.onlySelected, set: (v) => { this.state.onlySelected = v; this.refresh(); }, undo: false }, { iconOnly: true, icon: 'RESTRICT_SELECT_OFF' });
  }

  protected draw(): void {
    const ctx = this.ctx();
    if (!ctx) return;
    const w = this.width, hh = this.height;
    this.drawTimeBase(ctx, w, hh, '#5c5c5c');
    // value grid
    const span = this.vmax - this.vmin;
    const raw = span / Math.max(1, hh / 40);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
    ctx.strokeStyle = 'rgba(0,0,0,0.2)';
    ctx.fillStyle = '#ddd';
    ctx.textAlign = 'left';
    for (let v = Math.ceil(this.vmin / step) * step; v <= this.vmax; v += step) {
      const y = Math.round(this.valueToY(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      ctx.fillText(+v.toFixed(4) + '', 4, y - 2);
    }
    // curves
    const ch = this.channelList.length ? this.channelList : this.buildChannels();
    for (const c of ch) {
      if (c.kind !== 'fcurve' || !c.fc) continue;
      const fc = c.fc;
      ctx.strokeStyle = CURVE_COL[fc.index] ?? '#ddd';
      ctx.globalAlpha = fc.mute ? 0.3 : fc.select ? 1 : 0.75;
      ctx.lineWidth = fc.select ? 2 : 1.25;
      ctx.beginPath();
      for (let x = 0; x <= w; x += 2) {
        const v = evaluateFCurve(fc, this.xToFrame(x));
        const y = this.valueToY(v);
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
      for (const k of fc.keys) {
        const x = this.frameToX(k.frame), y = this.valueToY(k.value);
        ctx.fillStyle = k.select ? '#ffbe33' : '#000';
        ctx.fillRect(x - 3, y - 3, 6, 6);
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1;
        ctx.strokeRect(x - 3.5, y - 3.5, 7, 7);
      }
    }
    this.drawMarkers(ctx, hh);
    this.drawCurrentFrame(ctx, hh);
  }

  protected override onWheel(e: WheelEvent): void {
    if (e.ctrlKey) {
      e.preventDefault();
      const r = this.region.getBoundingClientRect();
      const y = e.clientY - r.top;
      const c = this.vmax - (y / (this.height - 20)) * (this.vmax - this.vmin);
      const f = e.deltaY > 0 ? 1.15 : 1 / 1.15;
      this.state.vmin = c - (c - this.vmin) * f;
      this.state.vmax = c + (this.vmax - c) * f;
      this.draw();
      return;
    }
    super.onWheel(e);
  }

  protected onPointerDown(e: PointerEvent): void {
    const r = this.region.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (e.button === 1) { this.panDrag(e, true); return; }
    if (e.button === 0) { this.scrub(e); return; }
    let best: Keyframe | null = null, bd = 10;
    for (const { k } of this.allKeys()) { const d = Math.hypot(this.frameToX(k.frame) - x, this.valueToY(k.value) - y); if (d < bd) { bd = d; best = k; } }
    if (!e.shiftKey) for (const { k } of this.allKeys()) k.select = false;
    if (best) best.select = e.shiftKey ? !best.select : true;
    app.pushUndo('Select Keyframes');
    this.refresh();
    const sx = e.clientX, sy = e.clientY;
    trackDrag(e, (ev) => { if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > 4 && !app.modal) this.grabKeys(true); }, undefined, { threshold: 4 });
  }
}

registerEditor({ type: Timeline.TYPE, label: 'Timeline', icon: 'TIME', create: (area, state) => new Timeline(area, state) });
registerEditor({ type: DopeSheet.TYPE, label: 'Dope Sheet', icon: 'ACTION', create: (area, state) => new DopeSheet(area, state) });
registerEditor({ type: GraphEditor.TYPE, label: 'Graph Editor', icon: 'IPO', create: (area, state) => new GraphEditor(area, state) });
