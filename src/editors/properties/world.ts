// World context (properties_world.py of Blender 2.79, Blender Internal).

import { app } from '../../app';
import { createWorld, renameData } from '../../core/scene';
import { bprop, cprop, fprop, type PanelDef } from '../../ui/layout';
import {
  activeWhen, cloneJSON, colorBelow, customPropsBody, flatPanel, naBool, naEnum, naFloat, naInt, usersOf, worldData,
  type PropsCtx,
} from './common';
import { drawWorldPreview, previewCanvas, worldPreviewKey } from './preview';

const W = worldData;
const hasWorld = () => !!worldData();

export function worldPanels(ctx: PropsCtx): PanelDef[] {
  void ctx;
  const P: PanelDef[] = [];

  P.push({
    id: 'world.context', label: '', noHeader: true,
    draw: (l) => {
      flatPanel(l);
      const sp = l.split(0.85);
      sp.column().idTemplate({
        icon: 'WORLD', title: 'World',
        items: () => Object.values(app.doc.worlds).map((w) => ({ id: w.id, name: w.name, icon: 'WORLD' })),
        get: () => app.scene?.world ?? null,
        set: (id) => { if (app.scene) app.scene.world = id; },
        name: () => W()?.name ?? '',
        rename: (n) => { const w = W(); if (w) renameData(app.doc, 'worlds', w.id, n); },
        users: () => usersOf('worlds', app.scene?.world),
        fakeUser: { get: () => !!W()?.fakeUser, set: (v) => { const w = W(); if (w) w.fakeUser = v; } },
        onNew: () => {
          // Blender's world.new copies the current world
          const cur = W();
          const w = createWorld(app.doc, cur?.name ?? 'World');
          if (cur) Object.assign(w, cloneJSON({ ...cur, id: w.id, name: w.name, fakeUser: false }));
          if (app.scene) app.scene.world = w.id;
        },
        unlink: () => { if (app.scene) app.scene.world = null; },
      });
      // number of texture slots in use (world textures are not modelled)
      sp.column().label('0', { icon: 'TEXTURE' });
    },
  });

  P.push({
    id: 'world.preview', label: 'Preview', poll: hasWorld,
    draw: (l) => {
      previewCanvas(l, () => worldPreviewKey(W()), (c) => { const w = W(); if (w) drawWorldPreview(c, w); });
    },
  });

  P.push({
    id: 'world.world', label: 'World', poll: hasWorld,
    draw: (l) => {
      const row = l.row();
      row.prop(bprop(W, 'usePaperSky', { name: 'Paper Sky', description: 'Flatten blend or texture coordinates', notify: ['data'] }));
      row.prop(bprop(W, 'useBlendSky', { name: 'Blend Sky', description: 'Render background with natural progression from horizon to zenith', notify: ['data'] }));
      row.prop(bprop(W, 'useRealSky', { name: 'Real Sky', description: 'Render background with a real horizon, relative to the camera angle', notify: ['data'] }));
      const r2 = l.row();
      colorBelow(r2, 'Horizon Color', cprop(W, 'horizonColor', { name: 'Horizon Color', description: 'Color at the horizon', notify: ['data'] }));
      const zc = r2.column();
      activeWhen(zc, () => !!W()?.useBlendSky);
      colorBelow(zc, 'Zenith Color', cprop(W, 'zenithColor', { name: 'Zenith Color', description: 'Color at the zenith', notify: ['data'] }));
      colorBelow(r2, 'Ambient Color', cprop(W, 'ambientColor', { name: 'Ambient Color', description: 'Ambient color of the world', notify: ['data'] }));
      const r3 = l.row();
      r3.prop(fprop(W, 'exposure', { name: 'Exposure', min: -0.2, max: 1, precision: 3, step: 0.1, description: 'Amount of exponential color correction for light' }));
      r3.prop(fprop(W, 'colorRange', { name: 'Range', min: 0.2, max: 5, precision: 3, step: 0.1, description: 'The color range that will be mapped to 0-1' }));
    },
  });

  P.push({
    id: 'world.ao', label: 'Ambient Occlusion', poll: hasWorld,
    drawHeader: (hl) => { hl.prop(bprop(W, 'useAO', { name: '', description: 'Use Ambient Occlusion to add shadowing based on distance between objects' }), { text: '' }); },
    draw: (l) => {
      activeWhen(l, () => !!W()?.useAO);
      const sp = l.split();
      sp.column().prop(fprop(W, 'aoFactor', { name: 'Factor', min: 0, max: 5, precision: 3, step: 0.1, description: 'Factor for ambient occlusion blending' }));
      sp.column().prop(naEnum('Blend Type', ['Add', 'Multiply'], 'Add'), { noLabel: true });
    },
  });

  P.push({
    id: 'world.env_light', label: 'Environment Lighting', poll: hasWorld,
    drawHeader: (hl) => { hl.prop(bprop(W, 'useEnvLight', { name: '', description: 'Add light coming from the environment' }), { text: '' }); },
    draw: (l) => {
      activeWhen(l, () => !!W()?.useEnvLight);
      const sp = l.split();
      sp.column().prop(fprop(W, 'envEnergy', { name: 'Energy', min: 0, max: 100, softMax: 16, precision: 3, step: 0.1, description: 'Defines the strength of environment light' }));
      sp.column().prop(naEnum('Environment Color', ['White', 'Sky Color', 'Sky Texture'], 'White'), { noLabel: true });
    },
  });

  P.push({
    id: 'world.indirect', label: 'Indirect Lighting', poll: hasWorld,
    drawHeader: (hl) => { hl.prop(naBool(''), { text: '' }); },
    draw: (l) => {
      const sp = l.split();
      sp.column().prop(naFloat('Factor', 1));
      sp.column().prop(naInt('Bounces', 1));
      l.label('Only works with Approximate gather method', { disabled: true });
    },
  });

  P.push({
    id: 'world.gather', label: 'Gather', poll: hasWorld,
    draw: (l) => {
      l.row().prop(naEnum('Gather Method', ['Raytrace', 'Approximate']), { expand: true });
      const sp = l.split();
      const c1 = sp.column();
      c1.label('Attenuation:', { disabled: true });
      c1.prop(naFloat('Distance', 10));
      c1.prop(naBool('Falloff'));
      c1.prop(naFloat('Strength', 0));
      const c2 = sp.column();
      c2.label('Sampling:', { disabled: true });
      c2.prop(naEnum('Sample Method', ['Constant Jittered', 'Adaptive QMC', 'Constant QMC'], 'Adaptive QMC'), { noLabel: true });
      c2.prop(naInt('Samples', 5));
      c2.prop(naFloat('Threshold', 0.01));
      c2.prop(naFloat('Adapt To Speed', 0.02));
    },
  });

  P.push({
    id: 'world.mist', label: 'Mist', poll: hasWorld,
    drawHeader: (hl) => { hl.prop(bprop(W, 'useMist', { name: '', description: 'Occlude objects with the environment color as they are further away', notify: ['data'] }), { text: '' }); },
    draw: (l) => {
      activeWhen(l, () => !!W()?.useMist);
      const sp = l.split();
      const c1 = sp.column();
      c1.prop(fprop(W, 'mistIntensity', { name: 'Minimum', min: 0, max: 1, precision: 3, description: 'Overall minimum intensity of the mist effect', notify: ['data'] }), { slider: true });
      c1.prop(fprop(W, 'mistStart', { name: 'Start', min: 0, max: 10000, softMax: 1000, unit: 'LENGTH', precision: 3, description: 'Starting distance of the mist, measured from the camera', notify: ['data'] }));
      const c2 = sp.column();
      c2.prop(fprop(W, 'mistDepth', { name: 'Depth', min: 0, max: 100000, softMax: 1000, unit: 'LENGTH', precision: 3, description: 'Distance over which the mist effect fades in', notify: ['data'] }));
      c2.prop(naFloat('Height', 0, { unit: 'LENGTH' }));
      l.prop(naEnum('Falloff', ['Quadratic', 'Linear', 'Inverse Quadratic'], 'Quadratic'));
    },
  });

  P.push({
    id: 'world.stars', label: 'Stars', poll: hasWorld,
    drawHeader: (hl) => { hl.prop(bprop(W, 'useStars', { name: '', description: 'Enable starfield generation (not rendered by blender-web)' }), { text: '' }); },
    draw: (l) => {
      activeWhen(l, () => !!W()?.useStars);
      const sp = l.split();
      const c1 = sp.column();
      c1.prop(naFloat('Size', 2));
      c1.prop(naFloat('Colors', 0));
      const c2 = sp.column();
      c2.prop(naFloat('Min. Dist', 0.5));
      c2.prop(naFloat('Separation', 15));
    },
  });

  P.push({ id: 'world.custom_props', label: 'Custom Properties', defaultClosed: true, poll: hasWorld, draw: customPropsBody });
  return P;
}
