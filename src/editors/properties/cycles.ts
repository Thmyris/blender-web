// Properties editor panels shown when the render engine is Cycles (the Cycles add-on's
// properties.py / ui.py of Blender 2.79): Render (device, sampling, light paths, film,
// performance, ...), Render Layers > Denoising, Material (Surface node view, Settings),
// World (Surface, Ambient Occlusion, Ray Visibility, Settings) and Lamp (Lamp, Nodes, Spot Shape).

import { app } from '../../app';
import type { Color3, CyclesShader, CyclesShaderType, MaterialData } from '../../core/types';
import { bprop, cprop, eprop, fprop, iprop, type EnumItem, type Layout, type PanelDef } from '../../ui/layout';
import type { MenuItem } from '../../ui/menu';
import {
  defaultShader, derivedLampStrength, enableMaterialNodes, ensureLampSettings, ensureMaterialSettings, ensureSceneSettings, ensureWorldSettings,
  isCycles,
} from '../../render/cycles/settings';
import {
  activeMaterial, activeWhen, commitEdit, lampData, NA, naBool, naButton, naEnum, naFloat, naInt, worldData, type PropsCtx,
} from './common';

const C = () => (app.scene ? ensureSceneSettings(app.scene) : null);
const R = () => app.scene?.render ?? null;
const pick = (panels: PanelDef[], ...ids: string[]): PanelDef[] =>
  ids.map((id) => panels.find((p) => p.id === id)).filter((p): p is PanelDef => !!p);

/**
 * Wrap the panels of a Properties context: with Cycles as the render engine, the Cycles panels
 * replace the Blender Internal ones (the shared ones, like Dimensions, are reused).
 */
export function cyclesPanels(context: 'RENDER' | 'RENDER_LAYER' | 'WORLD' | 'DATA' | 'MATERIAL', bi: (ctx: PropsCtx) => PanelDef[]): (ctx: PropsCtx) => PanelDef[] {
  return (ctx) => {
    const panels = bi(ctx);
    if (!isCycles(app.scene)) return panels;
    switch (context) {
      case 'RENDER': return renderPanels(panels);
      case 'RENDER_LAYER': return [...panels, denoisingPanel()];
      case 'WORLD': return worldPanels(panels);
      case 'MATERIAL': return materialPanels(panels);
      case 'DATA': return app.activeObject?.type === 'LAMP' ? lampPanels(panels) : panels;
    }
  };
}

// ------------------------------------------------------------------ render

function presets(l: Layout, label: string): void {
  const row = l.row(true);
  row.prop(naEnum(label, [label]), { noLabel: true });
  naButton(row, '', 'ZOOMIN', true);
  naButton(row, '', 'ZOOMOUT', true);
}

