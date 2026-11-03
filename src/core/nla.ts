// Actions (reusable named sets of F-Curves) and the NLA: action datablocks are kept in sync with the
// objects' `fcurves` (the F-Curves of the active action), and NLA tracks are evaluated bottom to top
// with the active action blended on top.

import type { BObject, Doc, FCurve } from './types';
import type { ActionData, AnimData, NlaBlend, NlaStrip, NlaTrack } from './edtypes';
import { evaluateFCurve, getPropValue, setPropValue } from './anim';
import { newId, uniqueName } from './scene';

// ------------------------------------------------------------------ actions

/** F-Curve arrays known to be shared between an action and its users (not in the JSON document). */
const linked = new WeakSet<FCurve[]>();

export function actionsOf(doc: Doc): Record<string, ActionData> { return (doc.actions ??= {}); }

export function newAction(doc: Doc, name: string, fcurves: FCurve[] = []): ActionData {
  const acts = actionsOf(doc);
  const act: ActionData = { id: newId(doc, 'AC'), name: uniqueName([], name, undefined, Object.values(acts)), fcurves, fakeUser: false };
  acts[act.id] = act;
  linked.add(fcurves);
  return act;
}

/** Make `act` the active action of `ob` (its F-Curves become the object's F-Curves). */
export function assignAction(doc: Doc, ob: BObject, act: ActionData | null): void {
  if (!act) { ob.action = null; ob.fcurves = []; return; }
  ob.action = act.id;
  ob.fcurves = act.fcurves;
  linked.add(act.fcurves);
  void doc;
}

export function actionRange(act: ActionData | null | undefined): [number, number] {
  let a = Infinity, b = -Infinity;
  for (const fc of act?.fcurves ?? []) for (const k of fc.keys) { a = Math.min(a, k.frame); b = Math.max(b, k.frame); }
  if (!Number.isFinite(a)) return [1, 2];
  if (b - a < 1) b = a + 1;
  return [a, b];
}

/** Number of users of an action (objects using it as active action, NLA strips, fake user). */
export function actionUsers(doc: Doc, id: string): number {
  let n = 0;
  for (const ob of Object.values(doc.objects)) {
    if (ob.action === id) n++;
    for (const t of ob.animData?.nlaTracks ?? []) for (const s of t.strips) if (s.action === id) n++;
    if (ob.animData?.tweak?.prevAction === id) n++;
  }
  if (doc.actions?.[id]?.fakeUser) n++;
  return n;
}

/**
 * Keep actions and objects consistent: objects with keyframes but no action get one ("<Object>Action"),
 * the users of an action share its F-Curve array, edits that replaced an object's array are written
 * back to the action, and duplicated objects get their own copy of the action.
 */
export function syncActions(doc: Doc): void {
  const acts = actionsOf(doc);
  const users = new Map<string, BObject[]>();
  for (const ob of Object.values(doc.objects)) {
    if (ob.action && !acts[ob.action]) ob.action = null;
    if (!ob.action) {
      if (ob.fcurves.length) { const a = newAction(doc, `${ob.name}Action`, ob.fcurves); ob.action = a.id; }
      else continue;
    }
    const list = users.get(ob.action!) ?? [];
    list.push(ob);
    users.set(ob.action!, list);
  }
  for (const [id, us] of users) {
    const act = acts[id];
    if (!linked.has(act.fcurves)) {
      // after loading or undo: the arrays are equal copies (or one user was edited since)
      const ref = JSON.stringify(act.fcurves);
      const src = us.find((u) => JSON.stringify(u.fcurves) !== ref)?.fcurves ?? us[0].fcurves;
      act.fcurves = src;
      linked.add(src);
      for (const u of us) u.fcurves = src;
      continue;
    }
    for (const u of us) {
      if (u.fcurves === act.fcurves) continue;
      if (linked.has(u.fcurves)) { u.fcurves = act.fcurves; continue; }
      const shares = u.fcurves.some((fc) => act.fcurves.includes(fc));
      const otherUser = us.some((v) => v !== u && v.fcurves === act.fcurves);
      if (!shares && otherUser && u.fcurves.length) {
        // a duplicated object: give it its own copy of the action
        const copy = newAction(doc, act.name, u.fcurves);
        u.action = copy.id;
        continue;
      }
      // the object's array was replaced (keys deleted / cleared): write it back to the action
      act.fcurves = u.fcurves;
      linked.add(u.fcurves);
      for (const v of us) if (v.action === id) v.fcurves = u.fcurves;
    }
  }
}

// ------------------------------------------------------------------ NLA data

export function ensureAnimData(ob: BObject): AnimData {
  ob.animData ??= { nlaTracks: [], useNla: true, actionBlendType: 'REPLACE', actionInfluence: 1, actionExtrapolation: 'HOLD', tweak: null };
  return ob.animData;
}

export function newTrack(ad: AnimData, index = ad.nlaTracks.length): NlaTrack {
  const names = new Set(ad.nlaTracks.map((t) => t.name));
  let name = 'NlaTrack';
  for (let i = 1; names.has(name); i++) name = `NlaTrack.${String(i).padStart(3, '0')}`;
  const t: NlaTrack = { name, strips: [], mute: false, isSolo: false, lock: false, select: false, active: false };
  ad.nlaTracks.splice(index, 0, t);
  return t;
}

