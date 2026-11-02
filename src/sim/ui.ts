// Properties editor panels for physics (Physics tab, Particles tab, the Scene tab's
// Rigid Body World), the tool shelf "Physics" tab and 3D View menu entries, laid
// out like Blender 2.79's properties_physics_*.py / properties_particle.py.

import { app } from '../app';
import type { BObject, Modifier, ParticleSystem } from '../core/types';
import {
  bprop, eprop, fprop, iprop, type BoolProp, type EnumItem, type EnumProp, type FloatProp, type IntProp, type Layout, type PanelDef,
} from '../ui/layout';
import type { MenuItem } from '../ui/menu';
import {
  activeWhen, flatPanel, NA, naBool, naButton, naEnum, naFloat, naInt, ob, objectIconFor, richList, type PropsCtx,
} from '../editors/properties/common';
import { allDrivers, cacheInfo, isBaking, objectDrivers, type SimDriver } from './cache';
import { clothDriverOf } from './cloth';
import { particleDriver } from './particles';
import { rigidBodyDriver } from './rigidbody';
import { CONSTRAINT_TYPES, FIELD_TYPES, SUPPORTED_FIELDS } from './ops';
import {
  CLOTH_PRESETS, clothOf, defaultCollision, defaultEffectorWeights, defaultField, psFull, softBodyOf,
  type ClothModifier, type CollisionSettings, type EffectorWeights, type FieldSettings, type PointCacheSettings,
  type RigidBodyConstraint, type RigidBodyObject, type SoftBodyModifier,
} from './types';

type Get<T> = () => T | null | undefined;

// ------------------------------------------------------------------ prop helpers

function f<T>(t: Get<T>, key: keyof T & string, name: string, o: Partial<FloatProp> = {}): FloatProp {
  return fprop(t as () => unknown, key, { name, precision: 3, step: 0.1, ...o });
}
function i<T>(t: Get<T>, key: keyof T & string, name: string, o: Partial<IntProp> = {}): IntProp {
  return iprop(t as () => unknown, key, { name, ...o });
}
function b<T>(t: Get<T>, key: keyof T & string, name: string, o: Partial<BoolProp> = {}): BoolProp {
  return bprop(t as () => unknown, key, { name, ...o });
}
function e<T>(t: Get<T>, key: keyof T & string, name: string, items: EnumItem[], o: Partial<EnumProp> = {}): EnumProp {
  return eprop(t as () => unknown, key, items, { name, ...o });
}

const pct = { min: 0, max: 1 };

// ------------------------------------------------------------------ shared UI blocks

/** Field Weights (effector_weights_ui). */
function effectorWeightsUI(l: Layout, w: Get<EffectorWeights>, py: string): void {
  l.prop(naEnum('Effector Group', [{ id: '', label: '', icon: 'GROUP' }]));
  const sp = l.split();
  sp.column().prop(f(w, 'gravity', 'Gravity', { min: -200, max: 200, softMin: 0, softMax: 1, description: 'Global gravity weight', python: `${py}.gravity` }), { slider: true });
  sp.column().prop(f(w, 'all', 'All', { min: -200, max: 200, softMin: 0, softMax: 1, description: 'All effector\'s weight', python: `${py}.all` }), { slider: true });
  l.separator();
  const sp2 = l.split();
  const c1 = sp2.column(), c2 = sp2.column();
  const s = (c: Layout, key: keyof EffectorWeights & string, name: string, supported = true) =>
    c.prop(f(w, key, name, { min: -200, max: 200, softMin: 0, softMax: 1, description: supported ? `${name} effector weight` : `${name} effector weight (${NA})`, python: `${py}.${key}`, disabled: supported ? undefined : () => true }), { slider: true });
  s(c1, 'force', 'Force'); s(c1, 'vortex', 'Vortex'); s(c1, 'magnetic', 'Magnetic'); s(c1, 'wind', 'Wind');
  s(c1, 'curveGuide', 'Curve Guide', false); s(c1, 'texture', 'Texture', false); s(c1, 'smokeflow', 'Smoke Flow', false);
  s(c2, 'harmonic', 'Harmonic'); s(c2, 'charge', 'Charge'); s(c2, 'lennardjones', 'Lennard-Jones', false); s(c2, 'turbulence', 'Turbulence');
  s(c2, 'drag', 'Drag'); s(c2, 'boid', 'Boid', false);
}

/** Point cache panel body (point_cache_ui). */
function pointCacheUI(l: Layout, ctx: PropsCtx, drv: () => SimDriver<unknown> | null, pc: Get<PointCacheSettings>, kind: 'RIGID_BODY' | 'CLOTH' | 'SOFTBODY' | 'PSYS'): void {
  const baked = () => !!drv()?.cache.baked;
  if (kind !== 'PSYS') {
    const row = l.row(true);
    const dis = () => baked();
    row.prop(i(pc, 'frameStart', 'Start', { min: -1000, max: 1048574, disabled: dis, description: 'Frame on which the simulation starts', notify: ['frame', 'data'] }));
    row.prop(i(pc, 'frameEnd', 'End', { min: 1, max: 1048574, disabled: dis, description: 'Frame on which the simulation stops', notify: ['frame', 'data'] }));
    if (kind === 'SOFTBODY') row.prop(naInt('Cache Step', 1));
  } else {
    l.row().prop(naInt('Cache Step', 1));
  }
  l.dynLabel(() => { const d = drv(); return d ? cacheInfo(d) : ''; });
  if (kind !== 'RIGID_BODY') {
    const r = l.row();
    r.prop(naBool('Disk Cache'));
    r.prop(naBool('Use Lib Path'));
  }
  const sp = l.split();
  const c1 = sp.column(true);
  const key = () => drv()?.key ?? '';
  if (baked()) c1.button('Free Bake', () => void app.callOperator('ptcache.free_bake', { cache_key: key() }, { area: ctx.area }), { tip: 'Free physics bake', disabled: () => isBaking() });
  else c1.button('Bake', () => void app.callOperator('ptcache.bake', { bake: true, cache_key: key() }, { area: ctx.area }), { tip: 'Bake physics (simulate the whole cache range now)', disabled: () => isBaking() });
  c1.button('Calculate To Frame', () => void app.callOperator('ptcache.bake', { bake: false, cache_key: key() }, { area: ctx.area }), { tip: 'Simulate up to the current frame', disabled: () => isBaking() || baked() });
  c1.button('Current Cache to Bake', () => void app.callOperator('ptcache.bake_from_cache', { cache_key: key() }, { area: ctx.area }), { tip: 'Keep the frames cached so far as a bake', disabled: () => isBaking() || baked() || !drv()?.cache.size });
  const c2 = sp.column(true);
  c2.operator('ptcache.bake_all', { text: 'Bake All Dynamics', props: { bake: true } });
  c2.operator('ptcache.free_bake_all', { text: 'Free All Bakes' });
  c2.operator('ptcache.bake_all', { text: 'Update All To Frame', props: { bake: false } });
}

/** Vertex group selector (prop_search over the object's vertex groups). */
function vgroupProp<T>(l: Layout, t: Get<T>, key: keyof T & string, name: string, description: string): void {
  l.prop({
    kind: 'enum', name, description, notify: ['data'],
    items: () => [{ id: '', label: '', icon: 'GROUP_VERTEX' }, ...(ob()?.vertexGroups ?? []).map((g) => ({ id: g.name, label: g.name, icon: 'GROUP_VERTEX' }))],
    get: () => String((t() as Record<string, unknown> | null)?.[key] ?? ''),
    set: (v) => { const x = t() as Record<string, unknown> | null; if (x) x[key] = v; },
  }, { noLabel: !name, icon: 'GROUP_VERTEX' });
}

// ------------------------------------------------------------------ getters

const modOf = (type: string): Modifier | null => ob()?.modifiers.find((m) => m.type === type) ?? null;
const cloth = (): ClothModifier | null => { const m = modOf('CLOTH'); return m ? clothOf(m) : null; };
const softbody = (): SoftBodyModifier | null => { const m = modOf('SOFT_BODY'); return m ? softBodyOf(m) : null; };
const clothSettings = () => cloth()?.settings ?? null;
const clothColl = () => cloth()?.collisionSettings ?? null;
const sbSettings = () => softbody()?.settings ?? null;
const rb = (): RigidBodyObject | null => ob()?.rigidBody ?? null;
const rbc = (): RigidBodyConstraint | null => ob()?.rigidBodyConstraint ?? null;
const field = (): FieldSettings | null => { const o = ob(); return o?.field && o.field.type !== 'NONE' ? o.field : null; };
/** Collision settings of the active object, created with defaults when first edited. */
const coll = (): CollisionSettings | null => {
  const o = ob();
  if (!o) return null;
  if (!o.collision) o.collision = defaultCollision();
  return o.collision;
};

function clothDriver(): SimDriver<unknown> | null {
  const o = ob(), m = modOf('CLOTH');
  return o && m ? clothDriverOf(o, m) as unknown as SimDriver<unknown> : null;
}
function sbDriver(): SimDriver<unknown> | null {
  const o = ob(), m = modOf('SOFT_BODY');
  return o && m ? clothDriverOf(o, m) as unknown as SimDriver<unknown> : null;
}

// ------------------------------------------------------------------ Physics tab

function physicsButton(l: Layout, text: string, icon: string, on: boolean, addOp: string, addProps: Record<string, unknown>, removeOp: string, removeProps: Record<string, unknown>, disabled = false): void {
  const row = l.row(true);
  if (disabled) {
    const btn = naButton(row, text, icon);
    btn.classList.add('left');
    return;
  }
  const el = on ? row.operator(removeOp, { text, icon: 'X', props: removeProps, align: 'left' }) : row.operator(addOp, { text, icon, props: addProps, align: 'left' });
  void el;
}

