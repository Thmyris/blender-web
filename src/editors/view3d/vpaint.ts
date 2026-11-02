// Vertex Paint mode: paint per-vertex colours with Mix/Add/Subtract/Multiply/
// Lighten/Darken/Blur brushes (Blender 2.79's vertex paint).

import { Vector3, Quaternion } from 'three';
import { app, type ModalHandler } from '../../app';
import type { Color3, VertexPaintSettings } from '../../core/types';
import type { PanelDef, Layout } from '../../ui/layout';
import type { MenuItem } from '../../ui/menu';
import type { View3D } from './view3d';
import { startRadialControl } from './sculpt';

export function vpaintSettings(): VertexPaintSettings {
  const ts = app.scene.toolSettings;
  ts.vpaint ??= { color: [1, 1, 1], radius: 50, strength: 1, blend: 'MIX' };
  return ts.vpaint;
}

const BLENDS: { id: VertexPaintSettings['blend']; label: string }[] = [
  { id: 'MIX', label: 'Mix' }, { id: 'ADD', label: 'Add' }, { id: 'SUB', label: 'Subtract' }, { id: 'MUL', label: 'Multiply' },
  { id: 'BLUR', label: 'Blur' }, { id: 'LIGHTEN', label: 'Lighten' }, { id: 'DARKEN', label: 'Darken' },
];

function blend(mode: VertexPaintSettings['blend'], a: Color3, b: Color3, f: number, blurAvg?: Color3): Color3 {
  const out: Color3 = [a[0], a[1], a[2]];
  for (let k = 0; k < 3; k++) {
    let t: number;
    switch (mode) {
      case 'ADD': t = a[k] + b[k]; break;
      case 'SUB': t = a[k] - b[k]; break;
      case 'MUL': t = a[k] * b[k]; break;
      case 'LIGHTEN': t = Math.max(a[k], b[k]); break;
      case 'DARKEN': t = Math.min(a[k], b[k]); break;
      case 'BLUR': t = blurAvg ? blurAvg[k] : a[k]; break;
      default: t = b[k];
    }
    out[k] = Math.min(1, Math.max(0, a[k] + (t - a[k]) * f));
  }
  return out;
}

export function startPaintStroke(view: View3D, e: PointerEvent): void {
  const ob = app.paintObj;
  const md = app.meshOf(ob);
  if (!ob || !md) return;
  const s = vpaintSettings();
  if (!md.vcol || md.vcol.length !== md.verts.length) md.vcol = md.verts.map(() => [1, 1, 1]);
  const world = app.matrices.world(ob).clone();
  const inv = world.clone().invert();
  const sc = new Vector3();
  world.decompose(new Vector3(), new Quaternion(), sc);
  const scale = (Math.abs(sc.x) + Math.abs(sc.y) + Math.abs(sc.z)) / 3 || 1;
  const neighbours: number[][] = md.verts.map(() => []);
  for (const [a, b] of md.edges) { neighbours[a].push(b); neighbours[b].push(a); }
  // each vertex is painted at most up to the brush strength per stroke (like Blender's "accumulate" off)
  const strokeMax = new Float32Array(md.verts.length);
  const painted = md.vcol.map((c) => c.slice() as Color3);
  const blurMode = e.shiftKey ? 'BLUR' : s.blend;
  const paintColor: Color3 = e.ctrlKey ? [1 - s.color[0], 1 - s.color[1], 1 - s.color[2]] : s.color;
  const paintAt = (x: number, y: number) => {
    const hit = view.renderer.pickMeshes(x, y).find((h) => h.ob.id === ob.id);
    if (!hit?.point) return;
    const c = hit.point.clone().applyMatrix4(inv);
    const r = (s.radius * view.view.pixelSize(hit.point)) / scale;
    md.verts.forEach((v, i) => {
      if (md.vhide?.[i]) return;
      const d = Math.hypot(v[0] - c.x, v[1] - c.y, v[2] - c.z);
      if (d > r) return;
      const t = 1 - d / r;
      const f = Math.min(1, s.strength * t * t * (3 - 2 * t));
      if (f <= strokeMax[i] + 1e-4 && blurMode !== 'BLUR') return;
      let avg: Color3 | undefined;
      if (blurMode === 'BLUR') {
        avg = [0, 0, 0];
        const nb = neighbours[i];
        for (const j of nb) { avg[0] += md.vcol![j][0]; avg[1] += md.vcol![j][1]; avg[2] += md.vcol![j][2]; }
        if (nb.length) { avg[0] /= nb.length; avg[1] /= nb.length; avg[2] /= nb.length; } else avg = undefined;
        md.vcol![i] = blend('BLUR', md.vcol![i], paintColor, f * 0.5, avg);
      } else {
        strokeMax[i] = f;
        md.vcol![i] = blend(blurMode, painted[i], paintColor, f);
      }
    });
    app.tagGeometry(md.id);
    view.requestRender();
  };
  const r0 = view.canvasRect();
  paintAt(e.clientX - r0.left, e.clientY - r0.top);
  const h: ModalHandler = {
    status: () => `Vertex Paint — ${BLENDS.find((b) => b.id === blurMode)?.label}, radius ${Math.round(s.radius)} px, strength ${s.strength.toFixed(2)}`,
    cursor: 'crosshair',
    cancel: () => app.endModal(h),
    onEvent(ev) {
      const r = view.canvasRect();
      if (ev.type === 'pointermove') {
        const pe = ev as PointerEvent;
        view.brushPos = { x: pe.clientX - r.left, y: pe.clientY - r.top };
        paintAt(pe.clientX - r.left, pe.clientY - r.top);
        return true;
      }
      if (ev.type === 'pointerup') {
        app.endModal(h);
        app.pushUndo('Vertex Paint Stroke');
        return true;
      }
      return true;
    },
  };
  app.startModal(h);
}

