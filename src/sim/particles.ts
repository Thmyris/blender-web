// Particle systems. Emitter particles are simulated frame by frame (Newtonian
// physics, force fields, collisions, simple boids) and cached like the other
// simulations; hair particles are static strands generated from the emitter
// surface, with simple / interpolated children (clump, roughness).

import { Matrix3, Matrix4, Vector3 } from 'three';
import { app } from '../app';
import { evaluateModifiers, type EvalMesh } from '../core/modifiers';
import { polyArea, polyNormal, triangulatePoly } from '../core/mesh';
import type { MatrixCache } from '../core/scene';
import type { BObject, ParticleSystem, Vec3 } from '../core/types';
import { atFrame, evaluateSim, PointCache, resetAtStart, simProviders, type SimDriver } from './cache';
import { buildColliders, segmentHit, type Collider } from './collision';
import { collectEffectors, effectorAccel, effectorSignature, vecNoise } from './fields';
import { psFull, type FullParticleSettings } from './types';

/** Small deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = (seed * 2654435761) >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomUnit(rand: () => number): Vec3 {
  const z = rand() * 2 - 1, a = rand() * Math.PI * 2, r = Math.sqrt(1 - z * z);
  return [r * Math.cos(a), r * Math.sin(a), z];
}

// ------------------------------------------------------------------ emission sampling

export interface Sample {
  /** Object-space position, normal and a per-particle random direction. */
  p: Vec3;
  n: Vec3;
  dir: Vec3;
  /** Face the sample lies on (-1 for vertices). */
  face: number;
}

const sampleCache = new WeakMap<EvalMesh, Map<string, Sample[]>>();

export function emissionSamples(m: EvalMesh, ps: FullParticleSettings, count = ps.count, seedOffset = 0): Sample[] {
  const key = `${count}|${ps.seed}|${ps.emitFrom}|${ps.distribution}|${ps.useEvenDistribution}|${ps.useEmitRandom}|${ps.jitterFactor}|${seedOffset}`;
  let byKey = sampleCache.get(m);
  if (!byKey) { byKey = new Map(); sampleCache.set(m, byKey); }
  const hit = byKey.get(key);
  if (hit) return hit;
  const rand = rng(ps.seed + 1 + seedOffset * 7919);
  const out: Sample[] = [];
  if (ps.emitFrom === 'VERT' || !m.faces.length) {
    if (m.verts.length) {
      const vn: Vec3[] = m.verts.map(() => [0, 0, 0]);
      for (const f of m.faces) { const n = polyNormal(m.verts, f); for (const v of f) { vn[v][0] += n[0]; vn[v][1] += n[1]; vn[v][2] += n[2]; } }
      for (let i = 0; i < count; i++) {
        const v = ps.useEmitRandom ? Math.floor(rand() * m.verts.length) : i % m.verts.length;
        const n = vn[v];
        const l = Math.hypot(n[0], n[1], n[2]);
        out.push({ p: m.verts[v].slice() as Vec3, n: l > 0 ? [n[0] / l, n[1] / l, n[2] / l] : [0, 0, 1], dir: randomUnit(rand), face: -1 });
      }
    }
  } else {
    const tris: { a: Vec3; b: Vec3; c: Vec3; n: Vec3; area: number; face: number }[] = [];
    m.faces.forEach((f, fi) => {
      const n = polyNormal(m.verts, f);
      for (const t of triangulatePoly(m.verts, f)) {
        const a = m.verts[f[t[0]]], b = m.verts[f[t[1]]], c = m.verts[f[t[2]]];
        tris.push({ a, b, c, n, area: polyArea(m.verts, [f[t[0]], f[t[1]], f[t[2]]]), face: fi });
      }
    });
    const at = (t: typeof tris[number], u: number, v: number): Vec3 => {
      if (u + v > 1) { u = 1 - u; v = 1 - v; }
      const w = 1 - u - v;
      return [t.a[0] * w + t.b[0] * u + t.c[0] * v, t.a[1] * w + t.b[1] * u + t.c[1] * v, t.a[2] * w + t.b[2] * u + t.c[2] * v];
    };
    if (ps.distribution === 'RANDOM' || !tris.length) {
      const cdf: number[] = [];
      let total = 0;
      for (const t of tris) { total += ps.useEvenDistribution ? t.area : 1; cdf.push(total); }
      for (let i = 0; i < count; i++) {
        const r = rand() * total;
        let lo = 0, hi = cdf.length - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid] < r) lo = mid + 1; else hi = mid; }
        const t = tris[lo];
        out.push({ p: at(t, rand(), rand()), n: t.n, dir: randomUnit(rand), face: t.face });
      }
    } else {
      // jittered: particles shared out over the triangles (by area), stratified inside each
      const weights = tris.map((t) => (ps.useEvenDistribution ? t.area : 1));
      const total = weights.reduce((a, b) => a + b, 0) || 1;
      const exact = weights.map((w) => (w / total) * count);
      const counts = exact.map(Math.floor);
      let rest = count - counts.reduce((a, b) => a + b, 0);
      const order = exact.map((e, i) => [e - Math.floor(e), i]).sort((a, b) => b[0] - a[0]);
      for (let k = 0; rest > 0 && k < order.length; k++, rest--) counts[order[k][1]]++;
      const jit = ps.distribution === 'GRID' ? 0 : Math.min(2, Math.max(0, ps.jitterFactor));
      tris.forEach((t, ti) => {
        const k = counts[ti];
        for (let j = 0; j < k; j++) {
          // R2 low-discrepancy sequence + jitter
          let u = (0.5 + (j + 0.5) * 0.7548776662466927) % 1, v = (0.5 + (j + 0.5) * 0.5698402909980532) % 1;
          if (k === 1) { u = 1 / 3; v = 1 / 3; }
          u = (u + (rand() - 0.5) * jit / Math.sqrt(k)) % 1; if (u < 0) u += 1;
          v = (v + (rand() - 0.5) * jit / Math.sqrt(k)) % 1; if (v < 0) v += 1;
          out.push({ p: at(t, u, v), n: t.n, dir: randomUnit(rand), face: t.face });
        }
      });
      if (ps.useEmitRandom) {
        for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
      }
    }
  }
  byKey.set(key, out);
  return out;
}

