// User Preferences (Ctrl+Alt+U), as a window and as an editor type, plus a
// simple File Browser editor listing files saved in the browser.

import { app, type Prefs } from '../app';
import { Editor, registerEditor } from '../screen/editor';
import type { Area } from '../screen/screen';
import { h, clear } from '../ui/dom';
import { icon } from '../ui/icons';
import { buildLayout, type Layout, type LayoutRoot, type EnumItem } from '../ui/layout';
import { listFiles, loadFromBrowser, deleteFile, openFromDisk } from '../io/files';

let tab = 'INTERFACE';

const p = () => app.prefs;
function bool(l: Layout, key: keyof Prefs, name: string, description?: string) {
  l.prop({ kind: 'bool', name, description, get: () => !!p()[key], set: (v) => { (p() as unknown as Record<string, unknown>)[key] = v; }, undo: false, notify: ['prefs', 'view'] });
}
function num(l: Layout, key: keyof Prefs, name: string, o: { min?: number; max?: number; step?: number; int?: boolean; description?: string } = {}) {
  l.prop({ kind: (o.int ? 'int' : 'float') as 'float', name, min: o.min, max: o.max, step: o.step, precision: 2, description: o.description, get: () => Number(p()[key]), set: (v: number) => { (p() as unknown as Record<string, unknown>)[key] = v; if (key === 'autoSaveTime') app.restartAutosave(); }, undo: false, notify: ['prefs', 'view'] });
}
function en(l: Layout, key: keyof Prefs, name: string, items: EnumItem[], expand = false) {
  l.prop({ kind: 'enum', name, items, get: () => String(p()[key]), set: (v) => { (p() as unknown as Record<string, unknown>)[key] = v; }, undo: false, notify: ['prefs', 'view'] }, { expand });
}
function na(l: Layout, text: string) { l.prop({ kind: 'bool', name: text, get: () => false, set: () => {}, disabled: () => true, undo: false, description: 'Not available in blender-web' }); }

export function drawUserPrefs(l: Layout): void {
  const tabs = l.row(true);
  const ids = ['INTERFACE', 'EDITING', 'INPUT', 'ADDONS', 'THEMES', 'FILES', 'SYSTEM'];
  const labels = ['Interface', 'Editing', 'Input', 'Add-ons', 'Themes', 'File', 'System'];
  const body = h('div', { style: { minHeight: '380px', marginTop: '6px' } });
  let bodyRoot: LayoutRoot | null = null;
  const draw = () => {
    clear(body);
    bodyRoot = buildLayout(body, null, (b) => drawTab(b));
    l.root.widgets.push({ update: () => bodyRoot?.update() });
  };
  tabs.prop({ kind: 'enum', name: 'Section', items: ids.map((id, i) => ({ id, label: labels[i] })), get: () => tab, set: (v) => { tab = v; draw(); }, undo: false }, { expand: true });
  l.el.append(body);
  draw();
  const foot = l.row();
  foot.button('Save User Settings', () => app.savePrefs(), { icon: 'SAVE_PREFS' });
  foot.button('Load Factory Settings', () => { app.resetPrefs(); draw(); }, { icon: 'FILE_REFRESH' });
}

