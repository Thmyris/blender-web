// Metaballs: Add > Metaball, and edit mode (select / move / scale elements, Alt+S radius,
// Shift+D duplicate, X delete, H hide). Selected elements show their radius and stiffness
// circles like Blender 2.79.

import { Euler, Matrix4, Quaternion, Vector3, type Group } from 'three';
import { app, type OpContext, type OperatorDef, type OpProps } from '../../app';
import type { BObject, Vec3 } from '../../core/types';
import type { MetaBallData, MetaElement, MetaElementType } from '../../core/curvetypes';
import { createObject, newId, threeEulerOrder, uniqueNameIn } from '../../core/scene';
import { metaDataOf } from '../../core/curveobj';
import { newMetaBallData, newMetaElement } from '../../core/mball';
import { registerEditType, type RegionMode, type SelectAction, type TransformPoint } from './edittypes';
import { registerKeymap, type KeyItem } from '../../keymap';
import { startTransform } from './transform';
import type { MenuItem } from '../../ui/menu';
import type { View3D } from './view3d';
import { addObjectAt } from '../../ops/curve';
import { viewAlignedRotation, viewOf } from '../../ops/common';

const op = (label: string, id: string, props?: Record<string, unknown>, icon?: string): MenuItem => ({ label, op: id, props, icon });
const sep: MenuItem = { type: 'separator' };
const sub = (label: string, items: MenuItem[] | (() => MenuItem[]), icon?: string): MenuItem => ({ type: 'submenu', label, items, icon });

export const isMetaEdit = () => app.mode === 'EDIT' && app.editObj?.type === 'META';
const editMeta = (): { ob: BObject; mb: MetaBallData } | null => {
  const ob = app.editObj;
  const mb = ob && ob.type === 'META' ? metaDataOf(app.doc, ob) : null;
  return ob && mb ? { ob, mb } : null;
};
const anySel = () => !!editMeta()?.mb.elements.some((e) => e.select && !e.hide);

// ------------------------------------------------------------------ drawing (2D rings)

const RAD = ['#a03c3c', '#ffa0a0'], STIFF = ['#3c903c', '#a0ffa0'];

/** Stiffness ring radius in units of the element radius (Blender draws it inside the radius ring). */
const stiffRadius = (el: MetaElement) => el.radius * (Math.atan(el.stiffness) / (Math.PI / 2));

function screenRing(view: View3D, ob: BObject, el: MetaElement, r: number): { x: number; y: number; r: number; behind: boolean } {
  const W = app.matrices.world(ob);
  const c = new Vector3(...el.co).applyMatrix4(W);
  const scale = new Vector3().setFromMatrixScale(W);
  const p = view.view.project(c);
  const rr = (r * (scale.x + scale.y + scale.z)) / 3 / view.view.pixelSize(c);
  return { x: p.x, y: p.y, r: rr, behind: p.behind };
}

function draw2D(view: View3D, ctx: CanvasRenderingContext2D, ob: BObject): void {
  const mb = metaDataOf(app.doc, ob);
  if (!mb) return;
  ctx.lineWidth = 1.5;
  mb.elements.forEach((el, i) => {
    if (el.hide) return;
    const a = screenRing(view, ob, el, el.radius);
    if (a.behind) return;
    const s = el.select ? 1 : 0;
    ctx.strokeStyle = RAD[s];
    ctx.lineWidth = el.select && !el.scaleStiffness && i === mb.activeElement ? 2.5 : 1.5;
    ctx.beginPath(); ctx.arc(a.x, a.y, Math.max(2, a.r), 0, Math.PI * 2); ctx.stroke();
    const b = screenRing(view, ob, el, stiffRadius(el));
    ctx.strokeStyle = STIFF[s];
    ctx.lineWidth = el.select && el.scaleStiffness ? 2.5 : 1.5;
    ctx.beginPath(); ctx.arc(b.x, b.y, Math.max(1.5, b.r), 0, Math.PI * 2); ctx.stroke();
  });
}

// ------------------------------------------------------------------ selection

