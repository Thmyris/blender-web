// Outliner: hierarchical view of the scene with selection, visibility toggles,
// renaming, context menu, drag & drop parenting and several display modes.

import { app } from '../app';
import { Editor, registerEditor } from '../screen/editor';
import type { Area } from '../screen/screen';
import { h, clear } from '../ui/dom';
import { icon, objectIcon, objectDataIcon } from '../ui/icons';
import { showMenu, type MenuItem } from '../ui/menu';
import type { Layout } from '../ui/layout';
import type { BObject } from '../core/types';
import { renameData, setParentKeepTransform, dataUsers, sceneObjects } from '../core/scene';
import { modifierDef } from '../core/modifiers';

type DisplayMode = 'ALL_SCENES' | 'CURRENT_SCENE' | 'VISIBLE_LAYERS' | 'SELECTED' | 'ACTIVE' | 'ORPHAN_DATA' | 'LIBRARIES';

interface Row {
  key: string;
  depth: number;
  icon: string;
  label: string;
  ob?: BObject;
  kind: 'scene' | 'object' | 'data' | 'material' | 'modifier' | 'group' | 'world' | 'renderlayers' | 'constraint' | 'misc';
  hasChildren: boolean;
  dim?: boolean;
  onClick?: (e: PointerEvent) => void;
  rename?: (name: string) => void;
}

export class Outliner extends Editor {
  static readonly TYPE = 'OUTLINER';
  private list: HTMLElement;
  private renaming = false;
  private lastKey = '';

  constructor(area: Area, state: Record<string, unknown>) {
    super(area, state);
    state.expanded ??= {};
    state.mode ??= 'ALL_SCENES';
    state.filter ??= '';
    this.list = h('div', { class: 'region-scroll', style: { background: 'var(--outliner-bg)', color: '#e6e6e6' } });
    const region = h('div', { class: 'region', style: { flex: '1 1 auto' } }, this.list);
    this.main.append(region);
    this.list.addEventListener('contextmenu', (e) => e.preventDefault());
    this.list.addEventListener('pointerdown', (e) => {
      if (e.target === this.list && e.button === 0 && !e.ctrlKey) { app.deselectAll(); app.notify('select'); }
    });
  }

  get type(): string { return Outliner.TYPE; }

  private get expanded(): Record<string, boolean> { return this.state.expanded as Record<string, boolean>; }

  override headerKey(): string { return String(this.state.mode); }

  override drawHeader(l: Layout): void {
    const row = l.row();
    row.el.classList.add('header-row');
    row.el.style.flex = '0 0 auto';
    row.menu('View', () => [
      { label: 'Show/Hide One Level', action: () => this.expandAll() },
      { label: 'Show Hierarchy', action: () => this.expandAll(true) },
      { label: 'Show Active', action: () => this.showActive() },
      { type: 'separator' },
      { label: 'Toggle Maximize Area', op: 'screen.screen_full_area' },
    ], { emboss: false });
    row.menu('Search', () => [
      { label: 'Case Sensitive Matches Only', disabled: true },
      { label: 'Complete Matches Only', disabled: true },
    ], { emboss: false });
    const modes: [DisplayMode, string, string][] = [['ALL_SCENES', 'All Scenes', 'SCENE_DATA'], ['CURRENT_SCENE', 'Current Scene', 'SCENE_DATA'], ['VISIBLE_LAYERS', 'Visible Layers', 'RENDERLAYERS'], ['SELECTED', 'Selected', 'RESTRICT_SELECT_OFF'], ['ACTIVE', 'Active', 'OBJECT_DATA'], ['ORPHAN_DATA', 'Orphan Data', 'X'], ['LIBRARIES', 'Blender File', 'FILE_BLEND']];
    const dm = l.prop({ kind: 'enum', name: 'Display Mode', items: modes.map(([id, label, ic]) => ({ id, label, icon: ic })), get: () => String(this.state.mode), set: (v) => { this.state.mode = v; this.lastKey = ''; this.refresh(new Set(['all'])); }, undo: false }, { noLabel: true });
    dm.style.flex = '0 0 130px';
    const search = h('input', { class: 'menu-search', placeholder: '🔍', spellcheck: 'false', value: String(this.state.filter ?? ''), style: { margin: '0', width: '100%', flex: '1 1 auto', minWidth: '40px' } }) as HTMLInputElement;
    search.addEventListener('input', () => { this.state.filter = search.value; this.lastKey = ''; this.refresh(new Set(['all'])); });
    search.addEventListener('keydown', (e) => e.stopPropagation());
    l.el.append(search);
  }

