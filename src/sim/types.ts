// Physics settings stored in the document (plain JSON). Names and defaults follow
// Blender 2.79's RNA (rigid_body, rigid_body_constraint, field, collision, cloth,
// soft_body and particle settings). Simulation results never live here: they are
// kept in memory by the point caches (see cache.ts).

import type { BObject, Modifier, ParticleSystem, Scene } from '../core/types';

// ------------------------------------------------------------------ shared

export interface PointCacheSettings {
  frameStart: number;
  frameEnd: number;
  frameStep: number;
}

/** Influence of each kind of force field (and gravity) on a simulation ("Field Weights"). */
export interface EffectorWeights {
  gravity: number;
  all: number;
  force: number;
  vortex: number;
  magnetic: number;
  wind: number;
  curveGuide: number;
  texture: number;
  smokeflow: number;
  harmonic: number;
  charge: number;
  lennardjones: number;
  turbulence: number;
  drag: number;
  boid: number;
}

export function defaultEffectorWeights(): EffectorWeights {
  return {
    gravity: 1, all: 1, force: 1, vortex: 1, magnetic: 1, wind: 1, curveGuide: 1, texture: 1, smokeflow: 1,
    harmonic: 1, charge: 1, lennardjones: 1, turbulence: 1, drag: 1, boid: 1,
  };
}

export function defaultPointCache(end = 250): PointCacheSettings {
  return { frameStart: 1, frameEnd: end, frameStep: 1 };
}

// ------------------------------------------------------------------ rigid body

export interface RigidBodyWorld {
  enabled: boolean;
  timeScale: number;
  useSplitImpulse: boolean;
  stepsPerSecond: number;
  solverIterations: number;
  pointCache: PointCacheSettings;
  effectorWeights: EffectorWeights;
}

export type RigidBodyShape = 'BOX' | 'SPHERE' | 'CAPSULE' | 'CYLINDER' | 'CONE' | 'CONVEX_HULL' | 'MESH';

export interface RigidBodyObject {
  type: 'ACTIVE' | 'PASSIVE';
  /** "Dynamic": rigid body actively participates in the simulation. */
  enabled: boolean;
  /** "Animated": the body follows the animation system. */
  kinematic: boolean;
  mass: number;
  collisionShape: RigidBodyShape;
  meshSource: 'BASE' | 'DEFORM' | 'FINAL';
  friction: number;
  restitution: number;
  useMargin: boolean;
  collisionMargin: number;
  linearDamping: number;
  angularDamping: number;
  useDeactivation: boolean;
  useStartDeactivated: boolean;
  deactivateLinearVelocity: number;
  deactivateAngularVelocity: number;
  collisionGroups: boolean[];
}

export type RigidBodyConstraintType = 'FIXED' | 'POINT' | 'HINGE' | 'SLIDER' | 'PISTON' | 'GENERIC' | 'GENERIC_SPRING' | 'MOTOR';

export interface RigidBodyConstraint {
  type: RigidBodyConstraintType;
  enabled: boolean;
  disableCollisions: boolean;
  object1: string | null;
  object2: string | null;
  useBreaking: boolean;
  breakingThreshold: number;
  useOverrideSolverIterations: boolean;
  solverIterations: number;
  useLimitAngZ: boolean;
  limitAngZLower: number;
  limitAngZUpper: number;
  useLimitLinX: boolean;
  limitLinXLower: number;
  limitLinXUpper: number;
  useSpringX: boolean;
  useSpringY: boolean;
  useSpringZ: boolean;
  springStiffnessX: number;
  springStiffnessY: number;
  springStiffnessZ: number;
  springDampingX: number;
  springDampingY: number;
  springDampingZ: number;
}

export function defaultRigidBodyWorld(): RigidBodyWorld {
  return {
    enabled: true, timeScale: 1, useSplitImpulse: false, stepsPerSecond: 60, solverIterations: 10,
    pointCache: defaultPointCache(250), effectorWeights: defaultEffectorWeights(),
  };
}

