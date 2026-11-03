// Image datablocks (bpy.data.images): creation (blank / UV grid / colour grid), opening files,
// saving, and the runtime pixel store. The document keeps each image as a PNG data URL; at runtime
// every image has a canvas (painted on directly) and a shared three.js texture used by the
// viewport and the renderer, updated live while painting.

import { CanvasTexture, SRGBColorSpace, RepeatWrapping, type Texture } from 'three';
import { app } from '../app';
import type { BImage, Color4, Doc, TextureData } from '../core/types';
import { newId, uniqueName } from '../core/scene';
import { downloadFile, pickFile } from '../ui/dom';

interface ImageRuntime {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  /** Data URL the canvas currently shows (null: not loaded yet). */
  src: string | null;
  /** Increments whenever the pixels change. */
  version: number;
  tex: CanvasTexture | null;
  loading: string | null;
  /** Pixels as last opened / saved (Reload restores them). */
  saved: string | null;
}

const runtimes = new Map<string, ImageRuntime>();
const listeners = new Set<() => void>();

/** Called whenever image pixels change (editors redraw). */
export function onImagesChanged(fn: () => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }
function changed(): void { for (const l of listeners) l(); app.notify('view'); }

export function imagesOf(doc: Doc = app.doc): Record<string, BImage> {
  doc.images ??= {};
  return doc.images;
}

export function imageList(): BImage[] {
  return Object.values(app.doc.images ?? {});
}

export function getImage(id: string | null | undefined): BImage | null {
  return id ? app.doc.images?.[id] ?? null : null;
}

function runtime(img: BImage): ImageRuntime {
  let rt = runtimes.get(img.id);
  if (!rt) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, img.width);
    canvas.height = Math.max(1, img.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    rt = { canvas, ctx, src: null, version: 0, tex: null, loading: null, saved: img.data };
    runtimes.set(img.id, rt);
  }
  // the document changed (undo, file load): reload the pixels
  if (img.data !== rt.src && img.data !== rt.loading) load(img, rt);
  return rt;
}

function load(img: BImage, rt: ImageRuntime): void {
  const data = img.data;
  rt.loading = data;
  if (!data) {
    rt.ctx.clearRect(0, 0, rt.canvas.width, rt.canvas.height);
    rt.src = null;
    rt.loading = null;
    bump(rt);
    return;
  }
  const el = new Image();
  el.onload = () => {
    if (rt.loading !== data) return;
    if (rt.canvas.width !== el.naturalWidth || rt.canvas.height !== el.naturalHeight) {
      rt.canvas.width = el.naturalWidth;
      rt.canvas.height = el.naturalHeight;
      if (rt.tex) { rt.tex.dispose(); rt.tex = null; }
    }
    rt.ctx.clearRect(0, 0, rt.canvas.width, rt.canvas.height);
    rt.ctx.drawImage(el, 0, 0);
    rt.src = data;
    rt.loading = null;
    bump(rt);
    changed();
  };
  el.onerror = () => { if (rt.loading === data) { rt.loading = null; rt.src = data; } };
  el.src = data;
}

function bump(rt: ImageRuntime): void {
  rt.version++;
  if (rt.tex) rt.tex.needsUpdate = true;
}

/** Is the image's pixel data available (decoded)? */
export function imageReady(img: BImage): boolean {
  const rt = runtime(img);
  return rt.src === img.data && !rt.loading;
}

/** Canvas holding the image pixels (kept up to date with the document). */
export function imageCanvas(img: BImage): HTMLCanvasElement { return runtime(img).canvas; }

export function imageContext(img: BImage): CanvasRenderingContext2D { return runtime(img).ctx; }

export function imageVersion(img: BImage): number { return runtime(img).version; }

/** Shared three.js texture of an image (updated in place while painting). */
export function imageTexture(img: BImage): Texture {
  const rt = runtime(img);
  if (!rt.tex) {
    rt.tex = new CanvasTexture(rt.canvas);
    rt.tex.colorSpace = SRGBColorSpace;
    rt.tex.wrapS = rt.tex.wrapT = RepeatWrapping;
    rt.tex.anisotropy = 4;
  }
  return rt.tex;
}

/** Pixels were changed on the canvas (painting): refresh textures and views. */
export function imagePixelsChanged(img: BImage): void {
  const rt = runtime(img);
  bump(rt);
  changed();
}

