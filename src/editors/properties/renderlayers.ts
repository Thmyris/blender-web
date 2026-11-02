// Render Layers context (properties_render_layer.py of Blender 2.79). blender-web has a
// single implicit render layer; only the scene layers are functional.

import { app } from '../../app';
import { NUM_LAYERS } from '../../core/scene';
import type { Layout, PanelDef } from '../../ui/layout';
import { flatPanel, naBool, naButton, naIdField, richList, type PropsCtx } from './common';

/** Display-only layer grid (render layer layers, exclude and mask layers are not modelled). */
function staticLayers(l: Layout, value: boolean[]): void {
  const el = l.layers(() => value, () => {});
  el.style.opacity = '0.5';
  el.style.pointerEvents = 'none';
}

const allLayers = () => new Array(NUM_LAYERS).fill(true);
const noLayers = () => new Array(NUM_LAYERS).fill(false);

export function renderLayerPanels(ctx: PropsCtx): PanelDef[] {
  void ctx;
  const P: PanelDef[] = [];

  P.push({
    id: 'rl.layers', label: 'Layers', noHeader: true,
    draw: (l) => {
      flatPanel(l);
      richList(l, {
        rows: 2,
        items: () => [{ label: 'RenderLayer', icon: 'RENDERLAYERS', check: { get: () => true, set: () => {}, disabled: true, tip: 'Enable or disable rendering of this layer (always enabled in blender-web)' } }],
        active: () => 0,
        side: [
          { icon: 'ZOOMIN', tip: 'Add a render layer (not available in blender-web)', disabled: () => true },
          { icon: 'ZOOMOUT', tip: 'Remove the selected render layer (not available in blender-web)', disabled: () => true },
          { icon: 'RESTRICT_RENDER_OFF', tip: 'Single Layer: only render this layer (not available in blender-web)', disabled: () => true, gap: true },
        ],
      });
    },
  });

  P.push({
    id: 'rl.layer_options', label: 'Layer',
    draw: (l) => {
      const sp = l.split();
      const c1 = sp.column();
      c1.label('Scene:');
      // the scene layers grid is functional (same data as the 3D View header)
      c1.layers(() => app.scene?.layers ?? [], (next) => {
        const sc = app.scene;
        if (!sc) return;
        sc.layers = next;
        app.pushUndo('Change Scene Layers');
        app.notify('scene', 'select');
      }, {
        used: () => { const u = new Array(NUM_LAYERS).fill(false); for (const o of app.objects()) o.layers.forEach((v, i) => { if (v) u[i] = true; }); return u; },
        activeOb: () => app.activeObject?.layers ?? [],
      });
      c1.label('');
      naIdField(c1, 'Lights', 'LAMP_DATA');
      naIdField(c1, 'Material', 'MATERIAL');
      const c2 = sp.column();
      c2.label('Layer:', { disabled: true });
      staticLayers(c2, allLayers());
      c2.label('Exclude:', { disabled: true });
      staticLayers(c2, noLayers());
      c2.label('Mask Layers:', { disabled: true });
      staticLayers(c2, noLayers());

      l.separator();
      l.label('Include:', { disabled: true });
      const sp2 = l.split(1 / 3);
      const a = sp2.column();
      a.prop(naBool('Use Z-Mask'));
      a.prop(naBool('Negate'));
      a.prop(naBool('All Z'));
      const b = sp2.column();
      b.prop(naBool('Solid', true));
      b.prop(naBool('Halo', true));
      b.prop(naBool('ZTransp', true));
      const c = sp2.column();
      c.prop(naBool('Sky', true));
      c.prop(naBool('Edge', true));
      c.prop(naBool('Strand', true));
      c.prop(naBool('Freestyle', true));
    },
  });

  P.push({
    id: 'rl.passes', label: 'Passes',
    draw: (l) => {
      const sp = l.split();
      const c1 = sp.column();
      for (const [n, v] of [['Combined', true], ['Z', true], ['Vector', false], ['Normal', false], ['UV', false], ['Mist', false], ['Object Index', false], ['Material Index', false], ['Color', false]] as [string, boolean][]) c1.prop(naBool(n, v));
      const c2 = sp.column();
      c2.prop(naBool('Diffuse'));
      for (const n of ['Specular', 'Shadow', 'Emit', 'AO', 'Environment', 'Indirect', 'Reflection', 'Refraction']) {
        const r = c2.row();
        r.prop(naBool(n));
        r.prop(naBool(`Exclude ${n}`), { iconOnly: true, icon: 'RESTRICT_RENDER_OFF', iconOn: 'RESTRICT_RENDER_ON' }).classList.add('fixed');
      }
    },
  });

  P.push({
    id: 'rl.views', label: 'Views', defaultClosed: true,
    drawHeader: (l) => { l.prop(naBool(''), { text: '' }); },
    draw: (l) => {
      l.row().prop({ kind: 'enum', name: 'Setup Stereo Mode', items: [{ id: 'STEREO_3D', label: 'Stereo 3D' }, { id: 'MULTIVIEW', label: 'Multi-View' }], get: () => 'STEREO_3D', set: () => {}, disabled: () => true, undo: false }, { expand: true });
      naButton(l, 'Views are not available in blender-web');
    },
  });

  return P;
}
