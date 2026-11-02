// Cloth and Soft Body: position-based (XPBD) mass-spring solvers that run on the
// mesh coming out of the modifiers above them in the stack. Positions are simulated
// in world space (so pinned vertices follow the object) and cached per frame.
//  - Cloth: structural (edges), shear (quad diagonals) and bending (vertices two edges
//    apart) distance constraints, pinning by vertex group, aerodynamic wind.
//  - Soft body: goal springs towards the animated shape, edge springs with separate
//    pull/push stiffness, bending springs, damping.
// Both collide with Collision objects and react to force fields via their field weights.

import { Matrix4 } from 'three';
import { app, evalKeyHooks } from '../app';
import { cloneEval, MODIFIERS, type EvalMesh, type ModifierContext } from '../core/modifiers';
import type { MatrixCache } from '../core/scene';
import type { BObject, Modifier } from '../core/types';
import { atFrame, evaluateSim, PointCache, resetAtStart, simProviders, type SimDriver } from './cache';
import { buildColliders, closestHit, segmentHit, type Collider } from './collision';
import { collectEffectors, effectorAccel, effectorSignature, type Effector } from './fields';
import {
  clothOf, defaultClothCollision, defaultClothSettings, defaultPointCache, defaultSoftBody, softBodyOf,
  type ClothModifier, type EffectorWeights, type SoftBodyModifier,
} from './types';

export interface DeformState {
  pos: Float32Array;
  vel: Float32Array;
}

/** Weight of each vertex in a vertex group (by name), or null when the group/weights don't exist. */
export function vertexGroupWeights(ob: BObject, group: string, count: number): Float32Array | null {
  if (!group) return null;
  const gi = (ob.vertexGroups ?? []).findIndex((g) => g.name === group);
  if (gi < 0) return null;
  const md = app.meshOf(ob);
  if (!md?.dvert || md.verts.length !== count) return null;
  const out = new Float32Array(count);
  md.dvert.forEach((dv, i) => { for (const [g, w] of dv ?? []) if (g === gi) out[i] = w; });
  return out;
}

function edgesOf(m: EvalMesh): [number, number][] {
  const seen = new Set<number>();
  const out: [number, number][] = [];
  const n = m.verts.length;
  const add = (a: number, b: number) => {
    if (a === b) return;
    const k = a < b ? a * n + b : b * n + a;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(a < b ? [a, b] : [b, a]);
  };
  for (const f of m.faces) for (let i = 0; i < f.length; i++) add(f[i], f[(i + 1) % f.length]);
  for (const e of m.looseEdges) add(e[0], e[1]);
  return out;
}

const XS_STRUCT = 4000;
const XS_BEND = 400;

/** Distance constraints with compliance (XPBD). */
interface Springs {
  a: Int32Array;
  b: Int32Array;
  rest: Float32Array;
  /** Compliance when stretched / compressed. */
  cPull: Float32Array;
  cPush: Float32Array;
  /** Velocity damping coefficient along the spring. */
  damp: Float32Array;
}

function makeSprings(list: { a: number; b: number; rest: number; pull: number; push: number; damp: number }[]): Springs {
  const n = list.length;
  const s: Springs = { a: new Int32Array(n), b: new Int32Array(n), rest: new Float32Array(n), cPull: new Float32Array(n), cPush: new Float32Array(n), damp: new Float32Array(n) };
  list.forEach((c, i) => { s.a[i] = c.a; s.b[i] = c.b; s.rest[i] = c.rest; s.cPull[i] = c.pull; s.cPush[i] = c.push; s.damp[i] = c.damp; });
  return s;
}

interface SolverSetup {
  kind: 'CLOTH' | 'SOFTBODY';
  n: number;
  invMass: Float32Array;
  springs: Springs;
  /** Goal (pin) compliance per vertex; Infinity = no goal; 0 = hard pin. */
  goal: Float32Array;
  goalDamp: number;
  faces: number[][];
  substeps: number;
  iterations: number;
  airDrag: number;
  velDamping: number;
  /** Extra distance kept from collision surfaces. */
  collideDist: number;
  friction: number;
  useCollision: boolean;
  weights: EffectorWeights;
  timeScale: number;
}

