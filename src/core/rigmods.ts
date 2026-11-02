// Modifiers of the rigging toolset: Armature, Lattice, Hook, Mask and the Vertex Weight Edit / Mix /
// Proximity modifiers. They are added to the modifier registry of core/modifiers.ts at import time and
// read other objects through the evaluation context (`ctx.ob`, `ctx.doc`) and the app's matrix cache.

import { Matrix4, Quaternion, Vector3 } from 'three';
import { app, evalKeyHooks } from '../app';
import type { BObject, Doc, Modifier, Vec3 } from './types';
import { MODIFIERS, cloneEval, evalEdges, type EvalMesh, type ModifierContext } from './modifiers';
import { armatureOf, envelopeWeight, evaluatePose } from './armature';
import { groupIndex, getWeight, meshOfOb } from './vgroups';
import { latticeOffset } from './lattice';
import { meshBounds } from './mesh';

const num = (v: unknown, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

// ------------------------------------------------------------------ weights during evaluation

/** Weights changed by Vertex Weight modifiers earlier in the stack (per evaluation context). */
const weightOverrides = new WeakMap<ModifierContext, Map<string, Float32Array>>();
/** Nearest original vertex of every evaluated vertex, when generators changed the vertex count. */
const nearestCache = new WeakMap<ModifierContext, { n: number; map: Int32Array }>();

function originalIndexMap(m: EvalMesh, ctx: ModifierContext): Int32Array | null {
  const md = ctx.doc && ctx.ob ? meshOfOb(ctx.doc, ctx.ob) : null;
  if (!md) return null;
  if (md.verts.length === m.verts.length) return null; // identity
  const hit = nearestCache.get(ctx);
  if (hit && hit.n === m.verts.length) return hit.map;
  // spatial hash nearest neighbour against the original vertices
  const b = meshBounds(md.verts);
  const size = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2], 1e-6);
  const cell = size / Math.max(1, Math.cbrt(md.verts.length));
  const key = (x: number, y: number, z: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  const grid = new Map<string, number[]>();
  md.verts.forEach((v, i) => { const k = key(v[0], v[1], v[2]); const l = grid.get(k); if (l) l.push(i); else grid.set(k, [i]); });
  const map = new Int32Array(m.verts.length).fill(-1);
  m.verts.forEach((p, vi) => {
    const cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell), cz = Math.floor(p[2] / cell);
    let best = -1, bd = Infinity;
    for (let r = 1; r <= 3 && best < 0; r++) {
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
        for (const i of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
          const q = md.verts[i];
          const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2;
          if (d < bd) { bd = d; best = i; }
        }
      }
    }
    map[vi] = best;
  });
  nearestCache.set(ctx, { n: m.verts.length, map });
  return map;
}

/**
 * Weights of vertex group `name` for every vertex of the evaluated mesh `m` (null when the object has
 * no such group). Includes changes made by Vertex Weight modifiers earlier in the stack. When
 * generative modifiers changed the vertex count, weights are taken from the nearest original vertex.
 */
export function modifierWeights(m: EvalMesh, ctx: ModifierContext, name: string): Float32Array | null {
  if (!name || !ctx.ob || !ctx.doc) return null;
  const ov = weightOverrides.get(ctx)?.get(name);
  if (ov && ov.length === m.verts.length) return ov;
  const md = meshOfOb(ctx.doc, ctx.ob);
  const g = groupIndex(ctx.ob, name);
  if (!md || g < 0) return null;
  const out = new Float32Array(m.verts.length);
  const map = originalIndexMap(m, ctx);
  for (let v = 0; v < m.verts.length; v++) {
    const o = map ? map[v] : v;
    out[v] = o >= 0 ? getWeight(md, o, g) : 0;
  }
  return out;
}

function setOverride(ctx: ModifierContext, name: string, w: Float32Array): void {
  let mp = weightOverrides.get(ctx);
  if (!mp) { mp = new Map(); weightOverrides.set(ctx, mp); }
  mp.set(name, w);
}

/** World matrix of an object (shared cache of the app). */
function world(o: BObject): Matrix4 { return app.matrices.world(o); }

function objectRef(doc: Doc | undefined, id: unknown): BObject | null {
  return doc && typeof id === 'string' && id ? doc.objects[id] ?? null : null;
}

