// Default keymap (Blender 2.79 bindings), key event dispatch and shortcut lookup.

import { app, type OpProps } from './app';
import { showMenu, type MenuItem, setShortcutResolver } from './ui/menu';
import type { Area } from './screen/screen';
import {
  addMenu, applyMenu, clearMenu, snapMenu, meshSpecialsMenu, objectSpecialsMenu, extrudeMenu, verticesMenu, edgesMenu, facesMenu,
  parentMenu, parentClearMenu, trackMenu, meshAddItems,
} from './editors/view3d/menus';

type Space = 'WINDOW' | 'VIEW_3D' | 'TIMELINE' | 'DOPESHEET_EDITOR' | 'GRAPH_EDITOR' | 'IMAGE_EDITOR' | 'OUTLINER' | 'PROPERTIES' | 'ANIM';

export interface KeyItem {
  code: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  space: Space;
  mode?: 'OBJECT' | 'EDIT';
  op?: string;
  props?: OpProps;
  menu?: () => MenuItem[];
  title?: string;
  /** Run the operator's exec directly (no confirmation popup). */
  exec?: boolean;
  label?: string;
}

const K = (code: string, space: Space, op: string, props?: OpProps, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}, mode?: 'OBJECT' | 'EDIT', extra: Partial<KeyItem> = {}): KeyItem => ({ code, space, op, props, mode, ...mods, ...extra });
const M = (code: string, space: Space, title: string, menu: () => MenuItem[], mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}, mode?: 'OBJECT' | 'EDIT'): KeyItem => ({ code, space, menu, title, mode, ...mods });
const C = { ctrl: true }, S = { shift: true }, A = { alt: true }, CS = { ctrl: true, shift: true }, CA = { ctrl: true, alt: true }, SA = { shift: true, alt: true };

const selectModeMenu = (): MenuItem[] => [
  { label: 'Vertex', icon: 'VERTEXSEL', op: 'mesh.select_mode', props: { type: 'VERT' } },
  { label: 'Edge', icon: 'EDGESEL', op: 'mesh.select_mode', props: { type: 'EDGE' } },
  { label: 'Face', icon: 'FACESEL', op: 'mesh.select_mode', props: { type: 'FACE' } },
];
const originMenu = (): MenuItem[] => [
  { label: 'Geometry to Origin', op: 'object.origin_set', props: { type: 'GEOMETRY_ORIGIN' } },
  { label: 'Origin to Geometry', op: 'object.origin_set', props: { type: 'ORIGIN_GEOMETRY' } },
  { label: 'Origin to 3D Cursor', op: 'object.origin_set', props: { type: 'ORIGIN_CURSOR' } },
  { label: 'Origin to Center of Mass', op: 'object.origin_set', props: { type: 'ORIGIN_CENTER_OF_MASS' } },
];
const selectGroupedMenu = (): MenuItem[] => [
  ['CHILDREN_RECURSIVE', 'Children'], ['CHILDREN', 'Immediate Children'], ['PARENT', 'Parent'], ['SIBLINGS', 'Siblings'], ['TYPE', 'Type'], ['LAYER', 'Layer'], ['LAMP_TYPE', 'Lamp Type'],
].map(([t, l]) => ({ label: l, op: 'object.select_grouped', props: { type: t } }));
const selectLinkedMenu = (): MenuItem[] => [
  { label: 'Object Data', op: 'object.select_linked', props: { type: 'OBDATA' } },
  { label: 'Material', op: 'object.select_linked', props: { type: 'MATERIAL' } },
];
const makeLinksMenu = (): MenuItem[] => [
  { label: 'Object Data', op: 'object.make_links_data', props: { type: 'OBDATA' } },
  { label: 'Materials', op: 'object.make_links_data', props: { type: 'MATERIAL' } },
  { label: 'Modifiers', op: 'object.make_links_data', props: { type: 'MODIFIERS' } },
];
const mirrorMenu = (): MenuItem[] => [0, 1, 2].flatMap((i) => [{ label: `${'XYZ'[i]} Global`, op: 'transform.mirror', props: { constraint_axis: [0, 1, 2].map((k) => k === i) } }]);