function drawTab(l: Layout): void {
  const split = l.split(0.5);
  const a = split.column(), b = split.column();
  switch (tab) {
    case 'INTERFACE':
      a.label('Display:');
      bool(a, 'showTooltips', 'Tooltips', 'Display tooltips (when off hold Alt to force display)');
      bool(a, 'showTooltipsPython', 'Python Tooltips', 'Show Python references in tooltips');
      bool(a, 'showObjectInfo', 'Object Info', 'Display objects name and frame number in 3D view');
      bool(a, 'showViewName', 'View Name', 'Show the name of the view\'s direction in each 3D View');
      bool(a, 'showPlaybackFps', 'Playback FPS', 'Show the frames per second screen refresh rate, while animation is played back');
      bool(a, 'showGridFloor', 'Global Grid Floor');
      a.separator();
      bool(a, 'showMiniAxis', 'Mini Axes', 'Show a small rotating 3D axes in the bottom left corner of the 3D View');
      num(a, 'miniAxisSize', 'Size', { min: 10, max: 64, int: true });
      a.separator();
      bool(a, 'showSplash', 'Show Splash', 'Display splash screen on startup');
      b.label('View Manipulation:');
      bool(b, 'zoomToMouse', 'Zoom To Mouse Position', 'Zoom in towards the mouse pointer\'s position in the 3D view');
      bool(b, 'orbitAroundSelection', 'Rotate Around Selection', 'Use selection as the pivot point');
      bool(b, 'autoPerspective', 'Auto Perspective', 'Automatically switch between orthographic and perspective when changing from top/front/side views');
      num(b, 'smoothView', 'Smooth View', { min: 0, max: 1000, int: true, description: 'Time to animate the view in milliseconds, zero to disable' });
      num(b, 'rotationAngle', 'Rotation Angle', { min: 0, max: 90, description: 'Rotation step for numerical pad keys (2 4 6 8)' });
      b.separator();
      b.label('Manipulator:');
      na(b, 'Size / Handle Size / Hotspot');
      break;
    case 'EDITING':
      a.label('New Objects:');
      bool(a, 'enterEditMode', 'Enter Edit Mode', 'Enter Edit Mode automatically after adding a new object');
      en(a, 'alignNewObjects', 'Align To', [{ id: 'WORLD', label: 'World' }, { id: 'VIEW', label: 'View' }]);
      a.separator();
      a.label('Undo:');
      num(a, 'undoSteps', 'Steps', { min: 0, max: 256, int: true, description: 'Number of undo steps available (smaller values conserve memory)' });
      b.label('New F-Curve Defaults:');
      en(b, 'keyframeInterpolation', 'Interpolation', [{ id: 'CONSTANT', label: 'Constant' }, { id: 'LINEAR', label: 'Linear' }, { id: 'BEZIER', label: 'Bezier' }]);
      b.separator();
      na(b, 'Grease Pencil: Simplify Stroke');
      na(b, 'Duplicate Data: Material');
      break;
    case 'INPUT':
      a.label('Presets:');
      a.prop({ kind: 'enum', name: 'Presets', items: [{ id: 'blender', label: 'Blender' }, { id: 'maya', label: 'Maya', disabled: true }, { id: '3dsmax', label: '3ds Max', disabled: true }], get: () => 'blender', set: () => {}, undo: false }, { noLabel: true });
      a.label('Mouse:');
      bool(a, 'emulate3Button', 'Emulate 3 Button Mouse', 'Emulate Middle Mouse with Alt+Left Mouse');
      a.label('Select With:');
      en(a, 'selectMouse', 'Select With', [{ id: 'LEFT', label: 'Left' }, { id: 'RIGHT', label: 'Right' }], true);
      num(a, 'dragThreshold', 'Drag Threshold', { min: 1, max: 40, int: true });
      a.separator();
      a.label('Orbit Style:');
      en(a, 'orbitStyle', 'Orbit Style', [{ id: 'TURNTABLE', label: 'Turntable' }, { id: 'TRACKBALL', label: 'Trackball' }], true);
      a.label('Zoom:');
      bool(a, 'invertZoomWheel', 'Invert Wheel Zoom Direction', 'Swap the Mouse Wheel zoom direction');
      a.separator();
      a.label('NDOF Device:');
      na(a, 'NDOF Sensitivity');
      b.label('Numpad Emulation:');
      bool(b, 'emulateNumpad', 'Emulate Numpad', 'Main 1 to 0 keys act as the numpad ones (useful for laptops)');
      b.separator();
      b.label('Keymap:');
      b.operator('wm.keymap_show', { text: 'Show Keyboard Shortcuts' });
      break;
    case 'ADDONS':
      a.label('Supported Level:');
      a.label('Categories: All');
      for (const name of ['Import-Export: Wavefront OBJ format (built in)', 'Import-Export: STL format (built in)', 'Import-Export: glTF 2.0 format (built in)']) {
        const box = l.box();
        box.label(name, { icon: 'PLUGIN' });
      }
      b.label('Third-party add-ons cannot be installed in blender-web.');
      break;
    case 'THEMES':
      a.label('Theme: Default (Blender 2.79)');
      a.label('Theme editing is not available in blender-web.');
      break;
    case 'FILES':
      a.label('Auto Save:');
      bool(a, 'autoSave', 'Auto Save Temporary Files', 'Automatic saving of temporary files into the browser storage');
      num(a, 'autoSaveTime', 'Timer (mins)', { min: 1, max: 60, int: true, description: 'The time (in minutes) to wait between automatic temporary saves' });
      a.separator();
      a.label('Recent Files:');
      a.label(`${p().lastFiles.length} recent file(s) remembered`);
      a.button('Clear Recent Files', () => { p().lastFiles = []; });
      b.label('Storage:');
      b.label(`${listFiles().length} file(s) saved in this browser`);
      break;
    case 'SYSTEM':
      a.label('General:');
      num(a, 'uiScale', 'Scale', { min: 0.5, max: 2, step: 0.05, description: 'Changes the size of the fonts and buttons in the interface' });
      a.label('(UI scale applies after a reload)');
      b.label('OpenGL:');
      b.label(`WebGL2, device pixel ratio ${window.devicePixelRatio}`);
      break;
  }
}

