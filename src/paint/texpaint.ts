// Image painting in the UV/Image Editor's Paint mode (Blender 2.79's 2D texture paint):
// Draw / Soften / Smear / Fill brushes with colour, radius, strength, blend mode, falloff and dab
// spacing; F and Shift+F radial controls, S samples a colour, X swaps the two colours,
// Ctrl paints with the secondary colour; one undo step per stroke.

import { app, type ModalHandler } from '../app';
import type { BImage, Color3, ImagePaintBlend, ImagePaintBrush, ImagePaintSettings } from '../core/types';
import type { Layout, PanelDef } from '../ui/layout';
import type { MenuItem } from '../ui/menu';
import { commitImage, imageContext, imagePixelsChanged } from './images';
import type { Area } from '../screen/screen';

/** What the paint code needs from the UV/Image editor. */
export interface PaintEditor {
  readonly area: Area;
  paintTarget(): BImage | null;
  screenToUV(x: number, y: number): [number, number];
  readonly zoom: number;
  brushPos: { x: number; y: number } | null;
  radialControl: { center: { x: number; y: number }; which: 'radius' | 'strength' } | null;
  canvasRect(): DOMRect;
  redraw(): void;
}

export function imagePaintSettings(): ImagePaintSettings {
  const ts = app.scene.toolSettings;
  ts.imagePaint ??= {
    brush: 'DRAW', color: [1, 1, 1], secondaryColor: [0, 0, 0], radius: 50, strength: 1, blend: 'MIX', falloff: 'SMOOTH',
    spacing: 10, cloneImage: null, fillThreshold: 0.2, useOcclude: true, useBackfaceCulling: true,
  };
  return ts.imagePaint;
}

const BRUSHES: { id: ImagePaintBrush; label: string; disabled?: boolean }[] = [
  { id: 'DRAW', label: 'TexDraw' }, { id: 'SOFTEN', label: 'Soften' }, { id: 'SMEAR', label: 'Smear' },
  { id: 'CLONE', label: 'Clone', disabled: true }, { id: 'FILL', label: 'Fill' },
];

const BLENDS: { id: ImagePaintBlend; label: string }[] = [
  { id: 'MIX', label: 'Mix' }, { id: 'ADD', label: 'Add' }, { id: 'SUB', label: 'Subtract' }, { id: 'MUL', label: 'Multiply' },
  { id: 'LIGHTEN', label: 'Lighten' }, { id: 'DARKEN', label: 'Darken' }, { id: 'ERASE_ALPHA', label: 'Erase Alpha' }, { id: 'ADD_ALPHA', label: 'Add Alpha' },
];

const FALLOFFS: { id: ImagePaintSettings['falloff']; label: string }[] = [
  { id: 'SMOOTH', label: 'Smooth' }, { id: 'SPHERE', label: 'Sphere' }, { id: 'ROOT', label: 'Root' },
  { id: 'SHARP', label: 'Sharp' }, { id: 'LINEAR', label: 'Linear' }, { id: 'CONSTANT', label: 'Constant' },
];

/** Brush falloff for a normalised distance d (0 at the centre, 1 at the rim). */
function falloff(kind: ImagePaintSettings['falloff'], d: number): number {
  const t = 1 - d;
  switch (kind) {
    case 'SPHERE': return Math.sqrt(Math.max(0, 1 - d * d));
    case 'ROOT': return Math.sqrt(t);
    case 'SHARP': return t * t;
    case 'LINEAR': return t;
    case 'CONSTANT': return 1;
    default: return t * t * (3 - 2 * t);
  }
}

function blendChannel(mode: ImagePaintBlend, a: number, b: number): number {
  switch (mode) {
    case 'ADD': return a + b;
    case 'SUB': return a - b;
    case 'MUL': return (a * b) / 255;
    case 'LIGHTEN': return Math.max(a, b);
    case 'DARKEN': return Math.min(a, b);
    default: return b;
  }
}

interface Stroke {
  img: BImage;
  s: ImagePaintSettings;
  color: Color3;
  /** Per-pixel strength already applied in this stroke (Draw brush). */
  done: Float32Array;
  w: number;
  h: number;
  /** Previous dab centre (Smear). */
  prev: [number, number] | null;
}

