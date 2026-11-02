// Object mode operators.

import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { app, type OperatorDef, type OpProps, type OpContext } from '../app';
import type { BObject, EmptyDrawType, LampType, MeshData, Vec3, ConstraintType, ModifierType } from '../core/types';
import {
  createObject, createMesh, createCamera, createLamp, createMaterial, newId, uniqueNameIn, setParentKeepTransform,
  basisMatrix, setBasisFromMatrix, sceneObjects, threeEulerOrder, dataCollectionFor,
} from '../core/scene';
import {
  primPlane, primCube, primCircle, primUVSphere, primIcoSphere, primCylinder, primCone, primTorus, primGrid,
  copyMeshData, meshBounds, polyArea, polyCenter, ensureArrays, rebuildEdges, addFace, addVert, selectAllMesh, flushSelection,
  type PrimitiveGeometry,
} from '../core/mesh';
import { newModifier, modifierDef, evaluateModifiers } from '../core/modifiers';
import { joinMeshInto } from '../core/meshops';
import { newParticleSystem } from '../core/particles';
import { confirmPopup } from '../ui/popup';
import { showMenu } from '../ui/menu';
import { h } from '../ui/dom';
import { buildLayout } from '../ui/layout';
import { promptString } from '../ui/popup';
import { popupLayer } from '../ui/menu';
import { activeLayer, hasSelected, isObjectMode, viewAlignedRotation, viewOf } from './common';
import { startTransform } from '../editors/view3d/transform';

const deg = Math.PI / 180;
const MODIFIER_ITEMS: [string, string][] = [
  ['ARRAY', 'Array'], ['BUILD', 'Build'], ['EDGE_SPLIT', 'Edge Split'], ['MIRROR', 'Mirror'], ['SCREW', 'Screw'], ['SOLIDIFY', 'Solidify'],
  ['SUBSURF', 'Subdivision Surface'], ['TRIANGULATE', 'Triangulate'], ['WIREFRAME', 'Wireframe'], ['CAST', 'Cast'], ['DISPLACE', 'Displace'],
  ['SIMPLE_DEFORM', 'Simple Deform'], ['SMOOTH', 'Smooth'], ['WAVE', 'Wave'],
];
const CONSTRAINT_ITEMS: [string, string][] = [
  ['COPY_LOCATION', 'Copy Location'], ['COPY_ROTATION', 'Copy Rotation'], ['COPY_SCALE', 'Copy Scale'], ['LIMIT_LOCATION', 'Limit Location'],
  ['LIMIT_ROTATION', 'Limit Rotation'], ['LIMIT_SCALE', 'Limit Scale'], ['TRACK_TO', 'Track To'], ['DAMPED_TRACK', 'Damped Track'], ['CHILD_OF', 'Child Of'],
];

// ------------------------------------------------------------------ add primitives

function addObjectCommon(ob: BObject, props: OpProps): void {
  const sc = app.scene;
  ob.location = (props.location as Vec3)?.slice() as Vec3 ?? sc.cursor.slice() as Vec3;
  ob.rotation = (props.rotation as Vec3)?.slice() as Vec3 ?? [0, 0, 0];
  ob.layers = new Array(20).fill(false);
  ob.layers[activeLayer()] = true;
  sc.objects.push(ob.id);
  app.deselectAll();
  ob.select = true;
  sc.activeObject = ob.id;
}

const commonAddProps = {
  view_align: { name: 'Align to View', type: 'bool' as const, default: false, description: 'Align the new object to the view' },
  enter_editmode: { name: 'Enter Editmode', type: 'bool' as const, default: false, hidden: true },
  location: { name: 'Location', type: 'vector' as const, default: [0, 0, 0], size: 3, subtype: 'TRANSLATION' as const },
  rotation: { name: 'Rotation', type: 'vector' as const, default: [0, 0, 0], size: 3, subtype: 'EULER' as const },
};

/** Fill location/rotation defaults at invoke time (cursor and view alignment). */
function invokeAdd(id: string) {
  return (ctx: OpContext, props: OpProps) => {
    const def = app.operator(id)!;
    const view = viewOf(ctx);
    props.location = app.scene.cursor.slice();
    props.view_align = props.view_align || app.prefs.alignNewObjects === 'VIEW';
    props.rotation = props.view_align ? viewAlignedRotation(view) : [0, 0, 0];
    props.enter_editmode = app.prefs.enterEditMode;
    return def.exec!(ctx, props);
  };
}

function addPrimitive(name: string, geom: PrimitiveGeometry, props: OpProps): 'FINISHED' {
  const doc = app.doc;
  if (app.mode === 'EDIT' && app.editMesh && app.editObj) {
    // Blender adds the primitive into the mesh being edited, at the cursor, selecting only it
    const md = app.editMesh;
    const ob = app.editObj;
    const inv = app.matrices.world(ob).clone().invert();
    const rot = props.rotation as Vec3 ?? [0, 0, 0];
    const m = new Matrix4().compose(new Vector3(...(props.location as Vec3)), new Quaternion().setFromEuler(new Euler(rot[0], rot[1], rot[2], threeEulerOrder('XYZ'))), new Vector3(1, 1, 1));
    const total = inv.multiply(m);
    selectAllMesh(md, false);
    const base = md.verts.length;
    for (const v of geom.verts) {
      const p = new Vector3(...v).applyMatrix4(total);
      addVert(md, [p.x, p.y, p.z], true);
    }
    for (const f of geom.faces) addFace(md, f.map((i) => i + base), { select: true });
    for (const e of geom.edges ?? []) md.edges.push([e[0] + base, e[1] + base]);
    rebuildEdges(md);
    ensureArrays(md);
    flushSelection(md, 'VERT');
    app.tagGeometry(md.id);
    return 'FINISHED';
  }
  const mesh = createMesh(doc, name, geom.verts, geom.faces, geom.edges ?? []);
  selectAllMesh(mesh, true); // Blender creates primitives fully selected
  const ob = createObject(doc, 'MESH', name, mesh.id);
  addObjectCommon(ob, props);
  if (props.enter_editmode) { app.mode = 'EDIT'; app.editObject = ob.id; selectAllMesh(mesh, true); }
  app.tagGeometry(mesh.id);
  return 'FINISHED';
}

const fillItems: [string, string][] = [['NOTHING', 'Nothing'], ['NGON', 'Ngon'], ['TRIFAN', 'Triangle Fan']];

function primOp(id: string, label: string, name: string, icon: string, props: OperatorDef['props'], build: (p: OpProps) => PrimitiveGeometry): OperatorDef {
  return {
    id, label, icon, undo: true, register: true, description: `Construct a ${name.toLowerCase()} mesh`,
    props: { ...props, ...commonAddProps },
    invoke: invokeAdd(id),
    exec: (_ctx, p) => addPrimitive(name, build(p), p),
  };
}

const n = (p: OpProps, k: string) => Number(p[k]);

