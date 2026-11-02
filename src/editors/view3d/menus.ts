// 3D View header menus and hotkey popup menus, following Blender 2.79's layout.

import { app } from '../../app';
import type { MenuItem } from '../../ui/menu';
import type { View3D } from './view3d';

const op = (label: string, id: string, props?: Record<string, unknown>, icon?: string): MenuItem => ({ label, op: id, props, icon });
const sep: MenuItem = { type: 'separator' };
const sub = (label: string, items: MenuItem[] | (() => MenuItem[]), icon?: string): MenuItem => ({ type: 'submenu', label, items, icon });

export function viewMenu(view: View3D): MenuItem[] {
  return [
    { label: 'Properties', checked: !!view.state.showNPanel, action: () => view.toggleRegion('npanel'), shortcut: 'N' },
    { label: 'Tool Shelf', checked: !!view.state.showToolshelf, action: () => view.toggleRegion('toolshelf'), shortcut: 'T' },
    sep,
    op('Camera', 'view3d.viewnumpad', { type: 'CAMERA' }),
    sep,
    op('Top', 'view3d.viewnumpad', { type: 'TOP' }),
    op('Bottom', 'view3d.viewnumpad', { type: 'BOTTOM' }),
    sep,
    op('Front', 'view3d.viewnumpad', { type: 'FRONT' }),
    op('Back', 'view3d.viewnumpad', { type: 'BACK' }),
    sep,
    op('Right', 'view3d.viewnumpad', { type: 'RIGHT' }),
    op('Left', 'view3d.viewnumpad', { type: 'LEFT' }),
    sep,
    sub('Cameras', [
      op('Set Active Object as Camera', 'view3d.object_as_camera'),
      op('Active Camera', 'view3d.viewnumpad', { type: 'CAMERA' }),
    ]),
    sep,
    op('Toggle Perspective/Orthographic', 'view3d.view_persportho'),
    sep,
    sub('Navigation', [
      op('Orbit Left', 'view3d.view_orbit', { type: 'ORBITLEFT' }),
      op('Orbit Right', 'view3d.view_orbit', { type: 'ORBITRIGHT' }),
      op('Orbit Up', 'view3d.view_orbit', { type: 'ORBITUP' }),
      op('Orbit Down', 'view3d.view_orbit', { type: 'ORBITDOWN' }),
      sep,
      op('Pan Left', 'view3d.view_pan', { type: 'PANLEFT' }),
      op('Pan Right', 'view3d.view_pan', { type: 'PANRIGHT' }),
      op('Pan Up', 'view3d.view_pan', { type: 'PANUP' }),
      op('Pan Down', 'view3d.view_pan', { type: 'PANDOWN' }),
      sep,
      op('Zoom In', 'view3d.zoom', { delta: 1 }),
      op('Zoom Out', 'view3d.zoom', { delta: -1 }),
      sep,
      op('Zoom Camera 1:1', 'view3d.zoom_camera_1_to_1'),
    ]),
    sub('Align View', [
      sub('Align View to Active', [
        op('Top', 'view3d.viewnumpad', { type: 'TOP', align_active: true }),
        op('Bottom', 'view3d.viewnumpad', { type: 'BOTTOM', align_active: true }),
        op('Front', 'view3d.viewnumpad', { type: 'FRONT', align_active: true }),
        op('Back', 'view3d.viewnumpad', { type: 'BACK', align_active: true }),
        op('Right', 'view3d.viewnumpad', { type: 'RIGHT', align_active: true }),
        op('Left', 'view3d.viewnumpad', { type: 'LEFT', align_active: true }),
      ]),
      sep,
      op('Align Active Camera to View', 'view3d.camera_to_view'),
      op('Align Active Camera to Selected', 'view3d.camera_to_view_selected'),
      op('Center Cursor and View All', 'view3d.view_all', { center: true }),
      op('View Selected', 'view3d.view_selected'),
      op('Center View to Cursor', 'view3d.view_center_cursor'),
      sep,
      op('Lock View to Object', 'view3d.view_lock_to_active'),
      op('Clear View Lock', 'view3d.view_lock_clear'),
    ]),
    sep,
    op('View Selected', 'view3d.view_selected'),
    op('View All', 'view3d.view_all', { center: false }),
    op('Frame All', 'view3d.view_all', { center: false }),
    sep,
    op('Local View', 'view3d.localview'),
    sep,
    op('Play Animation', 'screen.animation_play'),
    sep,
    op('Toggle Maximize Area', 'screen.screen_full_area', { use_hide_panels: false }),
    op('Toggle Fullscreen Area', 'screen.screen_full_area', { use_hide_panels: true }),
  ];
}

