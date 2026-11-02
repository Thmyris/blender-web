// UV operators (bpy.ops.uv.*, mesh seams and UV map slots) and image datablock operators
// (bpy.ops.image.*), plus the menus that call them: the 3D View's U "UV Mapping" menu and the
// UV/Image Editor's UVs / Select / Image menus. The modal UV editor tools (select, border,
// transforms) live in editors/uvedit.

import { Vector3, Matrix4 } from 'three';
import { app, type OperatorDef, type OpContext, type OpProps, type OpPropDef } from '../app';
import type { BImage, MeshData, MeshUVLayer, Vec3 } from '../core/types';
import { edgeKey, flushSelection, selectModeOf } from '../core/mesh';
import {
  UV_PIN, UV_SELECT, activeUVIndex, addUVLayer, cornerUV, ensureFlags, removeUVLayer, seamSet, setSeamsFromSet,
} from '../core/uvdata';
import {
  averageIslandScale, boundsFit, cubeProject, followActiveQuads, lightmapPack, minimizeStretch, packIslands, resetFaces,
  seamsFromIslands, smartProject, unwrapFaces, wrapProject,
} from '../core/unwrap';
import '../core/uvtransfer';
import {
  cornerSelected, isSync, selectAllUV, selectedCorners, selectedIslands, setCorners, uvContext, uvSettings,
  vertFacesOf, visibleFaces, visibleIslands, syncSelectCorners,
} from '../editors/uvedit/uvsel';
import { viewOf } from './common';
import { showMenu, type MenuItem } from '../ui/menu';
import { uvMappingMenu, uvSnapMenu, uvWeldAlignMenu } from '../editors/uvedit/uvmenus';
import { showDialog } from '../ui/popup';
import {
  createImage, getImage, openImageFile, reloadImage, saveImageAs, uniqueImageName,
} from '../paint/images';
import { registerKeymap, type KeyItem } from '../keymap';

// ------------------------------------------------------------------ context helpers

const isEditMesh = () => app.mode === 'EDIT' && !!app.editMesh;
const hasUV = () => isEditMesh() && !!uvContext();
const hasUVSel = () => hasUV() && selectedCorners(uvContext()!.md, uvContext()!.layer).length > 0;
const faceSelected = () => isEditMesh() && app.editMesh!.fsel.some((s, i) => s && !app.editMesh!.fhide?.[i]);

function done(md?: MeshData | null): 'FINISHED' {
  const m = md ?? app.editMesh;
  if (m) app.tagGeometry(m.id);
  app.notify('geometry', 'select', 'data');
  return 'FINISHED';
}

/** Faces affected by the unwrap / projection operators: selected, visible faces. */
function unwrapFacesOf(md: MeshData): number[] {
  const out: number[] = [];
  md.faces.forEach((_, f) => { if (md.fsel[f] && !md.fhide?.[f]) out.push(f); });
  return out;
}

/** Image shown in a UV/Image Editor (used for aspect correction and pixel snapping). */
export function uvEditorImage(ctx?: OpContext | null): BImage | null {
  const areas = app.screen?.areas() ?? [];
  const order = ctx?.area ? [ctx.area, ...areas] : areas;
  for (const a of order) {
    if (a.type !== 'IMAGE_EDITOR') continue;
    const st = (a.editor as { state?: Record<string, unknown> }).state;
    const img = getImage(typeof st?.image === 'string' ? st.image : null);
    if (img) return img;
  }
  return null;
}

/** Image aspect (width / height) for "Correct Aspect". */
function imageAspect(ctx?: OpContext | null): number {
  const img = uvEditorImage(ctx);
  return img && img.height > 0 ? img.width / img.height : 1;
}

function selectUnwrapped(md: MeshData, layer: MeshUVLayer, faces: number[]): void {
  const fl = ensureFlags(md, layer);
  for (const f of faces) for (let k = 0; k < fl[f].length; k++) fl[f][k] |= UV_SELECT;
}

function correctAspect(md: MeshData, layer: MeshUVLayer, faces: number[], aspect: number): void {
  if (Math.abs(aspect - 1) < 1e-6) return;
  for (const f of faces) {
    const u = layer.uv[f];
    for (let k = 0; k < md.faces[f].length; k++) {
      if (aspect > 1) u[k * 2] = 0.5 + (u[k * 2] - 0.5) / aspect;
      else u[k * 2 + 1] = 0.5 + (u[k * 2 + 1] - 0.5) * aspect;
    }
  }
}

function warnScale(): void {
  const ob = app.editObj;
  if (!ob) return;
  const s = ob.scale;
  if (Math.abs(s[0] - s[1]) > 1e-4 || Math.abs(s[1] - s[2]) > 1e-4) app.report('INFO', 'Object has non-uniform scale, unwrap will operate on a non-scaled version of the mesh');
}

/** Pivot centre (object space) used by the cylinder / sphere projections. */
function projectionCenter(md: MeshData): Vec3 {
  const ob = app.editObj!;
  if (app.scene.toolSettings.pivotPoint === 'CURSOR') {
    const p = new Vector3(...app.scene.cursor).applyMatrix4(app.matrices.world(ob).clone().invert());
    return [p.x, p.y, p.z];
  }
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  md.verts.forEach((v, i) => { if (!md.vsel[i]) return; for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], v[a]); mx[a] = Math.max(mx[a], v[a]); } });
  if (!isFinite(mn[0])) return [0, 0, 0];
  return [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
}

