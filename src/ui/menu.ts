// Popup menus (header pulldowns, context menus, submenus, search menu) and tooltips.

import { h, clear } from './dom';
import { icon } from './icons';
import { app, type AreaLike, type OpProps } from '../app';

export type MenuItem =
  | {
    type?: 'item';
    label: string;
    icon?: string;
    shortcut?: string;
    op?: string;
    props?: OpProps;
    action?: () => void;
    disabled?: boolean | (() => boolean);
    checked?: boolean;
    radio?: boolean;
    description?: string;
  }
  | { type: 'submenu'; label: string; icon?: string; items: MenuItem[] | (() => MenuItem[]); disabled?: boolean; description?: string }
  | { type: 'separator' }
  | { type: 'label'; label: string; icon?: string }
  | { type: 'columns'; columns: { title?: string; items: MenuItem[] }[] };

export interface MenuOptions {
  title?: string;
  titleIcon?: string;
  /** Area the menu was opened from (passed as operator context). */
  area?: AreaLike | null;
  /** Open upwards from the anchor (menus in bottom headers). */
  up?: boolean;
  /** Position the menu so that the mouse is over the first item (context menus). */
  atMouse?: boolean;
  /** Called when the menu closes (for any reason). */
  onClose?: () => void;
  /** Parent menu (for submenus). */
  parent?: OpenMenu;
  /** Minimum width. */
  minWidth?: number;
}

type ShortcutResolver = (op: string, props?: OpProps) => string | undefined;
let shortcutResolver: ShortcutResolver = () => undefined;
export function setShortcutResolver(fn: ShortcutResolver): void { shortcutResolver = fn; }
export function shortcutFor(op: string, props?: OpProps): string | undefined { return shortcutResolver(op, props); }

let layer: HTMLElement | null = null;
export function popupLayer(): HTMLElement {
  if (!layer) {
    layer = h('div', { class: 'popup-layer' });
    document.body.appendChild(layer);
  }
  return layer;
}

export interface OpenMenu {
  el: HTMLElement;
  close(all?: boolean): void;
  child: OpenMenu | null;
  parent: OpenMenu | null;
  closed: boolean;
}

const openMenus: OpenMenu[] = [];

export function menusOpen(): boolean { return openMenus.length > 0; }

export function closeAllMenus(): void {
  for (const m of openMenus.slice().reverse()) m.close();
}

function isDisabled(it: MenuItem): boolean {
  if (it.type === 'separator' || it.type === 'label' || it.type === 'columns') return true;
  const d = (it as { disabled?: boolean | (() => boolean) }).disabled;
  if (typeof d === 'function') return d();
  if (d) return true;
  if ((it.type === undefined || it.type === 'item') && it.op && !it.action) {
    return !app.pollOperator(it.op, null);
  }
  return false;
}

