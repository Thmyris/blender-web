// Blender-like UI layout engine (mirrors bpy.types.UILayout): rows, columns,
// splits, boxes and property widgets that read/write live data through getters.

import { h, clear, trackDrag, clamp } from './dom';
import { icon } from './icons';
import { attachTooltip, showMenu, shortcutFor, type MenuItem, hideTooltip } from './menu';
import { formatValue, editString, evalExpression, colorToCss, type UnitType } from './format';
import { showColorPicker } from './colorpicker';
import { app, type AreaLike, type OpProps } from '../app';

export type KeyState = 'NONE' | 'ANIMATED' | 'KEYED';

interface PropCommon {
  name?: string;
  description?: string;
  python?: string;
  disabled?: () => boolean;
  /** Undo step name pushed after a change; false disables undo. */
  undo?: string | false;
  keyState?: () => KeyState;
  keyframe?: (action: 'insert' | 'delete' | 'clear') => void;
  /** Called after each value change (before notify). */
  onChange?: () => void;
  /** Notification flags sent after a change (default: 'data'). */
  notify?: string[];
}

export interface FloatProp extends PropCommon {
  kind: 'float';
  get(): number;
  set(v: number): void;
  min?: number; max?: number; softMin?: number; softMax?: number;
  step?: number; precision?: number; unit?: UnitType; default?: number;
}
export interface IntProp extends PropCommon {
  kind: 'int';
  get(): number;
  set(v: number): void;
  min?: number; max?: number; softMin?: number; softMax?: number; step?: number; default?: number; unit?: UnitType;
}
export interface BoolProp extends PropCommon { kind: 'bool'; get(): boolean; set(v: boolean): void; default?: boolean; }
export interface EnumItem { id: string; label: string; icon?: string; description?: string; disabled?: boolean }
export interface EnumProp extends PropCommon {
  kind: 'enum';
  get(): string;
  set(v: string): void;
  items: (EnumItem | null)[] | (() => (EnumItem | null)[]);
  default?: string;
}
export interface StringProp extends PropCommon { kind: 'string'; get(): string; set(v: string): void; default?: string; }
export interface ColorProp extends PropCommon { kind: 'color'; get(): number[]; set(v: number[]): void; alpha?: boolean; default?: number[]; }

export type Prop = FloatProp | IntProp | BoolProp | EnumProp | StringProp | ColorProp;

export interface PropOpts {
  text?: string;
  icon?: string;
  iconOn?: string;
  slider?: boolean;
  expand?: boolean;
  toggle?: boolean;
  iconOnly?: boolean;
  emboss?: boolean;
  /** For enums shown as dropdowns: hide the "Name:" label. */
  noLabel?: boolean;
  cls?: string;
}

// ------------------------------------------------------------------ binding helpers

type AnyRec = Record<string, unknown>;

/** Bind a property to `target()[key]` (or `target()[key][index]`), resolved live every time. */
export function bind<T>(target: () => unknown, key: string, index?: number): { get(): T; set(v: T): void } {
  return {
    get() {
      const t = target() as AnyRec | null | undefined;
      if (!t) return undefined as unknown as T;
      const v = t[key];
      return (index !== undefined ? (v as unknown[])[index] : v) as T;
    },
    set(v: T) {
      const t = target() as AnyRec | null | undefined;
      if (!t) return;
      if (index !== undefined) (t[key] as unknown[])[index] = v;
      else t[key] = v;
    },
  };
}

export function fprop(target: () => unknown, key: string, o: Partial<FloatProp> = {}, index?: number): FloatProp {
  return { kind: 'float', ...bind<number>(target, key, index), ...o } as FloatProp;
}
export function iprop(target: () => unknown, key: string, o: Partial<IntProp> = {}, index?: number): IntProp {
  return { kind: 'int', ...bind<number>(target, key, index), ...o } as IntProp;
}
export function bprop(target: () => unknown, key: string, o: Partial<BoolProp> = {}, index?: number): BoolProp {
  return { kind: 'bool', ...bind<boolean>(target, key, index), ...o } as BoolProp;
}
export function eprop(target: () => unknown, key: string, items: EnumProp['items'], o: Partial<EnumProp> = {}): EnumProp {
  return { kind: 'enum', ...bind<string>(target, key), items, ...o } as EnumProp;
}
export function sprop(target: () => unknown, key: string, o: Partial<StringProp> = {}): StringProp {
  return { kind: 'string', ...bind<string>(target, key), ...o } as StringProp;
}
export function cprop(target: () => unknown, key: string, o: Partial<ColorProp> = {}): ColorProp {
  return {
    kind: 'color',
    get: () => { const t = target() as AnyRec | null; return ((t?.[key] as number[]) ?? [0, 0, 0]).slice(); },
    set: (v: number[]) => { const t = target() as AnyRec | null; if (t) t[key] = v.slice(); },
    ...o,
  } as ColorProp;
}

function changed(p: Prop): void {
  p.onChange?.();
  app.notify(...(p.notify ?? ['data']));
}

function commit(p: Prop, label?: string): void {
  if (p.undo === false) return;
  app.pushUndo(p.undo ?? `Change ${label ?? p.name ?? 'Property'}`);
  app.notify('data');
}

function enumItems(p: EnumProp): (EnumItem | null)[] {
  return typeof p.items === 'function' ? p.items() : p.items;
}

// ------------------------------------------------------------------ hover state (hotkeys over widgets)

export interface HoverTarget {
  hotkey(e: KeyboardEvent): boolean;
}