export function defaultRigidBody(type: 'ACTIVE' | 'PASSIVE'): RigidBodyObject {
  const groups = new Array(20).fill(false);
  groups[0] = true;
  return {
    type, enabled: true, kinematic: false, mass: 1, collisionShape: type === 'ACTIVE' ? 'CONVEX_HULL' : 'MESH',
    meshSource: 'BASE', friction: 0.5, restitution: 0, useMargin: false, collisionMargin: 0.04,
    linearDamping: 0.04, angularDamping: 0.1, useDeactivation: false, useStartDeactivated: false,
    deactivateLinearVelocity: 0.4, deactivateAngularVelocity: 0.5, collisionGroups: groups,
  };
}

export function defaultRigidBodyConstraint(type: RigidBodyConstraintType = 'FIXED'): RigidBodyConstraint {
  const q = Math.PI / 4;
  return {
    type, enabled: true, disableCollisions: true, object1: null, object2: null, useBreaking: false, breakingThreshold: 10,
    useOverrideSolverIterations: false, solverIterations: 10,
    useLimitAngZ: false, limitAngZLower: -q, limitAngZUpper: q, useLimitLinX: false, limitLinXLower: -1, limitLinXUpper: 1,
    useSpringX: false, useSpringY: false, useSpringZ: false, springStiffnessX: 10, springStiffnessY: 10, springStiffnessZ: 10,
    springDampingX: 0.5, springDampingY: 0.5, springDampingZ: 0.5,
  };
}

// ------------------------------------------------------------------ force fields

export type FieldType = 'NONE' | 'FORCE' | 'WIND' | 'VORTEX' | 'MAGNET' | 'HARMONIC' | 'CHARGE' | 'LENNARDJ' | 'TURBULENCE' | 'DRAG' | 'TEXTURE' | 'GUIDE' | 'BOID' | 'SMOKE_FLOW';

export interface FieldSettings {
  type: FieldType;
  shape: 'POINT' | 'PLANE' | 'SURFACE' | 'POINTS';
  strength: number;
  flow: number;
  noise: number;
  seed: number;
  applyToLocation: boolean;
  applyToRotation: boolean;
  useAbsorption: boolean;
  falloffType: 'SPHERE' | 'TUBE' | 'CONE';
  zDirection: 'BOTH' | 'POSITIVE' | 'NEGATIVE';
  falloffPower: number;
  useMinDistance: boolean;
  distanceMin: number;
  useMaxDistance: boolean;
  distanceMax: number;
  useRadialMin: boolean;
  radialMin: number;
  useRadialMax: boolean;
  radialMax: number;
  radialFalloff: number;
  /** Vortex (plane shapes): inwards component. */
  inflow: number;
  /** Turbulence noise size. */
  size: number;
  useGlobalCoords: boolean;
  harmonicDamping: number;
  restLength: number;
  useMultipleSprings: boolean;
  linearDrag: number;
  quadraticDrag: number;
}

export function defaultField(type: FieldType = 'FORCE'): FieldSettings {
  return {
    type, shape: 'POINT', strength: 1, flow: 0, noise: 0, seed: 1 + Math.floor(Math.random() * 127), applyToLocation: true,
    applyToRotation: true, useAbsorption: false, falloffType: 'SPHERE', zDirection: 'BOTH', falloffPower: 0,
    useMinDistance: false, distanceMin: 0, useMaxDistance: false, distanceMax: 0, useRadialMin: false, radialMin: 0,
    useRadialMax: false, radialMax: 0, radialFalloff: 0, inflow: 0, size: 1, useGlobalCoords: false, harmonicDamping: 1,
    restLength: 0, useMultipleSprings: false, linearDrag: 1, quadraticDrag: 0,
  };
}

// ------------------------------------------------------------------ collision

export interface CollisionSettings {
  permeability: number;
  stickiness: number;
  useParticleKill: boolean;
  dampingFactor: number;
  dampingRandom: number;
  frictionFactor: number;
  frictionRandom: number;
  thicknessOuter: number;
  thicknessInner: number;
  damping: number;
  absorption: number;
}

