// Wires curves, NURBS surfaces and metaballs into the app: their operators and keymaps, the
// edit-mode handlers (imported for their registerEditType side effects), Convert (Alt+C),
// and Join / material slot assignment for curve objects.

import { app, type App, type OperatorDef } from '../app';
import { CURVE_ADD_OPERATORS, CURVE_EDIT_OPERATORS, registerCurveKeymap } from './curve';
import { convertOperator, curveJoinPoll, curveMaterialSlotOp, joinCurves, separateOperator } from './curveconvert';
import { MBALL_OPERATORS, registerMetaKeymap } from '../editors/view3d/mballedit';
import '../editors/view3d/curveedit';

/** Extend an existing operator: `extra` runs first and returns null to fall through to the original. */
function extend(a: App, id: string, extraPoll: () => boolean, extra: () => 'FINISHED' | 'CANCELLED' | null): void {
  const orig = a.operator(id);
  if (!orig) return;
  const def: OperatorDef = {
    ...orig,
    poll: (ctx) => extraPoll() || (orig.poll ? orig.poll(ctx) : true),
    exec: (ctx, p) => extra() ?? (orig.exec ? orig.exec(ctx, p) : 'CANCELLED'),
  };
  if (orig.invoke) {
    const inv = orig.invoke;
    def.invoke = (ctx, p) => extra() ?? inv(ctx, p);
  }
  a.registerOperator(def);
}

export function initCurves(a: App = app): void {
  for (const def of [...CURVE_ADD_OPERATORS, ...CURVE_EDIT_OPERATORS, ...MBALL_OPERATORS, separateOperator]) a.registerOperator(def);
  // replaces the mesh-only Convert: Curve/Surface/Metaball/Text -> Mesh, Mesh/Text -> Curve
  a.registerOperator(convertOperator);
  registerCurveKeymap();
  registerMetaKeymap();
  const curveActive = () => app.mode === 'OBJECT' && app.activeObject?.type === 'CURVE';
  extend(a, 'object.join', () => curveActive() && curveJoinPoll(), () => (curveActive() ? joinCurves() : null));
  for (const kind of ['assign', 'select', 'deselect'] as const) {
    const isCurveEdit = () => app.mode === 'EDIT' && (app.editObj?.type === 'CURVE' || app.editObj?.type === 'SURFACE');
    extend(a, `object.material_slot_${kind}`, isCurveEdit, () => {
      if (!isCurveEdit()) return null;
      const r = curveMaterialSlotOp(kind);
      return r === null ? null : r ? 'FINISHED' : 'CANCELLED';
    });
  }
}