export let hoveredWidget: HoverTarget | null = null;

function setHover(el: HTMLElement, w: HoverTarget) {
  el.addEventListener('pointerenter', () => { hoveredWidget = w; });
  el.addEventListener('pointerleave', () => { if (hoveredWidget === w) hoveredWidget = null; });
}

/** Drag-toggle: pressing a checkbox and dragging over others sets them to the same value. */
let dragToggle: { value: boolean; props: Set<BoolProp>; first: BoolProp } | null = null;
window.addEventListener('pointerup', () => {
  if (!dragToggle) return;
  const dt = dragToggle;
  dragToggle = null;
  commit(dt.first, dt.first.name);
});

// ------------------------------------------------------------------ root

export interface Updatable { update(): void; }

export class LayoutRoot {
  widgets: Updatable[] = [];
  area: AreaLike | null;
  numWidgets: NumWidget[] = [];
  constructor(area: AreaLike | null = null) { this.area = area; }
  update(): void { for (const w of this.widgets) w.update(); }
}

// ------------------------------------------------------------------ widgets

function applyKeyState(el: HTMLElement, p: PropCommon) {
  if (!p.keyState) return;
  const s = p.keyState();
  el.classList.toggle('anim', s === 'ANIMATED');
  el.classList.toggle('keyed', s === 'KEYED');
}

function tooltipFor(el: HTMLElement, p: PropCommon, label?: string) {
  attachTooltip(el, () => ({ title: label || p.name || '', description: p.description, python: p.python }));
}

function commonHotkeys(e: KeyboardEvent, p: Prop, label?: string): boolean {
  const key = e.key.toLowerCase();
  if (key === 'i' && !e.ctrlKey && p.keyframe) {
    if (e.altKey && e.shiftKey) p.keyframe('clear');
    else if (e.altKey) p.keyframe('delete');
    else p.keyframe('insert');
    app.notify('data', 'frame');
    return true;
  }
  if ((e.ctrlKey || e.metaKey) && key === 'c') {
    app.valueClipboard = JSON.parse(JSON.stringify(p.get()));
    return true;
  }
  if ((e.ctrlKey || e.metaKey) && key === 'v') {
    const v = app.valueClipboard;
    if (v === null || v === undefined || (p.disabled && p.disabled())) return true;
    if ((p.kind === 'float' || p.kind === 'int') && typeof v === 'number') (p as FloatProp).set(v);
    else if (p.kind === 'bool' && typeof v === 'boolean') p.set(v);
    else if (p.kind === 'color' && Array.isArray(v)) p.set(v as number[]);
    else if (p.kind === 'string' && typeof v === 'string') p.set(v);
    else if (p.kind === 'enum' && typeof v === 'string') p.set(v);
    else return true;
    changed(p);
    commit(p, label);
    return true;
  }
  if (e.key === 'Backspace' && !e.ctrlKey) {
    if (p.default === undefined || (p.disabled && p.disabled())) return true;
    (p as { set(v: unknown): void }).set(JSON.parse(JSON.stringify(p.default)));
    changed(p);
    commit(p, label);
    return true;
  }
  return false;
}

