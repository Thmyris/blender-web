// Properties editor panels of the rigging toolset (Blender 2.79 layouts): the mesh "Vertex Groups"
// panel, the Armature and Lattice data tabs, the Bone and Bone Constraints tabs, and the Armature,
// Lattice, Hook, Mask and Vertex Weight modifier panels.

import { app } from '../../app';
import type { ArmatureData, BObject, Bone, BoneConstraint, LatticeData, Modifier, PoseBone } from '../../core/types';
import { bprop, eprop, fprop, iprop, type EnumItem, type Layout, type PanelDef, type Prop } from '../../ui/layout';
import type { MenuItem } from '../../ui/menu';
import { h } from '../../ui/dom';
import { activeWhen, callOp, flatPanel, NA, naBool, naButton, naEnum, ob, objectItems, richList, type PropsCtx } from './common';
import { objectDataTemplate } from './data_template';
import { DRAW, DEFORM_TYPES } from './modifiers';
import { armatureOf, boneByName, poseBone, renameBone, isBoneVisible } from '../../core/armature';
import { activeGroupIndex, groupsOf, uniqueGroupName } from '../../core/vgroups';
import { regrid } from '../../core/lattice';
import { setRotationMode, newBoneConstraint } from '../view3d/pose';
import { flushArmSelection } from '../view3d/armedit';

// ------------------------------------------------------------------ helpers

const meshOb = (): BObject | null => { const o = ob(); return o?.type === 'MESH' ? o : null; };
const arm = (): ArmatureData | null => armatureOf(app.doc, ob());
const lat = (): LatticeData | null => { const o = ob(); return o?.type === 'LATTICE' && o.data ? app.doc.lattices?.[o.data] ?? null : null; };

/** The bone shown in the Bone tab: the active (edit/pose) bone. */
export const activeBone = (): Bone | null => { const a = arm(); return a ? boneByName(a, a.activeBone) ?? null : null; };
const activePose = (): PoseBone | null => { const o = ob(), b = activeBone(); return o && b ? poseBone(o, b.name) : null; };
const editingArm = () => app.mode === 'EDIT' && app.editObj?.type === 'ARMATURE';

/** 32 bone-layer buttons (2 blocks of 8 × 2 like Blender's armature layer widget). */
function boneLayers(l: Layout, get: () => boolean[] | null, set: (v: boolean[]) => void, used?: () => boolean[]): void {
  const el = h('div', { class: 'layers' });
  const cells: HTMLElement[] = [];
  for (const start of [0, 8]) {
    const g = h('div', { class: 'group' });
    for (let r = 0; r < 2; r++) for (let c = 0; c < 8; c++) {
      const idx = start + c + r * 16;
      const cell = h('div', { class: 'layer' });
      cell.title = `Layer ${idx + 1} (Shift-click to toggle several)`;
      cell.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const cur = get()?.slice() ?? new Array(32).fill(false);
        let next: boolean[];
        if (e.shiftKey) { next = cur.slice(); next[idx] = !next[idx]; if (!next.some(Boolean)) next[idx] = true; }
        else { next = cur.map(() => false); next[idx] = true; }
        set(next);
        app.pushUndo('Change Bone Layers');
        app.notify('data', 'view');
        upd();
      });
      cells[idx] = cell;
      g.append(cell);
    }
    el.append(g);
  }
  const upd = () => {
    const cur = get() ?? [];
    const u = used?.() ?? [];
    cells.forEach((c, i) => { c.classList.toggle('on', !!cur[i]); c.classList.toggle('used', !!u[i]); });
  };
  l.custom(el, upd);
}

/** Vertex group selector bound to `get`/`set` (prop_search over the object's vertex groups). */
function vgroupEnum(name: string, obGet: () => BObject | null, get: () => string, set: (v: string) => void): Prop {
  return {
    kind: 'enum', name, notify: ['data', 'geometry'], description: 'Vertex group name',
    items: () => [{ id: '', label: '', icon: 'GROUP_VERTEX' }, ...(obGet()?.vertexGroups ?? []).map((g) => ({ id: g.name, label: g.name, icon: 'GROUP_VERTEX' }))],
    get, set,
  };
}

// ------------------------------------------------------------------ vertex groups (mesh data tab)

function vgSpecials(): MenuItem[] {
  const op = (label: string, id: string, props?: Record<string, unknown>, icon?: string): MenuItem => ({ label, op: id, props, icon });
  return [
    op('Sort by Name', 'object.vertex_group_sort', { sort_type: 'NAME' }, 'SORTALPHA'),
    op('Sort by Bone Hierarchy', 'object.vertex_group_sort', { sort_type: 'BONE_HIERARCHY' }, 'BONE_DATA'),
    op('Copy Vertex Group', 'object.vertex_group_copy', {}, 'COPY_ID'),
    { label: 'Copy Vertex Groups to Linked', disabled: true, description: NA, icon: 'LINK_AREA' },
    { label: 'Copy Vertex Group to Selected', disabled: true, description: NA, icon: 'LINK_AREA' },
    op('Mirror Vertex Group', 'object.vertex_group_mirror', { use_topology: false }, 'ARROW_LEFTRIGHT'),
    { label: 'Mirror Vertex Group (Topology)', disabled: true, description: NA, icon: 'ARROW_LEFTRIGHT' },
    op('Remove from All Groups', 'object.vertex_group_remove_from', { use_all_groups: true, use_all_verts: true }, 'X'),
    op('Clear Active Group', 'object.vertex_group_remove_from', { use_all_groups: false, use_all_verts: true }, 'X'),
    op('Delete All Groups', 'object.vertex_group_remove', { all: true }, 'X'),
    { type: 'separator' },
    op('Lock All', 'object.vertex_group_lock', { action: 'LOCK' }, 'LOCKED'),
    op('UnLock All', 'object.vertex_group_lock', { action: 'UNLOCK' }, 'UNLOCKED'),
    op('Lock Invert All', 'object.vertex_group_lock', { action: 'INVERT' }, 'LOCKED'),
  ];
}