export function physicsPanels(ctx: PropsCtx): PanelDef[] {
  const enabledKey = () => {
    const o = ob();
    if (!o) return '';
    return [o.type, !!field(), !!modOf('COLLISION'), !!modOf('CLOTH'), !!modOf('SOFT_BODY'), !!o.rigidBody, !!o.rigidBodyConstraint].join(',');
  };
  const isMesh = () => ob()?.type === 'MESH';
  return [
    {
      id: 'physics.add', label: '', noHeader: true, key: enabledKey,
      draw: (l) => {
        flatPanel(l);
        const o = ob();
        if (!o) return;
        const mesh = o.type === 'MESH';
        l.label('Enable physics for:');
        const sp = l.split();
        const c1 = sp.column();
        physicsButton(c1, 'Force Field', 'FORCE_FORCE', !!field(), 'object.forcefield_toggle', {}, 'object.forcefield_toggle', {});
        if (mesh) {
          const col = modOf('COLLISION'), cl = modOf('CLOTH');
          physicsButton(c1, 'Collision', 'MOD_PHYSICS', !!col, 'object.modifier_add', { type: 'COLLISION' }, 'object.modifier_remove', { modifier: col?.name ?? 'Collision' });
          physicsButton(c1, 'Cloth', 'MOD_CLOTH', !!cl, 'object.modifier_add', { type: 'CLOTH' }, 'object.modifier_remove', { modifier: cl?.name ?? 'Cloth' });
          physicsButton(c1, 'Dynamic Paint', 'MOD_DYNAMICPAINT', false, '', {}, '', {}, true);
        }
        const c2 = sp.column();
        if (mesh) {
          const sb = modOf('SOFT_BODY');
          physicsButton(c2, 'Soft Body', 'MOD_SOFT', !!sb, 'object.modifier_add', { type: 'SOFT_BODY' }, 'object.modifier_remove', { modifier: sb?.name ?? 'Softbody' });
          physicsButton(c2, 'Fluid', 'MOD_FLUIDSIM', false, '', {}, '', {}, true);
          physicsButton(c2, 'Smoke', 'MOD_SMOKE', false, '', {}, '', {}, true);
          physicsButton(c2, 'Rigid Body', 'MESH_ICOSPHERE', !!o.rigidBody, 'rigidbody.object_add', { type: 'ACTIVE' }, 'rigidbody.object_remove', {});
        }
        physicsButton(c2, 'Rigid Body Constraint', 'CONSTRAINT', !!o.rigidBodyConstraint, 'rigidbody.constraint_add', { type: 'FIXED' }, 'rigidbody.constraint_remove', {});
      },
    },
    ...fieldPanels(),
    ...collisionPanels(isMesh),
    ...clothPanels(ctx),
    ...rigidBodyPanels(),
    ...rigidBodyConstraintPanels(),
    ...softBodyPanels(ctx),
  ];
}

// ------------------------------------------------------------------ force fields

function fieldTypeItems(): EnumItem[] {
  return [{ id: 'NONE', label: 'None' }, ...FIELD_TYPES.map(([id, label, icon]) => ({ id, label, icon, disabled: !SUPPORTED_FIELDS.has(id), description: SUPPORTED_FIELDS.has(id) ? undefined : NA }))];
}

function fieldPanels(): PanelDef[] {
  const F = field;
  const py = 'bpy.context.object.field';
  return [{
    id: 'physics.field', label: 'Force Fields', poll: () => !!F(),
    key: () => { const x = F(); return x ? [x.type, x.shape, x.falloffType, x.useMinDistance, x.useMaxDistance].join(',') : ''; },
    draw: (l) => {
      const x = F();
      if (!x) return;
      const s1 = l.split(0.2);
      s1.column().label('Type:');
      s1.column().prop({ ...e(F, 'type', 'Type', fieldTypeItems(), { description: 'Type of field', python: `${py}.type` }), set: (v: string) => { const o = ob(); if (o?.field) o.field = { ...defaultField(v as FieldSettings['type']), ...o.field, type: v as FieldSettings['type'] }; } }, { noLabel: true });
      const s2 = l.split(0.2);
      s2.column().label('Shape:');
      s2.column().prop(e(F, 'shape', 'Shape', [
        { id: 'POINT', label: 'Point', description: 'Field originates from the object center' },
        { id: 'PLANE', label: 'Plane', description: 'Field originates from the local XY plane of the object' },
        { id: 'SURFACE', label: 'Surface', disabled: true, description: NA },
        { id: 'POINTS', label: 'Every Point', disabled: true, description: NA },
      ], { description: 'Which direction is used to calculate the effector force', python: `${py}.shape` }), { noLabel: true });
      if (x.type === 'HARMONIC') {
        const sp = l.split();
        const c1 = sp.column();
        c1.prop(f(F, 'strength', 'Strength', { min: -1000, max: 1000, description: 'Strength of force field', python: `${py}.strength` }));
        c1.prop(f(F, 'flow', 'Flow', { min: 0, max: 10, description: 'Convert effector force into air flow velocity', python: `${py}.flow` }));
        const c2 = sp.column();
        c2.prop(f(F, 'harmonicDamping', 'Damping', { min: 0, max: 10, description: 'Damping of the harmonic force', python: `${py}.harmonic_damping` }));
        c2.prop(f(F, 'restLength', 'Rest Length', { min: 0, max: 1000, unit: 'LENGTH', description: 'Rest length of the harmonic force', python: `${py}.rest_length` }));
        c2.prop(naBool('Multiple Springs'));
      } else {
        const sp = l.split();
        const c1 = sp.column();
        if (x.type === 'DRAG') c1.prop(f(F, 'linearDrag', 'Linear', { min: -2, max: 2, description: 'Drag component proportional to velocity', python: `${py}.linear_drag` }));
        else c1.prop(f(F, 'strength', 'Strength', { min: -1000, max: 1000, description: 'Strength of force field', python: `${py}.strength` }));
        if (x.type === 'TURBULENCE') {
          c1.prop(f(F, 'size', 'Size', { min: 0, max: 1000, description: 'Size of the turbulence', python: `${py}.size` }));
          c1.prop(f(F, 'flow', 'Flow', { min: 0, max: 10, description: 'Convert effector force into air flow velocity', python: `${py}.flow` }));
        } else if (x.type === 'VORTEX' && x.shape !== 'POINT') {
          c1.prop(f(F, 'inflow', 'Inflow', { min: -10, max: 10, description: 'Inwards component of the vortex force', python: `${py}.inflow` }));
        } else if (x.type === 'DRAG') {
          c1.prop(f(F, 'quadraticDrag', 'Quadr', { min: -2, max: 2, description: 'Drag component proportional to the square of velocity', python: `${py}.quadratic_drag` }));
        } else {
          c1.prop(f(F, 'flow', 'Flow', { min: 0, max: 10, description: 'Convert effector force into air flow velocity', python: `${py}.flow` }));
        }
        const c2 = sp.column();
        const r = c2.row(true);
        r.prop(f(F, 'noise', 'Noise', { min: 0, max: 10, description: 'Amount of noise for the force strength', python: `${py}.noise` }));
        r.prop(i(F, 'seed', 'Seed', { min: 1, max: 128, description: 'Seed of the noise', python: `${py}.seed` }));
        if (x.type === 'TURBULENCE') c2.prop(b(F, 'useGlobalCoords', 'Global', { description: 'Use effector/global coordinates for turbulence', python: `${py}.use_global_coords` }));
        const sp2 = l.split();
        const e1 = sp2.column();
        e1.label('Effect point:');
        e1.prop(b(F, 'applyToLocation', 'Location', { description: 'Effect particles\' location', python: `${py}.apply_to_location` }));
        e1.prop(b(F, 'applyToRotation', 'Rotation', { description: 'Effect particles\' dynamic rotation (stored)', python: `${py}.apply_to_rotation` }));
        const e2 = sp2.column();
        e2.label('Collision:');
        e2.prop(b(F, 'useAbsorption', 'Absorption', { description: 'Force gets absorbed by collision objects (stored)', python: `${py}.use_absorption` }));
      }
      l.label('Falloff:');
      l.row().prop(e(F, 'falloffType', 'Falloff', [
        { id: 'SPHERE', label: 'Sphere' }, { id: 'TUBE', label: 'Tube' }, { id: 'CONE', label: 'Cone' },
      ], { python: `${py}.falloff_type` }), { expand: true });
      const sp3 = l.split();
      sp3.column().prop(e(F, 'zDirection', 'Z Direction', [
        { id: 'BOTH', label: '+Z and -Z' }, { id: 'POSITIVE', label: '+Z' }, { id: 'NEGATIVE', label: '-Z' },
      ], { description: 'Effect in full or only positive/negative Z direction', python: `${py}.z_direction` }), { noLabel: true });
      sp3.column().prop(f(F, 'falloffPower', 'Power', { min: 0, max: 10, description: 'Falloff power (real gravitational falloff = 2)', python: `${py}.falloff_power` }));
      const sp4 = l.split();
      const m1 = sp4.column().row(true);
      m1.prop(b(F, 'useMinDistance', '', { description: 'Use a minimum distance for the field\'s fall-off', python: `${py}.use_min_distance` }), { text: '' });
      const mm1 = m1.row(true);
      mm1.prop(f(F, 'distanceMin', 'Minimum', { min: 0, max: 1000, unit: 'LENGTH', description: 'Minimum distance for the field\'s fall-off', python: `${py}.distance_min` }));
      activeWhen(mm1, () => !!F()?.useMinDistance);
      const m2 = sp4.column().row(true);
      m2.prop(b(F, 'useMaxDistance', '', { description: 'Use a maximum distance for the field to work', python: `${py}.use_max_distance` }), { text: '' });
      const mm2 = m2.row(true);
      mm2.prop(f(F, 'distanceMax', 'Maximum', { min: 0, max: 1000, unit: 'LENGTH', description: 'Maximum distance for the field to work', python: `${py}.distance_max` }));
      activeWhen(mm2, () => !!F()?.useMaxDistance);
      if (x.falloffType !== 'SPHERE') {
        l.label(x.falloffType === 'CONE' ? 'Angular:' : 'Radial:');
        const sp5 = l.split();
        sp5.column().prop(f(F, 'radialFalloff', 'Power', { min: 0, max: 10, description: 'Radial falloff power', python: `${py}.radial_falloff` }));
        const r2 = sp5.column().row(true);
        r2.prop(b(F, 'useRadialMax', '', { description: 'Use a maximum radial distance', python: `${py}.use_radial_max` }), { text: '' });
        r2.prop(f(F, 'radialMax', x.falloffType === 'CONE' ? 'Max Angle' : 'Maximum', { min: 0, max: 1000, unit: x.falloffType === 'CONE' ? 'ROTATION' : 'LENGTH', python: `${py}.radial_max` }));
      }
    },
  }];
}

