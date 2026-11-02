// Physics operators: rigid body (rigidbody.*), force fields, point cache baking
// (ptcache.*) and Quick Effects. Ids, labels and descriptions follow Blender 2.79.

import { Matrix4 } from 'three';
import { app, type OperatorDef, type OpProps } from '../app';
import { insertKeyframe } from '../core/anim';
import { createMaterial, createObject, MatrixCache, setBasisFromMatrix } from '../core/scene';
import { showMenu } from '../ui/menu';
import type { BObject, Vec3 } from '../core/types';
import { newParticleSystem } from '../core/particles';
import { allDrivers, bakeDrivers, cancelBake, freeBake, isBaking, objectDrivers, withFullEvaluation, type SimDriver } from './cache';
import { MASS_MATERIALS, rbOf, rigidBodyDriver, rigidBodyMatrixAt, shapeVolume } from './rigidbody';
import {
  defaultField, defaultRigidBody, defaultRigidBodyConstraint, defaultRigidBodyWorld,
  type FieldType, type RigidBodyConstraintType, type RigidBodyShape,
} from './types';

const isObjectMode = () => app.mode === 'OBJECT';
const meshLike = (o: BObject | null | undefined) => !!o && (o.type === 'MESH' || o.type === 'FONT');

const SHAPES: [string, string][] = [
  ['BOX', 'Box'], ['SPHERE', 'Sphere'], ['CAPSULE', 'Capsule'], ['CYLINDER', 'Cylinder'], ['CONE', 'Cone'], ['CONVEX_HULL', 'Convex Hull'], ['MESH', 'Mesh'],
];
export const CONSTRAINT_TYPES: [string, string][] = [
  ['FIXED', 'Fixed'], ['POINT', 'Point'], ['HINGE', 'Hinge'], ['SLIDER', 'Slider'], ['PISTON', 'Piston'], ['GENERIC', 'Generic'], ['GENERIC_SPRING', 'Generic Spring'], ['MOTOR', 'Motor'],
];
export const FIELD_TYPES: [FieldType, string, string][] = [
  ['FORCE', 'Force', 'FORCE_FORCE'], ['WIND', 'Wind', 'FORCE_WIND'], ['VORTEX', 'Vortex', 'FORCE_VORTEX'], ['MAGNET', 'Magnetic', 'FORCE_MAGNETIC'],
  ['HARMONIC', 'Harmonic', 'FORCE_HARMONIC'], ['CHARGE', 'Charge', 'FORCE_CHARGE'], ['LENNARDJ', 'Lennard-Jones', 'FORCE_LENNARDJONES'],
  ['TEXTURE', 'Texture', 'FORCE_TEXTURE'], ['GUIDE', 'Curve Guide', 'FORCE_CURVE'], ['BOID', 'Boid', 'FORCE_BOID'],
  ['TURBULENCE', 'Turbulence', 'FORCE_TURBULENCE'], ['DRAG', 'Drag', 'FORCE_DRAG'], ['SMOKE_FLOW', 'Smoke Flow', 'FORCE_SMOKEFLOW'],
];
/** Field types simulated in blender-web. */
export const SUPPORTED_FIELDS = new Set<FieldType>(['FORCE', 'WIND', 'VORTEX', 'MAGNET', 'HARMONIC', 'CHARGE', 'TURBULENCE', 'DRAG']);

function ensureWorld(): void {
  const sc = app.scene;
  if (!sc.rigidBodyWorld) sc.rigidBodyWorld = defaultRigidBodyWorld();
}

function addRigidBody(ob: BObject, type: 'ACTIVE' | 'PASSIVE'): void {
  ensureWorld();
  ob.rigidBody = defaultRigidBody(type);
}

/** Drivers addressed by a ptcache operator: an explicit cache key, else the active object's caches. */
function targetDrivers(key: string): SimDriver<unknown>[] {
  const all = allDrivers();
  if (key) return all.filter((d) => d.key === key);
  const ob = app.activeObject;
  return ob ? objectDrivers(ob) : [];
}