// ------------------------------------------------------------------ armature

function armatureDeform(m: EvalMesh, mod: Modifier, ctx: ModifierContext): EvalMesh {
  const doc = ctx.doc, ob = ctx.ob;
  const armOb = objectRef(doc, mod.object);
  const arm = doc ? armatureOf(doc, armOb) : null;
  if (!doc || !ob || !armOb || !arm || armOb.id === ob.id) return m;
  const res = evaluatePose(doc, armOb, { worldOf: world });
  const premat = world(armOb).clone().invert().multiply(world(ob));
  const postmat = premat.clone().invert();
  const useGroups = mod.useVertexGroups !== false, useEnv = mod.useBoneEnvelopes === true;
  const deformBones = arm.bones.filter((b) => b.useDeform);
  const groupW = deformBones.map((b) => (useGroups ? modifierWeights(m, ctx, b.name) : null));
  const mask = str(mod.vertexGroup) ? modifierWeights(m, ctx, str(mod.vertexGroup)) : null;
  const invMask = !!mod.invertVertexGroup;
  const skins = deformBones.map((b) => res.skin.get(b.name) ?? new Matrix4());
  const preserve = !!mod.useDeformPreserveVolume;
  const out = cloneEval(m);
  // dual quaternions of the bones (Preserve Volume)
  const dqs = preserve ? skins.map((sk) => {
    const qr = new Quaternion().setFromRotationMatrix(sk);
    const t = new Vector3().setFromMatrixPosition(sk);
    // qd = 0.5 * (0, t) * qr
    const qd = new Quaternion(t.x, t.y, t.z, 0).multiply(qr);
    return { qr, qd: new Quaternion(qd.x * 0.5, qd.y * 0.5, qd.z * 0.5, qd.w * 0.5) };
  }) : null;
  const p = new Vector3(), acc = new Vector3(), tmp = new Vector3();
  const br = new Quaternion(), bd = new Quaternion();
  for (let v = 0; v < m.verts.length; v++) {
    const src = m.verts[v];
    p.set(src[0], src[1], src[2]).applyMatrix4(premat);
    acc.set(0, 0, 0);
    let contrib = 0;
    br.set(0, 0, 0, 0); bd.set(0, 0, 0, 0);
    let first: Quaternion | null = null;
    for (let b = 0; b < deformBones.length; b++) {
      let w = 0;
      const gw = groupW[b];
      if (gw) w = gw[v];
      const bone = deformBones[b];
      if (useEnv && (!gw || w === 0 || bone.useEnvelopeMultiply)) {
        const ew = envelopeWeight(bone, p);
        w = bone.useEnvelopeMultiply && gw ? w * ew : (gw && w > 0 ? w : ew);
      }
      if (w <= 0) continue;
      if (dqs) {
        const d = dqs[b];
        const s = first && first.dot(d.qr) < 0 ? -w : w;
        if (!first) first = d.qr;
        br.set(br.x + d.qr.x * s, br.y + d.qr.y * s, br.z + d.qr.z * s, br.w + d.qr.w * s);
        bd.set(bd.x + d.qd.x * s, bd.y + d.qd.y * s, bd.z + d.qd.z * s, bd.w + d.qd.w * s);
      } else {
        tmp.copy(p).applyMatrix4(skins[b]).sub(p);
        acc.addScaledVector(tmp, w);
      }
      contrib += w;
    }
    if (contrib <= 1e-4) continue;
    const f = mask ? (invMask ? 1 - mask[v] : mask[v]) : 1;
    if (dqs) {
      const len = Math.hypot(br.x, br.y, br.z, br.w) || 1;
      const qr = new Quaternion(br.x / len, br.y / len, br.z / len, br.w / len);
      const qd = new Quaternion(bd.x / len, bd.y / len, bd.z / len, bd.w / len);
      // translation t = 2 * qd * conj(qr)
      const tq = qd.clone().multiply(qr.clone().conjugate());
      const moved = p.clone().applyQuaternion(qr).add(new Vector3(tq.x * 2, tq.y * 2, tq.z * 2));
      acc.copy(moved).sub(p).multiplyScalar(f);
    } else acc.multiplyScalar(f / contrib);
    p.add(acc).applyMatrix4(postmat);
    out.verts[v] = [p.x, p.y, p.z];
  }
  return out;
}