/** Axis frame (object space) for cylinder / sphere projections. */
function projectionFrame(ctx: OpContext, direction: string, align: string): [Vec3, Vec3, Vec3] {
  const ob = app.editObj!;
  const inv = new Matrix4().copy(app.matrices.world(ob)).invert();
  const toLocal = (v: Vector3) => { const r = v.clone().transformDirection(inv).normalize(); return [r.x, r.y, r.z] as Vec3; };
  const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const view = viewOf(ctx);
  if (direction === 'ALIGN_TO_OBJECT' || !view) {
    return align === 'POLAR_ZY' ? [[0, 1, 0], [-1, 0, 0], [0, 0, 1]] : [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  }
  const v = view.view;
  if (direction === 'VIEW_ON_POLES') {
    const Z = toLocal(v.viewDir().negate());
    const X = toLocal(align === 'POLAR_ZY' ? v.viewUp() : v.viewRight());
    return [X, cross(Z, X), Z];
  }
  const Z = toLocal(v.viewUp());
  const X = toLocal(align === 'POLAR_ZY' ? v.viewRight() : v.viewDir().negate());
  return [X, cross(Z, X), Z];
}

const boolP = (name: string, def: boolean, description?: string): OpPropDef => ({ name, type: 'bool', default: def, description });
const boundsProps: Record<string, OpPropDef> = {
  correct_aspect: boolP('Correct Aspect', true, 'Map UVs taking image aspect ratio into account'),
  clip_to_bounds: boolP('Clip to Bounds', false, 'Clip UV coordinates to bounds after unwrapping'),
  scale_to_bounds: boolP('Scale to Bounds', false, 'Scale UV coordinates to bounds after unwrapping'),
};

function finishProjection(ctx: OpContext, md: MeshData, layer: MeshUVLayer, faces: number[], p: OpProps): void {
  if (p.correct_aspect) correctAspect(md, layer, faces, imageAspect(ctx));
  boundsFit(md, layer, faces, !!p.scale_to_bounds, !!p.clip_to_bounds);
  selectUnwrapped(md, layer, faces);
}

/** Common body of the unwrap / projection operators. */
function uvOp(o: Omit<OperatorDef, 'exec' | 'undo' | 'register' | 'poll'> & { run: (ctx: OpContext, p: OpProps, md: MeshData, layer: MeshUVLayer, faces: number[]) => boolean | void; allFaces?: boolean }): OperatorDef {
  return {
    ...o, undo: true, register: true, poll: isEditMesh,
    exec: (ctx, p) => {
      const c = uvContext(true);
      if (!c) return 'CANCELLED';
      const faces = o.allFaces ? c.md.faces.map((_, i) => i).filter((i) => !c.md.fhide?.[i]) : unwrapFacesOf(c.md);
      if (!faces.length) { app.report('WARNING', 'No faces selected'); return 'CANCELLED'; }
      if (o.run(ctx, p, c.md, c.layer, faces) === false) return 'CANCELLED';
      return done(c.md);
    },
  };
}

// ------------------------------------------------------------------ 3D View: unwrap & project

export const UV_OPERATORS: OperatorDef[] = [
  {
    id: 'mesh.mark_seam', label: 'Mark Seam', description: '(Un)mark selected edges as a seam', undo: true, register: true,
    poll: () => isEditMesh() && app.editMesh!.esel.some(Boolean),
    props: { clear: boolP('Clear', false) },
    exec: (_c, p) => {
      const md = app.editMesh!;
      const s = seamSet(md);
      md.edges.forEach((e, i) => { if (!md.esel[i]) return; const k = edgeKey(e[0], e[1]); if (p.clear) s.delete(k); else s.add(k); });
      setSeamsFromSet(md, s);
      return done(md);
    },
  },
  uvOp({
    id: 'uv.unwrap', label: 'Unwrap', description: 'Unwrap the mesh of the object being edited',
    props: {
      method: { name: 'Method', type: 'enum', default: 'ANGLE_BASED', items: [['ANGLE_BASED', 'Angle Based'], ['CONFORMAL', 'Conformal']], description: 'Unwrapping method (Angle Based usually gives better results than Conformal, while being somewhat slower)' },
      fill_holes: boolP('Fill Holes', true, 'Virtual fill holes in mesh before unwrapping, to better avoid overlaps and preserve symmetry'),
      correct_aspect: boolP('Correct Aspect', true, 'Map UVs taking image aspect ratio into account'),
      use_subsurf_data: boolP('Use Subsurf Modifier', false, 'Map UVs taking vertex position after Subdivision Surface modifier has been applied'),
      margin: { name: 'Margin', type: 'float', default: 0.001, min: 0, max: 1, description: 'Space between islands' },
    },
    run: (ctx, p, md, layer, faces) => {
      warnScale();
      const t0 = performance.now();
      const r = unwrapFaces(md, layer, faces, { method: p.method as 'ANGLE_BASED', usePins: true, aspect: p.correct_aspect ? imageAspect(ctx) : 1, margin: Number(p.margin) });
      selectUnwrapped(md, layer, faces);
      if (performance.now() - t0 > 2000) app.report('INFO', `Unwrapped ${r.islands} islands`);
    },
  }),
  uvOp({
    id: 'uv.smart_project', label: 'Smart UV Project', description: 'This script projection unwraps the selected faces of a mesh (it operates on all selected mesh objects, and can be used to unwrap selected faces, or all faces)',
    props: {
      angle_limit: { name: 'Angle Limit', type: 'float', default: 66, min: 1, max: 89, description: 'Lower for more projection groups, higher for less distortion' },
      island_margin: { name: 'Island Margin', type: 'float', default: 0, min: 0, max: 1, description: 'Margin to reduce bleed from adjacent islands' },
      user_area_weight: { name: 'Area Weight', type: 'float', default: 0, min: 0, max: 1, description: 'Weight projections vector by faces with larger areas' },
      use_aspect: boolP('Correct Aspect', true, 'Map UVs taking image aspect ratio into account'),
      stretch_to_bounds: boolP('Stretch to UV Bounds', true, 'Stretch the final output to texture bounds'),
    },
    run: (ctx, p, md, layer, faces) => {
      smartProject(md, layer, faces, Number(p.angle_limit), Number(p.island_margin), Number(p.user_area_weight));
      if (p.use_aspect) correctAspect(md, layer, faces, imageAspect(ctx));
      if (p.stretch_to_bounds) boundsFit(md, layer, faces, true, false);
      selectUnwrapped(md, layer, faces);
    },
  }),
  {
    id: 'uv.lightmap_pack', label: 'Lightmap Pack', description: 'Pack each face\'s UVs into the UV bounds', undo: true, register: true, poll: isEditMesh,
    props: {
      PREF_CONTEXT: { name: 'Selection', type: 'enum', default: 'SEL_FACES', items: [['SEL_FACES', 'Selected Faces'], ['ALL_FACES', 'All Faces']] },
      PREF_PACK_IN_ONE: boolP('Share Tex Space', true, 'Objects Share texture space, map all objects into 1 uvmap'),
      PREF_NEW_UVLAYER: boolP('New UV Map', false, 'Create a new UV map for every mesh packed'),
      PREF_APPLY_IMAGE: boolP('New Image', false, 'Assign new images for every mesh (only one if shared tex space enabled)'),
      PREF_IMG_PX_SIZE: { name: 'Image Size', type: 'int', default: 512, min: 64, max: 5000, description: 'Width and Height for the new image' },
      PREF_BOX_DIV: { name: 'Pack Quality', type: 'int', default: 12, min: 1, max: 48, description: 'Pre Packing before the complex boxpack' },
      PREF_MARGIN_DIV: { name: 'Margin', type: 'float', default: 0.1, min: 0.001, max: 1, description: 'Size of the margin as a division of the UV' },
    },
    exec: (ctx, p) => {
      const md = app.editMesh!;
      if (p.PREF_NEW_UVLAYER) addUVLayer(md, 'lightmap');
      const c = uvContext(true)!;
      const faces = p.PREF_CONTEXT === 'ALL_FACES' ? md.faces.map((_, i) => i).filter((i) => !md.fhide?.[i]) : unwrapFacesOf(md);
      if (!faces.length) { app.report('WARNING', 'No faces selected'); return 'CANCELLED'; }
      lightmapPack(md, c.layer, faces, Number(p.PREF_MARGIN_DIV) / Math.max(1, Number(p.PREF_BOX_DIV)));
      selectUnwrapped(md, c.layer, faces);
      if (p.PREF_APPLY_IMAGE) {
        const px = Math.round(Number(p.PREF_IMG_PX_SIZE));
        const img = createImage({ name: 'lightmap', width: px, height: px, color: [0, 0, 0, 1], alpha: false, generatedType: 'BLANK' });
        showImageInEditors(img.id, ctx);
      }
      return done(md);
    },
  },
  {
    id: 'uv.follow_active_quads', label: 'Follow Active Quads', description: 'Follow UVs from active quads along continuous face loops', undo: true, register: true,
    poll: () => isEditMesh() && app.editMesh!.activeFace >= 0,
    props: { mode: { name: 'Edge Length Mode', type: 'enum', default: 'LENGTH_AVERAGE', items: [['EVEN', 'Even'], ['LENGTH', 'Length'], ['LENGTH_AVERAGE', 'Length Average']], description: 'Method to space UV edge loops' } },
    exec: (_c, p) => {
      const c = uvContext(true)!;
      const faces = unwrapFacesOf(c.md);
      if (!followActiveQuads(c.md, c.layer, faces, c.md.activeFace, p.mode as 'EVEN')) { app.report('ERROR', 'Active face must be a quad'); return 'CANCELLED'; }
      selectUnwrapped(c.md, c.layer, faces.filter((f) => c.md.faces[f].length === 4));
      return done(c.md);
    },
  },
  uvOp({
    id: 'uv.cube_project', label: 'Cube Projection', description: 'Project the UV vertices of the mesh over the six faces of a cube',
    props: { cube_size: { name: 'Cube Size', type: 'float', default: 1, min: 0, max: 1000, subtype: 'DISTANCE', description: 'Size of the cube to project on' }, ...boundsProps },
    run: (ctx, p, md, layer, faces) => { cubeProject(md, layer, faces, Number(p.cube_size), [0, 0, 0]); finishProjection(ctx, md, layer, faces, p); },
  }),
  uvOp({
    id: 'uv.cylinder_project', label: 'Cylinder Projection', description: 'Project the UV vertices of the mesh over the curved wall of a cylinder',
    props: {
      direction: { name: 'Direction', type: 'enum', default: 'VIEW_ON_EQUATOR', items: [['VIEW_ON_EQUATOR', 'View on Equator'], ['VIEW_ON_POLES', 'View on Poles'], ['ALIGN_TO_OBJECT', 'Align to Object']], description: 'Direction of the sphere or cylinder' },
      align: { name: 'Align', type: 'enum', default: 'POLAR_ZX', items: [['POLAR_ZX', 'Polar ZX'], ['POLAR_ZY', 'Polar ZY']], description: 'How to determine rotation around the pole' },
      radius: { name: 'Radius', type: 'float', default: 1, min: 0, subtype: 'DISTANCE', description: 'Radius of the sphere or cylinder' },
      ...boundsProps,
    },
    run: (ctx, p, md, layer, faces) => { wrapProject(md, layer, faces, 'CYLINDER', projectionCenter(md), projectionFrame(ctx, String(p.direction), String(p.align)), Number(p.radius)); finishProjection(ctx, md, layer, faces, p); },
  }),
  uvOp({
    id: 'uv.sphere_project', label: 'Sphere Projection', description: 'Project the UV vertices of the mesh over the curved surface of a sphere',
    props: {
      direction: { name: 'Direction', type: 'enum', default: 'VIEW_ON_EQUATOR', items: [['VIEW_ON_EQUATOR', 'View on Equator'], ['VIEW_ON_POLES', 'View on Poles'], ['ALIGN_TO_OBJECT', 'Align to Object']], description: 'Direction of the sphere or cylinder' },
      align: { name: 'Align', type: 'enum', default: 'POLAR_ZX', items: [['POLAR_ZX', 'Polar ZX'], ['POLAR_ZY', 'Polar ZY']], description: 'How to determine rotation around the pole' },
      ...boundsProps,
    },
    run: (ctx, p, md, layer, faces) => { wrapProject(md, layer, faces, 'SPHERE', projectionCenter(md), projectionFrame(ctx, String(p.direction), String(p.align)), 1); finishProjection(ctx, md, layer, faces, p); },
  }),
  uvOp({
    id: 'uv.project_from_view', label: 'Project From View', description: 'Project the UV vertices of the mesh as seen in current 3D view',
    props: {
      orthographic: boolP('Orthographic', false, 'Use orthographic projection'),
      camera_bounds: boolP('Camera Bounds', true, 'Map UVs to the camera region taking resolution and aspect into account'),
      ...boundsProps,
    },
    run: (ctx, p, md, layer, faces) => {
      const view = viewOf(ctx);
      if (!view) { app.report('ERROR', 'No 3D View to project from'); return false; }
      const v = view.view;
      const world = app.matrices.world(app.editObj!);
      const w = v.width, hgt = v.height;
      const frame = v.persp === 'CAMERA' && p.camera_bounds ? (v as unknown as { frame?: { x: number; y: number; w: number; h: number } }).frame : null;
      const right = v.viewRight(), up = v.viewUp();
      const s = Math.max(w, hgt);
      let oc: Vector3 | null = null;
      if (p.orthographic) {
        oc = new Vector3();
        let n = 0;
        for (const f of faces) for (const vi of md.faces[f]) { oc.add(new Vector3(...md.verts[vi]).applyMatrix4(world)); n++; }
        oc.multiplyScalar(1 / Math.max(1, n));
      }
      const ps = oc ? v.pixelSize(oc) : 1;
      for (const f of faces) {
        layer.uv[f] = md.faces[f].flatMap((vi) => {
          const pw = new Vector3(...md.verts[vi]).applyMatrix4(world);
          if (oc) {
            const d = pw.clone().sub(oc);
            return [0.5 + d.dot(right) / (ps * s), 0.5 + d.dot(up) / (ps * s)];
          }
          const pr = v.project(pw);
          if (frame && frame.w > 0 && frame.h > 0) return [(pr.x - frame.x) / frame.w, 1 - (pr.y - frame.y) / frame.h];
          return [0.5 + (pr.x - w / 2) / s, 0.5 - (pr.y - hgt / 2) / s];
        });
      }
      finishProjection(ctx, md, layer, faces, { ...p, correct_aspect: false });
    },
  }),
  uvOp({
    id: 'uv.reset', label: 'Reset', description: 'Reset UV projection',
    run: (_ctx, _p, md, layer, faces) => { resetFaces(md, layer, faces); selectUnwrapped(md, layer, faces); },
  }),
  // ---- UV map slots (Data tab > UV Maps)
  {
    id: 'mesh.uv_texture_add', label: 'Add UV Map', description: 'Add UV Map', undo: true, register: true, icon: 'ZOOMIN',
    poll: () => app.activeObject?.type === 'MESH' && !!app.meshOf(app.activeObject),
    exec: () => {
      const md = app.meshOf(app.activeObject)!;
      if ((md.uvLayers?.length ?? 0) >= 8) { app.report('WARNING', 'Cannot add more than 8 UV maps'); return 'CANCELLED'; }
      addUVLayer(md, 'UVMap');
      return done(md);
    },
  },
  {
    id: 'mesh.uv_texture_remove', label: 'Remove UV Map', description: 'Remove UV Map', undo: true, register: true, icon: 'ZOOMOUT',
    poll: () => !!app.meshOf(app.activeObject)?.uvLayers?.length,
    exec: () => {
      const md = app.meshOf(app.activeObject)!;
      removeUVLayer(md, activeUVIndex(md));
      return done(md);
    },
  },
];

// ------------------------------------------------------------------ UV editor operators

const selAction = { name: 'Action', type: 'enum' as const, default: 'TOGGLE', items: [['TOGGLE', 'Toggle'], ['SELECT', 'Select'], ['DESELECT', 'Deselect'], ['INVERT', 'Invert']] as [string, string][] };

/** Selected corners grouped by mesh vertex (for weld / stitch / remove doubles). */
function selectedByVertex(md: MeshData, layer: MeshUVLayer): Map<number, [number, number][]> {
  const m = new Map<number, [number, number][]>();
  for (const [f, k] of selectedCorners(md, layer)) {
    const v = md.faces[f][k];
    const l = m.get(v);
    if (l) l.push([f, k]); else m.set(v, [[f, k]]);
  }
  return m;
}

function setUV(layer: MeshUVLayer, f: number, k: number, u: number, v: number): void {
  const a = layer.uv[f];
  if (!a) return;
  a[k * 2] = u; a[k * 2 + 1] = v;
}

const uvEditOp = (o: Omit<OperatorDef, 'undo' | 'register'> & { undo?: boolean; register?: boolean }): OperatorDef => ({ undo: true, register: true, poll: hasUV, ...o });

export const UV_EDITOR_OPERATORS: OperatorDef[] = [
  uvEditOp({
    id: 'uv.select_all', label: '(De)select All', description: 'Change selection of all UV vertices',
    props: { action: selAction },
    exec: (_c, p) => { const c = uvContext()!; selectAllUV(c.md, c.layer, p.action as 'TOGGLE'); return done(c.md); },
  }),
  uvEditOp({
    id: 'uv.select_linked', label: 'Select Linked', description: 'Select all UV vertices linked to the active UV map',
    props: { extend: boolP('Extend', false) },
    exec: () => {
      const c = uvContext()!;
      const isl = selectedIslands(c.md, c.layer);
      const corners = isl.flat().flatMap((f) => c.md.faces[f].map((_, k) => [f, k] as [number, number]));
      if (isSync()) syncSelectCorners(c.md, corners, true, 'FACE'); else setCorners(c.md, c.layer, corners, true);
      return done(c.md);
    },
  }),
  uvEditOp({
    id: 'uv.select_linked_pick', label: 'Select Linked Pick', description: 'Select all UV vertices linked under the mouse',
    props: { extend: boolP('Extend', false), deselect: boolP('Deselect', false), location: { name: 'Location', type: 'vector', size: 2, default: [0, 0], description: 'Mouse location in normalized coordinates, 0.0 to 1.0 is within the image bounds' } },
    exec: (_c, p) => {
      const c = uvContext()!;
      const [lu, lv] = p.location as number[];
      let best = -1, bd = Infinity;
      for (const f of visibleFaces(c.md)) c.md.faces[f].forEach((_, k) => { const q = cornerUV(c.layer, f, k); const d = Math.hypot(q[0] - lu, q[1] - lv); if (d < bd) { bd = d; best = f; } });
      if (best < 0) return 'CANCELLED';
      const isl = visibleIslands(c.md, c.layer).find((i) => i.includes(best)) ?? [best];
      if (!p.extend && !p.deselect) selectAllUV(c.md, c.layer, 'DESELECT');
      const corners = isl.flatMap((f) => c.md.faces[f].map((_, k) => [f, k] as [number, number]));
      if (isSync()) syncSelectCorners(c.md, corners, !p.deselect, 'FACE'); else setCorners(c.md, c.layer, corners, !p.deselect);
      return done(c.md);
    },
  }),
  uvEditOp({
    id: 'uv.select_pinned', label: 'Selected Pinned', description: 'Select all pinned UV vertices',
    exec: () => {
      const c = uvContext()!;
      const corners: [number, number][] = [];
      for (const f of visibleFaces(c.md)) c.md.faces[f].forEach((_, k) => { if ((c.layer.flag?.[f]?.[k] ?? 0) & UV_PIN) corners.push([f, k]); });
      if (isSync()) syncSelectCorners(c.md, corners, true, 'VERT'); else setCorners(c.md, c.layer, corners, true);
      return done(c.md);
    },
  }),
  uvEditOp({
    id: 'uv.pin', label: 'Pin', description: 'Set/clear selected UV vertices as anchored between multiple unwrap operations', poll: hasUVSel,
    props: { clear: boolP('Clear', false, 'Clear pinning for the selection instead of setting it') },
    exec: (_c, p) => {
      const c = uvContext()!;
      const fl = ensureFlags(c.md, c.layer);
      for (const [f, k] of selectedCorners(c.md, c.layer)) { if (p.clear) fl[f][k] &= ~UV_PIN; else fl[f][k] |= UV_PIN; }
      return done(c.md);
    },
  }),
  uvEditOp({
    id: 'uv.weld', label: 'Weld', description: 'Weld selected UV vertices together', poll: hasUVSel,
    exec: () => {
      const c = uvContext()!;
      const sel = selectedCorners(c.md, c.layer);
      let cu = 0, cv = 0;
      for (const [f, k] of sel) { const q = cornerUV(c.layer, f, k); cu += q[0]; cv += q[1]; }
      cu /= sel.length; cv /= sel.length;
      for (const [f, k] of sel) setUV(c.layer, f, k, cu, cv);
      return done(c.md);
    },
  }),
  uvEditOp({
    id: 'uv.align', label: 'Align', description: 'Align selected UV vertices to an axis', poll: hasUVSel,
    props: { axis: { name: 'Axis', type: 'enum', default: 'ALIGN_AUTO', items: [['ALIGN_S', 'Straighten'], ['ALIGN_T', 'Straighten X'], ['ALIGN_U', 'Straighten Y'], ['ALIGN_AUTO', 'Align Auto'], ['ALIGN_X', 'Align X'], ['ALIGN_Y', 'Align Y']], description: 'Axis to align UV locations on' } },
    exec: (_c, p) => {
      const c = uvContext()!;
      const sel = selectedCorners(c.md, c.layer);
      const pts = sel.map(([f, k]) => cornerUV(c.layer, f, k));
      let mnu = Infinity, mxu = -Infinity, mnv = Infinity, mxv = -Infinity, cu = 0, cv = 0;
      for (const q of pts) { mnu = Math.min(mnu, q[0]); mxu = Math.max(mxu, q[0]); mnv = Math.min(mnv, q[1]); mxv = Math.max(mxv, q[1]); cu += q[0]; cv += q[1]; }
      cu /= pts.length; cv /= pts.length;
      let axis = String(p.axis);
      if (axis === 'ALIGN_AUTO') axis = mxu - mnu < mxv - mnv ? 'ALIGN_X' : 'ALIGN_Y';
      if (axis === 'ALIGN_S' || axis === 'ALIGN_T' || axis === 'ALIGN_U') {
        // straighten: project onto the line between the two extreme points
        let a = 0, b = 0, bd = -1;
        for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) { const d = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]); if (d > bd) { bd = d; a = i; b = j; } }
        const A = pts[a], B = pts[b];
        const dx = B[0] - A[0], dy = B[1] - A[1], l2 = dx * dx + dy * dy || 1;
        sel.forEach(([f, k], i) => {
          const q = pts[i];
          if (axis === 'ALIGN_T') { const t = dy ? (q[1] - A[1]) / dy : 0; setUV(c.layer, f, k, A[0] + dx * t, q[1]); return; }
          if (axis === 'ALIGN_U') { const t = dx ? (q[0] - A[0]) / dx : 0; setUV(c.layer, f, k, q[0], A[1] + dy * t); return; }
          const t = ((q[0] - A[0]) * dx + (q[1] - A[1]) * dy) / l2;
          setUV(c.layer, f, k, A[0] + dx * t, A[1] + dy * t);
        });
      } else {
        sel.forEach(([f, k], i) => { if (axis === 'ALIGN_X') setUV(c.layer, f, k, cu, pts[i][1]); else setUV(c.layer, f, k, pts[i][0], cv); });
      }
      return done(c.md);
    },
  }),
  uvEditOp({
    id: 'uv.remove_doubles', label: 'Remove Doubles UV', description: 'Selected UV vertices that are within a radius of each other are welded together', poll: hasUVSel,
    props: { threshold: { name: 'Merge Distance', type: 'float', default: 0.02, min: 0, max: 10, description: 'Maximum distance between welded vertices' }, use_unselected: boolP('Unselected', false, 'Merge selected to other unselected vertices') },
    exec: (_c, p) => {
      const c = uvContext()!;
      const thr = Number(p.threshold);
      const sel = selectedCorners(c.md, c.layer);
      const pts = sel.map(([f, k]) => cornerUV(c.layer, f, k));
      const used = new Array(sel.length).fill(false);
      let merged = 0;
      for (let i = 0; i < sel.length; i++) {
        if (used[i]) continue;
        const grp = [i];
        for (let j = i + 1; j < sel.length; j++) if (!used[j] && Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]) <= thr) { grp.push(j); used[j] = true; }
        if (grp.length < 2) continue;
        let u = 0, v = 0;
        for (const g of grp) { u += pts[g][0]; v += pts[g][1]; }
        for (const g of grp) setUV(c.layer, sel[g][0], sel[g][1], u / grp.length, v / grp.length);
        merged += grp.length - 1;
      }
      void merged;
      return done(c.md);
    },
  }),
  uvEditOp({
    id: 'uv.stitch', label: 'Stitch', description: 'Stitch selected UV vertices by proximity', poll: hasUVSel,
    props: {
      use_limit: boolP('Use Limit', false, 'Stitch UVs within a specified limit distance'),
      limit: { name: 'Limit', type: 'float', default: 0.01, min: 0, max: 10, description: 'Limit distance in normalized coordinates' },
      snap_islands: boolP('Snap Islands', true, 'Snap islands together (on edge stitch mode, rotates the islands too)'),
      midpoint_snap: boolP('Snap At Midpoint', false, 'UVs are stitched at midpoint instead of at static island'),
    },
    exec: (_c, p) => {
      const c = uvContext()!;
      const groups = selectedByVertex(c.md, c.layer);
      const lim = Number(p.limit);
      // corners of the vertex that sit at different UV locations are brought together
      groups.forEach((corners) => {
        if (corners.length < 2) return;
        const pts = corners.map(([f, k]) => cornerUV(c.layer, f, k));
        if (p.use_limit) {
          const far = pts.some((q) => Math.hypot(q[0] - pts[0][0], q[1] - pts[0][1]) > lim);
          if (far) return;
        }
        let tu: number, tv: number;
        if (p.midpoint_snap) { tu = pts.reduce((s, q) => s + q[0], 0) / pts.length; tv = pts.reduce((s, q) => s + q[1], 0) / pts.length; }
        else { tu = pts[0][0]; tv = pts[0][1]; }
        for (const [f, k] of corners) setUV(c.layer, f, k, tu, tv);
      });
      return done(c.md);
    },
  }),
  uvEditOp({
    id: 'uv.average_islands_scale', label: 'Average Islands Scale', description: 'Average the size of separate UV islands, based on their area in 3D space', poll: hasUVSel,
    exec: () => { const c = uvContext()!; averageIslandScale(c.md, c.layer, selectedIslands(c.md, c.layer)); return done(c.md); },
  }),
  uvEditOp({
    id: 'uv.pack_islands', label: 'Pack Islands', description: 'Transform all islands so that they fill up the UV space as much as possible', poll: hasUVSel,
    props: { rotate: boolP('Rotate', true, 'Rotate islands for best fit'), margin: { name: 'Margin', type: 'float', default: 0.001, min: 0, max: 1, description: 'Space between islands' } },
    exec: (ctx, p) => {
      const c = uvContext()!;
      const isl = selectedIslands(c.md, c.layer);
      packIslands(c.md, c.layer, isl, Number(p.margin), !!p.rotate);
      correctAspect(c.md, c.layer, isl.flat(), imageAspect(ctx));
      return done(c.md);
    },
  }),
  uvEditOp({
    id: 'uv.minimize_stretch', label: 'Minimize Stretch', description: 'Reduce UV stretching by relaxing angles', poll: hasUVSel,
    props: {
      fill_holes: boolP('Fill Holes', true, 'Virtual fill holes in mesh before unwrapping, to better avoid overlaps and preserve symmetry'),
      blend: { name: 'Blend', type: 'float', default: 0, min: 0, max: 1, subtype: 'FACTOR', description: 'Blend factor between stretch minimized and original' },
      iterations: { name: 'Iterations', type: 'int', default: 0, min: 0, max: 10000, description: 'Number of iterations to run, 0 is unlimited when run interactively' },
    },
    exec: (_c, p) => {
      const c = uvContext()!;
      const faces = [...new Set(selectedCorners(c.md, c.layer).map(([f]) => f))];
      minimizeStretch(c.md, c.layer, faces, Number(p.iterations) || 20, Number(p.blend));
      return done(c.md);
    },
  }),
  uvEditOp({
    id: 'uv.snap_selected', label: 'Snap Selection', description: 'Snap selected UV vertices to the target type', poll: hasUVSel,
    props: { target: { name: 'Target', type: 'enum', default: 'PIXELS', items: [['PIXELS', 'Pixels'], ['CURSOR', 'Cursor'], ['CURSOR_OFFSET', 'Cursor (Offset)'], ['ADJACENT_UNSELECTED', 'Adjacent Unselected']], description: 'Target to snap the selected UVs to' } },
    exec: (ctx, p) => {
      const c = uvContext()!;
      const sel = selectedCorners(c.md, c.layer);
      const cur = uvSettings().cursor;
      if (p.target === 'PIXELS') {
        const img = uvEditorImage(ctx);
        const w = img?.width ?? 256, h = img?.height ?? 256;
        for (const [f, k] of sel) { const q = cornerUV(c.layer, f, k); setUV(c.layer, f, k, Math.round(q[0] * w) / w, Math.round(q[1] * h) / h); }
      } else if (p.target === 'CURSOR') {
        for (const [f, k] of sel) setUV(c.layer, f, k, cur[0], cur[1]);
      } else if (p.target === 'CURSOR_OFFSET') {
        let cu = 0, cv = 0;
        for (const [f, k] of sel) { const q = cornerUV(c.layer, f, k); cu += q[0]; cv += q[1]; }
        cu /= sel.length; cv /= sel.length;
        for (const [f, k] of sel) { const q = cornerUV(c.layer, f, k); setUV(c.layer, f, k, q[0] + cur[0] - cu, q[1] + cur[1] - cv); }
      } else {
        // to an unselected corner of the same mesh vertex
        const vf = vertFacesOf(c.md);
        for (const [f, k] of sel) {
          const v = c.md.faces[f][k];
          for (const g of vf[v]) {
            if (!visibleFaces(c.md).includes(g)) continue;
            const kk = c.md.faces[g].indexOf(v);
            if (!cornerSelected(c.md, c.layer, g, kk)) { const q = cornerUV(c.layer, g, kk); setUV(c.layer, f, k, q[0], q[1]); break; }
          }
        }
      }
      return done(c.md);
    },
  }),
  uvEditOp({
    id: 'uv.snap_cursor', label: 'Snap Cursor', description: 'Snap cursor to target type', undo: false,
    props: { target: { name: 'Target', type: 'enum', default: 'PIXELS', items: [['PIXELS', 'Pixels'], ['SELECTED', 'Selected']], description: 'Target to snap the selected UVs to' } },
    exec: (ctx, p) => {
      const s = uvSettings();
      if (p.target === 'PIXELS') {
        const img = uvEditorImage(ctx);
        const w = img?.width ?? 256, h = img?.height ?? 256;
        s.cursor = [Math.round(s.cursor[0] * w) / w, Math.round(s.cursor[1] * h) / h];
      } else {
        const c = uvContext()!;
        const sel = selectedCorners(c.md, c.layer);
        if (!sel.length) return 'CANCELLED';
        let mnu = Infinity, mxu = -Infinity, mnv = Infinity, mxv = -Infinity;
        for (const [f, k] of sel) { const q = cornerUV(c.layer, f, k); mnu = Math.min(mnu, q[0]); mxu = Math.max(mxu, q[0]); mnv = Math.min(mnv, q[1]); mxv = Math.max(mxv, q[1]); }
        s.cursor = [(mnu + mxu) / 2, (mnv + mxv) / 2];
      }
      app.notify('view');
      return 'FINISHED';
    },
  }),
  uvEditOp({
    id: 'uv.cursor_set', label: 'Set 2D Cursor', description: 'Set 2D cursor location', undo: false, register: false,
    props: { location: { name: 'Location', type: 'vector', size: 2, default: [0, 0], description: 'Cursor location in normalized (0.0-1.0) coordinates' } },
    exec: (_c, p) => { const l = p.location as number[]; uvSettings().cursor = [l[0], l[1]]; app.notify('view'); return 'FINISHED'; },
  }),
  uvEditOp({
    id: 'uv.seams_from_islands', label: 'Seams From Islands', description: 'Set mesh seams according to island setup in the UV editor',
    props: { mark_seams: boolP('Mark Seams', true, 'Mark boundary edges as seams'), mark_sharp: boolP('Mark Sharp', false, 'Mark boundary edges as sharp') },
    exec: (_c, p) => {
      const c = uvContext()!;
      if (!p.mark_seams) return 'FINISHED';
      const keys = seamsFromIslands(c.md, c.layer, visibleFaces(c.md));
      const s = seamSet(c.md);
      for (const k of keys) s.add(k);
      setSeamsFromSet(c.md, s);
      return done(c.md);
    },
  }),
  uvEditOp({
    id: 'uv.mark_seam', label: 'Mark Seam', description: 'Mark selected UV edges as seams', poll: hasUVSel,
    props: { clear: boolP('Clear', false, 'Clear instead of marking seams') },
    exec: (_c, p) => {
      const c = uvContext()!;
      const s = seamSet(c.md);
      for (const f of visibleFaces(c.md)) {
        const g = c.md.faces[f];
        for (let k = 0; k < g.length; k++) {
          const k2 = (k + 1) % g.length;
          if (!cornerSelected(c.md, c.layer, f, k) || !cornerSelected(c.md, c.layer, f, k2)) continue;
          const key = edgeKey(g[k], g[k2]);
          if (p.clear) s.delete(key); else s.add(key);
        }
      }
      setSeamsFromSet(c.md, s);
      return done(c.md);
    },
  }),
  uvEditOp({
    id: 'uv.hide', label: 'Hide Selected', description: 'Hide (un)selected UV vertices',
    props: { unselected: boolP('Unselected', false, 'Hide unselected rather than selected') },
    exec: (_c, p) => {
      const c = uvContext()!;
      if (isSync()) { void app.callOperator('mesh.hide', { unselected: !!p.unselected }, { exec: true }); return 'CANCELLED'; }
      // without sync, hiding UVs deselects their faces in the mesh
      for (const f of visibleFaces(c.md)) {
        const any = c.md.faces[f].some((_, k) => cornerSelected(c.md, c.layer, f, k));
        if (any !== !!p.unselected) c.md.fsel[f] = false;
      }
      flushSelection(c.md, 'FACE');
      flushSelection(c.md, selectModeOf(app.scene.toolSettings.meshSelectMode));
      return done(c.md);
    },
  }),
  uvEditOp({
    id: 'uv.reveal', label: 'Reveal Hidden', description: 'Reveal all hidden UV vertices',
    exec: () => {
      const c = uvContext()!;
      if (isSync()) { void app.callOperator('mesh.reveal', {}, { exec: true }); return 'CANCELLED'; }
      const before = new Set(visibleFaces(c.md));
      c.md.faces.forEach((_, f) => { if (!c.md.fhide?.[f]) c.md.fsel[f] = true; });
      flushSelection(c.md, 'FACE');
      const fl = ensureFlags(c.md, c.layer);
      c.md.faces.forEach((g, f) => { if (!before.has(f) && !c.md.fhide?.[f]) for (let k = 0; k < g.length; k++) fl[f][k] |= UV_SELECT; });
      return done(c.md);
    },
  }),
];