export function vertexGroupsPanel(ctx: PropsCtx): PanelDef {
  return {
    id: 'data.vertex_groups', label: 'Vertex Groups', key: () => `${app.mode}|${!!meshOb()?.vertexGroups?.length}`,
    draw: (l) => {
      const rows = Math.max(2, Math.min(5, meshOb()?.vertexGroups?.length ?? 0));
      richList(l, {
        rows,
        items: () => (meshOb()?.vertexGroups ?? []).map((g) => ({
          label: g.name, icon: 'GROUP_VERTEX',
          check: { get: () => g.lockWeight, set: (v: boolean) => { g.lockWeight = v; app.pushUndo('Lock Vertex Group'); app.notify('data'); }, tip: 'Maintain the relative weights for the group' },
        })),
        active: () => { const o = meshOb(); return o ? activeGroupIndex(o) : -1; },
        setActive: (i) => { const o = meshOb(); if (o) { o.activeVertexGroup = i; app.pushUndo('Set Active Group'); app.notify('data', 'geometry'); } },
        rename: (i, name) => { const o = meshOb(); if (!o) return; const g = groupsOf(o)[i]; if (g && name.trim()) { g.name = uniqueGroupName(o, name.trim(), i); app.pushUndo('Rename Vertex Group'); app.notify('data', 'geometry'); } },
        side: [
          { icon: 'ZOOMIN', tip: 'Add a new vertex group to the active object', action: () => callOp(ctx, 'object.vertex_group_add') },
          { icon: 'ZOOMOUT', tip: 'Delete the active vertex group', action: () => callOp(ctx, 'object.vertex_group_remove', { all: false }), disabled: () => !meshOb()?.vertexGroups?.length },
          { icon: 'DOWNARROW_HLT', tip: 'Vertex Group Specials', menu: vgSpecials },
          { icon: 'TRIA_UP', tip: 'Move the active vertex group up', gap: true, action: () => callOp(ctx, 'object.vertex_group_move', { direction: 'UP' }), disabled: () => !meshOb()?.vertexGroups?.length },
          { icon: 'TRIA_DOWN', tip: 'Move the active vertex group down', action: () => callOp(ctx, 'object.vertex_group_move', { direction: 'DOWN' }), disabled: () => !meshOb()?.vertexGroups?.length },
        ],
      });
      if (app.mode === 'EDIT' && meshOb()?.vertexGroups?.length) {
        const r = l.row();
        const r1 = r.row(true);
        r1.operator('object.vertex_group_assign', { text: 'Assign' });
        r1.operator('object.vertex_group_remove_from', { text: 'Remove', props: { use_all_groups: false } });
        const r2 = r.row(true);
        r2.operator('object.vertex_group_select', { text: 'Select' });
        r2.operator('object.vertex_group_deselect', { text: 'Deselect' });
        l.prop({
          kind: 'float', name: 'Weight', min: 0, max: 1, precision: 3, step: 0.01, undo: false,
          get: () => app.scene.toolSettings.vertexGroupWeight ?? 1, set: (v) => { app.scene.toolSettings.vertexGroupWeight = v; },
          description: 'Weight to assign in vertex groups', python: 'bpy.context.scene.tool_settings.vertex_group_weight',
        }, { slider: true });
      }
    },
  };
}

// ------------------------------------------------------------------ armature data tab

export function armaturePanels(_ctx: PropsCtx): PanelDef[] {
  return [
    { id: 'data.arm_context', label: '', noHeader: true, draw: (l) => { flatPanel(l); objectDataTemplate(l, 'armatures', 'ARMATURE_DATA', 'Armature'); } },
    {
      id: 'data.skeleton', label: 'Skeleton', draw: (l) => {
        l.prop(eprop(arm, 'posePosition', [
          { id: 'POSE', label: 'Pose Position', description: 'Show armature in posed state' },
          { id: 'REST', label: 'Rest Position', description: 'Show armature in binding pose state (no posing possible)' },
        ], { name: 'Position', notify: ['data', 'geometry', 'scene'] }), { expand: true });
        const sp = l.split();
        const c1 = sp.column();
        c1.label('Layers:');
        boneLayers(c1, () => arm()?.layers ?? null, (v) => { const a = arm(); if (a) a.layers = v; }, () => {
          const u = new Array(32).fill(false);
          for (const b of arm()?.bones ?? []) b.layers.forEach((x, i) => { if (x) u[i] = true; });
          return u;
        });
        const c2 = sp.column();
        c2.label('Protected Layers:', { disabled: true });
        boneLayers(c2, () => arm()?.layersProtected ?? null, (v) => { const a = arm(); if (a) a.layersProtected = v; });
      },
    },
    {
      id: 'data.arm_display', label: 'Display', draw: (l) => {
        l.prop(eprop(arm, 'drawType', [
          { id: 'OCTAHEDRAL', label: 'Octahedral', description: 'Display bones as octahedral shape (default)' },
          { id: 'STICK', label: 'Stick', description: 'Display bones as simple 2D lines with dots' },
          { id: 'BBONE', label: 'B-Bone', description: 'Display bones as boxes, showing subdivision and B-Splines' },
          { id: 'ENVELOPE', label: 'Envelope', description: 'Display bones as extruded spheres, showing deformation influence volume' },
          { id: 'WIRE', label: 'Wire', description: 'Display bones as thin wires, showing subdivision and B-Splines' },
        ], { name: 'Draw Type', notify: ['data'] }), { expand: true });
        const sp = l.split();
        const c1 = sp.column();
        c1.prop(bprop(arm, 'showNames', { name: 'Names', description: 'Display bone names', notify: ['data', 'view'] }));
        c1.prop(bprop(arm, 'showAxes', { name: 'Axes', description: 'Display bone axes', notify: ['data'] }));
        c1.prop(bprop(arm, 'showBoneCustomShapes', { name: 'Shapes', description: 'Display bones with their custom shapes (custom shapes are not available in blender-web)', notify: ['data'] }));
        const c2 = sp.column();
        c2.prop(bprop(arm, 'showGroupColors', { name: 'Colors', description: 'Display bone group colors', notify: ['data'] }));
        c2.prop(bprop(ob, 'showXRay', { name: 'X-Ray', description: 'Make the object draw in front of others', notify: ['data', 'view'] }));
        c2.prop(naBool('Delay Refresh'));
      },
    },
    { id: 'data.bone_groups', label: 'Bone Groups', draw: (l) => { richList(l, { rows: 2, items: () => [], active: () => -1, side: [{ icon: 'ZOOMIN', tip: `Add bone group (${NA})`, disabled: () => true }, { icon: 'ZOOMOUT', tip: `Remove bone group (${NA})`, disabled: () => true }] }); } },
    { id: 'data.pose_library', label: 'Pose Library', defaultClosed: true, draw: (l) => { l.prop(naEnum('Pose Library', [{ id: '', label: '', icon: 'ACTION' }]), { noLabel: true }); } },
    { id: 'data.ghost', label: 'Ghost', defaultClosed: true, draw: (l) => { l.prop(naEnum('Ghost', ['Around Frame', 'In Range', 'On Keyframes']), { expand: true }); } },
    { id: 'data.motion_paths', label: 'Motion Paths', defaultClosed: true, draw: (l) => { naButton(l, 'Calculate'); naButton(l, 'Clear'); } },
  ];
}

