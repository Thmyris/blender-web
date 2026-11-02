// Media files (movies, images, image sequences, sounds) used by the sequencer, the movie clip editor
// and the compositor's Image node. The document stores a MediaData record per file: its name and,
// when the file is smaller than 5 MB, a data URL so it survives save/load. The file itself is kept in
// memory as an object URL while the page is open. Larger files show as missing after a reload.

import { app } from '../app';
import type { Doc } from '../core/types';
import type { MediaData, MediaKind } from '../core/edtypes';
import { newId, uniqueName } from '../core/scene';

export const EMBED_LIMIT = 5 * 1024 * 1024;

interface Runtime {
  url: string | null;
  urls?: (string | null)[];
  img?: HTMLImageElement;
  imgs?: (HTMLImageElement | null)[];
  video?: HTMLVideoElement;
  audio?: HTMLAudioElement;
  /** Peak envelope for the waveform display (one value per 1/100 s). */
  peaks?: Float32Array;
  ready: boolean;
  failed: boolean;
}

const runtime = new Map<string, Runtime>();
/** Runtime cache key: ids are only unique within a document, so the file path is part of the key. */
function rkey(md: MediaData): string { return `${md.id}|${md.filepath}|${md.files?.length ?? 0}`; }
/** Called when a media element finished loading or seeking (to redraw previews). */
export const mediaListeners = new Set<() => void>();
function changed(): void { for (const l of mediaListeners) l(); }

export function mediaColl(doc: Doc = app.doc): Record<string, MediaData> {
  return (doc.media ??= {});
}

export function getMedia(id: string | null | undefined, doc: Doc = app.doc): MediaData | null {
  return id ? doc.media?.[id] ?? null : null;
}

function readDataUrl(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });
}

export function kindOfFile(f: File): MediaKind | null {
  const t = f.type, n = f.name.toLowerCase();
  if (t.startsWith('video/') || /\.(mp4|webm|ogv|mov|mkv|m4v|avi)$/.test(n)) return 'MOVIE';
  if (t.startsWith('audio/') || /\.(mp3|wav|ogg|oga|flac|m4a|aac|opus)$/.test(n)) return 'SOUND';
  if (t.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/.test(n)) return 'IMAGE';
  return null;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Cannot decode image'));
    img.src = url;
  });
}

function loadVideo(url: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.crossOrigin = 'anonymous';
    v.onloadeddata = () => resolve(v);
    v.onerror = () => reject(new Error('Cannot decode movie'));
    v.src = url;
    v.load();
  });
}

function loadAudio(url: string): Promise<HTMLAudioElement> {
  return new Promise((resolve, reject) => {
    const a = document.createElement('audio');
    a.preload = 'auto';
    a.onloadedmetadata = () => resolve(a);
    a.onerror = () => reject(new Error('Cannot decode sound'));
    a.src = url;
  });
}

async function computePeaks(blob: Blob | string): Promise<Float32Array | undefined> {
  try {
    const buf = typeof blob === 'string' ? await (await fetch(blob)).arrayBuffer() : await blob.arrayBuffer();
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return undefined;
    const ctx = new Ctx();
    const audio = await ctx.decodeAudioData(buf);
    void ctx.close();
    const ch = audio.getChannelData(0);
    const step = Math.max(1, Math.floor(audio.sampleRate / 100));
    const n = Math.ceil(ch.length / step);
    const peaks = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let m = 0;
      for (let j = i * step; j < Math.min(ch.length, (i + 1) * step); j++) { const v = Math.abs(ch[j]); if (v > m) m = v; }
      peaks[i] = m;
    }
    return peaks;
  } catch { return undefined; }
}

/** Import files as a new media item. Several image files make an image sequence (sorted by name). */
export async function importMedia(files: File[], forceKind?: MediaKind): Promise<MediaData | null> {
  if (!files.length) return null;
  const sorted = files.slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const kind = forceKind ?? kindOfFile(sorted[0]);
  if (!kind) { app.report('ERROR', `Unsupported file type: ${sorted[0].name}`); return null; }
  const doc = app.doc;
  const coll = mediaColl(doc);
  const id = newId(doc, 'MD');
  const base = sorted[0].name;
  const md: MediaData = {
    id, name: uniqueName([], base, undefined, Object.values(coll)), kind, filepath: `//${base}`,
    width: 0, height: 0, duration: 0, fps: app.scene.fps / (app.scene.fpsBase || 1), fakeUser: false,
  };
  const rt: Runtime = { url: null, ready: false, failed: false };
  try {
    if (kind === 'IMAGE' && sorted.length > 1) {
      md.files = [];
      rt.urls = [];
      rt.imgs = [];
      let total = 0;
      for (const f of sorted) total += f.size;
      for (const f of sorted) {
        const url = URL.createObjectURL(f);
        rt.urls.push(url);
        rt.imgs.push(null);
        md.files.push({ name: f.name, dataUrl: total < EMBED_LIMIT ? await readDataUrl(f) : undefined });
      }
      const first = await loadImage(rt.urls[0]!);
      rt.imgs[0] = first;
      md.width = first.naturalWidth; md.height = first.naturalHeight;
      md.duration = sorted.length / md.fps;
    } else {
      const f = sorted[0];
      rt.url = URL.createObjectURL(f);
      if (f.size < EMBED_LIMIT) md.dataUrl = await readDataUrl(f);
      if (kind === 'IMAGE') {
        rt.img = await loadImage(rt.url);
        md.width = rt.img.naturalWidth; md.height = rt.img.naturalHeight;
        md.duration = 1 / md.fps;
      } else if (kind === 'MOVIE') {
        rt.video = await loadVideo(rt.url);
        md.width = rt.video.videoWidth; md.height = rt.video.videoHeight;
        md.duration = Number.isFinite(rt.video.duration) ? rt.video.duration : 1;
        rt.video.addEventListener('seeked', changed);
      } else {
        rt.audio = await loadAudio(rt.url);
        md.duration = Number.isFinite(rt.audio.duration) ? rt.audio.duration : 1;
        void computePeaks(f).then((p) => { rt.peaks = p; changed(); });
      }
    }
  } catch (err) {
    app.report('ERROR', `Cannot open "${base}": ${(err as Error).message}`);
    return null;
  }
  rt.ready = true;
  runtime.set(rkey(md), rt);
  coll[id] = md;
  return md;
}

