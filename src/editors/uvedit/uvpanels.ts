// Header menus, header widgets, tool shelf (T) and properties region (N) panels of the
// UV/Image Editor (space_image.py of Blender 2.79).

import { app } from '../../app';
import type { BImage } from '../../core/types';
import type { Layout, PanelDef } from '../../ui/layout';
import type { MenuItem } from '../../ui/menu';
import { h } from '../../ui/dom';
import { icon } from '../../ui/icons';
import { renderResult } from '../../render/render';
import { getImage, imageCanvas, imageList, regenerateImage } from '../../paint/images';
import { activeUVIndex, cornerUV } from '../../core/uvdata';
import { isSync, selectedCorners, uvContext, uvSettings } from './uvsel';
import { uvShowHideMenu, uvSnapMenu, uvWeldAlignMenu } from './uvmenus';
import { uvTransformExec } from './uvtools';
import { redoPanels } from '../view3d/panels';
import type { View3D } from '../view3d/view3d';
import { imagePaintPanels, imagePaintMenu } from '../../paint/texpaint';
import type { ImageEditor } from '../image';

const sep: MenuItem = { type: 'separator' };
const op = (label: string, id: string, props?: Record<string, unknown>): MenuItem => ({ label, op: id, props });

// ------------------------------------------------------------------ menus

export function imageEditorMenus(ed: ImageEditor): { label: string; items: () => MenuItem[] }[] {
  const menus: { label: string; items: () => MenuItem[] }[] = [];
  menus.push({ label: 'View', items: () => viewMenu(ed) });
  if (ed.editingUVs()) menus.push({ label: 'Select', items: () => selectMenu(ed) });
  menus.push({ label: 'Image', items: () => imageMenu(ed) });
  if (ed.editingUVs()) menus.push({ label: 'UVs', items: () => uvsMenu(ed) });
  if (ed.mode === 'PAINT') menus.push({ label: 'Brush', items: () => imagePaintMenu() });
  return menus;
}

function viewMenu(ed: ImageEditor): MenuItem[] {
  const zoom = (r: number, label: string, shortcut?: string): MenuItem => ({ label, shortcut, action: () => ed.setZoomRatio(r) });
  return [
    { label: 'Properties', checked: !!ed.state.showNPanel, shortcut: 'N', action: () => ed.toggleRegion('npanel') },
    { label: 'Tool Shelf', checked: !!ed.state.showToolshelf, shortcut: 'T', action: () => ed.toggleRegion('toolshelf') },
    sep,
    { label: 'Draw Other Objects', disabled: true, description: 'Not available in blender-web' },
    sep,
    { label: 'Zoom In', shortcut: 'Numpad +', action: () => ed.zoomAt(1.25) },
    { label: 'Zoom Out', shortcut: 'Numpad -', action: () => ed.zoomAt(0.8) },
    sep,
    zoom(1 / 8, 'Zoom 1:8', 'Numpad 8'), zoom(1 / 4, 'Zoom 1:4', 'Numpad 4'), zoom(1 / 2, 'Zoom 1:2', 'Numpad 2'), zoom(1, 'Zoom 1:1', 'Numpad 1'),
    zoom(2, 'Zoom 2:1', 'Ctrl Numpad 2'), zoom(4, 'Zoom 4:1', 'Ctrl Numpad 4'), zoom(8, 'Zoom 8:1', 'Ctrl Numpad 8'),
    sep,
    { label: 'View Fit', shortcut: 'Shift Home', action: () => ed.viewAll() },
    { label: 'View All', shortcut: 'Home', action: () => ed.viewAll() },
    ...(ed.editingUVs() ? [{ label: 'View Selected', shortcut: 'Numpad .', action: () => ed.viewSelected() } as MenuItem] : []),
    sep,
    op('Toggle Maximize Area', 'screen.screen_full_area'),
    op('Toggle Fullscreen Area', 'screen.screen_full_area', { use_hide_panels: true }),
  ];
}

function selectMenu(ed: ImageEditor): MenuItem[] {
  return [
    { label: 'Border Select', shortcut: 'B', action: () => ed.startBorder() },
    { label: 'Circle Select', shortcut: 'C', action: () => ed.startCircle() },
    sep,
    op('(De)select All', 'uv.select_all', { action: 'TOGGLE' }),
    op('Inverse', 'uv.select_all', { action: 'INVERT' }),
    sep,
    op('Select Pinned', 'uv.select_pinned'),
    op('Select Linked', 'uv.select_linked'),
    { label: 'Select Linked Pick', shortcut: 'L', action: () => ed.pickLinkedAtMouse(false) },
  ];
}

