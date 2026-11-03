// WebGL2 side of the path tracer: one shared context on an off-screen canvas, the scene data
// textures, accumulation targets (running mean of colour, albedo and normal in float textures),
// tiled sample passes, the denoiser and the display pass. Callers (F12 render, viewport) keep
// their own accumulation targets; the scene is re-uploaded only when its keys change.

import { app } from '../../app';
import type { BObject, CyclesSceneSettings } from '../../core/types';
import {
  buildGeometry, buildShading, geometryKey, newMatTable, renderObjects, shadingKey, TEX_W, type GeometryData, type ShadingData,
} from './build';
import { DENOISE, DISPLAY, TRACE, VERT } from './shaders';

type GL = WebGL2RenderingContext;

export interface Accum {
  w: number;
  h: number;
  /** Fully completed sample passes. */
  samples: number;
  /** Rows of the pass in progress that are already done. */
  row: number;
  texA: WebGLTexture[];
  texB: WebGLTexture[];
  fboA: WebGLFramebuffer;
  fboB: WebGLFramebuffer;
  /** Denoiser ping-pong targets (created on demand). */
  dn?: { tex: WebGLTexture[]; fbo: WebGLFramebuffer[] };
  dead?: boolean;
}

export interface CameraRays {
  /** NDC -> world, column-major 4x4. */
  invViewProj: ArrayLike<number>;
}

export interface SceneStatus {
  triCount: number;
  lightCount: number;
  /** Images still loading (the scene will change once they are available). */
  pendingImages: number;
  /** Approximate GPU memory used by the scene data, in bytes. */
  bytes: number;
}

// ------------------------------------------------------------------ images

interface ImageEntry { img: HTMLImageElement | null; failed: boolean; waiters: (() => void)[] }
const images = new Map<string, ImageEntry>();

function requestImage(src: string, onLoad: () => void): HTMLImageElement | null {
  let e = images.get(src);
  if (!e) {
    e = { img: null, failed: false, waiters: [] };
    images.set(src, e);
    const entry = e;
    const im = new Image();
    im.onload = () => { entry.img = im; for (const w of entry.waiters.splice(0)) w(); };
    im.onerror = () => { entry.failed = true; for (const w of entry.waiters.splice(0)) w(); };
    im.src = src;
  }
  if (e.img || e.failed) return e.img;
  e.waiters.push(onLoad);
  return null;
}

// ------------------------------------------------------------------ GPU budget

/**
 * Adapts how many pixel-samples are submitted per animation frame so that the GPU keeps up
 * (a fence tells when the previous batch finished) and the browser stays responsive.
 */
export class GpuBudget {
  pixels = 16384;
  private fence: WebGLSync | null = null;
  private checks = 0;
  constructor(private max = 1 << 23, private min = 1024) {}

  /** True when a new batch may be submitted (the previous one has finished). */
  ready(gl: GL): boolean {
    if (!this.fence) return true;
    this.checks++;
    const st = gl.getSyncParameter(this.fence, gl.SYNC_STATUS);
    if (st !== gl.SIGNALED) {
      if (this.checks > 2) this.pixels = Math.max(this.min, Math.floor(this.pixels * 0.7));
      return false;
    }
    gl.deleteSync(this.fence);
    this.fence = null;
    if (this.checks <= 1) this.pixels = Math.min(this.max, Math.ceil(this.pixels * 1.5));
    return true;
  }

  submitted(gl: GL): void {
    if (this.fence) gl.deleteSync(this.fence);
    this.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    this.checks = 0;
    gl.flush();
  }

  reset(gl: GL | null): void {
    if (this.fence && gl) gl.deleteSync(this.fence);
    this.fence = null;
    this.checks = 0;
  }
}

// ------------------------------------------------------------------ tracer

interface Program { prog: WebGLProgram; loc: Map<string, WebGLUniformLocation | null> }

const SCENE_UNITS = ['uTri', 'uVtx', 'uBvh', 'uMat', 'uLeaf', 'uTexRec', 'uLights', 'uEmit'] as const;