function renderPanels(bi: PanelDef[]): PanelDef[] {
  const P: PanelDef[] = [];
  const [render, ...shared] = pick(bi, 'render.render', 'render.dimensions', 'render.stamp', 'render.output', 'render.freestyle');
  if (render) {
    P.push({
      ...render,
      draw: (l) => {
        render.draw(l);
        l.prop(eprop(C, 'featureSet', [
          { id: 'SUPPORTED', label: 'Supported', description: 'Only use finished and supported features' },
          { id: 'EXPERIMENTAL', label: 'Experimental', disabled: true, description: `Use experimental and incomplete features: ${NA}` },
        ], { name: 'Feature Set', description: 'Feature set to use for rendering', python: 'bpy.context.scene.cycles.feature_set' }));
        const sp = l.split(1 / 3);
        sp.column().label('Device:');
        sp.column().prop(eprop(C, 'device', [
          { id: 'CPU', label: 'CPU', disabled: true, description: 'Use CPU for rendering (blender-web always renders on the GPU through WebGL 2)' },
          { id: 'GPU', label: 'GPU Compute', description: 'Use GPU compute device for rendering (WebGL 2)' },
        ], { name: 'Device', description: 'Device to use for rendering', python: 'bpy.context.scene.cycles.device' }), { noLabel: true });
      },
    });
  }
  P.push(...shared);

  P.push({
    id: 'cycles.sampling', label: 'Sampling', key: () => `${C()?.useSquareSamples}`,
    draw: (l) => {
      presets(l, 'Sampling Presets');
      const row = l.row();
      row.prop(eprop(C, 'progressive', [
        { id: 'BRANCHED_PATH', label: 'Branched Path Tracing', disabled: true, description: `Path tracing integrator that branches on the first bounce: ${NA}` },
        { id: 'PATH', label: 'Path Tracing', description: 'Pure path tracing integrator' },
      ], { name: 'Integrator', description: 'Method to sample lights and materials', python: 'bpy.context.scene.cycles.progressive' }), { noLabel: true });
      row.prop(bprop(C, 'useSquareSamples', { name: 'Square Samples', description: 'Square sampling values for easier artist control', python: 'bpy.context.scene.cycles.use_square_samples' }));
      const sp = l.split();
      const c1 = sp.column(true);
      c1.label('Settings:');
      const seed = c1.row(true);
      seed.prop(iprop(C, 'seed', { name: 'Seed', min: 0, max: 2147483647, description: 'Seed value for integrator to get different noise patterns', python: 'bpy.context.scene.cycles.seed' }));
      seed.prop(bprop(C, 'useAnimatedSeed', { name: '', description: 'Use different seed values (and hence noise patterns) at different frames', python: 'bpy.context.scene.cycles.use_animated_seed' }), { iconOnly: true, icon: 'TIME' }).classList.add('fixed');
      c1.prop(fprop(C, 'sampleClampDirect', { name: 'Clamp Direct', min: 0, max: 1e8, softMax: 100, precision: 2, description: 'If non-zero, the maximum value for a direct sample, higher values will be scaled down to avoid too much noise and slow convergence at the cost of accuracy', python: 'bpy.context.scene.cycles.sample_clamp_direct' }));
      c1.prop(fprop(C, 'sampleClampIndirect', { name: 'Clamp Indirect', min: 0, max: 1e8, softMax: 100, precision: 2, description: 'If non-zero, the maximum value for an indirect sample, higher values will be scaled down to avoid too much noise and slow convergence at the cost of accuracy', python: 'bpy.context.scene.cycles.sample_clamp_indirect' }));
      c1.prop(naFloat('Light Sampling Threshold', 0.01, { precision: 2 }));
      const c2 = sp.column(true);
      c2.label('Samples:');
      c2.prop(iprop(C, 'samples', { name: 'Render', min: 1, max: 2147483647, softMax: 4096, description: 'Number of samples to render for each pixel', python: 'bpy.context.scene.cycles.samples' }));
      c2.prop(iprop(C, 'previewSamples', { name: 'Preview', min: 0, max: 2147483647, softMax: 4096, description: 'Number of samples to render in the viewport, unlimited if 0', python: 'bpy.context.scene.cycles.preview_samples' }));
      l.row().prop(naEnum('Pattern', [{ id: 'SOBOL', label: 'Sobol' }, { id: 'CMJ', label: 'Correlated Multi-Jitter' }], 'SOBOL'));
      if (C()?.useSquareSamples) {
        const c = C()!;
        l.dynLabel(() => `Total Samples: ${c.samples * c.samples} (Preview: ${c.previewSamples * c.previewSamples})`);
      }
    },
  });

  P.push({
    id: 'cycles.geometry', label: 'Geometry', defaultClosed: true,
    draw: (l) => {
      const sp = l.split();
      const c1 = sp.column(true);
      c1.label('Volume Sampling:', { disabled: true });
      c1.prop(naFloat('Step Size', 0.1));
      c1.prop(naInt('Max Steps', 1024));
      const c2 = sp.column(true);
      c2.label('Hair:', { disabled: true });
      c2.prop(naEnum('Primitive', ['Curve Segments', 'Line Segments', 'Triangles'], 'Curve Segments'), { noLabel: true });
      c2.prop(naEnum('Shape', ['Thick', 'Ribbons'], 'Thick'), { noLabel: true });
    },
  });

  P.push({
    id: 'cycles.light_paths', label: 'Light Paths',
    draw: (l) => {
      presets(l, 'Integrator Presets');
      const sp = l.split();
      const c1 = sp.column();
      const t = c1.column(true);
      t.label('Transparency:');
      t.prop(iprop(C, 'transparentMaxBounces', { name: 'Max', min: 0, max: 1024, description: 'Maximum number of transparent bounces', python: 'bpy.context.scene.cycles.transparent_max_bounces' }));
      t.prop(iprop(C, 'transparentMinBounces', { name: 'Min', min: 0, max: 1024, description: 'Minimum number of transparent bounces, setting this lower than the maximum enables probabilistic path termination (faster render, more noise)', python: 'bpy.context.scene.cycles.transparent_min_bounces' }));
      t.prop(bprop(C, 'useTransparentShadows', { name: 'Shadows', description: 'Use transparency of surfaces for rendering shadows', python: 'bpy.context.scene.cycles.use_transparent_shadows' }));
      c1.separator();
      c1.prop(bprop(C, 'causticsReflective', { name: 'Reflective Caustics', description: 'Use reflective caustics, resulting in a brighter image (more noise but added realism)', python: 'bpy.context.scene.cycles.caustics_reflective' }));
      c1.prop(bprop(C, 'causticsRefractive', { name: 'Refractive Caustics', description: 'Use refractive caustics, resulting in a brighter image (more noise but added realism)', python: 'bpy.context.scene.cycles.caustics_refractive' }));
      c1.prop(fprop(C, 'blurGlossy', { name: 'Filter Glossy', min: 0, max: 10, precision: 2, description: 'Adaptively blur glossy shaders after blurry bounces, to reduce noise at the cost of accuracy', python: 'bpy.context.scene.cycles.blur_glossy' }));
      const c2 = sp.column();
      const b = c2.column(true);
      b.label('Bounces:');
      b.prop(iprop(C, 'maxBounces', { name: 'Max', min: 0, max: 1024, description: 'Total maximum number of bounces', python: 'bpy.context.scene.cycles.max_bounces' }));
      b.prop(iprop(C, 'minBounces', { name: 'Min', min: 0, max: 1024, description: 'Minimum number of bounces, setting this lower than the maximum enables probabilistic path termination (faster render, more noise)', python: 'bpy.context.scene.cycles.min_bounces' }));
      const b2 = c2.column(true);
      b2.prop(iprop(C, 'diffuseBounces', { name: 'Diffuse', min: 0, max: 1024, description: 'Maximum number of diffuse reflection bounces, bounded by total maximum', python: 'bpy.context.scene.cycles.diffuse_bounces' }));
      b2.prop(iprop(C, 'glossyBounces', { name: 'Glossy', min: 0, max: 1024, description: 'Maximum number of glossy reflection bounces, bounded by total maximum', python: 'bpy.context.scene.cycles.glossy_bounces' }));
      b2.prop(iprop(C, 'transmissionBounces', { name: 'Transmission', min: 0, max: 1024, description: 'Maximum number of transmission bounces, bounded by total maximum', python: 'bpy.context.scene.cycles.transmission_bounces' }));
      b2.prop(naInt('Volume', 0));
    },
  });

  P.push({
    id: 'cycles.motion_blur', label: 'Motion Blur', defaultClosed: true,
    drawHeader: (l) => { l.prop(bprop(R, 'useMotionBlur', { name: '', description: 'Use multi-sampled 3D scene motion blur (not rendered by blender-web)' }), { text: '' }); },
    draw: (l) => {
      activeWhen(l, () => !!R()?.useMotionBlur);
      l.prop(naEnum('Position', ['Start on Frame', 'Center on Frame', 'End on Frame'], 'Center on Frame'));
      l.prop(naFloat('Shutter', 0.5, { precision: 2 }));
      l.separator();
      l.label('Shutter curve:', { disabled: true });
      const sp = l.split();
      sp.column().prop(naEnum('Rolling Shutter', ['None', 'Top-Bottom'], 'None'));
      sp.column().prop(naFloat('Rolling Shutter Duration', 0.1, { precision: 2 }));
    },
  });

  P.push({
    id: 'cycles.film', label: 'Film', key: () => `${C()?.filterType}`,
    draw: (l) => {
      const sp = l.split();
      const c1 = sp.column();
      c1.prop(fprop(C, 'filmExposure', { name: 'Exposure', min: 0, max: 10, precision: 2, step: 0.1, description: 'Image brightness scale', python: 'bpy.context.scene.cycles.film_exposure' }));
      c1.separator();
      const sub = c1.column(true);
      sub.prop(eprop(C, 'filterType', [
        { id: 'BOX', label: 'Box', description: 'Box filter' },
        { id: 'GAUSSIAN', label: 'Gaussian', description: 'Gaussian filter' },
        { id: 'BLACKMAN_HARRIS', label: 'Blackman-Harris', description: 'Blackman-Harris filter' },
      ], { name: 'Filter Type', description: 'Pixel filter type', python: 'bpy.context.scene.cycles.pixel_filter_type' }), { noLabel: true });
      if (C()?.filterType !== 'BOX') {
        sub.prop(fprop(C, 'filterWidth', { name: 'Width', min: 0.01, max: 10, precision: 2, unit: 'PIXEL', step: 0.1, description: 'Pixel filter width', python: 'bpy.context.scene.cycles.filter_width' }));
      }
      const c2 = sp.column();
      c2.prop(bprop(C, 'filmTransparent', { name: 'Transparent', description: 'World background is transparent, for compositing the render over another background', python: 'bpy.context.scene.cycles.film_transparent' }));
      c2.prop(naBool('Transparent Glass'));
      c2.prop(naFloat('Roughness Threshold', 0.1, { precision: 2 }));
    },
  });

  P.push({
    id: 'cycles.performance', label: 'Performance', defaultClosed: true,
    draw: (l) => {
      const sp = l.split();
      const c1 = sp.column();
      const th = c1.column(true);
      th.label('Threads:', { disabled: true });
      th.row(true).prop(naEnum('Threads Mode', ['Auto-detect', 'Fixed'], 'Auto-detect'), { expand: true });
      th.prop(naInt('Threads', navigator.hardwareConcurrency || 4));
      c1.separator();
      const tl = c1.column(true);
      tl.label('Tiles:', { disabled: true });
      tl.prop(naEnum('Tile Order', ['Center', 'Right to Left', 'Left to Right', 'Top to Bottom', 'Bottom to Top', 'Hilbert Spiral'], 'Hilbert Spiral'), { noLabel: true });
      tl.prop(naInt('X', R()?.tileX ?? 64));
      tl.prop(naInt('Y', R()?.tileY ?? 64));
      c1.prop(naBool('Progressive Refine', true, 'blender-web always refines the whole image progressively; the work is split adaptively across frames'));
      const c2 = sp.column();
      const fr = c2.column(true);
      fr.label('Final Render:', { disabled: true });
      fr.prop(naBool('Save Buffers'));
      fr.prop(naBool('Persistent Images'));
      c2.separator();
      const vp = c2.column(true);
      vp.label('Viewport Resolution:');
      vp.prop(iprop(C, 'previewStartResolution', { name: 'Start Resolution', min: 8, max: 16384, description: 'Resolution to start rendering preview at, progressively increasing it to the full viewport size', python: 'bpy.context.scene.cycles.preview_start_resolution' }));
      c2.separator();
      const ac = c2.column(true);
      ac.label('Acceleration structure:', { disabled: true });
      ac.prop(naBool('Use Spatial Splits'));
      ac.prop(naBool('Use Hair BVH', true));
    },
  });

  P.push({
    id: 'cycles.post_processing', label: 'Post Processing', defaultClosed: true,
    draw: (l) => {
      const sp = l.split();
      const c1 = sp.column();
      c1.prop(bprop(R, 'useCompositing', { name: 'Compositing', description: 'Process the render result through the compositing pipeline, if compositing nodes are enabled' }));
      c1.prop(bprop(R, 'useSequencer', { name: 'Sequencer', description: 'Process the render (and composited) result through the video sequence editor pipeline, if sequencer strips exist' }));
      sp.column().prop(fprop(R, 'ditherIntensity', { name: 'Dither', min: 0, max: 2, precision: 3, description: 'Amount of dithering noise added to the rendered image to break up banding' }), { slider: true });
    },
  });

  P.push({
    id: 'cycles.bake', label: 'Bake', defaultClosed: true,
    draw: (l) => {
      naButton(l, 'Bake', 'RENDER_STILL');
      l.prop(naEnum('Bake Type', ['Combined', 'Ambient Occlusion', 'Shadow', 'Normal', 'UV', 'Emit', 'Environment', 'Diffuse', 'Glossy', 'Transmission', 'Subsurface'], 'Combined'));
      const sp = l.split();
      const c1 = sp.column();
      c1.prop(naInt('Margin', 16));
      c1.prop(naBool('Clear Image', true));
      const c2 = sp.column();
      c2.prop(naBool('Selected to Active'));
      c2.prop(naFloat('Ray Distance', 0));
    },
  });
  return P;
}

