// Document data of the Cycles render engine: optional `cycles` settings on scenes, materials,
// worlds and lamps (bpy: scene.cycles, material.cycles + material node tree, world.cycles,
// lamp.cycles). Every field is optional in the document: missing settings are derived from
// the Blender Internal ones (see settings.ts), so older files render sensibly in Cycles.

import type { Color3 } from '../../core/types';

/** Shader node types offered by the Cycles "Surface" panels. */
export type CyclesShaderType =
  | 'PRINCIPLED' | 'DIFFUSE' | 'GLOSSY' | 'GLASS' | 'REFRACTION' | 'TRANSLUCENT' | 'TRANSPARENT' | 'EMISSION'
  | 'MIX' | 'ADD';

export type CyclesDistribution = 'SHARP' | 'BECKMANN' | 'GGX' | 'MULTI_GGX' | 'ASHIKHMIN_SHIRLEY';

/**
 * A surface shader: one shader node plus, for Mix/Add shaders, its two input shaders
 * (a small node tree that the Surface panel edits like `template_node_view`).
 */
export interface CyclesShader {
  type: CyclesShaderType;
  /** "Base Color" (Principled) / "Color" input. */
  color: Color3;
  /** Texture datablock (doc.textures) linked into the colour input as an Image/procedural texture node. */
  colorTexture?: string | null;
  roughness: number;
  metallic: number;
  specular: number;
  specularTint: number;
  transmission: number;
  ior: number;
  /** Emission shader strength. */
  strength: number;
  distribution: CyclesDistribution;
  /** Mix Shader factor. */
  fac: number;
  /** The two shader inputs of Mix / Add shaders. */
  shaders?: [CyclesShader, CyclesShader];
}

/** material.cycles plus the material's Cycles node tree. */
export interface CyclesMaterialSettings {
  useNodes: boolean;
  surface: CyclesShader;
  /** Settings panel: "Multiple Importance" (sample emissive faces as lights). */
  sampleAsLight: boolean;
  /** Settings panel: "Transparent Shadows". */
  useTransparentShadow: boolean;
}

/** world.cycles plus the Background node of the world node tree. */
export interface CyclesWorldSettings {
  useNodes: boolean;
  /** Background colour source: a flat colour or the horizon/zenith sky gradient. */
  colorSource: 'COLOR' | 'SKY';
  color: Color3;
  strength: number;
  /** Ambient Occlusion "Distance" (factor and toggle are shared with Blender Internal). */
  aoDistance: number;
  /** Settings > Multiple Importance (sample the background as a light). */
  sampleAsLight: boolean;
  /** Ray Visibility: Camera. */
  visibleCamera: boolean;
}

/** lamp.cycles plus the Emission node of the lamp node tree. */
export interface CyclesLampSettings {
  useNodes: boolean;
  /** Emission strength (Watts for point/spot/area lamps, W/m² irradiance for sun lamps). */
  strength: number;
  maxBounces: number;
  castShadow: boolean;
  useMultipleImportance: boolean;
}

/** scene.cycles */
export interface CyclesSceneSettings {
  device: 'CPU' | 'GPU';
  featureSet: 'SUPPORTED' | 'EXPERIMENTAL';
  progressive: 'PATH' | 'BRANCHED_PATH';
  useSquareSamples: boolean;
  samples: number;
  previewSamples: number;
  seed: number;
  useAnimatedSeed: boolean;
  sampleClampDirect: number;
  sampleClampIndirect: number;
  lightSamplingThreshold: number;
  samplingPattern: 'SOBOL' | 'CORRELATED_MUTI_JITTER';
  transparentMaxBounces: number;
  transparentMinBounces: number;
  useTransparentShadows: boolean;
  causticsReflective: boolean;
  causticsRefractive: boolean;
  blurGlossy: number;
  maxBounces: number;
  minBounces: number;
  diffuseBounces: number;
  glossyBounces: number;
  transmissionBounces: number;
  volumeBounces: number;
  filmExposure: number;
  filmTransparent: boolean;
  filterType: 'BOX' | 'GAUSSIAN' | 'BLACKMAN_HARRIS';
  filterWidth: number;
  /** Render Layers > Denoising (an edge-aware filter guided by albedo and normal passes). */
  useDenoising: boolean;
  denoisingRadius: number;
  denoisingStrength: number;
  denoisingFeatureStrength: number;
  /** Performance > Viewport: "Start Resolution" (pixels of the first, coarse viewport pass). */
  previewStartResolution: number;
  /** Performance > Final Render: "Progressive Refine" (show the whole image refining instead of tiles). */
  useProgressiveRefine: boolean;
}
