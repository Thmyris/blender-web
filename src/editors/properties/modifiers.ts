// Modifiers context (properties_data_modifier.py + template_modifier of Blender 2.79).
// Like Blender, the stack is drawn as boxes in one header-less panel. Field names match
// what core/modifiers.ts evaluates; every edit refreshes the viewport through 'data'
// (the evaluated-mesh cache is keyed by the modifier JSON).

import { app } from '../../app';
import { modifierDef } from '../../core/modifiers';
import type { Modifier } from '../../core/types';
import type { BoolProp, EnumItem, EnumProp, FloatProp, IntProp, Layout, PanelDef, PropOpts } from '../../ui/layout';
import type { MenuItem } from '../../ui/menu';
import {
  activeWhen, callOp, flatPanel, NA, naBool, naButton, naEnum, naFloat, naIdField, naInt, ob, type PropsCtx,
} from './common';

/** Blender 2.79's Add Modifier menu: [type, label, icon]. */
const ADD_MENU: { title: string; items: [string, string, string][] }[] = [
  {
    title: 'Modify', items: [
      ['DATA_TRANSFER', 'Data Transfer', 'MOD_DATA_TRANSFER'], ['MESH_CACHE', 'Mesh Cache', 'MOD_MESHDEFORM'],
      ['MESH_SEQUENCE_CACHE', 'Mesh Sequence Cache', 'MOD_MESHDEFORM'], ['NORMAL_EDIT', 'Normal Edit', 'MOD_NORMALEDIT'],
      ['UV_PROJECT', 'UV Project', 'MOD_UVPROJECT'], ['UV_WARP', 'UV Warp', 'MOD_UVPROJECT'],
      ['VERTEX_WEIGHT_EDIT', 'Vertex Weight Edit', 'MOD_VERTEX_WEIGHT'], ['VERTEX_WEIGHT_MIX', 'Vertex Weight Mix', 'MOD_VERTEX_WEIGHT'],
      ['VERTEX_WEIGHT_PROXIMITY', 'Vertex Weight Proximity', 'MOD_VERTEX_WEIGHT'],
    ],
  },
  {
    title: 'Generate', items: [
      ['ARRAY', 'Array', 'MOD_ARRAY'], ['BEVEL', 'Bevel', 'MOD_BEVEL'], ['BOOLEAN', 'Boolean', 'MOD_BOOLEAN'], ['BUILD', 'Build', 'MOD_BUILD'],
      ['DECIMATE', 'Decimate', 'MOD_DECIM'], ['EDGE_SPLIT', 'Edge Split', 'MOD_EDGESPLIT'], ['MASK', 'Mask', 'MOD_MASK'],
      ['MIRROR', 'Mirror', 'MOD_MIRROR'], ['MULTIRES', 'Multiresolution', 'MOD_MULTIRES'], ['REMESH', 'Remesh', 'MOD_REMESH'],
      ['SCREW', 'Screw', 'MOD_SCREW'], ['SKIN', 'Skin', 'MOD_SKIN'], ['SOLIDIFY', 'Solidify', 'MOD_SOLIDIFY'],
      ['SUBSURF', 'Subdivision Surface', 'MOD_SUBSURF'], ['TRIANGULATE', 'Triangulate', 'MOD_TRIANGULATE'], ['WIREFRAME', 'Wireframe', 'MOD_WIREFRAME'],
    ],
  },
  {
    title: 'Deform', items: [
      ['ARMATURE', 'Armature', 'ARMATURE_DATA'], ['CAST', 'Cast', 'MOD_CAST'], ['CORRECTIVE_SMOOTH', 'Corrective Smooth', 'MOD_SMOOTH'],
      ['CURVE', 'Curve', 'MOD_CURVE'], ['DISPLACE', 'Displace', 'MOD_DISPLACE'], ['HOOK', 'Hook', 'MOD_HOOK'],
      ['LAPLACIANSMOOTH', 'Laplacian Smooth', 'MOD_SMOOTH'], ['LAPLACIANDEFORM', 'Laplacian Deform', 'MOD_MESHDEFORM'],
      ['LATTICE', 'Lattice', 'MOD_LATTICE'], ['MESH_DEFORM', 'Mesh Deform', 'MOD_MESHDEFORM'], ['SHRINKWRAP', 'Shrinkwrap', 'MOD_SHRINKWRAP'],
      ['SIMPLE_DEFORM', 'Simple Deform', 'MOD_SIMPLEDEFORM'], ['SMOOTH', 'Smooth', 'MOD_SMOOTH'], ['SURFACE_DEFORM', 'Surface Deform', 'MOD_MESHDEFORM'],
      ['WARP', 'Warp', 'MOD_WARP'], ['WAVE', 'Wave', 'MOD_WAVE'],
    ],
  },
  {
    title: 'Simulate', items: [
      ['CLOTH', 'Cloth', 'MOD_CLOTH'], ['COLLISION', 'Collision', 'MOD_PHYSICS'], ['DYNAMIC_PAINT', 'Dynamic Paint', 'MOD_DYNAMICPAINT'],
      ['EXPLODE', 'Explode', 'MOD_EXPLODE'], ['FLUID_SIMULATION', 'Fluid Simulation', 'MOD_FLUIDSIM'], ['OCEAN', 'Ocean', 'MOD_OCEAN'],
      ['PARTICLE_INSTANCE', 'Particle Instance', 'MOD_PARTICLES'], ['PARTICLE_SYSTEM', 'Particle System', 'MOD_PARTICLES'],
      ['SMOKE', 'Smoke', 'MOD_SMOKE'], ['SOFT_BODY', 'Soft Body', 'MOD_SOFT'],
    ],
  },
];