export function selectMenu(): MenuItem[] {
  if (app.mode === 'EDIT') {
    return [
      op('Border Select', 'view3d.select_border'),
      op('Circle Select', 'view3d.select_circle'),
      sep,
      op('(De)select All', 'mesh.select_all', { action: 'TOGGLE' }),
      op('Inverse', 'mesh.select_all', { action: 'INVERT' }),
      sep,
      op('Random', 'mesh.select_random'),
      op('Linked', 'mesh.select_linked'),
      sep,
      op('Select More', 'mesh.select_more'),
      op('Select Less', 'mesh.select_less'),
      sep,
      op('Non Manifold', 'mesh.select_non_manifold'),
      op('Loose Geometry', 'mesh.select_loose'),
      op('Interior Faces', 'mesh.select_interior_faces'),
      op('Faces by Sides', 'mesh.select_face_by_sides'),
      sep,
      op('Sharp Edges', 'mesh.edges_select_sharp'),
    ];
  }
  return [
    op('Border Select', 'view3d.select_border'),
    op('Circle Select', 'view3d.select_circle'),
    sep,
    op('(De)select All', 'object.select_all', { action: 'TOGGLE' }),
    op('Inverse', 'object.select_all', { action: 'INVERT' }),
    op('Random', 'object.select_random'),
    sep,
    sub('Select All by Layer', Array.from({ length: 20 }, (_, i) => op(`Layer ${i + 1}`, 'object.select_by_layer', { layers: i + 1 }))),
    sub('Select All by Type', [
      op('Mesh', 'object.select_by_type', { type: 'MESH' }, 'OUTLINER_OB_MESH'),
      op('Camera', 'object.select_by_type', { type: 'CAMERA' }, 'OUTLINER_OB_CAMERA'),
      op('Lamp', 'object.select_by_type', { type: 'LAMP' }, 'OUTLINER_OB_LAMP'),
      op('Empty', 'object.select_by_type', { type: 'EMPTY' }, 'OUTLINER_OB_EMPTY'),
    ]),
    op('Select Camera', 'object.select_camera'),
    sep,
    sub('Select Grouped', [
      op('Children', 'object.select_grouped', { type: 'CHILDREN_RECURSIVE' }),
      op('Immediate Children', 'object.select_grouped', { type: 'CHILDREN' }),
      op('Parent', 'object.select_grouped', { type: 'PARENT' }),
      op('Siblings', 'object.select_grouped', { type: 'SIBLINGS' }),
      op('Type', 'object.select_grouped', { type: 'TYPE' }),
      op('Layer', 'object.select_grouped', { type: 'LAYER' }),
      op('Lamp Type', 'object.select_grouped', { type: 'LAMP_TYPE' }),
    ]),
    sub('Select Linked', [
      op('Object Data', 'object.select_linked', { type: 'OBDATA' }),
      op('Material', 'object.select_linked', { type: 'MATERIAL' }),
    ]),
    op('Select Pattern...', 'object.select_pattern'),
  ];
}

