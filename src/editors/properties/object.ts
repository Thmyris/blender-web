// Object context (properties_object.py of Blender 2.79).

import { Euler, Quaternion } from 'three';
import { app } from '../../app';
import { NUM_LAYERS, renameData, setParentKeepTransform, threeEulerOrder } from '../../core/scene';
import type { BObject, RotationMode } from '../../core/types';
import { bprop, cprop, eprop, iprop, sprop, type EnumItem, type Layout, type PanelDef } from '../../ui/layout';
import { obChannel } from '../view3d/panels';
import {
  activeWhen, customPropsBody, flatPanel, NA, naBool, naButton, naEnum, naFloat, naInt, ob, objectIconFor, type PropsCtx,
} from './common';

const ROTATION_MODES: EnumItem[] = [
  { id: 'QUATERNION', label: 'Quaternion (WXYZ)', disabled: true, description: `No Gimbal Lock: ${NA}` },
  { id: 'XYZ', label: 'XYZ Euler', description: 'XYZ Rotation Order - prone to Gimbal Lock (default)' },
  { id: 'XZY', label: 'XZY Euler', description: 'XZY Rotation Order - prone to Gimbal Lock' },
  { id: 'YXZ', label: 'YXZ Euler', description: 'YXZ Rotation Order - prone to Gimbal Lock' },
  { id: 'YZX', label: 'YZX Euler', description: 'YZX Rotation Order - prone to Gimbal Lock' },
  { id: 'ZXY', label: 'ZXY Euler', description: 'ZXY Rotation Order - prone to Gimbal Lock' },
  { id: 'ZYX', label: 'ZYX Euler', description: 'ZYX Rotation Order - prone to Gimbal Lock' },
  { id: 'AXIS_ANGLE', label: 'Axis Angle', disabled: true, description: `Axis Angle (W+XYZ): ${NA}` },
];

/** Change the euler order while keeping the orientation (Blender converts the rotation values too). */
function setRotationMode(o: BObject, mode: RotationMode): void {
  if (o.rotationMode === mode) return;
  const q = new Quaternion().setFromEuler(new Euler(o.rotation[0], o.rotation[1], o.rotation[2], threeEulerOrder(o.rotationMode)));
  const e = new Euler().setFromQuaternion(q, threeEulerOrder(mode));
  o.rotation = [e.x, e.y, e.z];
  o.rotationMode = mode;
}

function vectorColumn(l: Layout, label: string, path: 'location' | 'rotation_euler' | 'scale' | 'delta_location' | 'delta_rotation_euler' | 'delta_scale'): void {
  const col = l.column(true);
  col.label(`${label}:`);
  for (let i = 0; i < 3; i++) col.prop(obChannel(path, i, ob));
}

/** Objects that may become the parent of `o` (not itself and not one of its descendants). */
function parentCandidates(o: BObject | null): EnumItem[] {
  const items: EnumItem[] = [{ id: '', label: '', icon: 'NONE' }];
  if (!o) return items;
  const isDescendant = (c: BObject): boolean => {
    let p: BObject | undefined = c;
    while (p) { if (p.id === o.id) return true; p = p.parent ? app.doc.objects[p.parent] : undefined; }
    return false;
  };
  for (const c of app.objects()) if (!isDescendant(c)) items.push({ id: c.id, label: c.name, icon: objectIconFor(c.type) });
  return items;
}

