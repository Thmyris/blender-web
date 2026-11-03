// Force fields ("effectors"): objects with field settings push particles, cloth and
// soft bodies around. Each simulation scales the fields by its Field Weights.

import { Vector3, type Matrix4 } from 'three';
import { app } from '../app';
import type { MatrixCache } from '../core/scene';
import type { BObject } from '../core/types';
import { defaultField, type EffectorWeights, type FieldSettings, type FieldType } from './types';

export interface Effector {
  ob: BObject;
  field: FieldSettings;
  pos: Vector3;
  /** Unit Z axis of the effector object (wind direction, vortex axis, plane normal). */
  z: Vector3;
  world: Matrix4;
}

export function fieldOf(ob: BObject): FieldSettings | null {
  const f = ob.field;
  if (!f || f.type === 'NONE') return null;
  return { ...defaultField(f.type), ...f };
}

export function collectEffectors(mats: MatrixCache, exclude?: string): Effector[] {
  const out: Effector[] = [];
  for (const ob of app.objects()) {
    if (ob.id === exclude) continue;
    const field = fieldOf(ob);
    if (!field) continue;
    const world = mats.world(ob);
    const e = world.elements;
    const z = new Vector3(e[8], e[9], e[10]).normalize();
    out.push({ ob, field, pos: new Vector3(e[12], e[13], e[14]), z, world });
  }
  return out;
}

const WEIGHT_KEY: Partial<Record<FieldType, keyof EffectorWeights>> = {
  FORCE: 'force', WIND: 'wind', VORTEX: 'vortex', MAGNET: 'magnetic', HARMONIC: 'harmonic', CHARGE: 'charge',
  LENNARDJ: 'lennardjones', TURBULENCE: 'turbulence', DRAG: 'drag', TEXTURE: 'texture', GUIDE: 'curveGuide', BOID: 'boid', SMOKE_FLOW: 'smokeflow',
};

// ------------------------------------------------------------------ noise

