// Application bootstrap: registers operators and editors, builds the screen
// layouts (Default, Animation, Scripting, ...), and routes input events.

import './styles/blender.css';
import { createApp, app } from './app';
import { Screen, type LayoutTemplate, type ScreenNode } from './screen/screen';
import { TRANSFORM_OPERATORS } from './editors/view3d/transform';
import { OBJECT_OPERATORS } from './ops/object';
import { MESH_OPERATORS } from './ops/mesh';
import { VIEW_OPERATORS } from './ops/view';
import { SCREEN_OPERATORS } from './ops/screen';
import { MESH_TOOL_OPERATORS, registerMeshToolKeys } from './ops/meshtools';
import { registerUV } from './ops/uv';
import { initEditorsExt } from './editors/ext_init';
import { dispatchKey } from './keymap';
import { menuKeyDown, menusOpen, closeAllMenus, hideTooltip } from './ui/menu';
import { hoveredWidget } from './ui/layout';
import { isTextInput } from './ui/dom';
import { dialogOpen } from './ui/popup';
import { showSplash } from './ui/splash';
import { setUnitSettings } from './ui/format';
import { cancelRender } from './render/render';
import { onFontLoaded } from './core/text3d';
import type { Area } from './screen/screen';

// editors (each registers itself)
import './editors/view3d/view3d';
import './editors/outliner';
import './editors/properties';
import './editors/info';
import './editors/anim';
import './editors/text';
import './editors/image';
import './editors/userprefs';

const a = createApp();
for (const def of [...TRANSFORM_OPERATORS, ...OBJECT_OPERATORS, ...MESH_OPERATORS, ...VIEW_OPERATORS, ...SCREEN_OPERATORS]) a.registerOperator(def);
for (const def of MESH_TOOL_OPERATORS) a.registerOperator(def);
registerMeshToolKeys();
registerUV();
initEditorsExt();

// regenerate text objects once the font has loaded
onFontLoaded(() => app.tagAllGeometry());

// keep the unit display settings in sync with the active scene
a.onChange(() => setUnitSettings(app.scene.unit));
setUnitSettings(a.scene.unit);

// ------------------------------------------------------------------ screen layouts

const leaf = (s: Screen, type: string): ScreenNode => ({ kind: 'area', area: s.newArea(type) });
const split = (dir: 'h' | 'v', a1: ScreenNode, b1: ScreenNode, ratio = 0.5, fixed?: { which: 0 | 1; px: number }): ScreenNode => ({ kind: 'split', dir, ratio, fixed, a: a1, b: b1 });
const INFO_H = 26;

const TEMPLATES: LayoutTemplate[] = [
  {
    name: 'Default',
    build: (s) => split('h', leaf(s, 'INFO'),
      split('v',
        split('h', leaf(s, 'VIEW_3D'), leaf(s, 'TIMELINE'), 0.85, { which: 1, px: 76 }),
        split('h', leaf(s, 'OUTLINER'), leaf(s, 'PROPERTIES'), 0.3, { which: 0, px: 230 }),
        0.8, { which: 1, px: 330 }),
      0, { which: 0, px: INFO_H }),
  },
  {
    name: 'Animation',
    build: (s) => split('h', leaf(s, 'INFO'),
      split('v',
        split('h',
          split('v', leaf(s, 'VIEW_3D'), leaf(s, 'VIEW_3D'), 0.3),
          split('h', leaf(s, 'DOPESHEET_EDITOR'), leaf(s, 'TIMELINE'), 0.7, { which: 1, px: 76 }),
          0.6),
        split('h', leaf(s, 'OUTLINER'), leaf(s, 'PROPERTIES'), 0.3, { which: 0, px: 200 }),
        0.8, { which: 1, px: 320 }),
      0, { which: 0, px: INFO_H }),
  },
  {
    name: 'Scripting',
    build: (s) => split('h', leaf(s, 'INFO'),
      split('v',
        split('h',
          split('v', leaf(s, 'TEXT_EDITOR'), leaf(s, 'VIEW_3D'), 0.55),
          leaf(s, 'CONSOLE'), 0.7),
        split('h', leaf(s, 'OUTLINER'), leaf(s, 'PROPERTIES'), 0.3, { which: 0, px: 200 }),
        0.8, { which: 1, px: 320 }),
      0, { which: 0, px: INFO_H }),
  },
  {
    name: 'UV Editing',
    build: (s) => split('h', leaf(s, 'INFO'),
      split('v', leaf(s, 'IMAGE_EDITOR'), leaf(s, 'VIEW_3D'), 0.5),
      0, { which: 0, px: INFO_H }),
  },
  {
    name: '3D View Full',
    build: (s) => split('h', leaf(s, 'INFO'), leaf(s, 'VIEW_3D'), 0, { which: 0, px: INFO_H }),
  },
  {
    name: 'Game Logic',
    build: (s) => split('h', leaf(s, 'INFO'),
      split('v', leaf(s, 'VIEW_3D'), split('h', leaf(s, 'OUTLINER'), leaf(s, 'PROPERTIES'), 0.3), 0.75),
      0, { which: 0, px: INFO_H }),
  },
];

