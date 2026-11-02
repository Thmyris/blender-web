// Preview images for the Properties editor (Blender's `template_preview`).
//
// Material and lamp previews are rendered with ONE shared offscreen WebGLRenderer and then
// copied into each panel's 2D canvas; world and texture previews are drawn on the CPU with a
// 2D canvas. Every preview element only re-renders when a key built from its inputs (and the
// canvas size) changes.

import {
  AmbientLight, BoxGeometry, BufferAttribute, BufferGeometry, Color, DirectionalLight, HemisphereLight, Mesh,
  MeshBasicMaterial, MeshPhongMaterial, PerspectiveCamera, PlaneGeometry, PointLight, Scene as ThreeScene,
  SphereGeometry, SpotLight, WebGLRenderer, SRGBColorSpace, DoubleSide, type Material,
} from 'three';
import { app } from '../../app';
import type { LampData, MaterialData, TextureData, TextureSlot, WorldData } from '../../core/types';
import { h } from '../../ui/dom';
import { colorToCss, linearToSrgb } from '../../ui/format';
import type { Layout } from '../../ui/layout';
import { applyOrcoTexture, buildTextureForMaterial } from '../view3d/textures';

const PREVIEW_HEIGHT = 170;

// ------------------------------------------------------------------ shared renderer

let renderer: WebGLRenderer | null = null;
let rendererFailed = false;

function getRenderer(): WebGLRenderer | null {
  if (renderer || rendererFailed) return renderer;
  try {
    const canvas = document.createElement('canvas');
    renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.setClearColor(0x000000, 0);
  } catch (err) {
    console.warn('properties preview: WebGL unavailable', err);
    rendererFailed = true;
    renderer = null;
  }
  return renderer;
}

/** Add Blender "generated" coordinates (bounding box mapped to -1..1) used by the texture shader. */
function withOrco(g: BufferGeometry): BufferGeometry {
  g.computeBoundingBox();
  const b = g.boundingBox!;
  const pos = g.getAttribute('position');
  const orco = new Float32Array(pos.count * 3);
  const min = [b.min.x, b.min.y, b.min.z], max = [b.max.x, b.max.y, b.max.z];
  for (let i = 0; i < pos.count; i++) {
    for (let a = 0; a < 3; a++) {
      const size = max[a] - min[a];
      orco[i * 3 + a] = size > 1e-9 ? ((pos.getComponent(i, a) - min[a]) / size) * 2 - 1 : 0;
    }
  }
  g.setAttribute('orco', new BufferAttribute(orco, 3));
  return g;
}

let geoms: Record<string, BufferGeometry> | null = null;
function geometry(kind: string): BufferGeometry {
  geoms ??= {
    SPHERE: withOrco(new SphereGeometry(1, 64, 40)),
    CUBE: withOrco(new BoxGeometry(1.25, 1.25, 1.25)),
    FLAT: withOrco(new PlaneGeometry(2.3, 2.3)),
  };
  return geoms[kind] ?? geoms.SPHERE;
}

function previewCamera(w: number, hgt: number): PerspectiveCamera {
  const cam = new PerspectiveCamera(32, w / Math.max(1, hgt), 0.1, 100);
  cam.position.set(0, 0, 4.6);
  cam.lookAt(0, 0, 0);
  return cam;
}

function renderInto(target: HTMLCanvasElement, scene: ThreeScene, cam: PerspectiveCamera, background: (ctx: CanvasRenderingContext2D, w: number, h: number) => void): void {
  const ctx = target.getContext('2d');
  if (!ctx) return;
  const w = target.width, hgt = target.height;
  background(ctx, w, hgt);
  const r = getRenderer();
  if (!r) {
    ctx.fillStyle = '#000';
    ctx.font = '11px sans-serif';
    ctx.fillText('Preview unavailable (no WebGL)', 8, 16);
    return;
  }
  r.setPixelRatio(1);
  r.setSize(w, hgt, false);
  r.clear();
  r.render(scene, cam);
  ctx.drawImage(r.domElement, 0, 0, w, hgt);
}