export const KEYMAP: KeyItem[] = [
  // ---------------------------------------------------------------- window
  K('KeyZ', 'WINDOW', 'ed.undo', {}, C),
  K('KeyZ', 'WINDOW', 'ed.redo', {}, CS),
  K('KeyY', 'WINDOW', 'ed.redo', {}, C),
  K('KeyZ', 'WINDOW', 'ed.undo_history', {}, CA),
  K('KeyR', 'WINDOW', 'screen.repeat_last', {}, S),
  K('F3', 'WINDOW', 'screen.repeat_history', {}),
  K('F6', 'WINDOW', 'screen.redo_last', {}),
  K('Space', 'WINDOW', 'wm.search_menu', {}),
  K('KeyN', 'WINDOW', 'wm.read_homefile', {}, C),
  K('KeyO', 'WINDOW', 'wm.open_mainfile', {}, C),
  K('F1', 'WINDOW', 'wm.open_mainfile', {}),
  K('KeyS', 'WINDOW', 'wm.save_mainfile', {}, C),
  K('KeyW', 'WINDOW', 'wm.save_mainfile', {}, C),
  K('KeyS', 'WINDOW', 'wm.save_as_mainfile', {}, CS),
  K('F2', 'WINDOW', 'wm.save_as_mainfile', {}),
  K('KeyQ', 'WINDOW', 'wm.quit_blender', {}, C),
  K('KeyU', 'WINDOW', 'screen.userpref_show', {}, CA),
  K('KeyU', 'WINDOW', 'wm.save_homefile', {}, C),
  K('F12', 'WINDOW', 'render.render', { animation: false }),
  K('F12', 'WINDOW', 'render.render', { animation: true }, C),
  K('F11', 'WINDOW', 'render.view_show', {}),
  K('ArrowUp', 'WINDOW', 'screen.screen_full_area', {}, C),
  K('ArrowDown', 'WINDOW', 'screen.screen_full_area', {}, C),
  K('Space', 'WINDOW', 'screen.screen_full_area', {}, S),
  K('F10', 'WINDOW', 'screen.screen_full_area', { use_hide_panels: true }, A),
  K('ArrowRight', 'WINDOW', 'screen.screen_set', { delta: 1 }, C),
  K('ArrowLeft', 'WINDOW', 'screen.screen_set', { delta: -1 }, C),
  K('KeyA', 'WINDOW', 'screen.animation_play', {}, A),
  K('KeyA', 'WINDOW', 'screen.animation_play', { reverse: true }, SA),
  K('ArrowLeft', 'WINDOW', 'screen.frame_jump', { end: false }, S),
  K('ArrowRight', 'WINDOW', 'screen.frame_jump', { end: true }, S),
  K('ArrowDown', 'WINDOW', 'screen.frame_jump', { end: false }, SA),
  K('ArrowUp', 'WINDOW', 'screen.frame_jump', { end: true }, SA),
  K('ArrowLeft', 'WINDOW', 'screen.frame_offset', { delta: -1 }),
  K('ArrowRight', 'WINDOW', 'screen.frame_offset', { delta: 1 }),
  K('ArrowUp', 'WINDOW', 'screen.keyframe_jump', { next: true }),
  K('ArrowDown', 'WINDOW', 'screen.keyframe_jump', { next: false }),
  K('Escape', 'WINDOW', 'screen.animation_cancel', {}),
  K('Escape', 'WINDOW', 'render.view_cancel', {}),
  K('Escape', 'WINDOW', 'screen.back_to_previous', {}),

  // ---------------------------------------------------------------- 3D view (both modes)
  K('KeyG', 'VIEW_3D', 'transform.translate'),
  K('KeyR', 'VIEW_3D', 'transform.rotate'),
  K('KeyS', 'VIEW_3D', 'transform.resize'),
  K('KeyM', 'VIEW_3D', 'transform.mirror', {}, C),
  K('KeyB', 'VIEW_3D', 'view3d.select_border'),
  K('KeyC', 'VIEW_3D', 'view3d.select_circle'),
  K('KeyT', 'VIEW_3D', 'view3d.toolshelf'),
  K('KeyN', 'VIEW_3D', 'view3d.properties'),
  K('KeyZ', 'VIEW_3D', 'view3d.toggle_wireframe'),
  K('KeyZ', 'VIEW_3D', 'view3d.toggle_textured', {}, A),
  K('KeyZ', 'VIEW_3D', 'view3d.toggle_rendered', {}, S),
  K('Tab', 'VIEW_3D', 'object.editmode_toggle'),
  K('Home', 'VIEW_3D', 'view3d.view_all', { center: false }),
  K('KeyC', 'VIEW_3D', 'view3d.view_all', { center: true }, S),
  K('NumpadDecimal', 'VIEW_3D', 'view3d.view_selected'),
  K('Numpad0', 'VIEW_3D', 'view3d.viewnumpad', { type: 'CAMERA' }),
  K('Numpad1', 'VIEW_3D', 'view3d.viewnumpad', { type: 'FRONT' }),
  K('Numpad1', 'VIEW_3D', 'view3d.viewnumpad', { type: 'BACK' }, C),
  K('Numpad3', 'VIEW_3D', 'view3d.viewnumpad', { type: 'RIGHT' }),
  K('Numpad3', 'VIEW_3D', 'view3d.viewnumpad', { type: 'LEFT' }, C),
  K('Numpad7', 'VIEW_3D', 'view3d.viewnumpad', { type: 'TOP' }),
  K('Numpad7', 'VIEW_3D', 'view3d.viewnumpad', { type: 'BOTTOM' }, C),
  K('Numpad1', 'VIEW_3D', 'view3d.viewnumpad', { type: 'FRONT', align_active: true }, S),
  K('Numpad3', 'VIEW_3D', 'view3d.viewnumpad', { type: 'RIGHT', align_active: true }, S),
  K('Numpad7', 'VIEW_3D', 'view3d.viewnumpad', { type: 'TOP', align_active: true }, S),
  K('Numpad5', 'VIEW_3D', 'view3d.view_persportho'),
  K('Numpad4', 'VIEW_3D', 'view3d.view_orbit', { type: 'ORBITLEFT' }),
  K('Numpad6', 'VIEW_3D', 'view3d.view_orbit', { type: 'ORBITRIGHT' }),
  K('Numpad8', 'VIEW_3D', 'view3d.view_orbit', { type: 'ORBITUP' }),
  K('Numpad2', 'VIEW_3D', 'view3d.view_orbit', { type: 'ORBITDOWN' }),
  K('Numpad9', 'VIEW_3D', 'view3d.view_orbit', { type: 'ORBITRIGHT', angle: Math.PI }),
  K('Numpad4', 'VIEW_3D', 'view3d.view_pan', { type: 'PANLEFT' }, C),
  K('Numpad6', 'VIEW_3D', 'view3d.view_pan', { type: 'PANRIGHT' }, C),
  K('Numpad8', 'VIEW_3D', 'view3d.view_pan', { type: 'PANUP' }, C),
  K('Numpad2', 'VIEW_3D', 'view3d.view_pan', { type: 'PANDOWN' }, C),
  K('Numpad4', 'VIEW_3D', 'view3d.view_roll', { angle: -Math.PI / 12 }, S),
  K('Numpad6', 'VIEW_3D', 'view3d.view_roll', { angle: Math.PI / 12 }, S),
  K('NumpadAdd', 'VIEW_3D', 'view3d.zoom', { delta: 1 }),
  K('NumpadSubtract', 'VIEW_3D', 'view3d.zoom', { delta: -1 }),
  K('Equal', 'VIEW_3D', 'view3d.zoom', { delta: 1 }, C),
  K('Minus', 'VIEW_3D', 'view3d.zoom', { delta: -1 }, C),
  K('NumpadDivide', 'VIEW_3D', 'view3d.localview'),
  K('Numpad0', 'VIEW_3D', 'view3d.object_as_camera', {}, C),
  K('Numpad0', 'VIEW_3D', 'view3d.camera_to_view', {}, CA),
  K('KeyF', 'VIEW_3D', 'view3d.camera_to_view_selected', {}, CA),
  K('Space', 'VIEW_3D', 'view3d.manipulator_toggle', {}, C),
  K('Comma', 'VIEW_3D', 'view3d.pivot_set', { type: 'BOUNDING_BOX_CENTER' }),
  K('Comma', 'VIEW_3D', 'view3d.pivot_set', { type: 'MEDIAN_POINT' }, C),
  K('Period', 'VIEW_3D', 'view3d.pivot_set', { type: 'CURSOR' }),
  K('Period', 'VIEW_3D', 'view3d.pivot_set', { type: 'INDIVIDUAL_ORIGINS' }, C),
  K('Period', 'VIEW_3D', 'view3d.pivot_set', { type: 'ACTIVE_ELEMENT' }, A),
  M('KeyS', 'VIEW_3D', 'Snap', snapMenu, S),
  K('KeyI', 'VIEW_3D', 'anim.keyframe_insert_menu', {}, {}, 'OBJECT'),
  K('KeyI', 'VIEW_3D', 'anim.keyframe_delete_v3d', {}, A, 'OBJECT'),
  K('KeyI', 'VIEW_3D', 'anim.keyframe_clear_v3d', {}, SA, 'OBJECT'),
  ...[0, 1, 2, 3, 4, 5].map((n) => K(`Digit${n}`, 'VIEW_3D', 'object.subdivision_set', { level: n }, C)),

  // ---------------------------------------------------------------- object mode
  K('KeyA', 'VIEW_3D', 'object.select_all', { action: 'TOGGLE' }, {}, 'OBJECT'),
  K('KeyI', 'VIEW_3D', 'object.select_all', { action: 'INVERT' }, C, 'OBJECT'),
  M('KeyA', 'VIEW_3D', 'Add', addMenu, S, 'OBJECT'),
  K('KeyX', 'VIEW_3D', 'object.delete', {}, {}, 'OBJECT'),
  K('Delete', 'VIEW_3D', 'object.delete', {}, {}, 'OBJECT', { exec: true }),
  K('KeyD', 'VIEW_3D', 'object.duplicate_move', {}, S, 'OBJECT'),
  K('KeyD', 'VIEW_3D', 'object.duplicate_move_linked', {}, A, 'OBJECT'),
  K('KeyJ', 'VIEW_3D', 'object.join', {}, C, 'OBJECT'),
  M('KeyP', 'VIEW_3D', 'Set Parent To', parentMenu, C, 'OBJECT'),
  M('KeyP', 'VIEW_3D', 'Clear Parent', parentClearMenu, A, 'OBJECT'),
  M('KeyT', 'VIEW_3D', 'Make Track', trackMenu, C, 'OBJECT'),
  K('KeyT', 'VIEW_3D', 'object.track_clear', {}, A, 'OBJECT'),
  K('KeyG', 'VIEW_3D', 'object.location_clear', {}, A, 'OBJECT'),
  K('KeyR', 'VIEW_3D', 'object.rotation_clear', {}, A, 'OBJECT'),
  K('KeyS', 'VIEW_3D', 'object.scale_clear', {}, A, 'OBJECT'),
  K('KeyO', 'VIEW_3D', 'object.origin_clear', {}, A, 'OBJECT'),
  M('KeyA', 'VIEW_3D', 'Apply', applyMenu, C, 'OBJECT'),
  M('KeyC', 'VIEW_3D', 'Set Origin', originMenu, { ctrl: true, shift: true, alt: true }, 'OBJECT'),
  M('KeyL', 'VIEW_3D', 'Make Links', makeLinksMenu, C, 'OBJECT'),
  M('KeyW', 'VIEW_3D', 'Specials', objectSpecialsMenu, {}, 'OBJECT'),
  M('KeyG', 'VIEW_3D', 'Select Grouped', selectGroupedMenu, S, 'OBJECT'),
  M('KeyL', 'VIEW_3D', 'Select Linked', selectLinkedMenu, S, 'OBJECT'),
  K('KeyH', 'VIEW_3D', 'object.hide_view_set', { unselected: false }, {}, 'OBJECT'),
  K('KeyH', 'VIEW_3D', 'object.hide_view_set', { unselected: true }, S, 'OBJECT'),
  K('KeyH', 'VIEW_3D', 'object.hide_view_clear', {}, A, 'OBJECT'),
  K('KeyM', 'VIEW_3D', 'object.move_to_layer', {}, {}, 'OBJECT'),
  ...Array.from({ length: 10 }, (_, i) => [
    K(`Digit${(i + 1) % 10}`, 'VIEW_3D', 'view3d.layers', { nr: i + 1, extend: false }),
    K(`Digit${(i + 1) % 10}`, 'VIEW_3D', 'view3d.layers', { nr: i + 1, extend: true }, S),
    K(`Digit${(i + 1) % 10}`, 'VIEW_3D', 'view3d.layers', { nr: i + 11, extend: false }, A),
    K(`Digit${(i + 1) % 10}`, 'VIEW_3D', 'view3d.layers', { nr: i + 11, extend: true }, SA),
  ]).flat(),
  K('Backquote', 'VIEW_3D', 'view3d.layers', { nr: 0 }),

  // ---------------------------------------------------------------- edit mode
  K('KeyA', 'VIEW_3D', 'mesh.select_all', { action: 'TOGGLE' }, {}, 'EDIT'),
  K('KeyI', 'VIEW_3D', 'mesh.select_all', { action: 'INVERT' }, C, 'EDIT'),
  M('KeyA', 'VIEW_3D', 'Add', meshAddItems, S, 'EDIT'),
  K('KeyE', 'VIEW_3D', 'mesh.extrude_region_move', {}, {}, 'EDIT'),
  M('KeyE', 'VIEW_3D', 'Extrude', extrudeMenu, A, 'EDIT'),
  K('KeyX', 'VIEW_3D', 'mesh.delete_menu', {}, {}, 'EDIT'),
  K('Delete', 'VIEW_3D', 'mesh.delete_menu', {}, {}, 'EDIT'),
  K('KeyF', 'VIEW_3D', 'mesh.edge_face_add', {}, {}, 'EDIT'),
  K('KeyF', 'VIEW_3D', 'mesh.edge_face_add', {}, A, 'EDIT'),
  K('KeyI', 'VIEW_3D', 'mesh.inset', {}, {}, 'EDIT'),
  K('KeyR', 'VIEW_3D', 'mesh.loopcut_slide', {}, C, 'EDIT'),
  M('KeyW', 'VIEW_3D', 'Specials', meshSpecialsMenu, {}, 'EDIT'),
  K('KeyM', 'VIEW_3D', 'mesh.merge_menu', {}, A, 'EDIT'),
  K('KeyN', 'VIEW_3D', 'mesh.normals_make_consistent', { inside: false }, C, 'EDIT'),
  K('KeyN', 'VIEW_3D', 'mesh.normals_make_consistent', { inside: true }, CS, 'EDIT'),
  K('KeyD', 'VIEW_3D', 'mesh.duplicate_move', {}, S, 'EDIT'),
  K('KeyL', 'VIEW_3D', 'mesh.select_linked_pick', { deselect: false }, {}, 'EDIT'),
  K('KeyL', 'VIEW_3D', 'mesh.select_linked_pick', { deselect: true }, S, 'EDIT'),
  K('KeyL', 'VIEW_3D', 'mesh.select_linked', {}, C, 'EDIT'),
  K('NumpadAdd', 'VIEW_3D', 'mesh.select_more', {}, C, 'EDIT'),
  K('NumpadSubtract', 'VIEW_3D', 'mesh.select_less', {}, C, 'EDIT'),
  K('KeyP', 'VIEW_3D', 'mesh.separate_menu', {}, {}, 'EDIT'),
  K('KeyH', 'VIEW_3D', 'mesh.hide', { unselected: false }, {}, 'EDIT'),
  K('KeyH', 'VIEW_3D', 'mesh.hide', { unselected: true }, S, 'EDIT'),
  K('KeyH', 'VIEW_3D', 'mesh.reveal', {}, A, 'EDIT'),
  K('KeyY', 'VIEW_3D', 'mesh.split', {}, {}, 'EDIT'),
  K('KeyT', 'VIEW_3D', 'mesh.quads_convert_to_tris', {}, C, 'EDIT'),
  K('KeyJ', 'VIEW_3D', 'mesh.tris_convert_to_quads', {}, A, 'EDIT'),
  K('KeyS', 'VIEW_3D', 'transform.shrink_fatten', {}, A, 'EDIT'),
  K('KeyS', 'VIEW_3D', 'transform.tosphere', {}, SA, 'EDIT'),
  M('Tab', 'VIEW_3D', 'Mesh Select Mode', selectModeMenu, C, 'EDIT'),
  M('KeyE', 'VIEW_3D', 'Edges', edgesMenu, C, 'EDIT'),
  M('KeyF', 'VIEW_3D', 'Faces', facesMenu, C, 'EDIT'),
  M('KeyV', 'VIEW_3D', 'Vertices', verticesMenu, C, 'EDIT'),
  M('KeyM', 'VIEW_3D', 'Mirror', mirrorMenu, C, 'EDIT'),

  // ---------------------------------------------------------------- animation editors
  ...(['TIMELINE', 'DOPESHEET_EDITOR', 'GRAPH_EDITOR'] as const).flatMap((sp) => [
    K('KeyS', sp, 'time.start_frame_set', {}, {}, undefined, { label: 'Set Start Frame' }),
    K('KeyE', sp, 'time.end_frame_set', {}, {}, undefined, { label: 'Set End Frame' }),
    K('KeyM', sp, 'marker.add'),
    K('Home', sp, 'time.view_all'),
    K('KeyI', sp, 'anim.keyframe_insert_menu', {}),
  ]),
];