export function defaultCollision(): CollisionSettings {
  return {
    permeability: 0, stickiness: 0, useParticleKill: false, dampingFactor: 0, dampingRandom: 0, frictionFactor: 0,
    frictionRandom: 0, thicknessOuter: 0.02, thicknessInner: 0.2, damping: 0.1, absorption: 0,
  };
}

// ------------------------------------------------------------------ cloth

export interface ClothSettings {
  quality: number;
  timeScale: number;
  mass: number;
  structuralStiffness: number;
  bendingStiffness: number;
  springDamping: number;
  airDamping: number;
  velDamping: number;
  usePinCloth: boolean;
  vertexGroupMass: string;
  pinStiffness: number;
  useSewingSprings: boolean;
  useDynamicMesh: boolean;
  shrinkMin: number;
  shrinkMax: number;
  effectorWeights: EffectorWeights;
}

export interface ClothCollisionSettings {
  useCollision: boolean;
  collisionQuality: number;
  distanceMin: number;
  repelForce: number;
  distanceRepel: number;
  friction: number;
  useSelfCollision: boolean;
  selfDistanceMin: number;
  selfFriction: number;
}

export const CLOTH_PRESETS: Record<string, Partial<ClothSettings>> = {
  Cotton: { quality: 5, mass: 0.3, structuralStiffness: 15, bendingStiffness: 0.5, springDamping: 5, airDamping: 1 },
  Denim: { quality: 12, mass: 1, structuralStiffness: 40, bendingStiffness: 10, springDamping: 25, airDamping: 1 },
  Leather: { quality: 15, mass: 0.4, structuralStiffness: 80, bendingStiffness: 150, springDamping: 25, airDamping: 1 },
  Rubber: { quality: 7, mass: 3, structuralStiffness: 15, bendingStiffness: 25, springDamping: 25, airDamping: 1 },
  Silk: { quality: 5, mass: 0.15, structuralStiffness: 5, bendingStiffness: 0.05, springDamping: 0, airDamping: 1 },
};

export function defaultClothSettings(): ClothSettings {
  return {
    quality: 5, timeScale: 1, mass: 0.3, structuralStiffness: 15, bendingStiffness: 0.5, springDamping: 5, airDamping: 1,
    velDamping: 1, usePinCloth: false, vertexGroupMass: '', pinStiffness: 1, useSewingSprings: false, useDynamicMesh: false,
    shrinkMin: 0, shrinkMax: 0, effectorWeights: defaultEffectorWeights(),
  };
}

export function defaultClothCollision(): ClothCollisionSettings {
  return {
    useCollision: true, collisionQuality: 2, distanceMin: 0.015, repelForce: 1, distanceRepel: 0.005, friction: 5,
    useSelfCollision: false, selfDistanceMin: 0.015, selfFriction: 5,
  };
}

// ------------------------------------------------------------------ soft body

export interface SoftBodySettings {
  friction: number;
  mass: number;
  speed: number;
  useGoal: boolean;
  vertexGroupGoal: string;
  goalDefault: number;
  goalMin: number;
  goalMax: number;
  goalSpring: number;
  goalFriction: number;
  useEdges: boolean;
  pull: number;
  push: number;
  damping: number;
  plastic: number;
  bend: number;
  useStiffQuads: boolean;
  shear: number;
  useEdgeCollision: boolean;
  useFaceCollision: boolean;
  useSelfCollision: boolean;
  ballSize: number;
  ballStiff: number;
  ballDamp: number;
  stepMin: number;
  stepMax: number;
  useAutoStep: boolean;
  errorThreshold: number;
  effectorWeights: EffectorWeights;
}

export function defaultSoftBody(): SoftBodySettings {
  return {
    friction: 0.5, mass: 1, speed: 1, useGoal: true, vertexGroupGoal: '', goalDefault: 0.7, goalMin: 0, goalMax: 1,
    goalSpring: 0.5, goalFriction: 0, useEdges: true, pull: 0.5, push: 0.5, damping: 0.5, plastic: 0, bend: 0,
    useStiffQuads: false, shear: 1, useEdgeCollision: false, useFaceCollision: false, useSelfCollision: false,
    ballSize: 0.49, ballStiff: 1, ballDamp: 0.5, stepMin: 10, stepMax: 300, useAutoStep: true, errorThreshold: 0.1,
    effectorWeights: defaultEffectorWeights(),
  };
}