export class NumWidget implements Updatable, HoverTarget {
  el: HTMLElement;
  private text: HTMLElement;
  private fill: HTMLElement | null = null;
  private editing: HTMLInputElement | null = null;
  constructor(private p: FloatProp | IntProp, private label: string, private slider: boolean, private root: LayoutRoot) {
    this.text = h('div', { class: 'w-text' });
    this.el = h('div', { class: `w ${slider ? 'w-slider' : 'w-num'}` });
    if (slider) { this.fill = h('div', { class: 'fill' }); this.el.append(this.fill); }
    else this.el.append(h('div', { class: 'arrow l' }), h('div', { class: 'arrow r' }));
    this.el.append(this.text);
    this.el.addEventListener('pointerdown', (e) => this.onDown(e));
    this.el.addEventListener('dblclick', () => this.startEdit());
    this.el.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
      this.stepBy(e.deltaY < 0 ? 1 : -1);
      commit(this.p, this.label);
    }, { passive: false });
    setHover(this.el, this);
    tooltipFor(this.el, p, label);
    root.numWidgets.push(this);
    this.update();
  }

  private get isInt() { return this.p.kind === 'int'; }
  private get step() { return this.p.step ?? (this.isInt ? 1 : 0.1); }
  private get unit(): UnitType { return this.p.unit ?? 'NONE'; }

  private clampV(v: number): number {
    const p = this.p;
    if (p.min !== undefined) v = Math.max(p.min, v);
    if (p.max !== undefined) v = Math.min(p.max, v);
    return this.isInt ? Math.round(v) : v;
  }

  update(): void {
    if (this.editing) return;
    const v = Number(this.p.get() ?? 0);
    const prec = this.p.kind === 'float' ? this.p.precision ?? 3 : 0;
    const vs = formatValue(v, this.unit, prec, this.isInt);
    this.text.textContent = this.label ? `${this.label}: ${vs}` : vs;
    if (this.fill) {
      const lo = this.p.softMin ?? this.p.min ?? 0, hi = this.p.softMax ?? this.p.max ?? 1;
      this.fill.style.width = `${clamp((v - lo) / (hi - lo || 1), 0, 1) * 100}%`;
    }
    this.el.classList.toggle('disabled', !!this.p.disabled?.());
    applyKeyState(this.el, this.p);
  }

  private stepBy(dir: number) {
    const v = Number(this.p.get() ?? 0);
    this.p.set(this.clampV(v + dir * this.step));
    changed(this.p);
    this.update();
  }

  private perPixel(): number {
    const p = this.p;
    const lo = p.softMin ?? p.min, hi = p.softMax ?? p.max;
    if (lo !== undefined && hi !== undefined && isFinite(lo) && isFinite(hi) && (this.slider || hi - lo <= 1000)) {
      const w = this.slider ? Math.max(60, this.el.clientWidth) : 300;
      return (hi - lo) / w;
    }
    return this.isInt ? this.step / 4 : this.step / 10;
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0 || this.editing) return;
    e.preventDefault();
    const start = Number(this.p.get() ?? 0);
    let acc = start;
    let lastX = e.clientX;
    const rect = this.el.getBoundingClientRect();
    const px = this.perPixel();
    trackDrag(e, (ev) => {
      this.el.classList.add('dragging');
      const dx = ev.clientX - lastX;
      lastX = ev.clientX;
      acc += dx * px * (ev.shiftKey ? 0.1 : 1);
      let v = acc;
      if (ev.ctrlKey) {
        const snap = this.isInt ? Math.max(1, this.step) : (this.unit === 'ROTATION' ? (5 * Math.PI) / 180 : this.step);
        v = Math.round(v / snap) * snap;
      }
      this.p.set(this.clampV(v));
      changed(this.p);
      this.update();
    }, (ev, moved) => {
      this.el.classList.remove('dragging');
      if (moved) { commit(this.p, this.label); return; }
      // click: arrows step, centre edits
      const x = ev.clientX - rect.left;
      if (!this.slider && x < 12) { this.stepBy(-1); commit(this.p, this.label); }
      else if (!this.slider && x > rect.width - 12) { this.stepBy(1); commit(this.p, this.label); }
      else this.startEdit();
    }, { cursor: 'ew-resize', threshold: 3 });
  }

  startEdit(): void {
    if (this.editing || this.p.disabled?.()) return;
    hideTooltip();
    const input = h('input', { class: 'w-edit', spellcheck: 'false' }) as HTMLInputElement;
    input.value = editString(Number(this.p.get() ?? 0), this.unit, this.isInt);
    this.editing = input;
    this.el.append(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (ok: boolean, next = 0) => {
      if (done) return;
      done = true;
      if (ok) {
        try {
          const v = this.clampV(evalExpression(input.value, this.unit));
          this.p.set(v);
          changed(this.p);
          commit(this.p, this.label);
        } catch (err) {
          app.report('ERROR', `Invalid value: ${(err as Error).message}`);
        }
      }
      input.remove();
      this.editing = null;
      this.update();
      if (next) {
        const list = this.root.numWidgets.filter((w) => w.el.isConnected);
        const i = list.indexOf(this);
        const n = list[(i + next + list.length) % list.length];
        if (n && n !== this) n.startEdit();
      }
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
      else if (e.key === 'Tab') { e.preventDefault(); finish(true, e.shiftKey ? -1 : 1); }
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  hotkey(e: KeyboardEvent): boolean {
    if (e.key === 'Enter') { this.startEdit(); return true; }
    if (e.key === '-' && e.ctrlKey) {
      this.p.set(this.clampV(-Number(this.p.get())));
      changed(this.p);
      commit(this.p, this.label);
      return true;
    }
    return commonHotkeys(e, this.p, this.label);
  }
}

class CheckWidget implements Updatable, HoverTarget {
  el: HTMLElement;
  constructor(private p: BoolProp, label: string) {
    this.el = h('div', { class: 'checkbox-widget' }, h('div', { class: 'box' }), label ? h('div', { class: 'ctext' }, label) : null);
    this.el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const v = !this.p.get();
      this.p.set(v);
      changed(this.p);
      dragToggle = { value: v, props: new Set([this.p]), first: this.p };
      this.update();
    });
    this.el.addEventListener('pointerenter', (e) => {
      if (dragToggle && e.buttons & 1 && !dragToggle.props.has(this.p)) {
        dragToggle.props.add(this.p);
        this.p.set(dragToggle.value);
        changed(this.p);
        this.update();
      }
    });
    setHover(this.el, this);
    tooltipFor(this.el, p, label);
    this.update();
  }
  update(): void {
    this.el.classList.toggle('on', !!this.p.get());
    this.el.classList.toggle('disabled', !!this.p.disabled?.());
    applyKeyState(this.el, this.p);
  }
  hotkey(e: KeyboardEvent): boolean { return commonHotkeys(e, this.p); }
}

class ToggleWidget implements Updatable, HoverTarget {
  el: HTMLElement;
  constructor(private p: BoolProp, label: string, private ic: string | undefined, private iconOn: string | undefined, private iconOnly: boolean, emboss: boolean) {
    if (iconOnly) {
      this.el = h('div', { class: `icon-btn${emboss ? ' emboss' : ''}` });
    } else {
      this.el = h('div', { class: 'w w-toggle' }, ic ? icon(ic) : null, h('div', { class: 'w-text center' }, label));
    }
    this.el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const v = !this.p.get();
      this.p.set(v);
      changed(this.p);
      dragToggle = { value: v, props: new Set([this.p]), first: this.p };
      this.update();
    });
    this.el.addEventListener('pointerenter', (e) => {
      if (dragToggle && e.buttons & 1 && !dragToggle.props.has(this.p)) {
        dragToggle.props.add(this.p);
        this.p.set(dragToggle.value);
        changed(this.p);
        this.update();
      }
    });
    setHover(this.el, this);
    tooltipFor(this.el, p, label);
    this.update();
  }
  update(): void {
    const on = !!this.p.get();
    this.el.classList.toggle('on', on);
    this.el.classList.toggle('disabled', !!this.p.disabled?.());
    if (this.iconOnly) {
      const name = on && this.iconOn ? this.iconOn : this.ic;
      if (this.el.dataset.icon !== name) {
        this.el.dataset.icon = name ?? '';
        clear(this.el);
        this.el.append(icon(name));
      }
    }
    applyKeyState(this.el, this.p);
  }
  hotkey(e: KeyboardEvent): boolean { return commonHotkeys(e, this.p); }
}

