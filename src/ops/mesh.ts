// Edit mode (mesh) operators.

import { Vector3 } from 'three';
import { app, type OperatorDef, type OpProps, type OpContext, type ModalHandler } from '../app';
import type { MeshData, Vec3 } from '../core/types';
import * as ops from '../core/meshops';
import { flushSelection, selectModeOf, ensureArrays, rebuildEdges, edgeKey, polyCenter, type SelectMode } from '../core/mesh';
import { createObject, createMesh } from '../core/scene';
import { showMenu } from '../ui/menu';
import { viewOf, isEditMesh } from './common';
import { startTransform, gatherElements, pivotCenter } from '../editors/view3d/transform';
import { pickEditElement } from '../editors/view3d/select';
import type { View3D } from '../editors/view3d/view3d';

const md = () => app.editMesh!;
const mode = (): SelectMode => selectModeOf(app.scene.toolSettings.meshSelectMode);
const anySel = () => isEditMesh() && md().vsel.some(Boolean);
const faceSel = () => isEditMesh() && md().fsel.some(Boolean);

function done(): 'FINISHED' {
  const m = app.editMesh;
  if (m) { ensureArrays(m); app.tagGeometry(m.id); }
  app.notify('geometry', 'select');
  return 'FINISHED';
}

function grabAfter(ctx: OpContext, opts: { constraint?: boolean[] | null; orientation?: 'NORMAL' | 'GLOBAL' } = {}): void {
  const view = viewOf(ctx);
  if (!view) return;
  const r = view.canvasRect();
  startTransform({ mode: 'TRANSLATION', view, mouse: { x: app.mouse.x - r.left, y: app.mouse.y - r.top }, constraint: opts.constraint ?? null, orientation: opts.orientation });
}

const editOp = (o: Omit<OperatorDef, 'undo' | 'register'> & { undo?: boolean; register?: boolean }): OperatorDef => ({ undo: true, register: true, poll: anySel, ...o });

const selAction = { name: 'Action', type: 'enum' as const, default: 'TOGGLE', items: [['TOGGLE', 'Toggle'], ['SELECT', 'Select'], ['DESELECT', 'Deselect'], ['INVERT', 'Invert']] as [string, string][] };

// ------------------------------------------------------------------ loop cut (interactive)

function startLoopCut(ctx: OpContext, cuts: number): void {
  const view = viewOf(ctx);
  if (!view) return;
  let ring: number[] = [];
  let edge = -1;
  const ob = app.editObj!;
  const preview = () => {
    const m = md();
    const world = app.matrices.world(ob);
    const pts: Vector3[] = [];
    // preview: line through the middle of each ring edge's quads
    const ringSet = new Set(ring.map((e) => edgeKey(m.edges[e][0], m.edges[e][1])));
    const mid = (e: number, t: number) => new Vector3(...m.verts[m.edges[e][0]]).lerp(new Vector3(...m.verts[m.edges[e][1]]), t).applyMatrix4(world);
    m.faces.forEach((f) => {
      if (f.length !== 4) return;
      const es: number[] = [];
      for (let k = 0; k < 4; k++) {
        const key = edgeKey(f[k], f[(k + 1) % 4]);
        if (ringSet.has(key)) es.push(ring.find((e) => edgeKey(m.edges[e][0], m.edges[e][1]) === key)!);
      }
      if (es.length === 2) {
        for (let c = 1; c <= cuts; c++) {
          const t = c / (cuts + 1);
          // keep both segments in a consistent direction around the quad
          const [a0, a1] = m.edges[es[0]], [b0, b1] = m.edges[es[1]];
          const ia = f.indexOf(a0), ib = f.indexOf(b0);
          void a1; void b1; void ia; void ib;
          const pa = mid(es[0], t);
          const pb0 = mid(es[1], t), pb1 = mid(es[1], 1 - t);
          // choose the end of the second edge that does not cross the quad
          const fwd = new Vector3(...m.verts[a0]).applyMatrix4(world);
          const pb = pb0.distanceTo(fwd) < pb1.distanceTo(fwd) || cuts === 1 ? pb0 : pb1;
          pts.push(pa, pb);
        }
      }
    });
    view.previewLines = pts;
    view.requestRender();
  };
  const hover = (x: number, y: number) => {
    const hit = pickEditElement(view, x, y, 'EDGE');
    const e = hit ? hit.index : -1;
    if (e === edge) return;
    edge = e;
    ring = e >= 0 ? ops.edgeRing(md(), e) : [];
    preview();
  };
  const end = () => { view.previewLines = null; app.endModal(h); view.requestRender(); };
  const h: ModalHandler = {
    status: () => `Loop Cut: hover an edge, LMB to cut, Wheel / PageUp/PageDown change number of cuts (${cuts}), RMB/Esc cancel`,
    cursor: 'crosshair',
    cancel: end,
    onEvent(e) {
      const r = view.canvasRect();
      if (e.type === 'pointermove') { const pe = e as PointerEvent; hover(pe.clientX - r.left, pe.clientY - r.top); return true; }
      if (e.type === 'wheel' || (e.type === 'keydown' && ['PageUp', 'PageDown', '+', '-'].includes((e as KeyboardEvent).key))) {
        const up = e.type === 'wheel' ? (e as WheelEvent).deltaY < 0 : ['PageUp', '+'].includes((e as KeyboardEvent).key);
        cuts = Math.max(1, Math.min(100, cuts + (up ? 1 : -1)));
        preview();
        return true;
      }
      if (e.type === 'pointerdown') {
        const pe = e as PointerEvent;
        if (pe.button !== 0) { end(); return true; }
        if (edge < 0) return true;
        end();
        const props = { number_cuts: cuts, edge_index: edge, factor: 0 };
        void app.callOperator('mesh.loopcut', props, { area: view.area, exec: true }).then(() => {
          if (cuts === 1) startEdgeSlide(view, edge);
        });
        return true;
      }
      if (e.type === 'keydown') { if ((e as KeyboardEvent).key === 'Escape') end(); return true; }
      return true;
    },
  };
  app.startModal(h);
  const r = view.canvasRect();
  hover(app.mouse.x - r.left, app.mouse.y - r.top);
}