// ------------------------------------------------------------------ collision

function collisionPanels(isMesh: () => boolean): PanelDef[] {
  const C = coll;
  const py = 'bpy.context.object.collision';
  const sl = (c: Layout, key: keyof CollisionSettings & string, name: string, desc: string, o: Partial<FloatProp> = {}) =>
    c.prop(f(C, key, name, { ...pct, description: desc, python: `${py}.${key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)}`, ...o }), { slider: true });
  return [{
    id: 'physics.collision', label: 'Collision', poll: () => isMesh() && !!modOf('COLLISION'),
    draw: (l) => {
      const sp = l.split();
      const c1 = sp.column();
      c1.label('Particle:');
      sl(c1, 'permeability', 'Permeability', 'Chance that the particle will pass through the mesh');
      c1.prop(f(C, 'stickiness', 'Stickiness', { min: 0, max: 10, description: 'Amount of stickiness to surface collision', python: `${py}.stickiness` }));
      c1.prop(b(C, 'useParticleKill', 'Kill Particles', { description: 'Kill collided particles', python: `${py}.use_particle_kill` }));
      c1.label('Particle Damping:');
      const d1 = c1.column(true);
      sl(d1, 'dampingFactor', 'Factor', 'Amount of damping during particle collision');
      sl(d1, 'dampingRandom', 'Random', 'Random variation of damping');
      c1.label('Particle Friction:');
      const d2 = c1.column(true);
      sl(d2, 'frictionFactor', 'Factor', 'Amount of friction during particle collision');
      sl(d2, 'frictionRandom', 'Random', 'Random variation of friction');
      const c2 = sp.column();
      c2.label('Soft Body and Cloth:');
      const d3 = c2.column(true);
      sl(d3, 'thicknessOuter', 'Outer', 'Outer face thickness', { min: 0.001, max: 1 });
      sl(d3, 'thicknessInner', 'Inner', 'Inner face thickness (only used by softbodies)', { min: 0.001, max: 1 });
      c2.label('Soft Body Damping:');
      sl(c2, 'damping', 'Factor', 'Amount of damping during collision');
      c2.label('Force Fields:');
      sl(c2, 'absorption', 'Absorption', 'How much of effector force gets lost during collision with this object (stored)');
    },
  }];
}

// ------------------------------------------------------------------ cloth

function clothPanels(ctx: PropsCtx): PanelDef[] {
  const S = clothSettings, CO = clothColl;
  const has = () => !!cloth();
  const py = 'bpy.context.cloth.settings';
  const bakedOff = () => !!clothDriver()?.cache.baked;
  return [
    {
      id: 'physics.cloth', label: 'Cloth', poll: has, key: () => `${clothDriver()?.cache.baked}`,
      draw: (l) => {
        if (bakedOff()) l.label('Cache is baked: free the bake to edit the settings', { icon: 'INFO' });
        const body = l.column();
        if (bakedOff()) activeWhen(body, () => false);
        const pr = body.row(true);
        pr.menu('Cloth Presets', () => Object.entries(CLOTH_PRESETS).map(([name, p]): MenuItem => ({
          label: name, action: () => { const s = S(); if (!s) return; Object.assign(s, p); app.pushUndo('Cloth Preset'); app.notify('data'); },
        })), { title: 'Cloth Presets' });
        pr.button('', () => {}, { icon: 'ZOOMIN', iconOnly: true, tip: `Add a cloth preset: ${NA}`, disabled: () => true });
        pr.button('', () => {}, { icon: 'ZOOMOUT', iconOnly: true, tip: `Remove a cloth preset: ${NA}`, disabled: () => true });
        const q = body.split(0.25);
        q.column().label('Quality:');
        q.column().prop(i(S, 'quality', 'Steps', { min: 1, max: 80, description: 'Quality of the simulation in steps per frame (higher is better quality but slower)', python: `${py}.quality` }));
        const sm = body.split(0.25);
        sm.column().label('Speed:');
        sm.column().prop(f(S, 'timeScale', 'Multiplier', { min: 0, max: 10, description: 'Cloth speed is multiplied by this value', python: `${py}.time_scale` }));
        const sp = body.split();
        const c1 = sp.column();
        c1.label('Material:');
        c1.prop(f(S, 'mass', 'Mass', { min: 0, max: 10, unit: 'MASS', description: 'Mass of cloth material', python: `${py}.mass` }));
        c1.prop(f(S, 'structuralStiffness', 'Structural', { min: 0, max: 10000, description: 'Overall stiffness of structure', python: `${py}.structural_stiffness` }));
        c1.prop(f(S, 'bendingStiffness', 'Bending', { min: 0, max: 10000, description: 'Wrinkle coefficient (higher = less smaller but more big wrinkles)', python: `${py}.bending_stiffness` }));
        const c2 = sp.column();
        c2.label('Damping:');
        c2.prop(f(S, 'springDamping', 'Spring', { min: 0, max: 50, description: 'Damping of cloth velocity (higher = more smooth, less jiggling)', python: `${py}.spring_damping` }));
        c2.prop(f(S, 'airDamping', 'Air', { min: 0, max: 10, description: 'Air has normally some thickness which slows falling things down', python: `${py}.air_damping` }));
        c2.prop(f(S, 'velDamping', 'Velocity', { min: 0, max: 1, description: 'Damp velocity to help cloth reach the resting position faster (1.0 = no damping, 0.0 = fully dampened)', python: `${py}.vel_damping` }));
      },
    },
    {
      id: 'physics.cloth_cache', label: 'Cloth Cache', poll: has, defaultClosed: true, key: () => `${clothDriver()?.cache.baked}`,
      draw: (l) => pointCacheUI(l, ctx, clothDriver, () => cloth()?.pointCache ?? null, 'CLOTH'),
    },
    {
      id: 'physics.cloth_shape', label: 'Cloth Shape', poll: has,
      draw: (l) => {
        const sp = l.split();
        const c1 = sp.column();
        c1.label('Pinning:');
        vgroupProp(c1, S, 'vertexGroupMass', '', 'Vertex group for pinning of vertices (weight 1 = pinned)');
        c1.prop(f(S, 'pinStiffness', 'Stiffness', { min: 0, max: 50, description: 'Pin (vertex target position) spring stiffness', python: `${py}.pin_stiffness` }));
        c1.label('Shrinking:');
        const sc = c1.column(true);
        sc.prop(f(S, 'shrinkMin', 'Shrink Min', { min: -1, max: 1, description: 'Shrink factor of the rest lengths of the springs', python: `${py}.shrink_min` }), { slider: true });
        sc.prop(naFloat('Shrink Max', 0));
        const c2 = sp.column();
        c2.prop(naBool('Sewing'));
        c2.prop(naFloat('Max Sewing Force', 0));
        c2.prop(naBool('Dynamic Mesh'));
      },
    },
    {
      id: 'physics.cloth_collision', label: 'Cloth Collisions', poll: has,
      drawHeader: (hl) => { hl.prop(b(CO, 'useCollision', '', { description: 'Enable collisions with other objects', python: 'bpy.context.cloth.collision_settings.use_collision' }), { text: '' }); },
      draw: (l) => {
        const body = activeWhen(l.column(), () => !!CO()?.useCollision);
        const pyc = 'bpy.context.cloth.collision_settings';
        const sp = body.split();
        const c1 = sp.column();
        c1.prop(i(CO, 'collisionQuality', 'Quality', { min: 1, max: 20, description: 'How many collision iterations should be done (higher is better quality but slower)', python: `${pyc}.collision_quality` }));
        c1.prop(f(CO, 'distanceMin', 'Distance', { min: 0.001, max: 1, unit: 'LENGTH', description: 'Minimum distance between collision objects before collision response takes in', python: `${pyc}.distance_min` }), { slider: true });
        c1.prop(f(CO, 'repelForce', 'Repel', { min: 0, max: 20, description: 'Repulsion force to apply on cloth when close to colliding', python: `${pyc}.repel_force` }), { slider: true });
        c1.prop(f(CO, 'distanceRepel', 'Repel Distance', { min: 0.001, max: 10, unit: 'LENGTH', description: 'Maximum distance to apply repulsion force, must be greater than minimum distance', python: `${pyc}.distance_repel` }));
        const c2 = sp.column();
        c2.prop(f(CO, 'friction', 'Friction', { min: 0, max: 80, description: 'Friction force if a collision happened (higher = less movement)', python: `${pyc}.friction` }));
        c2.prop(naBool('Self Collision'));
        c2.prop(naInt('Quality', 1));
        c2.prop(naFloat('Distance', 0.015));
      },
    },
    {
      id: 'physics.cloth_stiffness', label: 'Cloth Stiffness Scaling', poll: has, defaultClosed: true,
      drawHeader: (hl) => { hl.prop(naBool(''), { text: '' }); },
      draw: (l) => {
        const sp = l.split();
        const c1 = sp.column();
        c1.label('Structural Stiffness:', { disabled: true });
        c1.prop(naEnum('Vertex Group', [{ id: '', label: '', icon: 'GROUP_VERTEX' }]), { noLabel: true });
        c1.prop(naFloat('Max', 15));
        const c2 = sp.column();
        c2.label('Bending Stiffness:', { disabled: true });
        c2.prop(naEnum('Vertex Group', [{ id: '', label: '', icon: 'GROUP_VERTEX' }]), { noLabel: true });
        c2.prop(naFloat('Max', 0.5));
      },
    },
    {
      id: 'physics.cloth_field_weights', label: 'Cloth Field Weights', poll: has, defaultClosed: true,
      draw: (l) => effectorWeightsUI(l, () => clothSettings()?.effectorWeights ?? null, 'bpy.context.cloth.settings.effector_weights'),
    },
  ];
}