// ------------------------------------------------------------------ lattice

function latticeDeform(m: EvalMesh, mod: Modifier, ctx: ModifierContext): EvalMesh {
  const doc = ctx.doc, ob = ctx.ob;
  const lob = objectRef(doc, mod.object);
  if (!doc || !ob || !lob || lob.type !== 'LATTICE' || !lob.data) return m;
  const lt = doc.lattices?.[lob.data];
  if (!lt) return m;
  const toLat = world(lob).clone().invert().multiply(world(ob));
  const fromLat = toLat.clone().invert();
  const strength = num(mod.strength, 1);
  const vg = str(mod.vertexGroup) ? modifierWeights(m, ctx, str(mod.vertexGroup)) : null;
  const out = cloneEval(m);
  const p = new Vector3();
  for (let v = 0; v < m.verts.length; v++) {
    const f = strength * (vg ? vg[v] : 1);
    if (f === 0) continue;
    const s = m.verts[v];
    p.set(s[0], s[1], s[2]).applyMatrix4(toLat);
    const o = latticeOffset(lt, [p.x, p.y, p.z]);
    p.set(p.x + o[0] * f, p.y + o[1] * f, p.z + o[2] * f).applyMatrix4(fromLat);
    out.verts[v] = [p.x, p.y, p.z];
  }
  return out;
}

// ------------------------------------------------------------------ hook

function hookFalloff(type: string, d: number, radius: number): number {
  if (type === 'NONE' || radius <= 0) return 1;
  const t = Math.max(0, 1 - d / radius);
  switch (type) {
    case 'CONSTANT': return d <= radius ? 1 : 0;
    case 'LINEAR': return t;
    case 'SHARP': return t * t;
    case 'SPHERE': return Math.sqrt(2 * t - t * t);
    case 'ROOT': return Math.sqrt(t);
    case 'INVERSE_SQUARE': return t * (2 - t);
    default: return 3 * t * t - 2 * t * t * t; // SMOOTH
  }
}

function hookDeform(m: EvalMesh, mod: Modifier, ctx: ModifierContext): EvalMesh {
  const doc = ctx.doc, ob = ctx.ob;
  const hob = objectRef(doc, mod.object);
  if (!doc || !ob || !hob || hob.id === ob.id) return m;
  const inv = Array.isArray(mod.matrixInverse) && mod.matrixInverse.length === 16 ? new Matrix4().fromArray(mod.matrixInverse as number[]) : new Matrix4();
  const M = world(ob).clone().invert().multiply(world(hob)).multiply(inv);
  const strength = num(mod.strength, 1);
  const idx = Array.isArray(mod.vertexIndices) ? new Set(mod.vertexIndices as number[]) : null;
  const vg = str(mod.vertexGroup) ? modifierWeights(m, ctx, str(mod.vertexGroup)) : null;
  const center = Array.isArray(mod.center) ? (mod.center as Vec3) : [0, 0, 0];
  const radius = num(mod.falloffRadius, 0);
  const ftype = str(mod.falloffType) || 'NONE';
  const md = meshOfOb(doc, ob);
  const sameTopo = md && md.verts.length === m.verts.length;
  const out = cloneEval(m);
  const p = new Vector3();
  for (let v = 0; v < m.verts.length; v++) {
    let w: number;
    if (vg) w = vg[v];
    else if (idx && idx.size) w = sameTopo && idx.has(v) ? 1 : 0;
    else w = 1;
    if (w <= 0) continue;
    const s = m.verts[v];
    if (ftype !== 'NONE' && radius > 0) w *= hookFalloff(ftype, Math.hypot(s[0] - center[0], s[1] - center[1], s[2] - center[2]), radius);
    w *= strength;
    if (w <= 0) continue;
    p.set(s[0], s[1], s[2]).applyMatrix4(M);
    out.verts[v] = [s[0] + (p.x - s[0]) * w, s[1] + (p.y - s[1]) * w, s[2] + (p.z - s[2]) * w];
  }
  return out;
}

// ------------------------------------------------------------------ mask