const n = (p: OpProps, k: string) => Number(p[k]);

export const SIM_OPERATORS: OperatorDef[] = [
  // ---------------------------------------------------------------- rigid body world
  {
    id: 'rigidbody.world_add', label: 'Add Rigid Body World', description: 'Add Rigid Body simulation world to the current scene', undo: true, register: true,
    poll: () => !app.scene.rigidBodyWorld,
    exec: () => { ensureWorld(); return 'FINISHED'; },
  },
  {
    id: 'rigidbody.world_remove', label: 'Remove Rigid Body World', description: 'Remove Rigid Body simulation world from the current scene', undo: true, register: true,
    poll: () => !!app.scene.rigidBodyWorld,
    exec: () => { const d = rigidBodyDriver(); if (d) freeBake([d as unknown as SimDriver<unknown>]); app.scene.rigidBodyWorld = null; return 'FINISHED'; },
  },
  // ---------------------------------------------------------------- rigid bodies
  {
    id: 'rigidbody.object_add', label: 'Add Rigid Body', description: 'Add active object as Rigid Body', undo: true, register: true,
    props: { type: { name: 'Rigid Body Type', type: 'enum', default: 'ACTIVE', items: [['ACTIVE', 'Active'], ['PASSIVE', 'Passive']] } },
    poll: () => isObjectMode() && meshLike(app.activeObject) && !app.activeObject!.rigidBody,
    exec: (_c, p) => { addRigidBody(app.activeObject!, p.type as 'ACTIVE'); return 'FINISHED'; },
  },
  {
    id: 'rigidbody.object_remove', label: 'Remove Rigid Body', description: 'Remove Rigid Body settings from Object', undo: true, register: true,
    poll: () => isObjectMode() && !!app.activeObject?.rigidBody,
    exec: () => { app.activeObject!.rigidBody = null; return 'FINISHED'; },
  },
  {
    id: 'rigidbody.objects_add', label: 'Add Rigid Bodies', description: 'Add selected objects as Rigid Bodies', undo: true, register: true,
    props: { type: { name: 'Rigid Body Type', type: 'enum', default: 'ACTIVE', items: [['ACTIVE', 'Active'], ['PASSIVE', 'Passive']] } },
    poll: () => isObjectMode() && app.selectedObjects().some(meshLike),
    exec: (_c, p) => {
      for (const o of app.selectedObjects()) if (meshLike(o)) addRigidBody(o, p.type as 'ACTIVE');
      return 'FINISHED';
    },
  },
  {
    id: 'rigidbody.objects_remove', label: 'Remove Rigid Bodies', description: 'Remove selected objects from Rigid Body simulation', undo: true, register: true,
    poll: () => isObjectMode() && app.selectedObjects().some((o) => !!o.rigidBody),
    exec: () => { for (const o of app.selectedObjects()) o.rigidBody = null; return 'FINISHED'; },
  },
  {
    id: 'rigidbody.shape_change', label: 'Change Collision Shape', description: 'Change collision shapes for selected Rigid Body Objects', undo: true, register: true,
    props: { type: { name: 'Rigid Body Shape', type: 'enum', default: 'MESH', items: SHAPES } },
    poll: () => isObjectMode() && app.selectedObjects().some((o) => !!o.rigidBody),
    invoke: (ctx, p) => {
      showEnumMenu('Change Collision Shape', SHAPES, (v) => void app.callOperator('rigidbody.shape_change', { type: v }, { exec: true, area: ctx.area }));
      void p;
      return 'CANCELLED';
    },
    exec: (_c, p) => {
      for (const o of app.selectedObjects()) if (o.rigidBody) o.rigidBody.collisionShape = p.type as RigidBodyShape;
      return 'FINISHED';
    },
  },
  {
    id: 'rigidbody.mass_calculate', label: 'Calculate Mass', description: 'Automatically calculate mass values for Rigid Body Objects based on volume', undo: true, register: true,
    props: {
      material: { name: 'Material Preset', type: 'enum', default: 'Air', items: [...MASS_MATERIALS.map(([m, d]): [string, string] => [m, `${m} (${d} kg/m³)`]), ['Custom', 'Custom']] },
      density: { name: 'Density', type: 'float', default: 1, min: 0.001, description: 'Custom density value (kg/m^3) to use instead of material preset' },
    },
    poll: () => isObjectMode() && app.selectedObjects().some((o) => !!o.rigidBody),
    invoke: (ctx) => {
      showEnumMenu('Calculate Mass', [...MASS_MATERIALS.map(([m, d]): [string, string] => [m, `${m} (${d} kg/m³)`])],
        (v) => void app.callOperator('rigidbody.mass_calculate', { material: v }, { exec: true, area: ctx.area }));
      return 'CANCELLED';
    },
    exec: (_c, p) => {
      const preset = MASS_MATERIALS.find(([m]) => m === p.material);
      const density = preset ? preset[1] : n(p, 'density');
      for (const o of app.selectedObjects()) {
        const rb = rbOf(o);
        if (!rb || !o.rigidBody) continue;
        o.rigidBody.mass = Math.max(0.001, density * shapeVolume(o, rb));
      }
      return 'FINISHED';
    },
  },
  {
    id: 'rigidbody.object_settings_copy', label: 'Copy Rigid Body Settings', description: 'Copy Rigid Body settings from active object to selected', undo: true, register: true,
    poll: () => isObjectMode() && !!app.activeObject?.rigidBody && app.selectedObjects().length > 1,
    exec: () => {
      const src = app.activeObject!.rigidBody!;
      for (const o of app.selectedObjects()) if (o !== app.activeObject && meshLike(o)) { ensureWorld(); o.rigidBody = JSON.parse(JSON.stringify(src)); }
      return 'FINISHED';
    },
  },
  {
    id: 'rigidbody.bake_to_keyframes', label: 'Bake To Keyframes', description: 'Bake rigid body transformations of selected objects to keyframes', undo: true, register: true,
    props: {
      frame_start: { name: 'Start Frame', type: 'int', default: 1, min: 0 },
      frame_end: { name: 'End Frame', type: 'int', default: 250, min: 1 },
      step: { name: 'Frame Step', type: 'int', default: 1, min: 1, max: 120 },
    },
    poll: () => isObjectMode() && !!app.scene.rigidBodyWorld && app.selectedObjects().some((o) => o.rigidBody?.type === 'ACTIVE'),
    invoke: (ctx, p) => {
      const w = app.scene.rigidBodyWorld!;
      p.frame_start = w.pointCache.frameStart;
      p.frame_end = w.pointCache.frameEnd;
      return app.operator('rigidbody.bake_to_keyframes')!.exec!(ctx, p);
    },
    exec: (_c, p) => {
      const obs = app.selectedObjects().filter((o) => o.rigidBody?.type === 'ACTIVE');
      const start = Math.round(n(p, 'frame_start')), end = Math.round(n(p, 'frame_end')), step = Math.max(1, Math.round(n(p, 'step')));
      const keys = new Map<string, { f: number; m: Matrix4 }[]>();
      withFullEvaluation(() => {
        for (let f = start; f <= end; f += step) {
          for (const o of obs) {
            const m = f <= (app.scene.rigidBodyWorld?.pointCache.frameStart ?? 1) ? null : rigidBodyMatrixAt(o, f);
            const list = keys.get(o.id) ?? [];
            list.push({ f, m: m ?? rawWorld(o) });
            keys.set(o.id, list);
          }
        }
      });
      for (const o of obs) {
        const parentMat = o.parent && app.doc.objects[o.parent] ? rawWorld(app.doc.objects[o.parent]).multiply(new Matrix4().fromArray(o.parentInverse)) : new Matrix4();
        const pinv = parentMat.clone().invert();
        const tmp = JSON.parse(JSON.stringify(o)) as BObject;
        for (const { f, m } of keys.get(o.id) ?? []) {
          setBasisFromMatrix(tmp, pinv.clone().multiply(m));
          for (let i = 0; i < 3; i++) {
            insertKeyframe(o, 'location', i, f, tmp.location[i], 'LINEAR');
            insertKeyframe(o, 'rotation_euler', i, f, tmp.rotation[i], 'LINEAR');
          }
        }
        o.rigidBody = null;
      }
      app.evaluateAnimation();
      app.report('INFO', `Baked ${obs.length} rigid bod${obs.length === 1 ? 'y' : 'ies'} to keyframes`);
      return 'FINISHED';
    },
  },
  {
    id: 'rigidbody.connect', label: 'Connect Rigid Bodies', description: 'Create rigid body constraints between selected rigid bodies', undo: true, register: true,
    props: {
      con_type: { name: 'Type', type: 'enum', default: 'FIXED', items: CONSTRAINT_TYPES.filter(([t]) => !['PISTON', 'GENERIC', 'MOTOR'].includes(t)) },
      pivot_type: { name: 'Location', type: 'enum', default: 'CENTER', items: [['CENTER', 'Center'], ['ACTIVE', 'Active'], ['SELECTED', 'Selected']] },
      connection_pattern: { name: 'Connection Pattern', type: 'enum', default: 'SELECTED_TO_ACTIVE', items: [['SELECTED_TO_ACTIVE', 'Selected to Active'], ['CHAIN_DISTANCE', 'Chain by Distance']] },
    },
    poll: () => isObjectMode() && app.selectedObjects().filter((o) => !!o.rigidBody).length > 1,
    exec: (_c, p) => {
      const sel = app.selectedObjects().filter((o) => !!o.rigidBody);
      const act = app.activeObject && sel.includes(app.activeObject) ? app.activeObject : sel[0];
      const pairs: [BObject, BObject][] = [];
      if (p.connection_pattern === 'CHAIN_DISTANCE') {
        const rest = sel.filter((o) => o !== act);
        let cur = act;
        while (rest.length) {
          const cp = app.matrices.location(cur);
          rest.sort((a, b) => app.matrices.location(a).distanceTo(cp) - app.matrices.location(b).distanceTo(cp));
          const nx = rest.shift()!;
          pairs.push([cur, nx]);
          cur = nx;
        }
      } else for (const o of sel) if (o !== act) pairs.push([act, o]);
      const created: BObject[] = [];
      for (const [a, b] of pairs) {
        const pa = app.matrices.location(a), pb = app.matrices.location(b);
        const pos = p.pivot_type === 'ACTIVE' ? pa : p.pivot_type === 'SELECTED' ? pb : pa.clone().add(pb).multiplyScalar(0.5);
        const e = createObject(app.doc, 'EMPTY', 'Constraint', null);
        e.location = [pos.x, pos.y, pos.z];
        e.layers = a.layers.slice();
        e.rigidBodyConstraint = { ...defaultRigidBodyConstraint(p.con_type as RigidBodyConstraintType), object1: a.id, object2: b.id };
        app.scene.objects.push(e.id);
        created.push(e);
      }
      ensureWorld();
      app.report('INFO', `Created ${created.length} constraint${created.length === 1 ? '' : 's'}`);
      return 'FINISHED';
    },
  },
  {
    id: 'rigidbody.constraint_add', label: 'Add Rigid Body Constraint', description: 'Add Rigid Body Constraint to active object', undo: true, register: true,
    props: { type: { name: 'Rigid Body Constraint Type', type: 'enum', default: 'FIXED', items: CONSTRAINT_TYPES } },
    poll: () => isObjectMode() && !!app.activeObject && !app.activeObject.rigidBodyConstraint,
    exec: (_c, p) => { ensureWorld(); app.activeObject!.rigidBodyConstraint = defaultRigidBodyConstraint(p.type as RigidBodyConstraintType); return 'FINISHED'; },
  },
  {
    id: 'rigidbody.constraint_remove', label: 'Remove Rigid Body Constraint', description: 'Remove Rigid Body Constraint from Object', undo: true, register: true,
    poll: () => isObjectMode() && !!app.activeObject?.rigidBodyConstraint,
    exec: () => { app.activeObject!.rigidBodyConstraint = null; return 'FINISHED'; },
  },
  // ---------------------------------------------------------------- force fields
  {
    id: 'object.forcefield_toggle', label: 'Toggle Force Field', description: 'Toggle object\'s force field', undo: true, register: true,
    poll: () => !!app.activeObject,
    exec: () => {
      const o = app.activeObject!;
      if (o.field && o.field.type !== 'NONE') o.field = null;
      else o.field = defaultField('FORCE');
      return 'FINISHED';
    },
  },
  {
    id: 'object.effector_add', label: 'Add Effector', description: 'Add an empty object with a physics effector to the scene', undo: true, register: true,
    props: {
      type: { name: 'Type', type: 'enum', default: 'FORCE', items: FIELD_TYPES.map(([t, l]): [string, string] => [t, l]) },
      radius: { name: 'Radius', type: 'float', default: 1, min: 0.001, subtype: 'DISTANCE' },
      location: { name: 'Location', type: 'vector', default: [0, 0, 0], size: 3, subtype: 'TRANSLATION' },
      rotation: { name: 'Rotation', type: 'vector', default: [0, 0, 0], size: 3, subtype: 'EULER' },
    },
    poll: isObjectMode,
    invoke: (ctx, p) => { p.location = app.scene.cursor.slice(); return app.operator('object.effector_add')!.exec!(ctx, p); },
    exec: (_c, p) => {
      const type = p.type as FieldType;
      const label = FIELD_TYPES.find(([t]) => t === type)?.[1] ?? 'Field';
      const ob = createObject(app.doc, 'EMPTY', type === 'FORCE' ? 'Field' : label, null);
      ob.emptyDrawType = type === 'WIND' || type === 'VORTEX' ? 'SINGLE_ARROW' : 'PLAIN_AXES';
      ob.emptyDrawSize = n(p, 'radius');
      ob.location = (p.location as Vec3).slice() as Vec3;
      ob.rotation = (p.rotation as Vec3).slice() as Vec3;
      ob.field = defaultField(type);
      const layer = Math.max(0, app.scene.layers.findIndex(Boolean));
      ob.layers = new Array(20).fill(false);
      ob.layers[layer] = true;
      app.scene.objects.push(ob.id);
      app.deselectAll();
      ob.select = true;
      app.scene.activeObject = ob.id;
      return 'FINISHED';
    },
  },
  // ---------------------------------------------------------------- point caches
  {
    id: 'ptcache.bake', label: 'Bake Physics', description: 'Bake physics', register: true,
    props: { bake: { name: 'Bake', type: 'bool', default: false }, cache_key: { name: 'Cache', type: 'string', default: '', hidden: true } },
    poll: () => !isBaking(),
    exec: async (_c, p) => {
      const ds = targetDrivers(String(p.cache_key ?? ''));
      if (!ds.length) { app.report('WARNING', 'No point cache to bake'); return 'CANCELLED'; }
      await bakeDrivers(ds, !!p.bake);
      return 'FINISHED';
    },
  },
  {
    id: 'ptcache.free_bake', label: 'Free Physics Bake', description: 'Free physics bake', register: true,
    props: { cache_key: { name: 'Cache', type: 'string', default: '', hidden: true } },
    poll: () => !isBaking(),
    exec: (_c, p) => { freeBake(targetDrivers(String(p.cache_key ?? ''))); return 'FINISHED'; },
  },
  {
    id: 'ptcache.bake_from_cache', label: 'Bake From Cache', description: 'Bake from cache', register: true,
    props: { cache_key: { name: 'Cache', type: 'string', default: '', hidden: true } },
    poll: () => !isBaking(),
    exec: (_c, p) => {
      for (const d of targetDrivers(String(p.cache_key ?? ''))) if (d.cache.size) { d.cache.baked = true; d.cache.epoch++; }
      app.notify('frame', 'data');
      return 'FINISHED';
    },
  },
  {
    id: 'ptcache.bake_all', label: 'Bake All Physics', description: 'Bake all physics', register: true,
    props: { bake: { name: 'Bake', type: 'bool', default: true } },
    poll: () => !isBaking(),
    exec: async (_c, p) => {
      const ds = allDrivers().filter((d) => d.alive());
      if (!ds.length) { app.report('WARNING', 'No point caches to bake'); return 'CANCELLED'; }
      await bakeDrivers(ds, !!p.bake);
      return 'FINISHED';
    },
  },
  {
    id: 'ptcache.free_bake_all', label: 'Free All Physics Bakes', description: 'Free all baked caches of all objects in the current scene', register: true,
    poll: () => !isBaking(),
    exec: () => { freeBake(allDrivers()); return 'FINISHED'; },
  },
  // ---------------------------------------------------------------- quick effects
  {
    id: 'object.quick_fur', label: 'Quick Fur', description: 'Add fur setup to the selected objects', undo: true, register: true,
    props: {
      density: { name: 'Fur Density', type: 'enum', default: 'MEDIUM', items: [['LIGHT', 'Light'], ['MEDIUM', 'Medium'], ['HEAVY', 'Heavy']] },
      view_percentage: { name: 'View %', type: 'int', default: 10, min: 1, max: 100 },
      length: { name: 'Length', type: 'float', default: 0.1, min: 0.001, max: 100, subtype: 'DISTANCE' },
    },
    poll: () => isObjectMode() && app.selectedObjects().some((o) => o.type === 'MESH'),
    exec: (_c, p) => {
      const meshes = app.selectedObjects().filter((o) => o.type === 'MESH');
      let mat: string | null = null;
      for (const o of meshes) {
        const md = app.meshOf(o);
        if (!md) continue;
        if (!mat) {
          const ma = createMaterial(app.doc, 'Fur Material');
          ma.diffuseColor = [0.53, 0.38, 0.23];
          ma.specularIntensity = 0.1;
          mat = ma.id;
        }
        md.materials.push(mat);
        o.particleSystems ??= [];
        const ps = newParticleSystem(o.particleSystems);
        const count = p.density === 'LIGHT' ? 100 : p.density === 'HEAVY' ? 1000 : 400;
        Object.assign(ps, {
          type: 'HAIR', count, hairLength: n(p, 'length'), hairStep: 5, childType: 'INTERPOLATED', childNbr: Math.round(n(p, 'view_percentage')),
          renderedChildCount: 50, clumpFactor: 0, roughness1: 0.05, roughnessEndpoint: 0.2, materialSlot: md.materials.length, renderType: 'PATH',
          useAdvancedHair: false, distribution: 'JIT',
        });
        o.particleSystems.push(ps);
        o.activeParticleSystem = o.particleSystems.length - 1;
      }
      return 'FINISHED';
    },
  },
];

function rawWorld(o: BObject): Matrix4 {
  const mats = new MatrixCache(app.doc);
  mats.noOverrides = true;
  return mats.world(o).clone();
}

/** A popup list of enum values at the mouse (invoke of Change Shape / Calculate Mass). */
function showEnumMenu(title: string, items: [string, string][], pick: (v: string) => void): void {
  showMenu(items.map(([id, label]) => ({ label, action: () => pick(id) })), { x: app.mouse.x, y: app.mouse.y }, { title });
}

// Esc cancels a running bake
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isBaking()) { cancelBake(); e.preventDefault(); } }, true);

