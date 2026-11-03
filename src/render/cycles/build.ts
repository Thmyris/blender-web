// Scene export for the path tracer: world-space triangles of every renderable object (from the
// evaluated, modifier-applied meshes), a BVH over them, packed materials (shader trees flattened
// to up to four BSDF "leaves"), textures, lamps, emissive triangles and the world background.
// Everything ends up in Float32Arrays that tracer.ts uploads as RGBA32F data textures.

import { Matrix3, Matrix4, Vector3 } from 'three';
import { app } from '../../app';
import { isObjectVisible } from '../../core/scene';
import { meshBounds, polyNormal, triangulatePoly } from '../../core/mesh';
import type { EvalMesh } from '../../core/modifiers';
import type { BObject, Color3, CyclesShader, MaterialData, TextureData, TextureSlot, Vec3 } from '../../core/types';
import { hasEvalGeometry } from '../../core/geomtypes';
import { materialSlots } from '../../core/matslots';
import { buildBvh } from './bvh';
import { lampSettings, materialSettings, materialSurface, sceneSettings, worldSettings } from './settings';

/** Width of every data texture (texels). Must match TEX_W in the shader. */
export const TEX_W = 2048;

export const TRI_TEXELS = 3;   // v0 + material, edge 1, edge 2
export const VTX_TEXELS = 3;   // per triangle corner: normal + u, orco + v, vertex colour
export const MAT_TEXELS = 4;
export const LEAF_TEXELS = 4;
export const TEXREC_TEXELS = 7;
export const LIGHT_TEXELS = 5;
export const MAX_LEAVES = 4;

export const enum LeafKind { PRINCIPLED = 0, DIFFUSE = 1, GLOSSY = 2, GLASS = 3, REFRACTION = 4, TRANSLUCENT = 5, TRANSPARENT = 6 }
export const enum LightType { POINT = 0, SUN = 1, SPOT = 2, AREA = 3 }

export interface GeometryData {
  triCount: number;
  /** TRI_TEXELS texels per triangle (BVH order). */
  tri: Float32Array;
  /** 3 corners x VTX_TEXELS texels per triangle (BVH order). */
  vtx: Float32Array;
  bvh: Float32Array;
  nodeCount: number;
  /** Per triangle (BVH order): material record index. */
  triMat: Int32Array;
  /** Scene bounds (world space). */
  boundsMin: Vec3;
  boundsMax: Vec3;
  key: string;
}

export interface ImageRef {
  /** Data URL of the image. */
  src: string;
}

export interface ShadingData {
  materials: Float32Array;
  materialCount: number;
  leaves: Float32Array;
  texRecords: Float32Array;
  /** Images referenced by texture records (array layer = index). */
  images: ImageRef[];
  lights: Float32Array;
  lightCount: number;
  /** Emissive triangles: (triangle index, cumulative probability, 0, 0) per entry. */
  emitters: Float32Array;
  emitterCount: number;
  /** Total power-ish weight (area x luminance) of the emissive triangles. */
  emitterTotal: number;
  /** Probability of picking a mesh light rather than a lamp in next-event estimation. */
  meshLightProb: number;
  hasTransparent: boolean;
  world: WorldParams;
  key: string;
}

export interface WorldParams {
  /** 0 = flat colour, 1 = blend sky (horizon to zenith), 2 = real sky (signed). */
  mode: number;
  horizon: Color3;
  zenith: Color3;
  strength: number;
  aoFactor: number;
  aoDistance: number;
  useAO: boolean;
  visibleCamera: boolean;
}

// ------------------------------------------------------------------ helpers

const lum = (c: readonly number[]): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/** Objects that end up in the render (visible on the given layers, not hidden for rendering). */
export function renderObjects(layers?: boolean[], localView?: Set<string> | null): BObject[] {
  const sc = app.scene;
  return app.objects().filter((o) => isObjectVisible(sc, o, layers ?? sc.layers) && !o.hideRender && (!localView || localView.has(o.id)));
}

/** Material slots of an object's data (meshes, curves, metaballs, ... all keep a `materials` list). */
export function objectMaterials(ob: BObject): (string | null)[] {
  if (ob.type === 'FONT') return ob.text?.materials ?? [];
  return materialSlots(app.doc, ob) ?? [];
}