export function newStrip(act: ActionData, start: number): NlaStrip {
  const [a, b] = actionRange(act);
  return {
    name: act.name, action: act.id, frameStart: start, frameEnd: start + (b - a), actionFrameStart: a, actionFrameEnd: b,
    scale: 1, repeat: 1, blendIn: 0, blendOut: 0, useAutoBlend: false, extrapolation: 'HOLD_FORWARD', blendType: 'REPLACE',
    influence: 1, useAnimatedInfluence: false, mute: false, useReverse: false, select: true, active: true, useSyncLength: false,
  };
}

/** Recompute the end frame from the action range, scale and repeat. */
export function updateStripEnd(s: NlaStrip): void {
  const len = Math.max(1e-3, s.actionFrameEnd - s.actionFrameStart);
  s.frameEnd = s.frameStart + len * Math.max(1e-4, Math.abs(s.scale)) * Math.max(1e-3, s.repeat);
}

/** Setting the end frame changes the scale (like Blender). */
export function setStripEnd(s: NlaStrip, end: number): void {
  const len = Math.max(1e-3, s.actionFrameEnd - s.actionFrameStart) * Math.max(1e-3, s.repeat);
  s.frameEnd = Math.max(s.frameStart + 1e-3, end);
  s.scale = (s.frameEnd - s.frameStart) / len;
}

export function trackHasRoom(t: NlaTrack, start: number, end: number, ignore?: NlaStrip): boolean {
  return !t.strips.some((s) => s !== ignore && s.frameStart < end - 1e-6 && s.frameEnd > start + 1e-6);
}

export function sortStrips(t: NlaTrack): void { t.strips.sort((a, b) => a.frameStart - b.frameStart); }

/** Fix extrapolation: only the first strip of a track may hold backwards (like Blender). */
export function validateTrack(t: NlaTrack): void {
  sortStrips(t);
  t.strips.forEach((s, i) => { if (i > 0 && s.extrapolation === 'HOLD') s.extrapolation = 'HOLD_FORWARD'; });
}

/** Push the active action down into a new strip (on a new track above the others if needed). */
export function pushDown(doc: Doc, ob: BObject): NlaStrip | null {
  const act = ob.action ? actionsOf(doc)[ob.action] : null;
  if (!act) return null;
  const ad = ensureAnimData(ob);
  if (ad.tweak) return null;
  const [a] = actionRange(act);
  const strip = newStrip(act, a);
  strip.blendType = ad.actionBlendType;
  strip.influence = ad.actionInfluence;
  if (ad.actionInfluence < 1) strip.useAnimatedInfluence = true;
  let track = ad.nlaTracks[ad.nlaTracks.length - 1];
  if (!track || track.lock || !trackHasRoom(track, strip.frameStart, strip.frameEnd)) track = newTrack(ad);
  strip.extrapolation = !ad.nlaTracks.some((t) => t.strips.length) ? 'HOLD' : 'HOLD_FORWARD';
  for (const t of ad.nlaTracks) { t.active = false; for (const s of t.strips) s.active = false; }
  track.strips.push(strip);
  track.active = true;
  validateTrack(track);
  ob.action = null;
  ob.fcurves = [];
  ad.actionBlendType = 'REPLACE';
  ad.actionInfluence = 1;
  return strip;
}

/** Tweak mode: edit the action of the active strip (Tab). */
export function enterTweak(doc: Doc, ob: BObject, track: number, strip: number): boolean {
  const ad = ob.animData;
  const s = ad?.nlaTracks[track]?.strips[strip];
  if (!ad || !s || !s.action || ad.tweak) return false;
  const act = actionsOf(doc)[s.action];
  if (!act) return false;
  ad.tweak = { track, strip, prevAction: ob.action ?? null };
  assignAction(doc, ob, act);
  return true;
}

export function exitTweak(doc: Doc, ob: BObject): boolean {
  const ad = ob.animData;
  if (!ad?.tweak) return false;
  const s = ad.nlaTracks[ad.tweak.track]?.strips[ad.tweak.strip];
  // sync the strip length with the edited action
  if (s && s.useSyncLength) { const [a, b] = actionRange(actionsOf(doc)[s.action ?? '']); s.actionFrameStart = a; s.actionFrameEnd = b; updateStripEnd(s); }
  const prev = ad.tweak.prevAction ? actionsOf(doc)[ad.tweak.prevAction] ?? null : null;
  ad.tweak = null;
  assignAction(doc, ob, prev);
  return true;
}

// ------------------------------------------------------------------ evaluation

/** Action time for a scene frame inside (or held by) a strip. */
export function stripTime(s: NlaStrip, frame: number): number {
  const len = Math.max(1e-3, s.actionFrameEnd - s.actionFrameStart);
  const scale = Math.max(1e-4, Math.abs(s.scale)) || 1;
  const f = Math.max(s.frameStart, Math.min(s.frameEnd, frame));
  let t = (f - s.frameStart) / scale;
  if (t >= len * s.repeat - 1e-6) t = len;
  else { t %= len; if (Math.abs(t) < 1e-9 && f > s.frameStart && s.repeat > 1 && frame >= s.frameEnd) t = len; }
  return s.useReverse ? s.actionFrameEnd - t : s.actionFrameStart + t;
}