function maskMod(m: EvalMesh, mod: Modifier, ctx: ModifierContext): EvalMesh {
  const keep = new Uint8Array(m.verts.length);
  const thr = num(mod.threshold, 0);
  if (mod.mode === 'ARMATURE') {
    const armOb = objectRef(ctx.doc, mod.armature);
    const arm = ctx.doc ? armatureOf(ctx.doc, armOb) : null;
    if (!arm) return m;
    const sel = arm.bones.filter((b) => b.select);
    if (!sel.length) return m;
    const ws = sel.map((b) => modifierWeights(m, ctx, b.name)).filter((x): x is Float32Array => !!x);
    for (let v = 0; v < m.verts.length; v++) keep[v] = ws.some((w) => w[v] > thr) ? 1 : 0;
  } else {
    const w = modifierWeights(m, ctx, str(mod.vertexGroup));
    if (!w) return m;
    for (let v = 0; v < m.verts.length; v++) keep[v] = w[v] > thr ? 1 : 0;
  }
  if (mod.invertVertexGroup) for (let v = 0; v < keep.length; v++) keep[v] = keep[v] ? 0 : 1;
  const remap = new Int32Array(m.verts.length).fill(-1);
  const out: EvalMesh = { verts: [], faces: [], looseEdges: [], faceSmooth: [], faceMat: [], forceSmooth: m.forceSmooth, vcol: m.vcol ? [] : undefined };
  m.verts.forEach((p, i) => { if (keep[i]) { remap[i] = out.verts.length; out.verts.push([p[0], p[1], p[2]]); out.vcol?.push(m.vcol![i].slice() as Vec3); } });
  m.faces.forEach((f, i) => {
    if (!f.every((v) => keep[v])) return;
    out.faces.push(f.map((v) => remap[v])); out.faceSmooth.push(m.faceSmooth[i]); out.faceMat.push(m.faceMat[i]);
  });
  for (const [a, b] of m.looseEdges) if (keep[a] && keep[b]) out.looseEdges.push([remap[a], remap[b]]);
  // edges of removed faces whose two vertices remain are kept as loose edges (like Blender's Mask)
  const faceEdge = new Set<string>();
  for (const f of out.faces) for (let k = 0; k < f.length; k++) { const a = f[k], b = f[(k + 1) % f.length]; faceEdge.add(a < b ? `${a}_${b}` : `${b}_${a}`); }
  for (const [a, b] of evalEdges(m)) {
    if (!keep[a] || !keep[b]) continue;
    const ra = remap[a], rb = remap[b];
    const k = ra < rb ? `${ra}_${rb}` : `${rb}_${ra}`;
    if (!faceEdge.has(k) && !out.looseEdges.some(([x, y]) => (x === ra && y === rb) || (x === rb && y === ra))) out.looseEdges.push([ra, rb]);
  }
  return out;
}

// ------------------------------------------------------------------ vertex weight modifiers

function falloffMap(type: string, w: number): number {
  const t = Math.min(1, Math.max(0, w));
  switch (type) {
    case 'SHARP': return t * t;
    case 'SMOOTH': return 3 * t * t - 2 * t * t * t;
    case 'ROOT': return Math.sqrt(t);
    case 'SPHERE': return Math.sqrt(2 * t - t * t);
    case 'RANDOM': return t * Math.random();
    case 'STEP': return t >= 0.5 ? 1 : 0;
    default: return t; // LINEAR / CURVE
  }
}

function maskFactor(m: EvalMesh, mod: Modifier, ctx: ModifierContext): Float32Array {
  const out = new Float32Array(m.verts.length).fill(num(mod.maskConstant, 1));
  const g = str(mod.maskVertexGroup);
  if (g) {
    const w = modifierWeights(m, ctx, g);
    if (w) for (let v = 0; v < out.length; v++) out[v] *= w[v];
  }
  return out;
}

