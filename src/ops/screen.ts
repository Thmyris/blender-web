// Window manager, screen, file, render, animation-playback and history operators.

import { app, type OperatorDef, type OpContext, type OpResult } from '../app';
import { createStartupDoc, createScene, createWorld, NUM_LAYERS } from '../core/scene';
import { insertKeyframe, deleteKeyframe, objectKeyFrames, KEYING_SETS, ANIMATABLE } from '../core/anim';
import { confirmPopup, showDialog, promptString } from '../ui/popup';
import { showMenu, showSearchMenu } from '../ui/menu';
import { pickFile } from '../ui/dom';
import { showSplash } from '../ui/splash';
import { fileBrowser, saveToBrowser, loadFromBrowser, downloadDoc, openFromDisk, saveStartup, readStartup, clearStartup } from '../io/files';
import { exportOBJ, importOBJ, exportSTL, importSTL, exportGLB, baseName, download } from '../io/io';
import { renderStill, renderAnimation, renderResult, renderResultBlob, cancelRender } from '../render/render';
import { viewOf } from './common';
import type { Area, Screen } from '../screen/screen';
import { drawOperatorProps } from '../editors/view3d/panels';
import { shortcutList } from '../keymap';

const screen = () => app.screen as unknown as Screen;
const areaOf = (ctx: OpContext) => (ctx.area as Area | null) ?? screen().areaUnderMouse();

function opDialog(title: string, draw: Parameters<typeof showDialog>[0]['draw'], onOk: () => void, okText = 'OK', width = 340) {
  showDialog({ title, width, draw, okText, onOk: () => { onOk(); } });
}

