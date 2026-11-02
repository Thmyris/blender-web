// Screen layout: a binary tree of areas with draggable edges, corner action
// zones to split/join areas, maximise/fullscreen and named screen layouts.

import { h, clear, trackDrag, clamp } from '../ui/dom';
import { icon } from '../ui/icons';
import { showMenu, type MenuItem } from '../ui/menu';
import type { Layout } from '../ui/layout';
import { app, type AreaLike, type ScreenLike } from '../app';
import { editorRegistry, EDITOR_MENU, type Editor } from './editor';

let areaCounter = 0;

export class Area implements AreaLike {
  id = `area${++areaCounter}`;
  type: string;
  editor!: Editor;
  el: HTMLElement;
  /** Per editor-type persistent state (like Blender's SpaceLink list). */
  spaceData: Record<string, Record<string, unknown>> = {};
  rect = { x: 0, y: 0, w: 0, h: 0 };
  headerHidden = false;
  /** When set, this area temporarily shows another editor (e.g. render result); Esc returns. */
  tempPrevType: string | null = null;

  constructor(public screen: Screen, type: string) {
    this.type = type;
    this.el = h('div', { class: 'area' });
    this.el.dataset.area = this.id;
    const tr = h('div', { class: 'action-zone tr' });
    const bl = h('div', { class: 'action-zone bl' });
    tr.addEventListener('pointerdown', (e) => screen.startCornerDrag(this, e, 'tr'));
    bl.addEventListener('pointerdown', (e) => screen.startCornerDrag(this, e, 'bl'));
    this.el.append(tr, bl);
    this.setType(type, true);
  }

  setType(type: string, initial = false): void {
    const cls = editorRegistry.get(type) ?? editorRegistry.get('VIEW_3D');
    if (!cls) return;
    if (!initial && this.editor) {
      this.editor.destroy();
      this.editor.header.remove();
      this.editor.main.remove();
    }
    this.type = cls.type;
    const state = (this.spaceData[cls.type] ??= {});
    this.editor = cls.create(this, state);
    this.el.classList.toggle('header-bottom', (state.headerPosition as string ?? this.editor.headerPosition) === 'bottom');
    this.el.append(this.editor.header, this.editor.main);
    this.editor.header.classList.toggle('hidden', this.headerHidden);
    this.editor.header.addEventListener('contextmenu', (e) => { e.preventDefault(); this.headerContextMenu(e); });
    this.editor.rebuildHeader(true);
    if (!initial) {
      requestAnimationFrame(() => { this.editor.mount(); this.editor.resize(); this.editor.refresh(new Set(['all'])); });
    }
  }

  get headerPosition(): 'top' | 'bottom' {
    return (this.spaceData[this.type]?.headerPosition as 'top' | 'bottom') ?? this.editor.headerPosition;
  }

  headerContextMenu(e: MouseEvent): void {
    const pos = this.headerPosition;
    const items: MenuItem[] = [
      { label: pos === 'top' ? 'Flip to Bottom' : 'Flip to Top', action: () => { this.spaceData[this.type].headerPosition = pos === 'top' ? 'bottom' : 'top'; this.el.classList.toggle('header-bottom', pos === 'top'); this.screen.layout(); } },
      { label: 'Collapse Menus', disabled: true },
      { type: 'separator' },
      { label: this.screen.maximized === this ? 'Tile Area' : 'Maximize Area', shortcut: 'Ctrl Up', action: () => this.screen.toggleMaximize(this) },
      { label: this.screen.fullscreen ? 'Tile Area' : 'Toggle Fullscreen Area', shortcut: 'Alt F10', action: () => this.screen.toggleMaximize(this, true) },
      { type: 'separator' },
      { label: 'Hide Header', action: () => this.setHeaderHidden(true) },
      ...this.editor.headerMenuItems(),
    ];
    showMenu(items, { x: e.clientX, y: e.clientY }, { title: 'Header', area: this });
  }

  setHeaderHidden(v: boolean): void {
    this.headerHidden = v;
    this.editor.header.classList.toggle('hidden', v);
    if (v) {
      const show = h('div', { class: 'region-hidden-handle right', title: 'Show header', style: { top: this.headerPosition === 'top' ? '0' : 'auto', bottom: this.headerPosition === 'bottom' ? '0' : 'auto', right: '18px' } }, '+');
      show.addEventListener('click', () => { show.remove(); this.setHeaderHidden(false); });
      this.el.append(show);
    }
    this.editor.resize();
  }

