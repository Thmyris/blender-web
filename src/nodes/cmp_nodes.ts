// Compositing node types (Blender 2.79 compositor): sockets, settings, inline buttons and the
// per-node image operations used by the evaluator in compositor.ts.

import { app } from '../app';
import type { BNode, NodeTree } from '../core/edtypes';
import type { Scene } from '../core/types';
import { bprop, eprop, fprop, iprop, type Layout } from '../ui/layout';
import {
  BLEND_MODES, bilinear, blendRGB, blur, bw, canvasToImg, clamp01, constOf, convert, convolve3, copyImg, curveLUT, defaultColorRamp,
  defaultCurveMapping, evalColorRamp, hsvToRgb, isImg, lutEval, mapPixels, nearest, newImg, rgbToHsv, type BlurFilter, type ColorRampData,
  type CurveMapping, type Img, type Val,
} from './cmp_buffers';
import { createNode, defaultTreeBuilders, newNodeTree, registerNodeType, registerTreeType, type NodeTypeDef, type SocketDef } from './nodes';
import { colorRampWidget, curveMappingWidget } from './widgets';
import { getMedia, mediaColl, mediaImage, mediaVideo, frameCount } from '../media/media';

// ------------------------------------------------------------------ evaluation context

export interface CmpCtx {
  scene: Scene;
  /** Render result of the scene (linear, premultiplied) or null when nothing was rendered. */
  renderLayer: Img | null;
  renderZ: Img | null;
  /** Render size (for nodes that need a canvas when all inputs are constant). */
  rw: number;
  rh: number;
  frame: number;
  composite: { img: Img; alpha: boolean } | null;
  viewer: { img: Img; alpha: boolean } | null;
  activeViewer: string | null;
}

/** Set by the renderer integration when a depth pass is available. */
let zAvailable = false;
export function renderZAvailable(): boolean { return zAvailable; }
export function setRenderZAvailable(v: boolean): void { zAvailable = v; }

export type CmpExec = (node: BNode, ins: Val[], ctx: CmpCtx) => Val[];
export const cmpExec = new Map<string, CmpExec>();

function def(d: NodeTypeDef & { exec?: CmpExec }): void {
  const { exec, ...rest } = d;
  registerNodeType(rest);
  if (exec) cmpExec.set(d.id, exec);
}

// ------------------------------------------------------------------ socket helpers

const RGBA = (id: string, name = id, d: number[] = [0.8, 0.8, 0.8, 1]): SocketDef => ({ id, name, type: 'RGBA', default: d });
const VAL = (id: string, name = id, d = 0, min?: number, max?: number, slider = false): SocketDef => ({ id, name, type: 'VALUE', default: d, min, max, slider });
const VEC = (id: string, name = id, d: number[] = [0, 0, 0]): SocketDef => ({ id, name, type: 'VECTOR', default: d });
const OUT = (id: string, type: SocketDef['type'] = 'RGBA', name = id): SocketDef => ({ id, name, type });
const FAC = (d = 1): SocketDef => ({ id: 'Fac', name: 'Fac', type: 'VALUE', default: d, min: 0, max: 1, slider: true });

const items = (list: [string, string][]) => list.map(([id, label]) => ({ id, label }));
const P = (node: BNode) => () => node.props;

function pEnum(l: Layout, node: BNode, key: string, name: string, list: [string, string][], noLabel = true): void {
  l.prop(eprop(P(node), key, items(list), { name, notify: ['data'] }), { noLabel });
}
function pBool(l: Layout, node: BNode, key: string, name: string, description?: string): void {
  l.prop(bprop(P(node), key, { name, description, notify: ['data'] }));
}
function pFloat(l: Layout, node: BNode, key: string, name: string, o: { min?: number; max?: number; slider?: boolean; step?: number; precision?: number; unit?: 'ROTATION' | 'PERCENTAGE' | 'PIXEL' | 'FACTOR' } = {}, index?: number): void {
  l.prop(fprop(P(node), key, { name, min: o.min, max: o.max, step: o.step, precision: o.precision ?? 3, unit: o.unit, notify: ['data'] }, index), { slider: o.slider });
}
function pInt(l: Layout, node: BNode, key: string, name: string, min?: number, max?: number): void {
  l.prop(iprop(P(node), key, { name, min, max, notify: ['data'] }));
}

function num(v: Val, fallback = 0): number { return constOf(v, [fallback])[0] ?? fallback; }

function canvasSize(ins: Val[], ctx: CmpCtx): { w: number; h: number } {
  for (const v of ins) if (isImg(v)) return { w: v.img.w, h: v.img.h };
  return { w: ctx.rw, h: ctx.rh };
}

/** Make an image filled with a constant (for nodes that need pixels). */
function fill(c: number[], w: number, h: number): Img {
  const img = newImg(w, h, c.length);
  for (let i = 0; i < w * h; i++) for (let k = 0; k < c.length; k++) img.data[i * c.length + k] = c[k];
  return img;
}

function asImg(v: Val, ch: number, ctx: CmpCtx): Img {
  const c = convert(v, ch);
  return isImg(c) ? c.img : fill(c.c, ctx.rw, ctx.rh);
}

/** Lerp result towards input by fac (per pixel). */
function mixFac(orig: Val, result: Val, fac: Val): Val {
  return mapPixels([fac, orig, result], [1, 4, 4], [4], (p, o) => {
    const f = p[0][0], a = p[1], b = p[2];
    for (let i = 0; i < 4; i++) o[0][i] = a[i] + (b[i] - a[i]) * f;
  })[0];
}

// ------------------------------------------------------------------ tree type

registerTreeType({
  id: 'COMPOSITING', label: 'Compositing', icon: 'NODE_COMPOSITING', description: 'Compositing nodes',
  categories: () => [
    { id: 'INPUT', label: 'Input' }, { id: 'OUTPUT', label: 'Output' }, { id: 'COLOR', label: 'Color' }, { id: 'CONVERTER', label: 'Converter' },
    { id: 'FILTER', label: 'Filter' }, { id: 'VECTOR', label: 'Vector' }, { id: 'MATTE', label: 'Matte' }, { id: 'DISTORT', label: 'Distort' },
    { id: 'GROUP', label: 'Group' }, { id: 'LAYOUT', label: 'Layout' },
  ],
});

/** "Use Nodes" default: Render Layers -> Composite (and a Viewer). */
defaultTreeBuilders.push({
  tree: 'COMPOSITING',
  build: () => {
    const t = newNodeTree('COMPOSITING');
    const rl = createNode(t, 'CompositorNodeRLayers', [-200, 300]);
    const co = createNode(t, 'CompositorNodeComposite', [200, 300]);
    const vi = createNode(t, 'CompositorNodeViewer', [200, 120]);
    for (const n of t.nodes) n.select = false;
    t.links.push({ fromNode: rl.name, fromSocket: 'Image', toNode: co.name, toSocket: 'Image' });
    t.links.push({ fromNode: rl.name, fromSocket: 'Image', toNode: vi.name, toSocket: 'Image' });
    t.active = co.name;
    return t;
  },
});

// ------------------------------------------------------------------ Input

def({
  id: 'CompositorNodeRLayers', label: 'Render Layers', tree: 'COMPOSITING', category: 'INPUT', width: 170,
  description: 'Input render passes from a scene render',
  inputs: [], outputs: (): SocketDef[] => (renderZAvailable() ? [OUT('Image'), OUT('Alpha', 'VALUE'), OUT('Z', 'VALUE')] : [OUT('Image'), OUT('Alpha', 'VALUE')]),
  init: (n) => { n.props.scene = app.scene.id; n.props.layer = 'RenderLayer'; },
  draw: (l, n) => {
    l.prop(eprop(P(n), 'scene', () => app.doc.scenes.map((s) => ({ id: s.id, label: s.name, icon: 'SCENE_DATA' })), { name: 'Scene', notify: ['data'] }), { noLabel: true, icon: 'SCENE_DATA' });
    const r = l.row(true);
    r.prop(eprop(P(n), 'layer', [{ id: 'RenderLayer', label: 'RenderLayer', icon: 'RENDERLAYERS' }], { name: 'Layer', notify: ['data'] }), { noLabel: true });
    r.operator('render.render', { iconOnly: true, icon: 'RENDER_STILL', props: { animation: false } });
  },
  exec: (_n, _ins, ctx) => {
    if (!ctx.renderLayer) return [{ c: [0, 0, 0, 0] }, { c: [0] }, { c: [1e10] }];
    const img = ctx.renderLayer;
    const alpha = newImg(img.w, img.h, 1);
    for (let i = 0; i < img.w * img.h; i++) alpha.data[i] = img.data[i * 4 + 3];
    return [{ img }, { img: alpha }, ctx.renderZ ? { img: ctx.renderZ } : { c: [1e10] }];
  },
});

const imageCache = new WeakMap<object, { w: number; h: number; img: Img }>();
function elementImg(el: HTMLImageElement | HTMLVideoElement, key?: number): Img {
  const hit = imageCache.get(el);
  const w = (el as HTMLVideoElement).videoWidth || (el as HTMLImageElement).naturalWidth;
  const hh = (el as HTMLVideoElement).videoHeight || (el as HTMLImageElement).naturalHeight;
  if (hit && hit.w === w && hit.h === hh && key === undefined) return hit.img;
  const img = canvasToImg(el);
  if (key === undefined) imageCache.set(el, { w, h: hh, img });
  return img;
}

def({
  id: 'CompositorNodeImage', label: 'Image', tree: 'COMPOSITING', category: 'INPUT', width: 170,
  description: 'Input an image or a movie',
  inputs: [], outputs: [OUT('Image'), OUT('Alpha', 'VALUE')],
  init: (n) => { n.props.image = null; n.props.frame_offset = 0; n.props.frame_start = 1; n.props.use_cyclic = false; },
  draw: (l, n) => {
    l.idTemplate({
      icon: 'IMAGE_DATA', title: 'Image',
      items: () => Object.values(mediaColl()).filter((m) => m.kind !== 'SOUND').map((m) => ({ id: m.id, name: m.name, icon: m.kind === 'MOVIE' ? 'FILE_MOVIE' : 'IMAGE_DATA' })),
      get: () => (n.props.image as string | null) ?? null,
      set: (id) => { n.props.image = id; },
      name: () => getMedia(n.props.image as string)?.name ?? '',
      rename: (name) => { const m = getMedia(n.props.image as string); if (m) m.name = name; },
      onNew: () => void app.callOperator('node.image_open', { node: n.name }),
      newLabel: 'Open',
      unlink: () => { n.props.image = null; },
    });
    const md = getMedia(n.props.image as string);
    if (md && (md.kind === 'MOVIE' || md.files)) {
      const c = l.column(true);
      c.prop(iprop(P(n), 'frame_start', { name: 'Start Frame', notify: ['data'] }));
      c.prop(iprop(P(n), 'frame_offset', { name: 'Offset', notify: ['data'] }));
      l.prop(bprop(P(n), 'use_cyclic', { name: 'Cyclic', notify: ['data'] }));
    }
  },
  exec: (n, _ins, ctx) => {
    const md = getMedia(n.props.image as string);
    if (!md) return [{ c: [0, 0, 0, 0] }, { c: [0] }];
    let img: Img | null = null;
    const total = frameCount(md, ctx.scene.fps / (ctx.scene.fpsBase || 1));
    let fi = ctx.frame - Number(n.props.frame_start ?? 1) + Number(n.props.frame_offset ?? 0);
    if (n.props.use_cyclic) fi = ((fi % total) + total) % total;
    fi = Math.max(0, Math.min(total - 1, fi));
    if (md.kind === 'IMAGE') {
      const el = mediaImage(md, fi);
      if (el) img = elementImg(el);
    } else if (md.kind === 'MOVIE') {
      const v = mediaVideo(md);
      if (v && v.readyState >= 2) {
        const t = fi / (md.fps || 25);
        if (Math.abs(v.currentTime - t) > 0.5 / (md.fps || 25)) v.currentTime = t;
        img = elementImg(v, fi);
      }
    }
    if (!img) return [{ c: [0, 0, 0, 0] }, { c: [0] }];
    const alpha = newImg(img.w, img.h, 1);
    for (let i = 0; i < img.w * img.h; i++) alpha.data[i] = img.data[i * 4 + 3];
    return [{ img }, { img: alpha }];
  },
});

def({
  id: 'CompositorNodeRGB', label: 'RGB', tree: 'COMPOSITING', category: 'INPUT', width: 140,
  inputs: [], outputs: [OUT('RGBA', 'RGBA', 'RGBA')],
  init: (n) => { n.props.color = [0.5, 0.5, 0.5, 1]; },
  draw: (l, n) => { l.prop({ kind: 'color', name: 'Color', alpha: true, get: () => (n.props.color as number[]).slice(), set: (v) => { n.props.color = [v[0], v[1], v[2], v[3] ?? 1]; }, notify: ['data'] }, { text: '' }).style.height = '60px'; },
  exec: (n) => [{ c: (n.props.color as number[]).slice(0, 4) }],
});

