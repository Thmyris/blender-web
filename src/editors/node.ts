// Node Editor (NODE_EDITOR): compositing and Blender Internal material node trees in the 2.79 look.
// Nodes are DOM elements (so their buttons are real UI widgets) inside a pan/zoom transformed layer;
// links are SVG curves; the grid and the compositor backdrop are drawn on a canvas underneath.

import '../styles/editors.css';
import { app, type ModalHandler, type OperatorDef, type OpContext, type OpProps, type OpResult } from '../app';
import { Editor, registerEditor } from '../screen/editor';
import type { Area } from '../screen/screen';
import { h, clear, trackDrag } from '../ui/dom';
import { icon } from '../ui/icons';
import { pulldown, showMenu, type MenuItem } from '../ui/menu';
import { LayoutRoot, Layout, PanelRegion, bprop, sprop, type PanelDef } from '../ui/layout';
import type { BNode, NodeTree, NodeTreeType } from '../core/edtypes';
import type { MaterialData } from '../core/types';
import {
  CATEGORY_COLOR, SOCKET_COLOR, addLink, allTreeTypes, bestInput, buildDefaultTree, createNode, duplicateSelected, findNode, linkTo,
  nodeInputs, nodeLabel, nodeOutputs, nodeType, nodeTypesFor, removeNodes, socketDef, treeType, type SocketDef,
} from '../nodes/nodes';
import { setActiveViewer, viewerCanvas, viewerListeners, scheduleRecomposite } from '../nodes/compositor';
import { colorToCss } from '../ui/format';
import { importMedia } from '../media/media';
import { pickFile } from '../ui/dom';
import { renameData } from '../core/scene';

const ZOOM_MIN = 0.1, ZOOM_MAX = 2.31;

/** Material shown in the shader node editor: the active material of the active object. */
export function activeMaterialOf(): MaterialData | null {
  const ob = app.activeObject;
  if (!ob) return null;
  const md = app.meshOf(ob);
  const slot = md?.materials[Math.max(0, Math.min((md?.materials.length ?? 1) - 1, ob.activeMaterialIndex ?? 0))];
  return slot ? app.doc.materials[slot] ?? null : null;
}

// ------------------------------------------------------------------ editor

interface SockPos { node: string; side: 'in' | 'out'; id: string; type: SocketDef['type']; rx: number; ry: number }

export class NodeEditor extends Editor {
  static readonly TYPE = 'NODE_EDITOR';
  region: HTMLElement;
  private bg: HTMLCanvasElement;
  private world: HTMLElement;
  private linksSvg: SVGSVGElement;
  overlay: SVGSVGElement;
  private nodesLayer: HTMLElement;
  private framesLayer: HTMLElement;
  private msg: HTMLElement;
  private sidebarWrap: HTMLElement;
  private sidebar: PanelRegion;
  private root = new LayoutRoot(null);
  private nodeEls = new Map<string, HTMLElement>();
  private sockets = new Map<string, SockPos>();
  private builtKey = '';
  private builtTree: NodeTree | null = null;
  private raf = 0;
  private unsubViewer: () => void;
  private treeGen = 0;

  constructor(area: Area, state: Record<string, unknown>) {
    super(area, state);
    state.treeType ??= 'COMPOSITING';
    state.zoom ??= 1;
    state.panX ??= NaN;
    state.panY ??= NaN;
    state.showBackdrop ??= false;
    state.backdropZoom ??= 1;
    state.backdropX ??= 0;
    state.backdropY ??= 0;
    state.backdropChannels ??= 'COLOR_ALPHA';
    state.showSidebar ??= false;
    this.root = new LayoutRoot(area);
    this.bg = h('canvas', { class: 'node-bg' }) as HTMLCanvasElement;
    this.framesLayer = h('div', { style: { position: 'absolute', left: '0', top: '0' } });
    this.nodesLayer = h('div', { style: { position: 'absolute', left: '0', top: '0' } });
    this.linksSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.linksSvg.classList.add('node-links');
    this.world = h('div', { class: 'node-world' }, this.framesLayer);
    this.world.append(this.linksSvg, this.nodesLayer);
    this.overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.overlay.classList.add('node-overlay');
    this.msg = h('div', { class: 'node-tree-msg' });
    this.region = h('div', { class: 'node-region' }, this.bg, this.world, this.msg);
    this.region.append(this.overlay);
    this.sidebar = new PanelRegion(() => this.sidebarPanels(), area, `${area.id}:node-ui:`);
    this.sidebarWrap = h('div', { class: 'node-sidebar' }, this.sidebar.el);
    const row = h('div', { class: 'editor-row' }, this.region, this.sidebarWrap);
    this.main.append(row);
    this.region.addEventListener('contextmenu', (e) => e.preventDefault());
    this.region.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.region.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.region.addEventListener('dblclick', (e) => this.onDblClick(e));
    const vl = () => this.drawBg();
    viewerListeners.add(vl);
    this.unsubViewer = () => viewerListeners.delete(vl);
    this.updateSidebarVisibility();
  }

  get type(): string { return NodeEditor.TYPE; }
  get treeType(): NodeTreeType { return this.state.treeType as NodeTreeType; }
  get zoom(): number { return this.state.zoom as number; }
  get panX(): number { return this.state.panX as number; }
  get panY(): number { return this.state.panY as number; }

  override destroy(): void { this.unsubViewer(); cancelAnimationFrame(this.raf); }

  /** The node tree shown in this editor (may be null). */
  tree(): NodeTree | null {
    if (this.treeType === 'COMPOSITING') return app.scene.nodeTree ?? null;
    if (this.treeType === 'SHADER') return activeMaterialOf()?.nodeTree ?? null;
    return null;
  }

  /** Called after the tree was edited. */
  treeChanged(): void {
    if (this.treeType === 'COMPOSITING') scheduleRecomposite(60);
    app.notify('data');
  }

  // ---------------------------------------------------------------- coordinates

  /** Region-relative screen position of a node-space point (Blender coordinates, y up). */
  toScreen(x: number, y: number): [number, number] { return [x * this.zoom + this.panX, -y * this.zoom + this.panY]; }
  /** Node-space point under region-relative screen coordinates. */
  toNode(sx: number, sy: number): [number, number] { return [(sx - this.panX) / this.zoom, -(sy - this.panY) / this.zoom]; }
  eventPos(e: { clientX: number; clientY: number }): [number, number] {
    const r = this.region.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }
  mouseNode(): [number, number] { return this.toNode(...this.eventPos({ clientX: app.mouse.x, clientY: app.mouse.y })); }

  private ensureView(): void {
    if (Number.isFinite(this.panX) && Number.isFinite(this.panY)) return;
    const w = this.region.clientWidth, hh = this.region.clientHeight;
    if (!w || !hh) return;
    const t = this.tree();
    if (t && t.nodes.length) { this.viewAll(false); return; }
    this.state.panX = w / 2;
    this.state.panY = hh / 2 + 150 * this.zoom;
  }

  private applyTransform(): void {
    this.world.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
    this.drawBg();
  }

  // ---------------------------------------------------------------- refresh / building

  override mount(): void { this.resize(); }