function vwEdit(m: EvalMesh, mod: Modifier, ctx: ModifierContext): EvalMesh {
  const name = str(mod.vertexGroup);
  const base = modifierWeights(m, ctx, name);
  if (!base) return m;
  const w = Float32Array.from(base);
  const md = ctx.doc && ctx.ob ? meshOfOb(ctx.doc, ctx.ob) : null;
  const g = ctx.ob ? groupIndex(ctx.ob, name) : -1;
  const assigned = (v: number) => !!md && g >= 0 && md.verts.length === m.verts.length && !!md.dvert?.[v]?.some(([gi]) => gi === g);
  const mask = maskFactor(m, mod, ctx);
  for (let v = 0; v < w.length; v++) {
    let x = w[v];
    const orig = x;
    if (mod.useAdd && !assigned(v) && x === 0) x = num(mod.defaultWeight, 0);
    x = falloffMap(str(mod.falloffType) || 'LINEAR', x);
    if (mod.useAdd && x > num(mod.addThreshold, 0.01) && !assigned(v)) x = Math.max(x, num(mod.defaultWeight, 0));
    if (mod.useRemove && x < num(mod.removeThreshold, 0.01)) x = 0;
    w[v] = orig + (x - orig) * mask[v];
  }
  setOverride(ctx, name, w);
  return m;
}

function vwMix(m: EvalMesh, mod: Modifier, ctx: ModifierContext): EvalMesh {
  const a = str(mod.vertexGroupA);
  const wa = modifierWeights(m, ctx, a);
  if (!wa) return m;
  const wb = modifierWeights(m, ctx, str(mod.vertexGroupB));
  const da = num(mod.defaultWeightA, 0), db = num(mod.defaultWeightB, 0);
  const mask = maskFactor(m, mod, ctx);
  const out = Float32Array.from(wa);
  const sel = str(mod.mixSet) || 'AND';
  for (let v = 0; v < out.length; v++) {
    const x = wa[v] || 0, y = wb ? wb[v] : db;
    const inA = wa[v] > 0, inB = !!wb && wb[v] > 0;
    const use = sel === 'ALL' || (sel === 'A' && inA) || (sel === 'B' && inB) || (sel === 'OR' && (inA || inB)) || (sel === 'AND' && inA && inB);
    if (!use) continue;
    const xa = inA ? x : da;
    let r: number;
    switch (str(mod.mixMode) || 'SET') {
      case 'ADD': r = xa + y; break;
      case 'SUB': r = xa - y; break;
      case 'MUL': r = xa * y; break;
      case 'DIV': r = y !== 0 ? xa / y : xa; break;
      case 'DIF': r = Math.abs(xa - y); break;
      case 'AVG': r = (xa + y) / 2; break;
      default: r = y;
    }
    r = Math.min(1, Math.max(0, r));
    out[v] = xa + (r - xa) * mask[v];
  }
  setOverride(ctx, a, out);
  return m;
}

function vwProximity(m: EvalMesh, mod: Modifier, ctx: ModifierContext): EvalMesh {
  const name = str(mod.vertexGroup);
  const base = modifierWeights(m, ctx, name);
  const target = objectRef(ctx.doc, mod.target);
  if (!base || !target || !ctx.ob) return m;
  const toWorld = world(ctx.ob);
  const tw = world(target);
  let pts: Vector3[] = [new Vector3().setFromMatrixPosition(tw)];
  if (mod.proximityMode === 'GEOMETRY') {
    const tm = target.type === 'MESH' ? app.evalMesh(target) : null;
    if (tm && tm.verts.length) pts = tm.verts.map((p) => new Vector3(p[0], p[1], p[2]).applyMatrix4(tw));
  }
  const dmin = num(mod.minDist, 0), dmax = num(mod.maxDist, 1);
  const mask = maskFactor(m, mod, ctx);
  const out = Float32Array.from(base);
  const p = new Vector3();
  for (let v = 0; v < out.length; v++) {
    const s = m.verts[v];
    p.set(s[0], s[1], s[2]).applyMatrix4(toWorld);
    let d = Infinity;
    for (const q of pts) d = Math.min(d, p.distanceTo(q));
    let x = dmax === dmin ? (d <= dmin ? 0 : 1) : (d - dmin) / (dmax - dmin);
    x = falloffMap(str(mod.falloffType) || 'LINEAR', Math.min(1, Math.max(0, x)));
    out[v] = base[v] + (x - base[v]) * mask[v];
  }
  setOverride(ctx, name, out);
  return m;
}

// ------------------------------------------------------------------ registration

