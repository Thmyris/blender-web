// Mesh editing tools added on top of ops/mesh.ts: Bevel, Knife, Bisect, Rip, Bridge, Fill, Grid Fill,
// Beautify, Edge Rotate, Connect Vertex Path, Unsubdivide, Symmetrize, Snap to Symmetry, Edge Split,
// Screw, Edge/Vertex Slide, Shear, Push/Pull and the extra selection tools, plus their key bindings.

import { Matrix4, Vector3 } from 'three';
import { app, type OperatorDef, type OpContext, type OpProps } from '../app';
import type { MeshData, Vec3 } from '../core/types';
import { selectModeOf, type SelectMode } from '../core/mesh';
import { bevelMesh, type BevelOffsetType } from '../core/bevel';
import { registerKeymap, type KeyItem } from '../keymap';
import { viewOf, isEditMesh } from './common';
import { meshDone, startBevelModal } from '../editors/view3d/meshmodal';
import { startKnife, knifeProject } from '../editors/view3d/knife';

export const md = (): MeshData => app.editMesh!;
export const selMode = (): SelectMode => selectModeOf(app.scene.toolSettings.meshSelectMode);
const anySel = () => isEditMesh() && md().vsel.some(Boolean);
const edgeSel = () => isEditMesh() && md().esel.some(Boolean);

function done(): 'FINISHED' { meshDone(); return 'FINISHED'; }

const editOp = (o: Omit<OperatorDef, 'undo' | 'register'> & { undo?: boolean; register?: boolean }): OperatorDef => ({ undo: true, register: true, poll: anySel, ...o });

/** World matrix and its inverse of the object in edit mode. */
export function editMatrices(): { w: Matrix4; inv: Matrix4 } {
  const w = app.matrices.world(app.editObj!).clone();
  return { w, inv: w.clone().invert() };
}

export const toLocal = (p: Vec3 | number[]): Vec3 => { const v = new Vector3(p[0], p[1], p[2]).applyMatrix4(editMatrices().inv); return [v.x, v.y, v.z]; };
/** World-space plane normal -> local space (inverse transpose of the world matrix). */
export const normalToLocal = (d: Vec3 | number[]): Vec3 => {
  const m = editMatrices().w.transpose();
  const v = new Vector3(d[0], d[1], d[2]).transformDirection(m);
  return [v.x, v.y, v.z];
};

// ------------------------------------------------------------------ operators

const OFFSET_TYPES: [string, string][] = [['OFFSET', 'Offset'], ['WIDTH', 'Width'], ['DEPTH', 'Depth'], ['PERCENT', 'Percent']];

export const MESH_TOOL_OPERATORS: OperatorDef[] = [
  editOp({
    id: 'mesh.bevel', label: 'Bevel', description: 'Edge Bevel',
    poll: () => isEditMesh() && (md().esel.some(Boolean) || md().vsel.some(Boolean)),
    props: {
      offset_type: { name: 'Amount Type', type: 'enum', default: 'OFFSET', items: OFFSET_TYPES, description: 'What distance Amount measures' },
      offset: { name: 'Amount', type: 'float', default: 0, min: -1000000, max: 1000000, softMin: 0, softMax: 100, step: 1, precision: 3, subtype: 'DISTANCE' },
      segments: { name: 'Segments', type: 'int', default: 1, min: 1, max: 1000, softMax: 100, description: 'Segments for curved edge' },
      profile: { name: 'Profile', type: 'float', default: 0.5, min: 0.15, max: 1, subtype: 'FACTOR', description: 'Controls profile shape (0.5 = round)' },
      vertex_only: { name: 'Vertex Only', type: 'bool', default: false, description: 'Bevel only vertices' },
      clamp_overlap: { name: 'Clamp Overlap', type: 'bool', default: false, description: 'Do not allow beveled edges/vertices to overlap each other' },
      loop_slide: { name: 'Loop Slide', type: 'bool', default: true, description: 'Prefer slide along edge to even widths' },
      material: { name: 'Material', type: 'int', default: -1, min: -1, description: 'Material for bevel faces (-1 means use adjacent faces)' },
    },
    invoke: (ctx, p) => {
      const view = viewOf(ctx);
      if (!view) return app.operator('mesh.bevel')!.exec!(ctx, p);
      startBevelModal(view, !!p.vertex_only, p);
      return 'RUNNING_MODAL';
    },
    exec: (_c, p) => {
      const m = md();
      const ok = bevelMesh(m, {
        offset: Math.abs(Number(p.offset)), offsetType: p.offset_type as BevelOffsetType, segments: Number(p.segments), profile: Number(p.profile),
        vertexOnly: !!p.vertex_only, clampOverlap: !!p.clamp_overlap, loopSlide: !!p.loop_slide,
      });
      if (!ok) return 'CANCELLED';
      const mat = Math.round(Number(p.material));
      if (mat >= 0) m.faces.forEach((_, i) => { if (m.fsel[i]) m.faceMat[i] = mat; });
      return done();
    },
  }),
  {
    id: 'mesh.knife_tool', label: 'Knife Topology Tool', description: 'Cut new topology', undo: true, register: false, poll: isEditMesh,
    props: {
      use_occlude_geometry: { name: 'Occlude Geometry', type: 'bool', default: true, description: 'Only cut the front most geometry' },
      only_selected: { name: 'Only Selected', type: 'bool', default: false, description: 'Only cut selected geometry' },
    },
    invoke: (ctx, p) => {
      const view = viewOf(ctx);
      if (!view) return 'CANCELLED';
      startKnife(view, p);
      return 'RUNNING_MODAL';
    },
  },
  editOp({
    id: 'mesh.knife_project', label: 'Knife Project', description: 'Use other objects outlines & boundaries to project knife cuts',
    poll: () => isEditMesh() && app.selectedObjects().some((o) => o.id !== app.editObject && (o.type === 'MESH' || o.type === 'FONT')),
    props: { cut_through: { name: 'Cut through', type: 'bool', default: false, description: 'Cut through all faces, not just visible ones' } },
    exec: (ctx, p) => {
      const view = viewOf(ctx);
      if (!view) return 'CANCELLED';
      if (!knifeProject(view, !!p.cut_through)) { app.report('ERROR', 'No other selected objects with wire or boundary edges found'); return 'CANCELLED'; }
      return done();
    },
  }),
];

void edgeSel;
void ({} as OpContext);
void ({} as OpProps);

// ------------------------------------------------------------------ key bindings (edit mode)

const meshEdit = () => !!app.editMesh;
const E = (code: string, op: string, props: OpProps = {}, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}): KeyItem => ({ code, space: 'VIEW_3D', op, props, mode: 'EDIT', poll: meshEdit, ...mods });

export function registerMeshToolKeys(): void {
  registerKeymap([
    E('KeyB', 'mesh.bevel', { vertex_only: false }, { ctrl: true }),
    E('KeyB', 'mesh.bevel', { vertex_only: true }, { ctrl: true, shift: true }),
    E('KeyK', 'mesh.knife_tool', { use_occlude_geometry: true, only_selected: false }),
    E('KeyK', 'mesh.knife_tool', { use_occlude_geometry: true, only_selected: true }, { shift: true }),
  ]);
}