function imageMenu(ed: ImageEditor): MenuItem[] {
  const hasImg = !!ed.image;
  return [
    op('New Image', 'image.new'),
    op('Open Image...', 'image.open'),
    sep,
    { label: 'Reload Image', op: 'image.reload', disabled: !hasImg },
    sep,
    { label: 'Save Image', op: 'image.save', disabled: !hasImg },
    op('Save As Image', 'image.save_as'),
    sep,
    { label: 'Pack Image', op: 'image.pack', disabled: !hasImg },
    { type: 'submenu', label: 'Invert', disabled: !hasImg, items: () => [
      { label: 'Invert Image Colors', action: () => ed.invertImage(true, false) },
      sep,
      { label: 'Invert Red Channel', action: () => ed.invertImage([true, false, false], false) },
      { label: 'Invert Green Channel', action: () => ed.invertImage([false, true, false], false) },
      { label: 'Invert Blue Channel', action: () => ed.invertImage([false, false, true], false) },
      { label: 'Invert Alpha Channel', action: () => ed.invertImage(false, true) },
    ] },
    sep,
    { label: 'Save Animation (.webm)', op: 'image.save_animation', disabled: !renderResult?.video },
  ];
}

function uvsMenu(ed: ImageEditor): MenuItem[] {
  const s = uvSettings();
  const area = ed.area;
  return [
    { label: 'Snap to Pixels', checked: !!s.snapToPixels, action: () => { s.snapToPixels = !s.snapToPixels; app.notify('view'); } },
    sep,
    op('Unwrap', 'uv.unwrap'),
    sep,
    op('Pin', 'uv.pin', { clear: false }),
    op('Unpin', 'uv.pin', { clear: true }),
    sep,
    op('Mark Seam', 'uv.mark_seam', { clear: false }),
    op('Clear Seam', 'uv.mark_seam', { clear: true }),
    op('Seams From Islands', 'uv.seams_from_islands'),
    sep,
    op('Pack Islands', 'uv.pack_islands'),
    op('Average Islands Scale', 'uv.average_islands_scale'),
    op('Minimize Stretch', 'uv.minimize_stretch'),
    op('Stitch', 'uv.stitch'),
    sep,
    { type: 'submenu', label: 'Transform', items: () => [
      { label: 'Grab/Move', shortcut: 'G', action: () => ed.startTransform('TRANSLATION') },
      { label: 'Rotate', shortcut: 'R', action: () => ed.startTransform('ROTATION') },
      { label: 'Scale', shortcut: 'S', action: () => ed.startTransform('RESIZE') },
    ] },
    { type: 'submenu', label: 'Mirror', items: () => [
      { label: 'X Axis', action: () => uvTransformExec(area, 'RESIZE', { value: [-1, 1, 1], constraint_axis: [true, false, false] }, ['transform.mirror', 'Mirror']) },
      { label: 'Y Axis', action: () => uvTransformExec(area, 'RESIZE', { value: [1, -1, 1], constraint_axis: [false, true, false] }, ['transform.mirror', 'Mirror']) },
    ] },
    { type: 'submenu', label: 'Snap', items: uvSnapMenu },
    { type: 'submenu', label: 'Weld/Align', items: uvWeldAlignMenu },
    sep,
    { type: 'submenu', label: 'Show/Hide Faces', items: uvShowHideMenu },
  ];
}

// ------------------------------------------------------------------ header widgets

const PIVOTS = [
  { id: 'BOUNDING_BOX_CENTER', label: 'Bounding Box Center', icon: 'ROTATE', description: 'Pivot around bounding box center of selected UVs' },
  { id: 'CURSOR', label: '2D Cursor', icon: 'CURSOR', description: 'Pivot around the 2D cursor' },
  { id: 'INDIVIDUAL_ORIGINS', label: 'Individual Origins', icon: 'ROTATECOLLECTION', description: 'Pivot around each island\'s own center' },
  { id: 'MEDIAN_POINT', label: 'Median Point', icon: 'ROTATECENTER', description: 'Pivot around the median point of selected UVs' },
];