// ------------------------------------------------------------------ image datablock operators

/** Show an image in the UV/Image Editors (the invoking one, else all of them). */
export function showImageInEditors(id: string, ctx?: OpContext | null): void {
  const areas = (app.screen?.areas() ?? []).filter((a) => a.type === 'IMAGE_EDITOR');
  const target = ctx?.area && ctx.area.type === 'IMAGE_EDITOR' ? [ctx.area] : areas;
  for (const a of target) {
    const st = (a.editor as { state?: Record<string, unknown> }).state;
    if (st) st.image = id;
  }
  app.notify('screen', 'view');
}

/** Callback run once by the next image.new / image.open (e.g. to link the image to a texture). */
let pendingImageTarget: ((img: BImage) => void) | null = null;
export function setPendingImageTarget(fn: ((img: BImage) => void) | null): void { pendingImageTarget = fn; }

function takeTarget(img: BImage, ctx: OpContext): void {
  const fn = pendingImageTarget;
  pendingImageTarget = null;
  if (fn) fn(img); else showImageInEditors(img.id, ctx);
}

const IMAGE_NEW_PROPS: Record<string, OpPropDef> = {
  name: { name: 'Name', type: 'string', default: 'Untitled', description: 'Image data-block name' },
  width: { name: 'Width', type: 'int', default: 1024, min: 1, max: 16384, description: 'Image width' },
  height: { name: 'Height', type: 'int', default: 1024, min: 1, max: 16384, description: 'Image height' },
  color: { name: 'Color', type: 'vector', size: 4, default: [0, 0, 0, 1], description: 'Default fill color' },
  alpha: boolP('Alpha', true, 'Create an image with an alpha channel'),
  generated_type: { name: 'Generated Type', type: 'enum', default: 'BLANK', items: [['BLANK', 'Blank'], ['UV_GRID', 'UV Grid'], ['COLOR_GRID', 'Color Grid']], description: 'Fill the image with a grid for UV map testing' },
  float: boolP('32 bit Float', false, 'Create image with 32 bit floating point bit depth'),
};