/** After a single loop cut, slide it along the ring (re-running the cut with a factor). */
function startEdgeSlide(view: View3D, edgeIndex: number): void {
  const last = app.lastOp;
  if (!last || last.def.id !== 'mesh.loopcut') return;
  const r0 = view.canvasRect();
  const sx = app.mouse.x - r0.left;
  let factor = 0;
  const h: ModalHandler = {
    status: () => `Edge Slide: factor ${factor.toFixed(4)} — LMB/Enter confirm, RMB/Esc keep centred`,
    cursor: 'ew-resize',
    cancel: () => app.endModal(h),
    onEvent(e) {
      const r = view.canvasRect();
      if (e.type === 'pointermove') {
        const pe = e as PointerEvent;
        factor = Math.max(-1, Math.min(1, (pe.clientX - r.left - sx) / 200));
        void app.redoLast({ ...last.props, edge_index: edgeIndex, factor });
        return true;
      }
      if (e.type === 'pointerdown') {
        const pe = e as PointerEvent;
        if (pe.button !== 0) void app.redoLast({ ...last.props, edge_index: edgeIndex, factor: 0 });
        app.endModal(h);
        return true;
      }
      if (e.type === 'keydown') {
        const k = (e as KeyboardEvent).key;
        if (k === 'Escape') { void app.redoLast({ ...last.props, edge_index: edgeIndex, factor: 0 }); app.endModal(h); }
        if (k === 'Enter') app.endModal(h);
        return true;
      }
      return true;
    },
  };
  app.startModal(h);
}

// ------------------------------------------------------------------ inset (interactive)