  private expandAll(deep = false): void {
    const rows = this.buildRows(true);
    const anyClosed = rows.some((r) => r.hasChildren && !this.expanded[r.key] && (deep || r.depth <= 1));
    for (const r of rows) if (r.hasChildren && (deep || r.depth <= 1)) this.expanded[r.key] = anyClosed;
    this.lastKey = '';
    this.refresh(new Set(['all']));
  }

  private showActive(): void {
    const ob = app.activeObject;
    if (!ob) return;
    this.expanded[`sc:${app.scene.id}`] = true;
    let p = ob.parent ? app.doc.objects[ob.parent] : null;
    while (p) { this.expanded[`ob:${p.id}`] = true; p = p.parent ? app.doc.objects[p.parent] : null; }
    this.lastKey = '';
    this.refresh(new Set(['all']));
    this.list.querySelector('.ui-list-row.active')?.scrollIntoView({ block: 'nearest' });
  }

  // ---------------------------------------------------------------- rows

  private objectRows(ob: BObject, depth: number, rows: Row[], all: boolean, sceneObs: BObject[]): void {
    const key = `ob:${ob.id}`;
    const md = app.meshOf(ob);
    const children = sceneObs.filter((o) => o.parent === ob.id).sort((a, b) => a.name.localeCompare(b.name));
    const hasKids = !!ob.data || ob.modifiers.length > 0 || ob.constraints.length > 0 || children.length > 0;
    rows.push({
      key, depth, icon: objectIcon(ob.type), label: ob.name, ob, kind: 'object', hasChildren: hasKids, dim: ob.hide,
      rename: (n) => renameData(app.doc, 'objects', ob.id, n),
    });
    if (!(all || this.expanded[key])) return;
    if (ob.data) {
      const coll = ob.type === 'MESH' ? 'meshes' : ob.type === 'CAMERA' ? 'cameras' : 'lamps';
      const data = (app.doc[coll] as Record<string, { id: string; name: string }>)[ob.data];
      if (data) {
        const dkey = `data:${ob.id}`;
        const mats = md?.materials.filter(Boolean) ?? [];
        rows.push({
          key: dkey, depth: depth + 1, icon: objectDataIcon(ob.type), label: data.name, ob, kind: 'data', hasChildren: mats.length > 0,
          rename: (n) => renameData(app.doc, coll, data.id, n),
          onClick: () => { this.selectOb(ob, false); if (ob.type === 'MESH') void app.callOperator('object.editmode_toggle', {}, { area: this.area }); },
        });
        if (all || this.expanded[dkey]) {
          for (const mid of mats) {
            const ma = app.doc.materials[mid!];
            if (ma) rows.push({ key: `ma:${ob.id}:${mid}`, depth: depth + 2, icon: 'MATERIAL', label: ma.name, ob, kind: 'material', hasChildren: false, rename: (n) => renameData(app.doc, 'materials', ma.id, n) });
          }
        }
      }
    }
    if (ob.modifiers.length) {
      const mkey = `mods:${ob.id}`;
      rows.push({ key: mkey, depth: depth + 1, icon: 'MODIFIER', label: 'Modifiers', ob, kind: 'group', hasChildren: true });
      if (all || this.expanded[mkey]) for (const m of ob.modifiers) rows.push({ key: `mod:${ob.id}:${m.name}`, depth: depth + 2, icon: modifierDef(m.type)?.icon ?? 'MODIFIER', label: m.name, ob, kind: 'modifier', hasChildren: false, rename: (n) => { m.name = n; } });
    }
    if (ob.constraints.length) {
      const ckey = `cons:${ob.id}`;
      rows.push({ key: ckey, depth: depth + 1, icon: 'CONSTRAINT', label: 'Constraints', ob, kind: 'group', hasChildren: true });
      if (all || this.expanded[ckey]) for (const c of ob.constraints) rows.push({ key: `con:${ob.id}:${c.name}`, depth: depth + 2, icon: 'CONSTRAINT', label: c.name, ob, kind: 'constraint', hasChildren: false, rename: (n) => { c.name = n; } });
    }
    for (const c of children) this.objectRows(c, depth + 1, rows, all, sceneObs);
  }

