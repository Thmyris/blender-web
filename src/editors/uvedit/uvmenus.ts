// Menus of UV editing (no heavy imports, so editors and panels can use them freely): the 3D
// View's U "UV Mapping" menu and the UV/Image Editor's W / Shift+S / show-hide menus.

import type { MenuItem } from '../../ui/menu';
import type { OpProps } from '../../app';

const sep: MenuItem = { type: 'separator' };
const op = (label: string, id: string, props?: OpProps): MenuItem => ({ label, op: id, props });

/** 3D View > U: "UV Mapping". */
export function uvMappingMenu(): MenuItem[] {
  return [
    op('Unwrap', 'uv.unwrap'),
    op('Smart UV Project', 'uv.smart_project'),
    op('Lightmap Pack', 'uv.lightmap_pack'),
    op('Follow Active Quads', 'uv.follow_active_quads'),
    sep,
    op('Cube Projection', 'uv.cube_project'),
    op('Cylinder Projection', 'uv.cylinder_project'),
    op('Sphere Projection', 'uv.sphere_project'),
    sep,
    op('Project From View', 'uv.project_from_view', { scale_to_bounds: false }),
    op('Project from View (Bounds)', 'uv.project_from_view', { scale_to_bounds: true }),
    sep,
    op('Mark Seam', 'mesh.mark_seam', { clear: false }),
    op('Clear Seam', 'mesh.mark_seam', { clear: true }),
    sep,
    op('Reset', 'uv.reset'),
  ];
}

export function uvWeldAlignMenu(): MenuItem[] {
  return [
    op('Weld', 'uv.weld'),
    op('Remove Doubles UV', 'uv.remove_doubles'),
    sep,
    op('Straighten', 'uv.align', { axis: 'ALIGN_S' }),
    op('Straighten X', 'uv.align', { axis: 'ALIGN_T' }),
    op('Straighten Y', 'uv.align', { axis: 'ALIGN_U' }),
    op('Align Auto', 'uv.align', { axis: 'ALIGN_AUTO' }),
    op('Align X', 'uv.align', { axis: 'ALIGN_X' }),
    op('Align Y', 'uv.align', { axis: 'ALIGN_Y' }),
  ];
}

export function uvSnapMenu(): MenuItem[] {
  return [
    op('Selected to Pixels', 'uv.snap_selected', { target: 'PIXELS' }),
    op('Selected to Cursor', 'uv.snap_selected', { target: 'CURSOR' }),
    op('Selected to Cursor (Offset)', 'uv.snap_selected', { target: 'CURSOR_OFFSET' }),
    op('Selected to Adjacent Unselected', 'uv.snap_selected', { target: 'ADJACENT_UNSELECTED' }),
    sep,
    op('Cursor to Pixels', 'uv.snap_cursor', { target: 'PIXELS' }),
    op('Cursor to Selected', 'uv.snap_cursor', { target: 'SELECTED' }),
  ];
}

export function uvShowHideMenu(): MenuItem[] {
  return [
    op('Reveal Hidden', 'uv.reveal'),
    op('Hide Selected', 'uv.hide', { unselected: false }),
    op('Hide Unselected', 'uv.hide', { unselected: true }),
  ];
}