class EnumMenuWidget implements Updatable, HoverTarget {
  el: HTMLElement;
  private text: HTMLElement;
  private ic: HTMLElement;
  constructor(private p: EnumProp, private root: LayoutRoot, private iconOnly: boolean, emboss: boolean, private fixedIcon?: string, private fixedText?: string) {
    this.text = h('div', { class: 'w-text' });
    this.ic = h('span', { class: 'icon' });
    this.el = h('div', { class: `w w-menu${iconOnly ? ' icon-only' : ''}${emboss ? '' : ' no-emboss'}` }, this.ic, this.text, h('div', { class: 'updown' }));
    this.el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      this.open();
    });
    this.el.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
      const items = enumItems(this.p).filter((x): x is EnumItem => !!x && !x.disabled);
      const i = items.findIndex((x) => x.id === this.p.get());
      const n = items[clamp(i + (e.deltaY > 0 ? 1 : -1), 0, items.length - 1)];
      if (n && n.id !== this.p.get()) { this.p.set(n.id); changed(this.p); commit(this.p); this.update(); }
    }, { passive: false });
    setHover(this.el, this);
    tooltipFor(this.el, p);
    this.update();
  }
  open(): void {
    const cur = this.p.get();
    const items: MenuItem[] = enumItems(this.p).map((it) => it === null ? { type: 'separator' } as MenuItem : ({
      label: it.label, icon: it.icon, checked: it.id === cur, disabled: it.disabled, description: it.description,
      action: () => { this.p.set(it.id); changed(this.p); commit(this.p); this.update(); },
    }));
    const r = this.el.getBoundingClientRect();
    const up = r.top > window.innerHeight * 0.6;
    showMenu(items, r, { title: this.p.name, area: this.root.area, up, minWidth: r.width });
  }
  update(): void {
    const cur = this.p.get();
    const it = enumItems(this.p).find((x) => x && x.id === cur) ?? null;
    this.text.textContent = this.fixedText ?? it?.label ?? '';
    const ic = this.fixedIcon ?? it?.icon ?? '';
    if (this.ic.dataset.icon !== ic) {
      this.ic.dataset.icon = ic;
      this.ic.innerHTML = ic ? icon(ic).innerHTML : '';
      this.ic.style.display = ic ? '' : 'none';
    }
    this.el.classList.toggle('disabled', !!this.p.disabled?.());
  }
  hotkey(e: KeyboardEvent): boolean { return commonHotkeys(e, this.p); }
}

class RadioWidget implements Updatable {
  el: HTMLElement;
  constructor(private p: EnumProp, private item: EnumItem, iconOnly: boolean, text?: string) {
    this.el = h('div', { class: `w w-radio${iconOnly ? ' icon-only' : ''}` },
      item.icon ? icon(item.icon) : null,
      iconOnly ? null : h('div', { class: 'w-text' }, text ?? item.label));
    this.el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      if (this.p.get() === this.item.id) return;
      this.p.set(this.item.id);
      changed(this.p);
      commit(this.p);
    });
    attachTooltip(this.el, () => ({ title: item.label, description: item.description ?? p.description, python: p.python }));
    this.update();
  }
  update(): void {
    this.el.classList.toggle('on', this.p.get() === this.item.id);
    this.el.classList.toggle('disabled', !!this.p.disabled?.() || !!this.item.disabled);
  }
}

class TextWidget implements Updatable, HoverTarget {
  el: HTMLElement;
  private text: HTMLElement;
  private editing = false;
  constructor(private p: StringProp, private label: string, ic?: string) {
    this.text = h('div', { class: 'w-text' });
    this.el = h('div', { class: 'w w-textfield' }, ic ? icon(ic) : null, this.text);
    this.el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      this.startEdit();
    });
    setHover(this.el, this);
    tooltipFor(this.el, p, label);
    this.update();
  }
  startEdit(): void {
    if (this.editing || this.p.disabled?.()) return;
    this.editing = true;
    hideTooltip();
    const input = h('input', { class: 'w-edit', spellcheck: 'false' }) as HTMLInputElement;
    input.value = this.p.get() ?? '';
    this.el.append(input);
    setTimeout(() => { input.focus(); input.select(); }, 0);
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      if (ok && input.value !== this.p.get()) { this.p.set(input.value); changed(this.p); commit(this.p, this.label); }
      input.remove();
      this.editing = false;
      this.update();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('pointerdown', (e) => e.stopPropagation());
  }
  update(): void {
    if (this.editing) return;
    const v = this.p.get() ?? '';
    this.text.textContent = this.label ? `${this.label}: ${v}` : v;
    this.el.classList.toggle('disabled', !!this.p.disabled?.());
  }
  hotkey(e: KeyboardEvent): boolean {
    if (e.key === 'Enter') { this.startEdit(); return true; }
    return commonHotkeys(e, this.p, this.label);
  }
}

