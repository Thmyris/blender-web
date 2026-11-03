// Keyframe animation: F-Curve evaluation with Blender-like auto-clamped Bezier
// interpolation, keyframe insertion and property path resolution.

import type { BObject, FCurve, Interpolation, Keyframe } from './types';

/** Animatable object properties: path -> number of array components (0 for scalars). */
export const ANIMATABLE: Record<string, { size: number; label: string }> = {
  location: { size: 3, label: 'Location' },
  rotation_euler: { size: 3, label: 'Rotation' },
  scale: { size: 3, label: 'Scale' },
  delta_location: { size: 3, label: 'Delta Location' },
  delta_rotation_euler: { size: 3, label: 'Delta Rotation' },
  delta_scale: { size: 3, label: 'Delta Scale' },
  hide: { size: 0, label: 'Hide' },
  hide_render: { size: 0, label: 'Hide Render' },
};

const FIELD: Record<string, keyof BObject> = {
  location: 'location', rotation_euler: 'rotation', scale: 'scale',
  delta_location: 'deltaLocation', delta_rotation_euler: 'deltaRotation', delta_scale: 'deltaScale',
  hide: 'hide', hide_render: 'hideRender',
};

/**
 * Resolvers for property paths that are not plain object fields (e.g. pose bones:
 * `pose.bones["Bone"].location`). `get` returns undefined when the path is not handled.
 */
export interface PropResolver {
  get(ob: BObject, path: string, index: number): number | undefined;
  set(ob: BObject, path: string, index: number, value: number): boolean;
  /** Channel name for animation editors, e.g. "X Location (Bone)". */
  label?(path: string, index: number): string | undefined;
}
export const propResolvers: PropResolver[] = [];

/** Display name of an F-Curve channel. */
export function channelLabel(path: string, index: number): string {
  const info = ANIMATABLE[path];
  if (info) return info.size ? `${'XYZW'[index]} ${info.label}` : info.label;
  for (const r of propResolvers) { const l = r.label?.(path, index); if (l) return l; }
  return path;
}

export function getPropValue(ob: BObject, path: string, index: number): number {
  const f = FIELD[path];
  if (!f) {
    for (const r of propResolvers) { const v = r.get(ob, path, index); if (v !== undefined) return v; }
    return 0;
  }
  const v = ob[f] as unknown;
  if (Array.isArray(v)) return Number(v[index] ?? 0);
  return typeof v === 'boolean' ? (v ? 1 : 0) : Number(v);
}

export function setPropValue(ob: BObject, path: string, index: number, value: number): void {
  const f = FIELD[path];
  if (!f) { for (const r of propResolvers) if (r.set(ob, path, index, value)) return; return; }
  const cur = ob[f] as unknown;
  if (Array.isArray(cur)) (cur as number[])[index] = value;
  else if (typeof cur === 'boolean') (ob as unknown as Record<string, unknown>)[f] = value >= 0.5;
  else (ob as unknown as Record<string, unknown>)[f] = value;
}

export function findFCurve(ob: BObject, path: string, index: number): FCurve | undefined {
  return ob.fcurves.find((fc) => fc.path === path && fc.index === index);
}

export function sortKeys(fc: FCurve): void {
  fc.keys.sort((a, b) => a.frame - b.frame);
}

/** Insert (or replace) a keyframe. Returns true if a key was added or changed. */
export function insertKeyframe(ob: BObject, path: string, index: number, frame: number, value?: number, interpolation: Interpolation = 'BEZIER'): boolean {
  let fc = findFCurve(ob, path, index);
  if (!fc) {
    fc = { path, index, keys: [], select: true, mute: false };
    ob.fcurves.push(fc);
    // keep a stable ordering: by path then index
    const order = Object.keys(ANIMATABLE);
    ob.fcurves.sort((a, b) => order.indexOf(a.path) - order.indexOf(b.path) || a.index - b.index);
  }
  const v = value ?? getPropValue(ob, path, index);
  const isBool = ANIMATABLE[path]?.size === 0;
  const existing = fc.keys.find((k) => Math.abs(k.frame - frame) < 1e-4);
  if (existing) { existing.value = v; return true; }
  fc.keys.push({ frame, value: v, interpolation: isBool ? 'CONSTANT' : interpolation, select: true });
  sortKeys(fc);
  return true;
}

export function deleteKeyframe(ob: BObject, path: string, index: number, frame: number): boolean {
  const fc = findFCurve(ob, path, index);
  if (!fc) return false;
  const n = fc.keys.length;
  fc.keys = fc.keys.filter((k) => Math.abs(k.frame - frame) >= 1e-4);
  if (!fc.keys.length) ob.fcurves = ob.fcurves.filter((f) => f !== fc);
  return fc.keys.length !== n;
}

