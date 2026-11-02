// Lamp data (properties_data_lamp.py of Blender 2.79, Blender Internal).

import { bprop, cprop, eprop, fprop, iprop, type PanelDef } from '../../ui/layout';
import {
  activeWhen, customPropsBody, flatPanel, lampData, NA, naBool, naEnum, naFloat, naInt, type PropsCtx,
} from './common';
import { objectDataTemplate } from './data_template';
import { drawLampPreview, lampPreviewKey, previewCanvas } from './preview';

const LA = lampData;
const type = () => LA()?.lampType ?? 'POINT';

export function lampPanels(ctx: PropsCtx): PanelDef[] {
  void ctx;
  const P: PanelDef[] = [];
  const t = type();
  const shadow = LA()?.shadow ?? 'NOSHADOW';

  P.push({ id: 'data.lamp_context', label: '', noHeader: true, draw: (l) => { flatPanel(l); objectDataTemplate(l, 'lamps', 'LAMP_DATA', 'Lamp'); } });

  P.push({
    id: 'data.lamp_preview', label: 'Preview',
    draw: (l) => { previewCanvas(l, () => lampPreviewKey(LA()), (c) => { const la = LA(); if (la) drawLampPreview(c, la); }, 150); },
  });

  P.push({
    id: 'data.lamp', label: 'Lamp', key: () => `${type()}`,
    draw: (l) => {
      l.row().prop(eprop(LA, 'lampType', [
        { id: 'POINT', label: 'Point', icon: 'LAMP_POINT', description: 'Omnidirectional point light source' },
        { id: 'SUN', label: 'Sun', icon: 'LAMP_SUN', description: 'Constant direction parallel ray light source' },
        { id: 'SPOT', label: 'Spot', icon: 'LAMP_SPOT', description: 'Directional cone light source' },
        { id: 'HEMI', label: 'Hemi', icon: 'LAMP_HEMI', description: '180 degree constant light source' },
        { id: 'AREA', label: 'Area', icon: 'LAMP_AREA', description: 'Directional area light source' },
      ], { name: 'Type', description: 'Type of Lamp', notify: ['data'] }), { expand: true });
      const sp = l.split();
      const col = sp.column();
      col.prop(cprop(LA, 'color', { name: 'Color', description: 'Light color', notify: ['data'] }), { text: '' });
      col.prop(fprop(LA, 'energy', { name: 'Energy', min: -1e6, max: 1e6, softMin: 0, softMax: 10, step: 0.1, precision: 3, description: 'Amount of light that the lamp emits', notify: ['data'] }));
      if (t === 'POINT' || t === 'SPOT') {
        col.label('Falloff:');
        col.prop(eprop(LA, 'falloff', [
          { id: 'CONSTANT', label: 'Constant' }, { id: 'INVERSE_LINEAR', label: 'Inverse Linear' }, { id: 'INVERSE_SQUARE', label: 'Inverse Square' },
          { id: 'INVERSE_COEFFICIENTS', label: 'Inverse Coefficients', disabled: true, description: NA },
          { id: 'CUSTOM_CURVE', label: 'Custom Curve', disabled: true, description: NA },
          { id: 'LINEAR_QUADRATIC_WEIGHTED', label: 'Lin/Quad Weighted', disabled: true, description: NA },
        ], { name: 'Falloff', description: 'Intensity Decay with distance', notify: ['data'] }), { noLabel: true });
        col.prop(fprop(LA, 'distance', { name: 'Distance', min: 0, max: 1e6, softMax: 1000, unit: 'LENGTH', step: 0.1, precision: 3, description: 'Falloff distance - the light is at half the original intensity at this point', notify: ['data'] }));
        col.prop(bprop(LA, 'useSphere', { name: 'Sphere', description: 'Set light intensity to zero beyond lamp distance', notify: ['data'] }));
      }
      if (t === 'AREA') {
        col.prop(fprop(LA, 'distance', { name: 'Distance', min: 0, max: 1e6, softMax: 1000, unit: 'LENGTH', step: 0.1, precision: 3, description: 'Falloff distance', notify: ['data'] }));
        col.prop(naFloat('Gamma', 1));
      }
      const c2 = sp.column();
      c2.prop(bprop(LA, 'useNegative', { name: 'Negative', description: 'Cast negative light', notify: ['data'] }));
      c2.prop(bprop(LA, 'useOwnLayer', { name: 'This Layer Only', description: 'Illuminate objects only on the same layers the lamp is on', notify: ['data'] }));
      c2.prop(bprop(LA, 'useSpecular', { name: 'Specular', description: 'Create specular highlights', notify: ['data'] }));
      c2.prop(bprop(LA, 'useDiffuse', { name: 'Diffuse', description: 'Do diffuse shading', notify: ['data'] }));
    },
  });

  if (t === 'SUN') {
    P.push({
      id: 'data.lamp_sky', label: 'Sky & Atmosphere',
      draw: (l) => {
        const row = l.row();
        row.prop(naBool('Sky'));
        row.prop(naBool('Atmosphere'));
        if (LA()?.sunSize !== undefined) {
          l.prop(fprop(LA, 'sunSize', { name: 'Sun Size', min: 0, softMax: 10, step: 0.1, precision: 3, description: 'Sun size' }));
        }
      },
    });
  }

  if (t !== 'HEMI') {
    P.push({
      id: 'data.lamp_shadow', label: 'Shadow', key: () => `${type()}${LA()?.shadow}`,
      draw: (l) => {
        l.row().prop(eprop(LA, 'shadow', [
          { id: 'NOSHADOW', label: 'No Shadow' },
          ...(t === 'SPOT' ? [{ id: 'BUFFER_SHADOW', label: 'Buffer Shadow', disabled: true, description: NA }] : []),
          { id: 'RAY_SHADOW', label: 'Ray Shadow' },
        ], { name: 'Shadow Method', notify: ['data'] }), { expand: true });
        if (shadow === 'NOSHADOW' && t === 'AREA') {
          const sp = l.split();
          const c = sp.column();
          c.label('Form factor sampling:', { disabled: true });
          c.prop(naInt('Samples', 1));
        }
        if (shadow !== 'NOSHADOW') {
          const sp = l.split();
          sp.column().prop(cprop(LA, 'shadowColor', { name: 'Shadow Color', description: 'Color of shadows cast by the lamp', notify: ['data'] }), { text: '' });
          const c2 = sp.column();
          c2.prop(naBool('This Layer Only'));
          c2.prop(naBool('Only Shadow'));
        }
        if (shadow === 'RAY_SHADOW') {
          const sp = l.split();
          const col = sp.column();
          col.label('Sampling:');
          if (t === 'AREA') {
            const sub = col.row(true);
            sub.prop(iprop(LA, 'shadowSamples', { name: 'Samples', min: 1, max: 64, description: 'Number of samples taken extra (samples x samples)' }));
            const r = col.row();
            r.prop(naEnum('Shadow Sample Method', ['Adaptive QMC', 'Constant QMC', 'Constant Jittered'], 'Constant Jittered'), { expand: true });
          } else {
            const sub = col.row();
            sub.prop(iprop(LA, 'shadowSamples', { name: 'Samples', min: 1, max: 64, description: 'Number of shadow samples (samples x samples)' }));
            sub.prop(fprop(LA, 'shadowSoftSize', { name: 'Soft Size', min: 0, max: 100, unit: 'LENGTH', step: 0.1, precision: 3, description: 'Light size for ray shadow sampling (Raytraced shadows)', notify: ['data'] }));
            col.row().prop(naEnum('Shadow Sample Method', ['Adaptive QMC', 'Constant QMC'], 'Adaptive QMC'), { expand: true });
            l.prop(naFloat('Threshold', 0.001));
          }
        }
      },
    });
  }

  if (t === 'AREA') {
    P.push({
      id: 'data.lamp_area', label: 'Area Shape', key: () => LA()?.areaShape ?? '',
      draw: (l) => {
        const col = l.column();
        col.row().prop(eprop(LA, 'areaShape', [{ id: 'SQUARE', label: 'Square' }, { id: 'RECTANGLE', label: 'Rectangle' }], { name: 'Shape', description: 'Shape of the area lamp', notify: ['data'] }), { expand: true });
        const sub = col.row(true);
        if (LA()?.areaShape === 'RECTANGLE') {
          sub.prop(fprop(LA, 'areaSize', { name: 'Size X', min: 0, unit: 'LENGTH', step: 0.1, precision: 3, description: 'Size of the area of the area Lamp, X direction size for Rectangle shapes', notify: ['data'] }));
          sub.prop(fprop(LA, 'areaSizeY', { name: 'Size Y', min: 0, unit: 'LENGTH', step: 0.1, precision: 3, description: 'Size of the area of the area Lamp in the Y direction for Rectangle shapes', notify: ['data'] }));
        } else {
          sub.prop(fprop(LA, 'areaSize', { name: 'Size', min: 0, unit: 'LENGTH', step: 0.1, precision: 3, description: 'Size of the area of the area Lamp', notify: ['data'] }));
        }
      },
    });
  }

  if (t === 'SPOT') {
    P.push({
      id: 'data.lamp_spot', label: 'Spot Shape',
      draw: (l) => {
        const sp = l.split();
        const c1 = sp.column();
        c1.prop(fprop(LA, 'spotSize', { name: 'Size', min: (1 * Math.PI) / 180, max: Math.PI, unit: 'ROTATION', step: Math.PI / 180, precision: 1, description: 'Angle of the spotlight beam', notify: ['data'] }));
        c1.prop(fprop(LA, 'spotBlend', { name: 'Blend', min: 0, max: 1, step: 0.01, precision: 3, description: 'The softness of the spotlight edge', notify: ['data'] }), { slider: true });
        c1.prop(bprop(LA, 'useSquare', { name: 'Square', description: 'Cast a square spot light shape', notify: ['data'] }));
        c1.prop(bprop(LA, 'showCone', { name: 'Show Cone', description: 'Draw transparent cone in 3D view to visualize which objects are contained in it', notify: ['data'] }));
        const c2 = sp.column();
        c2.prop(bprop(LA, 'useHalo', { name: 'Halo', description: 'Render spotlight with a volumetric halo (stored; not rendered by blender-web)' }));
        const s = c2.column(true);
        activeWhen(s, () => !!LA()?.useHalo);
        s.prop(naFloat('Intensity', 1));
      },
    });
  }

  P.push({ id: 'data.lamp_custom_props', label: 'Custom Properties', defaultClosed: true, draw: customPropsBody });
  return P;
}
