// Rigging operators: add armature / lattice, vertex groups (object.vertex_group_*), Ctrl+P armature /
// bone / lattice parenting (with empty, envelope or automatic weights) and hooks (Ctrl+H).

import { Matrix4, Vector3 } from 'three';
import { app, type OperatorDef, type OpProps, type OpContext } from '../app';
import type { BObject, MeshData, Vec3 } from '../core/types';
import { createObject } from '../core/scene';
import { createArmature, defaultBone, armatureOf, boneByName, syncPose, evaluatePose, boneLength, isBoneVisible } from '../core/armature';
import { createLattice } from '../core/lattice';
import {
  activeGroupIndex, addGroup, ensureDvert, getWeight, groupIndex, groupsOf, inGroup, removeGroup, removeWeight, reorderGroups, setWeight,
  uniqueGroupName,
} from '../core/vgroups';
import { automaticWeights, envelopeWeights } from '../core/autoweights';
import { newModifier } from '../core/modifiers';
import { flushSelection, selectModeOf, polyCenter } from '../core/mesh';
import { activeLayer, viewAlignedRotation, viewOf, PARENT_TYPES } from './common';
import { showMenu, type MenuItem } from '../ui/menu';
import { registerKeymap } from '../keymap';
import { flipSideName } from '../editors/view3d/armedit';

// ------------------------------------------------------------------ add objects

