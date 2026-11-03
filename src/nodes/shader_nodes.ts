// Blender Internal material nodes (shader node tree of a material with "Use Nodes" on). The tree is
// evaluated with constant values to the material's final diffuse colour, which the viewport and the
// renderer use instead of the material's own diffuse colour.

import { app } from '../app';
import type { BNode, NodeTree } from '../core/edtypes';
import type { MaterialData, TextureData } from '../core/types';
import { bprop, eprop, type Layout } from '../ui/layout';
import { BLEND_MODES, blendRGB, bw, clamp01, defaultColorRamp, evalColorRamp, hsvToRgb, rgbToHsv, srgbToLinear, type ColorRampData } from './cmp_buffers';
import { MATH_OPS, mathOp } from './cmp_nodes';
import { createNode, defaultTreeBuilders, findNode, linkTo, newNodeTree, nodeInputs, nodeOutputs, registerNodeType, registerTreeType, type NodeTypeDef, type SocketDef } from './nodes';
import { colorRampWidget } from './widgets';

const isBI = () => app.scene.render.engine !== 'CYCLES';

type SVal = number[];
type SExec = (node: BNode, ins: SVal[], ctx: SCtx) => SVal[];
interface SCtx { owner: MaterialData | null; constant: boolean }
const shExec = new Map<string, SExec>();

function def(d: Omit<NodeTypeDef, 'tree'> & { exec?: SExec }): void {
  const { exec, ...rest } = d;
  registerNodeType({ tree: 'SHADER', poll: isBI, ...rest });
  if (exec) shExec.set(d.id, exec);
}

const RGBA = (id: string, name = id, d: number[] = [0.5, 0.5, 0.5, 1]): SocketDef => ({ id, name, type: 'RGBA', default: d });
const VAL = (id: string, name = id, d = 0, min?: number, max?: number, slider = false): SocketDef => ({ id, name, type: 'VALUE', default: d, min, max, slider });
const VEC = (id: string, name = id, d: number[] = [0, 0, 0], hideValue = false): SocketDef => ({ id, name, type: 'VECTOR', default: d, hideValue });
const OUT = (id: string, type: SocketDef['type'] = 'RGBA', name = id): SocketDef => ({ id, name, type });
const P = (n: BNode) => () => n.props;

registerTreeType({
  id: 'SHADER', label: 'Shader', icon: 'NODE_MATERIAL', description: 'Shader nodes',
  categories: () => [
    { id: 'INPUT', label: 'Input' }, { id: 'OUTPUT', label: 'Output' }, { id: 'COLOR', label: 'Color' }, { id: 'VECTOR', label: 'Vector' },
    { id: 'CONVERTER', label: 'Converter' }, { id: 'GROUP', label: 'Group' }, { id: 'LAYOUT', label: 'Layout' },
  ],
});

registerTreeType({ id: 'TEXTURE', label: 'Texture', icon: 'NODE_TEXTURE', description: 'Texture nodes (not available in blender-web)', categories: () => [], available: () => false });

/** "Use Nodes" on a Blender Internal material: Material -> Output. */
defaultTreeBuilders.push({
  tree: 'SHADER',
  build: () => {
    if (!isBI()) return null;
    const t = newNodeTree('SHADER');
    const ma = createNode(t, 'ShaderNodeMaterial', [-60, 300]);
    const out = createNode(t, 'ShaderNodeOutput', [200, 300]);
    ma.select = false; out.select = false;
    t.links.push({ fromNode: ma.name, fromSocket: 'Color', toNode: out.name, toSocket: 'Color' });
    t.links.push({ fromNode: ma.name, fromSocket: 'Alpha', toNode: out.name, toSocket: 'Alpha' });
    t.active = ma.name;
    return t;
  },
});

/** The material that owns a node tree. */
export function ownerMaterial(tree: NodeTree): MaterialData | null {
  return Object.values(app.doc.materials).find((m) => m.nodeTree === tree) ?? null;
}

// ------------------------------------------------------------------ nodes

def({
  id: 'ShaderNodeOutput', label: 'Output', category: 'OUTPUT',
  inputs: [RGBA('Color', 'Color', [0, 0, 0, 1]), VAL('Alpha', 'Alpha', 1, 0, 1, true)], outputs: [],
});

