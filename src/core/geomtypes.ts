// Object types whose data is evaluated to a mesh (drawn, rendered, picked and exported like meshes).

/** Curve-like types evaluated by curveobj.ts: curves, NURBS surfaces and metaballs. */
export const CURVE_LIKE_TYPES: ReadonlySet<string> = new Set(['CURVE', 'SURFACE', 'META']);

/** Does an object of this type have an evaluated mesh (app.evalMesh)? */
export function hasEvalGeometry(type: string): boolean {
  return type === 'MESH' || type === 'FONT' || CURVE_LIKE_TYPES.has(type);
}