  override resize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.bg.width = Math.max(1, Math.round(this.region.clientWidth * dpr));
    this.bg.height = Math.max(1, Math.round(this.region.clientHeight * dpr));
    this.ensureView();
    this.applyTransform();
    this.sidebar.refresh();
  }

  override refresh(): void {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.update());
  }

  override headerKey(): string {
    const t = this.treeType;
    return `${t}|${app.scene.useNodes}|${this.state.showBackdrop}|${t === 'SHADER' ? activeMaterialOf()?.id ?? '' : ''}|${!!activeMaterialOf()?.useNodes}`;
  }

  private structureKey(t: NodeTree | null): string {
    if (!t) return 'none';
    return JSON.stringify([
      t.nodes.map((n) => [n.name, n.type, n.hide, n.mute, n.width, n.label, n.hiddenSockets ?? null, n.parent, n.height ?? 0, n.showOptions === false,
        Object.entries(n.props).filter(([, v]) => typeof v !== 'number' && !(Array.isArray(v) && typeof v[0] === 'number') && (typeof v !== 'object' || v === null)), n.useCustomColor ? n.color : null]),
      t.links,
    ]);
  }

  update(): void {
    this.ensureView();
    const t = this.tree();
    if (t !== this.builtTree) this.treeGen++;
    const key = this.structureKey(t);
    if (t !== this.builtTree || key !== this.builtKey) {
      if (!app.modal || !this.isLinkModal) this.build(t);
      this.builtKey = key;
      this.builtTree = t;
    } else {
      this.root.update();
      this.updatePositions();
    }
    this.msg.textContent = t ? '' : this.treeType === 'COMPOSITING' ? 'Enable "Use Nodes" in the header to create a compositing node tree' : this.treeType === 'SHADER' ? (activeMaterialOf() ? 'Enable "Use Nodes" to use a node tree for this material' : 'No active material') : 'Texture nodes are not available in blender-web';
    this.sidebar.refresh();
    this.drawBg();
  }

  isLinkModal = false;

  private build(t: NodeTree | null): void {
    clear(this.nodesLayer);
    clear(this.framesLayer);
    this.nodeEls.clear();
    this.sockets.clear();
    this.root = new LayoutRoot(this.area);
    if (!t) { this.drawLinks(); return; }
    for (const n of t.nodes) {
      const d = nodeType(n.type);
      if (d?.special === 'FRAME') this.buildFrame(t, n);
      else if (d?.special === 'REROUTE') this.buildReroute(t, n);
      else this.buildNode(t, n);
    }
    // measure socket offsets
    for (const [name, el] of this.nodeEls) {
      const n = findNode(t, name);
      if (!n) continue;
      if (nodeType(n.type)?.special === 'REROUTE') {
        this.sockets.set(`${name}|in|Input`, { node: name, side: 'in', id: 'Input', type: 'RGBA', rx: 0, ry: 0 });
        this.sockets.set(`${name}|out|Output`, { node: name, side: 'out', id: 'Output', type: 'RGBA', rx: 0, ry: 0 });
        continue;
      }
      el.querySelectorAll<HTMLElement>('.sock').forEach((s) => {
        let x = s.offsetWidth / 2, y = s.offsetHeight / 2;
        let cur: HTMLElement | null = s;
        while (cur && cur !== el) { x += cur.offsetLeft; y += cur.offsetTop; cur = cur.offsetParent as HTMLElement | null; }
        const side = s.dataset.side as 'in' | 'out';
        this.sockets.set(`${name}|${side}|${s.dataset.id}`, { node: name, side, id: s.dataset.id!, type: (s.dataset.type ?? 'RGBA') as SocketDef['type'], rx: x, ry: y });
      });
    }
    this.updatePositions();
  }

  private buildFrame(t: NodeTree, n: BNode): void {
    const el = h('div', { class: 'bframe' }, h('div', { class: 'flabel', style: { fontSize: `${Number(n.props.label_size ?? 20) * 0.6}px` } }, n.label || n.name));
    if (n.useCustomColor && n.color) el.style.background = colorToCss(n.color, 0.6);
    el.dataset.node = n.name;
    this.framesLayer.append(el);
    this.nodeEls.set(n.name, el);
    void t;
  }

  private buildReroute(_t: NodeTree, n: BNode): void {
    const el = h('div', { class: 'bnode-reroute' });
    el.dataset.node = n.name;
    const s = h('div', { class: 'sock', style: { inset: '0', width: '100%', height: '100%', background: 'transparent', border: 'none' } });
    s.dataset.side = 'out'; s.dataset.id = 'Output'; s.dataset.node = n.name; s.dataset.type = 'RGBA';
    el.append(s);
    this.nodesLayer.append(el);
    this.nodeEls.set(n.name, el);
  }

  private buildNode(t: NodeTree, n: BNode): void {
    const d = nodeType(n.type);
    const color = n.useCustomColor && n.color ? colorToCss(n.color) : CATEGORY_COLOR[d?.category ?? 'LAYOUT'];
    const el = h('div', { class: `bnode${n.hide ? ' collapsed' : ''}` });
    el.dataset.node = n.name;
    el.style.width = `${n.width}px`;
    const tri = h('div', { class: 'tri', title: 'Collapse/expand the node (H)' });
    tri.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); if (e.button === 0) void app.callOperator('node.hide_toggle', { node: n.name }, { area: this.area }); });
    const header = h('div', { class: 'bnode-header', style: { background: color } }, tri, h('div', { class: 'ntitle' }, nodeLabel(n)));
    el.append(header);
    const hidden = new Set(n.hiddenSockets ?? []);
    const sock = (s: SocketDef, side: 'in' | 'out') => {
      const se = h('div', { class: `sock${s.type === 'VECTOR' ? ' vector' : ''}`, style: { background: SOCKET_COLOR[s.type] } });
      se.dataset.side = side; se.dataset.id = s.id; se.dataset.node = n.name; se.dataset.type = s.type;
      se.title = s.name;
      return se;
    };
    if (n.hide) {
      // collapsed: sockets on the left/right of the header
      const ins = nodeInputs(n).filter((s) => !hidden.has(s.id) || linkTo(t, n.name, s.id));
      const outs = nodeOutputs(n).filter((s) => !hidden.has(s.id));
      ins.forEach((s, i) => { const se = sock(s, 'in'); se.style.left = '-5.5px'; se.style.top = `${4.5 + (i - (ins.length - 1) / 2) * 6}px`; header.append(se); });
      outs.forEach((s, i) => { const se = sock(s, 'out'); se.style.right = '-5.5px'; se.style.top = `${4.5 + (i - (outs.length - 1) / 2) * 6}px`; header.append(se); });
      header.style.position = 'relative';
      this.nodesLayer.append(el);
      this.nodeEls.set(n.name, el);
      return;
    }
    const body = h('div', { class: 'bnode-body' });
    el.append(body);
    const lay = new Layout(body, this.root);
    for (const s of nodeOutputs(n)) {
      if (hidden.has(s.id)) continue;
      const row = h('div', { class: 'bnode-sock-row out' }, h('div', { class: 'sname' }, s.name), sock(s, 'out'));
      body.append(row);
    }
    if (d?.draw && n.showOptions !== false) {
      const col = lay.column();
      try { d.draw(col, n, { tree: t, sidebar: false }); } catch (err) { console.error(err); }
    }
    for (const s of nodeInputs(n)) {
      if (hidden.has(s.id) && !linkTo(t, n.name, s.id)) continue;
      const row = h('div', { class: 'bnode-sock-row in' }, sock(s, 'in'));
      body.append(row);
      const linked = !!linkTo(t, n.name, s.id);
      if (linked || s.hideValue) { row.append(h('div', { class: 'sname' }, s.name)); continue; }
      const rl = new Layout(row, this.root);
      this.socketValueWidget(rl, n, s, false);
    }
    this.nodesLayer.append(el);
    this.nodeEls.set(n.name, el);
  }

  /** Widget for an unlinked input socket value. */
  socketValueWidget(l: Layout, n: BNode, s: SocketDef, sidebar: boolean): void {
    const get = () => n.inputs[s.id] ?? s.default ?? 0;
    if (s.type === 'VALUE') {
      l.prop({
        kind: 'float', name: s.name, min: s.min, max: s.max, step: s.step, precision: 3, unit: s.unit,
        get: () => Number(get()), set: (v) => { n.inputs[s.id] = v; }, notify: ['data'], description: s.description,
      }, { slider: s.slider });
    } else if (s.type === 'RGBA') {
      const r = l.row();
      if (!sidebar) { const lab = h('div', { class: 'sname', style: { flex: '1 1 auto' } }, s.name); r.el.append(lab); }
      else r.label(s.name);
      const sw = r.prop({ kind: 'color', name: s.name, alpha: true, get: () => (get() as number[]).slice(), set: (v) => { n.inputs[s.id] = [v[0], v[1], v[2], v[3] ?? 1]; }, notify: ['data'] }, { text: '' });
      sw.style.flex = sidebar ? '1 1 auto' : '0 0 40px';
    } else if (s.type === 'VECTOR') {
      const c = l.column(true);
      c.label(`${s.name}:`);
      for (let i = 0; i < 3; i++) c.prop({ kind: 'float', name: 'XYZ'[i], precision: 3, get: () => Number((get() as number[])[i] ?? 0), set: (v) => { const a = (get() as number[]).slice(); a[i] = v; n.inputs[s.id] = a; }, notify: ['data'] });
    } else {
      l.label(s.name);
    }
  }

  /** Position nodes, frames and links (no rebuild). */
  updatePositions(): void {
    const t = this.tree();
    if (!t) { this.drawLinks(); return; }
    // frames: fit around their children when "shrink" is on
    for (const n of t.nodes) {
      const el = this.nodeEls.get(n.name);
      if (!el) continue;
      const d = nodeType(n.type);
      el.classList.toggle('selected', n.select);
      el.classList.toggle('active', t.active === n.name && n.select);
      el.classList.toggle('muted', n.mute);
      if (d?.special === 'FRAME') {
        const kids = t.nodes.filter((k) => k.parent === n.name);
        let x0 = n.location[0], y0 = -n.location[1], x1 = x0 + n.width, y1 = y0 + (n.height ?? 150);
        if (kids.length && n.props.shrink !== false) {
          x0 = Infinity; y0 = Infinity; x1 = -Infinity; y1 = -Infinity;
          for (const k of kids) {
            const ke = this.nodeEls.get(k.name);
            const kw = k.width, kh = ke ? ke.offsetHeight : 100;
            x0 = Math.min(x0, k.location[0]); y0 = Math.min(y0, -k.location[1]); x1 = Math.max(x1, k.location[0] + kw); y1 = Math.max(y1, -k.location[1] + kh);
          }
          x0 -= 20; x1 += 20; y0 -= 40; y1 += 20;
          n.location = [x0, -y0];
          n.width = x1 - x0;
          n.height = y1 - y0;
        }
        el.style.left = `${x0}px`; el.style.top = `${y0}px`; el.style.width = `${x1 - x0}px`; el.style.height = `${y1 - y0}px`;
        continue;
      }
      el.style.left = `${n.location[0]}px`;
      el.style.top = `${-n.location[1]}px`;
    }
    this.drawLinks();
  }

  /** Socket position in node DOM space (y down). */
  sockPos(node: string, side: 'in' | 'out', id: string): [number, number] | null {
    const t = this.tree();
    const n = t ? findNode(t, node) : undefined;
    const s = this.sockets.get(`${node}|${side}|${id}`);
    if (!n || !s) return null;
    return [n.location[0] + s.rx, -n.location[1] + s.ry];
  }

  static curve(x1: number, y1: number, x2: number, y2: number): string {
    const dx = Math.max(20, Math.abs(x2 - x1) * 0.5);
    return `M${x1} ${y1} C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`;
  }

  drawLinks(): void {
    while (this.linksSvg.firstChild) this.linksSvg.firstChild.remove();
    const t = this.tree();
    if (!t) return;
    const ns = 'http://www.w3.org/2000/svg';
    for (const l of t.links) {
      const a = this.sockPos(l.fromNode, 'out', l.fromSocket), b = this.sockPos(l.toNode, 'in', l.toSocket);
      if (!a || !b) continue;
      const fa = findNode(t, l.fromNode), fb = findNode(t, l.toNode);
      const hi = !!(fa?.select || fb?.select);
      const p = document.createElementNS(ns, 'path');
      p.setAttribute('d', NodeEditor.curve(a[0], a[1], b[0], b[1]));
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', hi ? '#ffffff' : '#1a1a1a');
      p.setAttribute('stroke-width', String(hi ? 2 : 1.6));
      if (fa?.mute || fb?.mute) p.setAttribute('stroke-opacity', '0.4');
      p.dataset.link = `${l.fromNode}|${l.fromSocket}|${l.toNode}|${l.toSocket}`;
      this.linksSvg.append(p);
    }
  }

  /** Sample points of each link curve in screen space (for cutting). */
  linkPolylines(): { link: NodeTree['links'][number]; pts: [number, number][] }[] {
    const t = this.tree();
    if (!t) return [];
    const out: { link: NodeTree['links'][number]; pts: [number, number][] }[] = [];
    for (const l of t.links) {
      const a = this.sockPos(l.fromNode, 'out', l.fromSocket), b = this.sockPos(l.toNode, 'in', l.toSocket);
      if (!a || !b) continue;
      const dx = Math.max(20, Math.abs(b[0] - a[0]) * 0.5);
      const pts: [number, number][] = [];
      for (let i = 0; i <= 24; i++) {
        const u = i / 24, v = 1 - u;
        const x = v * v * v * a[0] + 3 * v * v * u * (a[0] + dx) + 3 * v * u * u * (b[0] - dx) + u * u * u * b[0];
        const y = v * v * v * a[1] + 3 * v * v * u * a[1] + 3 * v * u * u * b[1] + u * u * u * b[1];
        pts.push([x * this.zoom + this.panX, y * this.zoom + this.panY]);
      }
      out.push({ link: l, pts });
    }
    return out;
  }

  // ---------------------------------------------------------------- background (grid, backdrop)

  drawBg(): void {
    const ctx = this.bg.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.bg.width / dpr, hh = this.bg.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#393939';
    ctx.fillRect(0, 0, w, hh);
    // backdrop
    if (this.treeType === 'COMPOSITING' && this.state.showBackdrop && viewerCanvas) {
      const img = viewerCanvas;
      const bz = this.state.backdropZoom as number;
      const iw = img.width * bz, ih = img.height * bz;
      const x = w / 2 - iw / 2 + (this.state.backdropX as number) * bz, y = hh / 2 - ih / 2 - (this.state.backdropY as number) * bz;
      const ch = this.state.backdropChannels;
      ctx.save();
      if (ch === 'ALPHA') {
        ctx.fillStyle = '#000'; ctx.fillRect(x, y, iw, ih);
        ctx.globalCompositeOperation = 'lighter';
        ctx.filter = 'grayscale(1) brightness(1000%)';
        ctx.drawImage(img, x, y, iw, ih);
      } else if (ch === 'COLOR') {
        ctx.fillStyle = '#000'; ctx.fillRect(x, y, iw, ih);
        ctx.drawImage(img, x, y, iw, ih);
      } else ctx.drawImage(img, x, y, iw, ih);
      ctx.restore();
    }
    // grid
    if (!Number.isFinite(this.panX)) return;
    const step = 20 * this.zoom;
    if (step >= 6) {
      ctx.strokeStyle = 'rgba(0,0,0,0.13)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      const ox = ((this.panX % step) + step) % step, oy = ((this.panY % step) + step) % step;
      for (let x = ox; x < w; x += step) { ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, hh); }
      for (let y = oy; y < hh; y += step) { ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(w, Math.round(y) + 0.5); }
      ctx.stroke();
    }
    const big = 100 * this.zoom;
    ctx.strokeStyle = 'rgba(0,0,0,0.22)';
    ctx.beginPath();
    const bx = ((this.panX % big) + big) % big, by = ((this.panY % big) + big) % big;
    for (let x = bx; x < w; x += big) { ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, hh); }
    for (let y = by; y < hh; y += big) { ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(w, Math.round(y) + 0.5); }
    ctx.stroke();
  }

  // ---------------------------------------------------------------- view

  viewAll(redraw = true, onlySelected = false): void {
    const t = this.tree();
    const w = this.region.clientWidth, hh = this.region.clientHeight;
    if (!t || !w || !hh) return;
    const nodes = t.nodes.filter((n) => !onlySelected || n.select);
    if (!nodes.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of nodes) {
      const el = this.nodeEls.get(n.name);
      const nh = el?.offsetHeight || 120;
      x0 = Math.min(x0, n.location[0]); x1 = Math.max(x1, n.location[0] + n.width);
      y0 = Math.min(y0, -n.location[1]); y1 = Math.max(y1, -n.location[1] + nh);
    }
    const pad = 40;
    const z = Math.max(ZOOM_MIN, Math.min(1.0, (w - pad * 2) / Math.max(1, x1 - x0), (hh - pad * 2) / Math.max(1, y1 - y0)));
    this.state.zoom = z;
    this.state.panX = w / 2 - ((x0 + x1) / 2) * z;
    this.state.panY = hh / 2 - ((y0 + y1) / 2) * z;
    if (redraw) this.applyTransform();
  }

  zoomAt(sx: number, sy: number, factor: number): void {
    const z0 = this.zoom;
    const z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z0 * factor));
    this.state.panX = sx - ((sx - this.panX) / z0) * z;
    this.state.panY = sy - ((sy - this.panY) / z0) * z;
    this.state.zoom = z;
    this.applyTransform();
  }

  private onWheel(e: WheelEvent): void {
    if ((e.target as HTMLElement).closest('.region-scroll')) return;
    e.preventDefault();
    const [x, y] = this.eventPos(e);
    if (e.ctrlKey) { this.state.panX = this.panX - e.deltaY * 0.5; this.applyTransform(); return; }
    if (e.shiftKey) { this.state.panY = this.panY - e.deltaY * 0.5; this.applyTransform(); return; }
    this.zoomAt(x, y, e.deltaY < 0 ? 1.15 : 1 / 1.15);
  }

  // ---------------------------------------------------------------- hit testing

  nodeAt(e: { clientX: number; clientY: number; target?: EventTarget | null }): BNode | null {
    const t = this.tree();
    if (!t) return null;
    const target = (e.target ?? document.elementFromPoint(e.clientX, e.clientY)) as HTMLElement | null;
    const el = target?.closest?.('[data-node]') as HTMLElement | null;
    if (el && (el.classList.contains('bnode') || el.classList.contains('bnode-reroute') || el.classList.contains('bframe'))) return findNode(t, el.dataset.node) ?? null;
    if (el && el.classList.contains('sock')) return findNode(t, el.dataset.node) ?? null;
    return null;
  }

  /** Nearest socket to a region position (within `radius` px). */
  socketNear(sx: number, sy: number, side: 'in' | 'out' | null, radius = 22): SockPos | null {
    let best: SockPos | null = null, bd = radius;
    for (const s of this.sockets.values()) {
      if (side && s.side !== side) continue;
      const p = this.sockPos(s.node, s.side, s.id);
      if (!p) continue;
      const d = Math.hypot(p[0] * this.zoom + this.panX - sx, p[1] * this.zoom + this.panY - sy);
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }

  nodeScreenRect(n: BNode): DOMRect | null {
    const el = this.nodeEls.get(n.name);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const rr = this.region.getBoundingClientRect();
    return new DOMRect(r.left - rr.left, r.top - rr.top, r.width, r.height);
  }

  // ---------------------------------------------------------------- mouse

  private onPointerDown(e: PointerEvent): void {
    if (app.modal) return;
    const target = e.target as HTMLElement;
    if (target.closest('.node-sidebar')) return;
    const t = this.tree();
    // widgets inside nodes handle their own events
    if (target.closest('.bnode-body') && target.closest('.w, .icon-btn, input, canvas, .id-template, .w-menu')) {
      if (e.button === 0 && t) { const n = this.nodeAt(e); if (n && t.active !== n.name) { t.active = n.name; this.updatePositions(); } }
      return;
    }
    if (e.button === 1 || (e.button === 0 && e.altKey && app.prefs.emulate3Button)) {
      e.preventDefault();
      if (e.altKey && this.state.showBackdrop && !app.prefs.emulate3Button) { this.backdropDrag(e); return; }
      this.panDrag(e);
      return;
    }
    if (!t) return;
    const sockEl = target.closest('.sock') as HTMLElement | null;
    if (sockEl && e.button === 0) {
      e.preventDefault();
      void app.callOperator('node.link', { node: sockEl.dataset.node, socket: sockEl.dataset.id, side: sockEl.dataset.side }, { area: this.area, event: e });
      return;
    }
    if (e.button === 2 && e.ctrlKey) { e.preventDefault(); void app.callOperator('node.links_cut', {}, { area: this.area, event: e }); return; }
    const n = this.nodeAt(e);
    if (n) {
      e.preventDefault();
      if (e.button === 0 && e.ctrlKey && e.shiftKey) { void app.callOperator('node.link_viewer', { node: n.name }, { area: this.area }); return; }
      const wasSelected = n.select;
      if (!(e.button === 0 && wasSelected && !e.shiftKey)) {
        void app.callOperator('node.select', { node: n.name, extend: e.shiftKey }, { area: this.area });
      } else { t.active = n.name; if (n.type.endsWith('Viewer')) setActiveViewer(t, n); this.updatePositions(); }
      // drag to move (tweak)
      const sx = e.clientX, sy = e.clientY;
      const cancel = trackDrag(e, (ev) => {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > app.prefs.dragThreshold && !app.modal) {
          cancel();
          if (!n.select) { n.select = true; }
          void app.callOperator('node.translate_attach', { release_confirm: true, button: e.button }, { area: this.area, event: ev });
        }
      }, undefined, { threshold: 0 });
      return;
    }
    // empty space
    if (e.button === 0) {
      e.preventDefault();
      const sx = e.clientX, sy = e.clientY;
      const cancel = trackDrag(e, (ev) => {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > app.prefs.dragThreshold && !app.modal) {
          cancel();
          void app.callOperator('node.select_border', { tweak: true, extend: e.shiftKey, startX: sx, startY: sy }, { area: this.area, event: ev });
        }
      }, (_ev, moved) => { if (!moved && !e.shiftKey) void app.callOperator('node.select_all', { action: 'DESELECT' }, { area: this.area }); }, { threshold: 0 });
    } else if (e.button === 2) {
      e.preventDefault();
      if (!e.shiftKey) void app.callOperator('node.select_all', { action: 'DESELECT' }, { area: this.area });
    }
  }

  private onDblClick(e: MouseEvent): void {
    const t = this.tree();
    if (!t) return;
    const target = e.target as HTMLElement;
    if (!target.closest('.ntitle')) return;
    const n = this.nodeAt(e);
    if (!n) return;
    const input = h('input', { class: 'w-edit', style: { position: 'relative', height: '16px', width: '100%' } }) as HTMLInputElement;
    input.value = n.label || nodeLabel(n);
    target.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const fin = (ok: boolean) => {
      if (done) return;
      done = true;
      if (ok) { n.label = input.value.trim() === nodeLabel({ ...n, label: '' }) ? '' : input.value.trim(); app.pushUndo('Rename Node'); }
      this.builtKey = '';
      app.notify('data');
    };
    input.addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') fin(true); if (ev.key === 'Escape') fin(false); });
    input.addEventListener('blur', () => fin(true));
  }

  private panDrag(e: PointerEvent): void {
    let lx = e.clientX, ly = e.clientY;
    trackDrag(e, (ev) => {
      const dx = ev.clientX - lx, dy = ev.clientY - ly;
      lx = ev.clientX; ly = ev.clientY;
      if (e.ctrlKey) { const [x, y] = this.eventPos(e); this.zoomAt(x, y, Math.pow(1.005, dx - dy)); return; }
      this.state.panX = this.panX + dx;
      this.state.panY = this.panY + dy;
      this.applyTransform();
    }, undefined, { threshold: 0, cursor: 'move' });
  }

  private backdropDrag(e: PointerEvent): void {
    let lx = e.clientX, ly = e.clientY;
    trackDrag(e, (ev) => {
      const bz = this.state.backdropZoom as number;
      this.state.backdropX = (this.state.backdropX as number) + (ev.clientX - lx) / bz;
      this.state.backdropY = (this.state.backdropY as number) - (ev.clientY - ly) / bz;
      lx = ev.clientX; ly = ev.clientY;
      this.drawBg();
    }, undefined, { threshold: 0, cursor: 'move' });
  }

  // ---------------------------------------------------------------- keys

  override onKey(e: KeyboardEvent): boolean {
    if (e.code === 'KeyN' && !e.ctrlKey && !e.altKey && !e.shiftKey) { this.state.showSidebar = !this.state.showSidebar; this.updateSidebarVisibility(); return true; }
    return false;
  }

  updateSidebarVisibility(): void {
    this.sidebarWrap.style.display = this.state.showSidebar ? '' : 'none';
    requestAnimationFrame(() => this.resize());
  }

  // ---------------------------------------------------------------- header

  override drawHeader(l: Layout): void {
    const area = () => this.area;
    const row = l.row();
    row.el.classList.add('header-row');
    row.el.style.flex = '0 0 auto';
    row.el.append(
      pulldown({ label: 'View', items: () => this.viewMenu() }, area),
      pulldown({ label: 'Select', items: () => selectMenu() }, area),
      pulldown({ label: 'Add', items: () => addMenuItems(this) }, area),
      pulldown({ label: 'Node', items: () => nodeMenu() }, area),
    );
    const types = l.row(true);
    types.el.style.flex = '0 0 auto';
    for (const tt of allTreeTypes()) {
      types.prop({ kind: 'enum', name: 'Tree Type', items: [{ id: tt.id, label: tt.label, icon: tt.icon, description: tt.description, disabled: tt.available ? !tt.available() : false }], get: () => this.treeType, set: (v) => { this.state.treeType = v; this.state.panX = NaN; this.builtTree = null; this.rebuildHeader(true); this.refresh(); }, undo: false, description: 'Node tree type to display and edit' }, { expand: true, iconOnly: true });
    }
    if (this.treeType === 'COMPOSITING') {
      const u = l.prop(bprop(() => app.scene, 'useNodes', { name: 'Use Nodes', description: 'Enable the compositing node tree', notify: ['data'], undo: 'Use Nodes', onChange: () => { const s = app.scene; if (s.useNodes && !s.nodeTree) { s.nodeTree = buildDefaultTree('COMPOSITING'); this.state.panX = NaN; } this.rebuildHeader(true); } }));
      u.style.flex = '0 0 auto';
      const b = l.prop({ kind: 'bool', name: 'Backdrop', get: () => !!this.state.showBackdrop, set: (v) => { this.state.showBackdrop = v; this.rebuildHeader(true); this.drawBg(); }, undo: false, description: 'Use active Viewer Node output as backdrop for compositing nodes' }, { toggle: true, icon: 'IMAGE_DATA' });
      b.style.flex = '0 0 auto';
      if (this.state.showBackdrop) {
        const ch = l.row(true);
        ch.el.style.flex = '0 0 auto';
        ch.prop({ kind: 'enum', name: 'Draw Channels', items: [{ id: 'COLOR_ALPHA', label: '', icon: 'IMAGE_RGB_ALPHA', description: 'Draw image with RGB colors and alpha transparency' }, { id: 'COLOR', label: '', icon: 'IMAGE_RGB', description: 'Draw image with RGB colors' }, { id: 'ALPHA', label: '', icon: 'IMAGE_ALPHA', description: 'Draw alpha transparency channel' }], get: () => String(this.state.backdropChannels), set: (v) => { this.state.backdropChannels = v; this.drawBg(); }, undo: false }, { expand: true, iconOnly: true });
      }
    } else if (this.treeType === 'SHADER') {
      const ob = app.activeObject;
      const ma = activeMaterialOf();
      if (ob && app.meshOf(ob)) {
        const id = l.row();
        id.el.style.flex = '0 0 260px';
        id.idTemplate({
          icon: 'MATERIAL', title: 'Material',
          items: () => Object.values(app.doc.materials).map((m) => ({ id: m.id, name: m.name, icon: 'MATERIAL' })),
          get: () => activeMaterialOf()?.id ?? null,
          set: (mid) => {
            const o = app.activeObject; const md = app.meshOf(o);
            if (!o || !md || !mid) return;
            if (!md.materials.length) { md.materials.push(mid); o.activeMaterialIndex = 0; } else md.materials[Math.max(0, Math.min(md.materials.length - 1, o.activeMaterialIndex))] = mid;
            app.tagGeometry(md.id);
          },
          name: () => activeMaterialOf()?.name ?? '',
          rename: (name) => { const m = activeMaterialOf(); if (m) renameData(app.doc, 'materials', m.id, name); },
          onNew: () => void app.callOperator('material.new', {}, { area: this.area }),
          newLabel: 'New',
        });
      }
      if (ma) {
        const u = l.prop(bprop(() => activeMaterialOf(), 'useNodes', { name: 'Use Nodes', description: 'Use shader nodes to render the material', notify: ['data'], undo: 'Use Nodes', onChange: () => { const m = activeMaterialOf(); if (m && m.useNodes && !m.nodeTree) { m.nodeTree = buildDefaultTree('SHADER'); this.state.panX = NaN; } const md = app.meshOf(app.activeObject); if (md) app.tagGeometry(md.id); this.rebuildHeader(true); } }));
        u.style.flex = '0 0 auto';
      }
    }
  }

  private viewMenu(): MenuItem[] {
    return [
      { label: 'Properties', shortcut: 'N', checked: !!this.state.showSidebar, action: () => { this.state.showSidebar = !this.state.showSidebar; this.updateSidebarVisibility(); } },
      { type: 'separator' },
      { label: 'Frame Selected', op: 'node.view_selected' },
      { label: 'View All', op: 'node.view_all' },
      { type: 'separator' },
      { label: 'Backdrop Zoom In', op: 'node.backimage_zoom', props: { factor: 1.2 } },
      { label: 'Backdrop Zoom Out', op: 'node.backimage_zoom', props: { factor: 1 / 1.2 } },
      { label: 'Fit Backdrop to Available Space', op: 'node.backimage_fit' },
      { type: 'separator' },
      { label: 'Toggle Maximize Area', op: 'screen.screen_full_area' },
      { label: 'Toggle Fullscreen Area', op: 'screen.screen_full_area', props: { use_hide_panels: true } },
    ];
  }

  // ---------------------------------------------------------------- sidebar (N)

  private sidebarPanels(): PanelDef[] {
    const t = () => this.tree();
    const act = () => { const tr = t(); return tr ? findNode(tr, tr.active) ?? null : null; };
    const gen = this.treeGen;
    const P: PanelDef[] = [];
    P.push({
      id: 'node', label: 'Node', poll: () => !!act(), key: () => `${act()?.name}|${gen}`,
      draw: (l) => {
        const n = act()!;
        l.prop({ kind: 'string', name: 'Name', description: 'Unique node identifier', undo: 'Rename Node', get: () => act()?.name ?? '', set: (v) => { const tr = t(), nn = act(); if (tr && nn) renameNode(tr, nn, v); } });
        l.prop(sprop(() => act(), 'label', { name: 'Label', description: 'Optional custom node label', undo: 'Change Label' }));
        const c = l.column();
        const r = c.row();
        r.prop(bprop(() => act(), 'useCustomColor', { name: 'Color', description: 'Use custom color for the node', notify: ['data'] }));
        if (n.useCustomColor) r.prop({ kind: 'color', name: 'Color', get: () => (act()?.color ?? [0.608, 0.608, 0.608]).slice(), set: (v) => { const nn = act(); if (nn) nn.color = [v[0], v[1], v[2]]; }, notify: ['data'] }, { text: '' });
        l.prop(bprop(() => act(), 'hide', { name: 'Hide', description: 'Collapse the node', notify: ['data'] }));
        l.prop(bprop(() => act(), 'mute', { name: 'Mute', description: 'Pass the input through without processing', notify: ['data'] }));
      },
    });
    P.push({
      id: 'properties', label: 'Properties', poll: () => !!act(), key: () => `${act()?.name}|${gen}|${JSON.stringify(Object.entries(act()?.props ?? {}).filter(([, v]) => typeof v === 'string' || typeof v === 'boolean'))}|${JSON.stringify(t()?.links.filter((l) => l.toNode === act()?.name).map((l) => l.toSocket))}`,
      draw: (l) => {
        const n = act()!;
        const d = nodeType(n.type);
        const tr = t()!;
        const draw = d?.drawExt ?? d?.draw;
        if (draw) draw(l, n, { tree: tr, sidebar: true });
        const ins = nodeInputs(n).filter((s) => !linkTo(tr, n.name, s.id) && !s.hideValue);
        if (ins.length) {
          l.label('Inputs:');
          for (const s of ins) this.socketValueWidget(l.row(), n, s, true);
        }
      },
    });
    P.push({
      id: 'backdrop', label: 'Backdrop', poll: () => this.treeType === 'COMPOSITING',
      drawHeader: (l) => { l.prop({ kind: 'bool', name: '', get: () => !!this.state.showBackdrop, set: (v) => { this.state.showBackdrop = v; this.rebuildHeader(true); this.drawBg(); }, undo: false }); },
      draw: (l) => {
        l.active = !!this.state.showBackdrop;
        l.prop({ kind: 'enum', name: 'Draw Channels', items: [{ id: 'COLOR_ALPHA', label: 'Color and Alpha' }, { id: 'COLOR', label: 'Color' }, { id: 'ALPHA', label: 'Alpha' }], get: () => String(this.state.backdropChannels), set: (v) => { this.state.backdropChannels = v; this.drawBg(); }, undo: false }, { expand: true });
        l.prop({ kind: 'float', name: 'Zoom', min: 0.01, max: 10, get: () => this.state.backdropZoom as number, set: (v) => { this.state.backdropZoom = v; this.drawBg(); }, undo: false });
        const c = l.column(true);
        c.label('Offset:');
        c.prop({ kind: 'float', name: 'X', get: () => this.state.backdropX as number, set: (v) => { this.state.backdropX = v; this.drawBg(); }, undo: false });
        c.prop({ kind: 'float', name: 'Y', get: () => this.state.backdropY as number, set: (v) => { this.state.backdropY = v; this.drawBg(); }, undo: false });
        l.operator('node.backimage_fit', { text: 'Fit' });
      },
    });
    return P;
  }
}