class ColorWidget implements Updatable, HoverTarget {
  el: HTMLElement;
  private sw: HTMLElement;
  private swA: HTMLElement | null = null;
  constructor(private p: ColorProp) {
    this.sw = h('div', { class: 'swatch' });
    this.el = h('div', { class: 'w w-color' }, this.sw);
    if (p.alpha) {
      this.swA = h('div', {});
      this.el.append(h('div', { class: 'swatch alpha' }, this.swA));
    }
    this.el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      showColorPicker(this.el.getBoundingClientRect(), {
        get: () => this.p.get(),
        set: (v) => { this.p.set(v); changed(this.p); this.update(); },
        onDone: (ch) => { if (ch) commit(this.p); this.update(); },
        alpha: this.p.alpha,
      });
    });
    setHover(this.el, this);
    tooltipFor(this.el, p);
    this.update();
  }
  update(): void {
    const c = this.p.get();
    this.sw.style.background = colorToCss(c);
    if (this.swA) this.swA.style.background = colorToCss(c, c[3] ?? 1);
    this.el.classList.toggle('disabled', !!this.p.disabled?.());
  }
  hotkey(e: KeyboardEvent): boolean { return commonHotkeys(e, this.p); }
}

// ------------------------------------------------------------------ layout

export interface IdTemplateOpts {
  /** Items to browse. */
  items: () => { id: string; name: string; icon?: string }[];
  get: () => string | null;
  set: (id: string | null) => void;
  name?: () => string;
  rename?: (name: string) => void;
  users?: () => number;
  fakeUser?: { get(): boolean; set(v: boolean): void };
  onNew?: () => void;
  newLabel?: string;
  unlink?: () => void;
  icon: string;
  title?: string;
}

export interface UIListOpts {
  items: () => { label: string; icon?: string; extra?: (row: HTMLElement) => void }[];
  active: () => number;
  setActive: (i: number) => void;
  rename?: (i: number, name: string) => void;
  rows?: number;
  side?: { icon: string; tip: string; action: () => void; disabled?: () => boolean }[];
}

export class Layout {
  active = true;
  constructor(public el: HTMLElement, public root: LayoutRoot) {}

  private child(cls: string): Layout {
    const el = h('div', { class: cls });
    this.el.append(el);
    const l = new Layout(el, this.root);
    l.active = this.active;
    return l;
  }

  row(align = false): Layout { return this.child(`layout-row${align ? ' align' : ''}`); }
  column(align = false): Layout { return this.child(`layout-col${align ? ' align' : ''}`); }
  box(): Layout { return this.child('layout-box'); }

  /** Two (or more) columns; the first takes `factor` of the width. */
  split(factor = 0.5): SplitLayout {
    const el = h('div', { class: 'layout-split' });
    this.el.append(el);
    return new SplitLayout(el, this.root, factor);
  }

  separator(): void { this.el.append(h('div', { class: 'layout-sep' })); }

  label(text: string, opts: { icon?: string; align?: 'left' | 'center' | 'right'; disabled?: boolean; fixed?: boolean } = {}): HTMLElement {
    const el = h('div', { class: `label${opts.align === 'right' ? ' right' : opts.align === 'center' ? ' center' : ''}${opts.disabled || !this.active ? ' disabled' : ''}${opts.fixed ? ' fixed' : ''}` },
      opts.icon ? icon(opts.icon) : null, text ? h('span', {}, text) : null);
    this.el.append(el);
    return el;
  }

  /** A label whose text is recomputed on every refresh. */
  dynLabel(text: () => string, opts: { icon?: string; align?: 'left' | 'center' | 'right' } = {}): HTMLElement {
    const span = h('span', {});
    const el = h('div', { class: `label${opts.align === 'right' ? ' right' : opts.align === 'center' ? ' center' : ''}` }, opts.icon ? icon(opts.icon) : null, span);
    const upd = { update: () => { span.textContent = text(); } };
    upd.update();
    this.root.widgets.push(upd);
    this.el.append(el);
    return el;
  }

  custom(el: HTMLElement, update?: () => void): HTMLElement {
    this.el.append(el);
    if (update) { this.root.widgets.push({ update }); update(); }
    return el;
  }

  prop(p: Prop, opts: PropOpts = {}): HTMLElement {
    const label = opts.text !== undefined ? opts.text : p.name ?? '';
    if (!this.active) {
      const orig = p.disabled;
      p = { ...p, disabled: () => true } as Prop;
      void orig;
    }
    let w: Updatable & { el: HTMLElement };
    switch (p.kind) {
      case 'float':
      case 'int':
        w = new NumWidget(p, label, !!opts.slider, this.root);
        break;
      case 'bool':
        w = opts.toggle || opts.iconOnly ? new ToggleWidget(p, label, opts.icon, opts.iconOn, !!opts.iconOnly, opts.emboss !== false) : new CheckWidget(p, label);
        break;
      case 'enum': {
        if (opts.expand) {
          const row = this.row(true);
          for (const it of enumItems(p)) {
            if (!it) continue;
            const rw = new RadioWidget(p, it, !!opts.iconOnly);
            row.el.append(rw.el);
            this.root.widgets.push(rw);
          }
          return row.el;
        }
        const mw = new EnumMenuWidget(p, this.root, !!opts.iconOnly, opts.emboss !== false, opts.icon, undefined);
        this.root.widgets.push(mw);
        if (label && !opts.noLabel && !opts.iconOnly) {
          const row = this.row();
          row.label(`${label}:`);
          row.el.append(mw.el);
          return row.el;
        }
        this.el.append(mw.el);
        return mw.el;
      }
      case 'string':
        w = new TextWidget(p, label, opts.icon);
        break;
      case 'color': {
        w = new ColorWidget(p);
        if (label && opts.text !== '') {
          const row = this.row();
          row.label(`${label}:`);
          row.el.append(w.el);
          this.root.widgets.push(w);
          return row.el;
        }
        break;
      }
    }
    if (opts.cls) w.el.classList.add(...opts.cls.split(' '));
    this.root.widgets.push(w);
    this.el.append(w.el);
    return w.el;
  }

