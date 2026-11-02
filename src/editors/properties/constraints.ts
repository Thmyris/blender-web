// Object Constraints context (properties_constraint.py + template_constraint of Blender 2.79).
// The constraint stack is drawn as boxes inside one header-less panel, like Blender.

import { Matrix4 } from 'three';
import { app } from '../../app';
import type { Constraint, ConstraintType } from '../../core/types';
import { bprop, eprop, fprop, sprop, type BoolProp, type FloatProp, type Layout, type PanelDef } from '../../ui/layout';
import type { MenuItem } from '../../ui/menu';
import {
  activeWhen, callOp, commitEdit, flatPanel, NA, naBool, naButton, naEnum, ob, objectItems, type PropsCtx,
} from './common';

const SUPPORTED = new Set<ConstraintType>([
  'COPY_LOCATION', 'COPY_ROTATION', 'COPY_SCALE', 'LIMIT_LOCATION', 'LIMIT_ROTATION', 'LIMIT_SCALE', 'TRACK_TO', 'DAMPED_TRACK', 'CHILD_OF',
]);

/** Blender 2.79's "Add Object Constraint" menu (object constraints only, no IK). */
const ADD_MENU: { title: string; items: [string, string][] }[] = [
  { title: 'Motion Tracking', items: [['CAMERA_SOLVER', 'Camera Solver'], ['FOLLOW_TRACK', 'Follow Track'], ['OBJECT_SOLVER', 'Object Solver']] },
  { title: 'Transform', items: [['COPY_LOCATION', 'Copy Location'], ['COPY_ROTATION', 'Copy Rotation'], ['COPY_SCALE', 'Copy Scale'], ['COPY_TRANSFORMS', 'Copy Transforms'], ['LIMIT_DISTANCE', 'Limit Distance'], ['LIMIT_LOCATION', 'Limit Location'], ['LIMIT_ROTATION', 'Limit Rotation'], ['LIMIT_SCALE', 'Limit Scale'], ['MAINTAIN_VOLUME', 'Maintain Volume'], ['TRANSFORM', 'Transformation']] },
  { title: 'Tracking', items: [['CLAMP_TO', 'Clamp To'], ['DAMPED_TRACK', 'Damped Track'], ['LOCKED_TRACK', 'Locked Track'], ['STRETCH_TO', 'Stretch To'], ['TRACK_TO', 'Track To']] },
  { title: 'Relationship', items: [['ACTION', 'Action'], ['CHILD_OF', 'Child Of'], ['FLOOR', 'Floor'], ['FOLLOW_PATH', 'Follow Path'], ['PIVOT', 'Pivot'], ['RIGID_BODY_JOINT', 'Rigid Body Joint'], ['SHRINKWRAP', 'Shrinkwrap']] },
];

const NEEDS_TARGET = new Set<ConstraintType>(['COPY_LOCATION', 'COPY_ROTATION', 'COPY_SCALE', 'TRACK_TO', 'DAMPED_TRACK', 'CHILD_OF']);

const TRACK_AXES = [
  { id: 'TRACK_X', label: 'X' }, { id: 'TRACK_Y', label: 'Y' }, { id: 'TRACK_Z', label: 'Z' },
  { id: 'TRACK_NEGATIVE_X', label: '-X' }, { id: 'TRACK_NEGATIVE_Y', label: '-Y' }, { id: 'TRACK_NEGATIVE_Z', label: '-Z' },
];

function addMenu(ctx: PropsCtx): MenuItem[] {
  return [{
    type: 'columns',
    columns: ADD_MENU.map((c) => ({
      title: c.title,
      items: c.items.map(([type, label]): MenuItem => (SUPPORTED.has(type as ConstraintType)
        ? { label, icon: 'CONSTRAINT_DATA', description: `Add a ${label} constraint to the active object`, action: () => callOp(ctx, 'object.constraint_add', { type }) }
        : { label, icon: 'CONSTRAINT_DATA', disabled: true, description: NA })),
    })),
  }];
}

export function constraintPanels(ctx: PropsCtx): PanelDef[] {
  const o = ob();
  const structure = () => JSON.stringify((ob()?.constraints ?? []).map((c) => [c.type, c.name, c.showExpanded]));
  return [{
    id: 'constraint.stack', label: 'Object Constraints', noHeader: true, key: structure,
    draw: (l) => {
      flatPanel(l);
      l.menu('Add Object Constraint', () => addMenu(ctx), { title: 'Add Constraint' });
      (o?.constraints ?? []).forEach((_, i) => constraintBox(l, ctx, i));
    },
  }];
}