  /** Editor type dropdown shown at the start of every header. */
  drawEditorTypeButton(l: Layout): void {
    const btn = h('div', { class: 'w w-menu fixed', style: { flex: '0 0 auto', width: '36px', padding: '0 2px' } },
      icon(editorRegistry.get(this.type)?.icon ?? 'VIEW3D'), h('div', { class: 'updown' }));
    btn.title = '';
    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const r = btn.getBoundingClientRect();
      const columns = EDITOR_MENU.map((g) => ({
        title: g.title,
        items: g.types.filter((t) => editorRegistry.has(t)).map((t) => {
          const cls = editorRegistry.get(t)!;
          return { label: cls.label, icon: cls.icon, checked: t === this.type, action: () => { this.tempPrevType = null; this.setType(t); this.screen.layout(); } } as MenuItem;
        }),
      }));
      showMenu([{ type: 'columns', columns }], r, { title: 'Editor Type', area: this, up: this.headerPosition === 'bottom' });
    });
    l.el.append(btn);
  }

  /** Temporarily switch to another editor (render result); `restoreTemp` switches back. */
  setTemp(type: string): void {
    if (this.type !== type) {
      const prev = this.type;
      this.setType(type);
      this.tempPrevType = prev;
      this.screen.layout();
    }
  }

  restoreTemp(): boolean {
    if (!this.tempPrevType) return false;
    const t = this.tempPrevType;
    this.tempPrevType = null;
    this.setType(t);
    this.screen.layout();
    return true;
  }
}

export type ScreenNode =
  | { kind: 'area'; area: Area }
  | { kind: 'split'; dir: 'h' | 'v'; ratio: number; fixed?: { which: 0 | 1; px: number }; a: ScreenNode; b: ScreenNode };

const GAP = 2;
const MIN = 26;

export interface LayoutTemplate {
  name: string;
  build(s: Screen): ScreenNode;
}

export class Screen implements ScreenLike {
  el: HTMLElement;
  root!: ScreenNode;
  maximized: Area | null = null;
  fullscreen = false;
  layoutName = 'Default';
  private layouts = new Map<string, ScreenNode>();
  private edgeEls: HTMLElement[] = [];

  constructor(container: HTMLElement, private templates: LayoutTemplate[]) {
    this.el = h('div', { class: 'screen' });
    container.append(this.el);
    window.addEventListener('resize', () => this.layout());
    this.setLayout('Default');
  }

  templateNames(): string[] { return this.templates.map((t) => t.name); }

  setLayout(name: string): void {
    const tpl = this.templates.find((t) => t.name === name) ?? this.templates[0];
    if (this.root) this.layouts.set(this.layoutName, this.root);
    this.maximized = null;
    this.fullscreen = false;
    this.layoutName = tpl.name;
    let root = this.layouts.get(tpl.name);
    if (!root) { root = tpl.build(this); this.layouts.set(tpl.name, root); }
    this.root = root;
    clear(this.el);
    for (const a of this.collect(this.root)) this.el.append(a.el);
    this.layout();
    requestAnimationFrame(() => {
      for (const a of this.areas()) { a.editor.mount(); a.editor.resize(); a.editor.refresh(new Set(['all'])); }
    });
    app?.notify('screen');
  }

  cycleLayout(dir: 1 | -1): void {
    const names = this.templateNames();
    const i = names.indexOf(this.layoutName);
    this.setLayout(names[(i + dir + names.length) % names.length]);
  }

  newArea(type: string): Area { return new Area(this, type); }

  private collect(n: ScreenNode, out: Area[] = []): Area[] {
    if (n.kind === 'area') out.push(n.area);
    else { this.collect(n.a, out); this.collect(n.b, out); }
    return out;
  }

  areas(): Area[] { return this.collect(this.root); }

  areaUnderMouse(): Area | null {
    const { x, y } = app.mouse;
    for (const a of this.visibleAreas()) {
      const r = a.rect;
      if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return a;
    }
    return null;
  }

  visibleAreas(): Area[] { return this.maximized ? [this.maximized] : this.areas(); }

  /** Largest visible area of a type (or overall). */
  biggestArea(type?: string): Area | null {
    let best: Area | null = null;
    for (const a of this.visibleAreas()) {
      if (type && a.type !== type) continue;
      if (!best || a.rect.w * a.rect.h > best.rect.w * best.rect.h) best = a;
    }
    return best;
  }

  refresh(flags: Set<string>): void {
    for (const a of this.visibleAreas()) {
      try {
        a.editor.rebuildHeader();
        a.editor.refresh(flags);
      } catch (err) { console.error('refresh', a.type, err); }
    }
  }

  // ---------------------------------------------------------------- layout