export function imageEditorHeaderExtras(ed: ImageEditor, l: Layout): void {
  // image browse (template_ID)
  const tmpl = h('div', { style: { flex: '0 0 230px', display: 'flex', minWidth: '0' } });
  l.el.append(tmpl);
  const tl = new (l.constructor as new (el: HTMLElement, root: Layout['root']) => Layout)(tmpl, l.root);
  tl.idTemplate({
    icon: 'IMAGE_DATA', title: 'Image',
    items: () => [
      ...(renderResult ? [{ id: 'RENDER', name: 'Render Result', icon: 'RENDER_RESULT' }] : []),
      ...imageList().map((i) => ({ id: i.id, name: i.name, icon: 'IMAGE_DATA' })),
    ],
    get: () => (ed.image ? ed.image.id : ed.showsRender() ? 'RENDER' : null),
    set: (id) => { ed.state.image = id === 'RENDER' ? null : id; ed.viewAll(); app.notify('screen', 'view'); },
    name: () => ed.image?.name ?? (ed.showsRender() ? 'Render Result' : ''),
    rename: (n) => { const img = ed.image; if (img) img.name = n; },
    users: () => ed.imageUsers(),
    fakeUser: { get: () => !!ed.image?.fakeUser, set: (v) => { const img = ed.image; if (img) img.fakeUser = v; } },
    onNew: () => void app.callOperator('image.new', {}, { area: ed.area }),
    unlink: () => { ed.state.image = 'NONE'; app.notify('screen', 'view'); },
  });
  const openBtn = l.button('', () => void app.callOperator('image.open', {}, { area: ed.area }), { icon: 'FILE_FOLDER', iconOnly: true, tip: 'Open Image (Alt O)' });
  openBtn.style.flex = '0 0 24px';
  // mode
  const modeEl = l.prop({
    kind: 'enum', name: 'Mode', undo: false, description: 'Editing context being displayed',
    items: [
      { id: 'VIEW', label: 'View', icon: 'FILE_IMAGE', description: 'View the image and UV edit in mesh editmode' },
      { id: 'PAINT', label: 'Paint', icon: 'TPAINT_HLT', description: '2D image painting mode' },
      { id: 'MASK', label: 'Mask', icon: 'MOD_MASK', disabled: true, description: 'Mask editing: not available in blender-web' },
    ],
    get: () => ed.mode, set: (v) => { ed.state.mode = v; app.notify('screen', 'view'); ed.rebuildHeader(true); },
  }, { noLabel: true });
  modeEl.style.flex = '0 0 80px';
  if (ed.editingUVs()) {
    const s = uvSettings();
    const piv = l.prop({ kind: 'enum', name: 'Pivot', items: PIVOTS, get: () => s.pivot, set: (v) => { s.pivot = v as typeof s.pivot; }, undo: false, description: 'Rotation/Scaling Pivot' }, { iconOnly: true });
    piv.style.flex = '0 0 36px';
    const sel = l.row(true);
    sel.el.style.flex = '0 0 auto';
    sel.prop({ kind: 'bool', name: 'UV Sync Selection', get: () => s.useSync, set: (v) => { s.useSync = v; }, undo: false, notify: ['all'], description: 'Keep UV and edit mode mesh selection in sync' }, { iconOnly: true, icon: 'UV_SYNC_SELECT', iconOn: 'UV_SYNC_SELECT' });
    if (isSync()) {
      ['VERTEXSEL', 'EDGESEL', 'FACESEL'].forEach((ic, i) => {
        const el = h('div', { class: 'icon-btn emboss' }, icon(ic));
        el.addEventListener('pointerdown', (e) => { e.preventDefault(); void app.callOperator('mesh.select_mode', { type: ['VERT', 'EDGE', 'FACE'][i], use_extend: e.shiftKey }, { area: ed.area }); });
        sel.custom(el, () => el.classList.toggle('on', app.scene.toolSettings.meshSelectMode[i]));
      });
    } else {
      const modes: [typeof s.selectMode, string, string][] = [['VERTEX', 'UV_VERTEXSEL', 'Vertex'], ['EDGE', 'UV_EDGESEL', 'Edge'], ['FACE', 'UV_FACESEL', 'Face'], ['ISLAND', 'UV_ISLANDSEL', 'Island']];
      for (const [m, ic, label] of modes) {
        sel.prop({ kind: 'bool', name: label, get: () => s.selectMode === m, set: () => { s.selectMode = m; }, undo: false, notify: ['all'], description: `${label} selection mode` }, { iconOnly: true, icon: ic, iconOn: ic });
      }
      const st = l.prop({
        kind: 'enum', name: 'Sticky Selection Mode', undo: false, description: 'Automatically select also UVs sharing the same vertex as the ones being selected',
        items: [
          { id: 'DISABLED', label: 'Disabled', icon: 'STICKY_UVS_DISABLE', description: 'Sticky vertex selection disabled' },
          { id: 'SHARED_LOCATION', label: 'Shared Location', icon: 'STICKY_UVS_LOC', description: 'Select UVs that are at the same location and share a mesh vertex' },
          { id: 'SHARED_VERTEX', label: 'Shared Vertex', icon: 'STICKY_UVS_VERT', description: 'Select UVs that share mesh vertex, irrespective if they are in the same location' },
        ],
        get: () => s.stickyMode, set: (v) => { s.stickyMode = v as typeof s.stickyMode; },
      }, { iconOnly: true });
      st.style.flex = '0 0 36px';
    }
    // active UV map
    const md = app.editMesh!;
    const uvm = l.prop({
      kind: 'enum', name: 'UV Map', undo: 'Set Active UV Map', description: 'Active UV Map',
      items: () => (md.uvLayers ?? []).map((u, i) => ({ id: String(i), label: u.name, icon: 'GROUP_UVS' })),
      get: () => String(activeUVIndex(md)), set: (v) => { md.uvActive = Number(v); app.tagGeometry(md.id); },
    }, { noLabel: true });
    uvm.style.flex = '0 0 110px';
  }
  if (ed.image || ed.showsRender()) {
    const ch = l.prop({
      kind: 'enum', name: 'Draw Channels', undo: false, description: 'Channels of the image to draw',
      items: [
        { id: 'COLOR_ALPHA', label: 'Color and Alpha', icon: 'IMAGE_RGB_ALPHA', description: 'Draw image with RGB colors and alpha transparency' },
        { id: 'COLOR', label: 'Color', icon: 'IMAGE_RGB', description: 'Draw image with RGB colors' },
        { id: 'ALPHA', label: 'Alpha', icon: 'IMAGE_ALPHA', description: 'Draw alpha transparency channel' },
      ],
      get: () => String(ed.state.channels === 'COLOR' ? 'COLOR' : ed.state.channels), set: (v) => { ed.state.channels = v; app.notify('view'); },
    }, { iconOnly: true });
    ch.style.flex = '0 0 36px';
  }
}