// ------------------------------------------------------------------ soft body

function softBodyPanels(ctx: PropsCtx): PanelDef[] {
  const S = sbSettings;
  const has = () => !!softbody();
  const py = 'bpy.context.object.soft_body';
  return [
    {
      id: 'physics.softbody', label: 'Soft Body', poll: has,
      draw: (l) => {
        const sp = l.split();
        const c1 = sp.column();
        c1.label('Object:');
        c1.prop(f(S, 'friction', 'Friction', { min: 0, max: 50, description: 'General media friction for point movements', python: `${py}.friction` }));
        c1.prop(f(S, 'mass', 'Mass', { min: 0, max: 50000, unit: 'MASS', description: 'General Mass value', python: `${py}.mass` }));
        c1.prop(naEnum('Mass Vertex Group', [{ id: '', label: '', icon: 'GROUP_VERTEX' }]), { noLabel: true });
        const c2 = sp.column();
        c2.label('Simulation:');
        c2.prop(f(S, 'speed', 'Speed', { min: 0.01, max: 100, description: 'Tweak timing for physics to control frequency and speed', python: `${py}.speed` }));
      },
    },
    {
      id: 'physics.softbody_cache', label: 'Soft Body Cache', poll: has, defaultClosed: true, key: () => `${sbDriver()?.cache.baked}`,
      draw: (l) => pointCacheUI(l, ctx, sbDriver, () => softbody()?.pointCache ?? null, 'SOFTBODY'),
    },
    {
      id: 'physics.softbody_goal', label: 'Soft Body Goal', poll: has,
      drawHeader: (hl) => { hl.prop(b(S, 'useGoal', '', { description: 'Define forces for vertices to stick to animated position', python: `${py}.use_goal` }), { text: '' }); },
      draw: (l) => {
        const body = activeWhen(l.column(), () => !!S()?.useGoal);
        const sp = body.split();
        const c1 = sp.column();
        c1.label('Goal Strengths:');
        c1.prop(f(S, 'goalDefault', 'Default', { ...pct, description: 'Default Goal (vertex target position) value', python: `${py}.goal_default` }));
        const mm = c1.column(true);
        mm.prop(f(S, 'goalMin', 'Minimum', { ...pct, description: 'Goal minimum, vertex weights are scaled to match this range', python: `${py}.goal_min` }), { slider: true });
        mm.prop(f(S, 'goalMax', 'Maximum', { ...pct, description: 'Goal maximum, vertex weights are scaled to match this range', python: `${py}.goal_max` }), { slider: true });
        const c2 = sp.column();
        c2.label('Goal Settings:');
        c2.prop(f(S, 'goalSpring', 'Stiffness', { min: 0, max: 0.999, description: 'Goal (vertex target position) spring stiffness', python: `${py}.goal_spring` }));
        c2.prop(f(S, 'goalFriction', 'Damping', { min: 0, max: 50, description: 'Goal (vertex target position) friction', python: `${py}.goal_friction` }));
        body.label('Vertex Group:');
        vgroupProp(body, S, 'vertexGroupGoal', '', 'Control point weight values');
      },
    },
    {
      id: 'physics.softbody_edge', label: 'Soft Body Edges', poll: has,
      drawHeader: (hl) => { hl.prop(b(S, 'useEdges', '', { description: 'Use Edges as springs', python: `${py}.use_edges` }), { text: '' }); },
      draw: (l) => {
        const body = activeWhen(l.column(), () => !!S()?.useEdges);
        const sp = body.split();
        const c1 = sp.column();
        c1.label('Springs:');
        c1.prop(f(S, 'pull', 'Pull', { min: 0, max: 0.999, description: 'Edge spring stiffness when longer than rest length', python: `${py}.pull` }));
        c1.prop(f(S, 'push', 'Push', { min: 0, max: 0.999, description: 'Edge spring stiffness when shorter than rest length', python: `${py}.push` }));
        c1.prop(f(S, 'damping', 'Damp', { min: 0, max: 50, description: 'Edge spring friction', python: `${py}.damping` }));
        c1.prop(naInt('Plastic', 0));
        c1.prop(f(S, 'bend', 'Bending', { min: 0, max: 10, description: 'Bending Stiffness', python: `${py}.bend` }));
        c1.prop(naInt('Length', 0));
        c1.prop(naEnum('Spring Vertex Group', [{ id: '', label: '', icon: 'GROUP_VERTEX' }]), { noLabel: true });
        const c2 = sp.column();
        c2.prop(naEnum('Aerodynamics Type', ['Simple', 'Lift Force']), { noLabel: true });
        c2.prop(naInt('Factor', 0));
        c2.label('Stiffness:');
        c2.prop(b(S, 'useStiffQuads', 'Stiff Quads', { description: 'Add diagonal springs on 4-gons', python: `${py}.use_stiff_quads` }));
        const sh = c2.row();
        sh.prop(f(S, 'shear', 'Shear', { ...pct, description: 'Shear Stiffness', python: `${py}.shear` }));
        activeWhen(sh, () => !!S()?.useStiffQuads);
        c2.label('Collision:', { disabled: true });
        c2.prop(naBool('Edge'));
        c2.prop(naBool('Face'));
      },
    },
    {
      id: 'physics.softbody_collide', label: 'Soft Body Self Collision', poll: has, defaultClosed: true,
      drawHeader: (hl) => { hl.prop(naBool(''), { text: '' }); },
      draw: (l) => {
        l.label('Collision Ball Size Calculation:', { disabled: true });
        l.row().prop(naEnum('Calculation Type', ['Manual', 'Average', 'Minimal', 'Maximal', 'AvMinMax'], 'Average'), { expand: true });
        const c = l.column(true);
        c.prop(naFloat('Size', 0.49)); c.prop(naFloat('Stiffness', 1)); c.prop(naFloat('Dampening', 0.5));
      },
    },
    {
      id: 'physics.softbody_solver', label: 'Soft Body Solver', poll: has, defaultClosed: true,
      draw: (l) => {
        const sp = l.split();
        const c1 = sp.column(true);
        c1.label('Step Size:');
        c1.prop(i(S, 'stepMin', 'Min Step', { min: 1, max: 100, description: 'Minimal # solver steps/frame', python: `${py}.step_min` }));
        c1.prop(naInt('Max Step', 300));
        c1.prop(naBool('Auto-Step', true));
        const c2 = sp.column();
        c2.prop(naFloat('Error Limit', 0.1));
        c2.label('Helpers:', { disabled: true });
        c2.prop(naInt('Choke', 3)); c2.prop(naFloat('Fuzzy', 0));
        l.label('Diagnostics:', { disabled: true });
        const r = l.row(); r.prop(naBool('Print Performance to Console')); r.prop(naBool('Estimate matrix'));
      },
    },
    {
      id: 'physics.softbody_field_weights', label: 'Soft Body Field Weights', poll: has, defaultClosed: true,
      draw: (l) => effectorWeightsUI(l, () => sbSettings()?.effectorWeights ?? null, `${py}.effector_weights`),
    },
  ];
}

// ------------------------------------------------------------------ rigid body

const SHAPE_ITEMS: EnumItem[] = [
  { id: 'BOX', label: 'Box', icon: 'MESH_CUBE', description: 'Box-like shapes (i.e. cubes), including planes (i.e. ground planes)' },
  { id: 'SPHERE', label: 'Sphere', icon: 'MESH_UVSPHERE' },
  { id: 'CAPSULE', label: 'Capsule', icon: 'OUTLINER_OB_META' },
  { id: 'CYLINDER', label: 'Cylinder', icon: 'MESH_CYLINDER' },
  { id: 'CONE', label: 'Cone', icon: 'MESH_CONE' },
  { id: 'CONVEX_HULL', label: 'Convex Hull', icon: 'MESH_ICOSPHERE', description: 'A mesh-like surface encompassing (i.e. shrinkwrap over) all vertices (best results with fewer vertices)' },
  { id: 'MESH', label: 'Mesh', icon: 'MESH_MONKEY', description: 'Mesh consisting of triangles only, allowing for more detailed interactions than convex hulls' },
];

