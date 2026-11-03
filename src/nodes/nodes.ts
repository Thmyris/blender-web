// Node system core shared by all node tree types (compositing, Blender Internal shader nodes and any
// tree type registered later, e.g. Cycles shader nodes): socket and node type registry, node tree
// creation and editing helpers (add, link, unlink, duplicate, topological order).

import type { BNode, NodeLink, NodeTree, NodeTreeType, SocketValue } from '../core/edtypes';
import type { Layout } from '../ui/layout';
import type { UnitType } from '../ui/format';

export type SocketType = 'RGBA' | 'VALUE' | 'VECTOR' | 'SHADER';

export interface SocketDef {
  /** Identifier (unique per node side), e.g. "Image" and "Image_001" for the two Mix inputs. */
  id: string;
  name: string;
  type: SocketType;
  default?: number | number[];
  min?: number;
  max?: number;
  /** Shown as a slider (factors). */
  slider?: boolean;
  unit?: UnitType;
  step?: number;
  /** Don't draw a value widget when unlinked. */
  hideValue?: boolean;
  description?: string;
}

/** 2.79 node class colours (node header by category). */
export type NodeCategory =
  | 'INPUT' | 'OUTPUT' | 'COLOR' | 'CONVERTER' | 'FILTER' | 'VECTOR' | 'MATTE' | 'DISTORT' | 'LAYOUT'
  | 'SHADER' | 'TEXTURE' | 'GROUP' | 'SCRIPT';

export const CATEGORY_COLOR: Record<NodeCategory, string> = {
  INPUT: '#cb3d3d',
  OUTPUT: '#cb3d3d',
  COLOR: '#a8a83d',
  CONVERTER: '#3d8ccb',
  FILTER: '#7a4f86',
  VECTOR: '#6363c7',
  MATTE: '#973c3c',
  DISTORT: '#4c9797',
  LAYOUT: '#6c696f',
  SHADER: '#24b524',
  TEXTURE: '#d0832a',
  GROUP: '#3b8f59',
  SCRIPT: '#16706c',
};

export const SOCKET_COLOR: Record<SocketType, string> = {
  RGBA: '#c7c729',
  VALUE: '#a1a1a1',
  VECTOR: '#6363c7',
  SHADER: '#63c763',
};

export interface NodeDrawCtx {
  tree: NodeTree;
  /** True when drawing into the sidebar (N panel) instead of the node itself. */
  sidebar: boolean;
}

export interface NodeTypeDef {
  /** bl_idname, e.g. "CompositorNodeMixRGB". */
  id: string;
  label: string;
  tree: NodeTreeType;
  /** Also available in these tree types (Frame, Reroute). */
  trees?: NodeTreeType[];
  category: NodeCategory;
  description?: string;
  inputs: SocketDef[] | ((node: BNode) => SocketDef[]);
  outputs: SocketDef[] | ((node: BNode) => SocketDef[]);
  width?: number;
  /** Default settings of a new node. */
  init?: (node: BNode, tree: NodeTree) => void;
  /** Buttons drawn inside the node (draw_buttons). */
  draw?: (l: Layout, node: BNode, ctx: NodeDrawCtx) => void;
  /** Buttons drawn in the sidebar "Properties" panel (draw_buttons_ext); defaults to `draw`. */
  drawExt?: (l: Layout, node: BNode, ctx: NodeDrawCtx) => void;
  /** Dynamic header label (e.g. Mix shows its blend mode). */
  dynLabel?: (node: BNode) => string;
  /** Only offered in the Add menu when this returns true (e.g. depending on the render engine). */
  poll?: () => boolean;
  /** Shown greyed out in the Add menu. */
  unavailable?: boolean;
  /** Only one per tree (e.g. Composite). */
  single?: boolean;
  /** Frame / Reroute special nodes. */
  special?: 'FRAME' | 'REROUTE';
}

const nodeTypes = new Map<string, NodeTypeDef>();

export function registerNodeType(def: NodeTypeDef): void { nodeTypes.set(def.id, def); }
export function nodeType(id: string): NodeTypeDef | undefined { return nodeTypes.get(id); }
export function nodeTypesFor(tree: NodeTreeType): NodeTypeDef[] { return [...nodeTypes.values()].filter((d) => d.tree === tree || !!d.trees?.includes(tree)); }

export function nodeInputs(node: BNode): SocketDef[] {
  const d = nodeTypes.get(node.type);
  if (!d) return [];
  return typeof d.inputs === 'function' ? d.inputs(node) : d.inputs;
}

