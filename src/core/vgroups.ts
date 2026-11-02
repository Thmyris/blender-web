// Vertex groups: per-object group names with per-vertex weights stored on the mesh (`MeshData.dvert`,
// lists of [group index, weight] pairs like Blender's MDeformVert), helpers to read and write
// weights, and the mesh layer that keeps weights consistent through edit-mode topology changes.

import type { BObject, Doc, MeshData, VertexGroup } from './types';
import { registerMeshLayer, type TopologyMap } from './meshlayers';

export function groupsOf(ob: BObject): VertexGroup[] {
  ob.vertexGroups ??= [];
  return ob.vertexGroups;
}

export function groupIndex(ob: BObject, name: string): number {
  return (ob.vertexGroups ?? []).findIndex((g) => g.name === name);
}

export function activeGroupIndex(ob: BObject): number {
  const n = ob.vertexGroups?.length ?? 0;
  if (!n) return -1;
  const i = ob.activeVertexGroup ?? 0;
  return Math.min(Math.max(0, i), n - 1);
}

export function uniqueGroupName(ob: BObject, base: string, ignore = -1): string {
  const names = new Set((ob.vertexGroups ?? []).filter((_, i) => i !== ignore).map((g) => g.name));
  if (!names.has(base)) return base;
  const m = /^(.*)\.(\d{3,})$/.exec(base);
  const stem = m ? m[1] : base;
  for (let i = 1; i < 100000; i++) { const c = `${stem}.${String(i).padStart(3, '0')}`; if (!names.has(c)) return c; }
  return `${stem}.${Date.now()}`;
}

export function addGroup(ob: BObject, name = 'Group'): number {
  const gs = groupsOf(ob);
  gs.push({ name: uniqueGroupName(ob, name), lockWeight: false });
  ob.activeVertexGroup = gs.length - 1;
  return gs.length - 1;
}

/** Make sure the weight array exists and matches the vertex count. */
export function ensureDvert(md: MeshData): [number, number][][] {
  if (!md.dvert) md.dvert = md.verts.map(() => []);
  if (md.dvert.length !== md.verts.length) {
    if (md.dvert.length > md.verts.length) md.dvert.length = md.verts.length;
    while (md.dvert.length < md.verts.length) md.dvert.push([]);
  }
  return md.dvert;
}

export function getWeight(md: MeshData, v: number, g: number): number {
  const dv = md.dvert?.[v];
  if (!dv) return 0;
  for (const [gi, w] of dv) if (gi === g) return w;
  return 0;
}

/** Is vertex `v` in group `g` (assigned, even with weight 0)? */
export function inGroup(md: MeshData, v: number, g: number): boolean {
  return !!md.dvert?.[v]?.some(([gi]) => gi === g);
}

export function setWeight(md: MeshData, v: number, g: number, w: number): void {
  const dv = ensureDvert(md)[v];
  const e = dv.find(([gi]) => gi === g);
  const val = Math.min(1, Math.max(0, w));
  if (e) e[1] = val; else dv.push([g, val]);
}

export function removeWeight(md: MeshData, v: number, g: number): void {
  const dv = md.dvert?.[v];
  if (!dv) return;
  const i = dv.findIndex(([gi]) => gi === g);
  if (i >= 0) dv.splice(i, 1);
}

/** Remove group `g` from the object, shifting the indices of the following groups in its mesh weights. */
export function removeGroup(ob: BObject, md: MeshData | null, g: number): void {
  const gs = groupsOf(ob);
  if (g < 0 || g >= gs.length) return;
  gs.splice(g, 1);
  if (md?.dvert) {
    for (const dv of md.dvert) {
      for (let i = dv.length - 1; i >= 0; i--) {
        if (dv[i][0] === g) dv.splice(i, 1);
        else if (dv[i][0] > g) dv[i][0]--;
      }
    }
  }
  if ((ob.activeVertexGroup ?? 0) >= gs.length) ob.activeVertexGroup = Math.max(0, gs.length - 1);
  if (!gs.length && md) delete md.dvert;
}