/** Deform-only modifiers can be shown on the edit-mode cage. */
export const DEFORM_TYPES = new Set(['CAST', 'DISPLACE', 'SIMPLE_DEFORM', 'SMOOTH', 'WAVE']);

function addMenu(ctx: PropsCtx): MenuItem[] {
  return [{
    type: 'columns',
    columns: ADD_MENU.map((c) => ({
      title: c.title,
      items: c.items.map(([type, label, ic]): MenuItem => (modifierDef(type)?.supported
        ? { label, icon: ic, description: `Add a ${label} modifier to the active object`, action: () => callOp(ctx, 'object.modifier_add', { type }) }
        : { label, icon: ic, disabled: true, description: NA })),
    })),
  }];
}

export function modifierPanels(ctx: PropsCtx): PanelDef[] {
  const structure = () => JSON.stringify((ob()?.modifiers ?? []).map((m) => [m.type, m.name, m.showExpanded, m.fitType, m.deformMethod, m.useMirrorMerge, m.direction]));
  return [{
    id: 'modifier.stack', label: 'Modifiers', noHeader: true, key: structure,
    draw: (l) => {
      flatPanel(l);
      l.menu('Add Modifier', () => addMenu(ctx), { title: 'Add Modifier' });
      (ob()?.modifiers ?? []).forEach((_, i) => modifierBox(l, ctx, i));
    },
  }];
}

// ------------------------------------------------------------------ prop helpers bound to modifier #i

type M = () => Modifier | null;

function mb(m: M, key: string, name: string, description = '', def = false): BoolProp {
  return {
    kind: 'bool', name, description, notify: ['data'],
    get: () => { const v = m()?.[key]; return v === undefined ? def : !!v; },
    set: (v) => { const x = m(); if (x) x[key] = v; },
  };
}

function mf(m: M, key: string, name: string, o: Partial<FloatProp> = {}): FloatProp {
  return { kind: 'float', name, notify: ['data'], precision: 3, get: () => Number(m()?.[key] ?? 0), set: (v) => { const x = m(); if (x) x[key] = v; }, ...o };
}

function mi(m: M, key: string, name: string, o: Partial<IntProp> = {}): IntProp {
  return { kind: 'int', name, notify: ['data'], get: () => Number(m()?.[key] ?? 0), set: (v) => { const x = m(); if (x) x[key] = Math.round(v); }, ...o };
}

/** Element `i` of a vector field. */
function mv(m: M, key: string, i: number, name: string, o: Partial<FloatProp> = {}): FloatProp {
  return {
    kind: 'float', name, notify: ['data'], precision: 3,
    get: () => { const a = m()?.[key]; return Array.isArray(a) ? Number(a[i] ?? 0) : 0; },
    set: (v) => { const x = m(); if (!x) return; if (!Array.isArray(x[key])) x[key] = [0, 0, 0]; (x[key] as number[])[i] = v; },
    ...o,
  };
}