/** Mesh particles are emitted from (the stack before an Explode modifier). */
const preExplodeCache = new Map<string, { key: string; mesh: EvalMesh }>();
export function emitterMesh(ob: BObject): EvalMesh | null {
  const i = ob.modifiers.findIndex((m) => m.type === 'EXPLODE');
  if (i < 0) return app.evalMesh(ob);
  const md = app.meshOf(ob);
  if (!md) return null;
  const mods = ob.modifiers.slice(0, i);
  const key = `${md.verts.length}|${md.faces.length}|${JSON.stringify(mods)}|${JSON.stringify(md.verts.slice(0, 64))}`;
  const hit = preExplodeCache.get(ob.id);
  if (hit && hit.key === key) return hit.mesh;
  const mesh = evaluateModifiers(md, mods, { frame: app.scene.frameCurrent, render: false, editMode: false, ob, doc: app.doc });
  preExplodeCache.set(ob.id, { key, mesh });
  return mesh;
}

// ------------------------------------------------------------------ emitter simulation

export interface ParticleState {
  pos: Float32Array;
  vel: Float32Array;
  /** 0 unborn, 1 alive, 2 dead. */
  alive: Uint8Array;
}

interface Precomp {
  birth: Float32Array;
  life: Float32Array;
  size: Float32Array;
  samples: Sample[];
}

class ParticleDriver implements SimDriver<ParticleState> {
  kind = 'PARTICLES' as const;
  cache = new PointCache<ParticleState>();
  label: string;
  pre: Precomp | null = null;
  x = new Float32Array(0);
  v = new Float32Array(0);
  flags = new Uint8Array(0);
  prevWorld: Matrix4 | null = null;
  constructor(public key: string, public obId: string, public psName: string) { this.label = psName; }

  ob(): BObject | null { return app.doc.objects[this.obId] ?? null; }
  ps(): ParticleSystem | null { return this.ob()?.particleSystems?.find((p) => p.name === this.psName) ?? null; }
  alive(): boolean { return !!this.ps(); }
  settings() {
    const ps = this.ps();
    const sc = app.scene;
    return { frameStart: Math.min(ps?.frameStart ?? sc.frameStart, sc.frameStart), frameEnd: Math.max(sc.frameEnd, ps?.frameStart ?? 0), frameStep: 1 };
  }
  signature(): string {
    const ps = this.ps();
    const ob = this.ob();
    const m = ob ? emitterMesh(ob) : null;
    const sc = app.scene;
    return JSON.stringify([ps, m?.verts.length, m?.faces.length, sc.gravity, sc.useGravity, sc.fps, sc.fpsBase,
      app.objects().filter((o) => o.modifiers.some((x) => x.type === 'COLLISION')).map((o) => [o.id, o.collision]), effectorSignature()]);
  }
  bytes(s: ParticleState): number { return s.pos.byteLength + s.vel.byteLength + s.alive.byteLength; }