def({
  id: 'CompositorNodeValue', label: 'Value', tree: 'COMPOSITING', category: 'INPUT', width: 140,
  inputs: [], outputs: [OUT('Value', 'VALUE')],
  init: (n) => { n.props.value = 0.5; },
  draw: (l, n) => pFloat(l, n, 'value', '', { precision: 3 }),
  exec: (n) => [{ c: [Number(n.props.value ?? 0)] }],
});

def({
  id: 'CompositorNodeTime', label: 'Time', tree: 'COMPOSITING', category: 'INPUT', width: 200,
  inputs: [], outputs: [OUT('Fac', 'VALUE')],
  init: (n) => { n.props.frame_start = 1; n.props.frame_end = 250; n.props.curve = defaultCurveMapping(1); },
  draw: (l, n) => {
    curveMappingWidget(l, () => n.props.curve as CurveMapping, ['']);
    const r = l.row(true);
    r.prop(iprop(P(n), 'frame_start', { name: 'Sta', notify: ['data'] }));
    r.prop(iprop(P(n), 'frame_end', { name: 'End', notify: ['data'] }));
  },
  exec: (n, _i, ctx) => {
    const s = Number(n.props.frame_start), e = Number(n.props.frame_end);
    const t = e > s ? clamp01((ctx.frame - s) / (e - s)) : 0;
    return [{ c: [lutEval(curveLUT((n.props.curve as CurveMapping).curves[0]), t)] }];
  },
});

def({
  id: 'CompositorNodeMovieClip', label: 'Movie Clip', tree: 'COMPOSITING', category: 'INPUT', width: 170,
  inputs: [], outputs: [OUT('Image'), OUT('Alpha', 'VALUE')],
  init: (n) => { n.props.clip = null; },
  draw: (l, n) => {
    l.prop(eprop(P(n), 'clip', () => [{ id: '', label: '' }, ...Object.values(app.doc.clips ?? {}).map((c) => ({ id: c.id, label: c.name, icon: 'CLIP' }))], { name: 'Clip', notify: ['data'] }), { noLabel: true, icon: 'CLIP' });
  },
  exec: (n, _i, ctx) => {
    const clip = app.doc.clips?.[n.props.clip as string];
    const md = getMedia(clip?.media);
    if (!clip || !md) return [{ c: [0, 0, 0, 0] }, { c: [0] }];
    const fi = Math.max(0, ctx.frame - clip.frameStart + clip.frameOffset);
    let img: Img | null = null;
    if (md.kind === 'IMAGE') { const el = mediaImage(md, fi); if (el) img = elementImg(el); }
    else { const v = mediaVideo(md); if (v && v.readyState >= 2) img = elementImg(v, fi); }
    if (!img) return [{ c: [0, 0, 0, 0] }, { c: [0] }];
    const alpha = newImg(img.w, img.h, 1);
    for (let i = 0; i < img.w * img.h; i++) alpha.data[i] = img.data[i * 4 + 3];
    return [{ img }, { img: alpha }];
  },
});

for (const [id, label] of [['CompositorNodeMask', 'Mask'], ['CompositorNodeTexture', 'Texture'], ['CompositorNodeBokehImage', 'Bokeh Image'], ['CompositorNodeTrackPos', 'Track Position']] as [string, string][]) {
  def({ id, label, tree: 'COMPOSITING', category: 'INPUT', unavailable: true, inputs: [], outputs: [OUT('Image')] });
}

// ------------------------------------------------------------------ Output

function outputExec(target: 'composite' | 'viewer') {
  return (n: BNode, ins: Val[], ctx: CmpCtx): Val[] => {
    let img = asImg(ins[0], 4, ctx);
    const alphaLinked = !!ctx.scene.nodeTree?.links.some((l) => l.toNode === n.name && l.toSocket === 'Alpha');
    if (alphaLinked) {
      img = copyImg(img);
      const a = convert(ins[1], 1);
      const tmp = [0];
      for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
        if (isImg(a)) { const ai = a.img; const sx = x + ((ai.w - img.w) >> 1), sy = y + ((ai.h - img.h) >> 1); tmp[0] = sx >= 0 && sy >= 0 && sx < ai.w && sy < ai.h ? ai.data[sy * ai.w + sx] : 0; }
        else tmp[0] = a.c[0];
        img.data[(y * img.w + x) * 4 + 3] = tmp[0];
      }
    }
    const res = { img, alpha: n.props.use_alpha !== false };
    if (target === 'composite') ctx.composite = res;
    else if (!ctx.activeViewer || ctx.activeViewer === n.name) ctx.viewer = res;
    return [];
  };
}

def({
  id: 'CompositorNodeComposite', label: 'Composite', tree: 'COMPOSITING', category: 'OUTPUT', single: true,
  inputs: [RGBA('Image', 'Image', [0, 0, 0, 1]), VAL('Alpha', 'Alpha', 1, 0, 1), VAL('Z', 'Z', 1)], outputs: [],
  init: (n) => { n.props.use_alpha = true; },
  draw: (l, n) => pBool(l, n, 'use_alpha', 'Use Alpha', 'Colors are treated alpha premultiplied, or colors output straight (alpha gets set to 1)'),
  exec: outputExec('composite'),
});

def({
  id: 'CompositorNodeViewer', label: 'Viewer', tree: 'COMPOSITING', category: 'OUTPUT',
  inputs: [RGBA('Image', 'Image', [0, 0, 0, 1]), VAL('Alpha', 'Alpha', 1, 0, 1), VAL('Z', 'Z', 1)], outputs: [],
  init: (n) => { n.props.use_alpha = true; },
  draw: (l, n) => pBool(l, n, 'use_alpha', 'Use Alpha', 'Colors are treated alpha premultiplied, or colors output straight (alpha gets set to 1)'),
  exec: outputExec('viewer'),
});

def({
  id: 'CompositorNodeSplitViewer', label: 'Split Viewer', tree: 'COMPOSITING', category: 'OUTPUT',
  inputs: [RGBA('Image'), RGBA('Image_001', 'Image')], outputs: [],
  init: (n) => { n.props.axis = 'X'; n.props.factor = 50; },
  draw: (l, n) => {
    l.prop(eprop(P(n), 'axis', items([['X', 'X'], ['Y', 'Y']]), { name: 'Axis', notify: ['data'] }), { expand: true });
    l.prop(iprop(P(n), 'factor', { name: 'Factor', min: 0, max: 100, notify: ['data'] }), { slider: true });
  },
  exec: (n, ins, ctx) => {
    const a = asImg(ins[0], 4, ctx), b = asImg(ins[1], 4, ctx);
    const out = newImg(a.w, a.h, 4);
    const f = Number(n.props.factor) / 100;
    const tmp = [0, 0, 0, 0];
    for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) {
      const useA = n.props.axis === 'Y' ? y / a.h > f : x / a.w <= f;
      const o = (y * a.w + x) * 4;
      if (useA) for (let c = 0; c < 4; c++) out.data[o + c] = a.data[o + c];
      else { nearest(b, x + (b.w - a.w) / 2 + 0.5, y + (b.h - a.h) / 2 + 0.5, tmp); for (let c = 0; c < 4; c++) out.data[o + c] = tmp[c]; }
    }
    if (!ctx.activeViewer || ctx.activeViewer === n.name) ctx.viewer = { img: out, alpha: true };
    return [];
  },
});

def({
  id: 'CompositorNodeLevels', label: 'Levels', tree: 'COMPOSITING', category: 'OUTPUT',
  inputs: [RGBA('Image', 'Image', [0, 0, 0, 1])], outputs: [OUT('Mean', 'VALUE'), OUT('Std Dev', 'VALUE', 'Std Dev')],
  init: (n) => { n.props.channel = 'COMBINED_RGB'; },
  draw: (l, n) => pEnum(l, n, 'channel', 'Channel', [['COMBINED_RGB', 'C'], ['RED', 'R'], ['GREEN', 'G'], ['BLUE', 'B'], ['LUMINANCE', 'L']]),
  exec: (n, ins) => {
    const v = convert(ins[0], 4);
    const val = (r: number, g: number, b: number) => {
      switch (n.props.channel) {
        case 'RED': return r;
        case 'GREEN': return g;
        case 'BLUE': return b;
        case 'LUMINANCE': return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        default: return (r + g + b) / 3;
      }
    };
    if (!isImg(v)) { const m = val(v.c[0], v.c[1], v.c[2]); return [{ c: [m] }, { c: [0] }]; }
    const d = v.img.data, n2 = v.img.w * v.img.h;
    let s = 0, s2 = 0;
    for (let i = 0; i < n2; i++) { const x = val(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]); s += x; s2 += x * x; }
    const mean = s / Math.max(1, n2);
    return [{ c: [mean] }, { c: [Math.sqrt(Math.max(0, s2 / Math.max(1, n2) - mean * mean))] }];
  },
});

def({ id: 'CompositorNodeOutputFile', label: 'File Output', tree: 'COMPOSITING', category: 'OUTPUT', unavailable: true, inputs: [RGBA('Image')], outputs: [] });

// ------------------------------------------------------------------ Color

def({
  id: 'CompositorNodeMixRGB', label: 'Mix', tree: 'COMPOSITING', category: 'COLOR',
  inputs: [FAC(1), RGBA('Image'), RGBA('Image_001', 'Image')], outputs: [OUT('Image')],
  init: (n) => { n.props.blend_type = 'MIX'; n.props.use_alpha = false; n.props.use_clamp = false; },
  dynLabel: (n) => BLEND_MODES.find((b) => b[0] === n.props.blend_type)?.[1] ?? 'Mix',
  draw: (l, n) => {
    pEnum(l, n, 'blend_type', 'Blend Type', BLEND_MODES);
    const r = l.row(true);
    r.prop(bprop(P(n), 'use_alpha', { name: '', description: 'Include alpha of second input in this operation', notify: ['data'] }), { iconOnly: true, icon: 'IMAGE_RGB_ALPHA' });
    r.prop(bprop(P(n), 'use_clamp', { name: 'Clamp', description: 'Clamp result of the node to 0..1 range', notify: ['data'] }));
  },
  exec: (n, ins) => {
    const mode = String(n.props.blend_type), useAlpha = !!n.props.use_alpha, clampR = !!n.props.use_clamp;
    return mapPixels(ins, [1, 4, 4], [4], (p, o) => {
      const a = p[1], b = p[2], out = o[0];
      let f = p[0][0];
      if (useAlpha) f *= b[3];
      out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; out[3] = a[3];
      blendRGB(mode, out, b, f);
      if (clampR) for (let i = 0; i < 3; i++) out[i] = clamp01(out[i]);
    });
  },
});

def({
  id: 'CompositorNodeAlphaOver', label: 'Alpha Over', tree: 'COMPOSITING', category: 'COLOR',
  inputs: [FAC(1), RGBA('Image'), RGBA('Image_001', 'Image')], outputs: [OUT('Image')],
  init: (n) => { n.props.use_premultiply = false; n.props.premul = 0; },
  draw: (l, n) => {
    pBool(l, n, 'use_premultiply', 'Convert Premul', 'Mix Factor');
    pFloat(l, n, 'premul', 'Premul', { min: 0, max: 1, slider: true });
  },
  exec: (n, ins) => {
    const conv = !!n.props.use_premultiply, pm = Number(n.props.premul ?? 0);
    return mapPixels(ins, [1, 4, 4], [4], (p, o) => {
      const f = p[0][0], bg = p[1], fg = p[2], out = o[0];
      if (conv) {
        // treat the foreground as straight alpha
        const a = fg[3] * f;
        for (let i = 0; i < 3; i++) out[i] = bg[i] * (1 - a) + fg[i] * a;
        out[3] = bg[3] * (1 - a) + a;
      } else if (pm > 0) {
        const a = fg[3] * f, k = 1 - (1 - pm) * a - pm * a;
        for (let i = 0; i < 3; i++) out[i] = bg[i] * Math.max(0, 1 - a * (1 - pm) - pm * a) + fg[i] * f;
        out[3] = bg[3] * Math.max(0, k) + fg[3] * f;
      } else {
        const a = fg[3] * f;
        for (let i = 0; i < 3; i++) out[i] = bg[i] * (1 - a) + fg[i] * f;
        out[3] = bg[3] * (1 - a) + fg[3] * f;
      }
    });
  },
});