function denoisingPanel(): PanelDef {
  return {
    id: 'cycles.denoising', label: 'Denoising',
    drawHeader: (l) => { l.prop(bprop(C, 'useDenoising', { name: '', description: 'Denoise the rendered image (an edge-aware filter guided by the albedo and normal passes; final renders only)', python: 'bpy.context.scene.render.layers.active.cycles.use_denoising' }), { text: '' }); },
    draw: (l) => {
      activeWhen(l, () => !!C()?.useDenoising);
      const sp = l.split();
      const c1 = sp.column(true);
      c1.prop(iprop(C, 'denoisingRadius', { name: 'Radius', min: 1, max: 25, description: 'Size of the image area that is used to denoise a pixel (higher values are smoother, but might lose detail and are slower)', python: 'bpy.context.scene.render.layers.active.cycles.denoising_radius' }));
      c1.prop(fprop(C, 'denoisingStrength', { name: 'Strength', min: 0, max: 1, precision: 3, description: 'Controls neighbor pixel weighting for the denoising filter (lower values preserve more detail, but aren\'t as smooth)', python: 'bpy.context.scene.render.layers.active.cycles.denoising_strength' }), { slider: true });
      c1.prop(fprop(C, 'denoisingFeatureStrength', { name: 'Feature Strength', min: 0, max: 1, precision: 3, description: 'Controls removal of noisy image feature passes (lower values preserve more detail, but aren\'t as smooth)', python: 'bpy.context.scene.render.layers.active.cycles.denoising_feature_strength' }), { slider: true });
      const c2 = sp.column();
      c2.prop(naBool('Relative filter'));
      l.separator();
      const g = l.split();
      for (const name of ['Diffuse', 'Glossy', 'Transmission', 'Subsurface']) {
        const r = g.column(true);
        r.label(`${name}:`, { disabled: true });
        r.prop(naBool('Direct', true), { toggle: true });
        r.prop(naBool('Indirect', true), { toggle: true });
      }
    },
  };
}

