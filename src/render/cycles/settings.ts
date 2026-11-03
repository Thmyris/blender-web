// Cycles settings with their 2.79 defaults, and the derivation of Cycles materials, lamps and
// worlds from the Blender Internal settings for datablocks that have no Cycles data yet.

import type {
  Color3, CyclesLampSettings, CyclesMaterialSettings, CyclesSceneSettings, CyclesShader, CyclesShaderType,
  CyclesWorldSettings, LampData, MaterialData, Scene, WorldData,
} from '../../core/types';

export const SCENE_DEFAULTS: CyclesSceneSettings = {
  device: 'GPU', featureSet: 'SUPPORTED', progressive: 'PATH', useSquareSamples: false,
  samples: 128, previewSamples: 32, seed: 0, useAnimatedSeed: false,
  sampleClampDirect: 0, sampleClampIndirect: 10, lightSamplingThreshold: 0.01, samplingPattern: 'SOBOL',
  transparentMaxBounces: 8, transparentMinBounces: 8, useTransparentShadows: true,
  causticsReflective: true, causticsRefractive: true, blurGlossy: 0,
  maxBounces: 12, minBounces: 3, diffuseBounces: 4, glossyBounces: 4, transmissionBounces: 12, volumeBounces: 0,
  filmExposure: 1, filmTransparent: false, filterType: 'BLACKMAN_HARRIS', filterWidth: 1.5,
  useDenoising: false, denoisingRadius: 8, denoisingStrength: 0.5, denoisingFeatureStrength: 0.5,
  previewStartResolution: 64, useProgressiveRefine: false,
};

export const LAMP_DEFAULTS: Omit<CyclesLampSettings, 'strength'> = {
  useNodes: false, maxBounces: 1024, castShadow: true, useMultipleImportance: true,
};

export const WORLD_DEFAULTS: Omit<CyclesWorldSettings, 'color' | 'colorSource'> = {
  useNodes: false, strength: 1, aoDistance: 10, sampleAsLight: false, visibleCamera: true,
};

export const MATERIAL_SETTINGS_DEFAULTS: Omit<CyclesMaterialSettings, 'surface' | 'useNodes'> = {
  sampleAsLight: true, useTransparentShadow: true,
};

// ------------------------------------------------------------------ scene

export function isCycles(sc: Scene | null | undefined): boolean {
  return sc?.render.engine === 'CYCLES';
}

/** Full Cycles settings of a scene (stored values over the defaults); read-only view. */
export function sceneSettings(sc: Scene): CyclesSceneSettings {
  return { ...SCENE_DEFAULTS, ...(sc.cycles ?? {}) } as CyclesSceneSettings;
}

/** The stored scene.cycles object with every default filled in (for UI bindings). */
export function ensureSceneSettings(sc: Scene): CyclesSceneSettings {
  const c = (sc.cycles ??= {});
  for (const [k, v] of Object.entries(SCENE_DEFAULTS)) if ((c as Record<string, unknown>)[k] === undefined) (c as Record<string, unknown>)[k] = v;
  return c as CyclesSceneSettings;
}

// ------------------------------------------------------------------ shaders

/** Default inputs of a shader node, as created in Blender 2.79. */
export function defaultShader(type: CyclesShaderType): CyclesShader {
  const s: CyclesShader = {
    type, color: [0.8, 0.8, 0.8], colorTexture: null, roughness: 0, metallic: 0, specular: 0.5, specularTint: 0,
    transmission: 0, ior: 1.45, strength: 1, distribution: 'GGX', fac: 0.5,
  };
  switch (type) {
    case 'PRINCIPLED': s.roughness = 0.5; s.distribution = 'MULTI_GGX'; break;
    case 'GLOSSY': s.roughness = 0.5; break;
    case 'GLASS': case 'REFRACTION': case 'TRANSPARENT': case 'EMISSION': s.color = [1, 1, 1]; break;
    case 'MIX': case 'ADD': s.shaders = [defaultShader('DIFFUSE'), defaultShader('GLOSSY')]; break;
  }
  return s;
}

/** Blender Internal hardness (Phong exponent) to a GGX roughness. */
export function hardnessToRoughness(hardness: number): number {
  const alpha = Math.sqrt(2 / (Math.max(1, hardness) + 2));
  return Math.min(1, Math.max(0, Math.sqrt(alpha)));
}

const scaled = (c: Color3, k: number): Color3 => [c[0] * k, c[1] * k, c[2] * k];

/** First texture slot that maps a texture onto the diffuse colour (Blender Internal "Influence > Color"). */
function diffuseTexture(ma: MaterialData): string | null {
  for (const slot of ma.textureSlots) {
    if (slot && slot.use && slot.texture && slot.useMapColorDiffuse) return slot.texture;
  }
  return null;
}