function renameNode(t: NodeTree, n: BNode, name: string): void {
  const nn = name.trim();
  if (!nn || nn === n.name) return;
  const unique = t.nodes.some((x) => x !== n && x.name === nn) ? `${nn}.001` : nn;
  for (const l of t.links) { if (l.fromNode === n.name) l.fromNode = unique; if (l.toNode === n.name) l.toNode = unique; }
  for (const k of t.nodes) if (k.parent === n.name) k.parent = unique;
  if (t.active === n.name) t.active = unique;
  n.name = unique;
}

// ------------------------------------------------------------------ menus

export function addMenuItems(ed: NodeEditor | null): MenuItem[] {
  const tt = ed?.treeType ?? 'COMPOSITING';
  const def = treeType(tt);
  if (!def) return [];
  const types = nodeTypesFor(tt).filter((d) => !d.poll || d.poll());
  const cats = def.categories();
  return [
    { label: 'Search ...', icon: 'VIEWZOOM', action: () => searchAdd(ed) },
    { type: 'separator' },
    ...cats.map((c): MenuItem => {
      const list = types.filter((d) => d.category === c.id);
      return {
        type: 'submenu', label: c.label, disabled: !list.length,
        items: () => list.map((d) => ({ label: d.label, disabled: !!d.unavailable, description: d.unavailable ? 'Not available in blender-web' : d.description, action: () => void app.callOperator('node.add_node', { type: d.id, use_transform: true }, { area: ed?.area ?? null }) })),
      };
    }),
  ];
}

