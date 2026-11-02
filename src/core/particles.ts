// Particle systems (Emitter type). Positions are computed in closed form for any
// frame, so scrubbing and rendering are deterministic without a simulation cache:
// each particle is born at an evenly spaced frame between Start and End from a
// random point of the emitter, and then moves ballistically under gravity.

import { Matrix3, Matrix4, Vector3 } from 'three';
import type { BObject, ParticleSystem, Vec3 } from './types';
import type { EvalMesh } from './modifiers';
import { polyArea, polyNormal, triangulatePoly } from './mesh';

export function newParticleSystem(existing: ParticleSystem[]): ParticleSystem {
  const names = new Set(existing.map((p) => p.name));
  let name = 'ParticleSystem';
  for (let i = 1; names.has(name); i++) name = `ParticleSystem.${String(i).padStart(3, '0')}`;
  return {
    name, count: 1000, frameStart: 1, frameEnd: 200, lifetime: 50, normalFactor: 1, randomFactor: 0,
    objectAlignFactor: [0, 0, 0], gravity: 1, size: 0.05, seed: 0, emitFrom: 'FACE', showViewport: true, showRender: true,
    displayPercentage: 100,
  };
}

/** Small deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = (seed * 2654435761) >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface EmitSample { p: Vec3; n: Vec3; dir: Vec3 }
const sampleCache = new WeakMap<EvalMesh, Map<string, EmitSample[]>>();

/** Emission points in object space (cached per evaluated mesh and settings). */
function emissionSamples(m: EvalMesh, ps: ParticleSystem): EmitSample[] {
  const key = `${ps.count}|${ps.seed}|${ps.emitFrom}`;
  let byKey = sampleCache.get(m);
  if (!byKey) { byKey = new Map(); sampleCache.set(m, byKey); }
  const hit = byKey.get(key);
  if (hit) return hit;
  const rand = rng(ps.seed + 1);
  const out: EmitSample[] = [];
  const randomDir = (): Vec3 => {
    const z = rand() * 2 - 1, a = rand() * Math.PI * 2, r = Math.sqrt(1 - z * z);
    return [r * Math.cos(a), r * Math.sin(a), z];
  };
  if (ps.emitFrom === 'VERT' || !m.faces.length) {
    if (!m.verts.length) return out;
    // vertex normals
    const vn: Vec3[] = m.verts.map(() => [0, 0, 0]);
    for (const f of m.faces) { const n = polyNormal(m.verts, f); for (const v of f) { vn[v][0] += n[0]; vn[v][1] += n[1]; vn[v][2] += n[2]; } }
    for (let i = 0; i < ps.count; i++) {
      const v = i % m.verts.length;
      const n = vn[v];
      const l = Math.hypot(n[0], n[1], n[2]) || 1;
      out.push({ p: m.verts[v], n: [n[0] / l, n[1] / l, (n[2] || (l === 1 ? 1 : 0)) / l], dir: randomDir() });
    }
  } else {
    // area-weighted triangles
    const tris: { a: Vec3; b: Vec3; c: Vec3; n: Vec3; area: number }[] = [];
    for (const f of m.faces) {
      const n = polyNormal(m.verts, f);
      for (const t of triangulatePoly(m.verts, f)) {
        const a = m.verts[f[t[0]]], b = m.verts[f[t[1]]], c = m.verts[f[t[2]]];
        tris.push({ a, b, c, n, area: polyArea(m.verts, [f[t[0]], f[t[1]], f[t[2]]]) });
      }
    }
    const cdf: number[] = [];
    let total = 0;
    for (const t of tris) { total += t.area; cdf.push(total); }
    for (let i = 0; i < ps.count; i++) {
      const r = rand() * total;
      let lo = 0, hi = cdf.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid] < r) lo = mid + 1; else hi = mid; }
      const t = tris[lo];
      let u = rand(), v = rand();
      if (u + v > 1) { u = 1 - u; v = 1 - v; }
      const w = 1 - u - v;
      const p: Vec3 = [t.a[0] * w + t.b[0] * u + t.c[0] * v, t.a[1] * w + t.b[1] * u + t.c[1] * v, t.a[2] * w + t.b[2] * u + t.c[2] * v];
      out.push({ p, n: t.n, dir: randomDir() });
    }
  }
  byKey.set(key, out);
  return out;
}

/**
 * World-space positions of the particles alive at `frame`.
 * `gravity` is the scene gravity (already multiplied by the "use gravity" flag).
 */
export function particlePositions(ob: BObject, ps: ParticleSystem, m: EvalMesh, world: Matrix4, frame: number, fps: number, gravity: Vec3, displayFraction = 1): Float32Array {
  const samples = emissionSamples(m, ps);
  const nmat = new Matrix3().getNormalMatrix(world);
  const out: number[] = [];
  const span = Math.max(0, ps.frameEnd - ps.frameStart);
  const shown = Math.max(0, Math.min(samples.length, Math.round(samples.length * displayFraction)));
  const g = new Vector3(...gravity).multiplyScalar(ps.gravity);
  const p0 = new Vector3(), n = new Vector3(), v = new Vector3();
  for (let i = 0; i < shown; i++) {
    const birth = ps.frameStart + (samples.length > 1 ? (span * i) / samples.length : 0);
    const age = frame - birth;
    if (age < 0 || age > ps.lifetime) continue;
    const s = samples[i];
    p0.set(s.p[0], s.p[1], s.p[2]).applyMatrix4(world);
    n.set(s.n[0], s.n[1], s.n[2]).applyMatrix3(nmat).normalize();
    v.copy(n).multiplyScalar(ps.normalFactor).add(new Vector3(...s.dir).multiplyScalar(ps.randomFactor));
    const t = age / Math.max(1, fps);
    out.push(p0.x + v.x * t + 0.5 * g.x * t * t, p0.y + v.y * t + 0.5 * g.y * t * t, p0.z + v.z * t + 0.5 * g.z * t * t);
  }
  void ob;
  return new Float32Array(out);
}