// ------------------------------------------------------------------ shader node view

const SHADER_LABEL: Record<CyclesShaderType, string> = {
  PRINCIPLED: 'Principled BSDF', DIFFUSE: 'Diffuse BSDF', GLOSSY: 'Glossy BSDF', GLASS: 'Glass BSDF', REFRACTION: 'Refraction BSDF',
  TRANSLUCENT: 'Translucent BSDF', TRANSPARENT: 'Transparent BSDF', EMISSION: 'Emission', MIX: 'Mix Shader', ADD: 'Add Shader',
};

/** Shader node types in the order of the 2.79 "Shader" link menu (unsupported ones greyed out). */
const SHADER_ITEMS: EnumItem[] = [
  { id: 'MIX', label: 'Mix Shader', icon: 'NODE' },
  { id: 'ADD', label: 'Add Shader', icon: 'NODE' },
  { id: 'DIFFUSE', label: 'Diffuse BSDF', icon: 'NODE' },
  { id: 'PRINCIPLED', label: 'Principled BSDF', icon: 'NODE' },
  { id: 'GLOSSY', label: 'Glossy BSDF', icon: 'NODE' },
  { id: 'TRANSPARENT', label: 'Transparent BSDF', icon: 'NODE' },
  { id: 'REFRACTION', label: 'Refraction BSDF', icon: 'NODE' },
  { id: 'GLASS', label: 'Glass BSDF', icon: 'NODE' },
  { id: 'TRANSLUCENT', label: 'Translucent BSDF', icon: 'NODE' },
  { id: 'ANISOTROPIC', label: 'Anisotropic BSDF', icon: 'NODE', disabled: true, description: NA },
  { id: 'VELVET', label: 'Velvet BSDF', icon: 'NODE', disabled: true, description: NA },
  { id: 'TOON', label: 'Toon BSDF', icon: 'NODE', disabled: true, description: NA },
  { id: 'SUBSURFACE', label: 'Subsurface Scattering', icon: 'NODE', disabled: true, description: NA },
  { id: 'EMISSION', label: 'Emission', icon: 'NODE' },
  { id: 'HAIR', label: 'Hair BSDF', icon: 'NODE', disabled: true, description: NA },
  { id: 'AO', label: 'Ambient Occlusion', icon: 'NODE', disabled: true, description: NA },
  { id: 'HOLDOUT', label: 'Holdout', icon: 'NODE', disabled: true, description: NA },
];

const DISTRIBUTIONS: Partial<Record<CyclesShaderType, EnumItem[]>> = {
  PRINCIPLED: [{ id: 'GGX', label: 'GGX' }, { id: 'MULTI_GGX', label: 'Multiscatter GGX' }],
  GLOSSY: [{ id: 'SHARP', label: 'Sharp' }, { id: 'BECKMANN', label: 'Beckmann' }, { id: 'GGX', label: 'GGX' }, { id: 'ASHIKHMIN_SHIRLEY', label: 'Ashikhmin-Shirley' }, { id: 'MULTI_GGX', label: 'Multiscatter GGX' }],
  GLASS: [{ id: 'SHARP', label: 'Sharp' }, { id: 'BECKMANN', label: 'Beckmann' }, { id: 'GGX', label: 'GGX' }, { id: 'MULTI_GGX', label: 'Multiscatter GGX' }],
  REFRACTION: [{ id: 'SHARP', label: 'Sharp' }, { id: 'BECKMANN', label: 'Beckmann' }, { id: 'GGX', label: 'GGX' }],
};

/** Structure of a shader tree (node types and links): the panel is rebuilt when it changes. */
function treeKey(s: CyclesShader | undefined | null): string {
  if (!s) return '-';
  return `${s.type}${s.colorTexture ? `[${s.colorTexture}]` : ''}${s.shaders ? `(${treeKey(s.shaders[0])},${treeKey(s.shaders[1])})` : ''}`;
}

/** Replace a shader node by another type, keeping the inputs that both have (like re-linking in 2.79). */
function convertShader(old: CyclesShader, type: CyclesShaderType): CyclesShader {
  const n = defaultShader(type);
  if (type === 'MIX' || type === 'ADD') {
    if (old.type === 'MIX' || old.type === 'ADD') return { ...n, shaders: old.shaders };
    n.shaders = [old, defaultShader(old.type === 'GLOSSY' ? 'DIFFUSE' : 'GLOSSY')];
    return n;
  }
  if (old.type !== 'MIX' && old.type !== 'ADD') {
    n.color = old.color.slice() as Color3;
    n.colorTexture = old.colorTexture ?? null;
    if (type !== 'DIFFUSE' && old.type !== 'DIFFUSE') n.roughness = old.roughness;
  }
  return n;
}

/** One "Label: value" row of a node view. */
function inputRow(l: Layout, label: string, indent: number): Layout {
  const sp = l.split(0.4);
  const lab = sp.column();
  const el = lab.label(`${label}:`);
  el.style.paddingLeft = `${indent * 12}px`;
  return sp.column();
}

function textureItems(): EnumItem[] {
  return Object.values(app.doc.textures).map((t) => ({ id: t.id, label: t.name, icon: t.type === 'IMAGE' ? 'IMAGE_DATA' : 'TEXTURE' }));
}

