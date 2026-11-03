// UV selection model of the UV/Image Editor (Blender 2.79): per-corner selection flags when
// "UV Sync Selection" is off (only the faces selected in the mesh are shown), or the mesh
// selection itself when it is on. Sticky selection (Disabled / Shared Location / Shared Vertex),
// UV select modes (Vertex / Edge / Face / Island) and helpers used by the UV operators.

import { app } from '../../app';
import type { MeshData, MeshUVLayer, UVEditSettings } from '../../core/types';
import { edgeKey, flushSelection, selectModeOf } from '../../core/mesh';
import { UV_PIN, UV_SELECT, activeUVLayer, cornerUV, ensureFlags, ensureUVShape } from '../../core/uvdata';
import { uvIslands } from '../../core/unwrap';

export const STICKY_EPS = 1e-5;

export function uvSettings(): UVEditSettings {
  const ts = app.scene.toolSettings;
  ts.uvEdit ??= { selectMode: 'VERTEX', stickyMode: 'SHARED_LOCATION', useSync: false, pivot: 'BOUNDING_BOX_CENTER', cursor: [0, 0] };
  ts.uvEdit.cursor ??= [0, 0];
  ts.uvEdit.pivot ??= 'BOUNDING_BOX_CENTER';
  return ts.uvEdit;
}

/** Mesh + active UV layer being edited in the UV editor (null when not in mesh edit mode). */
export function uvContext(create = false): { md: MeshData; layer: MeshUVLayer } | null {
  const md = app.editMesh;
  if (!md) return null;
  let layer = activeUVLayer(md);
  if (!layer && create) {
    // Blender creates a UV map on demand (e.g. when unwrapping a mesh that has none)
    md.uvLayers = [{ name: 'UVMap', uv: md.faces.map(() => []) }];
    md.uvActive = 0;
    md.uvActiveRender = 0;
    ensureUVShape(md);
    layer = md.uvLayers[0];
  }
  if (!layer) return null;
  if (layer.uv.length !== md.faces.length) ensureUVShape(md);
  return { md, layer };
}

export const isSync = (): boolean => uvSettings().useSync;

/** Faces shown in the UV editor. */
export function visibleFaces(md: MeshData): number[] {
  const out: number[] = [];
  const sync = isSync();
  for (let f = 0; f < md.faces.length; f++) {
    if (md.fhide?.[f]) continue;
    if (sync || md.fsel[f]) out.push(f);
  }
  return out;
}

export function isFaceVisible(md: MeshData, f: number): boolean {
  return !md.fhide?.[f] && (isSync() || !!md.fsel[f]);
}

/** Is corner k of face f UV-selected? */
export function cornerSelected(md: MeshData, layer: MeshUVLayer, f: number, k: number): boolean {
  if (isSync()) {
    const mode = selectModeOf(app.scene.toolSettings.meshSelectMode);
    return mode === 'FACE' ? !!md.fsel[f] : !!md.vsel[md.faces[f][k]];
  }
  return ((layer.flag?.[f]?.[k] ?? 0) & UV_SELECT) !== 0;
}

export function cornerPinned(layer: MeshUVLayer, f: number, k: number): boolean {
  return ((layer.flag?.[f]?.[k] ?? 0) & UV_PIN) !== 0;
}

export function faceUVSelected(md: MeshData, layer: MeshUVLayer, f: number): boolean {
  if (isSync()) {
    const mode = selectModeOf(app.scene.toolSettings.meshSelectMode);
    return mode === 'FACE' ? !!md.fsel[f] : md.faces[f].every((v) => md.vsel[v]);
  }
  const fl = layer.flag?.[f];
  if (!fl) return false;
  for (let k = 0; k < md.faces[f].length; k++) if (!((fl[k] ?? 0) & UV_SELECT)) return false;
  return true;
}

/** All selected corners of visible faces. */
export function selectedCorners(md: MeshData, layer: MeshUVLayer): [number, number][] {
  const out: [number, number][] = [];
  for (const f of visibleFaces(md)) for (let k = 0; k < md.faces[f].length; k++) if (cornerSelected(md, layer, f, k)) out.push([f, k]);
  return out;
}

export function anyUVSelected(): boolean {
  const c = uvContext();
  return !!c && selectedCorners(c.md, c.layer).length > 0;
}

/** Corners linked to (f, k) by the sticky selection mode (always includes (f, k) itself). */
export function stickyCorners(md: MeshData, layer: MeshUVLayer, f: number, k: number, vertFaces?: number[][]): [number, number][] {
  const mode = uvSettings().stickyMode;
  if (mode === 'DISABLED') return [[f, k]];
  const v = md.faces[f][k];
  const uv = cornerUV(layer, f, k);
  const out: [number, number][] = [];
  const faces = vertFaces ? vertFaces[v] : md.faces.map((_, i) => i).filter((i) => md.faces[i].includes(v));
  for (const g of faces) {
    if (!isFaceVisible(md, g)) continue;
    const kk = md.faces[g].indexOf(v);
    if (kk < 0) continue;
    if (mode === 'SHARED_LOCATION') {
      const p = cornerUV(layer, g, kk);
      if (Math.abs(p[0] - uv[0]) > STICKY_EPS || Math.abs(p[1] - uv[1]) > STICKY_EPS) continue;
    }
    out.push([g, kk]);
  }
  if (!out.some(([g, kk]) => g === f && kk === k)) out.push([f, k]);
  return out;
}