def({
  id: 'CompositorNodeBrightContrast', label: 'Bright/Contrast', tree: 'COMPOSITING', category: 'COLOR',
  inputs: [RGBA('Image'), VAL('Bright', 'Bright', 0, -100, 100), VAL('Contrast', 'Contrast', 0, -100, 100)], outputs: [OUT('Image')],
  init: (n) => { n.props.use_premultiply = true; },
  draw: (l, n) => pBool(l, n, 'use_premultiply', 'Convert Premul', 'Keep output image premultiplied alpha'),
  exec: (n, ins) => mapPixels(ins, [4, 1, 1], [4], (p, o) => {
    const c = p[0], bright = p[1][0] / 100, contrast = p[2][0], out = o[0];
    let delta = contrast / 200;
    let a = 1 - delta * 2, b: number;
    if (contrast > 0) { a = 1 / Math.max(1e-6, a); b = a * (bright - delta); } else { delta = -delta; b = a * (bright + delta); }
    const al = c[3];
    const prem = !!n.props.use_premultiply && al > 0;
    for (let i = 0; i < 3; i++) {
      const v = prem ? c[i] / al : c[i];
      const r = a * v + b;
      out[i] = prem ? r * al : r;
    }
    out[3] = al;
  }),
});

def({
  id: 'CompositorNodeColorBalance', label: 'Color Balance', tree: 'COMPOSITING', category: 'COLOR', width: 400,
  inputs: [FAC(1), RGBA('Image', 'Image', [1, 1, 1, 1])], outputs: [OUT('Image')],
  init: (n) => {
    n.props.correction_method = 'LIFT_GAMMA_GAIN';
    n.props.lift = [1, 1, 1]; n.props.gamma = [1, 1, 1]; n.props.gain = [1, 1, 1];
    n.props.offset = [0, 0, 0]; n.props.power = [1, 1, 1]; n.props.slope = [1, 1, 1]; n.props.offset_basis = 0;
  },
  draw: (l, n) => {
    pEnum(l, n, 'correction_method', 'Correction Formula', [['LIFT_GAMMA_GAIN', 'Lift/Gamma/Gain'], ['OFFSET_POWER_SLOPE', 'Offset/Power/Slope (ASC-CDL)']]);
    const sp = l.split();
    const keys = n.props.correction_method === 'OFFSET_POWER_SLOPE' ? [['offset', 'Offset'], ['power', 'Power'], ['slope', 'Slope']] : [['lift', 'Lift'], ['gamma', 'Gamma'], ['gain', 'Gain']];
    for (const [k, lab] of keys) {
      const c = sp.column();
      c.label(`${lab}:`);
      const sw = c.prop({ kind: 'color', name: lab, get: () => (n.props[k] as number[]).slice(), set: (v) => { n.props[k] = [v[0], v[1], v[2]]; }, notify: ['data'], description: `Correction for ${lab.toLowerCase()}` }, { text: '' });
      sw.style.height = '40px';
      if (k === 'offset') pFloat(c, n, 'offset_basis', 'Basis', { min: -100, max: 100 });
    }
  },
  exec: (n, ins) => {
    const method = n.props.correction_method;
    const lift = n.props.lift as number[], gamma = n.props.gamma as number[], gain = n.props.gain as number[];
    const offset = n.props.offset as number[], power = n.props.power as number[], slope = n.props.slope as number[], basis = Number(n.props.offset_basis ?? 0);
    const res = mapPixels([ins[1]], [4], [4], (p, o) => {
      const c = p[0], out = o[0];
      for (let i = 0; i < 3; i++) {
        let v = c[i];
        if (method === 'OFFSET_POWER_SLOPE') {
          v = v * slope[i] + offset[i] + basis;
          v = v > 0 ? Math.pow(v, power[i]) : v;
        } else {
          // the formula used by Blender: lift is applied in display space
          const sv = v <= 0 ? 0 : Math.pow(v, 1 / 2.2);
          let x = ((sv - 1) * (2 - lift[i]) + 1) * gain[i];
          if (x < 0) x = 0;
          v = Math.pow(Math.pow(x, 2.2), 1 / Math.max(1e-5, gamma[i]));
        }
        out[i] = v;
      }
      out[3] = c[3];
    })[0];
    return [mixFac(ins[1], res, ins[0])];
  },
});

def({
  id: 'CompositorNodeGamma', label: 'Gamma', tree: 'COMPOSITING', category: 'COLOR',
  inputs: [RGBA('Image', 'Image', [1, 1, 1, 1]), VAL('Gamma', 'Gamma', 1, 0.001, 10)], outputs: [OUT('Image')],
  exec: (_n, ins) => mapPixels(ins, [4, 1], [4], (p, o) => {
    const c = p[0], g = p[1][0], out = o[0];
    for (let i = 0; i < 3; i++) out[i] = c[i] > 0 ? Math.pow(c[i], g) : c[i];
    out[3] = c[3];
  }),
});

def({
  id: 'CompositorNodeHueSat', label: 'Hue Saturation Value', tree: 'COMPOSITING', category: 'COLOR', width: 150,
  inputs: [FAC(1), RGBA('Image')], outputs: [OUT('Image')],
  init: (n) => { n.props.color_hue = 0.5; n.props.color_saturation = 1; n.props.color_value = 1; },
  draw: (l, n) => {
    const c = l.column(true);
    pFloat(c, n, 'color_hue', 'Hue', { min: 0, max: 1, slider: true });
    pFloat(c, n, 'color_saturation', 'Sat', { min: 0, max: 2, slider: true });
    pFloat(c, n, 'color_value', 'Val', { min: 0, max: 2, slider: true });
  },
  exec: (n, ins) => {
    const hs = Number(n.props.color_hue) - 0.5, sat = Number(n.props.color_saturation), val = Number(n.props.color_value);
    const hsv = [0, 0, 0];
    return mapPixels(ins, [1, 4], [4], (p, o) => {
      const f = p[0][0], c = p[1], out = o[0];
      rgbToHsv(c[0], c[1], c[2], hsv);
      hsvToRgb(hsv[0] + hs, clamp01(hsv[1] * sat), hsv[2] * val, out);
      for (let i = 0; i < 3; i++) out[i] = c[i] + (out[i] - c[i]) * f;
      out[3] = c[3];
    });
  },
});

def({
  id: 'CompositorNodeInvert', label: 'Invert', tree: 'COMPOSITING', category: 'COLOR',
  inputs: [FAC(1), RGBA('Color', 'Color', [1, 1, 1, 1])], outputs: [OUT('Color')],
  init: (n) => { n.props.invert_rgb = true; n.props.invert_alpha = false; },
  draw: (l, n) => { const r = l.row(); pBool(r, n, 'invert_rgb', 'RGB'); pBool(r, n, 'invert_alpha', 'Alpha'); },
  exec: (n, ins) => {
    const rgb = !!n.props.invert_rgb, alpha = !!n.props.invert_alpha;
    return mapPixels(ins, [1, 4], [4], (p, o) => {
      const f = p[0][0], c = p[1], out = o[0];
      for (let i = 0; i < 3; i++) out[i] = rgb ? c[i] + ((1 - c[i]) - c[i]) * f : c[i];
      out[3] = alpha ? c[3] + ((1 - c[3]) - c[3]) * f : c[3];
    });
  },
});

def({
  id: 'CompositorNodeCurveRGB', label: 'RGB Curves', tree: 'COMPOSITING', category: 'COLOR', width: 200,
  inputs: [FAC(1), RGBA('Image', 'Image', [1, 1, 1, 1]), RGBA('Black Level', 'Black Level', [0, 0, 0, 1]), RGBA('White Level', 'White Level', [1, 1, 1, 1])], outputs: [OUT('Image')],
  init: (n) => { n.props.mapping = defaultCurveMapping(4); },
  draw: (l, n) => curveMappingWidget(l, () => n.props.mapping as CurveMapping),
  exec: (n, ins) => {
    const m = n.props.mapping as CurveMapping;
    const luts = m.curves.map((c) => curveLUT(c, 512));
    const ev = (lut: Float32Array, x: number) => {
      // straight extension beyond 0..1 keeps HDR values usable
      if (x > 1) return lutEval(lut, 1) + (x - 1) * (lut[lut.length - 1] - lut[lut.length - 2]) * (lut.length - 1);
      return lutEval(lut, x);
    };
    return mapPixels(ins, [1, 4, 4, 4], [4], (p, o) => {
      const f = p[0][0], c = p[1], bl = p[2], wl = p[3], out = o[0];
      for (let i = 0; i < 3; i++) {
        const range = wl[i] - bl[i];
        let v = range !== 0 ? (c[i] - bl[i]) / range : c[i];
        v = ev(luts[i + 1], ev(luts[0], v));
        out[i] = c[i] + (v - c[i]) * f;
      }
      out[3] = c[3];
    });
  },
});

def({
  id: 'CompositorNodeZcombine', label: 'Z Combine', tree: 'COMPOSITING', category: 'COLOR',
  inputs: [RGBA('Image', 'Image', [1, 1, 1, 1]), VAL('Z', 'Z', 1, 0, 10000), RGBA('Image_001', 'Image', [1, 1, 1, 1]), VAL('Z_001', 'Z', 1, 0, 10000)],
  outputs: [OUT('Image'), OUT('Z', 'VALUE')],
  init: (n) => { n.props.use_alpha = false; n.props.use_antialias_z = true; },
  draw: (l, n) => { pBool(l, n, 'use_alpha', 'Use Alpha', 'Take alpha channel into account when doing the Z operation'); pBool(l, n, 'use_antialias_z', 'Anti-Alias Z', 'Anti-alias the z-buffer to try to avoid artifacts, mostly useful for Blender renders'); },
  exec: (n, ins) => {
    const useA = !!n.props.use_alpha;
    return mapPixels(ins, [4, 1, 4, 1], [4, 1], (p, o) => {
      const a = p[0], za = p[1][0], b = p[2], zb = p[3][0];
      const front = za <= zb ? a : b, back = za <= zb ? b : a;
      if (useA) { const al = front[3]; for (let i = 0; i < 4; i++) o[0][i] = front[i] + back[i] * (1 - al); }
      else for (let i = 0; i < 4; i++) o[0][i] = front[i];
      o[1][0] = Math.min(za, zb);
    });
  },
});

def({
  id: 'CompositorNodeTonemap', label: 'Tonemap', tree: 'COMPOSITING', category: 'COLOR', width: 160,
  inputs: [RGBA('Image', 'Image', [1, 1, 1, 1])], outputs: [OUT('Image')],
  init: (n) => { n.props.tonemap_type = 'RH_SIMPLE'; n.props.key = 0.18; n.props.offset = 1; n.props.gamma = 1; n.props.intensity = 0; n.props.contrast = 0; n.props.adaptation = 1; n.props.correction = 0; },
  draw: (l, n) => {
    pEnum(l, n, 'tonemap_type', 'Type', [['RD_PHOTORECEPTOR', 'R/D Photoreceptor'], ['RH_SIMPLE', 'Rh Simple']]);
    const c = l.column(true);
    if (n.props.tonemap_type === 'RH_SIMPLE') { pFloat(c, n, 'key', 'Key', { min: 0, max: 1 }); pFloat(c, n, 'offset', 'Offset', { min: 0.001, max: 10 }); pFloat(c, n, 'gamma', 'Gamma', { min: 0.001, max: 3 }); }
    else { pFloat(c, n, 'intensity', 'Intensity', { min: -8, max: 8 }); pFloat(c, n, 'contrast', 'Contrast', { min: 0, max: 1, slider: true }); pFloat(c, n, 'adaptation', 'Adaptation', { min: 0, max: 1, slider: true }); pFloat(c, n, 'correction', 'Color Correction', { min: 0, max: 1, slider: true }); }
  },
  exec: (n, ins) => {
    const v = convert(ins[0], 4);
    if (!isImg(v)) return [v];
    const d = v.img.data, cnt = v.img.w * v.img.h;
    let lsum = 0;
    for (let i = 0; i < cnt; i++) lsum += Math.log(Math.max(1e-5, bw(d[i * 4], d[i * 4 + 1], d[i * 4 + 2])));
    const avg = Math.exp(lsum / Math.max(1, cnt));
    const simple = n.props.tonemap_type === 'RH_SIMPLE';
    const key = simple ? Number(n.props.key) : 0.18 * Math.pow(2, Number(n.props.intensity));
    const offset = simple ? Number(n.props.offset) : 1 - Number(n.props.contrast) * 0.5;
    const gamma = simple ? Number(n.props.gamma) : 1;
    const al = key / Math.max(1e-6, avg);
    return mapPixels([v], [4], [4], (p, o) => {
      for (let i = 0; i < 3; i++) {
        let x = p[0][i] * al;
        x = x / (x + Math.max(1e-6, offset));
        o[0][i] = gamma !== 1 && x > 0 ? Math.pow(x, 1 / gamma) : x;
      }
      o[0][3] = p[0][3];
    });
  },
});

