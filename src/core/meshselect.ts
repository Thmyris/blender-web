// Edit-mode selection tools: Shortest Path, Select Similar, Checker Deselect / Select Nth,
// Region to Loop, Loop to Region, Select Mirror and Edge Rings.

import type { MeshData, Vec3 } from './types';
import { edgeKey, ensureArrays, flushFromEdges, flushFromFaces, flushFromVerts, polyArea, polyCenter, polyNormal, sub, length, dot, normalize, type SelectMode } from './mesh';

function edgeFaceMap(md: MeshData): Map<string, number[]> {
  const ef = new Map<string, number[]>();
  md.faces.forEach((f, i) => {
    for (let k = 0; k < f.length; k++) {
      const key = edgeKey(f[k], f[(k + 1) % f.length]);
      const l = ef.get(key);
      if (l) l.push(i); else ef.set(key, [i]);
    }
  });
  return ef;
}

/** Simple binary heap keyed by distance. */
class Heap {
  private a: [number, number][] = [];
  get size(): number { return this.a.length; }
  push(d: number, v: number): void {
    const a = this.a;
    a.push([d, v]);
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  pop(): [number, number] {
    const a = this.a;
    const top = a[0], last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

/** Dijkstra from several sources to `target` over a weighted graph. Returns the path (sources first). */
function dijkstra(n: number, nbrs: (v: number) => [number, number][], sources: number[], target: number, topology = false): number[] | null {
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const heap = new Heap();
  for (const s of sources) { dist[s] = 0; heap.push(0, s); }
  while (heap.size) {
    const [d, v] = heap.pop();
    if (d > dist[v]) continue;
    if (v === target) break;
    for (const [u, w] of nbrs(v)) {
      const nd = d + (topology ? 1 : w);
      if (nd < dist[u] - 1e-12) { dist[u] = nd; prev[u] = v; heap.push(nd, u); }
    }
  }
  if (dist[target] === Infinity) return null;
  const path: number[] = [];
  for (let v = target; v >= 0; v = prev[v]) path.push(v);
  return path.reverse();
}

/**
 * Select Shortest Path (Ctrl+RMB): select the shortest path from the current selection (or `from`) to
 * the picked element (vertex, edge or face index depending on the mode).
 */
export function selectShortestPath(md: MeshData, mode: SelectMode, picked: number, opts: { from?: number; topology?: boolean } = {}): boolean {
  ensureArrays(md);
  if (mode === 'FACE') {
    const ef = edgeFaceMap(md);
    const adj: [number, number][][] = md.faces.map(() => []);
    const cen = md.faces.map((f) => polyCenter(md.verts, f));
    for (const fs of ef.values()) for (const a of fs) for (const b of fs) if (a !== b && !md.fhide?.[b]) adj[a].push([b, length(sub(cen[a], cen[b]))]);
    const sources = opts.from !== undefined ? [opts.from] : md.activeFace >= 0 && md.fsel[md.activeFace] ? [md.activeFace] : md.faces.map((_, i) => i).filter((i) => md.fsel[i]);
    if (!sources.length || sources.includes(picked)) { md.fsel[picked] = true; md.activeFace = picked; flushFromFaces(md); return true; }
    const path = dijkstra(md.faces.length, (v) => adj[v], sources, picked, opts.topology);
    if (!path) return false;
    for (const f of path) md.fsel[f] = true;
    md.activeFace = picked;
    flushFromFaces(md);
    return true;
  }
  const adj: [number, number][][] = md.verts.map(() => []);
  for (const [a, b] of md.edges) {
    if (md.vhide?.[a] || md.vhide?.[b]) continue;
    const w = length(sub(md.verts[a], md.verts[b]));
    adj[a].push([b, w]); adj[b].push([a, w]);
  }
  let targetV = picked, targetOther = -1;
  if (mode === 'EDGE') { [targetV, targetOther] = md.edges[picked]; }
  const sources = opts.from !== undefined ? [opts.from] : md.verts.map((_, i) => i).filter((i) => md.vsel[i]);
  if (!sources.length) {
    if (mode === 'EDGE') md.esel[picked] = true; else md.vsel[picked] = true;
    if (mode === 'EDGE') flushFromEdges(md); else flushFromVerts(md);
    return true;
  }
  // for edges: the path reaches the nearer end, then the edge itself is added
  let path = dijkstra(md.verts.length, (v) => adj[v], sources, targetV, opts.topology);
  if (mode === 'EDGE') {
    const p2 = dijkstra(md.verts.length, (v) => adj[v], sources, targetOther, opts.topology);
    if (p2 && (!path || p2.length < path.length)) { path = p2; [targetV, targetOther] = [targetOther, targetV]; }
  }
  if (!path) return false;
  if (mode === 'EDGE') {
    const keys = new Set<string>();
    for (let i = 0; i + 1 < path.length; i++) keys.add(edgeKey(path[i], path[i + 1]));
    keys.add(edgeKey(targetV, targetOther));
    md.edges.forEach(([a, b], i) => { if (keys.has(edgeKey(a, b))) md.esel[i] = true; });
    flushFromEdges(md);
  } else {
    for (const v of path) md.vsel[v] = true;
    // select the path edges too
    const keys = new Set<string>();
    for (let i = 0; i + 1 < path.length; i++) keys.add(edgeKey(path[i], path[i + 1]));
    md.edges.forEach(([a, b], i) => { if (keys.has(edgeKey(a, b))) md.esel[i] = true; });
    md.faces.forEach((f, i) => { md.fsel[i] = f.every((v) => md.vsel[v]); });
  }
  return true;
}

// ------------------------------------------------------------------ select similar

export type SimilarType =
  | 'NORMAL' | 'FACE' | 'EDGE' // vertex mode: normal, amount of adjacent faces, amount of connecting edges
  | 'LENGTH' | 'DIR' | 'FACE_ANGLE' // edge mode (+ FACE: amount of faces around an edge)
  | 'MATERIAL' | 'AREA' | 'SIDES' | 'PERIMETER' | 'COPLANAR' | 'SMOOTH'; // face mode (+ NORMAL)

export function similarItems(mode: SelectMode): [string, string][] {
  if (mode === 'VERT') return [['NORMAL', 'Normal'], ['FACE', 'Amount of Adjacent Faces'], ['EDGE', 'Amount of Connecting Edges']];
  if (mode === 'EDGE') return [['LENGTH', 'Length'], ['DIR', 'Direction'], ['FACE', 'Amount of Faces Around an Edge'], ['FACE_ANGLE', 'Face Angles']];
  return [['MATERIAL', 'Material'], ['AREA', 'Area'], ['SIDES', 'Polygon Sides'], ['PERIMETER', 'Perimeter'], ['NORMAL', 'Normal'], ['COPLANAR', 'Co-planar'], ['SMOOTH', 'Flat/Smooth']];
}

/** Select Similar (Shift+G). */
export function selectSimilar(md: MeshData, mode: SelectMode, type: SimilarType, compare: 'EQUAL' | 'GREATER' | 'LESS', threshold: number): number {
  ensureArrays(md);
  const cmp = (v: number, ref: number, tol: number) => (compare === 'EQUAL' ? Math.abs(v - ref) <= tol + 1e-9 : compare === 'GREATER' ? v >= ref - tol - 1e-9 : v <= ref + tol + 1e-9);
  const ef = edgeFaceMap(md);
  let count = 0;
  if (mode === 'VERT') {
    const vf: number[][] = md.verts.map(() => []);
    md.faces.forEach((f, i) => { for (const v of f) vf[v].push(i); });
    const ve = new Int32Array(md.verts.length);
    for (const [a, b] of md.edges) { ve[a]++; ve[b]++; }
    const fn = md.faces.map((f) => polyNormal(md.verts, f));
    const vn = md.verts.map((_, v) => { const n: Vec3 = [0, 0, 0]; for (const f of vf[v]) { n[0] += fn[f][0]; n[1] += fn[f][1]; n[2] += fn[f][2]; } return normalize(n); });
    const val = (v: number) => (type === 'FACE' ? vf[v].length : type === 'EDGE' ? ve[v] : 0);
    const refs = md.verts.map((_, i) => i).filter((i) => md.vsel[i]);
    md.verts.forEach((_, v) => {
      if (md.vsel[v] || md.vhide?.[v]) return;
      const hit = refs.some((r) => type === 'NORMAL' ? Math.acos(Math.max(-1, Math.min(1, dot(vn[v], vn[r])))) <= threshold * Math.PI + 1e-6 : cmp(val(v), val(r), 0));
      if (hit) { md.vsel[v] = true; count++; }
    });
    flushFromVerts(md);
    return count;
  }
  if (mode === 'EDGE') {
    const dir = md.edges.map(([a, b]) => normalize(sub(md.verts[b], md.verts[a])));
    const len = md.edges.map(([a, b]) => length(sub(md.verts[b], md.verts[a])));
    const fc = md.edges.map(([a, b]) => ef.get(edgeKey(a, b))?.length ?? 0);
    const ang = md.edges.map(([a, b]) => {
      const fs = ef.get(edgeKey(a, b)) ?? [];
      if (fs.length !== 2) return 0;
      return Math.acos(Math.max(-1, Math.min(1, dot(polyNormal(md.verts, md.faces[fs[0]]), polyNormal(md.verts, md.faces[fs[1]])))));
    });
    const refs = md.edges.map((_, i) => i).filter((i) => md.esel[i]);
    const maxLen = Math.max(1e-9, ...len);
    md.edges.forEach((_, e) => {
      if (md.esel[e]) return;
      const hit = refs.some((r) => {
        switch (type) {
          case 'LENGTH': return cmp(len[e], len[r], threshold * maxLen);
          case 'DIR': return Math.acos(Math.min(1, Math.abs(dot(dir[e], dir[r])))) <= threshold * Math.PI + 1e-6;
          case 'FACE': return cmp(fc[e], fc[r], 0);
          case 'FACE_ANGLE': return cmp(ang[e], ang[r], threshold * Math.PI);
          default: return false;
        }
      });
      if (hit) { md.esel[e] = true; count++; }
    });
    flushFromEdges(md);
    return count;
  }
  const fn = md.faces.map((f) => polyNormal(md.verts, f));
  const area = md.faces.map((f) => polyArea(md.verts, f));
  const per = md.faces.map((f) => f.reduce((s, v, k) => s + length(sub(md.verts[f[(k + 1) % f.length]], md.verts[v])), 0));
  const refs = md.faces.map((_, i) => i).filter((i) => md.fsel[i]);
  const maxA = Math.max(1e-12, ...area), maxP = Math.max(1e-12, ...per);
  md.faces.forEach((f, i) => {
    if (md.fsel[i] || md.fhide?.[i]) return;
    const hit = refs.some((r) => {
      switch (type) {
        case 'MATERIAL': return md.faceMat[i] === md.faceMat[r];
        case 'AREA': return cmp(area[i], area[r], threshold * maxA);
        case 'SIDES': return cmp(f.length, md.faces[r].length, 0);
        case 'PERIMETER': return cmp(per[i], per[r], threshold * maxP);
        case 'NORMAL': return Math.acos(Math.max(-1, Math.min(1, dot(fn[i], fn[r])))) <= threshold * Math.PI + 1e-6;
        case 'COPLANAR': {
          if (Math.acos(Math.max(-1, Math.min(1, dot(fn[i], fn[r])))) > threshold * Math.PI + 1e-6) return false;
          const d = Math.abs(dot(sub(polyCenter(md.verts, f), md.verts[md.faces[r][0]]), fn[r]));
          return d <= Math.max(1e-5, threshold);
        }
        case 'SMOOTH': return !!md.faceSmooth[i] === !!md.faceSmooth[r];
        default: return false;
      }
    });
    if (hit) { md.fsel[i] = true; count++; }
  });
  flushFromFaces(md);
  return count;
}

// ------------------------------------------------------------------ checker deselect / select nth

/**
 * Checker Deselect (Select Nth): walk each selected island from its active (or first) element and keep
 * `skip` elements selected, then deselect `nth - 1`, repeating; `offset` shifts the pattern.
 */
export function selectNth(md: MeshData, mode: SelectMode, nth = 2, skip = 1, offset = 0): void {
  ensureArrays(md);
  const period = Math.max(1, nth - 1) + Math.max(1, skip);
  const keep = (d: number) => ((((d + offset) % period) + period) % period) < Math.max(1, skip);
  if (mode === 'FACE') {
    const ef = edgeFaceMap(md);
    const depth = new Int32Array(md.faces.length).fill(-1);
    const order = md.activeFace >= 0 && md.fsel[md.activeFace] ? [md.activeFace, ...md.faces.map((_, i) => i)] : md.faces.map((_, i) => i);
    for (const s of order) {
      if (!md.fsel[s] || depth[s] >= 0) continue;
      depth[s] = 0;
      const q = [s];
      while (q.length) {
        const f = q.shift()!;
        const F = md.faces[f];
        for (let k = 0; k < F.length; k++) for (const g of ef.get(edgeKey(F[k], F[(k + 1) % F.length])) ?? []) {
          if (md.fsel[g] && depth[g] < 0) { depth[g] = depth[f] + 1; q.push(g); }
        }
      }
    }
    md.faces.forEach((_, i) => { if (md.fsel[i] && !keep(depth[i])) md.fsel[i] = false; });
    flushFromFaces(md);
    return;
  }
  if (mode === 'EDGE') {
    const vEdges: number[][] = md.verts.map(() => []);
    md.edges.forEach(([a, b], i) => { vEdges[a].push(i); vEdges[b].push(i); });
    const depth = new Int32Array(md.edges.length).fill(-1);
    for (let s = 0; s < md.edges.length; s++) {
      if (!md.esel[s] || depth[s] >= 0) continue;
      depth[s] = 0;
      const q = [s];
      while (q.length) {
        const e = q.shift()!;
        for (const v of md.edges[e]) for (const g of vEdges[v]) if (md.esel[g] && depth[g] < 0) { depth[g] = depth[e] + 1; q.push(g); }
      }
    }
    md.edges.forEach((_, i) => { if (md.esel[i] && !keep(depth[i])) md.esel[i] = false; });
    flushFromEdges(md);
    return;
  }
  const adj: number[][] = md.verts.map(() => []);
  for (const [a, b] of md.edges) { adj[a].push(b); adj[b].push(a); }
  const depth = new Int32Array(md.verts.length).fill(-1);
  for (let s = 0; s < md.verts.length; s++) {
    if (!md.vsel[s] || depth[s] >= 0) continue;
    depth[s] = 0;
    const q = [s];
    while (q.length) {
      const v = q.shift()!;
      for (const u of adj[v]) if (md.vsel[u] && depth[u] < 0) { depth[u] = depth[v] + 1; q.push(u); }
    }
  }
  md.verts.forEach((_, i) => { if (md.vsel[i] && !keep(depth[i])) md.vsel[i] = false; });
  flushFromVerts(md);
}

// ------------------------------------------------------------------ region <-> loop

/** Select Boundary Loop: select the boundary edges of the selected faces (and nothing else). */
export function regionToLoop(md: MeshData): number {
  ensureArrays(md);
  const count = new Map<string, number>();
  md.faces.forEach((f, i) => {
    if (!md.fsel[i]) return;
    for (let k = 0; k < f.length; k++) { const key = edgeKey(f[k], f[(k + 1) % f.length]); count.set(key, (count.get(key) ?? 0) + 1); }
  });
  const ef = edgeFaceMap(md);
  const loop = new Set<string>();
  for (const [k, c] of count) {
    if (c !== 1) continue;
    // a region edge on the mesh boundary is part of the loop as well
    loop.add(k);
  }
  void ef;
  md.vsel.fill(false); md.fsel.fill(false);
  md.edges.forEach(([a, b], i) => { md.esel[i] = loop.has(edgeKey(a, b)); });
  flushFromEdges(md);
  return loop.size;
}

/** Select Loop Inner-Region: select the faces enclosed by the selected edge loop(s). */
export function loopToRegion(md: MeshData, selectBigger = false): number {
  ensureArrays(md);
  const loop = new Set<string>();
  md.edges.forEach(([a, b], i) => { if (md.esel[i]) loop.add(edgeKey(a, b)); });
  if (!loop.size) return 0;
  const ef = edgeFaceMap(md);
  const comp = new Int32Array(md.faces.length).fill(-1);
  const regions: number[][] = [];
  for (let s = 0; s < md.faces.length; s++) {
    if (comp[s] >= 0 || md.fhide?.[s]) continue;
    const id = regions.length;
    const reg: number[] = [];
    comp[s] = id;
    const q = [s];
    while (q.length) {
      const f = q.pop()!;
      reg.push(f);
      const F = md.faces[f];
      for (let k = 0; k < F.length; k++) {
        const key = edgeKey(F[k], F[(k + 1) % F.length]);
        if (loop.has(key)) continue;
        for (const g of ef.get(key) ?? []) if (comp[g] < 0 && !md.fhide?.[g]) { comp[g] = id; q.push(g); }
      }
    }
    regions.push(reg);
  }
  // regions touching the loop
  const touching = regions.map((r) => r.some((f) => { const F = md.faces[f]; for (let k = 0; k < F.length; k++) if (loop.has(edgeKey(F[k], F[(k + 1) % F.length]))) return true; return false; }));
  const cands = regions.map((r, i) => ({ r, i })).filter((x) => touching[x.i]);
  if (cands.length < 2) {
    // an open loop that does not separate anything: select the faces along it
    md.fsel.fill(false);
    for (const x of cands) for (const f of x.r) md.fsel[f] = true;
  } else {
    cands.sort((a, b) => a.r.length - b.r.length);
    const chosen = selectBigger ? cands.slice(1) : cands.slice(0, cands.length - 1);
    md.fsel.fill(false);
    for (const x of chosen) for (const f of x.r) md.fsel[f] = true;
  }
  md.vsel.fill(false); md.esel.fill(false);
  flushFromFaces(md);
  return md.fsel.filter(Boolean).length;
}

// ------------------------------------------------------------------ mirror

/** Select Mirror (Shift+Ctrl+M): select the mirror counterparts of the selection across the given axes. */
export function selectMirror(md: MeshData, mode: SelectMode, axes: boolean[], extend: boolean, threshold = 0.0001): number {
  ensureArrays(md);
  let size = 0;
  for (const p of md.verts) size = Math.max(size, Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]));
  const tol = Math.max(threshold, size * 1e-5);
  const cell = tol * 4;
  const grid = new Map<string, number[]>();
  const key = (p: Vec3) => `${Math.round(p[0] / cell)},${Math.round(p[1] / cell)},${Math.round(p[2] / cell)}`;
  md.verts.forEach((p, v) => { const k = key(p); const l = grid.get(k); if (l) l.push(v); else grid.set(k, [v]); });
  const mirrorOf = (v: number): number => {
    const p = md.verts[v].map((x, k) => (axes[k] ? -x : x)) as Vec3;
    const cx = Math.round(p[0] / cell), cy = Math.round(p[1] / cell), cz = Math.round(p[2] / cell);
    let best = -1, bd = tol;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const u of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) { const d = length(sub(md.verts[u], p)); if (d <= bd) { bd = d; best = u; } }
    }
    return best;
  };
  if (!axes.some(Boolean)) return 0;
  const vmap = md.verts.map((_, v) => mirrorOf(v));
  let n = 0;
  if (mode === 'VERT') {
    const sel = md.vsel.slice();
    if (!extend) md.vsel.fill(false);
    sel.forEach((s, v) => { if (s && vmap[v] >= 0) { md.vsel[vmap[v]] = true; n++; } });
    flushFromVerts(md);
  } else if (mode === 'EDGE') {
    const sel = md.esel.slice();
    const eidx = new Map(md.edges.map(([a, b], i) => [edgeKey(a, b), i] as [string, number]));
    if (!extend) md.esel.fill(false);
    sel.forEach((s, i) => {
      if (!s) return;
      const [a, b] = md.edges[i];
      const j = vmap[a] >= 0 && vmap[b] >= 0 ? eidx.get(edgeKey(vmap[a], vmap[b])) : undefined;
      if (j !== undefined) { md.esel[j] = true; n++; }
    });
    flushFromEdges(md);
  } else {
    const sel = md.fsel.slice();
    const fidx = new Map(md.faces.map((f, i) => [f.slice().sort((x, y) => x - y).join(','), i] as [string, number]));
    if (!extend) md.fsel.fill(false);
    sel.forEach((s, i) => {
      if (!s) return;
      const m = md.faces[i].map((v) => vmap[v]);
      if (m.some((v) => v < 0)) return;
      const j = fidx.get(m.slice().sort((x, y) => x - y).join(','));
      if (j !== undefined) { md.fsel[j] = true; n++; }
    });
    flushFromFaces(md);
  }
  return n;
}
