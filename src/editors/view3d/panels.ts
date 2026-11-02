// Tool shelf (T) tabs and panels, properties region (N) panels and the
// "Adjust Last Operation" redo panel of the 3D View.

import { Vector3 } from 'three';
import { app, type OpPropDef, type OpProps } from '../../app';
import type { PanelDef, Layout, Prop } from '../../ui/layout';
import { fprop, bprop, sprop } from '../../ui/layout';
import { keyState, insertKeyframe, deleteKeyframe, findFCurve } from '../../core/anim';
import { renameData } from '../../core/scene';
import { meshBounds } from '../../core/mesh';
import type { BObject } from '../../core/types';
import type { View3D } from './view3d';
import { ORIENT_ITEMS } from './header';
import { sculptPanels } from './sculpt';
import { vpaintPanels } from './vpaint';

export const TOOL_TABS: { id: string; label: string; poll: () => boolean }[] = [
  { id: 'Tools', label: 'Tools', poll: () => true },
  { id: 'Create', label: 'Create', poll: () => app.mode === 'OBJECT' || app.mode === 'EDIT' },
  { id: 'Relations', label: 'Relations', poll: () => app.mode === 'OBJECT' },
  { id: 'Animation', label: 'Animation', poll: () => app.mode === 'OBJECT' },
  { id: 'Physics', label: 'Physics', poll: () => app.mode === 'OBJECT' },
  { id: 'Shading / UVs', label: 'Shading / UVs', poll: () => app.mode === 'EDIT' },
  { id: 'Options', label: 'Options', poll: () => app.mode === 'EDIT' },
  { id: 'Grease Pencil', label: 'Grease Pencil', poll: () => true },
];

const ob = () => app.activeObject;
const em = () => app.editMesh;

/** Property bound to an object transform channel with keyframe colouring and I-key support. */
export function obChannel(path: 'location' | 'rotation_euler' | 'scale' | 'delta_location' | 'delta_rotation_euler' | 'delta_scale', i: number, getOb: () => BObject | null = ob): Prop {
  const field = path === 'location' ? 'location' : path === 'rotation_euler' ? 'rotation' : path === 'scale' ? 'scale' : path === 'delta_location' ? 'deltaLocation' : path === 'delta_rotation_euler' ? 'deltaRotation' : 'deltaScale';
  const isRot = path.includes('rotation');
  const isScale = path.includes('scale');
  return fprop(getOb, field, {
    unit: isRot ? 'ROTATION' : isScale ? 'NONE' : 'LENGTH',
    precision: isRot ? 3 : isScale ? 3 : 5,
    step: isRot ? Math.PI / 180 : 0.1,
    default: isScale ? 1 : 0,
    name: ['X', 'Y', 'Z'][i],
    description: isRot ? 'Rotation in Eulers' : isScale ? 'Scaling of the object' : 'Location of the object',
    python: `bpy.data.objects["${getOb()?.name ?? ''}"].${path}[${i}]`,
    notify: ['scene'],
    keyState: () => { const o = getOb(); return o ? keyState(o, path, i, app.scene.frameCurrent) : 'NONE'; },
    keyframe: (action) => {
      const o = getOb();
      if (!o) return;
      const f = app.scene.frameCurrent;
      if (action === 'insert') { insertKeyframe(o, path, i, f, undefined, app.prefs.keyframeInterpolation); app.report('INFO', 'Successfully added keyframe'); }
      else if (action === 'delete') deleteKeyframe(o, path, i, f);
      else { const fc = findFCurve(o, path, i); if (fc) o.fcurves = o.fcurves.filter((x) => x !== fc); }
      app.pushUndo('Keyframe');
    },
    onChange: () => {
      const o = getOb();
      if (o && app.scene.toolSettings.useKeyframeInsertAuto) insertKeyframe(o, path, i, app.scene.frameCurrent);
    },
  }, i);
}

function lockToggle(l: Layout, key: 'lockLocation' | 'lockRotation' | 'lockScale', i: number) {
  return l.prop(bprop(ob, key, { name: 'Lock', description: 'Lock editing in the interface', notify: ['scene'] }, i), { iconOnly: true, icon: 'UNLOCKED', iconOn: 'LOCKED', emboss: false });
}