/** Show a popup menu at the given anchor. */
export function showMenu(items: MenuItem[], anchor: { x: number; y: number } | DOMRect, opts: MenuOptions = {}): OpenMenu {
  if (!opts.parent) closeAllMenus();
  hideTooltip();
  const el = h('div', { class: 'menu' });
  if (opts.minWidth) el.style.minWidth = `${opts.minWidth}px`;
  const menu: OpenMenu = {
    el, child: null, parent: opts.parent ?? null, closed: false,
    close(all = false) {
      if (menu.closed) return;
      menu.closed = true;
      menu.child?.close();
      el.remove();
      const i = openMenus.indexOf(menu);
      if (i >= 0) openMenus.splice(i, 1);
      if (!openMenus.length) document.removeEventListener('pointerdown', outside, true);
      opts.onClose?.();
      if (all && menu.parent) menu.parent.close(true);
    },
  };
  if (opts.parent) opts.parent.child = menu;
  if (opts.title) el.append(h('div', { class: 'menu-title' }, opts.titleIcon ? icon(opts.titleIcon) : null, opts.title));

  const rows: { el: HTMLElement; item: MenuItem }[] = [];
  const openedAt = performance.now();
  let hi = -1;
  let subTimer = 0;

  const setHi = (i: number) => {
    if (hi >= 0 && rows[hi]) rows[hi].el.classList.remove('hi');
    hi = i;
    if (hi >= 0 && rows[hi]) {
      rows[hi].el.classList.add('hi');
      rows[hi].el.scrollIntoView({ block: 'nearest' });
    }
  };

  const activate = (i: number) => {
    const row = rows[i];
    if (!row) return;
    const it = row.item;
    if (isDisabled(it)) return;
    if (it.type === 'submenu') { openSub(i); return; }
    if (it.type === 'item' || it.type === undefined) {
      menu.close(true);
      if (it.action) it.action();
      else if (it.op) void app.callOperator(it.op, it.props ?? {}, { area: opts.area ?? null });
    }
  };

  const openSub = (i: number) => {
    const row = rows[i];
    if (!row || row.item.type !== 'submenu') return;
    if (menu.child && !menu.child.closed && (menu.child as OpenMenu & { srcIndex?: number }).srcIndex === i) return;
    menu.child?.close();
    const sub = row.item.items;
    const list = typeof sub === 'function' ? sub() : sub;
    const r = row.el.getBoundingClientRect();
    const child = showMenu(list, new DOMRect(r.right - 2, r.top - 4, 0, 0), { area: opts.area, parent: menu });
    (child as OpenMenu & { srcIndex?: number }).srcIndex = i;
  };

  const addItems = (container: HTMLElement, list: MenuItem[]) => {
    for (const it of list) {
      if (it.type === 'separator') { container.append(h('div', { class: 'menu-sep' })); continue; }
      if (it.type === 'label') { container.append(h('div', { class: 'menu-title' }, it.icon ? icon(it.icon) : null, it.label)); continue; }
      if (it.type === 'columns') {
        const cols = h('div', { class: 'menu-columns' });
        for (const col of it.columns) {
          const c = h('div', { class: 'menu-column' });
          if (col.title) c.append(h('div', { class: 'menu-column-title' }, col.title));
          addItems(c, col.items);
          cols.append(c);
        }
        container.append(cols);
        continue;
      }
      const disabled = isDisabled(it);
      const isSub = it.type === 'submenu';
      let sc = '';
      if (!isSub && (it.type === undefined || it.type === 'item')) sc = it.shortcut ?? (it.op ? shortcutFor(it.op, it.props) ?? '' : '');
      const row = h('div', { class: `menu-item${disabled ? ' disabled' : ''}${!isSub && (it as { checked?: boolean }).checked ? ' checked' : ''}` },
        h('span', { class: 'icon-slot' }, it.icon ? icon(it.icon) : null),
        h('span', { class: 'mlabel' }, it.label),
        sc ? h('span', { class: 'shortcut' }, sc) : null,
        isSub ? h('span', { class: 'sub-arrow' }) : null,
      );
      const index = rows.length;
      rows.push({ el: row, item: it });
      row.addEventListener('pointerenter', () => {
        setHi(index);
        window.clearTimeout(subTimer);
        if (isSub && !disabled) subTimer = window.setTimeout(() => openSub(index), 150);
        else if (menu.child) subTimer = window.setTimeout(() => menu.child?.close(), 250);
      });
      row.addEventListener('pointerup', (e) => {
        // ignore the release of the click that opened a context menu
        if (opts.atMouse && performance.now() - openedAt < 250) return;
        if (e.button === 0 || e.button === 2) activate(index);
      });
      const desc = (it as { description?: string }).description;
      const opId = (it as { op?: string }).op;
      if (desc || opId) attachTooltip(row, () => {
        const def = opId ? app.operator(opId) : undefined;
        return { title: it.label, description: desc ?? def?.description, python: opId ? `bpy.ops.${opId}()` : undefined, shortcut: sc || undefined };
      });
      container.append(row);
    }
  };
  addItems(el, items);

  popupLayer().append(el);
  openMenus.push(menu);

  // positioning
  const rect = el.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  let x: number, y: number;
  if (anchor instanceof DOMRect) {
    x = anchor.left;
    y = opts.up ? anchor.top - rect.height : anchor.bottom;
    if (opts.parent) { x = anchor.left; y = anchor.top; if (x + rect.width > vw) x = (opts.parent.el.getBoundingClientRect().left - rect.width + 2); }
    if (!opts.up && y + rect.height > vh) y = anchor.top - rect.height;
    if (opts.up && y < 0) y = anchor.bottom;
  } else {
    x = anchor.x - 30;
    y = anchor.y - 12;
    if (opts.atMouse) {
      const first = rows.findIndex((r) => !isDisabled(r.item));
      if (first >= 0) {
        const fr = rows[first].el.getBoundingClientRect();
        y = anchor.y - (fr.top - rect.top) - 10;
        x = anchor.x - 40;
      }
    }
  }
  x = Math.max(2, Math.min(x, vw - rect.width - 2));
  y = Math.max(2, Math.min(y, vh - rect.height - 2));
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;

  el.addEventListener('contextmenu', (e) => e.preventDefault());
  el.addEventListener('pointerdown', (e) => e.stopPropagation());

  (menu as OpenMenu & { key?: (e: KeyboardEvent) => boolean }).key = (e: KeyboardEvent) => {
    const selectable = rows.map((r, i) => (isDisabled(r.item) ? -1 : i)).filter((i) => i >= 0);
    if (e.key === 'ArrowDown') {
      const n = selectable.find((i) => i > hi) ?? selectable[0];
      if (n !== undefined) setHi(n);
      return true;
    }
    if (e.key === 'ArrowUp') {
      const prev = selectable.filter((i) => i < hi);
      const n = prev.length ? prev[prev.length - 1] : selectable[selectable.length - 1];
      if (n !== undefined) setHi(n);
      return true;
    }
    if (e.key === 'ArrowRight') { if (hi >= 0 && rows[hi].item.type === 'submenu') { openSub(hi); } return true; }
    if (e.key === 'ArrowLeft') { if (menu.parent) menu.close(); return true; }
    if (e.key === 'Enter' || e.key === ' ') { if (hi >= 0) activate(hi); return true; }
    if (e.key === 'Escape') { menu.close(true); return true; }
    // number keys pick items (Blender supports 1..9 in menus)
    if (/^[1-9]$/.test(e.key) && !e.ctrlKey && !e.altKey) {
      const idx = selectable[parseInt(e.key, 10) - 1];
      if (idx !== undefined) activate(idx);
      return true;
    }
    return true;
  };

  if (openMenus.length === 1) document.addEventListener('pointerdown', outside, true);
  return menu;
}

