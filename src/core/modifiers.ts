// Modifier stack evaluation. Every modifier takes an EvalMesh and returns a new one.

import type { MeshData, Modifier, ModifierType, Vec3 } from './types';
import {
  add, cross, dot, edgeKey, length, lerp3, meshBounds, normalize, polyCenter, polyNormal, scale, sub, triangulatePoly,
} from './mesh';

export interface EvalMesh {
  verts: Vec3[];
  faces: number[][];
  /** Loose edges only (edges that are not part of a face). */
  looseEdges: [number, number][];
  faceSmooth: boolean[];
  faceMat: number[];
  /** When false, every face is rendered smooth (used by edge split). */
  forceSmooth?: boolean;
}

export interface ModifierContext {
  frame: number;
  render: boolean;
  editMode: boolean;
}

export interface ModifierDef {
  type: ModifierType;
  label: string;
  icon: string;
  category: 'Modify' | 'Generate' | 'Deform' | 'Simulate';
  supported: boolean;
  defaults: Record<string, unknown>;
  apply?: (m: EvalMesh, mod: Modifier, ctx: ModifierContext) => EvalMesh;
}

export function evalMeshFromData(md: MeshData): EvalMesh {
  const faceEdges = new Set<string>();
  for (const f of md.faces) for (let i = 0; i < f.length; i++) faceEdges.add(edgeKey(f[i], f[(i + 1) % f.length]));
  return {
    verts: md.verts.map((v) => [v[0], v[1], v[2]] as Vec3),
    faces: md.faces.map((f) => f.slice()),
    looseEdges: md.edges.filter((e) => !faceEdges.has(edgeKey(e[0], e[1]))).map((e) => [e[0], e[1]] as [number, number]),
    faceSmooth: md.faceSmooth.slice(),
    faceMat: md.faceMat.slice(),
  };
}

export function cloneEval(m: EvalMesh): EvalMesh {
  return {
    verts: m.verts.map((v) => [v[0], v[1], v[2]] as Vec3), faces: m.faces.map((f) => f.slice()),
    looseEdges: m.looseEdges.map((e) => [e[0], e[1]] as [number, number]), faceSmooth: m.faceSmooth.slice(),
    faceMat: m.faceMat.slice(), forceSmooth: m.forceSmooth,
  };
}

/** All unique edges (face edges + loose edges) of an evaluated mesh. */
export function evalEdges(m: EvalMesh): [number, number][] {
  const seen = new Set<string>();
  const out: [number, number][] = [];
  const push = (a: number, b: number) => {
    const k = edgeKey(a, b);
    if (!seen.has(k)) { seen.add(k); out.push([a, b]); }
  };
  for (const f of m.faces) for (let i = 0; i < f.length; i++) push(f[i], f[(i + 1) % f.length]);
  for (const e of m.looseEdges) push(e[0], e[1]);
  return out;
}

// ------------------------------------------------------------------ subdivision surface (Catmull-Clark)