function transformColumn(l: Layout, label: string, path: 'location' | 'rotation_euler' | 'scale', lock: 'lockLocation' | 'lockRotation' | 'lockScale') {
  const col = l.column(true);
  col.label(`${label}:`);
  for (let i = 0; i < 3; i++) {
    const r = col.row(true);
    r.prop(obChannel(path, i));
    lockToggle(r, lock, i).classList.add('fixed');
  }
}

function dimensions(l: Layout) {
  const col = l.column(true);
  col.label('Dimensions:');
  for (let i = 0; i < 3; i++) {
    col.prop({
      kind: 'float', name: ['X', 'Y', 'Z'][i], unit: 'LENGTH', precision: 3, step: 0.1, notify: ['scene'],
      description: 'Absolute bounding box dimensions of the object',
      get: () => {
        const o = ob();
        const m = o ? app.evalMesh(o) : null;
        if (!o || !m || !m.verts.length) return 0;
        const b = meshBounds(m.verts);
        return (b.max[i] - b.min[i]) * Math.abs(o.scale[i]);
      },
      set: (v) => {
        const o = ob();
        const m = o ? app.evalMesh(o) : null;
        if (!o || !m) return;
        const b = meshBounds(m.verts);
        const size = b.max[i] - b.min[i];
        if (size > 1e-9) o.scale[i] = (v / size) * Math.sign(o.scale[i] || 1);
      },
    });
  }
}

/** Median / single vertex transform in edit mode. */
function editTransform(l: Layout, view: View3D) {
  const md = em();
  const eob = app.editObj;
  if (!md || !eob) return;
  const sel = md.verts.map((_, i) => i).filter((i) => md.vsel[i]);
  if (!sel.length) { l.label('Nothing selected'); return; }
  const global = !!view.state.editGlobal;
  const med = () => {
    const m = em();
    const s = m ? m.verts.map((_, i) => i).filter((i) => m.vsel[i]) : [];
    const c = new Vector3();
    for (const i of s) c.add(new Vector3(...m!.verts[i]));
    c.multiplyScalar(1 / Math.max(1, s.length));
    if (global && app.editObj) c.applyMatrix4(app.matrices.world(app.editObj));
    return c;
  };
  const col = l.column(true);
  col.label(sel.length === 1 ? 'Vertex:' : 'Median:');
  for (let i = 0; i < 3; i++) {
    col.prop({
      kind: 'float', name: ['X', 'Y', 'Z'][i], unit: 'LENGTH', precision: 5, step: 0.1, notify: ['geometry'], undo: 'Transform Vertices',
      get: () => med().getComponent(i),
      set: (v) => {
        const m = em(); const o = app.editObj;
        if (!m || !o) return;
        const cur = med();
        const delta = new Vector3();
        delta.setComponent(i, v - cur.getComponent(i));
        if (global) delta.transformDirection(app.matrices.world(o).clone().invert()).multiplyScalar(delta.length() / Math.max(1e-12, delta.length()));
        if (global) {
          const inv = app.matrices.world(o).clone().invert();
          const a = cur.clone().applyMatrix4(inv), b = cur.clone().setComponent(i, v).applyMatrix4(inv);
          delta.copy(b.sub(a));
        }
        m.verts.forEach((p, k) => { if (m.vsel[k]) { p[0] += delta.x; p[1] += delta.y; p[2] += delta.z; } });
        app.tagGeometry(m.id);
      },
    });
  }
  const r = l.row(true);
  r.prop({ kind: 'enum', name: 'Space', items: [{ id: 'GLOBAL', label: 'Global' }, { id: 'LOCAL', label: 'Local' }], get: () => (view.state.editGlobal ? 'GLOBAL' : 'LOCAL'), set: (v) => { view.state.editGlobal = v === 'GLOBAL'; }, undo: false, notify: ['view'] }, { expand: true });
}

// ------------------------------------------------------------------ tool shelf

function opButtons(l: Layout, ops: [string, string, Record<string, unknown>?][]) {
  const col = l.column(true);
  for (const [id, text, props] of ops) col.operator(id, { text, props, align: 'left' });
}