export function nodeOutputs(node: BNode): SocketDef[] {
  const d = nodeTypes.get(node.type);
  if (!d) return [];
  return typeof d.outputs === 'function' ? d.outputs(node) : d.outputs;
}

export function nodeLabel(node: BNode): string {
  if (node.label) return node.label;
  const d = nodeTypes.get(node.type);
  return d?.dynLabel?.(node) ?? d?.label ?? node.type;
}

// ------------------------------------------------------------------ tree types

export interface TreeTypeDef {
  id: NodeTreeType;
  label: string;
  icon: string;
  description: string;
  /** Add-menu categories in order. */
  categories: () => { id: NodeCategory; label: string }[];
  /** Whether this tree type can be edited at the moment (Texture nodes are not available). */
  available?: () => boolean;
}

const treeTypes = new Map<NodeTreeType, TreeTypeDef>();
export function registerTreeType(def: TreeTypeDef): void { treeTypes.set(def.id, def); }
export function treeType(id: NodeTreeType): TreeTypeDef | undefined { return treeTypes.get(id); }
export function allTreeTypes(): TreeTypeDef[] { return [...treeTypes.values()]; }

/**
 * Builders for the default tree created by "Use Nodes" (keyed by tree type). A builder may return
 * null to defer to the next one, so another engine (e.g. Cycles) can register its own default.
 */
export const defaultTreeBuilders: { tree: NodeTreeType; build: () => NodeTree | null }[] = [];

export function newNodeTree(type: NodeTreeType): NodeTree {
  return { type, nodes: [], links: [], active: null };
}

export function buildDefaultTree(type: NodeTreeType): NodeTree {
  for (const b of defaultTreeBuilders) {
    if (b.tree !== type) continue;
    const t = b.build();
    if (t) return t;
  }
  return newNodeTree(type);
}

// ------------------------------------------------------------------ editing helpers

function clone<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }

export function uniqueNodeName(tree: NodeTree, base: string): string {
  const names = new Set(tree.nodes.map((n) => n.name));
  if (!names.has(base)) return base;
  const m = /^(.*)\.(\d{3,})$/.exec(base);
  const stem = m ? m[1] : base;
  for (let i = 1; ; i++) {
    const c = `${stem}.${String(i).padStart(3, '0')}`;
    if (!names.has(c)) return c;
  }
}

/** Create a node of the given type (not yet added to a tree unless `tree` is given). */
export function createNode(tree: NodeTree, type: string, location: [number, number] = [0, 0], add = true): BNode {
  const d = nodeTypes.get(type);
  if (!d) throw new Error(`Unknown node type "${type}"`);
  const node: BNode = {
    name: uniqueNodeName(tree, d.label), type, label: '', location: [location[0], location[1]], width: d.width ?? 140,
    select: true, hide: false, mute: false, parent: null, inputs: {}, props: {},
  };
  for (const s of typeof d.inputs === 'function' ? d.inputs(node) : d.inputs) {
    if (s.default !== undefined) node.inputs[s.id] = clone(s.default);
  }
  d.init?.(node, tree);
  // sockets can depend on settings made by init
  for (const s of nodeInputs(node)) if (s.default !== undefined && node.inputs[s.id] === undefined) node.inputs[s.id] = clone(s.default);
  if (add) tree.nodes.push(node);
  return node;
}

export function findNode(tree: NodeTree, name: string | null | undefined): BNode | undefined {
  return name ? tree.nodes.find((n) => n.name === name) : undefined;
}

export function inputValue(node: BNode, sock: SocketDef): SocketValue {
  return node.inputs[sock.id] ?? clone(sock.default ?? 0);
}

export function linkTo(tree: NodeTree, node: string, socket: string): NodeLink | undefined {
  return tree.links.find((l) => l.toNode === node && l.toSocket === socket);
}

export function linksFrom(tree: NodeTree, node: string, socket?: string): NodeLink[] {
  return tree.links.filter((l) => l.fromNode === node && (socket === undefined || l.fromSocket === socket));
}

/** True if `a` (transitively) feeds into `b`. */
export function dependsOn(tree: NodeTree, b: string, a: string): boolean {
  const seen = new Set<string>();
  const stack = [b];
  while (stack.length) {
    const n = stack.pop()!;
    if (n === a) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const l of tree.links) if (l.toNode === n) stack.push(l.fromNode);
  }
  return false;
}