for (const [id, label] of [['CompositorNodeColorCorrection', 'Color Correction'], ['CompositorNodeHueCorrect', 'Hue Correct']] as [string, string][]) {
  def({ id, label, tree: 'COMPOSITING', category: 'COLOR', unavailable: true, inputs: [FAC(1), RGBA('Image')], outputs: [OUT('Image')] });
}

// ------------------------------------------------------------------ Converter

def({
  id: 'CompositorNodePremulKey', label: 'Alpha Convert', tree: 'COMPOSITING', category: 'CONVERTER',
  inputs: [RGBA('Image', 'Image', [1, 1, 1, 1])], outputs: [OUT('Image')],
  init: (n) => { n.props.mapping = 'STRAIGHT_TO_PREMUL'; },
  draw: (l, n) => pEnum(l, n, 'mapping', 'Mapping', [['STRAIGHT_TO_PREMUL', 'Straight to Premul'], ['PREMUL_TO_STRAIGHT', 'Premul to Straight']]),
  exec: (n, ins) => mapPixels(ins, [4], [4], (p, o) => {
    const c = p[0], a = c[3];
    const toPremul = n.props.mapping !== 'PREMUL_TO_STRAIGHT';
    for (let i = 0; i < 3; i++) o[0][i] = toPremul ? c[i] * a : a > 0 ? c[i] / a : 0;
    o[0][3] = a;
  }),
});

def({
  id: 'CompositorNodeValToRGB', label: 'ColorRamp', tree: 'COMPOSITING', category: 'CONVERTER', width: 240,
  inputs: [VAL('Fac', 'Fac', 0.5, 0, 1, true)], outputs: [OUT('Image'), OUT('Alpha', 'VALUE')],
  init: (n) => { n.props.color_ramp = defaultColorRamp(); },
  draw: (l, n) => colorRampWidget(l, () => n.props.color_ramp as ColorRampData),
  exec: (n, ins) => {
    const r = n.props.color_ramp as ColorRampData;
    return mapPixels(ins, [1], [4, 1], (p, o) => { evalColorRamp(r, p[0][0], o[0]); o[1][0] = o[0][3]; });
  },
});

export const MATH_OPS: [string, string][] = [
  ['ADD', 'Add'], ['SUBTRACT', 'Subtract'], ['MULTIPLY', 'Multiply'], ['DIVIDE', 'Divide'], ['SINE', 'Sine'], ['COSINE', 'Cosine'],
  ['TANGENT', 'Tangent'], ['ARCSINE', 'Arcsine'], ['ARCCOSINE', 'Arccosine'], ['ARCTANGENT', 'Arctangent'], ['POWER', 'Power'],
  ['LOGARITHM', 'Logarithm'], ['MINIMUM', 'Minimum'], ['MAXIMUM', 'Maximum'], ['ROUND', 'Round'], ['LESS_THAN', 'Less Than'],
  ['GREATER_THAN', 'Greater Than'], ['MODULO', 'Modulo'], ['ABSOLUTE', 'Absolute'], ['ARCTAN2', 'Arctan2'],
];

export function mathOp(op: string, a: number, b: number): number {
  switch (op) {
    case 'ADD': return a + b;
    case 'SUBTRACT': return a - b;
    case 'MULTIPLY': return a * b;
    case 'DIVIDE': return b === 0 ? 0 : a / b;
    case 'SINE': return Math.sin(a);
    case 'COSINE': return Math.cos(a);
    case 'TANGENT': return Math.tan(a);
    case 'ARCSINE': return a <= 1 && a >= -1 ? Math.asin(a) : 0;
    case 'ARCCOSINE': return a <= 1 && a >= -1 ? Math.acos(a) : 0;
    case 'ARCTANGENT': return Math.atan(a);
    case 'POWER': return a >= 0 ? Math.pow(a, b) : (Number.isInteger(b) ? Math.pow(a, b) : 0);
    case 'LOGARITHM': return a > 0 && b > 0 ? Math.log(a) / Math.log(b) : 0;
    case 'MINIMUM': return Math.min(a, b);
    case 'MAXIMUM': return Math.max(a, b);
    case 'ROUND': return Math.floor(a + 0.5);
    case 'LESS_THAN': return a < b ? 1 : 0;
    case 'GREATER_THAN': return a > b ? 1 : 0;
    case 'MODULO': return b === 0 ? 0 : a % b;
    case 'ABSOLUTE': return Math.abs(a);
    case 'ARCTAN2': return Math.atan2(a, b);
    default: return a;
  }
}

def({
  id: 'CompositorNodeMath', label: 'Math', tree: 'COMPOSITING', category: 'CONVERTER',
  inputs: [VAL('Value', 'Value', 0.5, -10000, 10000), VAL('Value_001', 'Value', 0.5, -10000, 10000)], outputs: [OUT('Value', 'VALUE')],
  init: (n) => { n.props.operation = 'ADD'; n.props.use_clamp = false; },
  dynLabel: (n) => MATH_OPS.find((m) => m[0] === n.props.operation)?.[1] ?? 'Math',
  draw: (l, n) => { pEnum(l, n, 'operation', 'Operation', MATH_OPS); pBool(l, n, 'use_clamp', 'Clamp', 'Clamp result of the node to 0..1 range'); },
  exec: (n, ins) => {
    const op = String(n.props.operation), cl = !!n.props.use_clamp;
    return mapPixels(ins, [1, 1], [1], (p, o) => { const r = mathOp(op, p[0][0], p[1][0]); o[0][0] = cl ? clamp01(r) : r; });
  },
});

def({
  id: 'CompositorNodeRGBToBW', label: 'RGB to BW', tree: 'COMPOSITING', category: 'CONVERTER',
  inputs: [RGBA('Image')], outputs: [OUT('Val', 'VALUE')],
  exec: (_n, ins) => mapPixels(ins, [4], [1], (p, o) => { o[0][0] = bw(p[0][0], p[0][1], p[0][2]); }),
});

def({
  id: 'CompositorNodeSepRGBA', label: 'Separate RGBA', tree: 'COMPOSITING', category: 'CONVERTER',
  inputs: [RGBA('Image', 'Image', [1, 1, 1, 1])], outputs: [OUT('R', 'VALUE'), OUT('G', 'VALUE'), OUT('B', 'VALUE'), OUT('A', 'VALUE')],
  exec: (_n, ins) => mapPixels(ins, [4], [1, 1, 1, 1], (p, o) => { for (let i = 0; i < 4; i++) o[i][0] = p[0][i]; }),
});

def({
  id: 'CompositorNodeCombRGBA', label: 'Combine RGBA', tree: 'COMPOSITING', category: 'CONVERTER',
  inputs: [VAL('R', 'R', 0, 0, 1), VAL('G', 'G', 0, 0, 1), VAL('B', 'B', 0, 0, 1), VAL('A', 'A', 1, 0, 1)], outputs: [OUT('Image')],
  exec: (_n, ins) => mapPixels(ins, [1, 1, 1, 1], [4], (p, o) => { for (let i = 0; i < 4; i++) o[0][i] = p[i][0]; }),
});

def({
  id: 'CompositorNodeSepHSVA', label: 'Separate HSVA', tree: 'COMPOSITING', category: 'CONVERTER',
  inputs: [RGBA('Image', 'Image', [1, 1, 1, 1])], outputs: [OUT('H', 'VALUE'), OUT('S', 'VALUE'), OUT('V', 'VALUE'), OUT('A', 'VALUE')],
  exec: (_n, ins) => {
    const hsv = [0, 0, 0];
    return mapPixels(ins, [4], [1, 1, 1, 1], (p, o) => { rgbToHsv(p[0][0], p[0][1], p[0][2], hsv); o[0][0] = hsv[0]; o[1][0] = hsv[1]; o[2][0] = hsv[2]; o[3][0] = p[0][3]; });
  },
});

def({
  id: 'CompositorNodeCombHSVA', label: 'Combine HSVA', tree: 'COMPOSITING', category: 'CONVERTER',
  inputs: [VAL('H', 'H', 0, 0, 1), VAL('S', 'S', 0, 0, 1), VAL('V', 'V', 0, 0, 1), VAL('A', 'A', 1, 0, 1)], outputs: [OUT('Image')],
  exec: (_n, ins) => mapPixels(ins, [1, 1, 1, 1], [4], (p, o) => { hsvToRgb(p[0][0], p[1][0], p[2][0], o[0]); o[0][3] = p[3][0]; }),
});

def({
  id: 'CompositorNodeSetAlpha', label: 'Set Alpha', tree: 'COMPOSITING', category: 'CONVERTER',
  inputs: [RGBA('Image', 'Image', [0, 0, 0, 1]), VAL('Alpha', 'Alpha', 1, 0, 1)], outputs: [OUT('Image')],
  exec: (_n, ins) => mapPixels(ins, [4, 1], [4], (p, o) => { for (let i = 0; i < 3; i++) o[0][i] = p[0][i]; o[0][3] = p[1][0]; }),
});

for (const [id, label] of [['CompositorNodeIDMask', 'ID Mask'], ['CompositorNodeSepYCCA', 'Separate YCbCrA'], ['CompositorNodeCombYCCA', 'Combine YCbCrA'], ['CompositorNodeSepYUVA', 'Separate YUVA'], ['CompositorNodeCombYUVA', 'Combine YUVA'], ['CompositorNodeSwitchView', 'Switch View']] as [string, string][]) {
  def({ id, label, tree: 'COMPOSITING', category: 'CONVERTER', unavailable: true, inputs: [RGBA('Image')], outputs: [OUT('Image')] });
}

// ------------------------------------------------------------------ Filter

const BLUR_FILTERS: [string, string][] = [['FLAT', 'Flat'], ['TENT', 'Tent'], ['QUAD', 'Quadratic'], ['CUBIC', 'Cubic'], ['GAUSS', 'Gaussian'], ['FAST_GAUSS', 'Fast Gaussian'], ['CATROM', 'Catrom'], ['MITCH', 'Mitch']];

function gammaWrap(img: Img, fwd: boolean): Img {
  const out = copyImg(img);
  const n = img.w * img.h;
  for (let i = 0; i < n; i++) for (let c = 0; c < Math.min(3, img.ch); c++) {
    const v = out.data[i * img.ch + c];
    out.data[i * img.ch + c] = v > 0 ? Math.pow(v, fwd ? 1 / 2.2 : 2.2) : v;
  }
  return out;
}

def({
  id: 'CompositorNodeBlur', label: 'Blur', tree: 'COMPOSITING', category: 'FILTER', width: 150,
  inputs: [RGBA('Image', 'Image', [1, 1, 1, 1]), VAL('Size', 'Size', 1, 0, 1)], outputs: [OUT('Image')],
  init: (n) => {
    Object.assign(n.props, { filter_type: 'GAUSS', use_variable_size: false, use_bokeh: false, use_gamma_correction: false, use_relative: false, aspect_correction: 'NONE', factor_x: 0, factor_y: 0, size_x: 0, size_y: 0, use_extended_bounds: false });
  },
  draw: (l, n) => {
    pEnum(l, n, 'filter_type', 'Filter Type', BLUR_FILTERS);
    pBool(l, n, 'use_variable_size', 'Variable Size', 'Support variable blur per-pixel when using an image for size input');
    pBool(l, n, 'use_bokeh', 'Bokeh', 'Use circular filter (slower)');
    pBool(l, n, 'use_gamma_correction', 'Gamma', 'Apply filter on gamma corrected values');
    pBool(l, n, 'use_relative', 'Relative', 'Use relative (percent) values to define blur radius');
    const c = l.column(true);
    if (n.props.use_relative) {
      c.label('Aspect Correction:');
      c.prop(eprop(P(n), 'aspect_correction', items([['NONE', 'None'], ['Y', 'Y'], ['X', 'X']]), { name: 'Aspect Correction', notify: ['data'] }), { expand: true });
      const c2 = l.column(true);
      pFloat(c2, n, 'factor_x', 'X', { min: 0, max: 100, unit: 'PERCENTAGE' });
      pFloat(c2, n, 'factor_y', 'Y', { min: 0, max: 100, unit: 'PERCENTAGE' });
    } else {
      pInt(c, n, 'size_x', 'X', 0, 2048);
      pInt(c, n, 'size_y', 'Y', 0, 2048);
    }
    pBool(l, n, 'use_extended_bounds', 'Extend Bounds', 'Extend bounds of the input image to fully fit blurred image');
  },
  exec: (n, ins, ctx) => {
    const v = convert(ins[0], 4);
    if (!isImg(v)) return [v];
    let img = v.img;
    const size = num(ins[1], 1);
    let rx: number, ry: number;
    if (n.props.use_relative) {
      rx = (Number(n.props.factor_x) / 100) * img.w;
      ry = (Number(n.props.factor_y) / 100) * img.h;
      if (n.props.aspect_correction === 'Y') ry = (Number(n.props.factor_y) / 100) * img.w;
      else if (n.props.aspect_correction === 'X') rx = (Number(n.props.factor_x) / 100) * img.h;
    } else { rx = Number(n.props.size_x); ry = Number(n.props.size_y); }
    rx *= size; ry *= size;
    void ctx;
    const gam = !!n.props.use_gamma_correction;
    if (gam) img = gammaWrap(img, true);
    img = blur(img, rx, ry, (n.props.use_bokeh ? 'FLAT' : n.props.filter_type) as BlurFilter);
    if (gam) img = gammaWrap(img, false);
    return [{ img }];
  },
});