export function catmullClark(m: EvalMesh, simple = false): EvalMesh {
  const nv = m.verts.length;
  const facePts: Vec3[] = m.faces.map((f) => polyCenter(m.verts, f));
  // edges with adjacent faces
  const edgeMap = new Map<string, { a: number; b: number; faces: number[]; idx: number }>();
  const edgeList: { a: number; b: number; faces: number[]; idx: number }[] = [];
  const getEdge = (a: number, b: number) => {
    const k = edgeKey(a, b);
    let e = edgeMap.get(k);
    if (!e) { e = { a: Math.min(a, b), b: Math.max(a, b), faces: [], idx: edgeList.length }; edgeMap.set(k, e); edgeList.push(e); }
    return e;
  };
  m.faces.forEach((f, fi) => { for (let i = 0; i < f.length; i++) getEdge(f[i], f[(i + 1) % f.length]).faces.push(fi); });
  const loose = m.looseEdges.map(([a, b]) => getEdge(a, b));

  const edgePts: Vec3[] = edgeList.map((e) => {
    const mid = lerp3(m.verts[e.a], m.verts[e.b], 0.5);
    if (simple || e.faces.length !== 2) return mid;
    const fp = lerp3(facePts[e.faces[0]], facePts[e.faces[1]], 0.5);
    return lerp3(mid, fp, 0.5);
  });

  // vertex adjacency
  const vEdges: number[][] = Array.from({ length: nv }, () => []);
  edgeList.forEach((e, i) => { vEdges[e.a].push(i); vEdges[e.b].push(i); });
  const vFaces: number[][] = Array.from({ length: nv }, () => []);
  m.faces.forEach((f, fi) => { for (const v of f) vFaces[v].push(fi); });

  const newVerts: Vec3[] = m.verts.map((p, vi) => {
    if (simple) return [p[0], p[1], p[2]] as Vec3;
    const edges = vEdges[vi];
    if (!edges.length) return [p[0], p[1], p[2]] as Vec3;
    const boundary = edges.filter((ei) => edgeList[ei].faces.length < 2);
    if (boundary.length) {
      if (boundary.length !== 2) return [p[0], p[1], p[2]] as Vec3; // corner / non-manifold: keep
      const o1 = edgeList[boundary[0]], o2 = edgeList[boundary[1]];
      const n1 = m.verts[o1.a === vi ? o1.b : o1.a], n2 = m.verts[o2.a === vi ? o2.b : o2.a];
      return add(scale(p, 0.75), scale(add(n1, n2), 0.125));
    }
    const n = edges.length;
    const F: Vec3 = [0, 0, 0];
    for (const fi of vFaces[vi]) { F[0] += facePts[fi][0]; F[1] += facePts[fi][1]; F[2] += facePts[fi][2]; }
    const Fa = scale(F, 1 / vFaces[vi].length);
    const R: Vec3 = [0, 0, 0];
    for (const ei of edges) {
      const mid = lerp3(m.verts[edgeList[ei].a], m.verts[edgeList[ei].b], 0.5);
      R[0] += mid[0]; R[1] += mid[1]; R[2] += mid[2];
    }
    const Ra = scale(R, 1 / n);
    return scale(add(add(Fa, scale(Ra, 2)), scale(p, n - 3)), 1 / n);
  });

  const verts: Vec3[] = newVerts.slice();
  const edgeBase = verts.length;
  for (const p of edgePts) verts.push(p);
  const faceBase = verts.length;
  for (const p of facePts) verts.push(p);

  const faces: number[][] = [];
  const faceSmooth: boolean[] = [];
  const faceMat: number[] = [];
  m.faces.forEach((f, fi) => {
    const n = f.length;
    for (let i = 0; i < n; i++) {
      const v = f[i], next = f[(i + 1) % n], prev = f[(i - 1 + n) % n];
      const eNext = edgeMap.get(edgeKey(v, next))!.idx, ePrev = edgeMap.get(edgeKey(prev, v))!.idx;
      faces.push([v, edgeBase + eNext, faceBase + fi, edgeBase + ePrev]);
      faceSmooth.push(m.faceSmooth[fi] ?? false);
      faceMat.push(m.faceMat[fi] ?? 0);
    }
  });
  const looseEdges: [number, number][] = [];
  for (const e of loose) {
    const mid = edgeBase + e.idx;
    looseEdges.push([e.a, mid], [mid, e.b]);
  }
  return { verts, faces, looseEdges, faceSmooth, faceMat, forceSmooth: m.forceSmooth };
}

// ------------------------------------------------------------------ mirror

function mirrorAxis(m: EvalMesh, axis: number, merge: boolean, threshold: number, clip: boolean): EvalMesh {
  const nv = m.verts.length;
  if (clip) for (const v of m.verts) { if (Math.abs(v[axis]) < threshold) v[axis] = 0; }
  const map: number[] = new Array(nv);
  const verts = m.verts.slice();
  for (let i = 0; i < nv; i++) {
    const v = m.verts[i];
    if (merge && Math.abs(v[axis]) <= threshold) { map[i] = i; continue; }
    const c: Vec3 = [v[0], v[1], v[2]];
    c[axis] = -c[axis];
    map[i] = verts.length;
    verts.push(c);
  }
  const faces = m.faces.slice();
  const faceSmooth = m.faceSmooth.slice();
  const faceMat = m.faceMat.slice();
  m.faces.forEach((f, fi) => {
    const nf = f.map((v) => map[v]).reverse();
    // a face lying entirely in the mirror plane would duplicate itself
    if (nf.every((v, k) => v === f[f.length - 1 - k])) return;
    faces.push(nf);
    faceSmooth.push(m.faceSmooth[fi]);
    faceMat.push(m.faceMat[fi]);
  });
  const looseEdges = m.looseEdges.slice();
  for (const [a, b] of m.looseEdges) if (map[a] !== a || map[b] !== b) looseEdges.push([map[a], map[b]]);
  return { verts, faces, looseEdges, faceSmooth, faceMat, forceSmooth: m.forceSmooth };
}

// ------------------------------------------------------------------ helpers

