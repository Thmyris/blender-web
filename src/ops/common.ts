// Shared helpers for operators.

import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { app, type OpContext } from '../app';
import type { BObject, Vec3 } from '../core/types';
import type { Area } from '../screen/screen';
import { View3D } from '../editors/view3d/view3d';
import { threeEulerOrder } from '../core/scene';

/** The 3D View an operator applies to: the invoking area, else the biggest 3D View. */
export function viewOf(ctx: OpContext): View3D | null {
  const a = ctx.area as Area | null | undefined;
  if (a && a.editor instanceof View3D) return a.editor;
  const screen = app.screen as unknown as { biggestArea(type?: string): Area | null } | null;
  const b = screen?.biggestArea('VIEW_3D');
  return b && b.editor instanceof View3D ? b.editor : null;
}

export const isObjectMode = () => app.mode === 'OBJECT';
export const isEditMesh = () => app.mode === 'EDIT' && !!app.editMesh;
export const hasSelected = () => app.selectedObjects().length > 0;
export const hasActive = () => !!app.activeObject;

/** Rotation (euler, object order XYZ) that aligns a new object with the view. */
export function viewAlignedRotation(view: View3D | null): Vec3 {
  if (!view) return [0, 0, 0];
  const q: Quaternion = view.view.camera().quaternion.clone();
  const e = new Euler().setFromQuaternion(q, threeEulerOrder('XYZ'));
  return [e.x, e.y, e.z];
}

export function worldToLocal(ob: BObject, p: Vector3): Vector3 {
  return p.clone().applyMatrix4(app.matrices.world(ob).clone().invert());
}

export function matrixOf(ob: BObject): Matrix4 { return app.matrices.world(ob).clone(); }

/** Layer index new objects go to (the first visible scene layer). */
export function activeLayer(): number {
  const i = app.scene.layers.findIndex(Boolean);
  return i < 0 ? 0 : i;
}