/** Blender's preview backdrop: a checker pattern. */
function checker(ctx: CanvasRenderingContext2D, w: number, hgt: number): void {
  const s = Math.max(8, Math.round(hgt / 12));
  for (let y = 0; y < hgt; y += s) {
    for (let x = 0; x < w; x += s) {
      ctx.fillStyle = ((x / s + y / s) & 1) ? '#5f5f5f' : '#7a7a7a';
      ctx.fillRect(x, y, s, s);
    }
  }
}

// ------------------------------------------------------------------ material preview

export function materialPreviewKey(ma: MaterialData | null): string {
  if (!ma) return 'none';
  const info = buildTextureForMaterial(ma);
  const tex = info ? { s: info.slot, t: { ...info.tex, imageData: info.tex.imageData?.length ?? 0 }, loaded: !!info.image?.image } : null;
  const w = worldOf();
  return JSON.stringify([ma.diffuseColor, ma.diffuseIntensity, ma.specularColor, ma.specularIntensity, ma.specularHardness,
    ma.emit, ma.useShadeless, ma.useTransparency, ma.alpha, ma.previewType, ma.type, tex, w?.horizonColor, w?.zenithColor, w?.ambientColor]);
}

function worldOf(): WorldData | null {
  const id = app.scene.world;
  return id ? app.doc.worlds[id] ?? null : null;
}

function buildMaterial(ma: MaterialData): Material {
  const diff = new Color(ma.diffuseColor[0], ma.diffuseColor[1], ma.diffuseColor[2]);
  const transparent = ma.useTransparency && ma.alpha < 1;
  let mat: MeshPhongMaterial | MeshBasicMaterial;
  if (ma.useShadeless) {
    mat = new MeshBasicMaterial({ color: diff, transparent, opacity: ma.useTransparency ? ma.alpha : 1 });
  } else {
    mat = new MeshPhongMaterial({
      color: diff.clone().multiplyScalar(ma.diffuseIntensity),
      specular: new Color(ma.specularColor[0], ma.specularColor[1], ma.specularColor[2]).multiplyScalar(ma.specularIntensity),
      shininess: Math.max(1, ma.specularHardness),
      emissive: diff.clone().multiplyScalar(ma.emit),
      transparent, opacity: ma.useTransparency ? ma.alpha : 1,
    });
  }
  if (ma.type === 'WIRE') mat.wireframe = true;
  mat.side = DoubleSide;
  applyOrcoTexture(mat, buildTextureForMaterial(ma), ma);
  return mat;
}

export function drawMaterialPreview(target: HTMLCanvasElement, ma: MaterialData): void {
  const scene = new ThreeScene();
  const kind = ma.previewType === 'CUBE' ? 'CUBE' : ma.previewType === 'FLAT' ? 'FLAT' : 'SPHERE';
  const mat = buildMaterial(ma);
  const mesh = new Mesh(geometry(kind), mat);
  if (kind === 'CUBE') mesh.rotation.set(0.6, -0.75, 0);
  scene.add(mesh);
  // Roughly Blender's preview lighting: a key lamp up-left, a weaker fill lamp right, world ambient.
  const key = new DirectionalLight(0xffffff, 2.6);
  key.position.set(-3, 4, 4);
  const fill = new DirectionalLight(0xffffff, 0.7);
  fill.position.set(4, -1, 2);
  const w = worldOf();
  const amb = new AmbientLight(new Color(...(w?.ambientColor ?? [0, 0, 0])), Math.PI);
  scene.add(key, fill, amb);
  const cam = previewCamera(target.width, target.height);
  const bg = ma.previewType === 'SPHERE_A' && w
    ? (ctx: CanvasRenderingContext2D, cw: number, ch: number) => drawSkyGradient(ctx, cw, ch, w)
    : checker;
  renderInto(target, scene, cam, bg);
  mat.dispose();
}

// ------------------------------------------------------------------ lamp preview

export function lampPreviewKey(la: LampData | null): string {
  if (!la) return 'none';
  return JSON.stringify([la.lampType, la.color, la.energy, la.distance, la.falloff, la.useNegative, la.spotSize, la.spotBlend, la.useDiffuse]);
}