  private precompute(ps: FullParticleSettings, m: EvalMesh): Precomp {
    const n = ps.count;
    const samples = emissionSamples(m, ps);
    const rand = rng(ps.seed * 31 + 17);
    const birth = new Float32Array(n), life = new Float32Array(n), size = new Float32Array(n);
    const span = Math.max(0, ps.frameEnd - ps.frameStart);
    for (let i = 0; i < n; i++) {
      birth[i] = ps.frameStart + (n > 1 ? (span * i) / n : 0);
      life[i] = ps.lifetime * (1 - ps.lifetimeRandom * rand());
      size[i] = ps.size * (1 - ps.sizeRandom * rand());
    }
    return { birth, life, size, samples };
  }

  init(mats: MatrixCache, frame: number): ParticleState {
    const ob = this.ob(), ps0 = this.ps();
    const m = ob ? emitterMesh(ob) : null;
    if (!ob || !ps0 || !m) { this.x = new Float32Array(0); this.v = new Float32Array(0); this.flags = new Uint8Array(0); return this.snapshot(); }
    const ps = psFull(ps0);
    this.pre = this.precompute(ps, m);
    const n = Math.min(ps.count, this.pre.samples.length);
    this.x = new Float32Array(n * 3);
    this.v = new Float32Array(n * 3);
    this.flags = new Uint8Array(n);
    this.prevWorld = mats.world(ob).clone();
    // particles born exactly at the start frame
    for (let i = 0; i < n; i++) if (this.pre.birth[i] <= frame) this.spawn(i, ps, this.prevWorld, this.prevWorld, 1, 0);
    return this.snapshot();
  }

  restore(state: ParticleState): void {
    const ob = this.ob(), ps0 = this.ps();
    const m = ob ? emitterMesh(ob) : null;
    if (ob && ps0 && m && !this.pre) this.pre = this.precompute(psFull(ps0), m);
    this.x = Float32Array.from(state.pos);
    this.v = Float32Array.from(state.vel);
    this.flags = Uint8Array.from(state.alive);
    this.prevWorld = null;
  }

  private snapshot(): ParticleState {
    return { pos: Float32Array.from(this.x), vel: Float32Array.from(this.v), alive: Uint8Array.from(this.flags) };
  }

  /** Emit particle i at fraction `t` between the previous and current emitter transform. */
  private spawn(i: number, ps: FullParticleSettings, wa: Matrix4, wb: Matrix4, t: number, fps: number): void {
    const s = this.pre!.samples[i];
    const pa = new Vector3(...s.p).applyMatrix4(wa), pb = new Vector3(...s.p).applyMatrix4(wb);
    const p = pa.clone().lerp(pb, t);
    const nm = new Matrix3().getNormalMatrix(wb);
    const n = new Vector3(...s.n).applyMatrix3(nm).normalize();
    const v = n.multiplyScalar(ps.normalFactor).add(new Vector3(...s.dir).multiplyScalar(ps.randomFactor));
    v.x += ps.objectAlignFactor[0]; v.y += ps.objectAlignFactor[1]; v.z += ps.objectAlignFactor[2];
    if (ps.objectFactor && fps > 0) v.add(pb.clone().sub(pa).multiplyScalar(fps * ps.objectFactor));
    if (ps.physicsType === 'NO') v.set(0, 0, 0);
    const o = i * 3;
    this.x[o] = p.x; this.x[o + 1] = p.y; this.x[o + 2] = p.z;
    this.v[o] = v.x; this.v[o + 1] = v.y; this.v[o + 2] = v.z;
    this.flags[i] = 1;
  }

