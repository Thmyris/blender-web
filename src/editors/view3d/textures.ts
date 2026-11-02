// Blender Internal style textures for viewport/render materials. Textures use
// Blender's default "Generated" coordinates (the object's bounding box mapped to
// -1..1) with Flat/Cube/Tube/Sphere projection, and are evaluated in GLSL.

import { Color, SRGBColorSpace, Texture, TextureLoader, Vector3, RepeatWrapping, ClampToEdgeWrapping, type MeshPhongMaterial, type MeshBasicMaterial } from 'three';
import { app } from '../../app';
import type { MaterialData, TextureData, TextureSlot } from '../../core/types';

export interface TexInfo {
  slot: TextureSlot;
  tex: TextureData;
  image: Texture | null;
}

const imageCache = new Map<string, Texture>();

function imageTexture(t: TextureData): Texture | null {
  if (!t.imageData) return null;
  const key = `${t.id}:${t.imageData.length}:${t.imageData.slice(-32)}`;
  let tex = imageCache.get(key);
  if (!tex) {
    tex = new TextureLoader().load(t.imageData, () => app.notify('view'));
    tex.colorSpace = SRGBColorSpace;
    imageCache.set(key, tex);
  }
  const wrap = t.extension === 'REPEAT' ? RepeatWrapping : ClampToEdgeWrapping;
  tex.wrapS = tex.wrapT = wrap;
  return tex;
}

/** First active texture slot with a usable texture. */
export function buildTextureForMaterial(ma: MaterialData): TexInfo | null {
  for (const slot of ma.textureSlots) {
    if (!slot || !slot.use || !slot.texture) continue;
    const tex = app.doc.textures[slot.texture];
    if (!tex || tex.type === 'NONE') continue;
    if (!slot.useMapColorDiffuse && !slot.useMapAlpha) continue;
    return { slot, tex, image: tex.type === 'IMAGE' ? imageTexture(tex) : null };
  }
  return null;
}

const TYPE_ID: Record<string, number> = { IMAGE: 1, CLOUDS: 2, BLEND: 3, WOOD: 4, MARBLE: 5, VORONOI: 6, MAGIC: 7, STUCCI: 8, NOISE: 9 };
const PROG_ID: Record<string, number> = { LINEAR: 0, QUADRATIC: 1, EASING: 2, DIAGONAL: 3, SPHERICAL: 4, QUADRATIC_SPHERE: 5, RADIAL: 6 };
const WOOD_ID: Record<string, number> = { BANDS: 0, RINGS: 1, BANDNOISE: 2, RINGNOISE: 3 };
const MAP_ID: Record<string, number> = { FLAT: 0, CUBE: 1, TUBE: 2, SPHERE: 3 };
const BLEND_ID: Record<string, number> = { MIX: 0, ADD: 1, SUBTRACT: 2, MULTIPLY: 3, SCREEN: 4 };