function na(l: Layout, text: string) {
  const b = l.button(text, () => {}, { tip: `${text}: not available in blender-web`, disabled: () => true });
  b.classList.add('left');
}

export function toolshelfPanels(view: View3D): PanelDef[] {
  const tab = view.state.toolTab as string;
  const P: PanelDef[] = [];
  const isEdit = app.mode === 'EDIT';
  if (app.mode === 'VERTEX_PAINT') {
    return tab === 'Tools' ? [...vpaintPanels(), { id: 'history', label: 'History', draw: (l) => { const r = l.row(true); r.operator('ed.undo', { text: 'Undo' }); r.operator('ed.redo', { text: 'Redo' }); } }] : [];
  }
  if (app.mode === 'SCULPT') {
    if (tab === 'Tools') return [...sculptPanels(), { id: 'history', label: 'History', draw: (l) => { const r = l.row(true); r.operator('ed.undo', { text: 'Undo' }); r.operator('ed.redo', { text: 'Redo' }); l.operator('ed.undo_history', { text: 'Undo History', align: 'left' }); } }];
    if (tab === 'Grease Pencil') return [];
    return [];
  }
  if (tab === 'Tools') {
    if (!isEdit) {
      P.push({ id: 'transform', label: 'Transform', draw: (l) => opButtons(l, [['transform.translate', 'Translate'], ['transform.rotate', 'Rotate'], ['transform.resize', 'Scale'], ['transform.mirror', 'Mirror']]) });
      P.push({
        id: 'edit', label: 'Edit', draw: (l) => {
          opButtons(l, [['object.duplicate_move', 'Duplicate'], ['object.duplicate_move_linked', 'Duplicate Linked'], ['object.delete', 'Delete'], ['object.join', 'Join']]);
          l.menu('Set Origin', () => [
            { label: 'Geometry to Origin', op: 'object.origin_set', props: { type: 'GEOMETRY_ORIGIN' } },
            { label: 'Origin to Geometry', op: 'object.origin_set', props: { type: 'ORIGIN_GEOMETRY' } },
            { label: 'Origin to 3D Cursor', op: 'object.origin_set', props: { type: 'ORIGIN_CURSOR' } },
            { label: 'Origin to Center of Mass', op: 'object.origin_set', props: { type: 'ORIGIN_CENTER_OF_MASS' } },
          ], { title: 'Set Origin' });
        },
      });
      P.push({
        id: 'shading', label: 'Shading', draw: (l) => {
          const r = l.row(true);
          r.operator('object.shade_smooth', { text: 'Smooth' });
          r.operator('object.shade_flat', { text: 'Flat' });
        },
      });
      P.push({ id: 'datatransfer', label: 'Data Transfer', draw: (l) => { const r = l.row(true); na(r, 'Data'); na(r, 'Data Layout'); } });
    } else {
      P.push({ id: 'etransform', label: 'Transform', draw: (l) => opButtons(l, [['transform.translate', 'Translate'], ['transform.rotate', 'Rotate'], ['transform.resize', 'Scale'], ['transform.shrink_fatten', 'Shrink/Fatten'], ['transform.tosphere', 'To Sphere']]) });
      P.push({
        id: 'meshtools', label: 'Mesh Tools', draw: (l) => {
          l.label('Deform:');
          const c1 = l.column(true);
          na(c1, 'Slide Edge'); na(c1, 'Vertex');
          c1.operator('mesh.vertices_smooth', { text: 'Smooth Vertex', align: 'left' });
          c1.operator('transform.vertex_random', { text: 'Randomize', align: 'left' });
          l.label('Add:');
          const c2 = l.column(true);
          c2.menu('Extrude', () => [
            { label: 'Region', op: 'mesh.extrude_region_move' },
            { label: 'Individual', op: 'mesh.extrude_faces_move' },
            { label: 'Edges Only', op: 'mesh.extrude_edges_move' },
            { label: 'Vertices Only', op: 'mesh.extrude_vertices_move' },
          ]);
          for (const [id, text] of [['mesh.extrude_region_move', 'Extrude Region'], ['mesh.extrude_faces_move', 'Extrude Individual'], ['mesh.inset', 'Inset Faces'], ['mesh.edge_face_add', 'Make Edge/Face'], ['mesh.subdivide', 'Subdivide'], ['mesh.loopcut_slide', 'Loop Cut and Slide'], ['mesh.duplicate_move', 'Duplicate']]) c2.operator(id, { text, align: 'left' });
          c2.operator('mesh.spin', { text: 'Spin', align: 'left' });
          na(c2, 'Screw'); na(c2, 'Knife'); na(c2, 'Bisect');
          l.label('Delete:');
          const c3 = l.column(true);
          c3.menu('Delete', () => [
            { label: 'Vertices', op: 'mesh.delete', props: { type: 'VERT' } },
            { label: 'Edges', op: 'mesh.delete', props: { type: 'EDGE' } },
            { label: 'Faces', op: 'mesh.delete', props: { type: 'FACE' } },
            { label: 'Only Edges & Faces', op: 'mesh.delete', props: { type: 'EDGE_FACE' } },
            { label: 'Only Faces', op: 'mesh.delete', props: { type: 'ONLY_FACE' } },
          ]);
          c3.menu('Merge', () => [
            { label: 'At Center', op: 'mesh.merge', props: { type: 'CENTER' } },
            { label: 'At Cursor', op: 'mesh.merge', props: { type: 'CURSOR' } },
            { label: 'Collapse', op: 'mesh.merge', props: { type: 'COLLAPSE' } },
          ]);
          c3.operator('mesh.remove_doubles', { text: 'Remove Doubles', align: 'left' });
        },
      });
    }
    P.push({
      id: 'history', label: 'History', draw: (l) => {
        const r = l.row(true);
        r.operator('ed.undo', { text: 'Undo' });
        r.operator('ed.redo', { text: 'Redo' });
        l.operator('ed.undo_history', { text: 'Undo History', align: 'left' });
        const r2 = l.row(true);
        r2.operator('screen.repeat_last', { text: 'Repeat Last' });
        r2.operator('screen.repeat_history', { text: 'Repeat History...' });
      },
    });
  } else if (tab === 'Create') {
    if (isEdit) {
      P.push({ id: 'addprim', label: 'Add Primitive', draw: (l) => meshPrimButtons(l) });
    } else {
      P.push({
        id: 'addprim', label: 'Add Primitive', draw: (l) => {
          l.label('Mesh:');
          meshPrimButtons(l);
          l.label('Curve:');
          const cc = l.column(true);
          na(cc, 'Bezier'); na(cc, 'Circle'); na(cc, 'Path');
          l.label('Lamp:');
          const lc = l.column(true);
          for (const [t, n, ic] of [['POINT', 'Point', 'LAMP_POINT'], ['SUN', 'Sun', 'LAMP_SUN'], ['SPOT', 'Spot', 'LAMP_SPOT'], ['HEMI', 'Hemi', 'LAMP_HEMI'], ['AREA', 'Area', 'LAMP_AREA']]) lc.operator('object.lamp_add', { text: n, icon: ic, props: { type: t }, align: 'left' });
          l.label('Other:');
          const oc = l.column(true);
          na(oc, 'Text'); na(oc, 'Armature'); na(oc, 'Lattice');
          oc.operator('object.empty_add', { text: 'Empty', icon: 'OUTLINER_OB_EMPTY', props: { type: 'PLAIN_AXES' }, align: 'left' });
          na(oc, 'Force Field');
          oc.operator('object.camera_add', { text: 'Camera', icon: 'OUTLINER_OB_CAMERA', align: 'left' });
          na(oc, 'Speaker');
        },
      });
    }
  } else if (tab === 'Relations') {
    P.push({ id: 'group', label: 'Group', draw: (l) => { na(l, 'Create New Group'); na(l, 'Add to Active'); } });
    P.push({ id: 'parent', label: 'Parent', draw: (l) => { const r = l.row(true); r.operator('object.parent_set', { text: 'Set' }); r.operator('object.parent_clear', { text: 'Clear' }); } });
    P.push({
      id: 'obdata', label: 'Object Data', draw: (l) => {
        l.operator('object.make_single_user', { text: 'Make Single User', props: { type: 'SELECTED_OBJECTS', obdata: true }, align: 'left' });
        l.operator('object.make_links_data', { text: 'Link Data', props: { type: 'OBDATA' }, align: 'left' });
        l.operator('object.make_links_data', { text: 'Link Materials', props: { type: 'MATERIAL' }, align: 'left' });
        l.operator('object.make_links_data', { text: 'Link Modifiers', props: { type: 'MODIFIERS' }, align: 'left' });
      },
    });
  } else if (tab === 'Animation') {
    P.push({
      id: 'keyframes', label: 'Keyframes', draw: (l) => {
        l.label('Keyframes:');
        const r = l.row(true);
        r.operator('anim.keyframe_insert_menu_popup', { text: 'Insert' });
        r.operator('anim.keyframe_delete_v3d', { text: 'Delete' });
        l.label('Keying Set:');
        l.prop({ kind: 'enum', name: 'Keying Set', items: [{ id: '', label: 'Active Keying Set' }, { id: 'LocRotScale', label: 'LocRotScale' }, { id: 'Location', label: 'Location' }, { id: 'Rotation', label: 'Rotation' }, { id: 'Scaling', label: 'Scaling' }], get: () => app.scene.keyingSet, set: (v) => { app.scene.keyingSet = v; } }, { noLabel: true });
      },
    });
    P.push({ id: 'motionpaths', label: 'Motion Paths', defaultClosed: true, draw: (l) => { na(l, 'Calculate'); na(l, 'Clear'); } });
  } else if (tab === 'Physics') {
    P.push({ id: 'rigidbody', label: 'Rigid Body Tools', draw: (l) => { l.label('Add/Remove:'); const r = l.row(true); na(r, 'Add Active'); na(r, 'Add Passive'); na(l, 'Remove'); } });
  } else if (tab === 'Shading / UVs') {
    P.push({
      id: 'eshading', label: 'Shading', draw: (l) => {
        l.label('Faces:');
        const r = l.row(true); r.operator('mesh.faces_shade_smooth', { text: 'Smooth' }); r.operator('mesh.faces_shade_flat', { text: 'Flat' });
        l.label('Normals:');
        const r2 = l.row(true); r2.operator('mesh.normals_make_consistent', { text: 'Recalculate' }); r2.operator('mesh.flip_normals', { text: 'Flip Direction' });
      },
    });
    P.push({ id: 'uvs', label: 'UVs', draw: (l) => { na(l, 'Unwrap'); const r = l.row(true); na(r, 'Mark Seam'); na(r, 'Clear Seam'); } });
  } else if (tab === 'Options') {
    P.push({
      id: 'meshoptions', label: 'Mesh Options', draw: (l) => {
        l.prop(bprop(() => app.scene.toolSettings, 'useMeshAutomerge', { name: 'AutoMerge Editing', description: 'Automatically merge vertices moved to the same location' }));
        l.prop(fprop(() => app.scene.toolSettings, 'doubleThreshold', { name: 'Double Threshold', min: 0, max: 1, step: 0.001, precision: 6, unit: 'LENGTH', description: 'Limit for removing duplicates and AutoMerge' }));
      },
    });
  } else if (tab === 'Grease Pencil') {
    P.push({ id: 'gp', label: 'Grease Pencil', draw: (l) => { l.label('Draw:'); const r = l.row(true); na(r, 'Draw'); na(r, 'Erase'); const r2 = l.row(true); na(r2, 'Line'); na(r2, 'Poly'); } });
  }
  return P;
}