export function meshAddItems(): MenuItem[] {
  return [
    op('Plane', 'mesh.primitive_plane_add', {}, 'MESH_PLANE'),
    op('Cube', 'mesh.primitive_cube_add', {}, 'MESH_CUBE'),
    op('Circle', 'mesh.primitive_circle_add', {}, 'MESH_CIRCLE'),
    op('UV Sphere', 'mesh.primitive_uv_sphere_add', {}, 'MESH_UVSPHERE'),
    op('Icosphere', 'mesh.primitive_ico_sphere_add', {}, 'MESH_ICOSPHERE'),
    op('Cylinder', 'mesh.primitive_cylinder_add', {}, 'MESH_CYLINDER'),
    op('Cone', 'mesh.primitive_cone_add', {}, 'MESH_CONE'),
    op('Torus', 'mesh.primitive_torus_add', {}, 'MESH_TORUS'),
    sep,
    op('Grid', 'mesh.primitive_grid_add', {}, 'MESH_GRID'),
    op('Monkey', 'mesh.primitive_monkey_add', {}, 'MESH_MONKEY'),
  ];
}

const na = (label: string, icon: string): MenuItem => ({ label, icon, disabled: true, description: 'Not available in blender-web' });

export function addMenu(): MenuItem[] {
  if (app.mode === 'EDIT') return meshAddItems();
  return [
    sub('Mesh', meshAddItems(), 'OUTLINER_OB_MESH'),
    sub('Curve', [na('Bezier', 'CURVE_BEZCURVE'), na('Circle', 'CURVE_BEZCIRCLE'), na('Path', 'CURVE_PATH')], 'OUTLINER_OB_CURVE'),
    sub('Surface', [na('NURBS Surface', 'SURFACE_DATA')], 'OUTLINER_OB_SURFACE'),
    sub('Metaball', [na('Ball', 'META_DATA')], 'OUTLINER_OB_META'),
    na('Text', 'OUTLINER_OB_FONT'),
    sep,
    sub('Armature', [na('Single Bone', 'ARMATURE_DATA')], 'OUTLINER_OB_ARMATURE'),
    na('Lattice', 'OUTLINER_OB_LATTICE'),
    sub('Empty', [
      op('Plain Axes', 'object.empty_add', { type: 'PLAIN_AXES' }, 'OUTLINER_OB_EMPTY'),
      op('Arrows', 'object.empty_add', { type: 'ARROWS' }, 'OUTLINER_OB_EMPTY'),
      op('Single Arrow', 'object.empty_add', { type: 'SINGLE_ARROW' }, 'OUTLINER_OB_EMPTY'),
      op('Circle', 'object.empty_add', { type: 'CIRCLE' }, 'OUTLINER_OB_EMPTY'),
      op('Cube', 'object.empty_add', { type: 'CUBE' }, 'OUTLINER_OB_EMPTY'),
      op('Sphere', 'object.empty_add', { type: 'SPHERE' }, 'OUTLINER_OB_EMPTY'),
      op('Cone', 'object.empty_add', { type: 'CONE' }, 'OUTLINER_OB_EMPTY'),
    ], 'OUTLINER_OB_EMPTY'),
    sep,
    na('Speaker', 'OUTLINER_OB_SPEAKER'),
    sep,
    op('Camera', 'object.camera_add', {}, 'OUTLINER_OB_CAMERA'),
    sub('Lamp', [
      op('Point', 'object.lamp_add', { type: 'POINT' }, 'LAMP_POINT'),
      op('Sun', 'object.lamp_add', { type: 'SUN' }, 'LAMP_SUN'),
      op('Spot', 'object.lamp_add', { type: 'SPOT' }, 'LAMP_SPOT'),
      op('Hemi', 'object.lamp_add', { type: 'HEMI' }, 'LAMP_HEMI'),
      op('Area', 'object.lamp_add', { type: 'AREA' }, 'LAMP_AREA'),
    ], 'OUTLINER_OB_LAMP'),
    sep,
    sub('Force Field', [na('Force', 'FORCE_FORCE'), na('Wind', 'FORCE_WIND'), na('Vortex', 'FORCE_VORTEX')], 'OUTLINER_OB_FORCE_FIELD'),
    sep,
    sub('Group Instance', [{ type: 'label', label: 'No groups' }], 'OUTLINER_OB_GROUP_INSTANCE'),
  ];
}

