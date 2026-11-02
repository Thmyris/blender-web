// Particles and Physics contexts (properties_particle.py / properties_physics_common.py
// of Blender 2.79). Emitter particle systems are supported; physics simulations are not,
// so the Physics tab shows its buttons disabled.

import type { Layout, PanelDef } from '../../ui/layout';
import { flatPanel, NA, naButton, naTooltip, ob, richList, type PropsCtx } from './common';
import { app } from '../../app';
import { fprop, iprop, bprop } from '../../ui/layout';
import type { ParticleSystem } from '../../core/types';

export function particlePanels(ctx: PropsCtx): PanelDef[] {
  void ctx;
  const psys = () => {
    const o = ob();
    if (!o?.particleSystems?.length) return null;
    return o.particleSystems[Math.min(o.activeParticleSystem ?? 0, o.particleSystems.length - 1)] ?? null;
  };
  const has = () => !!psys();
  const P = <K extends keyof ParticleSystem>(key: K) => (() => psys()) as () => unknown;
  const num = (l: Layout, key: keyof ParticleSystem, name: string, o: { min?: number; max?: number; int?: boolean; step?: number; unit?: 'LENGTH' | 'NONE'; description?: string } = {}) =>
    l.prop(o.int ? iprop(P(key), key, { name, min: o.min, max: o.max, description: o.description }) : fprop(P(key), key, { name, min: o.min, max: o.max, step: o.step ?? 0.1, precision: 3, unit: o.unit, description: o.description }));
  return [
    {
      id: 'particles.context', label: '', noHeader: true, key: () => `${ob()?.particleSystems?.length ?? 0}`,
      draw: (l) => {
        flatPanel(l);
        richList(l, {
          rows: 3,
          items: () => (ob()?.particleSystems ?? []).map((p) => ({ label: p.name, icon: 'PARTICLES' })),
          active: () => ob()?.activeParticleSystem ?? 0,
          setActive: (i) => { const o = ob(); if (o) o.activeParticleSystem = i; },
          rename: (i, name) => { const o = ob(); if (o?.particleSystems[i]) o.particleSystems[i].name = name; },
          side: [
            { icon: 'ZOOMIN', tip: 'Add a particle system', action: () => void app.callOperator('object.particle_system_add', {}, { exec: true }) },
            { icon: 'ZOOMOUT', tip: 'Remove the selected particle system', disabled: () => !has(), action: () => void app.callOperator('object.particle_system_remove', {}, { exec: true }) },
          ],
        });
        if (!has()) return;
        const r = l.row();
        r.prop({ kind: 'enum', name: 'Type', items: [{ id: 'EMITTER', label: 'Emitter' }, { id: 'HAIR', label: 'Hair', disabled: true, description: 'Hair particles are not available in blender-web' }], get: () => 'EMITTER', set: () => {}, undo: false });
        r.prop(iprop(P('seed'), 'seed', { name: 'Seed', min: 0, description: 'Offset in the random number table, to get a different randomized result' }));
      },
    },
    {
      id: 'particles.emission', label: 'Emission', poll: has,
      draw: (l) => {
        const sp = l.split();
        const c1 = sp.column(true);
        num(c1, 'count', 'Number', { int: true, min: 0, max: 200000, description: 'Total number of particles' });
        num(c1, 'frameStart', 'Start', { min: -500000, max: 500000, step: 1, description: 'Frame number to start emitting particles' });
        num(c1, 'frameEnd', 'End', { min: -500000, max: 500000, step: 1, description: 'Frame number to stop emitting particles' });
        num(c1, 'lifetime', 'Lifetime', { min: 1, max: 500000, step: 1, description: 'Life span of the particles' });
        const c2 = sp.column();
        c2.label('Emit From:');
        c2.prop({ kind: 'enum', name: 'Emit From', items: [{ id: 'VERT', label: 'Verts' }, { id: 'FACE', label: 'Faces' }, { id: 'VOLUME', label: 'Volume', disabled: true }], get: () => psys()?.emitFrom ?? 'FACE', set: (v) => { const p = psys(); if (p) p.emitFrom = v as 'FACE'; }, description: 'Where to emit particles from' }, { expand: true });
      },
    },
    {
      id: 'particles.velocity', label: 'Velocity', poll: has,
      draw: (l) => {
        const sp = l.split();
        const c1 = sp.column(true);
        c1.label('Emitter Geometry:');
        num(c1, 'normalFactor', 'Normal', { min: -1000, max: 1000, unit: 'LENGTH', description: 'Let the surface normal give the particle a starting velocity' });
        const c2 = sp.column(true);
        c2.label('Other:');
        num(c2, 'randomFactor', 'Random', { min: 0, max: 200, description: 'Give the starting velocity a random variation' });
      },
    },
    {
      id: 'particles.physics', label: 'Physics', poll: has,
      draw: (l) => {
        l.prop({ kind: 'enum', name: 'Physics Type', items: [{ id: 'NO', label: 'No', disabled: true }, { id: 'NEWTON', label: 'Newtonian' }, { id: 'KEYED', label: 'Keyed', disabled: true }, { id: 'BOIDS', label: 'Boids', disabled: true }, { id: 'FLUID', label: 'Fluid', disabled: true }], get: () => 'NEWTON', set: () => {}, undo: false }, { expand: true });
        num(l, 'size', 'Size', { min: 0.001, max: 100000, step: 0.01, unit: 'LENGTH', description: 'The size of the particles' });
      },
    },
    {
      id: 'particles.display', label: 'Display', poll: has,
      draw: (l) => {
        const r = l.row();
        r.prop(bprop(P('showViewport'), 'showViewport', { name: 'Show in Viewport', notify: ['scene'] }));
        r.prop(bprop(P('showRender'), 'showRender', { name: 'Show in Render', notify: ['scene'] }));
        l.prop(iprop(P('displayPercentage'), 'displayPercentage', { name: 'Display', min: 0, max: 100, unit: 'PERCENTAGE', description: 'Percentage of particles to display in 3D view' }), { slider: true });
      },
    },
    {
      id: 'particles.fieldweights', label: 'Field Weights', poll: has, defaultClosed: true,
      draw: (l) => {
        num(l, 'gravity', 'Gravity', { min: -200, max: 200, step: 0.1, description: 'Global gravity weight' });
        l.label('Scene gravity is set in the Scene tab.');
      },
    },
  ];
}

