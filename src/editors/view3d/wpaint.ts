// Weight Paint mode: weights of the active vertex group shown as Blender's blue → green → yellow → red
// ramp, Add / Subtract / Mix / Blur / Lighten / Darken / Multiply brushes with weight, radius,
// strength and falloff, Ctrl inverts, Shift blurs, F / Shift+F / Ctrl+F radial controls, X-mirror,
// sample weight / group, bone selection of the deforming armature (Ctrl+RMB), one undo step per stroke.

import {
  BufferAttribute, BufferGeometry, Color, Group, Mesh, MeshPhongMaterial, Quaternion, Vector3,
} from 'three';
import { app, type ModalHandler } from '../../app';
import type { BObject, MeshData, WeightPaintSettings } from '../../core/types';
import type { EvalMesh } from '../../core/modifiers';
import type { Layout, PanelDef } from '../../ui/layout';
import { showMenu, type MenuItem } from '../../ui/menu';
import { triangulatePoly } from '../../core/mesh';
import {
  activeGroupIndex, addGroup, ensureDvert, getWeight, groupIndex, groupsOf, inGroup, setWeight,
} from '../../core/vgroups';
import { armatureOf } from '../../core/armature';
import { registerEditType } from './edittypes';
import { startRadialControl } from './sculpt';
import { pickBone, flipSideName } from './armedit';
import { posedMatrices, selectPoseBone } from './pose';
import { deformGroupNames } from '../../ops/rig';
import type { View3D } from './view3d';

export function wpaintSettings(): WeightPaintSettings {
  const ts = app.scene.toolSettings;
  ts.wpaint ??= { weight: 1, radius: 50, strength: 1, blend: 'MIX', falloff: 'SMOOTH', useFrontFacesOnly: false, useAccumulate: false };
  return ts.wpaint;
}

export const WP_BLENDS: { id: WeightPaintSettings['blend']; label: string; brush: string }[] = [
  { id: 'MIX', label: 'Mix', brush: 'Draw' }, { id: 'ADD', label: 'Add', brush: 'Add' }, { id: 'SUB', label: 'Subtract', brush: 'Subtract' },
  { id: 'MUL', label: 'Multiply', brush: 'Multiply' }, { id: 'BLUR', label: 'Blur', brush: 'Blur' }, { id: 'LIGHTEN', label: 'Lighten', brush: 'Lighten' },
  { id: 'DARKEN', label: 'Darken', brush: 'Darken' },
];

const wpOb = (): BObject | null => (app.mode === 'WEIGHT_PAINT' && app.editObject ? app.doc.objects[app.editObject] ?? null : null);
const wpMesh = (): MeshData | null => app.meshOf(wpOb());

// ------------------------------------------------------------------ colour ramp

/** Blender's weight colour ramp (blue, cyan, green, yellow, red), in sRGB. */
export function weightColor(w: number, out = new Color()): Color {
  const x = Math.min(1, Math.max(0, w));
  if (x <= 0.25) out.setRGB(0, x * 4, 1);
  else if (x <= 0.5) out.setRGB(0, 1, 1 - (x - 0.25) * 4);
  else if (x <= 0.75) out.setRGB((x - 0.5) * 4, 1, 0);
  else out.setRGB(1, 1 - (x - 0.75) * 4, 0);
  return out;
}

// ------------------------------------------------------------------ overlay (weights drawn on the mesh)

let colorAttr: BufferAttribute | null = null;
let colorMap: Int32Array | null = null; // overlay vertex -> mesh vertex
let paintVersion = 0;
/** Ctrl+F radial control edits the brush weight. */
let radialWeight = false;
const emIds = new WeakMap<EvalMesh, number>();
let emCounter = 0;

function evalKey(ob: BObject): string {
  const em = app.evalMesh(ob);
  if (!em) return 'none';
  let id = emIds.get(em);
  if (id === undefined) { id = ++emCounter; emIds.set(em, id); }
  return `${ob.id}|${id}`;
}