/** Colour input with a link menu (texture node) like the socket buttons of `template_node_view`. */
function colorInput(l: Layout, label: string, get: () => CyclesShader | null, indent: number): void {
  const col = inputRow(l, label, indent);
  const row = col.row(true);
  const linked = () => !!get()?.colorTexture;
  row.menu('', (): MenuItem[] => [
    { type: 'label', label: 'Input' },
    { label: 'Remove', icon: 'X', disabled: !linked(), action: () => { const s = get(); if (s) { s.colorTexture = null; commitEdit('Remove Link', 'data'); } } },
    { type: 'separator' },
    { type: 'label', label: 'Texture' },
    ...(textureItems().length ? textureItems().map((it): MenuItem => ({
      label: it.label, icon: it.icon, action: () => { const s = get(); if (s) { s.colorTexture = it.id; commitEdit('Link Texture', 'data'); } },
    })) : [{ label: 'No textures (add one in the Texture tab)', disabled: true } as MenuItem]),
  ], { icon: linked() ? 'TEXTURE' : 'DOT', iconOnly: true, title: 'Link' }).classList.add('fixed');
  if (linked()) {
    row.prop({
      kind: 'enum', name: label, items: textureItems, undo: 'Link Texture',
      description: 'Texture node linked to this input (mapping: the material\'s texture slot with this texture, or UV / Generated coordinates)',
      get: () => get()?.colorTexture ?? '', set: (v) => { const s = get(); if (s) s.colorTexture = v; },
    }, { noLabel: true, icon: 'TEXTURE' });
  } else {
    row.prop(cprop(get, 'color', { name: label, description: `${label} input of the shader node` }), { text: '' });
  }
}

function factorInput(l: Layout, label: string, get: () => CyclesShader | null, key: keyof CyclesShader, indent: number, o: { min?: number; max?: number; slider?: boolean } = {}): void {
  inputRow(l, label, indent).prop(fprop(get, key as string, { name: label, min: o.min ?? 0, max: o.max ?? 1, precision: 3, step: 0.1, description: `${label} input of the shader node` }), { slider: o.slider !== false, text: '' });
}

function naInput(l: Layout, label: string, value: string, indent: number): void {
  inputRow(l, label, indent).label(value, { disabled: true });
}

/** Draw a shader node selector and its inputs (recursively for Mix/Add shaders). */
function shaderView(l: Layout, label: string, get: () => CyclesShader | null, set: (s: CyclesShader) => void, indent = 0, depth = 0): void {
  const sel = inputRow(l, label, indent);
  sel.prop({
    kind: 'enum', name: label, items: SHADER_ITEMS, undo: 'Change Shader',
    description: 'Shader node linked to this input',
    get: () => get()?.type ?? 'PRINCIPLED',
    set: (v) => { const s = get(); if (s && v !== s.type) set(convertShader(s, v as CyclesShaderType)); },
  }, { noLabel: true });
  const s = get();
  if (!s) return;
  const i = indent + 1;
  const dist = DISTRIBUTIONS[s.type];
  if (dist) {
    const r = l.split(0.4);
    r.column();
    const rr = r.column().row(true);
    rr.prop(eprop(get, 'distribution', dist, { name: 'Distribution', description: 'Microfacet distribution (Sharp: perfectly smooth; the others render as GGX)' }), { noLabel: true });
    if (s.type === 'PRINCIPLED') rr.prop(naEnum('Subsurface Method', ['Christensen-Burley', 'Random Walk'], 'Christensen-Burley'), { noLabel: true });
  }
  switch (s.type) {
    case 'PRINCIPLED':
      colorInput(l, 'Base Color', get, i);
      naInput(l, 'Subsurface', '0.000', i);
      naInput(l, 'Subsurface Radius', '1.000, 0.200, 0.100', i);
      naInput(l, 'Subsurface Color', '0.700, 0.100, 0.100', i);
      factorInput(l, 'Metallic', get, 'metallic', i);
      factorInput(l, 'Specular', get, 'specular', i, { max: 1 });
      factorInput(l, 'Specular Tint', get, 'specularTint', i);
      factorInput(l, 'Roughness', get, 'roughness', i);
      naInput(l, 'Anisotropic', '0.000', i);
      naInput(l, 'Anisotropic Rotation', '0.000', i);
      naInput(l, 'Sheen', '0.000', i);
      naInput(l, 'Sheen Tint', '0.500', i);
      naInput(l, 'Clearcoat', '0.000', i);
      naInput(l, 'Clearcoat Roughness', '0.030', i);
      inputRow(l, 'IOR', i).prop(fprop(get, 'ior', { name: 'IOR', min: 1, max: 1000, softMax: 3, precision: 3, step: 0.01, description: 'Index of refraction' }), { text: '' });
      factorInput(l, 'Transmission', get, 'transmission', i);
      naInput(l, 'Normal', 'Default', i);
      naInput(l, 'Clearcoat Normal', 'Default', i);
      naInput(l, 'Tangent', 'Default', i);
      break;
    case 'DIFFUSE':
      colorInput(l, 'Color', get, i);
      factorInput(l, 'Roughness', get, 'roughness', i);
      naInput(l, 'Normal', 'Default', i);
      break;
    case 'GLOSSY':
      colorInput(l, 'Color', get, i);
      factorInput(l, 'Roughness', get, 'roughness', i);
      naInput(l, 'Normal', 'Default', i);
      break;
    case 'GLASS': case 'REFRACTION':
      colorInput(l, 'Color', get, i);
      factorInput(l, 'Roughness', get, 'roughness', i);
      inputRow(l, 'IOR', i).prop(fprop(get, 'ior', { name: 'IOR', min: 1, max: 1000, softMax: 3, precision: 3, step: 0.01, description: 'Index of refraction' }), { text: '' });
      naInput(l, 'Normal', 'Default', i);
      break;
    case 'TRANSLUCENT':
      colorInput(l, 'Color', get, i);
      naInput(l, 'Normal', 'Default', i);
      break;
    case 'TRANSPARENT':
      colorInput(l, 'Color', get, i);
      break;
    case 'EMISSION':
      colorInput(l, 'Color', get, i);
      inputRow(l, 'Strength', i).prop(fprop(get, 'strength', { name: 'Strength', min: -1e6, max: 1e6, softMin: 0, softMax: 100, precision: 3, step: 0.1, description: 'Emission strength (a strength of 1 shows the colour at full brightness)' }), { text: '' });
      break;
    case 'MIX': case 'ADD': {
      if (s.type === 'MIX') factorInput(l, 'Fac', get, 'fac', i);
      if (depth >= 3) { naInput(l, 'Shader', '(nested too deep)', i); break; }
      for (const k of [0, 1] as const) {
        const child = () => get()?.shaders?.[k] ?? null;
        shaderView(l, 'Shader', child, (ns) => { const p = get(); if (p?.shaders) p.shaders[k] = ns; }, i, depth + 1);
      }
      break;
    }
  }
}