function mergeByDistance(m: EvalMesh, threshold: number): EvalMesh {
  const n = m.verts.length;
  const cell = Math.max(threshold, 1e-6) * 2;
  const grid = new Map<string, number[]>();
  const remap = new Array(n);
  const verts: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const p = m.verts[i];
    const cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell), cz = Math.floor(p[2] / cell);
    let found = -1;
    for (let dx = -1; dx <= 1 && found < 0; dx++) for (let dy = -1; dy <= 1 && found < 0; dy++) for (let dz = -1; dz <= 1 && found < 0; dz++) {
      const list = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
      if (!list) continue;
      for (const j of list) if (length(sub(verts[j], p)) <= threshold) { found = j; break; }
    }
    if (found >= 0) { remap[i] = found; continue; }
    remap[i] = verts.length;
    verts.push(p);
    const key = `${cx},${cy},${cz}`;
    const l = grid.get(key);
    if (l) l.push(remap[i]); else grid.set(key, [remap[i]]);
  }
  const faces: number[][] = [], faceSmooth: boolean[] = [], faceMat: number[] = [];
  m.faces.forEach((f, fi) => {
    const nf: number[] = [];
    for (const v of f) { const r = remap[v]; if (nf[nf.length - 1] !== r) nf.push(r); }
    while (nf.length > 1 && nf[0] === nf[nf.length - 1]) nf.pop();
    if (new Set(nf).size >= 3) { faces.push(nf); faceSmooth.push(m.faceSmooth[fi]); faceMat.push(m.faceMat[fi]); }
  });
  const looseEdges = m.looseEdges.map(([a, b]) => [remap[a], remap[b]] as [number, number]).filter(([a, b]) => a !== b);
  return { verts, faces, looseEdges, faceSmooth, faceMat, forceSmooth: m.forceSmooth };
}

function vertexNormalsEval(m: EvalMesh): Vec3[] {
  const out: Vec3[] = m.verts.map(() => [0, 0, 0] as Vec3);
  for (const f of m.faces) {
    const n = polyNormal(m.verts, f);
    for (const v of f) { out[v][0] += n[0]; out[v][1] += n[1]; out[v][2] += n[2]; }
  }
  return out.map((n) => { const l = length(n); return l > 1e-12 ? scale(n, 1 / l) : [0, 0, 1] as Vec3; });
}

function append(dst: EvalMesh, src: EvalMesh): void {
  const off = dst.verts.length;
  for (const v of src.verts) dst.verts.push(v);
  src.faces.forEach((f, i) => { dst.faces.push(f.map((x) => x + off)); dst.faceSmooth.push(src.faceSmooth[i]); dst.faceMat.push(src.faceMat[i]); });
  for (const [a, b] of src.looseEdges) dst.looseEdges.push([a + off, b + off]);
}

// ------------------------------------------------------------------ modifier implementations

const num = (v: unknown, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d);
const bool = (v: unknown) => v === true;
const vec = (v: unknown, d: Vec3): Vec3 => (Array.isArray(v) && v.length === 3 ? (v as Vec3) : d);