export const TEXTURE_GLSL = /* glsl */ `
uniform int texType; uniform float noiseScale; uniform float noiseDepth; uniform float turbulence; uniform int noiseHard;
uniform int progression; uniform int woodType; uniform float tIntensity; uniform float tContrast;
uniform vec3 slotColor; uniform float colorFactor; uniform int mapping; uniform vec3 tOffset; uniform vec3 tScale;
uniform sampler2D tImage; uniform int hasImage; uniform float tSat; uniform int blendType; uniform int rgbToIntensity; uniform vec3 tTint;
varying vec3 vOrco;

vec3 hash3(vec3 p){ p = vec3(dot(p,vec3(127.1,311.7,74.7)), dot(p,vec3(269.5,183.3,246.1)), dot(p,vec3(113.5,271.9,124.6))); return -1.0 + 2.0*fract(sin(p)*43758.5453123); }
float gnoise(vec3 p){
  vec3 i = floor(p); vec3 f = fract(p); vec3 u = f*f*(3.0-2.0*f);
  return mix(mix(mix(dot(hash3(i+vec3(0,0,0)),f-vec3(0,0,0)), dot(hash3(i+vec3(1,0,0)),f-vec3(1,0,0)),u.x),
                 mix(dot(hash3(i+vec3(0,1,0)),f-vec3(0,1,0)), dot(hash3(i+vec3(1,1,0)),f-vec3(1,1,0)),u.x),u.y),
             mix(mix(dot(hash3(i+vec3(0,0,1)),f-vec3(0,0,1)), dot(hash3(i+vec3(1,0,1)),f-vec3(1,0,1)),u.x),
                 mix(dot(hash3(i+vec3(0,1,1)),f-vec3(0,1,1)), dot(hash3(i+vec3(1,1,1)),f-vec3(1,1,1)),u.x),u.y),u.z);
}
float noise01(vec3 p){ float n = gnoise(p) * 0.5 + 0.5; return noiseHard == 1 ? abs(2.0*n - 1.0) : n; }
float turb(vec3 p, int depth){
  float sum = 0.0; float amp = 1.0; float norm = 0.0;
  for (int i = 0; i < 8; i++) { if (i > depth) break; sum += amp * noise01(p); norm += amp; amp *= 0.5; p *= 2.0; }
  return sum / norm;
}
float voronoiF1(vec3 p){
  vec3 i = floor(p); vec3 f = fract(p); float d = 8.0;
  for (int x=-1;x<=1;x++) for(int y=-1;y<=1;y++) for(int z=-1;z<=1;z++){
    vec3 g = vec3(float(x),float(y),float(z)); vec3 o = hash3(i+g)*0.5+0.5; vec3 r = g + o - f; d = min(d, dot(r,r)); }
  return sqrt(d);
}
vec2 projectUV(vec3 co){
  if (mapping == 1) { vec3 a = abs(co); if (a.x >= a.y && a.x >= a.z) return co.yz; if (a.y >= a.z) return co.xz; return co.xy; }
  if (mapping == 2) { float u = atan(co.x, -co.y) / 3.14159265 * 0.5 + 0.5; return vec2(u*2.0-1.0, co.z); }
  if (mapping == 3) { float u = atan(co.x, -co.y) / 3.14159265 * 0.5 + 0.5; float l = length(co); float v = l > 0.0 ? asin(clamp(co.z / l, -1.0, 1.0)) / 1.5707963 : 0.0; return vec2(u*2.0-1.0, v); }
  return co.xy;
}
/** Returns rgb in .rgb and intensity in .a ; rgb.r < 0 means intensity-only texture */
vec4 evalTexture(vec3 orco){
  vec3 co = (orco + tOffset) * tScale;
  float ns = max(noiseScale, 1e-4);
  if (texType == 1) {
    if (hasImage == 0) return vec4(1.0, 0.0, 1.0, 1.0);
    vec2 uv = projectUV(co) * 0.5 + 0.5;
    vec4 c = texture2D(tImage, uv);
    return vec4(c.rgb, c.a);
  }
  float v = 0.0;
  if (texType == 2) v = turb(co / ns, int(noiseDepth));
  else if (texType == 3) {
    float x = co.x, y = co.y;
    if (progression == 0) v = (1.0 + x) / 2.0;
    else if (progression == 1) { v = max(0.0, (1.0 + x) / 2.0); v = v*v; }
    else if (progression == 2) { v = clamp((1.0 + x) / 2.0, 0.0, 1.0); v = v*v*(3.0-2.0*v); }
    else if (progression == 3) v = (2.0 + x + y) / 4.0;
    else if (progression == 4) v = max(0.0, 1.0 - length(co));
    else if (progression == 5) { v = max(0.0, 1.0 - length(co)); v = v*v; }
    else v = (atan(y, x) / 6.2831853) + 0.5;
  }
  else if (texType == 4) {
    float n = turbulence * turb(co / ns, int(noiseDepth)) * 0.1;
    if (woodType == 0) v = 0.5 + 0.5 * sin((co.x + co.y + co.z) * 10.0);
    else if (woodType == 1) v = 0.5 + 0.5 * sin(length(co.xy) * 20.0);
    else if (woodType == 2) v = 0.5 + 0.5 * sin((co.x + co.y + co.z) * 10.0 + n * 10.0);
    else v = 0.5 + 0.5 * sin(length(co.xy) * 20.0 + n * 10.0);
  }
  else if (texType == 5) { float n = turb(co / ns, int(noiseDepth)); v = 0.5 + 0.5 * sin((co.x + turbulence * n) * 5.0); v = pow(v, 0.5); }
  else if (texType == 6) v = clamp(voronoiF1(co / ns), 0.0, 1.0);
  else if (texType == 7) { vec3 p = co * turbulence; return vec4(0.5 + 0.5*sin(p.x*3.0 + p.y), 0.5 + 0.5*cos(p.y*3.0 - p.z), 0.5 + 0.5*sin(p.z*3.0 + p.x), 1.0); }
  else if (texType == 8) { float n = turb(co / ns, 2); v = smoothstep(0.45, 0.6, n); }
  else if (texType == 9) v = fract(sin(dot(floor(co * 200.0), vec3(12.9898,78.233,37.719))) * 43758.5453);
  v = clamp((v - 0.5) * tContrast + 0.5, 0.0, 1.0) * tIntensity;
  return vec4(-1.0, v, 0.0, v);
}
vec3 blendColor(vec3 base, vec3 col, float fac){
  if (blendType == 1) return base + col * fac;
  if (blendType == 2) return base - col * fac;
  if (blendType == 3) return base * mix(vec3(1.0), col, fac);
  if (blendType == 4) return 1.0 - (1.0 - base) * (1.0 - col * fac);
  return mix(base, col, fac);
}
`;

