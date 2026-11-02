// Camera data (properties_data_camera.py of Blender 2.79).

import type { CameraData } from '../../core/types';
import { bprop, eprop, fprop, type FloatProp, type PanelDef } from '../../ui/layout';
import {
  activeWhen, cameraData, customPropsBody, flatPanel, NA, naBool, naButton, naEnum, naFloat, naIdField, naInt, type PropsCtx,
} from './common';
import { objectDataTemplate } from './data_template';

const CAM = cameraData;

/** Sensor size Blender uses for the field of view (depends on the sensor fit). */
function sensorSize(c: CameraData): number {
  return c.sensorFit === 'VERTICAL' ? c.sensorHeight : c.sensorWidth;
}

/** Field of view <-> focal length, like `Camera.angle` in Blender. */
function fovProp(): FloatProp {
  return {
    kind: 'float', name: 'Field of View', unit: 'ROTATION', min: 0.00640536, max: 3.01675, step: Math.PI / 180, precision: 1,
    description: 'Camera lens field of view', notify: ['data'],
    get: () => { const c = CAM(); return c ? 2 * Math.atan(sensorSize(c) / (2 * Math.max(1e-6, c.lens))) : 0; },
    set: (v) => { const c = CAM(); if (c) c.lens = sensorSize(c) / (2 * Math.tan(Math.max(1e-6, v) / 2)); },
  };
}

