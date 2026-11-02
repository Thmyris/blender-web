// 3D View navigation, region toggles, selection tools and snapping operators.

import { Matrix4, Quaternion, Vector3 } from 'three';
import { app, type OperatorDef, type OpContext } from '../app';
import { setBasisFromMatrix } from '../core/scene';
import { VIEW_QUATS } from '../editors/view3d/viewstate';
import { startBorderSelect, startCircleSelect } from '../editors/view3d/select';
import type { Shading } from '../editors/view3d/draw';
import { viewOf } from './common';

const hasView = (ctx: OpContext) => !!viewOf(ctx);
const deg = Math.PI / 180;

function withView(fn: (ctx: OpContext, v: NonNullable<ReturnType<typeof viewOf>>, p: Record<string, unknown>) => void) {
  return (ctx: OpContext, p: Record<string, unknown>) => {
    const v = viewOf(ctx);
    if (!v) return 'CANCELLED' as const;
    fn(ctx, v, p);
    v.requestRender();
    app.notify('view');
    return 'FINISHED' as const;
  };
}

function moveSelectionTo(target: (p: Vector3) => Vector3, offsetMode = false): void {
  const md = app.editMesh, ob = app.editObj;
  if (md && ob) {
    const m = app.matrices.world(ob);
    const inv = m.clone().invert();
    const sel = md.verts.map((_, i) => i).filter((i) => md.vsel[i]);
    if (offsetMode) {
      const c = new Vector3();
      for (const i of sel) c.add(new Vector3(...md.verts[i]).applyMatrix4(m));
      c.multiplyScalar(1 / Math.max(1, sel.length));
      const d = target(c).sub(c);
      for (const i of sel) { const p = new Vector3(...md.verts[i]).applyMatrix4(m).add(d).applyMatrix4(inv); md.verts[i] = [p.x, p.y, p.z]; }
    } else {
      for (const i of sel) { const p = target(new Vector3(...md.verts[i]).applyMatrix4(m)).applyMatrix4(inv); md.verts[i] = [p.x, p.y, p.z]; }
    }
    app.tagGeometry(md.id);
    return;
  }
  const sel = app.selectedObjects();
  const c = new Vector3();
  for (const o of sel) c.add(app.matrices.location(o));
  c.multiplyScalar(1 / Math.max(1, sel.length));
  const d = offsetMode ? target(c).sub(c) : null;
  for (const o of sel) {
    const world = app.matrices.world(o).clone();
    const pos = new Vector3().setFromMatrixPosition(world);
    const np = d ? pos.clone().add(d) : target(pos);
    world.setPosition(np);
    const parentMat = o.parent && app.doc.objects[o.parent] ? app.matrices.world(app.doc.objects[o.parent]).clone().multiply(new Matrix4().fromArray(o.parentInverse)) : new Matrix4();
    const rot = o.rotation.slice(), scl = o.scale.slice();
    setBasisFromMatrix(o, parentMat.invert().multiply(world));
    o.rotation = rot as typeof o.rotation;
    o.scale = scl as typeof o.scale;
  }
  app.notify('scene');
}

const gridSnap = (p: Vector3, step = 1) => new Vector3(Math.round(p.x / step) * step, Math.round(p.y / step) * step, Math.round(p.z / step) * step);

function selectionCenterWorld(): Vector3 | null {
  const md = app.editMesh, ob = app.editObj;
  if (md && ob) {
    const m = app.matrices.world(ob);
    const c = new Vector3();
    let n = 0;
    md.verts.forEach((v, i) => { if (md.vsel[i]) { c.add(new Vector3(...v).applyMatrix4(m)); n++; } });
    return n ? c.multiplyScalar(1 / n) : null;
  }
  const sel = app.selectedObjects();
  if (!sel.length) return null;
  const c = new Vector3();
  for (const o of sel) c.add(app.matrices.location(o));
  return c.multiplyScalar(1 / sel.length);
}

const shadingToggle = (id: string, label: string, a: Shading, b: Shading, desc: string): OperatorDef => ({
  id, label, description: desc, poll: hasView,
  exec: withView((_c, v) => { v.display.shading = v.display.shading === a ? b : a; v.rebuildHeader(true); }),
});

