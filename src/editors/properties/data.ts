// Object Data context: mesh (properties_data_mesh.py) and empty (properties_data_empty.py)
// of Blender 2.79, plus the shared object-data ID template. Camera and lamp data live in
// data_camera.ts / data_lamp.ts.

import { app } from '../../app';
import { bprop, eprop, fprop, type Layout, type PanelDef } from '../../ui/layout';
import {
  activeWhen, customPropsBody, flatPanel, meshData, NA, naBool, naButton, naFloat, naString, ob, richList, type PropsCtx,
} from './common';
import { objectDataTemplate } from './data_template';
import { cameraPanels } from './data_camera';
import { lampPanels } from './data_lamp';

function emptyList(l: Layout, rows: number, side: { icon: string; tip: string }[]): void {
  richList(l, { rows, items: () => [], active: () => -1, side: side.map((s) => ({ ...s, tip: `${s.tip} (not available in blender-web)`, disabled: () => true })) });
}

const geomChanged = () => app.tagGeometry(meshData()?.id);

function meshPanels(): PanelDef[] {
  const P: PanelDef[] = [];
  P.push({ id: 'data.mesh_context', label: '', noHeader: true, draw: (l) => { flatPanel(l); objectDataTemplate(l, 'meshes', 'MESH_DATA', 'Mesh'); } });

  P.push({
    id: 'data.normals', label: 'Normals',
    draw: (l) => {
      const sp = l.split();
      const c1 = sp.column();
      c1.prop(bprop(meshData, 'autoSmooth', { name: 'Auto Smooth', description: 'Auto smooth (based on smooth/sharp faces/edges and angle between faces)', notify: ['geometry'], onChange: geomChanged }));
      const s = c1.column();
      activeWhen(s, () => !!meshData()?.autoSmooth);
      s.prop(fprop(meshData, 'autoSmoothAngle', { name: 'Angle', min: 0, max: Math.PI, unit: 'ROTATION', step: Math.PI / 180, description: 'Maximum angle between face normals that \'Auto Smooth\' will operate on', notify: ['geometry'], onChange: geomChanged }));
      sp.column().prop(bprop(meshData, 'doubleSided', { name: 'Double Sided', description: 'Display the mesh with double or single sided lighting (OpenGL only)', notify: ['geometry'], onChange: geomChanged }));
    },
  });

  P.push({
    id: 'data.texture_space', label: 'Texture Space', defaultClosed: true,
    draw: (l) => {
      l.prop(naString('Texture Mesh'), {});
      l.separator();
      l.prop(naBool('Auto Texture Space', true));
      const row = l.row();
      row.el.style.alignItems = 'flex-start';
      for (const label of ['Location', 'Size']) {
        const c = row.column(true);
        c.label(`${label}:`, { disabled: true });
        for (const ax of ['X', 'Y', 'Z']) c.prop(naFloat(ax, label === 'Size' ? 1 : 0, { unit: 'LENGTH' }));
      }
    },
  });

  P.push({ id: 'data.vertex_groups', label: 'Vertex Groups', draw: (l) => emptyList(l, 2, [{ icon: 'ZOOMIN', tip: 'Add a new vertex group' }, { icon: 'ZOOMOUT', tip: 'Delete the active vertex group' }, { icon: 'DOWNARROW_HLT', tip: 'Vertex Group Specials' }]) });
  P.push({
    id: 'data.shape_keys', label: 'Shape Keys',
    draw: (l) => {
      emptyList(l, 2, [{ icon: 'ZOOMIN', tip: 'Add shape key to the object' }, { icon: 'ZOOMOUT', tip: 'Remove shape key from the object' }, { icon: 'DOWNARROW_HLT', tip: 'Shape Key Specials' }]);
    },
  });
  P.push({ id: 'data.uv_maps', label: 'UV Maps', draw: (l) => emptyList(l, 2, [{ icon: 'ZOOMIN', tip: 'Add UV Map' }, { icon: 'ZOOMOUT', tip: 'Remove UV Map' }]) });
  P.push({ id: 'data.vertex_colors', label: 'Vertex Colors', draw: (l) => emptyList(l, 2, [{ icon: 'ZOOMIN', tip: 'Add vertex color layer' }, { icon: 'ZOOMOUT', tip: 'Remove vertex color layer' }]) });

  P.push({
    id: 'data.customdata', label: 'Geometry Data',
    draw: (l) => {
      const col = l.column();
      naButton(col, 'Clear Sculpt-Mask Data', 'X');
      naButton(col, 'Clear Skin Data', 'X');
      naButton(col, 'Add Custom Split Normals Data', 'ZOOMIN');
      const c2 = l.column();
      c2.prop(naBool('Store Vertex Bevel Weight'));
      c2.prop(naBool('Store Edge Bevel Weight'));
      c2.prop(naBool('Store Edge Crease'));
    },
  });

  P.push({ id: 'data.custom_props', label: 'Custom Properties', defaultClosed: true, draw: customPropsBody });
  return P;
}

function emptyPanels(): PanelDef[] {
  return [{
    id: 'data.empty', label: 'Empty',
    draw: (l) => {
      l.prop(eprop(ob, 'emptyDrawType', [
        { id: 'PLAIN_AXES', label: 'Plain Axes' }, { id: 'ARROWS', label: 'Arrows' }, { id: 'SINGLE_ARROW', label: 'Single Arrow' },
        { id: 'CIRCLE', label: 'Circle' }, { id: 'CUBE', label: 'Cube' }, { id: 'SPHERE', label: 'Sphere' }, { id: 'CONE', label: 'Cone' },
        { id: 'IMAGE', label: 'Image', disabled: true, description: NA },
      ], { name: 'Display', description: 'Viewport display style for empties', notify: ['data'] }));
      l.prop(fprop(ob, 'emptyDrawSize', { name: 'Size', min: 0.0001, max: 1000, unit: 'LENGTH', step: 0.1, description: 'Size of display in the viewport', notify: ['data'] }));
    },
  }];
}

export function dataPanels(ctx: PropsCtx): PanelDef[] {
  switch (ob()?.type) {
    case 'MESH': return meshPanels();
    case 'CAMERA': return cameraPanels(ctx);
    case 'LAMP': return lampPanels(ctx);
    case 'EMPTY': return emptyPanels();
    default: return [];
  }
}
