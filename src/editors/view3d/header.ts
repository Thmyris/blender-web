// 3D View header widgets (after the menus): mode, shading, pivot, manipulator,
// orientation, select mode, layers, proportional editing, snapping, OpenGL render.

import { app } from '../../app';
import type { Layout, EnumItem } from '../../ui/layout';
import { h } from '../../ui/dom';
import type { View3D } from './view3d';
import type { Shading } from './draw';
import { hasEditType } from './edittypes';

export const SHADING_ITEMS: EnumItem[] = [
  { id: 'RENDERED', label: 'Rendered', icon: 'RENDERED' },
  { id: 'MATERIAL', label: 'Material', icon: 'MATERIAL_SHADED' },
  { id: 'TEXTURED', label: 'Texture', icon: 'TEXTURE_SHADED' },
  { id: 'SOLID', label: 'Solid', icon: 'SOLID' },
  { id: 'WIREFRAME', label: 'Wireframe', icon: 'WIRE' },
  { id: 'BOUNDBOX', label: 'Bounding Box', icon: 'BBOX' },
];

export const PIVOT_ITEMS: EnumItem[] = [
  { id: 'BOUNDING_BOX_CENTER', label: 'Bounding Box Center', icon: 'ROTATE', description: 'Pivot around bounding box center of selected object(s)' },
  { id: 'CURSOR', label: '3D Cursor', icon: 'CURSOR', description: 'Pivot around the 3D cursor' },
  { id: 'INDIVIDUAL_ORIGINS', label: 'Individual Origins', icon: 'ROTATECOLLECTION', description: "Pivot around each object's own origin" },
  { id: 'MEDIAN_POINT', label: 'Median Point', icon: 'ROTATECENTER', description: 'Pivot around the median point of selected objects' },
  { id: 'ACTIVE_ELEMENT', label: 'Active Element', icon: 'ROTACTIVE', description: 'Pivot around active object' },
];

export const MODE_ITEMS: EnumItem[] = [
  { id: 'OBJECT', label: 'Object Mode', icon: 'OBJECT_DATAMODE' },
  { id: 'EDIT', label: 'Edit Mode', icon: 'EDITMODE_HLT' },
  { id: 'SCULPT', label: 'Sculpt Mode', icon: 'SCULPTMODE_HLT' },
  { id: 'VERTEX_PAINT', label: 'Vertex Paint', icon: 'VPAINT_HLT' },
  { id: 'WEIGHT_PAINT', label: 'Weight Paint', icon: 'WPAINT_HLT' },
  { id: 'TEXTURE_PAINT', label: 'Texture Paint', icon: 'TPAINT_HLT', disabled: true, description: 'Not available in blender-web' },
  { id: 'POSE', label: 'Pose Mode', icon: 'POSE_HLT' },
];

export const ORIENT_ITEMS: EnumItem[] = [
  { id: 'GLOBAL', label: 'Global' }, { id: 'LOCAL', label: 'Local' }, { id: 'NORMAL', label: 'Normal' },
  { id: 'GIMBAL', label: 'Gimbal' }, { id: 'VIEW', label: 'View' },
];

const ts = () => app.scene.toolSettings;