/** Paint one dab centred on image pixel (cx, cy) with a radius in image pixels. */
function dab(st: Stroke, cx: number, cy: number, r: number): void {
  const { img, s, w, h } = st;
  const ctx = imageContext(img);
  const x0 = Math.max(0, Math.floor(cx - r)), y0 = Math.max(0, Math.floor(cy - r));
  const x1 = Math.min(w, Math.ceil(cx + r)), y1 = Math.min(h, Math.ceil(cy + r));
  if (x1 <= x0 || y1 <= y0) return;
  const bw = x1 - x0, bh = y1 - y0;
  // Soften / Smear read from a slightly larger snapshot of the area under the brush
  const pad = s.brush === 'SMEAR' && st.prev ? Math.ceil(Math.hypot(cx - st.prev[0], cy - st.prev[1])) + 1 : 1;
  const sx0 = Math.max(0, x0 - pad), sy0 = Math.max(0, y0 - pad);
  const sx1 = Math.min(w, x1 + pad), sy1 = Math.min(h, y1 + pad);
  const src = s.brush === 'SOFTEN' || s.brush === 'SMEAR' ? ctx.getImageData(sx0, sy0, sx1 - sx0, sy1 - sy0) : null;
  const sw = sx1 - sx0;
  const read = (x: number, y: number, k: number): number => {
    const xx = Math.min(sx1 - 1, Math.max(sx0, x)) - sx0, yy = Math.min(sy1 - 1, Math.max(sy0, y)) - sy0;
    return src!.data[(yy * sw + xx) * 4 + k];
  };
  const id = ctx.getImageData(x0, y0, bw, bh);
  const px = id.data;
  const c = [st.color[0] * 255, st.color[1] * 255, st.color[2] * 255];
  const dx = st.prev ? Math.round(cx - st.prev[0]) : 0, dy = st.prev ? Math.round(cy - st.prev[1]) : 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / r;
      if (d >= 1) continue;
      const f = Math.min(1, s.strength * falloff(s.falloff, d));
      const o = ((y - y0) * bw + (x - x0)) * 4;
      if (s.brush === 'SOFTEN') {
        for (let k = 0; k < 4; k++) {
          let sum = 0;
          for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) sum += read(x + i, y + j, k);
          px[o + k] += (sum / 9 - px[o + k]) * f;
        }
        continue;
      }
      if (s.brush === 'SMEAR') {
        if (!st.prev) continue;
        for (let k = 0; k < 4; k++) px[o + k] += (read(x - dx, y - dy, k) - px[o + k]) * f;
        continue;
      }
      // Draw: within one stroke a pixel moves towards the brush at most up to the brush strength
      const pi = y * w + x;
      if (f <= st.done[pi]) continue;
      const step = (f - st.done[pi]) / (1 - st.done[pi] || 1);
      st.done[pi] = f;
      if (s.blend === 'ERASE_ALPHA' || s.blend === 'ADD_ALPHA') {
        px[o + 3] += ((s.blend === 'ERASE_ALPHA' ? 0 : 255) - px[o + 3]) * step;
        continue;
      }
      for (let k = 0; k < 3; k++) {
        const a = px[o + k];
        px[o + k] = Math.min(255, Math.max(0, a + (blendChannel(s.blend, a, c[k]) - a) * step));
      }
      if (s.blend === 'MIX') px[o + 3] += (255 - px[o + 3]) * step;
    }
  }
  ctx.putImageData(id, x0, y0);
  st.prev = [cx, cy];
}