export function transformSubmenu(): MenuItem[] {
  return [
    op('Grab/Move', 'transform.translate'),
    op('Rotate', 'transform.rotate'),
    op('Scale', 'transform.resize'),
    sep,
    op('To Sphere', 'transform.tosphere'),
    op('Shrink/Fatten', 'transform.shrink_fatten'),
    op('Randomize', 'object.randomize_transform'),
    sep,
    op('Align Objects', 'object.align'),
    sep,
    op('Geometry to Origin', 'object.origin_set', { type: 'GEOMETRY_ORIGIN' }),
    op('Origin to Geometry', 'object.origin_set', { type: 'ORIGIN_GEOMETRY' }),
    op('Origin to 3D Cursor', 'object.origin_set', { type: 'ORIGIN_CURSOR' }),
    op('Origin to Center of Mass', 'object.origin_set', { type: 'ORIGIN_CENTER_OF_MASS' }),
  ];
}

export function snapMenu(): MenuItem[] {
  return [
    op('Selection to Grid', 'view3d.snap_selected_to_grid'),
    op('Selection to Cursor', 'view3d.snap_selected_to_cursor', { use_offset: false }),
    op('Selection to Cursor (Offset)', 'view3d.snap_selected_to_cursor', { use_offset: true }),
    op('Selection to Active', 'view3d.snap_selected_to_active'),
    sep,
    op('Cursor to Selected', 'view3d.snap_cursor_to_selected'),
    op('Cursor to Center', 'view3d.snap_cursor_to_center'),
    op('Cursor to Grid', 'view3d.snap_cursor_to_grid'),
    op('Cursor to Active', 'view3d.snap_cursor_to_active'),
  ];
}

export function applyMenu(): MenuItem[] {
  return [
    op('Location', 'object.transform_apply', { location: true, rotation: false, scale: false }),
    op('Rotation', 'object.transform_apply', { location: false, rotation: true, scale: false }),
    op('Scale', 'object.transform_apply', { location: false, rotation: false, scale: true }),
    op('Rotation & Scale', 'object.transform_apply', { location: false, rotation: true, scale: true }),
    sep,
    op('Location to Deltas', 'object.transforms_to_deltas', { mode: 'LOC' }),
    op('Rotation to Deltas', 'object.transforms_to_deltas', { mode: 'ROT' }),
    op('Scale to Deltas', 'object.transforms_to_deltas', { mode: 'SCALE' }),
    op('All Transforms to Deltas', 'object.transforms_to_deltas', { mode: 'ALL' }),
    sep,
    op('Visual Transform', 'object.visual_transform_apply'),
    op('Visual Geometry to Mesh', 'object.convert', { target: 'MESH' }),
  ];
}

export function clearMenu(): MenuItem[] {
  return [
    op('Location', 'object.location_clear'),
    op('Rotation', 'object.rotation_clear'),
    op('Scale', 'object.scale_clear'),
    op('Origin', 'object.origin_clear'),
  ];
}

export function parentMenu(): MenuItem[] {
  return [
    op('Object', 'object.parent_set', { type: 'OBJECT', keep_transform: false }),
    op('Object (Keep Transform)', 'object.parent_set', { type: 'OBJECT', keep_transform: true }),
    op('Object (Without Inverse)', 'object.parent_no_inverse_set'),
  ];
}

export function parentClearMenu(): MenuItem[] {
  return [
    op('Clear Parent', 'object.parent_clear', { type: 'CLEAR' }),
    op('Clear and Keep Transformation', 'object.parent_clear', { type: 'CLEAR_KEEP_TRANSFORM' }),
    op('Clear Parent Inverse', 'object.parent_clear', { type: 'CLEAR_INVERSE' }),
  ];
}

export function trackMenu(): MenuItem[] {
  return [
    op('Damped Track Constraint', 'object.track_set', { type: 'DAMPTRACK' }),
    op('Track To Constraint', 'object.track_set', { type: 'TRACKTO' }),
    sep,
    op('Clear Track', 'object.track_clear', { type: 'CLEAR' }),
  ];
}