/** Install (or remove) the generated-coordinate texture shader on a material. */
export function applyOrcoTexture(mat: MeshPhongMaterial | MeshBasicMaterial, info: TexInfo | null, _ma: MaterialData): void {
  const ud = mat.userData as { hasTex?: boolean; texUniforms?: Record<string, { value: unknown }> };
  if (!info) {
    ud.hasTex = false;
    mat.onBeforeCompile = () => {};
    mat.customProgramCacheKey = () => 'plain';
    return;
  }
  const { slot, tex, image } = info;
  const uniforms: Record<string, { value: unknown }> = {
    texType: { value: TYPE_ID[tex.type] ?? 0 }, noiseScale: { value: tex.noiseScale }, noiseDepth: { value: tex.noiseDepth },
    turbulence: { value: tex.turbulence }, noiseHard: { value: tex.noiseType === 'HARD_NOISE' ? 1 : 0 },
    progression: { value: PROG_ID[tex.progression] ?? 0 }, woodType: { value: WOOD_ID[tex.woodType] ?? 0 },
    tIntensity: { value: tex.intensity }, tContrast: { value: tex.contrast }, slotColor: { value: new Color(slot.color[0], slot.color[1], slot.color[2]) },
    colorFactor: { value: slot.useMapColorDiffuse ? slot.diffuseColorFactor : 0 }, mapping: { value: MAP_ID[slot.mapping] ?? 0 },
    tOffset: { value: new Vector3(...slot.offset) }, tScale: { value: new Vector3(...slot.scale) },
    tImage: { value: image }, hasImage: { value: image ? 1 : 0 }, blendType: { value: BLEND_ID[slot.blendType] ?? 0 },
    rgbToIntensity: { value: slot.useRgbToIntensity ? 1 : 0 }, tSat: { value: tex.saturation ?? 1 }, tTint: { value: new Color(tex.colorTint[0], tex.colorTint[1], tex.colorTint[2]) },
  };
  ud.hasTex = true;
  ud.texUniforms = uniforms;
  mat.customProgramCacheKey = () => 'orco-tex';
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 orco;\nvarying vec3 vOrco;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvOrco = orco;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${TEXTURE_GLSL}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
      {
        vec4 tc = evalTexture(vOrco);
        vec3 col; float fac;
        if (tc.r < 0.0) { col = slotColor; fac = tc.a; }
        else if (rgbToIntensity == 1) { col = slotColor; fac = dot(tc.rgb, vec3(0.35, 0.45, 0.2)); }
        else { col = tc.rgb * tTint; float lum = dot(col, vec3(0.2126, 0.7152, 0.0722)); col = max(mix(vec3(lum), col, tSat), 0.0); fac = tc.a; }
        diffuseColor.rgb = blendColor(diffuseColor.rgb, col, fac * colorFactor);
      }`);
  };
}