function rigidBodyPanels(): PanelDef[] {
  const R = rb;
  const py = 'bpy.context.object.rigid_body';
  const has = () => !!R() && (ob()?.type === 'MESH' || ob()?.type === 'FONT');
  return [
    {
      id: 'physics.rigid_body', label: 'Rigid Body', poll: has, key: () => R()?.type ?? '',
      draw: (l) => {
        l.row().prop(e(R, 'type', 'Type', [
          { id: 'ACTIVE', label: 'Active', description: 'Object is directly controlled by simulation results' },
          { id: 'PASSIVE', label: 'Passive', description: 'Object is directly controlled by animation system' },
        ], { description: 'Role of object in Rigid Body Simulations', python: `${py}.type` }));
        const row = l.row();
        if (R()?.type === 'ACTIVE') row.prop(b(R, 'enabled', 'Dynamic', { description: 'Rigid Body actively participates to the simulation', python: `${py}.enabled` }));
        row.prop(b(R, 'kinematic', 'Animated', { description: 'Allow rigid body to be controlled by the animation system', python: `${py}.kinematic` }));
        if (R()?.type === 'ACTIVE') l.row().prop(f(R, 'mass', 'Mass', { min: 0.001, max: 100000, unit: 'MASS', description: 'How much the object \'weighs\' irrespective of gravity', python: `${py}.mass` }));
      },
    },
    {
      id: 'physics.rigid_body_collisions', label: 'Rigid Body Collisions', poll: has, key: () => R()?.collisionShape ?? '',
      draw: (l) => {
        l.prop(e(R, 'collisionShape', 'Shape', SHAPE_ITEMS, { description: 'Collision Shape of object in Rigid Body Simulations', python: `${py}.collision_shape` }));
        if (R()?.collisionShape === 'MESH') {
          l.prop(e(R, 'meshSource', 'Source', [
            { id: 'BASE', label: 'Base', description: 'Base mesh' },
            { id: 'DEFORM', label: 'Deform', description: 'Deformations (shape keys, deform modifiers)' },
            { id: 'FINAL', label: 'Final', description: 'All modifiers' },
          ], { description: 'Source of the mesh used to create collision shape', python: `${py}.mesh_source` }));
        }
        const sp = l.split();
        const c1 = sp.column();
        c1.label('Surface Response:');
        c1.prop(f(R, 'friction', 'Friction', { min: 0, max: 1, description: 'Resistance of object to movement', python: `${py}.friction` }), { slider: true });
        c1.prop(f(R, 'restitution', 'Bounciness', { min: 0, max: 1, description: 'Tendency of object to bounce after colliding with another (0 = stays still, 1 = perfectly elastic)', python: `${py}.restitution` }), { slider: true });
        const c2 = sp.column();
        c2.label('Sensitivity:');
        const shape = R()?.collisionShape;
        if (shape === 'MESH' || shape === 'CONE' || shape === 'CONVEX_HULL') {
          c2.prop(f(R, 'collisionMargin', 'Margin', { min: 0, max: 1, unit: 'LENGTH', description: 'Threshold of distance near surface where collisions are still considered (best results when non-zero)', python: `${py}.collision_margin` }));
        } else {
          c2.prop(b(R, 'useMargin', 'Collision Margin', { description: 'Use custom collision margin (some shapes will have a visible gap around them)', python: `${py}.use_margin` }));
          const m = c2.row();
          m.prop(f(R, 'collisionMargin', 'Margin', { min: 0, max: 1, unit: 'LENGTH', description: 'Threshold of distance near surface where collisions are still considered (best results when non-zero)', python: `${py}.collision_margin` }));
          activeWhen(m, () => !!R()?.useMargin);
        }
        l.label('Collision Groups:');
        l.layers(() => R()?.collisionGroups ?? [], (layers) => { const x = R(); if (x) { x.collisionGroups = layers; app.pushUndo('Collision Groups'); app.notify('data'); } });
      },
    },
    {
      id: 'physics.rigid_body_dynamics', label: 'Rigid Body Dynamics', poll: () => has() && R()?.type === 'ACTIVE', defaultClosed: true,
      draw: (l) => {
        const sp = l.split();
        const c1 = sp.column();
        c1.label('Deactivation:');
        c1.prop(b(R, 'useDeactivation', 'Enable Deactivation', { description: 'Enable deactivation of resting rigid bodies (increases performance and stability but can cause glitches)', python: `${py}.use_deactivation` }));
        const sub = c1.column();
        sub.prop(b(R, 'useStartDeactivated', 'Start Deactivated', { description: 'Deactivate rigid body at the start of the simulation', python: `${py}.use_start_deactivated` }));
        sub.prop(f(R, 'deactivateLinearVelocity', 'Linear Vel', { min: 0, max: 100, description: 'Linear Velocity below which simulation stops simulating object', python: `${py}.deactivate_linear_velocity` }));
        sub.prop(f(R, 'deactivateAngularVelocity', 'Angular Vel', { min: 0, max: 100, description: 'Angular Velocity below which simulation stops simulating object', python: `${py}.deactivate_angular_velocity` }));
        activeWhen(sub, () => !!R()?.useDeactivation);
        const c2 = sp.column();
        c2.label('Damping:');
        c2.prop(f(R, 'linearDamping', 'Translation', { min: 0, max: 1, description: 'Amount of linear velocity that is lost over time', python: `${py}.linear_damping` }), { slider: true });
        c2.prop(f(R, 'angularDamping', 'Rotation', { min: 0, max: 1, description: 'Amount of angular velocity that is lost over time', python: `${py}.angular_damping` }), { slider: true });
      },
    },
  ];
}

function rigidBodyConstraintPanels(): PanelDef[] {
  const C = rbc;
  const py = 'bpy.context.object.rigid_body_constraint';
  const has = () => !!C();
  const objectProp = (key: 'object1' | 'object2', name: string, desc: string) => ({
    kind: 'enum' as const, name, description: desc, python: `${py}.${key}`, notify: ['data'],
    items: () => [{ id: '', label: '', icon: 'NONE' }, ...app.objects().filter((o) => !!o.rigidBody).map((o) => ({ id: o.id, label: o.name, icon: objectIconFor(o.type) }))],
    get: () => C()?.[key] ?? '',
    set: (v: string) => { const x = C(); if (x) x[key] = v || null; },
  });
  return [
    {
      id: 'physics.rigid_body_constraint', label: 'Rigid Body Constraint', poll: has, key: () => `${C()?.type}|${C()?.useBreaking}`,
      draw: (l) => {
        l.prop(e(C, 'type', 'Type', CONSTRAINT_TYPES.map(([id, label]) => ({ id, label, disabled: ['PISTON', 'GENERIC', 'MOTOR'].includes(id), description: ['PISTON', 'GENERIC', 'MOTOR'].includes(id) ? NA : undefined })), { description: 'Type of Rigid Body Constraint', python: `${py}.type` }));
        const r = l.row();
        r.prop(b(C, 'enabled', 'Enabled', { description: 'Enable this constraint', python: `${py}.enabled` }));
        r.prop(b(C, 'disableCollisions', 'Disable Collisions', { description: 'Disable collisions between constrained rigid bodies', python: `${py}.disable_collisions` }));
        l.label('Objects:');
        const c = l.column(true);
        c.prop(objectProp('object1', 'First', 'First Rigid Body Object to be constrained'), { icon: 'OBJECT_DATA' });
        c.prop(objectProp('object2', 'Second', 'Second Rigid Body Object to be constrained'), { icon: 'OBJECT_DATA' });
        const r2 = l.row();
        r2.prop(b(C, 'useBreaking', 'Breakable', { description: 'Constraint can be broken if it receives an impulse above the threshold', python: `${py}.use_breaking` }));
        const th = r2.row();
        th.prop(f(C, 'breakingThreshold', 'Threshold', { min: 0, max: 1000, description: 'Impulse threshold that must be reached for the constraint to break', python: `${py}.breaking_threshold` }));
        activeWhen(th, () => !!C()?.useBreaking);
        const r3 = l.row();
        r3.prop(naBool('Override Iterations'));
        r3.prop(naInt('Iterations', 10));
      },
    },
    {
      id: 'physics.rigid_body_constraint_limits', label: 'Limits', poll: () => C()?.type === 'SLIDER' || C()?.type === 'HINGE',
      draw: (l) => {
        if (C()?.type === 'SLIDER') {
          l.label('X Axis:');
          const r = l.row(true);
          r.prop(b(C, 'useLimitLinX', '', { description: 'Limit translation on X axis', python: `${py}.use_limit_lin_x` }), { text: '' });
          const s = r.row(true);
          s.prop(f(C, 'limitLinXLower', 'Lower', { min: -1000, max: 1000, unit: 'LENGTH', description: 'Lower limit of X axis translation', python: `${py}.limit_lin_x_lower` }));
          s.prop(f(C, 'limitLinXUpper', 'Upper', { min: -1000, max: 1000, unit: 'LENGTH', description: 'Upper limit of X axis translation', python: `${py}.limit_lin_x_upper` }));
          activeWhen(s, () => !!C()?.useLimitLinX);
        } else {
          l.label('Z Angle:', { disabled: true });
          const r = l.row(true);
          r.prop(naBool(''), { text: '' });
          r.prop(naFloat('Lower', -45, { unit: 'NONE' }));
          r.prop(naFloat('Upper', 45, { unit: 'NONE' }));
        }
      },
    },
    {
      id: 'physics.rigid_body_constraint_springs', label: 'Springs', poll: () => C()?.type === 'GENERIC_SPRING',
      draw: (l) => {
        for (const ax of ['X', 'Y', 'Z'] as const) {
          const r = l.row();
          r.prop(b(C, `useSpring${ax}`, `${ax}`, { description: `Enable spring on ${ax} axis`, python: `${py}.use_spring_${ax.toLowerCase()}` }));
          const s = r.row(true);
          s.prop(f(C, `springStiffness${ax}`, 'Stiffness', { min: 0, max: 10000, description: `Stiffness on the ${ax} axis`, python: `${py}.spring_stiffness_${ax.toLowerCase()}` }));
          s.prop(f(C, `springDamping${ax}`, 'Damping', { min: 0, max: 1, description: `Damping on the ${ax} axis`, python: `${py}.spring_damping_${ax.toLowerCase()}` }));
          activeWhen(s, () => !!C()?.[`useSpring${ax}`]);
        }
      },
    },
  ];
}

// ------------------------------------------------------------------ scene tab: rigid body world