const root = document.getElementById('app')!;
document.documentElement.style.setProperty('--ui-size', `${Math.round(11 * (a.prefs.uiScale || 1))}px`);
const screen = new Screen(root, TEMPLATES);
a.screen = screen;

// ------------------------------------------------------------------ global input routing

window.addEventListener('pointermove', (e) => { a.mouse.x = e.clientX; a.mouse.y = e.clientY; }, true);
window.addEventListener('pointerdown', (e) => { a.mouse.x = e.clientX; a.mouse.y = e.clientY; hideTooltip(); }, true);

// modal operators (transform, border select, ...) receive all input until they finish
for (const type of ['pointermove', 'pointerdown', 'pointerup', 'wheel', 'contextmenu'] as const) {
  window.addEventListener(type, (e) => {
    if (!a.modal) return;
    if (a.modal.onEvent(e)) {
      e.preventDefault();
      e.stopPropagation();
      if (type !== 'pointermove') a.notify('view');
      else a.notify('view');
    }
  }, { capture: true, passive: false });
}

window.addEventListener('contextmenu', (e) => {
  if (!isTextInput(e.target)) e.preventDefault();
});

window.addEventListener('keydown', (e) => {
  // modal handlers first (they also get keys while a text field is not focused)
  if (a.modal) {
    if (a.modal.onEvent(e)) { e.preventDefault(); e.stopPropagation(); a.notify('view'); }
    return;
  }
  if (isTextInput(e.target)) return;
  if (menusOpen()) {
    if (menuKeyDown(e)) { e.preventDefault(); e.stopPropagation(); }
    return;
  }
  if (dialogOpen() && e.key !== 'Escape') return;
  if (e.key === 'Escape' && document.querySelector('.splash')) return;
  if (e.repeat && !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key) && !e.code.startsWith('Numpad')) {
    e.preventDefault();
    return;
  }
  if (e.key === 'Escape' && a.playing) { void a.callOperator('screen.animation_cancel', { restore_frame: true }); e.preventDefault(); return; }
  if (e.key === 'Escape') cancelRender();
  // hotkeys over hovered widgets (I, Ctrl+C/V, Backspace, Enter, ...)
  if (hoveredWidget && hoveredWidget.hotkey(e)) { e.preventDefault(); return; }
  const area = screen.areaUnderMouse() as Area | null;
  if (area && area.editor.onKey(e)) { e.preventDefault(); return; }
  if (dispatchKey(e, area)) { e.preventDefault(); e.stopPropagation(); }
});

// browser shortcuts that would leave the page are blocked where possible
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && ['KeyS', 'KeyO', 'KeyP'].includes(e.code)) e.preventDefault();
  if (e.code === 'F12' || e.code === 'F11' || e.code === 'F3' || e.code === 'F1' || e.code === 'F2' || e.code === 'F6' || e.code === 'F10') e.preventDefault();
}, true);

window.addEventListener('blur', () => { if (menusOpen()) closeAllMenus(); });

// expose for debugging and automated tests
(window as unknown as { blenderWeb: typeof a }).blenderWeb = a;

a.notify('all');
if (a.prefs.showSplash && !new URLSearchParams(location.search).has('nosplash')) setTimeout(() => showSplash(), 300);
