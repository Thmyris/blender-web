// 2D overlay of the 3D viewport: camera frame/passepartout, lamp circles,
// object origins and names, 3D cursor, transform manipulator, constraint lines,
// selection shapes and the corner texts (view name, object info, mini axis).

import { Matrix3, Vector3 } from 'three';
import { app } from '../../app';
import { objectKeyFrames } from '../../core/anim';
import { orientationMatrix, axisVector } from './transform';
import { sculptSettings } from './sculpt';
import type { View3D } from './view3d';

export interface ManipHit { kind: 'translate' | 'rotate' | 'scale'; axis: number | 'view' | 'trackball' }

const AXIS_COL = ['#dc1e1e', '#2ec42e', '#3a6bf0'];
const AXIS_HI = ['#ff8c8c', '#9cff9c', '#9cb8ff'];
const SELECT = '#f15800';
const ACTIVE = '#ffaa40';

function manipCenter(): Vector3 | null {
  const ts = app.scene.toolSettings;
  const md = app.editMesh, eob = app.editObj;
  let pts: Vector3[] = [];
  if (md && eob) {
    const m = app.matrices.world(eob);
    md.verts.forEach((v, i) => { if (md.vsel[i]) pts.push(new Vector3(v[0], v[1], v[2]).applyMatrix4(m)); });
    if (ts.pivotPoint === 'ACTIVE_ELEMENT' && md.activeFace >= 0 && md.fsel[md.activeFace]) {
      const f = md.faces[md.activeFace];
      const c = new Vector3();
      for (const i of f) c.add(new Vector3(...md.verts[i]));
      return c.multiplyScalar(1 / f.length).applyMatrix4(m);
    }
  } else {
    pts = app.selectedObjects().map((o) => app.matrices.location(o));
    if (ts.pivotPoint === 'ACTIVE_ELEMENT' && app.activeObject?.select) return app.matrices.location(app.activeObject);
  }
  if (!pts.length) return null;
  if (ts.pivotPoint === 'CURSOR') return new Vector3(...app.scene.cursor);
  if (ts.pivotPoint === 'BOUNDING_BOX_CENTER') {
    const min = new Vector3(Infinity, Infinity, Infinity), max = new Vector3(-Infinity, -Infinity, -Infinity);
    for (const p of pts) { min.min(p); max.max(p); }
    return min.add(max).multiplyScalar(0.5);
  }
  const c = new Vector3();
  for (const p of pts) c.add(p);
  return c.multiplyScalar(1 / pts.length);
}

interface ManipGeom {
  c: { x: number; y: number };
  axes: { i: number; tip: { x: number; y: number }; dir: Vector3; hidden: boolean }[];
  ring: { i: number; pts: { x: number; y: number; front: boolean }[] }[];
  radius: number;
}

function manipGeometry(view: View3D): ManipGeom | null {
  if (app.modal) return null;
  const center = manipCenter();
  if (!center) return null;
  const v = view.view;
  const pc = v.project(center);
  if (pc.behind) return null;
  const ps = v.pixelSize(center);
  const R = 80;
  const om: Matrix3 = orientationMatrix(app.scene.toolSettings.transformOrientation, view);
  const viewDir = v.viewDir();
  const axes: ManipGeom['axes'] = [];
  const ring: ManipGeom['ring'] = [];
  for (let i = 0; i < 3; i++) {
    const dir = axisVector(om, i);
    const tipW = center.clone().add(dir.clone().multiplyScalar(R * ps));
    const tip = v.project(tipW);
    axes.push({ i, tip: { x: tip.x, y: tip.y }, dir, hidden: Math.abs(dir.dot(viewDir)) > 0.985 });
    // rotation ring around this axis
    const ref = Math.abs(dir.z) < 0.9 ? new Vector3(0, 0, 1) : new Vector3(1, 0, 0);
    const u = new Vector3().crossVectors(dir, ref).normalize();
    const w = new Vector3().crossVectors(dir, u).normalize();
    const pts: ManipGeom['ring'][number]['pts'] = [];
    const camPos = new Vector3().setFromMatrixPosition(v.camera().matrixWorld);
    for (let k = 0; k <= 48; k++) {
      const a = (k / 48) * Math.PI * 2;
      const off = u.clone().multiplyScalar(Math.cos(a)).add(w.clone().multiplyScalar(Math.sin(a)));
      const pw = center.clone().add(off.clone().multiplyScalar(R * 0.8 * ps));
      const pp = v.project(pw);
      const toCam = v.isOrtho ? viewDir.clone().negate() : camPos.clone().sub(center).normalize();
      pts.push({ x: pp.x, y: pp.y, front: off.dot(toCam) >= -0.02 });
    }
    ring.push({ i, pts });
  }
  return { c: { x: pc.x, y: pc.y }, axes, ring, radius: R };
}

