// Sculpt Mode: brush strokes that deform the mesh of the active object, with
// the main Blender 2.79 brushes, symmetry, axis locking and radial falloff.

import { Matrix4, Quaternion, Vector3 } from 'three';
import { app, type ModalHandler } from '../../app';
import type { MeshData, SculptBrush, SculptSettings, Vec3 } from '../../core/types';
import { vertexNormals } from '../../core/mesh';
import type { PanelDef, Layout } from '../../ui/layout';
import { bprop } from '../../ui/layout';
import type { MenuItem } from '../../ui/menu';
import type { View3D } from './view3d';

export const BRUSHES: { id: SculptBrush; label: string; key: string; description: string }[] = [
  { id: 'DRAW', label: 'Draw', key: 'X', description: 'Move vertices outward (or inward with Subtract) along the area normal' },
  { id: 'CLAY', label: 'Clay', key: 'C', description: 'Build up material towards a plane above the surface' },
  { id: 'CREASE', label: 'Crease', key: 'Shift C', description: 'Draw while pinching vertices towards the stroke' },
  { id: 'FLATTEN', label: 'Flatten', key: 'Shift T', description: 'Move vertices towards the average plane of the brush area' },
  { id: 'GRAB', label: 'Grab', key: 'G', description: 'Drag the vertices under the brush with the mouse' },
  { id: 'INFLATE', label: 'Inflate/Deflate', key: 'I', description: 'Move vertices along their own normals' },
  { id: 'LAYER', label: 'Layer', key: 'L', description: 'Raise vertices to a fixed height above the original surface' },
  { id: 'PINCH', label: 'Pinch/Magnify', key: 'P', description: 'Pull vertices towards the brush centre' },
  { id: 'SMOOTH', label: 'Smooth', key: 'S', description: 'Average vertex positions with their neighbours' },
];

const DEFAULT_STRENGTH: Record<SculptBrush, number> = { DRAW: 0.5, CLAY: 0.5, CREASE: 0.5, FLATTEN: 0.5, GRAB: 1, INFLATE: 0.5, LAYER: 0.5, PINCH: 0.5, SMOOTH: 0.5 };

export function sculptSettings(): SculptSettings {
  const ts = app.scene.toolSettings;
  ts.sculpt ??= {
    brush: 'DRAW', radius: 50, strength: 0.5, direction: 'ADD', falloff: 'SMOOTH', symmetry: [true, false, false],
    lockAxis: [false, false, false], spacing: 0.1, useFrontFacesOnly: false, brushStrength: {},
  };
  return ts.sculpt;
}

function strengthOf(s: SculptSettings, b: SculptBrush): number { return s.brushStrength[b] ?? DEFAULT_STRENGTH[b]; }

export function setBrush(b: SculptBrush): void {
  const s = sculptSettings();
  s.brushStrength[s.brush] = s.strength;
  s.brush = b;
  s.strength = strengthOf(s, b);
  s.direction = 'ADD';
  app.notify('view', 'data');
}

function falloff(type: SculptSettings['falloff'], d: number): number {
  const t = Math.max(0, 1 - d);
  switch (type) {
    case 'SPHERE': return Math.sqrt(Math.max(0, 1 - d * d));
    case 'ROOT': return Math.sqrt(t);
    case 'SHARP': return t * t;
    case 'LINEAR': return t;
    case 'CONSTANT': return d < 1 ? 1 : 0;
    default: return t * t * (3 - 2 * t);
  }
}

interface StrokeCache {
  md: MeshData;
  world: Matrix4;
  inv: Matrix4;
  neighbours: number[][];
  /** original positions (for Layer and Grab) */
  orig: Vec3[];
  normals: Vec3[];
  layerDisp: Float32Array;
  scale: number;
}

function buildCache(md: MeshData, world: Matrix4): StrokeCache {
  const neighbours: number[][] = md.verts.map(() => []);
  for (const [a, b] of md.edges) { neighbours[a].push(b); neighbours[b].push(a); }
  const sc = new Vector3();
  world.decompose(new Vector3(), new Quaternion(), sc);
  return {
    md, world, inv: world.clone().invert(), neighbours, orig: md.verts.map((v) => [v[0], v[1], v[2]] as Vec3), normals: vertexNormals(md),
    layerDisp: new Float32Array(md.verts.length), scale: (Math.abs(sc.x) + Math.abs(sc.y) + Math.abs(sc.z)) / 3 || 1,
  };
}