// ------------------------------------------------------------------ lattice data tab

export function latticePanels(_ctx: PropsCtx): PanelDef[] {
  const geo = { notify: ['geometry', 'data'] };
  const resProp = (axis: 'pointsU' | 'pointsV' | 'pointsW', name: string): Prop => ({
    kind: 'int', name, min: 1, max: 64, ...geo, description: `Points in ${name.slice(0, 1)} direction (can't be changed when there are shape keys)`,
    get: () => lat()?.[axis] ?? 2,
    set: (v) => {
      const lt = lat();
      if (!lt) return;
      const n = { pointsU: lt.pointsU, pointsV: lt.pointsV, pointsW: lt.pointsW };
      n[axis] = v;
      regrid(lt, n.pointsU, n.pointsV, n.pointsW, true);
    },
  });
  const interp = (key: 'interpolationU' | 'interpolationV' | 'interpolationW') => eprop(lat, key, [
    { id: 'KEY_LINEAR', label: 'Linear' }, { id: 'KEY_CARDINAL', label: 'Cardinal' }, { id: 'KEY_BSPLINE', label: 'BSpline' },
  ], { name: '', ...geo });
  return [
    { id: 'data.lat_context', label: '', noHeader: true, draw: (l) => { flatPanel(l); objectDataTemplate(l, 'lattices', 'LATTICE_DATA', 'Lattice'); } },
    {
      id: 'data.lattice', label: 'Lattice', draw: (l) => {
        for (const [axis, name, key] of [['pointsU', 'U', 'interpolationU'], ['pointsV', 'V', 'interpolationV'], ['pointsW', 'W', 'interpolationW']] as const) {
          const sp = l.split();
          sp.column().prop(resProp(axis, name));
          sp.column().prop(interp(key), { noLabel: true });
        }
        const r = l.row();
        r.operator('lattice.make_regular', { text: 'Make Regular' });
        r.prop(bprop(lat, 'useOutside', { name: 'Outside', description: 'Only draw, and take into account, the outer vertices', ...geo }));
        l.prop(vgroupEnum('Vertex Group', ob, () => lat()?.vertexGroup ?? '', (v) => { const lt = lat(); if (lt) lt.vertexGroup = v; }), {});
      },
    },
  ];
}

// ------------------------------------------------------------------ Bone tab

const ROT_MODES: EnumItem[] = [
  { id: 'QUATERNION', label: 'Quaternion (WXYZ)', description: 'No Gimbal Lock' },
  { id: 'XYZ', label: 'XYZ Euler' }, { id: 'XZY', label: 'XZY Euler' }, { id: 'YXZ', label: 'YXZ Euler' },
  { id: 'YZX', label: 'YZX Euler' }, { id: 'ZXY', label: 'ZXY Euler' }, { id: 'ZYX', label: 'ZYX Euler' },
  { id: 'AXIS_ANGLE', label: 'Axis Angle', description: 'Axis Angle (W+XYZ), defines a rotation around some axis defined by 3D-Vector' },
];

/** Pose channel transform fields with keyframe colouring (used by the Bone tab and the N panel). */
export function poseTransform(l: Layout): void {
  const pb = activePose;
  const name = () => activeBone()?.name ?? '';
  const chan = (field: keyof PoseBone, path: string, i: number, label: string, o: { unit?: 'LENGTH' | 'ROTATION' | 'NONE'; def: number }): Prop => ({
    ...fprop(pb, field as string, { name: label, unit: o.unit ?? 'NONE', precision: o.unit === 'ROTATION' ? 3 : 5, step: o.unit === 'ROTATION' ? Math.PI / 180 : 0.1, default: o.def, notify: ['data', 'scene', 'geometry'] }, i),
    python: `bpy.context.object.pose.bones["${name()}"].${path}[${i}]`,
    keyState: () => keyStateOf(`pose.bones["${name()}"].${path}`, i),
    keyframe: (action) => keyframeOf(`pose.bones["${name()}"].${path}`, i, action),
  });
  const sp = l.split();
  const c1 = sp.column(true);
  c1.label('Location:');
  for (let i = 0; i < 3; i++) c1.prop(chan('location', 'location', i, 'XYZ'[i], { unit: 'LENGTH', def: 0 }));
  const c2 = sp.column(true);
  c2.label('Rotation:');
  const mode = pb()?.rotationMode ?? 'QUATERNION';
  if (mode === 'QUATERNION') for (let i = 0; i < 4; i++) c2.prop(chan('rotationQuaternion', 'rotation_quaternion', i, 'WXYZ'[i], { def: i === 0 ? 1 : 0 }));
  else if (mode === 'AXIS_ANGLE') for (let i = 0; i < 4; i++) c2.prop(chan('rotationAxisAngle', 'rotation_axis_angle', i, i === 0 ? 'W' : 'XYZ'[i - 1], { unit: i === 0 ? 'ROTATION' : 'NONE', def: i === 3 ? 1 : 0 }));
  else for (let i = 0; i < 3; i++) c2.prop(chan('rotationEuler', 'rotation_euler', i, 'XYZ'[i], { unit: 'ROTATION', def: 0 }));
  c2.prop({ kind: 'enum', name: 'Rotation Mode', items: ROT_MODES, get: () => pb()?.rotationMode ?? 'QUATERNION', set: (v) => { const p = pb(); if (p) setRotationMode(p, v as PoseBone['rotationMode']); }, notify: ['data', 'all'], description: 'Rotation mode of the bone' }, { noLabel: true });
  const c3 = sp.column(true);
  c3.label('Scale:');
  for (let i = 0; i < 3; i++) c3.prop(chan('scale', 'scale', i, 'XYZ'[i], { def: 1 }));
}