// ------------------------------------------------------------------ tool shelf

export function imageToolPanels(ed: ImageEditor): PanelDef[] {
  if (ed.mode === 'PAINT') return imagePaintPanels(ed.area);
  const P: PanelDef[] = [];
  if (ed.editingUVs()) {
    P.push({
      id: 'uvtransform', label: 'Transform', draw: (l) => {
        const c = l.column(true);
        c.button('Translate', () => ed.startTransform('TRANSLATION'), { tip: 'Move selected UVs (G)' }).classList.add('left');
        c.button('Rotate', () => ed.startTransform('ROTATION'), { tip: 'Rotate selected UVs (R)' }).classList.add('left');
        c.button('Scale', () => ed.startTransform('RESIZE'), { tip: 'Scale selected UVs (S)' }).classList.add('left');
      },
    });
    P.push({
      id: 'uvtools', label: 'UV Tools', draw: (l) => {
        const c = l.column(true);
        for (const [id, text] of [['uv.unwrap', 'Unwrap'], ['uv.pack_islands', 'Pack Islands'], ['uv.average_islands_scale', 'Average Islands Scale'], ['uv.minimize_stretch', 'Minimize Stretch'], ['uv.stitch', 'Stitch']]) c.operator(id, { text, align: 'left' });
        const r = l.row(true);
        r.operator('uv.pin', { text: 'Pin', props: { clear: false } });
        r.operator('uv.pin', { text: 'Unpin', props: { clear: true } });
      },
    });
    P.push({ id: 'uvsculpt', label: 'UV Sculpt', defaultClosed: true, draw: (l) => { l.prop({ kind: 'bool', name: 'UV Sculpt', get: () => false, set: () => {}, disabled: () => true, undo: false, description: 'Not available in blender-web' }); } });
    P.push(...redoPanels(null as unknown as View3D));
  } else {
    P.push({ id: 'imgscopes', label: 'Scopes', defaultClosed: true, draw: (l) => l.label('Scopes are not available in blender-web', { disabled: true }) });
  }
  return P;
}

// ------------------------------------------------------------------ N panels

