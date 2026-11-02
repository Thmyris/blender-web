// Shared helpers for the Properties editor: live data getters (always tolerant of
// a missing object / datablock, e.g. right after undo or deleting the active
// object), "not available" widgets, Blender-style `layout.active` emulation and
// a small UI list that can show a checkbox per row.

import { app } from '../../app';
import { dataUsers } from '../../core/scene';
import type { Area } from '../../screen/screen';
import type {
  BObject, CameraData, DataCollection, LampData, MaterialData, MeshData, Scene, TextureData, TextureSlot, WorldData,
} from '../../core/types';
import type {
  BoolProp, ColorProp, EnumItem, EnumProp, FloatProp, IntProp, Layout, StringProp,
} from '../../ui/layout';
import { h, clear } from '../../ui/dom';
import { icon } from '../../ui/icons';
import { attachTooltip, showMenu, type MenuItem } from '../../ui/menu';
import type { UnitType } from '../../ui/format';

/** Context handed to every panel builder. */
export interface PropsCtx {
  area: Area;
  state: Record<string, unknown>;
}

export const NA = 'Not available in blender-web';

// ------------------------------------------------------------------ live getters

export const scene = (): Scene => app.scene;
export const rd = () => app.scene.render;
export const ob = (): BObject | null => app.activeObject;
export const meshData = (): MeshData | null => app.meshOf(app.activeObject);

export function cameraData(): CameraData | null {
  const o = app.activeObject;
  return o && o.type === 'CAMERA' && o.data ? app.doc.cameras[o.data] ?? null : null;
}

export function lampData(): LampData | null {
  const o = app.activeObject;
  return o && o.type === 'LAMP' && o.data ? app.doc.lamps[o.data] ?? null : null;
}

export function worldData(): WorldData | null {
  const id = app.scene.world;
  return id ? app.doc.worlds[id] ?? null : null;
}

/** Index of the active material slot, clamped to the slot count (-1 when there are none). */
export function activeSlotIndex(): number {
  const o = ob();
  const md = meshData();
  if (!o || !md || !md.materials.length) return -1;
  return Math.max(0, Math.min(o.activeMaterialIndex, md.materials.length - 1));
}

export function activeMaterial(): MaterialData | null {
  const md = meshData();
  const i = activeSlotIndex();
  if (!md || i < 0) return null;
  const id = md.materials[i];
  return id ? app.doc.materials[id] ?? null : null;
}

export function activeTextureSlot(): TextureSlot | null {
  const ma = activeMaterial();
  if (!ma) return null;
  return ma.textureSlots[ma.activeTextureIndex] ?? null;
}

export function activeTexture(): TextureData | null {
  const s = activeTextureSlot();
  return s && s.texture ? app.doc.textures[s.texture] ?? null : null;
}

/** Live getter for element `i` of an array field (safe when the field is missing). */
export function arrItem(target: () => unknown, key: string, i: number, o: Partial<FloatProp> = {}): FloatProp {
  return {
    kind: 'float',
    get: () => {
      const t = target() as Record<string, unknown> | null;
      const a = t?.[key];
      return Array.isArray(a) ? Number(a[i] ?? 0) : 0;
    },
    set: (v: number) => {
      const t = target() as Record<string, unknown> | null;
      if (!t) return;
      if (!Array.isArray(t[key])) t[key] = [0, 0, 0];
      (t[key] as number[])[i] = v;
    },
    ...o,
  } as FloatProp;
}

/**
 * Integer percentage bound to `target()[key]` (int props are formatted without units, so
 * this is a float field with 0 decimals that rounds on write to show "50%").
 */
export function pctProp(target: () => unknown, key: string, o: Partial<FloatProp> = {}): FloatProp {
  return {
    kind: 'float', unit: 'PERCENTAGE', precision: 0, step: 1,
    get: () => Number((target() as Record<string, unknown> | null)?.[key] ?? 0),
    set: (v: number) => { const t = target() as Record<string, unknown> | null; if (t) t[key] = Math.round(v); },
    ...o,
  } as FloatProp;
}

// ------------------------------------------------------------------ "not available" widgets

export function naBool(name: string, value = false, description = NA): BoolProp {
  return { kind: 'bool', name, get: () => value, set: () => {}, disabled: () => true, undo: false, description };
}

export function naFloat(name: string, value = 0, o: { unit?: UnitType; precision?: number; min?: number; max?: number } = {}): FloatProp {
  return { kind: 'float', name, get: () => value, set: () => {}, disabled: () => true, undo: false, description: NA, precision: 3, ...o };
}