import { keyState, insertKeyframe, deleteKeyframe, findFCurve } from '../../core/anim';
function keyStateOf(path: string, i: number): ReturnType<typeof keyState> {
  const o = ob();
  return o ? keyState(o, path, i, app.scene.frameCurrent) : 'NONE';
}
function keyframeOf(path: string, i: number, action: 'insert' | 'delete' | 'clear'): void {
  const o = ob();
  if (!o) return;
  const f = app.scene.frameCurrent;
  if (action === 'insert') insertKeyframe(o, path, i, f, undefined, app.prefs.keyframeInterpolation);
  else if (action === 'delete') deleteKeyframe(o, path, i, f);
  else { const fc = findFCurve(o, path, i); if (fc) o.fcurves = o.fcurves.filter((x) => x !== fc); }
  app.pushUndo('Keyframe');
  app.notify('all');
}

/** Head / tail / roll of the active edit bone. */
export function editBoneTransform(l: Layout): void {
  const b = activeBone;
  const geo = { notify: ['data', 'geometry'] };
  const after = () => { const a = arm(); if (!a) return; for (const x of a.bones) { const p = boneByName(a, x.parent); if (p && x.useConnect) x.head = [...p.tail] as [number, number, number]; } };
  const pt = (key: 'head' | 'tail', i: number): Prop => ({ ...fprop(b, key, { name: 'XYZ'[i], unit: 'LENGTH', precision: 5, step: 0.1, ...geo, onChange: after }, i) });
  const sp = l.split();
  const c1 = sp.column(true);
  c1.label('Head:');
  for (let i = 0; i < 3; i++) c1.prop(pt('head', i));
  const c2 = sp.column(true);
  c2.label('Tail:');
  for (let i = 0; i < 3; i++) c2.prop(pt('tail', i));
  const c3 = sp.column(true);
  c3.label('Roll:');
  c3.prop(fprop(b, 'roll', { name: 'Roll', unit: 'ROTATION', precision: 3, step: Math.PI / 180, description: 'Bone rotation around head-tail axis', ...geo }), { noLabel: true });
  c3.prop(naBool('Lock'));
}

export function bonePanels(_ctx: PropsCtx): PanelDef[] {
  const b = activeBone;
  const geo = { notify: ['data', 'geometry'] };
  return [
    {
      id: 'bone.context', label: '', noHeader: true, draw: (l) => {
        flatPanel(l);
        l.prop({
          kind: 'string', name: 'Name', description: 'Bone name', undo: 'Rename Bone', notify: ['all'],
          get: () => b()?.name ?? '', set: (v) => { const a = arm(), x = b(); if (a && x) renameBone(app.doc, a, x, v); },
        }, { icon: 'BONE_DATA', text: '' });
      },
    },
    {
      id: 'bone.transform', label: 'Transform', key: () => `${app.mode}|${activePose()?.rotationMode}`,
      draw: (l) => { if (editingArm()) editBoneTransform(l); else poseTransform(l); },
    },
    {
      id: 'bone.transform_locks', label: 'Transform Locks', defaultClosed: true, poll: () => !editingArm(),
      draw: (l) => {
        const sp = l.split();
        for (const [key, label] of [['lockLocation', 'Location:'], ['lockRotation', 'Rotation:'], ['lockScale', 'Scale:']] as const) {
          const c = sp.column(true);
          c.label(label);
          for (let i = 0; i < 3; i++) c.prop(bprop(activePose, key, { name: 'XYZ'[i], description: 'Lock editing in the interface', notify: ['data'] }, i), { toggle: true });
        }
      },
    },
    {
      id: 'bone.relations', label: 'Relations', draw: (l) => {
        const sp = l.split();
        const c1 = sp.column();
        c1.label('Layers:');
        boneLayers(c1, () => b()?.layers ?? null, (v) => { const x = b(); if (x) x.layers = v; });
        c1.label('Bone Group:', { disabled: true });
        c1.prop(naEnum('Bone Group', [{ id: '', label: '', icon: 'GROUP_BONE' }]), { noLabel: true });
        c1.label('Object Children:', { disabled: true });
        c1.prop(naBool('Relative Parenting'));
        const c2 = sp.column();
        c2.label('Parent:');
        c2.prop({
          kind: 'enum', name: 'Parent', ...geo, description: 'Parent edit bone (in same Armature)',
          items: () => [{ id: '', label: '', icon: 'NONE' }, ...(arm()?.bones ?? []).filter((x) => x !== b()).map((x) => ({ id: x.name, label: x.name, icon: 'BONE_DATA' }))],
          get: () => b()?.parent ?? '',
          set: (v) => {
            const a = arm(), x = b();
            if (!a || !x) return;
            // reject cycles
            for (let p = boneByName(a, v); p; p = boneByName(a, p.parent)) if (p === x) return;
            x.parent = v || null;
            if (!v) x.useConnect = false;
          },
          disabled: () => !editingArm(),
        }, { noLabel: true });
        const cc = c2.column();
        activeWhen(cc, () => !!b()?.parent);
        cc.prop({ ...bprop(b, 'useConnect', { name: 'Connected', description: 'When bone has a parent, bone\'s head is stuck to the parent\'s tail', ...geo, onChange: () => { const a = arm(), x = b(); const p = a && x ? boneByName(a, x.parent) : undefined; if (x && p && x.useConnect) x.head = [...p.tail] as [number, number, number]; if (a) flushArmSelection(a); } }), disabled: () => !editingArm() || !b()?.parent });
        c2.prop(bprop(b, 'useInheritRotation', { name: 'Inherit Rotation', description: 'Bone inherits rotation or scale from parent bone', ...geo }));
        c2.prop(bprop(b, 'useInheritScale', { name: 'Inherit Scale', description: 'Bone inherits scaling from parent bone', ...geo }));
        c2.prop(bprop(b, 'useLocalLocation', { name: 'Local Location', description: 'Bone location is set in local space', ...geo }));
      },
    },
    {
      id: 'bone.display', label: 'Display', draw: (l) => {
        const sp = l.split();
        sp.column().prop(bprop(b, 'hide', { name: 'Hide', description: 'Bone is not visible when it is not in Edit Mode (i.e. in Object or Pose Modes)', notify: ['data'] }));
        sp.column().prop(naBool('Wireframe'));
        l.label('Custom Shape:', { disabled: true });
        l.prop(naEnum('Custom Shape', [{ id: '', label: '', icon: 'OBJECT_DATA' }]), { noLabel: true });
      },
    },
    {
      id: 'bone.inverse_kinematics', label: 'Inverse Kinematics', defaultClosed: true, poll: () => !editingArm(),
      draw: (l) => {
        l.prop(fprop(activePose, 'ikStretch', { name: 'IK Stretch', min: 0, max: 1, precision: 3, step: 0.01, description: 'Allow scaling of the bone for IK (stored; IK chains do not stretch in blender-web)', notify: ['data'] }), { slider: true });
        for (const ax of ['X', 'Y', 'Z']) { const r = l.row(); r.prop(naBool(`Lock IK ${ax}`)); r.prop(naBool(`Limit ${ax}`)); }
      },
    },
    {
      id: 'bone.deform', label: 'Deform',
      drawHeader: (l) => { l.prop(bprop(b, 'useDeform', { name: '', description: 'Enable Bone to deform geometry', ...geo }), { noLabel: true }); },
      draw: (l) => {
        activeWhen(l, () => !!b()?.useDeform);
        const sp = l.split();
        const c1 = sp.column(true);
        c1.label('Envelope:');
        c1.prop(fprop(b, 'envelopeDistance', { name: 'Distance', min: 0, max: 1000, unit: 'LENGTH', precision: 3, step: 0.01, description: 'Bone deformation distance (for Envelope deform only)', ...geo }));
        c1.prop(fprop(b, 'envelopeWeight', { name: 'Weight', min: 0, max: 1000, precision: 3, step: 0.1, description: 'Bone deformation weight (for Envelope deform only)', ...geo }));
        c1.prop(bprop(b, 'useEnvelopeMultiply', { name: 'Multiply', description: 'When deforming bone, multiply effects of Vertex Group weights with Envelope influence', ...geo }));
        const c1b = c1.column(true);
        c1b.label('Radius:');
        c1b.prop(fprop(b, 'headRadius', { name: 'Head', min: 0, unit: 'LENGTH', precision: 3, step: 0.01, description: 'Radius of head of bone (for Envelope deform only)', ...geo }));
        c1b.prop(fprop(b, 'tailRadius', { name: 'Tail', min: 0, unit: 'LENGTH', precision: 3, step: 0.01, description: 'Radius of tail of bone (for Envelope deform only)', ...geo }));
        const c2 = sp.column(true);
        c2.label('Curved Bones:');
        c2.prop(iprop(b, 'bboneSegments', { name: 'Segments', min: 1, max: 32, description: 'Number of subdivisions of bone (for B-Bones only; drawn, but deformation stays straight)', ...geo }));
        c2.prop(fprop(b, 'bboneX', { name: 'Display Size X', min: 0, unit: 'LENGTH', precision: 3, step: 0.01, description: 'B-Bone X size', ...geo }));
        c2.prop(fprop(b, 'bboneZ', { name: 'Display Size Z', min: 0, unit: 'LENGTH', precision: 3, step: 0.01, description: 'B-Bone Z size', ...geo }));
      },
    },
  ];
}