export function keyframeInsertMenu(): MenuItem[] {
  return [
    op('Location', 'anim.keyframe_insert_menu', { type: 'Location' }),
    op('Rotation', 'anim.keyframe_insert_menu', { type: 'Rotation' }),
    op('Scaling', 'anim.keyframe_insert_menu', { type: 'Scaling' }),
    op('LocRot', 'anim.keyframe_insert_menu', { type: 'BUILTIN_KSI_LocRot' }),
    op('LocScale', 'anim.keyframe_insert_menu', { type: 'LocScale' }),
    op('LocRotScale', 'anim.keyframe_insert_menu', { type: 'LocRotScale' }),
    op('RotScale', 'anim.keyframe_insert_menu', { type: 'RotScale' }),
    sep,
    op('Delta Location', 'anim.keyframe_insert_menu', { type: 'Delta Location' }),
    op('Delta Rotation', 'anim.keyframe_insert_menu', { type: 'Delta Rotation' }),
    op('Delta Scale', 'anim.keyframe_insert_menu', { type: 'Delta Scale' }),
    sep,
    op('Visual Location', 'anim.keyframe_insert_menu', { type: 'Visual Location' }),
    op('Visual Rotation', 'anim.keyframe_insert_menu', { type: 'Visual Rotation' }),
    op('Visual Scaling', 'anim.keyframe_insert_menu', { type: 'Visual Scaling' }),
    op('Visual LocRot', 'anim.keyframe_insert_menu', { type: 'Visual LocRot' }),
    op('Visual LocRotScale', 'anim.keyframe_insert_menu', { type: 'Visual LocRotScale' }),
  ];
}

export function objectMenu(): MenuItem[] {
  return [
    op('Undo History', 'ed.undo_history'),
    op('Redo', 'ed.redo'),
    op('Undo', 'ed.undo'),
    sep,
    sub('Mirror', [
      op('Interactive Mirror', 'transform.mirror', {}),
      sep,
      op('X Global', 'transform.mirror', { constraint_axis: [true, false, false] }),
      op('Y Global', 'transform.mirror', { constraint_axis: [false, true, false] }),
      op('Z Global', 'transform.mirror', { constraint_axis: [false, false, true] }),
      sep,
      op('X Local', 'transform.mirror', { constraint_axis: [true, false, false], constraint_orientation: 'LOCAL' }),
      op('Y Local', 'transform.mirror', { constraint_axis: [false, true, false], constraint_orientation: 'LOCAL' }),
      op('Z Local', 'transform.mirror', { constraint_axis: [false, false, true], constraint_orientation: 'LOCAL' }),
    ]),
    sub('Transform', transformSubmenu),
    sub('Clear', clearMenu),
    sub('Apply', applyMenu),
    sub('Snap', snapMenu),
    sep,
    op('Duplicate Objects', 'object.duplicate_move'),
    op('Duplicate Linked', 'object.duplicate_move_linked'),
    op('Join', 'object.join'),
    sep,
    op('Delete...', 'object.delete'),
    sep,
    sub('Make Links', [
      op('Object Data', 'object.make_links_data', { type: 'OBDATA' }),
      op('Materials', 'object.make_links_data', { type: 'MATERIAL' }),
      op('Modifiers', 'object.make_links_data', { type: 'MODIFIERS' }),
    ]),
    sub('Make Single User', [
      op('Object & Data', 'object.make_single_user', { type: 'SELECTED_OBJECTS', obdata: true }),
      op('Materials', 'object.make_single_user', { type: 'SELECTED_OBJECTS', material: true }),
    ]),
    sep,
    sub('Parent', () => [...parentMenu(), sep, ...parentClearMenu()]),
    sub('Track', trackMenu),
    sub('Constraints', [
      op('Add Constraint (with Targets)', 'object.constraint_add_with_targets'),
      op('Copy Constraints to Selected Objects', 'object.constraints_copy'),
      op('Clear Object Constraints', 'object.constraints_clear'),
    ]),
    sep,
    sub('Animation', [
      op('Insert Keyframe...', 'anim.keyframe_insert_menu_popup'),
      op('Delete Keyframes...', 'anim.keyframe_delete_v3d'),
      op('Clear Keyframes...', 'anim.keyframe_clear_v3d'),
    ]),
    sep,
    sub('Show/Hide', [
      op('Show Hidden', 'object.hide_view_clear'),
      op('Hide Selected', 'object.hide_view_set', { unselected: false }),
      op('Hide Unselected', 'object.hide_view_set', { unselected: true }),
    ]),
    sep,
    sub('Convert to', [op('Mesh from Curve/Meta/Surf/Text', 'object.convert', { target: 'MESH' })]),
    op('Move to Layer...', 'object.move_to_layer'),
    sep,
    op('Shade Smooth', 'object.shade_smooth'),
    op('Shade Flat', 'object.shade_flat'),
  ];
}