// ------------------------------------------------------------------ particles (extra settings)

export type ParticleRenderType = 'NONE' | 'HALO' | 'LINE' | 'PATH' | 'OBJECT' | 'GROUP' | 'BILLBOARD';
export type ParticlePhysicsType = 'NO' | 'NEWTON' | 'KEYED' | 'BOIDS' | 'FLUID';

/** Particle settings beyond the original emitter fields (all optional in stored files). */
export interface ParticleSettingsExt {
  type?: 'EMITTER' | 'HAIR';
  hairLength?: number;
  hairStep?: number;
  useRegrowHair?: boolean;
  useAdvancedHair?: boolean;
  distribution?: 'JIT' | 'RANDOM' | 'GRID';
  useEvenDistribution?: boolean;
  useEmitRandom?: boolean;
  jitterFactor?: number;
  tangentFactor?: number;
  tangentPhase?: number;
  objectFactor?: number;
  physicsType?: ParticlePhysicsType;
  mass?: number;
  sizeRandom?: number;
  dragFactor?: number;
  brownianFactor?: number;
  dampingFactor?: number;
  timestep?: number;
  subframes?: number;
  useDieOnCollision?: boolean;
  lifetimeRandom?: number;
  renderType?: ParticleRenderType;
  materialSlot?: number;
  useRenderEmitter?: boolean;
  showUnborn?: boolean;
  useDead?: boolean;
  dupliObject?: string | null;
  useGlobalDupli?: boolean;
  useRotationDupli?: boolean;
  useScaleDupli?: boolean;
  renderStep?: number;
  displayStep?: number;
  drawMethod?: 'NONE' | 'RENDER' | 'DOT' | 'CIRC' | 'CROSS' | 'AXIS';
  drawSize?: number;
  drawColor?: 'NONE' | 'MATERIAL' | 'VELOCITY' | 'ACCELERATION';
  childType?: 'NONE' | 'SIMPLE' | 'INTERPOLATED';
  childNbr?: number;
  renderedChildCount?: number;
  childLength?: number;
  childRadius?: number;
  childRoundness?: number;
  childSize?: number;
  clumpFactor?: number;
  clumpShape?: number;
  roughness1?: number;
  roughness1Size?: number;
  roughnessEndpoint?: number;
  roughnessEndShape?: number;
  roughness2?: number;
  roughness2Size?: number;
  roughness2Threshold?: number;
  effectorWeights?: EffectorWeights;
  boidAirSpeedMax?: number;
  boidAirAccMax?: number;
  boidSeparate?: number;
  boidFlock?: number;
  boidGoal?: number;
  boidNeighbours?: number;
  /** Edited hair (Particle Edit mode): per parent strand, the key points in emitter object space. */
  hairKeys?: number[][] | null;
}

/** Particle settings with every optional field filled in. */
export type FullParticleSettings = ParticleSystem & Required<Omit<ParticleSettingsExt, 'hairKeys' | 'dupliObject'>> & { hairKeys: number[][] | null; dupliObject: string | null };