export function objectPanels(ctx: PropsCtx): PanelDef[] {
  void ctx;
  const P: PanelDef[] = [];
  const type = ob()?.type ?? 'MESH';

  P.push({
    id: 'object.context', label: '', noHeader: true,
    draw: (l) => {
      flatPanel(l);
      const row = l.row();
      row.label('', { icon: 'OBJECT_DATA', fixed: true });
      row.prop({
        ...sprop(ob, 'name', { name: '', description: 'Unique data-block ID name', notify: ['all'], undo: 'Rename Object' }),
        set: (v: string) => { const o = ob(); if (o) renameData(app.doc, 'objects', o.id, v); },
      });
    },
  });

  P.push({
    id: 'object.transform', label: 'Transform',
    draw: (l) => {
      const row = l.row();
      row.el.style.alignItems = 'flex-start';
      vectorColumn(row, 'Location', 'location');
      vectorColumn(row, 'Rotation', 'rotation_euler');
      vectorColumn(row, 'Scale', 'scale');
      l.prop({
        kind: 'enum', name: 'Rotation Mode', items: ROTATION_MODES, notify: ['scene'], undo: 'Change Rotation Mode',
        description: 'Rotation mode', python: 'bpy.context.object.rotation_mode',
        get: () => ob()?.rotationMode ?? 'XYZ',
        set: (v) => { const o = ob(); if (o) setRotationMode(o, v as RotationMode); },
      });
    },
  });

  P.push({
    id: 'object.delta_transform', label: 'Delta Transform', defaultClosed: true,
    draw: (l) => {
      const row = l.row();
      row.el.style.alignItems = 'flex-start';
      vectorColumn(row, 'Delta Location', 'delta_location');
      vectorColumn(row, 'Delta Rotation', 'delta_rotation_euler');
      vectorColumn(row, 'Delta Scale', 'delta_scale');
    },
  });

  P.push({
    id: 'object.relations', label: 'Relations',
    draw: (l) => {
      const sp = l.split();
      const c1 = sp.column();
      c1.label('Layers:');
      c1.layers(() => ob()?.layers ?? [], (next) => {
        const o = ob();
        if (!o) return;
        o.layers = next.slice(0, NUM_LAYERS);
        app.pushUndo('Change Layers');
        app.notify('scene', 'select');
      });
      c1.separator();
      c1.prop(iprop(ob, 'passIndex', { name: 'Pass Index', min: 0, max: 32767, description: 'Index number for the "Object Index" render pass' }));
      const c2 = sp.column();
      c2.label('Parent:');
      c2.prop({
        kind: 'enum', name: 'Parent', notify: ['scene'], undo: 'Change Parent',
        description: 'Parent Object', python: 'bpy.context.object.parent',
        items: () => parentCandidates(ob()),
        get: () => ob()?.parent ?? '',
        set: (v) => {
          const o = ob();
          if (!o) return;
          const p = v ? app.doc.objects[v] ?? null : null;
          app.matrices.clear();
          setParentKeepTransform(app.doc, o, p, app.matrices);
        },
      }, { noLabel: true });
      const sub = c2.column();
      activeWhen(sub, () => !!ob()?.parent);
      sub.prop(naEnum('Parent Type', [
        { id: 'OBJECT', label: 'Object' }, { id: 'ARMATURE', label: 'Armature', disabled: true }, { id: 'LATTICE', label: 'Lattice', disabled: true },
        { id: 'VERTEX', label: 'Vertex', disabled: true }, { id: 'VERTEX_3', label: '3 Vertices', disabled: true }, { id: 'BONE', label: 'Bone', disabled: true },
      ], 'OBJECT'), { noLabel: true });
    },
  });

  P.push({
    id: 'object.groups', label: 'Groups',
    draw: (l) => {
      const row = l.row(true);
      naButton(row, 'Add to Group');
      naButton(row, '', 'ZOOMIN', true).classList.add('fixed');
    },
  });

  P.push({
    id: 'object.display', label: 'Display', key: () => ob()?.type ?? '',
    draw: (l) => {
      const isGeom = type === 'MESH';
      const isWire = type === 'CAMERA' || type === 'EMPTY';
      const sp = l.split();
      const c1 = sp.column();
      c1.prop(bprop(ob, 'showName', { name: 'Name', description: "Display the object's name", notify: ['data'] }));
      c1.prop(bprop(ob, 'showAxis', { name: 'Axis', description: "Display the object's origin and axes", notify: ['data'] }));
      if (isGeom) {
        c1.prop(bprop(ob, 'showWire', { name: 'Wire', description: "Add the object's wireframe over solid drawing", notify: ['data'] }));
        c1.prop(naBool('Draw All Edges'));
      }
      const c2 = sp.column();
      const r = c2.row();
      r.prop(bprop(ob, 'showBounds', { name: 'Bounds', description: "Display the object's bounds", notify: ['data'] }));
      const rs = r.row();
      activeWhen(rs, () => !!ob()?.showBounds);
      rs.prop(naEnum('Draw Bounds Type', ['Box', 'Sphere', 'Cylinder', 'Cone', 'Capsule'], 'Box'), { noLabel: true });
      if (isGeom) c2.prop(naBool('Texture Space'));
      c2.prop(bprop(ob, 'showXRay', { name: 'X-Ray', description: 'Make the object draw in front of others', notify: ['data'] }));
      if (isGeom) c2.prop(bprop(ob, 'showTransparent', { name: 'Transparency', description: 'Display material transparency in the object', notify: ['data'] }));

      const sp2 = l.split();
      const d1 = sp2.column();
      const drawTypes: EnumItem[] = [
        { id: 'BOUNDS', label: 'Bounds', description: 'Draw the bounds of the object' },
        { id: 'WIRE', label: 'Wire', description: 'Draw the object as a wireframe' },
        { id: 'SOLID', label: 'Solid', description: 'Draw the object as a solid (if solid drawing is enabled in the viewport)' },
        { id: 'TEXTURED', label: 'Textured', description: 'Draw the object with textures (if textures are enabled in the viewport)' },
      ];
      if (isWire) {
        // wire objects only use the maximum draw type for duplis (not supported)
        d1.label('Maximum Dupli Draw Type:', { disabled: true });
        d1.prop(naEnum('Maximum Draw Type', drawTypes, ob()?.drawType ?? 'TEXTURED'), { noLabel: true });
      } else {
        d1.label('Maximum Draw Type:');
        d1.prop(eprop(ob, 'drawType', drawTypes, { name: 'Maximum Draw Type', description: 'Maximum draw type to display object with in viewport', notify: ['data'] }), { noLabel: true });
      }
      const d2 = sp2.column();
      if (isGeom) {
        d2.label('Object Color:');
        d2.prop(cprop(ob, 'color', { name: 'Object Color', description: 'Object color and alpha, used when faces have the ObColor mode enabled', alpha: true, notify: ['data'] }), { text: '' });
      }
    },
  });

  P.push({
    id: 'object.duplication', label: 'Duplication',
    draw: (l) => {
      l.row().prop({
        kind: 'enum', name: 'Duplication', undo: false, description: 'If not None, object duplication method to use',
        items: [
          { id: 'NONE', label: 'None' },
          { id: 'FRAMES', label: 'Frames', disabled: true, description: NA },
          { id: 'VERTS', label: 'Verts', disabled: true, description: NA },
          { id: 'FACES', label: 'Faces', disabled: true, description: NA },
          { id: 'GROUP', label: 'Group', disabled: true, description: NA },
        ],
        get: () => 'NONE', set: () => {},
      }, { expand: true });
    },
  });

  P.push({
    id: 'object.relations_extras', label: 'Relations Extras', defaultClosed: true,
    draw: (l) => {
      const sp = l.split();
      const c1 = sp.column();
      c1.label('Tracking Axes:', { disabled: true });
      c1.prop(naEnum('Axis', ['+X', '+Y', '+Z', '-X', '-Y', '-Z'], '+Y'));
      c1.prop(naEnum('Up Axis', ['X', 'Y', 'Z'], 'Z'));
      const c2 = sp.column();
      c2.prop(naBool('Slow Parent'));
      c2.prop(naFloat('Offset', 0));
      l.prop(naBool('Extra Object Update'));
      l.prop(naBool('Extra Data Update'));
    },
  });

  P.push({
    id: 'object.motion_paths', label: 'Motion Paths', defaultClosed: true,
    draw: (l) => {
      const sp = l.split();
      const c1 = sp.column();
      c1.label('Paths Type:', { disabled: true });
      c1.row().prop(naEnum('Paths Type', ['Around Frame', 'In Range'], 'In Range'), { expand: true });
      const c2 = sp.column();
      c2.label('Frame Range:', { disabled: true });
      const sub = c2.column(true);
      sub.prop(naInt('Start', 1));
      sub.prop(naInt('End', 250));
      sub.prop(naInt('Step', 1));
      const row = l.row(true);
      naButton(row, 'Calculate');
      naButton(row, 'Clear');
    },
  });

  P.push({ id: 'object.custom_props', label: 'Custom Properties', defaultClosed: true, draw: customPropsBody });
  return P;
}