/** World-space vertex positions of the base mesh (the goal / pin targets). */
function worldVerts(m: EvalMesh, world: Matrix4): Float64Array {
  const e = world.elements;
  const out = new Float64Array(m.verts.length * 3);
  m.verts.forEach((v, i) => {
    out[i * 3] = e[0] * v[0] + e[4] * v[1] + e[8] * v[2] + e[12];
    out[i * 3 + 1] = e[1] * v[0] + e[5] * v[1] + e[9] * v[2] + e[13];
    out[i * 3 + 2] = e[2] * v[0] + e[6] * v[1] + e[10] * v[2] + e[14];
  });
  return out;
}

/** Shared position-based solver of the cloth and soft body drivers. */
abstract class DeformDriver<M extends Modifier> implements SimDriver<DeformState> {
  cache = new PointCache<DeformState>();
  abstract kind: 'CLOTH' | 'SOFTBODY';
  label: string;
  /** Mesh before this modifier (object space) of the latest evaluation. */
  base: EvalMesh | null = null;
  setup: SolverSetup | null = null;
  x: Float64Array = new Float64Array(0);
  v: Float64Array = new Float64Array(0);
  prevTarget: Float64Array | null = null;
  lastOut: { state: DeformState; nv: number; nf: number; world: string; mesh: EvalMesh } | null = null;

  constructor(public key: string, public obId: string, public modName: string) { this.label = modName; }

  ob(): BObject | null { return app.doc.objects[this.obId] ?? null; }
  mod(): M | null {
    const ob = this.ob();
    const m = ob?.modifiers.find((x) => x.name === this.modName && (x.type === 'CLOTH' || x.type === 'SOFT_BODY'));
    return (m as M | undefined) ?? null;
  }
  alive(): boolean { return !!this.mod(); }
  settings() { return (this.mod() as unknown as { pointCache?: { frameStart: number; frameEnd: number; frameStep: number } } | null)?.pointCache ?? defaultPointCache(250); }
  bytes(s: DeformState): number { return s.pos.byteLength + s.vel.byteLength; }

  signature(): string {
    const ob = this.ob();
    const sc = app.scene;
    return JSON.stringify([this.mod(), this.base?.verts.length, this.base?.faces.length, ob?.vertexGroups, sc.gravity, sc.useGravity, sc.fps, sc.fpsBase,
      app.objects().filter((o) => o.modifiers.some((m) => m.type === 'COLLISION')).map((o) => [o.id, o.collision]), effectorSignature()]);
  }

  protected abstract buildSetup(ob: BObject, mod: M, base: EvalMesh): SolverSetup;

  init(mats: MatrixCache): DeformState {
    const ob = this.ob(), mod = this.mod();
    const base = this.base;
    if (!ob || !mod || !base) return { pos: new Float32Array(0), vel: new Float32Array(0) };
    this.setup = this.buildSetup(ob, mod, base);
    const wv = worldVerts(base, mats.world(ob));
    this.x = wv;
    this.v = new Float64Array(wv.length);
    this.prevTarget = wv.slice();
    return this.snapshot();
  }

  private snapshot(): DeformState {
    return { pos: Float32Array.from(this.x), vel: Float32Array.from(this.v) };
  }

  restore(state: DeformState): void {
    const ob = this.ob(), mod = this.mod();
    if (!this.setup && ob && mod && this.base) this.setup = this.buildSetup(ob, mod, this.base);
    this.x = Float64Array.from(state.pos);
    this.v = Float64Array.from(state.vel);
    this.prevTarget = null;
  }