/** The Image > New Image dialog (Alt+N). */
function newImageDialog(ctx: OpContext, props: OpProps): void {
  const p = { ...props };
  p.name = uniqueImageName(String(p.name || 'Untitled'));
  const col = (p.color as number[]).slice();
  showDialog({
    title: 'New Image', icon: 'IMAGE_DATA', width: 300,
    draw: (l) => {
      l.prop({ kind: 'string', name: 'Name', get: () => String(p.name), set: (v) => { p.name = v; }, undo: false }, {});
      const c = l.column(true);
      c.prop({ kind: 'int', name: 'Width', min: 1, max: 16384, unit: 'PIXEL', get: () => Number(p.width), set: (v) => { p.width = v; }, undo: false, description: 'Image width' });
      c.prop({ kind: 'int', name: 'Height', min: 1, max: 16384, unit: 'PIXEL', get: () => Number(p.height), set: (v) => { p.height = v; }, undo: false, description: 'Image height' });
      l.prop({ kind: 'color', name: 'Color', alpha: true, get: () => col.slice(), set: (v) => { for (let i = 0; i < 4; i++) col[i] = v[i] ?? col[i]; }, undo: false, description: 'Default fill color' });
      l.prop({ kind: 'bool', name: 'Alpha', get: () => !!p.alpha, set: (v) => { p.alpha = v; }, undo: false, description: 'Create an image with an alpha channel' });
      l.prop({ kind: 'enum', name: 'Generated Type', items: [{ id: 'BLANK', label: 'Blank', description: 'Generate a blank image' }, { id: 'UV_GRID', label: 'UV Grid', description: 'Generated grid to test UV mappings' }, { id: 'COLOR_GRID', label: 'Color Grid', description: 'Generated improved UV grid to test UV mappings' }], get: () => String(p.generated_type), set: (v) => { p.generated_type = v; }, undo: false, description: 'Fill the image with a grid for UV map testing' });
      l.prop({ kind: 'bool', name: '32 bit Float', get: () => false, set: () => {}, disabled: () => true, undo: false, description: 'Not available in blender-web' });
    },
    okText: 'OK',
    onOk: () => { p.color = col; void app.callOperator('image.new', p, { area: ctx.area, exec: true }); },
    onCancel: () => { pendingImageTarget = null; },
  });
}