/** Map evaluated vertices to mesh vertices (identity when the count matches, else nearest). */
function evalToMesh(em: EvalMesh, md: MeshData): Int32Array {
  const map = new Int32Array(em.verts.length);
  if (em.verts.length === md.verts.length) { for (let i = 0; i < map.length; i++) map[i] = i; return map; }
  // generators (mirror, subsurf, ...): nearest original vertex
  em.verts.forEach((p, i) => {
    let best = 0, bd = Infinity;
    md.verts.forEach((q, j) => { const d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2; if (d < bd) { bd = d; best = j; } });
    map[i] = best;
  });
  return map;
}

function buildWeightOverlay(ob: BObject, group: Group): void {
  const em = app.evalMesh(ob);
  const md = app.meshOf(ob);
  if (!em || !md) return;
  const pos: number[] = [];
  const idx: number[] = [];
  for (const v of em.verts) pos.push(v[0], v[1], v[2]);
  for (const f of em.faces) for (const t of triangulatePoly(em.verts, f)) idx.push(f[t[0]], f[t[1]], f[t[2]]);
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  colorAttr = new BufferAttribute(new Float32Array(em.verts.length * 3), 3);
  g.setAttribute('color', colorAttr);
  g.setIndex(idx);
  g.computeVertexNormals();
  colorMap = evalToMesh(em, md);
  refreshWeightColors();
  const mat = new MeshPhongMaterial({ vertexColors: true, shininess: 10, specular: new Color(0.1, 0.1, 0.1), polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, side: 2 });
  const mesh = new Mesh(g, mat);
  mesh.renderOrder = 5;
  group.add(mesh);
}

/** Rewrite the overlay colours from the current weights (cheap, used during strokes). */
export function refreshWeightColors(): void {
  const ob = wpOb(), md = wpMesh();
  if (!ob || !md || !colorAttr || !colorMap) return;
  const g = activeGroupIndex(ob);
  const c = new Color();
  const arr = colorAttr.array as Float32Array;
  for (let i = 0; i < colorMap.length; i++) {
    const v = colorMap[i];
    const w = g >= 0 ? getWeight(md, v, g) : 0;
    weightColor(w, c).convertSRGBToLinear();
    arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b;
  }
  colorAttr.needsUpdate = true;
}

// ------------------------------------------------------------------ painting

function falloff(type: WeightPaintSettings['falloff'], t: number): number {
  const x = Math.min(1, Math.max(0, t)); // 1 at the centre, 0 at the rim
  switch (type) {
    case 'SPHERE': return Math.sqrt(2 * x - x * x);
    case 'ROOT': return Math.sqrt(x);
    case 'SHARP': return x * x;
    case 'LINEAR': return x;
    case 'CONSTANT': return 1;
    default: return x * x * (3 - 2 * x);
  }
}

function blendWeight(mode: WeightPaintSettings['blend'], cur: number, paint: number, alpha: number, blurAvg?: number): number {
  let t: number;
  switch (mode) {
    case 'ADD': t = cur + paint; break;
    case 'SUB': t = cur - paint; break;
    case 'MUL': t = cur * paint; break;
    case 'LIGHTEN': t = Math.max(cur, paint); break;
    case 'DARKEN': t = Math.min(cur, paint); break;
    case 'BLUR': t = blurAvg ?? cur; break;
    default: t = paint;
  }
  return Math.min(1, Math.max(0, cur + (t - cur) * alpha));
}