// ------------------------------------------------------------------ Bone Constraints tab

const BC_SUPPORTED = new Set(['IK', 'COPY_LOCATION', 'COPY_ROTATION', 'DAMPED_TRACK', 'LIMIT_ROTATION']);
const BC_MENU: { title: string; items: [string, string][] }[] = [
  { title: 'Motion Tracking', items: [['CAMERA_SOLVER', 'Camera Solver'], ['FOLLOW_TRACK', 'Follow Track'], ['OBJECT_SOLVER', 'Object Solver']] },
  { title: 'Transform', items: [['COPY_LOCATION', 'Copy Location'], ['COPY_ROTATION', 'Copy Rotation'], ['COPY_SCALE', 'Copy Scale'], ['COPY_TRANSFORMS', 'Copy Transforms'], ['LIMIT_DISTANCE', 'Limit Distance'], ['LIMIT_LOCATION', 'Limit Location'], ['LIMIT_ROTATION', 'Limit Rotation'], ['LIMIT_SCALE', 'Limit Scale'], ['MAINTAIN_VOLUME', 'Maintain Volume'], ['TRANSFORM', 'Transformation']] },
  { title: 'Tracking', items: [['CLAMP_TO', 'Clamp To'], ['DAMPED_TRACK', 'Damped Track'], ['IK', 'Inverse Kinematics'], ['LOCKED_TRACK', 'Locked Track'], ['SPLINE_IK', 'Spline IK'], ['STRETCH_TO', 'Stretch To'], ['TRACK_TO', 'Track To']] },
  { title: 'Relationship', items: [['ACTION', 'Action'], ['CHILD_OF', 'Child Of'], ['FLOOR', 'Floor'], ['FOLLOW_PATH', 'Follow Path'], ['PIVOT', 'Pivot'], ['RIGID_BODY_JOINT', 'Rigid Body Joint'], ['SHRINKWRAP', 'Shrinkwrap']] },
];

function targetFields(l: Layout, C: () => BoneConstraint | null, key = 'target', subKey = 'subtarget', label = 'Target:'): void {
  const sp = l.split(0.35);
  sp.column().label(label);
  const c = sp.column(true);
  c.prop({
    kind: 'enum', name: 'Target', notify: ['data', 'scene'], description: 'Target object',
    items: () => objectItems(), get: () => String(C()?.[key] ?? ''), set: (v) => { const x = C(); if (x) { x[key] = v || null; x[subKey] = ''; } },
  }, { noLabel: true });
  const t = () => { const x = C(); const id = x?.[key]; return typeof id === 'string' ? app.doc.objects[id] : undefined; };
  if (t()?.type === 'ARMATURE') {
    c.prop({
      kind: 'enum', name: 'Bone', notify: ['data', 'scene'], description: 'Target bone',
      items: () => [{ id: '', label: '', icon: 'NONE' }, ...(armatureOf(app.doc, t())?.bones ?? []).map((b) => ({ id: b.name, label: b.name, icon: 'BONE_DATA' }))],
      get: () => String(C()?.[subKey] ?? ''), set: (v) => { const x = C(); if (x) x[subKey] = v; },
    }, { text: 'Bone' });
  }
}