  step(mats: MatrixCache, frame: number): ParticleState {
    const ob = this.ob(), ps0 = this.ps();
    if (!ob || !ps0 || !this.pre) return this.snapshot();
    const ps = psFull(ps0);
    const sc = app.scene;
    const fps = sc.fps / (sc.fpsBase || 1);
    const world = mats.world(ob).clone();
    const prev = this.prevWorld ?? world;
    const n = this.flags.length;
    const dtFrame = 1 / fps;
    const sub = Math.max(1, Math.ceil(dtFrame / Math.max(0.005, ps.timestep)) + Math.max(0, Math.round(ps.subframes)));
    const h = dtFrame / sub;
    const physics = ps.physicsType;
    const cols: Collider[] = physics === 'NO' ? [] : buildColliders(mats, ob.id);
    const effs = physics === 'NO' ? [] : collectEffectors(mats, ob.id);
    const gw = ps.gravity;
    const g = sc.useGravity && physics === 'NEWTON' ? [sc.gravity[0] * gw, sc.gravity[1] * gw, sc.gravity[2] * gw] : [0, 0, 0];
    const acc = [0, 0, 0];
    const rand = rng(ps.seed * 977 + frame * 131);
    const pre = this.pre;
    for (let s = 0; s < sub; s++) {
      const t0 = frame - 1 + s / sub, t1 = frame - 1 + (s + 1) / sub;
      // births inside this substep
      for (let i = 0; i < n; i++) {
        if (this.flags[i] !== 0) continue;
        const b = pre.birth[i];
        if (b > t0 && b <= t1) {
          this.spawn(i, ps, prev, world, b - (frame - 1), fps);
          // advance the remaining part of the substep
          const rem = (t1 - b) / fps;
          if (physics !== 'NO') { const o = i * 3; this.x[o] += this.v[o] * rem; this.x[o + 1] += this.v[o + 1] * rem; this.x[o + 2] += this.v[o + 2] * rem; }
        }
      }
      if (physics === 'BOIDS') this.boids(ps, h);
      for (let i = 0; i < n; i++) {
        if (this.flags[i] !== 1) continue;
        // death by age
        if (t1 - pre.birth[i] > pre.life[i]) { this.flags[i] = 2; continue; }
        if (physics === 'NO') continue;
        const o = i * 3;
        let vx = this.v[o], vy = this.v[o + 1], vz = this.v[o + 2];
        let ax = g[0], ay = g[1], az = g[2];
        if (effs.length) {
          acc[0] = acc[1] = acc[2] = 0;
          effectorAccel(effs, ps.effectorWeights, this.x[o], this.x[o + 1], this.x[o + 2], vx, vy, vz, t1 / fps, acc);
          const im = 1 / Math.max(1e-4, ps.mass);
          ax += acc[0] * im; ay += acc[1] * im; az += acc[2] * im;
        }
        if (ps.brownianFactor) { ax += (rand() * 2 - 1) * ps.brownianFactor * 10; ay += (rand() * 2 - 1) * ps.brownianFactor * 10; az += (rand() * 2 - 1) * ps.brownianFactor * 10; }
        vx += ax * h; vy += ay * h; vz += az * h;
        if (ps.dragFactor) {
          const sp = Math.hypot(vx, vy, vz);
          const k = Math.max(0, 1 - ps.dragFactor * sp * h * pre.size[i] * 10);
          vx *= k; vy *= k; vz *= k;
        }
        if (ps.dampingFactor) { const k = Math.max(0, 1 - ps.dampingFactor); vx *= k; vy *= k; vz *= k; }
        if (physics === 'BOIDS') {
          const sp = Math.hypot(vx, vy, vz), mx = ps.boidAirSpeedMax;
          if (sp > mx) { vx *= mx / sp; vy *= mx / sp; vz *= mx / sp; }
        }
        let px = this.x[o], py = this.x[o + 1], pz = this.x[o + 2];
        let qx = px + vx * h, qy = py + vy * h, qz = pz + vz * h;
        // collisions (up to two bounces per substep)
        for (let k = 0; k < 2 && cols.length; k++) {
          const hit = segmentHit(cols, px, py, pz, qx, qy, qz);
          if (!hit) break;
          const cs = hit.collider.settings;
          if (cs.permeability > 0 && rand() < cs.permeability) break;
          if (cs.useParticleKill || ps.useDieOnCollision) { this.flags[i] = 2; qx = px + (qx - px) * hit.t; qy = py + (qy - py) * hit.t; qz = pz + (qz - pz) * hit.t; break; }
          const [nx, ny, nz] = hit.normal;
          const side = hit.front ? 1 : -1;
          const cx = px + (qx - px) * hit.t, cy = py + (qy - py) * hit.t, cz = pz + (qz - pz) * hit.t;
          const damp = Math.min(1, cs.dampingFactor + cs.dampingRandom * rand());
          const fric = Math.min(1, cs.frictionFactor + cs.frictionRandom * rand());
          const vn = vx * nx + vy * ny + vz * nz;
          const tx = vx - vn * nx, ty = vy - vn * ny, tz = vz - vn * nz;
          const vn2 = -vn * (1 - damp);
          const stick = cs.stickiness > 0 && Math.abs(vn) < cs.stickiness;
          vx = stick ? 0 : tx * (1 - fric) + vn2 * nx; vy = stick ? 0 : ty * (1 - fric) + vn2 * ny; vz = stick ? 0 : tz * (1 - fric) + vn2 * nz;
          const eps = 1e-4 * side;
          px = cx + nx * eps; py = cy + ny * eps; pz = cz + nz * eps;
          const remain = (1 - hit.t) * h;
          qx = px + vx * remain; qy = py + vy * remain; qz = pz + vz * remain;
        }
        this.x[o] = qx; this.x[o + 1] = qy; this.x[o + 2] = qz;
        this.v[o] = vx; this.v[o + 1] = vy; this.v[o + 2] = vz;
      }
    }
    this.prevWorld = world;
    return this.snapshot();
  }