  step(mats: MatrixCache, frame: number): DeformState {
    const ob = this.ob();
    const S = this.setup;
    const base = this.base;
    if (!ob || !S || !base || base.verts.length !== S.n || this.x.length !== S.n * 3) return this.snapshot();
    const sc = app.scene;
    const fps = sc.fps / (sc.fpsBase || 1);
    const dt = S.timeScale / fps;
    const target = worldVerts(base, mats.world(ob));
    const prevTarget = this.prevTarget ?? target;
    const cols = S.useCollision ? buildColliders(mats, ob.id) : [];
    const effs = collectEffectors(mats, ob.id);
    const gw = S.weights.gravity;
    const g = sc.useGravity ? [sc.gravity[0] * gw, sc.gravity[1] * gw, sc.gravity[2] * gw] : [0, 0, 0];
    const steps = S.substeps;
    const h = dt / steps;
    for (let s = 0; s < steps; s++) {
      const t = (s + 1) / steps;
      this.substep(h, g, effs, cols, prevTarget, target, t, (frame - 1 + t) / fps);
    }
    this.prevTarget = target;
    return this.snapshot();
  }

  private substep(h: number, g: number[], effs: Effector[], cols: Collider[], tA: Float64Array, tB: Float64Array, tt: number, time: number): void {
    const S = this.setup!;
    const n = S.n;
    const x = this.x, v = this.v;
    const im = S.invMass;
    const p = new Float64Array(x.length);
    const acc = [0, 0, 0];
    const hasFields = effs.length > 0;
    const drag = Math.exp(-S.airDrag * h);
    const vdamp = S.velDamping < 1 ? Math.pow(Math.max(0, S.velDamping), h * 24) : 1;
    // external forces + prediction
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      if (im[i] === 0) continue;
      let ax = g[0], ay = g[1], az = g[2];
      if (hasFields) {
        acc[0] = acc[1] = acc[2] = 0;
        effectorAccel(effs.filter((e) => S.kind !== 'CLOTH' || e.field.type !== 'WIND'), S.weights, x[o], x[o + 1], x[o + 2], v[o], v[o + 1], v[o + 2], time, acc);
        ax += acc[0]; ay += acc[1]; az += acc[2];
      }
      v[o] = (v[o] + ax * h) * drag * vdamp;
      v[o + 1] = (v[o + 1] + ay * h) * drag * vdamp;
      v[o + 2] = (v[o + 2] + az * h) * drag * vdamp;
    }
    if (S.kind === 'CLOTH' && hasFields && effs.some((e) => e.field.type === 'WIND')) this.aerodynamics(h, effs, time);
    for (let i = 0; i < n * 3; i++) p[i] = x[i] + v[i] * h;
    // goals / pins
    const tgt = new Float64Array(3);
    const goalTarget = (i: number) => {
      const o = i * 3;
      tgt[0] = tA[o] + (tB[o] - tA[o]) * tt; tgt[1] = tA[o + 1] + (tB[o + 1] - tA[o + 1]) * tt; tgt[2] = tA[o + 2] + (tB[o + 2] - tA[o + 2]) * tt;
    };
    const h2 = h * h;
    for (let it = 0; it < S.iterations; it++) {
      // springs
      const sp = S.springs;
      for (let c = 0; c < sp.a.length; c++) {
        const a = sp.a[c], b = sp.b[c];
        const wa = im[a], wb = im[b];
        const w = wa + wb;
        if (w === 0) continue;
        const ao = a * 3, bo = b * 3;
        const dx = p[bo] - p[ao], dy = p[bo + 1] - p[ao + 1], dz = p[bo + 2] - p[ao + 2];
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len < 1e-12) continue;
        const C = len - sp.rest[c];
        const comp = C > 0 ? sp.cPull[c] : sp.cPush[c];
        if (!isFinite(comp)) continue;
        const dl = -C / (w + comp / h2);
        const nx = dx / len, ny = dy / len, nz = dz / len;
        p[ao] -= nx * dl * wa; p[ao + 1] -= ny * dl * wa; p[ao + 2] -= nz * dl * wa;
        p[bo] += nx * dl * wb; p[bo + 1] += ny * dl * wb; p[bo + 2] += nz * dl * wb;
      }
      // goals
      for (let i = 0; i < n; i++) {
        const gc = S.goal[i];
        if (!isFinite(gc)) continue;
        goalTarget(i);
        const o = i * 3;
        if (gc === 0 || im[i] === 0) { p[o] = tgt[0]; p[o + 1] = tgt[1]; p[o + 2] = tgt[2]; continue; }
        const f = im[i] / (im[i] + gc / h2);
        p[o] += (tgt[0] - p[o]) * f; p[o + 1] += (tgt[1] - p[o + 1]) * f; p[o + 2] += (tgt[2] - p[o + 2]) * f;
      }
    }
    // collisions
    const hit = cols.length ? new Uint8Array(n) : null;
    const hitN = cols.length ? new Float64Array(n * 3) : null;
    if (cols.length) {
      for (let i = 0; i < n; i++) {
        if (im[i] === 0) continue;
        const o = i * 3;
        // continuous: did the vertex cross a surface this substep?
        const sh = segmentHit(cols, x[o], x[o + 1], x[o + 2], p[o], p[o + 1], p[o + 2]);
        if (sh && sh.front) {
          const outer = sh.collider.settings.thicknessOuter + S.collideDist;
          const tt2 = Math.max(0, sh.t - 1e-4);
          p[o] = x[o] + (p[o] - x[o]) * tt2 + sh.normal[0] * outer;
          p[o + 1] = x[o + 1] + (p[o + 1] - x[o + 1]) * tt2 + sh.normal[1] * outer;
          p[o + 2] = x[o + 2] + (p[o + 2] - x[o + 2]) * tt2 + sh.normal[2] * outer;
          hit![i] = 1; hitN![o] = sh.normal[0]; hitN![o + 1] = sh.normal[1]; hitN![o + 2] = sh.normal[2];
        }
        // proximity: keep the vertex outside the surface by the collision distance
        const maxOuter = 0.5;
        const ch = closestHit(cols, p[o], p[o + 1], p[o + 2], maxOuter);
        if (!ch) continue;
        const outer = ch.collider.settings.thicknessOuter + S.collideDist;
        const inner = Math.max(ch.collider.settings.thicknessInner, outer);
        if (ch.dist < outer && ch.dist > -inner) {
          const push = outer - ch.dist;
          p[o] += ch.normal[0] * push; p[o + 1] += ch.normal[1] * push; p[o + 2] += ch.normal[2] * push;
          hit![i] = 1; hitN![o] = ch.normal[0]; hitN![o + 1] = ch.normal[1]; hitN![o + 2] = ch.normal[2];
        }
      }
    }
    // velocities
    const inv = 1 / h;
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      v[o] = (p[o] - x[o]) * inv; v[o + 1] = (p[o + 1] - x[o + 1]) * inv; v[o + 2] = (p[o + 2] - x[o + 2]) * inv;
      if (hit && hit[i]) {
        // friction and damping against the collider
        const nx = hitN![o], ny = hitN![o + 1], nz = hitN![o + 2];
        const vn = v[o] * nx + v[o + 1] * ny + v[o + 2] * nz;
        let tx = v[o] - vn * nx, ty = v[o + 1] - vn * ny, tz = v[o + 2] - vn * nz;
        const fr = Math.max(0, 1 - S.friction);
        tx *= fr; ty *= fr; tz *= fr;
        const vnn = Math.max(0, vn);
        v[o] = tx + vnn * nx; v[o + 1] = ty + vnn * ny; v[o + 2] = tz + vnn * nz;
      }
    }
    // spring damping (relative velocity along each spring)
    const sp = S.springs;
    for (let c = 0; c < sp.a.length; c++) {
      const k = sp.damp[c];
      if (k <= 0) continue;
      const a = sp.a[c], b = sp.b[c];
      const wa = im[a], wb = im[b];
      const w = wa + wb;
      if (w === 0) continue;
      const ao = a * 3, bo = b * 3;
      const dx = p[bo] - p[ao], dy = p[bo + 1] - p[ao + 1], dz = p[bo + 2] - p[ao + 2];
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len < 1e-12) continue;
      const nx = dx / len, ny = dy / len, nz = dz / len;
      const rv = (v[bo] - v[ao]) * nx + (v[bo + 1] - v[ao + 1]) * ny + (v[bo + 2] - v[ao + 2]) * nz;
      const f = Math.min(1, k * h) * rv / w;
      v[ao] += nx * f * wa; v[ao + 1] += ny * f * wa; v[ao + 2] += nz * f * wa;
      v[bo] -= nx * f * wb; v[bo + 1] -= ny * f * wb; v[bo + 2] -= nz * f * wb;
    }
    // goal damping
    if (S.goalDamp > 0) {
      const f = Math.min(1, S.goalDamp * h);
      for (let i = 0; i < n; i++) {
        if (!isFinite(S.goal[i]) || im[i] === 0) continue;
        const o = i * 3;
        const tvx = (tB[o] - tA[o]) / (h * S.substeps), tvy = (tB[o + 1] - tA[o + 1]) / (h * S.substeps), tvz = (tB[o + 2] - tA[o + 2]) / (h * S.substeps);
        v[o] += (tvx - v[o]) * f; v[o + 1] += (tvy - v[o + 1]) * f; v[o + 2] += (tvz - v[o + 2]) * f;
      }
    }
    this.x = p;
  }

  /** Wind acting on cloth faces along their normals (makes flags flutter). */
  private aerodynamics(h: number, effs: Effector[], time: number): void {
    const S = this.setup!;
    const x = this.x, v = this.v, im = S.invMass;
    const winds = effs.filter((e) => e.field.type === 'WIND');
    const acc = [0, 0, 0];
    for (const f of S.faces) {
      if (f.length < 3) continue;
      let cx = 0, cy = 0, cz = 0, vx = 0, vy = 0, vz = 0;
      for (const i of f) { cx += x[i * 3]; cy += x[i * 3 + 1]; cz += x[i * 3 + 2]; vx += v[i * 3]; vy += v[i * 3 + 1]; vz += v[i * 3 + 2]; }
      const k = 1 / f.length;
      cx *= k; cy *= k; cz *= k; vx *= k; vy *= k; vz *= k;
      // face normal (Newell)
      let nx = 0, ny = 0, nz = 0;
      for (let j = 0; j < f.length; j++) {
        const a = f[j] * 3, b = f[(j + 1) % f.length] * 3;
        nx += (x[a + 1] - x[b + 1]) * (x[a + 2] + x[b + 2]);
        ny += (x[a + 2] - x[b + 2]) * (x[a] + x[b]);
        nz += (x[a] - x[b]) * (x[a + 1] + x[b + 1]);
      }
      const nl = Math.hypot(nx, ny, nz);
      if (nl < 1e-12) continue;
      nx /= nl; ny /= nl; nz /= nl;
      acc[0] = acc[1] = acc[2] = 0;
      effectorAccel(winds, S.weights, cx, cy, cz, vx, vy, vz, time, acc);
      // relative air velocity projected on the normal
      const proj = (acc[0] - vx * 0.2) * nx + (acc[1] - vy * 0.2) * ny + (acc[2] - vz * 0.2) * nz;
      const fx = nx * proj * 1.5, fy = ny * proj * 1.5, fz = nz * proj * 1.5;
      for (const i of f) {
        if (im[i] === 0) continue;
        v[i * 3] += fx * h; v[i * 3 + 1] += fy * h; v[i * 3 + 2] += fz * h;
      }
    }
  }

  /** Result mesh for the modifier stack: simulated positions in object space. */
  output(m: EvalMesh, state: DeformState, world: Matrix4): EvalMesh {
    const out = cloneEval(m);
    if (state.pos.length !== m.verts.length * 3) return out;
    const inv = world.clone().invert().elements;
    const p = state.pos;
    out.verts = m.verts.map((_, i) => {
      const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
      return [inv[0] * x + inv[4] * y + inv[8] * z + inv[12], inv[1] * x + inv[5] * y + inv[9] * z + inv[13], inv[2] * x + inv[6] * y + inv[10] * z + inv[14]];
    });
    return out;
  }
}