function outside(e: PointerEvent) {
  const t = e.target as Node;
  if (openMenus.some((m) => m.el.contains(t))) return;
  if ((t as HTMLElement).closest?.('.pulldown.open')) return;
  closeAllMenus();
  // swallow the click that closed the menu (like Blender)
  e.stopPropagation();
  e.preventDefault();
}

/** Route a key event to the top-most open menu. Returns true if handled. */
export function menuKeyDown(e: KeyboardEvent): boolean {
  const top = openMenus[openMenus.length - 1] as (OpenMenu & { key?: (e: KeyboardEvent) => boolean }) | undefined;
  if (!top) return false;
  return top.key ? top.key(e) : false;
}

// ------------------------------------------------------------------ header pulldowns

export interface PulldownDef {
  label: string;
  items: () => MenuItem[];
}

/** Create a header pulldown ("File", "View", ...). Hovering a sibling while open switches menus. */
export function pulldown(def: PulldownDef, getArea: () => AreaLike | null, up = false): HTMLElement {
  const el = h('div', { class: 'pulldown' }, def.label);
  const open = () => {
    const r = el.getBoundingClientRect();
    el.classList.add('open');
    (el as HTMLElement & { menuOpen?: boolean }).menuOpen = true;
    showMenu(def.items(), r, {
      area: getArea(), up, minWidth: 0,
      onClose: () => { el.classList.remove('open'); (el as HTMLElement & { menuOpen?: boolean }).menuOpen = false; },
    });
  };
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if ((el as HTMLElement & { menuOpen?: boolean }).menuOpen) { closeAllMenus(); return; }
    open();
  });
  el.addEventListener('pointerenter', () => {
    const header = el.parentElement;
    const other = header?.querySelector('.pulldown.open');
    if (other && other !== el) open();
  });
  return el;
}

// ------------------------------------------------------------------ search menu

export interface SearchEntry { label: string; detail?: string; icon?: string; action: () => void; }