function pick(view: View3D, ob: BObject, mb: MetaBallData, x: number, y: number): { i: number; stiff: boolean } | null {
  let best: { i: number; stiff: boolean } | null = null, bd = 10;
  mb.elements.forEach((el, i) => {
    if (el.hide) return;
    const a = screenRing(view, ob, el, el.radius), b = screenRing(view, ob, el, stiffRadius(el));
    if (a.behind) return;
    const d = Math.hypot(a.x - x, a.y - y);
    const dr = Math.abs(d - a.r), ds = Math.abs(d - b.r);
    if (dr < bd) { bd = dr; best = { i, stiff: false }; }
    if (ds < bd) { bd = ds; best = { i, stiff: true }; }
    if (d < 6 && d < bd) { bd = d; best = { i, stiff: false }; }
  });
  return best;
}

function selectAllMeta(mb: MetaBallData, action: SelectAction): void {
  let a = action;
  if (a === 'TOGGLE') a = mb.elements.some((e) => e.select && !e.hide) ? 'DESELECT' : 'SELECT';
  for (const e of mb.elements) if (!e.hide) e.select = a === 'INVERT' ? !e.select : a === 'SELECT';
}

function clickSelect(view: View3D, ob: BObject, x: number, y: number, extend: boolean): boolean {
  const mb = metaDataOf(app.doc, ob);
  if (!mb) return false;
  const hit = pick(view, ob, mb, x, y);
  if (!hit) { if (!extend) selectAllMeta(mb, 'DESELECT'); return false; }
  const el = mb.elements[hit.i];
  if (extend) el.select = !(el.select && mb.activeElement === hit.i);
  else { selectAllMeta(mb, 'DESELECT'); el.select = true; }
  el.scaleStiffness = hit.stiff;
  if (el.select) mb.activeElement = hit.i;
  return true;
}

function regionSelect(view: View3D, ob: BObject, inside: (px: number, py: number) => boolean, mode: RegionMode): void {
  const mb = metaDataOf(app.doc, ob);
  if (!mb) return;
  if (mode === 'SET') selectAllMeta(mb, 'DESELECT');
  const W = app.matrices.world(ob);
  for (const el of mb.elements) {
    if (el.hide) continue;
    const p = view.view.project(new Vector3(...el.co).applyMatrix4(W));
    if (!p.behind && inside(p.x, p.y)) el.select = mode !== 'SUB';
  }
}

// ------------------------------------------------------------------ transform

function transformPoints(ob: BObject, propSize: number): TransformPoint[] {
  const mb = metaDataOf(app.doc, ob);
  if (!mb) return [];
  const W = app.matrices.world(ob).clone();
  const Winv = W.clone().invert();
  const out: TransformPoint[] = [];
  for (const el of mb.elements) {
    if (el.hide || (!el.select && propSize <= 0)) continue;
    const start = { co: [...el.co] as Vec3, rot: [...el.rotation] as MetaElement['rotation'], radius: el.radius, stiffness: el.stiffness };
    out.push({
      world: new Vector3(...start.co).applyMatrix4(W), selected: el.select, factor: el.select ? 1 : 0,
      apply: (m) => {
        const L = Winv.clone().multiply(m).multiply(W);
        const p = new Vector3(...start.co).applyMatrix4(L);
        el.co = [p.x, p.y, p.z];
        const pos = new Vector3(), q = new Quaternion(), s = new Vector3();
        L.decompose(pos, q, s);
        const qs = new Quaternion(start.rot[1], start.rot[2], start.rot[3], start.rot[0]);
        const nq = q.clone().multiply(qs).normalize();
        el.rotation = [nq.w, nq.x, nq.y, nq.z];
        // scaling resizes the radius (or the stiffness when its ring was picked), like Blender
        const f = Math.cbrt(Math.abs(new Matrix4().copy(L).determinant()));
        if (el.scaleStiffness) { el.stiffness = Math.max(0, Math.min(10, start.stiffness * f)); el.radius = start.radius; }
        else { el.radius = Math.max(0, start.radius * f); el.stiffness = start.stiffness; }
      },
      restore: () => { el.co = [...start.co] as Vec3; el.rotation = [...start.rot] as MetaElement['rotation']; el.radius = start.radius; el.stiffness = start.stiffness; },
    });
  }
  return out;
}

