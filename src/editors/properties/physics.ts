// Particles and Physics contexts (properties_particle.py / properties_physics_common.py
// of Blender 2.79). Neither simulation system exists in blender-web, so every control is
// shown disabled; the particle list still lists any particle systems stored on the object.

import type { Layout, PanelDef } from '../../ui/layout';
import { flatPanel, NA, naButton, naTooltip, ob, richList, type PropsCtx } from './common';

export function particlePanels(ctx: PropsCtx): PanelDef[] {
  void ctx;
  return [{
    id: 'particles.context', label: '', noHeader: true,
    draw: (l) => {
      flatPanel(l);
      richList(l, {
        rows: 1,
        items: () => (ob()?.particleSystems ?? []).map((p) => ({ label: p.name, icon: 'PARTICLES' })),
        active: () => 0,
        side: [
          { icon: 'ZOOMIN', tip: 'Add a particle system (not available in blender-web)', disabled: () => true },
          { icon: 'ZOOMOUT', tip: 'Remove the selected particle system (not available in blender-web)', disabled: () => true },
        ],
      });
      const note = l.label('Particle systems are not available in blender-web', { icon: 'INFO' });
      note.style.whiteSpace = 'normal';
    },
  }];
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