const FILTER_KERNELS: Record<string, number[]> = {
  SOFTEN: [1, 2, 1, 2, 4, 2, 1, 2, 1].map((x) => x / 16),
  SHARPEN: [-1, -1, -1, -1, 9, -1, -1, -1, -1],
  LAPLACE: [-1 / 8, -1 / 8, -1 / 8, -1 / 8, 1, -1 / 8, -1 / 8, -1 / 8, -1 / 8],
  SOBEL: [1, 2, 1, 0, 0, 0, -1, -2, -1],
  PREWITT: [1, 1, 1, 0, 0, 0, -1, -1, -1],
  KIRSCH: [5, 5, 5, -3, 0, -3, -3, -3, -3],
  SHADOW: [1, 2, 1, 0, 1, 0, -1, -2, -1],
};

function transpose3(k: number[]): number[] { return [k[0], k[3], k[6], k[1], k[4], k[7], k[2], k[5], k[8]]; }

def({
  id: 'CompositorNodeFilter', label: 'Filter', tree: 'COMPOSITING', category: 'FILTER',
  inputs: [FAC(1), RGBA('Image', 'Image', [1, 1, 1, 1])], outputs: [OUT('Image')],
  init: (n) => { n.props.filter_type = 'SOFTEN'; },
  dynLabel: (n) => ({ SOFTEN: 'Soften', SHARPEN: 'Sharpen', LAPLACE: 'Laplace', SOBEL: 'Sobel', PREWITT: 'Prewitt', KIRSCH: 'Kirsch', SHADOW: 'Shadow' } as Record<string, string>)[String(n.props.filter_type)] ?? 'Filter',
  draw: (l, n) => pEnum(l, n, 'filter_type', 'Filter Type', [['SOFTEN', 'Soften'], ['SHARPEN', 'Sharpen'], ['LAPLACE', 'Laplace'], ['SOBEL', 'Sobel'], ['PREWITT', 'Prewitt'], ['KIRSCH', 'Kirsch'], ['SHADOW', 'Shadow']]),
  exec: (n, ins) => {
    const v = convert(ins[1], 4);
    if (!isImg(v)) return [v];
    const type = String(n.props.filter_type);
    const k = FILTER_KERNELS[type] ?? FILTER_KERNELS.SOFTEN;
    let res: Img;
    if (type === 'SOBEL' || type === 'PREWITT' || type === 'KIRSCH') {
      const gx = convolve3(v.img, k), gy = convolve3(v.img, transpose3(k));
      res = newImg(v.img.w, v.img.h, 4);
      for (let i = 0; i < v.img.w * v.img.h; i++) {
        for (let c = 0; c < 3; c++) { const a = gx.data[i * 4 + c], b = gy.data[i * 4 + c]; res.data[i * 4 + c] = Math.sqrt(a * a + b * b); }
        res.data[i * 4 + 3] = v.img.data[i * 4 + 3];
      }
    } else {
      res = convolve3(v.img, k);
      for (let i = 0; i < v.img.w * v.img.h; i++) res.data[i * 4 + 3] = v.img.data[i * 4 + 3];
    }
    return [mixFac(v, { img: res }, ins[0])];
  },
});

function shiftAdd(src: Img, dx: number, dy: number, weight: number, tint: number[] | null): Img {
  const out = copyImg(src);
  const tmp = [0, 0, 0, 0];
  for (let y = 0; y < src.h; y++) for (let x = 0; x < src.w; x++) {
    bilinear(src, x + 0.5 - dx, y + 0.5 - dy, tmp);
    const o = (y * src.w + x) * 4;
    for (let c = 0; c < 3; c++) out.data[o + c] += tmp[c] * weight * (tint ? tint[c] : 1);
  }
  return out;
}

function downsample(img: Img, f: number): Img {
  if (f <= 1) return img;
  const w = Math.max(1, Math.round(img.w / f)), hh = Math.max(1, Math.round(img.h / f));
  const out = newImg(w, hh, img.ch);
  const tmp = new Float32Array(img.ch);
  for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) {
    bilinear(img, (x + 0.5) * f, (y + 0.5) * f, tmp);
    for (let c = 0; c < img.ch; c++) out.data[(y * w + x) * img.ch + c] = tmp[c];
  }
  return out;
}

function upsample(img: Img, w: number, hh: number): Img {
  if (img.w === w && img.h === hh) return img;
  const out = newImg(w, hh, img.ch);
  const tmp = new Float32Array(img.ch);
  const fx = img.w / w, fy = img.h / hh;
  for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) {
    bilinear(img, (x + 0.5) * fx, (y + 0.5) * fy, tmp);
    for (let c = 0; c < img.ch; c++) out.data[(y * w + x) * img.ch + c] = tmp[c];
  }
  return out;
}

def({
  id: 'CompositorNodeGlare', label: 'Glare', tree: 'COMPOSITING', category: 'FILTER', width: 150,
  inputs: [RGBA('Image', 'Image', [1, 1, 1, 1])], outputs: [OUT('Image')],
  init: (n) => { Object.assign(n.props, { glare_type: 'STREAKS', quality: 'MEDIUM', iterations: 3, color_modulation: 0.25, mix: 0, threshold: 1, streaks: 4, angle_offset: 0, fade: 0.9, size: 8, use_rotate_45: true }); },
  draw: (l, n) => {
    pEnum(l, n, 'glare_type', 'Glare Type', [['GHOSTS', 'Ghosts'], ['STREAKS', 'Streaks'], ['FOG_GLOW', 'Fog Glow'], ['SIMPLE_STAR', 'Simple Star']]);
    pEnum(l, n, 'quality', 'Quality', [['HIGH', 'High'], ['MEDIUM', 'Medium'], ['LOW', 'Low']]);
    const t = n.props.glare_type;
    if (t !== 'FOG_GLOW') pInt(l, n, 'iterations', 'Iterations', 2, 5);
    if (t === 'GHOSTS' || t === 'STREAKS') pFloat(l, n, 'color_modulation', 'Color Modulation', { min: 0, max: 1, slider: true });
    pFloat(l, n, 'mix', 'Mix', { min: -1, max: 1, slider: true });
    pFloat(l, n, 'threshold', 'Threshold', { min: 0, max: 1000 });
    if (t === 'STREAKS') { pInt(l, n, 'streaks', 'Streaks', 1, 16); pFloat(l, n, 'angle_offset', 'Angle Offset', { min: 0, max: Math.PI, unit: 'ROTATION' }); }
    if (t === 'SIMPLE_STAR' || t === 'STREAKS') pFloat(l, n, 'fade', 'Fade', { min: 0.75, max: 1, slider: true });
    if (t === 'SIMPLE_STAR') pBool(l, n, 'use_rotate_45', 'Rotate 45', 'Simple star filter: add 45 degree rotation offset');
    if (t === 'FOG_GLOW') pInt(l, n, 'size', 'Size', 6, 9);
  },
  exec: (n, ins) => {
    const v = convert(ins[0], 4);
    if (!isImg(v)) return [v];
    const src = v.img;
    const q = n.props.quality === 'HIGH' ? 1 : n.props.quality === 'MEDIUM' ? 2 : 4;
    const thr = Number(n.props.threshold);
    // bright pass
    let bright = newImg(src.w, src.h, 4);
    for (let i = 0; i < src.w * src.h; i++) {
      const r = src.data[i * 4], g = src.data[i * 4 + 1], b = src.data[i * 4 + 2];
      const lum = bw(r, g, b);
      const f = lum > thr ? (lum - thr) / Math.max(1e-6, lum) : 0;
      bright.data[i * 4] = r * f; bright.data[i * 4 + 1] = g * f; bright.data[i * 4 + 2] = b * f; bright.data[i * 4 + 3] = 1;
    }
    bright = downsample(bright, q);
    const type = n.props.glare_type;
    const iters = Math.max(1, Math.min(5, Number(n.props.iterations)));
    const fade = Number(n.props.fade);
    const cm = Number(n.props.color_modulation);
    let glare: Img;
    const streak = (dirx: number, diry: number): Img => {
      let s = bright;
      for (let it = 0; it < iters; it++) {
        const d = Math.pow(4, it);
        const tint = cm > 0 ? [1, 1 - cm * 0.5 * (it % 2), 1 - cm * 0.5 * ((it + 1) % 2)] : null;
        s = shiftAdd(s, dirx * d, diry * d, Math.pow(fade, d), tint);
      }
      return s;
    };
    if (type === 'FOG_GLOW') {
      const r = (1 << Math.max(6, Math.min(9, Number(n.props.size)))) / 8 / q;
      glare = blur(bright, r, r, 'FAST_GAUSS');
    } else if (type === 'GHOSTS') {
      glare = newImg(bright.w, bright.h, 4);
      const blurred = blur(bright, 4 / q, 4 / q, 'FAST_GAUSS');
      const scales = [-1.5, -0.6, 0.5, 1.2, -0.3, 2].slice(0, iters + 1);
      const tmp = [0, 0, 0, 0];
      scales.forEach((sc, k) => {
        const tint = [1 - cm * (k % 3 === 0 ? 0 : 0.6), 1 - cm * (k % 3 === 1 ? 0 : 0.6), 1 - cm * (k % 3 === 2 ? 0 : 0.6)];
        for (let y = 0; y < bright.h; y++) for (let x = 0; x < bright.w; x++) {
          const cx = bright.w / 2, cy = bright.h / 2;
          bilinear(blurred, cx + (x + 0.5 - cx) / sc, cy + (y + 0.5 - cy) / sc, tmp);
          const o = (y * bright.w + x) * 4;
          for (let c = 0; c < 3; c++) glare.data[o + c] += tmp[c] * tint[c] * 0.5;
        }
      });
    } else {
      const dirs: number[] = [];
      if (type === 'SIMPLE_STAR') {
        const a0 = n.props.use_rotate_45 ? Math.PI / 4 : 0;
        for (let k = 0; k < 4; k++) dirs.push(a0 + (k * Math.PI) / 2);
      } else {
        const ns = Math.max(1, Number(n.props.streaks));
        for (let k = 0; k < ns; k++) dirs.push(Number(n.props.angle_offset) + (k * 2 * Math.PI) / ns);
      }
      glare = newImg(bright.w, bright.h, 4);
      for (const a of dirs) {
        const s = streak(Math.cos(a), Math.sin(a));
        for (let i = 0; i < s.data.length; i++) glare.data[i] += s.data[i] / dirs.length;
      }
    }
    glare = upsample(glare, src.w, src.h);
    const vmix = 0.5 * Number(n.props.mix) + 0.5;
    const mf = 2 - 2 * Math.abs(vmix - 0.5);
    const out = newImg(src.w, src.h, 4);
    for (let i = 0; i < src.w * src.h; i++) {
      for (let c = 0; c < 3; c++) out.data[i * 4 + c] = mf * ((1 - vmix) * src.data[i * 4 + c] + vmix * glare.data[i * 4 + c]);
      out.data[i * 4 + 3] = src.data[i * 4 + 3];
    }
    return [{ img: out }];
  },
});