  /** Simple flocking: separation, alignment and cohesion between nearby particles. */
  private boids(ps: FullParticleSettings, h: number): void {
    const n = this.flags.length;
    const r = Math.max(0.05, ps.size * 8);
    const cell = r;
    const grid = new Map<string, number[]>();
    for (let i = 0; i < n; i++) {
      if (this.flags[i] !== 1) continue;
      const k = `${Math.floor(this.x[i * 3] / cell)},${Math.floor(this.x[i * 3 + 1] / cell)},${Math.floor(this.x[i * 3 + 2] / cell)}`;
      const l = grid.get(k); if (l) l.push(i); else grid.set(k, [i]);
    }
    const maxAcc = ps.boidAirAccMax * ps.boidAirSpeedMax;
    for (let i = 0; i < n; i++) {
      if (this.flags[i] !== 1) continue;
      const o = i * 3;
      const cx = Math.floor(this.x[o] / cell), cy = Math.floor(this.x[o + 1] / cell), cz = Math.floor(this.x[o + 2] / cell);
      let sx = 0, sy = 0, sz = 0, ax = 0, ay = 0, az = 0, mx = 0, my = 0, mz = 0, cnt = 0;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        for (const j of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
          if (j === i || cnt >= ps.boidNeighbours * 4) continue;
          const jo = j * 3;
          const ddx = this.x[o] - this.x[jo], ddy = this.x[o + 1] - this.x[jo + 1], ddz = this.x[o + 2] - this.x[jo + 2];
          const d = Math.hypot(ddx, ddy, ddz);
          if (d > r || d < 1e-9) continue;
          sx += ddx / (d * d); sy += ddy / (d * d); sz += ddz / (d * d);
          ax += this.v[jo]; ay += this.v[jo + 1]; az += this.v[jo + 2];
          mx += this.x[jo]; my += this.x[jo + 1]; mz += this.x[jo + 2];
          cnt++;
        }
      }
      if (!cnt) continue;
      let fx = sx * ps.boidSeparate * 0.1 + ((ax / cnt - this.v[o]) * 0.5 + (mx / cnt - this.x[o])) * ps.boidFlock;
      let fy = sy * ps.boidSeparate * 0.1 + ((ay / cnt - this.v[o + 1]) * 0.5 + (my / cnt - this.x[o + 1])) * ps.boidFlock;
      let fz = sz * ps.boidSeparate * 0.1 + ((az / cnt - this.v[o + 2]) * 0.5 + (mz / cnt - this.x[o + 2])) * ps.boidFlock;
      const fl = Math.hypot(fx, fy, fz);
      if (fl > maxAcc) { fx *= maxAcc / fl; fy *= maxAcc / fl; fz *= maxAcc / fl; }
      this.v[o] += fx * h; this.v[o + 1] += fy * h; this.v[o + 2] += fz * h;
    }
  }
}

const drivers = new Map<string, ParticleDriver>();

export function particleDriver(ob: BObject, ps: ParticleSystem): ParticleDriver {
  const key = `PS:${ob.id}:${ps.name}`;
  let d = drivers.get(key);
  if (!d) { d = new ParticleDriver(key, ob.id, ps.name); drivers.set(key, d); }
  return d;
}

simProviders.push((scene) => {
  const out: SimDriver<unknown>[] = [];
  for (const id of scene.objects) {
    const ob = app.doc.objects[id];
    if (!ob || ob.type !== 'MESH') continue;
    for (const ps of ob.particleSystems ?? []) if ((ps.type ?? 'EMITTER') === 'EMITTER') out.push(particleDriver(ob, ps) as unknown as SimDriver<unknown>);
  }
  return out;
});

export interface ParticleFrame {
  pos: Float32Array;
  vel: Float32Array;
  alive: Uint8Array;
  size: Float32Array;
  birth: Float32Array;
}