export const ADD_OPERATORS: OperatorDef[] = [
  primOp('mesh.primitive_plane_add', 'Add Plane', 'Plane', 'MESH_PLANE', { radius: { name: 'Radius', type: 'float', default: 1, min: 0, subtype: 'DISTANCE' } }, (p) => primPlane(n(p, 'radius'))),
  primOp('mesh.primitive_cube_add', 'Add Cube', 'Cube', 'MESH_CUBE', { radius: { name: 'Radius', type: 'float', default: 1, min: 0, subtype: 'DISTANCE' } }, (p) => primCube(n(p, 'radius'))),
  primOp('mesh.primitive_circle_add', 'Add Circle', 'Circle', 'MESH_CIRCLE', {
    vertices: { name: 'Vertices', type: 'int', default: 32, min: 3, max: 10000 },
    radius: { name: 'Radius', type: 'float', default: 1, min: 0, subtype: 'DISTANCE' },
    fill_type: { name: 'Fill Type', type: 'enum', default: 'NOTHING', items: fillItems },
  }, (p) => primCircle(Math.max(3, n(p, 'vertices')), n(p, 'radius'), p.fill_type as 'NOTHING')),
  primOp('mesh.primitive_uv_sphere_add', 'Add UV Sphere', 'Sphere', 'MESH_UVSPHERE', {
    segments: { name: 'Segments', type: 'int', default: 32, min: 3, max: 500 },
    ring_count: { name: 'Rings', type: 'int', default: 16, min: 3, max: 500 },
    size: { name: 'Size', type: 'float', default: 1, min: 0, subtype: 'DISTANCE' },
  }, (p) => primUVSphere(Math.max(3, n(p, 'segments')), Math.max(3, n(p, 'ring_count')), n(p, 'size'))),
  primOp('mesh.primitive_ico_sphere_add', 'Add Ico Sphere', 'Icosphere', 'MESH_ICOSPHERE', {
    subdivisions: { name: 'Subdivisions', type: 'int', default: 2, min: 1, max: 8 },
    size: { name: 'Size', type: 'float', default: 1, min: 0, subtype: 'DISTANCE' },
  }, (p) => primIcoSphere(Math.min(8, Math.max(1, n(p, 'subdivisions'))), n(p, 'size'))),
  primOp('mesh.primitive_cylinder_add', 'Add Cylinder', 'Cylinder', 'MESH_CYLINDER', {
    vertices: { name: 'Vertices', type: 'int', default: 32, min: 3, max: 10000 },
    radius: { name: 'Radius', type: 'float', default: 1, min: 0, subtype: 'DISTANCE' },
    depth: { name: 'Depth', type: 'float', default: 2, min: 0, subtype: 'DISTANCE' },
    end_fill_type: { name: 'Cap Fill Type', type: 'enum', default: 'NGON', items: fillItems },
  }, (p) => primCylinder(Math.max(3, n(p, 'vertices')), n(p, 'radius'), n(p, 'depth'), p.end_fill_type as 'NGON')),
  primOp('mesh.primitive_cone_add', 'Add Cone', 'Cone', 'MESH_CONE', {
    vertices: { name: 'Vertices', type: 'int', default: 32, min: 3, max: 10000 },
    radius1: { name: 'Radius 1', type: 'float', default: 1, min: 0, subtype: 'DISTANCE' },
    radius2: { name: 'Radius 2', type: 'float', default: 0, min: 0, subtype: 'DISTANCE' },
    depth: { name: 'Depth', type: 'float', default: 2, min: 0, subtype: 'DISTANCE' },
    end_fill_type: { name: 'Base Fill Type', type: 'enum', default: 'NGON', items: fillItems },
  }, (p) => primCone(Math.max(3, n(p, 'vertices')), n(p, 'radius1'), n(p, 'radius2'), n(p, 'depth'), p.end_fill_type as 'NGON', p.end_fill_type as 'NGON')),
  primOp('mesh.primitive_torus_add', 'Add Torus', 'Torus', 'MESH_TORUS', {
    major_segments: { name: 'Major Segments', type: 'int', default: 48, min: 3, max: 256 },
    minor_segments: { name: 'Minor Segments', type: 'int', default: 12, min: 3, max: 256 },
    major_radius: { name: 'Major Radius', type: 'float', default: 1, min: 0.01, subtype: 'DISTANCE' },
    minor_radius: { name: 'Minor Radius', type: 'float', default: 0.25, min: 0.01, subtype: 'DISTANCE' },
  }, (p) => primTorus(Math.max(3, n(p, 'major_segments')), Math.max(3, n(p, 'minor_segments')), n(p, 'major_radius'), n(p, 'minor_radius'))),
  primOp('mesh.primitive_grid_add', 'Add Grid', 'Grid', 'MESH_GRID', {
    x_subdivisions: { name: 'X Subdivisions', type: 'int', default: 10, min: 2, max: 10000 },
    y_subdivisions: { name: 'Y Subdivisions', type: 'int', default: 10, min: 2, max: 10000 },
    radius: { name: 'Radius', type: 'float', default: 1, min: 0, subtype: 'DISTANCE' },
  }, (p) => primGrid(n(p, 'x_subdivisions'), n(p, 'y_subdivisions'), n(p, 'radius'))),
  {
    id: 'mesh.primitive_monkey_add', label: 'Add Monkey', icon: 'MESH_MONKEY', description: 'Construct a Suzanne mesh (not available in blender-web)',
    poll: () => false, exec: () => 'CANCELLED',
  },
  {
    id: 'object.camera_add', label: 'Add Camera', icon: 'OUTLINER_OB_CAMERA', undo: true, register: true, description: 'Add a camera object to the scene',
    poll: isObjectMode, props: { ...commonAddProps }, invoke: (ctx, p) => {
      const view = viewOf(ctx);
      p.location = app.scene.cursor.slice();
      p.rotation = viewAlignedRotation(view);
      p.view_align = true;
      return app.operator('object.camera_add')!.exec!(ctx, p);
    },
    exec: (_ctx, p) => {
      const cd = createCamera(app.doc, 'Camera');
      const ob = createObject(app.doc, 'CAMERA', 'Camera', cd.id);
      addObjectCommon(ob, p);
      if (!app.scene.camera) app.scene.camera = ob.id;
      return 'FINISHED';
    },
  },
  {
    id: 'object.lamp_add', label: 'Add Lamp', icon: 'OUTLINER_OB_LAMP', undo: true, register: true, description: 'Add a lamp object to the scene',
    poll: isObjectMode, props: { type: { name: 'Type', type: 'enum', default: 'POINT', items: [['POINT', 'Point'], ['SUN', 'Sun'], ['SPOT', 'Spot'], ['HEMI', 'Hemi'], ['AREA', 'Area']] }, ...commonAddProps },
    invoke: invokeAdd('object.lamp_add'),
    exec: (_ctx, p) => {
      const t = p.type as LampType;
      const la = createLamp(app.doc, t);
      const names: Record<LampType, string> = { POINT: 'Point', SUN: 'Sun', SPOT: 'Spot', HEMI: 'Hemi', AREA: 'Area' };
      const ob = createObject(app.doc, 'LAMP', names[t], la.id);
      addObjectCommon(ob, p);
      return 'FINISHED';
    },
  },
  {
    id: 'object.empty_add', label: 'Add Empty', icon: 'OUTLINER_OB_EMPTY', undo: true, register: true, description: 'Add an empty object to the scene',
    poll: isObjectMode,
    props: { type: { name: 'Type', type: 'enum', default: 'PLAIN_AXES', items: [['PLAIN_AXES', 'Plain Axes'], ['ARROWS', 'Arrows'], ['SINGLE_ARROW', 'Single Arrow'], ['CIRCLE', 'Circle'], ['CUBE', 'Cube'], ['SPHERE', 'Sphere'], ['CONE', 'Cone']] }, radius: { name: 'Radius', type: 'float', default: 1, min: 0.001, subtype: 'DISTANCE' }, ...commonAddProps },
    invoke: invokeAdd('object.empty_add'),
    exec: (_ctx, p) => {
      const ob = createObject(app.doc, 'EMPTY', 'Empty', null);
      ob.emptyDrawType = p.type as EmptyDrawType;
      ob.emptyDrawSize = n(p, 'radius');
      addObjectCommon(ob, p);
      return 'FINISHED';
    },
  },
];

// ------------------------------------------------------------------ helpers

function removeObjects(obs: BObject[]): void {
  const doc = app.doc;
  const ids = new Set(obs.map((o) => o.id));
  for (const sc of doc.scenes) {
    sc.objects = sc.objects.filter((id) => !ids.has(id));
    if (sc.activeObject && ids.has(sc.activeObject)) sc.activeObject = null;
    if (sc.camera && ids.has(sc.camera)) sc.camera = sc.objects.find((id) => doc.objects[id]?.type === 'CAMERA') ?? null;
  }
  // children keep their world transform
  for (const o of Object.values(doc.objects)) {
    if (o.parent && ids.has(o.parent)) setParentKeepTransform(doc, o, null, app.matrices);
    for (const c of o.constraints) if (c.target && ids.has(c.target)) c.target = null;
  }
  for (const id of ids) delete doc.objects[id];
  // orphan data blocks are removed lazily on save; drop meshes with no users right away to keep the file small
  for (const coll of ['meshes', 'cameras', 'lamps'] as const) {
    const used = new Set(Object.values(doc.objects).map((o) => o.data));
    for (const id of Object.keys(doc[coll])) if (!used.has(id) && !(doc[coll][id] as { fakeUser: boolean }).fakeUser) delete doc[coll][id];
  }
}

function duplicateObjects(linked: boolean): BObject[] {
  const doc = app.doc;
  const sc = app.scene;
  const sel = app.selectedObjects();
  const map = new Map<string, BObject>();
  for (const o of sel) {
    const c: BObject = JSON.parse(JSON.stringify(o));
    c.id = newId(doc, 'OB');
    c.name = uniqueNameIn(doc, 'objects', o.name);
    doc.objects[c.id] = c;
    if (!linked && o.data) {
      const coll = dataCollectionFor(o.type);
      if (coll === 'meshes') { const m = copyMeshData(doc.meshes[o.data], newId(doc, 'ME'), uniqueNameIn(doc, 'meshes', doc.meshes[o.data].name)); doc.meshes[m.id] = m; c.data = m.id; }
      else if (coll === 'cameras') { const d = { ...doc.cameras[o.data], id: newId(doc, 'CA') }; d.name = uniqueNameIn(doc, 'cameras', d.name); doc.cameras[d.id] = d; c.data = d.id; }
      else if (coll === 'lamps') { const d = { ...doc.lamps[o.data], id: newId(doc, 'LA'), color: [...doc.lamps[o.data].color] as Vec3 }; d.name = uniqueNameIn(doc, 'lamps', d.name); doc.lamps[d.id] = d; c.data = d.id; }
    }
    map.set(o.id, c);
    const i = sc.objects.indexOf(o.id);
    sc.objects.splice(i + 1, 0, c.id);
  }
  // re-link parents/constraint targets within the duplicated set
  for (const c of map.values()) {
    if (c.parent && map.has(c.parent)) c.parent = map.get(c.parent)!.id;
    for (const con of c.constraints) if (con.target && map.has(con.target)) con.target = map.get(con.target)!.id;
  }
  const act = app.activeObject;
  for (const o of sel) o.select = false;
  for (const c of map.values()) c.select = true;
  if (act && map.has(act.id)) sc.activeObject = map.get(act.id)!.id;
  app.tagAllGeometry();
  return [...map.values()];
}