function meshPrimButtons(l: Layout) {
  const c = l.column(true);
  const items: [string, string, string][] = [
    ['mesh.primitive_plane_add', 'Plane', 'MESH_PLANE'], ['mesh.primitive_cube_add', 'Cube', 'MESH_CUBE'],
    ['mesh.primitive_circle_add', 'Circle', 'MESH_CIRCLE'], ['mesh.primitive_uv_sphere_add', 'UV Sphere', 'MESH_UVSPHERE'],
    ['mesh.primitive_ico_sphere_add', 'Ico Sphere', 'MESH_ICOSPHERE'], ['mesh.primitive_cylinder_add', 'Cylinder', 'MESH_CYLINDER'],
    ['mesh.primitive_cone_add', 'Cone', 'MESH_CONE'], ['mesh.primitive_torus_add', 'Torus', 'MESH_TORUS'],
    ['mesh.primitive_grid_add', 'Grid', 'MESH_GRID'], ['mesh.primitive_monkey_add', 'Monkey', 'MESH_MONKEY'],
  ];
  for (let i = 0; i < items.length; i += 2) {
    const r = c.row(true);
    for (const [id, text, ic] of items.slice(i, i + 2)) r.operator(id, { text, icon: ic, align: 'left' });
  }
}

// ------------------------------------------------------------------ N panel