function selectedPoints(ob: BObject): Vector3[] {
  const mb = metaDataOf(app.doc, ob);
  const W = app.matrices.world(ob);
  return mb ? mb.elements.filter((e) => e.select && !e.hide).map((e) => new Vector3(...e.co).applyMatrix4(W)) : [];
}

// ------------------------------------------------------------------ operators

const TYPES: [MetaElementType, string, string][] = [['BALL', 'Ball', 'META_BALL'], ['CAPSULE', 'Capsule', 'META_CAPSULE'], ['PLANE', 'Plane', 'META_PLANE'], ['ELLIPSOID', 'Ellipsoid', 'META_ELLIPSOID'], ['CUBE', 'Cube', 'META_CUBE']];

export function metaballAddItems(): MenuItem[] {
  return TYPES.map(([t, l, ic]) => op(l, 'object.metaball_add', { type: t }, ic));
}

function addMetaball(p: OpProps): 'FINISHED' {
  const doc = app.doc;
  doc.metaballs ??= {};
  const type = p.type as MetaElementType;
  const em = editMeta();
  const rot = (p.rotation as Vec3) ?? [0, 0, 0];
  const M = new Matrix4().compose(new Vector3(...((p.location as Vec3) ?? [0, 0, 0])), new Quaternion().setFromEuler(new Euler(rot[0], rot[1], rot[2], threeEulerOrder('XYZ'))), new Vector3(1, 1, 1));
  if (em) {
    // edit mode: a new element of the metaball, at the cursor
    const L = app.matrices.world(em.ob).clone().invert().multiply(M);
    const c = new Vector3().applyMatrix4(L);
    const el = newMetaElement(type, [c.x, c.y, c.z], Number(p.radius));
    for (const e of em.mb.elements) e.select = false;
    em.mb.elements.push(el);
    em.mb.activeElement = em.mb.elements.length - 1;
    app.notify('geometry');
    return 'FINISHED';
  }
  const mb = newMetaBallData(newId(doc, 'MB'), uniqueNameIn(doc, 'metaballs', 'Mball'));
  mb.elements.push(newMetaElement(type, [0, 0, 0], Number(p.radius)));
  doc.metaballs[mb.id] = mb;
  const ob = createObject(doc, 'META', 'Mball', mb.id);
  addObjectAt(ob, p);
  if (p.enter_editmode) { app.mode = 'EDIT'; app.editObject = ob.id; }
  app.notify('geometry');
  return 'FINISHED';
}

function grabAfter(ctx: OpContext): void {
  const view = viewOf(ctx);
  if (!view) return;
  const r = view.canvasRect();
  startTransform({ mode: 'TRANSLATION', view, mouse: { x: app.mouse.x - r.left, y: app.mouse.y - r.top } });
}

/** Alt+S: scale the radius of the selected elements interactively. */
function radiusModal(ctx: OpContext): 'RUNNING_MODAL' | 'CANCELLED' {
  const view = viewOf(ctx);
  const em = editMeta();
  if (!view || !em) return 'CANCELLED';
  const els = em.mb.elements.filter((e) => e.select && !e.hide);
  if (!els.length) return 'CANCELLED';
  const start = els.map((e) => e.radius);
  const pts = selectedPoints(em.ob);
  const center = pts.reduce((a, p) => a.add(p), new Vector3()).multiplyScalar(1 / pts.length);
  const r = view.canvasRect();
  const pc = view.view.project(center);
  const d0 = Math.max(1, Math.hypot(app.mouse.x - r.left - pc.x, app.mouse.y - r.top - pc.y));
  let f = 1, typed = '';
  const apply = () => { const v = typed ? Number(typed) || 0 : f; els.forEach((e, i) => { e.radius = Math.max(0, start[i] * v); }); app.notify('geometry'); view.requestRender(); };
  const finish = (ok: boolean) => {
    app.endModal(h);
    if (!ok) { els.forEach((e, i) => { e.radius = start[i]; }); app.notify('geometry'); return; }
    app.finishOperator(app.operator('mball.radius_scale')!, { value: typed ? Number(typed) || 0 : f }, ctx);
  };
  const h = {
    status: () => `Scale Radius: ${typed ? `[${typed}|]` : f.toFixed(3)}`,
    cancel: () => finish(false),
    onEvent: (ev: Event): boolean => {
      if (ev.type === 'pointermove') { const pe = ev as PointerEvent; f = Math.hypot(pe.clientX - r.left - pc.x, pe.clientY - r.top - pc.y) / d0; if (pe.ctrlKey) f = Math.round(f * 10) / 10; apply(); return true; }
      if (ev.type === 'pointerdown') { finish((ev as PointerEvent).button === 0); return true; }
      if (ev.type === 'keydown') {
        const k = (ev as KeyboardEvent).key;
        if (k === 'Escape') finish(false); else if (k === 'Enter' || k === ' ') finish(true);
        else if (/^[0-9.]$/.test(k)) { typed += k; apply(); } else if (k === 'Backspace') { typed = typed.slice(0, -1); apply(); }
        return true;
      }
      return true;
    },
  };
  app.startModal(h);
  return 'RUNNING_MODAL';
}

