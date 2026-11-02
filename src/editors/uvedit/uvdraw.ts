// Drawing of the UV layout over the image in the UV/Image Editor (2D canvas): faces, edges in the
// Outline / Dash / Black / White styles, UV vertices or face dots, pinned UVs, the active face,
// stretch colouring (Area / Angle) and the 2D cursor.

import { app } from '../../app';
import type { MeshData, MeshUVLayer, Vec3 } from '../../core/types';
import { cornerUV, faceUVValid } from '../../core/uvdata';
import { cornerPinned, cornerSelected, faceUVSelected, isSync, uvSettings, visibleFaces } from './uvsel';
import { polyArea } from '../../core/mesh';

export interface UVDisplay {
  edgeStyle: 'OUTLINE' | 'DASH' | 'BLACK' | 'WHITE';
  drawStretch: boolean;
  stretchType: 'AREA' | 'ANGLE';
  smooth: boolean;
  drawFaces: boolean;
}

export function defaultUVDisplay(): UVDisplay {
  return { edgeStyle: 'OUTLINE', drawStretch: false, stretchType: 'AREA', smooth: false, drawFaces: true };
}

export interface UVMapping {
  /** UV -> canvas pixels (CSS px). */
  toScreen(u: number, v: number): [number, number];
}

const SEL = '#ff8500';
const SEL_FACE = 'rgba(255,133,0,0.25)';
const FACE = 'rgba(255,255,255,0.10)';
const ACTIVE_FACE = 'rgba(255,255,255,0.30)';

/** Blender-like stretch colour: blue (no stretch) -> cyan -> green -> yellow -> red (high stretch). */
function stretchColor(t: number): string {
  const x = Math.max(0, Math.min(1, t));
  // hue from 240 (blue) to 0 (red)
  return `hsla(${Math.round(240 * (1 - x))}, 100%, 50%, 0.55)`;
}

function uvArea(u: number[], n: number): number {
  let a = 0;
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; a += u[i * 2] * u[j * 2 + 1] - u[j * 2] * u[i * 2 + 1]; }
  return Math.abs(a) / 2;
}

function angle3(a: Vec3, b: Vec3, c: Vec3): number {
  const u = [a[0] - b[0], a[1] - b[1], a[2] - b[2]], v = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
  const l = Math.hypot(u[0], u[1], u[2]) * Math.hypot(v[0], v[1], v[2]);
  return l > 0 ? Math.acos(Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / l))) : 0;
}

function angle2(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  const ux = ax - bx, uy = ay - by, vx = cx - bx, vy = cy - by;
  const l = Math.hypot(ux, uy) * Math.hypot(vx, vy);
  return l > 0 ? Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / l))) : 0;
}

/** Per-face stretch in 0..1 for the stretch display. */
function faceStretch(md: MeshData, layer: MeshUVLayer, faces: number[], type: 'AREA' | 'ANGLE', aspect: number): Map<number, number> {
  const out = new Map<number, number>();
  if (type === 'AREA') {
    let t3 = 0, t2 = 0;
    const a3 = new Map<number, number>(), a2 = new Map<number, number>();
    for (const f of faces) {
      const x = polyArea(md.verts, md.faces[f]);
      const u = layer.uv[f].map((c, i) => (i % 2 === 0 ? c * aspect : c));
      const y = uvArea(u, md.faces[f].length);
      a3.set(f, x); a2.set(f, y); t3 += x; t2 += y;
    }
    for (const f of faces) {
      const r3 = t3 > 0 ? a3.get(f)! / t3 : 0, r2 = t2 > 0 ? a2.get(f)! / t2 : 0;
      if (r3 <= 0 && r2 <= 0) { out.set(f, 0); continue; }
      const ratio = r3 > r2 ? (r2 > 0 ? r3 / r2 : 1e9) : (r3 > 0 ? r2 / r3 : 1e9);
      out.set(f, 1 - 1 / Math.max(1, ratio));
    }
  } else {
    for (const f of faces) {
      const g = md.faces[f], n = g.length, u = layer.uv[f];
      let d = 0;
      for (let k = 0; k < n; k++) {
        const p = (k - 1 + n) % n, q = (k + 1) % n;
        const a3 = angle3(md.verts[g[p]], md.verts[g[k]], md.verts[g[q]]);
        const a2 = angle2(u[p * 2] * aspect, u[p * 2 + 1], u[k * 2] * aspect, u[k * 2 + 1], u[q * 2] * aspect, u[q * 2 + 1]);
        d += Math.abs(a3 - a2) / Math.PI;
      }
      out.set(f, Math.min(1, (d / n) * 2.5));
    }
  }
  return out;
}