MODIFIERS.push(
  { type: 'ARMATURE', label: 'Armature', icon: 'MOD_ARMATURE', category: 'Deform', supported: true,
    defaults: { object: null, useVertexGroups: true, useBoneEnvelopes: false, useDeformPreserveVolume: false, useMultiModifier: false, vertexGroup: '', invertVertexGroup: false },
    apply: armatureDeform },
  { type: 'LATTICE', label: 'Lattice', icon: 'MOD_LATTICE', category: 'Deform', supported: true,
    defaults: { object: null, vertexGroup: '', strength: 1 },
    apply: latticeDeform },
  { type: 'HOOK', label: 'Hook', icon: 'HOOK', category: 'Deform', supported: true,
    defaults: { object: null, subtarget: '', vertexGroup: '', strength: 1, falloffType: 'NONE', falloffRadius: 0, center: [0, 0, 0], matrixInverse: new Matrix4().toArray(), vertexIndices: [] },
    apply: hookDeform },
  { type: 'MASK', label: 'Mask', icon: 'MOD_MASK', category: 'Generate', supported: true,
    defaults: { mode: 'VERTEX_GROUP', vertexGroup: '', armature: null, invertVertexGroup: false, threshold: 0 },
    apply: maskMod },
  { type: 'VERTEX_WEIGHT_EDIT', label: 'VertexWeightEdit', icon: 'MOD_VERTEX_WEIGHT', category: 'Modify', supported: true,
    defaults: { vertexGroup: '', defaultWeight: 0, useAdd: false, addThreshold: 0.01, useRemove: false, removeThreshold: 0.01, falloffType: 'LINEAR', maskConstant: 1, maskVertexGroup: '' },
    apply: vwEdit },
  { type: 'VERTEX_WEIGHT_MIX', label: 'VertexWeightMix', icon: 'MOD_VERTEX_WEIGHT', category: 'Modify', supported: true,
    defaults: { vertexGroupA: '', vertexGroupB: '', defaultWeightA: 0, defaultWeightB: 0, mixMode: 'SET', mixSet: 'AND', maskConstant: 1, maskVertexGroup: '' },
    apply: vwMix },
  { type: 'VERTEX_WEIGHT_PROXIMITY', label: 'VertexWeightProximity', icon: 'MOD_VERTEX_WEIGHT', category: 'Modify', supported: true,
    defaults: { vertexGroup: '', target: null, proximityMode: 'OBJECT', minDist: 0, maxDist: 1, falloffType: 'LINEAR', maskConstant: 1, maskVertexGroup: '' },
    apply: vwProximity },
);

// cache key: these modifiers depend on other objects' transforms and data
const DEP_TYPES = new Set(['ARMATURE', 'LATTICE', 'HOOK', 'MASK', 'VERTEX_WEIGHT_PROXIMITY']);

evalKeyHooks.push((ob) => {
  if (!ob.modifiers.some((m) => DEP_TYPES.has(m.type)) && !ob.vertexGroups?.length) return '';
  const doc = app.doc;
  const parts: unknown[] = [ob.vertexGroups ?? null];
  let needSelf = false;
  for (const m of ob.modifiers) {
    if (!DEP_TYPES.has(m.type) || m.showViewport === false && m.showRender === false) continue;
    const ref = objectRef(doc, m.type === 'MASK' ? m.armature : m.type === 'VERTEX_WEIGHT_PROXIMITY' ? m.target : m.object);
    if (!ref) continue;
    needSelf = true;
    parts.push(world(ref).elements);
    if (ref.type === 'ARMATURE') {
      const arm = armatureOf(doc, ref);
      parts.push(arm?.bones, arm?.posePosition, ref.pose);
      if (Object.values(ref.pose ?? {}).some((pb) => pb.constraints?.length)) parts.push(Object.values(ref.pose ?? {}).flatMap((pb) => pb.constraints.map((c) => (c.target && doc.objects[c.target] ? world(doc.objects[c.target]).elements : 0))));
    }
    if (ref.type === 'LATTICE' && ref.data) parts.push(doc.lattices?.[ref.data]);
  }
  if (needSelf) parts.push(world(ob).elements);
  return JSON.stringify(parts);
});