export function rigidBodyWorldPanels(ctx: PropsCtx): PanelDef[] {
  const W = () => app.scene?.rigidBodyWorld ?? null;
  const py = 'bpy.context.scene.rigidbody_world';
  const drv = () => { const d = rigidBodyDriver(); return d ? d as unknown as SimDriver<unknown> : null; };
  return [
    {
      id: 'scene.rigidbody_world', label: 'Rigid Body World', key: () => `${!!W()}`,
      drawHeader: (hl) => {
        if (W()) hl.prop(b(W, 'enabled', '', { description: 'Simulation will be evaluated', python: `${py}.enabled` }), { text: '' });
        else hl.prop(naBool('', false, 'Add a Rigid Body World first'), { text: '' });
      },
      draw: (l) => {
        if (!W()) { l.operator('rigidbody.world_add'); return; }
        l.operator('rigidbody.world_remove');
        const col = activeWhen(l.column(), () => !!W()?.enabled);
        col.prop({
          kind: 'enum', name: 'Group', undo: false, description: 'Collection containing objects participating in this simulation (every object with rigid body settings in blender-web)', python: `${py}.group`,
          items: [{ id: 'RigidBodyWorld', label: 'RigidBodyWorld', icon: 'GROUP' }], get: () => 'RigidBodyWorld', set: () => {},
        }, { icon: 'GROUP' });
        col.prop({
          kind: 'enum', name: 'Constraints', undo: false, description: 'Collection containing rigid body constraint objects (every object with a rigid body constraint in blender-web)', python: `${py}.constraints`,
          items: [{ id: 'RigidBodyConstraints', label: 'RigidBodyConstraints', icon: 'GROUP' }], get: () => 'RigidBodyConstraints', set: () => {},
        }, { icon: 'GROUP' });
        const sp = col.split();
        const c1 = sp.column();
        c1.prop(f(W, 'timeScale', 'Speed', { min: 0, max: 100, description: 'Change the speed of the simulation', python: `${py}.time_scale` }));
        c1.prop(b(W, 'useSplitImpulse', 'Split Impulse', { description: 'Reduce extra velocity that can build up when objects collide (stored; cannon-es has no split impulse)', python: `${py}.use_split_impulse` }));
        const c2 = sp.column();
        c2.prop(i(W, 'stepsPerSecond', 'Steps Per Second', { min: 1, max: 32000, description: 'Number of simulation steps taken per second (higher values are more accurate but slower)', python: `${py}.steps_per_second` }));
        c2.prop(i(W, 'solverIterations', 'Solver Iterations', { min: 1, max: 1000, description: 'Number of constraint solver iterations made per simulation step (higher values are more accurate but slower)', python: `${py}.solver_iterations` }));
      },
    },
    {
      id: 'scene.rigidbody_cache', label: 'Rigid Body Cache', poll: () => !!W(), key: () => `${drv()?.cache.baked}`,
      draw: (l) => pointCacheUI(l, ctx, drv, () => W()?.pointCache ?? null, 'RIGID_BODY'),
    },
    {
      id: 'scene.rigidbody_field_weights', label: 'Rigid Body Field Weights', poll: () => !!W(), defaultClosed: true,
      draw: (l) => effectorWeightsUI(l, () => W()?.effectorWeights ?? null, `${py}.effector_weights`),
    },
  ];
}

// ------------------------------------------------------------------ Particles tab

function activePs(): ParticleSystem | null {
  const o = ob();
  if (!o?.particleSystems?.length) return null;
  return o.particleSystems[Math.min(o.activeParticleSystem ?? 0, o.particleSystems.length - 1)] ?? null;
}

/** Live float prop on the active particle system with the documented default when unset. */
function pf(key: keyof ParticleSystem & string, name: string, o: Partial<FloatProp> = {}): FloatProp {
  return {
    kind: 'float', name, precision: 3, step: 0.1, notify: ['data'], python: `bpy.context.particle_system.settings.${key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)}`,
    get: () => { const p = activePs(); return p ? Number((psFull(p) as unknown as Record<string, unknown>)[key] ?? 0) : 0; },
    set: (v) => { const p = activePs(); if (p) (p as unknown as Record<string, unknown>)[key] = v; },
    ...o,
  };
}
function pi(key: keyof ParticleSystem & string, name: string, o: Partial<IntProp> = {}): IntProp {
  return {
    kind: 'int', name, notify: ['data'], python: `bpy.context.particle_system.settings.${key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)}`,
    get: () => { const p = activePs(); return p ? Number((psFull(p) as unknown as Record<string, unknown>)[key] ?? 0) : 0; },
    set: (v) => { const p = activePs(); if (p) (p as unknown as Record<string, unknown>)[key] = Math.round(v); },
    ...o,
  };
}
function pb(key: keyof ParticleSystem & string, name: string, o: Partial<BoolProp> = {}): BoolProp {
  return {
    kind: 'bool', name, notify: ['data'], python: `bpy.context.particle_system.settings.${key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)}`,
    get: () => { const p = activePs(); return p ? !!(psFull(p) as unknown as Record<string, unknown>)[key] : false; },
    set: (v) => { const p = activePs(); if (p) (p as unknown as Record<string, unknown>)[key] = v; },
    ...o,
  };
}
function pe(key: keyof ParticleSystem & string, name: string, items: EnumItem[], o: Partial<EnumProp> = {}): EnumProp {
  return {
    kind: 'enum', name, items, notify: ['data'], python: `bpy.context.particle_system.settings.${key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)}`,
    get: () => { const p = activePs(); return p ? String((psFull(p) as unknown as Record<string, unknown>)[key] ?? '') : ''; },
    set: (v) => { const p = activePs(); if (p) (p as unknown as Record<string, unknown>)[key] = v; },
    ...o,
  };
}

const isHair = () => psFull(activePs() ?? ({} as ParticleSystem)).type === 'HAIR';

