// Knife tool (K / Shift+K) and Knife Project of the 3D View in mesh edit mode.
//
// Click to place cut points (snapping to vertices, edges, Ctrl: edge midpoints, Shift: no snapping);
// the cut runs across the faces between consecutive points. E starts a new cut, C constrains the
// angle to 45 degree steps, Z cuts through occluded geometry, Enter/Space confirms, Esc/RMB cancels.
// Each straight segment is turned into per-face "pieces" (see core/knife.ts): the cut plane through the
// two view rays is intersected with every edge whose crossing projects between the two points.

import { Matrix3, Vector3 } from 'three';
import { app, type ModalHandler, type OpContext, type OpProps } from '../../app';
import type { BObject, MeshData, Vec3 } from '../../core/types';
import { edgeKey, hiddenEdges, flushFromFaces } from '../../core/mesh';
import { knifeApply, type KnifePiece, type KnifePoint } from '../../core/knife';
import { evalEdges } from '../../core/modifiers';
import { overlayDrawers } from './overlay';
import { meshDone, withOperatorHooks } from './meshmodal';
import type { View3D } from './view3d';

type Kind = 'VERT' | 'EDGE' | 'FACE' | 'NONE';
interface KPt { id: string; kind: Kind; v?: number; e?: [number, number]; t?: number; f?: number; world: Vector3 }

interface MeshCache {
  md: MeshData;
  ob: BObject;
  world: Vector3[];
  edgeFaces: Map<string, number[]>;
  vertFaces: number[][];
  ehide: boolean[];
  inv: import('three').Matrix4;
}

function buildCache(): MeshCache | null {
  const md = app.editMesh, ob = app.editObj;
  if (!md || !ob) return null;
  const w = app.matrices.world(ob);
  const edgeFaces = new Map<string, number[]>();
  const vertFaces: number[][] = md.verts.map(() => []);
  md.faces.forEach((f, i) => {
    if (md.fhide?.[i]) return;
    for (let k = 0; k < f.length; k++) {
      const key = edgeKey(f[k], f[(k + 1) % f.length]);
      const l = edgeFaces.get(key);
      if (l) l.push(i); else edgeFaces.set(key, [i]);
      vertFaces[f[k]].push(i);
    }
  });
  return { md, ob, world: md.verts.map((v) => new Vector3(v[0], v[1], v[2]).applyMatrix4(w)), edgeFaces, vertFaces, ehide: hiddenEdges(md), inv: w.clone().invert() };
}

const toLocal = (c: MeshCache, p: Vector3): Vec3 => { const q = p.clone().applyMatrix4(c.inv); return [q.x, q.y, q.z]; };

/** Faces a knife point lies on. */
function facesOf(c: MeshCache, p: KPt): number[] {
  if (p.kind === 'VERT') return c.vertFaces[p.v!];
  if (p.kind === 'EDGE') return c.edgeFaces.get(edgeKey(p.e![0], p.e![1])) ?? [];
  if (p.kind === 'FACE') return [p.f!];
  return [];
}