export const SCREEN_OPERATORS: OperatorDef[] = [
  // ---------------------------------------------------------------- history
  { id: 'ed.undo', label: 'Undo', description: 'Undo previous action', exec: () => (app.undo() ? 'FINISHED' : 'CANCELLED') },
  { id: 'ed.redo', label: 'Redo', description: 'Redo previous action', exec: () => (app.redo() ? 'FINISHED' : 'CANCELLED') },
  {
    id: 'ed.undo_history', label: 'Undo History', description: 'Redo specific action in history',
    exec: () => {
      const hist = app.undoHistory().slice().reverse();
      showMenu(hist.map((s) => ({ label: s.name, checked: s.current, action: () => app.undoTo(s.index) })), app.mouse, { title: 'Undo History', atMouse: true });
      return 'FINISHED';
    },
  },
  {
    id: 'screen.repeat_last', label: 'Repeat Last', description: 'Repeat last action',
    poll: () => !!app.lastOp?.def.exec,
    exec: async (): Promise<OpResult> => {
      const last = app.lastOp!;
      const r = await last.def.exec!(last.ctx, JSON.parse(JSON.stringify(last.props)));
      if (r === 'FINISHED') app.finishOperator(last.def, last.props, last.ctx);
      return 'FINISHED';
    },
  },
  {
    id: 'screen.repeat_history', label: 'Repeat History', description: 'Display menu for previous actions performed',
    exec: () => {
      const ops = app.reports.filter((r) => r.type === 'OPERATOR').slice(-15).reverse();
      showMenu(ops.length ? ops.map((r) => ({ label: r.text.replace(/^bpy\.ops\./, '').replace(/\(.*$/, ''), action: () => { const id = r.text.replace(/^bpy\.ops\./, '').replace(/\(.*$/, ''); void app.callOperator(id, {}, { exec: true }); } })) : [{ type: 'label', label: 'No history' }], app.mouse, { title: 'Repeat History', atMouse: true });
      return 'FINISHED';
    },
  },
  {
    id: 'screen.redo_last', label: 'Adjust Last Operation', description: 'Display menu for last action performed (F6)',
    poll: () => !!app.lastOp?.def.props,
    exec: () => {
      const last = app.lastOp!;
      showDialog({ title: last.def.label, width: 300, modal: false, draw: (l) => drawOperatorProps(l, last.def.props!) });
      return 'FINISHED';
    },
  },
  {
    id: 'wm.search_menu', label: 'Search Menu', description: 'Pop-up a search menu over all available operators in current context',
    exec: (ctx) => {
      const area = ctx.area;
      showSearchMenu(() => [...app.operators.values()]
        .filter((d) => !d.id.startsWith('_') && d.label && (!d.poll || safePoll(d, area)))
        .map((d) => ({ label: d.label, detail: d.id, icon: d.icon, action: () => void app.callOperator(d.id, {}, { area }) })), app.mouse, 'Search...');
      return 'FINISHED';
    },
  },
  // ---------------------------------------------------------------- screen
  {
    id: 'screen.screen_full_area', label: 'Toggle Maximize Area', description: 'Toggle display selected area as fullscreen/maximized',
    props: { use_hide_panels: { name: 'Hide Panels', type: 'bool', default: false } },
    exec: (ctx, p) => { const a = areaOf(ctx); screen().toggleMaximize(a, !!p.use_hide_panels); return 'FINISHED'; },
  },
  {
    id: 'screen.screen_set', label: 'Set Screen', description: 'Cycle through available screens',
    props: { delta: { name: 'Delta', type: 'int', default: 1 } },
    exec: (_c, p) => { screen().cycleLayout(Number(p.delta) > 0 ? 1 : -1); return 'FINISHED'; },
  },
  {
    id: 'screen.back_to_previous', label: 'Back to Previous Screen', description: 'Revert back to the original screen layout, before fullscreen area overlay',
    poll: (ctx) => !!(areaOf(ctx)?.tempPrevType) || !!screen().maximized,
    exec: (ctx) => {
      const a = areaOf(ctx);
      if (screen().maximized) screen().toggleMaximize(null);
      if (a?.tempPrevType) a.restoreTemp();
      return 'FINISHED';
    },
  },
  { id: 'screen.userpref_show', label: 'Show User Preferences', description: 'Show user preferences', exec: () => { openPrefs(); return 'FINISHED'; } },
  {
    id: 'screen.new', label: 'New Screen', description: 'Add a new screen (not available)', poll: () => false, exec: () => 'CANCELLED',
  },
  // ---------------------------------------------------------------- scenes
  {
    id: 'scene.new', label: 'New Scene', description: 'Add new scene by type', undo: true, register: true,
    props: { type: { name: 'Type', type: 'enum', default: 'NEW', items: [['NEW', 'New'], ['EMPTY', 'Copy Settings'], ['LINK_OBJECTS', 'Link Objects'], ['FULL_COPY', 'Full Copy']] } },
    invoke: (ctx) => {
      const t = (type: string) => () => void app.callOperator('scene.new', { type }, { area: ctx.area, exec: true });
      showMenu([{ label: 'New', action: t('NEW') }, { label: 'Copy Settings', action: t('EMPTY') }, { label: 'Link Objects', action: t('LINK_OBJECTS') }, { label: 'Full Copy', action: t('FULL_COPY'), disabled: true }], app.mouse, { title: 'New Scene', atMouse: true });
      return 'CANCELLED';
    },
    exec: (_c, p) => {
      const cur = app.scene;
      const sc = createScene(app.doc, p.type === 'NEW' ? 'Scene' : cur.name);
      if (p.type !== 'NEW') {
        sc.render = JSON.parse(JSON.stringify(cur.render));
        sc.unit = { ...cur.unit };
        sc.world = cur.world;
        sc.frameStart = cur.frameStart; sc.frameEnd = cur.frameEnd; sc.fps = cur.fps;
      } else {
        sc.world = createWorld(app.doc).id;
      }
      if (p.type === 'LINK_OBJECTS') { sc.objects = cur.objects.slice(); sc.camera = cur.camera; sc.activeObject = cur.activeObject; }
      app.doc.scenes.push(sc);
      app.doc.activeScene = sc.id;
      if (app.mode === 'EDIT') { app.mode = 'OBJECT'; app.editObject = null; }
      app.tagAllGeometry();
      return 'FINISHED';
    },
  },
  {
    id: 'scene.delete', label: 'Delete Scene', description: 'Delete active scene', undo: true, register: true, poll: () => app.doc.scenes.length > 1,
    exec: () => {
      const id = app.scene.id;
      app.doc.scenes = app.doc.scenes.filter((s) => s.id !== id);
      app.doc.activeScene = app.doc.scenes[0].id;
      app.mode = 'OBJECT';
      app.editObject = null;
      app.tagAllGeometry();
      return 'FINISHED';
    },
  },
  // ---------------------------------------------------------------- files
  {
    id: 'wm.read_homefile', label: 'New', description: 'Open the default file (doesn\'t save the current file)',
    invoke: (ctx) => { confirmPopup('OK?', 'Reload Start-Up File', () => void app.callOperator('wm.read_homefile', {}, { area: ctx.area, exec: true }), undefined, 'FILE_NEW'); return 'CANCELLED'; },
    exec: () => {
      const startup = readStartup();
      app.loadDoc(startup ?? createStartupDoc(), '');
      app.report('INFO', 'Loaded startup file');
      return 'FINISHED';
    },
  },
  {
    id: 'wm.read_factory_settings', label: 'Load Factory Settings', description: 'Load default file and user preferences',
    invoke: (ctx) => { confirmPopup('OK?', 'Load Factory Settings', () => void app.callOperator('wm.read_factory_settings', {}, { area: ctx.area, exec: true })); return 'CANCELLED'; },
    exec: () => { clearStartup(); app.resetPrefs(); app.loadDoc(createStartupDoc(), ''); return 'FINISHED'; },
  },
  {
    id: 'wm.open_mainfile', label: 'Open', description: 'Open a Blender file',
    props: { filepath: { name: 'File Path', type: 'string', default: '' } },
    invoke: (_c, p) => { if (p.filepath) return loadFromBrowser(String(p.filepath)) ? 'FINISHED' : 'CANCELLED'; fileBrowser('open'); return 'CANCELLED'; },
    exec: (_c, p) => (loadFromBrowser(String(p.filepath)) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    id: 'wm.save_mainfile', label: 'Save', description: 'Save the current file in the desired location',
    exec: () => { if (!app.doc.filename) { fileBrowser('save'); return 'CANCELLED'; } return saveToBrowser(app.doc.filename) ? 'FINISHED' : 'CANCELLED'; },
  },
  { id: 'wm.save_as_mainfile', label: 'Save As', description: 'Save the current file in the desired location', exec: () => { fileBrowser('save'); return 'FINISHED'; } },
  { id: 'wm.download_mainfile', label: 'Download .blend.json', description: 'Download the current file to your computer', icon: 'EXPORT', exec: () => { downloadDoc(); return 'FINISHED'; } },
  { id: 'wm.upload_mainfile', label: 'Open from Disk...', description: 'Open a .blend.json file from your computer', icon: 'FILE_FOLDER', exec: async (): Promise<OpResult> => ((await openFromDisk()) ? 'FINISHED' : 'CANCELLED') },
  {
    id: 'wm.recover_auto_save', label: 'Recover Auto Save', description: 'Open an automatically saved file to recover it',
    exec: () => { const d = app.readAutosave(); if (!d) { app.report('WARNING', 'No auto save found'); return 'CANCELLED'; } app.loadDoc(d, ''); app.report('INFO', 'Recovered auto save'); return 'FINISHED'; },
  },
  {
    id: 'wm.recover_last_session', label: 'Recover Last Session', description: 'Open the last closed file ("quit.blend")',
    exec: () => { const d = app.readQuitSession(); if (!d) { app.report('WARNING', 'No last session found'); return 'CANCELLED'; } app.loadDoc(d, ''); app.report('INFO', 'Recovered last session'); return 'FINISHED'; },
  },
  { id: 'wm.save_homefile', label: 'Save Startup File', description: 'Make the current file the default .blend file', invoke: (ctx) => { confirmPopup('OK?', 'Save Startup File', () => void app.callOperator('wm.save_homefile', {}, { area: ctx.area, exec: true })); return 'CANCELLED'; }, exec: () => { saveStartup(); return 'FINISHED'; } },
  { id: 'wm.save_userpref', label: 'Save User Settings', description: 'Save user preferences separately, overrides startup file preferences', exec: () => { app.savePrefs(); return 'FINISHED'; } },
  {
    id: 'wm.quit_blender', label: 'Quit', description: 'Quit Blender',
    invoke: (ctx) => { confirmPopup('OK?', 'Quit Blender', () => void app.callOperator('wm.quit_blender', {}, { area: ctx.area, exec: true }), undefined, 'QUIT'); return 'CANCELLED'; },
    exec: () => {
      try { localStorage.setItem('blender-web:quit', JSON.stringify(app.doc)); } catch { /* ignore */ }
      document.body.innerHTML = '<div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px;background:#222;color:#ddd;font-family:sans-serif"><div style="font-size:18px">Blender has quit.</div><div style="opacity:.7">Your session was saved and can be restored with File &gt; Recover &gt; Last Session.</div><button onclick="location.reload()" style="padding:6px 16px">Restart</button></div>';
      return 'FINISHED';
    },
  },
  { id: 'wm.splash', label: 'Splash Screen', description: 'Open the splash screen with release info', exec: () => { showSplash(); return 'FINISHED'; } },
  {
    id: 'wm.url_open', label: 'Open URL', description: 'Open a website in the web-browser',
    props: { url: { name: 'URL', type: 'string', default: '' } },
    exec: (_c, p) => { window.open(String(p.url), '_blank', 'noopener'); return 'FINISHED'; },
  },
  {
    id: 'wm.keymap_show', label: 'Keyboard Shortcuts', description: 'Show a list of keyboard shortcuts',
    exec: () => {
      showDialog({
        title: 'Keyboard Shortcuts', icon: 'HELP', width: 640,
        draw: (l) => {
          const wrap = l.column();
          wrap.el.style.maxHeight = '70vh';
          wrap.el.style.overflowY = 'auto';
          for (const [section, items] of shortcutList()) {
            wrap.label(section).style.fontWeight = 'bold';
            const box = wrap.box();
            for (const [key, desc] of items) {
              const r = box.row();
              r.label(desc);
              r.label(key, { align: 'right' });
            }
          }
        },
      });
      return 'FINISHED';
    },
  },
  {
    id: 'wm.system_info', label: 'System Info', description: 'Show information about the browser environment',
    exec: () => {
      const gl = document.createElement('canvas').getContext('webgl2');
      const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
      const info = [
        `blender-web 2.79b UI`, `User agent: ${navigator.userAgent}`, `WebGL2: ${gl ? 'yes' : 'no'}`,
        `GPU: ${gl && dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown'}`, `Device pixel ratio: ${window.devicePixelRatio}`,
        `Objects: ${Object.keys(app.doc.objects).length}, Meshes: ${Object.keys(app.doc.meshes).length}`,
      ];
      showDialog({ title: 'System Info', width: 520, draw: (l) => { for (const s of info) l.label(s); } });
      return 'FINISHED';
    },
  },
  // ---------------------------------------------------------------- import / export
  {
    id: 'import_scene.obj', label: 'Import OBJ', description: 'Load a Wavefront OBJ File', icon: 'IMPORT', undo: true, register: true,
    poll: () => app.mode === 'OBJECT',
    exec: async (): Promise<OpResult> => {
      const f = await pickFile('.obj');
      if (!f) return 'CANCELLED';
      const obs = importOBJ(await f.text(), f.name.replace(/\.obj$/i, ''));
      app.report('INFO', `Imported ${obs.length} object(s) from ${f.name}`);
      return obs.length ? 'FINISHED' : 'CANCELLED';
    },
  },
  {
    id: 'import_mesh.stl', label: 'Import STL', description: 'Load STL triangle mesh data', icon: 'IMPORT', undo: true, register: true,
    poll: () => app.mode === 'OBJECT',
    exec: async (): Promise<OpResult> => {
      const f = await pickFile('.stl');
      if (!f) return 'CANCELLED';
      const ob = importSTL(await f.arrayBuffer(), f.name.replace(/\.stl$/i, ''));
      if (!ob) { app.report('ERROR', 'Could not read STL file'); return 'CANCELLED'; }
      return 'FINISHED';
    },
  },
  {
    id: 'export_scene.obj', label: 'Export OBJ', description: 'Save a Wavefront OBJ File', icon: 'EXPORT', register: true,
    props: {
      use_selection: { name: 'Selection Only', type: 'bool', default: false }, use_mesh_modifiers: { name: 'Apply Modifiers', type: 'bool', default: true },
      use_normals: { name: 'Write Normals', type: 'bool', default: true }, use_materials: { name: 'Write Materials', type: 'bool', default: true },
      use_triangles: { name: 'Triangulate Faces', type: 'bool', default: false }, axis_up: { name: 'Up', type: 'enum', default: 'Y', items: [['Y', 'Y Up'], ['Z', 'Z Up']] },
    },
    invoke: (ctx, p) => {
      opDialog('Export OBJ', (l) => drawOperatorPropsLocal(l, 'export_scene.obj', p), () => void app.operator('export_scene.obj')!.exec!(ctx, p), 'Export OBJ');
      return 'CANCELLED';
    },
    exec: (_c, p) => {
      const r = exportOBJ({ selectedOnly: !!p.use_selection, applyModifiers: !!p.use_mesh_modifiers, writeNormals: !!p.use_normals, writeMaterials: !!p.use_materials, triangulate: !!p.use_triangles, yUp: p.axis_up === 'Y' });
      const base = baseName();
      download(`${base}.obj`, r.obj, 'text/plain');
      if (p.use_materials) setTimeout(() => download(`${base}.mtl`, r.mtl, 'text/plain'), 300);
      app.report('INFO', `Exported ${base}.obj`);
      return 'FINISHED';
    },
  },
  {
    id: 'export_mesh.stl', label: 'Export STL', description: 'Save STL triangle mesh data', icon: 'EXPORT', register: true,
    props: { use_selection: { name: 'Selection Only', type: 'bool', default: false }, ascii: { name: 'Ascii', type: 'bool', default: false }, use_mesh_modifiers: { name: 'Apply Modifiers', type: 'bool', default: true } },
    invoke: (ctx, p) => { opDialog('Export STL', (l) => drawOperatorPropsLocal(l, 'export_mesh.stl', p), () => void app.operator('export_mesh.stl')!.exec!(ctx, p), 'Export STL'); return 'CANCELLED'; },
    exec: (_c, p) => {
      const data = exportSTL(!!p.use_selection, !!p.ascii, !!p.use_mesh_modifiers);
      download(`${baseName()}.stl`, data, 'model/stl');
      return 'FINISHED';
    },
  },
  {
    id: 'export_scene.gltf', label: 'Export glTF 2.0', description: 'Export scene as glTF 2.0 binary (.glb)', icon: 'EXPORT', register: true,
    props: { use_selection: { name: 'Selected Objects', type: 'bool', default: false } },
    invoke: (ctx, p) => { opDialog('Export glTF 2.0', (l) => drawOperatorPropsLocal(l, 'export_scene.gltf', p), () => void app.operator('export_scene.gltf')!.exec!(ctx, p), 'Export glTF 2.0'); return 'CANCELLED'; },
    exec: async (_c, p): Promise<OpResult> => {
      const blob = await exportGLB(!!p.use_selection);
      download(`${baseName()}.glb`, blob);
      return 'FINISHED';
    },
  },
  // ---------------------------------------------------------------- render
  {
    id: 'render.render', label: 'Render', description: 'Render active scene', icon: 'RENDER_STILL',
    props: { animation: { name: 'Animation', type: 'bool', default: false } },
    exec: async (_c, p): Promise<OpResult> => { const ok = p.animation ? await renderAnimation('RENDERED') : await renderStill('RENDERED'); return ok ? 'FINISHED' : 'CANCELLED'; },
  },
  {
    id: 'render.opengl', label: 'OpenGL Render', description: 'OpenGL render active viewport', icon: 'RENDER_STILL',
    props: { animation: { name: 'Animation', type: 'bool', default: false } },
    exec: async (ctx, p): Promise<OpResult> => {
      const v = viewOf(ctx);
      const shading = v?.display.shading ?? 'SOLID';
      const ok = p.animation ? await renderAnimation(shading) : await renderStill(shading);
      return ok ? 'FINISHED' : 'CANCELLED';
    },
  },
  {
    id: 'render.view_show', label: 'Show/Hide Render View', description: 'Toggle show render view',
    exec: (ctx) => {
      const imageArea = screen().areas().find((a) => a.type === 'IMAGE_EDITOR' && a.tempPrevType);
      if (imageArea) { imageArea.restoreTemp(); return 'FINISHED'; }
      if (!renderResult) { app.report('WARNING', 'No render result yet (press F12 to render)'); return 'CANCELLED'; }
      const a = screen().biggestArea() ?? areaOf(ctx);
      a?.setTemp('IMAGE_EDITOR');
      return 'FINISHED';
    },
  },
  { id: 'render.view_cancel', label: 'Cancel Render View', description: 'Cancel show render view', poll: (ctx) => !!areaOf(ctx)?.tempPrevType, exec: (ctx) => { cancelRender(); areaOf(ctx)?.restoreTemp(); return 'FINISHED'; } },
  {
    id: 'image.save_as', label: 'Save As Image', description: 'Save the render result to a file', icon: 'SAVE_AS',
    poll: () => !!renderResult,
    exec: async (): Promise<OpResult> => {
      const blob = await renderResultBlob();
      if (!blob) return 'CANCELLED';
      const ext = app.scene.render.fileFormat === 'JPEG' ? 'jpg' : app.scene.render.fileFormat.toLowerCase();
      download(`${baseName()}_${String(renderResult!.frame).padStart(4, '0')}.${ext}`, blob);
      return 'FINISHED';
    },
  },
  {
    id: 'image.save_animation', label: 'Save Animation', description: 'Save the last rendered animation as a WebM video', icon: 'RENDER_ANIMATION',
    poll: () => !!renderResult?.video,
    exec: () => { download(`${baseName()}.webm`, renderResult!.video!); return 'FINISHED'; },
  },
  // ---------------------------------------------------------------- animation playback
  {
    id: 'screen.animation_play', label: 'Play Animation', description: 'Play animation',
    props: { reverse: { name: 'Play in Reverse', type: 'bool', default: false } },
    exec: (_c, p) => { playStart = app.scene.frameCurrent; app.play(p.reverse ? -1 : 1); return 'FINISHED'; },
  },
  {
    id: 'screen.animation_cancel', label: 'Cancel Animation', description: 'Cancel animation, returning to the original frame', poll: () => !!app.playing,
    props: { restore_frame: { name: 'Restore Frame', type: 'bool', default: true } },
    exec: (_c, p) => { app.stop(!!p.restore_frame, playStart); return 'FINISHED'; },
  },
  {
    id: 'screen.frame_offset', label: 'Frame Offset', description: 'Move current frame forward/backward by a given number',
    props: { delta: { name: 'Delta', type: 'int', default: 1 } },
    exec: (_c, p) => { app.setFrame(app.scene.frameCurrent + Number(p.delta)); return 'FINISHED'; },
  },
  {
    id: 'screen.frame_jump', label: 'Jump to Endpoint', description: 'Jump to first/last frame in frame range',
    props: { end: { name: 'Last Frame', type: 'bool', default: false } },
    exec: (_c, p) => { const s = app.scene; app.setFrame(p.end ? (s.usePreviewRange ? s.previewEnd : s.frameEnd) : (s.usePreviewRange ? s.previewStart : s.frameStart)); return 'FINISHED'; },
  },
  {
    id: 'screen.keyframe_jump', label: 'Jump to Keyframe', description: 'Jump to previous/next keyframe',
    props: { next: { name: 'Next Keyframe', type: 'bool', default: true } },
    exec: (_c, p) => {
      const frames = new Set<number>();
      for (const o of app.selectedObjects().length ? app.selectedObjects() : app.objects()) for (const f of objectKeyFrames(o)) frames.add(f);
      const cur = app.scene.frameCurrent;
      const sorted = [...frames].sort((a, b) => a - b);
      const t = p.next ? sorted.find((f) => f > cur + 1e-4) : [...sorted].reverse().find((f) => f < cur - 1e-4);
      if (t === undefined) { app.report('INFO', 'No more keyframes to jump to in this direction'); return 'CANCELLED'; }
      app.setFrame(t);
      return 'FINISHED';
    },
  },
  {
    id: 'anim.change_frame', label: 'Change Frame', description: 'Interactively change the current frame number',
    props: { frame: { name: 'Frame', type: 'int', default: 1 } },
    exec: (_c, p) => { app.setFrame(Number(p.frame)); return 'FINISHED'; },
  },
  // ---------------------------------------------------------------- keyframes
  {
    id: 'anim.keyframe_insert_menu', label: 'Insert Keyframe Menu', description: 'Insert Keyframes for specified Keying Set, with menu of available Keying Sets if undefined', undo: true, register: true,
    poll: () => app.mode === 'OBJECT' && app.selectedObjects().length > 0,
    props: { type: { name: 'Keying Set', type: 'enum', default: '', items: KEYING_SETS.map((k) => [k.id, k.label] as [string, string]) }, always_prompt: { name: 'Always Show Menu', type: 'bool', default: false, hidden: true } },
    invoke: (ctx, p) => {
      const ks = p.type || app.scene.keyingSet;
      if (ks && !p.always_prompt) return app.operator('anim.keyframe_insert_menu')!.exec!(ctx, { ...p, type: ks });
      showMenu(KEYING_SETS.map((k, i) => (i === 7 || i === 10 ? [{ type: 'separator' as const }, { label: k.label, action: () => void app.callOperator('anim.keyframe_insert_menu', { type: k.id }, { area: ctx.area, exec: true }) }] : [{ label: k.label, action: () => void app.callOperator('anim.keyframe_insert_menu', { type: k.id }, { area: ctx.area, exec: true }) }])).flat(), app.mouse, { title: 'Insert Keyframe Menu', atMouse: true });
      return 'CANCELLED';
    },
    exec: (_c, p) => {
      const ks = KEYING_SETS.find((k) => k.id === p.type);
      if (!ks) return 'CANCELLED';
      const f = app.scene.frameCurrent;
      let n = 0;
      for (const o of app.selectedObjects()) for (const path of ks.paths) for (let i = 0; i < (ANIMATABLE[path]?.size || 1); i++) { insertKeyframe(o, path, i, f, undefined, app.prefs.keyframeInterpolation); n++; }
      app.report('INFO', `${ks.label}: inserted ${n} keyframe(s)`);
      return 'FINISHED';
    },
  },
  {
    id: 'anim.keyframe_insert_menu_popup', label: 'Insert Keyframe...', description: 'Show the Insert Keyframe menu',
    poll: () => app.mode === 'OBJECT' && app.selectedObjects().length > 0,
    exec: (ctx) => { void app.callOperator('anim.keyframe_insert_menu', { always_prompt: true }, { area: ctx.area }); return 'FINISHED'; },
  },
  {
    id: 'anim.keyframe_delete_v3d', label: 'Delete Keyframe', description: 'Remove keyframes on current frame for selected objects', undo: true, register: true,
    poll: () => app.selectedObjects().some((o) => o.fcurves.length),
    invoke: (ctx) => { confirmPopup('OK?', 'Delete Keyframe', () => void app.callOperator('anim.keyframe_delete_v3d', {}, { area: ctx.area, exec: true })); return 'CANCELLED'; },
    exec: () => {
      const f = app.scene.frameCurrent;
      for (const o of app.selectedObjects()) for (const fc of o.fcurves.slice()) deleteKeyframe(o, fc.path, fc.index, f);
      return 'FINISHED';
    },
  },
  {
    id: 'anim.keyframe_clear_v3d', label: 'Remove Animation', description: 'Remove all keyframe animation for selected objects', undo: true, register: true,
    poll: () => app.selectedObjects().some((o) => o.fcurves.length),
    invoke: (ctx) => { confirmPopup('OK?', 'Remove Animation', () => void app.callOperator('anim.keyframe_clear_v3d', {}, { area: ctx.area, exec: true })); return 'CANCELLED'; },
    exec: () => { for (const o of app.selectedObjects()) o.fcurves = []; return 'FINISHED'; },
  },
  {
    id: 'anim.auto_key_toggle', label: 'Auto Keying', description: 'Automatic keyframe insertion for objects',
    exec: () => { const t = app.scene.toolSettings; t.useKeyframeInsertAuto = !t.useKeyframeInsertAuto; return 'FINISHED'; },
  },
  {
    id: 'time.start_frame_set', label: 'Set Start Frame', description: 'Set the start frame', undo: true, register: true,
    exec: () => { const s = app.scene; s.frameStart = s.frameCurrent; if (s.frameEnd < s.frameStart) s.frameEnd = s.frameStart; return 'FINISHED'; },
  },
  {
    id: 'time.end_frame_set', label: 'Set End Frame', description: 'Set the end frame', undo: true, register: true,
    exec: () => { const s = app.scene; s.frameEnd = s.frameCurrent; if (s.frameStart > s.frameEnd) s.frameStart = s.frameEnd; return 'FINISHED'; },
  },
  {
    id: 'time.view_all', label: 'View All', description: 'Show the entire playable frame range',
    exec: (ctx) => { const a = areaOf(ctx); (a?.editor as unknown as { viewAll?: () => void })?.viewAll?.(); return 'FINISHED'; },
  },
  {
    id: 'marker.add', label: 'Add Time Marker', description: 'Add a new time marker', undo: true, register: true,
    exec: () => {
      const s = app.scene;
      for (const m of s.markers) m.select = false;
      s.markers.push({ name: `F_${String(s.frameCurrent).padStart(2, '0')}`, frame: s.frameCurrent, select: true });
      return 'FINISHED';
    },
  },
  {
    id: 'marker.delete', label: 'Delete Markers', description: 'Delete selected time marker(s)', undo: true, register: true, poll: () => app.scene.markers.some((m) => m.select),
    exec: () => { app.scene.markers = app.scene.markers.filter((m) => !m.select); return 'FINISHED'; },
  },
  {
    id: 'marker.rename', label: 'Rename Marker', description: 'Rename first selected time marker', undo: true, register: true, poll: () => app.scene.markers.some((m) => m.select),
    exec: async (): Promise<OpResult> => {
      const m = app.scene.markers.find((x) => x.select)!;
      const s = await promptString('Rename Marker', 'Name:', m.name);
      if (s === null) return 'CANCELLED';
      m.name = s;
      return 'FINISHED';
    },
  },
];

let playStart = 1;

function safePoll(d: OperatorDef, area: OpContext['area']): boolean {
  try { return d.poll ? d.poll({ app, area }) : true; } catch { return false; }
}

function drawOperatorPropsLocal(l: Parameters<typeof drawOperatorProps>[0], id: string, props: Record<string, unknown>): void {
  const def = app.operator(id)!;
  for (const [k, pd] of Object.entries(def.props ?? {})) {
    if (pd.type === 'bool') l.prop({ kind: 'bool', name: pd.name, get: () => !!props[k], set: (v) => { props[k] = v; }, undo: false });
    else if (pd.type === 'enum') l.prop({ kind: 'enum', name: pd.name, items: (pd.items ?? []).map(([id2, label]) => ({ id: id2, label })), get: () => String(props[k]), set: (v) => { props[k] = v; }, undo: false });
  }
}

// ------------------------------------------------------------------ user preferences window

let prefsDialog: { close(): void } | null = null;

export function openPrefs(): void {
  prefsDialog?.close();
  import('../editors/userprefs').then(({ drawUserPrefs }) => {
    prefsDialog = showDialog({ title: 'Blender User Preferences', icon: 'PREFERENCES', width: 760, modal: false, draw: (l) => drawUserPrefs(l) });
  });
}

export function unusedScreenHelpers(): void { void NUM_LAYERS; }
