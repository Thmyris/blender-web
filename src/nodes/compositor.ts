// Compositor: evaluates the scene's compositing node tree on the CPU (linear float RGBA, premultiplied
// alpha) after an F12 render when Render > Post Processing > Compositing is on, and keeps the result
// up to date while nodes are edited. Also produces the "Viewer Node" image shown as the node editor
// backdrop and in the UV/Image editor.

import { app } from '../app';
import type { BNode, NodeTree } from '../core/edtypes';
import { renderListeners, renderResult } from '../render/render';
import { canvasToImg, channelsOf, convert, imgToCanvas, isImg, newImg, type Img, type Val } from './cmp_buffers';
import { cmpExec, treeIsTimeDependent, type CmpCtx } from './cmp_nodes';
import { findNode, linkTo, nodeInputs, nodeOutputs, nodeType } from './nodes';
import { mediaListeners } from '../media/media';

// ------------------------------------------------------------------ results

/** The Viewer node image (straight alpha canvas), or null. */
export let viewerCanvas: HTMLCanvasElement | null = null;
export const viewerListeners = new Set<() => void>();

/** Last raw render of the scene (input of the Render Layers node). */
let lastRender: { img: Img; w: number; h: number } | null = null;
/** Canvas the compositor last placed into the render result. */
let lastOutput: HTMLCanvasElement | null = null;
let lastError = '';

export function compositingEnabled(): boolean {
  const s = app.scene;
  return !!(s.useNodes && s.nodeTree && s.render.useCompositing);
}

function activeViewer(tree: NodeTree): BNode | undefined {
  const viewers = tree.nodes.filter((n) => (n.type === 'CompositorNodeViewer' || n.type === 'CompositorNodeSplitViewer') && !n.mute);
  return viewers.find((n) => n.props.is_active_output) ?? viewers[0];
}

/** Mark a viewer node as the active output (clicking a viewer, Ctrl+Shift+LMB). */
export function setActiveViewer(tree: NodeTree, node: BNode): void {
  if (node.type !== 'CompositorNodeViewer' && node.type !== 'CompositorNodeSplitViewer') return;
  for (const n of tree.nodes) if (n.props.is_active_output) n.props.is_active_output = false;
  node.props.is_active_output = true;
}

function zero(ch: number): Val { return { c: new Array<number>(ch).fill(0) }; }

/** Evaluate the outputs needed by the Composite and the active Viewer node. */
export function evaluateTree(tree: NodeTree, ctx: CmpCtx): void {
  const memo = new Map<string, Val[]>();
  const visiting = new Set<string>();
  const evalNode = (node: BNode): Val[] => {
    const hit = memo.get(node.name);
    if (hit) return hit;
    if (visiting.has(node.name)) return nodeOutputs(node).map((s) => zero(channelsOf(s.type)));
    visiting.add(node.name);
    const isReroute = nodeType(node.type)?.special === 'REROUTE';
    const ins: Val[] = nodeInputs(node).map((s) => {
      const link = linkTo(tree, node.name, s.id);
      if (link) {
        const from = findNode(tree, link.fromNode);
        if (from) {
          const outs = evalNode(from);
          const idx = nodeOutputs(from).findIndex((o) => o.id === link.fromSocket);
          const v = outs[idx];
          if (v) return isReroute ? v : convert(v, channelsOf(s.type));
        }
      }
      const d = node.inputs[s.id] ?? s.default ?? 0;
      const arr = Array.isArray(d) ? d.slice() : [Number(d)];
      return convert({ c: arr }, channelsOf(s.type));
    });
    const outDefs = nodeOutputs(node);
    let outs: Val[];
    const exec = cmpExec.get(node.type);
    if (node.mute || !exec) {
      // muted / unsupported nodes pass the first input of a matching type through
      const inDefs = nodeInputs(node);
      outs = outDefs.map((o) => {
        const i = inDefs.findIndex((s) => s.type === o.type);
        const j = i >= 0 ? i : 0;
        return ins[j] ? convert(ins[j], channelsOf(o.type)) : zero(channelsOf(o.type));
      });
      if (exec && node.mute && (node.type === 'CompositorNodeComposite' || node.type === 'CompositorNodeViewer')) outs = [];
    } else {
      try { outs = exec(node, ins, ctx); } catch (err) { console.error(err); lastError = `${node.name}: ${(err as Error).message}`; outs = []; }
    }
    // pad missing outputs
    outs = outDefs.map((o, i) => outs[i] ?? zero(channelsOf(o.type)));
    visiting.delete(node.name);
    memo.set(node.name, outs);
    return outs;
  };
  const comp = tree.nodes.find((n) => n.type === 'CompositorNodeComposite' && !n.mute);
  if (comp) evalNode(comp);
  const viewer = activeViewer(tree);
  ctx.activeViewer = viewer?.name ?? null;
  if (viewer) evalNode(viewer);
}