export const MODIFIERS: ModifierDef[] = [
  // Modify
  { type: 'EDGE_SPLIT', label: 'Edge Split', icon: 'MOD_EDGESPLIT', category: 'Generate', supported: true,
    defaults: { splitAngle: (30 * Math.PI) / 180, useEdgeAngle: true, useEdgeSharp: true },
    apply: (m, mod) => edgeSplit(m, num(mod.splitAngle, 0.5236)) },
  // Generate
  { type: 'ARRAY', label: 'Array', icon: 'MOD_ARRAY', category: 'Generate', supported: true,
    defaults: { count: 2, useRelativeOffset: true, relativeOffset: [1, 0, 0], useConstantOffset: false, constantOffset: [1, 0, 0], useMerge: false, mergeThreshold: 0.01, fitType: 'FIXED_COUNT' },
    apply: (m, mod) => {
      const count = Math.max(1, Math.round(num(mod.count, 2)));
      const b = meshBounds(m.verts);
      const size: Vec3 = sub(b.max, b.min);
      let off: Vec3 = [0, 0, 0];
      if (mod.useRelativeOffset !== false) { const r = vec(mod.relativeOffset, [1, 0, 0]); off = add(off, [r[0] * size[0], r[1] * size[1], r[2] * size[2]]); }
      if (bool(mod.useConstantOffset)) off = add(off, vec(mod.constantOffset, [1, 0, 0]));
      const out = cloneEval(m);
      for (let i = 1; i < count; i++) {
        const c = cloneEval(m);
        c.verts = c.verts.map((v) => add(v, scale(off, i)));
        append(out, c);
      }
      return bool(mod.useMerge) ? mergeByDistance(out, num(mod.mergeThreshold, 0.01)) : out;
    } },
  { type: 'BEVEL', label: 'Bevel', icon: 'MOD_BEVEL', category: 'Generate', supported: false, defaults: { width: 0.1, segments: 1 } },
  { type: 'BUILD', label: 'Build', icon: 'MOD_BUILD', category: 'Generate', supported: true,
    defaults: { frameStart: 1, frameDuration: 100, useReverse: false, useRandomOrder: false, seed: 0 },
    apply: (m, mod, ctx) => {
      const start = num(mod.frameStart, 1), dur = Math.max(1, num(mod.frameDuration, 100));
      let t = (ctx.frame - start) / dur;
      t = Math.min(1, Math.max(0, t));
      const n = Math.floor(m.faces.length * t);
      const order = m.faces.map((_, i) => i);
      if (bool(mod.useRandomOrder)) {
        let s = num(mod.seed, 0) * 9301 + 49297;
        for (let i = order.length - 1; i > 0; i--) { s = (s * 9301 + 49297) % 233280; const j = Math.floor((s / 233280) * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
      }
      if (bool(mod.useReverse)) order.reverse();
      const keep = new Set(order.slice(0, n));
      const out = cloneEval(m);
      out.faces = []; out.faceSmooth = []; out.faceMat = [];
      m.faces.forEach((f, i) => { if (keep.has(i)) { out.faces.push(f.slice()); out.faceSmooth.push(m.faceSmooth[i]); out.faceMat.push(m.faceMat[i]); } });
      out.looseEdges = t >= 1 ? out.looseEdges : [];
      return out;
    } },
  { type: 'DECIMATE', label: 'Decimate', icon: 'MOD_DECIM', category: 'Generate', supported: false, defaults: { ratio: 1 } },
  { type: 'MIRROR', label: 'Mirror', icon: 'MOD_MIRROR', category: 'Generate', supported: true,
    defaults: { useX: true, useY: false, useZ: false, useClip: false, useMirrorMerge: true, mergeThreshold: 0.001, mirrorObject: null },
    apply: (m, mod) => {
      let out = cloneEval(m);
      const merge = mod.useMirrorMerge !== false, thr = num(mod.mergeThreshold, 0.001), clip = bool(mod.useClip);
      if (mod.useX !== false) out = mirrorAxis(out, 0, merge, thr, clip);
      if (bool(mod.useY)) out = mirrorAxis(out, 1, merge, thr, clip);
      if (bool(mod.useZ)) out = mirrorAxis(out, 2, merge, thr, clip);
      return out;
    } },
  { type: 'SCREW', label: 'Screw', icon: 'MOD_SCREW', category: 'Generate', supported: true,
    defaults: { angle: Math.PI * 2, steps: 16, renderSteps: 16, screwOffset: 0, iterations: 1, axis: 'Z', useNormalFlip: false, useSmoothShade: true },
    apply: (m, mod, ctx) => screw(m, mod, ctx) },
  { type: 'SOLIDIFY', label: 'Solidify', icon: 'MOD_SOLIDIFY', category: 'Generate', supported: true,
    defaults: { thickness: 0.01, offset: -1, useRim: true, useEvenOffset: false, useFlipNormals: false },
    apply: (m, mod) => solidify(m, num(mod.thickness, 0.01), num(mod.offset, -1), mod.useRim !== false, bool(mod.useFlipNormals)) },
  { type: 'SUBSURF', label: 'Subdivision Surface', icon: 'MOD_SUBSURF', category: 'Generate', supported: true,
    defaults: { levels: 1, renderLevels: 2, subdivisionType: 'CATMULL_CLARK', useSubsurfUv: true, showOnlyControlEdges: false },
    apply: (m, mod, ctx) => {
      const lv = Math.min(6, Math.max(0, Math.round(num(ctx.render ? mod.renderLevels : mod.levels, 1))));
      let out = m;
      // guard: avoid freezing the browser on enormous meshes
      for (let i = 0; i < lv; i++) {
        if (out.faces.length * 4 > 2_000_000) break;
        out = catmullClark(out, mod.subdivisionType === 'SIMPLE');
      }
      return out === m ? cloneEval(m) : out;
    } },
  { type: 'TRIANGULATE', label: 'Triangulate', icon: 'MOD_TRIANGULATE', category: 'Generate', supported: true,
    defaults: { quadMethod: 'BEAUTY', ngonMethod: 'BEAUTY' },
    apply: (m) => {
      const out = cloneEval(m);
      out.faces = []; out.faceSmooth = []; out.faceMat = [];
      m.faces.forEach((f, fi) => {
        for (const t of triangulatePoly(m.verts, f)) { out.faces.push([f[t[0]], f[t[1]], f[t[2]]]); out.faceSmooth.push(m.faceSmooth[fi]); out.faceMat.push(m.faceMat[fi]); }
      });
      return out;
    } },
  { type: 'WIREFRAME', label: 'Wireframe', icon: 'MOD_WIREFRAME', category: 'Generate', supported: true,
    defaults: { thickness: 0.02, useReplace: true },
    apply: (m, mod) => wireframe(m, num(mod.thickness, 0.02), mod.useReplace !== false) },
  // Deform
  { type: 'CAST', label: 'Cast', icon: 'MOD_CAST', category: 'Deform', supported: true,
    defaults: { castType: 'SPHERE', factor: 0.5, radius: 0, useX: true, useY: true, useZ: true },
    apply: (m, mod) => {
      const out = cloneEval(m);
      const f = num(mod.factor, 0.5);
      const axes = [mod.useX !== false, mod.useY !== false, mod.useZ !== false];
      const c: Vec3 = [0, 0, 0];
      let r = num(mod.radius, 0);
      if (r <= 0) { r = 0; for (const v of m.verts) r += length(v); r /= Math.max(1, m.verts.length); }
      if (mod.castType === 'CUBOID') {
        out.verts = out.verts.map((v) => {
          const mx = Math.max(Math.abs(v[0]), Math.abs(v[1]), Math.abs(v[2])) || 1;
          const t = v.map((x) => (x / mx) * r) as Vec3;
          return v.map((x, k) => (axes[k] ? x + (t[k] - x) * f : x)) as Vec3;
        });
      } else {
        out.verts = out.verts.map((v) => {
          const d = sub(v, c);
          if (mod.castType === 'CYLINDER') d[2] = 0;
          const l = length(d);
          if (l < 1e-9) return v;
          const t = add(c, scale(d, r / l));
          if (mod.castType === 'CYLINDER') t[2] = v[2];
          return v.map((x, k) => (axes[k] ? x + (t[k] - x) * f : x)) as Vec3;
        });
      }
      return out;
    } },
  { type: 'DISPLACE', label: 'Displace', icon: 'MOD_DISPLACE', category: 'Deform', supported: true,
    defaults: { strength: 1, midLevel: 0.5, direction: 'NORMAL' },
    apply: (m, mod) => {
      const out = cloneEval(m);
      const d = (1 - num(mod.midLevel, 0.5)) * num(mod.strength, 1);
      const dir = mod.direction as string;
      const normals = dir === 'NORMAL' || dir === 'RGB_TO_XYZ' ? vertexNormalsEval(m) : null;
      out.verts = out.verts.map((v, i) => {
        if (normals) return add(v, scale(normals[i], d));
        const axis = dir === 'X' ? 0 : dir === 'Y' ? 1 : 2;
        const r: Vec3 = [v[0], v[1], v[2]];
        r[axis] += d;
        return r;
      });
      return out;
    } },
  { type: 'SIMPLE_DEFORM', label: 'Simple Deform', icon: 'MOD_SIMPLEDEFORM', category: 'Deform', supported: true,
    defaults: { deformMethod: 'TWIST', angle: (45 * Math.PI) / 180, factor: 0.785398, limits: [0, 1], lockX: false, lockY: false },
    apply: (m, mod) => simpleDeform(m, mod) },
  { type: 'SMOOTH', label: 'Smooth', icon: 'MOD_SMOOTH', category: 'Deform', supported: true,
    defaults: { factor: 0.5, iterations: 1, useX: true, useY: true, useZ: true },
    apply: (m, mod) => {
      const out = cloneEval(m);
      const nbr: Set<number>[] = m.verts.map(() => new Set());
      for (const [a, b] of evalEdges(m)) { nbr[a].add(b); nbr[b].add(a); }
      const f = num(mod.factor, 0.5);
      const axes = [mod.useX !== false, mod.useY !== false, mod.useZ !== false];
      for (let it = 0; it < Math.max(0, Math.round(num(mod.iterations, 1))); it++) {
        const prev = out.verts.map((v) => [v[0], v[1], v[2]] as Vec3);
        out.verts = prev.map((v, i) => {
          if (!nbr[i].size) return v;
          const avg: Vec3 = [0, 0, 0];
          nbr[i].forEach((j) => { avg[0] += prev[j][0]; avg[1] += prev[j][1]; avg[2] += prev[j][2]; });
          const a = scale(avg, 1 / nbr[i].size);
          return v.map((x, k) => (axes[k] ? x + (a[k] - x) * f : x)) as Vec3;
        });
      }
      return out;
    } },
  { type: 'WAVE', label: 'Wave', icon: 'MOD_WAVE', category: 'Deform', supported: true,
    defaults: { useX: true, useY: true, useCyclic: true, useNormal: false, height: 0.5, width: 1.5, narrowness: 1.5, speed: 0.25, startX: 0, startY: 0, timeOffset: 0, lifetime: 0, dampingTime: 10, falloffRadius: 0 },
    apply: (m, mod, ctx) => wave(m, mod, ctx) },
];

export function modifierDef(type: string): ModifierDef | undefined {
  return MODIFIERS.find((d) => d.type === type);
}

export function newModifier(type: ModifierType, existing: Modifier[]): Modifier {
  const def = modifierDef(type)!;
  const names = new Set(existing.map((m) => m.name));
  let name = def.label;
  for (let i = 1; names.has(name); i++) name = `${def.label}.${String(i).padStart(3, '0')}`;
  return {
    type, name, showViewport: true, showRender: true, showInEditmode: type === 'SUBSURF' || type === 'MIRROR' || type === 'ARRAY',
    showOnCage: false, showExpanded: true, ...JSON.parse(JSON.stringify(def.defaults)),
  } as Modifier;
}

export function evaluateModifiers(md: MeshData, mods: Modifier[], ctx: ModifierContext): EvalMesh {
  let m = evalMeshFromData(md);
  for (const mod of mods) {
    if (ctx.render ? !mod.showRender : !mod.showViewport) continue;
    if (ctx.editMode && !mod.showInEditmode) continue;
    const def = modifierDef(mod.type);
    if (!def?.apply) continue;
    try { m = def.apply(m, mod, ctx); } catch (err) { console.warn('modifier failed', mod.type, err); }
  }
  return m;
}

// ------------------------------------------------------------------ more implementations

function solidify(m: EvalMesh, thickness: number, offset: number, rim: boolean, flip: boolean): EvalMesh {
  const n = vertexNormalsEval(m);
  const nv = m.verts.length;
  const outerF = (offset + 1) / 2, innerF = (offset - 1) / 2;
  const verts: Vec3[] = m.verts.map((v, i) => add(v, scale(n[i], thickness * outerF)));
  for (let i = 0; i < nv; i++) verts.push(add(m.verts[i], scale(n[i], thickness * innerF)));
  const faces: number[][] = [], faceSmooth: boolean[] = [], faceMat: number[] = [];
  m.faces.forEach((f, fi) => {
    faces.push(flip ? f.slice().reverse() : f.slice()); faceSmooth.push(m.faceSmooth[fi]); faceMat.push(m.faceMat[fi]);
    const inner = f.map((v) => v + nv).reverse();
    faces.push(flip ? inner.reverse() : inner); faceSmooth.push(m.faceSmooth[fi]); faceMat.push(m.faceMat[fi]);
  });
  if (rim) {
    const count = new Map<string, number>();
    const dir = new Map<string, [number, number]>();
    m.faces.forEach((f, fi) => {
      for (let i = 0; i < f.length; i++) {
        const a = f[i], b = f[(i + 1) % f.length];
        const k = edgeKey(a, b);
        count.set(k, (count.get(k) ?? 0) + 1);
        dir.set(k, [a, b]);
        void fi;
      }
    });
    count.forEach((c, k) => {
      if (c !== 1) return;
      const [a, b] = dir.get(k)!;
      const q = [b, a, a + nv, b + nv];
      faces.push(flip ? q.reverse() : q); faceSmooth.push(false); faceMat.push(0);
    });
  }
  return { verts, faces, looseEdges: m.looseEdges.slice(), faceSmooth, faceMat, forceSmooth: m.forceSmooth };
}

function edgeSplit(m: EvalMesh, angle: number): EvalMesh {
  const normals = m.faces.map((f) => polyNormal(m.verts, f));
  const edgeFaces = new Map<string, number[]>();
  m.faces.forEach((f, fi) => { for (let i = 0; i < f.length; i++) { const k = edgeKey(f[i], f[(i + 1) % f.length]); const l = edgeFaces.get(k); if (l) l.push(fi); else edgeFaces.set(k, [fi]); } });
  const sharp = new Set<string>();
  const cosA = Math.cos(angle);
  edgeFaces.forEach((fs, k) => { if (fs.length !== 2 || dot(normals[fs[0]], normals[fs[1]]) < cosA - 1e-6) sharp.add(k); });
  // union-find over face corners per vertex
  const verts: Vec3[] = [];
  const corner = new Map<string, number>(); // "face:vert" -> new vertex
  const vFaces: number[][] = m.verts.map(() => []);
  m.faces.forEach((f, fi) => { for (const v of f) vFaces[v].push(fi); });
  vFaces.forEach((fs, v) => {
    const parent = new Map<number, number>(fs.map((f) => [f, f]));
    const find = (x: number): number => { while (parent.get(x) !== x) x = parent.get(x)!; return x; };
    for (const fa of fs) {
      const f = m.faces[fa];
      const i = f.indexOf(v);
      for (const nbV of [f[(i + 1) % f.length], f[(i - 1 + f.length) % f.length]]) {
        const k = edgeKey(v, nbV);
        if (sharp.has(k)) continue;
        for (const fb of edgeFaces.get(k) ?? []) if (fb !== fa && parent.has(fb)) parent.set(find(fa), find(fb));
      }
    }
    const groupVert = new Map<number, number>();
    for (const f of fs) {
      const r = find(f);
      let nvIdx = groupVert.get(r);
      if (nvIdx === undefined) { nvIdx = verts.length; verts.push([...m.verts[v]] as Vec3); groupVert.set(r, nvIdx); }
      corner.set(`${f}:${v}`, nvIdx);
    }
  });
  const looseMap = new Map<number, number>();
  const looseEdges = m.looseEdges.map(([a, b]) => [a, b].map((v) => {
    let r = looseMap.get(v);
    if (r === undefined) { r = verts.length; verts.push([...m.verts[v]] as Vec3); looseMap.set(v, r); }
    return r;
  }) as [number, number]);
  const faces = m.faces.map((f, fi) => f.map((v) => corner.get(`${fi}:${v}`)!));
  return { verts, faces, looseEdges, faceSmooth: m.faces.map(() => true), faceMat: m.faceMat.slice(), forceSmooth: true };
}

function wave(m: EvalMesh, mod: Modifier, ctx: ModifierContext): EvalMesh {
  const out = cloneEval(m);
  const width = num(mod.width, 1.5), narrow = num(mod.narrowness, 1.5), speed = num(mod.speed, 0.25), height = num(mod.height, 0.5);
  const minfac = 1 / Math.exp(width * narrow * width * narrow);
  let lifefac = height;
  const timeoffs = num(mod.timeOffset, 0), lifetime = num(mod.lifetime, 0), damp = num(mod.dampingTime, 10) || 10;
  const ctime = ctx.frame;
  if (lifetime !== 0) {
    const x = ctime - timeoffs;
    if (x > lifetime) {
      lifefac = x - lifetime;
      lifefac = lifefac > damp ? 0 : height * (1 - Math.sqrt(lifefac / damp));
    }
  }
  if (lifefac === 0) return out;
  const normals = bool(mod.useNormal) ? vertexNormalsEval(m) : null;
  const useX = mod.useX !== false, useY = mod.useY !== false;
  out.verts = out.verts.map((co, i) => {
    const x = co[0] - num(mod.startX, 0), y = co[1] - num(mod.startY, 0);
    let amplit = 0;
    if (useX) amplit = useY ? Math.sqrt(x * x + y * y) : x;
    else if (useY) amplit = y;
    amplit -= (ctime - timeoffs) * speed;
    if (mod.useCyclic !== false) {
      amplit = ((((amplit - width) % (2 * width)) + 2 * width) % (2 * width)) - width;
    }
    if (amplit > -width && amplit < width) {
      amplit *= narrow;
      amplit = 1 / Math.exp(amplit * amplit) - minfac;
      const d = lifefac * amplit;
      if (normals) return add(co, scale(normals[i], d));
      return [co[0], co[1], co[2] + d] as Vec3;
    }
    return co;
  });
  return out;
}

function simpleDeform(m: EvalMesh, mod: Modifier): EvalMesh {
  const out = cloneEval(m);
  const method = (mod.deformMethod as string) ?? 'TWIST';
  const factor = method === 'TWIST' || method === 'BEND' ? num(mod.angle, 0.785) : num(mod.factor, 0.785);
  const b = meshBounds(m.verts);
  const lim = Array.isArray(mod.limits) ? (mod.limits as number[]) : [0, 1];
  const axis = method === 'BEND' ? 0 : 2;
  const lo = b.min[axis] + (b.max[axis] - b.min[axis]) * lim[0];
  const hi = b.min[axis] + (b.max[axis] - b.min[axis]) * lim[1];
  out.verts = out.verts.map((v) => {
    let [x, y, z] = v;
    const c = Math.min(hi, Math.max(lo, axis === 0 ? x : z));
    switch (method) {
      case 'TWIST': {
        const th = c * factor, ct = Math.cos(th), st = Math.sin(th);
        const nx = x * ct - y * st, ny = x * st + y * ct;
        x = nx; y = ny;
        z = z + 0;
        break;
      }
      case 'BEND': {
        if (Math.abs(factor) < 1e-9) break;
        const th = c * factor, ct = Math.cos(th), st = Math.sin(th);
        const r = 1 / factor;
        const dx = x - c;
        const ny = y - r;
        x = -ny * st + dx * ct;
        y = ny * ct + r + dx * st;
        break;
      }
      case 'TAPER': {
        const s = c * factor;
        if (!mod.lockX) x += x * s;
        if (!mod.lockY) y += y * s;
        break;
      }
      case 'STRETCH': {
        const s = c * factor;
        const sc = 1 + s;
        const inv = sc > 0 ? 1 / Math.sqrt(sc) : 1;
        z = z * sc;
        if (!mod.lockX) x *= inv;
        if (!mod.lockY) y *= inv;
        break;
      }
    }
    return [x, y, z] as Vec3;
  });
  return out;
}

function screw(m: EvalMesh, mod: Modifier, ctx: ModifierContext): EvalMesh {
  const steps = Math.max(2, Math.round(num(ctx.render ? mod.renderSteps : mod.steps, 16)));
  const angle = num(mod.angle, Math.PI * 2);
  const iterations = Math.max(1, Math.round(num(mod.iterations, 1)));
  const offset = num(mod.screwOffset, 0);
  const axisIdx = mod.axis === 'X' ? 0 : mod.axis === 'Y' ? 1 : 2;
  const total = steps * iterations;
  const closed = Math.abs(Math.abs(angle) - Math.PI * 2) < 1e-6 && Math.abs(offset) < 1e-9 && iterations === 1;
  const rings = closed ? total : total + 1;
  const nv = m.verts.length;
  const verts: Vec3[] = [];
  for (let s = 0; s < rings; s++) {
    const t = s / steps;
    const th = angle * t;
    const ct = Math.cos(th), st = Math.sin(th);
    for (const v of m.verts) {
      const p: Vec3 = [v[0], v[1], v[2]];
      const [i1, i2] = axisIdx === 2 ? [0, 1] : axisIdx === 0 ? [1, 2] : [2, 0];
      const a = p[i1], b = p[i2];
      p[i1] = a * ct - b * st;
      p[i2] = a * st + b * ct;
      p[axisIdx] += offset * t;
      verts.push(p);
    }
  }
  const faces: number[][] = [];
  const edges = evalEdges(m);
  const flip = bool(mod.useNormalFlip);
  for (let s = 0; s < total; s++) {
    const r0 = s * nv, r1 = ((s + 1) % rings) * nv;
    for (const [a, b] of edges) {
      const q = [r0 + a, r0 + b, r1 + b, r1 + a];
      faces.push(flip ? q : q.reverse());
    }
  }
  const smooth = mod.useSmoothShade !== false;
  return { verts, faces, looseEdges: [], faceSmooth: faces.map(() => smooth), faceMat: faces.map(() => 0) };
}

function wireframe(m: EvalMesh, thickness: number, replace: boolean): EvalMesh {
  // Builds a square tube along every edge (simplified Wireframe modifier).
  const out: EvalMesh = replace ? { verts: [], faces: [], looseEdges: [], faceSmooth: [], faceMat: [] } : cloneEval(m);
  const half = thickness / 2;
  for (const [a, b] of evalEdges(m)) {
    const pa = m.verts[a], pb = m.verts[b];
    const d = normalize(sub(pb, pa));
    if (length(d) < 1e-9) continue;
    const ref: Vec3 = Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const u = scale(normalize(cross(d, ref)), half);
    const v = scale(normalize(cross(d, u)), half);
    const base = out.verts.length;
    const ring = (p: Vec3) => [add(add(p, u), v), add(sub(p, u), v), sub(sub(p, u), v), sub(add(p, u), v)];
    for (const q of ring(pa)) out.verts.push(q as Vec3);
    for (const q of ring(pb)) out.verts.push(q as Vec3);
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      out.faces.push([base + i, base + j, base + 4 + j, base + 4 + i]);
      out.faceSmooth.push(false); out.faceMat.push(0);
    }
    out.faces.push([base + 3, base + 2, base + 1, base]); out.faceSmooth.push(false); out.faceMat.push(0);
    out.faces.push([base + 4, base + 5, base + 6, base + 7]); out.faceSmooth.push(false); out.faceMat.push(0);
  }
  return out;
}