/** Apply one brush dab centred at `c` (object-local) with local radius `r`. */
function dab(cache: StrokeCache, s: SculptSettings, brush: SculptBrush, c: Vector3, r: number, invert: boolean, grabDelta?: Vector3, grabWeights?: Map<number, number>): void {
  const { md, neighbours, normals } = cache;
  const strength = s.strength * (invert ? -1 : 1) * (s.direction === 'SUBTRACT' ? -1 : 1);
  const centers: { c: Vector3; mirror: Vector3 }[] = [{ c, mirror: new Vector3(1, 1, 1) }];
  // symmetry: mirror the dab across the enabled local axes (all combinations)
  for (let mask = 1; mask < 8; mask++) {
    if ((mask & 1 && !s.symmetry[0]) || (mask & 2 && !s.symmetry[1]) || (mask & 4 && !s.symmetry[2])) continue;
    const m = new Vector3(mask & 1 ? -1 : 1, mask & 2 ? -1 : 1, mask & 4 ? -1 : 1);
    centers.push({ c: c.clone().multiply(m), mirror: m });
  }
  for (const { c: cc, mirror } of centers) {
    if (brush === 'GRAB' && grabDelta && grabWeights) {
      // grab moves the captured vertex set once (symmetry is not applied to grab)
      if (mirror.x === 1 && mirror.y === 1 && mirror.z === 1) for (const [i, w] of grabWeights) moveVert(md, s, i, grabDelta.clone().multiplyScalar(w));
      continue;
    }
    const r2 = r * r;
    const idx: number[] = [];
    const w: number[] = [];
    const area = new Vector3();
    const centroid = new Vector3();
    md.verts.forEach((v, i) => {
      if (md.vhide?.[i]) return;
      const dx = v[0] - cc.x, dy = v[1] - cc.y, dz = v[2] - cc.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2) return;
      const f = falloff(s.falloff, Math.sqrt(d2) / r);
      if (f <= 0) return;
      idx.push(i); w.push(f);
      area.x += normals[i][0] * f; area.y += normals[i][1] * f; area.z += normals[i][2] * f;
      centroid.x += v[0] * f; centroid.y += v[1] * f; centroid.z += v[2] * f;
    });
    if (!idx.length) continue;
    const wsum = w.reduce((a, b) => a + b, 0);
    centroid.multiplyScalar(1 / wsum);
    if (area.lengthSq() < 1e-12) area.set(0, 0, 1);
    area.normalize();
    if (s.useFrontFacesOnly) { /* front-face filtering happens through the view ray; skipped for simplicity */ }
    const amount = r * 0.1 * strength;
    idx.forEach((i, k) => {
      const v = md.verts[i];
      const p = new Vector3(v[0], v[1], v[2]);
      const f = w[k];
      const delta = new Vector3();
      switch (brush) {
        case 'DRAW': delta.copy(area).multiplyScalar(amount * f); break;
        case 'CLAY': {
          // pull towards a plane offset above the brush area
          const plane = centroid.clone().add(area.clone().multiplyScalar(amount * 2));
          const dist = plane.clone().sub(p).dot(area);
          if (strength >= 0 ? dist > 0 : dist < 0) delta.copy(area).multiplyScalar(dist * Math.min(1, Math.abs(strength)) * f * 0.5);
          break;
        }
        case 'LAYER': {
          const target = r * 0.1 * Math.abs(strength) * (strength < 0 ? -1 : 1);
          const cur = cache.layerDisp[i];
          const add = (target - cur) * f;
          if (Math.abs(add) > 1e-9) {
            const o = cache.orig[i];
            const nrm = cache.normals[i];
            cache.layerDisp[i] = cur + add;
            const np = new Vector3(o[0] + nrm[0] * cache.layerDisp[i], o[1] + nrm[1] * cache.layerDisp[i], o[2] + nrm[2] * cache.layerDisp[i]);
            delta.copy(np.sub(p));
          }
          break;
        }
        case 'INFLATE': delta.set(normals[i][0], normals[i][1], normals[i][2]).multiplyScalar(amount * f); break;
        case 'FLATTEN': {
          const dist = p.clone().sub(centroid).dot(area);
          delta.copy(area).multiplyScalar(-dist * Math.min(1, Math.abs(strength)) * f * (strength < 0 ? -1 : 1));
          break;
        }
        case 'PINCH': {
          const toC = centroid.clone().sub(p);
          toC.sub(area.clone().multiplyScalar(toC.dot(area)));
          delta.copy(toC).multiplyScalar(0.25 * strength * f);
          break;
        }
        case 'CREASE': {
          const toC = cc.clone().sub(p);
          toC.sub(area.clone().multiplyScalar(toC.dot(area)));
          delta.copy(area).multiplyScalar(amount * f).add(toC.multiplyScalar(0.25 * Math.abs(strength) * f));
          break;
        }
        case 'SMOOTH': {
          const nb = neighbours[i];
          if (!nb.length) break;
          const avg = new Vector3();
          for (const j of nb) avg.add(new Vector3(...md.verts[j]));
          avg.multiplyScalar(1 / nb.length);
          delta.copy(avg.sub(p)).multiplyScalar(Math.min(1, Math.abs(strength)) * f);
          break;
        }
        default: break;
      }
      moveVert(md, s, i, delta);
    });
  }
}