/** Link output `from.fromSocket` to input `to.toSocket`, replacing an existing link to that input. Refuses cycles. */
export function addLink(tree: NodeTree, fromNode: string, fromSocket: string, toNode: string, toSocket: string): boolean {
  if (fromNode === toNode) return false;
  if (dependsOn(tree, fromNode, toNode)) return false;
  tree.links = tree.links.filter((l) => !(l.toNode === toNode && l.toSocket === toSocket));
  tree.links.push({ fromNode, fromSocket, toNode, toSocket });
  return true;
}

export function removeNodes(tree: NodeTree, names: Set<string>, reconnect = false): void {
  if (reconnect) {
    // Delete with Reconnect: link the first linked input's source to all targets of matching outputs
    for (const name of names) {
      const node = findNode(tree, name);
      if (!node) continue;
      const inLink = tree.links.find((l) => l.toNode === name && !names.has(l.fromNode));
      if (!inLink) continue;
      for (const out of tree.links.filter((l) => l.fromNode === name && !names.has(l.toNode))) {
        tree.links.push({ fromNode: inLink.fromNode, fromSocket: inLink.fromSocket, toNode: out.toNode, toSocket: out.toSocket });
      }
    }
  }
  tree.nodes = tree.nodes.filter((n) => !names.has(n.name));
  tree.links = tree.links.filter((l) => !names.has(l.fromNode) && !names.has(l.toNode));
  for (const n of tree.nodes) if (n.parent && names.has(n.parent)) n.parent = null;
  if (tree.active && names.has(tree.active)) tree.active = null;
}

/** Duplicate the selected nodes (and the links between them); the copies become the selection. */
export function duplicateSelected(tree: NodeTree, keepInputs = true): BNode[] {
  const sel = tree.nodes.filter((n) => n.select);
  const map = new Map<string, string>();
  const copies: BNode[] = [];
  for (const n of sel) {
    const c = clone(n);
    c.name = uniqueNodeName(tree, n.name);
    map.set(n.name, c.name);
    tree.nodes.push(c);
    copies.push(c);
    n.select = false;
  }
  for (const c of copies) if (c.parent && map.has(c.parent)) c.parent = map.get(c.parent)!;
  const newLinks: NodeLink[] = [];
  for (const l of tree.links) {
    const f = map.get(l.fromNode), t = map.get(l.toNode);
    if (f && t) newLinks.push({ fromNode: f, fromSocket: l.fromSocket, toNode: t, toSocket: l.toSocket });
    else if (t && keepInputs) newLinks.push({ fromNode: l.fromNode, fromSocket: l.fromSocket, toNode: t, toSocket: l.toSocket });
  }
  tree.links.push(...newLinks);
  if (copies.length) tree.active = copies[copies.length - 1].name;
  return copies;
}

/** Nodes in evaluation order (sources first). Cycles are broken arbitrarily. */
export function topoOrder(tree: NodeTree): BNode[] {
  const out: BNode[] = [];
  const state = new Map<string, 1 | 2>();
  const byName = new Map(tree.nodes.map((n) => [n.name, n]));
  const visit = (n: BNode) => {
    const s = state.get(n.name);
    if (s) return;
    state.set(n.name, 1);
    for (const l of tree.links) if (l.toNode === n.name) { const f = byName.get(l.fromNode); if (f && state.get(f.name) !== 1) visit(f); }
    state.set(n.name, 2);
    out.push(n);
  };
  for (const n of tree.nodes) visit(n);
  return out;
}

/** Socket of the node by identifier. */
export function socketDef(node: BNode, id: string, side: 'in' | 'out'): SocketDef | undefined {
  return (side === 'in' ? nodeInputs(node) : nodeOutputs(node)).find((s) => s.id === id);
}

/** Remove links whose sockets no longer exist (after a node's sockets changed). */
export function validateLinks(tree: NodeTree): void {
  const byName = new Map(tree.nodes.map((n) => [n.name, n]));
  tree.links = tree.links.filter((l) => {
    const a = byName.get(l.fromNode), b = byName.get(l.toNode);
    return !!a && !!b && !!socketDef(a, l.fromSocket, 'out') && !!socketDef(b, l.toSocket, 'in');
  });
}

/** Find the best matching input socket for linking from a socket of `type` (F, auto-linking). */
export function bestInput(node: BNode, type: SocketType, tree: NodeTree, preferFree = true): SocketDef | undefined {
  const ins = nodeInputs(node).filter((s) => !(node.hiddenSockets ?? []).includes(s.id));
  const free = (s: SocketDef) => !linkTo(tree, node.name, s.id);
  return ins.find((s) => s.type === type && (!preferFree || free(s)))
    ?? ins.find((s) => !preferFree || free(s))
    ?? ins[0];
}