class ClothDriver extends DeformDriver<ClothModifier> {
  kind = 'CLOTH' as const;
  protected buildSetup(ob: BObject, mod: ClothModifier, base: EvalMesh): SolverSetup {
    const cm = clothOf(mod);
    const st = cm.settings, co = cm.collisionSettings;
    const n = base.verts.length;
    const mass = Math.max(1e-4, st.mass);
    const invMass = new Float32Array(n).fill(1 / mass);
    const goal = new Float32Array(n).fill(Infinity);
    const pins = vertexGroupWeights(ob, st.vertexGroupMass, n);
    if (pins) {
      for (let i = 0; i < n; i++) {
        const w = pins[i];
        if (w >= 0.999) { invMass[i] = 0; goal[i] = 0; }
        else if (w > 0.001) goal[i] = 1 / (w * Math.max(1e-3, st.pinStiffness) * 2000);
      }
    }
    const V = base.verts;
    const dist = (a: number, b: number) => Math.hypot(V[a][0] - V[b][0], V[a][1] - V[b][1], V[a][2] - V[b][2]);
    const list: { a: number; b: number; rest: number; pull: number; push: number; damp: number }[] = [];
    const cStruct = 1 / (Math.max(1e-3, st.structuralStiffness) * XS_STRUCT);
    const cBend = 1 / (Math.max(1e-4, st.bendingStiffness) * XS_BEND);
    const damp = st.springDamping * 0.6;
    const edges = edgesOf(base);
    const shrink = 1 - st.shrinkMin;
    for (const [a, b] of edges) list.push({ a, b, rest: dist(a, b) * shrink, pull: cStruct, push: cStruct * 4, damp });
    // shear: quad diagonals
    for (const f of base.faces) {
      if (f.length !== 4) continue;
      list.push({ a: f[0], b: f[2], rest: dist(f[0], f[2]) * shrink, pull: cStruct * 2, push: cStruct * 8, damp: damp * 0.5 });
      list.push({ a: f[1], b: f[3], rest: dist(f[1], f[3]) * shrink, pull: cStruct * 2, push: cStruct * 8, damp: damp * 0.5 });
    }
    // bending: across each edge's adjacent faces (opposite vertices)
    const edgeFaces = new Map<number, number[]>();
    base.faces.forEach((f, fi) => { for (let i = 0; i < f.length; i++) { const a = f[i], b = f[(i + 1) % f.length]; const k = a < b ? a * n + b : b * n + a; const l = edgeFaces.get(k); if (l) l.push(fi); else edgeFaces.set(k, [fi]); } });
    const bendSeen = new Set<number>();
    for (const [k, fl] of edgeFaces) {
      if (fl.length !== 2) continue;
      const a = Math.floor(k / n), b = k % n;
      const fa = base.faces[fl[0]], fb = base.faces[fl[1]];
      // the neighbours of `a` on either side of the edge: folding along a-b changes their distance
      const nbr = (f: number[]) => { const i = f.indexOf(a); if (i < 0) return -1; const len = f.length; const pr = f[(i - 1 + len) % len], nx = f[(i + 1) % len]; return pr === b ? nx : nx === b ? pr : -1; };
      const c = nbr(fa), d = nbr(fb);
      if (c < 0 || d < 0 || c === d) continue;
      const kk = c < d ? c * n + d : d * n + c;
      if (bendSeen.has(kk)) continue;
      bendSeen.add(kk);
      list.push({ a: c, b: d, rest: dist(c, d), pull: cBend, push: cBend, damp: 0 });
    }
    const q = Math.max(1, Math.round(st.quality));
    return {
      kind: 'CLOTH', n, invMass, springs: makeSprings(list), goal, goalDamp: 0, faces: base.faces.map((f) => f.slice()),
      substeps: Math.min(60, q * 2), iterations: 2, airDrag: st.airDamping * 0.3, velDamping: st.velDamping,
      collideDist: co.distanceMin, friction: Math.min(0.95, co.friction * 0.04), useCollision: co.useCollision,
      weights: st.effectorWeights, timeScale: st.timeScale,
    };
  }
}