export function naInt(name: string, value = 0, o: { unit?: UnitType; min?: number; max?: number } = {}): IntProp {
  return { kind: 'int', name, get: () => value, set: () => {}, disabled: () => true, undo: false, description: NA, ...o };
}

export function naEnum(name: string, items: (EnumItem | string)[], value?: string): EnumProp {
  const its = items.map((it) => (typeof it === 'string' ? { id: it, label: it } : it));
  const v = value ?? its[0]?.id ?? '';
  return { kind: 'enum', name, items: its, get: () => v, set: () => {}, disabled: () => true, undo: false, description: NA };
}

export function naString(name: string, value = ''): StringProp {
  return { kind: 'string', name, get: () => value, set: () => {}, disabled: () => true, undo: false, description: NA };
}

export function naColor(name: string, value: number[] = [0, 0, 0]): ColorProp {
  return { kind: 'color', name, get: () => value.slice(), set: () => {}, disabled: () => true, undo: false, description: NA };
}

/** A disabled button (greyed out, does nothing). */
export function naButton(l: Layout, text: string, ic?: string, iconOnly = false): HTMLElement {
  return l.button(text, () => {}, { icon: ic, tip: `${text || 'Button'}: ${NA}`, disabled: () => true, iconOnly });
}

/** Disabled pointer-ID field ("Target:" style object search field). */
export function naIdField(l: Layout, label: string, ic = 'OBJECT_DATA'): HTMLElement {
  return l.prop(naEnum(label, [{ id: '', label: '', icon: ic }], ''), label ? {} : { noLabel: true });
}

/**
 * Wrap an element in a container that shows a tooltip even though the element itself is
 * disabled (disabled widgets use `pointer-events: none`, so they get no hover events).
 */
export function naTooltip(el: HTMLElement, title: string, description = NA): HTMLElement {
  const parent = el.parentElement;
  const wrap = h('div', { style: { display: 'flex', minWidth: '0', flex: el.style.flex || '1 1 0' } });
  if (parent) parent.replaceChild(wrap, el);
  el.style.flex = '1 1 auto';
  wrap.append(el);
  attachTooltip(wrap, () => ({ title, description }));
  return wrap;
}

// ------------------------------------------------------------------ layout helpers

/**
 * Emulates Blender's `layout.active = cond`: the contents are drawn greyed out but stay
 * editable (unlike `enabled`, which disables them).
 */
export function activeWhen(l: Layout, cond: () => boolean): Layout {
  const el = l.el;
  const upd = () => { el.style.opacity = cond() ? '' : '0.55'; };
  upd();
  l.root.widgets.push({ update: upd });
  return l;
}

/** Label with a trailing colon like Blender's column labels. */
export function lab(l: Layout, text: string, disabled = false): HTMLElement {
  return l.label(text, { disabled });
}

/** "Name:" style labelled color swatch in a column: label on its own line, swatch below. */
export function colorBelow(l: Layout, label: string, p: ColorProp): void {
  const col = l.column();
  col.label(`${label}:`);
  col.prop(p, { text: '' });
}

/** Make a panel body background transparent and drop its frame (HIDE_HEADER panels). */
export function flatPanel(l: Layout): void {
  const panel = l.el.parentElement;
  if (panel) { panel.style.boxShadow = 'none'; panel.style.background = 'transparent'; }
}

/** Run an operator from a properties button with this area as context. */
export function callOp(ctx: PropsCtx, id: string, props: Record<string, unknown> = {}): void {
  void app.callOperator(id, props, { area: ctx.area });
}

/** Clone data via JSON (documents are plain JSON). */
export function cloneJSON<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }

/** Commit a direct data edit made from a button: undo step + refresh. */
export function commitEdit(name: string, ...flags: string[]): void {
  app.pushUndo(name);
  app.notify(...(flags.length ? flags : ['all']));
}

/** Items for an object pointer dropdown ('' = none). */
export function objectItems(filter: (o: BObject) => boolean = () => true): EnumItem[] {
  const items: EnumItem[] = [{ id: '', label: '', icon: 'NONE' }];
  for (const o of app.objects()) if (filter(o)) items.push({ id: o.id, label: o.name, icon: objectIconFor(o.type) });
  return items;
}

export function objectIconFor(type: string): string {
  switch (type) {
    case 'MESH': return 'OUTLINER_OB_MESH';
    case 'CAMERA': return 'OUTLINER_OB_CAMERA';
    case 'LAMP': return 'OUTLINER_OB_LAMP';
    case 'EMPTY': return 'OUTLINER_OB_EMPTY';
    default: return 'OBJECT_DATA';
  }
}

/** Number of users of a datablock (for the ID template user count). */
export function usersOf(coll: DataCollection, id: string | null | undefined): number {
  return id ? dataUsers(app.doc, coll, id) : 0;
}