/** Place an image into a w x h canvas (centred, like Blender's compositor output). */
function fitTo(img: Img, w: number, h: number): Img {
  if (img.w === w && img.h === h) return img;
  const out = newImg(w, h, 4);
  const ox = (img.w - w) >> 1, oy = (img.h - h) >> 1;
  for (let y = 0; y < h; y++) {
    const sy = y + oy;
    if (sy < 0 || sy >= img.h) continue;
    for (let x = 0; x < w; x++) {
      const sx = x + ox;
      if (sx < 0 || sx >= img.w) continue;
      for (let c = 0; c < 4; c++) out.data[(y * w + x) * 4 + c] = img.data[(sy * img.w + sx) * 4 + c];
    }
  }
  return out;
}

function renderSizeNow(): { w: number; h: number } {
  const rs = app.scene.render;
  const pct = rs.resolutionPercentage / 100;
  return { w: Math.max(4, Math.round(rs.resolutionX * pct)), h: Math.max(4, Math.round(rs.resolutionY * pct)) };
}

function makeCtx(): CmpCtx {
  const size = lastRender ? { w: lastRender.w, h: lastRender.h } : renderSizeNow();
  return {
    scene: app.scene, renderLayer: lastRender?.img ?? null, renderZ: null, rw: size.w, rh: size.h, frame: app.scene.frameCurrent,
    composite: null, viewer: null, activeViewer: null,
  };
}

function updateViewer(ctx: CmpCtx): void {
  if (ctx.viewer) {
    const img = ctx.viewer.img.ch === 4 ? ctx.viewer.img : (convert({ img: ctx.viewer.img }, 4) as { img: Img }).img;
    viewerCanvas = imgToCanvas(img, ctx.viewer.alpha, viewerCanvas && viewerCanvas.width === img.w && viewerCanvas.height === img.h ? viewerCanvas : undefined);
  } else viewerCanvas = null;
  for (const l of viewerListeners) l();
}

/** Run the compositor and return the composited canvas (or null when there is no Composite output). */
function run(): HTMLCanvasElement | null {
  const tree = app.scene.nodeTree;
  if (!tree || !app.scene.useNodes) { viewerCanvas = null; for (const l of viewerListeners) l(); return null; }
  const ctx = makeCtx();
  lastError = '';
  evaluateTree(tree, ctx);
  if (lastError) app.report('ERROR', `Compositor: ${lastError}`);
  updateViewer(ctx);
  if (!ctx.composite) return null;
  const img = fitTo(ctx.composite.img, ctx.rw, ctx.rh);
  const transparent = app.scene.render.alphaMode === 'TRANSPARENT';
  return imgToCanvas(img, ctx.composite.alpha && transparent);
}

/** Render pipeline hook: composite a freshly rendered frame. */
export function compositeFrame(raw: HTMLCanvasElement): HTMLCanvasElement {
  lastRender = { img: canvasToImg(raw), w: raw.width, h: raw.height };
  if (!compositingEnabled()) { lastOutput = null; return raw; }
  const tree = app.scene.nodeTree!;
  if (!tree.nodes.some((n) => n.type === 'CompositorNodeComposite')) {
    app.report('WARNING', 'No render output node in scene');
    run();
    lastOutput = null;
    return raw;
  }
  const out = run();
  lastOutput = out;
  lastKey = treeKey();
  return out ?? raw;
}

// ------------------------------------------------------------------ live updates while editing nodes

let lastKey = '';
let timer = 0;

function treeKey(): string {
  const s = app.scene;
  return JSON.stringify([s.id, s.useNodes, s.render.useCompositing, s.render.alphaMode, s.nodeTree ?? null, s.nodeTree && treeIsTimeDependent(s.nodeTree) ? s.frameCurrent : 0]);
}

/** Re-evaluate after a change (debounced). */
export function scheduleRecomposite(delay = 120): void {
  window.clearTimeout(timer);
  timer = window.setTimeout(recompositeNow, delay);
}

export function recompositeNow(): void {
  lastKey = treeKey();
  const out = run();
  const rr = renderResult;
  if (rr && lastRender && rr.label === 'Render Result' && (rr.canvas === lastOutput || (lastOutput === null && compositingEnabled()))) {
    if (out && compositingEnabled()) { rr.canvas = out; lastOutput = out; }
    else if (!compositingEnabled() && lastOutput) {
      // compositing switched off: show the plain render again
      rr.canvas = imgToCanvas(lastRender.img, app.scene.render.alphaMode === 'TRANSPARENT');
      lastOutput = null;
    }
    for (const l of renderListeners) l();
  }
  app.notify('view');
}

/** Install the change listeners (called once the app exists). */
export function initCompositor(): void {
  app.onChange((flags) => {
    if (flags.size === 1 && (flags.has('view') || flags.has('reports'))) return;
    const s = app.scene;
    if (!s.nodeTree && !lastKey) return;
    const k = treeKey();
    if (k === lastKey) return;
    lastKey = k;
    scheduleRecomposite(app.playing ? 0 : 120);
  });
  mediaListeners.add(() => { if (app.scene.useNodes && app.scene.nodeTree && treeIsTimeDependent(app.scene.nodeTree)) scheduleRecomposite(60); });
}

export function hasRenderLayer(): boolean { return !!lastRender; }
export function isImgVal(v: Val): boolean { return isImg(v); }