const editOp = (o: Omit<OperatorDef, 'undo' | 'register'> & { undo?: boolean; register?: boolean }): OperatorDef => ({ undo: true, register: true, poll: isMetaEdit, ...o });
const mb = () => editMeta()!.mb;

export const MBALL_OPERATORS: OperatorDef[] = [
  {
    id: 'object.metaball_add', label: 'Add Metaball', icon: 'OUTLINER_OB_META', undo: true, register: true, description: 'Add an metaball object to the scene',
    poll: () => app.mode === 'OBJECT' || isMetaEdit(),
    props: {
      type: { name: 'Primitive', type: 'enum', default: 'BALL', items: TYPES.map(([t, l]) => [t, l] as [string, string]) },
      radius: { name: 'Radius', type: 'float', default: 2, min: 0, subtype: 'DISTANCE' },
      view_align: { name: 'Align to View', type: 'bool', default: false },
      enter_editmode: { name: 'Enter Editmode', type: 'bool', default: false },
      location: { name: 'Location', type: 'vector', default: [0, 0, 0], size: 3, subtype: 'TRANSLATION' },
      rotation: { name: 'Rotation', type: 'vector', default: [0, 0, 0], size: 3, subtype: 'EULER' },
    },
    invoke: (ctx, p) => {
      p.location = app.scene.cursor.slice();
      p.view_align = p.view_align || app.prefs.alignNewObjects === 'VIEW';
      p.rotation = p.view_align ? viewAlignedRotation(viewOf(ctx)) : [0, 0, 0];
      p.enter_editmode = p.enter_editmode || app.prefs.enterEditMode;
      return addMetaball(p);
    },
    exec: (_c, p) => addMetaball(p),
  },
  editOp({
    id: 'mball.select_all', label: '(De)select All', description: 'Change selection of all meta elements',
    props: { action: { name: 'Action', type: 'enum', default: 'TOGGLE', items: [['TOGGLE', 'Toggle'], ['SELECT', 'Select'], ['DESELECT', 'Deselect'], ['INVERT', 'Invert']] } },
    exec: (_c, p) => { selectAllMeta(mb(), p.action as SelectAction); app.notify('select'); return 'FINISHED'; },
  }),
  editOp({
    id: 'mball.select_random_metaelems', label: 'Select Random', description: 'Randomly select metaelements',
    props: { percent: { name: 'Percent', type: 'float', default: 50, min: 0, max: 100, subtype: 'PERCENTAGE' }, seed: { name: 'Random Seed', type: 'int', default: 0, min: 0 }, action: { name: 'Action', type: 'enum', default: 'SELECT', items: [['SELECT', 'Select'], ['DESELECT', 'Deselect']] } },
    exec: (_c, p) => {
      let s = (Number(p.seed) * 9301 + 49297) % 233280 || 1;
      for (const e of mb().elements) { s = (s * 9301 + 49297) % 233280; if (!e.hide && (s / 233280) * 100 < Number(p.percent)) e.select = p.action === 'SELECT'; }
      app.notify('select');
      return 'FINISHED';
    },
  }),
  editOp({
    id: 'mball.select_similar', label: 'Select Similar', description: 'Select similar metaballs by property types',
    props: { type: { name: 'Type', type: 'enum', default: 'TYPE', items: [['TYPE', 'Type'], ['RADIUS', 'Radius'], ['STIFFNESS', 'Stiffness']] }, threshold: { name: 'Threshold', type: 'float', default: 0.1, min: 0 } },
    poll: () => isMetaEdit() && anySel(),
    exec: (_c, p) => {
      const els = mb().elements;
      const sel = els.filter((e) => e.select);
      const th = Number(p.threshold);
      for (const e of els) {
        if (e.hide) continue;
        if (p.type === 'TYPE' && sel.some((s) => s.type === e.type)) e.select = true;
        if (p.type === 'RADIUS' && sel.some((s) => Math.abs(s.radius - e.radius) <= th)) e.select = true;
        if (p.type === 'STIFFNESS' && sel.some((s) => Math.abs(s.stiffness - e.stiffness) <= th)) e.select = true;
      }
      app.notify('select');
      return 'FINISHED';
    },
  }),
  editOp({
    id: 'mball.duplicate_move', label: 'Duplicate Metaelements', description: 'Duplicate selected metaelement(s)', undo: false, register: false, poll: () => isMetaEdit() && anySel(),
    exec: (ctx) => {
      const m = mb();
      const copies = m.elements.filter((e) => e.select && !e.hide).map((e) => JSON.parse(JSON.stringify(e)) as MetaElement);
      for (const e of m.elements) e.select = false;
      m.elements.push(...copies);
      m.activeElement = m.elements.length - 1;
      app.notify('geometry', 'select');
      app.report('OPERATOR', 'bpy.ops.mball.duplicate_move(MBALL_OT_duplicate_metaelems={}, TRANSFORM_OT_translate={"value":(0, 0, 0)})');
      grabAfter(ctx);
      return 'FINISHED';
    },
  }),
  editOp({
    id: 'mball.delete_metaelems', label: 'Delete', description: 'Delete selected metaelement(s)', poll: () => isMetaEdit() && anySel(),
    exec: () => { const m = mb(); m.elements = m.elements.filter((e) => !e.select || e.hide); m.activeElement = Math.min(m.activeElement, m.elements.length - 1); app.notify('geometry', 'select'); return 'FINISHED'; },
  }),
  editOp({
    id: 'mball.hide_metaelems', label: 'Hide Selected', description: 'Hide (un)selected metaelement(s)',
    props: { unselected: { name: 'Unselected', type: 'bool', default: false } },
    exec: (_c, p) => { for (const e of mb().elements) if (e.select !== !!p.unselected) { e.hide = true; e.select = false; } app.notify('geometry', 'select'); return 'FINISHED'; },
  }),
  editOp({
    id: 'mball.reveal_metaelems', label: 'Reveal Hidden', description: 'Reveal all hidden metaelements',
    exec: () => { for (const e of mb().elements) if (e.hide) { e.hide = false; e.select = true; } app.notify('geometry', 'select'); return 'FINISHED'; },
  }),
  editOp({
    id: 'mball.radius_scale', label: 'Scale Radius', description: 'Scale the radius of the selected metaelements', poll: () => isMetaEdit() && anySel(),
    props: { value: { name: 'Factor', type: 'float', default: 1, min: 0 } },
    invoke: (ctx) => radiusModal(ctx),
    exec: (_c, p) => { for (const e of mb().elements) if (e.select && !e.hide) e.radius *= Number(p.value); app.notify('geometry'); return 'FINISHED'; },
  }),
];