function boneConstraintBox(l: Layout, ctx: PropsCtx, i: number): void {
  const C = (): BoneConstraint | null => activePose()?.constraints[i] ?? null;
  const con = C();
  if (!con) return;
  const box = l.box();
  const head = box.row();
  head.prop(bprop(C, 'showExpanded', { name: '', undo: false, notify: ['screen', 'data'] }), { iconOnly: true, icon: 'TRIA_RIGHT', iconOn: 'TRIA_DOWN', emboss: false }).style.background = 'transparent';
  head.label('', { icon: 'CONSTRAINT_BONE', fixed: true });
  head.prop({ kind: 'string', name: '', get: () => C()?.name ?? '', set: (v) => { const x = C(); if (x && v.trim()) x.name = v.trim(); }, undo: 'Rename Constraint', notify: ['data'] });
  head.prop(bprop(C, 'mute', { name: 'Mute', description: 'Enable/Disable Constraint', notify: ['data', 'scene'] }), { iconOnly: true, icon: 'RESTRICT_VIEW_OFF', iconOn: 'RESTRICT_VIEW_ON' }).classList.add('fixed');
  const n = activePose()?.constraints.length ?? 0;
  if (n > 1) {
    const ud = head.row(true);
    ud.el.classList.add('fixed');
    const move = (d: number) => { const pb = activePose(); if (!pb) return; const j = i + d; if (j < 0 || j >= pb.constraints.length) return; [pb.constraints[i], pb.constraints[j]] = [pb.constraints[j], pb.constraints[i]]; app.pushUndo('Move Constraint'); app.notify('all'); };
    ud.button('', () => move(-1), { icon: 'TRIA_UP', iconOnly: true, tip: 'Move constraint up', disabled: () => i === 0 });
    ud.button('', () => move(1), { icon: 'TRIA_DOWN', iconOnly: true, tip: 'Move constraint down', disabled: () => i >= n - 1 });
  }
  head.button('', () => { const pb = activePose(); if (pb) { pb.constraints.splice(i, 1); app.pushUndo('Delete Constraint'); app.notify('all'); } }, { icon: 'X', iconOnly: true, tip: 'Remove constraint from constraint stack' }).classList.add('fixed');
  if (!con.showExpanded) return;
  const body = box.column();
  const f = (key: string, name: string, o: Record<string, unknown> = {}): Prop => ({ kind: 'float', name, notify: ['data', 'scene'], precision: 3, get: () => Number(C()?.[key] ?? 0), set: (v) => { const x = C(); if (x) x[key] = v; }, ...o } as Prop);
  const b = (key: string, name: string, desc = ''): Prop => ({ kind: 'bool', name, description: desc, notify: ['data', 'scene'], get: () => !!C()?.[key], set: (v) => { const x = C(); if (x) x[key] = v; } });
  switch (con.type) {
    case 'IK': {
      targetFields(body, C);
      targetFields(body, C, 'poleTarget', 'poleSubtarget', 'Pole Target:');
      if (C()?.poleTarget) body.prop(f('poleAngle', 'Pole Angle', { unit: 'ROTATION', step: Math.PI / 180, description: 'Pole rotation offset' }));
      const sp = body.split();
      const c1 = sp.column();
      c1.prop({ kind: 'int', name: 'Iterations', min: 0, max: 10000, notify: ['data', 'scene'], get: () => Number(C()?.iterations ?? 500), set: (v) => { const x = C(); if (x) x.iterations = v; }, description: 'Maximum number of solving iterations' });
      c1.prop({ kind: 'int', name: 'Chain Length', min: 0, max: 255, notify: ['data', 'scene'], get: () => Number(C()?.chainCount ?? 0), set: (v) => { const x = C(); if (x) x.chainCount = v; }, description: 'How many bones are included in the IK effect - 0 uses all bones' });
      const c2 = sp.column();
      c2.prop(b('useTail', 'Use Tail', 'Include bone\'s tail as last element in chain'));
      c2.prop(b('useStretch', 'Stretch', 'Enable IK Stretching (stored)'));
      c2.prop(naBool('Rotation'));
      break;
    }
    case 'COPY_LOCATION': case 'COPY_ROTATION': {
      targetFields(body, C);
      const sp = body.split();
      for (const ax of ['X', 'Y', 'Z']) {
        const c = sp.column(true);
        c.prop(b(`use${ax}`, ax), {});
        c.prop(b(`invert${ax}`, 'Invert'), {});
      }
      body.prop(b('useOffset', 'Offset', 'Add original location/rotation onto the copied one'));
      if (con.type === 'COPY_LOCATION') body.prop(b('useTail', 'Head/Tail: use the target bone\'s tail'));
      break;
    }
    case 'DAMPED_TRACK': {
      targetFields(body, C);
      body.prop({ kind: 'enum', name: 'To', notify: ['data', 'scene'], items: [{ id: 'TRACK_X', label: 'X' }, { id: 'TRACK_Y', label: 'Y' }, { id: 'TRACK_Z', label: 'Z' }, { id: 'TRACK_NEGATIVE_X', label: '-X' }, { id: 'TRACK_NEGATIVE_Y', label: '-Y' }, { id: 'TRACK_NEGATIVE_Z', label: '-Z' }], get: () => String(C()?.trackAxis ?? 'TRACK_Y'), set: (v) => { const x = C(); if (x) x.trackAxis = v; }, description: 'Axis that points to the target object' }, { expand: true });
      break;
    }
    case 'LIMIT_ROTATION': {
      const sp = body.split();
      for (const ax of ['X', 'Y', 'Z']) {
        const c = sp.column(true);
        c.prop(b(`useLimit${ax}`, `Limit ${ax}`));
        c.prop(f(`min${ax}`, 'Min', { unit: 'ROTATION', step: Math.PI / 180 }));
        c.prop(f(`max${ax}`, 'Max', { unit: 'ROTATION', step: Math.PI / 180 }));
      }
      break;
    }
  }
  body.prop(f('influence', 'Influence', { min: 0, max: 1, description: 'Amount of influence constraint will have on the final solution' }), { slider: true });
  void ctx;
}

