// Lattice Edit Mode: point selection (RMB, border/circle/lasso, A, Ctrl+I) and G/R/S of lattice points.

import { Vector3 } from 'three';
import { app, type OperatorDef } from '../../app';
import type { BObject, LatticeData } from '../../core/types';
import { registerEditType, type SelectAction, type TransformPoint } from './edittypes';
import { registerKeymap } from '../../keymap';
import { regrid } from '../../core/lattice';
import type { MenuItem } from '../../ui/menu';

const latOf = (ob: BObject | null | undefined): LatticeData | null => (ob && ob.type === 'LATTICE' && ob.data ? app.doc.lattices?.[ob.data] ?? null : null);
const editLat = () => (app.mode === 'EDIT' ? latOf(app.editObj) : null);
const isLatEdit = () => !!editLat();

function ensureSel(lt: LatticeData): void {
  if (lt.select.length !== lt.points.length) lt.select = lt.points.map((_, i) => !!lt.select[i]);
}

function selectAll(lt: LatticeData, action: SelectAction): void {
  ensureSel(lt);
  let a = action;
  if (a === 'TOGGLE') a = lt.select.some(Boolean) ? 'DESELECT' : 'SELECT';
  lt.select = lt.select.map((s) => (a === 'SELECT' ? true : a === 'DESELECT' ? false : !s));
}

export const LATTICE_OPERATORS: OperatorDef[] = [
  {
    id: 'lattice.select_all', label: '(De)select All', description: 'Change selection of all lattice points', undo: true, register: true, poll: isLatEdit,
    props: { action: { name: 'Action', type: 'enum', default: 'TOGGLE', items: [['TOGGLE', 'Toggle'], ['SELECT', 'Select'], ['DESELECT', 'Deselect'], ['INVERT', 'Invert']] } },
    exec: (_c, p) => { selectAll(editLat()!, p.action as SelectAction); app.notify('data', 'select'); return 'FINISHED'; },
  },
  {
    id: 'lattice.make_regular', label: 'Make Regular', description: 'Set UVW control points a uniform distance apart', undo: true, register: true,
    poll: () => !!latOf(app.editObj ?? app.activeObject),
    exec: () => { const lt = latOf(app.editObj ?? app.activeObject)!; regrid(lt, lt.pointsU, lt.pointsV, lt.pointsW, false); app.tagAllGeometry(); return 'FINISHED'; },
  },
  {
    id: 'lattice.flip', label: 'Flip (Distortion)', description: 'Mirror all control points without inverting the lattice deform', undo: true, register: true, poll: isLatEdit,
    props: { axis: { name: 'Flip Axis', type: 'enum', default: 'U', items: [['U', 'U (X) Axis'], ['V', 'V (Y) Axis'], ['W', 'W (Z) Axis']] } },
    exec: (_c, p) => {
      const lt = editLat()!;
      const ax = p.axis === 'V' ? 1 : p.axis === 'W' ? 2 : 0;
      const n = [lt.pointsU, lt.pointsV, lt.pointsW];
      const pts = lt.points.map((q) => [...q]);
      for (let w = 0; w < n[2]; w++) for (let v = 0; v < n[1]; v++) for (let u = 0; u < n[0]; u++) {
        const idx = [u, v, w];
        const src = [...idx]; src[ax] = n[ax] - 1 - idx[ax];
        const i = (w * n[1] + v) * n[0] + u, j = (src[2] * n[1] + src[1]) * n[0] + src[0];
        const q = pts[j];
        lt.points[i] = [q[0], q[1], q[2]];
        lt.points[i][ax] = -q[ax];
      }
      app.tagAllGeometry();
      return 'FINISHED';
    },
  },
];