def({
  id: 'CompositorNodeDilateErode', label: 'Dilate/Erode', tree: 'COMPOSITING', category: 'FILTER',
  inputs: [VAL('Mask', 'Mask', 0, 0, 1)], outputs: [OUT('Mask', 'VALUE')],
  init: (n) => { n.props.mode = 'STEP'; n.props.distance = 0; n.props.edge = 0; n.props.falloff = 'SMOOTH'; },
  draw: (l, n) => {
    pEnum(l, n, 'mode', 'Mode', [['STEP', 'Step'], ['THRESHOLD', 'Threshold'], ['DISTANCE', 'Distance'], ['FEATHER', 'Feather']]);
    pInt(l, n, 'distance', 'Distance', -5000, 5000);
    if (n.props.mode === 'THRESHOLD') pFloat(l, n, 'edge', 'Edge', { min: -100, max: 100 });
    if (n.props.mode === 'FEATHER') pEnum(l, n, 'falloff', 'Falloff', [['SMOOTH', 'Smooth'], ['SPHERE', 'Sphere'], ['ROOT', 'Root'], ['INVERSE_SQUARE', 'Inverse Square'], ['SHARP', 'Sharp'], ['LINEAR', 'Linear']]);
  },
  exec: (n, ins) => {
    const v = convert(ins[0], 1);
    if (!isImg(v)) return [v];
    const d = Math.round(Number(n.props.distance));
    if (!d) return [v];
    const src = v.img;
    const mode = n.props.mode;
    if (mode === 'FEATHER') {
      const r = Math.abs(d);
      let b = blur(src, r, r, 'GAUSS');
      if (d < 0) { b = copyImg(b); for (let i = 0; i < b.data.length; i++) b.data[i] = Math.min(src.data[i], b.data[i]); }
      else { b = copyImg(b); for (let i = 0; i < b.data.length; i++) b.data[i] = Math.max(src.data[i], b.data[i]); }
      return [{ img: b }];
    }
    const r = Math.abs(d), dil = d > 0;
    const round = mode === 'DISTANCE' || mode === 'THRESHOLD';
    // separable max/min for the square (step) kernel, direct disc for distance mode
    const pass = (s: Img, horizontal: boolean): Img => {
      const o = newImg(s.w, s.h, 1);
      for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) {
        let m = dil ? -Infinity : Infinity;
        for (let k = -r; k <= r; k++) {
          const xx = horizontal ? x + k : x, yy = horizontal ? y : y + k;
          if (xx < 0 || yy < 0 || xx >= s.w || yy >= s.h) continue;
          const val = s.data[yy * s.w + xx];
          m = dil ? Math.max(m, val) : Math.min(m, val);
        }
        o.data[y * s.w + x] = m;
      }
      return o;
    };
    if (!round || r > 12) return [{ img: pass(pass(src, true), false) }];
    const o = newImg(src.w, src.h, 1);
    for (let y = 0; y < src.h; y++) for (let x = 0; x < src.w; x++) {
      let m = dil ? -Infinity : Infinity;
      for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) {
        if (i * i + j * j > r * r) continue;
        const xx = x + i, yy = y + j;
        if (xx < 0 || yy < 0 || xx >= src.w || yy >= src.h) continue;
        const val = src.data[yy * src.w + xx];
        m = dil ? Math.max(m, val) : Math.min(m, val);
      }
      o.data[y * src.w + x] = m;
    }
    return [{ img: o }];
  },
});

def({
  id: 'CompositorNodeDespeckle', label: 'Despeckle', tree: 'COMPOSITING', category: 'FILTER',
  inputs: [FAC(1), RGBA('Image', 'Image', [1, 1, 1, 1])], outputs: [OUT('Image')],
  init: (n) => { n.props.threshold = 0.5; n.props.threshold_neighbor = 0.5; },
  draw: (l, n) => { pFloat(l, n, 'threshold', 'Threshold', { min: 0, max: 1, slider: true }); pFloat(l, n, 'threshold_neighbor', 'Neighbor', { min: 0, max: 1, slider: true }); },
  exec: (n, ins) => {
    const v = convert(ins[1], 4);
    if (!isImg(v)) return [v];
    const s = v.img, out = copyImg(s);
    const thr = Number(n.props.threshold), thrN = Number(n.props.threshold_neighbor);
    for (let y = 1; y < s.h - 1; y++) for (let x = 1; x < s.w - 1; x++) {
      const o = (y * s.w + x) * 4;
      const avg = [0, 0, 0, 0];
      let similar = 0;
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
        if (!i && !j) continue;
        const q = ((y + j) * s.w + x + i) * 4;
        let diff = 0;
        for (let c = 0; c < 4; c++) { avg[c] += s.data[q + c] / 8; diff += Math.abs(s.data[q + c] - s.data[o + c]); }
        if (diff < thrN) similar++;
      }
      let dd = 0;
      for (let c = 0; c < 4; c++) dd += Math.abs(avg[c] - s.data[o + c]);
      if (dd > thr && similar < 2) for (let c = 0; c < 4; c++) out.data[o + c] = avg[c];
    }
    return [mixFac(v, { img: out }, ins[0])];
  },
});

def({
  id: 'CompositorNodeDBlur', label: 'Directional Blur', tree: 'COMPOSITING', category: 'FILTER', width: 150,
  inputs: [RGBA('Image', 'Image', [1, 1, 1, 1])], outputs: [OUT('Image')],
  init: (n) => { Object.assign(n.props, { iterations: 1, use_wrap: false, center_x: 0.5, center_y: 0.5, distance: 0, angle: 0, spin: 0, zoom: 0 }); },
  draw: (l, n) => {
    pInt(l, n, 'iterations', 'Iterations', 1, 32);
    pBool(l, n, 'use_wrap', 'Wrap');
    const c = l.column(true);
    c.label('Center:');
    pFloat(c, n, 'center_x', 'X', { min: 0, max: 1 });
    pFloat(c, n, 'center_y', 'Y', { min: 0, max: 1 });
    const c2 = l.column(true);
    pFloat(c2, n, 'distance', 'Distance', { min: -1, max: 1 });
    pFloat(c2, n, 'angle', 'Angle', { min: 0, max: 2 * Math.PI, unit: 'ROTATION' });
    pFloat(l, n, 'spin', 'Spin', { min: -Math.PI / 2, max: Math.PI / 2, unit: 'ROTATION' });
    pFloat(l, n, 'zoom', 'Zoom', { min: 0, max: 100 });
  },
  exec: (n, ins) => {
    const v = convert(ins[0], 4);
    if (!isImg(v)) return [v];
    const s = v.img;
    const steps = Math.min(64, Math.pow(2, Math.max(1, Math.min(6, Number(n.props.iterations)))));
    const cx = Number(n.props.center_x) * s.w, cy = Number(n.props.center_y) * s.h;
    const diag = Math.hypot(s.w, s.h);
    const dist = Number(n.props.distance) * diag, ang = Number(n.props.angle), spin = Number(n.props.spin), zoom = Number(n.props.zoom);
    const out = newImg(s.w, s.h, 4);
    const tmp = [0, 0, 0, 0];
    const wrap = !!n.props.use_wrap;
    for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) {
      const o = (y * s.w + x) * 4;
      const acc = [0, 0, 0, 0];
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        const sc = 1 / (1 + zoom * t * 0.1);
        const a = spin * t;
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
        const rx = (dx * Math.cos(a) - dy * Math.sin(a)) * sc + cx - Math.cos(ang) * dist * t;
        const ry = (dx * Math.sin(a) + dy * Math.cos(a)) * sc + cy - Math.sin(ang) * dist * t;
        bilinear(s, rx, ry, tmp, wrap);
        for (let c = 0; c < 4; c++) acc[c] += tmp[c];
      }
      for (let c = 0; c < 4; c++) out.data[o + c] = acc[c] / (steps + 1);
    }
    return [{ img: out }];
  },
});

def({
  id: 'CompositorNodePixelate', label: 'Pixelate', tree: 'COMPOSITING', category: 'FILTER',
  inputs: [RGBA('Color', 'Color', [0, 0, 0, 1])], outputs: [OUT('Color')],
  exec: (_n, ins) => [convert(ins[0], 4)],
});

def({
  id: 'CompositorNodeSunBeams', label: 'Sun Beams', tree: 'COMPOSITING', category: 'FILTER', width: 150,
  inputs: [RGBA('Image', 'Image', [1, 1, 1, 1])], outputs: [OUT('Image')],
  init: (n) => { n.props.source = [0.5, 0.5]; n.props.ray_length = 0.2; },
  draw: (l, n) => {
    const c = l.column(true);
    c.label('Source:');
    pFloat(c, n, 'source', 'X', { min: -100, max: 100 }, 0);
    pFloat(c, n, 'source', 'Y', { min: -100, max: 100 }, 1);
    pFloat(l, n, 'ray_length', 'Ray Length', { min: 0, max: 1, slider: true });
  },
  exec: (n, ins) => {
    const v = convert(ins[0], 4);
    if (!isImg(v)) return [v];
    const s = v.img;
    const src = n.props.source as number[];
    const sx = src[0] * s.w, sy = src[1] * s.h;
    const len = Number(n.props.ray_length);
    const steps = 32;
    const out = newImg(s.w, s.h, 4);
    const tmp = [0, 0, 0, 0];
    for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) {
      const acc = [0, 0, 0, 0];
      let wsum = 0;
      for (let k = 0; k < steps; k++) {
        const t = (k / steps) * len;
        const wgt = 1 - k / steps;
        bilinear(s, x + 0.5 + (sx - x - 0.5) * t, y + 0.5 + (sy - y - 0.5) * t, tmp);
        for (let c = 0; c < 4; c++) acc[c] += tmp[c] * wgt;
        wsum += wgt;
      }
      const o = (y * s.w + x) * 4;
      for (let c = 0; c < 4; c++) out.data[o + c] = acc[c] / wsum;
    }
    return [{ img: out }];
  },
});

for (const [id, label] of [['CompositorNodeBilateralblur', 'Bilateral Blur'], ['CompositorNodeBokehBlur', 'Bokeh Blur'], ['CompositorNodeDefocus', 'Defocus'], ['CompositorNodeInpaint', 'Inpaint'], ['CompositorNodeVecBlur', 'Vector Blur']] as [string, string][]) {
  def({ id, label, tree: 'COMPOSITING', category: 'FILTER', unavailable: true, inputs: [RGBA('Image')], outputs: [OUT('Image')] });
}

// ------------------------------------------------------------------ Vector

def({
  id: 'CompositorNodeMapValue', label: 'Map Value', tree: 'COMPOSITING', category: 'VECTOR', width: 150,
  inputs: [VAL('Value', 'Value', 1, 0, 100)], outputs: [OUT('Value', 'VALUE')],
  init: (n) => { Object.assign(n.props, { offset: 0, size: 1, use_min: false, min: 0, use_max: false, max: 1 }); },
  draw: (l, n) => {
    const c = l.column(true);
    pFloat(c, n, 'offset', 'Offs', { min: -1000, max: 1000 });
    pFloat(c, n, 'size', 'Size', { min: -1000, max: 1000 });
    const sp = l.split();
    const a = sp.column(true), b = sp.column(true);
    pBool(a, n, 'use_min', 'Use Minimum');
    pFloat(a, n, 'min', 'Min', { min: -1000, max: 1000 });
    pBool(b, n, 'use_max', 'Use Maximum');
    pFloat(b, n, 'max', 'Max', { min: -1000, max: 1000 });
  },
  exec: (n, ins) => {
    const off = Number(n.props.offset), sz = Number(n.props.size), umin = !!n.props.use_min, umax = !!n.props.use_max, mn = Number(n.props.min), mx = Number(n.props.max);
    return mapPixels(ins, [1], [1], (p, o) => {
      let v = (p[0][0] + off) * sz;
      if (umin && v < mn) v = mn;
      if (umax && v > mx) v = mx;
      o[0][0] = v;
    });
  },
});

def({
  id: 'CompositorNodeMapRange', label: 'Map Range', tree: 'COMPOSITING', category: 'VECTOR',
  inputs: [VAL('Value', 'Value', 1, 0, 1), VAL('From Min', 'From Min', 0, -10000, 10000), VAL('From Max', 'From Max', 1, -10000, 10000), VAL('To Min', 'To Min', 0, -10000, 10000), VAL('To Max', 'To Max', 1, -10000, 10000)],
  outputs: [OUT('Value', 'VALUE')],
  init: (n) => { n.props.use_clamp = false; },
  draw: (l, n) => pBool(l, n, 'use_clamp', 'Clamp', 'Clamp result of the node to 0..1 range'),
  exec: (n, ins) => mapPixels(ins, [1, 1, 1, 1, 1], [1], (p, o) => {
    const [v, a, b, c, d] = p.map((x) => x[0]);
    let r = b !== a ? c + ((v - a) / (b - a)) * (d - c) : c;
    if (n.props.use_clamp) r = Math.min(Math.max(c, d), Math.max(Math.min(c, d), r));
    o[0][0] = r;
  }),
});

def({
  id: 'CompositorNodeNormalize', label: 'Normalize', tree: 'COMPOSITING', category: 'VECTOR',
  inputs: [VAL('Value', 'Value', 1, 0, 1)], outputs: [OUT('Value', 'VALUE')],
  exec: (_n, ins) => {
    const v = convert(ins[0], 1);
    if (!isImg(v)) return [{ c: [0] }];
    let mn = Infinity, mx = -Infinity;
    for (const x of v.img.data) { if (Math.abs(x) >= 1e9) continue; if (x < mn) mn = x; if (x > mx) mx = x; }
    const r = mx - mn;
    const out = newImg(v.img.w, v.img.h, 1);
    for (let i = 0; i < out.data.length; i++) { const x = v.img.data[i]; out.data[i] = Math.abs(x) >= 1e9 ? (x > 0 ? 1 : 0) : r > 0 ? (x - mn) / r : 0; }
    return [{ img: out }];
  },
});