function constraintBox(l: Layout, ctx: PropsCtx, i: number): void {
  const C = (): Constraint | null => ob()?.constraints[i] ?? null;
  const con = C();
  if (!con) return;
  const count = ob()?.constraints.length ?? 0;
  const box = l.box();
  const head = box.row();
  head.prop(bprop(C, 'showExpanded', { name: '', description: 'Expand/collapse constraint', undo: false, notify: ['screen'] }), { iconOnly: true, icon: 'TRIA_RIGHT', iconOn: 'TRIA_DOWN', emboss: false }).style.background = 'transparent';
  head.label('', { icon: 'CONSTRAINT_DATA', fixed: true });
  const nameEl = head.prop({
    ...sprop(C, 'name', { name: '', description: 'Constraint name', undo: 'Rename Constraint' }),
    set: (v: string) => {
      const o = ob(); const c = C();
      if (!o || !c || !v.trim()) return;
      // keep names unique within the stack (operators address constraints by name)
      const names = new Set(o.constraints.filter((x) => x !== c).map((x) => x.name));
      let n = v.trim();
      for (let k = 1; names.has(n); k++) n = `${v.trim()}.${String(k).padStart(3, '0')}`;
      c.name = n;
    },
  });
  // Blender draws the name in red when the constraint cannot be evaluated (missing target)
  const markInvalid = () => {
    const c = C();
    const bad = !!c && NEEDS_TARGET.has(c.type) && !(c.target && app.doc.objects[c.target]);
    nameEl.style.background = bad ? 'linear-gradient(to bottom, #d05050, #b03c3c)' : '';
  };
  markInvalid();
  head.root.widgets.push({ update: markInvalid });
  if (count > 1) {
    const ud = head.row(true);
    ud.el.classList.add('fixed');
    ud.button('', () => { const c = C(); if (c) callOp(ctx, 'constraint.move_up', { constraint: c.name }); }, { icon: 'TRIA_UP', iconOnly: true, tip: 'Move constraint up in constraint stack', disabled: () => i === 0 });
    ud.button('', () => { const c = C(); if (c) callOp(ctx, 'constraint.move_down', { constraint: c.name }); }, { icon: 'TRIA_DOWN', iconOnly: true, tip: 'Move constraint down in constraint stack', disabled: () => i >= (ob()?.constraints.length ?? 0) - 1 });
  }
  head.prop(bprop(C, 'mute', { name: 'Disable', description: 'Enable/Disable Constraint', notify: ['scene'] }), { iconOnly: true, icon: 'RESTRICT_VIEW_OFF', iconOn: 'RESTRICT_VIEW_ON', emboss: false });
  head.button('', () => { const c = C(); if (c) callOp(ctx, 'constraint.delete', { constraint: c.name }); }, { icon: 'X', iconOnly: true, tip: 'Delete Constraint' }).classList.add('fixed');

  if (!con.showExpanded) return;
  const body = box.column();
  switch (con.type) {
    case 'COPY_LOCATION':
    case 'COPY_ROTATION': {
      target(body, C);
      const sp = body.split(1 / 3);
      for (const ax of ['X', 'Y', 'Z']) {
        const col = sp.column();
        col.prop(cbool(C, `use${ax}`, ax, `Copy the target's ${ax} ${con.type === 'COPY_LOCATION' ? 'location' : 'rotation'}`));
        const sub = col.column();
        activeWhen(sub, () => C()?.[`use${ax}`] !== false);
        sub.prop(cbool(C, `invert${ax}`, 'Invert', `Invert the ${ax} ${con.type === 'COPY_LOCATION' ? 'location' : 'rotation'}`));
      }
      body.prop(cbool(C, 'useOffset', 'Offset', `Add original ${con.type === 'COPY_LOCATION' ? 'location' : 'rotation'} into copied ${con.type === 'COPY_LOCATION' ? 'location' : 'rotation'}`));
      space(body, true);
      break;
    }
    case 'COPY_SCALE': {
      target(body, C);
      const row = body.row(true);
      for (const ax of ['X', 'Y', 'Z']) row.prop(cbool(C, `use${ax}`, ax, `Copy the target's ${ax} scale`));
      body.prop(cbool(C, 'useOffset', 'Offset', 'Combine original scale with copied scale'));
      body.prop(naBool('Additive'));
      space(body, true);
      break;
    }
    case 'LIMIT_LOCATION':
    case 'LIMIT_SCALE': {
      const isLoc = con.type === 'LIMIT_LOCATION';
      const sp = body.split(1 / 3);
      for (const ax of ['X', 'Y', 'Z']) {
        const col = sp.column();
        for (const m of ['Min', 'Max']) {
          col.prop(cbool(C, `use${m}${ax}`, `${m === 'Min' ? 'Minimum' : 'Maximum'} ${ax}`, `Use the ${m === 'Min' ? 'minimum' : 'maximum'} ${ax} value`));
          const sub = col.column();
          activeWhen(sub, () => !!C()?.[`use${m}${ax}`]);
          sub.prop(cfloat(C, `${m.toLowerCase()}${ax}`, '', { unit: isLoc ? 'LENGTH' : 'NONE', precision: 3, step: 0.1, description: `Lowest/highest ${ax} value to allow` }));
        }
      }
      limitFooter(body);
      break;
    }
    case 'LIMIT_ROTATION': {
      const sp = body.split(1 / 3);
      for (const ax of ['X', 'Y', 'Z']) {
        const col = sp.column(true);
        col.prop(cbool(C, `useLimit${ax}`, `Limit ${ax}`, `Use ${ax} limit`));
        const sub = col.column(true);
        activeWhen(sub, () => !!C()?.[`useLimit${ax}`]);
        sub.prop(cfloat(C, `min${ax}`, 'Min', { unit: 'ROTATION', step: Math.PI / 180, description: `Lowest ${ax} value to allow` }));
        sub.prop(cfloat(C, `max${ax}`, 'Max', { unit: 'ROTATION', step: Math.PI / 180, description: `Highest ${ax} value to allow` }));
      }
      limitFooter(body);
      break;
    }
    case 'TRACK_TO': {
      target(body, C);
      const row = body.row();
      row.label('To:', { fixed: true });
      row.prop(eprop(C, 'trackAxis', TRACK_AXES, { name: 'Track Axis', description: 'Axis that points to the target object', notify: ['scene'] }), { expand: true });
      const r2 = body.row();
      r2.prop(eprop(C, 'upAxis', [{ id: 'UP_X', label: 'X' }, { id: 'UP_Y', label: 'Y' }, { id: 'UP_Z', label: 'Z' }], { name: 'Up', description: 'Axis that points upward', notify: ['scene'] }));
      r2.prop(naBool('Target Z'));
      space(body, true);
      break;
    }
    case 'DAMPED_TRACK': {
      target(body, C);
      const row = body.row();
      row.label('To:', { fixed: true });
      row.prop(eprop(C, 'trackAxis', TRACK_AXES, { name: 'Track Axis', description: 'Axis that points to the target object', notify: ['scene'] }), { expand: true });
      space(body, true);
      break;
    }
    case 'CHILD_OF': {
      target(body, C);
      const sp = body.split(1 / 3);
      for (const t of ['Location', 'Rotation', 'Scale']) {
        const col = sp.column();
        col.label(`${t}:`, { disabled: true });
        for (const ax of ['X', 'Y', 'Z']) col.prop(naBool(ax, true, `Use ${t} ${ax} of parent (always on in blender-web)`));
      }
      const row = body.row();
      row.button('Set Inverse', () => {
        const c = C();
        const t = c?.target ? app.doc.objects[c.target] : null;
        if (!c || !t) return;
        app.matrices.clear();
        c.inverse = app.matrices.world(t).clone().invert().toArray();
        commitEdit('Set Inverse', 'scene');
      }, { tip: 'Set inverse correction for ChildOf constraint', disabled: () => !C()?.target });
      row.button('Clear Inverse', () => {
        const c = C();
        if (!c) return;
        c.inverse = new Matrix4().toArray();
        commitEdit('Clear Inverse', 'scene');
      }, { tip: 'Clear inverse correction for ChildOf constraint' });
      break;
    }
  }
  // influence
  const ir = body.row(true);
  ir.prop(fprop(C, 'influence', { name: 'Influence', min: 0, max: 1, precision: 3, description: 'Amount of influence constraint will have on the final solution', notify: ['scene'] }), { slider: true });
  naButton(ir, '', 'CANCEL', true);
}