/** State of an emitter particle system at a frame (null before the system's start). */
export function particleFrame(ob: BObject, ps: ParticleSystem, frame: number): ParticleFrame | null {
  const d = particleDriver(ob, ps);
  const pc = d.settings();
  if (frame < pc.frameStart) { resetAtStart(d); return null; }
  if (frame === pc.frameStart) resetAtStart(d);
  const st = evaluateSim(d, frame);
  if (!st || !d.pre) return null;
  return { pos: st.pos, vel: st.vel, alive: st.alive, size: d.pre.size, birth: d.pre.birth };
}

/** Positions of one particle over past frames (Path render of emitter particles). */
export function particleTrail(ob: BObject, ps: ParticleSystem, i: number, frame: number, maxFrames: number): number[] {
  const d = particleDriver(ob, ps);
  const out: number[] = [];
  for (let f = frame; f >= frame - maxFrames; f--) {
    const st = d.cache.states.get(f);
    if (!st || st.alive[i] !== 1) break;
    out.push(st.pos[i * 3], st.pos[i * 3 + 1], st.pos[i * 3 + 2]);
  }
  return out;
}

// ------------------------------------------------------------------ hair

export interface HairStrands {
  /** World-space points of all strands, concatenated. */
  points: Float32Array;
  /** Index of the first point of each strand (plus a final end index). */
  offsets: Int32Array;
  /** Parent strand count (the first strands are the parents). */
  parents: number;
}

/** Key points (object space) of the parent strands: root..tip, `segments`+1 keys each. */
export function parentHairKeys(ob: BObject, ps0: ParticleSystem, m: EvalMesh): { roots: Sample[]; keys: Vec3[][] } {
  const ps = psFull(ps0);
  const roots = emissionSamples(m, ps);
  const segs = Math.max(1, Math.round(ps.hairStep));
  const keys: Vec3[][] = [];
  roots.forEach((s, i) => {
    const edited = ps.hairKeys?.[i];
    if (edited && edited.length >= 6) {
      const pts: Vec3[] = [];
      for (let k = 0; k + 2 < edited.length; k += 3) pts.push([edited[k], edited[k + 1], edited[k + 2]]);
      keys.push(pts);
      return;
    }
    let d: Vec3 = s.n.slice() as Vec3;
    let len = ps.hairLength;
    if (ps.useAdvancedHair) {
      d = [s.n[0] * ps.normalFactor + s.dir[0] * ps.randomFactor + ps.objectAlignFactor[0], s.n[1] * ps.normalFactor + s.dir[1] * ps.randomFactor + ps.objectAlignFactor[1], s.n[2] * ps.normalFactor + s.dir[2] * ps.randomFactor + ps.objectAlignFactor[2]];
      const l = Math.hypot(d[0], d[1], d[2]);
      if (l < 1e-9) d = s.n.slice() as Vec3; else { d = [d[0] / l, d[1] / l, d[2] / l]; len *= l / Math.max(1e-6, Math.abs(ps.normalFactor) || 1); }
    }
    const pts: Vec3[] = [];
    for (let k = 0; k <= segs; k++) {
      const t = k / segs;
      pts.push([s.p[0] + d[0] * len * t, s.p[1] + d[1] * len * t, s.p[2] + d[2] * len * t]);
    }
    keys.push(pts);
  });
  return { roots, keys };
}

/** Catmull-Rom resampling of strand keys into `res` points per segment. */
function resample(keys: Vec3[], res: number): Vec3[] {
  if (res <= 1 || keys.length < 2) return keys.map((k) => k.slice() as Vec3);
  const out: Vec3[] = [];
  const n = keys.length;
  for (let i = 0; i < n - 1; i++) {
    const p0 = keys[Math.max(0, i - 1)], p1 = keys[i], p2 = keys[i + 1], p3 = keys[Math.min(n - 1, i + 2)];
    for (let j = 0; j < res; j++) {
      const t = j / res, t2 = t * t, t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1]), f(p0[2], p1[2], p2[2], p3[2])]);
    }
  }
  out.push(keys[n - 1].slice() as Vec3);
  return out;
}

const hairCache = new Map<string, { key: string; strands: HairStrands }>();