function startInset(ctx: OpContext): void {
  const view = viewOf(ctx);
  if (!view) return;
  const snapshot = JSON.stringify(md());
  const restore = () => { const s = JSON.parse(snapshot) as MeshData; Object.assign(md(), s); };
  const el = gatherElements();
  const center = pivotCenter(el, 'MEDIAN_POINT');
  const r = view.canvasRect();
  const pc = view.view.project(center);
  const start = Math.hypot(app.mouse.x - r.left - pc.x, app.mouse.y - r.top - pc.y);
  let thickness = 0, depth = 0, individual = false, depthMode = false;
  let lastD = start;
  const apply = () => {
    restore();
    ops.inset(md(), Math.max(0, thickness), depth, individual);
    done();
    view.requestRender();
  };
  const h: ModalHandler = {
    status: () => `Inset: Thickness: ${thickness.toFixed(4)}, Depth (Ctrl to tweak): ${depth.toFixed(4)}, Individual (I): ${individual ? 'On' : 'Off'}`,
    cancel: () => { restore(); done(); app.endModal(h); },
    onEvent(e) {
      const rr = view.canvasRect();
      if (e.type === 'pointermove') {
        const pe = e as PointerEvent;
        const d = Math.hypot(pe.clientX - rr.left - pc.x, pe.clientY - rr.top - pc.y);
        const ps = view.view.pixelSize(center) * (pe.shiftKey ? 0.1 : 1);
        if (pe.ctrlKey !== depthMode) { depthMode = pe.ctrlKey; lastD = d; }
        if (depthMode) depth += (d - lastD) * ps; else thickness = Math.max(0, thickness + (lastD - d) * ps * -1);
        lastD = d;
        apply();
        return true;
      }
      if (e.type === 'pointerdown' || (e.type === 'keydown' && ['Enter', 'Escape'].includes((e as KeyboardEvent).key))) {
        const ok = e.type === 'pointerdown' ? (e as PointerEvent).button === 0 : (e as KeyboardEvent).key === 'Enter';
        app.endModal(h);
        if (!ok) { restore(); done(); return true; }
        restore();
        void app.callOperator('mesh.inset', { thickness, depth, use_individual: individual }, { area: view.area, exec: true });
        return true;
      }
      if (e.type === 'keydown' && (e as KeyboardEvent).key.toLowerCase() === 'i') { individual = !individual; apply(); return true; }
      return true;
    },
  };
  app.startModal(h);
}

// ------------------------------------------------------------------ separate

function separateParts(parts: ReturnType<typeof ops.separateLoose>): void {
  const ob = app.editObj!;
  const src = md();
  for (const part of parts) {
    if (!part) continue;
    const mesh = createMesh(app.doc, src.name, part.verts, part.faces, part.edges);
    mesh.faceSmooth = part.faceSmooth.slice();
    mesh.faceMat = part.faceMat.slice();
    mesh.materials = src.materials.slice();
    ensureArrays(mesh);
    const no = createObject(app.doc, 'MESH', ob.name, mesh.id);
    no.location = ob.location.slice() as Vec3;
    no.rotation = ob.rotation.slice() as Vec3;
    no.scale = ob.scale.slice() as Vec3;
    no.rotationMode = ob.rotationMode;
    no.parent = ob.parent;
    no.parentInverse = ob.parentInverse.slice();
    no.layers = ob.layers.slice();
    no.modifiers = JSON.parse(JSON.stringify(ob.modifiers));
    const i = app.scene.objects.indexOf(ob.id);
    app.scene.objects.splice(i + 1, 0, no.id);
    app.tagGeometry(mesh.id);
  }
}

// ------------------------------------------------------------------ operators

