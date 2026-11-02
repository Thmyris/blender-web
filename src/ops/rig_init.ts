// Registers the rigging toolset: armatures (object/edit/pose drawing and tools), lattices, vertex
// groups and Weight Paint, the Armature / Lattice / Hook / Mask / Vertex Weight modifiers and their
// panels, plus document upgrades for files saved before these features existed.

import { app, docLoadHooks, type App } from '../app';
import { parentResolvers } from '../core/scene';
import { boneParentMatrix } from '../core/armature';
import '../core/vgroups';
import '../core/rigmods';
import '../editors/view3d/armdraw';
import { ARMATURE_EDIT_OPERATORS } from '../editors/view3d/armedit';
import { POSE_OPERATORS } from '../editors/view3d/pose';
import '../editors/view3d/wpaint';
import { LATTICE_OPERATORS } from '../editors/view3d/latedit';
import { RIG_OPERATORS } from './rig';
import '../editors/properties/rig_panels';

docLoadHooks.push((doc) => {
  doc.armatures ??= {};
  doc.lattices ??= {};
});

parentResolvers.bone = (doc, parent, bone, worldOf) => boneParentMatrix(doc, parent, bone, worldOf);

export function initRig(a: App = app): void {
  for (const def of [...ARMATURE_EDIT_OPERATORS, ...POSE_OPERATORS, ...LATTICE_OPERATORS, ...RIG_OPERATORS]) a.registerOperator(def);
  // the startup document was created before this module ran
  a.doc.armatures ??= {};
  a.doc.lattices ??= {};
}