export function npanelPanels(view: View3D): PanelDef[] {
  const P: PanelDef[] = [];
  P.push({
    id: 'transform', label: 'Transform', poll: () => !!ob(), key: () => `${app.mode}${ob()?.id}${app.editMesh?.vsel.filter(Boolean).length === 1}${app.editMesh?.vsel.some(Boolean)}`,
    draw: (l) => {
      if (app.mode === 'EDIT') { editTransform(l, view); return; }
      transformColumn(l, 'Location', 'location', 'lockLocation');
      transformColumn(l, 'Rotation', 'rotation_euler', 'lockRotation');
      l.prop({ kind: 'enum', name: 'Rotation Mode', items: ['XYZ', 'XZY', 'YXZ', 'YZX', 'ZXY', 'ZYX'].map((id) => ({ id, label: `${id} Euler` })), get: () => ob()?.rotationMode ?? 'XYZ', set: (v) => { const o = ob(); if (o) o.rotationMode = v as never; }, notify: ['scene'] }, { noLabel: true });
      transformColumn(l, 'Scale', 'scale', 'lockScale');
      if (ob()?.type === 'MESH') dimensions(l);
    },
  });
  P.push({
    id: 'view', label: 'View', draw: (l) => {
      l.prop({ kind: 'float', name: 'Lens', min: 1, max: 250, step: 1, precision: 0, get: () => view.view.lens, set: (v) => { view.view.lens = v; }, undo: false, notify: ['view'], description: 'Viewport lens angle' }, { text: 'Lens' });
      l.label('Lock to Object:');
      l.prop({ kind: 'enum', name: 'Lock Object', items: () => [{ id: '', label: '' }, ...app.objects().map((o) => ({ id: o.id, label: o.name, icon: 'OBJECT_DATA' }))], get: () => (view.state.lockObject as string) ?? '', set: (v) => { view.state.lockObject = v; }, undo: false }, { noLabel: true });
      l.prop({ kind: 'bool', name: 'Lock to Cursor', get: () => !!view.state.lockCursor, set: (v) => { view.state.lockCursor = v; }, undo: false, notify: ['view'] });
      l.prop({ kind: 'bool', name: 'Lock Camera to View', get: () => view.view.lockCameraToView, set: (v) => { view.view.lockCameraToView = v; }, undo: false, notify: ['view'], description: 'Enable view navigation within the camera view' });
      l.label('Clip:');
      const c = l.column(true);
      c.prop({ kind: 'float', name: 'Start', min: 0.0001, max: 100, step: 0.01, precision: 3, unit: 'LENGTH', get: () => view.view.clipStart, set: (v) => { view.view.clipStart = v; }, undo: false, notify: ['view'] });
      c.prop({ kind: 'float', name: 'End', min: 1, max: 100000, step: 10, precision: 1, unit: 'LENGTH', get: () => view.view.clipEnd, set: (v) => { view.view.clipEnd = v; }, undo: false, notify: ['view'] });
      l.label('Local Camera:');
      l.prop({ kind: 'enum', name: 'Local Camera', items: () => [{ id: '', label: '' }, ...app.objects().filter((o) => o.type === 'CAMERA').map((o) => ({ id: o.id, label: o.name, icon: 'OUTLINER_OB_CAMERA' }))], get: () => app.scene.camera ?? '', set: (v) => { app.scene.camera = v || null; }, notify: ['view'] }, { noLabel: true });
    },
  });
  P.push({
    id: 'cursor', label: '3D Cursor', draw: (l) => {
      const c = l.column(true);
      c.label('Location:');
      for (let i = 0; i < 3; i++) c.prop(fprop(() => app.scene, 'cursor', { name: ['X', 'Y', 'Z'][i], unit: 'LENGTH', precision: 5, step: 0.1, undo: false, notify: ['view'], default: 0 }, i));
    },
  });
  P.push({
    id: 'item', label: 'Item', poll: () => !!ob(), draw: (l) => {
      const o = ob()!;
      l.prop(sprop(ob, 'name', { name: '', undo: 'Rename', notify: ['all'] }), { icon: 'OBJECT_DATA', text: '' });
      void o;
      // Blender renames through the datablock so the name stays unique
      const last = l.el.lastElementChild as HTMLElement;
      void last;
    },
  });
  P.push({
    id: 'display', label: 'Display', draw: (l) => {
      const d = view.display;
      const dp = (key: keyof typeof d, name: string, description?: string) => l.prop(bprop(() => view.display, key as string, { name, description, undo: false, notify: ['view'] }));
      dp('showOnlyRender', 'Only Render', 'Display only objects which will be rendered');
      dp('showWorld', 'World Background', 'Display world colors in the background');
      dp('showOutlineSelected', 'Outline Selected', 'Show an outline highlight around selected objects in non-wireframe views');
      dp('showAllOrigins', 'All Object Origins', 'Show the object origin center dot for all (selected and unselected) objects');
      dp('showRelationshipLines', 'Relationship Lines', 'Show dashed lines indicating parent or constraint relationships');
      const r = l.row();
      r.prop(bprop(() => view.display, 'showFloor', { name: 'Grid Floor', undo: false, notify: ['view'] }));
      const ax = r.row(true);
      ax.prop(bprop(() => view.display, 'showAxisX', { name: 'X', undo: false, notify: ['view'] }), { toggle: true });
      ax.prop(bprop(() => view.display, 'showAxisY', { name: 'Y', undo: false, notify: ['view'] }), { toggle: true });
      ax.prop(bprop(() => view.display, 'showAxisZ', { name: 'Z', undo: false, notify: ['view'] }), { toggle: true });
      const c = l.column(true);
      c.prop({ kind: 'int', name: 'Lines', min: 0, max: 1024, get: () => d.gridLines, set: (v) => { view.display.gridLines = v; }, undo: false, notify: ['view'] });
      c.prop({ kind: 'float', name: 'Scale', min: 0.001, max: 1000, step: 0.1, precision: 3, get: () => d.gridScale, set: (v) => { view.display.gridScale = v; }, undo: false, notify: ['view'] });
      c.prop({ kind: 'int', name: 'Subdivisions', min: 1, max: 1024, get: () => d.gridSubdivisions, set: (v) => { view.display.gridSubdivisions = v; }, undo: false, notify: ['view'] });
      l.label('Shading:');
      dp('showTexturedSolid', 'Textured Solid', 'Display face-assigned textures in solid view');
      dp('backfaceCulling', 'Backface Culling', 'Use back face culling to hide the back side of faces');
      if (app.mode === 'EDIT') {
        l.label('Mesh Display:');
        dp('showFaceDots', 'Face Dots');
        const nr = l.row();
        nr.prop(bprop(() => view.display, 'showNormals', { name: 'Normals', undo: false, notify: ['view'], onChange: () => view.renderer.invalidateEdit() }));
        nr.prop({ kind: 'float', name: 'Size', min: 0.001, max: 10, step: 0.01, precision: 2, get: () => d.normalsSize, set: (v) => { view.display.normalsSize = v; view.renderer.invalidateEdit(); }, undo: false, notify: ['view'] });
      }
    },
  });
  P.push({ id: 'bgimages', label: 'Background Images', defaultClosed: true, draw: (l) => { na(l, 'Add Image'); } });
  P.push({
    id: 'orient', label: 'Transform Orientations', defaultClosed: true, draw: (l) => {
      l.prop({ kind: 'enum', name: 'Orientation', items: ORIENT_ITEMS, get: () => app.scene.toolSettings.transformOrientation, set: (v) => { app.scene.toolSettings.transformOrientation = v as never; }, notify: ['view'] }, { noLabel: true });
    },
  });
  return P;
}