function metaMenu(): MenuItem[] {
  const ts = app.scene.toolSettings;
  return [
    op('Undo History', 'ed.undo_history'), op('Redo', 'ed.redo'), op('Undo', 'ed.undo'),
    sep,
    sub('Transform', [op('Grab/Move', 'transform.translate'), op('Rotate', 'transform.rotate'), op('Scale', 'transform.resize'), op('Scale Radius', 'mball.radius_scale')]),
    sub('Snap', [op('Selection to Cursor', 'view3d.snap_selected_to_cursor', { use_offset: false }), op('Cursor to Selected', 'view3d.snap_cursor_to_selected'), op('Cursor to Center', 'view3d.snap_cursor_to_center')]),
    sep,
    op('Delete...', 'mball.delete_metaelems'),
    op('Duplicate Metaelements', 'mball.duplicate_move'),
    sep,
    sub('Proportional Editing', (['DISABLED', 'ENABLED', 'CONNECTED'] as const).map((v) => ({ label: v === 'DISABLED' ? 'Disable' : v === 'ENABLED' ? 'Enable' : 'Connected', checked: ts.proportionalEdit === v, action: () => { ts.proportionalEdit = v; app.notify('view'); } }))),
    sep,
    sub('Show/Hide', [op('Show Hidden', 'mball.reveal_metaelems'), op('Hide Selected', 'mball.hide_metaelems', { unselected: false }), op('Hide Unselected', 'mball.hide_metaelems', { unselected: true })]),
  ];
}