export function imageNPanels(ed: ImageEditor): PanelDef[] {
  const P: PanelDef[] = [];
  P.push({ id: 'img', label: 'Image', key: () => `${ed.image?.id ?? (ed.showsRender() ? 'R' : '')}|${ed.image?.source ?? ''}`, poll: () => !!ed.image || ed.showsRender(), draw: (l) => imagePanel(ed, l) });
  if (ed.editingUVs()) {
    P.push({ id: 'uvvertex', label: 'UV Vertex', poll: () => !!uvContext() && selectedCorners(uvContext()!.md, uvContext()!.layer).length > 0, draw: (l) => uvVertexPanel(ed, l) });
    P.push({ id: 'uvdisplay', label: 'Display', draw: (l) => displayPanel(ed, l) });
  }
  return P;
}

function imagePanel(ed: ImageEditor, l: Layout): void {
  const img = ed.image;
  if (!img) {
    const r = renderResult;
    l.label('Render Result', { icon: 'RENDER_RESULT' });
    if (r) l.label(`${r.width} x ${r.height}, RGBA byte`);
    return;
  }
  const I = (): BImage | null => getImage(img.id);
  l.prop({ kind: 'string', name: 'Name', get: () => I()?.name ?? '', set: (v) => { const x = I(); if (x) x.name = v; }, undo: 'Rename Image', notify: ['screen'] }, {});
  l.prop({
    kind: 'enum', name: 'Source', undo: 'Image Source', description: 'Where the image comes from',
    items: [{ id: 'FILE', label: 'Single Image', description: 'Single image file' }, { id: 'SEQUENCE', label: 'Image Sequence', disabled: true, description: 'Not available in blender-web' }, { id: 'MOVIE', label: 'Movie', disabled: true, description: 'Not available in blender-web' }, { id: 'GENERATED', label: 'Generated', description: 'Generated image' }],
    get: () => I()?.source ?? 'FILE', set: (v) => { const x = I(); if (x) x.source = v as BImage['source']; },
  });
  if (img.source === 'GENERATED') {
    const regen = () => { const x = I(); if (x) regenerateImage(x); };
    const c = l.column(true);
    c.prop({ kind: 'int', name: 'X', min: 1, max: 16384, unit: 'PIXEL', get: () => I()?.width ?? 0, set: (v) => { const x = I(); if (x) x.width = v; }, onChange: regen, undo: 'Generated Size', description: 'Generated image width' });
    c.prop({ kind: 'int', name: 'Y', min: 1, max: 16384, unit: 'PIXEL', get: () => I()?.height ?? 0, set: (v) => { const x = I(); if (x) x.height = v; }, onChange: regen, undo: 'Generated Size', description: 'Generated image height' });
    l.prop({ kind: 'bool', name: 'Float Buffer', get: () => false, set: () => {}, disabled: () => true, undo: false, description: 'Not available in blender-web' });
    l.prop({
      kind: 'enum', name: 'Type', undo: 'Generated Type', description: 'Generated image type',
      items: [{ id: 'BLANK', label: 'Blank' }, { id: 'UV_GRID', label: 'UV Grid' }, { id: 'COLOR_GRID', label: 'Color Grid' }],
      get: () => I()?.generatedType ?? 'BLANK', set: (v) => { const x = I(); if (x) x.generatedType = v as BImage['generatedType']; }, onChange: regen,
    }, { expand: true });
    if (img.generatedType === 'BLANK') {
      l.prop({ kind: 'color', name: 'Color', alpha: true, get: () => (I()?.color ?? [0, 0, 0, 1]).slice(), set: (v) => { const x = I(); if (x) x.color = [v[0], v[1], v[2], v[3] ?? 1]; }, onChange: regen, undo: 'Generated Color', description: 'Fill color for the generated image' });
    }
  } else {
    const r = l.row(true);
    r.prop({ kind: 'string', name: '', get: () => I()?.filepath ?? '', set: () => {}, disabled: () => true, undo: false, description: 'Image file path (images are packed into the document)' }, { text: '' });
    r.operator('image.reload', { iconOnly: true, icon: 'FILE_REFRESH' });
  }
  l.dynLabel(() => { const x = I(); if (!x) return ''; const c = imageCanvas(x); return `${c.width} x ${c.height}, RGBA byte${x.packed ? ', packed' : ''}`; });
  void ed;
}