export class PathTracer {
  readonly canvas: HTMLCanvasElement;
  readonly gl: GL;
  lost = false;
  error: string | null = null;
  private progs: { trace: Program; display: Program; denoise: Program } | null = null;
  private pending: { trace: WebGLProgram; display: WebGLProgram; denoise: WebGLProgram } | null = null;
  private parallel: { COMPLETION_STATUS_KHR: number } | null;
  private vao: WebGLVertexArrayObject;
  private fmt: { internal: number; type: number; linear: boolean };
  private sceneTex = new Map<string, WebGLTexture>();
  private imageTex: WebGLTexture;
  private dummyTex: WebGLTexture;
  geometry: GeometryData | null = null;
  shading: ShadingData | null = null;
  private geomKey = '';
  private shadeKey = '';
  private imageKey = '';
  private texBytes = new Map<string, number>();
  private matTable = newMatTable();
  /** Bumped whenever uploaded scene data changes (accumulations must restart). */
  version = 0;
  private maxTex: number;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = 4;
    const gl = this.canvas.getContext('webgl2', { antialias: false, depth: false, stencil: false, alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL 2 is not available');
    this.gl = gl;
    this.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });
    this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    this.parallel = gl.getExtension('KHR_parallel_shader_compile') as { COMPLETION_STATUS_KHR: number } | null;
    const cbf = gl.getExtension('EXT_color_buffer_float');
    const lin32 = !!gl.getExtension('OES_texture_float_linear');
    if (cbf) this.fmt = { internal: gl.RGBA32F, type: gl.FLOAT, linear: lin32 };
    else if (gl.getExtension('EXT_color_buffer_half_float')) this.fmt = { internal: gl.RGBA16F, type: gl.HALF_FLOAT, linear: true };
    else this.fmt = { internal: gl.RGBA8, type: gl.UNSIGNED_BYTE, linear: true };
    if (cbf && !this.checkRenderable()) this.fmt = { internal: gl.RGBA16F, type: gl.HALF_FLOAT, linear: true };
    // full-screen triangle pair
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.imageTex = this.makeArrayTexture(1, 1, null);
    this.dummyTex = this.dataTexture(new Float32Array(4), 1);
    this.compile();
  }

  private checkRenderable(): boolean {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 4, 4, 0, gl.RGBA, gl.FLOAT, null);
    const f = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(f);
    gl.deleteTexture(t);
    return ok;
  }

  // ---------------------------------------------------------------- programs

  private compile(): void {
    const gl = this.gl;
    const mk = (fs: string): WebGLProgram => {
      const vs = gl.createShader(gl.VERTEX_SHADER)!;
      gl.shaderSource(vs, VERT);
      gl.compileShader(vs);
      const f = gl.createShader(gl.FRAGMENT_SHADER)!;
      gl.shaderSource(f, fs);
      gl.compileShader(f);
      const p = gl.createProgram()!;
      gl.attachShader(p, vs);
      gl.attachShader(p, f);
      gl.bindAttribLocation(p, 0, 'aPos');
      gl.linkProgram(p);
      return p;
    };
    this.pending = { trace: mk(TRACE), display: mk(DISPLAY), denoise: mk(DENOISE) };
  }

  /** True once the shaders are compiled and linked (compiles in the background when the browser can). */
  ready(): boolean {
    if (this.progs) return true;
    if (this.error || !this.pending) return false;
    const gl = this.gl;
    const p = this.pending;
    if (this.parallel) {
      for (const prog of [p.trace, p.display, p.denoise]) {
        if (!gl.getProgramParameter(prog, this.parallel.COMPLETION_STATUS_KHR)) return false;
      }
    }
    for (const [name, prog] of Object.entries(p)) {
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        const shaders = gl.getAttachedShaders(prog) ?? [];
        const logs = shaders.map((s) => gl.getShaderInfoLog(s)).filter(Boolean).join('\n');
        this.error = `Cycles: could not compile the ${name} shader: ${gl.getProgramInfoLog(prog) ?? ''} ${logs}`;
        console.error(this.error);
        return false;
      }
    }
    const wrap = (prog: WebGLProgram): Program => ({ prog, loc: new Map() });
    this.progs = { trace: wrap(p.trace), display: wrap(p.display), denoise: wrap(p.denoise) };
    this.pending = null;
    return true;
  }

  private loc(p: Program, name: string): WebGLUniformLocation | null {
    let l = p.loc.get(name);
    if (l === undefined) { l = this.gl.getUniformLocation(p.prog, name); p.loc.set(name, l); }
    return l;
  }

  // ---------------------------------------------------------------- textures

  private dataTexture(data: Float32Array, texels: number, reuse?: WebGLTexture, name = ''): WebGLTexture {
    const gl = this.gl;
    const w = TEX_W;
    const h = Math.max(1, Math.ceil(texels / w));
    if (h > this.maxTex) throw new Error(`Cycles: the scene is too large for this GPU (${texels} texels)`);
    let buf = data;
    if (data.length < w * h * 4) { buf = new Float32Array(w * h * 4); buf.set(data.subarray(0, Math.min(data.length, w * h * 4))); }
    const t = reuse ?? gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, buf);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (name) this.texBytes.set(name, w * h * 16);
    return t;
  }

  private setSceneTexture(name: string, data: Float32Array, texels: number): void {
    const old = this.sceneTex.get(name);
    this.sceneTex.set(name, this.dataTexture(data, texels, old, name));
  }

  private makeArrayTexture(size: number, layers: number, sources: (HTMLImageElement | null)[] | null): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.SRGB8_ALPHA8, size, size, Math.max(1, layers));
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d', { willReadFrequently: false })!;
    for (let i = 0; i < Math.max(1, layers); i++) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, size, size);
      const img = sources?.[i] ?? null;
      if (img) {
        // flip vertically: texture row 0 is the bottom of the image (Blender's UV origin)
        ctx.setTransform(1, 0, 0, -1, 0, size);
        ctx.drawImage(img, 0, 0, size, size);
      } else {
        ctx.fillStyle = sources ? '#ff00ff' : '#ffffff';
        ctx.fillRect(0, 0, size, size);
      }
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, size, size, 1, gl.RGBA, gl.UNSIGNED_BYTE, c);
    }
    return t;
  }

  // ---------------------------------------------------------------- scene

  /**
   * Bring the uploaded scene up to date (geometry and/or shading are rebuilt only when their keys
   * changed). `onImage` is called when a texture image that is still loading becomes available.
   */
  syncScene(opts: { layers?: boolean[]; localView?: Set<string> | null; onImage?: () => void } = {}): SceneStatus {
    const objs: BObject[] = renderObjects(opts.layers, opts.localView);
    const gk = geometryKey(objs);
    const mats = newMatTable();
    let changed = false;
    if (gk !== this.geomKey || !this.geometry) {
      const g = buildGeometry(objs, mats, gk);
      this.setSceneTexture('uTri', g.tri, g.triCount * 3);
      this.setSceneTexture('uVtx', g.vtx, g.triCount * 9);
      this.setSceneTexture('uBvh', g.bvh, Math.max(1, g.nodeCount) * 2);
      this.geometry = g;
      this.geomKey = gk;
      this.shadeKey = '';
      changed = true;
      this.matTable = mats;
    }
    const table = this.matTable;
    const sk = shadingKey(objs, table.list);
    let pending = 0;
    if (sk !== this.shadeKey || !this.shading) {
      const s = buildShading(objs, this.geometry!, table, sk);
      this.setSceneTexture('uMat', s.materials, Math.max(1, s.materialCount) * 4);
      this.setSceneTexture('uLeaf', s.leaves, Math.max(1, s.leaves.length / 4));
      this.setSceneTexture('uTexRec', s.texRecords, Math.max(1, s.texRecords.length / 4));
      this.setSceneTexture('uLights', s.lights, Math.max(1, s.lights.length / 4));
      this.setSceneTexture('uEmit', s.emitters, Math.max(1, s.emitters.length / 4));
      this.shading = s;
      this.shadeKey = sk;
      changed = true;
    }
    // texture images (loaded asynchronously, then uploaded into one texture array)
    const srcs = this.shading!.images.map((i) => i.src);
    const loaded = srcs.map((src) => requestImage(src, () => { this.imageKey = ''; opts.onImage?.(); }));
    pending = loaded.filter((x, i) => !x && !images.get(srcs[i])?.failed).length;
    const ik = srcs.map((s, i) => `${s.length}:${s.slice(-32)}:${loaded[i] ? 1 : 0}`).join('|');
    if (ik !== this.imageKey) {
      this.gl.deleteTexture(this.imageTex);
      const maxDim = Math.max(64, ...loaded.map((im) => (im ? Math.max(im.naturalWidth, im.naturalHeight) : 64)));
      let size = 64;
      while (size < maxDim && size < 2048) size *= 2;
      if (srcs.length > 4) size = Math.min(size, 1024);
      this.imageTex = srcs.length ? this.makeArrayTexture(size, srcs.length, loaded) : this.makeArrayTexture(1, 1, null);
      this.imageKey = ik;
      changed = true;
    }
    if (changed) this.version++;
    return { triCount: this.geometry!.triCount, lightCount: this.shading!.lightCount + this.shading!.emitterCount, pendingImages: pending, bytes: this.sceneMemory };
  }

  // ---------------------------------------------------------------- accumulation targets

  createAccum(w: number, h: number): Accum {
    const gl = this.gl;
    const mkTex = () => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, this.fmt.internal, w, h, 0, gl.RGBA, this.fmt.type, null);
      const filter = this.fmt.linear ? gl.LINEAR : gl.NEAREST;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    const mkFbo = (texs: WebGLTexture[]) => {
      const f = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      texs.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0));
      gl.drawBuffers(texs.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
      return f;
    };
    const texA = [mkTex(), mkTex(), mkTex()], texB = [mkTex(), mkTex(), mkTex()];
    const acc: Accum = { w, h, samples: 0, row: 0, texA, texB, fboA: mkFbo(texA), fboB: mkFbo(texB) };
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.clearAccum(acc);
    return acc;
  }

  clearAccum(acc: Accum): void {
    const gl = this.gl;
    for (const f of [acc.fboA, acc.fboB]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.disable(gl.SCISSOR_TEST);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    acc.samples = 0;
    acc.row = 0;
  }

  freeAccum(acc: Accum | null | undefined): void {
    if (!acc || acc.dead) return;
    const gl = this.gl;
    acc.dead = true;
    for (const t of [...acc.texA, ...acc.texB, ...(acc.dn?.tex ?? [])]) gl.deleteTexture(t);
    for (const f of [acc.fboA, acc.fboB, ...(acc.dn?.fbo ?? [])]) gl.deleteFramebuffer(f);
  }

  // ---------------------------------------------------------------- passes

  /**
   * Trace pixel rows [y0, y1) of the pass with sample index `acc.samples` into the running mean.
   */
  traceRows(acc: Accum, y0: number, y1: number, cam: CameraRays, s: CyclesSceneSettings, seed: number): void {
    const gl = this.gl;
    const P = this.progs!.trace;
    const g = this.geometry!, sh = this.shading!;
    gl.useProgram(P.prog);
    gl.bindFramebuffer(gl.FRAMEBUFFER, acc.fboB);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
    gl.viewport(0, 0, acc.w, acc.h);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, y0, acc.w, y1 - y0);
    gl.disable(gl.BLEND);
    let unit = 0;
    const bind = (name: string, tex: WebGLTexture, target: number = gl.TEXTURE_2D) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(target, tex);
      gl.uniform1i(this.loc(P, name), unit);
      unit++;
    };
    for (const n of SCENE_UNITS) bind(n, this.sceneTex.get(n) ?? this.dummyTex);
    bind('uImages', this.imageTex, gl.TEXTURE_2D_ARRAY);
    bind('uPrevColor', acc.texA[0]);
    bind('uPrevAlbedo', acc.texA[1]);
    bind('uPrevNormal', acc.texA[2]);
    const u1i = (n: string, v: number) => gl.uniform1i(this.loc(P, n), v);
    const u1f = (n: string, v: number) => gl.uniform1f(this.loc(P, n), v);
    gl.uniformMatrix4fv(this.loc(P, 'uInvViewProj'), false, Array.from(cam.invViewProj));
    gl.uniform2f(this.loc(P, 'uRes'), acc.w, acc.h);
    u1i('uSample', acc.samples);
    u1i('uSeed', seed);
    u1f('uBlend', 1 / (acc.samples + 1));
    u1i('uTriCount', g.triCount);
    u1i('uLightCount', Math.min(64, sh.lightCount));
    u1i('uEmitCount', sh.emitterCount);
    u1i('uHasTransparent', sh.hasTransparent ? 1 : 0);
    u1f('uEmitTotal', Math.max(1e-12, sh.emitterTotal));
    u1f('uMeshLightProb', sh.meshLightProb);
    u1i('uMaxBounces', s.maxBounces);
    u1i('uMinBounces', s.minBounces);
    u1i('uDiffuseBounces', s.diffuseBounces);
    u1i('uGlossyBounces', s.glossyBounces);
    u1i('uTransBounces', s.transmissionBounces);
    u1i('uTranspMax', s.transparentMaxBounces);
    u1i('uTranspMin', s.transparentMinBounces);
    u1f('uClampDirect', s.sampleClampDirect);
    u1f('uClampIndirect', s.sampleClampIndirect);
    u1f('uBlurGlossy', s.blurGlossy);
    u1i('uCausticsRefl', s.causticsReflective ? 1 : 0);
    u1i('uCausticsRefr', s.causticsRefractive ? 1 : 0);
    u1i('uTransparentShadows', s.useTransparentShadows ? 1 : 0);
    u1i('uFilterType', s.filterType === 'BOX' ? 0 : s.filterType === 'GAUSSIAN' ? 1 : 2);
    u1f('uFilterWidth', Math.max(0.01, s.filterWidth));
    u1i('uFilmTransparent', s.filmTransparent ? 1 : 0);
    const w = sh.world;
    u1i('uWorldMode', w.mode);
    u1i('uWorldVisible', w.visibleCamera ? 1 : 0);
    gl.uniform3f(this.loc(P, 'uHorizon'), w.horizon[0], w.horizon[1], w.horizon[2]);
    gl.uniform3f(this.loc(P, 'uZenith'), w.zenith[0], w.zenith[1], w.zenith[2]);
    u1f('uWorldStrength', w.strength);
    u1i('uUseAO', w.useAO ? 1 : 0);
    u1f('uAOFactor', w.aoFactor);
    u1f('uAODist', Math.max(1e-3, w.aoDistance));
    const ext = Math.max(...g.boundsMax.map((x, i) => Math.abs(x - g.boundsMin[i])), ...g.boundsMax.map(Math.abs), ...g.boundsMin.map(Math.abs), 1);
    u1f('uEps', Math.max(1e-5, ext * 2e-5));
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    // copy the rows back into the A targets
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, acc.fboB);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, acc.fboA);
    for (let i = 0; i < 3; i++) {
      gl.readBuffer(gl.COLOR_ATTACHMENT0 + i);
      gl.drawBuffers([0, 1, 2].map((k) => (k === i ? gl.COLOR_ATTACHMENT0 + k : gl.NONE)));
      gl.blitFramebuffer(0, y0, acc.w, y1, 0, y0, acc.w, y1, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    }
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindVertexArray(null);
  }

  /**
   * Trace up to `pixels` pixel-samples, continuing the pass in progress; stops after `maxSamples`
   * passes. Returns the number of passes completed by this call.
   */
  traceBatch(acc: Accum, pixels: number, maxSamples: number, cam: CameraRays, s: CyclesSceneSettings, seed: number): number {
    let done = 0;
    let budget = Math.max(acc.w, pixels);
    while (budget > 0 && acc.samples < maxSamples) {
      const rows = Math.max(1, Math.min(acc.h - acc.row, Math.ceil(budget / acc.w)));
      this.traceRows(acc, acc.row, acc.row + rows, cam, s, seed);
      budget -= rows * acc.w;
      acc.row += rows;
      if (acc.row >= acc.h) { acc.row = 0; acc.samples++; done++; }
    }
    return done;
  }

  /** Edge-aware a-trous filter of the accumulated colour; returns the texture to display. */
  denoise(acc: Accum, s: CyclesSceneSettings): WebGLTexture {
    const gl = this.gl;
    if (!acc.dn) {
      const tex: WebGLTexture[] = [], fbo: WebGLFramebuffer[] = [];
      for (let i = 0; i < 2; i++) {
        const t = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, this.fmt.internal, acc.w, acc.h, 0, gl.RGBA, this.fmt.type, null);
        const filter = this.fmt.linear ? gl.LINEAR : gl.NEAREST;
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        const f = gl.createFramebuffer()!;
        gl.bindFramebuffer(gl.FRAMEBUFFER, f);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
        tex.push(t); fbo.push(f);
      }
      acc.dn = { tex, fbo };
    }
    const P = this.progs!.denoise;
    gl.useProgram(P.prog);
    gl.viewport(0, 0, acc.w, acc.h);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.vao);
    const iterations = Math.max(1, Math.min(5, Math.round(Math.log2(Math.max(2, s.denoisingRadius)))));
    const strength = Math.max(0.01, s.denoisingStrength);
    const feat = Math.max(0.01, s.denoisingFeatureStrength);
    let src = acc.texA[0];
    for (let i = 0; i < iterations; i++) {
      const dst = i % 2;
      gl.bindFramebuffer(gl.FRAMEBUFFER, acc.dn.fbo[dst]);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src); gl.uniform1i(this.loc(P, 'uColor'), 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, acc.texA[1]); gl.uniform1i(this.loc(P, 'uAlbedo'), 1);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, acc.texA[2]); gl.uniform1i(this.loc(P, 'uNormal'), 2);
      gl.uniform1i(this.loc(P, 'uStep'), 1 << i);
      gl.uniform1f(this.loc(P, 'uSigmaColor'), (strength * 2) / Math.sqrt(Math.max(1, acc.samples)));
      gl.uniform1f(this.loc(P, 'uSigmaNormal'), 0.1 / feat);
      gl.uniform1f(this.loc(P, 'uSigmaAlbedo'), 0.05 / feat);
      gl.uniform1i(this.loc(P, 'uFirst'), i === 0 ? 1 : 0);
      gl.uniform1i(this.loc(P, 'uLast'), i === iterations - 1 ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      src = acc.dn.tex[dst];
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
    return src;
  }

  /** Draw the accumulated image (exposure, sRGB) into this tracer's canvas at the given size. */
  display(acc: Accum, outW: number, outH: number, s: CyclesSceneSettings, opts: { dither?: number; opaque?: boolean; denoise?: boolean } = {}): HTMLCanvasElement {
    const gl = this.gl;
    if (this.canvas.width !== outW || this.canvas.height !== outH) { this.canvas.width = outW; this.canvas.height = outH; }
    const src = opts.denoise && acc.samples > 0 ? this.denoise(acc, s) : acc.texA[0];
    const P = this.progs!.display;
    gl.useProgram(P.prog);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, outW, outH);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src);
    gl.uniform1i(this.loc(P, 'uColor'), 0);
    gl.uniform1f(this.loc(P, 'uExposure'), s.filmExposure);
    gl.uniform1f(this.loc(P, 'uDither'), opts.dither ?? 0);
    gl.uniform1i(this.loc(P, 'uOpaque'), opts.opaque ? 1 : 0);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    return this.canvas;
  }

  /** Bytes of GPU memory used by an accumulation target. */
  accumBytes(acc: Accum): number {
    const px = this.fmt.internal === this.gl.RGBA32F ? 16 : this.fmt.internal === this.gl.RGBA16F ? 8 : 4;
    return acc.w * acc.h * px * (6 + (acc.dn ? 2 : 0));
  }

  get sceneMemory(): number { let b = 0; for (const v of this.texBytes.values()) b += v; return b; }
}

// ------------------------------------------------------------------ shared instance

let tracer: PathTracer | null = null;

/** The shared path tracer (created on first use; recreated after a lost context). */
export function getTracer(): PathTracer {
  if (tracer && tracer.lost) tracer = null;
  if (!tracer) tracer = new PathTracer();
  return tracer;
}

/** Seed for a frame (Sampling > Seed, plus the frame number with the animated seed toggle). */
export function frameSeed(s: CyclesSceneSettings): number {
  return (s.seed + (s.useAnimatedSeed ? app.scene.frameCurrent * 7919 : 0)) >>> 0;
}

export function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const fin = () => { if (!done) { done = true; resolve(); } };
    requestAnimationFrame(fin);
    // background tabs throttle animation frames: keep rendering slowly
    setTimeout(fin, 100);
  });
}
