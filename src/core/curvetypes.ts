// Document data of curves (Blender's Curve datablock, used by CURVE and SURFACE objects),
// metaballs (MetaBall datablock) and fonts (VectorFont datablock). Plain JSON like the rest
// of the document model.

import type { Vec3 } from './types';

export type HandleType = 'AUTO' | 'VECTOR' | 'ALIGNED' | 'FREE';

/** A point of a Bezier spline (bpy.types.BezierSplinePoint). */
export interface BezierPoint {
  co: Vec3;
  handleLeft: Vec3;
  handleRight: Vec3;
  handleLeftType: HandleType;
  handleRightType: HandleType;
  tilt: number;
  radius: number;
  weightSoftbody: number;
  /** Selection of the control point and of the two handles. */
  select: boolean;
  selectLeft: boolean;
  selectRight: boolean;
  hide?: boolean;
}

/** A point of a NURBS / poly spline or of a NURBS surface (bpy.types.SplinePoint). `co[3]` is the weight. */
export interface SplinePoint {
  co: Vec3;
  w: number;
  tilt: number;
  radius: number;
  weightSoftbody: number;
  select: boolean;
  hide?: boolean;
}

export type SplineType = 'POLY' | 'BEZIER' | 'NURBS';

export interface Spline {
  type: SplineType;
  /** Bezier points (BEZIER splines). */
  bezierPoints: BezierPoint[];
  /** NURBS / poly points; surfaces store a grid of pointCountU x pointCountV points, U fastest. */
  points: SplinePoint[];
  /** Points in U (surfaces; for curves the number of points). */
  pointCountU: number;
  /** Points in V (surfaces; 1 for curves). */
  pointCountV: number;
  orderU: number;
  orderV: number;
  resolutionU: number;
  resolutionV: number;
  useCyclicU: boolean;
  useCyclicV: boolean;
  useEndpointU: boolean;
  useEndpointV: boolean;
  useBezierU: boolean;
  useBezierV: boolean;
  useSmooth: boolean;
  materialIndex: number;
  hide?: boolean;
}

export type CurveFillMode = 'FULL' | 'BACK' | 'FRONT' | 'HALF' | 'NONE';

/** bpy.types.Curve (and SurfaceCurve). */
export interface CurveData {
  id: string;
  name: string;
  splines: Spline[];
  dimensions: '2D' | '3D';
  resolutionU: number;
  renderResolutionU: number;
  resolutionV: number;
  renderResolutionV: number;
  fillMode: CurveFillMode;
  twistMode: 'Z_UP' | 'MINIMUM' | 'TANGENT';
  twistSmooth: number;
  useFillDeform: boolean;
  offset: number;
  extrude: number;
  bevelDepth: number;
  bevelResolution: number;
  bevelObject: string | null;
  taperObject: string | null;
  useFillCaps: boolean;
  useMapTaper: boolean;
  /** Path animation. */
  usePath: boolean;
  pathDuration: number;
  evalTime: number;
  usePathFollow: boolean;
  useStretch: boolean;
  useDeformBounds: boolean;
  useRadius: boolean;
  /** Display (N panel "Curve Display"). */
  showHandles: boolean;
  showNormalFace: boolean;
  materials: (string | null)[];
  /** Active spline / point (index into the spline's point list) for the N panel. */
  activeSpline: number;
  activePoint: number;
  fakeUser: boolean;
}

export type MetaElementType = 'BALL' | 'CAPSULE' | 'PLANE' | 'ELLIPSOID' | 'CUBE';

/** bpy.types.MetaElement. */
export interface MetaElement {
  type: MetaElementType;
  co: Vec3;
  /** Rotation (w, x, y, z). */
  rotation: [number, number, number, number];
  radius: number;
  stiffness: number;
  sizeX: number;
  sizeY: number;
  sizeZ: number;
  useNegative: boolean;
  hide: boolean;
  select: boolean;
  /** Which circle Scale affects: the radius (default) or the stiffness. */
  scaleStiffness?: boolean;
}

/** bpy.types.MetaBall. */
export interface MetaBallData {
  id: string;
  name: string;
  elements: MetaElement[];
  resolution: number;
  renderResolution: number;
  threshold: number;
  updateMode: 'UPDATE_ALWAYS' | 'HALFRES' | 'FAST' | 'NEVER';
  materials: (string | null)[];
  activeElement: number;
  fakeUser: boolean;
}

/** bpy.types.VectorFont: a font file stored in the document. */
export interface VFontData {
  id: string;
  name: string;
  filepath: string;
  /** The .ttf / .otf file, base64 encoded. */
  data: string;
  fakeUser: boolean;
}