  /** Vector property shown as a label and an aligned column of X/Y/Z fields. */
  vector(label: string, props: Prop[], names = ['X', 'Y', 'Z'], opts: PropOpts = {}): Layout {
    const col = this.column(true);
    if (label) col.label(`${label}:`);
    props.forEach((p, i) => col.prop(p, { ...opts, text: names[i] }));
    return col;
  }

  operator(op: string, opts: { text?: string; icon?: string; props?: OpProps; emboss?: boolean; iconOnly?: boolean; depress?: () => boolean; align?: 'left' | 'center' } = {}): HTMLElement {
    const def = app.operator(op);
    const text = opts.text ?? def?.label ?? op;
    let el: HTMLElement;
    if (opts.iconOnly || opts.emboss === false) {
      el = h('div', { class: `icon-btn${opts.emboss === false ? '' : ' emboss'}` }, icon(opts.icon ?? def?.icon));
      if (!opts.iconOnly && text) { el.className = 'w w-button'; el.append(h('div', { class: 'w-text' }, text)); }
    } else {
      el = h('div', { class: `w w-button${opts.align === 'left' ? ' left' : ''}` }, opts.icon ? icon(opts.icon) : null, text ? h('div', { class: 'w-text' }, text) : null);
    }
    const root = this.root;
    el.addEventListener('pointerdown', (e) => { if (e.button === 0) e.preventDefault(); });
    el.addEventListener('click', (e) => {
      if (el.classList.contains('disabled')) return;
      void app.callOperator(op, opts.props ?? {}, { area: root.area, event: e });
    });
    attachTooltip(el, () => ({ title: text || def?.label || op, description: def?.description, python: `bpy.ops.${op}()`, shortcut: shortcutFor(op, opts.props) }));
    const upd = {
      update: () => {
        const ok = this.active && app.pollOperator(op, root.area);
        el.classList.toggle('disabled', !ok);
        if (opts.depress) el.classList.toggle('pressed', opts.depress());
      },
    };
    upd.update();
    this.root.widgets.push(upd);
    this.el.append(el);
    return el;
  }

  /** Plain button with a callback. */
  button(text: string, onClick: (e: MouseEvent) => void, opts: { icon?: string; tip?: string; disabled?: () => boolean; depress?: () => boolean; iconOnly?: boolean } = {}): HTMLElement {
    const el = opts.iconOnly
      ? h('div', { class: 'icon-btn emboss' }, icon(opts.icon))
      : h('div', { class: 'w w-button' }, opts.icon ? icon(opts.icon) : null, text ? h('div', { class: 'w-text' }, text) : null);
    el.addEventListener('pointerdown', (e) => { if (e.button === 0) e.preventDefault(); });
    el.addEventListener('click', (e) => { if (!el.classList.contains('disabled')) onClick(e); });
    if (opts.tip) attachTooltip(el, () => ({ title: opts.tip! }));
    const upd = {
      update: () => {
        el.classList.toggle('disabled', !this.active || !!opts.disabled?.());
        if (opts.depress) el.classList.toggle('pressed', opts.depress());
      },
    };
    upd.update();
    this.root.widgets.push(upd);
    this.el.append(el);
    return el;
  }

