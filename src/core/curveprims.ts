// Primitive splines of Add > Curve and Add > Surface (Blender 2.79's shapes), in object space.

import type { Vec3 } from './types';
import type { Spline } from './curvetypes';
import { calcHandles, newBezierPoint, newSpline, newSplinePoint } from './curve';

export type CurvePrim = 'BEZIER' | 'CIRCLE' | 'NURBS' | 'NURBS_CIRCLE' | 'PATH';
export type SurfacePrim = 'CURVE' | 'CIRCLE' | 'SURFACE' | 'CYLINDER' | 'SPHERE' | 'TORUS';

const S2 = Math.SQRT1_2;
/** Corner weight that makes an order 4 uniform 8-point NURBS circle round. */
const CIRCLE_W = Math.SQRT2 / 4;

/** Unit 8-point NURBS circle (corners weighted), counter-clockwise from -Y. */
function circle8(): { co: [number, number]; w: number }[] {
  return [[0, -1, 1], [1, -1, CIRCLE_W], [1, 0, 1], [1, 1, CIRCLE_W], [0, 1, 1], [-1, 1, CIRCLE_W], [-1, 0, 1], [-1, -1, CIRCLE_W]]
    .map(([x, y, w]) => ({ co: [x, y] as [number, number], w }));
}

export function curvePrimitive(type: CurvePrim, r: number): Spline {
  const sc = (v: Vec3): Vec3 => [v[0] * r, v[1] * r, v[2] * r];
  switch (type) {
    case 'BEZIER': {
      const sp = newSpline('BEZIER');
      sp.bezierPoints.push(newBezierPoint(sc([-1, 0, 0]), sc([-1.5, -0.5, 0]), sc([-0.5, 0.5, 0]), 'ALIGNED', true));
      sp.bezierPoints.push(newBezierPoint(sc([1, 0, 0]), sc([0, 0, 0]), sc([2, 0, 0]), 'ALIGNED', true));
      sp.pointCountU = 2;
      return sp;
    }
    case 'CIRCLE': {
      const sp = newSpline('BEZIER');
      for (const [x, y] of [[-1, 0], [0, -1], [1, 0], [0, 1]]) sp.bezierPoints.push(newBezierPoint(sc([x, y, 0]), sc([x, y, 0]), sc([x, y, 0]), 'AUTO', true));
      sp.useCyclicU = true;
      sp.pointCountU = 4;
      calcHandles(sp);
      return sp;
    }
    case 'NURBS': {
      const sp = newSpline('NURBS');
      for (const [x, y] of [[-1.5, 0], [-0.5, 1], [0.5, 1], [1.5, 0]]) sp.points.push(newSplinePoint(sc([x, y, 0]), 1, true));
      sp.pointCountU = 4;
      return sp;
    }
    case 'NURBS_CIRCLE': {
      const sp = newSpline('NURBS');
      for (const p of circle8()) sp.points.push(newSplinePoint(sc([p.co[0], p.co[1], 0]), p.w, true));
      sp.useCyclicU = true;
      sp.pointCountU = 8;
      return sp;
    }
    case 'PATH': {
      const sp = newSpline('NURBS');
      for (let i = 0; i < 5; i++) sp.points.push(newSplinePoint(sc([-2 + i, 0, 0]), 1, true));
      sp.orderU = 5;
      sp.useEndpointU = true;
      sp.pointCountU = 5;
      return sp;
    }
  }
}

/** NURBS surface primitives: a grid of points (U fastest). */
export function surfacePrimitive(type: SurfacePrim, r: number): Spline {
  const sp = newSpline('NURBS', 4);
  const add = (x: number, y: number, z: number, w = 1) => sp.points.push(newSplinePoint([x * r, y * r, z * r], w, true));
  switch (type) {
    case 'CURVE':
      for (const [x, y] of [[-1.5, 0], [-0.5, 1], [0.5, 1], [1.5, 0]]) add(x, y, 0);
      sp.pointCountU = 4; sp.pointCountV = 1;
      break;
    case 'CIRCLE':
      for (const p of circle8()) add(p.co[0], p.co[1], 0, p.w);
      sp.pointCountU = 8; sp.pointCountV = 1; sp.useCyclicU = true;
      break;
    case 'SURFACE':
      for (let v = 0; v < 4; v++) for (let u = 0; u < 4; u++) add(-1.5 + u, -1.5 + v, 0);
      sp.pointCountU = 4; sp.pointCountV = 4; sp.useEndpointU = true; sp.useEndpointV = true;
      break;
    case 'CYLINDER':
      for (const z of [-1, 1]) for (const p of circle8()) add(p.co[0], p.co[1], z, p.w);
      sp.pointCountU = 8; sp.pointCountV = 2; sp.useCyclicU = true; sp.orderV = 2; sp.useEndpointV = true;
      break;
    case 'SPHERE': {
      // half circle profile (x, z, weight) revolved around Z
      const prof: [number, number, number][] = [[0, -1, 1], [1, -1, S2], [1, 0, 1], [1, 1, S2], [0, 1, 1]];
      for (const [px, pz, pw] of prof) for (const p of circle8()) add(p.co[0] * px, p.co[1] * px, pz, p.w * pw);
      sp.pointCountU = 8; sp.pointCountV = 5; sp.useCyclicU = true; sp.orderV = 3; sp.useEndpointV = true;
      break;
    }
    case 'TORUS': {
      const minor = 0.25;
      for (const q of circle8()) {
        const rr = 1 + q.co[0] * minor, z = q.co[1] * minor;
        for (const p of circle8()) add(p.co[0] * rr, p.co[1] * rr, z, p.w * q.w);
      }
      sp.pointCountU = 8; sp.pointCountV = 8; sp.useCyclicU = true; sp.useCyclicV = true;
      break;
    }
  }
  return sp;
}

export const CURVE_PRIM_NAMES: Record<CurvePrim, string> = { BEZIER: 'BezierCurve', CIRCLE: 'BezierCircle', NURBS: 'NurbsCurve', NURBS_CIRCLE: 'NurbsCircle', PATH: 'NurbsPath' };
export const SURFACE_PRIM_NAMES: Record<SurfacePrim, string> = { CURVE: 'SurfCurve', CIRCLE: 'SurfCircle', SURFACE: 'SurfPatch', CYLINDER: 'SurfCylinder', SPHERE: 'SurfSphere', TORUS: 'SurfTorus' };