// ------------------------------------------------------------------ redo panel

let redoProps: OpProps | null = null;
let redoFor: unknown = null;
let redoTimer = 0;

function redoProp(key: string, def: OpPropDef, index?: number): Prop {
  const get = () => {
    const v = redoProps?.[key];
    return index !== undefined ? (v as unknown[])[index] : v;
  };
  const set = (v: unknown) => {
    if (!redoProps) return;
    if (index !== undefined) (redoProps[key] as unknown[])[index] = v;
    else redoProps[key] = v;
    window.clearTimeout(redoTimer);
    const snapshot = JSON.parse(JSON.stringify(redoProps));
    redoTimer = window.setTimeout(() => void app.redoLast(snapshot), 0);
  };
  const unit = def.subtype === 'ANGLE' ? 'ROTATION' : def.subtype === 'DISTANCE' || def.subtype === 'TRANSLATION' ? 'LENGTH' : def.subtype === 'PERCENTAGE' ? 'PERCENTAGE' : 'NONE';
  switch (def.type) {
    case 'bool': case 'bools': return { kind: 'bool', name: def.name, get: get as () => boolean, set, undo: false };
    case 'int': return { kind: 'int', name: def.name, get: get as () => number, set, min: def.min, max: def.max, softMin: def.softMin, softMax: def.softMax, undo: false };
    case 'enum': return { kind: 'enum', name: def.name, items: (def.items ?? []).map(([id, label]) => ({ id, label })), get: get as () => string, set, undo: false };
    case 'string': return { kind: 'string', name: def.name, get: get as () => string, set, undo: false };
    default: return {
      kind: 'float', name: def.name, get: get as () => number, set, min: def.min, max: def.max, softMin: def.softMin, softMax: def.softMax,
      unit, precision: def.precision ?? (unit === 'ROTATION' ? 3 : def.subtype === 'FACTOR' ? 3 : 5), step: def.step ?? (unit === 'ROTATION' ? Math.PI / 180 : 0.1), undo: false,
    };
  }
}