// ------------------------------------------------------------------ helpers

function cbool(C: () => Constraint | null, key: string, name: string, description: string): BoolProp {
  return { kind: 'bool', name, description, notify: ['scene'], get: () => { const v = C()?.[key]; return key.startsWith('use') && (key === 'useX' || key === 'useY' || key === 'useZ') ? v !== false : !!v; }, set: (v) => { const c = C(); if (c) c[key] = v; } };
}

function cfloat(C: () => Constraint | null, key: string, name: string, o: Partial<FloatProp> = {}): FloatProp {
  return { kind: 'float', name, notify: ['scene'], get: () => Number(C()?.[key] ?? 0), set: (v) => { const c = C(); if (c) c[key] = v; }, ...o };
}

function target(l: Layout, C: () => Constraint | null): void {
  l.prop({
    kind: 'enum', name: 'Target', notify: ['scene'], undo: 'Change Target', description: 'Target Object',
    items: () => objectItems((o) => o.id !== ob()?.id),
    get: () => C()?.target ?? '',
    set: (v) => { const c = C(); if (c) c.target = v || null; },
  }, { icon: 'OBJECT_DATA' });
}

function space(l: Layout, withTarget: boolean): void {
  const sp = l.split(0.2);
  sp.column().label('Space:', { disabled: true });
  const row = sp.column().row();
  if (withTarget) {
    row.prop(naEnum('Target Space', ['World Space', 'Local Space', 'Local with Parent', 'Pose Space'], 'World Space'), { noLabel: true });
    row.label('↔', { fixed: true, disabled: true });
  }
  row.prop(naEnum('Owner Space', ['World Space', 'Local Space', 'Local with Parent', 'Pose Space'], 'World Space'), { noLabel: true });
}

function limitFooter(l: Layout): void {
  const row = l.row();
  row.prop(naBool('For Transform'));
  row.label('');
  const r2 = l.row();
  r2.label('Convert:', { disabled: true });
  r2.prop(naEnum('Owner Space', ['World Space', 'Local Space', 'Local with Parent'], 'World Space'), { noLabel: true });
}