def({
  id: 'CompositorNodeNormal', label: 'Normal', tree: 'COMPOSITING', category: 'VECTOR',
  inputs: [VEC('Normal', 'Normal', [0, 0, 1])], outputs: [OUT('Normal', 'VECTOR'), OUT('Dot', 'VALUE')],
  init: (n) => { n.props.normal = [0, 0, 1]; },
  draw: (l, n) => { const c = l.column(true); for (let i = 0; i < 3; i++) pFloat(c, n, 'normal', 'XYZ'[i], { min: -1, max: 1 }, i); },
  exec: (n, ins) => {
    const nn = n.props.normal as number[];
    const len = Math.hypot(nn[0], nn[1], nn[2]) || 1;
    const u = nn.map((x) => x / len);
    return mapPixels(ins, [3], [3, 1], (p, o) => { o[0][0] = u[0]; o[0][1] = u[1]; o[0][2] = u[2]; o[1][0] = -(p[0][0] * u[0] + p[0][1] * u[1] + p[0][2] * u[2]); });
  },
});

def({
  id: 'CompositorNodeCurveVec', label: 'Vector Curves', tree: 'COMPOSITING', category: 'VECTOR', width: 200,
  inputs: [VEC('Vector')], outputs: [OUT('Vector', 'VECTOR')],
  init: (n) => { const m = defaultCurveMapping(3); m.curves = m.curves.map(() => [[0, 0], [1, 1]]); n.props.mapping = m; },
  draw: (l, n) => curveMappingWidget(l, () => n.props.mapping as CurveMapping, ['X', 'Y', 'Z']),
  exec: (n, ins) => {
    const luts = (n.props.mapping as CurveMapping).curves.map((c) => curveLUT(c, 256));
    return mapPixels(ins, [3], [3], (p, o) => { for (let i = 0; i < 3; i++) o[0][i] = lutEval(luts[i], (p[0][i] + 1) / 2) * 2 - 1; });
  },
});

// ------------------------------------------------------------------ Matte

function maskNode(id: string, label: string, ellipse: boolean): void {
  def({
    id, label, tree: 'COMPOSITING', category: 'MATTE', width: 150,
    inputs: [VAL('Mask', 'Mask', 0, 0, 1), VAL('Value', 'Value', 1, 0, 1)], outputs: [OUT('Mask', 'VALUE')],
    init: (n) => { Object.assign(n.props, { x: 0.5, y: 0.5, width: ellipse ? 0.2 : 0.3, height: ellipse ? 0.1 : 0.2, rotation: 0, mask_type: 'ADD' }); },
    draw: (l, n) => {
      const c = l.column(true);
      const r = c.row(true);
      pFloat(r, n, 'x', 'X', { min: -1, max: 2 });
      pFloat(r, n, 'y', 'Y', { min: -1, max: 2 });
      const r2 = c.row(true);
      pFloat(r2, n, 'width', 'Width', { min: 0, max: 2, slider: true });
      pFloat(r2, n, 'height', 'Height', { min: 0, max: 2, slider: true });
      pFloat(l, n, 'rotation', 'Rotation', { min: -2 * Math.PI, max: 2 * Math.PI, unit: 'ROTATION' });
      pEnum(l, n, 'mask_type', 'Mask Type', [['ADD', 'Add'], ['SUBTRACT', 'Subtract'], ['MULTIPLY', 'Multiply'], ['NOT', 'Not']]);
    },
    exec: (n, ins, ctx) => {
      const { w, h } = canvasSize(ins, ctx);
      const mask = isImg(ins[0]) ? ins[0] : { img: fill(constOf(ins[0]), w, h) };
      const cx = Number(n.props.x), cy = Number(n.props.y), mw = Number(n.props.width) / 2, mh = Number(n.props.height) / 2;
      const rot = Number(n.props.rotation), cs = Math.cos(rot), sn = Math.sin(rot);
      const aspect = w / Math.max(1, h);
      const type = n.props.mask_type;
      return mapPixels([mask, ins[1]], [1, 1], [1], (p, o, x, y) => {
        const dx = (x + 0.5) / w - cx, dy = ((y + 0.5) / h - cy) / aspect;
        const rx = dx * cs + dy * sn, ry = (-dx * sn + dy * cs);
        const inside = ellipse ? (rx * rx) / (mw * mw + 1e-12) + (ry * ry) / ((mh / aspect) * (mh / aspect) + 1e-12) <= 1 : Math.abs(rx) <= mw && Math.abs(ry) <= mh / aspect;
        const m = p[0][0], v = p[1][0];
        let r = m;
        switch (type) {
          case 'ADD': r = inside ? Math.max(m, v) : m; break;
          case 'SUBTRACT': r = inside ? clamp01(m - v) : m; break;
          case 'MULTIPLY': r = inside ? m * v : 0; break;
          case 'NOT': r = inside ? (m > 0 ? 0 : v) : m; break;
        }
        o[0][0] = r;
      });
    },
  });
}
maskNode('CompositorNodeBoxMask', 'Box Mask', false);
maskNode('CompositorNodeEllipseMask', 'Ellipse Mask', true);

def({
  id: 'CompositorNodeLumaMatte', label: 'Luminance Key', tree: 'COMPOSITING', category: 'MATTE', width: 150,
  inputs: [RGBA('Image', 'Image', [1, 1, 1, 1])], outputs: [OUT('Image'), OUT('Matte', 'VALUE')],
  init: (n) => { n.props.limit_max = 1; n.props.limit_min = 0; },
  draw: (l, n) => { const c = l.column(true); pFloat(c, n, 'limit_max', 'High', { min: 0, max: 1, slider: true }); pFloat(c, n, 'limit_min', 'Low', { min: 0, max: 1, slider: true }); },
  exec: (n, ins) => {
    const hi = Number(n.props.limit_max), lo = Number(n.props.limit_min);
    return mapPixels(ins, [4], [4, 1], (p, o) => {
      const c = p[0];
      const lum = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      const m = Math.min(c[3], hi > lo ? clamp01((lum - lo) / (hi - lo)) : lum >= hi ? 1 : 0);
      for (let i = 0; i < 4; i++) o[0][i] = c[i] * (c[3] > 0 ? m / c[3] : 0);
      o[1][0] = m;
    });
  },
});

for (const [id, label] of [['CompositorNodeChannelMatte', 'Channel Key'], ['CompositorNodeChromaMatte', 'Chroma Key'], ['CompositorNodeColorMatte', 'Color Key'], ['CompositorNodeColorSpill', 'Color Spill'], ['CompositorNodeDiffMatte', 'Difference Key'], ['CompositorNodeDistanceMatte', 'Distance Key'], ['CompositorNodeDoubleEdgeMask', 'Double Edge Mask'], ['CompositorNodeKeying', 'Keying'], ['CompositorNodeKeyingScreen', 'Keying Screen']] as [string, string][]) {
  def({ id, label, tree: 'COMPOSITING', category: 'MATTE', unavailable: true, inputs: [RGBA('Image')], outputs: [OUT('Image')] });
}

// ------------------------------------------------------------------ Distort

type Sampler = (img: Img, x: number, y: number, out: number[]) => void;
const FILTERS: [string, string][] = [['NEAREST', 'Nearest'], ['BILINEAR', 'Bilinear'], ['BICUBIC', 'Bicubic']];
function sampler(f: unknown): Sampler { return f === 'NEAREST' ? (img, x, y, o) => nearest(img, x, y, o) : (img, x, y, o) => bilinear(img, x, y, o); }

/** Resample `src` into a w x h canvas: `map` gives the source coordinate for a destination pixel centre. */
function warp(src: Img, w: number, hh: number, map: (x: number, y: number) => [number, number], samp: Sampler = (img, x, y, o) => bilinear(img, x, y, o)): Img {
  const out = newImg(w, hh, src.ch);
  const tmp = new Array<number>(src.ch).fill(0);
  for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) {
    const [sx, sy] = map(x + 0.5, y + 0.5);
    samp(src, sx, sy, tmp);
    const o = (y * w + x) * src.ch;
    for (let c = 0; c < src.ch; c++) out.data[o + c] = tmp[c];
  }
  return out;
}

def({
  id: 'CompositorNodeScale', label: 'Scale', tree: 'COMPOSITING', category: 'DISTORT',
  inputs: [RGBA('Image', 'Image', [1, 1, 1, 1]), VAL('X', 'X', 1, 0.0001, 100000), VAL('Y', 'Y', 1, 0.0001, 100000)], outputs: [OUT('Image')],
  init: (n) => { n.props.space = 'RELATIVE'; n.props.frame_method = 'STRETCH'; },
  draw: (l, n) => {
    pEnum(l, n, 'space', 'Space', [['RELATIVE', 'Relative'], ['ABSOLUTE', 'Absolute'], ['SCENE_SIZE', 'Scene Size'], ['RENDER_SIZE', 'Render Size']]);
    if (n.props.space === 'RENDER_SIZE') l.prop(eprop(P(n), 'frame_method', items([['STRETCH', 'Stretch'], ['FIT', 'Fit'], ['CROP', 'Crop']]), { name: 'Frame Method', notify: ['data'] }), { expand: true });
  },
  exec: (n, ins, ctx) => {
    const v = convert(ins[0], 4);
    if (!isImg(v)) return [v];
    const s = v.img;
    const space = n.props.space;
    let sx = num(ins[1], 1), sy = num(ins[2], 1);
    let w = s.w, hh = s.h;
    if (space === 'ABSOLUTE') { sx = sx / s.w; sy = sy / s.h; }
    else if (space === 'SCENE_SIZE') { sx = sy = ctx.scene.render.resolutionPercentage / 100; }
    else if (space === 'RENDER_SIZE') {
      w = ctx.rw; hh = ctx.rh;
      sx = w / s.w; sy = hh / s.h;
      if (n.props.frame_method === 'FIT') sx = sy = Math.min(sx, sy);
      else if (n.props.frame_method === 'CROP') sx = sy = Math.max(sx, sy);
    }
    const cx = w / 2, cy = hh / 2, scx = s.w / 2, scy = s.h / 2;
    return [{ img: warp(s, w, hh, (x, y) => [scx + (x - cx) / Math.max(1e-6, sx), scy + (y - cy) / Math.max(1e-6, sy)]) }];
  },
});

def({
  id: 'CompositorNodeTranslate', label: 'Translate', tree: 'COMPOSITING', category: 'DISTORT',
  inputs: [RGBA('Image', 'Image', [1, 1, 1, 1]), VAL('X', 'X', 0, -10000, 10000), VAL('Y', 'Y', 0, -10000, 10000)], outputs: [OUT('Image')],
  init: (n) => { n.props.use_relative = false; n.props.wrap_axis = 'NONE'; },
  draw: (l, n) => { pBool(l, n, 'use_relative', 'Relative', 'Use relative (fraction of input image size) values to define translation'); pEnum(l, n, 'wrap_axis', 'Wrapping', [['NONE', 'None'], ['XAXIS', 'X Axis'], ['YAXIS', 'Y Axis'], ['BOTH', 'Both Axes']]); },
  exec: (n, ins) => {
    const v = convert(ins[0], 4);
    if (!isImg(v)) return [v];
    const s = v.img;
    let dx = num(ins[1]), dy = num(ins[2]);
    if (n.props.use_relative) { dx *= s.w; dy *= s.h; }
    const wa = String(n.props.wrap_axis);
    const wx = wa === 'XAXIS' || wa === 'BOTH', wy = wa === 'YAXIS' || wa === 'BOTH';
    return [{ img: warp(s, s.w, s.h, (x, y) => {
      let sx = x - dx, sy = y - dy;
      if (wx) sx = ((sx % s.w) + s.w) % s.w;
      if (wy) sy = ((sy % s.h) + s.h) % s.h;
      return [sx, sy];
    }) }];
  },
});

def({
  id: 'CompositorNodeRotate', label: 'Rotate', tree: 'COMPOSITING', category: 'DISTORT',
  inputs: [RGBA('Image', 'Image', [1, 1, 1, 1]), { id: 'Degr', name: 'Degr', type: 'VALUE', default: 0, min: -10000, max: 10000, unit: 'ROTATION' }], outputs: [OUT('Image')],
  init: (n) => { n.props.filter_type = 'BILINEAR'; },
  draw: (l, n) => pEnum(l, n, 'filter_type', 'Filter', FILTERS),
  exec: (n, ins) => {
    const v = convert(ins[0], 4);
    if (!isImg(v)) return [v];
    const s = v.img, a = num(ins[1]);
    const cs = Math.cos(a), sn = Math.sin(a), cx = s.w / 2, cy = s.h / 2;
    return [{ img: warp(s, s.w, s.h, (x, y) => { const dx = x - cx, dy = y - cy; return [cx + dx * cs + dy * sn, cy - dx * sn + dy * cs]; }, sampler(n.props.filter_type)) }];
  },
});

