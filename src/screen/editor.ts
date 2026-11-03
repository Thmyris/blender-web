// Editor (space) base class and registry.

import { h, clear } from '../ui/dom';
import { Layout, LayoutRoot } from '../ui/layout';
import type { MenuItem } from '../ui/menu';
import type { Area } from './screen';

export interface EditorClass {
  type: string;
  label: string;
  icon: string;
  create(area: Area, state: Record<string, unknown>): Editor;
}

export const editorRegistry = new Map<string, EditorClass>();

export function registerEditor(cls: EditorClass): void {
  editorRegistry.set(cls.type, cls);
}

/** Order and grouping of the Editor Type menu (as in Blender 2.79). */
export const EDITOR_MENU: { title: string; types: string[] }[] = [
  { title: 'Scripting', types: ['CONSOLE', 'FILE_BROWSER', 'INFO', 'USER_PREFERENCES'] },
  { title: 'Data', types: ['OUTLINER', 'PROPERTIES'] },
  { title: 'Editing', types: ['LOGIC_EDITOR', 'NODE_EDITOR', 'TEXT_EDITOR', 'CLIP_EDITOR', 'SEQUENCE_EDITOR', 'IMAGE_EDITOR'] },
  { title: 'Animation', types: ['NLA_EDITOR', 'DOPESHEET_EDITOR', 'GRAPH_EDITOR', 'TIMELINE', 'VIEW_3D'] },
];

export abstract class Editor {
  header: HTMLElement;
  main: HTMLElement;
  protected headerRoot: LayoutRoot;
  private headerKeyCache = '';
  /** Header placement; Blender 2.79 puts it at the bottom for 3D View and Timeline. */
  headerPosition: 'top' | 'bottom' = 'top';

  constructor(public area: Area, public state: Record<string, unknown>) {
    this.header = h('div', { class: 'header' });
    this.main = h('div', { class: 'area-main' });
    this.headerRoot = new LayoutRoot(area);
  }

  abstract get type(): string;

  /** Build the header contents (after the editor-type button). */
  abstract drawHeader(layout: Layout): void;

  /** Rebuild the header when this key changes. */
  headerKey(): string { return ''; }

  /** Called once the editor's elements are in the DOM. */
  mount(): void {}

  /** Called on data/state changes. */
  refresh(_flags: Set<string>): void {}

  /** Called when the area is resized. */
  resize(): void {}

  /** Keyboard events while the mouse is over this area. Return true when handled. */
  onKey(_e: KeyboardEvent): boolean { return false; }

  destroy(): void {}

  /** Extra items appended to the header context menu. */
  headerMenuItems(): MenuItem[] { return []; }

  rebuildHeader(force = false): void {
    const key = this.headerKey();
    if (!force && key === this.headerKeyCache && this.header.childElementCount) { this.headerRoot.update(); return; }
    this.headerKeyCache = key;
    clear(this.header);
    this.headerRoot = new LayoutRoot(this.area);
    const l = new Layout(this.header, this.headerRoot);
    this.area.drawEditorTypeButton(l);
    this.drawHeader(l);
  }
}