export function meshMenu(): MenuItem[] {
  return [
    op('Undo History', 'ed.undo_history'),
    op('Redo', 'ed.redo'),
    op('Undo', 'ed.undo'),
    sep,
    sub('Transform', [
      op('Grab/Move', 'transform.translate'),
      op('Rotate', 'transform.rotate'),
      op('Scale', 'transform.resize'),
      sep,
      op('To Sphere', 'transform.tosphere'),
      op('Shrink/Fatten', 'transform.shrink_fatten'),
    ]),
    sub('Mirror', [
      op('X Global', 'transform.mirror', { constraint_axis: [true, false, false] }),
      op('Y Global', 'transform.mirror', { constraint_axis: [false, true, false] }),
      op('Z Global', 'transform.mirror', { constraint_axis: [false, false, true] }),
      sep,
      op('X Local', 'transform.mirror', { constraint_axis: [true, false, false], constraint_orientation: 'LOCAL' }),
      op('Y Local', 'transform.mirror', { constraint_axis: [false, true, false], constraint_orientation: 'LOCAL' }),
      op('Z Local', 'transform.mirror', { constraint_axis: [false, false, true], constraint_orientation: 'LOCAL' }),
    ]),
    sub('Snap', snapMenu),
    sub('Extrude', extrudeMenu),
    sep,
    op('Duplicate', 'mesh.duplicate_move'),
    sub('Delete', deleteMenuMesh),
    sep,
    sub('Vertices', verticesMenu),
    sub('Edges', edgesMenu),
    sub('Faces', facesMenu),
    sub('Normals', [
      op('Recalculate Outside', 'mesh.normals_make_consistent', { inside: false }),
      op('Recalculate Inside', 'mesh.normals_make_consistent', { inside: true }),
      sep,
      op('Flip', 'mesh.flip_normals'),
    ]),
    sub('Clean up', [
      op('Delete Loose', 'mesh.delete_loose'),
      op('Remove Doubles', 'mesh.remove_doubles'),
    ]),
    sep,
    sub('Show/Hide', [
      op('Show Hidden', 'mesh.reveal'),
      op('Hide Selected', 'mesh.hide', { unselected: false }),
      op('Hide Unselected', 'mesh.hide', { unselected: true }),
    ]),
    sep,
    sub('Proportional Editing', [
      { label: 'Disable', checked: app.scene.toolSettings.proportionalEdit === 'DISABLED', action: () => { app.scene.toolSettings.proportionalEdit = 'DISABLED'; app.notify('view'); } },
      { label: 'Enable', checked: app.scene.toolSettings.proportionalEdit === 'ENABLED', action: () => { app.scene.toolSettings.proportionalEdit = 'ENABLED'; app.notify('view'); } },
      { label: 'Connected', checked: app.scene.toolSettings.proportionalEdit === 'CONNECTED', action: () => { app.scene.toolSettings.proportionalEdit = 'CONNECTED'; app.notify('view'); } },
    ]),
  ];
}