function renderMesh(ob: BObject): EvalMesh | null {
  if (!hasEvalGeometry(ob.type)) return null;
  try { return app.evalMesh(ob, true); } catch (err) { console.warn('cycles: could not evaluate', ob.name, err); return null; }
}

/** Per face-corner UVs of an evaluated mesh (from the mesh's render UV map when the topology is unchanged). */
function cornerUVs(ob: BObject, em: EvalMesh): number[][] | null {
  const own = (em as EvalMesh & { uv?: number[][] }).uv;
  if (Array.isArray(own) && own.length === em.faces.length) return own;
  const md = app.meshOf(ob);
  const layers = md?.uvLayers;
  if (!md || !layers?.length || md.faces.length !== em.faces.length) return null;
  const idx = Math.max(0, Math.min(layers.length - 1, md.uvActiveRender ?? md.uvActive ?? 0));
  const uv = layers[idx]?.uv;
  return uv && uv.length === em.faces.length ? uv : null;
}

const meshIds = new WeakMap<object, number>();
let meshIdCounter = 0;
function identity(o: object): number {
  let id = meshIds.get(o);
  if (id === undefined) { id = ++meshIdCounter; meshIds.set(o, id); }
  return id;
}

// ------------------------------------------------------------------ geometry

interface MatTable {
  /** doc material id ('' = default material) -> material record index */
  index: Map<string, number>;
  list: (MaterialData | null)[];
}

export function newMatTable(): MatTable {
  return { index: new Map([['', 0]]), list: [null] };
}

function matIndex(t: MatTable, id: string | null | undefined): number {
  const ma = id ? app.doc.materials[id] : null;
  if (!ma) return 0;
  let i = t.index.get(ma.id);
  if (i === undefined) { i = t.list.length; t.list.push(ma); t.index.set(ma.id, i); }
  return i;
}

/** Cheap key of everything that affects the triangle data (so unchanged geometry is not rebuilt). */
export function geometryKey(objs: BObject[]): string {
  const parts: string[] = [];
  for (const ob of objs) {
    const em = renderMesh(ob);
    if (!em) continue;
    const md = app.meshOf(ob);
    const m = app.matrices.world(ob).elements;
    parts.push(`${ob.id}:${identity(em)}:${md ? `${md.autoSmooth}${md.autoSmoothAngle}${md.uvActiveRender ?? ''}` : ''}:${objectMaterials(ob).join(',')}:${Array.from(m, (x) => x.toFixed(5)).join(',')}`);
  }
  return parts.join('|');
}

