// Viewport (and F12) drawing of particles, hair strands and force field shapes.
// Called by the 3D View renderer every sync with its particle group; built objects
// are cached on the group by a key so orbiting the view doesn't rebuild them.

import {
  BufferAttribute, BufferGeometry, CanvasTexture, Color, DoubleSide, Group, InstancedMesh, LineBasicMaterial, LineSegments,
  Matrix4, MeshBasicMaterial, MeshPhongMaterial, Points, PointsMaterial, Quaternion, Vector3, type Camera, type Material, type Object3D,
} from 'three';
import { app } from '../app';
import type { EvalMesh } from '../core/modifiers';
import { triangulatePoly } from '../core/mesh';
import type { BObject, ParticleSystem } from '../core/types';
import { fieldOf } from './fields';
import { hairStrands, particleDriver, particleFrame, particleTrail } from './particles';
import { psFull, type FullParticleSettings } from './types';

export interface SimDrawContext {
  isVisible(ob: BObject): boolean;
  shading: string;
  showOnlyRender: boolean;
  camera: Camera;
  pixelRatio: number;
}

interface Built { key: string; obj: Object3D }

function disposeObj(o: Object3D): void {
  o.traverse((c) => {
    const m = c as unknown as { geometry?: BufferGeometry; material?: Material | Material[] };
    m.geometry?.dispose();
    if (Array.isArray(m.material)) m.material.forEach((x) => x.dispose()); else m.material?.dispose();
  });
}

let sprite: CanvasTexture | null = null;
function haloSprite(): CanvasTexture {
  if (!sprite) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const cx = cv.getContext('2d')!;
    const gr = cx.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.6)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    cx.fillStyle = gr; cx.fillRect(0, 0, 64, 64);
    sprite = new CanvasTexture(cv);
  }
  return sprite;
}

/** Diffuse colour of the material used by a particle system (its material slot on the emitter). */
function particleColor(ob: BObject, ps: FullParticleSettings): Color {
  const md = app.meshOf(ob);
  const id = md?.materials[Math.max(0, ps.materialSlot - 1)] ?? md?.materials[0] ?? null;
  const ma = id ? app.doc.materials[id] : null;
  return ma ? new Color(ma.diffuseColor[0], ma.diffuseColor[1], ma.diffuseColor[2]) : new Color(0.8, 0.8, 0.8);
}

/** Whether the emitter mesh itself is hidden in renders (Render > Emitter unchecked). */
export function emitterHiddenInRender(ob: BObject): boolean {
  return (ob.particleSystems ?? []).some((p) => p.showRender && p.useRenderEmitter === false);
}

// ------------------------------------------------------------------ main entry

export function syncSimDrawing(group: Group, ctx: SimDrawContext): void {
  const cache: Map<string, Built> = (group.userData.simCache ??= new Map<string, Built>());
  const used = new Set<string>();
  const rendered = ctx.shading === 'RENDERED' || ctx.showOnlyRender;
  const frame = app.scene.frameCurrent;
  const place = (id: string, key: string, build: () => Object3D | null) => {
    used.add(id);
    const hit = cache.get(id);
    if (hit && hit.key === key) return;
    if (hit) { group.remove(hit.obj); disposeObj(hit.obj); cache.delete(id); }
    const obj = build();
    if (!obj) return;
    group.add(obj);
    cache.set(id, { key, obj });
  };
  for (const ob of app.objects()) {
    if (!ctx.isVisible(ob)) continue;
    const world = app.matrices.world(ob);
    // particle systems
    if (ob.type === 'MESH' && ob.particleSystems?.length) {
      ob.particleSystems.forEach((ps0, pi) => {
        if (ctx.showOnlyRender ? !ps0.showRender : !ps0.showViewport) return;
        const ps = psFull(ps0);
        const id = `${ob.id}:${pi}`;
        if (ps.type === 'HAIR') {
          if (ps.renderType === 'NONE' && ctx.showOnlyRender) return;
          if (!ctx.showOnlyRender && ps.drawMethod === 'NONE') return;
          const frac = ctx.showOnlyRender ? 1 : ps.displayPercentage / 100;
          const em = app.evalMesh(ob);
          const key = JSON.stringify([ps, world.elements, rendered, ctx.showOnlyRender, meshTag(em), lampKey(rendered), ob.select]);
          place(id, key, () => buildHair(ob, ps0, ps, world, ctx.showOnlyRender, frac, rendered));
        } else {
          const d = particleDriver(ob, ps0);
          const key = JSON.stringify([frame, d.cache.version, d.cache.epoch, ps, world.elements, rendered, ctx.showOnlyRender, ob.select, dupliKey(ps)]);
          place(id, key, () => buildEmitter(ob, ps0, ps, ctx, rendered));
        }
      });
    }
  }
  // force fields (not in renders): view dependent, rebuilt every sync
  const fid = '__fields__';
  const old = cache.get(fid);
  if (old) { group.remove(old.obj); disposeObj(old.obj); cache.delete(fid); }
  if (!ctx.showOnlyRender) {
    const g = buildFields(ctx);
    if (g) { group.add(g); cache.set(fid, { key: '', obj: g }); }
    used.add(fid);
  }
  for (const [id, b] of cache) {
    if (!used.has(id)) { group.remove(b.obj); disposeObj(b.obj); cache.delete(id); }
  }
}