export function drawLampPreview(target: HTMLCanvasElement, la: LampData): void {
  const scene = new ThreeScene();
  // a large white plane seen at a grazing angle, lit by the lamp
  const plane = new Mesh(new PlaneGeometry(14, 14), new MeshPhongMaterial({ color: 0xcccccc, specular: 0x222222, shininess: 20 }));
  plane.rotation.x = -1.05;
  plane.position.set(0, -0.6, 0);
  scene.add(plane);
  const col = new Color(la.color[0], la.color[1], la.color[2]);
  const energy = (la.useNegative ? -1 : 1) * la.energy * (la.useDiffuse ? 1 : 0);
  const decay = la.falloff === 'CONSTANT' ? 0 : la.falloff === 'INVERSE_LINEAR' ? 1 : 2;
  switch (la.lampType) {
    case 'SUN': {
      const l = new DirectionalLight(col, energy * Math.PI * 0.8);
      l.position.set(0.5, 3, 1);
      scene.add(l);
      break;
    }
    case 'HEMI': {
      scene.add(new HemisphereLight(col, new Color(0, 0, 0), Math.max(0, energy) * Math.PI * 0.5));
      break;
    }
    case 'SPOT': {
      const l = new SpotLight(col, energy * 18, la.distance * 2, Math.min(Math.PI / 2 - 0.01, la.spotSize / 2), Math.min(1, la.spotBlend), decay);
      l.position.set(0, 2.2, 1.0);
      l.target.position.set(0, -0.6, -0.4);
      scene.add(l, l.target);
      break;
    }
    default: {
      const l = new PointLight(col, energy * 12, la.distance * 2, decay);
      l.position.set(0, 0.3, 0.6);
      scene.add(l);
    }
  }
  const cam = previewCamera(target.width, target.height);
  renderInto(target, scene, cam, (ctx, w, hgt) => { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, hgt); });
  (plane.material as Material).dispose();
  plane.geometry.dispose();
}

// ------------------------------------------------------------------ world preview (2D)

export function worldPreviewKey(w: WorldData | null): string {
  return w ? JSON.stringify([w.horizonColor, w.zenithColor, w.usePaperSky, w.useBlendSky, w.useRealSky, w.exposure, w.colorRange]) : 'none';
}

function drawSkyGradient(ctx: CanvasRenderingContext2D, cw: number, ch: number, w: WorldData): void {
  // exposure / range approximate Blender's tone mapping of the sky colour
  const tone = (c: number[]) => c.map((x) => Math.min(1, (x * Math.pow(2, w.exposure)) / Math.max(1e-3, w.colorRange)));
  const hor = colorToCss(tone(w.horizonColor)), zen = colorToCss(tone(w.zenithColor));
  if (!w.useBlendSky) { ctx.fillStyle = hor; ctx.fillRect(0, 0, cw, ch); return; }
  const g = ctx.createLinearGradient(0, 0, 0, ch);
  if (w.useRealSky) {
    // real sky: horizon in the middle, zenith above and nadir below
    g.addColorStop(0, zen); g.addColorStop(0.5, hor); g.addColorStop(1, zen);
  } else {
    g.addColorStop(0, zen); g.addColorStop(1, hor);
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, cw, ch);
}

export function drawWorldPreview(target: HTMLCanvasElement, w: WorldData): void {
  const ctx = target.getContext('2d');
  if (ctx) drawSkyGradient(ctx, target.width, target.height, w);
}

// ------------------------------------------------------------------ texture preview (2D, CPU)