export function showSearchMenu(entries: () => SearchEntry[], at: { x: number; y: number }, placeholder = ''): void {
  closeAllMenus();
  const el = h('div', { class: 'menu', style: { width: '380px' } });
  const input = h('input', { class: 'menu-search', placeholder, spellcheck: 'false' }) as HTMLInputElement;
  const list = h('div', { style: { maxHeight: '320px', overflowY: 'auto' } });
  el.append(input, list);
  const menu: OpenMenu = {
    el, child: null, parent: null, closed: false,
    close() {
      if (menu.closed) return;
      menu.closed = true;
      el.remove();
      const i = openMenus.indexOf(menu);
      if (i >= 0) openMenus.splice(i, 1);
      if (!openMenus.length) document.removeEventListener('pointerdown', outside, true);
    },
  };
  let hi = 0;
  let shown: SearchEntry[] = [];
  const render = () => {
    clear(list);
    const q = input.value.trim().toLowerCase();
    const words = q.split(/\s+/).filter(Boolean);
    shown = entries().filter((e) => words.every((w) => `${e.label} ${e.detail ?? ''}`.toLowerCase().includes(w))).slice(0, 200);
    hi = Math.min(hi, Math.max(0, shown.length - 1));
    shown.forEach((e, i) => {
      const row = h('div', { class: `menu-item${i === hi ? ' hi' : ''}` },
        h('span', { class: 'icon-slot' }, e.icon ? icon(e.icon) : null),
        h('span', { class: 'mlabel' }, e.label),
        e.detail ? h('span', { class: 'shortcut' }, e.detail) : null);
      row.addEventListener('pointerenter', () => { hi = i; list.querySelectorAll('.menu-item').forEach((n, k) => n.classList.toggle('hi', k === i)); });
      row.addEventListener('pointerup', () => { menu.close(); e.action(); });
      list.append(row);
    });
  };
  input.addEventListener('input', () => { hi = 0; render(); });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'ArrowDown') { hi = Math.min(shown.length - 1, hi + 1); render(); list.children[hi]?.scrollIntoView({ block: 'nearest' }); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { hi = Math.max(0, hi - 1); render(); list.children[hi]?.scrollIntoView({ block: 'nearest' }); e.preventDefault(); }
    else if (e.key === 'Enter') { const s = shown[hi]; menu.close(); s?.action(); }
    else if (e.key === 'Escape') menu.close();
  });
  el.addEventListener('pointerdown', (e) => e.stopPropagation());
  popupLayer().append(el);
  openMenus.push(menu);
  if (openMenus.length === 1) document.addEventListener('pointerdown', outside, true);
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.max(2, Math.min(at.x - 190, window.innerWidth - r.width - 2))}px`;
  el.style.top = `${Math.max(2, Math.min(at.y - 12, window.innerHeight - 360))}px`;
  render();
  input.focus();
}

// ------------------------------------------------------------------ tooltips

export interface TooltipInfo { title: string; description?: string; python?: string; shortcut?: string; extra?: string }

let ttEl: HTMLElement | null = null;
let ttTimer = 0;

export function hideTooltip(): void {
  window.clearTimeout(ttTimer);
  ttEl?.remove();
  ttEl = null;
}

export function attachTooltip(el: HTMLElement, info: () => TooltipInfo | null): void {
  el.addEventListener('pointerenter', (e) => {
    if (e.buttons) return;
    window.clearTimeout(ttTimer);
    if (!app?.prefs.showTooltips) return;
    ttTimer = window.setTimeout(() => {
      if (!el.isConnected) return;
      const i = info();
      if (!i) return;
      showTooltip(i, el.getBoundingClientRect());
    }, 550);
  });
  el.addEventListener('pointerleave', hideTooltip);
  el.addEventListener('pointerdown', hideTooltip);
}

export function showTooltip(i: TooltipInfo, r: DOMRect): void {
  hideTooltip();
  const el = h('div', { class: 'tooltip' },
    h('div', { class: 'tt-title' }, i.description ? `${i.title}: ${i.description}` : i.title),
    i.shortcut ? h('div', { class: 'tt-shortcut' }, `Shortcut: ${i.shortcut}`) : null,
    i.extra ? h('div', { class: 'tt-desc' }, i.extra) : null,
    i.python && app.prefs.showTooltipsPython ? h('div', { class: 'tt-python' }, `Python: ${i.python}`) : null,
  );
  document.body.append(el);
  const tr = el.getBoundingClientRect();
  let x = r.left + Math.min(20, r.width / 2);
  let y = r.bottom + 6;
  if (y + tr.height > window.innerHeight) y = r.top - tr.height - 6;
  x = Math.max(2, Math.min(x, window.innerWidth - tr.width - 4));
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  ttEl = el;
}