function moveVert(md: MeshData, s: SculptSettings, i: number, d: Vector3): void {
  const v = md.verts[i];
  if (!s.lockAxis[0]) v[0] += d.x;
  if (!s.lockAxis[1]) v[1] += d.y;
  if (!s.lockAxis[2]) v[2] += d.z;
}

/** Start a brush stroke from a pointerdown in the viewport. */
export function startSculptStroke(view: View3D, e: PointerEvent): void {
  const ob = app.sculptObj;
  const md = app.meshOf(ob);
  if (!ob || !md) return;
  const s = sculptSettings();
  const world = app.matrices.world(ob).clone();
  const cache = buildCache(md, world);
  const brush: SculptBrush = e.shiftKey ? 'SMOOTH' : s.brush;
  const invert = e.ctrlKey;
  const rect = view.canvasRect();
  const hitAt = (x: number, y: number): Vector3 | null => {
    const hits = view.renderer.pickMeshes(x, y).filter((h) => h.ob.id === ob.id);
    return hits[0]?.point ?? null;
  };
  const startPos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  const startHit = hitAt(startPos.x, startPos.y);
  if (!startHit && brush !== 'GRAB') { app.report('INFO', 'Start the stroke on the mesh'); }
  const radiusLocal = (worldPoint: Vector3) => (s.radius * view.view.pixelSize(worldPoint)) / cache.scale;
  // grab: capture weights once
  let grabWeights: Map<number, number> | undefined;
  let grabLast: Vector3 | null = null;
  if (brush === 'GRAB' && startHit) {
    const c = startHit.clone().applyMatrix4(cache.inv);
    const r = radiusLocal(startHit);
    grabWeights = new Map();
    md.verts.forEach((v, i) => {
      const d = Math.hypot(v[0] - c.x, v[1] - c.y, v[2] - c.z);
      if (d <= r) grabWeights!.set(i, falloff(s.falloff, d / r) * Math.min(1, s.strength * 1.0 + 0.0001));
    });
    grabLast = startHit.clone();
  }
  let last: Vector3 | null = null;
  const stroke = (x: number, y: number) => {
    if (brush === 'GRAB') {
      if (!grabLast || !grabWeights) return;
      const now = view.view.unprojectAtDepth(x, y, grabLast);
      const deltaW = now.clone().sub(grabLast);
      const deltaL = deltaW.clone().transformDirection(cache.inv).multiplyScalar(deltaW.length() / cache.scale);
      dab(cache, s, brush, new Vector3(), 1, invert, deltaL, grabWeights);
      grabLast = now;
    } else {
      const hit = hitAt(x, y);
      if (!hit) return;
      const r = radiusLocal(hit);
      const c = hit.clone().applyMatrix4(cache.inv);
      // spacing: interpolate dabs between the last and the current position
      const spacing = Math.max(1e-6, r * Math.max(0.02, s.spacing));
      if (last) {
        const dist = last.distanceTo(c);
        if (dist < spacing) return;
        const n = Math.min(20, Math.floor(dist / spacing));
        for (let k = 1; k <= n; k++) dab(cache, s, brush, last.clone().lerp(c, k / n), r, invert);
        cache.normals = vertexNormals(md);
      } else dab(cache, s, brush, c, r, invert);
      last = c;
    }
    cache.normals = vertexNormals(md);
    app.tagGeometry(md.id);
    view.requestRender();
  };
  stroke(startPos.x, startPos.y);
  const h: ModalHandler = {
    status: () => `Sculpt: ${BRUSHES.find((b) => b.id === brush)?.label ?? brush} — radius ${Math.round(s.radius)} px, strength ${s.strength.toFixed(2)}`,
    cursor: 'crosshair',
    cancel: () => app.endModal(h),
    onEvent(ev) {
      const r = view.canvasRect();
      if (ev.type === 'pointermove') {
        const pe = ev as PointerEvent;
        view.brushPos = { x: pe.clientX - r.left, y: pe.clientY - r.top };
        stroke(pe.clientX - r.left, pe.clientY - r.top);
        return true;
      }
      if (ev.type === 'pointerup') {
        app.endModal(h);
        app.pushUndo(`Sculpt Stroke (${BRUSHES.find((b) => b.id === brush)?.label ?? brush})`);
        app.notify('geometry');
        return true;
      }
      return true;
    },
  };
  app.startModal(h);
}