function uvVertexPanel(ed: ImageEditor, l: Layout): void {
  const median = (): [number, number] => {
    const c = uvContext();
    if (!c) return [0, 0];
    const sel = selectedCorners(c.md, c.layer);
    let u = 0, v = 0;
    for (const [f, k] of sel) { const p = cornerUV(c.layer, f, k); u += p[0]; v += p[1]; }
    return sel.length ? [u / sel.length, v / sel.length] : [0, 0];
  };
  const pixels = () => !ed.state.normalized && (!!ed.image);
  const size = () => ed.imageSize();
  const col = l.column(true);
  for (let i = 0; i < 2; i++) {
    col.prop({
      kind: 'float', name: ['X', 'Y'][i], step: 0.1, precision: 3, undo: 'Edit UV Vertex', notify: ['geometry'], description: 'UV coordinate of the selected vertices (median)',
      get: () => median()[i] * (pixels() ? size()[i] : 1),
      set: (val) => {
        const c = uvContext();
        if (!c) return;
        const target = val / (pixels() ? size()[i] : 1);
        const d = target - median()[i];
        for (const [f, k] of selectedCorners(c.md, c.layer)) { const a = c.layer.uv[f]; if (a) a[k * 2 + i] += d; }
        app.tagGeometry(c.md.id);
      },
    });
  }
}

function displayPanel(ed: ImageEditor, l: Layout): void {
  const d = ed.display;
  const s = uvSettings();
  const sp = l.split();
  const c1 = sp.column();
  c1.label('Coordinates:');
  c1.prop({ kind: 'bool', name: 'Normalized', get: () => !!ed.state.normalized, set: (v) => { ed.state.normalized = v; }, undo: false, notify: ['view'], description: 'Display UV coordinates from 0.0 to 1.0 rather than in pixels' });
  const c2 = sp.column(true);
  c2.label('Cursor Location:');
  for (let i = 0; i < 2; i++) {
    c2.prop({ kind: 'float', name: ['X', 'Y'][i], step: 0.1, precision: 3, undo: false, notify: ['view'], description: '2D cursor location for this view',
      get: () => s.cursor[i] * (ed.state.normalized || !ed.image ? 1 : ed.imageSize()[i]),
      set: (v) => { s.cursor[i] = v / (ed.state.normalized || !ed.image ? 1 : ed.imageSize()[i]); } });
  }
  l.separator();
  l.label('UV:');
  l.row().prop({
    kind: 'enum', name: 'Edge Draw Type', undo: false, notify: ['view'], description: 'Draw type for drawing UV edges',
    items: [{ id: 'OUTLINE', label: 'Outline', description: 'Draw white edges with black outline' }, { id: 'DASH', label: 'Dash', description: 'Draw dashed black-white edges' }, { id: 'BLACK', label: 'Black', description: 'Draw black edges' }, { id: 'WHITE', label: 'White', description: 'Draw white edges' }],
    get: () => d.edgeStyle, set: (v) => { d.edgeStyle = v as UVEdge; },
  }, { expand: true });
  const sp2 = l.split();
  const a = sp2.column();
  a.prop({ kind: 'bool', name: 'Draw Stretch', get: () => d.drawStretch, set: (v) => { d.drawStretch = v; }, undo: false, notify: ['view'], description: 'Draw faces colored according to the difference in shape between UVs and their 3D coordinates (blue for low distortion, red for high distortion)' });
  const st = a.row();
  st.prop({ kind: 'enum', name: 'Draw Stretch Type', items: [{ id: 'ANGLE', label: 'Angle', description: 'Angular distortion between UV and 3D angles' }, { id: 'AREA', label: 'Area', description: 'Area distortion between UV and 3D faces' }], get: () => d.stretchType, set: (v) => { d.stretchType = v as 'AREA'; }, undo: false, notify: ['view'], disabled: () => !d.drawStretch }, { expand: true });
  const b = sp2.column();
  b.prop({ kind: 'bool', name: 'Smooth', get: () => d.smooth, set: (v) => { d.smooth = v; }, undo: false, notify: ['view'], description: 'Draw UV edges anti-aliased' });
  b.prop({ kind: 'bool', name: 'Modified', get: () => false, set: () => {}, disabled: () => true, undo: false, description: 'Not available in blender-web' });
  b.prop({ kind: 'bool', name: 'Faces', get: () => d.drawFaces, set: (v) => { d.drawFaces = v; }, undo: false, notify: ['view'], description: 'Draw faces over the image' });
}

type UVEdge = 'OUTLINE' | 'DASH' | 'BLACK' | 'WHITE';