/** Generic Custom Properties panel body (closed by default in Blender; adding is not supported). */
export function customPropsBody(l: Layout): void {
  naButton(l, 'Add', 'ZOOMIN');
}

// ------------------------------------------------------------------ rich list

export interface RichListItem {
  label: string;
  icon?: string;
  /** Optional checkbox on the right of the row. */
  check?: { get(): boolean; set(v: boolean): void; disabled?: boolean; tip?: string };
  /** Greyed text (e.g. empty slots). */
  dim?: boolean;
}

export interface RichListSide {
  icon: string;
  tip: string;
  action?: (e: MouseEvent) => void;
  disabled?: () => boolean;
  menu?: () => MenuItem[];
  /** Vertical gap before this button. */
  gap?: boolean;
}

/**
 * UIList replacement whose rows re-render whenever any of their content (including per-row
 * checkboxes) changes. Uses the theme's `.ui-list` classes.
 */
export function richList(l: Layout, o: {
  items: () => RichListItem[];
  active: () => number;
  setActive?: (i: number) => void;
  rows?: number;
  side?: RichListSide[];
  rename?: (i: number, name: string) => void;
}): HTMLElement {
  const wrap = h('div', { class: 'ui-list-wrap' });
  const list = h('div', { class: 'ui-list' });
  list.style.height = `${(o.rows ?? 5) * 20 + 6}px`;
  list.style.minHeight = '0';
  wrap.append(list);
  if (o.side?.length) {
    const side = h('div', { class: 'ui-list-side' });
    for (const b of o.side) {
      const el = h('div', { class: 'w w-button' }, icon(b.icon));
      el.style.justifyContent = 'center';
      el.style.flex = '0 0 auto';
      if (b.gap) el.style.marginTop = '6px';
      el.addEventListener('pointerdown', (e) => { if (e.button === 0) e.preventDefault(); });
      el.addEventListener('click', (e) => {
        if (b.disabled?.()) return;
        if (b.menu) { const r = el.getBoundingClientRect(); showMenu(b.menu(), r, {}); return; }
        b.action?.(e);
      });
      attachTooltip(el, () => ({ title: b.tip }));
      side.append(el);
      const upd = () => el.classList.toggle('disabled', !!b.disabled?.());
      upd();
      l.root.widgets.push({ update: upd });
    }
    // disabled buttons swallow pointer events, so show the tooltip on the column
    wrap.append(side);
  }
  let lastKey = '';
  const render = () => {
    const items = o.items();
    const act = o.active();
    const key = JSON.stringify([items.map((i) => [i.label, i.icon, i.dim, i.check ? [i.check.get(), !!i.check.disabled] : null]), act]);
    if (key === lastKey) return;
    lastKey = key;
    clear(list);
    items.forEach((it, i) => {
      const name = h('div', { class: 'name' }, it.label);
      if (it.dim) name.style.color = 'rgba(0,0,0,0.45)';
      const row = h('div', { class: `ui-list-row${i === act ? ' active' : ''}` }, it.icon ? icon(it.icon) : null, name);
      if (it.check) {
        const c = it.check;
        const box = h('div', { class: `checkbox-widget${c.get() ? ' on' : ''}${c.disabled ? ' disabled' : ''}` }, h('div', { class: 'box' }));
        box.style.flex = '0 0 auto';
        box.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          e.preventDefault();
          if (c.disabled) return;
          c.set(!c.get());
          commitEdit('Toggle', 'data');
        });
        if (c.tip) attachTooltip(box, () => ({ title: c.tip! }));
        row.append(box);
      }
      row.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || !o.setActive) return;
        o.setActive(i);
        app.notify('all');
      });
      if (o.rename) {
        row.addEventListener('dblclick', () => {
          const input = h('input', { class: 'w-edit', style: { position: 'relative', height: '18px', flex: '1 1 auto' } }) as HTMLInputElement;
          input.value = it.label;
          name.replaceWith(input);
          input.focus();
          input.select();
          let done = false;
          const fin = (ok: boolean) => {
            if (done) return;
            done = true;
            if (ok && input.value.trim()) { o.rename!(i, input.value.trim()); app.pushUndo('Rename'); }
            lastKey = '';
            app.notify('all');
          };
          input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') fin(true); if (e.key === 'Escape') fin(false); });
          input.addEventListener('blur', () => fin(true));
          input.addEventListener('pointerdown', (e) => e.stopPropagation());
        });
      }
      list.append(row);
    });
  };
  render();
  l.root.widgets.push({ update: render });
  l.el.append(wrap);
  return wrap;
}