// ------------------------------------------------------------------ material

const MA = activeMaterial;
const MC = () => { const m = MA(); return m ? ensureMaterialSettings(m) : null; };
const surfaceOf = () => { const m = MA(); return m?.cycles?.useNodes ? m.cycles.surface ?? null : null; };

function materialPanels(bi: PanelDef[]): PanelDef[] {
  const hasMat = () => !!MA();
  const [context, preview, custom] = pick(bi, 'material.context', 'material.preview', 'material.custom_props');
  const P: PanelDef[] = [];
  if (context) P.push(context);
  if (preview) P.push(preview);
  P.push({
    id: 'cycles.material.surface', label: 'Surface', poll: hasMat,
    key: () => `${MA()?.id}|${!!MA()?.cycles?.useNodes}|${treeKey(surfaceOf())}`,
    draw: (l) => {
      const ma = MA();
      if (!ma) return;
      if (!ma.cycles?.useNodes) {
        l.button('Use Nodes', () => { const m = MA(); if (m) { enableMaterialNodes(m); commitEdit('Use Shading Nodes', 'data'); } }, { icon: 'NODETREE', tip: 'Enable nodes on a material: the node tree starts from what the material looks like now' });
        l.prop(cprop(MA, 'diffuseColor', { name: 'Color', description: 'Diffuse color of the material (without nodes Cycles renders a look derived from the Blender Internal settings)', python: 'bpy.context.material.diffuse_color' }));
        return;
      }
      shaderView(l, 'Surface', surfaceOf, (s) => { const m = MA(); if (m?.cycles) m.cycles.surface = s; });
    },
  });
  P.push({
    id: 'cycles.material.volume', label: 'Volume', poll: hasMat, defaultClosed: true,
    draw: (l) => { inputRow(l, 'Volume', 0).label('None', { disabled: true }); },
  });
  P.push({
    id: 'cycles.material.displacement', label: 'Displacement', poll: hasMat, defaultClosed: true,
    draw: (l) => { inputRow(l, 'Displacement', 0).label('None', { disabled: true }); },
  });
  P.push({
    id: 'cycles.material.settings', label: 'Settings', poll: hasMat, defaultClosed: true,
    draw: (l) => {
      const sp = l.split();
      const c1 = sp.column();
      c1.label('Viewport Color:');
      c1.prop(cprop(MA, 'diffuseColor', { name: 'Diffuse Color', description: 'Diffuse color of the material (used for the viewport display)', python: 'bpy.context.material.diffuse_color' }), { text: '' });
      c1.prop(fprop(MA, 'alpha', { name: 'Alpha', min: 0, max: 1, precision: 3, step: 0.1, description: 'Alpha transparency of the material' }), { slider: true });
      const c2 = sp.column(true);
      c2.label('Viewport Specular:');
      c2.prop(cprop(MA, 'specularColor', { name: 'Specular Color', description: 'Specular color of the material' }), { text: '' });
      c2.prop(iprop(MA, 'specularHardness', { name: 'Hardness', min: 1, max: 511, description: 'How hard (sharp) the specular reflection is' }));
      l.separator();
      const sp2 = l.split();
      const a = sp2.column(true);
      a.label('Surface:');
      a.prop(bprop(MC, 'sampleAsLight', { name: 'Multiple Importance', description: 'Use multiple importance sampling for this material, disabling may reduce overall noise for large objects that emit little light compared to other light sources', python: 'bpy.context.material.cycles.sample_as_light' }));
      a.prop(bprop(MC, 'useTransparentShadow', { name: 'Transparent Shadows', description: 'Use transparent shadows for this material if it contains a Transparent BSDF', python: 'bpy.context.material.cycles.use_transparent_shadow' }));
      a.separator();
      a.label('Geometry:', { disabled: true });
      a.prop(naEnum('Displacement Method', ['Bump', 'True', 'Both'], 'Bump'), { noLabel: true });
      const b = sp2.column(true);
      b.label('Volume:', { disabled: true });
      b.prop(naEnum('Volume Sampling', ['Distance', 'Equiangular', 'Multiple Importance'], 'Multiple Importance'), { noLabel: true });
      b.prop(naEnum('Volume Interpolation', ['Linear', 'Cubic'], 'Linear'), { noLabel: true });
      b.prop(naBool('Homogeneous'));
      l.separator();
      l.prop(naInt('Pass Index', 0));
    },
  });
  if (custom) P.push(custom);
  return P;
}

// ------------------------------------------------------------------ world

const W = worldData;
const WC = () => { const w = W(); return w ? ensureWorldSettings(w) : null; };