def({
  id: 'ShaderNodeMaterial', label: 'Material', category: 'INPUT', width: 160,
  inputs: [RGBA('Color', 'Color', [0, 0, 0, 1]), RGBA('Spec', 'Spec', [0, 0, 0, 1]), VAL('DiffuseIntensity', 'Refl', 0, 0, 1, true), VEC('Normal', 'Normal', [0, 0, 0], true)],
  outputs: [OUT('Color'), OUT('Alpha', 'VALUE'), OUT('Normal', 'VECTOR')],
  init: (n) => { n.props.material = null; n.props.use_diffuse = true; n.props.use_specular = true; n.props.invert_normal = false; },
  draw: (l, n, ctx) => {
    const owner = ownerMaterial(ctx.tree);
    l.idTemplate({
      icon: 'MATERIAL', title: 'Material',
      items: () => Object.values(app.doc.materials).map((m) => ({ id: m.id, name: m.name, icon: 'MATERIAL' })),
      get: () => (n.props.material as string | null) ?? owner?.id ?? null,
      set: (id) => { n.props.material = id; },
      name: () => app.doc.materials[(n.props.material as string) ?? owner?.id ?? '']?.name ?? '',
      unlink: () => { n.props.material = null; },
    });
    const r = l.row(true);
    r.prop(bprop(P(n), 'use_diffuse', { name: 'Diffuse', notify: ['data'] }), { toggle: true });
    r.prop(bprop(P(n), 'use_specular', { name: 'Specular', notify: ['data'] }), { toggle: true });
    r.prop(bprop(P(n), 'invert_normal', { name: 'Invert Normal', notify: ['data'] }), { toggle: true });
  },
  exec: (n, ins, ctx) => {
    const ma = app.doc.materials[(n.props.material as string) ?? ''] ?? ctx.owner;
    const linkedColor = ins[0][4] === 1;
    const base = linkedColor ? ins[0].slice(0, 3) : ma ? ma.diffuseColor.slice() : [0.8, 0.8, 0.8];
    const col = n.props.use_diffuse === false ? [0, 0, 0] : base;
    return [[col[0], col[1], col[2], 1], [ma ? (ma.useTransparency ? ma.alpha : 1) : 1], [0, 0, 1]];
  },
});

def({ id: 'ShaderNodeExtendedMaterial', label: 'Extended Material', category: 'INPUT', unavailable: true, inputs: [], outputs: [OUT('Color')] });

def({
  id: 'ShaderNodeRGB', label: 'RGB', category: 'INPUT',
  inputs: [], outputs: [OUT('Color')],
  init: (n) => { n.props.color = [0.5, 0.5, 0.5, 1]; },
  draw: (l, n) => { l.prop({ kind: 'color', name: 'Color', get: () => (n.props.color as number[]).slice(), set: (v) => { n.props.color = [v[0], v[1], v[2], 1]; }, notify: ['data'] }, { text: '' }).style.height = '60px'; },
  exec: (n) => [(n.props.color as number[]).slice(0, 4)],
});

def({
  id: 'ShaderNodeValue', label: 'Value', category: 'INPUT',
  inputs: [], outputs: [OUT('Value', 'VALUE')],
  init: (n) => { n.props.value = 0.5; },
  draw: (l, n) => { l.prop({ kind: 'float', name: '', precision: 3, get: () => Number(n.props.value), set: (v) => { n.props.value = v; }, notify: ['data'] }); },
  exec: (n) => [[Number(n.props.value)]],
});

/** Average colour of a texture (image textures are sampled once loaded; procedural ones use their tint). */
const texAverage = new Map<string, { key: string; color: number[] }>();
function textureAverage(tex: TextureData): number[] {
  const key = `${tex.type}|${tex.imageData?.length ?? 0}|${tex.intensity}|${tex.contrast}|${tex.colorTint.join(',')}`;
  const hit = texAverage.get(tex.id);
  if (hit && hit.key === key) return hit.color;
  const color = [0.5 * tex.colorTint[0], 0.5 * tex.colorTint[1], 0.5 * tex.colorTint[2], 1];
  if (tex.type === 'IMAGE' && tex.imageData) {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = 16; c.height = 16;
      const g = c.getContext('2d', { willReadFrequently: true })!;
      g.drawImage(img, 0, 0, 16, 16);
      const d = g.getImageData(0, 0, 16, 16).data;
      const acc = [0, 0, 0];
      for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) acc[k] += srgbToLinear(d[i + k] / 255);
      texAverage.set(tex.id, { key, color: [acc[0] / 256, acc[1] / 256, acc[2] / 256, 1] });
      app.tagAllGeometry();
    };
    img.src = tex.imageData;
  }
  texAverage.set(tex.id, { key, color });
  return color;
}