/** Gather world-space triangles of all renderable objects and build the BVH. */
export function buildGeometry(objs: BObject[], mats: MatTable, key: string): GeometryData {
  // first pass: count triangles
  interface Src { ob: BObject; em: EvalMesh; tris: { f: number; c: [number, number, number] }[] }
  const srcs: Src[] = [];
  let n = 0;
  for (const ob of objs) {
    const em = renderMesh(ob);
    if (!em || !em.faces.length) continue;
    const tris: Src['tris'] = [];
    em.faces.forEach((f, fi) => { if (f.length >= 3) for (const c of triangulatePoly(em.verts, f)) tris.push({ f: fi, c }); });
    if (!tris.length) continue;
    srcs.push({ ob, em, tris });
    n += tris.length;
  }
  const pos = new Float32Array(n * 9);
  const nor = new Float32Array(n * 9);
  const orco = new Float32Array(n * 9);
  const uvs = new Float32Array(n * 6);
  const vcol = new Float32Array(n * 9).fill(1);
  const triMatSrc = new Int32Array(n);
  const bmin: Vec3 = [Infinity, Infinity, Infinity], bmax: Vec3 = [-Infinity, -Infinity, -Infinity];
  let t = 0;
  const v = new Vector3();
  const nm = new Matrix3();
  for (const { ob, em, tris } of srcs) {
    const world: Matrix4 = app.matrices.world(ob);
    nm.getNormalMatrix(world);
    const flip = world.determinant() < 0;
    const md = app.meshOf(ob);
    const autoSmooth = !!md?.autoSmooth;
    const cosA = Math.cos(md?.autoSmoothAngle ?? 0.5);
    const smoothAll = !!em.forceSmooth;
    const fn = em.faces.map((f) => polyNormal(em.verts, f));
    const needSmooth = smoothAll || em.faceSmooth.some(Boolean);
    const vf: number[][] = needSmooth ? em.verts.map(() => []) : [];
    if (needSmooth) em.faces.forEach((f, i) => { for (const k of f) vf[k].push(i); });
    const smoothCache = new Map<number, Vec3>();
    const b = meshBounds(em.verts);
    const uv = cornerUVs(ob, em);
    const slots = objectMaterials(ob);
    const slotIdx = slots.map((id) => matIndex(mats, id));
    for (const { f: fi, c } of tris) {
      const face = em.faces[fi];
      const corners = flip ? [c[0], c[2], c[1]] : c;
      const mi = em.faceMat[fi] ?? 0;
      triMatSrc[t] = slotIdx[Math.min(mi, slotIdx.length - 1)] ?? 0;
      const smooth = smoothAll || !!em.faceSmooth[fi];
      for (let k = 0; k < 3; k++) {
        const corner = corners[k];
        const vi = face[corner];
        const p = em.verts[vi];
        v.set(p[0], p[1], p[2]).applyMatrix4(world);
        const o9 = t * 9 + k * 3;
        pos[o9] = v.x; pos[o9 + 1] = v.y; pos[o9 + 2] = v.z;
        if (v.x < bmin[0]) bmin[0] = v.x; if (v.y < bmin[1]) bmin[1] = v.y; if (v.z < bmin[2]) bmin[2] = v.z;
        if (v.x > bmax[0]) bmax[0] = v.x; if (v.y > bmax[1]) bmax[1] = v.y; if (v.z > bmax[2]) bmax[2] = v.z;
        let nn: Vec3 = fn[fi];
        if (smooth) {
          const ck = autoSmooth ? vi * 1048576 + fi : vi;
          let cached = smoothCache.get(ck);
          if (!cached) {
            let x = 0, y = 0, z = 0;
            for (const g of vf[vi]) {
              if (!smoothAll && !em.faceSmooth[g]) continue;
              const gn = fn[g];
              if (autoSmooth && gn[0] * fn[fi][0] + gn[1] * fn[fi][1] + gn[2] * fn[fi][2] < cosA - 1e-6) continue;
              x += gn[0]; y += gn[1]; z += gn[2];
            }
            const l = Math.hypot(x, y, z) || 1;
            cached = [x / l, y / l, z / l];
            smoothCache.set(ck, cached);
          }
          nn = cached;
        }
        v.set(nn[0], nn[1], nn[2]).applyMatrix3(nm).normalize();
        nor[o9] = v.x; nor[o9 + 1] = v.y; nor[o9 + 2] = v.z;
        for (let a = 0; a < 3; a++) {
          const size = b.max[a] - b.min[a];
          orco[o9 + a] = size > 1e-9 ? ((p[a] - b.min[a]) / size) * 2 - 1 : 0;
        }
        if (em.vcol) { const vc = em.vcol[vi]; if (vc) { vcol[o9] = vc[0]; vcol[o9 + 1] = vc[1]; vcol[o9 + 2] = vc[2]; } }
        if (uv) {
          const fu = uv[fi];
          if (fu) { uvs[t * 6 + k * 2] = fu[corner * 2] ?? 0; uvs[t * 6 + k * 2 + 1] = fu[corner * 2 + 1] ?? 0; }
        }
      }
      t++;
    }
  }
  if (!n) { bmin.fill(0); bmax.fill(0); }
  const bvh = buildBvh(pos, n);
  // pack in BVH order
  const tri = new Float32Array(Math.max(1, n * TRI_TEXELS) * 4);
  const vtx = new Float32Array(Math.max(1, n * 3 * VTX_TEXELS) * 4);
  const triMat = new Int32Array(n);
  for (let j = 0; j < n; j++) {
    const s = bvh.order[j];
    const p = s * 9;
    const o = j * TRI_TEXELS * 4;
    tri[o] = pos[p]; tri[o + 1] = pos[p + 1]; tri[o + 2] = pos[p + 2]; tri[o + 3] = triMatSrc[s];
    tri[o + 4] = pos[p + 3] - pos[p]; tri[o + 5] = pos[p + 4] - pos[p + 1]; tri[o + 6] = pos[p + 5] - pos[p + 2];
    tri[o + 8] = pos[p + 6] - pos[p]; tri[o + 9] = pos[p + 7] - pos[p + 1]; tri[o + 10] = pos[p + 8] - pos[p + 2];
    triMat[j] = triMatSrc[s];
    for (let k = 0; k < 3; k++) {
      const q = (j * 3 + k) * VTX_TEXELS * 4;
      const a = p + k * 3;
      vtx[q] = nor[a]; vtx[q + 1] = nor[a + 1]; vtx[q + 2] = nor[a + 2]; vtx[q + 3] = uvs[s * 6 + k * 2];
      vtx[q + 4] = orco[a]; vtx[q + 5] = orco[a + 1]; vtx[q + 6] = orco[a + 2]; vtx[q + 7] = uvs[s * 6 + k * 2 + 1];
      vtx[q + 8] = vcol[a]; vtx[q + 9] = vcol[a + 1]; vtx[q + 10] = vcol[a + 2]; vtx[q + 11] = 1;
    }
  }
  return { triCount: n, tri, vtx, bvh: bvh.nodes.length ? bvh.nodes : new Float32Array(8), nodeCount: bvh.nodeCount, triMat, boundsMin: bmin, boundsMax: bmax, key };
}