/** The strip of a track that affects `frame`, its action time and influence. */
export function activeStrip(t: NlaTrack, frame: number): { strip: NlaStrip; time: number; influence: number } | null {
  const strips = t.strips.filter((s) => !s.mute);
  if (!strips.length) return null;
  let hit: NlaStrip | null = null;
  let held = false;
  for (const s of strips) if (frame >= s.frameStart && frame <= s.frameEnd) { hit = s; break; }
  if (!hit) {
    // extrapolation of the nearest strip before the frame
    let prev: NlaStrip | null = null;
    for (const s of strips) if (s.frameEnd < frame) prev = s;
    if (prev && prev.extrapolation !== 'NOTHING') { hit = prev; held = true; }
    else if (!prev && strips[0].extrapolation === 'HOLD' && frame < strips[0].frameStart) { hit = strips[0]; held = true; }
  }
  if (!hit) return null;
  let infl = hit.useAnimatedInfluence ? hit.influence : 1;
  if (!held) {
    const bi = hit.useAutoBlend ? 0 : hit.blendIn, bo = hit.useAutoBlend ? 0 : hit.blendOut;
    if (bi > 0 && frame < hit.frameStart + bi) infl *= Math.max(0, (frame - hit.frameStart) / bi);
    if (bo > 0 && frame > hit.frameEnd - bo) infl *= Math.max(0, (hit.frameEnd - frame) / bo);
  }
  return { strip: hit, time: stripTime(hit, frame), influence: infl };
}

function defaultValue(path: string, index: number): number {
  if (/scale/.test(path)) return 1;
  if (/rotation_quaternion|rotation_axis_angle/.test(path) && index === 0) return /quaternion/.test(path) ? 1 : 0;
  return 0;
}

function blend(prev: number, v: number, mode: NlaBlend, infl: number): number {
  switch (mode) {
    case 'ADD': return prev + v * infl;
    case 'SUBTRACT': return prev - v * infl;
    case 'MULTIPLY': return prev * (1 - infl + v * infl);
    default: return prev + (v - prev) * infl;
  }
}

/**
 * Evaluate an object's NLA stack (and its active action on top). Returns false when the object has no
 * NLA tracks, in which case the plain action evaluation applies.
 */
export function evaluateNla(doc: Doc, ob: BObject, frame: number): boolean {
  const ad = ob.animData;
  if (!ad || !ad.nlaTracks.length) return false;
  const chans = new Map<string, { path: string; index: number; value: number }>();
  const apply = (path: string, index: number, v: number, mode: NlaBlend, infl: number) => {
    const key = `${path}|${index}`;
    let c = chans.get(key);
    if (!c) { c = { path, index, value: defaultValue(path, index) }; chans.set(key, c); }
    c.value = blend(c.value, v, mode, infl);
  };
  const acts = actionsOf(doc);
  if (ad.useNla !== false) {
    const solo = ad.nlaTracks.some((t) => t.isSolo);
    const limit = ad.tweak ? ad.tweak.track : ad.nlaTracks.length;
    for (let ti = 0; ti < limit; ti++) {
      const tr = ad.nlaTracks[ti];
      if (tr.mute || (solo && !tr.isSolo)) continue;
      const hit = activeStrip(tr, frame);
      if (!hit || hit.influence <= 0) continue;
      const act = hit.strip.action ? acts[hit.strip.action] : null;
      if (!act) continue;
      for (const fc of act.fcurves) {
        if (fc.mute || !fc.keys.length) continue;
        apply(fc.path, fc.index, evaluateFCurve(fc, hit.time), hit.strip.blendType, hit.influence);
      }
    }
  }
  if (ob.fcurves.length) {
    let time = frame, mode = ad.actionBlendType, infl = ad.actionInfluence;
    const ts = ad.tweak ? ad.nlaTracks[ad.tweak.track]?.strips[ad.tweak.strip] : null;
    if (ts) { time = stripTime(ts, frame); mode = ts.blendType; infl = ts.useAnimatedInfluence ? ts.influence : 1; }
    for (const fc of ob.fcurves) {
      if (fc.mute || !fc.keys.length) continue;
      apply(fc.path, fc.index, evaluateFCurve(fc, time), mode, infl);
    }
  }
  for (const c of chans.values()) {
    if (getPropValue(ob, c.path, c.index) !== c.value) setPropValue(ob, c.path, c.index, c.value);
  }
  return true;
}

/** All strips of an object with their track index. */
export function allStrips(ob: BObject): { track: NlaTrack; ti: number; strip: NlaStrip; si: number }[] {
  const out: { track: NlaTrack; ti: number; strip: NlaStrip; si: number }[] = [];
  (ob.animData?.nlaTracks ?? []).forEach((track, ti) => track.strips.forEach((strip, si) => out.push({ track, ti, strip, si })));
  return out;
}
