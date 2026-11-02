// Scene context (properties_scene.py of Blender 2.79).

import { app } from '../../app';
import type { UnitSettings } from '../../core/types';
import { setUnitSettings } from '../../ui/format';
import { bprop, eprop, fprop, type EnumItem, type PanelDef } from '../../ui/layout';
import {
  activeWhen, customPropsBody, naBool, naButton, naEnum, naFloat, naIdField, naInt, richList, scene, type PropsCtx,
} from './common';

const U = (): UnitSettings | null => app.scene?.unit ?? null;

/** Units changed: number fields read the module-level unit settings from ui/format. */
function unitsChanged(): void { if (app.scene) setUnitSettings(app.scene.unit); }

export function scenePanels(ctx: PropsCtx): PanelDef[] {
  void ctx;
  const P: PanelDef[] = [];

  P.push({
    id: 'scene.scene', label: 'Scene',
    draw: (l) => {
      l.prop({
        kind: 'enum', name: 'Camera', notify: ['scene', 'view'], undo: 'Change Camera',
        description: 'Active camera, used for rendering the scene', python: 'bpy.context.scene.camera',
        items: () => {
          const items: EnumItem[] = [{ id: '', label: '', icon: 'NONE' }];
          for (const o of app.objects()) if (o.type === 'CAMERA') items.push({ id: o.id, label: o.name, icon: 'OUTLINER_OB_CAMERA' });
          return items;
        },
        get: () => app.scene?.camera ?? '',
        set: (v) => { if (app.scene) app.scene.camera = v || null; },
      }, { icon: 'OUTLINER_OB_CAMERA' });
      naIdField(l, 'Background', 'SCENE_DATA');
      naIdField(l, 'Active Clip', 'CLIP');
    },
  });

  P.push({
    id: 'scene.units', label: 'Units', key: () => U()?.system ?? '',
    draw: (l) => {
      const pr = l.row(true);
      pr.menu('Unit Presets', () => [
        { label: 'None', action: () => setPreset('NONE') },
        { label: 'Metric', action: () => setPreset('METRIC') },
        { label: 'Imperial', action: () => setPreset('IMPERIAL') },
      ], { title: 'Unit Presets' });
      const col = l.column();
      col.row().prop(eprop(U, 'system', [
        { id: 'NONE', label: 'None' }, { id: 'METRIC', label: 'Metric' }, { id: 'IMPERIAL', label: 'Imperial' },
      ], { name: 'Unit System', description: 'The unit system to use for button display', notify: ['scene', 'view'], onChange: unitsChanged }), { expand: true });
      col.row().prop(eprop(U, 'systemRotation', [
        { id: 'DEGREES', label: 'Degrees', description: 'Use degrees for measuring angles and rotations' },
        { id: 'RADIANS', label: 'Radians' },
      ], { name: 'Rotation Units', description: 'Unit to use for displaying/editing rotation values', notify: ['scene', 'view'], onChange: unitsChanged }), { expand: true });
      if ((U()?.system ?? 'NONE') !== 'NONE') {
        const row = l.row();
        row.prop(fprop(U, 'scaleLength', { name: 'Unit Scale', min: 0.00001, max: 100000, precision: 3, step: 0.1, description: 'Scale to use when converting between Blender units and dimensions', notify: ['scene', 'view'], onChange: unitsChanged }));
        row.prop(bprop(U, 'useSeparate', { name: 'Separate Units', description: 'Display units in pairs (e.g. 1m 0cm)', notify: ['scene', 'view'], onChange: unitsChanged }));
      }
    },
  });

  P.push({
    id: 'scene.keying_sets', label: 'Keying Sets',
    draw: (l) => {
      richList(l, {
        rows: 1, items: () => [], active: () => -1,
        side: [
          { icon: 'ZOOMIN', tip: 'Add Empty Keying Set (not available in blender-web)', disabled: () => true },
          { icon: 'ZOOMOUT', tip: 'Remove Active Keying Set (not available in blender-web)', disabled: () => true },
        ],
      });
      const row = l.row();
      const c1 = row.column();
      c1.label('Keyframing Settings:', { disabled: true });
      c1.prop(naBool('Needed'));
      c1.prop(naBool('Visual Keying'));
      c1.prop(naBool('XYZ to RGB'));
    },
  });

  P.push({
    id: 'scene.color_management', label: 'Color Management',
    draw: (l) => {
      const col = l.column();
      col.label('Display:', { disabled: true });
      col.prop(naEnum('Display Device', ['sRGB']));
      const c2 = l.column();
      c2.separator();
      c2.label('Render:', { disabled: true });
      c2.prop(naEnum('View', ['Default', 'Filmic', 'Filmic Log', 'Raw', 'Log', 'False Color'], 'Default'));
      c2.prop(naEnum('Look', ['None']));
      const r = c2.row();
      r.prop(naFloat('Exposure', 0));
      r.prop(naFloat('Gamma', 1));
      c2.prop(naBool('Use Curves'));
      const c3 = l.column();
      c3.separator();
      c3.label('Sequencer:', { disabled: true });
      c3.prop(naEnum('Color Space', ['sRGB']));
    },
  });

  P.push({
    id: 'scene.audio', label: 'Audio', defaultClosed: true,
    draw: (l) => {
      l.prop(naFloat('Volume', 1), { slider: true });
      const sp = l.split();
      const c1 = sp.column();
      c1.label('Distance Model:', { disabled: true });
      c1.prop(naEnum('Distance Model', ['Inverse Clamped']), { noLabel: true });
      c1.prop(naFloat('Speed', 343.3));
      c1.prop(naFloat('Doppler', 1));
      const c2 = sp.column();
      c2.label('Format:', { disabled: true });
      c2.prop(naEnum('Channels', ['Stereo']), { noLabel: true });
      c2.prop(naEnum('Mixing Rate', ['48 kHz']), { noLabel: true });
      naButton(l, 'Update Animation Cache');
    },
  });

  P.push({
    id: 'scene.gravity', label: 'Gravity',
    drawHeader: (hl) => { hl.prop(bprop(scene, 'useGravity', { name: '', description: 'Use global gravity for all dynamics' }), { text: '' }); },
    draw: (l) => {
      activeWhen(l, () => !!app.scene?.useGravity);
      const col = l.column(true);
      for (let i = 0; i < 3; i++) {
        col.prop({
          kind: 'float', name: ['X', 'Y', 'Z'][i], unit: 'ACCELERATION', precision: 2, step: 0.1, description: 'Constant acceleration in a given direction',
          get: () => app.scene?.gravity?.[i] ?? 0,
          set: (v) => { const sc = app.scene; if (sc) sc.gravity[i] = v; },
        });
      }
    },
  });

  P.push({
    id: 'scene.rigidbody_world', label: 'Rigid Body World',
    drawHeader: (hl) => { hl.prop(naBool(''), { text: '' }); },
    draw: (l) => { naButton(l, 'Add Rigid Body World'); },
  });

  P.push({
    id: 'scene.simplify', label: 'Simplify', defaultClosed: true,
    drawHeader: (hl) => { hl.prop(naBool(''), { text: '' }); },
    draw: (l) => {
      const sp = l.split();
      const c1 = sp.column();
      c1.label('Viewport:', { disabled: true });
      c1.prop(naInt('Subdivision', 6));
      c1.prop(naFloat('Child Particles', 1));
      const c2 = sp.column();
      c2.label('Render:', { disabled: true });
      c2.prop(naInt('Subdivision', 6));
      c2.prop(naFloat('Child Particles', 1));
      c2.prop(naInt('Shadow Samples', 16));
      c2.prop(naFloat('AO and SSS', 1));
      c2.prop(naBool('Skip Quad to Triangles'));
    },
  });

  P.push({ id: 'scene.custom_props', label: 'Custom Properties', defaultClosed: true, draw: customPropsBody });
  return P;
}

function setPreset(system: UnitSettings['system']): void {
  const u = U();
  if (!u) return;
  u.system = system;
  u.scaleLength = 1;
  u.useSeparate = false;
  unitsChanged();
  app.pushUndo('Unit Presets');
  app.notify('scene', 'view');
}