export function particleDefaults(ps: ParticleSystem): Required<Omit<ParticleSettingsExt, 'hairKeys' | 'dupliObject'>> & { hairKeys: number[][] | null; dupliObject: string | null } {
  const hair = ps.type === 'HAIR';
  return {
    type: 'EMITTER', hairLength: 4, hairStep: 5, useRegrowHair: false, useAdvancedHair: false, distribution: 'JIT',
    useEvenDistribution: true, useEmitRandom: true, jitterFactor: 1, tangentFactor: 0, tangentPhase: 0, objectFactor: 0,
    physicsType: 'NEWTON', mass: 1, sizeRandom: 0, dragFactor: 0, brownianFactor: 0, dampingFactor: 0, timestep: 0.04,
    subframes: 0, useDieOnCollision: false, lifetimeRandom: 0, renderType: hair ? 'PATH' : 'HALO', materialSlot: 1,
    useRenderEmitter: true, showUnborn: false, useDead: false, dupliObject: null, useGlobalDupli: false,
    useRotationDupli: false, useScaleDupli: false, renderStep: 3, displayStep: 2, drawMethod: 'RENDER', drawSize: 0,
    drawColor: 'MATERIAL', childType: 'NONE', childNbr: 10, renderedChildCount: 100, childLength: 1, childRadius: 0.2,
    childRoundness: 0, childSize: 1, clumpFactor: 0, clumpShape: 0, roughness1: 0, roughness1Size: 1, roughnessEndpoint: 0,
    roughnessEndShape: 1, roughness2: 0, roughness2Size: 1, roughness2Threshold: 0, effectorWeights: defaultEffectorWeights(),
    boidAirSpeedMax: 10, boidAirAccMax: 0.5, boidSeparate: 1, boidFlock: 1, boidGoal: 0, boidNeighbours: 4, hairKeys: null,
  };
}

/** Read particle settings with defaults for missing fields (does not modify the document). */
export function psFull(ps: ParticleSystem): FullParticleSettings {
  const d = particleDefaults(ps);
  const out = { ...d, ...ps } as FullParticleSettings;
  for (const k of Object.keys(d) as (keyof typeof d)[]) if ((ps as unknown as Record<string, unknown>)[k] === undefined) (out as unknown as Record<string, unknown>)[k] = d[k];
  return out;
}

// ------------------------------------------------------------------ accessors for settings stored in modifiers

export interface ClothModifier extends Modifier {
  settings: ClothSettings;
  collisionSettings: ClothCollisionSettings;
  pointCache: PointCacheSettings;
}

export interface SoftBodyModifier extends Modifier {
  settings: SoftBodySettings;
  pointCache: PointCacheSettings;
}

export function clothOf(mod: Modifier): ClothModifier {
  const m = mod as ClothModifier;
  m.settings = { ...defaultClothSettings(), ...(m.settings ?? {}) };
  m.settings.effectorWeights = { ...defaultEffectorWeights(), ...(m.settings.effectorWeights ?? {}) };
  m.collisionSettings = { ...defaultClothCollision(), ...(m.collisionSettings ?? {}) };
  m.pointCache = { ...defaultPointCache(250), ...(m.pointCache ?? {}) };
  return m;
}

export function softBodyOf(mod: Modifier): SoftBodyModifier {
  const m = mod as SoftBodyModifier;
  m.settings = { ...defaultSoftBody(), ...(m.settings ?? {}) };
  m.settings.effectorWeights = { ...defaultEffectorWeights(), ...(m.settings.effectorWeights ?? {}) };
  m.pointCache = { ...defaultPointCache(250), ...(m.pointCache ?? {}) };
  return m;
}

/** Fill missing fields in physics settings of a loaded document (older files, other versions). */
export function normalizePhysics(scene: Scene, objects: BObject[]): void {
  if (scene.rigidBodyWorld) {
    const w = scene.rigidBodyWorld;
    scene.rigidBodyWorld = { ...defaultRigidBodyWorld(), ...w, pointCache: { ...defaultPointCache(250), ...(w.pointCache ?? {}) }, effectorWeights: { ...defaultEffectorWeights(), ...(w.effectorWeights ?? {}) } };
  }
  for (const ob of objects) {
    if (ob.rigidBody) ob.rigidBody = { ...defaultRigidBody(ob.rigidBody.type ?? 'ACTIVE'), ...ob.rigidBody };
    if (ob.rigidBodyConstraint) ob.rigidBodyConstraint = { ...defaultRigidBodyConstraint(ob.rigidBodyConstraint.type), ...ob.rigidBodyConstraint };
    if (ob.field) ob.field = { ...defaultField(ob.field.type), ...ob.field };
    if (ob.collision) ob.collision = { ...defaultCollision(), ...ob.collision };
    for (const m of ob.modifiers ?? []) {
      if (m.type === 'CLOTH') clothOf(m);
      else if (m.type === 'SOFT_BODY') softBodyOf(m);
    }
  }
}
