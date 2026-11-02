// Info editor: the top header with the main menus (File, Render, Window, Help),
// screen layout and scene selectors, render engine and scene statistics, and
// the report log (Python-like operator history) in its main region.

import { app } from '../app';
import { Editor, registerEditor } from '../screen/editor';
import type { Area, Screen } from '../screen/screen';
import { h, clear } from '../ui/dom';
import { icon } from '../ui/icons';
import { pulldown, showMenu, type MenuItem } from '../ui/menu';
import type { Layout } from '../ui/layout';
import { listFiles } from '../io/files';
import { renderListeners, renderProgress } from '../render/render';

const sep: MenuItem = { type: 'separator' };
const na = (label: string, icon?: string): MenuItem => ({ label, icon, disabled: true, description: 'Not available in blender-web' });

export function fileMenu(): MenuItem[] {
  const recent = app.prefs.lastFiles;
  const stored = listFiles();
  return [
    { label: 'New', icon: 'NEW', op: 'wm.read_homefile' },
    { label: 'Open...', icon: 'FILE_FOLDER', op: 'wm.open_mainfile' },
    {
      type: 'submenu', label: 'Open Recent', icon: 'OPEN_RECENT', items: () => {
        const names = [...new Set([...recent, ...stored.map((f) => f.name)])].slice(0, 15);
        return names.length ? [...names.map((n) => ({ label: n, icon: 'FILE_BLEND', action: () => void app.callOperator('wm.open_mainfile', { filepath: n }, { exec: true }) })), sep, { label: 'Clear Recent Files List', action: () => { app.prefs.lastFiles = []; } }] : [{ type: 'label', label: 'No recent files' }];
      },
    },
    { type: 'submenu', label: 'Recover', icon: 'RECOVER_LAST', items: [{ label: 'Last Session', icon: 'RECOVER_LAST', op: 'wm.recover_last_session' }, { label: 'Auto Save...', icon: 'RECOVER_AUTO', op: 'wm.recover_auto_save' }] },
    { label: 'Revert', icon: 'FILE_REFRESH', disabled: () => !app.doc.filename, action: () => { if (app.doc.filename) void app.callOperator('wm.open_mainfile', { filepath: app.doc.filename }, { exec: true }); } },
    sep,
    { label: 'Save', icon: 'FILE_TICK', op: 'wm.save_mainfile' },
    { label: 'Save As...', icon: 'SAVE_AS', op: 'wm.save_as_mainfile' },
    { label: 'Download .blend.json', icon: 'EXPORT', op: 'wm.download_mainfile' },
    { label: 'Open from Disk...', icon: 'FILE_FOLDER', op: 'wm.upload_mainfile' },
    sep,
    { label: 'User Preferences...', icon: 'PREFERENCES', op: 'screen.userpref_show' },
    sep,
    { label: 'Save Startup File', icon: 'SAVE_PREFS', op: 'wm.save_homefile' },
    { label: 'Load Factory Settings', icon: 'LOAD_FACTORY', op: 'wm.read_factory_settings' },
    sep,
    na('Link...', 'LINK_BLEND'),
    na('Append...', 'APPEND_BLEND'),
    { type: 'submenu', label: 'Data Previews', items: [na('Refresh Data-Block Previews')] },
    sep,
    {
      type: 'submenu', label: 'Import', icon: 'IMPORT', items: [
        na('Collada (Default) (.dae)'), na('Alembic (.abc)'), na('Motion Capture (.bvh)'), na('Scalable Vector Graphics (.svg)'),
        { label: 'Stl (.stl)', op: 'import_mesh.stl' }, na('FBX (.fbx)'), na('Stanford (.ply)'), { label: 'Wavefront (.obj)', op: 'import_scene.obj' }, na('X3D Extensible 3D (.x3d/.wrl)'),
      ],
    },
    {
      type: 'submenu', label: 'Export', icon: 'EXPORT', items: [
        na('Collada (Default) (.dae)'), na('Alembic (.abc)'), na('Motion Capture (.bvh)'),
        { label: 'Stl (.stl)', op: 'export_mesh.stl' }, na('FBX (.fbx)'), na('Stanford (.ply)'), { label: 'Wavefront (.obj)', op: 'export_scene.obj' },
        { label: 'glTF 2.0 (.glb)', op: 'export_scene.gltf' }, na('X3D Extensible 3D (.x3d)'),
      ],
    },
    sep,
    { type: 'submenu', label: 'External Data', items: [na('Automatically Pack Into .blend'), na('Pack All Into .blend'), na('Unpack All Into Files')] },
    sep,
    { label: 'Quit', icon: 'QUIT', op: 'wm.quit_blender' },
  ];
}