/** Draw the UV layout of the edit mesh. `aspect` = image width / height. */
export function drawUVs(ctx: CanvasRenderingContext2D, md: MeshData, layer: MeshUVLayer, map: UVMapping, disp: UVDisplay, aspect: number): void {
  const faces = visibleFaces(md).filter((f) => faceUVValid(layer, md, f));
  const sync = isSync();
  const selMode = sync ? (app.scene.toolSettings.meshSelectMode[2] && !app.scene.toolSettings.meshSelectMode[0] ? 'FACE' : 'VERTEX') : uvSettings().selectMode;
  const pts = new Map<number, [number, number][]>();
  for (const f of faces) pts.set(f, md.faces[f].map((_, k) => { const p = cornerUV(layer, f, k); return map.toScreen(p[0], p[1]); }));
  const path = (f: number) => {
    const p = pts.get(f)!;
    ctx.moveTo(p[0][0], p[0][1]);
    for (let i = 1; i < p.length; i++) ctx.lineTo(p[i][0], p[i][1]);
    ctx.closePath();
  };
  ctx.save();
  if (!disp.smooth) ctx.imageSmoothingEnabled = false;
  // faces
  if (disp.drawStretch) {
    const st = faceStretch(md, layer, faces, disp.stretchType, aspect);
    for (const f of faces) { ctx.beginPath(); path(f); ctx.fillStyle = stretchColor(st.get(f) ?? 0); ctx.fill(); }
  } else if (disp.drawFaces) {
    ctx.beginPath();
    for (const f of faces) if (!faceUVSelected(md, layer, f)) path(f);
    ctx.fillStyle = FACE; ctx.fill();
    ctx.beginPath();
    for (const f of faces) if (faceUVSelected(md, layer, f)) path(f);
    ctx.fillStyle = SEL_FACE; ctx.fill();
  }
  if (md.activeFace >= 0 && pts.has(md.activeFace)) { ctx.beginPath(); path(md.activeFace); ctx.fillStyle = ACTIVE_FACE; ctx.fill(); }
  // edges
  const lw = disp.smooth ? 1 : 1;
  const edgeSel = (f: number, k: number) => cornerSelected(md, layer, f, k) && cornerSelected(md, layer, f, (k + 1) % md.faces[f].length);
  const strokeEdges = (filter: (f: number, k: number) => boolean) => {
    ctx.beginPath();
    for (const f of faces) {
      const p = pts.get(f)!;
      for (let k = 0; k < p.length; k++) {
        if (!filter(f, k)) continue;
        const q = p[(k + 1) % p.length];
        ctx.moveTo(p[k][0], p[k][1]);
        ctx.lineTo(q[0], q[1]);
      }
    }
    ctx.stroke();
  };
  if (!disp.smooth) ctx.translate(0.5, 0.5);
  if (disp.edgeStyle === 'OUTLINE') {
    ctx.strokeStyle = '#000'; ctx.lineWidth = 3 * lw;
    strokeEdges(() => true);
    ctx.lineWidth = lw;
    ctx.strokeStyle = '#ffffff';
    strokeEdges((f, k) => !edgeSel(f, k));
    ctx.strokeStyle = SEL;
    strokeEdges(edgeSel);
  } else if (disp.edgeStyle === 'DASH') {
    ctx.lineWidth = lw;
    ctx.strokeStyle = '#000';
    strokeEdges(() => true);
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#fff';
    strokeEdges((f, k) => !edgeSel(f, k));
    ctx.strokeStyle = SEL;
    strokeEdges(edgeSel);
    ctx.setLineDash([]);
  } else {
    ctx.lineWidth = lw;
    ctx.strokeStyle = disp.edgeStyle === 'BLACK' ? '#000' : '#fff';
    strokeEdges((f, k) => !edgeSel(f, k));
    ctx.strokeStyle = SEL;
    strokeEdges(edgeSel);
  }
  // vertices / face dots
  if (selMode === 'FACE') {
    for (const f of faces) {
      const p = pts.get(f)!;
      let x = 0, y = 0;
      for (const q of p) { x += q[0]; y += q[1]; }
      x /= p.length; y /= p.length;
      ctx.fillStyle = faceUVSelected(md, layer, f) ? SEL : '#000';
      ctx.fillRect(x - 2, y - 2, 4, 4);
    }
  } else if (selMode !== 'EDGE' && selMode !== 'ISLAND') {
    const unsel: [number, number][] = [], sel: [number, number][] = [];
    for (const f of faces) pts.get(f)!.forEach((q, k) => (cornerSelected(md, layer, f, k) ? sel : unsel).push(q));
    ctx.fillStyle = '#000';
    for (const q of unsel) ctx.fillRect(q[0] - 2, q[1] - 2, 4, 4);
    ctx.fillStyle = SEL;
    for (const q of sel) ctx.fillRect(q[0] - 2, q[1] - 2, 4, 4);
  }
  // pinned
  ctx.fillStyle = '#ff0000';
  for (const f of faces) pts.get(f)!.forEach((q, k) => { if (cornerPinned(layer, f, k)) ctx.fillRect(q[0] - 3, q[1] - 3, 6, 6); });
  ctx.restore();
}