/** Fill brush: flood-fill the region of similar colour under (px, py). */
function floodFill(img: BImage, px: number, py: number, color: Color3, s: ImagePaintSettings): void {
  const ctx = imageContext(img);
  const w = ctx.canvas.width, h = ctx.canvas.height;
  if (px < 0 || py < 0 || px >= w || py >= h) return;
  const id = ctx.getImageData(0, 0, w, h);
  const d = id.data;
  const i0 = (py * w + px) * 4;
  const ref = [d[i0], d[i0 + 1], d[i0 + 2], d[i0 + 3]];
  const thr = s.fillThreshold * 255 * 2;
  const c = [color[0] * 255, color[1] * 255, color[2] * 255];
  const seen = new Uint8Array(w * h);
  const stack = [py * w + px];
  seen[py * w + px] = 1;
  while (stack.length) {
    const p = stack.pop()!;
    const o = p * 4;
    for (let k = 0; k < 3; k++) d[o + k] += (blendChannel(s.blend, d[o + k], c[k]) - d[o + k]) * s.strength;
    if (s.blend === 'MIX') d[o + 3] += (255 - d[o + 3]) * s.strength;
    const x = p % w, y = (p - x) / w;
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as const) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const q = ny * w + nx;
      if (seen[q]) continue;
      const qo = q * 4;
      const dist = Math.abs(d[qo] - ref[0]) + Math.abs(d[qo + 1] - ref[1]) + Math.abs(d[qo + 2] - ref[2]) + Math.abs(d[qo + 3] - ref[3]);
      if (dist > thr) continue;
      seen[q] = 1;
      stack.push(q);
    }
  }
  ctx.putImageData(id, 0, 0);
}

/** LMB stroke in Paint mode. */
export function imagePaintStroke(ed: PaintEditor, e: PointerEvent): void {
  const img = ed.paintTarget();
  if (!img) return;
  const s = imagePaintSettings();
  const ctx = imageContext(img);
  const w = ctx.canvas.width, h = ctx.canvas.height;
  const color: Color3 = e.ctrlKey ? s.secondaryColor : s.color;
  const toPixel = (x: number, y: number): [number, number] => {
    const [u, v] = ed.screenToUV(x, y);
    return [u * w, (1 - v) * h];
  };
  const r0 = ed.canvasRect();
  if (s.brush === 'FILL') {
    const [fx, fy] = toPixel(e.clientX - r0.left, e.clientY - r0.top);
    floodFill(img, Math.floor(fx), Math.floor(fy), color, s);
    imagePixelsChanged(img);
    commitImage(img);
    app.pushUndo('Image Paint');
    app.notify('view');
    ed.redraw();
    return;
  }
  if (s.brush === 'CLONE') { app.report('INFO', 'The Clone brush is not available in blender-web'); return; }
  const st: Stroke = { img, s, color, done: new Float32Array(w * h), w, h, prev: null };
  const rPx = () => Math.max(0.5, s.radius / Math.max(1e-6, ed.zoom));
  let last: [number, number] | null = null;
  const paintTo = (x: number, y: number) => {
    const p = toPixel(x, y);
    const r = rPx();
    const spacing = Math.max(1, (r * s.spacing) / 100);
    if (!last) { dab(st, p[0], p[1], r); last = p; }
    else {
      const dist = Math.hypot(p[0] - last[0], p[1] - last[1]);
      const n = Math.floor(dist / spacing);
      for (let i = 1; i <= n; i++) {
        const t = (i * spacing) / dist;
        dab(st, last[0] + (p[0] - last[0]) * t, last[1] + (p[1] - last[1]) * t, r);
      }
      if (n > 0) last = [last[0] + ((p[0] - last[0]) * n * spacing) / dist, last[1] + ((p[1] - last[1]) * n * spacing) / dist];
    }
    imagePixelsChanged(img);
    ed.redraw();
  };
  paintTo(e.clientX - r0.left, e.clientY - r0.top);
  const hnd: ModalHandler = {
    status: () => `Image Paint — ${BRUSHES.find((b) => b.id === s.brush)?.label}, radius ${Math.round(s.radius)} px, strength ${s.strength.toFixed(2)}`,
    cursor: 'crosshair',
    cancel: () => app.endModal(hnd),
    onEvent(ev) {
      const r = ed.canvasRect();
      if (ev.type === 'pointermove') {
        const pe = ev as PointerEvent;
        ed.brushPos = { x: pe.clientX - r.left, y: pe.clientY - r.top };
        paintTo(ed.brushPos.x, ed.brushPos.y);
        return true;
      }
      if (ev.type === 'pointerup') {
        app.endModal(hnd);
        commitImage(img);
        app.pushUndo('Image Paint');
        app.notify('view');
        return true;
      }
      return true;
    },
  };
  app.startModal(hnd);
}