function searchAdd(ed: NodeEditor | null): void {
  const tt = ed?.treeType ?? 'COMPOSITING';
  void import('../ui/menu').then(({ showSearchMenu }) => {
    showSearchMenu(() => nodeTypesFor(tt).filter((d) => !d.unavailable && (!d.poll || d.poll())).map((d) => ({ label: d.label, detail: treeType(tt)?.categories().find((c) => c.id === d.category)?.label, action: () => void app.callOperator('node.add_node', { type: d.id, use_transform: true }, { area: ed?.area ?? null }) })), app.mouse, 'Search nodes');
  });
}

function selectMenu(): MenuItem[] {
  return [
    { label: 'Border Select', op: 'node.select_border' },
    { type: 'separator' },
    { label: '(De)select All', op: 'node.select_all', props: { action: 'TOGGLE' } },
    { label: 'Inverse', op: 'node.select_all', props: { action: 'INVERT' } },
    { label: 'Linked From', op: 'node.select_linked_from' },
    { label: 'Linked To', op: 'node.select_linked_to' },
    { label: 'Grouped by Type', op: 'node.select_grouped', props: { type: 'TYPE' } },
    { label: 'Grouped by Color', op: 'node.select_grouped', props: { type: 'COLOR' } },
  ];
}

function nodeMenu(): MenuItem[] {
  return [
    { label: 'Move', op: 'node.translate_attach' },
    { type: 'separator' },
    { label: 'Duplicate', op: 'node.duplicate_move' },
    { label: 'Delete', op: 'node.delete' },
    { label: 'Delete with Reconnect', op: 'node.delete_reconnect' },
    { type: 'separator' },
    { label: 'Join in New Frame', op: 'node.join' },
    { label: 'Remove from Frame', op: 'node.detach' },
    { type: 'separator' },
    { label: 'Make Links', op: 'node.link_make', props: { replace: false } },
    { label: 'Make and Replace Links', op: 'node.link_make', props: { replace: true } },
    { label: 'Cut Links', op: 'node.links_cut' },
    { label: 'Detach Links', op: 'node.links_detach' },
    { type: 'separator' },
    { label: 'Toggle Node Mute', op: 'node.mute_toggle' },
    { label: 'Collapse', op: 'node.hide_toggle' },
    { label: 'Toggle Hidden Node Sockets', op: 'node.hide_socket_toggle' },
    { label: 'Toggle Node Options', op: 'node.options_toggle' },
    { type: 'separator' },
    { label: 'Read Render Layers', op: 'node.read_renderlayers' },
  ];
}