/** Snap target under a viewport position. */
function snapAt(view: View3D, c: MeshCache, x: number, y: number, mid: boolean, noSnap: boolean, onlySel: boolean): KPt {
  const md = c.md;
  const proj = (p: Vector3) => view.view.project(p);
  if (!noSnap) {
    // candidates within the snap distance; nearly coincident ones (silhouettes) prefer the closest to the eye
    const pick = <T extends { d: number; z: number }>(cands: T[]): T | null => {
      cands.sort((p, q) => p.d - q.d);
      if (!cands.length) return null;
      const near = cands.filter((c2) => c2.d <= cands[0].d + 1.5);
      near.sort((p, q) => p.z - q.z);
      return near[0];
    };
    const vc: { i: number; d: number; z: number }[] = [];
    c.world.forEach((p, i) => {
      if (md.vhide?.[i] || !c.vertFaces[i].length) return;
      const s = proj(p);
      if (s.behind) return;
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < 12 && view.renderer.editPointVisible(p)) vc.push({ i, d, z: s.z });
    });
    const bv = pick(vc);
    if (bv) return { id: `v${bv.i}`, kind: 'VERT', v: bv.i, world: c.world[bv.i].clone() };
    const ec: { i: number; d: number; z: number; t: number }[] = [];
    const ray = view.view.ray(x, y);
    md.edges.forEach(([a, b], i) => {
      if (c.ehide[i] || !c.edgeFaces.has(edgeKey(a, b))) return;
      const pa = proj(c.world[a]), pb = proj(c.world[b]);
      if (pa.behind || pb.behind) return;
      const dx = pb.x - pa.x, dy = pb.y - pa.y, l2 = dx * dx + dy * dy;
      const s = l2 > 0 ? Math.max(0, Math.min(1, ((x - pa.x) * dx + (y - pa.y) * dy) / l2)) : 0;
      const d = Math.hypot(x - (pa.x + dx * s), y - (pa.y + dy * s));
      if (d >= 10) return;
      // closest point on the 3D edge to the mouse ray
      const t = mid ? 0.5 : closestParam(c.world[a], c.world[b], ray.origin, ray.dir);
      const pt = c.world[a].clone().lerp(c.world[b], t);
      if (view.renderer.editPointVisible(pt)) ec.push({ i, d, z: proj(pt).z, t });
    });
    const be = pick(ec);
    if (be) {
      const [a, b] = md.edges[be.i];
      return { id: `e${a}_${b}_${be.t.toFixed(6)}`, kind: 'EDGE', e: [a, b], t: be.t, world: c.world[a].clone().lerp(c.world[b], be.t) };
    }
  }
  const hit = view.renderer.pickEditFace(x, y);
  if (hit && !md.fhide?.[hit.face] && (!onlySel || md.fsel[hit.face])) return { id: `f${hit.face}_${x}_${y}`, kind: 'FACE', f: hit.face, world: hit.point.clone() };
  // empty space: at the depth of the mesh
  const ctr = new Vector3();
  for (const p of c.world) ctr.add(p);
  if (c.world.length) ctr.multiplyScalar(1 / c.world.length);
  return { id: `n${x}_${y}`, kind: 'NONE', world: view.view.unprojectAtDepth(x, y, ctr) };
}

function closestParam(a: Vector3, b: Vector3, ro: Vector3, rd: Vector3): number {
  const u = b.clone().sub(a), w0 = a.clone().sub(ro);
  const A = u.dot(u), B = u.dot(rd), C = rd.dot(rd), D = u.dot(w0), E = rd.dot(w0);
  const den = A * C - B * B;
  const t = den > 1e-12 ? (B * E - C * D) / den : 0;
  return Math.max(0, Math.min(1, t));
}

interface SegResult { pieces: KnifePiece[]; crossings: Vector3[] }