/** Reorder groups by `order` (new index -> old index). */
export function reorderGroups(ob: BObject, md: MeshData | null, order: number[]): void {
  const gs = groupsOf(ob);
  const old = gs.slice();
  const map = new Map<number, number>();
  order.forEach((o, n) => map.set(o, n));
  ob.vertexGroups = order.map((o) => old[o]);
  if (md?.dvert) for (const dv of md.dvert) for (const e of dv) e[0] = map.get(e[0]) ?? e[0];
  const act = ob.activeVertexGroup ?? 0;
  ob.activeVertexGroup = map.get(act) ?? 0;
}

/**
 * Weights of the group named `name` for every vertex of `md` (0 when not assigned), or null when the
 * object has no such group. Modifiers use this to read vertex groups.
 */
export function vertexGroupWeights(ob: BObject | undefined, md: MeshData | null | undefined, name: string | null | undefined, invert = false): Float32Array | null {
  if (!ob || !md || !name) return null;
  const g = groupIndex(ob, name);
  if (g < 0) return null;
  const out = new Float32Array(md.verts.length);
  for (let v = 0; v < md.verts.length; v++) {
    const w = getWeight(md, v, g);
    out[v] = invert ? 1 - w : w;
  }
  return out;
}

/** Mesh data of an object (deform weights live on the mesh). */
export function meshOfOb(doc: Doc, ob: BObject | null | undefined): MeshData | null {
  return ob && ob.type === 'MESH' && ob.data ? doc.meshes[ob.data] ?? null : null;
}

/** Copy vertex groups (names) and weights from one object/mesh to another (e.g. join). */
export function mergeWeightsInto(dstOb: BObject, dst: MeshData, dstStart: number, srcOb: BObject, src: MeshData): void {
  if (!src.dvert || !srcOb.vertexGroups?.length) return;
  const remap = srcOb.vertexGroups.map((g) => {
    let i = groupIndex(dstOb, g.name);
    if (i < 0) { groupsOf(dstOb).push({ name: g.name, lockWeight: g.lockWeight }); i = dstOb.vertexGroups!.length - 1; }
    return i;
  });
  const dv = ensureDvert(dst);
  for (let v = 0; v < src.verts.length && dstStart + v < dv.length; v++) {
    dv[dstStart + v] = (src.dvert[v] ?? []).map(([g, w]) => [remap[g] ?? g, w] as [number, number]);
  }
}

// ------------------------------------------------------------------ topology layer

function remapDvert(old: [number, number][][], map: TopologyMap): [number, number][][] {
  return map.vertSources.map((src) => {
    if (src.length === 1) return (old[src[0].index] ?? []).map(([g, w]) => [g, w] as [number, number]);
    const acc = new Map<number, number>();
    for (const s of src) for (const [g, w] of old[s.index] ?? []) acc.set(g, (acc.get(g) ?? 0) + w * s.weight);
    // a group is kept when any source vertex was in it
    return [...acc.entries()].map(([g, w]) => [g, Math.min(1, w)] as [number, number]);
  });
}

registerMeshLayer({
  name: 'dvert',
  has: (md) => !!md.dvert,
  capture: (md) => (md.dvert ?? []).map((dv) => dv.map(([g, w]) => [g, w] as [number, number])),
  remap: (md, _ob, captured, map) => { md.dvert = remapDvert(captured as [number, number][][], map); },
  remapSplit: (newMd, newOb, captured, map, srcOb) => {
    if (!srcOb?.vertexGroups?.length) return;
    newOb.vertexGroups = srcOb.vertexGroups.map((g) => ({ ...g }));
    newOb.activeVertexGroup = srcOb.activeVertexGroup ?? 0;
    newMd.dvert = remapDvert(captured as [number, number][][], map);
  },
});