export function drawOperatorProps(l: Layout, defs: Record<string, OpPropDef>): void {
  for (const [key, def] of Object.entries(defs)) {
    if (def.hidden) continue;
    if (def.type === 'vector') {
      const names = def.subtype === 'EULER' ? ['X', 'Y', 'Z'] : ['X', 'Y', 'Z'];
      const col = l.column(true);
      col.label(`${def.name}:`);
      for (let i = 0; i < (def.size ?? 3); i++) col.prop(redoProp(key, { ...def, type: 'float', subtype: def.subtype === 'EULER' ? 'ANGLE' : def.subtype === 'XYZ' ? 'NONE' : 'DISTANCE' }, i), { text: names[i] });
    } else if (def.type === 'bools') {
      l.label(`${def.name}:`);
      const r = l.row(true);
      for (let i = 0; i < (def.size ?? 3); i++) r.prop(redoProp(key, def, i), { toggle: true, text: ['X', 'Y', 'Z'][i] });
    } else if (def.type === 'enum') {
      l.prop(redoProp(key, def));
    } else {
      l.prop(redoProp(key, def));
    }
  }
}

export function redoPanels(_view: View3D): PanelDef[] {
  const last = app.lastOp;
  if (!last || !last.def.exec || !last.def.props || !Object.values(last.def.props).some((p) => !p.hidden)) { redoProps = null; redoFor = null; return []; }
  if (redoFor !== last) { redoFor = last; redoProps = JSON.parse(JSON.stringify(last.props)); }
  return [{
    id: `redo`, label: last.def.label, key: () => last.def.id + JSON.stringify(Object.keys(last.props)),
    draw: (l) => drawOperatorProps(l, last.def.props!),
  }];
}

/** Rename helper used by the Item panel (keeps names unique). */
export function renameObject(o: BObject, name: string): void { renameData(app.doc, 'objects', o.id, name); }