/** A Cycles surface shader that renders a Blender Internal material similarly. */
export function deriveSurface(ma: MaterialData): CyclesShader {
  let s: CyclesShader;
  if (ma.useShadeless) {
    s = { ...defaultShader('EMISSION'), color: ma.diffuseColor.slice() as Color3, colorTexture: diffuseTexture(ma), strength: 1 };
  } else {
    s = {
      ...defaultShader('PRINCIPLED'),
      color: scaled(ma.diffuseColor, Math.min(1, ma.diffuseIntensity)),
      colorTexture: diffuseTexture(ma),
      specular: Math.min(1, ma.specularIntensity),
      roughness: hardnessToRoughness(ma.specularHardness),
      distribution: 'GGX',
    };
    if (ma.useTransparency && ma.alpha < 1 && ma.transparencyMethod === 'RAYTRACE') {
      s.transmission = 1 - ma.alpha;
      s.ior = 1.45;
    }
    if (ma.useMirror && ma.rayMirror > 0) {
      const mirror: CyclesShader = { ...defaultShader('GLOSSY'), color: [1, 1, 1], roughness: 0, distribution: 'SHARP' };
      s = { ...defaultShader('MIX'), fac: Math.min(1, ma.rayMirror), shaders: [s, mirror] };
    }
    if (ma.emit > 0) {
      const em: CyclesShader = { ...defaultShader('EMISSION'), color: ma.diffuseColor.slice() as Color3, colorTexture: diffuseTexture(ma), strength: ma.emit };
      s = { ...defaultShader('ADD'), shaders: [s, em] };
    }
  }
  if (ma.useTransparency && ma.alpha < 1 && ma.transparencyMethod !== 'RAYTRACE') {
    s = { ...defaultShader('MIX'), fac: ma.alpha, shaders: [{ ...defaultShader('TRANSPARENT') }, s] };
  }
  return s;
}

/** The surface shader Cycles renders for a material (its node tree, or the derived one). */
export function materialSurface(ma: MaterialData): CyclesShader {
  const c = ma.cycles;
  if (c?.useNodes && c.surface) return c.surface;
  return deriveSurface(ma);
}

export function materialSettings(ma: MaterialData): CyclesMaterialSettings {
  return { ...MATERIAL_SETTINGS_DEFAULTS, useNodes: false, surface: materialSurface(ma), ...(ma.cycles ?? {}) } as CyclesMaterialSettings;
}

/** The stored material.cycles object with defaults filled in (for UI bindings). */
export function ensureMaterialSettings(ma: MaterialData): CyclesMaterialSettings {
  const c = (ma.cycles ??= {});
  for (const [k, v] of Object.entries(MATERIAL_SETTINGS_DEFAULTS)) if ((c as Record<string, unknown>)[k] === undefined) (c as Record<string, unknown>)[k] = v;
  if (c.useNodes === undefined) c.useNodes = false;
  return c as CyclesMaterialSettings;
}

/** "Use Nodes": give the material a node tree that looks like what it rendered before. */
export function enableMaterialNodes(ma: MaterialData, principledDefault = false): void {
  const c = ensureMaterialSettings(ma);
  if (!c.surface) c.surface = principledDefault ? defaultShader('PRINCIPLED') : JSON.parse(JSON.stringify(deriveSurface(ma))) as CyclesShader;
  c.useNodes = true;
}

// ------------------------------------------------------------------ lamps

/**
 * Lamp strength derived from the Blender Internal energy, chosen so that a lamp lights objects a few
 * metres away about as brightly as Blender Internal's (soft) inverse-square falloff does.
 */
export function derivedLampStrength(la: LampData): number {
  const e = la.energy * (la.useNegative ? -1 : 1);
  switch (la.lampType) {
    case 'SUN': case 'HEMI': return e * Math.PI;
    case 'AREA': {
      const d = 7, dist = Math.max(1e-3, la.distance);
      return e * 4 * Math.PI * d * d * (dist * dist) / (dist * dist + d * d);
    }
    default: {
      const d = 7, dist = Math.max(1e-3, la.distance);
      return e * 4 * Math.PI * Math.PI * d * d * (dist * dist) / (dist * dist + d * d);
    }
  }
}

export function lampSettings(la: LampData): CyclesLampSettings {
  const c = la.cycles ?? {};
  const strength = c.useNodes && c.strength !== undefined ? c.strength : derivedLampStrength(la);
  return { ...LAMP_DEFAULTS, ...c, strength } as CyclesLampSettings;
}

export function ensureLampSettings(la: LampData): CyclesLampSettings {
  const c = (la.cycles ??= {});
  for (const [k, v] of Object.entries(LAMP_DEFAULTS)) if ((c as Record<string, unknown>)[k] === undefined) (c as Record<string, unknown>)[k] = v;
  if (c.strength === undefined) c.strength = Math.round(derivedLampStrength(la) * 1000) / 1000;
  return c as CyclesLampSettings;
}

// ------------------------------------------------------------------ world

export function worldSettings(w: WorldData): CyclesWorldSettings {
  const c = w.cycles ?? {};
  const derived: CyclesWorldSettings = {
    ...WORLD_DEFAULTS,
    colorSource: w.useBlendSky ? 'SKY' : 'COLOR',
    color: w.horizonColor.slice() as Color3,
  };
  if (!c.useNodes) return { ...derived, aoDistance: c.aoDistance ?? derived.aoDistance, sampleAsLight: c.sampleAsLight ?? false, visibleCamera: c.visibleCamera ?? true };
  return { ...derived, ...c } as CyclesWorldSettings;
}

export function ensureWorldSettings(w: WorldData): CyclesWorldSettings {
  const c = (w.cycles ??= {});
  for (const [k, v] of Object.entries(WORLD_DEFAULTS)) if ((c as Record<string, unknown>)[k] === undefined) (c as Record<string, unknown>)[k] = v;
  if (c.colorSource === undefined) c.colorSource = w.useBlendSky ? 'SKY' : 'COLOR';
  if (c.color === undefined) c.color = w.horizonColor.slice() as Color3;
  return c as CyclesWorldSettings;
}