export function particlePanels(ctx: PropsCtx): PanelDef[] {
  const has = () => !!activePs();
  const full = () => psFull(activePs()!);
  const psDriver = (): SimDriver<unknown> | null => { const o = ob(), p = activePs(); return o && p && !isHair() ? particleDriver(o, p) as unknown as SimDriver<unknown> : null; };
  const structure = () => { const p = activePs(); if (!p) return ''; const x = psFull(p); return [x.type, x.emitFrom, x.distribution, x.useAdvancedHair, x.physicsType, x.renderType, x.drawMethod, x.childType, !!x.hairKeys].join(','); };
  return [
    {
      id: 'particles.context', label: '', noHeader: true, key: () => `${ob()?.particleSystems?.length ?? 0}|${structure()}`,
      draw: (l) => {
        flatPanel(l);
        richList(l, {
          rows: 3,
          items: () => (ob()?.particleSystems ?? []).map((p) => ({
            label: p.name, icon: 'PARTICLES',
            check: { get: () => p.showViewport, set: (v) => { p.showViewport = v; }, tip: 'Display particle system in viewport' },
          })),
          active: () => ob()?.activeParticleSystem ?? 0,
          setActive: (n) => { const o = ob(); if (o) o.activeParticleSystem = n; },
          rename: (n, name) => { const o = ob(); if (o?.particleSystems[n]) o.particleSystems[n].name = name; },
          side: [
            { icon: 'ZOOMIN', tip: 'Add a particle system', action: () => void app.callOperator('object.particle_system_add', {}, { exec: true, area: ctx.area }) },
            { icon: 'ZOOMOUT', tip: 'Remove the selected particle system', disabled: () => !has(), action: () => void app.callOperator('object.particle_system_remove', {}, { exec: true, area: ctx.area }) },
          ],
        });
        if (!has()) return;
        const sp = l.split(0.32);
        sp.column().label('Type:');
        const r = sp.column().row();
        r.prop(pe('type', 'Type', [{ id: 'EMITTER', label: 'Emitter' }, { id: 'HAIR', label: 'Hair' }], {
          description: 'Particle Type', undo: 'Change Particle Type',
          set: (v) => { const p = activePs(); if (!p) return; p.type = v as 'HAIR'; delete p.renderType; },
        }), { noLabel: true });
        r.prop(iprop(() => activePs(), 'seed', { name: 'Seed', min: 0, description: 'Offset in the random number table, to get a different randomized result', python: 'bpy.context.particle_system.seed' }));
        if (isHair()) {
          if (full().hairKeys) {
            l.button('Free Edit', () => { const p = activePs(); if (p) { p.hairKeys = null; app.pushUndo('Free Edit'); app.notify('data'); } }, { tip: 'Undo all edits of the hair (Particle Edit mode)' });
          } else {
            const r2 = l.split(0.32);
            r2.column();
            const rr = r2.column().row();
            rr.prop(pb('useRegrowHair', 'Regrow', { description: 'Regrow hair for each frame' }));
            rr.prop(pb('useAdvancedHair', 'Advanced', { description: 'Use full physics calculations for growing hair' }));
          }
        }
      },
    },
    {
      id: 'particles.emission', label: 'Emission', poll: has, key: structure,
      draw: (l) => {
        const x = full();
        const row = l.row();
        row.prop(pi('count', 'Number', { min: 0, max: 10000000, softMax: 200000, description: 'Total number of particles' }));
        if (x.type === 'HAIR') {
          row.prop(pf('hairLength', 'Hair Length', { min: 0, max: 1000, unit: 'LENGTH', description: 'Length of the hair' }));
        } else {
          const sp = l.split();
          const c1 = sp.column(true);
          c1.prop(pf('frameStart', 'Start', { min: -500000, max: 500000, step: 1, precision: 3, description: 'Frame number to start emitting particles' }));
          c1.prop(pf('frameEnd', 'End', { min: -500000, max: 500000, step: 1, precision: 3, description: 'Frame number to stop emitting particles' }));
          const c2 = sp.column(true);
          c2.prop(pf('lifetime', 'Lifetime', { min: 1, max: 500000, step: 1, description: 'Life span of the particles' }));
          c2.prop(pf('lifetimeRandom', 'Random', { ...pct, description: 'Give the particle life a random variation' }), { slider: true });
        }
        if (x.type === 'HAIR' && !x.useAdvancedHair) {
          l.label('Emit From:');
          l.row().prop(pe('emitFrom', 'Emit From', [{ id: 'VERT', label: 'Verts' }, { id: 'FACE', label: 'Faces' }, { id: 'VOLUME', label: 'Volume', disabled: true, description: NA }], { description: 'Where to emit particles from' }), { expand: true });
        } else {
          l.label('Emit From:');
          l.row().prop(pe('emitFrom', 'Emit From', [{ id: 'VERT', label: 'Verts' }, { id: 'FACE', label: 'Faces' }, { id: 'VOLUME', label: 'Volume', disabled: true, description: NA }], { description: 'Where to emit particles from' }), { expand: true });
        }
        const r2 = l.row();
        r2.prop(pb('useEmitRandom', 'Random', { description: 'Emit in random order of elements' }));
        if (x.emitFrom !== 'VERT') r2.prop(pb('useEvenDistribution', 'Even Distribution', { description: 'Use even distribution from faces based on face areas or edge lengths' }));
        if (x.emitFrom === 'FACE') {
          l.row().prop(pe('distribution', 'Distribution', [
            { id: 'JIT', label: 'Jittered', description: 'Use a uniform distribution with a jitter' },
            { id: 'RANDOM', label: 'Random' },
            { id: 'GRID', label: 'Grid', description: 'Regular arrangement inside the faces' },
          ], { description: 'How to distribute particles on selected element' }), { expand: true });
          if (x.distribution === 'JIT') {
            const r3 = l.row();
            r3.prop(naInt('Particles/Face', 0));
            r3.prop(pf('jitterFactor', 'Jittering Amount', { min: 0, max: 2, description: 'Amount of jitter applied to the sampling' }), { slider: true });
          }
        }
        l.row().prop(naBool('Use Modifier Stack', true));
      },
    },
    {
      id: 'particles.hair_dynamics', label: 'Hair Dynamics', poll: () => has() && isHair(), defaultClosed: true,
      drawHeader: (hl) => { hl.prop(naBool(''), { text: '' }); },
      draw: (l) => { l.label('Hair dynamics are not available in blender-web', { disabled: true }); },
    },
    {
      id: 'particles.cache', label: 'Cache', poll: () => has() && !isHair(), defaultClosed: true, key: () => `${psDriver()?.cache.baked}`,
      draw: (l) => pointCacheUI(l, ctx, psDriver, () => null, 'PSYS'),
    },
    {
      id: 'particles.velocity', label: 'Velocity', poll: () => has() && (!isHair() || full().useAdvancedHair),
      draw: (l) => {
        const sp = l.split();
        const c1 = sp.column();
        c1.label('Emitter Geometry:');
        c1.prop(pf('normalFactor', 'Normal', { min: -1000, max: 1000, unit: 'LENGTH', description: 'Let the surface normal give the particle a starting velocity' }));
        const t = c1.column(true);
        t.prop(naFloat('Tangent', 0));
        t.prop(naFloat('Rot', 0));
        const c2 = sp.column();
        c2.label('Emitter Object:');
        const col = c2.column(true);
        for (let k = 0; k < 3; k++) {
          col.prop({
            kind: 'float', name: ['X', 'Y', 'Z'][k], precision: 3, step: 0.1, unit: 'LENGTH', notify: ['data'], description: 'Let the emitter object orientation give the particle a starting velocity',
            get: () => activePs()?.objectAlignFactor?.[k] ?? 0,
            set: (v) => { const p = activePs(); if (p) { p.objectAlignFactor = (p.objectAlignFactor ?? [0, 0, 0]).slice() as typeof p.objectAlignFactor; p.objectAlignFactor[k] = v; } },
          });
        }
        l.label('Other:');
        const r = l.row();
        r.prop(pf('objectFactor', 'Object', { min: -200, max: 200, softMin: -1, softMax: 1, description: 'Let the object give the particle a starting velocity' }), { slider: true });
        r.prop(pf('randomFactor', 'Random', { min: 0, max: 200, description: 'Give the starting velocity a random variation' }));
      },
    },
    {
      id: 'particles.rotation', label: 'Rotation', poll: () => has() && !isHair(), defaultClosed: true,
      drawHeader: (hl) => { hl.prop(naBool(''), { text: '' }); },
      draw: (l) => {
        l.row().prop(naBool('Dynamic'));
        const sp = l.split();
        sp.column().prop(naEnum('Orientation Axis', ['Velocity / Hair'], 'Velocity / Hair'));
        sp.column().prop(naFloat('Random', 0));
      },
    },
    {
      id: 'particles.physics', label: 'Physics', poll: () => has() && !isHair(), key: structure,
      draw: (l) => {
        const x = full();
        l.row().prop(pe('physicsType', 'Physics Type', [
          { id: 'NO', label: 'No' }, { id: 'NEWTON', label: 'Newtonian' }, { id: 'KEYED', label: 'Keyed', disabled: true, description: NA },
          { id: 'BOIDS', label: 'Boids' }, { id: 'FLUID', label: 'Fluid', disabled: true, description: NA },
        ], { description: 'Particle physics type' }), { expand: true });
        const row = l.row();
        const c1 = row.column(true);
        c1.prop(pf('size', 'Size', { min: 0.001, max: 100000, step: 0.01, unit: 'LENGTH', description: 'The size of the particles' }));
        c1.prop(pf('sizeRandom', 'Random Size', { ...pct, description: 'Give the particle size a random variation' }), { slider: true });
        if (x.physicsType !== 'NO') {
          const c2 = row.column(true);
          c2.prop(pf('mass', 'Mass', { min: 0.001, max: 100000, unit: 'MASS', description: 'Mass of the particles' }));
          c2.prop(naBool('Multiply mass with size'));
        }
        if (x.physicsType === 'NEWTON') {
          const sp = l.split();
          const f1 = sp.column();
          f1.label('Forces:');
          f1.prop(pf('brownianFactor', 'Brownian', { min: 0, max: 200, description: 'Amount of random, erratic particle movement' }));
          f1.prop(pf('dragFactor', 'Drag', { ...pct, description: 'Amount of air-drag' }), { slider: true });
          f1.prop(pf('dampingFactor', 'Damp', { ...pct, description: 'Amount of damping' }), { slider: true });
          const f2 = sp.column();
          f2.label('Integration:');
          f2.prop(naEnum('Integration', ['Midpoint'], 'Midpoint'), { noLabel: true });
          f2.prop(pf('timestep', 'Timestep', { min: 0.0001, max: 100, description: 'The simulation timestep per frame (seconds per frame)' }));
          f2.prop(pi('subframes', 'Subframes', { min: 0, max: 1000, description: 'Subframes to simulate for improved stability and finer granularity simulations' }));
          const r = l.row();
          r.prop(naBool('Size Deflect'));
          r.prop(pb('useDieOnCollision', 'Die on hit', { description: 'Particles die when they collide with a deflector object' }));
          l.prop(naEnum('Collision Group', [{ id: '', label: '', icon: 'GROUP' }]));
        } else if (x.physicsType === 'BOIDS') {
          const sp = l.split();
          const c1b = sp.column();
          c1b.label('Movement:');
          c1b.prop(pf('boidAirSpeedMax', 'Max Air Speed', { min: 0, max: 100, description: 'Maximum speed in air' }));
          c1b.prop(pf('boidAirAccMax', 'Max Air Acceleration', { ...pct, description: 'Maximum acceleration in air (relative to maximum speed)' }), { slider: true });
          const c2b = sp.column();
          c2b.label('Rules:');
          c2b.prop(pf('boidSeparate', 'Separate', { min: 0, max: 10, description: 'Keep from going through other boids' }));
          c2b.prop(pf('boidFlock', 'Flock', { min: 0, max: 10, description: 'Move to the center of the flock and align with neighbours' }));
          c2b.prop(pi('boidNeighbours', 'Neighbors', { min: 1, max: 100, description: 'How many neighbours to consider' }));
        }
      },
    },
    {
      id: 'particles.render', label: 'Render', poll: has, key: structure,
      draw: (l) => {
        const x = full();
        const o = ob();
        const md = app.meshOf(o);
        l.row().prop(pe('materialSlot', 'Material', (md?.materials ?? []).map((m, k) => ({ id: String(k + 1), label: m ? app.doc.materials[m]?.name ?? '' : '', icon: 'MATERIAL' })), {
          description: 'Index of material slot used for rendering particles',
          get: () => String(full().materialSlot), set: (v) => { const p = activePs(); if (p) p.materialSlot = Number(v); },
        }), { icon: 'MATERIAL' });
        const sp = l.split();
        const c1 = sp.column();
        c1.prop(pb('useRenderEmitter', 'Emitter', { description: 'Render emitter object' }));
        c1.prop(naBool('Parents'));
        const c2 = sp.column();
        c2.prop(pb('showUnborn', 'Unborn', { description: 'Show particles before they are emitted' }));
        c2.prop(pb('useDead', 'Died', { description: 'Show particles after they have died' }));
        l.row().prop(pe('renderType', 'Render As', [
          { id: 'NONE', label: 'None' }, { id: 'HALO', label: 'Halo', disabled: x.type === 'HAIR' }, { id: 'LINE', label: 'Line', disabled: x.type === 'HAIR' },
          { id: 'PATH', label: 'Path' }, { id: 'OBJECT', label: 'Object', disabled: x.type === 'HAIR', description: x.type === 'HAIR' ? NA : undefined },
          { id: 'GROUP', label: 'Group', disabled: true, description: NA }, { id: 'BILLBOARD', label: 'Billboard', disabled: true, description: NA },
        ], { description: 'How particles are rendered' }), { expand: true });
        if (x.renderType === 'PATH') {
          const s2 = l.split();
          const d1 = s2.column();
          d1.prop(naBool('Strand render'));
          d1.prop(naBool('B-Spline'));
          d1.prop(pi('renderStep', 'Steps', { min: 0, max: 20, description: 'How many steps paths are rendered with (power of 2)' }));
          const d2 = s2.column();
          d2.label('Timing:', { disabled: true });
          d2.prop(naFloat('Start', 0));
          d2.prop(naFloat('End', 1));
        } else if (x.renderType === 'OBJECT') {
          l.prop({
            kind: 'enum', name: 'Duplication Object', description: 'Show this Object in place of particles', notify: ['data'], python: 'bpy.context.particle_system.settings.dupli_object',
            items: () => [{ id: '', label: '', icon: 'NONE' }, ...app.objects().filter((q) => q.type === 'MESH' && q.id !== o?.id).map((q) => ({ id: q.id, label: q.name, icon: objectIconFor(q.type) }))],
            get: () => activePs()?.dupliObject ?? '', set: (v) => { const p = activePs(); if (p) p.dupliObject = v || null; },
          }, { icon: 'OBJECT_DATA' });
          const r = l.row();
          r.prop(naBool('Global'));
          r.prop(pb('useRotationDupli', 'Rotation', { description: 'Use object\'s rotation for duplication (else align to the particle velocity)' }));
          r.prop(pb('useScaleDupli', 'Scale', { description: 'Use object\'s scale for duplication' }));
        } else if (x.renderType === 'HALO' || x.renderType === 'LINE') {
          l.row().prop(naInt('Trail Count', 1));
        }
      },
    },
    {
      id: 'particles.display', label: 'Display', poll: has, key: structure,
      draw: (l) => {
        const x = full();
        l.row().prop(pe('drawMethod', 'Display', [
          { id: 'NONE', label: 'None' }, { id: 'RENDER', label: 'Rendered' }, { id: 'DOT', label: 'Point' }, { id: 'CIRC', label: 'Circle' },
          { id: 'CROSS', label: 'Cross' }, { id: 'AXIS', label: 'Axis' },
        ], { description: 'How particles are displayed in viewport' }), { expand: true });
        const r = l.row();
        r.prop(bprop(() => activePs(), 'showViewport', { name: 'Show in Viewport', notify: ['scene'] }));
        r.prop(bprop(() => activePs(), 'showRender', { name: 'Show in Render', notify: ['scene'] }));
        const r2 = l.row();
        r2.prop(iprop(() => activePs(), 'displayPercentage', { name: 'Display', min: 0, max: 100, unit: 'PERCENTAGE', description: 'Percentage of particles to display in 3D view' }), { slider: true });
        if (x.drawMethod !== 'RENDER' || x.renderType === 'HALO') r2.prop(pi('drawSize', 'Draw Size', { min: 0, max: 1000, description: 'Size of particles on viewport in pixels (0=default)' }));
        const r3 = l.row();
        const c1 = r3.column();
        c1.prop(naBool('Size')); c1.prop(naBool('Velocity')); c1.prop(naBool('Number'));
        const c2 = r3.column(true);
        c2.label('Color:');
        c2.prop(naEnum('Draw Color', ['Material'], 'Material'), { noLabel: true });
        if (x.renderType === 'PATH' || x.type === 'HAIR') c2.prop(pi('displayStep', 'Steps', { min: 0, max: 10, description: 'How many steps paths are drawn with (power of 2)' }));
      },
    },
    {
      id: 'particles.children', label: 'Children', poll: () => has() && isHair(), key: structure,
      draw: (l) => {
        const x = full();
        l.row().prop(pe('childType', 'Children From', [{ id: 'NONE', label: 'None' }, { id: 'SIMPLE', label: 'Simple' }, { id: 'INTERPOLATED', label: 'Interpolated' }], { description: 'Create child particles' }), { expand: true });
        if (x.childType === 'NONE') return;
        const row = l.row();
        const c1 = row.column(true);
        c1.prop(pi('childNbr', 'Display', { min: 0, max: 100000, softMax: 1000, description: 'Number of children/parent for display' }));
        c1.prop(pi('renderedChildCount', 'Render', { min: 0, max: 100000, softMax: 10000, description: 'Number of children/parent for rendering' }));
        const c2 = row.column(true);
        if (x.childType === 'INTERPOLATED') { c2.prop(naInt('Seed', 0)); c2.prop(naFloat('Virtual Parents', 0)); }
        else { c2.prop(naFloat('Size', 1)); c2.prop(naFloat('Random', 0)); }
        const sp = l.split();
        const e1 = sp.column();
        e1.label('Effects:');
        const cl = e1.column(true);
        cl.prop(naBool('Use Clump Curve'));
        cl.prop(pf('clumpFactor', 'Clump', { min: -1, max: 1, description: 'Amount of clumping' }), { slider: true });
        cl.prop(pf('clumpShape', 'Shape', { min: -0.999, max: 0.999, description: 'Shape of clumping' }), { slider: true });
        const ln = e1.column(true);
        ln.prop(pf('childLength', 'Length', { ...pct, description: 'Length of child paths' }), { slider: true });
        ln.prop(naFloat('Threshold', 0));
        if (x.childType === 'SIMPLE') {
          const sr = e1.column(true);
          sr.prop(pf('childRadius', 'Radius', { min: 0, max: 100000, softMax: 10, unit: 'LENGTH', description: 'Radius of children around parent' }));
          sr.prop(pf('childRoundness', 'Roundness', { ...pct, description: 'Roundness of children around parent' }), { slider: true });
        }
        const e2 = sp.column();
        e2.label('Roughness:');
        const u = e2.column(true);
        u.prop(pf('roughness1', 'Uniform', { min: 0, max: 100000, softMax: 1, description: 'Amount of location dependent rough' }));
        u.prop(pf('roughness1Size', 'Size', { min: 0.01, max: 100000, softMax: 10, description: 'Size of location dependent rough' }));
        const ep = e2.column(true);
        ep.prop(pf('roughnessEndpoint', 'Endpoint', { min: 0, max: 100000, softMax: 1, description: 'Amount of end point rough' }));
        ep.prop(pf('roughnessEndShape', 'Shape', { min: 0, max: 10, description: 'Shape of end point rough' }));
        const rn = e2.column(true);
        rn.prop(pf('roughness2', 'Random', { min: 0, max: 100000, softMax: 1, description: 'Amount of random rough' }));
        rn.prop(pf('roughness2Size', 'Size', { min: 0.01, max: 100000, softMax: 10, description: 'Size of random rough' }));
        rn.prop(pf('roughness2Threshold', 'Threshold', { ...pct, description: 'Amount of particles left untouched by random rough' }), { slider: true });
        l.label('Kink:', { disabled: true });
        l.row().prop(naEnum('Kink', ['Nothing', 'Curl', 'Radial', 'Wave', 'Braid', 'Spiral'], 'Nothing'), { expand: true });
      },
    },
    {
      id: 'particles.fieldweights', label: 'Field Weights', poll: has, defaultClosed: true,
      draw: (l) => {
        // gravity uses the system's original "gravity" field
        const w = (): EffectorWeights | null => {
          const p = activePs();
          if (!p) return null;
          if (!p.effectorWeights) p.effectorWeights = defaultEffectorWeights();
          const wt = p.effectorWeights;
          return new Proxy(wt, {
            get: (t, k) => (k === 'gravity' ? p.gravity : (t as unknown as Record<string | symbol, unknown>)[k]),
            set: (t, k, v) => { if (k === 'gravity') p.gravity = Number(v); else (t as unknown as Record<string | symbol, unknown>)[k] = v; return true; },
          });
        };
        effectorWeightsUI(l, w, 'bpy.context.particle_system.settings.effector_weights');
      },
    },
    {
      id: 'particles.vertexgroups', label: 'Vertex Groups', poll: has, defaultClosed: true,
      draw: (l) => {
        const sp = l.split();
        const c1 = sp.column(); c1.label('Density', { disabled: true }); c1.label('Length', { disabled: true });
        const c2 = sp.column();
        c2.prop(naEnum('Density', [{ id: '', label: '', icon: 'GROUP_VERTEX' }]), { noLabel: true });
        c2.prop(naEnum('Length', [{ id: '', label: '', icon: 'GROUP_VERTEX' }]), { noLabel: true });
      },
    },
  ];
}