function worldPanels(bi: PanelDef[]): PanelDef[] {
  const hasWorld = () => !!W();
  const [context, preview, custom] = pick(bi, 'world.context', 'world.preview', 'world.custom_props');
  const P: PanelDef[] = [];
  if (context) P.push(context);
  if (preview) P.push(preview);
  P.push({
    id: 'cycles.world.surface', label: 'Surface', poll: hasWorld,
    key: () => `${!!W()?.cycles?.useNodes}|${W()?.cycles?.colorSource ?? ''}`,
    draw: (l) => {
      const w = W();
      if (!w) return;
      if (!w.cycles?.useNodes) {
        l.button('Use Nodes', () => { const ww = W(); if (ww) { ensureWorldSettings(ww).useNodes = true; commitEdit('Use Shading Nodes', 'data'); } }, { icon: 'NODETREE', tip: 'Enable nodes on the world (a Background node with the horizon colour, or the sky gradient)' });
        l.prop(cprop(W, 'horizonColor', { name: 'Color', description: 'Color at the horizon (the world background without nodes)', python: 'bpy.context.scene.world.horizon_color' }));
        return;
      }
      inputRow(l, 'Surface', 0).prop(naEnum('Surface', [{ id: 'BG', label: 'Background', icon: 'NODE' }], 'BG'), { noLabel: true });
      const col = inputRow(l, 'Color', 1);
      const row = col.row(true);
      row.prop(eprop(WC, 'colorSource', [
        { id: 'COLOR', label: 'Color', icon: 'DOT', description: 'A flat background colour' },
        { id: 'SKY', label: 'Sky Gradient', icon: 'WORLD', description: 'Blend from the horizon colour to the zenith colour (the Blender Internal blend sky)' },
      ], { name: 'Color Source', description: 'Node linked to the Color input', undo: 'Link Background Color' }), { iconOnly: true });
      if (WC()?.colorSource === 'SKY') {
        row.label('Sky Gradient', { disabled: false });
        inputRow(l, 'Horizon', 2).prop(cprop(W, 'horizonColor', { name: 'Horizon Color', description: 'Color at the horizon' }), { text: '' });
        inputRow(l, 'Zenith', 2).prop(cprop(W, 'zenithColor', { name: 'Zenith Color', description: 'Color at the zenith' }), { text: '' });
      } else {
        row.prop(cprop(WC, 'color', { name: 'Color', description: 'Background colour' }), { text: '' });
      }
      inputRow(l, 'Strength', 1).prop(fprop(WC, 'strength', { name: 'Strength', min: 0, max: 1e6, softMax: 10, precision: 3, step: 0.1, description: 'Strength of the background light', python: 'bpy.data.worlds["World"].node_tree.nodes["Background"].inputs[1].default_value' }), { text: '' });
    },
  });
  P.push({
    id: 'cycles.world.volume', label: 'Volume', poll: hasWorld, defaultClosed: true,
    draw: (l) => { inputRow(l, 'Volume', 0).label('None', { disabled: true }); },
  });
  P.push({
    id: 'cycles.world.ao', label: 'Ambient Occlusion', poll: hasWorld,
    drawHeader: (hl) => { hl.prop(bprop(W, 'useAO', { name: '', description: 'Use Ambient Occlusion to add shadowing based on distance between objects', python: 'bpy.context.scene.world.light_settings.use_ambient_occlusion' }), { text: '' }); },
    draw: (l) => {
      activeWhen(l, () => !!W()?.useAO);
      const sp = l.split();
      sp.column().prop(fprop(W, 'aoFactor', { name: 'Factor', min: 0, max: 5, precision: 3, step: 0.1, description: 'Factor for ambient occlusion blending', python: 'bpy.context.scene.world.light_settings.ao_factor' }));
      sp.column().prop(fprop(WC, 'aoDistance', { name: 'Distance', min: 0, max: 1e4, softMax: 100, unit: 'LENGTH', precision: 3, description: 'Length of rays, defines how far away other faces give occlusion effect', python: 'bpy.context.scene.world.light_settings.distance' }));
    },
  });
  P.push({
    id: 'cycles.world.mist', label: 'Mist Pass', poll: hasWorld, defaultClosed: true,
    draw: (l) => {
      const sp = l.split();
      sp.column().prop(naFloat('Start', W()?.mistStart ?? 5, { unit: 'LENGTH' }));
      sp.column().prop(naFloat('Depth', W()?.mistDepth ?? 25, { unit: 'LENGTH' }));
      l.prop(naEnum('Falloff', ['Quadratic', 'Linear', 'Inverse Quadratic'], 'Quadratic'));
      l.label('Enable the Mist pass in the Render Layers tab (passes are not available in blender-web)', { disabled: true });
    },
  });
  P.push({
    id: 'cycles.world.ray_visibility', label: 'Ray Visibility', poll: hasWorld, defaultClosed: true,
    draw: (l) => {
      const f = l.row();
      f.prop(bprop(WC, 'visibleCamera', { name: 'Camera', description: 'Object visibility for camera rays', python: 'bpy.context.scene.world.cycles_visibility.camera' }));
      f.prop(naBool('Diffuse', true));
      f.prop(naBool('Glossy', true));
      const g = l.row();
      g.prop(naBool('Transmission', true));
      g.prop(naBool('Volume Scatter', true));
    },
  });
  P.push({
    id: 'cycles.world.settings', label: 'Settings', poll: hasWorld, defaultClosed: true,
    draw: (l) => {
      const sp = l.split();
      const c1 = sp.column(true);
      c1.label('Sampling:', { disabled: true });
      c1.prop(naBool('Multiple Importance', false, 'Background importance sampling is not available in blender-web: the world is reached by BSDF sampling'));
      c1.prop(naInt('Map Resolution', 1024));
      c1.prop(naInt('Max Bounces', 1024));
      const c2 = sp.column(true);
      c2.label('Volume:', { disabled: true });
      c2.prop(naEnum('Volume Sampling', ['Distance', 'Equiangular', 'Multiple Importance'], 'Equiangular'), { noLabel: true });
      c2.prop(naEnum('Volume Interpolation', ['Linear', 'Cubic'], 'Linear'), { noLabel: true });
      c2.prop(naBool('Homogeneous'));
    },
  });
  if (custom) P.push(custom);
  return P;
}

// ------------------------------------------------------------------ lamp

const LA = lampData;
const LC = () => { const la = LA(); return la ? ensureLampSettings(la) : null; };