// JS port of the generated-texture GLSL in view3d/textures.ts, evaluated on the z = 0 plane.
function fract(x: number): number { return x - Math.floor(x); }
function hash3(x: number, y: number, z: number): [number, number, number] {
  const a = x * 127.1 + y * 311.7 + z * 74.7, b = x * 269.5 + y * 183.3 + z * 246.1, c = x * 113.5 + y * 271.9 + z * 124.6;
  return [-1 + 2 * fract(Math.sin(a) * 43758.5453123), -1 + 2 * fract(Math.sin(b) * 43758.5453123), -1 + 2 * fract(Math.sin(c) * 43758.5453123)];
}
function gnoise(x: number, y: number, z: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), uz = fz * fz * (3 - 2 * fz);
  const d = (ox: number, oy: number, oz: number) => { const g = hash3(ix + ox, iy + oy, iz + oz); return g[0] * (fx - ox) + g[1] * (fy - oy) + g[2] * (fz - oz); };
  const mix = (a: number, b: number, t: number) => a + (b - a) * t;
  return mix(mix(mix(d(0, 0, 0), d(1, 0, 0), ux), mix(d(0, 1, 0), d(1, 1, 0), ux), uy),
    mix(mix(d(0, 0, 1), d(1, 0, 1), ux), mix(d(0, 1, 1), d(1, 1, 1), ux), uy), uz);
}
function turb(x: number, y: number, z: number, depth: number, hard: boolean): number {
  let sum = 0, amp = 1, norm = 0;
  for (let i = 0; i <= Math.min(7, depth); i++) {
    let n = gnoise(x, y, z) * 0.5 + 0.5;
    if (hard) n = Math.abs(2 * n - 1);
    sum += amp * n; norm += amp; amp *= 0.5; x *= 2; y *= 2; z *= 2;
  }
  return sum / norm;
}
function voronoiF1(x: number, y: number, z: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  let d = 8;
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
    const o = hash3(ix + a, iy + b, iz + c);
    const rx = a + (o[0] * 0.5 + 0.5) - fx, ry = b + (o[1] * 0.5 + 0.5) - fy, rz = c + (o[2] * 0.5 + 0.5) - fz;
    d = Math.min(d, rx * rx + ry * ry + rz * rz);
  }
  return Math.sqrt(d);
}

/** Evaluate a procedural texture: returns [r,g,b] (0..1, linear) or a single intensity as [v,v,v]. */
function evalTex(t: TextureData, x: number, y: number, z: number): [number, number, number] {
  const ns = Math.max(t.noiseScale, 1e-4);
  const hard = t.noiseType === 'HARD_NOISE';
  let v = 0;
  switch (t.type) {
    case 'CLOUDS': v = turb(x / ns, y / ns, z / ns, Math.round(t.noiseDepth), hard); break;
    case 'BLEND': {
      const r = Math.hypot(x, y, z);
      switch (t.progression) {
        case 'LINEAR': v = (1 + x) / 2; break;
        case 'QUADRATIC': v = Math.max(0, (1 + x) / 2) ** 2; break;
        case 'EASING': { const c = Math.min(1, Math.max(0, (1 + x) / 2)); v = c * c * (3 - 2 * c); break; }
        case 'DIAGONAL': v = (2 + x + y) / 4; break;
        case 'SPHERICAL': v = Math.max(0, 1 - r); break;
        case 'QUADRATIC_SPHERE': v = Math.max(0, 1 - r) ** 2; break;
        default: v = Math.atan2(y, x) / (Math.PI * 2) + 0.5;
      }
      break;
    }
    case 'WOOD': {
      const n = t.turbulence * turb(x / ns, y / ns, z / ns, Math.round(t.noiseDepth), hard) * 0.1;
      if (t.woodType === 'BANDS') v = 0.5 + 0.5 * Math.sin((x + y + z) * 10);
      else if (t.woodType === 'RINGS') v = 0.5 + 0.5 * Math.sin(Math.hypot(x, y) * 20);
      else if (t.woodType === 'BANDNOISE') v = 0.5 + 0.5 * Math.sin((x + y + z) * 10 + n * 10);
      else v = 0.5 + 0.5 * Math.sin(Math.hypot(x, y) * 20 + n * 10);
      break;
    }
    case 'MARBLE': { const n = turb(x / ns, y / ns, z / ns, Math.round(t.noiseDepth), hard); v = Math.sqrt(Math.max(0, 0.5 + 0.5 * Math.sin((x + t.turbulence * n) * 5))); break; }
    case 'VORONOI': v = Math.min(1, Math.max(0, voronoiF1(x / ns, y / ns, z / ns))); break;
    case 'MAGIC': {
      const px = x * t.turbulence, py = y * t.turbulence, pz = z * t.turbulence;
      return [0.5 + 0.5 * Math.sin(px * 3 + py), 0.5 + 0.5 * Math.cos(py * 3 - pz), 0.5 + 0.5 * Math.sin(pz * 3 + px)].map((c) => c * t.intensity) as [number, number, number];
    }
    case 'STUCCI': { const n = turb(x / ns, y / ns, z / ns, 2, hard); const e = Math.min(1, Math.max(0, (n - 0.45) / 0.15)); v = e * e * (3 - 2 * e); break; }
    case 'NOISE': v = fract(Math.sin(Math.floor(x * 200) * 12.9898 + Math.floor(y * 200) * 78.233 + Math.floor(z * 200) * 37.719) * 43758.5453); break;
    default: v = 0;
  }
  v = Math.min(1, Math.max(0, (v - 0.5) * t.contrast + 0.5)) * t.intensity;
  return [v, v, v];
}