/** Pieces of one straight knife segment. */
function segmentPieces(view: View3D, c: MeshCache, P: KPt, Q: KPt, segId: string, cutThrough: boolean, onlySel: boolean): SegResult {
  const out: SegResult = { pieces: [], crossings: [] };
  const md = c.md;
  const ps = view.view.project(P.world), qs = view.view.project(Q.world);
  const len2 = (qs.x - ps.x) ** 2 + (qs.y - ps.y) ** 2;
  if (len2 < 1) return out;
  const rP = view.view.ray(ps.x, ps.y), rQ = view.view.ray(qs.x, qs.y);
  const n = view.view.isOrtho ? rQ.origin.clone().sub(rP.origin).cross(rP.dir) : rP.dir.clone().cross(rQ.dir);
  if (n.lengthSq() < 1e-20) return out;
  n.normalize();
  const o = rP.origin;
  const dist = c.world.map((p) => n.dot(p.clone().sub(o)));
  let scaleRef = 0;
  for (const p of c.world) scaleRef = Math.max(scaleRef, Math.abs(p.x), Math.abs(p.y), Math.abs(p.z));
  const epsD = Math.max(1e-9, scaleRef * 1e-7);
  const sParam = (p: Vector3): number | null => {
    const s = view.view.project(p);
    if (s.behind) return null;
    return ((s.x - ps.x) * (qs.x - ps.x) + (s.y - ps.y) * (qs.y - ps.y)) / len2;
  };
  interface FP { pt: KnifePoint; s: number; world: Vector3 }
  const perFace = new Map<number, FP[]>();
  const addTo = (faces: number[], fp: FP) => {
    for (const f of faces) {
      if (onlySel && !md.fsel[f]) continue;
      const l = perFace.get(f) ?? [];
      if (!l.some((x) => x.pt.id === fp.pt.id)) l.push(fp);
      perFace.set(f, l);
    }
  };
  const visible = (p: Vector3) => cutThrough || view.renderer.editPointVisible(p);
  const sEps = 1e-4;
  // vertices lying on the cut plane
  dist.forEach((d, v) => {
    if (Math.abs(d) > epsD || md.vhide?.[v] || v === P.v || v === Q.v) return;
    const s = sParam(c.world[v]);
    if (s === null || s <= sEps || s >= 1 - sEps || !visible(c.world[v])) return;
    addTo(c.vertFaces[v], { pt: { id: `v${v}`, kind: 'VERT', v, co: toLocal(c, c.world[v]) }, s, world: c.world[v] });
    out.crossings.push(c.world[v]);
  });
  // edge crossings
  md.edges.forEach(([a, b], i) => {
    if (c.ehide[i]) return;
    const da = dist[a], db = dist[b];
    if (Math.abs(da) <= epsD || Math.abs(db) <= epsD || (da > 0) === (db > 0)) return;
    const key = edgeKey(a, b);
    const faces = c.edgeFaces.get(key);
    if (!faces) return;
    const t = da / (da - db);
    const X = c.world[a].clone().lerp(c.world[b], t);
    const s = sParam(X);
    if (s === null || s <= sEps || s >= 1 - sEps) return;
    if (P.kind === 'EDGE' && edgeKey(P.e![0], P.e![1]) === key && Math.abs(s) < 0.01) return;
    if (Q.kind === 'EDGE' && edgeKey(Q.e![0], Q.e![1]) === key && Math.abs(1 - s) < 0.01) return;
    if (!visible(X)) return;
    addTo(faces, { pt: { id: `${segId}:${key}`, kind: 'EDGE', e: [a, b], t, co: toLocal(c, X) }, s, world: X });
    out.crossings.push(X);
  });
  // the segment's own end points
  const endPt = (p: KPt): KnifePoint | null => {
    if (p.kind === 'NONE') return null;
    return { id: p.id, kind: p.kind === 'FACE' ? 'FACE' : p.kind, v: p.v, e: p.e, t: p.t, co: toLocal(c, p.world) };
  };
  const pp = endPt(P), qp = endPt(Q);
  if (pp) addTo(facesOf(c, P), { pt: pp, s: 0, world: P.world });
  if (qp) addTo(facesOf(c, Q), { pt: qp, s: 1, world: Q.world });
  for (const [f, list] of perFace) {
    if (list.length < 2) continue;
    list.sort((x, y) => x.s - y.s);
    for (let k = 0; k + 1 < list.length; k += 2) {
      const A = list[k], B = list[k + 1];
      if (!cutThrough) {
        const mid = A.world.clone().add(B.world).multiplyScalar(0.5);
        if (!view.renderer.editPointVisible(mid)) continue;
      }
      out.pieces.push({ face: f, a: A.pt, b: B.pt });
    }
  }
  return out;
}

// ------------------------------------------------------------------ modal

let active: { draw: (view: View3D, ctx: CanvasRenderingContext2D) => void; view: View3D } | null = null;
overlayDrawers.push((view, ctx) => { if (active && active.view === view) active.draw(view, ctx); });