/** F (radius) / Shift+F (strength): interactive brush size like Blender's radial control. */
export function startRadialControl(view: View3D, which: 'radius' | 'strength', target?: { radius: number; strength: number }): void {
  const s = target ?? sculptSettings();
  const r0 = view.canvasRect();
  const center = view.brushPos ?? { x: app.mouse.x - r0.left, y: app.mouse.y - r0.top };
  const orig = which === 'radius' ? s.radius : s.strength;
  view.radialControl = { center, which };
  const h: ModalHandler = {
    status: () => (which === 'radius' ? `Radius: ${Math.round(s.radius)}` : `Strength: ${s.strength.toFixed(3)}`),
    cancel: () => { view.radialControl = null; app.endModal(h); },
    onEvent(ev) {
      const r = view.canvasRect();
      if (ev.type === 'pointermove') {
        const pe = ev as PointerEvent;
        const d = Math.hypot(pe.clientX - r.left - center.x, pe.clientY - r.top - center.y);
        if (which === 'radius') s.radius = Math.max(2, Math.min(500, d));
        else s.strength = Math.max(0, Math.min(1, d / 200));
        view.requestRender();
        app.notify('view');
        return true;
      }
      if (ev.type === 'pointerdown' || ev.type === 'keydown') {
        const ok = ev.type === 'pointerdown' ? (ev as PointerEvent).button === 0 : (ev as KeyboardEvent).key === 'Enter';
        const cancel = ev.type === 'pointerdown' ? (ev as PointerEvent).button === 2 : (ev as KeyboardEvent).key === 'Escape';
        if (!ok && !cancel) return true;
        if (cancel) { if (which === 'radius') s.radius = orig; else s.strength = orig; }
        view.radialControl = null;
        app.endModal(h);
        app.notify('view', 'data');
        return true;
      }
      return true;
    },
  };
  app.startModal(h);
}

/** Sculpt-mode hotkeys (handled before the keymap). */
export function sculptKey(view: View3D, e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.altKey || e.metaKey) return false;
  const k = e.code;
  const map: Record<string, SculptBrush> = { KeyX: 'DRAW', KeyC: 'CLAY', KeyG: 'GRAB', KeyI: 'INFLATE', KeyL: 'LAYER', KeyP: 'PINCH', KeyS: 'SMOOTH' };
  if (e.shiftKey && k === 'KeyT') { setBrush('FLATTEN'); return true; }
  if (e.shiftKey && k === 'KeyC') { setBrush('CREASE'); return true; }
  if (!e.shiftKey && map[k]) { setBrush(map[k]); return true; }
  if (k === 'KeyF') { startRadialControl(view, e.shiftKey ? 'strength' : 'radius'); return true; }
  if (k === 'BracketLeft' || k === 'BracketRight') {
    const s = sculptSettings();
    s.radius = Math.max(2, Math.min(500, s.radius * (k === 'BracketLeft' ? 0.9 : 1.1)));
    app.notify('view', 'data');
    return true;
  }
  if (k === 'KeyE' && !e.shiftKey) {
    const s = sculptSettings();
    s.direction = s.direction === 'ADD' ? 'SUBTRACT' : 'ADD';
    app.notify('view', 'data');
    return true;
  }
  return false;
}

// ------------------------------------------------------------------ UI