function hash3(x: number, y: number, z: number, s: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647 + s * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function valueNoise(x: number, y: number, z: number, s: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  const n = (dx: number, dy: number, dz: number) => hash3(xi + dx, yi + dy, zi + dz, s);
  return l(l(l(n(0, 0, 0), n(1, 0, 0), u), l(n(0, 1, 0), n(1, 1, 0), u), v), l(l(n(0, 0, 1), n(1, 0, 1), u), l(n(0, 1, 1), n(1, 1, 1), u), v), w) * 2 - 1;
}

/** Smooth 3D vector noise in [-1, 1]. */
export function vecNoise(x: number, y: number, z: number, seed: number, out: number[]): void {
  out[0] = valueNoise(x, y, z, seed) + 0.5 * valueNoise(x * 2.03, y * 2.03, z * 2.03, seed + 7);
  out[1] = valueNoise(x + 31.4, y - 12.7, z + 5.1, seed + 13) + 0.5 * valueNoise(x * 2.03 + 3, y * 2.03, z * 2.03, seed + 17);
  out[2] = valueNoise(x - 17.2, y + 8.3, z - 27.9, seed + 23) + 0.5 * valueNoise(x * 2.03, y * 2.03 + 3, z * 2.03, seed + 29);
}

// ------------------------------------------------------------------ evaluation

const nz = [0, 0, 0];

/**
 * Accumulate the acceleration of all effectors on a point with velocity v into `out`.
 * `time` is in seconds (used for noise and turbulence animation).
 */
export function effectorAccel(effs: Effector[], weights: EffectorWeights, px: number, py: number, pz: number, vx: number, vy: number, vz: number, time: number, out: number[]): void {
  for (const ef of effs) {
    const f = ef.field;
    const wkey = WEIGHT_KEY[f.type];
    const weight = weights.all * (wkey ? weights[wkey] : 1);
    if (weight === 0) continue;
    const dx = px - ef.pos.x, dy = py - ef.pos.y, dz = pz - ef.pos.z;
    const along = dx * ef.z.x + dy * ef.z.y + dz * ef.z.z;
    if (f.zDirection === 'POSITIVE' && along < 0) continue;
    if (f.zDirection === 'NEGATIVE' && along > 0) continue;
    // distance and direction used by the falloff
    let dist: number;
    let rx = dx, ry = dy, rz = dz;
    if (f.shape === 'PLANE') {
      dist = Math.abs(along);
      rx = ef.z.x * Math.sign(along || 1); ry = ef.z.y * Math.sign(along || 1); rz = ef.z.z * Math.sign(along || 1);
    } else {
      dist = Math.hypot(dx, dy, dz);
      if (dist > 1e-9) { rx = dx / dist; ry = dy / dist; rz = dz / dist; } else { rx = 0; ry = 0; rz = 0; }
    }
    let fdist = dist;
    if (f.falloffType === 'TUBE') {
      const radial = Math.hypot(dx - along * ef.z.x, dy - along * ef.z.y, dz - along * ef.z.z);
      if (f.useRadialMax && radial > f.radialMax) continue;
      if (f.useRadialMin && radial < f.radialMin) { /* full strength */ }
      fdist = Math.abs(along);
    } else if (f.falloffType === 'CONE') {
      const ang = Math.acos(Math.min(1, Math.abs(along) / Math.max(dist, 1e-9)));
      if (f.useRadialMax && ang > f.radialMax) continue;
    }
    if (f.useMaxDistance && fdist > f.distanceMax) continue;
    let fac = 1;
    if (f.falloffPower > 0) {
      const eff = f.useMinDistance ? Math.max(0, fdist - f.distanceMin) : fdist;
      fac = Math.min(100, 1 / Math.pow(Math.max(eff, 0.05), f.falloffPower));
      if (f.useMinDistance && fdist < f.distanceMin) fac = 1 / Math.pow(Math.max(f.distanceMin, 0.05), 0);
    }
    if (f.falloffType === 'TUBE' && f.radialFalloff > 0) {
      const radial = Math.hypot(dx - along * ef.z.x, dy - along * ef.z.y, dz - along * ef.z.z);
      fac *= 1 / Math.pow(Math.max(radial, 0.05), f.radialFalloff);
    }
    const s = f.strength * fac * weight;
    let ax = 0, ay = 0, az = 0;
    switch (f.type) {
      case 'FORCE':
      case 'CHARGE':
        ax = rx * s; ay = ry * s; az = rz * s;
        break;
      case 'WIND':
        ax = ef.z.x * s; ay = ef.z.y * s; az = ef.z.z * s;
        break;
      case 'VORTEX': {
        // spin around the effector Z axis
        const cx = ef.z.y * dz - ef.z.z * dy, cy = ef.z.z * dx - ef.z.x * dz, cz = ef.z.x * dy - ef.z.y * dx;
        const cl = Math.hypot(cx, cy, cz) || 1;
        ax = (cx / cl) * s; ay = (cy / cl) * s; az = (cz / cl) * s;
        if (f.inflow) {
          const radx = dx - along * ef.z.x, rady = dy - along * ef.z.y, radz = dz - along * ef.z.z;
          const rl = Math.hypot(radx, rady, radz) || 1;
          ax -= (radx / rl) * f.inflow * fac * weight; ay -= (rady / rl) * f.inflow * fac * weight; az -= (radz / rl) * f.inflow * fac * weight;
        }
        break;
      }
      case 'MAGNET': {
        // Lorentz-like: perpendicular to the velocity and the field axis
        ax = (vy * ef.z.z - vz * ef.z.y) * s; ay = (vz * ef.z.x - vx * ef.z.z) * s; az = (vx * ef.z.y - vy * ef.z.x) * s;
        break;
      }
      case 'HARMONIC': {
        const k = f.strength * weight;
        let tx = dx, ty = dy, tz = dz;
        if (f.restLength > 0 && dist > 1e-9) { const r = (dist - f.restLength) / dist; tx = dx * r; ty = dy * r; tz = dz * r; }
        ax = -k * tx - f.harmonicDamping * vx; ay = -k * ty - f.harmonicDamping * vy; az = -k * tz - f.harmonicDamping * vz;
        break;
      }
      case 'TURBULENCE': {
        const sz = Math.max(1e-3, f.size);
        let qx = px, qy = py, qz = pz;
        if (!f.useGlobalCoords) { qx = dx; qy = dy; qz = dz; }
        vecNoise(qx / sz, qy / sz, qz / sz + time * 0.5, f.seed, nz);
        ax = nz[0] * s; ay = nz[1] * s; az = nz[2] * s;
        if (f.flow) { ax -= vx * f.flow; ay -= vy * f.flow; az -= vz * f.flow; }
        break;
      }
      case 'DRAG': {
        const speed = Math.hypot(vx, vy, vz);
        const k = (f.linearDrag + f.quadraticDrag * speed) * fac * weight * Math.max(0, f.strength);
        ax = -vx * k; ay = -vy * k; az = -vz * k;
        break;
      }
      default:
        continue;
    }
    if (f.flow && (f.type === 'FORCE' || f.type === 'WIND' || f.type === 'VORTEX')) {
      // effector as an air flow: drag the velocity towards the force
      ax += (ax - vx) * f.flow; ay += (ay - vy) * f.flow; az += (az - vz) * f.flow;
    }
    if (f.noise) {
      vecNoise(px * 0.7 + time * 3.1, py * 0.7 - time * 2.3, pz * 0.7 + time * 1.7, f.seed + 101, nz);
      const amp = f.noise * Math.max(Math.abs(s), 1) * weight;
      ax += nz[0] * amp; ay += nz[1] * amp; az += nz[2] * amp;
    }
    out[0] += ax; out[1] += ay; out[2] += az;
  }
}

/** Wind velocity at a point (for aerodynamic cloth forces): the sum of wind fields. */
export function windAt(effs: Effector[], weights: EffectorWeights, px: number, py: number, pz: number, time: number, out: number[]): boolean {
  let any = false;
  out[0] = out[1] = out[2] = 0;
  for (const ef of effs) {
    if (ef.field.type !== 'WIND') continue;
    any = true;
    const one = [0, 0, 0];
    effectorAccel([ef], weights, px, py, pz, 0, 0, 0, time, one);
    out[0] += one[0]; out[1] += one[1]; out[2] += one[2];
  }
  return any;
}

/** Signature of all effectors (part of simulation cache signatures). */
export function effectorSignature(): string {
  return JSON.stringify(app.objects().filter((o) => o.field && o.field.type !== 'NONE').map((o) => [o.id, o.field]));
}