function placeNew(ob: BObject, props: OpProps): void {
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

const addProps = {
  view_align: { name: 'Align to View', type: 'bool' as const, default: false },
  enter_editmode: { name: 'Enter Editmode', type: 'bool' as const, default: false, hidden: true },
  location: { name: 'Location', type: 'vector' as const, default: [0, 0, 0], size: 3, subtype: 'TRANSLATION' as const },
  rotation: { name: 'Rotation', type: 'vector' as const, default: [0, 0, 0], size: 3, subtype: 'EULER' as const },
};

function invokeAdd(id: string) {
  return (ctx: OpContext, props: OpProps) => {
    props.location = app.scene.cursor.slice();
    props.view_align = props.view_align || app.prefs.alignNewObjects === 'VIEW';
    props.rotation = props.view_align ? viewAlignedRotation(viewOf(ctx)) : [0, 0, 0];
    props.enter_editmode = app.prefs.enterEditMode;
    return app.operator(id)!.exec!(ctx, props);
  };
}

// ------------------------------------------------------------------ vertex group helpers

/** Object whose vertex groups are edited: the edit / paint object, else the active object. */
export function vgObject(): BObject | null {
  const o = app.editObject && app.mode !== 'OBJECT' && app.mode !== 'POSE' ? app.doc.objects[app.editObject] : app.activeObject;
  return o && o.type === 'MESH' ? o : null;
}
const vgMesh = (): MeshData | null => app.meshOf(vgObject());
const hasGroups = () => !!vgObject()?.vertexGroups?.length;
const inEdit = () => app.mode === 'EDIT' && !!app.editMesh;

/** Vertices the weight tools act on: selected ones in edit mode, all otherwise. */
function targetVerts(md: MeshData): number[] {
  const out: number[] = [];
  const editing = app.mode === 'EDIT';
  for (let v = 0; v < md.verts.length; v++) if (!editing || md.vsel[v]) out.push(v);
  return out;
}

/** Groups the weight tools act on (ACTIVE / ALL / BONE_DEFORM / OTHER_DEFORM). */
function targetGroups(ob: BObject, subset: string): number[] {
  const gs = groupsOf(ob);
  const all = gs.map((_, i) => i);
  if (subset === 'ACTIVE') return activeGroupIndex(ob) >= 0 ? [activeGroupIndex(ob)] : [];
  const deform = deformGroupNames(ob);
  if (subset === 'BONE_DEFORM') return all.filter((i) => deform.has(gs[i].name));
  if (subset === 'OTHER_DEFORM') return all.filter((i) => !deform.has(gs[i].name));
  return all;
}

/** Names of groups that match deforming bones of the armatures deforming the object. */
export function deformGroupNames(ob: BObject): Set<string> {
  const out = new Set<string>();
  for (const m of ob.modifiers) {
    if (m.type !== 'ARMATURE' || !m.object) continue;
    const arm = armatureOf(app.doc, app.doc.objects[m.object as string]);
    for (const b of arm?.bones ?? []) if (b.useDeform) out.add(b.name);
  }
  return out;
}

const subsetProp = { name: 'Subset', type: 'enum' as const, default: 'ACTIVE', items: [['ACTIVE', 'Active Group'], ['BONE_DEFORM', 'Deform Pose Bones'], ['OTHER_DEFORM', 'Other'], ['ALL', 'All Groups']] as [string, string][] };

function vgDone(): 'FINISHED' {
  const md = vgMesh();
  if (md) app.tagGeometry(md.id);
  app.notify('data', 'geometry');
  return 'FINISHED';
}

const vgOp = (o: Omit<OperatorDef, 'undo' | 'register'>): OperatorDef => ({ undo: true, register: true, poll: hasGroups, ...o });

function normalizeVerts(md: MeshData, ob: BObject, verts: number[], groups: number[], lockActive: boolean): void {
  const locked = new Set(groupsOf(ob).map((g, i) => (g.lockWeight ? i : -1)).filter((i) => i >= 0));
  const act = activeGroupIndex(ob);
  for (const v of verts) {
    const dv = md.dvert?.[v];
    if (!dv?.length) continue;
    const free = dv.filter(([g]) => groups.includes(g) && !locked.has(g) && !(lockActive && g === act));
    const fixed = dv.filter(([g]) => !free.some(([f]) => f === g) && groups.includes(g));
    const fixedSum = fixed.reduce((s, [, w]) => s + w, 0);
    const freeSum = free.reduce((s, [, w]) => s + w, 0);
    const target = Math.max(0, 1 - fixedSum);
    if (freeSum > 0) for (const e of free) e[1] = (e[1] / freeSum) * target;
  }
}

/** Mirror weights across X between groups with flipped names (or the same group). */
function mirrorWeights(md: MeshData, ob: BObject, useFlipNames: boolean, allGroups: boolean, onlySelected: boolean): number {
  const n = md.verts.length;
  // vertex -> mirrored vertex by exact (rounded) position
  const key = (p: Vec3) => `${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)},${Math.round(p[2] * 1e4)}`;
  const map = new Map<string, number>();
  md.verts.forEach((p, i) => map.set(key(p), i));
  const gs = groupsOf(ob);
  const groups = allGroups ? gs.map((_, i) => i) : [activeGroupIndex(ob)];
  const old = (md.dvert ?? []).map((dv) => dv.map(([g, w]) => [g, w] as [number, number]));
  let count = 0;
  ensureDvert(md);
  for (let v = 0; v < n; v++) {
    if (onlySelected && !md.vsel[v]) continue;
    const p = md.verts[v];
    const m = map.get(key([-p[0], p[1], p[2]]));
    if (m === undefined) continue;
    for (const g of groups) {
      if (g < 0) continue;
      const mg = useFlipNames ? groupIndex(ob, flipSideName(gs[g].name)) : g;
      const tg = mg >= 0 ? mg : g;
      const src = old[m]?.find(([gi]) => gi === g);
      if (src) setWeight(md, v, tg, src[1]); else if (tg !== g || !old[v]?.some(([gi]) => gi === g)) removeWeight(md, v, tg);
      count++;
    }
  }
  return count;
}

export const VGROUP_OPERATORS: OperatorDef[] = [
  {
    id: 'object.vertex_group_add', label: 'Add Vertex Group', description: 'Add a new vertex group to the active object', undo: true, register: true,
    poll: () => !!vgObject(),
    exec: () => { addGroup(vgObject()!); return vgDone(); },
  },
  vgOp({
    id: 'object.vertex_group_remove', label: 'Remove Vertex Group', description: 'Delete the active or all vertex groups from the active object',
    props: { all: { name: 'All', type: 'bool', default: false } },
    exec: (_c, p) => {
      const ob = vgObject()!, md = vgMesh();
      if (p.all) { ob.vertexGroups = []; ob.activeVertexGroup = 0; if (md) delete md.dvert; }
      else removeGroup(ob, md, activeGroupIndex(ob));
      return vgDone();
    },
  }),
  vgOp({
    id: 'object.vertex_group_set_active', label: 'Set Active Vertex Group', description: 'Set the active vertex group',
    props: { group: { name: 'Group', type: 'string', default: '' } },
    exec: (_c, p) => { const ob = vgObject()!; const i = groupIndex(ob, String(p.group)); if (i < 0) return 'CANCELLED'; ob.activeVertexGroup = i; return vgDone(); },
  }),
  {
    id: 'object.vertex_group_assign', label: 'Assign to Vertex Group', description: 'Assign the selected vertices to the active vertex group', undo: true, register: true,
    poll: () => inEdit() && !!vgObject(),
    props: { weight: { name: 'Weight', type: 'float', default: 1, min: 0, max: 1, hidden: true } },
    exec: (_c, p) => {
      const ob = vgObject()!, md = app.editMesh!;
      if (!ob.vertexGroups?.length) addGroup(ob);
      const g = activeGroupIndex(ob);
      const w = Number(p.weight ?? app.scene.toolSettings.vertexGroupWeight ?? 1);
      md.verts.forEach((_, v) => { if (md.vsel[v]) setWeight(md, v, g, w); });
      return vgDone();
    },
  },
  {
    id: 'object.vertex_group_assign_new', label: 'Assign to New Group', description: 'Assign the selected vertices to a new vertex group', undo: true, register: true,
    poll: () => inEdit() && !!vgObject(),
    exec: () => {
      const ob = vgObject()!, md = app.editMesh!;
      const g = addGroup(ob);
      const w = Number(app.scene.toolSettings.vertexGroupWeight ?? 1);
      md.verts.forEach((_, v) => { if (md.vsel[v]) setWeight(md, v, g, w); });
      return vgDone();
    },
  },
  vgOp({
    id: 'object.vertex_group_remove_from', label: 'Remove from Vertex Group', description: 'Remove the selected vertices from active or all vertex group(s)',
    props: { use_all_groups: { name: 'All Groups', type: 'bool', default: false }, use_all_verts: { name: 'All Verts', type: 'bool', default: false } },
    poll: () => inEdit() && hasGroups(),
    exec: (_c, p) => {
      const ob = vgObject()!, md = app.editMesh!;
      const groups = p.use_all_groups ? groupsOf(ob).map((_, i) => i) : [activeGroupIndex(ob)];
      md.verts.forEach((_, v) => { if (p.use_all_verts || md.vsel[v]) for (const g of groups) if (!groupsOf(ob)[g]?.lockWeight) removeWeight(md, v, g); });
      return vgDone();
    },
  }),
  vgOp({
    id: 'object.vertex_group_select', label: 'Select Vertex Group', description: 'Select all the vertices assigned to the active vertex group', poll: () => inEdit() && hasGroups(),
    exec: () => {
      const ob = vgObject()!, md = app.editMesh!;
      const g = activeGroupIndex(ob);
      md.verts.forEach((_, v) => { if (inGroup(md, v, g) && !md.vhide?.[v]) md.vsel[v] = true; });
      flushSelection(md, 'VERT');
      flushSelection(md, selectModeOf(app.scene.toolSettings.meshSelectMode));
      return vgDone();
    },
  }),
  vgOp({
    id: 'object.vertex_group_deselect', label: 'Deselect Vertex Group', description: 'Deselect all selected vertices assigned to the active vertex group', poll: () => inEdit() && hasGroups(),
    exec: () => {
      const ob = vgObject()!, md = app.editMesh!;
      const g = activeGroupIndex(ob);
      md.verts.forEach((_, v) => { if (inGroup(md, v, g)) md.vsel[v] = false; });
      flushSelection(md, 'VERT');
      return vgDone();
    },
  }),
  vgOp({
    id: 'object.vertex_group_copy', label: 'Copy Vertex Group', description: 'Make a copy of the active vertex group',
    exec: () => {
      const ob = vgObject()!, md = vgMesh();
      const src = activeGroupIndex(ob);
      const g = groupsOf(ob)[src];
      const ni = groupsOf(ob).length;
      groupsOf(ob).push({ name: uniqueGroupName(ob, `${g.name}_copy`), lockWeight: false });
      if (md?.dvert) md.dvert.forEach((dv, v) => { const w = dv.find(([gi]) => gi === src); if (w) setWeight(md, v, ni, w[1]); });
      ob.activeVertexGroup = ni;
      return vgDone();
    },
  }),
  vgOp({
    id: 'object.vertex_group_sort', label: 'Sort Vertex Groups', description: 'Sort vertex groups',
    props: { sort_type: { name: 'Sort type', type: 'enum', default: 'NAME', items: [['NAME', 'Name'], ['BONE_HIERARCHY', 'Bone Hierarchy']] } },
    exec: (_c, p) => {
      const ob = vgObject()!, md = vgMesh();
      const gs = groupsOf(ob);
      let order = gs.map((_, i) => i);
      if (p.sort_type === 'BONE_HIERARCHY') {
        const names: string[] = [];
        for (const m of ob.modifiers) if (m.type === 'ARMATURE' && m.object) for (const b of armatureOf(app.doc, app.doc.objects[m.object as string])?.bones ?? []) names.push(b.name);
        const rank = (n: string) => { const i = names.indexOf(n); return i < 0 ? 1e9 : i; };
        order.sort((a, b) => rank(gs[a].name) - rank(gs[b].name) || gs[a].name.localeCompare(gs[b].name));
      } else order = order.sort((a, b) => gs[a].name.localeCompare(gs[b].name, undefined, { numeric: true }));
      reorderGroups(ob, md, order);
      return vgDone();
    },
  }),
  vgOp({
    id: 'object.vertex_group_move', label: 'Move Vertex Group', description: 'Move the active vertex group up/down in the list',
    props: { direction: { name: 'Direction', type: 'enum', default: 'UP', items: [['UP', 'Up'], ['DOWN', 'Down']] } },
    exec: (_c, p) => {
      const ob = vgObject()!;
      const a = activeGroupIndex(ob), b = a + (p.direction === 'UP' ? -1 : 1);
      if (b < 0 || b >= groupsOf(ob).length) return 'CANCELLED';
      const order = groupsOf(ob).map((_, i) => i);
      order[a] = b; order[b] = a;
      reorderGroups(ob, vgMesh(), order);
      return vgDone();
    },
  }),
  vgOp({
    id: 'object.vertex_group_mirror', label: 'Mirror Vertex Group', description: 'Mirror vertex group, flip weights and/or names, editing only selected vertices, flipping when both sides are selected otherwise copy from unselected',
    props: { use_topology: { name: 'Topology Mirror', type: 'bool', default: false }, flip_group_names: { name: 'Flip Group Names', type: 'bool', default: true }, all_groups: { name: 'All Groups', type: 'bool', default: false } },
    exec: (_c, p) => { mirrorWeights(vgMesh()!, vgObject()!, !!p.flip_group_names, !!p.all_groups, inEdit()); return vgDone(); },
  }),
  vgOp({
    id: 'object.vertex_group_lock', label: 'Change the Lock On Vertex Groups', description: 'Change the lock state of all vertex groups of active object',
    props: { action: { name: 'Action', type: 'enum', default: 'TOGGLE', items: [['TOGGLE', 'Toggle'], ['LOCK', 'Lock'], ['UNLOCK', 'Unlock'], ['INVERT', 'Invert']] } },
    exec: (_c, p) => {
      const gs = groupsOf(vgObject()!);
      const anyLocked = gs.some((g) => g.lockWeight);
      for (const g of gs) {
        if (p.action === 'LOCK') g.lockWeight = true;
        else if (p.action === 'UNLOCK') g.lockWeight = false;
        else if (p.action === 'INVERT') g.lockWeight = !g.lockWeight;
        else g.lockWeight = !anyLocked;
      }
      return vgDone();
    },
  }),
  vgOp({
    id: 'object.vertex_group_normalize', label: 'Normalize Vertex Group', description: 'Normalize weights of the active vertex group, so that the highest ones are now 1.0',
    exec: () => {
      const ob = vgObject()!, md = vgMesh()!;
      const g = activeGroupIndex(ob);
      const vs = targetVerts(md);
      let max = 0;
      for (const v of vs) max = Math.max(max, getWeight(md, v, g));
      if (max <= 0) return 'CANCELLED';
      for (const v of vs) if (inGroup(md, v, g)) setWeight(md, v, g, getWeight(md, v, g) / max);
      return vgDone();
    },
  }),
  vgOp({
    id: 'object.vertex_group_normalize_all', label: 'Normalize All Vertex Groups', description: 'Normalize all weights of all vertex groups, so that for each vertex, the sum of all weights is 1.0',
    props: { group_select_mode: { ...subsetProp, default: 'ALL' }, lock_active: { name: 'Lock Active', type: 'bool', default: true } },
    exec: (_c, p) => { const ob = vgObject()!, md = vgMesh()!; normalizeVerts(md, ob, targetVerts(md), targetGroups(ob, String(p.group_select_mode)), !!p.lock_active); return vgDone(); },
  }),
  vgOp({
    id: 'object.vertex_group_invert', label: 'Invert Vertex Group', description: 'Invert active vertex group\'s weights',
    props: { group_select_mode: subsetProp, auto_assign: { name: 'Add Weights', type: 'bool', default: true }, auto_remove: { name: 'Remove Weights', type: 'bool', default: true } },
    exec: (_c, p) => {
      const ob = vgObject()!, md = vgMesh()!;
      for (const g of targetGroups(ob, String(p.group_select_mode))) {
        if (groupsOf(ob)[g]?.lockWeight) continue;
        for (const v of targetVerts(md)) {
          const has = inGroup(md, v, g);
          if (!has && !p.auto_assign) continue;
          const w = 1 - getWeight(md, v, g);
          if (w <= 0 && p.auto_remove) removeWeight(md, v, g); else setWeight(md, v, g, w);
        }
      }
      return vgDone();
    },
  }),
  vgOp({
    id: 'object.vertex_group_clean', label: 'Clean Vertex Group', description: 'Remove vertex group assignments which are not required',
    props: { group_select_mode: subsetProp, limit: { name: 'Limit', type: 'float', default: 0, min: 0, max: 1, subtype: 'FACTOR' }, keep_single: { name: 'Keep Single', type: 'bool', default: false } },
    exec: (_c, p) => {
      const ob = vgObject()!, md = vgMesh()!;
      const groups = targetGroups(ob, String(p.group_select_mode));
      for (const v of targetVerts(md)) {
        const dv = md.dvert?.[v];
        if (!dv) continue;
        for (let i = dv.length - 1; i >= 0; i--) {
          if (!groups.includes(dv[i][0]) || dv[i][1] > Number(p.limit)) continue;
          if (p.keep_single && dv.length === 1) continue;
          dv.splice(i, 1);
        }
      }
      return vgDone();
    },
  }),
  vgOp({
    id: 'object.vertex_group_quantize', label: 'Quantize Vertex Weights', description: 'Set weights to a fixed number of steps',
    props: { group_select_mode: subsetProp, steps: { name: 'Steps', type: 'int', default: 4, min: 1, max: 1000 } },
    exec: (_c, p) => {
      const ob = vgObject()!, md = vgMesh()!;
      const st = Math.max(1, Number(p.steps));
      for (const g of targetGroups(ob, String(p.group_select_mode))) for (const v of targetVerts(md)) if (inGroup(md, v, g)) setWeight(md, v, g, Math.round(getWeight(md, v, g) * st) / st);
      return vgDone();
    },
  }),
  vgOp({
    id: 'object.vertex_group_levels', label: 'Vertex Group Levels', description: 'Add some offset and multiply with some gain the weights of the active vertex group',
    props: { group_select_mode: subsetProp, offset: { name: 'Offset', type: 'float', default: 0, min: -1, max: 1 }, gain: { name: 'Gain', type: 'float', default: 1, min: 0, max: 100 } },
    exec: (_c, p) => {
      const ob = vgObject()!, md = vgMesh()!;
      for (const g of targetGroups(ob, String(p.group_select_mode))) for (const v of targetVerts(md)) if (inGroup(md, v, g)) setWeight(md, v, g, (getWeight(md, v, g) + Number(p.offset)) * Number(p.gain));
      return vgDone();
    },
  }),
  vgOp({
    id: 'object.vertex_group_smooth', label: 'Smooth Vertex Weights', description: 'Smooth weights for selected vertices',
    props: { group_select_mode: subsetProp, factor: { name: 'Factor', type: 'float', default: 0.5, min: 0, max: 1, subtype: 'FACTOR' }, repeat: { name: 'Iterations', type: 'int', default: 1, min: 1, max: 200 }, expand: { name: 'Expand/Contract', type: 'float', default: 0, min: -1, max: 1 } },
    exec: (_c, p) => {
      const ob = vgObject()!, md = vgMesh()!;
      const nbr: number[][] = md.verts.map(() => []);
      for (const [a, b] of md.edges) { nbr[a].push(b); nbr[b].push(a); }
      const vs = targetVerts(md);
      const f = Number(p.factor), ex = Number(p.expand);
      for (const g of targetGroups(ob, String(p.group_select_mode))) {
        for (let it = 0; it < Number(p.repeat); it++) {
          const cur = md.verts.map((_, v) => getWeight(md, v, g));
          for (const v of vs) {
            if (!nbr[v].length) continue;
            let s = 0;
            for (const n of nbr[v]) s += cur[n];
            let avg = s / nbr[v].length;
            if (ex) avg = ex > 0 ? Math.max(avg, avg + (Math.max(...nbr[v].map((n) => cur[n])) - avg) * ex) : avg + (avg - Math.min(...nbr[v].map((n) => cur[n]))) * ex;
            const w = cur[v] + (avg - cur[v]) * f;
            if (w > 0 || inGroup(md, v, g)) setWeight(md, v, g, w);
          }
        }
      }
      return vgDone();
    },
  }),
  vgOp({
    id: 'object.vertex_group_limit_total', label: 'Limit Number of Weights per Vertex', description: 'Limit deform weights associated with a vertex to a specified number by removing lowest weights',
    props: { group_select_mode: { ...subsetProp, default: 'ALL' }, limit: { name: 'Limit', type: 'int', default: 4, min: 1, max: 32 } },
    exec: (_c, p) => {
      const ob = vgObject()!, md = vgMesh()!;
      const groups = targetGroups(ob, String(p.group_select_mode));
      for (const v of targetVerts(md)) {
        const dv = md.dvert?.[v];
        if (!dv) continue;
        const cand = dv.filter(([g]) => groups.includes(g)).sort((a, b) => b[1] - a[1]);
        for (const e of cand.slice(Number(p.limit))) dv.splice(dv.indexOf(e), 1);
      }
      return vgDone();
    },
  }),
  vgOp({
    id: 'object.vertex_group_remove_from_all', label: 'Remove from All', description: 'Remove the selected vertices from all vertex groups', poll: () => inEdit() && hasGroups(),
    exec: (ctx) => app.operator('object.vertex_group_remove_from')!.exec!(ctx, { use_all_groups: true, use_all_verts: false }) as 'FINISHED',
  }),
];

// ------------------------------------------------------------------ armature / lattice add

export const RIG_ADD_OPERATORS: OperatorDef[] = [
  {
    id: 'object.armature_add', label: 'Add Armature', icon: 'OUTLINER_OB_ARMATURE', undo: true, register: true, description: 'Add an armature object to the scene',
    props: { ...addProps }, invoke: invokeAdd('object.armature_add'),
    poll: () => app.mode === 'OBJECT' || app.mode === 'EDIT' && app.editObj?.type === 'ARMATURE',
    exec: (_c, p) => {
      if (app.mode === 'EDIT') return app.operator('armature.bone_primitive_add')!.exec!(_c, { name: 'Bone' }) as 'FINISHED';
      const arm = createArmature(app.doc, 'Armature');
      const b = defaultBone('Bone', [0, 0, 0], [0, 0, 1]);
      arm.bones.push(b);
      arm.activeBone = b.name;
      const ob = createObject(app.doc, 'ARMATURE', 'Armature', arm.id);
      placeNew(ob, p);
      syncPose(ob, arm);
      if (p.enter_editmode) { app.mode = 'EDIT'; app.editObject = ob.id; b.select = b.selectHead = b.selectTail = true; }
      return 'FINISHED';
    },
  },
  {
    id: 'object.add', label: 'Add Object', undo: true, register: true, description: 'Add an object to the scene',
    props: { type: { name: 'Type', type: 'enum', default: 'LATTICE', items: [['LATTICE', 'Lattice'], ['EMPTY', 'Empty']] }, ...addProps },
    invoke: invokeAdd('object.add'), poll: () => app.mode === 'OBJECT',
    exec: (_c, p) => {
      if (p.type === 'EMPTY') {
        const e = createObject(app.doc, 'EMPTY', 'Empty', null);
        placeNew(e, p);
        return 'FINISHED';
      }
      const lt = createLattice(app.doc, 'Lattice');
      const ob = createObject(app.doc, 'LATTICE', 'Lattice', lt.id);
      placeNew(ob, p);
      if (p.enter_editmode) { app.mode = 'EDIT'; app.editObject = ob.id; }
      return 'FINISHED';
    },
  },
];

// ------------------------------------------------------------------ parenting (Ctrl+P)

const selectedOthers = (): BObject[] => { const act = app.activeObject; return app.selectedObjects().filter((o) => o !== act); };

function parentKeep(child: BObject, parent: BObject, bone?: string): void {
  // Blender's parent inverse: the inverse of the parent's (bone) world matrix at parenting time
  delete child.parentBone;
  child.parent = parent.id;
  let pw = app.matrices.world(parent).clone();
  if (bone) {
    child.parentBone = bone;
    const res = evaluatePose(app.doc, parent, { worldOf: (o) => app.matrices.world(o) });
    const arm = armatureOf(app.doc, parent);
    const b = arm ? boneByName(arm, bone) : undefined;
    const m = res.pose.get(bone);
    if (m && b) pw = pw.multiply(m.clone().multiply(new Matrix4().makeTranslation(0, boneLength(b), 0)));
  }
  child.parentInverse = pw.invert().toArray();
  app.matrices.clear();
}

/** Armature Deform: parent, add an Armature modifier and (optionally) create weighted groups. */
function armatureDeform(mode: 'NONE' | 'NAME' | 'ENVELOPE' | 'AUTO'): 'FINISHED' | 'CANCELLED' {
  const armOb = app.activeObject;
  const arm = armatureOf(app.doc, armOb);
  if (!armOb || !arm) return 'CANCELLED';
  let n = 0;
  for (const ob of selectedOthers()) {
    parentKeep(ob, armOb);
    if (ob.type !== 'MESH' && ob.type !== 'LATTICE') continue;
    if (ob.type === 'MESH') {
      if (!ob.modifiers.some((m) => m.type === 'ARMATURE' && m.object === armOb.id)) {
        const mod = newModifier('ARMATURE', ob.modifiers);
        mod.object = armOb.id;
        ob.modifiers.unshift(mod);
      }
      if (mode !== 'NONE') createBoneGroups(ob, armOb, mode);
      app.tagGeometry(ob.data);
    }
    n++;
  }
  app.notify('data', 'geometry');
  return n || selectedOthers().length ? 'FINISHED' : 'CANCELLED';
}

/** Create a vertex group for every deforming bone and fill it (NAME: empty, ENVELOPE, AUTO). */
export function createBoneGroups(ob: BObject, armOb: BObject, mode: 'NAME' | 'ENVELOPE' | 'AUTO'): void {
  const arm = armatureOf(app.doc, armOb)!;
  const md = app.meshOf(ob);
  if (!md) return;
  const bones = arm.bones.filter((b) => b.useDeform && isBoneVisible(arm, b));
  const gIdx = bones.map((b) => { const i = groupIndex(ob, b.name); return i >= 0 ? i : addGroup(ob, b.name); });
  if (mode === 'NAME') return;
  // mesh vertices in armature (rest) space
  const toArm = app.matrices.world(armOb).clone().invert().multiply(app.matrices.world(ob));
  const verts = md.verts.map((v) => { const p = new Vector3(v[0], v[1], v[2]).applyMatrix4(toArm); return [p.x, p.y, p.z] as Vec3; });
  const ws = mode === 'AUTO' ? automaticWeights(verts, md.edges, bones) : envelopeWeights(verts, bones);
  ensureDvert(md);
  bones.forEach((_, bi) => {
    const g = gIdx[bi];
    const w = ws[bi];
    for (let v = 0; v < md.verts.length; v++) {
      if (w[v] > 0) setWeight(md, v, g, w[v]);
      else removeWeight(md, v, g);
    }
  });
  ob.activeVertexGroup = gIdx[gIdx.length - 1] ?? 0;
}

function latticeDeform(): 'FINISHED' | 'CANCELLED' {
  const lob = app.activeObject;
  if (!lob || lob.type !== 'LATTICE') return 'CANCELLED';
  for (const ob of selectedOthers()) {
    parentKeep(ob, lob);
    if (ob.type !== 'MESH') continue;
    if (!ob.modifiers.some((m) => m.type === 'LATTICE' && m.object === lob.id)) {
      const mod = newModifier('LATTICE', ob.modifiers);
      mod.object = lob.id;
      ob.modifiers.push(mod);
    }
    app.tagGeometry(ob.data);
  }
  return 'FINISHED';
}

function boneParent(): 'FINISHED' | 'CANCELLED' {
  const armOb = app.activeObject;
  const arm = armatureOf(app.doc, armOb);
  if (!armOb || !arm?.activeBone || !boneByName(arm, arm.activeBone)) { app.report('ERROR', 'No active bone'); return 'CANCELLED'; }
  for (const ob of selectedOthers()) parentKeep(ob, armOb, arm.activeBone);
  return 'FINISHED';
}

const activeIsArmature = () => app.mode === 'OBJECT' || app.mode === 'POSE' ? app.activeObject?.type === 'ARMATURE' && selectedOthers().length > 0 : false;
PARENT_TYPES.push(
  {
    id: 'ARMATURE', label: 'Armature Deform', poll: activeIsArmature,
    sub: [
      { label: 'With Empty Groups', props: { type: 'ARMATURE_NAME' } },
      { label: 'With Envelope Weights', props: { type: 'ARMATURE_ENVELOPE' } },
      { label: 'With Automatic Weights', props: { type: 'ARMATURE_AUTO' } },
    ],
    exec: () => armatureDeform('NONE'),
  },
  { id: 'ARMATURE_NAME', label: 'With Empty Groups', poll: () => false, exec: () => armatureDeform('NAME') },
  { id: 'ARMATURE_ENVELOPE', label: 'With Envelope Weights', poll: () => false, exec: () => armatureDeform('ENVELOPE') },
  { id: 'ARMATURE_AUTO', label: 'With Automatic Weights', poll: () => false, exec: () => armatureDeform('AUTO') },
  { id: 'BONE', label: 'Bone', poll: () => activeIsArmature() && !!armatureOf(app.doc, app.activeObject)?.activeBone, exec: boneParent },
  { id: 'LATTICE', label: 'Lattice Deform', poll: () => app.mode === 'OBJECT' && app.activeObject?.type === 'LATTICE' && selectedOthers().length > 0, exec: latticeDeform },
);

// ------------------------------------------------------------------ hooks (Ctrl+H)

function selectedVertsCenter(md: MeshData): Vec3 | null {
  const sel = md.verts.map((_, i) => i).filter((i) => md.vsel[i]);
  if (!sel.length) return null;
  const c = polyCenter(md.verts, sel);
  return c;
}

function addHook(ob: BObject, md: MeshData, hookOb: BObject): void {
  const mod = newModifier('HOOK', ob.modifiers);
  mod.name = `Hook-${hookOb.name}`;
  mod.object = hookOb.id;
  mod.vertexIndices = md.verts.map((_, i) => i).filter((i) => md.vsel[i]);
  mod.center = selectedVertsCenter(md) ?? [0, 0, 0];
  // inverse of (object^-1 * hook) at assignment: the hook starts with no effect
  const m = app.matrices.world(ob).clone().invert().multiply(app.matrices.world(hookOb));
  mod.matrixInverse = m.invert().toArray();
  ob.modifiers.push(mod);
  app.tagGeometry(md.id);
}

export const HOOK_OPERATORS: OperatorDef[] = [
  {
    id: 'object.hook_add_newob', label: 'Hook to New Object', description: 'Hook selected vertices to a newly created object', undo: true, register: true,
    poll: () => app.mode === 'EDIT' && !!app.editMesh?.vsel.some(Boolean),
    exec: () => {
      const ob = app.editObj!, md = app.editMesh!;
      const c = selectedVertsCenter(md)!;
      const wp = new Vector3(...c).applyMatrix4(app.matrices.world(ob));
      const e = createObject(app.doc, 'EMPTY', 'Empty', null);
      e.location = [wp.x, wp.y, wp.z];
      e.layers = ob.layers.slice();
      app.scene.objects.push(e.id);
      app.matrices.clear();
      addHook(ob, md, e);
      return 'FINISHED';
    },
  },
  {
    id: 'object.hook_add_selob', label: 'Hook to Selected Object', description: 'Hook selected vertices to the first selected object', undo: true, register: true,
    props: { use_bone: { name: 'Active Bone', type: 'bool', default: false } },
    poll: () => app.mode === 'EDIT' && !!app.editMesh?.vsel.some(Boolean) && app.selectedObjects().some((o) => o.id !== app.editObject),
    exec: () => {
      const ob = app.editObj!, md = app.editMesh!;
      const other = app.selectedObjects().find((o) => o.id !== ob.id)!;
      addHook(ob, md, other);
      return 'FINISHED';
    },
  },
  {
    id: 'object.hook_reset', label: 'Reset Hook', description: 'Recalculate and clear offset transformation', undo: true, register: true,
    props: { modifier: { name: 'Modifier', type: 'string', default: '' } },
    poll: () => !!app.activeObject?.modifiers.some((m) => m.type === 'HOOK'),
    exec: (_c, p) => {
      const ob = app.editObj ?? app.activeObject!;
      const mod = ob.modifiers.find((m) => m.type === 'HOOK' && (!p.modifier || m.name === p.modifier));
      const h = mod?.object ? app.doc.objects[mod.object as string] : null;
      if (!mod || !h) return 'CANCELLED';
      mod.matrixInverse = app.matrices.world(ob).clone().invert().multiply(app.matrices.world(h)).invert().toArray();
      app.tagGeometry(ob.data);
      return 'FINISHED';
    },
  },
  {
    id: 'object.hook_recenter', label: 'Recenter Hook', description: 'Set hook center to cursor position', undo: true, register: true,
    props: { modifier: { name: 'Modifier', type: 'string', default: '' } },
    poll: () => !!app.activeObject?.modifiers.some((m) => m.type === 'HOOK'),
    exec: (_c, p) => {
      const ob = app.editObj ?? app.activeObject!;
      const mod = ob.modifiers.find((m) => m.type === 'HOOK' && (!p.modifier || m.name === p.modifier));
      if (!mod) return 'CANCELLED';
      const c = new Vector3(...app.scene.cursor).applyMatrix4(app.matrices.world(ob).clone().invert());
      mod.center = [c.x, c.y, c.z];
      app.tagGeometry(ob.data);
      return 'FINISHED';
    },
  },
  {
    id: 'object.hook_assign', label: 'Assign to Hook', description: 'Assign the selected vertices to a hook', undo: true, register: true,
    props: { modifier: { name: 'Modifier', type: 'string', default: '' } },
    poll: () => app.mode === 'EDIT' && !!app.editObj?.modifiers.some((m) => m.type === 'HOOK'),
    exec: (_c, p) => {
      const ob = app.editObj!, md = app.editMesh!;
      const mod = ob.modifiers.find((m) => m.type === 'HOOK' && (!p.modifier || m.name === p.modifier));
      if (!mod) return 'CANCELLED';
      mod.vertexIndices = md.verts.map((_, i) => i).filter((i) => md.vsel[i]);
      app.tagGeometry(md.id);
      return 'FINISHED';
    },
  },
  {
    id: 'object.hook_select', label: 'Select Hook', description: 'Select affected vertices on mesh', undo: true, register: true,
    props: { modifier: { name: 'Modifier', type: 'string', default: '' } },
    poll: () => app.mode === 'EDIT' && !!app.editObj?.modifiers.some((m) => m.type === 'HOOK'),
    exec: (_c, p) => {
      const ob = app.editObj!, md = app.editMesh!;
      const mod = ob.modifiers.find((m) => m.type === 'HOOK' && (!p.modifier || m.name === p.modifier));
      if (!mod) return 'CANCELLED';
      for (const i of (mod.vertexIndices as number[]) ?? []) if (i < md.verts.length) md.vsel[i] = true;
      flushSelection(md, 'VERT');
      app.tagGeometry(md.id);
      return 'FINISHED';
    },
  },
];

// ------------------------------------------------------------------ menus and keys

const op = (label: string, id: string, props?: Record<string, unknown>): MenuItem => ({ label, op: id, props });

export function vertexGroupsMenu(): MenuItem[] {
  return [
    op('Assign to New Group', 'object.vertex_group_assign_new'),
    { type: 'separator' },
    op('Assign to Active Group', 'object.vertex_group_assign'),
    op('Remove from Active Group', 'object.vertex_group_remove_from', { use_all_groups: false }),
    op('Remove from All', 'object.vertex_group_remove_from', { use_all_groups: true }),
    { type: 'separator' },
    op('Set Active Group', 'object.vertex_group_set_active'),
    op('Remove Active Group', 'object.vertex_group_remove', { all: false }),
    op('Remove All Groups', 'object.vertex_group_remove', { all: true }),
  ];
}

export function hooksMenu(): MenuItem[] {
  const ob = app.editObj;
  const hooks = ob?.modifiers.filter((m) => m.type === 'HOOK') ?? [];
  return [
    op('Hook to New Object', 'object.hook_add_newob'),
    op('Hook to Selected Object', 'object.hook_add_selob', { use_bone: false }),
    ...(hooks.length ? [
      { type: 'separator' } as MenuItem,
      ...hooks.flatMap((m): MenuItem[] => [
        op(`Reset ${m.name}`, 'object.hook_reset', { modifier: m.name }),
        op(`Recenter ${m.name}`, 'object.hook_recenter', { modifier: m.name }),
        op(`Select ${m.name}`, 'object.hook_select', { modifier: m.name }),
        op(`Assign to ${m.name}`, 'object.hook_assign', { modifier: m.name }),
      ]),
    ] : []),
  ];
}

registerKeymap([
  { code: 'KeyG', space: 'VIEW_3D', mode: 'EDIT', ctrl: true, title: 'Vertex Groups', menu: vertexGroupsMenu, poll: () => !!app.editMesh },
  { code: 'KeyH', space: 'VIEW_3D', mode: 'EDIT', ctrl: true, title: 'Hooks', menu: hooksMenu, poll: () => !!app.editMesh },
]);

export const RIG_OPERATORS: OperatorDef[] = [...RIG_ADD_OPERATORS, ...VGROUP_OPERATORS, ...HOOK_OPERATORS];