def({
  id: 'CompositorNodeFlip', label: 'Flip', tree: 'COMPOSITING', category: 'DISTORT',
  inputs: [RGBA('Image', 'Image', [1, 1, 1, 1])], outputs: [OUT('Image')],
  init: (n) => { n.props.axis = 'X'; },
  draw: (l, n) => pEnum(l, n, 'axis', 'Axis', [['X', 'Flip X'], ['Y', 'Flip Y'], ['XY', 'Flip X & Y']]),
  exec: (n, ins) => {
    const v = convert(ins[0], 4);
    if (!isImg(v)) return [v];
    const s = v.img, fx = n.props.axis !== 'Y', fy = n.props.axis !== 'X';
    return [{ img: warp(s, s.w, s.h, (x, y) => [fx ? s.w - x : x, fy ? s.h - y : y], (img, x, y, o) => nearest(img, x, y, o)) }];
  },
});

def({
  id: 'CompositorNodeCrop', label: 'Crop', tree: 'COMPOSITING', category: 'DISTORT', width: 150,
  inputs: [RGBA('Image', 'Image', [1, 1, 1, 1])], outputs: [OUT('Image')],
  init: (n) => { Object.assign(n.props, { use_crop_size: false, relative: false, min_x: 0, max_x: 0, min_y: 0, max_y: 0, rel_min_x: 0, rel_max_x: 1, rel_min_y: 0, rel_max_y: 1 }); },
  draw: (l, n) => {
    pBool(l, n, 'use_crop_size', 'Crop Image Size', 'Whether to crop the size of the input image');
    pBool(l, n, 'relative', 'Relative', 'Use relative values to crop image');
    const c = l.column(true);
    if (n.props.relative) {
      pFloat(c, n, 'rel_min_x', 'Left', { min: 0, max: 1, slider: true }); pFloat(c, n, 'rel_max_x', 'Right', { min: 0, max: 1, slider: true });
      pFloat(c, n, 'rel_min_y', 'Up', { min: 0, max: 1, slider: true }); pFloat(c, n, 'rel_max_y', 'Down', { min: 0, max: 1, slider: true });
    } else {
      pInt(c, n, 'min_x', 'Left', 0, 10000); pInt(c, n, 'max_x', 'Right', 0, 10000);
      pInt(c, n, 'min_y', 'Up', 0, 10000); pInt(c, n, 'max_y', 'Down', 0, 10000);
    }
  },
  exec: (n, ins) => {
    const v = convert(ins[0], 4);
    if (!isImg(v)) return [v];
    const s = v.img;
    let x1: number, x2: number, y1: number, y2: number;
    if (n.props.relative) { x1 = Number(n.props.rel_min_x) * s.w; x2 = Number(n.props.rel_max_x) * s.w; y1 = Number(n.props.rel_min_y) * s.h; y2 = Number(n.props.rel_max_y) * s.h; }
    else { x1 = Number(n.props.min_x); x2 = Number(n.props.max_x); y1 = Number(n.props.min_y); y2 = Number(n.props.max_y); }
    const xmin = Math.max(0, Math.min(s.w - 1, Math.floor(Math.min(x1, x2)))), xmax = Math.max(xmin + 1, Math.min(s.w, Math.ceil(Math.max(x1, x2)) + 1));
    const ymin = Math.max(0, Math.min(s.h - 1, Math.floor(Math.min(y1, y2)))), ymax = Math.max(ymin + 1, Math.min(s.h, Math.ceil(Math.max(y1, y2)) + 1));
    if (n.props.use_crop_size) {
      const w = xmax - xmin, hh = ymax - ymin;
      const out = newImg(w, hh, 4);
      for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 4; c++) out.data[(y * w + x) * 4 + c] = s.data[((y + ymin) * s.w + x + xmin) * 4 + c];
      return [{ img: out }];
    }
    const out = newImg(s.w, s.h, 4);
    for (let y = ymin; y < ymax; y++) for (let x = xmin; x < xmax; x++) for (let c = 0; c < 4; c++) out.data[(y * s.w + x) * 4 + c] = s.data[(y * s.w + x) * 4 + c];
    return [{ img: out }];
  },
});

def({
  id: 'CompositorNodeTransform', label: 'Transform', tree: 'COMPOSITING', category: 'DISTORT',
  inputs: [RGBA('Image', 'Image', [0.8, 0.8, 0.8, 1]), VAL('X', 'X', 0, -10000, 10000), VAL('Y', 'Y', 0, -10000, 10000), { id: 'Angle', name: 'Angle', type: 'VALUE', default: 0, min: -10000, max: 10000, unit: 'ROTATION' }, VAL('Scale', 'Scale', 1, 0.0001, 100000)],
  outputs: [OUT('Image')],
  init: (n) => { n.props.filter_type = 'BILINEAR'; },
  draw: (l, n) => pEnum(l, n, 'filter_type', 'Filter', FILTERS),
  exec: (n, ins) => {
    const v = convert(ins[0], 4);
    if (!isImg(v)) return [v];
    const s = v.img;
    const tx = num(ins[1]), ty = num(ins[2]), a = num(ins[3]), sc = Math.max(1e-6, num(ins[4], 1));
    const cs = Math.cos(a), sn = Math.sin(a), cx = s.w / 2, cy = s.h / 2;
    return [{ img: warp(s, s.w, s.h, (x, y) => {
      const dx = (x - cx - tx) / sc, dy = (y - cy - ty) / sc;
      return [cx + dx * cs + dy * sn, cy - dx * sn + dy * cs];
    }, sampler(n.props.filter_type)) }];
  },
});

def({
  id: 'CompositorNodeLensdist', label: 'Lens Distortion', tree: 'COMPOSITING', category: 'DISTORT', width: 150,
  inputs: [RGBA('Image', 'Image', [1, 1, 1, 1]), VAL('Distort', 'Distort', 0, -0.999, 1, true), VAL('Dispersion', 'Dispersion', 0, 0, 1, true)], outputs: [OUT('Image')],
  init: (n) => { n.props.use_projector = false; n.props.use_jitter = false; n.props.use_fit = false; },
  draw: (l, n) => {
    const c = l.column();
    pBool(c, n, 'use_projector', 'Projector', 'Enable/disable projector mode (the effect is applied in horizontal direction only)');
    if (!n.props.use_projector) { pBool(c, n, 'use_jitter', 'Jitter', 'Enable/disable jittering (faster, but also noisier)'); pBool(c, n, 'use_fit', 'Fit', 'For positive distortion factor only: scale image such that black areas are not visible'); }
  },
  exec: (n, ins) => {
    const v = convert(ins[0], 4);
    if (!isImg(v)) return [v];
    const s = v.img;
    const dist = Math.max(-0.999, Math.min(1, num(ins[1]))), disp = Math.max(0, Math.min(1, num(ins[2])));
    const proj = !!n.props.use_projector;
    const k = [dist + disp, dist, dist - disp].map((x) => Math.max(-0.999, Math.min(1, x)));
    const maxk = Math.max(...k);
    const sc = n.props.use_fit && maxk > 0 ? 1 / (1 + 2 * maxk) : 1 / (1 + Math.max(0, maxk));
    const out = newImg(s.w, s.h, 4);
    const cx = s.w / 2, cy = s.h / 2;
    const tmp = [0, 0, 0, 0];
    for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) {
      const u = (x + 0.5 - cx) / cx, vv = (y + 0.5 - cy) / cy;
      const o = (y * s.w + x) * 4;
      let alpha = 0;
      for (let c = 0; c < 3; c++) {
        if (proj) {
          bilinear(s, x + 0.5 + (c - 1) * disp * s.w * 0.05, y + 0.5, tmp);
        } else {
          const r2 = u * u + vv * vv;
          const f = sc * (1 + 4 * k[c] * r2 * 0.25) / (1 + Math.max(0, -k[c]) * 0.5);
          bilinear(s, cx + u * f * cx, cy + vv * f * cy, tmp);
        }
        out.data[o + c] = tmp[c];
        alpha += tmp[3] / 3;
      }
      out.data[o + 3] = alpha;
    }
    return [{ img: out }];
  },
});

def({
  id: 'CompositorNodeDisplace', label: 'Displace', tree: 'COMPOSITING', category: 'DISTORT',
  inputs: [RGBA('Image', 'Image', [1, 1, 1, 1]), VEC('Vector', 'Vector', [1, 1, 1]), VAL('X Scale', 'X Scale', 0, -1000, 1000), VAL('Y Scale', 'Y Scale', 0, -1000, 1000)], outputs: [OUT('Image')],
  exec: (_n, ins, ctx) => {
    const v = convert(ins[0], 4);
    if (!isImg(v)) return [v];
    const s = v.img;
    const vec = convert(ins[1], 3), xs = convert(ins[2], 1), ys = convert(ins[3], 1);
    const tv = [0, 0, 0], tx = [0], ty = [0];
    void ctx;
    return [{ img: warp(s, s.w, s.h, (x, y) => {
      const px = Math.floor(x), py = Math.floor(y);
      if (isImg(vec)) { const i = vec.img; const sx = px + ((i.w - s.w) >> 1), sy = py + ((i.h - s.h) >> 1); const o = (Math.max(0, Math.min(i.h - 1, sy)) * i.w + Math.max(0, Math.min(i.w - 1, sx))) * 3; tv[0] = i.data[o]; tv[1] = i.data[o + 1]; } else { tv[0] = vec.c[0]; tv[1] = vec.c[1]; }
      tx[0] = isImg(xs) ? xs.img.data[Math.min(xs.img.data.length - 1, py * xs.img.w + px)] : xs.c[0];
      ty[0] = isImg(ys) ? ys.img.data[Math.min(ys.img.data.length - 1, py * ys.img.w + px)] : ys.c[0];
      return [x - tv[0] * tx[0], y - tv[1] * ty[0]];
    }) }];
  },
});

for (const [id, label] of [['CompositorNodeCornerPin', 'Corner Pin'], ['CompositorNodeMapUV', 'Map UV'], ['CompositorNodeMovieDistortion', 'Movie Distortion'], ['CompositorNodePlaneTrackDeform', 'Plane Track Deform'], ['CompositorNodeStabilize', 'Stabilize 2D']] as [string, string][]) {
  def({ id, label, tree: 'COMPOSITING', category: 'DISTORT', unavailable: true, inputs: [RGBA('Image')], outputs: [OUT('Image')] });
}

// ------------------------------------------------------------------ Layout

def({
  id: 'NodeFrame', label: 'Frame', tree: 'COMPOSITING', trees: ['SHADER', 'TEXTURE'], category: 'LAYOUT', special: 'FRAME', width: 200,
  inputs: [], outputs: [],
  init: (n) => { n.height = 150; n.props.shrink = true; n.props.label_size = 20; },
  draw: (l, n) => { pBool(l, n, 'shrink', 'Shrink', 'Shrink the frame to minimal bounding box'); pInt(l, n, 'label_size', 'Label Size', 8, 64); },
});

def({
  id: 'NodeReroute', label: 'Reroute', tree: 'COMPOSITING', trees: ['SHADER', 'TEXTURE'], category: 'LAYOUT', special: 'REROUTE', width: 16,
  inputs: [{ id: 'Input', name: 'Input', type: 'RGBA', default: [0, 0, 0, 1], hideValue: true }], outputs: [OUT('Output')],
  exec: (_n, ins) => [ins[0]],
});

def({
  id: 'CompositorNodeSwitch', label: 'Switch', tree: 'COMPOSITING', category: 'LAYOUT',
  inputs: [RGBA('Off', 'Off', [0.8, 0.8, 0.8, 1]), RGBA('On', 'On', [0.8, 0.8, 0.8, 1])], outputs: [OUT('Image')],
  init: (n) => { n.props.check = false; },
  draw: (l, n) => pBool(l, n, 'check', 'Switch', 'Off: first socket, On: second socket'),
  exec: (n, ins) => [n.props.check ? ins[1] : ins[0]],
});

def({ id: 'CompositorNodeGroup', label: 'Group', tree: 'COMPOSITING', category: 'GROUP', unavailable: true, inputs: [], outputs: [] });

/** Nodes with special frame-dependent behaviour (re-evaluate on frame change). */
export function treeIsTimeDependent(tree: NodeTree): boolean {
  return tree.nodes.some((n) => n.type === 'CompositorNodeTime' || n.type === 'CompositorNodeMovieClip' || (n.type === 'CompositorNodeImage' && !!getMedia(n.props.image as string) && (getMedia(n.props.image as string)!.kind === 'MOVIE' || !!getMedia(n.props.image as string)!.files)));
}