/** Store the canvas pixels in the document (end of a paint stroke / tool). */
export function commitImage(img: BImage): void {
  const rt = runtime(img);
  const url = rt.canvas.toDataURL('image/png');
  img.data = url;
  img.width = rt.canvas.width;
  img.height = rt.canvas.height;
  rt.src = url;
}

// ------------------------------------------------------------------ generated patterns

function fillBlank(ctx: CanvasRenderingContext2D, w: number, h: number, color: Color4, alpha: boolean): void {
  ctx.clearRect(0, 0, w, h);
  const a = alpha ? color[3] : 1;
  ctx.fillStyle = `rgba(${Math.round(color[0] * 255)},${Math.round(color[1] * 255)},${Math.round(color[2] * 255)},${a})`;
  ctx.fillRect(0, 0, w, h);
}

/** UV Grid: a grey checker with fine grid lines and crosses, for checking stretching. */
function drawUVGrid(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const n = 8;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    ctx.fillStyle = (i + j) % 2 ? '#262626' : '#d4d4d4';
    ctx.fillRect(Math.floor((i * w) / n), Math.floor((j * h) / n), Math.ceil(w / n), Math.ceil(h / n));
  }
  // thin sub-grid
  ctx.lineWidth = Math.max(1, w / 1024);
  for (let k = 0; k <= n * 4; k++) {
    const x = (k * w) / (n * 4), y = (k * h) / (n * 4);
    ctx.strokeStyle = 'rgba(128,128,128,0.55)';
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
  // small crosses at cell centres
  ctx.lineWidth = Math.max(1, w / 512);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const cx = ((i + 0.5) * w) / n, cy = ((j + 0.5) * h) / n, r = Math.min(w, h) / (n * 8);
    ctx.strokeStyle = (i + j) % 2 ? '#d4d4d4' : '#262626';
    ctx.beginPath(); ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy); ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r); ctx.stroke();
  }
}

/** Color Grid: coloured cells labelled with a letter and a number. */
function drawColorGrid(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const n = 8;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const hue = (i / n) * 360;
    const light = 30 + (j / (n - 1)) * 45;
    ctx.fillStyle = `hsl(${hue}, 75%, ${light}%)`;
    const x = Math.floor((i * w) / n), y = Math.floor((j * h) / n);
    ctx.fillRect(x, y, Math.ceil(w / n), Math.ceil(h / n));
    // inner checker for orientation
    const cw = w / n / 2, ch = h / n / 2;
    ctx.fillStyle = `hsl(${hue}, 75%, ${light + 10}%)`;
    ctx.fillRect(x, y, cw, ch);
    ctx.fillRect(x + cw, y + ch, cw, ch);
    const label = `${String.fromCharCode(65 + i)}${n - j}`;
    ctx.fillStyle = light > 55 ? '#000' : '#fff';
    ctx.font = `bold ${Math.max(8, Math.round(h / n / 3))}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + w / n / 2, y + h / n / 2);
  }
  ctx.strokeStyle = '#000';
  ctx.lineWidth = Math.max(1, w / 512);
  for (let k = 0; k <= n; k++) {
    const x = (k * w) / n, y = (k * h) / n;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
}

/** Fill a canvas with the image's generated pattern. */
function generate(img: BImage, canvas: HTMLCanvasElement): void {
  canvas.width = Math.max(1, img.width);
  canvas.height = Math.max(1, img.height);
  const ctx = canvas.getContext('2d')!;
  if (img.generatedType === 'UV_GRID') drawUVGrid(ctx, canvas.width, canvas.height);
  else if (img.generatedType === 'COLOR_GRID') drawColorGrid(ctx, canvas.width, canvas.height);
  else fillBlank(ctx, canvas.width, canvas.height, img.color, img.useAlpha);
}

export interface NewImageOptions {
  name: string;
  width: number;
  height: number;
  color: Color4;
  alpha: boolean;
  generatedType: BImage['generatedType'];
}

export function uniqueImageName(base: string): string {
  return uniqueName(imageList().map((i) => i.name), base);
}

/** Create a generated image datablock (Image > New Image). */
export function createImage(o: NewImageOptions): BImage {
  const img: BImage = {
    id: newId(app.doc, 'IM'), name: uniqueImageName(o.name || 'Untitled'), width: Math.max(1, Math.round(o.width)), height: Math.max(1, Math.round(o.height)),
    source: 'GENERATED', generatedType: o.generatedType, color: [o.color[0], o.color[1], o.color[2], o.color[3]], useAlpha: o.alpha,
    data: null, filepath: '', packed: true, fakeUser: false,
  };
  const canvas = document.createElement('canvas');
  generate(img, canvas);
  img.data = canvas.toDataURL('image/png');
  imagesOf()[img.id] = img;
  const rt = runtime(img);
  rt.canvas.width = canvas.width;
  rt.canvas.height = canvas.height;
  rt.ctx.drawImage(canvas, 0, 0);
  rt.src = img.data;
  rt.saved = img.data;
  bump(rt);
  return img;
}

/** Regenerate a generated image (after changing its generated settings, or Reload). */
export function regenerateImage(img: BImage): void {
  const rt = runtime(img);
  generate(img, rt.canvas);
  if (rt.tex) { rt.tex.dispose(); rt.tex = null; }
  commitImage(img);
  bump(rt);
  changed();
}

/** Read an image file into a new datablock (Image > Open Image). */
export async function openImageFile(): Promise<BImage | null> {
  const file = await pickFile('image/*');
  if (!file) return null;
  const url = await new Promise<string | null>((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(typeof r.result === 'string' ? r.result : null);
    r.onerror = () => resolve(null);
    r.readAsDataURL(file);
  });
  if (!url) { app.report('ERROR', `Cannot read image "${file.name}"`); return null; }
  const dims = await new Promise<{ w: number; h: number } | null>((resolve) => {
    const el = new Image();
    el.onload = () => resolve({ w: el.naturalWidth, h: el.naturalHeight });
    el.onerror = () => resolve(null);
    el.src = url;
  });
  if (!dims) { app.report('ERROR', `Cannot decode image "${file.name}"`); return null; }
  return addImageFromData(file.name, url, dims.w, dims.h);
}

export function addImageFromData(name: string, url: string, w: number, h: number): BImage {
  const img: BImage = {
    id: newId(app.doc, 'IM'), name: uniqueImageName(name), width: w, height: h, source: 'FILE', generatedType: 'BLANK',
    color: [0, 0, 0, 1], useAlpha: true, data: url, filepath: `//${name}`, packed: true, fakeUser: false,
  };
  imagesOf()[img.id] = img;
  runtime(img).saved = url;
  return img;
}

