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
import {
  beautifyFaces, bisectMesh, bridgeEdgeLoops, connectVertexPath, edgeSplitSelected, fillLoops, gridFill, rotateEdges,
  snapToSymmetry, symmetrize, unsubdivide, type SymDirection,
} from '../core/meshtools';

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

// ------------------------------------------------------------------ edge / face / vertex tools

const SYM_DIRS: [string, string][] = [['NEGATIVE_X', '-X to +X'], ['POSITIVE_X', '+X to -X'], ['NEGATIVE_Y', '-Y to +Y'], ['POSITIVE_Y', '+Y to -Y'], ['NEGATIVE_Z', '-Z to +Z'], ['POSITIVE_Z', '+Z to -Z']];

/** Run an algorithm returning an error message (or null on success). */
function errOrDone(err: string | null): 'FINISHED' | 'CANCELLED' {
  if (err) { app.report('ERROR', err); return 'CANCELLED'; }
  return done();
}

/** Run an algorithm returning a count of changed elements. */
function countOrDone(n: number, none: string): 'FINISHED' | 'CANCELLED' {
  if (!n) { app.report('WARNING', none); return 'CANCELLED'; }
  return done();
}

export const MESH_EXTRA_OPERATORS: OperatorDef[] = [
  editOp({
    id: 'mesh.bridge_edge_loops', label: 'Bridge Edge Loops', description: 'Make faces between two or more edge loops', poll: edgeSel,
    props: {
      number_cuts: { name: 'Number of Cuts', type: 'int', default: 0, min: 0, max: 1000 },
      twist_offset: { name: 'Twist', type: 'int', default: 0, min: -1000, max: 1000 },
      smoothness: { name: 'Smoothness', type: 'float', default: 1, min: 0, max: 1000 },
    },
    exec: (_c, p) => errOrDone(bridgeEdgeLoops(md(), { cuts: Number(p.number_cuts), twist: Number(p.twist_offset), smoothness: Number(p.smoothness) })),
  }),
  editOp({
    id: 'mesh.fill', label: 'Fill', description: 'Fill a selected edge loop with faces', poll: edgeSel,
    props: { use_beauty: { name: 'Beauty', type: 'bool', default: true, description: 'Use best triangulation division' } },
    exec: (_c, p) => countOrDone(fillLoops(md(), !!p.use_beauty), 'No closed edge loop to fill'),
  }),
  editOp({
    id: 'mesh.beautify_fill', label: 'Beautify Faces', description: 'Rearrange some faces to try to get less degenerated geometry',
    props: { angle_limit: { name: 'Max Angle', type: 'float', default: Math.PI, min: 0, max: Math.PI, subtype: 'ANGLE' } },
    exec: (_c, p) => { beautifyFaces(md(), Number(p.angle_limit)); return done(); },
  }),
  editOp({
    id: 'mesh.fill_grid', label: 'Grid Fill', description: 'Fill grid from two loops', poll: edgeSel,
    props: { span: { name: 'Span', type: 'int', default: 1, min: 1, max: 1000 }, offset: { name: 'Offset', type: 'int', default: 0, min: -1000, max: 1000 } },
    exec: (_c, p) => errOrDone(gridFill(md(), Number(p.span), Number(p.offset))),
  }),
  editOp({
    id: 'mesh.edge_rotate', label: 'Rotate Selected Edge', description: 'Rotate selected edge or adjoining faces', poll: edgeSel,
    props: { use_ccw: { name: 'Counter Clockwise', type: 'bool', default: false } },
    exec: (_c, p) => countOrDone(rotateEdges(md(), !p.use_ccw), 'Could not rotate the selected edges (each needs exactly two adjacent faces)'),
  }),
  editOp({
    id: 'mesh.edge_split', label: 'Edge Split', description: 'Split selected edges so that each neighbor face gets its own copy', poll: edgeSel,
    exec: () => countOrDone(edgeSplitSelected(md()), 'No edges to split'),
  }),
  editOp({
    id: 'mesh.vert_connect_path', label: 'Vertex Connect Path', description: 'Connect vertices by their selection order, creating edges, splitting faces',
    exec: () => countOrDone(connectVertexPath(md()), 'Select at least two vertices to connect'),
  }),
  editOp({
    id: 'mesh.unsubdivide', label: 'Un-Subdivide', description: 'UnSubdivide selected edges & faces',
    props: { iterations: { name: 'Iterations', type: 'int', default: 2, min: 1, max: 1000 } },
    exec: (_c, p) => errOrDone(unsubdivide(md(), Number(p.iterations), true)),
  }),
  editOp({
    id: 'mesh.symmetrize', label: 'Symmetrize', description: 'Enforce symmetry (both form and topological) across an axis',
    props: {
      direction: { name: 'Direction', type: 'enum', default: 'NEGATIVE_X', items: SYM_DIRS },
      threshold: { name: 'Threshold', type: 'float', default: 0.0001, min: 0, max: 10 },
    },
    exec: (_c, p) => {
      const dir = p.direction as SymDirection;
      // like Blender, first cut faces crossing the mirror plane so none are lost
      const no: Vec3 = dir.endsWith('X') ? [1, 0, 0] : dir.endsWith('Y') ? [0, 1, 0] : [0, 0, 1];
      bisectMesh(md(), [0, 0, 0], no, { threshold: Number(p.threshold) });
      return symmetrize(md(), dir, Number(p.threshold)) ? done() : 'CANCELLED';
    },
  }),
  editOp({
    id: 'mesh.symmetry_snap', label: 'Snap to Symmetry', description: 'Snap vertex pairs to their mirrored locations',
    props: {
      direction: { name: 'Direction', type: 'enum', default: 'NEGATIVE_X', items: SYM_DIRS },
      threshold: { name: 'Threshold', type: 'float', default: 0.05, min: 0, max: 10 },
      factor: { name: 'Factor', type: 'float', default: 0.5, min: 0, max: 1 },
      use_center: { name: 'Center', type: 'bool', default: true, description: 'Snap middle vertices to the axis center' },
    },
    exec: (_c, p) => countOrDone(snapToSymmetry(md(), p.direction as SymDirection, Number(p.threshold), Number(p.factor), !!p.use_center), 'No mirrored vertex pairs found'),
  }),
  editOp({
    id: 'mesh.bisect', label: 'Bisect', description: 'Cut geometry along a plane (through the 3D cursor, facing the view; adjust in the redo panel)',
    props: {
      plane_co: { name: 'Plane Point', type: 'vector', default: [0, 0, 0], size: 3, subtype: 'TRANSLATION' },
      plane_no: { name: 'Plane Normal', type: 'vector', default: [1, 0, 0], size: 3, subtype: 'XYZ' },
      use_fill: { name: 'Fill', type: 'bool', default: false, description: 'Fill in the cut' },
      clear_inner: { name: 'Clear Inner', type: 'bool', default: false, description: 'Remove geometry behind the plane' },
      clear_outer: { name: 'Clear Outer', type: 'bool', default: false, description: 'Remove geometry in front of the plane' },
      threshold: { name: 'Axis Threshold', type: 'float', default: 0.0001, min: 0, max: 10 },
    },
    invoke: (ctx, p) => {
      p.plane_co = app.scene.cursor.slice();
      const view = viewOf(ctx);
      // a vertical cut as seen from the view: the plane normal is the view's right vector
      if (view) { const r = new Vector3(1, 0, 0).applyQuaternion(view.view.rot); p.plane_no = [r.x, r.y, r.z]; }
      return app.operator('mesh.bisect')!.exec!(ctx, p);
    },
    exec: (_c, p) => {
      const ok = bisectMesh(md(), toLocal(p.plane_co as Vec3), normalToLocal(p.plane_no as Vec3), {
        fill: !!p.use_fill, clearInner: !!p.clear_inner, clearOuter: !!p.clear_outer, threshold: Number(p.threshold),
      });
      if (!ok) { app.report('WARNING', 'The plane does not cut the selection'); return 'CANCELLED'; }
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
    E('KeyF', 'mesh.fill', {}, { alt: true }),
    E('KeyF', 'mesh.beautify_fill', {}, { alt: true, shift: true }),
    E('KeyJ', 'mesh.vert_connect_path'),
  ]);
}