// ------------------------------------------------------------------ key naming

const KEY_NAMES: Record<string, string> = {
  Space: 'Spacebar', Escape: 'Esc', ArrowLeft: 'Left Arrow', ArrowRight: 'Right Arrow', ArrowUp: 'Up Arrow', ArrowDown: 'Down Arrow',
  NumpadDecimal: 'Numpad .', NumpadAdd: 'Numpad +', NumpadSubtract: 'Numpad -', NumpadDivide: 'Numpad /', NumpadMultiply: 'Numpad *',
  NumpadEnter: 'Numpad Enter', Comma: ',', Period: '.', Equal: '=', Minus: '-', Backquote: 'Accent Grave', Delete: 'Delete', Home: 'Home',
};

export function keyName(code: string): string {
  if (KEY_NAMES[code]) return KEY_NAMES[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Numpad ${code.slice(6)}`;
  return code;
}

function itemText(k: KeyItem): string {
  return [k.shift ? 'Shift' : '', k.ctrl ? 'Ctrl' : '', k.alt ? 'Alt' : '', keyName(k.code)].filter(Boolean).join(' ');
}

setShortcutResolver((op, props) => {
  const items = KEYMAP.filter((k) => k.op === op && (k.mode === undefined || k.mode === app.mode));
  if (!items.length) return undefined;
  // an item matches when all of its props agree with the requested props (missing keys count as falsy/defaults)
  const want = props ?? {};
  const agrees = (k: KeyItem) => Object.entries(k.props ?? {}).every(([key, v]) => JSON.stringify(want[key] ?? defaultOf(v)) === JSON.stringify(v));
  const conflicts = (k: KeyItem) => Object.entries(want).some(([key, v]) => k.props && key in k.props && JSON.stringify(k.props[key]) !== JSON.stringify(v));
  const cands = items.filter((k) => agrees(k) && !conflicts(k));
  cands.sort((a, b) => Object.keys(b.props ?? {}).length - Object.keys(a.props ?? {}).length);
  return cands[0] ? itemText(cands[0]) : undefined;
});

function defaultOf(v: unknown): unknown {
  return typeof v === 'boolean' ? false : typeof v === 'number' ? 0 : typeof v === 'string' ? '' : null;
}

export function shortcutList(): [string, [string, string][]][] {
  const groups = new Map<string, [string, string][]>();
  for (const k of KEYMAP) {
    const title = k.space === 'WINDOW' ? 'Window' : k.space === 'VIEW_3D' ? `3D View${k.mode ? ` (${k.mode === 'EDIT' ? 'Edit Mode' : 'Object Mode'})` : ''}` : k.space.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
    const desc = k.label ?? (k.op ? app.operator(k.op)?.label ?? k.op : `${k.title} menu`);
    const extra = k.props && Object.keys(k.props).length ? ` (${Object.values(k.props).map((v) => (typeof v === 'string' ? v.toLowerCase().replace(/_/g, ' ') : String(v))).join(', ')})` : '';
    if (!groups.has(title)) groups.set(title, []);
    groups.get(title)!.push([itemText(k), desc + extra]);
  }
  groups.set('Mouse (3D View)', [
    ['Middle Mouse drag', 'Orbit view'], ['Shift + Middle Mouse drag', 'Pan view'], ['Ctrl + Middle Mouse drag / Wheel', 'Zoom view'],
    ['Right click', 'Select (Shift: extend)'], ['Right drag', 'Select and move'], ['Left click', 'Place 3D cursor'],
    ['Alt + Right click (edit mode)', 'Select edge/face loop'], ['Ctrl + Left drag', 'Lasso select'],
    ['Alt + Left drag', 'Orbit (with "Emulate 3 Button Mouse" enabled)'],
  ]);
  return [...groups.entries()];
}

// ------------------------------------------------------------------ dispatch

/** Handle a keydown for the given area. Returns true if consumed. */
export function dispatchKey(e: KeyboardEvent, area: Area | null): boolean {
  let code = e.code;
  const type = area?.type ?? '';
  // emulate numpad: number row acts as numpad in the 3D view
  if (app.prefs.emulateNumpad && type === 'VIEW_3D' && /^Digit\d$/.test(code) && !e.ctrlKey) code = `Numpad${code.slice(5)}`;
  if (code === 'NumpadEnter') code = 'Enter';
  const spaces: Space[] = [];
  if (type === 'VIEW_3D') spaces.push('VIEW_3D');
  else if (type) spaces.push(type as Space);
  spaces.push('WINDOW');
  for (const space of spaces) {
    for (const k of KEYMAP) {
      if (k.space !== space || k.code !== code) continue;
      if (!!k.ctrl !== (e.ctrlKey || e.metaKey) || !!k.shift !== e.shiftKey || !!k.alt !== e.altKey) continue;
      if (k.mode && k.mode !== app.mode) continue;
      if (k.menu) {
        const items = k.menu();
        showMenu(items, app.mouse, { title: k.title, atMouse: true, area });
        return true;
      }
      if (k.op) {
        if (!app.pollOperator(k.op, area)) continue;
        void app.callOperator(k.op, { ...(k.props ?? {}) }, { area, event: e, exec: k.exec });
        return true;
      }
    }
  }
  return false;
}

export function clearMenuRefs(): void { void clearMenu; }