export function vpaintKey(view: View3D, e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.altKey || e.metaKey) return false;
  if (e.code === 'KeyF') { startRadialControl(view, e.shiftKey ? 'strength' : 'radius', vpaintSettings()); return true; }
  if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
    const s = vpaintSettings();
    s.radius = Math.max(2, Math.min(500, s.radius * (e.code === 'BracketLeft' ? 0.9 : 1.1)));
    app.notify('view', 'data');
    return true;
  }
  return false;
}

/** Fill the whole mesh with the paint colour (Shift+K in Blender). */
export function fillVertexColors(): void {
  const md = app.meshOf(app.paintObj);
  if (!md) return;
  const c = vpaintSettings().color;
  md.vcol = md.verts.map(() => [c[0], c[1], c[2]]);
  app.tagGeometry(md.id);
  app.pushUndo('Set Vertex Colors');
}

export function vpaintPanels(): PanelDef[] {
  const S = () => vpaintSettings();
  return [
    {
      id: 'vpbrush', label: 'Brush', draw: (l: Layout) => {
        l.prop({ kind: 'color', name: 'Color', get: () => S().color.slice(), set: (v) => { S().color = [v[0], v[1], v[2]]; }, undo: false, notify: ['view'], description: 'Paint colour' }, { text: '' });
        const c = l.column(true);
        c.prop({ kind: 'int', name: 'Radius', min: 1, max: 500, unit: 'PIXEL', get: () => Math.round(S().radius), set: (v) => { S().radius = v; }, undo: false, notify: ['view'], description: 'Radius of the brush in pixels (F)' }, { slider: true });
        c.prop({ kind: 'float', name: 'Strength', min: 0, max: 1, precision: 3, step: 0.01, get: () => S().strength, set: (v) => { S().strength = v; }, undo: false, notify: ['view'], description: 'How powerful the effect of the brush is (Shift F)' }, { slider: true });
        l.prop({ kind: 'enum', name: 'Blend', items: BLENDS.map((b) => ({ id: b.id, label: b.label })), get: () => S().blend, set: (v) => { S().blend = v as 'MIX'; }, undo: false, description: 'Brush blending mode' });
        l.label('Ctrl paints the inverted colour, Shift blurs.');
        l.button('Set Vertex Colors', () => fillVertexColors(), { tip: 'Fill the active vertex color layer with the current paint color (Shift K)' });
      },
    },
  ];
}

export function vpaintMenu(): MenuItem[] {
  return [
    { label: 'Set Vertex Colors', shortcut: 'Shift K', action: () => fillVertexColors() },
    { type: 'separator' },
    { type: 'submenu', label: 'Blend', items: BLENDS.map((b) => ({ label: b.label, checked: vpaintSettings().blend === b.id, action: () => { vpaintSettings().blend = b.id; app.notify('view'); } })) },
  ];
}
