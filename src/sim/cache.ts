// Point caches: every simulation (rigid body world, cloth, soft body, particles)
// steps forward frame by frame from its cache start frame and keeps each frame's
// state in memory, so scrubbing backwards shows cached frames. The cache is reset
// when the start frame is evaluated or when the simulation settings change, unless
// it is baked. Nothing here is stored in the document.

import { app } from '../app';
import { MatrixCache } from '../core/scene';
import { renderProgress } from '../render/render';
import type { BObject, Scene } from '../core/types';
import type { PointCacheSettings } from './types';

export type CacheKind = 'RIGIDBODY' | 'CLOTH' | 'SOFTBODY' | 'PARTICLES';

export interface SimDriver<S> {
  key: string;
  kind: CacheKind;
  /** Owner object (none for the rigid body world). */
  obId: string | null;
  label: string;
  cache: PointCache<S>;
  settings(): PointCacheSettings;
  /** Settings signature: the cache is reset when it changes (unless baked). */
  signature(): string;
  /** Initial state at the cache start frame, from the current document. */
  init(mats: MatrixCache, frame: number): S;
  /** Advance the live state by one frame (to `frame`) and return a snapshot. */
  step(mats: MatrixCache, frame: number): S;
  /** Make the live state equal to a cached snapshot. */
  restore(state: S, frame: number): void;
  bytes(state: S): number;
  /** Still valid (its object / settings exist)? */
  alive(): boolean;
}

export class PointCache<S> {
  states = new Map<number, S>();
  /** First and last computed frame (contiguous). */
  first = 0;
  last = -Infinity;
  baked = false;
  sig: string | null = null;
  version = 0;
  /** Changes when the cache is reset, baked or freed (not when it grows). */
  epoch = 0;
  bytes = 0;
  /** Frame of the driver's live state. */
  liveFrame = -Infinity;

  clear(): void {
    if (!this.states.size && this.last === -Infinity) return;
    this.states.clear();
    this.last = -Infinity;
    this.bytes = 0;
    this.liveFrame = -Infinity;
    this.version++;
    this.epoch++;
    simVersion++;
  }

  get size(): number { return this.states.size; }
}

/** Bumped whenever any cache changes (used for redraw keys). */
export let simVersion = 0;

// ------------------------------------------------------------------ driver registry

/** Providers list the simulation drivers of a scene (registered by each simulation module). */
export const simProviders: ((scene: Scene) => SimDriver<unknown>[])[] = [];

export function allDrivers(scene: Scene = app.scene): SimDriver<unknown>[] {
  const out: SimDriver<unknown>[] = [];
  for (const p of simProviders) out.push(...p(scene));
  return out;
}

/** Drivers that belong to an object (for the Timeline cache lines and per-object operators). */
export function objectDrivers(ob: BObject): SimDriver<unknown>[] {
  return allDrivers().filter((d) => d.obId === ob.id);
}

// ------------------------------------------------------------------ evaluation at other frames

let insideAtFrame = 0;

/**
 * Run `fn` with the animation system evaluated at `frame` (for simulation inputs such as
 * animated colliders, kinematic rigid bodies or moving emitters). The document is restored
 * afterwards. `fn` gets a matrix cache that ignores simulation overrides.
 */
export function atFrame<T>(frame: number, fn: (mats: MatrixCache) => T): T {
  const sc = app.scene;
  const cur = sc.frameCurrent;
  const mats = new MatrixCache(app.doc);
  mats.noOverrides = true;
  if (frame === cur || insideAtFrame) return fn(mats);
  const animated = Object.values(app.doc.objects).filter((o) => o.fcurves?.length || o.animData);
  if (!animated.length) return fn(mats);
  const snap = animated.map((o) => JSON.stringify([o.location, o.rotation, o.scale, o.deltaLocation, o.deltaRotation, o.deltaScale, o.hide, o.hideRender]));
  insideAtFrame++;
  sc.frameCurrent = frame;
  try {
    app.evaluateAnimation();
    return fn(mats);
  } finally {
    sc.frameCurrent = cur;
    animated.forEach((o, i) => {
      const [l, r, s, dl, dr, ds, h, hr] = JSON.parse(snap[i]) as [BObject['location'], BObject['rotation'], BObject['scale'], BObject['location'], BObject['rotation'], BObject['scale'], boolean, boolean];
      o.location = l; o.rotation = r; o.scale = s; o.deltaLocation = dl; o.deltaRotation = dr; o.deltaScale = ds; o.hide = h; o.hideRender = hr;
    });
    insideAtFrame--;
  }
}