function me(m: M, key: string, name: string, items: EnumItem[], description = ''): EnumProp {
  return { kind: 'enum', name, items, description, notify: ['data'], get: () => String(m()?.[key] ?? ''), set: (v) => { const x = m(); if (x) x[key] = v; } };
}

function vgroup(l: Layout, label = true, opts: PropOpts = { noLabel: true }): void {
  if (label) l.label('Vertex Group:', { disabled: true });
  l.prop(naEnum('Vertex Group', [{ id: '', label: '', icon: 'GROUP' }]), opts);
}

// ------------------------------------------------------------------ box

function modifierBox(l: Layout, ctx: PropsCtx, i: number): void {
  const m: M = () => ob()?.modifiers[i] ?? null;
  const mod = m();
  if (!mod) return;
  const def = modifierDef(mod.type);
  const count = ob()?.modifiers.length ?? 0;
  const box = l.box();
  const head = box.row();
  head.prop({ ...mb(m, 'showExpanded', '', 'Set modifier expanded in the user interface'), undo: false }, { iconOnly: true, icon: 'TRIA_RIGHT', iconOn: 'TRIA_DOWN', emboss: false }).style.background = 'transparent';
  head.label('', { icon: def?.icon ?? 'MODIFIER', fixed: true });
  head.prop({
    kind: 'string', name: '', description: 'Modifier name', undo: 'Rename Modifier', notify: ['data'],
    get: () => m()?.name ?? '',
    set: (v) => {
      const o = ob(); const x = m();
      if (!o || !x || !v.trim()) return;
      // operators address modifiers by name: keep names unique within the stack
      const names = new Set(o.modifiers.filter((y) => y !== x).map((y) => y.name));
      let n = v.trim();
      for (let k = 1; names.has(n); k++) n = `${v.trim()}.${String(k).padStart(3, '0')}`;
      x.name = n;
    },
  });
  const toggles = head.row(true);
  toggles.el.classList.add('fixed');
  toggles.prop(mb(m, 'showRender', 'Render', 'Use modifier during render', true), { iconOnly: true, icon: 'RESTRICT_RENDER_OFF' });
  toggles.prop(mb(m, 'showViewport', 'Realtime', 'Display modifier in viewport', true), { iconOnly: true, icon: 'RESTRICT_VIEW_OFF' });
  toggles.prop(mb(m, 'showInEditmode', 'Edit Mode', 'Display modifier in Edit mode'), { iconOnly: true, icon: 'EDITMODE_HLT' });
  if (DEFORM_TYPES.has(mod.type)) {
    toggles.prop({ ...mb(m, 'showOnCage', 'On Cage', 'Adjust edit cage to modifier result (stored; the edit cage is not deformed in blender-web)'), disabled: () => !m()?.showInEditmode }, { iconOnly: true, icon: 'MESH_DATA' });
  }
  if (count > 1) {
    const ud = head.row(true);
    ud.el.classList.add('fixed');
    ud.button('', () => { const x = m(); if (x) callOp(ctx, 'object.modifier_move_up', { modifier: x.name }); }, { icon: 'TRIA_UP', iconOnly: true, tip: 'Move modifier up in the stack', disabled: () => i === 0 });
    ud.button('', () => { const x = m(); if (x) callOp(ctx, 'object.modifier_move_down', { modifier: x.name }); }, { icon: 'TRIA_DOWN', iconOnly: true, tip: 'Move modifier down in the stack', disabled: () => i >= (ob()?.modifiers.length ?? 0) - 1 });
  }
  head.button('', () => { const x = m(); if (x) callOp(ctx, 'object.modifier_remove', { modifier: x.name }); }, { icon: 'X', iconOnly: true, tip: 'Remove a modifier from the active object' }).classList.add('fixed');

  if (!mod.showExpanded) return;
  const body = box.column();
  const ar = body.row();
  ar.button('Apply', () => { const x = m(); if (x) callOp(ctx, 'object.modifier_apply', { modifier: x.name, apply_as: 'DATA' }); }, {
    tip: 'Apply modifier and remove from the stack', disabled: () => !app.pollOperator('object.modifier_apply', ctx.area),
  });
  if (DEFORM_TYPES.has(mod.type)) naButton(ar, 'Apply as Shape Key');
  ar.button('Copy', () => { const x = m(); if (x) callOp(ctx, 'object.modifier_copy', { modifier: x.name }); }, { tip: 'Duplicate modifier at the same position in the stack' });
  const draw = DRAW[mod.type];
  if (draw) draw(body, m);
  else body.label(`Settings for this modifier are not available in blender-web`, { disabled: true });
}