export function renderMenu(): MenuItem[] {
  return [
    { label: 'Render Image', icon: 'RENDER_STILL', op: 'render.render', props: { animation: false } },
    { label: 'Render Animation', icon: 'RENDER_ANIMATION', op: 'render.render', props: { animation: true } },
    na('Render Audio...'),
    sep,
    { label: 'View Render', op: 'render.view_show' },
    na('View Animation'),
    sep,
    { label: 'Lock Interface', checked: app.scene.render.useLockInterface, action: () => { app.scene.render.useLockInterface = !app.scene.render.useLockInterface; } },
    sep,
    { label: 'OpenGL Render Image', icon: 'RENDER_STILL', op: 'render.opengl', props: { animation: false } },
    { label: 'OpenGL Render Animation', icon: 'RENDER_ANIMATION', op: 'render.opengl', props: { animation: true } },
    sep,
    { label: 'Save Rendered Image...', icon: 'SAVE_AS', op: 'image.save_as' },
    { label: 'Save Rendered Animation (.webm)', icon: 'RENDER_ANIMATION', op: 'image.save_animation' },
  ];
}

export function windowMenu(): MenuItem[] {
  return [
    na('Duplicate Window'),
    { label: 'Toggle Window Fullscreen', action: () => { if (document.fullscreenElement) void document.exitFullscreen(); else void document.documentElement.requestFullscreen?.(); } },
    sep,
    { label: 'Next Screen', op: 'screen.screen_set', props: { delta: 1 } },
    { label: 'Previous Screen', op: 'screen.screen_set', props: { delta: -1 } },
    sep,
    na('Save Screenshot'),
    na('Save Screencast'),
    sep,
    na('Toggle System Console'),
  ];
}

export function helpMenu(): MenuItem[] {
  const url = (label: string, u: string, ic = 'URL'): MenuItem => ({ label, icon: ic, action: () => window.open(u, '_blank', 'noopener') });
  return [
    url('Manual', 'https://docs.blender.org/manual/en/2.79/', 'HELP'),
    url('Release Log', 'https://www.blender.org/download/releases/2-79/'),
    url('Blender Website', 'https://www.blender.org/'),
    url('Blender Store', 'https://store.blender.org/'),
    url('Developer Community', 'https://www.blender.org/get-involved/'),
    url('User Community', 'https://www.blender.org/community/'),
    url('Report a Bug', 'https://developer.blender.org/'),
    sep,
    url('Python API Reference', 'https://docs.blender.org/api/2.79/'),
    { label: 'Keyboard Shortcuts', icon: 'HELP', op: 'wm.keymap_show' },
    { label: 'Operator Cheat Sheet', icon: 'SCRIPT', action: () => listOperators() },
    sep,
    { label: 'Save System Info', icon: 'INFO', op: 'wm.system_info' },
    sep,
    { label: 'Splash Screen', icon: 'BLENDER', op: 'wm.splash' },
  ];
}

function listOperators(): void {
  const lines = [...app.operators.values()].map((d) => `bpy.ops.${d.id}()  # ${d.label}`).sort().join('\n');
  const texts = Object.values(app.doc.texts);
  let t = texts.find((x) => x.name === 'OperatorList.txt');
  if (!t) { t = { id: `TX${Date.now().toString(36)}`, name: 'OperatorList.txt', body: '', fakeUser: false }; app.doc.texts[t.id] = t; }
  t.body = `# Operators available in blender-web\n${lines}\n`;
  app.report('INFO', 'See OperatorList.txt in the Text Editor');
  app.notify('all');
}

export class InfoEditor extends Editor {
  static readonly TYPE = 'INFO';
  private log: HTMLElement;
  private statsEl: HTMLElement | null = null;
  private reportEl: HTMLElement | null = null;
  private lastReportCount = -1;
  private unsub: () => void;

  constructor(area: Area, state: Record<string, unknown>) {
    super(area, state);
    this.log = h('div', { class: 'region-scroll', style: { background: '#727272', padding: '4px', fontFamily: 'monospace', fontSize: '12px' } });
    this.main.append(h('div', { class: 'region', style: { flex: '1 1 auto' } }, this.log));
    const l = () => this.updateStatus();
    renderListeners.add(l);
    this.unsub = () => renderListeners.delete(l);
  }

  get type(): string { return InfoEditor.TYPE; }

  override destroy(): void { this.unsub(); }

  override headerKey(): string {
    return [app.doc.scenes.map((s) => s.name).join(), app.scene.id, (app.screen as unknown as Screen)?.layoutName, app.scene.render.engine].join('|');
  }