  private buildRows(all = false): Row[] {
    const rows: Row[] = [];
    const mode = this.state.mode as DisplayMode;
    const doc = app.doc;
    if (mode === 'ORPHAN_DATA' || mode === 'LIBRARIES') {
      const colls: [string, keyof typeof doc, string][] = [['Cameras', 'cameras', 'CAMERA_DATA'], ['Lamps', 'lamps', 'LAMP_DATA'], ['Materials', 'materials', 'MATERIAL'], ['Meshes', 'meshes', 'MESH_DATA'], ['Objects', 'objects', 'OBJECT_DATA'], ['Scenes', 'scenes', 'SCENE_DATA'], ['Texts', 'texts', 'TEXT'], ['Textures', 'textures', 'TEXTURE'], ['Worlds', 'worlds', 'WORLD']];
      if (mode === 'LIBRARIES') rows.push({ key: 'file', depth: 0, icon: 'FILE_BLEND', label: doc.filename || 'untitled.blend', kind: 'misc', hasChildren: true });
      for (const [label, coll, ic] of colls) {
        const items = coll === 'scenes' ? doc.scenes.map((s) => ({ id: s.id, name: s.name })) : Object.values(doc[coll] as Record<string, { id: string; name: string }>);
        const list = mode === 'ORPHAN_DATA' ? items.filter((it) => coll !== 'scenes' && coll !== 'texts' && dataUsers(doc, coll as never, it.id) === 0) : items;
        if (!list.length) continue;
        const key = `coll:${coll}`;
        rows.push({ key, depth: mode === 'LIBRARIES' ? 1 : 0, icon: ic, label: `${label}`, kind: 'group', hasChildren: true });
        if (all || this.expanded[key]) for (const it of list) rows.push({ key: `${coll}:${it.id}`, depth: mode === 'LIBRARIES' ? 2 : 1, icon: ic, label: mode === 'ORPHAN_DATA' ? `${it.name}` : it.name, kind: 'misc', hasChildren: false });
      }
      return rows;
    }
    const scenes = mode === 'ALL_SCENES' ? doc.scenes : [app.scene];
    for (const sc of scenes) {
      const skey = `sc:${sc.id}`;
      const flat = mode === 'SELECTED' || mode === 'ACTIVE' || mode === 'VISIBLE_LAYERS';
      if (!flat) {
        rows.push({
          key: skey, depth: 0, icon: 'SCENE_DATA', label: sc.name, kind: 'scene', hasChildren: true,
          onClick: () => { if (doc.activeScene !== sc.id) { doc.activeScene = sc.id; app.mode = 'OBJECT'; app.editObject = null; app.tagAllGeometry(); app.pushUndo('Change Scene'); } },
          rename: (n) => { sc.name = n; },
        });
        if (!(all || this.expanded[skey] !== false)) continue;
        rows.push({ key: `rl:${sc.id}`, depth: 1, icon: 'RENDERLAYERS', label: 'RenderLayers', kind: 'renderlayers', hasChildren: false });
        if (sc.world && doc.worlds[sc.world]) rows.push({ key: `wo:${sc.id}`, depth: 1, icon: 'WORLD', label: doc.worlds[sc.world].name, kind: 'world', hasChildren: false, rename: (n) => renameData(doc, 'worlds', sc.world!, n) });
      }
      let obs = sceneObjects(doc, sc);
      if (mode === 'VISIBLE_LAYERS') obs = obs.filter((o) => o.layers.some((l, i) => l && sc.layers[i]));
      if (mode === 'SELECTED') obs = obs.filter((o) => o.select);
      if (mode === 'ACTIVE') obs = obs.filter((o) => o.id === sc.activeObject);
      const ids = new Set(obs.map((o) => o.id));
      const roots = obs.filter((o) => flat || !o.parent || !ids.has(o.parent)).sort((a, b) => a.name.localeCompare(b.name));
      for (const ob of roots) this.objectRows(ob, flat ? 0 : 1, rows, all, flat ? [] : obs);
    }
    const f = String(this.state.filter ?? '').toLowerCase();
    if (f) return rows.filter((r) => r.label.toLowerCase().includes(f) || r.kind === 'scene');
    return rows;
  }