// ------------------------------------------------------------------ per type layouts (2.79)

/** Per-type layouts; other modules add theirs with `DRAW[type] = ...` (exported for that). */
export const DRAW: Record<string, (l: Layout, m: () => Modifier | null) => void> = {
  SUBSURF: (l, m) => {
    l.row().prop(me(m, 'subdivisionType', 'Subdivision Type', [
      { id: 'CATMULL_CLARK', label: 'Catmull-Clark', description: 'Use Catmull-Clark subdivision' },
      { id: 'SIMPLE', label: 'Simple', description: 'Use simple subdivision' },
    ], 'Select type of subdivision algorithm'), { expand: true });
    const sp = l.split();
    const c1 = sp.column();
    c1.label('Subdivisions:');
    c1.prop(mi(m, 'levels', 'View', { min: 0, max: 6, description: 'Number of subdivisions to perform' }));
    c1.prop(mi(m, 'renderLevels', 'Render', { min: 0, max: 6, description: 'Number of subdivisions to perform when rendering' }));
    const c2 = sp.column();
    c2.label('Options:');
    c2.prop(mb(m, 'useSubsurfUv', 'Subdivide UVs', 'Use subsurf to subdivide UVs (stored; UVs are not modelled)', true));
    c2.prop(mb(m, 'showOnlyControlEdges', 'Optimal Display', 'Skip drawing/rendering of interior subdivided edges (stored)'));
    c2.prop(naBool('Use OpenSubdiv'));
  },

  MIRROR: (l, m) => {
    const sp = l.split(0.25);
    const c1 = sp.column();
    c1.label('Axis:');
    c1.prop(mb(m, 'useX', 'X', 'Enable X axis mirror', true));
    c1.prop(mb(m, 'useY', 'Y', 'Enable Y axis mirror'));
    c1.prop(mb(m, 'useZ', 'Z', 'Enable Z axis mirror'));
    const c2 = sp.column();
    c2.label('Options:');
    c2.prop(mb(m, 'useMirrorMerge', 'Merge', 'Merge vertices within the merge threshold', true));
    c2.prop(mb(m, 'useClip', 'Clipping', 'Prevent vertices from going through the mirror during transform'));
    c2.prop(naBool('Vertex Groups'));
    const c3 = sp.column();
    c3.label('Textures:', { disabled: true });
    c3.prop(naBool('U'));
    c3.prop(naBool('V'));
    const col = l.column(true);
    col.prop(naFloat('U Offset', 0));
    col.prop(naFloat('V Offset', 0));
    const c4 = l.column();
    if (m()?.useMirrorMerge !== false) c4.prop(mf(m, 'mergeThreshold', 'Merge Limit', { min: 0, max: 1, softMax: 1, unit: 'LENGTH', precision: 3, step: 0.001, description: 'Distance within which mirrored vertices are merged' }));
    c4.label('Mirror Object:', { disabled: true });
    naIdField(c4, '');
  },

  ARRAY: (l, m) => {
    l.prop(me(m, 'fitType', 'Fit Type', [
      { id: 'FIXED_COUNT', label: 'Fixed Count', description: 'Duplicate the object a certain number of times' },
      { id: 'FIT_LENGTH', label: 'Fit Length', disabled: true, description: NA },
      { id: 'FIT_CURVE', label: 'Fit Curve', disabled: true, description: NA },
    ], 'Array length calculation method'));
    l.prop(mi(m, 'count', 'Count', { min: 1, max: 1000, softMax: 1000, description: 'Number of duplicates to make' }));
    l.separator();
    const sp = l.split();
    const c1 = sp.column();
    c1.prop(mb(m, 'useConstantOffset', 'Constant Offset', 'Add a constant offset'));
    const s1 = c1.column(true);
    activeWhen(s1, () => !!m()?.useConstantOffset);
    for (let k = 0; k < 3; k++) s1.prop(mv(m, 'constantOffset', k, ['X', 'Y', 'Z'][k], { unit: 'LENGTH', step: 0.1, description: 'Value for the distance between arrayed items' }));
    c1.separator();
    c1.prop(mb(m, 'useMerge', 'Merge', 'Merge vertices in adjacent duplicates'));
    const s2 = c1.column();
    activeWhen(s2, () => !!m()?.useMerge);
    s2.prop(naBool('First Last'));
    s2.prop(mf(m, 'mergeThreshold', 'Distance', { min: 0, max: 1, unit: 'LENGTH', step: 0.01, description: 'Limit below which to merge vertices' }));
    const c2 = sp.column();
    c2.prop(mb(m, 'useRelativeOffset', 'Relative Offset', 'Add an offset relative to the object\'s bounding box', true));
    const s3 = c2.column(true);
    activeWhen(s3, () => m()?.useRelativeOffset !== false);
    for (let k = 0; k < 3; k++) s3.prop(mv(m, 'relativeOffset', k, ['X', 'Y', 'Z'][k], { step: 0.1, description: 'The size of the geometry will determine the distance between arrayed items' }));
    c2.separator();
    c2.prop(naBool('Object Offset'));
    naIdField(c2, '');
    l.separator();
    naIdField(l, 'Start Cap', 'OUTLINER_OB_MESH');
    naIdField(l, 'End Cap', 'OUTLINER_OB_MESH');
  },

  SOLIDIFY: (l, m) => {
    const sp = l.split();
    const c1 = sp.column();
    c1.prop(mf(m, 'thickness', 'Thickness', { min: -10, max: 10, softMin: -10, softMax: 10, unit: 'LENGTH', step: 0.01, precision: 4, description: 'Thickness of the shell' }));
    c1.prop(naFloat('Clamp', 0));
    c1.separator();
    vgroup(c1, false);
    c1.prop(naFloat('Factor', 0));
    c1.label('Crease:', { disabled: true });
    const cr = c1.column(true);
    cr.prop(naFloat('Inner', 0));
    cr.prop(naFloat('Outer', 0));
    cr.prop(naFloat('Rim', 0));
    const c2 = sp.column();
    c2.prop(mf(m, 'offset', 'Offset', { min: -1, max: 1, step: 0.1, precision: 4, description: 'Offset the thickness from the center' }));
    c2.prop(mb(m, 'useFlipNormals', 'Flip Normals', 'Invert the face direction'));
    c2.prop(mb(m, 'useEvenOffset', 'Even Thickness', 'Maintain thickness by adjusting for sharp corners'));
    c2.prop(naBool('High Quality Normals'));
    c2.prop(mb(m, 'useRim', 'Fill Rim', 'Create edge loops between the inner and outer surfaces on face edges', true));
    c2.prop(naBool('Only Rim'));
    c2.separator();
    c2.label('Material Index Offset:', { disabled: true });
    const mr = c2.row(true);
    mr.prop(naInt('', 0));
    mr.prop(naInt('Rim', 0));
  },

  TRIANGULATE: (l, m) => {
    const row = l.row();
    const c1 = row.column();
    c1.label('Quad Method:');
    c1.prop(me(m, 'quadMethod', 'Quad Method', [
      { id: 'BEAUTY', label: 'Beauty' }, { id: 'FIXED', label: 'Fixed' }, { id: 'FIXED_ALTERNATE', label: 'Fixed Alternate' }, { id: 'SHORTEST_DIAGONAL', label: 'Shortest Diagonal' },
    ], 'Method for splitting the quads into triangles'), { noLabel: true });
    const c2 = row.column();
    c2.label('Ngon Method:');
    c2.prop(me(m, 'ngonMethod', 'Ngon Method', [{ id: 'BEAUTY', label: 'Beauty' }, { id: 'CLIP', label: 'Clip' }],
      'Method for splitting the polygons into triangles'), { noLabel: true });
  },

  SMOOTH: (l, m) => {
    const sp = l.split(0.25);
    const c1 = sp.column();
    c1.label('Axis:');
    c1.prop(mb(m, 'useX', 'X', 'Smooth object along X axis', true));
    c1.prop(mb(m, 'useY', 'Y', 'Smooth object along Y axis', true));
    c1.prop(mb(m, 'useZ', 'Z', 'Smooth object along Z axis', true));
    const c2 = sp.column();
    c2.prop(mf(m, 'factor', 'Factor', { min: -1000, max: 1000, softMin: -10, softMax: 10, step: 0.1, description: 'Strength of modifier effect' }));
    c2.prop(mi(m, 'iterations', 'Repeat', { min: 0, max: 32767, softMax: 30, description: 'Number of smoothing iterations' }));
    vgroup(c2);
  },

  WAVE: (l, m) => {
    const sp = l.split();
    const c1 = sp.column();
    c1.label('Motion:');
    c1.prop(mb(m, 'useX', 'X', 'X axis motion', true));
    c1.prop(mb(m, 'useY', 'Y', 'Y axis motion', true));
    c1.prop(mb(m, 'useCyclic', 'Cycles', 'Cyclic wave effect', true));
    const c2 = sp.column();
    c2.prop(mb(m, 'useNormal', 'Normals', 'Displace along normals'));
    const s = c2.column();
    s.prop(naBool('X', true));
    s.prop(naBool('Y', true));
    s.prop(naBool('Z', true));
    const sp2 = l.split();
    const t = sp2.column();
    t.label('Time:');
    const ts = t.column(true);
    ts.prop(mf(m, 'timeOffset', 'Offset', { min: -300000, max: 300000, step: 1, precision: 2, unit: 'FRAMES', description: 'Either the starting frame (for positive speed) or ending frame (for negative speed)' }));
    ts.prop(mf(m, 'lifetime', 'Life', { min: -300000, max: 300000, step: 1, precision: 2, description: 'Lifetime of the wave in frames, zero means infinite' }));
    t.prop(mf(m, 'dampingTime', 'Damping', { min: -300000, max: 300000, step: 1, precision: 2, description: 'Number of frames in which the wave damps out after it dies' }));
    const p = sp2.column();
    p.label('Position:');
    const ps = p.column(true);
    ps.prop(mf(m, 'startX', 'X', { unit: 'LENGTH', step: 0.1, precision: 4, description: 'X coordinate of the start position' }));
    ps.prop(mf(m, 'startY', 'Y', { unit: 'LENGTH', step: 0.1, precision: 4, description: 'Y coordinate of the start position' }));
    p.prop(mf(m, 'falloffRadius', 'Falloff', { min: 0, unit: 'LENGTH', step: 0.1, description: 'Distance after which it fades out' }));
    l.separator();
    naIdField(l, 'Start Position Object', 'OBJECT_DATA');
    l.prop(naEnum('Vertex Group', [{ id: '', label: '', icon: 'GROUP' }]));
    const sp3 = l.split(0.33);
    sp3.column().label('Texture', { disabled: true });
    naButton(sp3.column(), 'New', 'ZOOMIN');
    l.separator();
    const sp4 = l.split();
    const a = sp4.column(true);
    a.prop(mf(m, 'speed', 'Speed', { min: -2, max: 2, softMin: -1, softMax: 1, step: 0.01, description: 'Speed of the wave, towards the starting point when negative' }), { slider: true });
    a.prop(mf(m, 'height', 'Height', { min: -2, max: 2, softMin: -2, softMax: 2, step: 0.01, description: 'Height of the wave' }), { slider: true });
    const b = sp4.column(true);
    b.prop(mf(m, 'width', 'Width', { min: 0, max: 5, step: 0.01, description: 'Distance between the waves' }), { slider: true });
    b.prop(mf(m, 'narrowness', 'Narrowness', { min: 0, max: 10, step: 0.01, description: 'Distance between the top and the base of a wave, the higher the value, the more narrow the wave' }), { slider: true });
  },

  DISPLACE: (l, m) => {
    const col = l.column(true);
    col.label('Texture:', { disabled: true });
    naButton(col, 'New', 'ZOOMIN');
    const sp = l.split();
    const c1 = sp.column(true);
    c1.label('Direction:');
    c1.prop(me(m, 'direction', 'Direction', [
      { id: 'X', label: 'X', description: 'Use the texture\'s intensity value to displace in the X direction' },
      { id: 'Y', label: 'Y', description: 'Use the texture\'s intensity value to displace in the Y direction' },
      { id: 'Z', label: 'Z', description: 'Use the texture\'s intensity value to displace in the Z direction' },
      { id: 'NORMAL', label: 'Normal', description: 'Use the texture\'s intensity value to displace along the vertex normal' },
      { id: 'CUSTOM_NORMAL', label: 'Custom Normal', disabled: true, description: NA },
      { id: 'RGB_TO_XYZ', label: 'RGB to XYZ', description: 'Use the texture\'s RGB values to displace the mesh in the XYZ direction' },
    ], 'Direction to displace the vertices along'), { noLabel: true });
    const dir = m()?.direction;
    if (dir === 'X' || dir === 'Y' || dir === 'Z' || dir === 'RGB_TO_XYZ') {
      c1.label('Space:', { disabled: true });
      c1.prop(naEnum('Space', ['Local', 'Global']), { noLabel: true });
    }
    vgroup(c1);
    const c2 = sp.column(true);
    c2.label('Texture Coordinates:', { disabled: true });
    c2.prop(naEnum('Texture Coordinates', ['Local', 'Global', 'Object', 'UV']), { noLabel: true });
    l.separator();
    const row = l.row();
    row.prop(mf(m, 'midLevel', 'Midlevel', { min: 0, max: 1, step: 0.1, description: 'Material value that gives no displacement' }), { slider: true });
    row.prop(mf(m, 'strength', 'Strength', { min: -100, max: 100, softMin: -100, softMax: 100, step: 0.1, description: 'Amount to displace geometry' }));
  },

  SIMPLE_DEFORM: (l, m) => {
    l.row().prop(me(m, 'deformMethod', 'Deform Method', [
      { id: 'TWIST', label: 'Twist', description: 'Rotate around the Z axis of the modifier space' },
      { id: 'BEND', label: 'Bend', description: 'Bend the mesh over the Z axis of the modifier space' },
      { id: 'TAPER', label: 'Taper', description: 'Linearly scale along Z axis of the modifier space' },
      { id: 'STRETCH', label: 'Stretch', description: 'Stretch the object along the Z axis of the modifier space' },
    ]), { expand: true });
    const sp = l.split();
    vgroup(sp.column());
    const sp2 = l.split();
    const c1 = sp2.column();
    c1.label('Axis, Origin:', { disabled: true });
    naIdField(c1, '');
    const meth = String(m()?.deformMethod ?? 'TWIST');
    if (meth === 'TAPER' || meth === 'STRETCH' || meth === 'TWIST') {
      c1.label('Lock:');
      c1.prop(mb(m, 'lockX', 'X', 'Do not allow deformation along the X axis'));
      c1.prop(mb(m, 'lockY', 'Y', 'Do not allow deformation along the Y axis'));
    }
    const c2 = sp2.column();
    c2.label('Deform:');
    if (meth === 'TAPER' || meth === 'STRETCH') c2.prop(mf(m, 'factor', 'Factor', { softMin: -10, softMax: 10, step: 0.1, description: 'Amount to deform object' }));
    else c2.prop(mf(m, 'angle', 'Angle', { unit: 'ROTATION', step: Math.PI / 180, description: 'Angle of deformation' }));
    c2.label('Limits:');
    const lim = c2.column(true);
    lim.prop(mv(m, 'limits', 0, '', { min: 0, max: 1, step: 0.01, description: 'Lower/Upper limits for deform' }), { slider: true });
    lim.prop(mv(m, 'limits', 1, '', { min: 0, max: 1, step: 0.01, description: 'Lower/Upper limits for deform' }), { slider: true });
  },

  CAST: (l, m) => {
    const sp = l.split(0.25);
    sp.column().label('Cast Type:');
    sp.column().prop(me(m, 'castType', 'Cast Type', [
      { id: 'SPHERE', label: 'Sphere' }, { id: 'CYLINDER', label: 'Cylinder' }, { id: 'CUBOID', label: 'Cuboid' },
    ], 'Target object shape'), { noLabel: true });
    const sp2 = l.split(0.25);
    const c1 = sp2.column();
    c1.prop(mb(m, 'useX', 'X', 'Use X axis', true));
    c1.prop(mb(m, 'useY', 'Y', 'Use Y axis', true));
    c1.prop(mb(m, 'useZ', 'Z', 'Use Z axis', true));
    const c2 = sp2.column();
    c2.prop(mf(m, 'factor', 'Factor', { softMin: -10, softMax: 10, step: 0.1, description: 'Amount of deformation' }));
    c2.prop(mf(m, 'radius', 'Radius', { min: 0, unit: 'LENGTH', step: 0.1, description: 'Only deform vertices within this distance from the center of the effect (0 = use the average distance)' }));
    c2.prop(naFloat('Size', 0));
    c2.prop(naBool('From Radius', true));
    const sp3 = l.split();
    vgroup(sp3.column());
    const c4 = sp3.column();
    c4.label('Control Object:', { disabled: true });
    naIdField(c4, '');
  },

  EDGE_SPLIT: (l, m) => {
    const sp = l.split();
    const c1 = sp.column();
    c1.prop(mb(m, 'useEdgeAngle', 'Edge Angle', 'Split edges with high angle between faces', true));
    const s = c1.column();
    activeWhen(s, () => m()?.useEdgeAngle !== false);
    s.prop(mf(m, 'splitAngle', 'Split Angle', { min: 0, max: Math.PI, unit: 'ROTATION', step: Math.PI / 180, description: 'Angle above which to split edges' }));
    sp.column().prop(mb(m, 'useEdgeSharp', 'Sharp Edges', 'Split edges that are marked as sharp (stored; sharp edges are not modelled)', true));
  },

  WIREFRAME: (l, m) => {
    const sp = l.split();
    const c1 = sp.column();
    c1.prop(mf(m, 'thickness', 'Thickness', { min: -10, max: 10, softMin: 0, softMax: 1, unit: 'LENGTH', step: 0.01, precision: 4, description: 'Thickness factor' }));
    vgroup(c1, false);
    c1.prop(naFloat('Factor', 0));
    c1.prop(naBool('Crease Edges'));
    c1.prop(naFloat('Crease Weight', 1));
    const c2 = sp.column();
    c2.prop(naFloat('Offset', 0));
    c2.prop(naBool('Even Thickness', true));
    c2.prop(naBool('Relative Thickness'));
    c2.prop(naBool('Boundary'));
    c2.prop(mb(m, 'useReplace', 'Replace Original', 'Remove original geometry', true));
    c2.prop(naInt('Material Offset', 0));
  },

  SCREW: (l, m) => {
    const sp = l.split();
    const c1 = sp.column();
    const ar = c1.row();
    ar.label('Axis:', { fixed: true });
    ar.prop(me(m, 'axis', 'Axis', [{ id: 'X', label: 'X' }, { id: 'Y', label: 'Y' }, { id: 'Z', label: 'Z' }], 'Screw axis'), { expand: true });
    naIdField(c1, 'AxisOb', 'OBJECT_DATA');
    c1.prop(mf(m, 'angle', 'Angle', { unit: 'ROTATION', step: Math.PI / 180, description: 'Angle of revolution' }));
    c1.prop(mi(m, 'steps', 'Steps', { min: 2, max: 10000, softMax: 512, description: 'Number of steps in the revolution' }));
    c1.prop(mi(m, 'renderSteps', 'Render Steps', { min: 2, max: 10000, softMax: 512, description: 'Number of steps in the revolution (for rendering)' }));
    c1.prop(mb(m, 'useSmoothShade', 'Smooth Shading', 'Output faces with smooth shading rather than flat shaded', true));
    c1.prop(naBool('Merge Vertices'));
    c1.prop(naFloat('Merge Distance', 0.01));
    const c2 = sp.column();
    c2.prop(mf(m, 'screwOffset', 'Screw', { unit: 'LENGTH', step: 0.1, description: 'Offset the revolution along its axis' }));
    c2.prop(naBool('Object Screw'));
    c2.prop(naBool('Calc Order', true));
    c2.prop(mb(m, 'useNormalFlip', 'Flip', 'Flip normals of lathed faces'));
    c2.prop(mi(m, 'iterations', 'Iterations', { min: 1, max: 10000, softMax: 100, description: 'Number of times to apply the screw operation' }));
    c2.prop(naBool('Stretch U'));
    c2.prop(naBool('Stretch V'));
  },

  BUILD: (l, m) => {
    const sp = l.split();
    const c1 = sp.column();
    c1.prop(mf(m, 'frameStart', 'Start', { min: -300000, max: 300000, step: 1, precision: 2, unit: 'FRAMES', description: 'Start frame of the effect' }));
    c1.prop(mf(m, 'frameDuration', 'Length', { min: 1, max: 300000, step: 1, precision: 2, unit: 'FRAMES', description: 'Total time the build effect requires' }));
    c1.prop(mb(m, 'useReverse', 'Reversed', 'Deconstruct the mesh instead of building it'));
    const c2 = sp.column();
    c2.prop(mb(m, 'useRandomOrder', 'Randomize', 'Randomize the faces or edges during build'));
    const s = c2.column();
    activeWhen(s, () => !!m()?.useRandomOrder);
    s.prop(mi(m, 'seed', 'Seed', { min: 1, max: 300000, description: 'Seed for random if used' }));
  },
};