def({
  id: 'ShaderNodeTexture', label: 'Texture', category: 'INPUT', width: 160,
  inputs: [VEC('Vector', 'Vector', [0, 0, 0], true)], outputs: [OUT('Value', 'VALUE'), OUT('Color'), OUT('Normal', 'VECTOR')],
  init: (n) => { n.props.texture = null; },
  draw: (l, n) => {
    l.prop(eprop(P(n), 'texture', () => [{ id: '', label: '' }, ...Object.values(app.doc.textures).map((t) => ({ id: t.id, label: t.name, icon: 'TEXTURE' }))], { name: 'Texture', notify: ['data'] }), { noLabel: true, icon: 'TEXTURE' });
  },
  exec: (n, _ins, ctx) => {
    const tex = app.doc.textures[(n.props.texture as string) ?? ''];
    ctx.constant = false;
    if (!tex || tex.type === 'NONE') return [[0], [0, 0, 0, 1], [0, 0, 1]];
    const c = textureAverage(tex);
    return [[bw(c[0], c[1], c[2])], c, [0, 0, 1]];
  },
});

def({
  id: 'ShaderNodeGeometry', label: 'Geometry', category: 'INPUT',
  inputs: [],
  outputs: [OUT('Global', 'VECTOR'), OUT('Local', 'VECTOR'), OUT('View', 'VECTOR'), OUT('Orco', 'VECTOR'), OUT('UV', 'VECTOR'), OUT('Normal', 'VECTOR'), OUT('Vertex Color', 'RGBA', 'Vertex Color'), OUT('Vertex Alpha', 'VALUE', 'Vertex Alpha'), OUT('Front/Back', 'VALUE', 'Front/Back')],
  init: (n) => { n.props.uv_layer = ''; n.props.color_layer = ''; },
  exec: (_n, _i, ctx) => { ctx.constant = false; return [[0, 0, 0], [0, 0, 0], [0, 0, -1], [0.5, 0.5, 0.5], [0.5, 0.5, 0], [0, 0, 1], [1, 1, 1, 1], [1], [1]]; },
});

for (const [id, label] of [['ShaderNodeCameraData', 'Camera Data'], ['ShaderNodeLampData', 'Lamp Data'], ['ShaderNodeParticleInfo', 'Particle Info'], ['ShaderNodeObjectInfo', 'Object Info']] as [string, string][]) {
  def({ id, label, category: 'INPUT', unavailable: true, inputs: [], outputs: [OUT('Value', 'VALUE')] });
}

def({
  id: 'ShaderNodeMixRGB', label: 'Mix', category: 'COLOR',
  inputs: [VAL('Fac', 'Fac', 0.5, 0, 1, true), RGBA('Color1', 'Color1'), RGBA('Color2', 'Color2')], outputs: [OUT('Color')],
  init: (n) => { n.props.blend_type = 'MIX'; n.props.use_alpha = false; n.props.use_clamp = false; },
  dynLabel: (n) => BLEND_MODES.find((b) => b[0] === n.props.blend_type)?.[1] ?? 'Mix',
  draw: (l, n) => {
    l.prop(eprop(P(n), 'blend_type', BLEND_MODES.map(([id, label]) => ({ id, label })), { name: 'Blend Type', notify: ['data'] }), { noLabel: true });
    const r = l.row(true);
    r.prop(bprop(P(n), 'use_alpha', { name: '', notify: ['data'] }), { iconOnly: true, icon: 'IMAGE_RGB_ALPHA' });
    r.prop(bprop(P(n), 'use_clamp', { name: 'Clamp', notify: ['data'] }));
  },
  exec: (n, ins) => {
    const out = ins[1].slice(0, 4);
    let f = ins[0][0];
    if (n.props.use_alpha) f *= ins[2][3] ?? 1;
    blendRGB(String(n.props.blend_type), out, ins[2], f);
    if (n.props.use_clamp) for (let i = 0; i < 3; i++) out[i] = clamp01(out[i]);
    return [out];
  },
});

def({
  id: 'ShaderNodeInvert', label: 'Invert', category: 'COLOR',
  inputs: [VAL('Fac', 'Fac', 1, 0, 1, true), RGBA('Color', 'Color', [0, 0, 0, 1])], outputs: [OUT('Color')],
  exec: (_n, ins) => { const f = ins[0][0], c = ins[1]; return [[0, 1, 2].map((i) => c[i] + (1 - 2 * c[i]) * f).concat([c[3] ?? 1])]; },
});