const imageCache = new Map<string, HTMLImageElement>();
function cachedImage(t: TextureData, onLoad: () => void): HTMLImageElement | null {
  if (!t.imageData) return null;
  const key = `${t.id}:${t.imageData.length}:${t.imageData.slice(-32)}`;
  let img = imageCache.get(key);
  if (!img) {
    img = new Image();
    img.onload = onLoad;
    img.src = t.imageData;
    imageCache.set(key, img);
  }
  return img;
}

export function texturePreviewKey(t: TextureData | null, slot: TextureSlot | null): string {
  if (!t) return 'none';
  const img = t.type === 'IMAGE' && t.imageData ? cachedImage(t, () => app.notify('view')) : null;
  return JSON.stringify([{ ...t, imageData: t.imageData?.length ?? 0, name: '' }, img?.complete ?? false, slot?.color, slot?.useRgbToIntensity]);
}

export function drawTexturePreview(target: HTMLCanvasElement, t: TextureData): void {
  const ctx = target.getContext('2d');
  if (!ctx) return;
  const W = target.width, H = target.height;
  checker(ctx, W, H);
  if (t.type === 'NONE') return;
  if (t.type === 'IMAGE') {
    const img = cachedImage(t, () => app.notify('view'));
    if (!img || !img.complete || !img.naturalWidth) return;
    const s = Math.min(W / img.naturalWidth, H / img.naturalHeight);
    const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
    ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
    return;
  }
  // evaluate on a small square grid and scale it up (Blender's preview shows the -1..1 range)
  const N = 112;
  const size = Math.min(W, H);
  const buf = document.createElement('canvas');
  buf.width = buf.height = N;
  const bctx = buf.getContext('2d')!;
  const img = bctx.createImageData(N, N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = (i / (N - 1)) * 2 - 1, y = 1 - (j / (N - 1)) * 2;
      let [r, g, b] = evalTex(t, x, y, 0);
      if (t.type === 'MAGIC') { r *= t.colorTint[0]; g *= t.colorTint[1]; b *= t.colorTint[2]; }
      const k = (j * N + i) * 4;
      img.data[k] = Math.round(Math.min(1, Math.max(0, linearToSrgb(r))) * 255);
      img.data[k + 1] = Math.round(Math.min(1, Math.max(0, linearToSrgb(g))) * 255);
      img.data[k + 2] = Math.round(Math.min(1, Math.max(0, linearToSrgb(b))) * 255);
      img.data[k + 3] = 255;
    }
  }
  bctx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(buf, (W - size) / 2, (H - size) / 2, size, size);
}

// ------------------------------------------------------------------ preview widget

/**
 * Add a preview canvas to a layout. `key()` is evaluated on every refresh; the canvas is redrawn
 * only when it (or the canvas size) changes.
 */
export function previewCanvas(l: Layout, key: () => string, draw: (c: HTMLCanvasElement) => void, height = PREVIEW_HEIGHT): HTMLElement {
  const canvas = h('canvas', { style: { width: '100%', height: `${height}px`, display: 'block', borderRadius: '3px' } }) as HTMLCanvasElement;
  const wrap = h('div', { style: { flex: '1 1 auto', minWidth: '0', border: '1px solid #191919', borderRadius: '4px', overflow: 'hidden', background: '#5f5f5f' } }, canvas);
  let last = '';
  const update = () => {
    if (!canvas.isConnected) { last = ''; return; }
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), hh = Math.max(1, Math.round(height * dpr));
    const k = `${w}x${hh}|${key()}`;
    if (k === last) return;
    last = k;
    canvas.width = w;
    canvas.height = hh;
    try { draw(canvas); } catch (err) { console.error('preview', err); }
  };
  l.custom(wrap);
  l.root.widgets.push({ update });
  // the canvas has no size until it is in the DOM
  requestAnimationFrame(update);
  return wrap;
}