export const MESH_OPERATORS: OperatorDef[] = [
  editOp({
    id: 'mesh.select_all', label: '(De)select All', description: 'Change selection of all vertices, edges or faces', poll: isEditMesh,
    props: { action: selAction },
    exec: (_c, p) => { ops.selectAll(md(), p.action as 'TOGGLE', mode()); return done(); },
  }),
  editOp({
    id: 'mesh.select_mode', label: 'Select Mode', description: 'Change selection mode', poll: isEditMesh,
    props: { type: { name: 'Type', type: 'enum', default: 'VERT', items: [['VERT', 'Vertex'], ['EDGE', 'Edge'], ['FACE', 'Face']] }, use_extend: { name: 'Extend', type: 'bool', default: false } },
    exec: (_c, p) => {
      const ts = app.scene.toolSettings;
      const i = ['VERT', 'EDGE', 'FACE'].indexOf(String(p.type));
      const m = md();
      const prev = mode();
      if (p.use_extend) { ts.meshSelectMode[i] = !ts.meshSelectMode[i]; if (!ts.meshSelectMode.some(Boolean)) ts.meshSelectMode[i] = true; }
      else ts.meshSelectMode = [i === 0, i === 1, i === 2];
      // convert the selection like Blender does
      const next = mode();
      if (next !== prev) {
        if (next === 'VERT') flushSelection(m, 'VERT');
        else if (next === 'EDGE') { if (prev === 'VERT') { m.edges.forEach((e, k) => (m.esel[k] = m.vsel[e[0]] && m.vsel[e[1]])); } flushSelection(m, 'EDGE'); }
        else { if (prev !== 'FACE') { m.faces.forEach((f, k) => (m.fsel[k] = f.every((v) => m.vsel[v]))); } flushSelection(m, 'FACE'); }
      }
      return done();
    },
  }),
  editOp({ id: 'mesh.select_more', label: 'Select More', description: 'Select more vertices, edges or faces connected to initial selection', exec: () => { ops.selectMore(md(), mode()); return done(); } }),
  editOp({ id: 'mesh.select_less', label: 'Select Less', description: 'Deselect vertices, edges or faces at the boundary of each selection region', exec: () => { ops.selectLess(md(), mode()); return done(); } }),
  editOp({ id: 'mesh.select_linked', label: 'Select Linked All', description: 'Select all vertices linked to the active mesh', exec: () => { ops.selectLinked(md(), mode()); return done(); } }),
  editOp({
    id: 'mesh.select_linked_pick', label: 'Select Linked', description: '(De)select all vertices linked to the edge under the mouse cursor', poll: isEditMesh,
    props: { deselect: { name: 'Deselect', type: 'bool', default: false }, index: { name: 'Index', type: 'int', default: -1, hidden: true } },
    invoke: (ctx, p) => {
      const view = viewOf(ctx);
      if (!view) return 'CANCELLED';
      const r = view.canvasRect();
      const hit = pickEditElement(view, app.mouse.x - r.left, app.mouse.y - r.top, 'VERT') ?? pickEditElement(view, app.mouse.x - r.left, app.mouse.y - r.top, 'EDGE');
      if (!hit) return 'CANCELLED';
      p.index = hit.kind === 'VERT' ? hit.index : md().edges[hit.index][0];
      return app.operator('mesh.select_linked_pick')!.exec!(ctx, p);
    },
    exec: (_c, p) => { if (Number(p.index) < 0) return 'CANCELLED'; ops.selectLinkedPick(md(), Number(p.index), !!p.deselect, mode()); return done(); },
  }),
  editOp({
    id: 'mesh.select_random', label: 'Select Random', description: 'Randomly select vertices', poll: isEditMesh,
    props: { percent: { name: 'Percent', type: 'float', default: 50, min: 0, max: 100, subtype: 'PERCENTAGE' }, seed: { name: 'Random Seed', type: 'int', default: 0, min: 0 }, action: { name: 'Action', type: 'enum', default: 'SELECT', items: [['SELECT', 'Select'], ['DESELECT', 'Deselect']] } },
    exec: (_c, p) => { ops.selectRandom(md(), Number(p.percent), Number(p.seed), mode(), p.action as 'SELECT'); return done(); },
  }),
  editOp({ id: 'mesh.select_non_manifold', label: 'Select Non Manifold', description: 'Select all non-manifold vertices or edges', poll: () => isEditMesh() && !app.scene.toolSettings.meshSelectMode[2], exec: () => { ops.selectNonManifold(md()); return done(); } }),
  editOp({ id: 'mesh.select_loose', label: 'Select Loose Geometry', description: 'Select loose geometry based in the selection mode', poll: isEditMesh, exec: () => { ops.selectLoose(md()); return done(); } }),
  editOp({ id: 'mesh.select_interior_faces', label: 'Select Interior Faces', description: 'Select faces where all edges have more than 2 face users', poll: isEditMesh, exec: () => { ops.selectInteriorFaces(md()); return done(); } }),
  editOp({
    id: 'mesh.select_face_by_sides', label: 'Select Faces by Sides', description: 'Select vertices or faces by the number of polygon sides', poll: isEditMesh,
    props: { number: { name: 'Number of Vertices', type: 'int', default: 4, min: 3 }, type: { name: 'Type', type: 'enum', default: 'EQUAL', items: [['LESS', 'Less Than'], ['EQUAL', 'Equal To'], ['GREATER', 'Greater Than'], ['NOTEQUAL', 'Not Equal To']] }, extend: { name: 'Extend', type: 'bool', default: true } },
    exec: (_c, p) => { ops.selectFaceBySides(md(), Number(p.number), p.type as 'EQUAL', !!p.extend); return done(); },
  }),
  editOp({
    id: 'mesh.edges_select_sharp', label: 'Select Sharp Edges', description: 'Select all sharp-enough edges', poll: isEditMesh,
    props: { sharpness: { name: 'Sharpness', type: 'float', default: (30 * Math.PI) / 180, min: 0.000017, max: Math.PI, subtype: 'ANGLE' } },
    exec: (_c, p) => { ops.selectSharpEdges(md(), Number(p.sharpness)); return done(); },
  }),
  // ---- extrude
  editOp({
    id: 'mesh.extrude_region_move', label: 'Extrude Region and Move', description: 'Extrude region and move result', undo: false, register: false,
    exec: (ctx) => {
      const res = ops.extrudeRegion(md(), mode());
      done();
      app.report('OPERATOR', 'bpy.ops.mesh.extrude_region_move(MESH_OT_extrude_region={"mirror":False}, TRANSFORM_OT_translate={"value":(0, 0, 0)})');
      const hasNormal = Math.hypot(...res.normal) > 1e-6;
      grabAfter(ctx, hasNormal ? { constraint: [false, false, true], orientation: 'NORMAL' } : {});
      return 'FINISHED';
    },
  }),
  editOp({ id: 'mesh.extrude_faces_move', label: 'Extrude Individual Faces and Move', poll: faceSel, undo: false, register: false, exec: (ctx) => { ops.extrudeIndividual(md()); done(); grabAfter(ctx); return 'FINISHED'; } }),
  editOp({ id: 'mesh.extrude_edges_move', label: 'Extrude Only Edges and Move', undo: false, register: false, exec: (ctx) => { ops.extrudeEdgesOnly(md()); done(); grabAfter(ctx); return 'FINISHED'; } }),
  editOp({ id: 'mesh.extrude_vertices_move', label: 'Extrude Only Vertices and Move', undo: false, register: false, exec: (ctx) => { ops.extrudeVertsOnly(md()); done(); grabAfter(ctx); return 'FINISHED'; } }),
  editOp({
    id: 'mesh.extrude_menu', label: 'Extrude', description: 'Extrude menu (Alt+E)', undo: false, register: false,
    invoke: (ctx) => {
      const items = [
        ...(faceSel() ? [{ label: 'Region', action: () => void app.callOperator('mesh.extrude_region_move', {}, { area: ctx.area }) }, { label: 'Individual Faces', action: () => void app.callOperator('mesh.extrude_faces_move', {}, { area: ctx.area }) }] : []),
        { label: 'Edges Only', action: () => void app.callOperator('mesh.extrude_edges_move', {}, { area: ctx.area }) },
        { label: 'Vertices Only', action: () => void app.callOperator('mesh.extrude_vertices_move', {}, { area: ctx.area }) },
      ];
      showMenu(items, app.mouse, { title: 'Extrude', atMouse: true, area: ctx.area });
      return 'CANCELLED';
    },
    exec: () => 'CANCELLED',
  }),
  // ---- delete
  editOp({
    id: 'mesh.delete', label: 'Delete', description: 'Delete selected vertices, edges or faces',
    props: { type: { name: 'Type', type: 'enum', default: 'VERT', items: [['VERT', 'Vertices'], ['EDGE', 'Edges'], ['FACE', 'Faces'], ['EDGE_FACE', 'Only Edges & Faces'], ['ONLY_FACE', 'Only Faces']] } },
    exec: (_c, p) => { ops.deleteElements(md(), p.type as 'VERT'); return done(); },
  }),
  editOp({
    id: 'mesh.delete_menu', label: 'Delete', description: 'Delete menu (X)', undo: false, register: false,
    invoke: (ctx) => {
      const t = (type: string) => () => void app.callOperator('mesh.delete', { type }, { area: ctx.area, exec: true });
      showMenu([
        { label: 'Vertices', action: t('VERT') }, { label: 'Edges', action: t('EDGE') }, { label: 'Faces', action: t('FACE') },
        { label: 'Only Edges & Faces', action: t('EDGE_FACE') }, { label: 'Only Faces', action: t('ONLY_FACE') },
        { type: 'separator' },
        { label: 'Dissolve Faces', op: 'mesh.dissolve_faces' },
        { type: 'separator' },
        { label: 'Delete Loose', op: 'mesh.delete_loose' },
      ], app.mouse, { title: 'Delete', atMouse: true, area: ctx.area });
      return 'CANCELLED';
    },
    exec: () => 'CANCELLED',
  }),
  editOp({ id: 'mesh.delete_loose', label: 'Delete Loose', description: 'Delete loose vertices and edges', poll: isEditMesh, exec: () => { const n = ops.deleteLoose(md()); app.report('INFO', `Removed: ${n} loose elements`); return done(); } }),
  editOp({ id: 'mesh.dissolve_faces', label: 'Dissolve Faces', description: 'Dissolve faces', poll: faceSel, exec: () => { ops.dissolveFaces(md()); return done(); } }),
  // ---- create / modify
  editOp({
    id: 'mesh.edge_face_add', label: 'Make Edge/Face', description: 'Add an edge or face to selected',
    exec: () => { const err = ops.makeEdgeFace(md()); if (err) { app.report('ERROR', err); return 'CANCELLED'; } return done(); },
  }),
  editOp({
    id: 'mesh.subdivide', label: 'Subdivide', description: 'Subdivide selected edges',
    props: { number_cuts: { name: 'Number of Cuts', type: 'int', default: 1, min: 1, max: 100, softMax: 10 }, smoothness: { name: 'Smoothness', type: 'float', default: 0, min: 0, max: 1000, softMax: 1, subtype: 'FACTOR' } },
    exec: (_c, p) => { ops.subdivide(md(), Math.max(1, Number(p.number_cuts)), Number(p.smoothness)); return done(); },
  }),
  editOp({
    id: 'mesh.loopcut_slide', label: 'Loop Cut and Slide', description: 'Cut mesh loop and slide it', poll: isEditMesh, undo: false, register: false,
    invoke: (ctx) => { startLoopCut(ctx, 1); return 'RUNNING_MODAL'; },
    exec: () => 'CANCELLED',
  }),
  {
    id: 'mesh.loopcut', label: 'Loop Cut', description: 'Add a new loop between existing loops', undo: true, register: true, poll: isEditMesh,
    props: { number_cuts: { name: 'Number of Cuts', type: 'int', default: 1, min: 1, max: 100, softMax: 10 }, edge_index: { name: 'Edge Index', type: 'int', default: -1, hidden: true }, factor: { name: 'Factor', type: 'float', default: 0, min: -1, max: 1, subtype: 'FACTOR' } },
    exec: (_c, p) => {
      const e = Number(p.edge_index);
      if (e < 0 || e >= md().edges.length) return 'CANCELLED';
      ops.loopCut(md(), e, Math.max(1, Number(p.number_cuts)), Number(p.number_cuts) === 1 ? Number(p.factor) : 0);
      app.scene.toolSettings.meshSelectMode = [false, true, false].map((x, i) => (app.scene.toolSettings.meshSelectMode[0] ? i === 0 : x)) as [boolean, boolean, boolean];
      return done();
    },
  },
  editOp({
    id: 'mesh.inset', label: 'Inset Faces', description: 'Inset new faces into selected faces', poll: faceSel,
    props: { thickness: { name: 'Thickness', type: 'float', default: 0.01, min: 0, subtype: 'DISTANCE' }, depth: { name: 'Depth', type: 'float', default: 0, subtype: 'DISTANCE' }, use_individual: { name: 'Individual', type: 'bool', default: false } },
    invoke: (ctx) => { startInset(ctx); return 'RUNNING_MODAL'; },
    exec: (_c, p) => { ops.inset(md(), Number(p.thickness), Number(p.depth), !!p.use_individual); return done(); },
  }),
  editOp({
    id: 'mesh.merge', label: 'Merge', description: 'Merge selected vertices',
    props: { type: { name: 'Type', type: 'enum', default: 'CENTER', items: [['FIRST', 'At First'], ['LAST', 'At Last'], ['CENTER', 'At Center'], ['CURSOR', 'At Cursor'], ['COLLAPSE', 'Collapse']] } },
    exec: (_c, p) => {
      const ob = app.editObj!;
      const cur = new Vector3(...app.scene.cursor).applyMatrix4(app.matrices.world(ob).clone().invert());
      const n = ops.mergeVerts(md(), p.type as 'CENTER', [cur.x, cur.y, cur.z]);
      app.report('INFO', `Removed ${n} vertices`);
      return done();
    },
  }),
  editOp({
    id: 'mesh.merge_menu', label: 'Merge', description: 'Merge menu (Alt+M)', undo: false, register: false,
    invoke: (ctx) => {
      const t = (type: string) => () => void app.callOperator('mesh.merge', { type }, { area: ctx.area, exec: true });
      showMenu([{ label: 'At Center', action: t('CENTER') }, { label: 'At Cursor', action: t('CURSOR') }, { label: 'Collapse', action: t('COLLAPSE') }], app.mouse, { title: 'Merge', atMouse: true });
      return 'CANCELLED';
    },
    exec: () => 'CANCELLED',
  }),
  editOp({
    id: 'mesh.remove_doubles', label: 'Remove Doubles', description: 'Remove duplicate vertices',
    props: { threshold: { name: 'Merge Distance', type: 'float', default: 0.0001, min: 0.000001, max: 50, softMax: 10, precision: 6, subtype: 'DISTANCE' }, use_unselected: { name: 'Unselected', type: 'bool', default: false } },
    exec: (_c, p) => { const n = ops.removeDoubles(md(), Number(p.threshold), !p.use_unselected); app.report('INFO', `Removed ${n} vertices`); return done(); },
  }),
  editOp({ id: 'mesh.flip_normals', label: 'Flip Normals', description: 'Flip the direction of selected faces\' normals', poll: faceSel, exec: () => { ops.flipNormals(md()); return done(); } }),
  editOp({
    id: 'mesh.normals_make_consistent', label: 'Make Normals Consistent', description: 'Make face and vertex normals point either outside or inside the mesh', poll: faceSel,
    props: { inside: { name: 'Inside', type: 'bool', default: false } },
    exec: (_c, p) => { ops.recalcNormals(md(), !!p.inside); return done(); },
  }),
  ...([['faces_shade_smooth', 'Shade Smooth', true], ['faces_shade_flat', 'Shade Flat', false]] as const).map(([id, label, s]) => editOp({
    id: `mesh.${id}`, label, description: `Display faces ${s ? 'smooth' : 'flat'}`, poll: faceSel,
    exec: () => { const m = md(); m.faces.forEach((_, i) => { if (m.fsel[i]) m.faceSmooth[i] = s; }); return done(); },
  })),
  editOp({
    id: 'mesh.duplicate_move', label: 'Duplicate', description: 'Duplicate mesh and move', undo: false, register: false,
    exec: (ctx) => { ops.duplicateSelected(md()); done(); app.report('OPERATOR', 'bpy.ops.mesh.duplicate_move(MESH_OT_duplicate={"mode":1}, TRANSFORM_OT_translate={"value":(0, 0, 0)})'); grabAfter(ctx); return 'FINISHED'; },
  }),
  editOp({
    id: 'mesh.separate', label: 'Separate', description: 'Separate selected geometry into a new mesh', poll: isEditMesh,
    props: { type: { name: 'Type', type: 'enum', default: 'SELECTED', items: [['SELECTED', 'Selection'], ['MATERIAL', 'By Material'], ['LOOSE', 'By loose parts']] } },
    exec: (_c, p) => {
      if (p.type === 'LOOSE') { const parts = ops.separateLoose(md()); separateParts(parts); }
      else if (p.type === 'MATERIAL') {
        const m = md();
        const mats = [...new Set(m.faceMat)].sort((a, b) => a - b);
        for (const mi of mats.slice(1)) {
          m.vsel.fill(false); m.esel.fill(false);
          m.fsel = m.faceMat.map((x) => x === mi);
          flushSelection(m, 'FACE');
          const part = ops.separateSelected(m);
          if (part) separateParts([part]);
        }
      } else {
        const part = ops.separateSelected(md());
        if (!part) { app.report('ERROR', 'Nothing selected'); return 'CANCELLED'; }
        separateParts([part]);
      }
      return done();
    },
  }),
  editOp({
    id: 'mesh.separate_menu', label: 'Separate', description: 'Separate menu (P)', undo: false, register: false, poll: isEditMesh,
    invoke: (ctx) => {
      const t = (type: string) => () => void app.callOperator('mesh.separate', { type }, { area: ctx.area, exec: true });
      showMenu([{ label: 'Selection', action: t('SELECTED') }, { label: 'By Material', action: t('MATERIAL') }, { label: 'By loose parts', action: t('LOOSE') }], app.mouse, { title: 'Separate', atMouse: true });
      return 'CANCELLED';
    },
    exec: () => 'CANCELLED',
  }),
  editOp({ id: 'mesh.split', label: 'Split', description: 'Split off selected geometry from connected unselected geometry', exec: () => { ops.splitSelected(md()); return done(); } }),
  editOp({
    id: 'mesh.vertices_smooth', label: 'Smooth Vertex', description: 'Flatten angles of selected vertices',
    props: { factor: { name: 'Smoothing', type: 'float', default: 0.5, min: -10, max: 10, softMin: 0, softMax: 1, subtype: 'FACTOR' }, repeat: { name: 'Repeat', type: 'int', default: 1, min: 1, max: 1000, softMax: 100 }, xaxis: { name: 'X-Axis', type: 'bool', default: true }, yaxis: { name: 'Y-Axis', type: 'bool', default: true }, zaxis: { name: 'Z-Axis', type: 'bool', default: true } },
    exec: (_c, p) => { ops.smoothVerts(md(), Number(p.factor), Number(p.repeat), [!!p.xaxis, !!p.yaxis, !!p.zaxis]); return done(); },
  }),
  editOp({
    id: 'transform.vertex_random', label: 'Randomize', description: 'Randomize vertices',
    props: { offset: { name: 'Amount', type: 'float', default: 0.1, min: -10, max: 10, subtype: 'DISTANCE' }, uniform: { name: 'Uniform', type: 'float', default: 0, min: 0, max: 1, subtype: 'FACTOR' }, normal: { name: 'normal', type: 'float', default: 0, min: 0, max: 1, subtype: 'FACTOR' }, seed: { name: 'Random Seed', type: 'int', default: 0, min: 0, max: 10000 } },
    exec: (_c, p) => { ops.randomizeVerts(md(), Number(p.offset), Number(p.seed), Number(p.uniform), Number(p.normal)); return done(); },
  }),
  editOp({ id: 'mesh.quads_convert_to_tris', label: 'Triangulate Faces', description: 'Triangulate selected faces', poll: faceSel, exec: () => { ops.quadsToTris(md()); return done(); } }),
  editOp({
    id: 'mesh.tris_convert_to_quads', label: 'Tris to Quads', description: 'Join triangles into quads', poll: faceSel,
    props: { face_threshold: { name: 'Max Face Angle', type: 'float', default: (40 * Math.PI) / 180, min: 0, max: Math.PI, subtype: 'ANGLE' } },
    exec: (_c, p) => { ops.trisToQuads(md(), (Number(p.face_threshold) * 180) / Math.PI); return done(); },
  }),
  editOp({
    id: 'mesh.specials', label: 'Specials', description: 'Specials menu (W)', undo: false, register: false, poll: isEditMesh,
    invoke: () => 'CANCELLED', exec: () => 'CANCELLED',
  }),
  // ---- mirror (object & edit)
  {
    id: 'transform.mirror', label: 'Mirror', description: 'Mirror selected items around one or more axes', undo: true, register: true,
    poll: () => (app.mode === 'EDIT' ? anySel() : app.selectedObjects().length > 0),
    props: { constraint_axis: { name: 'Constraint Axis', type: 'bools', default: [false, false, false], size: 3 }, constraint_orientation: { name: 'Orientation', type: 'enum', default: 'GLOBAL', items: [['GLOBAL', 'Global'], ['LOCAL', 'Local']] } },
    invoke: (ctx, p) => {
      if ((p.constraint_axis as boolean[]).some(Boolean)) return app.operator('transform.mirror')!.exec!(ctx, p);
      showMenu([0, 1, 2].map((i) => ({ label: `${'XYZ'[i]} Global`, action: () => void app.callOperator('transform.mirror', { constraint_axis: [0, 1, 2].map((k) => k === i) }, { area: ctx.area, exec: true }) })), app.mouse, { title: 'Mirror', atMouse: true });
      return 'CANCELLED';
    },
    exec: (ctx, p) => {
      const ax = p.constraint_axis as boolean[];
      const s = ax.map((a) => (a ? -1 : 1));
      const r = app.operator('transform.resize')!.exec!(ctx, { value: s, constraint_axis: ax, constraint_orientation: p.constraint_orientation, proportional: 'DISABLED', proportional_size: 1, proportional_edit_falloff: 'SMOOTH', _pivot: app.scene.toolSettings.pivotPoint });
      if (app.editMesh && s.filter((x) => x < 0).length % 2 === 1) {
        const m = md();
        m.faces.forEach((f, i) => { if (m.fsel[i]) f.reverse(); });
        app.tagGeometry(m.id);
      }
      return r as 'FINISHED';
    },
  },
];

export function meshCenterOfSelection(): Vec3 | null {
  const m = app.editMesh;
  if (!m) return null;
  const sel = m.faces.filter((_, i) => m.fsel[i]);
  if (!sel.length) return null;
  return polyCenter(m.verts, sel[0]);
}

export function unusedMeshHelpers(): void { void rebuildEdges; void ({} as OpProps); }