class SoftBodyDriver extends DeformDriver<SoftBodyModifier> {
  kind = 'SOFTBODY' as const;
  protected buildSetup(ob: BObject, mod: SoftBodyModifier, base: EvalMesh): SolverSetup {
    const st = softBodyOf(mod).settings;
    const n = base.verts.length;
    const invMass = new Float32Array(n).fill(1 / Math.max(1e-4, st.mass));
    const goal = new Float32Array(n).fill(Infinity);
    if (st.useGoal) {
      const w = vertexGroupWeights(ob, st.vertexGroupGoal, n);
      for (let i = 0; i < n; i++) {
        let gs = w ? w[i] : st.goalDefault;
        if (w) gs = st.goalMin + (st.goalMax - st.goalMin) * gs;
        gs = Math.min(st.goalMax, Math.max(st.goalMin, gs));
        if (gs >= 0.999) { invMass[i] = 0; goal[i] = 0; }
        else if (gs > 0.001) goal[i] = 1 / (Math.max(1e-3, st.goalSpring) * 400 * (gs / (1 - gs)));
      }
    }
    const V = base.verts;
    const dist = (a: number, b: number) => Math.hypot(V[a][0] - V[b][0], V[a][1] - V[b][1], V[a][2] - V[b][2]);
    const list: { a: number; b: number; rest: number; pull: number; push: number; damp: number }[] = [];
    if (st.useEdges) {
      const cPull = 1 / (Math.max(1e-3, st.pull) * 1500), cPush = 1 / (Math.max(1e-3, st.push) * 1500);
      const damp = st.damping * 4;
      for (const [a, b] of edgesOf(base)) list.push({ a, b, rest: dist(a, b), pull: cPull, push: cPush, damp });
      if (st.useStiffQuads) {
        const cs = 1 / (Math.max(1e-3, st.shear) * 1500);
        for (const f of base.faces) {
          if (f.length !== 4) continue;
          list.push({ a: f[0], b: f[2], rest: dist(f[0], f[2]), pull: cs, push: cs, damp });
          list.push({ a: f[1], b: f[3], rest: dist(f[1], f[3]), pull: cs, push: cs, damp });
        }
      }
      if (st.bend > 0) {
        // second-neighbour springs
        const nb: Set<number>[] = Array.from({ length: n }, () => new Set());
        for (const [a, b] of edgesOf(base)) { nb[a].add(b); nb[b].add(a); }
        const seen = new Set<number>();
        const cb = 1 / (st.bend * 150);
        for (let a = 0; a < n; a++) for (const b of nb[a]) for (const c of nb[b]) {
          if (c <= a || nb[a].has(c)) continue;
          const k = a * n + c;
          if (seen.has(k)) continue;
          seen.add(k);
          list.push({ a, b: c, rest: dist(a, c), pull: cb, push: cb, damp: 0 });
        }
      }
    }
    return {
      kind: 'SOFTBODY', n, invMass, springs: makeSprings(list), goal, goalDamp: st.goalFriction * 10, faces: base.faces.map((f) => f.slice()),
      substeps: Math.max(2, Math.min(50, Math.round(st.stepMin))), iterations: 2, airDrag: st.friction * 0.4, velDamping: 1,
      collideDist: 0.02, friction: 0.3, useCollision: true, weights: st.effectorWeights, timeScale: st.speed,
    };
  }
}