export function boneConstraintPanels(ctx: PropsCtx): PanelDef[] {
  return [{
    id: 'bone_constraint.stack', label: 'Bone Constraints', noHeader: true,
    key: () => JSON.stringify([activeBone()?.name, (activePose()?.constraints ?? []).map((c) => [c.type, c.name, c.showExpanded, !!c.target && app.doc.objects[c.target]?.type, !!c.poleTarget])]),
    draw: (l) => {
      flatPanel(l);
      l.menu('Add Bone Constraint', () => [{
        type: 'columns',
        columns: BC_MENU.map((c) => ({
          title: c.title,
          items: c.items.map(([type, label]): MenuItem => (BC_SUPPORTED.has(type)
            ? { label, icon: 'CONSTRAINT_DATA', action: () => { const pb = activePose(); if (!pb) return; pb.constraints.push(newBoneConstraint(type as BoneConstraint['type'], pb.constraints)); app.pushUndo('Add Constraint'); app.notify('all'); } }
            : { label, icon: 'CONSTRAINT_DATA', disabled: true, description: NA })),
        })),
      }], { title: 'Add Constraint' });
      (activePose()?.constraints ?? []).forEach((_, i) => boneConstraintBox(l, ctx, i));
    },
  }];
}

// ------------------------------------------------------------------ modifier panels

type M = () => Modifier | null;
const mObj = (m: M, key: string, name: string, filter: (o: BObject) => boolean, desc: string): Prop => ({
  kind: 'enum', name, notify: ['data', 'geometry'], description: desc,
  items: () => objectItems((o) => o.id !== ob()?.id && filter(o)), get: () => String(m()?.[key] ?? ''), set: (v) => { const x = m(); if (x) x[key] = v || null; },
});
const mBool = (m: M, key: string, name: string, desc = '', def = false): Prop => ({ kind: 'bool', name, description: desc, notify: ['data', 'geometry'], get: () => { const v = m()?.[key]; return v === undefined ? def : !!v; }, set: (v) => { const x = m(); if (x) x[key] = v; } });
const mFloat = (m: M, key: string, name: string, o: Record<string, unknown> = {}): Prop => ({ kind: 'float', name, notify: ['data', 'geometry'], precision: 3, get: () => Number(m()?.[key] ?? 0), set: (v) => { const x = m(); if (x) x[key] = v; }, ...o } as Prop);
const mEnum = (m: M, key: string, name: string, items: EnumItem[], desc = ''): Prop => ({ kind: 'enum', name, items, description: desc, notify: ['data', 'geometry'], get: () => String(m()?.[key] ?? ''), set: (v) => { const x = m(); if (x) x[key] = v; } });
const mGroup = (m: M, key: string, name = 'Vertex Group'): Prop => vgroupEnum(name, ob, () => String(m()?.[key] ?? ''), (v) => { const x = m(); if (x) x[key] = v; });

function vgRow(l: Layout, m: M, key = 'vertexGroup', invertKey = 'invertVertexGroup'): void {
  const r = l.row(true);
  r.prop(mGroup(m, key), { noLabel: true });
  r.prop(mBool(m, invertKey, '', 'Invert vertex group influence'), { iconOnly: true, icon: 'ARROW_LEFTRIGHT' }).classList.add('fixed');
}

const FALLOFF_ITEMS: EnumItem[] = ['LINEAR', 'CURVE', 'SHARP', 'SMOOTH', 'ROOT', 'SPHERE', 'RANDOM', 'STEP'].map((id) => ({ id, label: id === 'CURVE' ? 'Custom Curve' : id[0] + id.slice(1).toLowerCase() }));

function maskFields(l: Layout, m: M): void {
  l.label('Influence/Mask Options:');
  l.prop(mFloat(m, 'maskConstant', 'Global Influence:', { min: 0, max: 1, description: 'Global influence of current modifications on vgroup' }), { slider: true });
  const sp = l.split(0.4);
  sp.column().label('Vertex Group Mask:');
  sp.column().prop(mGroup(m, 'maskVertexGroup', 'Mask Vertex Group'), { noLabel: true });
}

DRAW.ARMATURE = (l, m) => {
  const sp = l.split();
  const c1 = sp.column();
  c1.label('Object:');
  c1.prop(mObj(m, 'object', 'Object', (o) => o.type === 'ARMATURE', 'Armature object to deform with'), { noLabel: true });
  const c2 = sp.column();
  c2.label('Vertex Group:');
  vgRow(c2, m);
  const sp2 = l.split();
  const d1 = sp2.column();
  d1.label('Bind To:');
  d1.prop(mBool(m, 'useVertexGroups', 'Vertex Groups', 'Bind Bone envelopes to armature modifier', true));
  d1.prop(mBool(m, 'useBoneEnvelopes', 'Bone Envelopes', 'Bind Bone envelopes to armature modifier'));
  const d2 = sp2.column();
  d2.label('Deformation:');
  d2.prop(mBool(m, 'useDeformPreserveVolume', 'Preserve Volume', 'Deform rotation interpolation with quaternions'));
  d2.prop(naBool('Multi Modifier'));
};

DRAW.LATTICE = (l, m) => {
  const sp = l.split();
  const c1 = sp.column();
  c1.label('Object:');
  c1.prop(mObj(m, 'object', 'Object', (o) => o.type === 'LATTICE', 'Lattice object to deform with'), { noLabel: true });
  const c2 = sp.column();
  c2.label('Vertex Group:');
  c2.prop(mGroup(m, 'vertexGroup'), { noLabel: true });
  l.separator();
  l.prop(mFloat(m, 'strength', 'Strength', { min: 0, max: 1, description: 'Strength of modifier effect' }), { slider: true });
};

DRAW.HOOK = (l, m) => {
  const sp = l.split();
  const c1 = sp.column();
  c1.label('Object:');
  c1.prop(mObj(m, 'object', 'Object', () => true, 'Parent Object for hook, also recalculates and clears offset'), { noLabel: true });
  const c2 = sp.column();
  c2.label('Vertex Group:');
  c2.prop(mGroup(m, 'vertexGroup'), { noLabel: true });
  l.separator();
  const sp2 = l.split();
  const d1 = sp2.column();
  d1.prop(mEnum(m, 'falloffType', 'Falloff', [{ id: 'NONE', label: 'No Falloff' }, { id: 'CURVE', label: 'Curve' }, { id: 'SMOOTH', label: 'Smooth' }, { id: 'SPHERE', label: 'Sphere' }, { id: 'ROOT', label: 'Root' }, { id: 'INVERSE_SQUARE', label: 'Inverse Square' }, { id: 'SHARP', label: 'Sharp' }, { id: 'LINEAR', label: 'Linear' }, { id: 'CONSTANT', label: 'Constant' }]));
  const fr = d1.column();
  activeWhen(fr, () => m()?.falloffType !== 'NONE');
  fr.prop(mFloat(m, 'falloffRadius', 'Radius', { min: 0, unit: 'LENGTH', description: 'If not zero, the distance from the hook where influence ends' }));
  const d2 = sp2.column();
  d2.prop(mFloat(m, 'strength', 'Strength', { min: 0, max: 1, description: 'Relative force of the hook' }), { slider: true });
  if (app.mode === 'EDIT') {
    const r = l.row(true);
    const name = () => m()?.name ?? '';
    r.button('Reset', () => void app.callOperator('object.hook_reset', { modifier: name() }), { tip: 'Recalculate and clear offset transformation' });
    r.button('Recenter', () => void app.callOperator('object.hook_recenter', { modifier: name() }), { tip: 'Set hook center to cursor position' });
    const r2 = l.row(true);
    r2.button('Select', () => void app.callOperator('object.hook_select', { modifier: name() }), { tip: 'Select affected vertices on mesh' });
    r2.button('Assign', () => void app.callOperator('object.hook_assign', { modifier: name() }), { tip: 'Assign the selected vertices to a hook' });
  }
};