// ------------------------------------------------------------------ operators

function editorOf(ctx: OpContext): NodeEditor | null {
  const ed = ctx.area?.editor;
  return ed instanceof NodeEditor ? ed : null;
}

function treeOf(ctx: OpContext): NodeTree | null { return editorOf(ctx)?.tree() ?? null; }
const hasTree = (ctx: OpContext) => !!treeOf(ctx);
const hasSel = (ctx: OpContext) => !!treeOf(ctx)?.nodes.some((n) => n.select);

function selected(t: NodeTree): BNode[] { return t.nodes.filter((n) => n.select); }

function done(ctx: OpContext): void { editorOf(ctx)?.treeChanged(); }

/** Modal grab of the selected nodes. */
function startGrab(ctx: OpContext, def: OperatorDef, props: OpProps, onCancel?: () => void): OpResult {
  const ed = editorOf(ctx);
  const t = treeOf(ctx);
  if (!ed || !t) return 'CANCELLED';
  // nodes inside selected frames move with them
  const moving = new Set(selected(t).map((n) => n.name));
  for (const n of t.nodes) if (n.parent && moving.has(n.parent)) moving.add(n.name);
  const nodes = t.nodes.filter((n) => moving.has(n.name));
  if (!nodes.length) return 'CANCELLED';
  const start = nodes.map((n) => [n.location[0], n.location[1]] as [number, number]);
  const m0 = ed.eventPos({ clientX: app.mouse.x, clientY: app.mouse.y });
  const release = !!props.release_confirm;
  let dx = 0, dy = 0;
  const apply = (snap: boolean) => {
    nodes.forEach((n, i) => {
      let x = start[i][0] + dx, y = start[i][1] + dy;
      if (snap) { x = Math.round(x / 20) * 20; y = Math.round(y / 20) * 20; }
      n.location = [x, y];
    });
    ed.updatePositions();
  };
  const handler: ModalHandler = {
    status: () => `Move: D: ${dx.toFixed(0)}, ${dy.toFixed(0)}  (Ctrl: snap to grid)`,
    cursor: 'move',
    cancel: () => { nodes.forEach((n, i) => { n.location = start[i]; }); app.endModal(handler); ed.updatePositions(); onCancel?.(); },
    onEvent: (e) => {
      if (e.type === 'pointermove') {
        const pe = e as PointerEvent;
        const p = ed.eventPos(pe);
        dx = (p[0] - m0[0]) / ed.zoom; dy = -(p[1] - m0[1]) / ed.zoom;
        apply(pe.ctrlKey);
        return true;
      }
      const finish = () => {
        app.endModal(handler);
        // attach to / detach from a frame under the mouse when moving single nodes
        app.finishOperator(def, { ...props, value: [dx, dy] }, ctx);
        done(ctx);
      };
      if (e.type === 'pointerup' && release) { finish(); return true; }
      if (e.type === 'pointerdown') {
        const b = (e as PointerEvent).button;
        if (b === 0) finish(); else if (b === 2) handler.cancel();
        return true;
      }
      if (e.type === 'keydown') {
        const k = (e as KeyboardEvent).key;
        if (k === 'Enter' || k === ' ') finish();
        else if (k === 'Escape') handler.cancel();
        return true;
      }
      return e.type !== 'wheel';
    },
  };
  app.startModal(handler);
  return 'RUNNING_MODAL';
}