// ------------------------------------------------------------------ stepping

/** The cache was reset because the start frame was evaluated. */
export function resetAtStart<S>(d: SimDriver<S>): void {
  if (!d.cache.baked) d.cache.clear();
}

function checkSignature<S>(d: SimDriver<S>): void {
  const sig = d.signature();
  const c = d.cache;
  if (c.sig === null) { c.sig = sig; return; }
  if (sig !== c.sig) {
    c.sig = sig;
    if (!c.baked) c.clear();
  }
}

let fullEval = 0;
/** Run `fn` with simulations computed completely (no interactive time budget). */
export function withFullEvaluation<T>(fn: () => T): T {
  fullEval++;
  try { return fn(); } finally { fullEval--; }
}

let continuePending = false;
/** Catching up was interrupted by the time budget: continue on the next tick. */
function scheduleContinue(): void {
  if (continuePending) return;
  continuePending = true;
  setTimeout(() => { continuePending = false; app.notify('frame', 'scene'); }, 0);
}

/** Interactive time budget for catching up a simulation (renders and bakes compute fully). */
function budgetMs(): number {
  return fullEval || baking || renderProgress !== null ? Infinity : 120;
}

/**
 * State at `frame` (> cache start). Computes missing frames forward from the last cached
 * frame. Returns null when the frame can't be produced (baked cache without that frame).
 * In the interactive viewport, long catch-ups are spread over several redraws (the latest
 * computed frame is returned meanwhile).
 */
export function evaluateSim<S>(d: SimDriver<S>, frame: number): S | null {
  checkSignature(d);
  const c = d.cache;
  const s = d.settings();
  const start = s.frameStart;
  const target = Math.min(Math.round(frame), s.frameEnd);
  if (target <= start) {
    resetAtStart(d);
    if (c.states.has(start)) return c.states.get(start)!;
    const st = atFrame(start, (m) => d.init(m, start));
    c.states.set(start, st); c.first = start; c.last = start; c.liveFrame = start; c.bytes += d.bytes(st);
    c.version++; simVersion++;
    return st;
  }
  const hit = c.states.get(target);
  if (hit !== undefined) return hit;
  if (c.baked) {
    // baked caches are not extended: show the closest earlier frame
    let best: S | null = null;
    for (let f = target; f >= start; f--) { const st = c.states.get(f); if (st !== undefined) { best = st; break; } }
    return best;
  }
  if (c.last < start || !c.states.has(c.last)) {
    c.clear();
    const st = atFrame(start, (m) => d.init(m, start));
    c.states.set(start, st); c.first = start; c.last = start; c.liveFrame = start; c.bytes += d.bytes(st);
  } else if (c.liveFrame !== c.last) {
    d.restore(c.states.get(c.last)!, c.last);
    c.liveFrame = c.last;
  }
  const budget = budgetMs();
  const t0 = performance.now();
  for (let f = c.last + 1; f <= target; f++) {
    const st = atFrame(f, (m) => d.step(m, f));
    c.states.set(f, st);
    c.last = f;
    c.liveFrame = f;
    c.bytes += d.bytes(st);
    if (f < target && performance.now() - t0 > budget) {
      c.version++;
      simVersion++;
      scheduleContinue();
      return st;
    }
  }
  c.version++;
  simVersion++;
  return c.states.get(target) ?? null;
}

/** Info text of a cache ("250 frames in memory (1.2 MB)"). */
export function cacheInfo<S>(d: SimDriver<S>): string {
  const c = d.cache;
  const n = c.states.size;
  const mb = (c.bytes / (1024 * 1024)).toFixed(n && c.bytes < 1024 * 1024 ? 2 : 1);
  if (c.baked) return `${n} frames in memory (${mb} MB), baked`;
  if (!n) return '0 frames in memory (0.0 MB)';
  return `${n} frames in memory (${mb} MB)`;
}

// ------------------------------------------------------------------ baking

let baking = false;
let bakeCancel = false;
export let bakeProgress: string | null = null;
export const bakeListeners = new Set<() => void>();

export function isBaking(): boolean { return baking; }
export function cancelBake(): void { bakeCancel = true; }

function setBakeProgress(s: string | null): void {
  bakeProgress = s;
  for (const l of bakeListeners) l();
  app.notify('reports');
}

/**
 * Simulate the whole cache range of the given drivers now (with progress in the Info header).
 * `bake` marks the caches as baked (protected from resets); otherwise it only calculates to the
 * current frame ("Calculate To Frame" / "Update All To Frame").
 */