export function extrudeMenu(): MenuItem[] {
  const md = app.editMesh;
  const mode = app.scene.toolSettings.meshSelectMode;
  const items: MenuItem[] = [];
  if (md?.fsel.some(Boolean)) {
    items.push(op('Region', 'mesh.extrude_region_move'));
    items.push(op('Individual Faces', 'mesh.extrude_faces_move'));
  }
  if (mode[1] || mode[0]) items.push(op('Edges Only', 'mesh.extrude_edges_move'));
  if (mode[0]) items.push(op('Vertices Only', 'mesh.extrude_vertices_move'));
  return items.length ? items : [op('Region', 'mesh.extrude_region_move')];
}

export function deleteMenuMesh(): MenuItem[] {
  return [
    op('Vertices', 'mesh.delete', { type: 'VERT' }),
    op('Edges', 'mesh.delete', { type: 'EDGE' }),
    op('Faces', 'mesh.delete', { type: 'FACE' }),
    op('Only Edges & Faces', 'mesh.delete', { type: 'EDGE_FACE' }),
    op('Only Faces', 'mesh.delete', { type: 'ONLY_FACE' }),
    sep,
    op('Dissolve Faces', 'mesh.dissolve_faces'),
    sep,
    op('Delete Loose', 'mesh.delete_loose'),
  ];
}

export function verticesMenu(): MenuItem[] {
  return [
    op('Merge...', 'mesh.merge_menu'),
    op('Separate...', 'mesh.separate_menu'),
    op('Split', 'mesh.split'),
    sep,
    op('Smooth Vertex', 'mesh.vertices_smooth'),
    op('Remove Doubles', 'mesh.remove_doubles'),
    op('Randomize Vertices', 'transform.vertex_random'),
    sep,
    op('Make Edge/Face', 'mesh.edge_face_add'),
  ];
}

export function edgesMenu(): MenuItem[] {
  return [
    op('Make Edge/Face', 'mesh.edge_face_add'),
    op('Subdivide', 'mesh.subdivide'),
    sep,
    op('Loop Cut and Slide', 'mesh.loopcut_slide'),
    sep,
    op('Spin', 'mesh.spin'),
    sep,
    op('Select Sharp Edges', 'mesh.edges_select_sharp'),
  ];
}

export function facesMenu(): MenuItem[] {
  return [
    op('Fill', 'mesh.edge_face_add'),
    op('Inset Faces', 'mesh.inset'),
    op('Dissolve Faces', 'mesh.dissolve_faces'),
    sep,
    op('Extrude Individual Faces', 'mesh.extrude_faces_move'),
    sep,
    op('Triangulate Faces', 'mesh.quads_convert_to_tris'),
    op('Tris to Quads', 'mesh.tris_convert_to_quads'),
    sep,
    op('Shade Smooth', 'mesh.faces_shade_smooth'),
    op('Shade Flat', 'mesh.faces_shade_flat'),
  ];
}

/** W menu in edit mode (Specials). */
export function meshSpecialsMenu(): MenuItem[] {
  return [
    op('Subdivide', 'mesh.subdivide', { number_cuts: 1, smoothness: 0 }),
    op('Subdivide Smooth', 'mesh.subdivide', { number_cuts: 1, smoothness: 1 }),
    sep,
    op('Merge', 'mesh.merge_menu'),
    op('Remove Doubles', 'mesh.remove_doubles'),
    sep,
    op('Flip Normals', 'mesh.flip_normals'),
    op('Smooth', 'mesh.vertices_smooth'),
    sep,
    op('Inset Faces', 'mesh.inset'),
    sep,
    op('Select Inverse', 'mesh.select_all', { action: 'INVERT' }),
    sep,
    op('Shade Smooth', 'mesh.faces_shade_smooth'),
    op('Shade Flat', 'mesh.faces_shade_flat'),
  ];
}

/** W menu in object mode. */
export function objectSpecialsMenu(): MenuItem[] {
  return [
    op('Shade Smooth', 'object.shade_smooth'),
    op('Shade Flat', 'object.shade_flat'),
    sep,
    op('Set Origin to Geometry', 'object.origin_set', { type: 'ORIGIN_GEOMETRY' }),
    op('Set Origin to 3D Cursor', 'object.origin_set', { type: 'ORIGIN_CURSOR' }),
  ];
}