  override drawHeader(l: Layout): void {
    const area = () => this.area;
    const row = l.row();
    row.el.classList.add('header-row');
    row.el.style.flex = '0 0 auto';
    row.el.append(
      pulldown({ label: 'File', items: fileMenu }, area),
      pulldown({ label: 'Render', items: renderMenu }, area),
      pulldown({ label: 'Window', items: windowMenu }, area),
      pulldown({ label: 'Help', items: helpMenu }, area),
    );
    const screen = app.screen as unknown as Screen;
    // screen layout selector
    const lay = l.row(true);
    lay.el.style.flex = '0 0 auto';
    const layEl = lay.prop({ kind: 'enum', name: 'Screen', items: () => (screen?.templateNames() ?? ['Default']).map((n) => ({ id: n, label: n, icon: 'SPLITSCREEN' })), get: () => screen?.layoutName ?? 'Default', set: (v) => screen.setLayout(v), undo: false, description: 'Active screen showing in the window' }, { noLabel: true, icon: 'SPLITSCREEN' });
    layEl.style.width = '150px';
    lay.button('', () => app.report('INFO', 'Adding screens is not available in blender-web'), { icon: 'ZOOMIN', iconOnly: true, tip: 'Add a new screen (not available)' });
    lay.button('', () => app.report('INFO', 'Deleting screens is not available in blender-web'), { icon: 'X', iconOnly: true, tip: 'Delete active screen (not available)' });
    // scene selector
    const sc = l.row(true);
    sc.el.style.flex = '0 0 auto';
    const scEl = sc.prop({
      kind: 'enum', name: 'Scene', items: () => app.doc.scenes.map((s) => ({ id: s.id, label: s.name, icon: 'SCENE_DATA' })), get: () => app.doc.activeScene,
      set: (v) => { app.doc.activeScene = v; app.mode = 'OBJECT'; app.editObject = null; app.tagAllGeometry(); }, undo: 'Change Scene', description: 'Active scene being displayed',
    }, { noLabel: true, icon: 'SCENE_DATA' });
    scEl.style.width = '150px';
    sc.operator('scene.new', { iconOnly: true, icon: 'ZOOMIN' });
    sc.operator('scene.delete', { iconOnly: true, icon: 'X' });
    // render engine
    const eng = l.prop({
      kind: 'enum', name: 'Engine', items: [{ id: 'BLENDER_RENDER', label: 'Blender Render' }, { id: 'BLENDER_GAME', label: 'Blender Game', disabled: true, description: 'Not available in blender-web' }, { id: 'CYCLES', label: 'Cycles Render', disabled: true, description: 'Not available in blender-web' }],
      get: () => app.scene.render.engine, set: (v) => { app.scene.render.engine = v as never; }, description: 'Engine to use for rendering',
    }, { noLabel: true });
    eng.style.flex = '0 0 130px';
    this.reportEl = h('div', { style: { display: 'flex', alignItems: 'center', gap: '4px', flex: '0 1 auto', overflow: 'hidden', minWidth: '0' } });
    l.el.append(this.reportEl);
    this.statsEl = h('div', { class: 'header-status', style: { flex: '1 1 auto', textAlign: 'right' } });
    l.el.append(this.statsEl);
    this.updateStatus();
  }

  private reportTimer = 0;
  private updateStatus(): void {
    if (this.statsEl) this.statsEl.textContent = renderProgress ?? app.stats();
    if (this.reportEl) {
      const r = app.reports.filter((x) => x.type !== 'OPERATOR' && x.type !== 'PROPERTY').slice(-1)[0];
      clear(this.reportEl);
      if (r && Date.now() - r.time < 5000) {
        const col = r.type === 'ERROR' ? '#c03030' : r.type === 'WARNING' ? '#c88a10' : '#5680c2';
        this.reportEl.append(h('div', { style: { background: col, color: '#fff', padding: '1px 8px', borderRadius: '4px', display: 'flex', alignItems: 'center', gap: '4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, icon(r.type === 'ERROR' ? 'ERROR' : r.type === 'WARNING' ? 'ERROR' : 'INFO'), r.text));
        window.clearTimeout(this.reportTimer);
        this.reportTimer = window.setTimeout(() => this.updateStatus(), 5100 - (Date.now() - r.time));
      }
    }
  }

  override refresh(_flags: Set<string>): void {
    this.updateStatus();
    if (this.area.rect.h < 60) return;
    if (app.reports.length === this.lastReportCount) return;
    this.lastReportCount = app.reports.length;
    const atBottom = this.log.scrollTop + this.log.clientHeight >= this.log.scrollHeight - 4;
    clear(this.log);
    for (const r of app.reports) {
      const col = r.type === 'OPERATOR' ? '#000' : r.type === 'ERROR' ? '#7a0000' : r.type === 'WARNING' ? '#704d00' : '#1c2c54';
      const row = h('div', { style: { color: col, padding: '1px 4px', whiteSpace: 'pre-wrap', userSelect: 'text' } }, r.text);
      row.addEventListener('pointerdown', (e) => {
        if (e.button === 2) {
          e.preventDefault();
          showMenu([{ label: 'Copy', action: () => void navigator.clipboard?.writeText(r.text) }, { label: 'Clear Log', action: () => { app.reports = []; this.lastReportCount = -1; this.refresh(new Set()); } }], { x: e.clientX, y: e.clientY });
        }
      });
      row.addEventListener('contextmenu', (e) => e.preventDefault());
      this.log.append(row);
    }
    if (atBottom) this.log.scrollTop = this.log.scrollHeight;
  }
}

registerEditor({ type: InfoEditor.TYPE, label: 'Info', icon: 'INFO_EDITOR', create: (area, state) => new InfoEditor(area, state) });