def({
  id: 'ShaderNodeHueSaturation', label: 'Hue/Saturation', category: 'COLOR',
  inputs: [VAL('Hue', 'Hue', 0.5, 0, 1, true), VAL('Saturation', 'Saturation', 1, 0, 2), VAL('Value', 'Value', 1, 0, 2), VAL('Fac', 'Fac', 1, 0, 1, true), RGBA('Color', 'Color', [0.8, 0.8, 0.8, 1])], outputs: [OUT('Color')],
  exec: (_n, ins) => {
    const c = ins[4], hsv = [0, 0, 0], o = [0, 0, 0];
    rgbToHsv(c[0], c[1], c[2], hsv);
    hsvToRgb(hsv[0] + ins[0][0] - 0.5, clamp01(hsv[1] * ins[1][0]), hsv[2] * ins[2][0], o);
    const f = ins[3][0];
    return [[0, 1, 2].map((i) => c[i] + (o[i] - c[i]) * f).concat([c[3] ?? 1])];
  },
});

def({
  id: 'ShaderNodeGamma', label: 'Gamma', category: 'COLOR',
  inputs: [RGBA('Color', 'Color', [1, 1, 1, 1]), VAL('Gamma', 'Gamma', 1, 0.001, 10)], outputs: [OUT('Color')],
  exec: (_n, ins) => [[0, 1, 2].map((i) => (ins[0][i] > 0 ? Math.pow(ins[0][i], ins[1][0]) : ins[0][i])).concat([ins[0][3] ?? 1])],
});

def({ id: 'ShaderNodeRGBCurve', label: 'RGB Curves', category: 'COLOR', unavailable: true, inputs: [RGBA('Color')], outputs: [OUT('Color')] });

def({
  id: 'ShaderNodeValToRGB', label: 'ColorRamp', category: 'CONVERTER', width: 240,
  inputs: [VAL('Fac', 'Fac', 0.5, 0, 1, true)], outputs: [OUT('Color'), OUT('Alpha', 'VALUE')],
  init: (n) => { n.props.color_ramp = defaultColorRamp(); },
  draw: (l, n) => colorRampWidget(l, () => n.props.color_ramp as ColorRampData),
  exec: (n, ins) => { const o = [0, 0, 0, 1]; evalColorRamp(n.props.color_ramp as ColorRampData, ins[0][0], o); return [o, [o[3]]]; },
});

def({
  id: 'ShaderNodeRGBToBW', label: 'RGB to BW', category: 'CONVERTER',
  inputs: [RGBA('Color')], outputs: [OUT('Val', 'VALUE')],
  exec: (_n, ins) => [[bw(ins[0][0], ins[0][1], ins[0][2])]],
});

def({
  id: 'ShaderNodeMath', label: 'Math', category: 'CONVERTER',
  inputs: [VAL('Value', 'Value', 0.5, -10000, 10000), VAL('Value_001', 'Value', 0.5, -10000, 10000)], outputs: [OUT('Value', 'VALUE')],
  init: (n) => { n.props.operation = 'ADD'; n.props.use_clamp = false; },
  dynLabel: (n) => MATH_OPS.find((m) => m[0] === n.props.operation)?.[1] ?? 'Math',
  draw: (l: Layout, n) => {
    l.prop(eprop(P(n), 'operation', MATH_OPS.map(([id, label]) => ({ id, label })), { name: 'Operation', notify: ['data'] }), { noLabel: true });
    l.prop(bprop(P(n), 'use_clamp', { name: 'Clamp', notify: ['data'] }));
  },
  exec: (n, ins) => { const r = mathOp(String(n.props.operation), ins[0][0], ins[1][0]); return [[n.props.use_clamp ? clamp01(r) : r]]; },
});

def({
  id: 'ShaderNodeSeparateRGB', label: 'Separate RGB', category: 'CONVERTER',
  inputs: [RGBA('Image', 'Image', [0.8, 0.8, 0.8, 1])], outputs: [OUT('R', 'VALUE'), OUT('G', 'VALUE'), OUT('B', 'VALUE')],
  exec: (_n, ins) => [[ins[0][0]], [ins[0][1]], [ins[0][2]]],
});

def({
  id: 'ShaderNodeCombineRGB', label: 'Combine RGB', category: 'CONVERTER',
  inputs: [VAL('R', 'R', 0, 0, 1), VAL('G', 'G', 0, 0, 1), VAL('B', 'B', 0, 0, 1)], outputs: [OUT('Image')],
  exec: (_n, ins) => [[ins[0][0], ins[1][0], ins[2][0], 1]],
});