export function drawView3DHeader(view: View3D, l: Layout): void {
  const row = l.row();
  row.el.classList.add('header-row');
  row.el.style.flex = '0 0 auto';
  // mode
  const ob = app.activeObject;
  // like 2.79, only the modes of the active object's type are listed (armatures: Object / Edit / Pose)
  const modeItems = MODE_ITEMS.filter((m) => (ob?.type === 'ARMATURE' ? ['OBJECT', 'EDIT', 'POSE'].includes(m.id) : m.id !== 'POSE')).map((m) => ((m.id === 'EDIT' ? !(ob && (ob.type === 'MESH' || ob.type === 'FONT' || hasEditType(ob.type))) : (m.id === 'SCULPT' || m.id === 'VERTEX_PAINT' || m.id === 'WEIGHT_PAINT') && ob?.type !== 'MESH') ? { ...m, disabled: true } : m));
  const modeEl = row.prop({
    kind: 'enum', name: 'Mode', items: modeItems, get: () => app.mode, undo: false,
    set: (v) => { void app.callOperator('object.mode_set', { mode: v }, { area: view.area }); },
    description: 'Object interaction mode', python: 'bpy.ops.object.mode_set(mode=...)',
  }, { noLabel: true });
  modeEl.style.flex = '0 0 auto';
  modeEl.style.width = '118px';
  // viewport shading
  const shadeEl = row.prop({
    kind: 'enum', name: 'Viewport Shading', items: SHADING_ITEMS, get: () => view.display.shading, undo: false, notify: ['view'],
    set: (v) => { view.display.shading = v as Shading; view.requestRender(); }, description: 'Method to display/shade objects in the 3D View',
  }, { iconOnly: true });
  shadeEl.style.flex = '0 0 auto';
  shadeEl.style.width = '36px';
  // pivot point
  const pivotEl = row.prop({
    kind: 'enum', name: 'Pivot Point', items: PIVOT_ITEMS, get: () => ts().pivotPoint, undo: false, notify: ['view'],
    set: (v) => { ts().pivotPoint = v as typeof ts.prototype; }, description: 'Pivot center for rotation/scaling',
  }, { iconOnly: true });
  pivotEl.style.flex = '0 0 auto';
  pivotEl.style.width = '36px';
  // manipulator
  const manip = l.row(true);
  manip.el.style.flex = '0 0 auto';
  manip.prop({ kind: 'bool', name: 'Manipulator', get: () => view.display.manipulator, set: (v) => { view.display.manipulator = v; }, notify: ['view'], undo: false, description: 'Use a 3D manipulator widget for controlling transforms' }, { iconOnly: true, icon: 'MANIPUL' });
  manip.prop({ kind: 'bool', name: 'Translate', get: () => view.display.manipTranslate, set: (v) => { view.display.manipTranslate = v; if (!v && !view.display.manipRotate && !view.display.manipScale) view.display.manipTranslate = true; }, notify: ['view'], undo: false, description: 'Use the manipulator for movement transformations', disabled: () => !view.display.manipulator }, { iconOnly: true, icon: 'MAN_TRANS' });
  manip.prop({ kind: 'bool', name: 'Rotate', get: () => view.display.manipRotate, set: (v) => { view.display.manipRotate = v; }, notify: ['view'], undo: false, description: 'Use the manipulator for rotation transformations', disabled: () => !view.display.manipulator }, { iconOnly: true, icon: 'MAN_ROT' });
  manip.prop({ kind: 'bool', name: 'Scale', get: () => view.display.manipScale, set: (v) => { view.display.manipScale = v; }, notify: ['view'], undo: false, description: 'Use the manipulator for scale transformations', disabled: () => !view.display.manipulator }, { iconOnly: true, icon: 'MAN_SCALE' });
  const orientEl = l.prop({ kind: 'enum', name: 'Transform Orientation', items: ORIENT_ITEMS, get: () => ts().transformOrientation, set: (v) => { ts().transformOrientation = v as never; }, undo: false, notify: ['view'], description: 'Transformation orientation' }, { noLabel: true });
  orientEl.style.flex = '0 0 auto';
  orientEl.style.width = '76px';
  // edit mode: select mode + occlude
  if (app.mode === 'EDIT' && app.editMesh) {
    const sm = l.row(true);
    sm.el.style.flex = '0 0 auto';
    const names = ['Vertex select mode', 'Edge select mode', 'Face select mode'];
    ['VERTEXSEL', 'EDGESEL', 'FACESEL'].forEach((ic, i) => {
      const el = h('div', { class: 'icon-btn emboss' });
      el.append(...[iconEl(ic)]);
      el.title = '';
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        const type = ['VERT', 'EDGE', 'FACE'][i];
        void app.callOperator('mesh.select_mode', { type, use_extend: e.shiftKey }, { area: view.area });
      });
      sm.custom(el, () => el.classList.toggle('on', ts().meshSelectMode[i]));
      void names;
    });
    sm.prop({ kind: 'bool', name: 'Limit selection to visible', get: () => view.display.useOcclude, set: (v) => { view.display.useOcclude = v; view.renderer.invalidateEdit(); }, undo: false, notify: ['view'], description: 'Limit selection to visible (clipped with depth buffer)' }, { iconOnly: true, icon: 'ORTHO' });
  }
  // layers
  const lay = l.row();
  lay.el.style.flex = '0 0 auto';
  lay.layers(
    () => (view.display.useLocalLayers ? view.display.layers : app.scene.layers),
    (layers) => {
      if (view.display.useLocalLayers) view.display.layers = layers;
      else { app.scene.layers = layers; app.pushUndo('Change Layers'); }
      app.notify('scene');
    },
    {
      used: () => { const u = new Array(20).fill(false); for (const o of app.objects()) o.layers.forEach((x, i) => { if (x) u[i] = true; }); return u; },
      activeOb: () => app.activeObject?.layers ?? [],
    },
  );
  lay.prop({ kind: 'bool', name: 'Lock', get: () => !view.display.useLocalLayers, set: (v) => { view.display.useLocalLayers = !v; if (!v) view.display.layers = app.scene.layers.slice(); }, undo: false, notify: ['view'], description: 'Lock layers and used Camera to Scene' }, { iconOnly: true, icon: 'LOCKED', iconOn: 'LOCKED' });
  // proportional editing
  const pr = l.row(true);
  pr.el.style.flex = '0 0 auto';
  const propEl = pr.prop({
    kind: 'enum', name: 'Proportional Editing', undo: false, notify: ['view'], get: () => ts().proportionalEdit, set: (v) => { ts().proportionalEdit = v as never; },
    items: [{ id: 'DISABLED', label: 'Disable', icon: 'PROP_OFF' }, { id: 'ENABLED', label: 'Enable', icon: 'PROP_ON' }, { id: 'CONNECTED', label: 'Connected', icon: 'PROP_CON' }],
    description: 'Proportional Editing mode, allows transforms with distance fall-off', disabled: () => app.mode !== 'EDIT',
  }, { iconOnly: true });
  propEl.style.width = '36px';
  if (ts().proportionalEdit !== 'DISABLED') {
    const fo = pr.prop({
      kind: 'enum', name: 'Proportional Editing Falloff', undo: false, get: () => ts().proportionalFalloff, set: (v) => { ts().proportionalFalloff = v as never; },
      items: ['SMOOTH', 'SPHERE', 'ROOT', 'INVERSE_SQUARE', 'SHARP', 'LINEAR', 'CONSTANT', 'RANDOM'].map((id) => ({ id, label: id.split('_').map((s) => s[0] + s.slice(1).toLowerCase()).join(' ') })),
    }, { noLabel: true });
    fo.style.width = '90px';
  }
  // snapping
  const sn = l.row(true);
  sn.el.style.flex = '0 0 auto';
  sn.prop({ kind: 'bool', name: 'Snap', get: () => ts().useSnap, set: (v) => { ts().useSnap = v; }, undo: false, notify: ['view'], description: 'Snap during transform (hold Ctrl to toggle while transforming)' }, { iconOnly: true, icon: 'SNAP_OFF', iconOn: 'SNAP_ON' });
  const se = sn.prop({
    kind: 'enum', name: 'Snap Element', undo: false, get: () => ts().snapElement, set: (v) => { ts().snapElement = v as never; },
    items: [{ id: 'INCREMENT', label: 'Increment', icon: 'SNAP_INCREMENT' }, { id: 'VERTEX', label: 'Vertex', icon: 'SNAP_VERTEX' }, { id: 'EDGE', label: 'Edge', icon: 'SNAP_EDGE' }, { id: 'FACE', label: 'Face', icon: 'SNAP_FACE' }, { id: 'VOLUME', label: 'Volume', icon: 'SNAP_VOLUME', disabled: true, description: 'Volume snapping is not available in blender-web' }],
  }, { iconOnly: true });
  se.style.width = '36px';
  // OpenGL render
  const gl = l.row(true);
  gl.el.style.flex = '0 0 auto';
  gl.operator('render.opengl', { iconOnly: true, icon: 'RENDER_STILL', props: { animation: false } });
  gl.operator('render.opengl', { iconOnly: true, icon: 'RENDER_ANIMATION', props: { animation: true } });
}

import { icon as iconEl } from '../../ui/icons';