  layout(): void {
    for (const e of this.edgeEls) e.remove();
    this.edgeEls = [];
    const W = this.el.clientWidth, H = this.el.clientHeight;
    const all = this.areas();
    if (this.maximized) {
      for (const a of all) a.el.style.display = a === this.maximized ? '' : 'none';
      this.place(this.maximized, 0, 0, W, H);
    } else {
      for (const a of all) a.el.style.display = '';
      this.layoutNode(this.root, 0, 0, W, H);
    }
    for (const a of this.visibleAreas()) a.editor.resize();
  }

  private place(a: Area, x: number, y: number, w: number, hgt: number) {
    a.rect = { x, y, w, h: hgt };
    Object.assign(a.el.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${hgt}px` });
  }

  private firstSize(n: Extract<ScreenNode, { kind: 'split' }>, total: number): number {
    const avail = total - GAP;
    let s: number;
    if (n.fixed) s = n.fixed.which === 0 ? n.fixed.px : avail - n.fixed.px;
    else s = avail * n.ratio;
    return clamp(Math.round(s), Math.min(MIN, avail / 2), Math.max(avail - MIN, avail / 2));
  }

  private layoutNode(n: ScreenNode, x: number, y: number, w: number, hgt: number): void {
    if (n.kind === 'area') { this.place(n.area, x, y, w, hgt); return; }
    if (n.dir === 'v') {
      const s = this.firstSize(n, w);
      this.layoutNode(n.a, x, y, s, hgt);
      this.layoutNode(n.b, x + s + GAP, y, w - s - GAP, hgt);
      this.addEdge(n, x + s - 2, y, GAP + 4, hgt, 'v', x, w);
    } else {
      const s = this.firstSize(n, hgt);
      this.layoutNode(n.a, x, y, w, s);
      this.layoutNode(n.b, x, y + s + GAP, w, hgt - s - GAP);
      this.addEdge(n, x, y + s - 2, w, GAP + 4, 'h', y, hgt);
    }
  }

  private addEdge(n: Extract<ScreenNode, { kind: 'split' }>, x: number, y: number, w: number, hgt: number, dir: 'h' | 'v', origin: number, total: number) {
    const e = h('div', { class: `area-edge ${dir}`, style: { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${hgt}px` } });
    e.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      trackDrag(ev, (m) => {
        const pos = (dir === 'v' ? m.clientX : m.clientY) - this.el.getBoundingClientRect()[dir === 'v' ? 'left' : 'top'];
        const avail = total - GAP;
        const first = clamp(pos - origin, MIN, avail - MIN);
        if (n.fixed) n.fixed.px = n.fixed.which === 0 ? first : avail - first;
        else n.ratio = first / avail;
        this.layout();
      }, undefined, { cursor: dir === 'v' ? 'col-resize' : 'row-resize', threshold: 0 });
    });
    e.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      showMenu([
        { label: 'Split Area', action: () => { const a = this.areaAt(ev.clientX + (dir === 'v' ? 8 : 0), ev.clientY + (dir === 'h' ? 8 : 0)); if (a) this.splitArea(a, dir === 'v' ? 'h' : 'v', 0.5); } },
        { label: 'Join Area', action: () => this.joinSplit(n) },
      ], { x: ev.clientX, y: ev.clientY }, { title: 'Area Options' });
    });
    this.el.append(e);
    this.edgeEls.push(e);
  }

  private areaAt(x: number, y: number): Area | null {
    const r = this.el.getBoundingClientRect();
    const px = x - r.left, py = y - r.top;
    for (const a of this.visibleAreas()) {
      const q = a.rect;
      if (px >= q.x && px < q.x + q.w && py >= q.y && py < q.y + q.h) return a;
    }
    return null;
  }

  private findParent(target: ScreenNode, n: ScreenNode = this.root, parent: Extract<ScreenNode, { kind: 'split' }> | null = null): Extract<ScreenNode, { kind: 'split' }> | null {
    if (n === target) return parent;
    if (n.kind === 'split') return this.findParent(target, n.a, n) ?? this.findParent(target, n.b, n);
    return null;
  }

  private nodeOf(area: Area, n: ScreenNode = this.root): ScreenNode | null {
    if (n.kind === 'area') return n.area === area ? n : null;
    return this.nodeOf(area, n.a) ?? this.nodeOf(area, n.b);
  }

  private replaceNode(oldN: ScreenNode, newN: ScreenNode): void {
    const p = this.findParent(oldN);
    if (!p) { this.root = newN; return; }
    if (p.a === oldN) p.a = newN; else p.b = newN;
  }

  /** Split `area` with a new area of the same type. `dir`: 'v' = side by side, 'h' = stacked. */
  splitArea(area: Area, dir: 'h' | 'v', ratio: number): Area | null {
    const node = this.nodeOf(area);
    if (!node) return null;
    const r = area.rect;
    if ((dir === 'v' && r.w < MIN * 2 + GAP) || (dir === 'h' && r.h < MIN * 2 + GAP)) return null;
    const na = new Area(this, area.type);
    na.spaceData = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(area.spaceData).map(([k, v]) => [k, sanitizeState(v)]))));
    na.setType(area.type, false);
    const split: ScreenNode = { kind: 'split', dir, ratio: clamp(ratio, 0.05, 0.95), a: node, b: { kind: 'area', area: na } };
    this.replaceNode(node, split);
    this.el.append(na.el);
    this.layout();
    return na;
  }

  /** Remove `remove` and let its sibling take the space (they must be siblings). */
  joinAreas(keep: Area, remove: Area): boolean {
    const kn = this.nodeOf(keep), rn = this.nodeOf(remove);
    if (!kn || !rn) return false;
    const p = this.findParent(rn);
    if (!p || (p.a !== kn && p.b !== kn)) return false;
    this.replaceNode(p, kn);
    remove.editor.destroy();
    remove.el.remove();
    this.layout();
    return true;
  }

  private joinSplit(n: Extract<ScreenNode, { kind: 'split' }>): void {
    if (n.a.kind === 'area' && n.b.kind === 'area') this.joinAreas(n.a.area, n.b.area);
    else app.report('WARNING', 'Can only join areas that share an edge fully');
  }

  toggleMaximize(area: Area | null, fullscreen = false): void {
    if (this.maximized) {
      const m = this.maximized;
      this.maximized = null;
      this.fullscreen = false;
      m.setHeaderHidden(false);
      m.el.querySelectorAll('.region-hidden-handle').forEach((x) => x.remove());
    } else if (area) {
      this.maximized = area;
      this.fullscreen = fullscreen;
      if (fullscreen) area.setHeaderHidden(true);
    }
    this.layout();
    app.notify('screen');
  }

  /** Corner action zone drag: inward = split, outward into a neighbour = join. */
  startCornerDrag(area: Area, e: PointerEvent, corner: 'tr' | 'bl'): void {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const preview = h('div', { class: 'area-split-preview' });
    const joinPrev = h('div', { class: 'area-join-preview' });
    let mode: 'none' | 'split' | 'join' = 'none';
    let splitDir: 'h' | 'v' = 'v';
    let ratio = 0.5;
    let target: Area | null = null;
    const sr = this.el.getBoundingClientRect();
    const r = area.rect;
    trackDrag(e, (m) => {
      const px = m.clientX - sr.left, py = m.clientY - sr.top;
      const inside = px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h;
      preview.remove();
      joinPrev.remove();
      if (inside) {
        mode = 'split';
        const dx = Math.abs(m.clientX - e.clientX), dy = Math.abs(m.clientY - e.clientY);
        splitDir = dx > dy ? 'v' : 'h';
        if (splitDir === 'v') {
          ratio = (px - r.x) / r.w;
          Object.assign(preview.style, { left: `${sr.left + px}px`, top: `${sr.top + r.y}px`, width: '1px', height: `${r.h}px` });
        } else {
          ratio = (py - r.y) / r.h;
          Object.assign(preview.style, { left: `${sr.left + r.x}px`, top: `${sr.top + py}px`, width: `${r.w}px`, height: '1px' });
        }
        preview.style.position = 'fixed';
        document.body.append(preview);
      } else {
        target = this.areaAt(m.clientX, m.clientY);
        if (target && target !== area) {
          mode = 'join';
          const t = target.rect;
          Object.assign(joinPrev.style, { position: 'fixed', left: `${sr.left + t.x}px`, top: `${sr.top + t.y}px`, width: `${t.w}px`, height: `${t.h}px` });
          const ang = t.x >= r.x + r.w ? 45 : t.x + t.w <= r.x ? 225 : t.y >= r.y + r.h ? 135 : 315;
          joinPrev.style.setProperty('--join-rot', `${ang}deg`);
          document.body.append(joinPrev);
        } else mode = 'none';
      }
    }, () => {
      preview.remove();
      joinPrev.remove();
      if (mode === 'split') {
        // the new area is placed on the side of the corner that was dragged
        const na = this.splitArea(area, splitDir, ratio);
        void na;
      } else if (mode === 'join' && target) {
        if (!this.joinAreas(area, target)) app.report('WARNING', 'Can only join areas that share an edge fully');
      }
      void corner;
    }, { threshold: 4, cursor: 'crosshair' });
  }
}

function sanitizeState(v: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (x === null || ['string', 'number', 'boolean'].includes(typeof x) || Array.isArray(x) || (typeof x === 'object' && x.constructor === Object)) {
      try { out[k] = JSON.parse(JSON.stringify(x)); } catch { /* skip */ }
    }
  }
  return out;
}
