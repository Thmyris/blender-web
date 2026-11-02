// Node UI widgets: curve mapping (template_curve_mapping) and colour ramp (template_color_ramp),
// drawn on small canvases and editable with the mouse like in Blender 2.79.

import { app } from '../app';
import { h, trackDrag } from '../ui/dom';
import type { Layout } from '../ui/layout';
import { showMenu } from '../ui/menu';
import { curveLUT, evalColorRamp, linearToSrgb, type ColorRampData, type CurveMapping } from './cmp_buffers';

function dpr(): number { return Math.min(2, window.devicePixelRatio || 1); }

function sizeCanvas(c: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const w = c.clientWidth || 120, hh = c.clientHeight || 100;
  const r = dpr();
  if (c.width !== Math.round(w * r) || c.height !== Math.round(hh * r)) { c.width = Math.round(w * r); c.height = Math.round(hh * r); }
  const ctx = c.getContext('2d');
  ctx?.setTransform(r, 0, 0, r, 0, 0);
  return ctx;
}

function rel(c: HTMLElement, e: PointerEvent | MouseEvent): { x: number; y: number } {
  const r = c.getBoundingClientRect();
  return { x: (e.clientX - r.left) / Math.max(1, r.width), y: 1 - (e.clientY - r.top) / Math.max(1, r.height) };
}

const CURVE_COLORS = ['#000000', '#e04040', '#40c040', '#4060f0'];

/** Curve mapping editor. `labels` are the channel tab names (C R G B or X Y Z). */
export function curveMappingWidget(l: Layout, get: () => CurveMapping | null, labels = ['C', 'R', 'G', 'B']): void {
  const tabs = l.row(true);
  labels.forEach((lab, i) => {
    tabs.button(lab, () => { const m = get(); if (m) { m.active = i; m.sel = -1; app.notify('data'); } }, { depress: () => get()?.active === i });
  });
  tabs.button('', (e) => {
    showMenu([
      { label: 'Reset Curve', action: () => { const m = get(); if (m) { m.curves[m.active] = [[0, 0], [1, 1]]; m.sel = -1; app.pushUndo('Reset Curve'); app.notify('data'); } } },
      { label: 'Reset All Curves', action: () => { const m = get(); if (m) { m.curves = m.curves.map(() => [[0, 0], [1, 1]]); m.sel = -1; app.pushUndo('Reset Curves'); app.notify('data'); } } },
    ], { x: e.clientX, y: e.clientY }, { title: 'Curve Tools' });
  }, { icon: 'MODIFIER', iconOnly: true, tip: 'Curve tools' });
  tabs.button('', () => {
    const m = get();
    if (!m || m.sel < 0) return;
    const c = m.curves[m.active];
    if (c.length <= 2) return;
    c.splice(m.sel, 1);
    m.sel = -1;
    app.pushUndo('Delete Curve Point');
    app.notify('data');
  }, { icon: 'X', iconOnly: true, tip: 'Delete points', disabled: () => { const m = get(); return !m || m.sel < 0 || m.curves[m.active].length <= 2; } });

  const canvas = h('canvas', { class: 'node-curve', style: { width: '100%', height: '140px', display: 'block', cursor: 'crosshair' } }) as HTMLCanvasElement;
  const draw = () => {
    const m = get();
    const ctx = sizeCanvas(canvas);
    if (!ctx || !m) return;
    const w = canvas.clientWidth || 120, hh = canvas.clientHeight || 100;
    ctx.fillStyle = '#4b4b4b';
    ctx.fillRect(0, 0, w, hh);
    ctx.strokeStyle = '#5c5c5c';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const x = Math.round((i / 4) * w) + 0.5, y = Math.round((i / 4) * hh) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, hh); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    ctx.strokeStyle = '#3a3a3a';
    ctx.beginPath(); ctx.moveTo(0, hh); ctx.lineTo(w, 0); ctx.stroke();
    // inactive curves faint, active curve on top
    const order = m.curves.map((_, i) => i).filter((i) => i !== m.active).concat([m.active]);
    for (const ci of order) {
      const lut = curveLUT(m.curves[ci], 128);
      ctx.strokeStyle = ci === m.active ? (ci === 0 ? '#111' : CURVE_COLORS[ci]) : 'rgba(0,0,0,0.25)';
      ctx.lineWidth = ci === m.active ? 1.5 : 1;
      ctx.beginPath();
      for (let i = 0; i < lut.length; i++) {
        const x = (i / (lut.length - 1)) * w, y = (1 - lut[i]) * hh;
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
      ctx.stroke();
    }
    const pts = m.curves[m.active];
    pts.forEach((p, i) => {
      ctx.fillStyle = i === m.sel ? '#ffffff' : '#000000';
      ctx.fillRect(p[0] * w - 3, (1 - p[1]) * hh - 3, 6, 6);
    });
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const m = get();
    if (!m) return;
    const pts = m.curves[m.active];
    const p = rel(canvas, e);
    const r = canvas.getBoundingClientRect();
    let best = -1, bd = 10;
    pts.forEach((q, i) => { const d = Math.hypot((q[0] - p.x) * r.width, (q[1] - p.y) * r.height); if (d < bd) { bd = d; best = i; } });
    if (best < 0) {
      pts.push([Math.min(1, Math.max(0, p.x)), Math.min(1, Math.max(0, p.y))]);
      pts.sort((a, b) => a[0] - b[0]);
      best = pts.findIndex((q) => Math.abs(q[0] - p.x) < 1e-6 || (Math.abs(q[0] - Math.min(1, Math.max(0, p.x))) < 1e-6));
    }
    m.sel = best;
    draw();
    app.notify('data');
    const pt = pts[best];
    trackDrag(e, (ev) => {
      const q = rel(canvas, ev);
      pt[0] = Math.min(1, Math.max(0, q.x));
      pt[1] = Math.min(1, Math.max(0, q.y));
      pts.sort((a, b) => a[0] - b[0]);
      m.sel = pts.indexOf(pt);
      draw();
      app.notify('data');
    }, () => { app.pushUndo('Edit Curve'); app.notify('data'); }, { threshold: 0 });
  });
  l.custom(canvas, draw);
  requestAnimationFrame(draw);
}