/** Hair strands of a hair particle system in world space (parents + children). */
export function hairStrands(ob: BObject, ps0: ParticleSystem, world: Matrix4, render: boolean, displayFraction = 1): HairStrands | null {
  const m = emitterMesh(ob);
  if (!m) return null;
  const ps = psFull(ps0);
  const key = JSON.stringify([ps, render, displayFraction, world.elements, m.verts.length, m.faces.length]) + (sampleCache.has(m) ? '' : '*');
  const hit = hairCache.get(`${ob.id}:${ps.name}`);
  if (hit && hit.key === key && hairMeshRef.get(`${ob.id}:${ps.name}`) === m) return hit.strands;
  const { roots, keys } = parentHairKeys(ob, ps, m);
  const res = 1 << Math.max(0, Math.min(6, Math.round(render ? ps.renderStep : ps.displayStep)));
  const shownParents = Math.max(0, Math.min(keys.length, Math.round(keys.length * displayFraction)));
  const parentPaths = keys.map((k) => resample(k, res));
  const strands: Vec3[][] = [];
  const childType = ps.childType;
  if (childType === 'NONE') for (let i = 0; i < shownParents; i++) strands.push(parentPaths[i]);
  if (childType !== 'NONE') {
    const per = Math.max(0, Math.round(render ? ps.renderedChildCount : ps.childNbr));
    const rand = rng(ps.seed * 7 + 3);
    const total = shownParents * per;
    if (childType === 'SIMPLE') {
      for (let pi = 0; pi < shownParents; pi++) {
        const path = parentPaths[pi];
        const root = roots[pi];
        const n = root.n;
        // a frame around the root normal
        const ax: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
        const u = normalize(sub(ax, scale3(n, dot(ax, n))));
        const w = cross(n, u);
        for (let c = 0; c < per; c++) {
          const ang = rand() * Math.PI * 2, rr = Math.sqrt(rand()) * ps.childRadius;
          const ofs = add(scale3(u, Math.cos(ang) * rr), scale3(w, Math.sin(ang) * rr * (1 - ps.childRoundness) + 0));
          const lift = scale3(n, (rand() - 0.5) * rr * ps.childRoundness);
          strands.push(childPath(path, add(ofs, lift), ps, rand));
        }
      }
    } else {
      // interpolated: children rooted on the surface, shaped by the nearest parents
      const childRoots = emissionSamples(m, { ...ps, distribution: 'RANDOM' }, total, 1);
      const grid = new Map<string, number[]>();
      let ext = 0;
      for (const r of roots.slice(0, shownParents)) ext = Math.max(ext, Math.abs(r.p[0]), Math.abs(r.p[1]), Math.abs(r.p[2]));
      const cell = Math.max(1e-3, (ext * 2) / Math.max(1, Math.cbrt(shownParents)) * 1.5);
      roots.slice(0, shownParents).forEach((r, i) => {
        const k = `${Math.floor(r.p[0] / cell)},${Math.floor(r.p[1] / cell)},${Math.floor(r.p[2] / cell)}`;
        const l = grid.get(k); if (l) l.push(i); else grid.set(k, [i]);
      });
      for (const cr of childRoots) {
        const near: [number, number][] = [];
        const cx = Math.floor(cr.p[0] / cell), cy = Math.floor(cr.p[1] / cell), cz = Math.floor(cr.p[2] / cell);
        for (let rad = 1; rad <= 3 && near.length < 3; rad++) {
          near.length = 0;
          for (let dx = -rad; dx <= rad; dx++) for (let dy = -rad; dy <= rad; dy++) for (let dz = -rad; dz <= rad; dz++) {
            for (const i of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
              const r = roots[i].p;
              near.push([i, Math.hypot(r[0] - cr.p[0], r[1] - cr.p[1], r[2] - cr.p[2])]);
            }
          }
        }
        if (!near.length) continue;
        near.sort((a, b) => a[1] - b[1]);
        const use = near.slice(0, 4);
        let wsum = 0;
        const ws = use.map(([, d]) => { const w = 1 / Math.max(1e-4, d); wsum += w; return w; });
        const len = parentPaths[use[0][0]].length;
        const path: Vec3[] = [];
        for (let k = 0; k < len; k++) {
          const q: Vec3 = [0, 0, 0];
          use.forEach(([i], j) => {
            const pp = parentPaths[i];
            const root = pp[0], pt = pp[Math.min(k, pp.length - 1)];
            q[0] += (pt[0] - root[0]) * ws[j]; q[1] += (pt[1] - root[1]) * ws[j]; q[2] += (pt[2] - root[2]) * ws[j];
          });
          path.push([cr.p[0] + q[0] / wsum, cr.p[1] + q[1] / wsum, cr.p[2] + q[2] / wsum]);
        }
        // clump towards the nearest parent
        strands.push(childPath(path, [0, 0, 0], ps, rand, parentPaths[use[0][0]]));
      }
    }
  }
  // to world space
  let total = 0;
  for (const s of strands) total += s.length;
  const points = new Float32Array(total * 3);
  const offsets = new Int32Array(strands.length + 1);
  const e = world.elements;
  let o = 0;
  strands.forEach((s, si) => {
    offsets[si] = o / 3;
    for (const p of s) {
      points[o++] = e[0] * p[0] + e[4] * p[1] + e[8] * p[2] + e[12];
      points[o++] = e[1] * p[0] + e[5] * p[1] + e[9] * p[2] + e[13];
      points[o++] = e[2] * p[0] + e[6] * p[1] + e[10] * p[2] + e[14];
    }
  });
  offsets[strands.length] = o / 3;
  const out: HairStrands = { points, offsets, parents: Math.min(shownParents, strands.length) };
  hairCache.set(`${ob.id}:${ps.name}`, { key, strands: out });
  hairMeshRef.set(`${ob.id}:${ps.name}`, m);
  return out;
}