/** The 2D cursor (red/white dashed circle with a cross). */
export function drawCursor2D(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.save();
  ctx.lineWidth = 1;
  for (let i = 0; i < 8; i++) {
    ctx.strokeStyle = i % 2 ? '#fff' : '#ff0000';
    ctx.beginPath();
    ctx.arc(x, y, 8, (i / 8) * Math.PI * 2, ((i + 1) / 8) * Math.PI * 2);
    ctx.stroke();
  }
  ctx.strokeStyle = '#000';
  ctx.beginPath();
  ctx.moveTo(x - 14, y); ctx.lineTo(x - 5, y); ctx.moveTo(x + 5, y); ctx.lineTo(x + 14, y);
  ctx.moveTo(x, y - 14); ctx.lineTo(x, y - 5); ctx.moveTo(x, y + 5); ctx.lineTo(x, y + 14);
  ctx.stroke();
  ctx.restore();
}

/** Dark grid shown behind UVs when no image is displayed (0..1 area). */
export function drawUVBackground(ctx: CanvasRenderingContext2D, x0: number, y0: number, w: number, h: number): void {
  ctx.fillStyle = '#2b2b2b';
  ctx.fillRect(x0, y0, w, h);
  const n = 8;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, y0, w, h);
  ctx.clip();
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    if ((i + j) % 2) continue;
    ctx.fillStyle = '#323232';
    ctx.fillRect(x0 + (i * w) / n, y0 + (j * h) / n, w / n, h / n);
  }
  ctx.strokeStyle = '#3d3d3d';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let k = 0; k <= n; k++) {
    const x = Math.round(x0 + (k * w) / n) + 0.5, y = Math.round(y0 + (k * h) / n) + 0.5;
    ctx.moveTo(x, y0); ctx.lineTo(x, y0 + h);
    ctx.moveTo(x0, y); ctx.lineTo(x0 + w, y);
  }
  ctx.stroke();
  ctx.restore();
}