// ------------------------------------------------------------------ driver registry

const drivers = new Map<string, DeformDriver<Modifier>>();

function driverFor(ob: BObject, mod: Modifier): DeformDriver<Modifier> {
  const key = `${mod.type}:${ob.id}:${mod.name}`;
  let d = drivers.get(key);
  if (!d) {
    d = (mod.type === 'CLOTH' ? new ClothDriver(key, ob.id, mod.name) : new SoftBodyDriver(key, ob.id, mod.name)) as unknown as DeformDriver<Modifier>;
    drivers.set(key, d);
  }
  return d;
}

simProviders.push((scene) => {
  const out: SimDriver<unknown>[] = [];
  for (const id of scene.objects) {
    const ob = app.doc.objects[id];
    if (!ob) continue;
    for (const m of ob.modifiers) if (m.type === 'CLOTH' || m.type === 'SOFT_BODY') out.push(driverFor(ob, m) as unknown as SimDriver<unknown>);
  }
  return out;
});

/** Modifier evaluation: replace the vertex positions by the simulated state. */
function applySim(m: EvalMesh, mod: Modifier, ctx: ModifierContext): EvalMesh {
  const ob = ctx.ob;
  if (!ob || ctx.editMode || !ctx.doc || ctx.doc !== app.doc || !app.scene.objects.includes(ob.id)) return cloneEval(m);
  const d = driverFor(ob, mod);
  d.base = m;
  const pc = d.settings();
  const frame = ctx.frame;
  if (frame <= pc.frameStart) { resetAtStart(d); return cloneEval(m); }
  const state = evaluateSim(d, frame);
  if (!state) return cloneEval(m);
  const world = atFrame(app.scene.frameCurrent, (mats) => mats.world(ob).clone());
  // the same state gives the same mesh object (no geometry rebuild when re-evaluated)
  const memo = d.lastOut;
  if (memo && memo.state === state && memo.nv === m.verts.length && memo.nf === m.faces.length && memo.world === world.elements.join(',')) return memo.mesh;
  const mesh = d.output(m, state, world);
  d.lastOut = { state, nv: m.verts.length, nf: m.faces.length, world: world.elements.join(','), mesh };
  return mesh;
}