export async function bakeDrivers(drivers: SimDriver<unknown>[], bake: boolean): Promise<boolean> {
  if (baking || !drivers.length) return false;
  baking = true;
  bakeCancel = false;
  const t0 = performance.now();
  try {
    for (const d of drivers) if (bake && d.cache.baked) { d.cache.baked = false; d.cache.clear(); }
    const ranges = drivers.map((d) => { const s = d.settings(); return { d, start: s.frameStart, end: bake ? s.frameEnd : Math.min(s.frameEnd, app.scene.frameCurrent) }; });
    const total = ranges.reduce((a, r) => a + Math.max(0, r.end - r.start), 0) || 1;
    let done = 0;
    let lastYield = performance.now();
    for (const r of ranges) {
      // evaluate the start frame (resets an unbaked cache)
      evaluateSim(r.d, r.start);
      for (let f = r.start + 1; f <= r.end; f++) {
        if (bakeCancel) break;
        evaluateSim(r.d, f);
        done++;
        if (performance.now() - lastYield > 40) {
          setBakeProgress(`Baking ${Math.round((done / total) * 100)}%  (${r.d.label}, frame ${f})  —  Esc to cancel`);
          await new Promise((res) => setTimeout(res, 0));
          lastYield = performance.now();
        }
      }
      if (bakeCancel) break;
      if (bake) r.d.cache.baked = true;
      r.d.cache.version++;
      r.d.cache.epoch++;
    }
    simVersion++;
    const secs = ((performance.now() - t0) / 1000).toFixed(2);
    if (bakeCancel) app.report('WARNING', 'Baking cancelled');
    else app.report('INFO', bake ? `Baked ${drivers.length > 1 ? `${drivers.length} caches` : drivers[0].label} in ${secs} s` : `Calculated to frame in ${secs} s`);
    return !bakeCancel;
  } finally {
    baking = false;
    setBakeProgress(null);
    app.tagAllGeometry();
    app.notify('frame', 'scene', 'data');
  }
}

export function freeBake(drivers: SimDriver<unknown>[]): void {
  for (const d of drivers) {
    d.cache.baked = false;
    d.cache.clear();
    d.cache.epoch++;
  }
  simVersion++;
  app.tagAllGeometry();
  app.notify('frame', 'scene', 'data');
}

// ------------------------------------------------------------------ timeline display

export interface CacheLine {
  kind: CacheKind;
  start: number;
  end: number;
  frames: number[];
  baked: boolean;
}

/** Cache lines drawn at the bottom of the Timeline: the active object's caches and the rigid body world. */
export function timelineCacheLines(): CacheLine[] {
  const out: CacheLine[] = [];
  const act = app.activeObject;
  for (const d of allDrivers()) {
    if (d.obId !== null && d.obId !== act?.id) continue;
    if (!d.alive()) continue;
    const s = d.settings();
    out.push({ kind: d.kind, start: s.frameStart, end: s.frameEnd, frames: [...d.cache.states.keys()], baked: d.cache.baked });
  }
  return out;
}

const CACHE_COLORS: Record<CacheKind, [number, number, number]> = {
  RIGIDBODY: [255, 153, 0],
  CLOTH: [26, 26, 191],
  SOFTBODY: [255, 102, 5],
  PARTICLES: [255, 26, 5],
};

/** Draw the cache lines into a Timeline canvas (called by the Timeline editor). */
export function drawTimelineCaches(ctx: CanvasRenderingContext2D, frameToX: (f: number) => number, height: number, bottomMargin = 18): void {
  const lines = timelineCacheLines();
  if (!lines.length) return;
  const h = 6;
  let y = height - bottomMargin - 2 - h;
  for (const l of lines) {
    const [r, g, b] = CACHE_COLORS[l.kind];
    const x0 = frameToX(l.start), x1 = frameToX(l.end + 1);
    ctx.fillStyle = `rgba(${r},${g},${b},0.15)`;
    ctx.fillRect(x0, y, x1 - x0, h);
    ctx.fillStyle = l.baked ? `rgba(${r},${g},${b},1)` : `rgba(${r},${g},${b},0.6)`;
    // contiguous runs
    const frames = l.frames.sort((a, b2) => a - b2);
    let i = 0;
    while (i < frames.length) {
      let j = i;
      while (j + 1 < frames.length && frames[j + 1] === frames[j] + 1) j++;
      const a = frameToX(frames[i]), bb = frameToX(frames[j] + 1);
      ctx.fillRect(a, y, Math.max(1, bb - a), h);
      i = j + 1;
    }
    y -= h + 1;
  }
}