  // ---------------------------------------------------------------- render

  override refresh(_flags: Set<string>): void {
    if (this.renaming) return;
    const rows = this.buildRows();
    const key = JSON.stringify(rows.map((r) => [r.key, r.label, r.depth, r.hasChildren, r.dim, r.ob?.select, r.ob?.hide, r.ob?.hideSelect, r.ob?.hideRender, this.expanded[r.key]])) + app.scene.activeObject + app.mode;
    if (key === this.lastKey) return;
    this.lastKey = key;
    const scroll = this.list.scrollTop;
    clear(this.list);
    rows.forEach((r, i) => this.list.append(this.rowEl(r, i)));
    this.list.scrollTop = scroll;
  }

  private selectOb(ob: BObject, extend: boolean): void {
    if (app.mode === 'EDIT' && app.editObject !== ob.id) { app.mode = 'OBJECT'; app.editObject = null; app.tagAllGeometry(); }
    if (!extend) app.deselectAll();
    if (extend && ob.select && app.activeObject === ob) ob.select = false;
    else { ob.select = !ob.hideSelect; app.activeObject = ob; }
    app.pushUndo('Select');
    app.notify('select', 'all');
  }

  private rowEl(r: Row, i: number): HTMLElement {
    const ob = r.ob;
    const isActive = r.kind === 'object' && ob && app.scene.activeObject === ob.id;
    const sel = r.kind === 'object' && ob?.select;
    const row = h('div', { class: 'ui-list-row', style: { color: '#e6e6e6', height: '20px', borderRadius: '0', background: sel ? 'rgba(130,130,130,0.45)' : i % 2 ? 'rgba(255,255,255,0.025)' : 'transparent', paddingLeft: `${4 + r.depth * 18}px` } });
    const tri = h('div', { style: { width: '12px', flex: '0 0 12px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' } });
    if (r.hasChildren) {
      const open = r.kind === 'scene' ? this.expanded[r.key] !== false : !!this.expanded[r.key];
      tri.append(icon(open ? 'DISCLOSURE_TRI_DOWN' : 'DISCLOSURE_TRI_RIGHT'));
      tri.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        if (e.shiftKey) {
          // Shift: expand/collapse recursively
          const all = this.buildRows(true).filter((x) => x.key === r.key || x.key.includes(r.ob?.id ?? '\u0000'));
          for (const x of all) this.expanded[x.key] = !open;
        }
        this.expanded[r.key] = !open;
        this.lastKey = '';
        this.refresh(new Set(['all']));
      });
    }
    const name = h('div', { class: 'name', style: { color: isActive ? '#ffffff' : r.dim ? '#888' : '#e6e6e6', fontWeight: isActive ? 'bold' : 'normal' } }, r.label);
    row.append(tri, icon(r.icon), name);
    if (r.kind === 'object' && ob) {
      const toggles = h('div', { style: { display: 'flex', gap: '2px', flex: '0 0 auto' } });
      const mk = (field: 'hide' | 'hideSelect' | 'hideRender', on: string, off: string, tip: string) => {
        const b = h('div', { class: 'icon-btn', title: tip, style: { width: '18px', height: '18px' } }, icon(ob[field] ? off : on));
        b.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          e.preventDefault();
          const v = !ob[field];
          const targets = e.ctrlKey ? [ob, ...this.descendants(ob)] : [ob];
          for (const t of targets) { t[field] = v; if (field === 'hide' && v) t.select = false; }
          app.pushUndo('Toggle Visibility');
          app.notify('scene');
        });
        return b;
      };
      toggles.append(mk('hide', 'RESTRICT_VIEW_OFF', 'RESTRICT_VIEW_ON', 'Restrict viewport visibility (Ctrl to recurse)'),
        mk('hideSelect', 'RESTRICT_SELECT_OFF', 'RESTRICT_SELECT_ON', 'Restrict viewport selection (Ctrl to recurse)'),
        mk('hideRender', 'RESTRICT_RENDER_OFF', 'RESTRICT_RENDER_ON', 'Restrict rendering (Ctrl to recurse)'));
      row.append(toggles);
      // drag & drop parenting
      row.draggable = true;
      row.addEventListener('dragstart', (e) => { e.dataTransfer?.setData('text/x-blender-object', ob.id); });
      row.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('text/x-blender-object')) { e.preventDefault(); row.style.outline = '1px solid #5680c2'; } });
      row.addEventListener('dragleave', () => { row.style.outline = ''; });
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.style.outline = '';
        const id = e.dataTransfer?.getData('text/x-blender-object');
        const child = id ? app.doc.objects[id] : null;
        if (!child || child === ob) return;
        setParentKeepTransform(app.doc, child, ob, app.matrices);
        app.pushUndo('Drop to Set Parent');
        app.report('INFO', `Set parent of ${child.name} to ${ob.name}`);
        app.notify('all');
      });
    }
    if (r.kind === 'scene') {
      row.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('text/x-blender-object')) e.preventDefault(); });
      row.addEventListener('drop', (e) => {
        const id = e.dataTransfer?.getData('text/x-blender-object');
        const child = id ? app.doc.objects[id] : null;
        if (!child?.parent) return;
        setParentKeepTransform(app.doc, child, null, app.matrices);
        app.pushUndo('Drop to Clear Parent');
        app.notify('all');
      });
    }
    row.addEventListener('pointerdown', (e) => {
      if (e.button === 0) {
        if (r.onClick) r.onClick(e);
        else if (ob) this.selectOb(ob, e.ctrlKey || e.shiftKey);
      } else if (e.button === 2) {
        e.preventDefault();
        this.contextMenu(r, e);
      }
    });
    row.addEventListener('dblclick', () => { if (r.rename) this.startRename(row, name, r); });
    return row;
  }

  private descendants(ob: BObject): BObject[] {
    const out: BObject[] = [];
    const walk = (p: BObject) => { for (const c of app.objects()) if (c.parent === p.id) { out.push(c); walk(c); } };
    walk(ob);
    return out;
  }

  private startRename(row: HTMLElement, name: HTMLElement, r: Row): void {
    this.renaming = true;
    const input = h('input', { class: 'menu-search', value: r.label, spellcheck: 'false', style: { margin: '0', height: '18px', flex: '1 1 auto' } }) as HTMLInputElement;
    name.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      this.renaming = false;
      if (ok && input.value.trim() && input.value !== r.label) { r.rename?.(input.value.trim()); app.pushUndo('Rename'); }
      this.lastKey = '';
      app.notify('all');
    };
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('pointerdown', (e) => e.stopPropagation());
    void row;
  }

  private contextMenu(r: Row, e: PointerEvent): void {
    const ob = r.ob;
    const items: MenuItem[] = [];
    if (r.kind === 'object' && ob) {
      if (!ob.select) this.selectOb(ob, false);
      items.push(
        { label: 'Select', action: () => this.selectOb(ob, true) },
        { label: 'Select Hierarchy', action: () => { for (const d of [ob, ...this.descendants(ob)]) d.select = true; app.pushUndo('Select Hierarchy'); app.notify('select'); } },
        { label: 'Deselect', action: () => { ob.select = false; app.pushUndo('Deselect'); app.notify('select'); } },
        { type: 'separator' },
        { label: 'Delete', action: () => void app.callOperator('object.delete', {}, { exec: true }) },
        { label: 'Delete Hierarchy', action: () => { for (const d of this.descendants(ob)) d.select = true; ob.select = true; void app.callOperator('object.delete', {}, { exec: true }); } },
        { type: 'separator' },
        { label: 'Rename', action: () => { const rowEl = (e.target as HTMLElement).closest('.ui-list-row') as HTMLElement; const nm = rowEl?.querySelector('.name') as HTMLElement; if (rowEl && nm) this.startRename(rowEl, nm, r); } },
        { label: 'Toggle Visible', action: () => { ob.hide = !ob.hide; app.pushUndo('Toggle Visible'); app.notify('scene'); } },
        { label: 'Toggle Selectable', action: () => { ob.hideSelect = !ob.hideSelect; app.pushUndo('Toggle Selectable'); app.notify('scene'); } },
        { label: 'Toggle Renderable', action: () => { ob.hideRender = !ob.hideRender; app.pushUndo('Toggle Renderable'); app.notify('scene'); } },
      );
    } else if (r.kind === 'scene') {
      items.push({ label: 'Delete', op: 'scene.delete' });
    } else if (r.kind === 'modifier' && ob) {
      const name = r.label;
      items.push({ label: 'Toggle Viewport Use', action: () => { const m = ob.modifiers.find((x) => x.name === name); if (m) { m.showViewport = !m.showViewport; app.pushUndo('Toggle'); app.notify('data'); } } },
        { label: 'Delete', action: () => { app.activeObject = ob; void app.callOperator('object.modifier_remove', { modifier: name }, { exec: true }); } });
    } else return;
    showMenu(items, { x: e.clientX, y: e.clientY }, { title: r.kind === 'object' ? 'Object' : undefined, area: this.area });
  }

  override onKey(e: KeyboardEvent): boolean {
    const k = e.key.toLowerCase();
    if ((k === 'x' || e.key === 'Delete') && !e.ctrlKey && app.mode === 'OBJECT' && app.selectedObjects().length) { void app.callOperator('object.delete', {}, { exec: true }); return true; }
    if (k === 'a' && !e.ctrlKey && !e.altKey) { void app.callOperator(app.mode === 'EDIT' ? 'mesh.select_all' : 'object.select_all', { action: 'TOGGLE' }); return true; }
    if (k === 'h' && !e.ctrlKey) { void app.callOperator(e.altKey ? 'object.hide_view_clear' : 'object.hide_view_set', { unselected: e.shiftKey }); return true; }
    if (e.code === 'NumpadAdd' || e.code === 'NumpadSubtract') { this.expandAll(); return true; }
    if (e.code === 'NumpadDecimal' || e.key === '.') { this.showActive(); return true; }
    if (e.key === 'F2' || (k === 'r' && e.ctrlKey)) return false;
    return false;
  }
}

registerEditor({ type: Outliner.TYPE, label: 'Outliner', icon: 'OOPS', create: (area, state) => new Outliner(area, state) });