const meshIds = new WeakMap<object, number>();
let meshCounter = 0;
function meshTag(m: EvalMesh | null): number {
  if (!m) return 0;
  let id = meshIds.get(m);
  if (!id) { id = ++meshCounter; meshIds.set(m, id); }
  return id;
}

function dupliKey(ps: FullParticleSettings): string {
  if (ps.renderType !== 'OBJECT' || !ps.dupliObject) return '';
  const o = app.doc.objects[ps.dupliObject];
  if (!o) return '';
  const md = app.meshOf(o);
  const ma = md?.materials[0] ? app.doc.materials[md.materials[0]!] : null;
  return JSON.stringify([o.scale, o.rotation, meshTag(app.evalMesh(o)), ma?.diffuseColor]);
}

// ------------------------------------------------------------------ emitter particles

function buildEmitter(ob: BObject, ps0: ParticleSystem, ps: FullParticleSettings, ctx: SimDrawContext, rendered: boolean): Object3D | null {
  const frame = app.scene.frameCurrent;
  const st = particleFrame(ob, ps0, frame);
  if (!st) return null;
  const n = st.alive.length;
  const frac = ctx.showOnlyRender ? 1 : ps.displayPercentage / 100;
  const shownMax = Math.round(n * frac);
  const show = (i: number) => i < shownMax && (st.alive[i] === 1 || (st.alive[i] === 2 && ps.useDead) || (st.alive[i] === 0 && ps.showUnborn));
  // in the viewport "Rendered" display follows the render type; other display methods draw markers
  let mode: string = ps.renderType;
  if (!ctx.showOnlyRender && ps.drawMethod !== 'RENDER') mode = ps.drawMethod;
  if (ctx.showOnlyRender && mode === 'NONE') return null;
  if (!ctx.showOnlyRender && mode === 'NONE') return null;
  const col = particleColor(ob, ps);
  const g = new Group();
  if (mode === 'OBJECT' && ps.dupliObject && app.doc.objects[ps.dupliObject]) {
    const inst = buildInstances(ob, ps, st, show, rendered);
    if (inst) g.add(inst);
    return g;
  }
  if (mode === 'PATH' || mode === 'LINE') {
    const pts: number[] = [];
    const fps = app.scene.fps / (app.scene.fpsBase || 1);
    for (let i = 0; i < n; i++) {
      if (!show(i) || st.alive[i] !== 1) continue;
      if (mode === 'LINE') {
        const o = i * 3;
        const k = 0.5 / fps;
        pts.push(st.pos[o] - st.vel[o] * k, st.pos[o + 1] - st.vel[o + 1] * k, st.pos[o + 2] - st.vel[o + 2] * k, st.pos[o] + st.vel[o] * k, st.pos[o + 1] + st.vel[o + 1] * k, st.pos[o + 2] + st.vel[o + 2] * k);
      } else {
        const tr = particleTrail(ob, ps0, i, frame, Math.max(2, Math.round(ps.lifetime)));
        for (let k = 0; k + 5 < tr.length; k += 3) pts.push(tr[k], tr[k + 1], tr[k + 2], tr[k + 3], tr[k + 4], tr[k + 5]);
      }
    }
    if (!pts.length) return null;
    const geom = new BufferGeometry();
    geom.setAttribute('position', new BufferAttribute(new Float32Array(pts), 3));
    g.add(new LineSegments(geom, new LineBasicMaterial({ color: rendered ? col : ob.select ? 0xffa040 : 0x222222 })));
    return g;
  }
  if (mode === 'CROSS' || mode === 'AXIS') {
    const pts: number[] = [];
    for (let i = 0; i < n; i++) {
      if (!show(i)) continue;
      const o = i * 3;
      const s = ps.drawSize > 0 ? ps.drawSize * 0.01 : st.size[i];
      const x = st.pos[o], y = st.pos[o + 1], z = st.pos[o + 2];
      pts.push(x - s, y, z, x + s, y, z, x, y - s, z, x, y + s, z, x, y, z - s, x, y, z + s);
    }
    if (!pts.length) return null;
    const geom = new BufferGeometry();
    geom.setAttribute('position', new BufferAttribute(new Float32Array(pts), 3));
    g.add(new LineSegments(geom, new LineBasicMaterial({ color: ob.select ? 0xffa040 : 0x111111 })));
    return g;
  }
  const pos: number[] = [];
  for (let i = 0; i < n; i++) if (show(i)) pos.push(st.pos[i * 3], st.pos[i * 3 + 1], st.pos[i * 3 + 2]);
  if (!pos.length) return null;
  const geom = new BufferGeometry();
  geom.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  geom.computeBoundingSphere();
  let mat: PointsMaterial;
  if (rendered && mode === 'HALO') mat = new PointsMaterial({ size: ps.size * 4, sizeAttenuation: true, map: haloSprite(), transparent: true, depthWrite: false, color: 0xffffff });
  else if (rendered) mat = new PointsMaterial({ size: ps.size * 2, sizeAttenuation: true, color: col });
  else mat = new PointsMaterial({ size: (mode === 'CIRC' ? 5 : 3) * ctx.pixelRatio, sizeAttenuation: false, color: ob.select ? 0xffa040 : 0x111111 });
  g.add(new Points(geom, mat));
  return g;
}