/** Download the image as a PNG file (Image > Save As Image). */
export function saveImageAs(img: BImage): void {
  const rt = runtime(img);
  rt.canvas.toBlob((blob) => {
    if (!blob) { app.report('ERROR', 'Could not encode the image'); return; }
    const base = img.name.replace(/\.(png|jpe?g|webp|bmp|tga)$/i, '');
    downloadFile(`${base}.png`, blob);
  }, 'image/png');
  rt.saved = rt.canvas.toDataURL('image/png');
  app.report('INFO', `Saved "${img.name}"`);
}

/** Restore the pixels as last opened / saved (Image > Reload). Returns false when nothing to restore. */
export function reloadImage(img: BImage): boolean {
  if (img.source === 'GENERATED') { regenerateImage(img); return true; }
  const rt = runtime(img);
  if (!rt.saved) return false;
  img.data = rt.saved;
  load(img, rt);
  return true;
}

/** Number of users of an image (textures referencing it). */
export function imageUsers(id: string): number {
  let n = 0;
  for (const t of Object.values(app.doc.textures)) if ((t as TextureData).image === id) n++;
  return n + (getImage(id)?.fakeUser ? 1 : 0);
}

/** Effective image of a texture (null when it has none). */
export function textureImage(t: TextureData | null | undefined): BImage | null {
  return t && t.type === 'IMAGE' ? getImage(t.image) : null;
}

/** Read RGBA pixels of an image (for baking / sampling). */
export function imagePixels(img: BImage): ImageData {
  const rt = runtime(img);
  return rt.ctx.getImageData(0, 0, rt.canvas.width, rt.canvas.height);
}

/** Write RGBA pixels into an image and commit. */
export function setImagePixels(img: BImage, data: ImageData): void {
  const rt = runtime(img);
  if (rt.canvas.width !== data.width || rt.canvas.height !== data.height) {
    rt.canvas.width = data.width;
    rt.canvas.height = data.height;
    if (rt.tex) { rt.tex.dispose(); rt.tex = null; }
  }
  rt.ctx.putImageData(data, 0, 0);
  commitImage(img);
  bump(rt);
  changed();
}