MODIFIERS.push(
  { type: 'CLOTH', label: 'Cloth', icon: 'MOD_CLOTH', category: 'Simulate', supported: true,
    defaults: { settings: defaultClothSettings(), collisionSettings: defaultClothCollision(), pointCache: defaultPointCache(250) },
    apply: applySim },
  { type: 'SOFT_BODY', label: 'Softbody', icon: 'MOD_SOFT', category: 'Simulate', supported: true,
    defaults: { settings: defaultSoftBody(), pointCache: defaultPointCache(250) },
    apply: applySim },
  { type: 'COLLISION', label: 'Collision', icon: 'MOD_PHYSICS', category: 'Simulate', supported: true, defaults: {},
    apply: (m) => cloneEval(m) },
);

/** Evaluated meshes of simulated objects change with the frame and the cache. */
evalKeyHooks.push((ob) => {
  if (!ob.modifiers.some((m) => m.type === 'CLOTH' || m.type === 'SOFT_BODY')) return '';
  const f = app.scene.frameCurrent;
  const eps = ob.modifiers.filter((m) => m.type === 'CLOTH' || m.type === 'SOFT_BODY').map((m) => {
    const d = drivers.get(`${m.type}:${ob.id}:${m.name}`);
    return d ? `${d.cache.epoch}.${Math.min(f, d.cache.last)}` : '0';
  });
  return `sim${app.scene.frameCurrent}:${eps.join(',')}`;
});

export function clothDriverOf(ob: BObject, mod: Modifier): SimDriver<DeformState> {
  return driverFor(ob, mod) as unknown as SimDriver<DeformState>;
}