export function cameraPanels(ctx: PropsCtx): PanelDef[] {
  void ctx;
  const P: PanelDef[] = [];
  P.push({ id: 'data.camera_context', label: '', noHeader: true, draw: (l) => { flatPanel(l); objectDataTemplate(l, 'cameras', 'CAMERA_DATA', 'Camera'); } });

  P.push({
    id: 'data.lens', label: 'Lens', key: () => `${CAM()?.lensType}${CAM()?.lensUnit}`,
    draw: (l) => {
      const c = CAM();
      l.row().prop(eprop(CAM, 'lensType', [
        { id: 'PERSP', label: 'Perspective' }, { id: 'ORTHO', label: 'Orthographic' },
        { id: 'PANO', label: 'Panoramic', disabled: true, description: NA },
      ], { name: 'Type', description: 'Camera types', notify: ['data'] }), { expand: true });
      const col = l.column();
      if (c?.lensType === 'ORTHO') {
        col.prop(fprop(CAM, 'orthoScale', { name: 'Orthographic Scale', min: 0, max: 100000, softMax: 1000, step: 0.1, precision: 3, description: 'Orthographic Camera scale (similar to zoom)', notify: ['data'] }));
      } else {
        const row = col.row();
        if (c?.lensUnit === 'FOV') row.prop(fovProp());
        else row.prop(fprop(CAM, 'lens', { name: 'Focal Length', min: 1, max: 5000, softMax: 5000, step: 1, precision: 3, unit: 'CAMERA', description: 'Perspective Camera lens value in millimeters', notify: ['data'] }));
        row.prop(eprop(CAM, 'lensUnit', [
          { id: 'MILLIMETERS', label: 'Millimeters', description: 'Specify the lens in millimeters' },
          { id: 'FOV', label: 'Field of View', description: 'Specify the lens as the field of view\'s angle' },
        ], { name: 'Lens Unit', description: 'Unit to edit lens in for the user interface', undo: false, notify: ['data'] }), { noLabel: true });
      }
      const sp2 = l.split();
      const a = sp2.column(true);
      a.label('Shift:');
      a.prop(fprop(CAM, 'shiftX', { name: 'X', min: -10, max: 10, softMin: -2, softMax: 2, step: 0.01, precision: 3, description: 'Camera horizontal shift', notify: ['data'] }));
      a.prop(fprop(CAM, 'shiftY', { name: 'Y', min: -10, max: 10, softMin: -2, softMax: 2, step: 0.01, precision: 3, description: 'Camera vertical shift', notify: ['data'] }));
      const b = sp2.column(true);
      b.label('Clipping:');
      b.prop(fprop(CAM, 'clipStart', { name: 'Start', min: 1e-6, unit: 'LENGTH', step: 0.1, precision: 3, description: 'Camera near clipping distance', notify: ['data'] }));
      b.prop(fprop(CAM, 'clipEnd', { name: 'End', min: 1e-6, unit: 'LENGTH', step: 1, precision: 3, description: 'Camera far clipping distance', notify: ['data'] }));
    },
  });

  P.push({
    id: 'data.camera', label: 'Camera', key: () => CAM()?.sensorFit ?? '',
    draw: (l) => {
      const pr = l.row(true);
      pr.prop(naEnum('Camera Presets', ['Camera Presets']), { noLabel: true });
      naButton(pr, '', 'ZOOMIN', true);
      naButton(pr, '', 'ZOOMOUT', true);
      l.label('Sensor:');
      const sp = l.split();
      const col = sp.column(true);
      const fit = CAM()?.sensorFit ?? 'AUTO';
      const sw = (name: string) => fprop(CAM, 'sensorWidth', { name, min: 1, max: 200, unit: 'CAMERA', step: 1, precision: 3, description: 'Horizontal size of the image sensor area in millimeters', notify: ['data'] });
      if (fit === 'AUTO') {
        col.prop(sw('Size'));
      } else {
        const a = col.column(true);
        activeWhen(a, () => CAM()?.sensorFit === 'HORIZONTAL');
        a.prop(sw('Width'));
        const b = col.column(true);
        activeWhen(b, () => CAM()?.sensorFit === 'VERTICAL');
        b.prop(fprop(CAM, 'sensorHeight', { name: 'Height', min: 1, max: 200, unit: 'CAMERA', step: 1, precision: 3, description: 'Vertical size of the image sensor area in millimeters', notify: ['data'] }));
      }
      sp.column(true).prop(eprop(CAM, 'sensorFit', [
        { id: 'AUTO', label: 'Auto', description: 'Fit to the sensor width or height depending on image resolution' },
        { id: 'HORIZONTAL', label: 'Horizontal', description: 'Fit to the sensor width' },
        { id: 'VERTICAL', label: 'Vertical', description: 'Fit to the sensor height' },
      ], { name: 'Sensor Fit', description: 'Method to fit image and field of view angle inside the sensor', notify: ['data'] }), { noLabel: true });
    },
  });

  P.push({
    id: 'data.camera_dof', label: 'Depth of Field',
    draw: (l) => {
      const sp = l.split();
      const c1 = sp.column();
      c1.label('Focus:');
      naIdField(c1, '');
      c1.prop(fprop(CAM, 'dofDistance', { name: 'Distance', min: 0, max: 5000, unit: 'LENGTH', step: 0.1, precision: 3, description: 'Distance to the focus point for depth of field' }));
      const c2 = sp.column(true);
      c2.label('Viewport:', { disabled: true });
      c2.prop(naBool('High Quality'));
      c2.prop(naFloat('F-stop', 128, { precision: 1 }));
    },
  });

  P.push({
    id: 'data.camera_display', label: 'Display',
    draw: (l) => {
      const sp = l.split();
      const c1 = sp.column();
      c1.prop(bprop(CAM, 'showLimits', { name: 'Limits', description: 'Draw the clipping range and focus point on the camera', notify: ['data'] }));
      c1.prop(naBool('Mist'));
      c1.prop(bprop(CAM, 'showSensor', { name: 'Sensor', description: 'Show sensor size (film gate) in Camera view', notify: ['data'] }));
      c1.prop(bprop(CAM, 'showName', { name: 'Name', description: 'Show the active Camera\'s name in Camera view', notify: ['data'] }));
      const c2 = sp.column();
      c2.prop(naEnum('Composition Guides', ['Composition Guides']), { noLabel: true });
      c2.prop(fprop(CAM, 'drawSize', { name: 'Size', min: 0.01, max: 1000, softMax: 10, unit: 'LENGTH', step: 0.1, precision: 3, description: 'Apparent size of the Camera object in the 3D View', notify: ['data'] }));
      c2.separator();
      c2.prop(bprop(CAM, 'showPassepartout', { name: 'Passepartout', description: 'Show a darkened overlay outside the image area in Camera view', notify: ['data'] }));
      const s = c2.column();
      activeWhen(s, () => !!CAM()?.showPassepartout);
      s.prop(fprop(CAM, 'passepartoutAlpha', { name: 'Alpha', min: 0, max: 1, step: 0.1, precision: 3, description: 'Opacity (alpha) of the darkened overlay in Camera view', notify: ['data'] }), { slider: true });
    },
  });

  P.push({
    id: 'data.camera_safe_areas', label: 'Safe Areas', defaultClosed: true,
    drawHeader: (hl) => { hl.prop(naBool(''), { text: '' }); },
    draw: (l) => {
      const sp = l.split();
      const c1 = sp.column(true);
      c1.label('Title Safe:', { disabled: true });
      c1.prop(naFloat('X', 0.1));
      c1.prop(naFloat('Y', 0.05));
      const c2 = sp.column(true);
      c2.label('Action Safe:', { disabled: true });
      c2.prop(naFloat('X', 0.035));
      c2.prop(naFloat('Y', 0.035));
      l.prop(naInt('Center-Cut Safe Areas', 0));
    },
  });

  P.push({ id: 'data.camera_custom_props', label: 'Custom Properties', defaultClosed: true, draw: customPropsBody });
  return P;
}
