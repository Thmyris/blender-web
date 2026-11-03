// Evaluated meshes of curve-like objects (CURVE, SURFACE, META): curve to mesh conversion with
// bevel / taper objects, NURBS surfaces, metaball families, then the object's modifier stack.
// This module does not import the app (it is imported by app.ts); callers pass the context.

import type { Matrix4 } from 'three';
import type { BObject, Doc, Modifier } from './types';
import type { CurveData, MetaBallData } from './curvetypes';
import { modifierDef, type EvalMesh } from './modifiers';
import { curveToMesh, sampleSpline, splineResolution, surfaceToMesh, type SampledSpline } from './curve';
import { polygonizeMeta, type PlacedElement } from './mball';

export interface CurveEvalContext {
  doc: Doc;
  render: boolean;
  frame: number;
  editMode: boolean;
  /** World matrix of an object (metaball families). */
  world: (ob: BObject) => Matrix4;
  /** A modal transform is running (metaball update modes). */
  transforming: boolean;
}

export function curveDataOf(doc: Doc, ob: BObject | null | undefined): CurveData | null {
  if (!ob || (ob.type !== 'CURVE' && ob.type !== 'SURFACE') || !ob.data) return null;
  return doc.curves?.[ob.data] ?? null;
}

export function metaDataOf(doc: Doc, ob: BObject | null | undefined): MetaBallData | null {
  if (!ob || ob.type !== 'META' || !ob.data) return null;
  return doc.metaballs?.[ob.data] ?? null;
}

/** "Mball.001" -> "Mball". */
export function metaFamilyName(name: string): string {
  const m = /^(.*?)(\.\d+)?$/.exec(name);
  return m ? m[1] : name;
}

/** Is this metaball object the basis of its family (the one whose name has no number suffix)? */
export function isMetaBasis(ob: BObject): boolean { return metaFamilyName(ob.name) === ob.name; }

/** Metaball objects of the same family as `ob` (in any scene the basis is in). */
export function metaFamily(doc: Doc, ob: BObject): BObject[] {
  const base = metaFamilyName(ob.name);
  const scene = doc.scenes.find((s) => s.objects.includes(ob.id));
  const ids = scene ? scene.objects : Object.keys(doc.objects);
  return ids.map((id) => doc.objects[id]).filter((o): o is BObject => !!o && o.type === 'META' && metaFamilyName(o.name) === base);
}

/** Basis object of a metaball family (null when there is none). */
export function metaBasisOf(doc: Doc, ob: BObject): BObject | null {
  return metaFamily(doc, ob).find(isMetaBasis) ?? null;
}

/** Sample the first spline of a bevel / taper object. */
function firstSpline(doc: Doc, id: string | null, render: boolean): SampledSpline | null {
  const o = id ? doc.objects[id] : null;
  const cu = curveDataOf(doc, o);
  if (!cu || !cu.splines.length || o?.type !== 'CURVE') return null;
  return sampleSpline(cu.splines[0], splineResolution(cu, cu.splines[0], render));
}

function applyModifiers(m: EvalMesh, mods: Modifier[], ctx: CurveEvalContext, ob: BObject): EvalMesh {
  for (const mod of mods) {
    if (ctx.render ? !mod.showRender : !mod.showViewport) continue;
    if (ctx.editMode && !mod.showInEditmode) continue;
    const def = modifierDef(mod.type);
    if (!def?.apply) continue;
    try { m = def.apply(m, mod, { frame: ctx.frame, render: ctx.render, editMode: ctx.editMode, ob, doc: ctx.doc }); } catch (err) { console.warn('modifier failed', mod.type, err); }
  }
  return m;
}

const cache = new Map<string, { key: string; mesh: EvalMesh }>();
const EMPTY: EvalMesh = { verts: [], faces: [], looseEdges: [], faceSmooth: [], faceMat: [] };

/** Extra state the curve of `ob` depends on (bevel / taper objects, metaball family). */
function dependencyKey(ob: BObject, ctx: CurveEvalContext): string {
  const doc = ctx.doc;
  if (ob.type === 'CURVE') {
    const cu = curveDataOf(doc, ob);
    if (!cu) return '';
    const dep = (id: string | null) => { const o = id ? doc.objects[id] : null; return o ? JSON.stringify(curveDataOf(doc, o)) : ''; };
    return dep(cu.bevelObject) + dep(cu.taperObject);
  }
  if (ob.type === 'META') {
    return metaFamily(doc, ob).map((o) => `${o.id}:${JSON.stringify(metaDataOf(doc, o)?.elements)}:${metaDataOf(doc, o)?.resolution}:${metaDataOf(doc, o)?.renderResolution}:${metaDataOf(doc, o)?.threshold}:${ctx.world(o).elements.map((x) => x.toFixed(5)).join(',')}`).join(';');
  }
  return '';
}

/** Evaluated mesh (with modifiers) of a CURVE, SURFACE or META object. */
export function curveObjEvalMesh(ob: BObject, ctx: CurveEvalContext): EvalMesh | null {
  const doc = ctx.doc;
  const data = ob.type === 'META' ? metaDataOf(doc, ob) : curveDataOf(doc, ob);
  if (!data) return null;
  const timeDep = ob.modifiers.some((m) => m.type === 'WAVE' || m.type === 'BUILD');
  const key = [JSON.stringify(data), JSON.stringify(ob.modifiers), ctx.render, ctx.editMode, timeDep ? ctx.frame : 0, dependencyKey(ob, ctx), ob.name].join('|');
  const ck = `${ob.id}|${ctx.render}`;
  const hit = cache.get(ck);
  if (hit && hit.key === key) return hit.mesh;
  let mesh: EvalMesh;
  if (ob.type === 'META') {
    const mb = data as MetaBallData;
    // FAST / NEVER: keep the old surface while transforming
    if (hit && ctx.transforming && (mb.updateMode === 'FAST' || mb.updateMode === 'NEVER')) return hit.mesh;
    if (!isMetaBasis(ob)) mesh = EMPTY;
    else {
      const baseInv = ctx.world(ob).clone().invert();
      const placed: PlacedElement[] = [];
      for (const o of metaFamily(doc, ob)) {
        const md = metaDataOf(doc, o);
        if (!md) continue;
        const toBase = baseInv.clone().multiply(ctx.world(o));
        for (const el of md.elements) placed.push({ el, toBase });
      }
      let res = ctx.render ? mb.renderResolution : mb.resolution;
      if (!ctx.render && ctx.transforming && mb.updateMode === 'HALFRES') res *= 2;
      mesh = polygonizeMeta(placed, res, mb.threshold);
    }
  } else if (ob.type === 'SURFACE') {
    mesh = surfaceToMesh(data as CurveData, ctx.render);
  } else {
    const cu = data as CurveData;
    mesh = curveToMesh(cu, { render: ctx.render, bevel: firstSpline(doc, cu.bevelObject, ctx.render), taper: firstSpline(doc, cu.taperObject, ctx.render) });
  }
  if (ob.modifiers.length && mesh.verts.length) mesh = applyModifiers(mesh, ob.modifiers, ctx, ob);
  if (cache.size > 256) cache.clear();
  cache.set(ck, { key, mesh });
  return mesh;
}

/** Forget cached results (after undo / file load). */
export function clearCurveCache(): void { cache.clear(); }