/** Image of the invoking UV/Image Editor (or of any editor). */
function contextImage(ctx: OpContext): BImage | null {
  const st = ctx.area?.type === 'IMAGE_EDITOR' ? (ctx.area.editor as { state?: Record<string, unknown> }).state : null;
  const id = st && typeof st.image === 'string' ? st.image : null;
  return getImage(id) ?? (ctx.area?.type === 'IMAGE_EDITOR' ? null : uvEditorImage(ctx));
}

export const IMAGE_OPERATORS: OperatorDef[] = [
  {
    id: 'image.new', label: 'New Image', description: 'Create a new image', undo: true, register: true, icon: 'ZOOMIN', props: IMAGE_NEW_PROPS,
    invoke: (ctx, p) => { newImageDialog(ctx, p); return 'CANCELLED'; },
    exec: (ctx, p) => {
      const col = (p.color as number[]) ?? [0, 0, 0, 1];
      const img = createImage({
        name: String(p.name || 'Untitled'), width: Number(p.width), height: Number(p.height), color: [col[0], col[1], col[2], col[3] ?? 1],
        alpha: !!p.alpha, generatedType: p.generated_type as BImage['generatedType'],
      });
      takeTarget(img, ctx);
      return 'FINISHED';
    },
  },
  {
    id: 'image.open', label: 'Open Image', description: 'Open image', undo: true, register: true, icon: 'FILE_FOLDER',
    exec: async (ctx) => {
      const img = await openImageFile();
      if (!img) { pendingImageTarget = null; return 'CANCELLED'; }
      takeTarget(img, ctx);
      return 'FINISHED';
    },
  },
  {
    id: 'image.reload', label: 'Reload Image', description: 'Reload current image from disk', undo: true, register: true, icon: 'FILE_REFRESH',
    poll: (ctx) => !!contextImage(ctx),
    exec: (ctx) => { const img = contextImage(ctx)!; if (!reloadImage(img)) { app.report('WARNING', 'Image has no saved pixels to reload'); return 'CANCELLED'; } return 'FINISHED'; },
  },
  {
    id: 'image.pack', label: 'Pack Image', description: 'Pack an image as embedded data into the .blend file', undo: true, register: true, icon: 'PACKAGE',
    poll: (ctx) => !!contextImage(ctx),
    exec: (ctx) => { const img = contextImage(ctx)!; img.packed = true; app.report('INFO', `Packed image "${img.name}"`); return 'FINISHED'; },
  },
  {
    id: 'image.save', label: 'Save Image', description: 'Save the image with current name and settings', register: true,
    poll: (ctx) => !!contextImage(ctx),
    exec: (ctx) => { saveImageAs(contextImage(ctx)!); return 'FINISHED'; },
  },
];