/** Colour ramp editor. */
export function colorRampWidget(l: Layout, get: () => ColorRampData | null): void {
  const top = l.row(true);
  top.button('', () => {
    const r = get();
    if (!r) return;
    const els = r.elements;
    const a = els[r.active] ?? els[0];
    const sorted = els.slice().sort((x, y) => x.pos - y.pos);
    const i = sorted.indexOf(a);
    const b = sorted[i + 1] ?? sorted[i - 1] ?? a;
    const pos = a === b ? Math.min(1, a.pos + 0.1) : (a.pos + b.pos) / 2;
    const col = [0, 0, 0, 1];
    evalColorRamp(r, pos, col);
    els.push({ pos, color: col });
    r.active = els.length - 1;
    app.pushUndo('Add Color Ramp Element');
    app.notify('data');
  }, { icon: 'ZOOMIN', iconOnly: true, tip: 'Add a new color stop to the colorband' });
  top.button('', () => {
    const r = get();
    if (!r || r.elements.length <= 1) return;
    r.elements.splice(r.active, 1);
    r.active = Math.max(0, r.active - 1);
    app.pushUndo('Delete Color Ramp Element');
    app.notify('data');
  }, { icon: 'ZOOMOUT', iconOnly: true, tip: 'Delete the active position', disabled: () => (get()?.elements.length ?? 0) <= 1 });
  top.button('', () => {
    const r = get();
    if (!r) return;
    for (const e of r.elements) e.pos = 1 - e.pos;
    app.pushUndo('Flip Color Ramp');
    app.notify('data');
  }, { icon: 'ARROW_LEFTRIGHT', iconOnly: true, tip: 'Flip the color ramp' });
  const mode = top.prop({ kind: 'enum', name: 'Color Mode', items: [{ id: 'RGB', label: 'RGB' }, { id: 'HSV', label: 'HSV' }, { id: 'HSL', label: 'HSL' }], get: () => get()?.colorMode ?? 'RGB', set: (v) => { const r = get(); if (r) r.colorMode = v as ColorRampData['colorMode']; }, description: 'Set color mode to use for interpolation' }, { noLabel: true });
  mode.style.flex = '1 1 0';
  const interp = top.prop({ kind: 'enum', name: 'Interpolation', items: [{ id: 'EASE', label: 'Ease' }, { id: 'CARDINAL', label: 'Cardinal' }, { id: 'LINEAR', label: 'Linear' }, { id: 'B_SPLINE', label: 'B-Spline' }, { id: 'CONSTANT', label: 'Constant' }], get: () => get()?.interpolation ?? 'LINEAR', set: (v) => { const r = get(); if (r) r.interpolation = v as ColorRampData['interpolation']; }, description: 'Set interpolation between color stops' }, { noLabel: true });
  interp.style.flex = '1 1 0';

  const canvas = h('canvas', { style: { width: '100%', height: '22px', display: 'block', cursor: 'default', marginTop: '2px' } }) as HTMLCanvasElement;
  const draw = () => {
    const r = get();
    const ctx = sizeCanvas(canvas);
    if (!ctx || !r) return;
    const w = canvas.clientWidth || 120, hh = canvas.clientHeight || 20;
    const cs = 5;
    for (let y = 0; y < hh; y += cs) for (let x = 0; x < w; x += cs) { ctx.fillStyle = ((x / cs + y / cs) & 1) ? '#666' : '#999'; ctx.fillRect(x, y, cs, cs); }
    const col = [0, 0, 0, 1];
    for (let x = 0; x < w; x++) {
      evalColorRamp(r, x / Math.max(1, w - 1), col);
      ctx.fillStyle = `rgba(${Math.round(Math.min(1, Math.max(0, linearToSrgb(col[0]))) * 255)},${Math.round(Math.min(1, Math.max(0, linearToSrgb(col[1]))) * 255)},${Math.round(Math.min(1, Math.max(0, linearToSrgb(col[2]))) * 255)},${Math.min(1, Math.max(0, col[3]))})`;
      ctx.fillRect(x, 0, 1, hh);
    }
    ctx.strokeStyle = '#000';
    ctx.strokeRect(0.5, 0.5, w - 1, hh - 1);
    r.elements.forEach((e, i) => {
      const x = Math.round(e.pos * (w - 1)) + 0.5;
      ctx.strokeStyle = i === r.active ? '#fff' : '#000';
      ctx.lineWidth = i === r.active ? 2 : 1;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, hh); ctx.stroke();
      ctx.lineWidth = 1;
    });
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const r = get();
    if (!r) return;
    const p = rel(canvas, e);
    const rect = canvas.getBoundingClientRect();
    let best = 0, bd = Infinity;
    r.elements.forEach((el, i) => { const d = Math.abs(el.pos - p.x) * rect.width; if (d < bd) { bd = d; best = i; } });
    r.active = best;
    draw();
    app.notify('data');
    const el = r.elements[best];
    trackDrag(e, (ev) => { el.pos = Math.min(1, Math.max(0, rel(canvas, ev).x)); draw(); app.notify('data'); }, () => { app.pushUndo('Move Color Ramp Element'); app.notify('data'); }, { threshold: 1 });
  });
  l.custom(canvas, draw);
  requestAnimationFrame(draw);

  const bottom = l.row(true);
  const act = () => { const r = get(); return r ? r.elements[r.active] ?? null : null; };
  const idx = bottom.prop({ kind: 'int', name: '', min: 0, get: () => get()?.active ?? 0, set: (v) => { const r = get(); if (r) r.active = Math.max(0, Math.min(r.elements.length - 1, v)); }, undo: false, description: 'Index of the active color stop' });
  idx.style.flex = '0 0 34px';
  bottom.prop({ kind: 'float', name: 'Pos', min: 0, max: 1, step: 1, precision: 3, get: () => act()?.pos ?? 0, set: (v) => { const e = act(); if (e) e.pos = v; }, description: 'Set position of selected color stop' }, { slider: true });
  const sw = bottom.prop({ kind: 'color', name: '', alpha: true, get: () => (act()?.color ?? [0, 0, 0, 1]).slice(), set: (v) => { const e = act(); if (e) e.color = [v[0], v[1], v[2], v[3] ?? 1]; }, description: 'Set color of selected color stop' }, { text: '' });
  sw.style.flex = '0 0 50px';
}