function nodeOps(): OperatorDef[] {
  const poll = (ctx: OpContext) => !!editorOf(ctx);
  const ops: OperatorDef[] = [];
  const op = (d: OperatorDef) => { ops.push(d); return d; };

  op({
    id: 'node.select', label: 'Select', description: 'Select the node under the cursor', undo: true,
    props: { node: { name: 'Node', type: 'string', default: '', hidden: true }, extend: { name: 'Extend', type: 'bool', default: false } },
    poll: hasTree,
    exec: (ctx, p) => {
      const t = treeOf(ctx)!;
      const n = findNode(t, String(p.node));
      if (!p.extend) for (const k of t.nodes) k.select = false;
      if (n) {
        if (p.extend && n.select && t.active === n.name) n.select = false;
        else { n.select = true; t.active = n.name; setActiveViewer(t, n); }
      }
      editorOf(ctx)?.updatePositions();
      if (n && n.type.endsWith('Viewer')) done(ctx);
      return 'FINISHED';
    },
  });

  op({
    id: 'node.select_all', label: '(De)select All', description: '(De)select all nodes', undo: true,
    props: { action: { name: 'Action', type: 'enum', default: 'TOGGLE', items: [['TOGGLE', 'Toggle'], ['SELECT', 'Select'], ['DESELECT', 'Deselect'], ['INVERT', 'Invert']] } },
    poll: hasTree,
    exec: (ctx, p) => {
      const t = treeOf(ctx)!;
      let action = String(p.action);
      if (action === 'TOGGLE') action = t.nodes.some((n) => n.select) ? 'DESELECT' : 'SELECT';
      for (const n of t.nodes) n.select = action === 'SELECT' ? true : action === 'DESELECT' ? false : !n.select;
      editorOf(ctx)?.updatePositions();
      return 'FINISHED';
    },
  });

  const box = op({
    id: 'node.select_border', label: 'Border Select', description: 'Use box selection to select nodes', undo: true,
    props: { tweak: { name: 'Tweak', type: 'bool', default: false, hidden: true }, extend: { name: 'Extend', type: 'bool', default: false }, startX: { name: 'x', type: 'float', default: 0, hidden: true }, startY: { name: 'y', type: 'float', default: 0, hidden: true } },
    poll: hasTree,
    invoke: (ctx, p) => {
      const ed = editorOf(ctx)!;
      const t = treeOf(ctx)!;
      const ns = 'http://www.w3.org/2000/svg';
      const rect = document.createElementNS(ns, 'rect');
      rect.setAttribute('fill', 'rgba(255,255,255,0.05)');
      rect.setAttribute('stroke', '#000');
      rect.setAttribute('stroke-dasharray', '3 3');
      const cross = document.createElementNS(ns, 'path');
      cross.setAttribute('stroke', 'rgba(0,0,0,0.5)');
      cross.setAttribute('stroke-dasharray', '2 2');
      ed.overlay.append(rect, cross);
      let start: [number, number] | null = p.tweak ? ed.eventPos({ clientX: Number(p.startX), clientY: Number(p.startY) }) : null;
      let cur = ed.eventPos({ clientX: app.mouse.x, clientY: app.mouse.y });
      let deselect = false;
      const draw = () => {
        if (start) {
          rect.setAttribute('x', String(Math.min(start[0], cur[0]))); rect.setAttribute('y', String(Math.min(start[1], cur[1])));
          rect.setAttribute('width', String(Math.abs(cur[0] - start[0]))); rect.setAttribute('height', String(Math.abs(cur[1] - start[1])));
          cross.setAttribute('d', '');
        } else {
          rect.setAttribute('width', '0');
          cross.setAttribute('d', `M${cur[0]} 0 V${ed.region.clientHeight} M0 ${cur[1]} H${ed.region.clientWidth}`);
        }
      };
      draw();
      const finish = () => {
        rect.remove(); cross.remove();
        app.endModal(handler);
        if (!start) return;
        const x0 = Math.min(start[0], cur[0]), x1 = Math.max(start[0], cur[0]), y0 = Math.min(start[1], cur[1]), y1 = Math.max(start[1], cur[1]);
        if (!p.extend && !deselect && p.tweak) for (const n of t.nodes) n.select = false;
        for (const n of t.nodes) {
          const r = ed.nodeScreenRect(n);
          if (!r) continue;
          if (r.right >= x0 && r.left <= x1 && r.bottom >= y0 && r.top <= y1) n.select = !deselect;
        }
        ed.updatePositions();
        app.finishOperator(box, p, ctx);
      };
      const handler: ModalHandler = {
        status: () => 'Border select: LMB drag to select, Shift/MMB to deselect, RMB/Esc cancel',
        cancel: () => { rect.remove(); cross.remove(); app.endModal(handler); },
        onEvent: (e) => {
          if (e.type === 'pointermove') { cur = ed.eventPos(e as PointerEvent); draw(); return true; }
          if (e.type === 'pointerdown') {
            const pe = e as PointerEvent;
            if (pe.button === 2 && !start) { handler.cancel(); return true; }
            if (!start) { start = ed.eventPos(pe); deselect = pe.button === 1 || pe.shiftKey; draw(); }
            return true;
          }
          if (e.type === 'pointerup') { if (start) finish(); return true; }
          if (e.type === 'keydown' && (e as KeyboardEvent).key === 'Escape') { handler.cancel(); return true; }
          return true;
        },
      };
      app.startModal(handler);
      return 'RUNNING_MODAL';
    },
  });

  op({
    id: 'node.select_linked_from', label: 'Select Linked From', description: 'Select nodes linked from the selected ones', undo: true, poll: hasSel,
    exec: (ctx) => { const t = treeOf(ctx)!; const s = new Set(selected(t).map((n) => n.name)); for (const l of t.links) if (s.has(l.toNode)) { const n = findNode(t, l.fromNode); if (n) n.select = true; } editorOf(ctx)?.updatePositions(); return 'FINISHED'; },
  });
  op({
    id: 'node.select_linked_to', label: 'Select Linked To', description: 'Select nodes linked to the selected ones', undo: true, poll: hasSel,
    exec: (ctx) => { const t = treeOf(ctx)!; const s = new Set(selected(t).map((n) => n.name)); for (const l of t.links) if (s.has(l.fromNode)) { const n = findNode(t, l.toNode); if (n) n.select = true; } editorOf(ctx)?.updatePositions(); return 'FINISHED'; },
  });
  op({
    id: 'node.select_grouped', label: 'Select Grouped', description: 'Select nodes with similar properties', undo: true, poll: hasSel,
    props: { type: { name: 'Type', type: 'enum', default: 'TYPE', items: [['TYPE', 'Type'], ['COLOR', 'Color'], ['PREFIX', 'Prefix'], ['SUFFIX', 'Suffix']] } },
    exec: (ctx, p) => {
      const t = treeOf(ctx)!;
      const a = findNode(t, t.active) ?? selected(t)[0];
      if (!a) return 'CANCELLED';
      for (const n of t.nodes) {
        if (p.type === 'TYPE' && n.type === a.type) n.select = true;
        if (p.type === 'COLOR' && JSON.stringify(n.color ?? null) === JSON.stringify(a.color ?? null) && !!n.useCustomColor === !!a.useCustomColor) n.select = true;
        if (p.type === 'PREFIX' && n.name.split('.')[0] === a.name.split('.')[0]) n.select = true;
      }
      editorOf(ctx)?.updatePositions();
      return 'FINISHED';
    },
  });

  const grab = op({
    id: 'node.translate_attach', label: 'Move', description: 'Move nodes and attach them to frames', undo: true, register: true,
    props: { release_confirm: { name: 'Confirm on Release', type: 'bool', default: false, hidden: true }, button: { name: 'b', type: 'int', default: 0, hidden: true }, value: { name: 'Vector', type: 'vector', default: [0, 0], size: 2 } },
    poll: hasSel,
    invoke: (ctx, p) => startGrab(ctx, grab, p),
    exec: (ctx, p) => { const t = treeOf(ctx)!; const v = p.value as number[]; for (const n of selected(t)) n.location = [n.location[0] + v[0], n.location[1] + v[1]]; done(ctx); return 'FINISHED'; },
  });

  op({
    id: 'node.delete', label: 'Delete', description: 'Delete selected nodes', undo: true, register: true, poll: hasSel,
    exec: (ctx) => { const t = treeOf(ctx)!; removeNodes(t, new Set(selected(t).map((n) => n.name))); done(ctx); return 'FINISHED'; },
  });
  op({
    id: 'node.delete_reconnect', label: 'Delete with Reconnect', description: 'Delete nodes; will reconnect nodes as if deletion was muted', undo: true, register: true, poll: hasSel,
    exec: (ctx) => { const t = treeOf(ctx)!; removeNodes(t, new Set(selected(t).map((n) => n.name)), true); done(ctx); return 'FINISHED'; },
  });

  const dup = op({
    id: 'node.duplicate_move', label: 'Duplicate', description: 'Duplicate selected nodes and move them', undo: true, register: true, poll: hasSel,
    invoke: (ctx, p) => {
      const t = treeOf(ctx)!;
      duplicateSelected(t);
      editorOf(ctx)!.update();
      app.notify('data');
      return startGrab(ctx, dup, { ...p, release_confirm: false }, () => { app.undo(); });
    },
    exec: (ctx) => { const t = treeOf(ctx)!; duplicateSelected(t); done(ctx); return 'FINISHED'; },
  });

  const add = op({
    id: 'node.add_node', label: 'Add Node', description: 'Add a node to the active tree', undo: true, register: true,
    props: { type: { name: 'Node Type', type: 'string', default: '' }, use_transform: { name: 'Use Transform', type: 'bool', default: false } },
    poll: hasTree,
    invoke: (ctx, p) => {
      const ed = editorOf(ctx)!;
      const t = treeOf(ctx)!;
      const d = nodeType(String(p.type));
      if (!d || d.unavailable) return 'CANCELLED';
      for (const n of t.nodes) n.select = false;
      const [mx, my] = ed.mouseNode();
      const n = createNode(t, d.id, [Math.round(mx - (d.width ?? 140) / 2), Math.round(my + 10)]);
      n.select = true;
      t.active = n.name;
      if (d.single) for (const o of t.nodes) if (o !== n && o.type === n.type) o.mute = true;
      ed.update();
      done(ctx);
      if (!p.use_transform) return 'FINISHED';
      app.pushUndo(add.label);
      app.report('OPERATOR', `bpy.ops.node.add_node(type='${d.id}', use_transform=True)`);
      return startGrab(ctx, grab, { release_confirm: false });
    },
    exec: (ctx, p) => {
      const t = treeOf(ctx)!;
      const n = createNode(t, String(p.type), [0, 0]);
      for (const o of t.nodes) o.select = o === n;
      t.active = n.name;
      done(ctx);
      return 'FINISHED';
    },
  });

  op({
    id: 'node.mute_toggle', label: 'Toggle Node Mute', description: 'Toggle muting of the nodes', undo: true, register: true, poll: hasSel,
    exec: (ctx) => { for (const n of selected(treeOf(ctx)!)) n.mute = !n.mute; done(ctx); return 'FINISHED'; },
  });
  op({
    id: 'node.hide_toggle', label: 'Hide', description: 'Toggle hiding of selected nodes', undo: true, register: true,
    props: { node: { name: 'Node', type: 'string', default: '', hidden: true } },
    poll: hasTree,
    exec: (ctx, p) => {
      const t = treeOf(ctx)!;
      const list = p.node ? [findNode(t, String(p.node))].filter((x): x is BNode => !!x) : selected(t);
      if (!list.length) return 'CANCELLED';
      const v = !list.some((n) => n.hide);
      for (const n of list) n.hide = v;
      done(ctx);
      return 'FINISHED';
    },
  });
  op({
    id: 'node.hide_socket_toggle', label: 'Toggle Hidden Node Sockets', description: 'Toggle unused node socket display', undo: true, register: true, poll: hasSel,
    exec: (ctx) => {
      const t = treeOf(ctx)!;
      const sel = selected(t);
      const anyHidden = sel.some((n) => (n.hiddenSockets ?? []).length);
      for (const n of sel) {
        if (anyHidden) { delete n.hiddenSockets; continue; }
        const used = new Set([...t.links.filter((l) => l.toNode === n.name).map((l) => l.toSocket), ...t.links.filter((l) => l.fromNode === n.name).map((l) => l.fromSocket)]);
        n.hiddenSockets = [...nodeInputs(n), ...nodeOutputs(n)].map((s) => s.id).filter((id) => !used.has(id));
      }
      done(ctx);
      return 'FINISHED';
    },
  });
  op({
    id: 'node.options_toggle', label: 'Toggle Node Options', description: 'Toggle option buttons display for selected nodes', undo: true, register: true, poll: hasSel,
    exec: (ctx) => { const sel = selected(treeOf(ctx)!); const v = sel.some((n) => n.showOptions !== false); for (const n of sel) n.showOptions = !v; done(ctx); return 'FINISHED'; },
  });

  op({
    id: 'node.link_make', label: 'Make Links', description: 'Makes a link between selected output in input sockets', undo: true, register: true,
    props: { replace: { name: 'Replace', type: 'bool', default: false, description: 'Replace socket connections with the new links' } },
    poll: (ctx) => (treeOf(ctx)?.nodes.filter((n) => n.select).length ?? 0) >= 2,
    exec: (ctx, p) => {
      const t = treeOf(ctx)!;
      const sel = selected(t).filter((n) => nodeType(n.type)?.special !== 'FRAME').sort((a, b) => a.location[0] - b.location[0]);
      let made = 0;
      for (let i = 0; i < sel.length - 1; i++) {
        const a = sel[i], b = sel[i + 1];
        const outs = nodeOutputs(a);
        if (!outs.length) continue;
        const out = outs[0];
        const inp = bestInput(b, out.type, t, !p.replace);
        if (!inp) continue;
        if (!p.replace && linkTo(t, b.name, inp.id)) continue;
        if (addLink(t, a.name, out.id, b.name, inp.id)) made++;
      }
      if (!made) return 'CANCELLED';
      done(ctx);
      return 'FINISHED';
    },
  });

  op({
    id: 'node.links_detach', label: 'Detach Links', description: 'Remove all links to selected nodes, and try to connect neighbor nodes together', undo: true, register: true, poll: hasSel,
    exec: (ctx) => {
      const t = treeOf(ctx)!;
      const s = new Set(selected(t).map((n) => n.name));
      for (const n of s) {
        const inl = t.links.find((l) => l.toNode === n && !s.has(l.fromNode));
        if (inl) for (const o of t.links.filter((l) => l.fromNode === n && !s.has(l.toNode))) t.links.push({ fromNode: inl.fromNode, fromSocket: inl.fromSocket, toNode: o.toNode, toSocket: o.toSocket });
      }
      t.links = t.links.filter((l) => !(s.has(l.fromNode) !== s.has(l.toNode)));
      done(ctx);
      return 'FINISHED';
    },
  });

  const cut = op({
    id: 'node.links_cut', label: 'Cut Links', description: 'Use the mouse to cut (remove) some links', undo: true, register: true, poll: hasTree,
    invoke: (ctx, p) => {
      const ed = editorOf(ctx)!;
      const t = treeOf(ctx)!;
      const ns = 'http://www.w3.org/2000/svg';
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('stroke', '#fff');
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke-dasharray', '4 3');
      ed.overlay.append(path);
      const pts: [number, number][] = [ed.eventPos({ clientX: app.mouse.x, clientY: app.mouse.y })];
      const segX = (a: [number, number], b: [number, number], c: [number, number], d: [number, number]) => {
        const cr = (o: [number, number], u: [number, number], v: [number, number]) => (u[0] - o[0]) * (v[1] - o[1]) - (u[1] - o[1]) * (v[0] - o[0]);
        return cr(a, b, c) * cr(a, b, d) < 0 && cr(c, d, a) * cr(c, d, b) < 0;
      };
      const handler: ModalHandler = {
        status: () => 'Cut links: drag with Ctrl+RMB',
        cursor: 'crosshair',
        cancel: () => { path.remove(); app.endModal(handler); },
        onEvent: (e) => {
          if (e.type === 'pointermove') { pts.push(ed.eventPos(e as PointerEvent)); path.setAttribute('d', `M${pts.map((q) => q.join(' ')).join(' L')}`); return true; }
          if (e.type === 'pointerup' || (e.type === 'keydown' && (e as KeyboardEvent).key === 'Enter')) {
            path.remove();
            app.endModal(handler);
            const kill = new Set<object>();
            for (const { link, pts: lp } of ed.linkPolylines()) {
              outer: for (let i = 0; i < pts.length - 1; i++) for (let j = 0; j < lp.length - 1; j++) if (segX(pts[i], pts[i + 1], lp[j], lp[j + 1])) { kill.add(link); break outer; }
            }
            if (kill.size) { t.links = t.links.filter((l) => !kill.has(l)); app.finishOperator(cut, p, ctx); done(ctx); }
            return true;
          }
          if (e.type === 'keydown' && (e as KeyboardEvent).key === 'Escape') { handler.cancel(); return true; }
          return true;
        },
      };
      app.startModal(handler);
      return 'RUNNING_MODAL';
    },
  });

  const link = op({
    id: 'node.link', label: 'Link Nodes', description: 'Use the mouse to create a link between two nodes', undo: true,
    props: { node: { name: 'Node', type: 'string', default: '', hidden: true }, socket: { name: 'Socket', type: 'string', default: '', hidden: true }, side: { name: 'Side', type: 'string', default: 'out', hidden: true } },
    poll: hasTree,
    invoke: (ctx, p) => {
      const ed = editorOf(ctx)!;
      const t = treeOf(ctx)!;
      let fromSide = String(p.side) as 'in' | 'out';
      let anchorNode = String(p.node), anchorSock = String(p.socket);
      // dragging a linked input picks up its link (re-route)
      if (fromSide === 'in') {
        const existing = linkTo(t, anchorNode, anchorSock);
        if (existing) {
          t.links = t.links.filter((l) => l !== existing);
          anchorNode = existing.fromNode; anchorSock = existing.fromSocket; fromSide = 'out';
          ed.drawLinks();
        }
      }
      const anchorNodeDef = findNode(t, anchorNode);
      const anchorType = anchorNodeDef ? socketDef(anchorNodeDef, anchorSock, fromSide)?.type ?? 'RGBA' : 'RGBA';
      const ns = 'http://www.w3.org/2000/svg';
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('stroke', '#fff');
      path.setAttribute('stroke-width', '2');
      path.setAttribute('fill', 'none');
      ed.overlay.append(path);
      const anchor = () => { const sp = ed.sockPos(anchorNode, fromSide, anchorSock); return sp ? [sp[0] * ed.zoom + ed.panX, sp[1] * ed.zoom + ed.panY] as [number, number] : [0, 0] as [number, number]; };
      let cur = ed.eventPos({ clientX: app.mouse.x, clientY: app.mouse.y });
      const draw = () => {
        const a = anchor();
        const near = ed.socketNear(cur[0], cur[1], fromSide === 'out' ? 'in' : 'out');
        let b = cur;
        if (near) { const sp = ed.sockPos(near.node, near.side, near.id); if (sp) b = [sp[0] * ed.zoom + ed.panX, sp[1] * ed.zoom + ed.panY]; }
        path.setAttribute('d', fromSide === 'out' ? NodeEditor.curve(a[0], a[1], b[0], b[1]) : NodeEditor.curve(b[0], b[1], a[0], a[1]));
      };
      draw();
      ed.isLinkModal = true;
      const end = () => { path.remove(); app.endModal(handler); ed.isLinkModal = false; };
      const handler: ModalHandler = {
        status: () => 'Link: release over a socket to connect',
        cursor: 'crosshair',
        cancel: () => { end(); ed.update(); },
        onEvent: (e) => {
          if (e.type === 'pointermove') { cur = ed.eventPos(e as PointerEvent); draw(); return true; }
          if (e.type === 'pointerup') {
            end();
            const pe = e as PointerEvent;
            const pos = ed.eventPos(pe);
            let target = ed.socketNear(pos[0], pos[1], fromSide === 'out' ? 'in' : 'out');
            if (!target) {
              // dropped onto a node body: pick the best matching socket
              const el = document.elementFromPoint(pe.clientX, pe.clientY) as HTMLElement | null;
              const nodeEl = el?.closest('.bnode') as HTMLElement | null;
              const n = nodeEl ? findNode(t, nodeEl.dataset.node) : undefined;
              if (n && n.name !== anchorNode) {
                if (fromSide === 'out') { const s = bestInput(n, anchorType, t); if (s) target = { node: n.name, side: 'in', id: s.id, type: s.type, rx: 0, ry: 0 }; }
                else { const s = nodeOutputs(n).find((o) => o.type === anchorType) ?? nodeOutputs(n)[0]; if (s) target = { node: n.name, side: 'out', id: s.id, type: s.type, rx: 0, ry: 0 }; }
              }
            }
            let ok = false;
            if (target) ok = fromSide === 'out' ? addLink(t, anchorNode, anchorSock, target.node, target.id) : addLink(t, target.node, target.id, anchorNode, anchorSock);
            const changedLinks = ok || String(p.side) === 'in';
            if (changedLinks) { app.finishOperator(link, p, ctx); done(ctx); }
            ed.update();
            return true;
          }
          if (e.type === 'keydown' && (e as KeyboardEvent).key === 'Escape') { handler.cancel(); return true; }
          return true;
        },
      };
      app.startModal(handler);
      return 'RUNNING_MODAL';
    },
  });

  op({
    id: 'node.link_viewer', label: 'Link to Viewer Node', description: 'Link to viewer node', undo: true, register: true,
    props: { node: { name: 'Node', type: 'string', default: '', hidden: true } },
    poll: (ctx) => editorOf(ctx)?.treeType === 'COMPOSITING' && hasTree(ctx),
    exec: (ctx, p) => {
      const t = treeOf(ctx)!;
      const n = findNode(t, String(p.node)) ?? findNode(t, t.active);
      if (!n) return 'CANCELLED';
      const outs = nodeOutputs(n);
      if (!outs.length) return 'CANCELLED';
      let viewer = t.nodes.find((v) => v.type === 'CompositorNodeViewer' && v.props.is_active_output) ?? t.nodes.find((v) => v.type === 'CompositorNodeViewer');
      if (!viewer) { viewer = createNode(t, 'CompositorNodeViewer', [n.location[0] + n.width + 60, n.location[1]]); viewer.select = false; }
      // cycle through the outputs on repeated use
      const cur = linkTo(t, viewer.name, 'Image');
      let idx = 0;
      if (cur && cur.fromNode === n.name) idx = (outs.findIndex((o) => o.id === cur.fromSocket) + 1) % outs.length;
      addLink(t, n.name, outs[idx].id, viewer.name, 'Image');
      setActiveViewer(t, viewer);
      done(ctx);
      return 'FINISHED';
    },
  });

  op({
    id: 'node.view_all', label: 'View All', description: 'Resize view so you can see all nodes', poll,
    exec: (ctx) => { editorOf(ctx)!.viewAll(); return 'FINISHED'; },
  });
  op({
    id: 'node.view_selected', label: 'Frame Selected', description: 'Resize view so you can see selected nodes', poll: hasSel,
    exec: (ctx) => { editorOf(ctx)!.viewAll(true, true); return 'FINISHED'; },
  });
  op({
    id: 'node.backimage_zoom', label: 'Background Image Zoom', description: 'Zoom in/out the background image',
    props: { factor: { name: 'Factor', type: 'float', default: 1.2 } },
    poll: (ctx) => editorOf(ctx)?.treeType === 'COMPOSITING',
    exec: (ctx, p) => { const ed = editorOf(ctx)!; ed.state.backdropZoom = Math.max(0.01, Math.min(10, (ed.state.backdropZoom as number) * Number(p.factor))); ed.drawBg(); return 'FINISHED'; },
  });
  op({
    id: 'node.backimage_fit', label: 'Background Image Fit', description: 'Fit the background image to the view',
    poll: (ctx) => editorOf(ctx)?.treeType === 'COMPOSITING',
    exec: (ctx) => {
      const ed = editorOf(ctx)!;
      const img = viewerCanvas;
      ed.state.backdropX = 0; ed.state.backdropY = 0;
      if (img) ed.state.backdropZoom = Math.min(ed.region.clientWidth / img.width, ed.region.clientHeight / img.height) * 0.95;
      ed.drawBg();
      return 'FINISHED';
    },
  });

  op({
    id: 'node.join', label: 'Join Nodes', description: 'Attach selected nodes to a new common frame', undo: true, register: true, poll: hasSel,
    exec: (ctx) => {
      const t = treeOf(ctx)!;
      const sel = selected(t).filter((n) => nodeType(n.type)?.special !== 'FRAME');
      if (!sel.length) return 'CANCELLED';
      const f = createNode(t, 'NodeFrame', [Math.min(...sel.map((n) => n.location[0])) - 20, Math.max(...sel.map((n) => n.location[1])) + 40], false);
      t.nodes.unshift(f);
      for (const n of sel) n.parent = f.name;
      for (const n of t.nodes) n.select = n === f;
      t.active = f.name;
      done(ctx);
      return 'FINISHED';
    },
  });
  op({
    id: 'node.detach', label: 'Detach Nodes', description: 'Detach selected nodes from parents', undo: true, register: true, poll: hasSel,
    exec: (ctx) => { for (const n of selected(treeOf(ctx)!)) n.parent = null; done(ctx); return 'FINISHED'; },
  });
  op({
    id: 'node.read_renderlayers', label: 'Read Render Layers', description: 'Read all render layers of all used scenes', poll: (ctx) => editorOf(ctx)?.treeType === 'COMPOSITING',
    exec: () => { scheduleRecomposite(0); return 'FINISHED'; },
  });
  op({
    id: 'node.image_open', label: 'Open Image', description: 'Open image or movie for the Image node', undo: true, register: true,
    props: { node: { name: 'Node', type: 'string', default: '', hidden: true } },
    poll: hasTree,
    exec: async (ctx, p) => {
      const t = treeOf(ctx);
      const f = await pickFile('image/*,video/*');
      if (!f || !t) return 'CANCELLED';
      const md = await importMedia([f]);
      if (!md) return 'CANCELLED';
      const n = findNode(t, String(p.node)) ?? findNode(t, t.active);
      if (n && (n.type === 'CompositorNodeImage')) n.props.image = md.id;
      done(ctx);
      return 'FINISHED';
    },
  });
  op({
    id: 'node.properties', label: 'Properties', description: 'Toggle the properties region visibility', poll,
    exec: (ctx) => { const ed = editorOf(ctx)!; ed.state.showSidebar = !ed.state.showSidebar; ed.updateSidebarVisibility(); return 'FINISHED'; },
  });
  op({
    id: 'node.add_menu', label: 'Add', description: 'Add a node', poll: hasTree,
    exec: (ctx) => { showMenu(addMenuItems(editorOf(ctx)), app.mouse, { title: 'Add', atMouse: true, area: ctx.area }); return 'CANCELLED'; },
  });
  op({
    id: 'node.use_nodes', label: 'Use Nodes', description: 'Enable the node tree of the scene or the active material', undo: true, register: true,
    props: { tree: { name: 'Tree Type', type: 'enum', default: 'COMPOSITING', items: [['COMPOSITING', 'Compositing'], ['SHADER', 'Shader']] } },
    exec: (_ctx, p) => {
      if (p.tree === 'SHADER') {
        const m = activeMaterialOf();
        if (!m) return 'CANCELLED';
        m.useNodes = !m.useNodes;
        if (m.useNodes && !m.nodeTree) m.nodeTree = buildDefaultTree('SHADER');
        const md = app.meshOf(app.activeObject); if (md) app.tagGeometry(md.id);
      } else {
        const s = app.scene;
        s.useNodes = !s.useNodes;
        if (s.useNodes && !s.nodeTree) s.nodeTree = buildDefaultTree('COMPOSITING');
        scheduleRecomposite(0);
      }
      return 'FINISHED';
    },
  });
  return ops;
}

export const NODE_OPERATORS: OperatorDef[] = nodeOps();

registerEditor({ type: NodeEditor.TYPE, label: 'Node Editor', icon: 'NODETREE', create: (area, state) => new NodeEditor(area, state) });