/** Pick the colour under the mouse into the brush (S). */
function sampleColor(ed: PaintEditor): void {
  const img = ed.paintTarget();
  if (!img) return;
  const r = ed.canvasRect();
  const [u, v] = ed.screenToUV(app.mouse.x - r.left, app.mouse.y - r.top);
  const ctx = imageContext(img);
  const x = Math.floor(u * ctx.canvas.width), y = Math.floor((1 - v) * ctx.canvas.height);
  if (x < 0 || y < 0 || x >= ctx.canvas.width || y >= ctx.canvas.height) return;
  const d = ctx.getImageData(x, y, 1, 1).data;
  imagePaintSettings().color = [d[0] / 255, d[1] / 255, d[2] / 255];
  app.notify('all');
}

/** F / Shift+F: drag to change the brush radius / strength; LMB or Enter confirms, Esc/RMB cancels. */
function radialControl(ed: PaintEditor, which: 'radius' | 'strength'): void {
  const s = imagePaintSettings();
  const r = ed.canvasRect();
  const center = ed.brushPos ?? { x: app.mouse.x - r.left, y: app.mouse.y - r.top };
  const start = which === 'radius' ? s.radius : s.strength;
  ed.radialControl = { center, which };
  const finish = (ok: boolean) => {
    if (!ok) { if (which === 'radius') s.radius = start; else s.strength = start; }
    ed.radialControl = null;
    app.endModal(hnd);
    ed.redraw();
    app.notify('all');
  };
  const hnd: ModalHandler = {
    status: () => (which === 'radius' ? `Radius: ${Math.round(s.radius)}` : `Strength: ${s.strength.toFixed(3)}`),
    cancel: () => finish(false),
    onEvent(ev) {
      if (ev.type === 'pointermove') {
        const pe = ev as PointerEvent;
        const rr = ed.canvasRect();
        const d = Math.hypot(pe.clientX - rr.left - center.x, pe.clientY - rr.top - center.y);
        if (which === 'radius') s.radius = Math.max(1, Math.min(500, d));
        else s.strength = Math.max(0, Math.min(1, d / 200));
        ed.redraw();
        return true;
      }
      if (ev.type === 'pointerdown') { finish((ev as PointerEvent).button === 0); return true; }
      if (ev.type === 'keydown') {
        const k = (ev as KeyboardEvent).code;
        if (k === 'Enter' || k === 'NumpadEnter' || k === 'Space') finish(true);
        else if (k === 'Escape') finish(false);
        return true;
      }
      return true;
    },
  };
  app.startModal(hnd);
}

function swapColors(): void {
  const s = imagePaintSettings();
  [s.color, s.secondaryColor] = [s.secondaryColor, s.color];
  app.notify('all');
}

/** Keyboard shortcuts of Paint mode; returns true when handled. */
export function imagePaintKey(ed: PaintEditor, e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.altKey || e.metaKey) return false;
  const s = imagePaintSettings();
  if (e.code === 'KeyF') { radialControl(ed, e.shiftKey ? 'strength' : 'radius'); return true; }
  if (e.code === 'KeyS' && !e.shiftKey) { sampleColor(ed); return true; }
  if (e.code === 'KeyX' && !e.shiftKey) { swapColors(); return true; }
  if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
    s.radius = Math.max(1, Math.min(500, s.radius * (e.code === 'BracketLeft' ? 0.9 : 1.1)));
    ed.redraw();
    app.notify('all');
    return true;
  }
  return false;
}