  /** Dropdown button that opens a menu (e.g. "Add Modifier"). */
  menu(text: string, items: () => MenuItem[], opts: { icon?: string; title?: string; iconOnly?: boolean; emboss?: boolean } = {}): HTMLElement {
    const el = h('div', { class: `w w-menu${opts.iconOnly ? ' icon-only' : ''}${opts.emboss === false ? ' no-emboss' : ''}` }, opts.icon ? icon(opts.icon) : null, h('div', { class: 'w-text' }, text), h('div', { class: 'updown' }));
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const r = el.getBoundingClientRect();
      showMenu(items(), r, { title: opts.title, area: this.root.area, up: r.top > window.innerHeight * 0.6, minWidth: r.width });
    });
    this.el.append(el);
    return el;
  }

  /** Datablock selector: [browse][name][users][F][+][X] */
  idTemplate(o: IdTemplateOpts): HTMLElement {
    const wrap = h('div', { class: 'id-template' });
    this.el.append(wrap);
    const build = () => {
      clear(wrap);
      const cur = o.get();
      const browse = h('div', { class: 'w w-menu browse' }, icon(o.icon), h('div', { class: 'updown' }));
      browse.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const items = o.items();
        const r = browse.getBoundingClientRect();
        showMenu(items.length ? items.map((it) => ({ label: it.name, icon: it.icon ?? o.icon, checked: it.id === cur, action: () => { o.set(it.id); app.pushUndo('Browse'); app.notify('all'); } })) : [{ type: 'label', label: 'Nothing to browse' }],
          r, { title: o.title, area: this.root.area, up: r.top > window.innerHeight * 0.6 });
      });
      attachTooltip(browse, () => ({ title: `Browse ${o.title ?? 'ID'} to be linked` }));
      wrap.append(browse);
      if (cur) {
        const nameW = new TextWidget({
          kind: 'string', get: () => o.name?.() ?? '', set: (v) => o.rename?.(v), undo: 'Rename', notify: ['all'],
        }, '');
        wrap.append(nameW.el);
        this.root.widgets.push(nameW);
        const users = o.users?.() ?? 1;
        if (users > 1) {
          const u = h('div', { class: 'w users' }, h('div', { class: 'w-text' }, String(users)));
          attachTooltip(u, () => ({ title: 'Display number of users of this data (click to make a single-user copy)' }));
          wrap.append(u);
        }
        if (o.fakeUser) {
          const fu = o.fakeUser;
          const t = new ToggleWidget({ kind: 'bool', get: () => fu.get(), set: (v) => fu.set(v), name: 'Fake User', description: 'Save this data-block even if it has no users', notify: ['all'] }, '', 'FAKE_USER_OFF', 'FAKE_USER_ON', true, true);
          t.el.className = 'w w-toggle small';
          t.update();
          wrap.append(t.el);
          this.root.widgets.push(t);
        }
        if (o.onNew) {
          const n = h('div', { class: 'w w-button small' }, icon('ZOOMIN'));
          n.addEventListener('click', () => { o.onNew!(); app.pushUndo('New'); app.notify('all'); });
          attachTooltip(n, () => ({ title: 'Add a new data-block (copy of the current one)' }));
          wrap.append(n);
        }
        if (o.unlink) {
          const x = h('div', { class: 'w w-button small' }, icon('X'));
          x.addEventListener('click', () => { o.unlink!(); app.pushUndo('Unlink'); app.notify('all'); });
          attachTooltip(x, () => ({ title: 'Unlink data-block (Shift + Click to set users to zero)' }));
          wrap.append(x);
        }
      } else if (o.onNew) {
        const n = h('div', { class: 'w w-button new' }, icon('ZOOMIN'), h('div', { class: 'w-text' }, o.newLabel ?? 'New'));
        n.style.flex = '1 1 auto';
        n.addEventListener('click', () => { o.onNew!(); app.pushUndo('New'); app.notify('all'); });
        wrap.append(n);
      }
    };
    build();
    let last = JSON.stringify([o.get(), o.users?.()]);
    this.root.widgets.push({
      update: () => {
        const k = JSON.stringify([o.get(), o.users?.()]);
        if (k !== last) { last = k; build(); }
      },
    });
    return wrap;
  }

  /** UIList with optional side buttons (+, -, ...). */
  list(o: UIListOpts): HTMLElement {
    const wrap = h('div', { class: 'ui-list-wrap' });
    const list = h('div', { class: 'ui-list' });
    list.style.height = `${(o.rows ?? 5) * 20 + 6}px`;
    wrap.append(list);
    if (o.side?.length) {
      const side = h('div', { class: 'ui-list-side' });
      for (const b of o.side) {
        const el = h('div', { class: 'w w-button' }, icon(b.icon));
        el.style.justifyContent = 'center';
        el.addEventListener('click', () => { if (!b.disabled?.()) b.action(); });
        attachTooltip(el, () => ({ title: b.tip }));
        side.append(el);
        this.root.widgets.push({ update: () => el.classList.toggle('disabled', !!b.disabled?.()) });
      }
      wrap.append(side);
    }
    let lastKey = '';
    const render = () => {
      const items = o.items();
      const key = JSON.stringify([items.map((i) => [i.label, i.icon]), o.active()]);
      if (key === lastKey) return;
      lastKey = key;
      clear(list);
      items.forEach((it, i) => {
        const row = h('div', { class: `ui-list-row${i === o.active() ? ' active' : ''}` }, it.icon ? icon(it.icon) : null, h('div', { class: 'name' }, it.label));
        it.extra?.(row);
        row.addEventListener('pointerdown', (e) => { if (e.button === 0) { o.setActive(i); app.notify('all'); } });
        if (o.rename) {
          row.addEventListener('dblclick', () => {
            const input = h('input', { class: 'w-edit', style: { position: 'relative', height: '18px' } }) as HTMLInputElement;
            input.value = it.label;
            const name = row.querySelector('.name') as HTMLElement;
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
          });
        }
        list.append(row);
      });
    };
    render();
    this.root.widgets.push({ update: render });
    this.el.append(wrap);
    return wrap;
  }

  /** 20-layer grid (two groups of 2x5 per half). */
  layers(get: () => boolean[], set: (layers: boolean[], toggleIndex: number, extend: boolean) => void, opts: { used?: () => boolean[]; activeOb?: () => boolean[]; big?: boolean } = {}): HTMLElement {
    const el = h('div', { class: `layers${opts.big ? ' big' : ''}` });
    const cells: HTMLElement[] = [];
    // Blender layout: top row = layers 1-5 | 6-10, bottom row = 11-15 | 16-20
    const group = (start: number) => {
      const g = h('div', { class: 'group' });
      for (let r = 0; r < 2; r++) for (let c = 0; c < 5; c++) {
        const idx = start + c + r * 10;
        const cell = h('div', { class: 'layer' });
        cell.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const cur = get().slice();
          let next: boolean[];
          if (e.shiftKey) { next = cur.slice(); next[idx] = !next[idx]; if (!next.some(Boolean)) next[idx] = true; }
          else { next = cur.map(() => false); next[idx] = true; }
          set(next, idx, e.shiftKey);
          upd();
        });
        attachTooltip(cell, () => ({ title: `Layer ${idx + 1}`, description: 'Shift-click to toggle multiple layers' }));
        cells[idx] = cell;
        g.append(cell);
      }
      return g;
    };
    el.append(group(0), group(5));
    const upd = () => {
      const l = get() ?? [];
      const used = opts.used?.() ?? [];
      const ob = opts.activeOb?.() ?? [];
      cells.forEach((c, i) => {
        c.classList.toggle('on', !!l[i]);
        c.classList.toggle('used', !!used[i]);
        c.classList.toggle('active-ob', !!ob[i]);
      });
    };
    upd();
    this.root.widgets.push({ update: upd });
    this.el.append(el);
    return el;
  }
}