// ------------------------------------------------------------------ tool shelf and menus

/** Tool shelf "Physics" tab (VIEW3D_PT_tools_rigid_body). */
export function physicsToolPanels(): PanelDef[] {
  return [{
    id: 'rigidbody', label: 'Rigid Body Tools',
    draw: (l) => {
      const c = l.column(true);
      c.label('Add/Remove:');
      const r = c.row(true);
      r.operator('rigidbody.objects_add', { text: 'Add Active', props: { type: 'ACTIVE' } });
      r.operator('rigidbody.objects_add', { text: 'Add Passive', props: { type: 'PASSIVE' } });
      c.row(true).operator('rigidbody.objects_remove', { text: 'Remove' });
      const c2 = l.column(true);
      c2.label('Object Tools:');
      c2.operator('rigidbody.shape_change', { text: 'Change Shape', align: 'left' });
      c2.operator('rigidbody.mass_calculate', { text: 'Calculate Mass', align: 'left' });
      c2.operator('rigidbody.object_settings_copy', { text: 'Copy from Active', align: 'left' });
      c2.operator('object.visual_transform_apply', { text: 'Apply Transformation', align: 'left' });
      c2.operator('rigidbody.bake_to_keyframes', { text: 'Bake To Keyframes', align: 'left' });
      c2.label('Constraints:');
      c2.operator('rigidbody.connect', { text: 'Connect', align: 'left' });
    },
  }];
}

/** Object > Rigid Body submenu. */
export function rigidBodyMenu(): MenuItem[] {
  return [
    { label: 'Add Active', op: 'rigidbody.objects_add', props: { type: 'ACTIVE' } },
    { label: 'Add Passive', op: 'rigidbody.objects_add', props: { type: 'PASSIVE' } },
    { label: 'Remove', op: 'rigidbody.objects_remove' },
    { type: 'separator' },
    { label: 'Change Shape', op: 'rigidbody.shape_change' },
    { label: 'Calculate Mass', op: 'rigidbody.mass_calculate' },
    { label: 'Copy from Active', op: 'rigidbody.object_settings_copy' },
    { label: 'Apply Transformation', op: 'object.visual_transform_apply' },
    { label: 'Bake To Keyframes', op: 'rigidbody.bake_to_keyframes' },
    { type: 'separator' },
    { label: 'Connect', op: 'rigidbody.connect' },
  ];
}

/** Object > Quick Effects submenu. */
export function quickEffectsMenu(): MenuItem[] {
  return [
    { label: 'Quick Fur', op: 'object.quick_fur' },
    { label: 'Quick Explode', disabled: true, description: NA },
    { label: 'Quick Smoke', disabled: true, description: NA },
    { label: 'Quick Fluid', disabled: true, description: NA },
  ];
}

/** Add > Force Field submenu. */
export function forceFieldAddItems(): MenuItem[] {
  return FIELD_TYPES.map(([id, label, icon]): MenuItem => (SUPPORTED_FIELDS.has(id)
    ? { label, icon, op: 'object.effector_add', props: { type: id } }
    : { label, icon, disabled: true, description: NA }));
}

/** All physics simulation caches in the scene (for UI listings). */
export function sceneCaches(): SimDriver<unknown>[] { return allDrivers(); }
export function objectCaches(o: BObject): SimDriver<unknown>[] { return objectDrivers(o); }