/** Mirrored vertex (by position across the object's X axis), or -1. */
function mirrorMap(md: MeshData): Int32Array {
  const key = (x: number, y: number, z: number) => `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
  const idx = new Map<string, number>();
  md.verts.forEach((p, i) => idx.set(key(p[0], p[1], p[2]), i));
  return Int32Array.from(md.verts, (p) => idx.get(key(-p[0], p[1], p[2])) ?? -1);
}

function normalizeVertex(md: MeshData, ob: BObject, v: number, keep: number): void {
  const dv = md.dvert?.[v];
  if (!dv || dv.length < 2) return;
  const deform = deformGroupNames(ob);
  const gs = groupsOf(ob);
  const use = (g: number) => !deform.size || deform.has(gs[g]?.name ?? '');
  const locked = (g: number) => !!gs[g]?.lockWeight;
  const kept = dv.find(([g]) => g === keep);
  const others = dv.filter(([g]) => g !== keep && use(g) && !locked(g));
  const fixed = dv.filter(([g]) => g !== keep && use(g) && locked(g)).reduce((s, [, w]) => s + w, 0);
  const rest = Math.max(0, 1 - (kept?.[1] ?? 0) - fixed);
  const sum = others.reduce((s, [, w]) => s + w, 0);
  if (sum > 0) for (const e of others) e[1] = (e[1] / sum) * rest;
  else if (kept && kept[1] + fixed > 1) kept[1] = Math.max(0, 1 - fixed);
}

function startWeightStroke(view: View3D, e: PointerEvent): void {
  const ob = wpOb(), md = wpMesh();
  if (!ob || !md) return;
  const s = wpaintSettings();
  if (!ob.vertexGroups?.length) { addGroup(ob, 'Group'); app.notify('data'); }
  const g = activeGroupIndex(ob);
  if (groupsOf(ob)[g]?.lockWeight) { app.report('WARNING', 'Active group is locked, aborting'); return; }
  ensureDvert(md);
  const em = app.evalMesh(ob);
  // paint on the deformed surface when it has the same vertices
  const positions = em && em.verts.length === md.verts.length ? em.verts : md.verts;
  const world = app.matrices.world(ob).clone();
  const inv = world.clone().invert();
  const sc = new Vector3();
  world.decompose(new Vector3(), new Quaternion(), sc);
  const scale = (Math.abs(sc.x) + Math.abs(sc.y) + Math.abs(sc.z)) / 3 || 1;
  const nbr: number[][] = md.verts.map(() => []);
  for (const [a, b] of md.edges) { nbr[a].push(b); nbr[b].push(a); }
  const start = md.verts.map((_, v) => getWeight(md, v, g));
  const strokeMax = new Float32Array(md.verts.length);
  let mode: WeightPaintSettings['blend'] = e.shiftKey ? 'BLUR' : s.blend;
  let paint = s.weight;
  if (e.ctrlKey) {
    // Ctrl inverts the brush: add <-> subtract, lighten <-> darken, others paint the inverted weight
    if (mode === 'ADD') mode = 'SUB'; else if (mode === 'SUB') mode = 'ADD';
    else if (mode === 'LIGHTEN') mode = 'DARKEN'; else if (mode === 'DARKEN') mode = 'LIGHTEN';
    else paint = 1 - paint;
  }
  const mirror = app.scene.toolSettings.useWeightPaintMirrorX ? mirrorMap(md) : null;
  const mirrorGroup = mirror ? (() => { const n = flipSideName(groupsOf(ob)[g].name); const i = groupIndex(ob, n); return i >= 0 ? i : g; })() : g;
  const autoNorm = !!app.scene.toolSettings.useAutoNormalize;
  const apply = (v: number, gi: number, f: number, base: number) => {
    let w: number;
    if (mode === 'BLUR') {
      let sum = 0, n = 0;
      for (const j of nbr[v]) { sum += getWeight(md, j, gi); n++; }
      if (!n) return;
      w = blendWeight('BLUR', getWeight(md, v, gi), paint, f * 0.5, sum / n);
    } else w = blendWeight(mode, s.useAccumulate ? getWeight(md, v, gi) : base, paint, f);
    if (w <= 0 && !inGroup(md, v, gi) && mode !== 'MIX') return;
    setWeight(md, v, gi, w);
    if (autoNorm) normalizeVertex(md, ob, v, gi);
  };
  const paintAt = (x: number, y: number) => {
    const hit = view.renderer.pickMeshes(x, y).find((h) => h.ob.id === ob.id);
    if (!hit?.point) return;
    const c = hit.point.clone().applyMatrix4(inv);
    const r = (s.radius * view.view.pixelSize(hit.point)) / scale;
    for (let v = 0; v < positions.length; v++) {
      if (md.vhide?.[v]) continue;
      const p = positions[v];
      const d = Math.hypot(p[0] - c.x, p[1] - c.y, p[2] - c.z);
      if (d > r) continue;
      const f = Math.min(1, s.strength * falloff(s.falloff, 1 - d / r));
      if (mode !== 'BLUR' && !s.useAccumulate) {
        if (f <= strokeMax[v] + 1e-4) continue;
        strokeMax[v] = f;
      }
      apply(v, g, f, start[v]);
      if (mirror && mirror[v] >= 0 && mirror[v] !== v) apply(mirror[v], mirrorGroup, f, getWeight(md, mirror[v], mirrorGroup));
    }
    paintVersion++;
    refreshWeightColors();
    void paintVersion;
    // modifiers reading weights (armature, mask, ...) see the new values
    if (ob.modifiers.length) app.tagGeometry(md.id);
    view.requestRender();
  };
  const r0 = view.canvasRect();
  paintAt(e.clientX - r0.left, e.clientY - r0.top);
  const h: ModalHandler = {
    status: () => `Weight Paint — ${WP_BLENDS.find((b) => b.id === mode)?.label}, weight ${paint.toFixed(3)}, radius ${Math.round(s.radius)} px, strength ${s.strength.toFixed(2)}`,
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
        app.tagGeometry(md.id);
        app.pushUndo('Weight Paint Stroke');
        app.report('OPERATOR', `bpy.ops.paint.weight_paint(stroke=[...])`);
        return true;
      }
      return true;
    },
  };
  app.startModal(h);
}

/** Vertex nearest to the mouse on the painted object (or -1). */
function vertexUnderMouse(view: View3D, x: number, y: number): number {
  const ob = wpOb(), md = wpMesh();
  if (!ob || !md) return -1;
  const hit = view.renderer.pickMeshes(x, y).find((h) => h.ob.id === ob.id);
  if (!hit?.point) return -1;
  const c = hit.point.clone().applyMatrix4(app.matrices.world(ob).clone().invert());
  const em = app.evalMesh(ob);
  const positions = em && em.verts.length === md.verts.length ? em.verts : md.verts;
  let best = -1, bd = Infinity;
  positions.forEach((p, i) => { const d = (p[0] - c.x) ** 2 + (p[1] - c.y) ** 2 + (p[2] - c.z) ** 2; if (d < bd) { bd = d; best = i; } });
  return best;
}

/** The armature deforming the painted mesh (for Ctrl+RMB bone selection). */
function deformingArmature(ob: BObject): BObject | null {
  for (const m of ob.modifiers) if (m.type === 'ARMATURE' && m.object && app.doc.objects[m.object as string]) return app.doc.objects[m.object as string];
  return null;
}

function sampleWeight(view: View3D, x: number, y: number): boolean {
  const ob = wpOb(), md = wpMesh();
  if (!ob || !md) return false;
  const v = vertexUnderMouse(view, x, y);
  if (v < 0) return false;
  wpaintSettings().weight = getWeight(md, v, activeGroupIndex(ob));
  app.report('INFO', `Sampled weight: ${wpaintSettings().weight.toFixed(3)}`);
  app.notify('view', 'data');
  return true;
}

function sampleGroup(view: View3D, x: number, y: number): void {
  const ob = wpOb(), md = wpMesh();
  if (!ob || !md) return;
  const v = vertexUnderMouse(view, x, y);
  const dv = v >= 0 ? md.dvert?.[v] ?? [] : [];
  if (!dv.length) return;
  showMenu(dv.map(([gi, w]): MenuItem => ({ label: `${groupsOf(ob)[gi]?.name ?? gi} (${w.toFixed(3)})`, action: () => { ob.activeVertexGroup = gi; refreshWeightColors(); app.pushUndo('Set Active Group'); app.notify('data', 'view'); } })), app.mouse, { title: 'Vertex Groups', atMouse: true });
}

function selectBoneAt(view: View3D, x: number, y: number, extend: boolean): boolean {
  const ob = wpOb();
  const armOb = ob ? deformingArmature(ob) : null;
  const arm = armatureOf(app.doc, armOb);
  if (!ob || !armOb || !arm) return false;
  const hit = pickBone(view, armOb, arm, x, y, posedMatrices(armOb), false);
  if (!hit) return false;
  selectPoseBone(arm, hit.bone, extend);
  const gi = groupIndex(ob, hit.bone.name);
  if (gi >= 0) ob.activeVertexGroup = gi;
  refreshWeightColors();
  app.pushUndo('Select Bone');
  app.notify('data', 'select', 'view');
  return true;
}

// ------------------------------------------------------------------ weight radial control (Ctrl+F)

function startWeightRadial(view: View3D): void {
  const s = wpaintSettings();
  const proxy = { radius: s.radius, get strength() { return s.weight; }, set strength(v: number) { s.weight = v; } };
  radialWeight = true;
  startRadialControl(view, 'strength', proxy);
}

// ------------------------------------------------------------------ UI

const S = () => wpaintSettings();

export function wpaintPanels(): PanelDef[] {
  return [
    {
      id: 'wpbrush', label: 'Brush', draw: (l: Layout) => {
        l.prop({ kind: 'enum', name: 'Brush', items: WP_BLENDS.map((b) => ({ id: b.id, label: b.brush, icon: 'BRUSH_DATA' })), get: () => S().blend, set: (v) => { S().blend = v as 'MIX'; }, undo: false, notify: ['view'], description: 'Weight paint brush (blend mode)' }, { noLabel: true });
        const c = l.column(true);
        c.prop({ kind: 'float', name: 'Weight', min: 0, max: 1, precision: 3, step: 0.01, get: () => S().weight, set: (v) => { S().weight = v; }, undo: false, notify: ['view'], description: 'Weight to paint (Ctrl+F)' }, { slider: true });
        c.prop({ kind: 'int', name: 'Radius', min: 1, max: 500, unit: 'PIXEL', get: () => Math.round(S().radius), set: (v) => { S().radius = v; }, undo: false, notify: ['view'], description: 'Radius of the brush in pixels (F)' }, { slider: true });
        c.prop({ kind: 'float', name: 'Strength', min: 0, max: 1, precision: 3, step: 0.01, get: () => S().strength, set: (v) => { S().strength = v; }, undo: false, notify: ['view'], description: 'How powerful the effect of the brush is (Shift+F)' }, { slider: true });
        l.prop({ kind: 'enum', name: 'Blend', items: WP_BLENDS.map((b) => ({ id: b.id, label: b.label })), get: () => S().blend, set: (v) => { S().blend = v as 'MIX'; }, undo: false, description: 'Brush blending mode' });
        l.label('Ctrl inverts, Shift blurs.');
      },
    },
    {
      id: 'wptools', label: 'Weight Tools', draw: (l: Layout) => {
        const c = l.column(true);
        for (const [id, text, props] of [
          ['object.vertex_group_normalize_all', 'Normalize All', { lock_active: false }], ['object.vertex_group_normalize', 'Normalize', {}],
          ['object.vertex_group_mirror', 'Mirror', {}], ['object.vertex_group_invert', 'Invert', {}], ['object.vertex_group_clean', 'Clean', {}],
          ['object.vertex_group_quantize', 'Quantize', {}], ['object.vertex_group_levels', 'Levels', {}], ['object.vertex_group_smooth', 'Smooth', {}],
          ['object.vertex_group_limit_total', 'Limit Total', {}],
        ] as [string, string, Record<string, unknown>][]) c.operator(id, { text, props, align: 'left' });
      },
    },
    {
      id: 'wpstroke', label: 'Stroke', defaultClosed: true, draw: (l: Layout) => {
        l.prop({ kind: 'bool', name: 'Accumulate', get: () => S().useAccumulate, set: (v) => { S().useAccumulate = v; }, undo: false, description: 'Accumulate stroke daubs on top of each other' });
      },
    },
    {
      id: 'wpcurve', label: 'Curve', defaultClosed: true, draw: (l: Layout) => {
        l.prop({ kind: 'enum', name: 'Falloff', items: ['SMOOTH', 'SPHERE', 'ROOT', 'SHARP', 'LINEAR', 'CONSTANT'].map((id) => ({ id, label: id[0] + id.slice(1).toLowerCase() })), get: () => S().falloff, set: (v) => { S().falloff = v as 'SMOOTH'; }, undo: false, description: 'Brush falloff curve preset' });
      },
    },
    {
      id: 'wpoptions', label: 'Options', draw: (l: Layout) => {
        const ts = app.scene.toolSettings;
        l.prop({ kind: 'bool', name: 'Auto Normalize', get: () => !!ts.useAutoNormalize, set: (v) => { ts.useAutoNormalize = v; }, description: 'Ensure that all deforming vertex groups add up to 1.0 while painting' });
        l.prop({ kind: 'bool', name: 'X Mirror', get: () => !!ts.useWeightPaintMirrorX, set: (v) => { ts.useWeightPaintMirrorX = v; }, description: 'Paint on the mirrored side too (groups with flipped names, e.g. .L / .R)' });
        l.prop({ kind: 'bool', name: 'Use Front Faces Only', get: () => S().useFrontFacesOnly, set: (v) => { S().useFrontFacesOnly = v; }, undo: false, description: 'Only paint faces facing the view (the brush always paints the surface under the mouse)' });
      },
    },
  ];
}

export function weightsMenu(): MenuItem[] {
  const op = (label: string, id: string, props?: Record<string, unknown>): MenuItem => ({ label, op: id, props });
  return [
    op('Normalize All', 'object.vertex_group_normalize_all', { lock_active: false }),
    op('Normalize', 'object.vertex_group_normalize'),
    op('Mirror', 'object.vertex_group_mirror'),
    op('Invert', 'object.vertex_group_invert'),
    op('Clean', 'object.vertex_group_clean'),
    op('Quantize', 'object.vertex_group_quantize'),
    op('Levels', 'object.vertex_group_levels'),
    op('Smooth', 'object.vertex_group_smooth'),
    op('Limit Total', 'object.vertex_group_limit_total'),
    { type: 'separator' },
    { type: 'submenu', label: 'Brush', items: WP_BLENDS.map((b) => ({ label: b.brush, checked: wpaintSettings().blend === b.id, action: () => { wpaintSettings().blend = b.id; app.notify('view'); } })) },
  ];
}

registerEditType({
  types: ['MESH'],
  mode: 'WEIGHT_PAINT',
  trackBrush: true,
  enter: (ob) => { const md = app.meshOf(ob); if (md) ensureDvert(md); },
  clickSelect: () => false,
  regionSelect: () => {},
  selectAll: () => {},
  hasSelection: () => false,
  transformPoints: () => [],
  menuLabel: 'Weights',
  menu: weightsMenu,
  overlayKey: (ob) => `${evalKey(ob)}|${activeGroupIndex(ob)}|${ob.vertexGroups?.length ?? 0}`,
  buildOverlay: (ob, group) => buildWeightOverlay(ob, group),
  pointerDown: (view, _ob, e, button) => {
    const p = view.local(e);
    if (button === 'ACTION') { startWeightStroke(view, e); return true; }
    if (button === 'SELECT') {
      if (e.ctrlKey) { if (!selectBoneAt(view, p.x, p.y, e.shiftKey)) sampleWeight(view, p.x, p.y); return true; }
      if (e.shiftKey) { sampleGroup(view, p.x, p.y); return true; }
      return true;
    }
    return false;
  },
  key: (view, _ob, e) => {
    if (e.altKey || e.metaKey) return false;
    if (e.code === 'KeyF') {
      if (e.ctrlKey) startWeightRadial(view);
      else { radialWeight = false; startRadialControl(view, e.shiftKey ? 'strength' : 'radius', wpaintSettings()); }
      return true;
    }
    if (e.ctrlKey) return false;
    if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
      const s = wpaintSettings();
      s.radius = Math.max(2, Math.min(500, s.radius * (e.code === 'BracketLeft' ? 0.9 : 1.1)));
      app.notify('view', 'data');
      return true;
    }
    return false;
  },
  draw2D: (view, ctx) => {
    const s = wpaintSettings();
    const rc = view.radialControl;
    const pos = rc ? rc.center : view.brushPos;
    if (!pos) return;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(pos.x, pos.y, s.radius, 0, Math.PI * 2); ctx.stroke();
    if (rc) {
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      const amount = radialWeight ? s.weight : s.strength;
      const val = rc.which === 'radius' ? s.radius : (amount * 200);
      ctx.beginPath(); ctx.arc(pos.x, pos.y, val, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(rc.which === 'radius' ? `${Math.round(s.radius)}` : amount.toFixed(3), pos.x - 12, pos.y + 4);
    }
  },
});