// ------------------------------------------------------------------ materials

interface Leaf { kind: LeafKind; shader: CyclesShader; weight: number }

const KIND: Partial<Record<CyclesShader['type'], LeafKind>> = {
  PRINCIPLED: LeafKind.PRINCIPLED, DIFFUSE: LeafKind.DIFFUSE, GLOSSY: LeafKind.GLOSSY, GLASS: LeafKind.GLASS,
  REFRACTION: LeafKind.REFRACTION, TRANSLUCENT: LeafKind.TRANSLUCENT, TRANSPARENT: LeafKind.TRANSPARENT,
};

/** Flatten a shader tree into weighted BSDF leaves plus the total emission. */
function flatten(s: CyclesShader | undefined, w: number, out: Leaf[], emission: { c: number[]; tex: string | null }, depth = 0): void {
  if (!s || w <= 0 || depth > 8) return;
  if (s.type === 'MIX' || s.type === 'ADD') {
    const [a, b] = s.shaders ?? [undefined, undefined];
    const f = Math.min(1, Math.max(0, s.fac));
    flatten(a, s.type === 'MIX' ? w * (1 - f) : w, out, emission, depth + 1);
    flatten(b, s.type === 'MIX' ? w * f : w, out, emission, depth + 1);
    return;
  }
  if (s.type === 'EMISSION') {
    for (let i = 0; i < 3; i++) emission.c[i] += s.color[i] * s.strength * w;
    if (s.colorTexture && !emission.tex) emission.tex = s.colorTexture;
    return;
  }
  const kind = KIND[s.type];
  if (kind === undefined) return;
  out.push({ kind, shader: s, weight: w });
}

const TEX_TYPE: Record<string, number> = { IMAGE: 1, CLOUDS: 2, BLEND: 3, WOOD: 4, MARBLE: 5, VORONOI: 6, MAGIC: 7, STUCCI: 8, NOISE: 9 };
const PROG: Record<string, number> = { LINEAR: 0, QUADRATIC: 1, EASING: 2, DIAGONAL: 3, SPHERICAL: 4, QUADRATIC_SPHERE: 5, RADIAL: 6 };
const WOOD: Record<string, number> = { BANDS: 0, RINGS: 1, BANDNOISE: 2, RINGNOISE: 3 };
const MAPPING: Record<string, number> = { FLAT: 0, CUBE: 1, TUBE: 2, SPHERE: 3 };
const BLEND: Record<string, number> = { MIX: 0, ADD: 1, SUBTRACT: 2, MULTIPLY: 3, SCREEN: 4 };

/** Data URL of an image texture (its image datablock, or the texture's own image data). */
export function textureImageSrc(tex: TextureData): string | null {
  if (tex.type !== 'IMAGE') return null;
  const imgId = tex.image;
  const images = (app.doc as { images?: Record<string, { data: string | null }> }).images;
  if (imgId && images?.[imgId]?.data) return images[imgId].data;
  return tex.imageData;
}

class TexPacker {
  records: number[] = [];
  count = 0;
  images: ImageRef[] = [];
  private byKey = new Map<string, number>();