/** Runtime element of a media item, loading it from the embedded data URL after a reload. */
function ensureRuntime(md: MediaData): Runtime {
  let rt = runtime.get(rkey(md));
  if (rt) return rt;
  rt = { url: null, ready: false, failed: false };
  runtime.set(rkey(md), rt);
  const r = rt;
  if (md.files) {
    r.urls = md.files.map((f) => f.dataUrl ?? null);
    r.imgs = md.files.map(() => null);
    if (!r.urls.some(Boolean)) { r.failed = true; return r; }
    r.ready = true;
    return r;
  }
  if (!md.dataUrl) { r.failed = true; return r; }
  r.url = md.dataUrl;
  const done = () => { r.ready = true; changed(); app.notify('view'); };
  const fail = () => { r.failed = true; changed(); };
  if (md.kind === 'IMAGE') loadImage(md.dataUrl).then((img) => { r.img = img; done(); }, fail);
  else if (md.kind === 'MOVIE') loadVideo(md.dataUrl).then((v) => { r.video = v; v.addEventListener('seeked', changed); done(); }, fail);
  else loadAudio(md.dataUrl).then((a) => { r.audio = a; done(); void computePeaks(md.dataUrl!).then((p) => { r.peaks = p; changed(); }); }, fail);
  return r;
}

/** True when the file of this media item is not available (too big to be saved in the document). */
export function isMissing(md: MediaData | null): boolean {
  if (!md) return true;
  return ensureRuntime(md).failed;
}

export function isReady(md: MediaData | null): boolean {
  return !!md && ensureRuntime(md).ready;
}

/** Image for a still or an image sequence frame (0-based), or null while loading / missing. */
export function mediaImage(md: MediaData, index = 0): HTMLImageElement | null {
  const rt = ensureRuntime(md);
  if (rt.failed) return null;
  if (md.files && rt.urls && rt.imgs) {
    const i = Math.max(0, Math.min(rt.urls.length - 1, index));
    const img = rt.imgs[i];
    if (img) return img;
    const url = rt.urls[i];
    if (url) {
      rt.imgs[i] = null;
      loadImage(url).then((im) => { rt.imgs![i] = im; changed(); app.notify('view'); }, () => {});
      // mark as requested to avoid repeated loads
      const placeholder = new Image();
      rt.imgs[i] = placeholder;
      placeholder.src = url;
      placeholder.onload = () => { changed(); app.notify('view'); };
      return placeholder.complete && placeholder.naturalWidth ? placeholder : null;
    }
    return null;
  }
  return rt.img && rt.img.complete && rt.img.naturalWidth ? rt.img : null;
}

export function frameCount(md: MediaData, fps: number): number {
  if (md.files) return md.files.length;
  if (md.kind === 'IMAGE') return 1;
  return Math.max(1, Math.round(md.duration * fps));
}

export function mediaVideo(md: MediaData): HTMLVideoElement | null {
  const rt = ensureRuntime(md);
  return rt.video ?? null;
}

export function mediaAudio(md: MediaData): HTMLAudioElement | null {
  const rt = ensureRuntime(md);
  return rt.audio ?? null;
}

export function mediaPeaks(md: MediaData): Float32Array | undefined {
  return ensureRuntime(md).peaks;
}

/** Seek a video so that the frame at `time` (seconds) is displayed; resolves once it is. */
export function seekVideo(v: HTMLVideoElement, time: number): Promise<void> {
  const t = Math.max(0, Math.min(Number.isFinite(v.duration) ? v.duration - 0.001 : time, time));
  if (Math.abs(v.currentTime - t) < 0.0005 && v.readyState >= 2) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; resolve(); };
    const onSeeked = () => {
      v.removeEventListener('seeked', onSeeked);
      const rvfc = (v as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number }).requestVideoFrameCallback;
      if (rvfc && v.paused) {
        // the new frame is presented asynchronously; wait for it but don't hang if none comes
        rvfc.call(v, () => finish());
        setTimeout(finish, 120);
      } else finish();
    };
    v.addEventListener('seeked', onSeeked);
    v.currentTime = t;
    setTimeout(finish, 1500);
  });
}

/** Relink a missing media item to a file chosen by the user. */
export async function relinkMedia(md: MediaData, file: File): Promise<boolean> {
  const tmp = await importMedia([file], md.kind);
  if (!tmp) return false;
  const coll = mediaColl();
  const rt = runtime.get(rkey(tmp))!;
  runtime.delete(rkey(tmp));
  md.dataUrl = tmp.dataUrl;
  md.width = tmp.width; md.height = tmp.height; md.duration = tmp.duration;
  md.filepath = tmp.filepath;
  runtime.set(rkey(md), rt);
  delete coll[tmp.id];
  changed();
  return true;
}