function physicsButton(l: Layout, text: string, ic: string): void {
  const row = l.row(true);
  const b = naButton(row, text, ic);
  b.classList.add('left');
  naTooltip(b, text, `Enable ${text} physics: ${NA}`);
}

export function physicsPanels(ctx: PropsCtx): PanelDef[] {
  void ctx;
  return [{
    id: 'physics.add', label: '', noHeader: true, key: () => ob()?.type ?? '',
    draw: (l) => {
      flatPanel(l);
      const isMesh = ob()?.type === 'MESH';
      l.label('Enable physics for:');
      const sp = l.split();
      const c1 = sp.column();
      physicsButton(c1, 'Force Field', 'FORCE_FORCE');
      if (isMesh) {
        physicsButton(c1, 'Collision', 'MOD_PHYSICS');
        physicsButton(c1, 'Cloth', 'MOD_CLOTH');
        physicsButton(c1, 'Dynamic Paint', 'MOD_DYNAMICPAINT');
      }
      const c2 = sp.column();
      if (isMesh) {
        physicsButton(c2, 'Soft Body', 'MOD_SOFT');
        physicsButton(c2, 'Fluid', 'MOD_FLUIDSIM');
        physicsButton(c2, 'Smoke', 'MOD_SMOKE');
        physicsButton(c2, 'Rigid Body', 'MESH_ICOSPHERE');
      }
      physicsButton(c2, 'Rigid Body Constraint', 'CONSTRAINT');
    },
  }];
}