  /** Texture record for a texture linked to a colour input (-1 when unusable). */
  add(texId: string | null | undefined, ma: MaterialData | null, hasUV: boolean): number {
    if (!texId) return -1;
    const tex = app.doc.textures[texId];
    if (!tex || tex.type === 'NONE') return -1;
    // a Blender Internal texture slot with this texture provides the mapping (like a Mapping node)
    const slot: TextureSlot | null = ma?.textureSlots.find((s) => s && s.texture === texId && s.use) ?? null;
    const key = `${texId}|${ma?.id ?? ''}`;
    const hit = this.byKey.get(key);
    if (hit !== undefined) return hit;
    let layer = -1;
    if (tex.type === 'IMAGE') {
      const src = textureImageSrc(tex);
      if (!src) return -1;
      layer = this.images.findIndex((i) => i.src === src);
      if (layer < 0) { layer = this.images.length; this.images.push({ src }); }
    }
    const coords = slot ? (slot.textureCoords === 'UV' ? 1 : 0) : hasUV && tex.type === 'IMAGE' ? 1 : 0;
    const off = slot?.offset ?? [0, 0, 0], scl = slot?.scale ?? [1, 1, 1];
    const sc = slot?.color ?? [1, 0, 1];
    this.records.push(
      TEX_TYPE[tex.type] ?? 0, layer, MAPPING[slot?.mapping ?? 'FLAT'] ?? 0, coords,
      off[0], off[1], off[2], slot ? (slot.useMapColorDiffuse ? slot.diffuseColorFactor : 0) : 1,
      scl[0], scl[1], scl[2], BLEND[slot?.blendType ?? 'MIX'] ?? 0,
      tex.noiseScale, tex.noiseDepth, tex.turbulence, tex.noiseType === 'HARD_NOISE' ? 1 : 0,
      tex.intensity, tex.contrast, PROG[tex.progression] ?? 0, WOOD[tex.woodType] ?? 0,
      sc[0], sc[1], sc[2], slot?.useRgbToIntensity ? 1 : 0,
      tex.colorTint[0], tex.colorTint[1], tex.colorTint[2], tex.saturation ?? 1,
    );
    const idx = this.count++;
    this.byKey.set(key, idx);
    return idx;
  }
}

/** Key of everything shading-related (materials, textures, images, lamps, world, settings). */
export function shadingKey(objs: BObject[], mats: (MaterialData | null)[]): string {
  const sc = app.scene;
  const lamps = objs.filter((o) => o.type === 'LAMP' && o.data).map((o) => [o.id, app.doc.lamps[o.data!], Array.from(app.matrices.world(o).elements, (x) => +x.toFixed(5))]);
  const world = sc.world ? app.doc.worlds[sc.world] : null;
  const texIds = new Set<string>();
  for (const m of mats) {
    if (!m) continue;
    for (const s of m.textureSlots) if (s?.texture) texIds.add(s.texture);
    collectTextures(materialSurface(m), texIds);
  }
  const texs = [...texIds].map((id) => {
    const t = app.doc.textures[id];
    if (!t) return null;
    const src = textureImageSrc(t);
    return { ...t, imageData: src ? `${src.length}:${src.slice(-48)}` : null };
  });
  return JSON.stringify([mats.map((m) => m && { ...m, nodeTree: undefined }), texs, lamps, world, sc.cycles ?? null, sc.render.alphaMode]);
}

function collectTextures(s: CyclesShader | undefined, out: Set<string>): void {
  if (!s) return;
  if (s.colorTexture) out.add(s.colorTexture);
  for (const c of s.shaders ?? []) collectTextures(c, out);
}