function latticeMenu(): MenuItem[] {
  const op = (label: string, id: string, props?: Record<string, unknown>): MenuItem => ({ label, op: id, props });
  return [
    op('Undo History', 'ed.undo_history'), op('Redo', 'ed.redo'), op('Undo', 'ed.undo'),
    { type: 'separator' },
    { type: 'submenu', label: 'Transform', items: [op('Grab/Move', 'transform.translate'), op('Rotate', 'transform.rotate'), op('Scale', 'transform.resize')] },
    { type: 'separator' },
    op('Make Regular', 'lattice.make_regular'),
    { type: 'submenu', label: 'Flip', items: [op('U (X) Axis', 'lattice.flip', { axis: 'U' }), op('V (Y) Axis', 'lattice.flip', { axis: 'V' }), op('W (Z) Axis', 'lattice.flip', { axis: 'W' })] },
  ];
}

registerEditType({
  types: ['LATTICE'],
  mode: 'EDIT',
  enter: (ob) => { const lt = latOf(ob); if (lt) ensureSel(lt); },
  clickSelect: (view, ob, x, y, extend) => {
    const lt = latOf(ob);
    if (!lt) return false;
    ensureSel(lt);
    const w = app.matrices.world(ob);
    let best = -1, bd = 12;
    lt.points.forEach((p, i) => {
      const s = view.view.project(new Vector3(...p).applyMatrix4(w));
      if (s.behind) return;
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < bd) { bd = d; best = i; }
    });
    if (best < 0) return false;
    if (!extend) lt.select.fill(false);
    lt.select[best] = extend ? !lt.select[best] : true;
    app.notify('data', 'select');
    return true;
  },
  regionSelect: (view, ob, inside, mode) => {
    const lt = latOf(ob);
    if (!lt) return;
    ensureSel(lt);
    if (mode === 'SET') lt.select.fill(false);
    const w = app.matrices.world(ob);
    lt.points.forEach((p, i) => {
      const s = view.view.project(new Vector3(...p).applyMatrix4(w));
      if (!s.behind && inside(s.x, s.y)) lt.select[i] = mode !== 'SUB';
    });
    app.notify('data', 'select');
  },
  selectAll: (ob, a) => { const lt = latOf(ob); if (lt) selectAll(lt, a); },
  hasSelection: (ob) => !!latOf(ob)?.select.some(Boolean),
  selectedPoints: (ob) => {
    const lt = latOf(ob);
    const w = app.matrices.world(ob);
    return lt ? lt.points.filter((_, i) => lt.select[i]).map((p) => new Vector3(...p).applyMatrix4(w)) : [];
  },
  transformPoints: (ob, propSize) => {
    const lt = latOf(ob);
    if (!lt) return [];
    ensureSel(lt);
    const w = app.matrices.world(ob).clone(), wi = w.clone().invert();
    const sel = lt.points.map((p, i) => (lt.select[i] ? new Vector3(...p).applyMatrix4(w) : null)).filter((x): x is Vector3 => !!x);
    const out: TransformPoint[] = [];
    lt.points.forEach((p, i) => {
      const world = new Vector3(...p).applyMatrix4(w);
      const selected = !!lt.select[i];
      if (!selected && !(propSize > 0 && sel.some((s) => s.distanceTo(world) < propSize))) return;
      const start = [p[0], p[1], p[2]] as [number, number, number];
      out.push({
        world, selected, factor: selected ? 1 : 0,
        apply: (X) => { const q = world.clone().applyMatrix4(X).applyMatrix4(wi); lt.points[i] = [q.x, q.y, q.z]; },
        restore: () => { lt.points[i] = [...start]; },
      });
    });
    return out;
  },
  afterTransform: () => { app.notify('geometry', 'data'); },
  menuLabel: 'Lattice',
  menu: latticeMenu,
});

registerKeymap([
  { code: 'KeyA', space: 'VIEW_3D', mode: 'EDIT', poll: isLatEdit, op: 'lattice.select_all', props: { action: 'TOGGLE' } },
  { code: 'KeyI', space: 'VIEW_3D', mode: 'EDIT', poll: isLatEdit, ctrl: true, op: 'lattice.select_all', props: { action: 'INVERT' } },
]);