function selectedMeshes(): BObject[] { return app.selectedObjects().filter((o) => o.type === 'MESH' && o.data && app.doc.meshes[o.data]); }

/** Users of a mesh among all objects. */
function meshUsers(id: string): BObject[] { return Object.values(app.doc.objects).filter((o) => o.data === id); }

/** Bake part of the basis transform into the mesh data and fix children. */
function applyTransform(ob: BObject, loc: boolean, rot: boolean, scl: boolean): string | null {
  const md = app.meshOf(ob);
  if (!md) return 'Can only apply transforms to mesh objects';
  if (meshUsers(md.id).length > 1) return `Cannot apply to a multi user: Object "${ob.name}", Mesh "${md.name}", aborting`;
  const oldBasis = basisMatrix(ob);
  const oldWorld = app.matrices.world(ob).clone();
  if (loc) ob.location = [0, 0, 0];
  if (rot) ob.rotation = [0, 0, 0];
  if (scl) ob.scale = [1, 1, 1];
  const newBasis = basisMatrix(ob);
  const conv = newBasis.clone().invert().multiply(oldBasis);
  for (const v of md.verts) {
    const p = new Vector3(...v).applyMatrix4(conv);
    v[0] = p.x; v[1] = p.y; v[2] = p.z;
  }
  // a negative determinant flips the winding
  if (conv.determinant() < 0) for (const f of md.faces) f.reverse();
  app.matrices.clear();
  const newWorld = app.matrices.world(ob).clone();
  for (const child of Object.values(app.doc.objects)) {
    if (child.parent !== ob.id) continue;
    const pinv = new Matrix4().fromArray(child.parentInverse);
    child.parentInverse = newWorld.clone().invert().multiply(oldWorld).multiply(pinv).toArray();
  }
  app.tagGeometry(md.id);
  return null;
}

function setOrigin(ob: BObject, type: string): void {
  const md = app.meshOf(ob);
  if (!md || !md.verts.length) return;
  let c: Vector3;
  if (type === 'ORIGIN_CURSOR') c = new Vector3(...app.scene.cursor).applyMatrix4(app.matrices.world(ob).clone().invert());
  else if (type === 'ORIGIN_CENTER_OF_MASS') {
    c = new Vector3();
    let total = 0;
    for (const f of md.faces) { const a = polyArea(md.verts, f); const pc = polyCenter(md.verts, f); c.add(new Vector3(...pc).multiplyScalar(a)); total += a; }
    if (total > 1e-12) c.multiplyScalar(1 / total);
    else { c.set(0, 0, 0); for (const v of md.verts) c.add(new Vector3(...v)); c.multiplyScalar(1 / md.verts.length); }
  } else {
    // median of vertices (Blender's default "Median Center")
    c = new Vector3();
    for (const v of md.verts) c.add(new Vector3(...v));
    c.multiplyScalar(1 / md.verts.length);
  }
  if (meshUsers(md.id).length > 1 && type !== 'GEOMETRY_ORIGIN') {
    app.report('WARNING', 'Cannot apply to a multi user mesh, doing nothing');
    return;
  }
  for (const v of md.verts) { v[0] -= c.x; v[1] -= c.y; v[2] -= c.z; }
  if (type !== 'GEOMETRY_ORIGIN') {
    // move the object so the geometry stays in place: new basis = basis * T(c)
    const basis = basisMatrix(ob).multiply(new Matrix4().makeTranslation(c.x, c.y, c.z));
    const p = new Vector3().setFromMatrixPosition(basis);
    ob.location = [p.x - ob.deltaLocation[0], p.y - ob.deltaLocation[1], p.z - ob.deltaLocation[2]];
    // children must not move
    for (const child of Object.values(app.doc.objects)) {
      if (child.parent !== ob.id) continue;
      const pinv = new Matrix4().fromArray(child.parentInverse);
      child.parentInverse = new Matrix4().makeTranslation(-c.x, -c.y, -c.z).multiply(pinv).toArray();
    }
  }
  app.tagGeometry(md.id);
}