export function startKnife(view: View3D, props: OpProps, opId = 'mesh.knife_tool'): void {
  const cache = buildCache();
  if (!cache) return;
  const onlySel = !!props.only_selected;
  let cutThrough = props.use_occlude_geometry === false;
  let angleSnap = false;
  let ctrl = false, shift = false;
  const paths: KPt[][] = [[]];
  let hover: KPt | null = null;
  let mouse = { x: 0, y: 0 };
  let clickCount = 0;
  let lastClick = { t: 0, x: 0, y: 0 };
  const segCache = new Map<string, SegResult>();
  const segKey = (a: KPt, b: KPt) => `${a.id}|${b.id}|${cutThrough}`;
  const seg = (a: KPt, b: KPt, id: string): SegResult => {
    const k = segKey(a, b);
    let r = segCache.get(k);
    if (!r) { r = segmentPieces(view, cache, a, b, id, cutThrough, onlySel); segCache.set(k, r); }
    return r;
  };
  const cur = () => paths[paths.length - 1];
  const constrained = (x: number, y: number): { x: number; y: number } => {
    const last = cur()[cur().length - 1];
    if (!angleSnap || !last) return { x, y };
    const p = view.view.project(last.world);
    const dx = x - p.x, dy = y - p.y;
    const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    const l = dx * Math.cos(ang) + dy * Math.sin(ang);
    return { x: p.x + Math.cos(ang) * l, y: p.y + Math.sin(ang) * l };
  };
  const updateHover = () => {
    const m = constrained(mouse.x, mouse.y);
    hover = snapAt(view, cache, m.x, m.y, ctrl, shift, onlySel);
    view.requestRender();
  };
  const status = () => `Knife: LMB define cut lines, Return/Spacebar confirm, Esc or RMB cancel, E new cut, Ctrl midpoint snap (${ctrl ? 'ON' : 'OFF'}), Shift ignore snap (${shift ? 'ON' : 'OFF'}), C angle constrain (${angleSnap ? 'ON' : 'OFF'}), Z cut through (${cutThrough ? 'ON' : 'OFF'})`;

  const draw = (_v: View3D, ctx: CanvasRenderingContext2D) => {
    const P = (p: Vector3) => view.view.project(p);
    ctx.save();
    // committed segments
    ctx.lineWidth = 1.5;
    for (const path of paths) {
      for (let i = 0; i + 1 < path.length; i++) {
        const a = P(path[i].world), b = P(path[i + 1].world);
        ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        ctx.strokeStyle = '#e8e8e8'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        ctx.fillStyle = '#26c6ff';
        for (const x of seg(path[i], path[i + 1], `s${paths.indexOf(path)}_${i}`).crossings) { const q = P(x); ctx.fillRect(q.x - 2.5, q.y - 2.5, 5, 5); }
      }
    }
    // rubber band to the mouse
    const path = cur();
    const last = path[path.length - 1];
    if (last && hover) {
      const a = P(last.world), b = P(hover.world);
      ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.fillStyle = '#26c6ff';
      for (const x of segmentPieces(view, cache, last, hover, 'live', cutThrough, onlySel).crossings) { const q = P(x); ctx.fillRect(q.x - 2.5, q.y - 2.5, 5, 5); }
    }
    // clicked points
    for (const pth of paths) for (const p of pth) { const q = P(p.world); ctx.fillStyle = '#000'; ctx.fillRect(q.x - 3.5, q.y - 3.5, 7, 7); ctx.fillStyle = '#ffffff'; ctx.fillRect(q.x - 2.5, q.y - 2.5, 5, 5); }
    // snap target
    if (hover) {
      const q = P(hover.world);
      ctx.lineWidth = 2;
      ctx.strokeStyle = hover.kind === 'VERT' ? '#50ff50' : hover.kind === 'EDGE' ? (ctrl ? '#ffa020' : '#40e0ff') : hover.kind === 'FACE' ? '#ffffff' : '#a0a0a0';
      ctx.beginPath(); ctx.arc(q.x, q.y, hover.kind === 'VERT' ? 6 : 4, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
  };

  const finish = (ok: boolean) => {
    app.endModal(h);
    active = null;
    view.transformState = null;
    if (ok) {
      const pieces: KnifePiece[] = [];
      paths.forEach((path, pi) => { for (let i = 0; i + 1 < path.length; i++) pieces.push(...seg(path[i], path[i + 1], `s${pi}_${i}`).pieces); });
      const def = app.operator(opId)!;
      const ctx: OpContext = { app, area: view.area };
      if (pieces.length && app.editMesh) {
        withOperatorHooks(def, ctx, () => knifeApply(app.editMesh!, pieces, true));
        meshDone();
        app.finishOperator(def, { ...props, use_occlude_geometry: !cutThrough }, ctx);
      }
    }
    app.notify('geometry', 'select', 'view');
    view.requestRender();
  };

  const h: ModalHandler = {
    status, cursor: 'crosshair',
    cancel: () => finish(false),
    onEvent(e) {
      const r = view.canvasRect();
      if (e.type === 'pointermove') {
        const pe = e as PointerEvent;
        mouse = { x: pe.clientX - r.left, y: pe.clientY - r.top };
        ctrl = pe.ctrlKey; shift = pe.shiftKey;
        updateHover();
        return true;
      }
      if (e.type === 'pointerdown') {
        const pe = e as PointerEvent;
        if (pe.button === 2) { finish(false); return true; }
        if (pe.button !== 0) return true;
        mouse = { x: pe.clientX - r.left, y: pe.clientY - r.top };
        ctrl = pe.ctrlKey; shift = pe.shiftKey;
        updateHover();
        const now = performance.now();
        const dbl = now - lastClick.t < 350 && Math.hypot(mouse.x - lastClick.x, mouse.y - lastClick.y) < 4;
        lastClick = { t: now, x: mouse.x, y: mouse.y };
        if (dbl) { if (cur().length) paths.push([]); view.requestRender(); return true; }
        if (hover) {
          const p: KPt = { ...hover, id: hover.kind === 'VERT' ? hover.id : `${hover.id}#${clickCount++}`, world: hover.world.clone() };
          const path = cur();
          if (!path.length || path[path.length - 1].id !== p.id) path.push(p);
        }
        view.requestRender();
        return true;
      }
      if (e.type === 'keydown') {
        const ke = e as KeyboardEvent;
        const k = ke.key.toLowerCase();
        if (ke.key === 'Escape') { finish(false); return true; }
        if (ke.key === 'Enter' || ke.key === ' ' || ke.code === 'NumpadEnter') { finish(true); return true; }
        if (ke.key === 'Control') { ctrl = true; updateHover(); return true; }
        if (ke.key === 'Shift') { shift = true; updateHover(); return true; }
        if (k === 'e') { if (cur().length) paths.push([]); view.requestRender(); return true; }
        if (k === 'c') { angleSnap = !angleSnap; updateHover(); return true; }
        if (k === 'z') { cutThrough = !cutThrough; segCache.clear(); view.requestRender(); return true; }
        return true;
      }
      return e.type === 'contextmenu' || e.type === 'pointerup' || e.type === 'wheel';
    },
  };
  const keyUp = (e: KeyboardEvent) => {
    if (app.modal !== h) { window.removeEventListener('keyup', keyUp, true); return; }
    if (e.key === 'Control') { ctrl = false; updateHover(); }
    if (e.key === 'Shift') { shift = false; updateHover(); }
  };
  window.addEventListener('keyup', keyUp, true);
  active = { draw, view };
  app.startModal(h);
  view.transformState = { center: () => new Vector3(), constraint: () => null, orient: () => new Matrix3(), mode: () => 'TRANSLATION', propSize: () => 0 };
  const r = view.canvasRect();
  mouse = { x: app.mouse.x - r.left, y: app.mouse.y - r.top };
  updateHover();
}

// ------------------------------------------------------------------ knife project

/**
 * Knife Project: cut the edit mesh with the outlines of the other selected objects as seen from the
 * view (loose edges, or boundary edges of meshes with faces), then select the faces inside.
 */
export function knifeProject(view: View3D, cutThrough: boolean): boolean {
  const cache = buildCache();
  if (!cache) return false;
  const cutters = app.selectedObjects().filter((o) => o.id !== cache.ob.id && (o.type === 'MESH' || o.type === 'FONT'));
  if (!cutters.length) return false;
  const pieces: KnifePiece[] = [];
  let si = 0;
  const md = cache.md;
  for (const ob of cutters) {
    const em = app.evalMesh(ob);
    if (!em) continue;
    const w = app.matrices.world(ob);
    const pts = em.verts.map((v) => new Vector3(v[0], v[1], v[2]).applyMatrix4(w));
    let segs: [number, number][];
    if (em.faces.length) {
      const count = new Map<string, number>();
      for (const f of em.faces) for (let k = 0; k < f.length; k++) { const key = edgeKey(f[k], f[(k + 1) % f.length]); count.set(key, (count.get(key) ?? 0) + 1); }
      segs = evalEdges(em).filter(([a, b]) => count.get(edgeKey(a, b)) === 1);
      if (!segs.length) segs = evalEdges(em);
    } else segs = evalEdges(em);
    // points of the outline inside faces of the edit mesh become interior cut points
    const ptOf = new Map<number, KPt>();
    const outlinePt = (i: number): KPt => {
      let p = ptOf.get(i);
      if (p) return p;
      const s = view.view.project(pts[i]);
      const hit = view.renderer.pickEditFace(s.x, s.y);
      p = hit && !md.fhide?.[hit.face] ? { id: `o${ob.id}_${i}`, kind: 'FACE', f: hit.face, world: hit.point.clone() } : { id: `o${ob.id}_${i}`, kind: 'NONE', world: pts[i].clone() };
      ptOf.set(i, p);
      return p;
    };
    for (const [a, b] of segs) pieces.push(...segmentPieces(view, cache, outlinePt(a), outlinePt(b), `p${si++}`, cutThrough, false).pieces);
  }
  if (!pieces.length) return false;
  const res = knifeApply(md, pieces, false);
  // select the faces inside the outline: faces whose centre projects inside any cutter's silhouette
  const inside = (x: number, y: number) => cutters.some((ob) => view.renderer.pickMeshes(x, y).some((h) => h.ob.id === ob.id));
  const w = app.matrices.world(cache.ob);
  md.vsel.fill(false); md.esel.fill(false);
  md.fsel = md.faces.map((f, i) => {
    if (md.fhide?.[i]) return false;
    const c = new Vector3();
    for (const v of f) c.add(new Vector3(...md.verts[v]));
    c.multiplyScalar(1 / f.length).applyMatrix4(w);
    const s = view.view.project(c);
    return !s.behind && inside(s.x, s.y) && (cutThrough || view.renderer.editPointVisible(c));
  });
  flushFromFaces(md);
  void res;
  return true;
}