export function sculptPanels(): PanelDef[] {
  const S = () => sculptSettings();
  return [
    {
      id: 'brush', label: 'Brush', key: () => S().brush, draw: (l: Layout) => {
        l.prop({ kind: 'enum', name: 'Brush', items: BRUSHES.map((b) => ({ id: b.id, label: b.label, icon: 'SCULPTMODE_HLT', description: `${b.description} (${b.key})` })), get: () => S().brush, set: (v) => setBrush(v as SculptBrush), undo: false }, { noLabel: true });
        const c = l.column(true);
        c.prop({ kind: 'int', name: 'Radius', min: 1, max: 500, get: () => Math.round(S().radius), set: (v) => { S().radius = v; }, undo: false, notify: ['view'], description: 'Radius of the brush in pixels (F)', unit: 'PIXEL' }, { slider: true });
        c.prop({ kind: 'float', name: 'Strength', min: 0, max: 1, precision: 3, step: 0.01, get: () => S().strength, set: (v) => { S().strength = v; }, undo: false, notify: ['view'], description: 'How powerful the effect of the brush is when applied (Shift F)' }, { slider: true });
        if (S().brush !== 'SMOOTH' && S().brush !== 'GRAB' && S().brush !== 'FLATTEN') {
          l.prop({ kind: 'enum', name: 'Direction', items: [{ id: 'ADD', label: 'Add', icon: 'ZOOMIN' }, { id: 'SUBTRACT', label: 'Subtract', icon: 'ZOOMOUT' }], get: () => S().direction, set: (v) => { S().direction = v as 'ADD'; }, undo: false, description: 'Direction of the brush (E toggles, hold Ctrl to invert)' }, { expand: true });
        }
        l.label('Hold Ctrl to invert, Shift to smooth.');
      },
    },
    {
      id: 'stroke', label: 'Stroke', defaultClosed: true, draw: (l: Layout) => {
        l.prop({ kind: 'float', name: 'Spacing', min: 0.01, max: 1, precision: 2, step: 0.01, get: () => S().spacing, set: (v) => { S().spacing = v; }, undo: false, description: 'Spacing between brush dabs, relative to the radius' }, { slider: true });
      },
    },
    {
      id: 'curve', label: 'Curve', defaultClosed: true, draw: (l: Layout) => {
        l.prop({ kind: 'enum', name: 'Falloff', items: ['SMOOTH', 'SPHERE', 'ROOT', 'SHARP', 'LINEAR', 'CONSTANT'].map((id) => ({ id, label: id[0] + id.slice(1).toLowerCase() })), get: () => S().falloff, set: (v) => { S().falloff = v as 'SMOOTH'; }, undo: false }, { expand: false });
      },
    },
    {
      id: 'symmetry', label: 'Symmetry/Lock', draw: (l: Layout) => {
        l.label('Mirror:');
        const r = l.row(true);
        for (let i = 0; i < 3; i++) r.prop(bprop(() => S(), 'symmetry', { name: 'XYZ'[i], undo: false, description: `Mirror brush across the ${'XYZ'[i]} axis` }, i), { toggle: true });
        l.label('Lock:');
        const r2 = l.row(true);
        for (let i = 0; i < 3; i++) r2.prop(bprop(() => S(), 'lockAxis', { name: 'XYZ'[i], undo: false, description: `Disallow changes to the ${'XYZ'[i]} axis of vertices` }, i), { toggle: true });
      },
    },
    {
      id: 'dyntopo', label: 'Dyntopo', defaultClosed: true, draw: (l: Layout) => {
        l.button('Enable Dyntopo', () => {}, { disabled: () => true, tip: 'Dynamic topology is not available in blender-web' });
      },
    },
  ];
}

export function sculptMenu(): MenuItem[] {
  const S = sculptSettings();
  return [
    { type: 'submenu', label: 'Brush', items: BRUSHES.map((b) => ({ label: b.label, shortcut: b.key, checked: S.brush === b.id, action: () => setBrush(b.id) })) },
    { type: 'separator' },
    { label: 'Mirror X', checked: S.symmetry[0], action: () => { S.symmetry[0] = !S.symmetry[0]; } },
    { label: 'Mirror Y', checked: S.symmetry[1], action: () => { S.symmetry[1] = !S.symmetry[1]; } },
    { label: 'Mirror Z', checked: S.symmetry[2], action: () => { S.symmetry[2] = !S.symmetry[2]; } },
    { type: 'separator' },
    { label: 'Toggle Direction', shortcut: 'E', action: () => { S.direction = S.direction === 'ADD' ? 'SUBTRACT' : 'ADD'; } },
    { type: 'separator' },
    { label: 'Radius...', shortcut: 'F', action: () => {} , disabled: true },
  ];
}