export class SplitLayout extends Layout {
  private count = 0;
  constructor(el: HTMLElement, root: LayoutRoot, private factor: number) { super(el, root); }
  override column(align = false): Layout {
    const el = h('div', { class: `layout-col${align ? ' align' : ''}` });
    if (this.count === 0) el.style.flex = `0 0 calc(${this.factor * 100}% - 3px)`;
    else el.style.flex = '1 1 0';
    this.count++;
    this.el.append(el);
    const l = new Layout(el, this.root);
    l.active = this.active;
    return l;
  }
  override row(align = false): Layout {
    const el = h('div', { class: `layout-row${align ? ' align' : ''}` });
    if (this.count === 0) el.style.flex = `0 0 calc(${this.factor * 100}% - 3px)`;
    else el.style.flex = '1 1 0';
    this.count++;
    this.el.append(el);
    const l = new Layout(el, this.root);
    l.active = this.active;
    return l;
  }
}

// ------------------------------------------------------------------ panels

export interface PanelDef {
  id: string;
  label: string | (() => string);
  poll?: () => boolean;
  draw: (layout: Layout) => void;
  drawHeader?: (layout: Layout) => void;
  defaultClosed?: boolean;
  /** Extra string folded into the region's structure key (rebuild when it changes). */
  key?: () => string;
  /** Panel without header (always open). */
  noHeader?: boolean;
}

const panelState = new Map<string, boolean>();

/** A scrollable region that hosts panels and rebuilds when its structure changes. */
export class PanelRegion {
  el: HTMLElement;
  private scroll: HTMLElement;
  private root: LayoutRoot;
  private lastKey = '';
  constructor(private panels: () => PanelDef[], private area: AreaLike | null, private stateScope: string) {
    this.el = h('div', { class: 'region' });
    this.el.style.position = 'relative';
    this.el.style.flex = '1 1 auto';
    this.scroll = h('div', { class: 'region-scroll' });
    this.el.append(this.scroll);
    this.root = new LayoutRoot(area);
  }

  private structureKey(): string {
    return this.panels().filter((p) => !p.poll || p.poll()).map((p) => `${p.id}:${p.key?.() ?? ''}:${panelState.get(this.stateScope + p.id) ?? ''}`).join('|');
  }

  refresh(force = false): void {
    const key = this.structureKey();
    if (!force && key === this.lastKey) { this.root.update(); return; }
    this.lastKey = key;
    const scrollTop = this.scroll.scrollTop;
    clear(this.scroll);
    this.root = new LayoutRoot(this.area);
    const container = h('div', { class: 'panels' });
    this.scroll.append(container);
    for (const p of this.panels()) {
      if (p.poll && !p.poll()) continue;
      const stateKey = this.stateScope + p.id;
      const closed = panelState.get(stateKey) ?? !!p.defaultClosed;
      const panel = h('div', { class: `panel${closed ? ' closed' : ''}` });
      if (!p.noHeader) {
        const header = h('div', { class: 'panel-header' }, h('div', { class: 'tri' }));
        if (p.drawHeader) {
          const hl = new Layout(h('div', { class: 'layout-row' }), this.root);
          hl.el.style.flex = '0 0 auto';
          p.drawHeader(hl);
          header.append(hl.el);
          hl.el.addEventListener('pointerdown', (e) => e.stopPropagation());
        }
        const title = typeof p.label === 'function' ? p.label() : p.label;
        header.append(h('div', { class: 'title' }, title), h('div', { class: 'grip' }));
        header.addEventListener('pointerdown', (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          if (e.ctrlKey) {
            // Ctrl+click: open this panel, collapse all others
            for (const o of this.panels()) panelState.set(this.stateScope + o.id, o.id !== p.id);
          } else {
            panelState.set(stateKey, !closed);
          }
          this.refresh(true);
        });
        panel.append(header);
      }
      const body = h('div', { class: 'panel-body' });
      panel.append(body);
      if (!closed || p.noHeader) {
        try { p.draw(new Layout(body, this.root)); } catch (err) { console.error(`panel ${p.id}`, err); body.append(h('div', { class: 'label' }, `Error: ${(err as Error).message}`)); }
      }
      container.append(panel);
    }
    this.scroll.scrollTop = scrollTop;
  }
}

/** Build a one-off layout into an element (headers, popups). */
export function buildLayout(el: HTMLElement, area: AreaLike | null, draw: (l: Layout) => void): LayoutRoot {
  const root = new LayoutRoot(area);
  draw(new Layout(el, root));
  return root;
}