function metaSelectMenu(): MenuItem[] {
  return [
    op('Border Select', 'view3d.select_border'), op('Circle Select', 'view3d.select_circle'),
    sep,
    op('(De)select All', 'mball.select_all', { action: 'TOGGLE' }), op('Inverse', 'mball.select_all', { action: 'INVERT' }),
    sep,
    op('Random', 'mball.select_random_metaelems'),
    sub('Similar', [op('Type', 'mball.select_similar', { type: 'TYPE' }), op('Radius', 'mball.select_similar', { type: 'RADIUS' }), op('Stiffness', 'mball.select_similar', { type: 'STIFFNESS' })]),
  ];
}

registerEditType({
  types: ['META'],
  menuLabel: 'Metaball',
  menu: metaMenu,
  selectMenu: metaSelectMenu,
  addMenu: metaballAddItems,
  clickSelect, regionSelect,
  selectAll: (ob, a) => { const m = metaDataOf(app.doc, ob); if (m) selectAllMeta(m, a); },
  hasSelection: (ob) => !!metaDataOf(app.doc, ob)?.elements.some((e) => e.select && !e.hide),
  transformPoints,
  afterTransform: () => app.notify('geometry'),
  selectedPoints,
  activePoint: (ob) => { const m = metaDataOf(app.doc, ob); const e = m?.elements[m.activeElement]; return e?.select ? new Vector3(...e.co).applyMatrix4(app.matrices.world(ob)) : null; },
  overlayKey: () => 'meta',
  buildOverlay: (_ob: BObject, _g: Group) => { /* rings are drawn in draw2D */ },
  draw2D,
});

export function registerMetaKeymap(): void {
  const S = { shift: true }, A = { alt: true }, C = { ctrl: true };
  const K = (code: string, opId: string, props: Record<string, unknown> = {}, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}): KeyItem => ({ code, space: 'VIEW_3D', op: opId, props, mode: 'EDIT', poll: isMetaEdit, ...mods });
  registerKeymap([
    K('KeyA', 'mball.select_all', { action: 'TOGGLE' }),
    K('KeyI', 'mball.select_all', { action: 'INVERT' }, C),
    { code: 'KeyA', space: 'VIEW_3D', mode: 'EDIT', poll: isMetaEdit, shift: true, title: 'Add', menu: metaballAddItems },
    { code: 'KeyG', space: 'VIEW_3D', mode: 'EDIT', poll: isMetaEdit, shift: true, title: 'Select Similar', menu: () => [op('Type', 'mball.select_similar', { type: 'TYPE' }), op('Radius', 'mball.select_similar', { type: 'RADIUS' }), op('Stiffness', 'mball.select_similar', { type: 'STIFFNESS' })] },
    K('KeyD', 'mball.duplicate_move', {}, S),
    K('KeyX', 'mball.delete_metaelems'),
    K('Delete', 'mball.delete_metaelems'),
    K('KeyH', 'mball.hide_metaelems', { unselected: false }),
    K('KeyH', 'mball.hide_metaelems', { unselected: true }, S),
    K('KeyH', 'mball.reveal_metaelems', {}, A),
    K('KeyS', 'mball.radius_scale', {}, A),
  ]);
}