function geometryFromEval(m: EvalMesh): BufferGeometry {
  const pos: number[] = [];
  for (const f of m.faces) {
    const tris = f.length === 3 ? [[0, 1, 2]] : f.length === 4 ? [[0, 1, 2], [0, 2, 3]] : triangulatePoly(m.verts, f);
    for (const t of tris) for (const k of t) { const v = m.verts[f[k]]; pos.push(v[0], v[1], v[2]); }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.computeVertexNormals();
  return g;
}

function buildInstances(ob: BObject, ps: FullParticleSettings, st: { pos: Float32Array; vel: Float32Array; alive: Uint8Array; size: Float32Array }, show: (i: number) => boolean, rendered: boolean): Object3D | null {
  const dob = app.doc.objects[ps.dupliObject!];
  const em = app.evalMesh(dob);
  if (!em || !em.faces.length) return null;
  const idx: number[] = [];
  for (let i = 0; i < st.alive.length; i++) if (show(i)) idx.push(i);
  if (!idx.length) return null;
  const md = app.meshOf(dob);
  const ma = md?.materials[0] ? app.doc.materials[md.materials[0]!] : null;
  const color = ma ? new Color(ma.diffuseColor[0], ma.diffuseColor[1], ma.diffuseColor[2]) : new Color(0.8, 0.8, 0.8);
  const mat = rendered || true ? new MeshPhongMaterial({ color, side: DoubleSide, shininess: 30 }) : new MeshBasicMaterial({ color });
  const mesh = new InstancedMesh(geometryFromEval(em), mat, idx.length);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const dw = app.matrices.world(dob);
  const dq = new Quaternion(), ds = new Vector3();
  dw.decompose(new Vector3(), dq, ds);
  const m = new Matrix4();
  const q = new Quaternion();
  const xAxis = new Vector3(1, 0, 0);
  idx.forEach((i, k) => {
    const o = i * 3;
    const v = new Vector3(st.vel[o], st.vel[o + 1], st.vel[o + 2]);
    if (ps.useRotationDupli) q.copy(dq);
    else if (v.lengthSq() > 1e-12) q.setFromUnitVectors(xAxis, v.normalize());
    else q.identity();
    const s = st.size[i] * (ps.useScaleDupli ? 1 : 1);
    const sc = ps.useScaleDupli ? ds.clone().multiplyScalar(s) : new Vector3(s, s, s);
    m.compose(new Vector3(st.pos[o], st.pos[o + 1], st.pos[o + 2]), q, sc);
    mesh.setMatrixAt(k, m);
  });
  mesh.instanceMatrix.needsUpdate = true;
  void ob;
  return mesh;
}

// ------------------------------------------------------------------ hair

function lampKey(rendered: boolean): string {
  if (!rendered) return '';
  return JSON.stringify(app.objects().filter((o) => o.type === 'LAMP').map((o) => [o.id, app.matrices.world(o).elements, o.data ? app.doc.lamps[o.data]?.energy : 0]));
}

interface LampInfo { pos: Vector3; dir: Vector3; point: boolean; color: Color }

function sceneLamps(): LampInfo[] {
  const out: LampInfo[] = [];
  for (const o of app.objects()) {
    if (o.type !== 'LAMP' || !o.data || o.hideRender) continue;
    const la = app.doc.lamps[o.data];
    if (!la) continue;
    const w = app.matrices.world(o);
    const e = w.elements;
    out.push({
      pos: new Vector3(e[12], e[13], e[14]), dir: new Vector3(-e[8], -e[9], -e[10]).normalize(),
      point: la.lampType === 'POINT' || la.lampType === 'SPOT',
      color: new Color(la.color[0], la.color[1], la.color[2]).multiplyScalar(Math.min(3, la.energy)),
    });
  }
  return out;
}

function buildHair(ob: BObject, ps0: ParticleSystem, ps: FullParticleSettings, world: Matrix4, render: boolean, frac: number, rendered: boolean): Object3D | null {
  const hs = hairStrands(ob, ps0, world, render, frac);
  if (!hs || hs.offsets.length < 2) return null;
  const col = particleColor(ob, ps);
  const nStr = hs.offsets.length - 1;
  let segs = 0;
  for (let s = 0; s < nStr; s++) segs += Math.max(0, hs.offsets[s + 1] - hs.offsets[s] - 1);
  const pos = new Float32Array(segs * 6);
  const colors = rendered ? new Float32Array(segs * 6) : null;
  const lamps = rendered ? sceneLamps() : [];
  const amb = 0.25;
  const t = new Vector3(), l = new Vector3(), p = new Vector3();
  let o = 0;
  const shade = (pi: number, tx: number, ty: number, tz: number, frac2: number, out: Float32Array, at: number) => {
    let r = amb, g = amb, b = amb;
    p.set(hs.points[pi * 3], hs.points[pi * 3 + 1], hs.points[pi * 3 + 2]);
    t.set(tx, ty, tz);
    if (!lamps.length) { r += 0.7; g += 0.7; b += 0.7; }
    for (const la of lamps) {
      if (la.point) l.copy(la.pos).sub(p).normalize(); else l.copy(la.dir).negate();
      const tl = t.dot(l);
      const diff = Math.sqrt(Math.max(0, 1 - tl * tl));
      r += diff * la.color.r * 0.8; g += diff * la.color.g * 0.8; b += diff * la.color.b * 0.8;
    }
    // slightly darker towards the root (self shadowing)
    const k = 0.55 + 0.45 * frac2;
    out[at] = Math.min(1, col.r * r * k); out[at + 1] = Math.min(1, col.g * g * k); out[at + 2] = Math.min(1, col.b * b * k);
  };
  for (let s = 0; s < nStr; s++) {
    const a = hs.offsets[s], bnd = hs.offsets[s + 1];
    const cnt = bnd - a;
    for (let i = a; i < bnd - 1; i++) {
      const x0 = hs.points[i * 3], y0 = hs.points[i * 3 + 1], z0 = hs.points[i * 3 + 2];
      const x1 = hs.points[i * 3 + 3], y1 = hs.points[i * 3 + 4], z1 = hs.points[i * 3 + 5];
      pos[o] = x0; pos[o + 1] = y0; pos[o + 2] = z0; pos[o + 3] = x1; pos[o + 4] = y1; pos[o + 5] = z1;
      if (colors) {
        let tx = x1 - x0, ty = y1 - y0, tz = z1 - z0;
        const tl = Math.hypot(tx, ty, tz) || 1;
        tx /= tl; ty /= tl; tz /= tl;
        shade(i, tx, ty, tz, (i - a) / Math.max(1, cnt - 1), colors, o);
        shade(i + 1, tx, ty, tz, (i + 1 - a) / Math.max(1, cnt - 1), colors, o + 3);
      }
      o += 6;
    }
  }
  const geom = new BufferGeometry();
  geom.setAttribute('position', new BufferAttribute(pos, 3));
  if (colors) geom.setAttribute('color', new BufferAttribute(colors, 3));
  geom.computeBoundingSphere();
  const mat = colors ? new LineBasicMaterial({ vertexColors: true }) : new LineBasicMaterial({ color: col.clone().multiplyScalar(0.85) });
  return new LineSegments(geom, mat);
}

// ------------------------------------------------------------------ force fields

function buildFields(ctx: SimDrawContext): Object3D | null {
  const pts: Record<string, number[]> = { normal: [], select: [], active: [] };
  const cam = ctx.camera;
  cam.updateMatrixWorld();
  const ce = cam.matrixWorld.elements;
  const vx = new Vector3(ce[0], ce[1], ce[2]).normalize(), vy = new Vector3(ce[4], ce[5], ce[6]).normalize();
  for (const ob of app.objects()) {
    if (!ctx.isVisible(ob)) continue;
    const f = fieldOf(ob);
    if (!f) continue;
    const w = app.matrices.world(ob);
    const e = w.elements;
    const c = new Vector3(e[12], e[13], e[14]);
    const ax = new Vector3(e[0], e[1], e[2]), ay = new Vector3(e[4], e[5], e[6]), az = new Vector3(e[8], e[9], e[10]);
    const size = ob.type === 'EMPTY' ? Math.max(0.1, ob.emptyDrawSize) : 1;
    const out = ob.select ? (app.scene.activeObject === ob.id ? pts.active : pts.select) : pts.normal;
    const circle = (center: Vector3, u: Vector3, v: Vector3, r: number, segs = 24) => {
      for (let i = 0; i < segs; i++) {
        const a0 = (i / segs) * Math.PI * 2, a1 = ((i + 1) / segs) * Math.PI * 2;
        out.push(center.x + (u.x * Math.cos(a0) + v.x * Math.sin(a0)) * r, center.y + (u.y * Math.cos(a0) + v.y * Math.sin(a0)) * r, center.z + (u.z * Math.cos(a0) + v.z * Math.sin(a0)) * r);
        out.push(center.x + (u.x * Math.cos(a1) + v.x * Math.sin(a1)) * r, center.y + (u.y * Math.cos(a1) + v.y * Math.sin(a1)) * r, center.z + (u.z * Math.cos(a1) + v.z * Math.sin(a1)) * r);
      }
    };
    const ux = ax.clone().normalize(), uy = ay.clone().normalize(), uz = az.clone().normalize();
    const scale = (ax.length() + ay.length() + az.length()) / 3;
    switch (f.type) {
      case 'WIND': {
        // stacked circles along the wind direction, spaced by the strength
        const step = Math.min(2, Math.max(0.1, Math.abs(f.strength) * 0.25)) * size * scale;
        for (let k = 0; k < 4; k++) circle(c.clone().addScaledVector(uz, step * k * Math.sign(f.strength || 1)), ux, uy, size * scale * (1 - k * 0.0));
        break;
      }
      case 'VORTEX': {
        // spiral in the XY plane
        const turns = 2, segs = 64, r = size * scale;
        let prev: Vector3 | null = null;
        for (let i = 0; i <= segs; i++) {
          const t2 = i / segs, a = t2 * turns * Math.PI * 2 * Math.sign(f.strength || 1);
          const p = c.clone().addScaledVector(ux, Math.cos(a) * r * t2).addScaledVector(uy, Math.sin(a) * r * t2);
          if (prev) out.push(prev.x, prev.y, prev.z, p.x, p.y, p.z);
          prev = p;
        }
        break;
      }
      case 'FORCE':
      case 'CHARGE':
      case 'LENNARDJ':
        for (const r of [0.5, 1, 1.5]) circle(c, vx, vy, r * size * scale);
        break;
      case 'MAGNET':
        circle(c, ux, uy, size * scale);
        circle(c, ux, uz, size * scale);
        break;
      case 'HARMONIC':
        circle(c, vx, vy, size * scale * 0.5);
        circle(c, vx, vy, size * scale);
        break;
      case 'TURBULENCE': {
        // a wobbly circle
        const segs = 32;
        let prev: Vector3 | null = null;
        for (let i = 0; i <= segs; i++) {
          const a = (i / segs) * Math.PI * 2;
          const r = size * scale * (1 + 0.15 * Math.sin(a * 5));
          const p = c.clone().addScaledVector(vx, Math.cos(a) * r).addScaledVector(vy, Math.sin(a) * r);
          if (prev) out.push(prev.x, prev.y, prev.z, p.x, p.y, p.z);
          prev = p;
        }
        break;
      }
      case 'DRAG':
        circle(c, vx, vy, size * scale);
        circle(c, vx, vy, size * scale * 0.7);
        break;
      default:
        circle(c, vx, vy, size * scale);
    }
    if (f.useMaxDistance && f.distanceMax > 0) circle(c, vx, vy, f.distanceMax, 48);
    if (f.useMinDistance && f.distanceMin > 0) circle(c, vx, vy, f.distanceMin, 48);
  }
  const g = new Group();
  const colors: Record<string, number> = { normal: 0x000000, select: 0xf15800, active: 0xffaa40 };
  for (const [k, list] of Object.entries(pts)) {
    if (!list.length) continue;
    const geom = new BufferGeometry();
    geom.setAttribute('position', new BufferAttribute(new Float32Array(list), 3));
    g.add(new LineSegments(geom, new LineBasicMaterial({ color: colors[k] })));
  }
  return g.children.length ? g : null;
}