export class UserPrefsEditor extends Editor {
  static readonly TYPE = 'USER_PREFERENCES';
  private root: LayoutRoot;
  constructor(area: Area, state: Record<string, unknown>) {
    super(area, state);
    const body = h('div', { class: 'panels', style: { padding: '8px' } });
    this.main.append(h('div', { class: 'region', style: { flex: '1 1 auto' } }, h('div', { class: 'region-scroll' }, body)));
    this.root = buildLayout(body, area, (l) => drawUserPrefs(l));
  }
  get type(): string { return UserPrefsEditor.TYPE; }
  override drawHeader(l: Layout): void { l.label('User Preferences'); }
  override refresh(): void { this.root.update(); }
}

export class FileBrowserEditor extends Editor {
  static readonly TYPE = 'FILE_BROWSER';
  private list: HTMLElement;
  private key = '';
  constructor(area: Area, state: Record<string, unknown>) {
    super(area, state);
    this.list = h('div', { class: 'region-scroll', style: { background: '#3a3a3a', color: '#ddd', padding: '4px' } });
    this.main.append(h('div', { class: 'region', style: { flex: '1 1 auto' } }, this.list));
  }
  get type(): string { return FileBrowserEditor.TYPE; }
  override drawHeader(l: Layout): void {
    l.label('Browser storage', { icon: 'FILE_FOLDER' }).style.flex = '0 0 auto';
    l.button('Open from Disk...', () => void openFromDisk(), { icon: 'FILE_FOLDER' }).style.flex = '0 0 140px';
  }
  override refresh(): void {
    const files = listFiles();
    const k = JSON.stringify(files) + app.doc.filename;
    if (k === this.key) return;
    this.key = k;
    clear(this.list);
    if (!files.length) this.list.append(h('div', { style: { padding: '8px', color: '#999' } }, 'No files saved yet. Use File > Save (Ctrl S).'));
    for (const f of files) {
      const row = h('div', { class: 'ui-list-row', style: { color: '#ddd', background: f.name === app.doc.filename ? 'rgba(86,128,194,0.5)' : '' } }, icon('FILE_BLEND'), h('div', { class: 'name' }, f.name), h('div', { style: { color: '#999' } }, new Date(f.modified).toLocaleString()));
      const del = h('div', { class: 'icon-btn', title: 'Delete' }, icon('X'));
      del.addEventListener('click', (e) => { e.stopPropagation(); deleteFile(f.name); this.key = ''; this.refresh(); });
      row.append(del);
      row.addEventListener('dblclick', () => loadFromBrowser(f.name));
      this.list.append(row);
    }
  }
}

registerEditor({ type: UserPrefsEditor.TYPE, label: 'User Preferences', icon: 'PREFERENCES', create: (area, state) => new UserPrefsEditor(area, state) });
registerEditor({ type: FileBrowserEditor.TYPE, label: 'File Browser', icon: 'FILESEL', create: (area, state) => new FileBrowserEditor(area, state) });