function moveToLayerPopup(ctx: OpContext): void {
  const sel = app.selectedObjects();
  if (!sel.length) return;
  const el = h('div', { class: 'popup-panel' });
  let layers = sel[0].layers.slice();
  buildLayout(el, ctx.area ?? null, (l) => {
    l.label('Move to Layer');
    l.layers(() => layers, (next) => {
      layers = next;
      for (const o of app.selectedObjects()) o.layers = layers.slice();
      app.pushUndo('Move to Layer');
      app.report('OPERATOR', `bpy.ops.object.move_to_layer(layers=(${layers.map((b) => (b ? 'True' : 'False')).join(', ')}))`);
      app.notify('scene');
    }, { big: true, used: () => { const u = new Array(20).fill(false); for (const o of app.objects()) o.layers.forEach((x, i) => { if (x) u[i] = true; }); return u; } });
  });
  popupLayer().append(el);
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.max(2, Math.min(app.mouse.x - r.width / 2, window.innerWidth - r.width - 2))}px`;
  el.style.top = `${Math.max(2, Math.min(app.mouse.y - r.height / 2, window.innerHeight - r.height - 2))}px`;
  const close = (e: Event) => {
    if (e.type === 'pointerdown' && el.contains(e.target as Node)) return;
    if (e.type === 'pointermove') {
      const b = el.getBoundingClientRect();
      const pe = e as PointerEvent;
      if (pe.clientX > b.left - 60 && pe.clientX < b.right + 60 && pe.clientY > b.top - 60 && pe.clientY < b.bottom + 60) return;
    }
    if (e.type === 'keydown' && (e as KeyboardEvent).key !== 'Escape' && (e as KeyboardEvent).key !== 'Enter') return;
    el.remove();
    window.removeEventListener('pointerdown', close, true);
    window.removeEventListener('pointermove', close, true);
    window.removeEventListener('keydown', close, true);
  };
  window.addEventListener('pointerdown', close, true);
  window.addEventListener('pointermove', close, true);
  window.addEventListener('keydown', close, true);
}

// ------------------------------------------------------------------ operators

const selectAction = { name: 'Action', type: 'enum' as const, default: 'TOGGLE', items: [['TOGGLE', 'Toggle'], ['SELECT', 'Select'], ['DESELECT', 'Deselect'], ['INVERT', 'Invert']] as [string, string][] };

export const OBJECT_OPERATORS: OperatorDef[] = [
  ...ADD_OPERATORS,
  {
    id: 'object.select_all', label: '(De)select All', description: 'Change selection of all visible objects in scene', undo: true, register: true, poll: isObjectMode,
    props: { action: selectAction },
    exec: (_c, p) => {
      const obs = app.selectableObjects();
      let a = p.action as string;
      if (a === 'TOGGLE') a = obs.some((o) => o.select) ? 'DESELECT' : 'SELECT';
      for (const o of obs) o.select = a === 'SELECT' ? true : a === 'DESELECT' ? false : !o.select;
      return 'FINISHED';
    },
  },
  {
    id: 'object.select_random', label: 'Select Random', description: 'Set select on random visible objects', undo: true, register: true, poll: isObjectMode,
    props: { percent: { name: 'Percent', type: 'float', default: 50, min: 0, max: 100, subtype: 'PERCENTAGE' }, seed: { name: 'Random Seed', type: 'int', default: 0, min: 0 }, action: { name: 'Action', type: 'enum', default: 'SELECT', items: [['SELECT', 'Select'], ['DESELECT', 'Deselect']] } },
    exec: (_c, p) => {
      let s = (Number(p.seed) * 9301 + 49297) % 233280 || 1;
      const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
      for (const o of app.selectableObjects()) if (rnd() * 100 < Number(p.percent)) o.select = p.action === 'SELECT';
      return 'FINISHED';
    },
  },
  {
    id: 'object.select_by_type', label: 'Select All by Type', undo: true, register: true, poll: isObjectMode,
    props: { extend: { name: 'Extend', type: 'bool', default: false }, type: { name: 'Type', type: 'enum', default: 'MESH', items: [['MESH', 'Mesh'], ['CAMERA', 'Camera'], ['LAMP', 'Lamp'], ['EMPTY', 'Empty']] } },
    exec: (_c, p) => { if (!p.extend) app.deselectAll(); for (const o of app.selectableObjects()) if (o.type === p.type) o.select = true; return 'FINISHED'; },
  },
  {
    id: 'object.select_by_layer', label: 'Select by Layer', undo: true, register: true, poll: isObjectMode,
    props: { extend: { name: 'Extend', type: 'bool', default: false }, layers: { name: 'Layer', type: 'int', default: 1, min: 1, max: 20 } },
    exec: (_c, p) => { if (!p.extend) app.deselectAll(); const li = Number(p.layers) - 1; for (const o of app.objects()) if (o.layers[li] && !o.hide && !o.hideSelect) o.select = true; return 'FINISHED'; },
  },
  {
    id: 'object.select_camera', label: 'Select Camera', description: 'Select the active camera', undo: true, register: true, poll: isObjectMode,
    exec: () => {
      const id = app.scene.camera;
      const cam = id ? app.doc.objects[id] : null;
      if (!cam) return 'CANCELLED';
      app.deselectAll();
      cam.select = true;
      app.scene.activeObject = cam.id;
      return 'FINISHED';
    },
  },
  {
    id: 'object.select_grouped', label: 'Select Grouped', description: 'Select all visible objects grouped by various properties', undo: true, register: true, poll: () => isObjectMode() && !!app.activeObject,
    props: { extend: { name: 'Extend', type: 'bool', default: false }, type: { name: 'Type', type: 'enum', default: 'CHILDREN_RECURSIVE', items: [['CHILDREN_RECURSIVE', 'Children'], ['CHILDREN', 'Immediate Children'], ['PARENT', 'Parent'], ['SIBLINGS', 'Siblings'], ['TYPE', 'Type'], ['LAYER', 'Layer'], ['LAMP_TYPE', 'Lamp Type']] } },
    exec: (_c, p) => {
      const act = app.activeObject!;
      if (!p.extend) { app.deselectAll(); act.select = true; }
      const all = app.selectableObjects();
      const isDesc = (o: BObject) => { let q = o.parent ? app.doc.objects[o.parent] : null; while (q) { if (q.id === act.id) return true; q = q.parent ? app.doc.objects[q.parent] : null; } return false; };
      for (const o of all) {
        let hit = false;
        switch (p.type) {
          case 'CHILDREN_RECURSIVE': hit = isDesc(o); break;
          case 'CHILDREN': hit = o.parent === act.id; break;
          case 'PARENT': hit = act.parent === o.id; break;
          case 'SIBLINGS': hit = !!act.parent && o.parent === act.parent; break;
          case 'TYPE': hit = o.type === act.type; break;
          case 'LAYER': hit = o.layers.some((l, i) => l && act.layers[i]); break;
          case 'LAMP_TYPE': hit = o.type === 'LAMP' && act.type === 'LAMP' && app.doc.lamps[o.data!]?.lampType === app.doc.lamps[act.data!]?.lampType; break;
        }
        if (hit) o.select = true;
      }
      return 'FINISHED';
    },
  },
  {
    id: 'object.select_linked', label: 'Select Linked', description: 'Select all visible objects that are linked', undo: true, register: true, poll: () => isObjectMode() && !!app.activeObject,
    props: { extend: { name: 'Extend', type: 'bool', default: false }, type: { name: 'Type', type: 'enum', default: 'OBDATA', items: [['OBDATA', 'Object Data'], ['MATERIAL', 'Material']] } },
    exec: (_c, p) => {
      const act = app.activeObject!;
      if (!p.extend) app.deselectAll();
      const mats = new Set(app.meshOf(act)?.materials.filter(Boolean));
      for (const o of app.selectableObjects()) {
        if (p.type === 'OBDATA' ? o.data && o.data === act.data : app.meshOf(o)?.materials.some((m) => m && mats.has(m))) o.select = true;
      }
      return 'FINISHED';
    },
  },
  {
    id: 'object.select_pattern', label: 'Select Pattern', description: 'Select objects matching a naming pattern', undo: true, register: true, poll: isObjectMode,
    props: { pattern: { name: 'Pattern', type: 'string', default: '*' }, case_sensitive: { name: 'Case Sensitive', type: 'bool', default: false }, extend: { name: 'Extend', type: 'bool', default: true } },
    invoke: async (ctx, p) => {
      const s = await promptString('Select Pattern', 'Pattern:', String(p.pattern));
      if (s === null) return 'CANCELLED';
      p.pattern = s;
      return app.operator('object.select_pattern')!.exec!(ctx, p);
    },
    exec: (_c, p) => {
      const pat = String(p.pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
      const re = new RegExp(`^${pat}$`, p.case_sensitive ? '' : 'i');
      if (!p.extend) app.deselectAll();
      for (const o of app.selectableObjects()) if (re.test(o.name)) o.select = true;
      return 'FINISHED';
    },
  },
  {
    id: 'object.delete', label: 'Delete', description: 'Delete selected objects', undo: true, register: true, poll: () => isObjectMode() && hasSelected(),
    props: { use_global: { name: 'Delete Globally', type: 'bool', default: false } },
    invoke: (ctx, p) => {
      confirmPopup('OK?', 'Delete', () => {
        const before = app.undoHistory().findIndex((x) => x.current);
        app.operator('object.delete')!.exec!(ctx, p);
        app.finishOperator(app.operator('object.delete')!, p, ctx, before);
      });
      return 'CANCELLED';
    },
    exec: () => {
      const sel = app.selectedObjects();
      removeObjects(sel);
      app.report('INFO', `Deleted ${sel.length} object(s)`);
      return 'FINISHED';
    },
  },
  {
    id: 'object.duplicate_move', label: 'Duplicate Objects', description: 'Duplicate selected objects and move them', undo: false, poll: () => isObjectMode() && hasSelected(),
    exec: (ctx) => {
      duplicateObjects(false);
      app.report('OPERATOR', 'bpy.ops.object.duplicate_move(OBJECT_OT_duplicate={"linked":False, "mode":\'TRANSLATION\'})');
      const view = viewOf(ctx);
      if (view) { const r = view.canvasRect(); startTransform({ mode: 'TRANSLATION', view, mouse: { x: app.mouse.x - r.left, y: app.mouse.y - r.top } }); }
      return 'FINISHED';
    },
  },
  {
    id: 'object.duplicate_move_linked', label: 'Duplicate Linked', description: 'Duplicate selected objects (sharing data) and move them', undo: false, poll: () => isObjectMode() && hasSelected(),
    exec: (ctx) => {
      duplicateObjects(true);
      app.report('OPERATOR', 'bpy.ops.object.duplicate_move_linked(OBJECT_OT_duplicate={"linked":True, "mode":\'TRANSLATION\'})');
      const view = viewOf(ctx);
      if (view) { const r = view.canvasRect(); startTransform({ mode: 'TRANSLATION', view, mouse: { x: app.mouse.x - r.left, y: app.mouse.y - r.top } }); }
      return 'FINISHED';
    },
  },
  {
    id: 'object.join', label: 'Join', description: 'Join selected objects into active object', undo: true, register: true,
    poll: () => isObjectMode() && app.activeObject?.type === 'MESH' && app.selectedObjects().filter((o) => o.type === 'MESH').length > 1,
    exec: () => {
      const act = app.activeObject!;
      const target = app.meshOf(act)!;
      if (meshUsers(target.id).length > 1) { const c = copyMeshData(target, newId(app.doc, 'ME'), uniqueNameIn(app.doc, 'meshes', target.name)); app.doc.meshes[c.id] = c; act.data = c.id; }
      const tgt = app.meshOf(act)!;
      const inv = app.matrices.world(act).clone().invert();
      const others = selectedMeshes().filter((o) => o !== act);
      for (const o of others) {
        const src = app.meshOf(o)!;
        const m = inv.clone().multiply(app.matrices.world(o));
        const remap = src.materials.map((mid) => {
          let i = tgt.materials.indexOf(mid);
          if (i < 0) { tgt.materials.push(mid); i = tgt.materials.length - 1; }
          return i;
        });
        if (!remap.length) remap.push(0);
        joinMeshInto(tgt, src, m.toArray(), remap);
      }
      removeObjects(others);
      act.select = true;
      app.scene.activeObject = act.id;
      app.tagGeometry(tgt.id);
      return 'FINISHED';
    },
  },
  {
    id: 'object.parent_set', label: 'Make Parent', description: 'Set the object\'s parenting', undo: true, register: true,
    poll: () => isObjectMode() && !!app.activeObject && app.selectedObjects().length > 1,
    props: { type: { name: 'Type', type: 'enum', default: 'OBJECT', items: [['OBJECT', 'Object']] }, keep_transform: { name: 'Keep Transform', type: 'bool', default: false } },
    invoke: (ctx, p) => {
      showMenu([
        { label: 'Object', action: () => void app.callOperator('object.parent_set', { type: 'OBJECT', keep_transform: false }, { area: ctx.area, exec: true }) },
        { label: 'Object (Keep Transform)', action: () => void app.callOperator('object.parent_set', { type: 'OBJECT', keep_transform: true }, { area: ctx.area, exec: true }) },
        { label: 'Object (Without Inverse)', action: () => void app.callOperator('object.parent_no_inverse_set', {}, { area: ctx.area, exec: true }) },
      ], app.mouse, { title: 'Set Parent To', atMouse: true });
      void p;
      return 'CANCELLED';
    },
    exec: () => {
      const par = app.activeObject!;
      for (const o of app.selectedObjects()) {
        if (o === par) continue;
        setParentKeepTransform(app.doc, o, par, app.matrices);
        app.matrices.clear();
      }
      return 'FINISHED';
    },
  },
  {
    id: 'object.parent_no_inverse_set', label: 'Make Parent without Inverse', undo: true, register: true,
    poll: () => isObjectMode() && !!app.activeObject && app.selectedObjects().length > 1,
    exec: () => {
      const par = app.activeObject!;
      for (const o of app.selectedObjects()) {
        if (o === par) continue;
        o.parent = par.id;
        o.parentInverse = new Matrix4().toArray();
        o.location = [0, 0, 0];
      }
      return 'FINISHED';
    },
  },
  {
    id: 'object.parent_clear', label: 'Clear Parent', description: 'Clear the object\'s parenting', undo: true, register: true, poll: () => isObjectMode() && hasSelected(),
    props: { type: { name: 'Type', type: 'enum', default: 'CLEAR', items: [['CLEAR', 'Clear Parent'], ['CLEAR_KEEP_TRANSFORM', 'Clear and Keep Transformation'], ['CLEAR_INVERSE', 'Clear Parent Inverse']] } },
    invoke: (ctx) => {
      showMenu([
        { label: 'Clear Parent', action: () => void app.callOperator('object.parent_clear', { type: 'CLEAR' }, { area: ctx.area, exec: true }) },
        { label: 'Clear and Keep Transformation', action: () => void app.callOperator('object.parent_clear', { type: 'CLEAR_KEEP_TRANSFORM' }, { area: ctx.area, exec: true }) },
        { label: 'Clear Parent Inverse', action: () => void app.callOperator('object.parent_clear', { type: 'CLEAR_INVERSE' }, { area: ctx.area, exec: true }) },
      ], app.mouse, { title: 'Clear Parent', atMouse: true });
      return 'CANCELLED';
    },
    exec: (_c, p) => {
      for (const o of app.selectedObjects()) {
        if (!o.parent) continue;
        if (p.type === 'CLEAR_KEEP_TRANSFORM') setParentKeepTransform(app.doc, o, null, app.matrices);
        else if (p.type === 'CLEAR_INVERSE') o.parentInverse = new Matrix4().toArray();
        else { o.parent = null; o.parentInverse = new Matrix4().toArray(); }
        app.matrices.clear();
      }
      return 'FINISHED';
    },
  },
  ...(['location', 'rotation', 'scale'] as const).map((what): OperatorDef => ({
    id: `object.${what}_clear`, label: `Clear ${what[0].toUpperCase()}${what.slice(1)}`, description: `Clear the object's ${what}`, undo: true, register: true,
    poll: () => isObjectMode() && hasSelected(),
    exec: () => {
      for (const o of app.selectedObjects()) {
        for (let i = 0; i < 3; i++) {
          if (what === 'location' && !o.lockLocation[i]) o.location[i] = 0;
          if (what === 'rotation' && !o.lockRotation[i]) o.rotation[i] = 0;
          if (what === 'scale' && !o.lockScale[i]) o.scale[i] = 1;
        }
      }
      return 'FINISHED';
    },
  })),
  {
    id: 'object.origin_clear', label: 'Clear Origin', description: 'Clear the object\'s origin (parent offset)', undo: true, register: true, poll: () => isObjectMode() && hasSelected(),
    exec: () => {
      for (const o of app.selectedObjects()) {
        if (!o.parent) continue;
        const m = new Matrix4().fromArray(o.parentInverse);
        m.setPosition(0, 0, 0);
        o.parentInverse = m.toArray();
      }
      return 'FINISHED';
    },
  },
  {
    id: 'object.transform_apply', label: 'Apply Object Transform', description: 'Apply the object\'s transformation to its data', undo: true, register: true,
    poll: () => isObjectMode() && hasSelected(),
    props: { location: { name: 'Location', type: 'bool', default: false }, rotation: { name: 'Rotation', type: 'bool', default: true }, scale: { name: 'Scale', type: 'bool', default: true } },
    exec: (_c, p) => {
      let err: string | null = null;
      for (const o of app.selectedObjects()) {
        const e = applyTransform(o, !!p.location, !!p.rotation, !!p.scale);
        if (e) err = e;
      }
      if (err) app.report('WARNING', err);
      return 'FINISHED';
    },
  },
  {
    id: 'object.transforms_to_deltas', label: 'Apply Object Transform to Deltas', description: 'Convert normal object transforms to delta transforms', undo: true, register: true,
    poll: () => isObjectMode() && hasSelected(),
    props: { mode: { name: 'Mode', type: 'enum', default: 'ALL', items: [['ALL', 'All Transforms'], ['LOC', 'Location'], ['ROT', 'Rotation'], ['SCALE', 'Scale']] } },
    exec: (_c, p) => {
      for (const o of app.selectedObjects()) {
        if (p.mode === 'ALL' || p.mode === 'LOC') { o.deltaLocation = o.deltaLocation.map((d, i) => d + o.location[i]) as Vec3; o.location = [0, 0, 0]; }
        if (p.mode === 'ALL' || p.mode === 'ROT') { o.deltaRotation = o.deltaRotation.map((d, i) => d + o.rotation[i]) as Vec3; o.rotation = [0, 0, 0]; }
        if (p.mode === 'ALL' || p.mode === 'SCALE') { o.deltaScale = o.deltaScale.map((d, i) => d * o.scale[i]) as Vec3; o.scale = [1, 1, 1]; }
      }
      return 'FINISHED';
    },
  },
  {
    id: 'object.visual_transform_apply', label: 'Apply Visual Transform', description: 'Apply the object\'s visual transformation to its data (constraints)', undo: true, register: true,
    poll: () => isObjectMode() && hasSelected(),
    exec: () => {
      for (const o of app.selectedObjects()) {
        const world = app.matrices.world(o).clone();
        const parentMat = o.parent && app.doc.objects[o.parent] ? app.matrices.world(app.doc.objects[o.parent]).clone().multiply(new Matrix4().fromArray(o.parentInverse)) : new Matrix4();
        setBasisFromMatrix(o, parentMat.invert().multiply(world));
      }
      return 'FINISHED';
    },
  },
  {
    id: 'object.origin_set', label: 'Set Origin', description: 'Set the object\'s origin, by either moving the data, or set to center of data, or use 3D cursor', undo: true, register: true,
    poll: () => isObjectMode() && hasSelected(),
    props: { type: { name: 'Type', type: 'enum', default: 'GEOMETRY_ORIGIN', items: [['GEOMETRY_ORIGIN', 'Geometry to Origin'], ['ORIGIN_GEOMETRY', 'Origin to Geometry'], ['ORIGIN_CURSOR', 'Origin to 3D Cursor'], ['ORIGIN_CENTER_OF_MASS', 'Origin to Center of Mass']] } },
    exec: (_c, p) => {
      const done = new Set<string>();
      for (const o of selectedMeshes()) {
        if (done.has(o.data!)) continue;
        done.add(o.data!);
        setOrigin(o, String(p.type));
        app.matrices.clear();
      }
      return 'FINISHED';
    },
  },
  ...([['shade_smooth', 'Shade Smooth', true], ['shade_flat', 'Shade Flat', false]] as const).map(([id, label, smooth]): OperatorDef => ({
    id: `object.${id}`, label, description: `Display faces ${smooth ? 'smooth (using vertex normals)' : 'flat'}`, undo: true, register: true,
    poll: () => isObjectMode() && selectedMeshes().length > 0,
    exec: () => { for (const o of selectedMeshes()) { const md = app.meshOf(o)!; md.faceSmooth = md.faces.map(() => smooth); app.tagGeometry(md.id); } return 'FINISHED'; },
  })),
  {
    id: 'object.hide_view_set', label: 'Hide Selected', description: 'Hide the objects', undo: true, register: true, poll: isObjectMode,
    props: { unselected: { name: 'Unselected', type: 'bool', default: false } },
    exec: (_c, p) => {
      for (const o of app.visibleObjects()) {
        if (p.unselected ? !o.select : o.select) { o.hide = true; o.select = false; }
      }
      if (app.activeObject?.hide) app.activeObject = null;
      return 'FINISHED';
    },
  },
  {
    id: 'object.hide_view_clear', label: 'Clear Restrict View', description: 'Reveal temporarily hidden objects', undo: true, register: true, poll: isObjectMode,
    exec: () => { for (const o of app.objects()) if (o.hide && o.layers.some((l, i) => l && app.scene.layers[i])) { o.hide = false; o.select = true; } return 'FINISHED'; },
  },
  {
    id: 'object.hide_render_set', label: 'Hide Render', undo: true, register: true, poll: () => isObjectMode() && hasSelected(),
    props: { unselected: { name: 'Unselected', type: 'bool', default: false } },
    exec: (_c, p) => { for (const o of app.visibleObjects()) if (p.unselected ? !o.select : o.select) o.hideRender = true; return 'FINISHED'; },
  },
  {
    id: 'object.move_to_layer', label: 'Move to Layer', description: 'Move the object to different layers', undo: true, register: true, poll: () => isObjectMode() && hasSelected(),
    props: { layers: { name: 'Layer', type: 'bools', default: new Array(20).fill(false), size: 20 } },
    invoke: (ctx) => { moveToLayerPopup(ctx); return 'CANCELLED'; },
    exec: (_c, p) => { const l = p.layers as boolean[]; if (!l.some(Boolean)) return 'CANCELLED'; for (const o of app.selectedObjects()) o.layers = l.slice(); return 'FINISHED'; },
  },
  {
    id: 'object.make_links_data', label: 'Link Data', description: 'Apply active object links to other selected objects', undo: true, register: true,
    poll: () => isObjectMode() && !!app.activeObject && app.selectedObjects().length > 1,
    props: { type: { name: 'Type', type: 'enum', default: 'OBDATA', items: [['OBDATA', 'Object Data'], ['MATERIAL', 'Materials'], ['MODIFIERS', 'Modifiers']] } },
    invoke: (ctx) => {
      showMenu([
        { label: 'Object Data', action: () => void app.callOperator('object.make_links_data', { type: 'OBDATA' }, { area: ctx.area, exec: true }) },
        { label: 'Materials', action: () => void app.callOperator('object.make_links_data', { type: 'MATERIAL' }, { area: ctx.area, exec: true }) },
        { label: 'Modifiers', action: () => void app.callOperator('object.make_links_data', { type: 'MODIFIERS' }, { area: ctx.area, exec: true }) },
      ], app.mouse, { title: 'Make Links', atMouse: true });
      return 'CANCELLED';
    },
    exec: (_c, p) => {
      const act = app.activeObject!;
      for (const o of app.selectedObjects()) {
        if (o === act) continue;
        if (p.type === 'OBDATA' && o.type === act.type) o.data = act.data;
        if (p.type === 'MATERIAL') { const a = app.meshOf(act), b = app.meshOf(o); if (a && b) b.materials = a.materials.slice(); }
        if (p.type === 'MODIFIERS' && o.type === 'MESH') o.modifiers = JSON.parse(JSON.stringify(act.modifiers));
      }
      app.tagAllGeometry();
      return 'FINISHED';
    },
  },
  {
    id: 'object.make_single_user', label: 'Make Single User', description: 'Make linked data local to each object', undo: true, register: true, poll: () => isObjectMode() && hasSelected(),
    props: { type: { name: 'Type', type: 'enum', default: 'SELECTED_OBJECTS', items: [['SELECTED_OBJECTS', 'Selected Objects'], ['ALL', 'All']] }, obdata: { name: 'Object Data', type: 'bool', default: false }, material: { name: 'Materials', type: 'bool', default: false } },
    exec: (_c, p) => {
      const doc = app.doc;
      const seen = new Set<string>();
      for (const o of app.selectedObjects()) {
        const md = app.meshOf(o);
        if (p.obdata && md) {
          if (seen.has(md.id) && meshUsers(md.id).length > 1) {
            const c = copyMeshData(md, newId(doc, 'ME'), uniqueNameIn(doc, 'meshes', md.name));
            doc.meshes[c.id] = c;
            o.data = c.id;
          }
          seen.add(md.id);
        }
        const m2 = app.meshOf(o);
        if (p.material && m2) {
          m2.materials = m2.materials.map((mid) => {
            if (!mid) return mid;
            const src = doc.materials[mid];
            const c = { ...JSON.parse(JSON.stringify(src)), id: newId(doc, 'MA') };
            c.name = uniqueNameIn(doc, 'materials', src.name);
            doc.materials[c.id] = c;
            return c.id;
          });
        }
      }
      app.tagAllGeometry();
      return 'FINISHED';
    },
  },
  {
    id: 'object.mode_set', label: 'Set Object Mode', description: 'Sets the object interaction mode', undo: true, register: true,
    poll: () => !!app.activeObject,
    props: { mode: { name: 'Mode', type: 'enum', default: 'OBJECT', items: [['OBJECT', 'Object Mode'], ['EDIT', 'Edit Mode'], ['SCULPT', 'Sculpt Mode']] }, toggle: { name: 'Toggle', type: 'bool', default: false } },
    exec: (_c, p) => {
      const act = app.activeObject!;
      let mode = p.mode as 'OBJECT' | 'EDIT' | 'SCULPT';
      if (p.toggle && app.mode === mode) mode = 'OBJECT';
      if (mode === 'SCULPT') {
        if (act.type !== 'MESH' || act.hide) { app.report('WARNING', 'Sculpt mode needs a visible mesh object'); return 'CANCELLED'; }
        app.mode = 'SCULPT';
        app.editObject = act.id;
        act.select = true;
        app.tagAllGeometry();
        return 'FINISHED';
      }
      if (mode === 'EDIT') {
        if (act.type !== 'MESH') { app.report('WARNING', `Unable to execute 'Toggle Editmode', error changing modes`); return 'CANCELLED'; }
        if (act.hide) return 'CANCELLED';
        app.mode = 'EDIT';
        app.editObject = act.id;
        act.select = true;
        const md = app.meshOf(act)!;
        ensureArrays(md);
      } else {
        app.mode = 'OBJECT';
        app.editObject = null;
      }
      app.tagAllGeometry();
      return 'FINISHED';
    },
  },
  {
    id: 'object.editmode_toggle', label: 'Toggle Editmode', description: 'Toggle object\'s editmode', undo: true, register: true,
    poll: () => !!app.activeObject && (app.activeObject.type === 'MESH' || app.mode === 'EDIT'),
    // like Blender, Tab from sculpt mode goes to edit mode; from edit mode back to object mode
    exec: (ctx) => app.operator('object.mode_set')!.exec!(ctx, { mode: app.mode === 'EDIT' ? 'OBJECT' : 'EDIT', toggle: false }) as 'FINISHED',
  },
  {
    id: 'object.subdivision_set', label: 'Subdivision Set', description: 'Sets a Subdivision Surface Level (1-5)', undo: true, register: true,
    poll: () => selectedMeshes().length > 0 || app.mode === 'EDIT',
    props: { level: { name: 'Level', type: 'int', default: 1, min: 0, max: 6 }, relative: { name: 'Relative', type: 'bool', default: false } },
    exec: (_c, p) => {
      const obs = app.mode === 'EDIT' && app.editObj ? [app.editObj] : selectedMeshes();
      for (const o of obs) {
        let m = o.modifiers.find((x) => x.type === 'SUBSURF');
        if (!m) { m = newModifier('SUBSURF', o.modifiers); o.modifiers.push(m); }
        const lvl = p.relative ? Math.max(0, Number(m.levels) + Number(p.level)) : Number(p.level);
        m.levels = lvl;
        if (Number(m.renderLevels) < lvl) m.renderLevels = lvl;
      }
      app.tagAllGeometry();
      return 'FINISHED';
    },
  },
  {
    id: 'object.convert', label: 'Convert to', description: 'Convert selected objects to another type (applies modifiers for meshes)', undo: true, register: true,
    poll: () => isObjectMode() && selectedMeshes().length > 0,
    props: { target: { name: 'Target', type: 'enum', default: 'MESH', items: [['MESH', 'Mesh']] }, keep_original: { name: 'Keep Original', type: 'bool', default: false } },
    exec: () => {
      for (const o of selectedMeshes()) {
        const md = app.meshOf(o)!;
        const ev = evaluateModifiers(md, o.modifiers, { frame: app.scene.frameCurrent, render: false, editMode: false });
        md.verts = ev.verts; md.faces = ev.faces; md.edges = ev.looseEdges.slice(); md.faceSmooth = ev.faceSmooth; md.faceMat = ev.faceMat;
        md.vsel = []; md.esel = []; md.fsel = []; md.activeFace = -1;
        rebuildEdges(md); ensureArrays(md);
        o.modifiers = [];
        app.tagGeometry(md.id);
      }
      return 'FINISHED';
    },
  },
  {
    id: 'object.randomize_transform', label: 'Randomize Transform', description: 'Randomize objects loc/rot/scale', undo: true, register: true, poll: () => isObjectMode() && hasSelected(),
    props: {
      random_seed: { name: 'Random Seed', type: 'int', default: 0, min: 0, max: 10000 },
      use_loc: { name: 'Randomize Location', type: 'bool', default: true },
      loc: { name: 'Location', type: 'vector', default: [0, 0, 0], size: 3, subtype: 'TRANSLATION' },
      use_rot: { name: 'Randomize Rotation', type: 'bool', default: true },
      rot: { name: 'Rotation', type: 'vector', default: [0, 0, 0], size: 3, subtype: 'EULER' },
      use_scale: { name: 'Randomize Scale', type: 'bool', default: true },
      scale: { name: 'Scale', type: 'vector', default: [1, 1, 1], size: 3, subtype: 'XYZ' },
    },
    exec: (_c, p) => {
      let s = Number(p.random_seed) * 7919 + 1;
      const rnd = () => { s = (s * 16807) % 2147483647; return (s / 2147483647) * 2 - 1; };
      for (const o of app.selectedObjects()) {
        for (let i = 0; i < 3; i++) {
          if (p.use_loc) o.location[i] += rnd() * (p.loc as number[])[i];
          if (p.use_rot) o.rotation[i] += rnd() * (p.rot as number[])[i];
          if (p.use_scale) o.scale[i] *= 1 + rnd() * ((p.scale as number[])[i] - 1);
        }
      }
      return 'FINISHED';
    },
  },
  {
    id: 'object.track_set', label: 'Make Track', description: 'Make the object track another object, using various methods/constraints', undo: true, register: true,
    poll: () => isObjectMode() && !!app.activeObject && app.selectedObjects().length > 1,
    props: { type: { name: 'Type', type: 'enum', default: 'DAMPTRACK', items: [['DAMPTRACK', 'Damped Track Constraint'], ['TRACKTO', 'Track To Constraint']] } },
    invoke: (ctx) => {
      showMenu([
        { label: 'Damped Track Constraint', action: () => void app.callOperator('object.track_set', { type: 'DAMPTRACK' }, { area: ctx.area, exec: true }) },
        { label: 'Track To Constraint', action: () => void app.callOperator('object.track_set', { type: 'TRACKTO' }, { area: ctx.area, exec: true }) },
      ], app.mouse, { title: 'Make Track', atMouse: true });
      return 'CANCELLED';
    },
    exec: (_c, p) => {
      const act = app.activeObject!;
      for (const o of app.selectedObjects()) {
        if (o === act) continue;
        o.constraints.push(newConstraint(p.type === 'TRACKTO' ? 'TRACK_TO' : 'DAMPED_TRACK', o, act.id));
      }
      return 'FINISHED';
    },
  },
  {
    id: 'object.track_clear', label: 'Clear Track', description: 'Clear tracking constraint or flag from object', undo: true, register: true, poll: () => isObjectMode() && hasSelected(),
    props: { type: { name: 'Type', type: 'enum', default: 'CLEAR', items: [['CLEAR', 'Clear Track']] } },
    exec: () => { for (const o of app.selectedObjects()) o.constraints = o.constraints.filter((c) => c.type !== 'TRACK_TO' && c.type !== 'DAMPED_TRACK'); return 'FINISHED'; },
  },
  // ---- modifiers
  {
    id: 'object.modifier_add', label: 'Add Modifier', description: 'Add a procedural operation/effect to the active object', undo: true, register: true,
    poll: () => app.activeObject?.type === 'MESH',
    props: { type: { name: 'Type', type: 'enum', default: 'SUBSURF', items: MODIFIER_ITEMS } },
    exec: (_c, p) => {
      const o = app.activeObject!;
      const def = modifierDef(String(p.type));
      if (!def || !def.supported) { app.report('ERROR', `Modifier "${p.type}" is not available in blender-web`); return 'CANCELLED'; }
      o.modifiers.push(newModifier(def.type as ModifierType, o.modifiers));
      app.tagAllGeometry();
      return 'FINISHED';
    },
  },
  {
    id: 'object.modifier_remove', label: 'Remove Modifier', description: 'Remove a modifier from the active object', undo: true, register: true, poll: () => !!app.activeObject,
    props: { modifier: { name: 'Modifier', type: 'string', default: '' } },
    exec: (_c, p) => { const o = app.activeObject!; o.modifiers = o.modifiers.filter((m) => m.name !== p.modifier); app.tagAllGeometry(); return 'FINISHED'; },
  },
  ...([['modifier_move_up', -1, 'Move Up'], ['modifier_move_down', 1, 'Move Down']] as const).map(([id, dir, label]): OperatorDef => ({
    id: `object.${id}`, label: `${label} Modifier`, description: `${label} modifier in the stack`, undo: true, register: true, poll: () => !!app.activeObject,
    props: { modifier: { name: 'Modifier', type: 'string', default: '' } },
    exec: (_c, p) => {
      const o = app.activeObject!;
      const i = o.modifiers.findIndex((m) => m.name === p.modifier);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= o.modifiers.length) return 'CANCELLED';
      [o.modifiers[i], o.modifiers[j]] = [o.modifiers[j], o.modifiers[i]];
      app.tagAllGeometry();
      return 'FINISHED';
    },
  })),
  {
    id: 'object.modifier_copy', label: 'Copy Modifier', description: 'Duplicate modifier at the same position in the stack', undo: true, register: true, poll: () => !!app.activeObject,
    props: { modifier: { name: 'Modifier', type: 'string', default: '' } },
    exec: (_c, p) => {
      const o = app.activeObject!;
      const i = o.modifiers.findIndex((m) => m.name === p.modifier);
      if (i < 0) return 'CANCELLED';
      const c = JSON.parse(JSON.stringify(o.modifiers[i]));
      const names = new Set(o.modifiers.map((m) => m.name));
      let k = 1; let nm = `${c.name}.001`;
      while (names.has(nm)) nm = `${c.name}.${String(++k).padStart(3, '0')}`;
      c.name = nm;
      o.modifiers.splice(i + 1, 0, c);
      app.tagAllGeometry();
      return 'FINISHED';
    },
  },
  {
    id: 'object.modifier_apply', label: 'Apply Modifier', description: 'Apply modifier and remove from the stack', undo: true, register: true, poll: () => isObjectMode() && app.activeObject?.type === 'MESH',
    props: { modifier: { name: 'Modifier', type: 'string', default: '' }, apply_as: { name: 'Apply as', type: 'enum', default: 'DATA', items: [['DATA', 'Object Data'], ['SHAPE', 'New Shape']] } },
    exec: (_c, p) => {
      const o = app.activeObject!;
      const md = app.meshOf(o)!;
      const i = o.modifiers.findIndex((m) => m.name === p.modifier);
      if (i < 0) return 'CANCELLED';
      if (i !== 0) app.report('INFO', 'Applied modifier was not first, result may not be as expected');
      if (meshUsers(md.id).length > 1) { app.report('ERROR', 'Modifiers cannot be applied to multi-user data'); return 'CANCELLED'; }
      const mod = o.modifiers[i];
      const ev = evaluateModifiers(md, [{ ...mod, showViewport: true }], { frame: app.scene.frameCurrent, render: false, editMode: false });
      md.verts = ev.verts; md.faces = ev.faces; md.edges = ev.looseEdges.slice(); md.faceSmooth = ev.faceSmooth; md.faceMat = ev.faceMat;
      md.vsel = []; md.esel = []; md.fsel = []; md.activeFace = -1;
      rebuildEdges(md); ensureArrays(md);
      o.modifiers.splice(i, 1);
      app.tagGeometry(md.id);
      return 'FINISHED';
    },
  },
  // ---- particles
  {
    id: 'object.particle_system_add', label: 'Add Particle System Slot', description: 'Add a particle system', undo: true, register: true,
    poll: () => app.activeObject?.type === 'MESH',
    exec: () => {
      const o = app.activeObject!;
      o.particleSystems ??= [];
      o.particleSystems.push(newParticleSystem(o.particleSystems));
      o.activeParticleSystem = o.particleSystems.length - 1;
      return 'FINISHED';
    },
  },
  {
    id: 'object.particle_system_remove', label: 'Remove Particle System Slot', description: 'Remove the selected particle system', undo: true, register: true,
    poll: () => !!app.activeObject?.particleSystems?.length,
    exec: () => {
      const o = app.activeObject!;
      const i = Math.min(o.activeParticleSystem ?? 0, o.particleSystems.length - 1);
      o.particleSystems.splice(i, 1);
      o.activeParticleSystem = Math.max(0, i - 1);
      return 'FINISHED';
    },
  },
  // ---- constraints
  {
    id: 'object.constraint_add', label: 'Add Constraint', description: 'Add a constraint to the active object', undo: true, register: true, poll: () => !!app.activeObject,
    props: { type: { name: 'Type', type: 'enum', default: 'COPY_LOCATION', items: CONSTRAINT_ITEMS } },
    exec: (_c, p) => { const o = app.activeObject!; o.constraints.push(newConstraint(p.type as ConstraintType, o, null)); return 'FINISHED'; },
  },
  {
    id: 'object.constraint_add_with_targets', label: 'Add Constraint (with Targets)', description: 'Add a constraint to the active object, with target set to the other selected object', undo: true, register: true,
    poll: () => !!app.activeObject,
    invoke: (ctx) => {
      const types: [ConstraintType, string][] = [['COPY_LOCATION', 'Copy Location'], ['COPY_ROTATION', 'Copy Rotation'], ['COPY_SCALE', 'Copy Scale'], ['TRACK_TO', 'Track To'], ['DAMPED_TRACK', 'Damped Track'], ['CHILD_OF', 'Child Of']];
      showMenu(types.map(([t, l]) => ({ label: l, action: () => {
        const o = app.activeObject!;
        const target = app.selectedObjects().find((x) => x !== o) ?? null;
        o.constraints.push(newConstraint(t, o, target?.id ?? null));
        app.finishOperator(app.operator('object.constraint_add_with_targets')!, { type: t }, ctx);
      } })), app.mouse, { title: 'Add Constraint (with Targets)', atMouse: true });
      return 'CANCELLED';
    },
    exec: () => 'CANCELLED',
  },
  {
    id: 'object.constraints_clear', label: 'Clear Object Constraints', description: 'Clear all the constraints for the selected objects', undo: true, register: true, poll: hasSelected,
    exec: () => { for (const o of app.selectedObjects()) o.constraints = []; return 'FINISHED'; },
  },
  {
    id: 'object.constraints_copy', label: 'Copy Constraints to Selected Objects', undo: true, register: true, poll: () => !!app.activeObject && app.selectedObjects().length > 1,
    exec: () => { const a = app.activeObject!; for (const o of app.selectedObjects()) if (o !== a) o.constraints = JSON.parse(JSON.stringify(a.constraints)); return 'FINISHED'; },
  },
  {
    id: 'constraint.delete', label: 'Delete Constraint', description: 'Remove constraint from constraint stack', undo: true, register: true, poll: () => !!app.activeObject,
    props: { constraint: { name: 'Constraint', type: 'string', default: '' } },
    exec: (_c, p) => { const o = app.activeObject!; o.constraints = o.constraints.filter((c) => c.name !== p.constraint); return 'FINISHED'; },
  },
  ...([['move_up', -1, 'Move Up'], ['move_down', 1, 'Move Down']] as const).map(([id, dir, label]): OperatorDef => ({
    id: `constraint.${id}`, label: `${label} Constraint`, undo: true, register: true, poll: () => !!app.activeObject,
    props: { constraint: { name: 'Constraint', type: 'string', default: '' } },
    exec: (_c, p) => {
      const o = app.activeObject!;
      const i = o.constraints.findIndex((m) => m.name === p.constraint);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= o.constraints.length) return 'CANCELLED';
      [o.constraints[i], o.constraints[j]] = [o.constraints[j], o.constraints[i]];
      return 'FINISHED';
    },
  })),
  // ---- materials
  {
    id: 'object.material_slot_add', label: 'Add Material Slot', description: 'Add a new material slot', undo: true, register: true, poll: () => app.activeObject?.type === 'MESH',
    exec: () => { const md = app.meshOf(app.activeObject)!; md.materials.push(null); app.activeObject!.activeMaterialIndex = md.materials.length - 1; return 'FINISHED'; },
  },
  {
    id: 'object.material_slot_remove', label: 'Remove Material Slot', description: 'Remove the selected material slot', undo: true, register: true,
    poll: () => !!app.meshOf(app.activeObject)?.materials.length,
    exec: () => {
      const o = app.activeObject!;
      const md = app.meshOf(o)!;
      const i = Math.min(o.activeMaterialIndex, md.materials.length - 1);
      md.materials.splice(i, 1);
      md.faceMat = md.faceMat.map((m) => (m > i ? m - 1 : m === i ? Math.max(0, i - 1) : m));
      o.activeMaterialIndex = Math.max(0, i - 1);
      app.tagGeometry(md.id);
      return 'FINISHED';
    },
  },
  {
    id: 'object.material_slot_assign', label: 'Assign Material Slot', description: 'Assign active material slot to selection', undo: true, register: true,
    poll: () => app.mode === 'EDIT' && !!app.editMesh,
    exec: () => { const o = app.editObj!; const md = app.editMesh!; md.faces.forEach((_, i) => { if (md.fsel[i]) md.faceMat[i] = o.activeMaterialIndex; }); app.tagGeometry(md.id); return 'FINISHED'; },
  },
  ...([['material_slot_select', true, 'Select'], ['material_slot_deselect', false, 'Deselect']] as const).map(([id, sel, label]): OperatorDef => ({
    id: `object.${id}`, label: `${label} Material Slot`, description: `${label} by active material slot`, undo: true, register: true,
    poll: () => app.mode === 'EDIT' && !!app.editMesh,
    exec: () => {
      const o = app.editObj!; const md = app.editMesh!;
      md.faces.forEach((_, i) => { if (md.faceMat[i] === o.activeMaterialIndex) md.fsel[i] = sel; });
      flushSelection(md, 'FACE');
      return 'FINISHED';
    },
  })),
  {
    id: 'material.new', label: 'New Material', description: 'Add a new material', undo: true, register: true, poll: () => app.activeObject?.type === 'MESH',
    exec: () => {
      const o = app.activeObject!;
      const md = app.meshOf(o)!;
      const cur = md.materials[o.activeMaterialIndex];
      const m = createMaterial(app.doc, cur ? app.doc.materials[cur]?.name ?? 'Material' : 'Material');
      if (cur && app.doc.materials[cur]) Object.assign(m, JSON.parse(JSON.stringify({ ...app.doc.materials[cur], id: m.id, name: m.name })));
      if (!md.materials.length) { md.materials.push(m.id); o.activeMaterialIndex = 0; }
      else md.materials[o.activeMaterialIndex] = m.id;
      app.tagGeometry(md.id);
      return 'FINISHED';
    },
  },
];