export const VIEW_OPERATORS: OperatorDef[] = [
  {
    id: 'view3d.viewnumpad', label: 'View Numpad', description: 'Use a preset viewpoint', poll: hasView,
    props: { type: { name: 'View', type: 'enum', default: 'FRONT', items: [['LEFT', 'Left'], ['RIGHT', 'Right'], ['BOTTOM', 'Bottom'], ['TOP', 'Top'], ['FRONT', 'Front'], ['BACK', 'Back'], ['CAMERA', 'Camera']] }, align_active: { name: 'Align Active', type: 'bool', default: false } },
    exec: withView((_c, v, p) => {
      const t = p.type as keyof typeof VIEW_QUATS | 'CAMERA';
      if (t === 'CAMERA') { v.view.toggleCamera(); return; }
      if (p.align_active) {
        const ob = app.editObj ?? app.activeObject;
        if (ob) {
          const q = new Quaternion();
          app.matrices.world(ob).decompose(new Vector3(), q, new Vector3());
          v.view.setView(t, q.multiply(VIEW_QUATS[t]));
          return;
        }
      }
      v.view.setView(t);
    }),
  },
  { id: 'view3d.view_persportho', label: 'View Persp/Ortho', description: 'Switch the current view from perspective/orthographic projection', poll: hasView, exec: withView((_c, v) => v.view.togglePersp()) },
  {
    id: 'view3d.view_orbit', label: 'View Orbit', description: 'Orbit the view', poll: hasView,
    props: { type: { name: 'Orbit', type: 'enum', default: 'ORBITLEFT', items: [['ORBITLEFT', 'Orbit Left'], ['ORBITRIGHT', 'Orbit Right'], ['ORBITUP', 'Orbit Up'], ['ORBITDOWN', 'Orbit Down']] }, angle: { name: 'Roll', type: 'float', default: 0, subtype: 'ANGLE' } },
    exec: withView((_c, v, p) => {
      const a = (Number(p.angle) || app.prefs.rotationAngle * deg);
      switch (p.type) {
        case 'ORBITLEFT': v.view.orbitStep('Z', -a); break;
        case 'ORBITRIGHT': v.view.orbitStep('Z', a); break;
        case 'ORBITUP': v.view.orbitStep('X', -a); break;
        case 'ORBITDOWN': v.view.orbitStep('X', a); break;
      }
    }),
  },
  {
    id: 'view3d.view_roll', label: 'View Roll', description: 'Roll the view', poll: hasView,
    props: { angle: { name: 'Roll', type: 'float', default: 15 * deg, subtype: 'ANGLE' } },
    exec: withView((_c, v, p) => {
      if (v.view.persp === 'CAMERA') v.view.leaveCamera();
      const fwd = new Vector3(0, 0, 1).applyQuaternion(v.view.rot);
      v.view.smoothTo({ rot: v.view.rot.clone().premultiply(new Quaternion().setFromAxisAngle(fwd, Number(p.angle))) });
      v.view.viewName = 'USER';
    }),
  },
  {
    id: 'view3d.view_pan', label: 'View Pan', description: 'Pan the view', poll: hasView,
    props: { type: { name: 'Pan', type: 'enum', default: 'PANLEFT', items: [['PANLEFT', 'Pan Left'], ['PANRIGHT', 'Pan Right'], ['PANUP', 'Pan Up'], ['PANDOWN', 'Pan Down']] } },
    exec: withView((_c, v, p) => {
      const d = 40;
      if (p.type === 'PANLEFT') v.view.pan(d, 0);
      else if (p.type === 'PANRIGHT') v.view.pan(-d, 0);
      else if (p.type === 'PANUP') v.view.pan(0, d);
      else v.view.pan(0, -d);
    }),
  },
  {
    id: 'view3d.zoom', label: 'Zoom View', description: 'Zoom in/out in the view', poll: hasView,
    props: { delta: { name: 'Delta', type: 'int', default: 0 } },
    exec: withView((_c, v, p) => v.view.zoom(Number(p.delta) > 0 ? 1 / 1.2 : 1.2)),
  },
  { id: 'view3d.zoom_camera_1_to_1', label: 'Zoom Camera 1:1', description: 'Match the camera to 1:1 to the render output', poll: (c) => !!viewOf(c) && viewOf(c)!.view.persp === 'CAMERA', exec: withView((_c, v) => { v.view.camZoom = 0; v.view.camOffset.set(0, 0); }) },
  {
    id: 'view3d.view_selected', label: 'View Selected', description: 'Move the view to the selection center', poll: hasView,
    exec: withView((_c, v) => { const b = v.boundsOf(true); if (b) v.view.frameBounds(b.center, b.radius); }),
  },
  {
    id: 'view3d.view_all', label: 'View All', description: 'View all objects in scene', poll: hasView,
    props: { center: { name: 'Center', type: 'bool', default: false } },
    exec: withView((_c, v, p) => {
      if (p.center) app.scene.cursor = [0, 0, 0];
      const b = v.boundsOf(false);
      if (b) v.view.frameBounds(p.center ? new Vector3(0, 0, 0) : b.center, p.center ? b.center.length() + b.radius : b.radius);
    }),
  },
  { id: 'view3d.view_center_cursor', label: 'Center View to Cursor', description: 'Center the view so that the cursor is in the middle of the view', poll: hasView, exec: withView((_c, v) => v.view.smoothTo({ target: new Vector3(...app.scene.cursor) })) },
  { id: 'view3d.view_lock_to_active', label: 'View Lock to Active', description: 'Lock the view to the active object (not available)', poll: () => false, exec: () => 'CANCELLED' },
  { id: 'view3d.view_lock_clear', label: 'View Lock Clear', description: 'Clear all view locking', poll: () => false, exec: () => 'CANCELLED' },
  { id: 'view3d.localview', label: 'Local View', description: 'Toggle display of selected object(s) separately and centered in view', poll: hasView, exec: withView((_c, v) => v.toggleLocalView()) },
  {
    id: 'view3d.object_as_camera', label: 'Set Active Object as Camera', description: 'Set the active object as the active camera for this view or scene', undo: true, register: true,
    poll: (c) => hasView(c) && app.activeObject?.type === 'CAMERA',
    exec: withView((_c, v) => { app.scene.camera = app.activeObject!.id; v.view.lastPersp = v.view.persp === 'ORTHO' ? 'ORTHO' : 'PERSP'; v.view.persp = 'CAMERA'; }),
  },
  {
    id: 'view3d.camera_to_view', label: 'Align Camera To View', description: 'Set camera view to active view', undo: true, register: true,
    poll: (c) => hasView(c) && !!app.scene.camera && viewOf(c)!.view.persp !== 'CAMERA',
    exec: withView((_c, v) => {
      const cam = app.doc.objects[app.scene.camera!];
      v.view.setCameraWorld(cam, v.view.eye(), v.view.rot.clone());
      v.view.lastPersp = v.view.persp === 'ORTHO' ? 'ORTHO' : 'PERSP';
      v.view.persp = 'CAMERA';
    }),
  },
  {
    id: 'view3d.camera_to_view_selected', label: 'Camera Fit Frame to Selected', description: 'Move the camera so selected objects are framed', undo: true, register: true,
    poll: (c) => hasView(c) && !!app.scene.camera,
    exec: withView((_c, v) => {
      const b = v.boundsOf(true);
      const cam = app.doc.objects[app.scene.camera!];
      const cd = cam.data ? app.doc.cameras[cam.data] : null;
      if (!b || !cd) return;
      const q = new Quaternion();
      app.matrices.world(cam).decompose(new Vector3(), q, new Vector3());
      const half = Math.atan(cd.sensorWidth / 2 / cd.lens);
      const d = b.radius / Math.sin(half);
      const pos = b.center.clone().add(new Vector3(0, 0, d).applyQuaternion(q));
      v.view.setCameraWorld(cam, pos, q);
    }),
  },
  {
    id: 'view3d.toolshelf', label: 'Tool Shelf', description: 'Toggles tool shelf display', poll: hasView,
    exec: withView((_c, v) => v.toggleRegion('toolshelf')),
  },
  {
    id: 'view3d.properties', label: 'Properties', description: 'Toggles the properties panel display', poll: hasView,
    exec: withView((_c, v) => v.toggleRegion('npanel')),
  },
  {
    id: 'view3d.layers', label: 'Layers', description: 'Toggle layer(s) visibility', poll: hasView, undo: true,
    props: { nr: { name: 'Number', type: 'int', default: 1, min: 0, max: 20 }, extend: { name: 'Extend', type: 'bool', default: false } },
    exec: withView((_c, v, p) => {
      const i = Number(p.nr) - 1;
      const target = v.display.useLocalLayers ? v.display.layers : app.scene.layers;
      let next: boolean[];
      if (i < 0) next = target.map(() => true);
      else if (p.extend) { next = target.slice(); next[i] = !next[i]; if (!next.some(Boolean)) next[i] = true; }
      else { next = target.map(() => false); next[i] = true; }
      if (v.display.useLocalLayers) v.display.layers = next; else app.scene.layers = next;
      app.notify('scene');
    }),
  },
  { id: 'view3d.select_border', label: 'Border Select', description: 'Select items using border selection', poll: hasView, exec: withView((_c, v) => startBorderSelect(v)) },
  { id: 'view3d.select_circle', label: 'Circle Select', description: 'Select items using circle selection', poll: hasView, exec: withView((_c, v) => startCircleSelect(v)) },
  shadingToggle('view3d.toggle_wireframe', 'Toggle Wireframe', 'WIREFRAME', 'SOLID', 'Toggle wireframe shading'),
  shadingToggle('view3d.toggle_textured', 'Toggle Textured', 'TEXTURED', 'SOLID', 'Toggle textured shading'),
  shadingToggle('view3d.toggle_rendered', 'Toggle Rendered', 'RENDERED', 'SOLID', 'Toggle rendered shading'),
  {
    id: 'view3d.toggle_xray_occlude', label: 'Limit Selection to Visible', poll: (c) => hasView(c) && app.mode === 'EDIT',
    exec: withView((_c, v) => { v.display.useOcclude = !v.display.useOcclude; v.renderer.invalidateEdit(); v.rebuildHeader(true); }),
  },
  {
    id: 'view3d.pivot_set', label: 'Set Pivot Point', poll: hasView,
    props: { type: { name: 'Pivot', type: 'enum', default: 'MEDIAN_POINT', items: [['BOUNDING_BOX_CENTER', 'Bounding Box Center'], ['CURSOR', '3D Cursor'], ['INDIVIDUAL_ORIGINS', 'Individual Origins'], ['MEDIAN_POINT', 'Median Point'], ['ACTIVE_ELEMENT', 'Active Element']] } },
    exec: withView((_c, _v, p) => { app.scene.toolSettings.pivotPoint = p.type as never; }),
  },
  {
    id: 'view3d.manipulator_toggle', label: 'Toggle Manipulator', poll: hasView,
    exec: withView((_c, v) => { v.display.manipulator = !v.display.manipulator; v.rebuildHeader(true); }),
  },
  // ---- snapping
  { id: 'view3d.snap_cursor_to_selected', label: 'Snap Cursor to Selected', description: 'Snap cursor to center of selected item(s)', undo: true, register: true, poll: () => !!selectionCenterWorld(), exec: () => { const c = selectionCenterWorld()!; app.scene.cursor = [c.x, c.y, c.z]; return 'FINISHED'; } },
  { id: 'view3d.snap_cursor_to_center', label: 'Snap Cursor to Center', description: 'Snap 3D cursor to the world origin', undo: true, register: true, exec: () => { app.scene.cursor = [0, 0, 0]; return 'FINISHED'; } },
  { id: 'view3d.snap_cursor_to_grid', label: 'Snap Cursor to Grid', description: 'Snap cursor to nearest grid division', undo: true, register: true, exec: () => { const c = gridSnap(new Vector3(...app.scene.cursor)); app.scene.cursor = [c.x, c.y, c.z]; return 'FINISHED'; } },
  {
    id: 'view3d.snap_cursor_to_active', label: 'Snap Cursor to Active', description: 'Snap cursor to active item', undo: true, register: true, poll: () => !!app.activeObject,
    exec: () => {
      const md = app.editMesh;
      if (md && app.editObj && md.activeFace >= 0) {
        const f = md.faces[md.activeFace];
        const c = new Vector3();
        for (const i of f) c.add(new Vector3(...md.verts[i]));
        c.multiplyScalar(1 / f.length).applyMatrix4(app.matrices.world(app.editObj));
        app.scene.cursor = [c.x, c.y, c.z];
      } else {
        const c = app.matrices.location(app.activeObject!);
        app.scene.cursor = [c.x, c.y, c.z];
      }
      return 'FINISHED';
    },
  },
  { id: 'view3d.snap_selected_to_grid', label: 'Snap Selection to Grid', description: 'Snap selected item(s) to nearest grid division', undo: true, register: true, poll: () => !!selectionCenterWorld(), exec: () => { moveSelectionTo((p) => gridSnap(p)); return 'FINISHED'; } },
  {
    id: 'view3d.snap_selected_to_cursor', label: 'Snap Selection to Cursor', description: 'Snap selected item(s) to cursor', undo: true, register: true, poll: () => !!selectionCenterWorld(),
    props: { use_offset: { name: 'Offset', type: 'bool', default: true } },
    exec: (_c, p) => { const cur = new Vector3(...app.scene.cursor); moveSelectionTo(() => cur.clone(), !!p.use_offset); return 'FINISHED'; },
  },
  {
    id: 'view3d.snap_selected_to_active', label: 'Snap Selection to Active', description: 'Snap selected item(s) to the active item', undo: true, register: true,
    poll: () => !!selectionCenterWorld() && !!app.activeObject,
    exec: () => { const a = app.matrices.location(app.activeObject!); moveSelectionTo(() => a.clone()); return 'FINISHED'; },
  },
];