/** Wrap the render-result "Save As Image" so it also saves image datablocks shown in the editor. */
export function extendImageSaveAs(): void {
  const base = app.operator('image.save_as');
  if (!base || (base as { _uvWrapped?: boolean })._uvWrapped) return;
  const wrapped: OperatorDef & { _uvWrapped?: boolean } = {
    ...base,
    description: 'Save the image with another name and/or settings',
    poll: (ctx) => !!contextImage(ctx) || (base.poll ? base.poll(ctx) : true),
    exec: (ctx, p) => {
      const img = contextImage(ctx);
      if (img) { saveImageAs(img); return 'FINISHED'; }
      return base.exec ? base.exec(ctx, p) : 'CANCELLED';
    },
    _uvWrapped: true,
  };
  app.registerOperator(wrapped);
}

// ------------------------------------------------------------------ keymap

export function registerUVKeymap(): void {
  const E = 'EDIT' as const;
  const items: KeyItem[] = [
    // 3D View edit mode
    { code: 'KeyU', space: 'VIEW_3D', mode: E, menu: uvMappingMenu, title: 'UV Mapping', poll: () => !!app.editMesh },
    // UV/Image Editor (mesh edit mode)
    { code: 'KeyA', space: 'IMAGE_EDITOR', mode: E, op: 'uv.select_all', props: { action: 'TOGGLE' } },
    { code: 'KeyI', space: 'IMAGE_EDITOR', mode: E, op: 'uv.select_all', props: { action: 'INVERT' }, ctrl: true },
    { code: 'KeyL', space: 'IMAGE_EDITOR', mode: E, op: 'uv.select_linked', ctrl: true },
    { code: 'KeyP', space: 'IMAGE_EDITOR', mode: E, op: 'uv.pin', props: { clear: false } },
    { code: 'KeyP', space: 'IMAGE_EDITOR', mode: E, op: 'uv.pin', props: { clear: true }, alt: true },
    { code: 'KeyP', space: 'IMAGE_EDITOR', mode: E, op: 'uv.select_pinned', shift: true },
    { code: 'KeyW', space: 'IMAGE_EDITOR', mode: E, menu: uvWeldAlignMenu, title: 'Weld/Align' },
    { code: 'KeyV', space: 'IMAGE_EDITOR', mode: E, op: 'uv.stitch' },
    { code: 'KeyA', space: 'IMAGE_EDITOR', mode: E, op: 'uv.average_islands_scale', ctrl: true },
    { code: 'KeyP', space: 'IMAGE_EDITOR', mode: E, op: 'uv.pack_islands', ctrl: true },
    { code: 'KeyV', space: 'IMAGE_EDITOR', mode: E, op: 'uv.minimize_stretch', ctrl: true },
    { code: 'KeyE', space: 'IMAGE_EDITOR', mode: E, op: 'uv.unwrap' },
    { code: 'KeyS', space: 'IMAGE_EDITOR', mode: E, menu: uvSnapMenu, title: 'Snap', shift: true },
    { code: 'KeyH', space: 'IMAGE_EDITOR', mode: E, op: 'uv.hide', props: { unselected: false } },
    { code: 'KeyH', space: 'IMAGE_EDITOR', mode: E, op: 'uv.hide', props: { unselected: true }, shift: true },
    { code: 'KeyH', space: 'IMAGE_EDITOR', mode: E, op: 'uv.reveal', alt: true },
    // images (any mode)
    { code: 'KeyN', space: 'IMAGE_EDITOR', op: 'image.new', alt: true },
    { code: 'KeyO', space: 'IMAGE_EDITOR', op: 'image.open', alt: true },
    { code: 'KeyR', space: 'IMAGE_EDITOR', op: 'image.reload', alt: true },
    { code: 'KeyS', space: 'IMAGE_EDITOR', op: 'image.save', alt: true },
    { code: 'KeyS', space: 'IMAGE_EDITOR', op: 'image.save_as', shift: true, alt: true },
  ];
  registerKeymap(items);
}

/** Open a menu at the mouse (helper for editors). */
export function popupMenu(title: string, items: MenuItem[], area: OpContext['area']): void {
  showMenu(items, app.mouse, { title, atMouse: true, area });
}

export const UV_ALL_OPERATORS: OperatorDef[] = [...UV_OPERATORS, ...UV_EDITOR_OPERATORS, ...IMAGE_OPERATORS];

/** Register every UV / image operator and key binding (called once from main.ts). */
export function registerUV(): void {
  for (const def of UV_ALL_OPERATORS) app.registerOperator(def);
  extendImageSaveAs();
  registerUVKeymap();
}