export function newConstraint(type: ConstraintType, ob: BObject, target: string | null) {
  const labels: Record<ConstraintType, string> = {
    COPY_LOCATION: 'Copy Location', COPY_ROTATION: 'Copy Rotation', COPY_SCALE: 'Copy Scale', LIMIT_LOCATION: 'Limit Location',
    LIMIT_ROTATION: 'Limit Rotation', LIMIT_SCALE: 'Limit Scale', TRACK_TO: 'Track To', DAMPED_TRACK: 'Damped Track', CHILD_OF: 'Child Of',
  };
  const names = new Set(ob.constraints.map((c) => c.name));
  let name = labels[type];
  for (let i = 1; names.has(name); i++) name = `${labels[type]}.${String(i).padStart(3, '0')}`;
  const base = { type, name, mute: false, showExpanded: true, influence: 1, target };
  switch (type) {
    case 'COPY_LOCATION': case 'COPY_ROTATION': case 'COPY_SCALE':
      return { ...base, useX: true, useY: true, useZ: true, invertX: false, invertY: false, invertZ: false, useOffset: false };
    case 'LIMIT_LOCATION': case 'LIMIT_SCALE':
      return { ...base, useMinX: false, useMinY: false, useMinZ: false, useMaxX: false, useMaxY: false, useMaxZ: false, minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
    case 'LIMIT_ROTATION':
      return { ...base, useLimitX: false, useLimitY: false, useLimitZ: false, minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
    case 'TRACK_TO':
      return { ...base, trackAxis: 'TRACK_NEGATIVE_Z', upAxis: 'UP_Y' };
    case 'DAMPED_TRACK':
      return { ...base, trackAxis: 'TRACK_Y' };
    case 'CHILD_OF': {
      const inv = target && app.doc.objects[target] ? app.matrices.world(app.doc.objects[target]).clone().invert().toArray() : new Matrix4().toArray();
      return { ...base, inverse: inv };
    }
  }
}

export function useObjectData(): void { void sceneObjects; void meshBounds; void deg; void ({} as MeshData); }