for (const [id, label, cat] of [['ShaderNodeVectorMath', 'Vector Math', 'CONVERTER'], ['ShaderNodeSqueeze', 'Squeeze Value', 'CONVERTER'], ['ShaderNodeSeparateHSV', 'Separate HSV', 'CONVERTER'], ['ShaderNodeCombineHSV', 'Combine HSV', 'CONVERTER'], ['ShaderNodeNormal', 'Normal', 'VECTOR'], ['ShaderNodeMapping', 'Mapping', 'VECTOR'], ['ShaderNodeVectorCurve', 'Vector Curves', 'VECTOR'], ['ShaderNodeVectorTransform', 'Vector Transform', 'VECTOR']] as [string, string, 'CONVERTER' | 'VECTOR'][]) {
  def({ id, label, category: cat, unavailable: true, inputs: [VEC('Vector')], outputs: [OUT('Vector', 'VECTOR')] });
}
def({ id: 'ShaderNodeGroup', label: 'Group', category: 'GROUP', unavailable: true, inputs: [], outputs: [] });

// ------------------------------------------------------------------ evaluation

function socketDefault(node: BNode, s: SocketDef): SVal {
  const v = node.inputs[s.id] ?? s.default ?? 0;
  const arr = Array.isArray(v) ? v.slice() : [Number(v)];
  if (s.type === 'RGBA') { while (arr.length < 4) arr.push(arr.length === 3 ? 1 : arr[0] ?? 0); return arr.slice(0, 4); }
  if (s.type === 'VECTOR') { while (arr.length < 3) arr.push(arr[0] ?? 0); return arr.slice(0, 3); }
  return [arr.length >= 3 ? bw(arr[0], arr[1], arr[2]) : arr[0]];
}

function convertTo(v: SVal, type: SocketDef['type']): SVal {
  if (type === 'VALUE') return [v.length >= 3 ? (v.length === 4 ? bw(v[0], v[1], v[2]) : (v[0] + v[1] + v[2]) / 3) : v[0]];
  if (type === 'RGBA') return v.length === 1 ? [v[0], v[0], v[0], 1] : v.length === 3 ? [v[0], v[1], v[2], 1] : v.slice(0, 4);
  if (type === 'VECTOR') return v.length === 1 ? [v[0], v[0], v[0]] : v.slice(0, 3);
  return v;
}

/** Evaluate a material's node tree to a constant colour (null when there is no output). */
export function evaluateShaderTree(tree: NodeTree, owner: MaterialData | null): { color: number[]; alpha: number; constant: boolean } | null {
  const out = tree.nodes.find((n) => n.type === 'ShaderNodeOutput' && !n.mute);
  if (!out) return null;
  const ctx: SCtx = { owner, constant: true };
  const memo = new Map<string, SVal[]>();
  const stack = new Set<string>();
  const evalNode = (n: BNode): SVal[] => {
    const hit = memo.get(n.name);
    if (hit) return hit;
    if (stack.has(n.name)) return nodeOutputs(n).map((s) => convertTo([0], s.type));
    stack.add(n.name);
    const ins = nodeInputs(n).map((s) => {
      const l = linkTo(tree, n.name, s.id);
      if (l) {
        const f = findNode(tree, l.fromNode);
        if (f) {
          const fo = evalNode(f);
          const idx = nodeOutputs(f).findIndex((o) => o.id === l.fromSocket);
          if (fo[idx]) { const v = convertTo(fo[idx], s.type); return s.id === 'Color' && n.type === 'ShaderNodeMaterial' ? [...v.slice(0, 4), 1] : v; }
        }
      }
      return socketDefault(n, s);
    });
    const ex = shExec.get(n.type);
    let res: SVal[];
    if (n.mute || !ex) {
      const inDefs = nodeInputs(n);
      res = nodeOutputs(n).map((o) => { const i = inDefs.findIndex((s) => s.type === o.type); return convertTo(ins[i >= 0 ? i : 0] ?? [0], o.type); });
    } else res = ex(n, ins, ctx);
    stack.delete(n.name);
    memo.set(n.name, res);
    return res;
  };
  const ins = nodeInputs(out).map((s) => {
    const l = linkTo(tree, out.name, s.id);
    if (l) { const f = findNode(tree, l.fromNode); if (f) { const fo = evalNode(f); const idx = nodeOutputs(f).findIndex((o) => o.id === l.fromSocket); if (fo[idx]) return convertTo(fo[idx], s.type); } }
    return socketDefault(out, s);
  });
  return { color: ins[0].slice(0, 3), alpha: ins[1][0], constant: ctx.constant };
}

/** Diffuse colour of a material for display: the node tree result when the material uses nodes. */
export function materialDiffuse(ma: MaterialData): [number, number, number] {
  if (ma.useNodes && ma.nodeTree && isBI()) {
    const r = evaluateShaderTree(ma.nodeTree, ma);
    if (r) return [r.color[0], r.color[1], r.color[2]];
  }
  return [ma.diffuseColor[0], ma.diffuseColor[1], ma.diffuseColor[2]];
}
