// Data tab > UV Maps panel (properties_data_mesh.py DATA_PT_uv_texture): the list of UV maps
// with the active map, the active render map (checkbox) and add / remove buttons.

import { app } from '../../app';
import type { Layout } from '../../ui/layout';
import { meshData, richList } from './common';
import { activeUVIndex, renderUVIndex } from '../../core/uvdata';

export function uvMapsPanel(l: Layout): void {
  richList(l, {
    rows: 2,
    items: () => (meshData()?.uvLayers ?? []).map((layer, i) => ({
      label: layer.name, icon: 'GROUP_UVS',
      check: {
        get: () => renderUVIndex(meshData()) === i,
        set: (v: boolean) => { const md = meshData(); if (md && v) { md.uvActiveRender = i; app.tagGeometry(md.id); } },
        tip: 'Set the map as active for rendering',
      },
    })),
    active: () => activeUVIndex(meshData()),
    setActive: (i) => { const md = meshData(); if (md) { md.uvActive = i; app.tagGeometry(md.id); app.pushUndo('Set Active UV Map'); } },
    rename: (i, name) => {
      const md = meshData();
      const layer = md?.uvLayers?.[i];
      if (!md || !layer) return;
      const names = new Set(md.uvLayers!.filter((x) => x !== layer).map((x) => x.name));
      let n = name;
      for (let k = 1; names.has(n); k++) n = `${name}.${String(k).padStart(3, '0')}`;
      layer.name = n;
    },
    side: [
      { icon: 'ZOOMIN', tip: 'Add UV Map', action: () => void app.callOperator('mesh.uv_texture_add'), disabled: () => !app.pollOperator('mesh.uv_texture_add') },
      { icon: 'ZOOMOUT', tip: 'Remove UV Map', action: () => void app.callOperator('mesh.uv_texture_remove'), disabled: () => !app.pollOperator('mesh.uv_texture_remove') },
    ],
  });
}