function lampPanels(bi: PanelDef[]): PanelDef[] {
  const [context, preview, custom] = pick(bi, 'data.lamp_context', 'data.lamp_preview', 'data.lamp_custom_props');
  const P: PanelDef[] = [];
  if (context) P.push(context);
  if (preview) P.push(preview);
  const t = () => LA()?.lampType ?? 'POINT';
  P.push({
    id: 'cycles.lamp', label: 'Lamp', key: () => `${t()}|${LA()?.areaShape}`,
    draw: (l) => {
      l.row().prop(eprop(LA, 'lampType', [
        { id: 'POINT', label: 'Point', icon: 'LAMP_POINT', description: 'Omnidirectional point light source' },
        { id: 'SUN', label: 'Sun', icon: 'LAMP_SUN', description: 'Constant direction parallel ray light source' },
        { id: 'SPOT', label: 'Spot', icon: 'LAMP_SPOT', description: 'Directional cone light source' },
        { id: 'HEMI', label: 'Hemi', icon: 'LAMP_HEMI', description: '180 degree constant light source' },
        { id: 'AREA', label: 'Area', icon: 'LAMP_AREA', description: 'Directional area light source' },
      ], { name: 'Type', description: 'Type of Lamp', notify: ['data'], python: 'bpy.context.lamp.type' }), { expand: true });
      const sp = l.split();
      const c1 = sp.column(true);
      const type = t();
      if (type === 'POINT' || type === 'SUN' || type === 'SPOT') {
        c1.prop(fprop(LA, 'shadowSoftSize', { name: 'Size', min: 0, max: 1e6, softMax: 100, unit: 'LENGTH', step: 0.1, precision: 3, description: 'Light size for ray shadow sampling (Raytraced shadows)', python: 'bpy.context.lamp.shadow_soft_size' }));
      } else if (type === 'AREA') {
        c1.prop(eprop(LA, 'areaShape', [{ id: 'SQUARE', label: 'Square' }, { id: 'RECTANGLE', label: 'Rectangle' }], { name: 'Shape', description: 'Shape of the area lamp', python: 'bpy.context.lamp.shape' }), { noLabel: true });
        if (LA()?.areaShape === 'RECTANGLE') {
          c1.prop(fprop(LA, 'areaSize', { name: 'Size X', min: 0, unit: 'LENGTH', step: 0.1, precision: 3, description: 'Size of the area of the area Lamp, X direction size for Rectangle shapes', python: 'bpy.context.lamp.size' }));
          c1.prop(fprop(LA, 'areaSizeY', { name: 'Size Y', min: 0, unit: 'LENGTH', step: 0.1, precision: 3, description: 'Size of the area of the area Lamp in the Y direction for Rectangle shapes', python: 'bpy.context.lamp.size_y' }));
        } else {
          c1.prop(fprop(LA, 'areaSize', { name: 'Size', min: 0, unit: 'LENGTH', step: 0.1, precision: 3, description: 'Size of the area of the area Lamp', python: 'bpy.context.lamp.size' }));
        }
      }
      c1.prop(iprop(LC, 'maxBounces', { name: 'Max Bounces', min: 0, max: 1024, description: 'Maximum number of bounces the light will contribute to the render', python: 'bpy.context.lamp.cycles.max_bounces' }));
      const c2 = sp.column(true);
      c2.prop(bprop(LC, 'castShadow', { name: 'Cast Shadow', description: 'Lamp casts shadows', python: 'bpy.context.lamp.cycles.cast_shadow' }));
      c2.prop(bprop(LC, 'useMultipleImportance', { name: 'Multiple Importance', description: 'Use multiple importance sampling for the lamp, reduces noise for area lamps and sharp glossy materials', python: 'bpy.context.lamp.cycles.use_multiple_importance_sampling' }));
      if (type === 'AREA') c2.prop(naBool('Portal'));
      if (type === 'HEMI') l.label('Not supported, interpreted as sun lamp', { icon: 'INFO' });
    },
  });
  P.push({
    id: 'cycles.lamp.nodes', label: 'Nodes', key: () => `${!!LA()?.cycles?.useNodes}`,
    draw: (l) => {
      const la = LA();
      if (!la) return;
      if (!la.cycles?.useNodes) {
        l.button('Use Nodes', () => {
          const x = LA();
          if (!x) return;
          const c = ensureLampSettings(x);
          c.strength = Math.round(derivedLampStrength(x) * 1000) / 1000;
          c.useNodes = true;
          commitEdit('Use Shading Nodes', 'data');
        }, { icon: 'NODETREE', tip: 'Enable nodes on the lamp: an Emission node whose strength starts from the Blender Internal energy' });
        l.prop(cprop(LA, 'color', { name: 'Color', description: 'Light color', python: 'bpy.context.lamp.color' }));
        return;
      }
      inputRow(l, 'Surface', 0).prop(naEnum('Surface', [{ id: 'EMISSION', label: 'Emission', icon: 'NODE' }], 'EMISSION'), { noLabel: true });
      inputRow(l, 'Color', 1).prop(cprop(LA, 'color', { name: 'Color', description: 'Light color', python: 'bpy.context.lamp.color' }), { text: '' });
      inputRow(l, 'Strength', 1).prop(fprop(LC, 'strength', {
        name: 'Strength', min: -1e6, max: 1e6, softMin: 0, softMax: 10000, precision: 3, step: 1,
        description: 'Emission strength: Watts for point, spot and area lamps, irradiance (W/m²) for sun lamps',
        python: 'bpy.data.lamps["Lamp"].node_tree.nodes["Emission"].inputs[1].default_value',
      }), { text: '' });
    },
  });
  if (t() === 'SPOT') {
    P.push({
      id: 'cycles.lamp.spot', label: 'Spot Shape',
      draw: (l) => {
        const sp = l.split();
        const c1 = sp.column();
        c1.prop(fprop(LA, 'spotSize', { name: 'Size', min: Math.PI / 180, max: Math.PI, unit: 'ROTATION', step: Math.PI / 180, precision: 1, description: 'Angle of the spotlight beam', python: 'bpy.context.lamp.spot_size' }));
        c1.prop(fprop(LA, 'spotBlend', { name: 'Blend', min: 0, max: 1, step: 0.01, precision: 3, description: 'The softness of the spotlight edge', python: 'bpy.context.lamp.spot_blend' }), { slider: true });
        const c2 = sp.column();
        c2.prop(bprop(LA, 'showCone', { name: 'Show Cone', description: 'Draw transparent cone in 3D view to visualize which objects are contained in it', python: 'bpy.context.lamp.show_cone' }));
      },
    });
  }
  if (custom) P.push(custom);
  return P;
}

/** Used by the "New" material operator hook: new materials get a Principled BSDF node tree with Cycles. */
export function initNewCyclesMaterial(ma: MaterialData): void {
  if (ma.cycles?.useNodes) return;
  enableMaterialNodes(ma, true);
}