export function vertFacesOf(md: MeshData): number[][] {
  const out: number[][] = md.verts.map(() => []);
  md.faces.forEach((f, i) => { for (const v of f) out[v]?.push(i); });
  return out;
}

/** Set the selection of corners (non-sync) — callers flush with `flushSyncFromCorners` when syncing. */
export function setCorners(md: MeshData, layer: MeshUVLayer, corners: [number, number][], select: boolean): void {
  const fl = ensureFlags(md, layer);
  for (const [f, k] of corners) {
    if (select) fl[f][k] |= UV_SELECT; else fl[f][k] &= ~UV_SELECT;
  }
}

/** Deselect every visible corner (or select all). */
export function selectAllUV(md: MeshData, layer: MeshUVLayer, action: 'SELECT' | 'DESELECT' | 'INVERT' | 'TOGGLE'): void {
  if (isSync()) {
    const any = md.vsel.some(Boolean);
    const act = action === 'TOGGLE' ? (any ? 'DESELECT' : 'SELECT') : action;
    const mode = selectModeOf(app.scene.toolSettings.meshSelectMode);
    if (act === 'INVERT') {
      if (mode === 'FACE') md.fsel = md.fsel.map((s, i) => (md.fhide?.[i] ? s : !s));
      else if (mode === 'EDGE') md.esel = md.esel.map((s) => !s);
      else md.vsel = md.vsel.map((s, i) => (md.vhide?.[i] ? s : !s));
    } else {
      md.vsel.fill(act === 'SELECT'); md.esel.fill(act === 'SELECT'); md.fsel.fill(act === 'SELECT');
    }
    flushSelection(md, mode);
    return;
  }
  const fl = ensureFlags(md, layer);
  const vis = visibleFaces(md);
  let act = action;
  if (act === 'TOGGLE') act = vis.some((f) => fl[f].some((x) => x & UV_SELECT)) ? 'DESELECT' : 'SELECT';
  for (const f of vis) for (let k = 0; k < fl[f].length; k++) {
    if (act === 'SELECT') fl[f][k] |= UV_SELECT;
    else if (act === 'DESELECT') fl[f][k] &= ~UV_SELECT;
    else fl[f][k] ^= UV_SELECT;
  }
}

/** In sync mode, select mesh vertices / edges / faces corresponding to corners. */
export function syncSelectCorners(md: MeshData, corners: [number, number][], select: boolean, kind: 'VERT' | 'EDGE' | 'FACE'): void {
  const mode = selectModeOf(app.scene.toolSettings.meshSelectMode);
  if (kind === 'FACE' || mode === 'FACE') {
    const faces = new Set(corners.map(([f]) => f));
    faces.forEach((f) => { md.fsel[f] = select; });
    flushSelection(md, 'FACE');
    if (mode !== 'FACE') flushSelection(md, mode === 'EDGE' ? 'EDGE' : 'VERT');
    return;
  }
  if (kind === 'EDGE' || mode === 'EDGE') {
    const emap = new Map<string, number>();
    md.edges.forEach((e, i) => emap.set(edgeKey(e[0], e[1]), i));
    // corners come in pairs (edge start, edge end)
    for (let i = 0; i + 1 < corners.length; i += 2) {
      const a = md.faces[corners[i][0]][corners[i][1]], b = md.faces[corners[i + 1][0]][corners[i + 1][1]];
      const ei = emap.get(edgeKey(a, b));
      if (ei !== undefined) md.esel[ei] = select;
    }
    if (mode === 'EDGE') { flushSelection(md, 'EDGE'); return; }
  }
  for (const [f, k] of corners) md.vsel[md.faces[f][k]] = select;
  flushSelection(md, 'VERT');
}

/** UV islands of the visible faces. */
export function visibleIslands(md: MeshData, layer: MeshUVLayer): number[][] {
  return uvIslands(md, layer, visibleFaces(md));
}

/** Islands that contain at least one selected corner. */
export function selectedIslands(md: MeshData, layer: MeshUVLayer): number[][] {
  return visibleIslands(md, layer).filter((isl) => isl.some((f) => md.faces[f].some((_, k) => cornerSelected(md, layer, f, k))));
}

/** Faces whose corners are all UV-selected. */
export function selectedUVFaces(md: MeshData, layer: MeshUVLayer): number[] {
  return visibleFaces(md).filter((f) => faceUVSelected(md, layer, f));
}