DRAW.MASK = (l, m) => {
  const sp = l.split();
  const c1 = sp.column();
  c1.label('Mode:');
  c1.prop(mEnum(m, 'mode', 'Mode', [{ id: 'VERTEX_GROUP', label: 'Vertex Group' }, { id: 'ARMATURE', label: 'Armature' }]), { noLabel: true });
  const c2 = sp.column();
  if (m()?.mode === 'ARMATURE') {
    c2.label('Armature:');
    c2.prop(mObj(m, 'armature', 'Armature', (o) => o.type === 'ARMATURE', 'Armature to use as source of bones to mask'), { noLabel: true });
  } else {
    c2.label('Vertex Group:');
    vgRow(c2, m);
  }
  l.prop(mFloat(m, 'threshold', 'Threshold', { min: 0, max: 1, description: 'Weights over this threshold remain' }), { slider: true });
};

DRAW.VERTEX_WEIGHT_EDIT = (l, m) => {
  const sp = l.split();
  const c1 = sp.column();
  c1.label('Vertex Group:');
  c1.prop(mGroup(m, 'vertexGroup'), { noLabel: true });
  c1.label('Default Weight:');
  c1.prop(mFloat(m, 'defaultWeight', 'Default Weight', { min: 0, max: 1 }), { noLabel: true, slider: true });
  const c2 = sp.column();
  c2.prop(mBool(m, 'useAdd', 'Group Add', 'Add vertices with weight over threshold to vgroup'));
  const a = c2.column(); activeWhen(a, () => !!m()?.useAdd);
  a.prop(mFloat(m, 'addThreshold', 'Add Threshold', { min: 0, max: 1 }), { slider: true });
  c2.prop(mBool(m, 'useRemove', 'Group Remove', 'Remove vertices with weight below threshold from vgroup'));
  const r = c2.column(); activeWhen(r, () => !!m()?.useRemove);
  r.prop(mFloat(m, 'removeThreshold', 'Remove Threshold', { min: 0, max: 1 }), { slider: true });
  l.separator();
  l.prop(mEnum(m, 'falloffType', 'Falloff Type', FALLOFF_ITEMS));
  maskFields(l, m);
};

DRAW.VERTEX_WEIGHT_MIX = (l, m) => {
  const sp = l.split();
  const c1 = sp.column();
  c1.label('Vertex Group A:');
  c1.prop(mGroup(m, 'vertexGroupA', 'Vertex Group A'), { noLabel: true });
  c1.label('Default Weight A:');
  c1.prop(mFloat(m, 'defaultWeightA', 'Default Weight A', { min: 0, max: 1 }), { noLabel: true, slider: true });
  c1.label('Mix Mode:');
  c1.prop(mEnum(m, 'mixMode', 'Mix Mode', [{ id: 'SET', label: 'Replace' }, { id: 'ADD', label: 'Add' }, { id: 'SUB', label: 'Subtract' }, { id: 'MUL', label: 'Multiply' }, { id: 'DIV', label: 'Divide' }, { id: 'DIF', label: 'Difference' }, { id: 'AVG', label: 'Average' }]), { noLabel: true });
  const c2 = sp.column();
  c2.label('Vertex Group B:');
  c2.prop(mGroup(m, 'vertexGroupB', 'Vertex Group B'), { noLabel: true });
  c2.label('Default Weight B:');
  c2.prop(mFloat(m, 'defaultWeightB', 'Default Weight B', { min: 0, max: 1 }), { noLabel: true, slider: true });
  c2.label('Mix Set:');
  c2.prop(mEnum(m, 'mixSet', 'Mix Set', [{ id: 'ALL', label: 'All' }, { id: 'A', label: 'Vertex Group A' }, { id: 'B', label: 'Vertex Group B' }, { id: 'OR', label: 'Vertex Group A or B' }, { id: 'AND', label: 'Vertex Group A and B' }]), { noLabel: true });
  maskFields(l, m);
};

DRAW.VERTEX_WEIGHT_PROXIMITY = (l, m) => {
  const sp = l.split();
  const c1 = sp.column();
  c1.label('Vertex Group:');
  c1.prop(mGroup(m, 'vertexGroup'), { noLabel: true });
  const c2 = sp.column();
  c2.label('Target Object:');
  c2.prop(mObj(m, 'target', 'Target', () => true, 'Object to calculate vertices distances from'), { noLabel: true });
  l.separator();
  l.row().prop(mEnum(m, 'proximityMode', 'Distance', [{ id: 'OBJECT', label: 'Object' }, { id: 'GEOMETRY', label: 'Geometry' }]), { expand: true });
  const r = l.row(true);
  r.prop(mFloat(m, 'minDist', 'Lowest', { unit: 'LENGTH', description: 'Distance mapping to weight 0.0' }));
  r.prop(mFloat(m, 'maxDist', 'Highest', { unit: 'LENGTH', description: 'Distance mapping to weight 1.0' }));
  l.prop(mEnum(m, 'falloffType', 'Falloff Type', FALLOFF_ITEMS));
  maskFields(l, m);
};

for (const t of ['ARMATURE', 'LATTICE', 'HOOK']) DEFORM_TYPES.add(t);

/** Bones of the active armature visible in the current layers (N panel / outliner helpers). */
export function visibleBones(): Bone[] { const a = arm(); return a ? a.bones.filter((b) => isBoneVisible(a, b)) : []; }