function segDist(px: number, py: number, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - a.x) * dx + (py - a.y) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a.x + dx * t), py - (a.y + dy * t));
}

export function manipulatorHit(view: View3D, x: number, y: number): ManipHit | null {
  const d = view.display;
  if (!d.manipulator || app.mode === 'SCULPT') return null;
  const g = manipGeometry(view);
  if (!g) return null;
  const dc = Math.hypot(x - g.c.x, y - g.c.y);
  if (d.manipTranslate || d.manipScale) {
    let best: { axis: number; d: number; kind: 'translate' | 'scale' } | null = null;
    for (const a of g.axes) {
      if (a.hidden) continue;
      const tip = d.manipTranslate ? a.tip : a.tip;
      const dd = segDist(x, y, { x: g.c.x + (tip.x - g.c.x) * 0.2, y: g.c.y + (tip.y - g.c.y) * 0.2 }, tip);
      if (dd < 9 && (!best || dd < best.d)) best = { axis: a.i, d: dd, kind: d.manipTranslate ? 'translate' : 'scale' };
    }
    if (best) {
      // with both translate and scale on, the scale handles sit at 60% of the arrow length
      if (d.manipTranslate && d.manipScale) {
        const a = g.axes[best.axis];
        const sp = { x: g.c.x + (a.tip.x - g.c.x) * 0.6, y: g.c.y + (a.tip.y - g.c.y) * 0.6 };
        if (Math.hypot(x - sp.x, y - sp.y) < 8) return { kind: 'scale', axis: best.axis };
      }
      return { kind: best.kind, axis: best.axis };
    }
    if (dc < 12) return { kind: d.manipTranslate ? 'translate' : 'scale', axis: 'view' };
  }
  if (d.manipRotate) {
    let best: { axis: number; d: number } | null = null;
    for (const r of g.ring) {
      for (let k = 0; k + 1 < r.pts.length; k++) {
        const a = r.pts[k], b = r.pts[k + 1];
        if (!a.front && !b.front) continue;
        const dd = segDist(x, y, a, b);
        if (dd < 7 && (!best || dd < best.d)) best = { axis: r.i, d: dd };
      }
    }
    if (best) return { kind: 'rotate', axis: best.axis };
    const rr = g.radius * 0.8 * 1.25;
    if (Math.abs(dc - rr) < 6) return { kind: 'rotate', axis: 'view' };
    if (dc < g.radius * 0.8) return { kind: 'rotate', axis: 'trackball' };
  }
  return null;
}

function arrowHead(ctx: CanvasRenderingContext2D, from: { x: number; y: number }, to: { x: number; y: number }, size: number) {
  const ang = Math.atan2(to.y - from.y, to.x - from.x);
  ctx.beginPath();
  ctx.moveTo(to.x + Math.cos(ang) * size, to.y + Math.sin(ang) * size);
  ctx.lineTo(to.x + Math.cos(ang + 2.6) * size * 0.8, to.y + Math.sin(ang + 2.6) * size * 0.8);
  ctx.lineTo(to.x + Math.cos(ang - 2.6) * size * 0.8, to.y + Math.sin(ang - 2.6) * size * 0.8);
  ctx.closePath();
  ctx.fill();
}