const hairMeshRef = new Map<string, EvalMesh>();

/** A child strand: the parent path offset at the root, with clump, length and roughness. */
function childPath(parent: Vec3[], ofs: Vec3, ps: FullParticleSettings, rand: () => number, clumpTo?: Vec3[]): Vec3[] {
  const n = parent.length;
  const out: Vec3[] = [];
  const clump = ps.clumpFactor;
  const shape = ps.clumpShape;
  const exp = shape >= 0 ? 1 - shape * 0.999 : 1 / (1 + shape * 0.999);
  const endRand: Vec3 = [rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1];
  const rand2: Vec3 = [rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1];
  const affected2 = rand() >= ps.roughness2Threshold;
  const lenFac = Math.max(0, Math.min(1, ps.childLength));
  const nz = [0, 0, 0];
  const root = parent[0];
  for (let k = 0; k < n; k++) {
    const t = n > 1 ? k / (n - 1) : 0;
    const tl = t * lenFac;
    // position along the (possibly shortened) parent
    const fi = tl * (n - 1), i0 = Math.floor(fi), i1 = Math.min(n - 1, i0 + 1), fr = fi - i0;
    const pp: Vec3 = [parent[i0][0] + (parent[i1][0] - parent[i0][0]) * fr, parent[i0][1] + (parent[i1][1] - parent[i0][1]) * fr, parent[i0][2] + (parent[i1][2] - parent[i0][2]) * fr];
    let o: Vec3 = ofs.slice() as Vec3;
    if (clump !== 0) {
      const c = clump > 0 ? clump * Math.pow(t, exp) : clump * Math.pow(t, exp);
      o = scale3(o, 1 - c);
      if (clumpTo && clump > 0) {
        const cp = clumpTo[Math.min(clumpTo.length - 1, Math.round(tl * (clumpTo.length - 1)))];
        pp[0] += (cp[0] - pp[0]) * c; pp[1] += (cp[1] - pp[1]) * c; pp[2] += (cp[2] - pp[2]) * c;
      }
    }
    const p: Vec3 = add(pp, o);
    if (ps.roughness1) {
      const sz = Math.max(1e-3, ps.roughness1Size);
      vecNoise(p[0] / sz * 4, p[1] / sz * 4, p[2] / sz * 4, ps.seed + 5, nz);
      p[0] += nz[0] * ps.roughness1 * t * 0.5; p[1] += nz[1] * ps.roughness1 * t * 0.5; p[2] += nz[2] * ps.roughness1 * t * 0.5;
    }
    if (ps.roughnessEndpoint) {
      const f = ps.roughnessEndpoint * Math.pow(t, Math.max(0.01, ps.roughnessEndShape) * 4) * 0.5;
      p[0] += endRand[0] * f; p[1] += endRand[1] * f; p[2] += endRand[2] * f;
    }
    if (ps.roughness2 && affected2) {
      const f = ps.roughness2 * Math.pow(t, Math.max(0.01, ps.roughness2Size)) * 0.5;
      p[0] += rand2[0] * f; p[1] += rand2[1] * f; p[2] += rand2[2] * f;
    }
    out.push(p);
  }
  void root;
  return out;
}

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale3 = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: Vec3): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** World matrix helper for drawing at the current frame (no simulation override issues for emitters). */
export function emitterWorld(ob: BObject): Matrix4 {
  return atFrame(app.scene.frameCurrent, () => app.matrices.world(ob)).clone();
}
