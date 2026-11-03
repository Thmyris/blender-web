// Curve-driven constraints: Follow Path and Clamp To (Blender 2.79 object constraints).
// Registered into `constraintEvaluators` of core/scene.ts, which calls them with the
// owner's current world matrix and expects the constrained world matrix back.

import { Matrix4, Vector3 } from 'three';
import type { BObject, Constraint, Doc, Vec3 } from './types';
import type { CurveData } from './curvetypes';
import { constraintEvaluators, type MatrixCache } from './scene';
import { buildPath, pathAt, type CurvePath } from './curve';
import { curveDataOf } from './curveobj';

type AxisId = 'FORWARD_X' | 'FORWARD_Y' | 'FORWARD_Z' | 'TRACK_NEGATIVE_X' | 'TRACK_NEGATIVE_Y' | 'TRACK_NEGATIVE_Z';

/** Path animation start frame set by the "Animate Path" button (absent: the path is not animated). */
export interface PathAnimCurve extends CurveData { pathAnimStart?: number }

const pathCache = new WeakMap<CurveData, { key: string; path: CurvePath | null }>();

function pathOf(cu: CurveData): CurvePath | null {
  const key = JSON.stringify(cu.splines) + cu.dimensions + cu.twistMode + cu.resolutionU;
  const hit = pathCache.get(cu);
  if (hit && hit.key === key) return hit.path;
  const path = buildPath(cu);
  pathCache.set(cu, { key, path });
  return path;
}

function currentFrame(doc: Doc): number {
  const sc = doc.scenes.find((s) => s.id === doc.activeScene) ?? doc.scenes[0];
  return sc ? sc.frameCurrent : 1;
}

/** Evaluation time along the path, in frames (Blender's curve "eval_time"). */
export function pathEvalTime(doc: Doc, cu: CurveData): number {
  const start = (cu as PathAnimCurve).pathAnimStart;
  return start == null ? cu.evalTime : currentFrame(doc) - start;
}

function curveTarget(doc: Doc, con: Constraint): { ob: BObject; cu: CurveData } | null {
  const ob = con.target ? doc.objects[con.target] : null;
  const cu = curveDataOf(doc, ob);
  return ob && cu ? { ob, cu } : null;
}

/** Rotation whose `forward` axis follows the tangent and `up` axis the path's up vector. */
function followRotation(tangent: Vec3, up: Vec3, forward: string, upAxis: string): Matrix4 {
  const fIdx = 'XYZ'.indexOf(forward.slice(-1));
  const neg = forward.startsWith('TRACK_NEGATIVE');
  let uIdx = 'XYZ'.indexOf(upAxis.slice(-1));
  if (uIdx === fIdx) uIdx = (fIdx + 2) % 3; // Blender ignores an up axis equal to the forward axis
  const t = new Vector3(...tangent).normalize().multiplyScalar(neg ? -1 : 1);
  const u = new Vector3(...up);
  u.addScaledVector(t, -u.dot(t));
  if (u.lengthSq() < 1e-10) u.set(0, 0, 1).addScaledVector(t, -t.z);
  u.normalize();
  const cols: Vector3[] = [new Vector3(), new Vector3(), new Vector3()];
  cols[fIdx] = t;
  cols[uIdx] = u;
  const r = 3 - fIdx - uIdx;
  cols[r] = new Vector3().crossVectors(cols[(r + 1) % 3], cols[(r + 2) % 3]).normalize();
  return new Matrix4().makeBasis(cols[0], cols[1], cols[2]);
}

constraintEvaluators.FOLLOW_PATH = (doc, _ob, con, m, cache: MatrixCache) => {
  const tgt = curveTarget(doc, con);
  if (!tgt) return null;
  const path = pathOf(tgt.cu);
  if (!path) return null;
  let t: number;
  if (con.useFixedLocation) t = Number(con.offsetFactor ?? 0);
  else t = (pathEvalTime(doc, tgt.cu) - Number(con.offset ?? 0)) / Math.max(1, tgt.cu.pathDuration);
  if (!path.cyclic) t = Math.min(1, Math.max(0, t));
  const p = pathAt(path, t);
  const local = new Matrix4().makeTranslation(p.co[0], p.co[1], p.co[2]);
  if (con.useCurveFollow) local.multiply(followRotation(p.frame.t, p.frame.u, String(con.forwardAxis ?? 'FORWARD_Y'), String(con.upAxis ?? 'UP_Z')));
  if (con.useCurveRadius) local.multiply(new Matrix4().makeScale(p.radius, p.radius, p.radius));
  return cache.world(tgt.ob).clone().multiply(local).multiply(m);
};

constraintEvaluators.CLAMP_TO = (doc, _ob, con, m, cache: MatrixCache) => {
  const tgt = curveTarget(doc, con);
  if (!tgt) return null;
  const path = pathOf(tgt.cu);
  if (!path) return null;
  const curveWorld = cache.world(tgt.ob);
  const pos = new Vector3().setFromMatrixPosition(m).applyMatrix4(curveWorld.clone().invert());
  // the owner's position along the main axis of the curve's bounding box picks the point on the path
  const min = new Vector3(Infinity, Infinity, Infinity), max = new Vector3(-Infinity, -Infinity, -Infinity);
  for (const q of path.pts) { min.min(new Vector3(...q)); max.max(new Vector3(...q)); }
  const size = new Vector3().subVectors(max, min);
  let axis = 'XYZ'.indexOf(String(con.mainAxis ?? 'CLAMPTO_AUTO').slice(-1));
  if (axis < 0 || String(con.mainAxis ?? 'CLAMPTO_AUTO') === 'CLAMPTO_AUTO') axis = size.x >= size.y && size.x >= size.z ? 0 : size.y >= size.z ? 1 : 2;
  const extent = size.getComponent(axis);
  let t = extent > 1e-9 ? (pos.getComponent(axis) - min.getComponent(axis)) / extent : 0;
  if (con.useCyclic) t = ((t % 1) + 1) % 1;
  else t = Math.min(1, Math.max(0, t));
  const p = pathAt(path, t);
  const world = new Vector3(...p.co).applyMatrix4(curveWorld);
  const res = m.clone();
  res.setPosition(world);
  return res;
};