/** Brush circle (and the radial control) drawn over the image. */
export function drawImageBrush(ctx: CanvasRenderingContext2D, ed: PaintEditor): void {
  const s = imagePaintSettings();
  ctx.save();
  if (ed.radialControl) {
    const { center, which } = ed.radialControl;
    const rr = which === 'radius' ? s.radius : s.strength * 200;
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.beginPath(); ctx.arc(center.x, center.y, rr, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.stroke();
  } else if (ed.brushPos && s.brush !== 'FILL') {
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(ed.brushPos.x, ed.brushPos.y, s.radius, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.restore();
}

/** Tool shelf panels of Paint mode. */
export function imagePaintPanels(_area: Area): PanelDef[] {
  const S = imagePaintSettings;
  return [
    {
      id: 'image.paint_brush', label: 'Brush',
      draw: (l: Layout) => {
        l.prop({ kind: 'enum', name: 'Brush', items: BRUSHES.map((b) => ({ id: b.id, label: b.label, disabled: b.disabled, description: b.disabled ? 'Not available in blender-web' : undefined })), get: () => S().brush, set: (v) => { S().brush = v as ImagePaintBrush; }, undo: false, notify: ['all'], description: 'Brush type' });
        const row = l.row(true);
        row.prop({ kind: 'color', name: 'Color', get: () => S().color.slice(), set: (v) => { S().color = [v[0], v[1], v[2]]; }, undo: false, notify: ['view'], description: 'Paint colour (S samples the image)' }, { text: '' });
        row.prop({ kind: 'color', name: 'Secondary Color', get: () => S().secondaryColor.slice(), set: (v) => { S().secondaryColor = [v[0], v[1], v[2]]; }, undo: false, notify: ['view'], description: 'Secondary paint colour (Ctrl paints with it, X swaps)' }, { text: '' });
        row.button('', () => swapColors(), { icon: 'FILE_REFRESH', iconOnly: true, tip: 'Swap the primary and secondary colours (X)' });
        const c = l.column(true);
        c.prop({ kind: 'int', name: 'Radius', min: 1, max: 500, unit: 'PIXEL', get: () => Math.round(S().radius), set: (v) => { S().radius = v; }, undo: false, notify: ['view'], description: 'Radius of the brush in pixels (F)' }, { slider: true });
        c.prop({ kind: 'float', name: 'Strength', min: 0, max: 1, precision: 3, step: 0.01, get: () => S().strength, set: (v) => { S().strength = v; }, undo: false, notify: ['view'], description: 'How powerful the effect of the brush is (Shift F)' }, { slider: true });
        l.prop({ kind: 'enum', name: 'Blend', items: BLENDS.map((b) => ({ id: b.id, label: b.label })), get: () => S().blend, set: (v) => { S().blend = v as ImagePaintBlend; }, undo: false, description: 'Brush blending mode' });
        if (S().brush === 'FILL') l.prop({ kind: 'float', name: 'Fill Threshold', min: 0, max: 1, precision: 3, step: 0.01, get: () => S().fillThreshold, set: (v) => { S().fillThreshold = v; }, undo: false, description: 'Colour difference up to which neighbouring pixels are filled' }, { slider: true });
      },
    },
    {
      id: 'image.paint_stroke', label: 'Stroke',
      draw: (l: Layout) => {
        l.prop({ kind: 'int', name: 'Spacing', min: 1, max: 1000, get: () => S().spacing, set: (v) => { S().spacing = v; }, undo: false, description: 'Spacing between brush dabs, in percent of the radius' }, { slider: true });
      },
    },
    {
      id: 'image.paint_curve', label: 'Curve',
      draw: (l: Layout) => {
        l.prop({ kind: 'enum', name: 'Falloff', items: FALLOFFS.map((f) => ({ id: f.id, label: f.label })), get: () => S().falloff, set: (v) => { S().falloff = v as ImagePaintSettings['falloff']; }, undo: false, description: 'Brush falloff curve' });
      },
    },
  ];
}

/** Header "Brush" menu of Paint mode. */
export function imagePaintMenu(): MenuItem[] {
  const S = imagePaintSettings;
  return [
    ...BRUSHES.map((b): MenuItem => ({ label: b.label, checked: S().brush === b.id, disabled: b.disabled, action: () => { S().brush = b.id; app.notify('all'); } })),
    { type: 'separator' },
    { label: 'Swap Colors', shortcut: 'X', action: () => swapColors() },
    { label: 'Radius: Smaller', shortcut: '[', action: () => { S().radius = Math.max(1, S().radius * 0.9); app.notify('all'); } },
    { label: 'Radius: Larger', shortcut: ']', action: () => { S().radius = Math.min(500, S().radius * 1.1); app.notify('all'); } },
  ];
}