export function buildShading(objs: BObject[], geom: GeometryData, mats: MatTable, key: string): ShadingData {
  const tp = new TexPacker();
  const matArr: number[] = [];
  const leafArr: number[] = [];
  let leafCount = 0;
  let hasTransparent = false;
  const matEmission: number[] = [];
  const matSampleLight: boolean[] = [];
  // which materials are used on meshes with UVs is not tracked per material: image textures fall
  // back to generated coordinates when a triangle has no UVs (shader checks for all-zero UVs)
  for (let mi = 0; mi < mats.list.length; mi++) {
    const ma = mats.list[mi];
    const leaves: Leaf[] = [];
    const em = { c: [0, 0, 0], tex: null as string | null };
    let useVcol = 0;
    let sampleLight = true;
    if (ma) {
      const ms = materialSettings(ma);
      flatten(materialSurface(ma), 1, leaves, em);
      useVcol = ma.useVertexColorPaint && !ms.useNodes ? Math.max(1e-3, ma.diffuseIntensity) : 0;
      sampleLight = ms.sampleAsLight;
    } else {
      // objects without a material render with a grey diffuse surface, like Cycles
      leaves.push({ kind: LeafKind.DIFFUSE, shader: { type: 'DIFFUSE', color: [0.8, 0.8, 0.8], roughness: 0, metallic: 0, specular: 0, specularTint: 0, transmission: 0, ior: 1.45, strength: 1, distribution: 'GGX', fac: 0.5 }, weight: 1 });
    }
    // keep the strongest leaves
    leaves.sort((a, b) => b.weight - a.weight);
    leaves.length = Math.min(leaves.length, 4);
    const total = leaves.reduce((s, l) => s + l.weight, 0);
    const start = leafCount;
    const cum = [1, 1, 1, 1], mult = [0, 0, 0, 0];
    let acc = 0;
    leaves.forEach((l, i) => {
      const p = total > 0 ? l.weight / total : 0;
      acc += p;
      cum[i] = i === leaves.length - 1 ? 1 : acc;
      mult[i] = p > 0 ? l.weight / p : 0;
      const s = l.shader;
      if (l.kind === LeafKind.TRANSPARENT) hasTransparent = true;
      let metallic = s.metallic, specular = s.specular, transmission = s.transmission, rough = s.roughness;
      if (s.distribution === 'SHARP') rough = 0;
      switch (l.kind) {
        case LeafKind.DIFFUSE: case LeafKind.TRANSLUCENT: metallic = 0; specular = 0; transmission = 0; break;
        case LeafKind.GLOSSY: metallic = 1; transmission = 0; break;
        case LeafKind.GLASS: case LeafKind.REFRACTION: metallic = 0; transmission = 1; break;
        default: break;
      }
      const tex = tp.add(s.colorTexture, ma, true);
      leafArr.push(
        s.color[0], s.color[1], s.color[2], l.kind,
        Math.min(1, Math.max(0, metallic)), Math.max(0, specular), Math.min(1, Math.max(0, rough)), Math.min(1, Math.max(0, transmission)),
        Math.max(1.0001, s.ior), Math.min(1, Math.max(0, s.specularTint)), useVcol, tex,
        0, 0, 0, 0,
      );
      leafCount++;
    });
    const emTex = tp.add(em.tex, ma, true);
    matEmission.push(lum(em.c));
    matSampleLight.push(sampleLight);
    matArr.push(
      start, leaves.length, total, emTex,
      em.c[0], em.c[1], em.c[2], sampleLight ? 1 : 0,
      cum[0], cum[1], cum[2], cum[3],
      mult[0], mult[1], mult[2], mult[3],
    );
  }

  // emissive triangles (mesh lights), weighted by area x emitted luminance
  const emitList: number[] = [];
  const weights: number[] = [];
  let emitTotal = 0;
  for (let t = 0; t < geom.triCount; t++) {
    const mi = geom.triMat[t];
    const e = matEmission[mi] ?? 0;
    if (e <= 0 || !matSampleLight[mi]) continue;
    const o = t * TRI_TEXELS * 4;
    const e1 = [geom.tri[o + 4], geom.tri[o + 5], geom.tri[o + 6]], e2 = [geom.tri[o + 8], geom.tri[o + 9], geom.tri[o + 10]];
    const cx = e1[1] * e2[2] - e1[2] * e2[1], cy = e1[2] * e2[0] - e1[0] * e2[2], cz = e1[0] * e2[1] - e1[1] * e2[0];
    const area = 0.5 * Math.hypot(cx, cy, cz);
    if (area <= 0) continue;
    const w = area * e;
    emitTotal += w;
    emitList.push(t);
    weights.push(w);
  }
  const emitters = new Float32Array(Math.max(1, emitList.length) * 4);
  let acc = 0;
  for (let i = 0; i < emitList.length; i++) {
    acc += weights[i];
    emitters[i * 4] = emitList[i];
    emitters[i * 4 + 1] = i === emitList.length - 1 ? 1 : acc / emitTotal;
  }

  // lamps
  const lightArr: number[] = [];
  let lightCount = 0;
  for (const ob of objs) {
    if (ob.type !== 'LAMP' || !ob.data) continue;
    const la = app.doc.lamps[ob.data];
    if (!la) continue;
    const cs = lampSettings(la);
    const P = cs.strength;
    if (P === 0) continue;
    const m = app.matrices.world(ob);
    const pos = new Vector3().setFromMatrixPosition(m);
    const dir = new Vector3(0, 0, -1).transformDirection(m);
    const flags = (cs.castShadow ? 1 : 0) + (cs.useMultipleImportance ? 2 : 0) + 4 * Math.min(1024, Math.max(0, Math.round(cs.maxBounces)));
    const col = la.color;
    let type: LightType, radius = 0, emit = [0, 0, 0], u = [0, 0, 0], v = [0, 0, 0], spotCos = -2, spotBlend = 0;
    switch (la.lampType) {
      case 'SUN': case 'HEMI': {
        type = LightType.SUN;
        // the size is the radius of a disk at unit distance (angular radius atan(size))
        const ang = la.lampType === 'HEMI' ? 0 : Math.atan(Math.max(0, la.shadowSoftSize));
        radius = ang;
        emit = [col[0] * P, col[1] * P, col[2] * P];
        break;
      }
      case 'AREA': {
        type = LightType.AREA;
        const sx = Math.max(1e-4, la.areaSize), sy = Math.max(1e-4, la.areaShape === 'RECTANGLE' ? la.areaSizeY : la.areaSize);
        const ux = new Vector3(1, 0, 0).transformDirection(m), uy = new Vector3(0, 1, 0).transformDirection(m);
        const sclX = new Vector3().setFromMatrixColumn(m, 0).length(), sclY = new Vector3().setFromMatrixColumn(m, 1).length();
        const hx = (sx * sclX) / 2, hy = (sy * sclY) / 2;
        u = [ux.x * hx, ux.y * hx, ux.z * hx];
        v = [uy.x * hy, uy.y * hy, uy.z * hy];
        const area = 4 * hx * hy;
        const L = (0.25 * P) / area;
        emit = [col[0] * L, col[1] * L, col[2] * L];
        break;
      }
      default: {
        type = la.lampType === 'SPOT' ? LightType.SPOT : LightType.POINT;
        radius = Math.max(0, la.shadowSoftSize);
        // radiant intensity P / 4pi (W/sr)
        const I = P / (4 * Math.PI);
        emit = [col[0] * I, col[1] * I, col[2] * I];
        if (type === LightType.SPOT) {
          spotCos = Math.cos(Math.min(Math.PI, la.spotSize) / 2);
          spotBlend = Math.max(0, Math.min(1, la.spotBlend));
        }
      }
    }
    lightArr.push(
      pos.x, pos.y, pos.z, type,
      dir.x, dir.y, dir.z, radius,
      emit[0], emit[1], emit[2], spotCos,
      u[0], u[1], u[2], spotBlend,
      v[0], v[1], v[2], flags,
    );
    lightCount++;
  }
  const meshLightProb = emitList.length ? (lightCount ? 0.5 : 1) : 0;

  // world
  const sc = app.scene;
  const w = sc.world ? app.doc.worlds[sc.world] : null;
  let world: WorldParams;
  if (w) {
    const ws = worldSettings(w);
    const sky = ws.colorSource === 'SKY';
    world = {
      mode: sky ? (w.useRealSky ? 2 : 1) : 0,
      horizon: (sky ? w.horizonColor : ws.color).slice() as Color3,
      zenith: w.zenithColor.slice() as Color3,
      strength: ws.strength,
      useAO: w.useAO, aoFactor: w.aoFactor, aoDistance: ws.aoDistance, visibleCamera: ws.visibleCamera,
    };
  } else {
    world = { mode: 0, horizon: [0, 0, 0], zenith: [0, 0, 0], strength: 0, useAO: false, aoFactor: 0, aoDistance: 10, visibleCamera: true };
  }
  void sceneSettings;

  return {
    materials: new Float32Array(matArr.length ? matArr : [0]),
    materialCount: mats.list.length,
    leaves: new Float32Array(leafArr.length ? leafArr : new Array(16).fill(0)),
    texRecords: new Float32Array(tp.records.length ? tp.records : new Array(28).fill(0)),
    images: tp.images,
    lights: new Float32Array(lightArr.length ? lightArr : new Array(20).fill(0)),
    lightCount,
    emitters,
    emitterCount: emitList.length,
    emitterTotal: emitTotal,
    meshLightProb,
    hasTransparent,
    world,
    key,
  };
}