/** Auto-clamped handle slopes (Blender's default handle type). */
function autoSlopes(keys: Keyframe[]): number[] {
  const n = keys.length;
  const slopes = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (i === 0 || i === n - 1) { slopes[i] = 0; continue; }
    const p = keys[i - 1], c = keys[i], nx = keys[i + 1];
    // clamped: extremes get flat handles
    if ((c.value >= p.value && c.value >= nx.value) || (c.value <= p.value && c.value <= nx.value)) { slopes[i] = 0; continue; }
    slopes[i] = (nx.value - p.value) / (nx.frame - p.frame);
  }
  return slopes;
}

/** Evaluate an F-Curve at a (possibly fractional) frame. */
export function evaluateFCurve(fc: FCurve, frame: number): number {
  const keys = fc.keys;
  if (!keys.length) return 0;
  if (frame <= keys[0].frame) return keys[0].value;
  const last = keys[keys.length - 1];
  if (frame >= last.frame) return last.value;
  let i = 0;
  while (i < keys.length - 1 && keys[i + 1].frame < frame) i++;
  const a = keys[i], b = keys[i + 1];
  const span = b.frame - a.frame;
  if (span <= 0) return b.value;
  const t = (frame - a.frame) / span;
  switch (a.interpolation) {
    case 'CONSTANT': return a.value;
    case 'LINEAR': return a.value + (b.value - a.value) * t;
    default: {
      // Cubic Bezier with handles at 1/3 of the span (Hermite form, equivalent to Blender's
      // auto-clamped handles which are placed one third of the way to the neighbour key).
      const slopes = autoSlopes(keys);
      const m0 = slopes[i] * span, m1 = slopes[i + 1] * span;
      const t2 = t * t, t3 = t2 * t;
      return (2 * t3 - 3 * t2 + 1) * a.value + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * b.value + (t3 - t2) * m1;
    }
  }
}

/** Apply all F-Curves of an object for the given frame. */
export function evaluateObjectAnimation(ob: BObject, frame: number): boolean {
  let changed = false;
  for (const fc of ob.fcurves) {
    if (fc.mute || !fc.keys.length) continue;
    const v = evaluateFCurve(fc, frame);
    if (getPropValue(ob, fc.path, fc.index) !== v) { setPropValue(ob, fc.path, fc.index, v); changed = true; }
  }
  return changed;
}

export type KeyState = 'NONE' | 'ANIMATED' | 'KEYED';

/** State used to colour property fields: green when animated, yellow when keyed on this frame. */
export function keyState(ob: BObject, path: string, index: number, frame: number): KeyState {
  const fc = findFCurve(ob, path, index);
  if (!fc || !fc.keys.length) return 'NONE';
  return fc.keys.some((k) => Math.abs(k.frame - frame) < 1e-4) ? 'KEYED' : 'ANIMATED';
}

/** All key frames of an object (sorted unique). */
export function objectKeyFrames(ob: BObject): number[] {
  const set = new Set<number>();
  for (const fc of ob.fcurves) for (const k of fc.keys) set.add(Math.round(k.frame * 1000) / 1000);
  return [...set].sort((a, b) => a - b);
}

/** Keying sets offered by the "Insert Keyframe Menu" (I). */
export const KEYING_SETS: { id: string; label: string; paths: string[] }[] = [
  { id: 'Location', label: 'Location', paths: ['location'] },
  { id: 'Rotation', label: 'Rotation', paths: ['rotation_euler'] },
  { id: 'Scaling', label: 'Scaling', paths: ['scale'] },
  { id: 'BUILTIN_KSI_LocRot', label: 'LocRot', paths: ['location', 'rotation_euler'] },
  { id: 'LocScale', label: 'LocScale', paths: ['location', 'scale'] },
  { id: 'LocRotScale', label: 'LocRotScale', paths: ['location', 'rotation_euler', 'scale'] },
  { id: 'RotScale', label: 'RotScale', paths: ['rotation_euler', 'scale'] },
  { id: 'Delta Location', label: 'Delta Location', paths: ['delta_location'] },
  { id: 'Delta Rotation', label: 'Delta Rotation', paths: ['delta_rotation_euler'] },
  { id: 'Delta Scale', label: 'Delta Scale', paths: ['delta_scale'] },
  { id: 'Visual Location', label: 'Visual Location', paths: ['location'] },
  { id: 'Visual Rotation', label: 'Visual Rotation', paths: ['rotation_euler'] },
  { id: 'Visual Scaling', label: 'Visual Scaling', paths: ['scale'] },
  { id: 'Visual LocRot', label: 'Visual LocRot', paths: ['location', 'rotation_euler'] },
  { id: 'Visual LocRotScale', label: 'Visual LocRotScale', paths: ['location', 'rotation_euler', 'scale'] },
];
