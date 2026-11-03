// Physics simulations (rigid body, cloth, soft body, collision, force fields,
// particles and hair). Importing this module installs the simulation hooks
// (world-matrix override, simulation modifiers, cache providers) and returns
// the operators to register.

import { docLoadHooks } from '../app';
import type { OperatorDef } from '../app';
import { SIM_OPERATORS } from './ops';
import { normalizePhysics } from './types';
import './rigidbody';
import './cloth';
import './particles';

docLoadHooks.push((doc) => {
  for (const sc of doc.scenes) normalizePhysics(sc, sc.objects.map((id) => doc.objects[id]).filter((o) => !!o));
});

export const PHYSICS_OPERATORS: OperatorDef[] = SIM_OPERATORS;
export { syncSimDrawing, emitterHiddenInRender } from './draw';
export { drawTimelineCaches, bakeProgress } from './cache';