function drawManipulator(ctx: CanvasRenderingContext2D, view: View3D): void {
  const d = view.display;
  if (!d.manipulator || d.showOnlyRender || app.mode === 'SCULPT') return;
  const g = manipGeometry(view);
  if (!g) return;
  const hover = view.manipHover;
  const isHi = (kind: string, axis: number | string) => hover && hover.kind === kind && hover.axis === axis;
  ctx.lineCap = 'round';
  if (d.manipRotate) {
    // outer view ring and trackball disc
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = isHi('rotate', 'view') ? '#ffffff' : 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.arc(g.c.x, g.c.y, g.radius * 0.8 * 1.25, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = isHi('rotate', 'trackball') ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.07)';
    ctx.beginPath();
    ctx.arc(g.c.x, g.c.y, g.radius * 0.8, 0, Math.PI * 2);
    ctx.fill();
    for (const r of g.ring) {
      ctx.strokeStyle = isHi('rotate', r.i) ? AXIS_HI[r.i] : AXIS_COL[r.i];
      ctx.lineWidth = isHi('rotate', r.i) ? 3 : 2;
      ctx.beginPath();
      let pen = false;
      for (const p of r.pts) {
        if (!p.front) { pen = false; continue; }
        if (!pen) { ctx.moveTo(p.x, p.y); pen = true; } else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }
  }
  if (d.manipTranslate || d.manipScale) {
    for (const a of g.axes) {
      if (a.hidden) continue;
      const hi = isHi('translate', a.i) || isHi('scale', a.i);
      ctx.strokeStyle = ctx.fillStyle = hi ? AXIS_HI[a.i] : AXIS_COL[a.i];
      ctx.lineWidth = hi ? 3 : 2;
      ctx.beginPath();
      const start = { x: g.c.x + (a.tip.x - g.c.x) * 0.12, y: g.c.y + (a.tip.y - g.c.y) * 0.12 };
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(a.tip.x, a.tip.y);
      ctx.stroke();
      if (d.manipTranslate) arrowHead(ctx, g.c, a.tip, 9);
      if (d.manipScale) {
        const sp = d.manipTranslate ? { x: g.c.x + (a.tip.x - g.c.x) * 0.6, y: g.c.y + (a.tip.y - g.c.y) * 0.6 } : a.tip;
        ctx.fillRect(sp.x - 4, sp.y - 4, 8, 8);
      }
    }
    ctx.strokeStyle = (isHi('translate', 'view') || isHi('scale', 'view')) ? '#ffffff' : 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(g.c.x, g.c.y, 9, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawCursor(ctx: CanvasRenderingContext2D, view: View3D): void {
  const p = view.view.project(new Vector3(...app.scene.cursor));
  if (p.behind) return;
  const r = 10;
  ctx.lineWidth = 1.5;
  for (let i = 0; i < 8; i++) {
    ctx.strokeStyle = i % 2 ? '#ffffff' : '#ff2020';
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, (i / 8) * Math.PI * 2, ((i + 1) / 8) * Math.PI * 2);
    ctx.stroke();
  }
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 1;
  ctx.beginPath();
  const g = 5, l = 14;
  ctx.moveTo(p.x - l, p.y); ctx.lineTo(p.x - g, p.y);
  ctx.moveTo(p.x + g, p.y); ctx.lineTo(p.x + l, p.y);
  ctx.moveTo(p.x, p.y - l); ctx.lineTo(p.x, p.y - g);
  ctx.moveTo(p.x, p.y + g); ctx.lineTo(p.x, p.y + l);
  ctx.stroke();
}

function drawMiniAxis(ctx: CanvasRenderingContext2D, view: View3D, hgt: number): void {
  if (!app.prefs.showMiniAxis) return;
  const q = view.view.camera().quaternion.clone().invert();
  const o = { x: 30, y: hgt - 34 };
  const len = app.prefs.miniAxisSize;
  const axes = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)].map((a, i) => ({ v: a.applyQuaternion(q), i }));
  axes.sort((a, b) => a.v.z - b.v.z);
  ctx.font = '11px "DejaVu Sans", Verdana, sans-serif';
  for (const { v, i } of axes) {
    const ex = o.x + v.x * len, ey = o.y - v.y * len;
    ctx.strokeStyle = AXIS_COL[i];
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(o.x, o.y);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.fillText('XYZ'[i], ex + (v.x >= 0 ? 3 : -10), ey + (v.y >= 0 ? -3 : 10));
  }
}

function shadowText(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, color = '#ffffff') {
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillText(s, x + 1, y + 1);
  ctx.fillStyle = color;
  ctx.fillText(s, x, y);
}

export function drawOverlay(view: View3D): void {
  const cv = view.overlay;
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  const dpr = view.renderer.pixelRatio;
  const w = cv.width / dpr, hgt = cv.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, hgt);
  const v = view.view;
  const d = view.display;
  ctx.font = '11px "DejaVu Sans", Verdana, sans-serif';
  ctx.textBaseline = 'alphabetic';

  // ---- camera frame & passepartout
  if (v.persp === 'CAMERA' && v.frame) {
    const f = v.frame;
    const cd = v.sceneCameraData();
    if (cd?.showPassepartout) {
      ctx.fillStyle = `rgba(0,0,0,${cd.passepartoutAlpha})`;
      ctx.fillRect(0, 0, w, Math.max(0, f.y));
      ctx.fillRect(0, f.y + f.h, w, Math.max(0, hgt - f.y - f.h));
      ctx.fillRect(0, f.y, Math.max(0, f.x), f.h);
      ctx.fillRect(f.x + f.w, f.y, Math.max(0, w - f.x - f.w), f.h);
    }
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(f.x) + 0.5, Math.round(f.y) + 0.5, Math.round(f.w), Math.round(f.h));
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.strokeRect(Math.round(f.x) - 0.5, Math.round(f.y) - 0.5, Math.round(f.w) + 2, Math.round(f.h) + 2);
    ctx.setLineDash([]);
    if (cd?.showName || true) {
      const camOb = v.sceneCamera();
      if (camOb) shadowText(ctx, camOb.name, f.x + 4, f.y + f.h + 13, '#000' === '#000' ? '#ddd' : '#fff');
    }
  }

  if (!d.showOnlyRender) {
    // ---- lamps
    for (const ob of app.objects()) {
      if (ob.type !== 'LAMP' || !view.renderer.objectVisible(ob.id)) continue;
      const pos = app.matrices.location(ob);
      const p = v.project(pos);
      if (p.behind) continue;
      const sel = ob.select, act = app.scene.activeObject === ob.id;
      const outline = act && sel ? ACTIVE : sel ? SELECT : '#000';
      ctx.lineWidth = 1;
      ctx.fillStyle = 'rgba(0,0,0,0.16)';
      ctx.beginPath(); ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = outline;
      ctx.beginPath(); ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(p.x, p.y, 9, 0, Math.PI * 2); ctx.stroke();
      const la = ob.data ? app.doc.lamps[ob.data] : null;
      if (la?.lampType === 'SUN') {
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          ctx.beginPath();
          ctx.moveTo(p.x + Math.cos(a) * 12, p.y + Math.sin(a) * 12);
          ctx.lineTo(p.x + Math.cos(a) * 17, p.y + Math.sin(a) * 17);
          ctx.stroke();
        }
      }
    }
    // ---- origins
    for (const ob of app.objects()) {
      if (!view.renderer.objectVisible(ob.id)) continue;
      if (!ob.select && !d.showAllOrigins) continue;
      if (app.mode === 'EDIT' && app.editObject === ob.id) continue;
      const p = v.project(app.matrices.location(ob));
      if (p.behind) continue;
      const act = app.scene.activeObject === ob.id;
      ctx.fillStyle = ob.select ? (act ? ACTIVE : SELECT) : '#000';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    // ---- names
    for (const ob of app.objects()) {
      if (!ob.showName || !view.renderer.objectVisible(ob.id)) continue;
      const p = v.project(app.matrices.location(ob));
      if (p.behind) continue;
      shadowText(ctx, ob.name, p.x + 6, p.y - 4, ob.select ? '#ffaa40' : '#fff');
    }
    // ---- loop cut preview
    if (view.previewLines && view.previewLines.length) {
      ctx.strokeStyle = '#ffd400';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i + 1 < view.previewLines.length; i += 2) {
        const a = v.project(view.previewLines[i]), b = v.project(view.previewLines[i + 1]);
        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();
    }
    drawCursor(ctx, view);
    // sculpt brush circle and radial control
    if (app.mode === 'SCULPT') {
      const sc = sculptSettings();
      const rc = view.radialControl;
      const pos = rc ? rc.center : view.brushPos;
      if (pos) {
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = sc.direction === 'SUBTRACT' ? 'rgba(120,170,255,0.9)' : 'rgba(255,110,110,0.9)';
        ctx.beginPath(); ctx.arc(pos.x, pos.y, sc.radius, 0, Math.PI * 2); ctx.stroke();
        if (rc) {
          ctx.fillStyle = 'rgba(255,255,255,0.15)';
          ctx.beginPath(); ctx.arc(pos.x, pos.y, rc.which === 'radius' ? sc.radius : sc.strength * 200, 0, Math.PI * 2); ctx.fill();
          shadowText(ctx, rc.which === 'radius' ? `${Math.round(sc.radius)}` : sc.strength.toFixed(3), pos.x - 12, pos.y + 4);
        }
      }
    }
    drawManipulator(ctx, view);
  }

  // ---- transform constraint lines & proportional circle
  const ts = view.transformState;
  if (ts) {
    const c = ts.center();
    const cons = ts.constraint();
    if (cons) {
      const om = ts.orient();
      cons.forEach((on, i) => {
        if (!on) return;
        const a = axisVector(om, i);
        const p0 = v.project(c.clone().add(a.clone().multiplyScalar(-1000))), p1 = v.project(c.clone().add(a.clone().multiplyScalar(1000)));
        const pc = v.project(c);
        ctx.strokeStyle = AXIS_COL[i];
        ctx.lineWidth = 1;
        ctx.beginPath();
        // clip roughly: draw from centre in both directions
        const dir = { x: p1.x - pc.x, y: p1.y - pc.y };
        const len = Math.hypot(dir.x, dir.y) || 1;
        const ex = (dir.x / len) * 5000, ey = (dir.y / len) * 5000;
        if (p0.behind && p1.behind) return;
        ctx.moveTo(pc.x - ex, pc.y - ey);
        ctx.lineTo(pc.x + ex, pc.y + ey);
        ctx.stroke();
      });
    }
    const sp = ts.snap?.();
    if (sp) {
      const q = v.project(sp);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(q.x, q.y, 6, 0, Math.PI * 2); ctx.stroke();
    }
    const ps = ts.propSize();
    if (ps > 0) {
      const pc = v.project(c);
      const rpx = ps / v.pixelSize(c);
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(pc.x, pc.y, rpx, 0, Math.PI * 2); ctx.stroke();
    }
    // dashed line from pivot to mouse for rotate/scale like Blender
    const mode = ts.mode();
    if (mode === 'ROTATION' || mode === 'RESIZE' || mode === 'SHRINK_FATTEN' || mode === 'TOSPHERE') {
      const pc = v.project(c);
      const r = view.canvasRect();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = '#000';
      ctx.beginPath();
      ctx.moveTo(pc.x, pc.y);
      ctx.lineTo(app.mouse.x - r.left, app.mouse.y - r.top);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // ---- selection shapes
  const sh = view.overlayShape;
  if (sh) {
    ctx.lineWidth = 1;
    if (sh.kind === 'rect') {
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = '#fff';
      const x = Math.min(sh.a.x, sh.b.x), y = Math.min(sh.a.y, sh.b.y);
      ctx.strokeRect(x + 0.5, y + 0.5, Math.abs(sh.b.x - sh.a.x), Math.abs(sh.b.y - sh.a.y));
      ctx.setLineDash([4, 3]);
      ctx.lineDashOffset = 4;
      ctx.strokeStyle = '#000';
      ctx.strokeRect(x + 0.5, y + 0.5, Math.abs(sh.b.x - sh.a.x), Math.abs(sh.b.y - sh.a.y));
      ctx.lineDashOffset = 0;
      ctx.setLineDash([]);
    } else if (sh.kind === 'cross') {
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.beginPath();
      ctx.moveTo(0, sh.a.y + 0.5); ctx.lineTo(w, sh.a.y + 0.5);
      ctx.moveTo(sh.a.x + 0.5, 0); ctx.lineTo(sh.a.x + 0.5, hgt);
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (sh.kind === 'circle') {
      ctx.strokeStyle = '#fff';
      ctx.beginPath(); ctx.arc(sh.a.x, sh.a.y, sh.r ?? 25, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = '#000';
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.arc(sh.a.x, sh.a.y, sh.r ?? 25, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
    } else if (sh.kind === 'lasso' && sh.pts) {
      ctx.strokeStyle = '#fff';
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      sh.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // ---- texts
  if (app.prefs.showViewName) {
    shadowText(ctx, v.title() + (view.localView ? ' (Local)' : ''), 10, 20);
  }
  if (app.playing && app.prefs.showPlaybackFps) {
    const fps = app.fps;
    const target = app.scene.fps / (app.scene.fpsBase || 1);
    shadowText(ctx, `fps: ${fps.toFixed(fps < 10 ? 1 : 0)}`, 10, 36, fps < target * 0.9 ? '#ff6060' : '#fff');
  }
  if (app.prefs.showObjectInfo) {
    const ob = app.activeObject;
    const frame = app.scene.frameCurrent;
    let text = `(${frame})`;
    let color = '#ffffff';
    if (ob) {
      text += ` ${ob.name}`;
      if (objectKeyFrames(ob).some((f) => Math.abs(f - frame) < 1e-4)) color = '#f0eb64';
    }
    shadowText(ctx, text, 10, hgt - 8, color);
  }
  drawMiniAxis(ctx, view, hgt - 14);
}
