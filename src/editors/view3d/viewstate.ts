// RegionView3D equivalent: view orientation, distance, perspective/ortho/camera
// projection (using Blender's viewport lens conventions) and smooth view.

import { Euler, Matrix4, OrthographicCamera, PerspectiveCamera, Quaternion, Vector3, Vector2, Camera } from 'three';
import { threeEulerOrder } from '../../core/scene';
import { app } from '../../app';
import type { BObject, CameraData } from '../../core/types';

export type ViewName = 'USER' | 'FRONT' | 'BACK' | 'RIGHT' | 'LEFT' | 'TOP' | 'BOTTOM' | 'CAMERA';

const SENSOR = 32;
const DEG = Math.PI / 180;

const qAxis = (x: number, y: number, z: number, a: number) => new Quaternion().setFromAxisAngle(new Vector3(x, y, z), a);

export const VIEW_QUATS: Record<Exclude<ViewName, 'USER' | 'CAMERA'>, Quaternion> = {
  TOP: new Quaternion(),
  BOTTOM: qAxis(1, 0, 0, Math.PI),
  FRONT: qAxis(1, 0, 0, Math.PI / 2),
  BACK: qAxis(0, 0, 1, Math.PI).multiply(qAxis(1, 0, 0, Math.PI / 2)),
  RIGHT: qAxis(0, 0, 1, Math.PI / 2).multiply(qAxis(1, 0, 0, Math.PI / 2)),
  LEFT: qAxis(0, 0, 1, -Math.PI / 2).multiply(qAxis(1, 0, 0, Math.PI / 2)),
};

/** View rotation looking at the origin from the given azimuth/elevation (degrees). */
export function viewQuatFromAngles(azDeg: number, elDeg: number): Quaternion {
  const az = (azDeg * Math.PI) / 180, el = (elDeg * Math.PI) / 180;
  const eye = new Vector3(Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el));
  return new Quaternion().setFromRotationMatrix(new Matrix4().lookAt(eye, new Vector3(), new Vector3(0, 0, 1)));
}

export interface CameraFrame {
  /** Camera frame rectangle in viewport pixels (camera view only). */
  x: number; y: number; w: number; h: number;
}

export class ViewState {
  /** View orientation: view space -> world (like Blender's view_rotation). */
  rot = viewQuatFromAngles(-52, 26);
  target = new Vector3(0.6, -0.6, 0.6);
  dist = 15.5;
  persp: 'PERSP' | 'ORTHO' | 'CAMERA' = 'PERSP';
  /** Projection to return to when leaving camera view. */
  lastPersp: 'PERSP' | 'ORTHO' = 'PERSP';
  viewName: ViewName = 'USER';
  lens = 35;
  clipStart = 0.1;
  clipEnd = 1000;
  camZoom = 0;
  camOffset = new Vector2(0, 0);
  lockCameraToView = false;
  /** When true the camera frame fills the viewport exactly (used for final renders). */
  fitFrame = false;

  width = 1;
  height = 1;

  readonly perspCam = new PerspectiveCamera();
  readonly orthoCam = new OrthographicCamera();
  frame: CameraFrame | null = null;

  private anim: { from: { rot: Quaternion; target: Vector3; dist: number }; to: { rot: Quaternion; target: Vector3; dist: number }; start: number; dur: number } | null = null;

  constructor() {
    this.perspCam.up.set(0, 0, 1);
    this.orthoCam.up.set(0, 0, 1);
  }

  toJSON(): Record<string, unknown> {
    return {
      rot: this.rot.toArray(), target: this.target.toArray(), dist: this.dist, persp: this.persp, lastPersp: this.lastPersp,
      viewName: this.viewName, lens: this.lens, clipStart: this.clipStart, clipEnd: this.clipEnd, camZoom: this.camZoom,
    };
  }

  fromJSON(o: Record<string, unknown> | undefined): void {
    if (!o) return;
    if (Array.isArray(o.rot)) this.rot.fromArray(o.rot as number[]);
    if (Array.isArray(o.target)) this.target.fromArray(o.target as number[]);
    if (typeof o.dist === 'number') this.dist = o.dist;
    if (typeof o.persp === 'string') this.persp = o.persp as ViewState['persp'];
    if (typeof o.lastPersp === 'string') this.lastPersp = o.lastPersp as ViewState['lastPersp'];
    if (typeof o.viewName === 'string') this.viewName = o.viewName as ViewName;
    if (typeof o.lens === 'number') this.lens = o.lens;
    if (typeof o.clipStart === 'number') this.clipStart = o.clipStart;
    if (typeof o.clipEnd === 'number') this.clipEnd = o.clipEnd;
    if (typeof o.camZoom === 'number') this.camZoom = o.camZoom;
  }

  get isOrtho(): boolean {
    if (this.persp === 'CAMERA') {
      const cd = this.sceneCameraData();
      return cd?.lensType === 'ORTHO';
    }
    return this.persp === 'ORTHO';
  }

  sceneCamera(): BObject | null {
    const id = app.scene.camera;
    const ob = id ? app.doc.objects[id] : null;
    return ob && ob.type === 'CAMERA' ? ob : null;
  }

  sceneCameraData(): CameraData | null {
    const ob = this.sceneCamera();
    return ob?.data ? app.doc.cameras[ob.data] ?? null : null;
  }

  /** Active three.js camera with up-to-date matrices. */
  camera(): Camera {
    this.update();
    return this.isOrtho ? this.orthoCam : this.perspCam;
  }

  /** Name shown in the top-left corner ("User Persp", "Front Ortho", "Camera Persp"). */
  title(): string {
    if (this.persp === 'CAMERA') return `Camera ${this.isOrtho ? 'Ortho' : 'Persp'}`;
    const n = this.viewName === 'USER' ? 'User' : this.viewName[0] + this.viewName.slice(1).toLowerCase();
    return `${n} ${this.persp === 'ORTHO' ? 'Ortho' : 'Persp'}`;
  }

  eye(): Vector3 {
    return this.target.clone().add(new Vector3(0, 0, this.dist).applyQuaternion(this.rot));
  }

  setSize(w: number, h: number): void {
    this.width = Math.max(1, w);
    this.height = Math.max(1, h);
  }

  /** World units per pixel at the pivot depth (used for pan / gizmo sizing). */
  pixelSizeAtTarget(): number {
    const halfW = this.dist * (SENSOR / this.lens);
    const big = Math.max(this.width, this.height);
    return (halfW * 2) / big;
  }

  /** World units per pixel at an arbitrary world point. */
  pixelSize(p: Vector3): number {
    const cam = this.camera();
    if (this.isOrtho) {
      const o = this.orthoCam;
      return (o.right - o.left) / this.width;
    }
    const camPos = new Vector3().setFromMatrixPosition(cam.matrixWorld);
    const forward = new Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const depth = Math.max(1e-4, p.clone().sub(camPos).dot(forward));
    const pc = this.perspCam;
    const e = pc.projectionMatrix.elements;
    // e[0] = 2n/(r-l) -> width at depth d = 2d/e[0]
    return (2 * depth) / e[0] / this.width;
  }

  // ---------------------------------------------------------------- projection

  update(): void {
    this.tickAnim();
    const w = this.width, h = this.height;
    this.frame = null;
    if (this.persp === 'CAMERA') {
      const ob = this.sceneCamera();
      const cd = this.sceneCameraData();
      if (ob && cd) { this.updateCameraView(ob, cd); return; }
      this.persp = this.lastPersp;
    }
    const eye = this.eye();
    const big = Math.max(w, h);
    const halfBig = SENSOR / this.lens; // tan(half fov) for the larger dimension (Blender: zoom 2.0)
    const hx = (halfBig * w) / big, hy = (halfBig * h) / big;
    if (this.persp === 'ORTHO') {
      const o = this.orthoCam;
      o.position.copy(eye);
      o.quaternion.copy(this.rot);
      o.updateMatrixWorld(true);
      const sx = this.dist * hx, sy = this.dist * hy;
      o.left = -sx; o.right = sx; o.top = sy; o.bottom = -sy;
      o.near = -this.clipEnd * 0.5;
      o.far = this.clipEnd * 0.5;
      o.projectionMatrix.makeOrthographic(-sx, sx, sy, -sy, o.near, o.far);
      o.projectionMatrixInverse.copy(o.projectionMatrix).invert();
    } else {
      const p = this.perspCam;
      p.position.copy(eye);
      p.quaternion.copy(this.rot);
      p.updateMatrixWorld(true);
      const n = this.clipStart;
      p.near = n; p.far = this.clipEnd;
      p.projectionMatrix.makePerspective(-hx * n, hx * n, hy * n, -hy * n, n, this.clipEnd);
      p.projectionMatrixInverse.copy(p.projectionMatrix).invert();
    }
  }

  /** Fraction of the viewport the camera frame fills (Blender's camzoom). */
  camZoomFactor(): number {
    if (this.fitFrame) return 1;
    const f = Math.pow(Math.SQRT2 + this.camZoom / 50, 2) / 4; // BKE_screen_view3d_zoom_to_fac
    return Math.min(20, Math.max(0.02, f * 1.6));
  }

  private updateCameraView(ob: BObject, cd: CameraData): void {
    const w = this.width, h = this.height;
    const r = app.scene.render;
    const ra = (r.resolutionX * r.pixelAspectX) / Math.max(1, r.resolutionY * r.pixelAspectY);
    const m = app.matrices.world(ob);
    const pos = new Vector3(), quat = new Quaternion(), scl = new Vector3();
    m.decompose(pos, quat, scl);
    const ortho = cd.lensType === 'ORTHO';
    // frame half extents at unit depth (persp) or in world units (ortho)
    let fw: number, fh: number;
    const fit = cd.sensorFit === 'AUTO' ? (ra >= 1 ? 'HORIZONTAL' : 'VERTICAL') : cd.sensorFit;
    const sensor = cd.sensorFit === 'VERTICAL' ? cd.sensorHeight : cd.sensorWidth;
    const base = ortho ? cd.orthoScale / 2 : sensor / 2 / cd.lens;
    if (fit === 'HORIZONTAL') { fw = base; fh = base / ra; } else { fh = base; fw = base * ra; }
    const shiftUnit = 2 * Math.max(fw, fh);
    const cx = cd.shiftX * shiftUnit, cy = cd.shiftY * shiftUnit;
    const k = this.camZoomFactor();
    const va = w / h;
    let vw: number, vh: number;
    if (fw / fh > va) { vw = fw / k; vh = vw / va; } else { vh = fh / k; vw = vh * va; }
    const ox = cx - this.camOffset.x * 2 * fw, oy = cy - this.camOffset.y * 2 * fh;
    const near = ortho ? -cd.clipEnd : cd.clipStart;
    const far = cd.clipEnd;
    if (ortho) {
      const o = this.orthoCam;
      o.position.copy(pos);
      o.quaternion.copy(quat);
      o.updateMatrixWorld(true);
      o.left = ox - vw; o.right = ox + vw; o.top = oy + vh; o.bottom = oy - vh;
      o.near = cd.clipStart; o.far = far;
      o.projectionMatrix.makeOrthographic(o.left, o.right, o.top, o.bottom, cd.clipStart, far);
      o.projectionMatrixInverse.copy(o.projectionMatrix).invert();
    } else {
      const p = this.perspCam;
      p.position.copy(pos);
      p.quaternion.copy(quat);
      p.updateMatrixWorld(true);
      p.near = near; p.far = far;
      p.projectionMatrix.makePerspective((ox - vw) * near, (ox + vw) * near, (oy + vh) * near, (oy - vh) * near, near, far);
      p.projectionMatrixInverse.copy(p.projectionMatrix).invert();
    }
    // frame rectangle in pixels
    const toPx = (x: number, y: number) => [((x - (ox - vw)) / (2 * vw)) * w, (1 - (y - (oy - vh)) / (2 * vh)) * h];
    const [x0, y0] = toPx(cx - fw, cy + fh);
    const [x1, y1] = toPx(cx + fw, cy - fh);
    this.frame = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  // ---------------------------------------------------------------- projection helpers

  /** World -> viewport pixel coordinates (x right, y down). z is NDC depth. */
  project(p: Vector3): { x: number; y: number; z: number; behind: boolean } {
    const cam = this.camera();
    const v = p.clone().applyMatrix4(cam.matrixWorldInverse);
    const behind = !this.isOrtho && v.z > -1e-6;
    v.applyMatrix4(cam.projectionMatrix);
    return { x: (v.x * 0.5 + 0.5) * this.width, y: (-v.y * 0.5 + 0.5) * this.height, z: v.z, behind };
  }

  /** Pixel -> NDC */
  ndc(x: number, y: number): Vector2 {
    return new Vector2((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1);
  }

  /** A world-space ray through a pixel. */
  ray(x: number, y: number): { origin: Vector3; dir: Vector3 } {
    const cam = this.camera();
    const n = this.ndc(x, y);
    const near = new Vector3(n.x, n.y, -1).unproject(cam);
    const far = new Vector3(n.x, n.y, 1).unproject(cam);
    return { origin: near, dir: far.sub(near).normalize() };
  }

  /** Point under a pixel at the depth of `ref` (on the plane through `ref` facing the view). */
  unprojectAtDepth(x: number, y: number, ref: Vector3): Vector3 {
    const { origin, dir } = this.ray(x, y);
    const cam = this.camera();
    const normal = new Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const denom = dir.dot(normal);
    if (Math.abs(denom) < 1e-9) return ref.clone();
    const t = ref.clone().sub(origin).dot(normal) / denom;
    return origin.add(dir.multiplyScalar(t));
  }

  viewDir(): Vector3 { return new Vector3(0, 0, -1).applyQuaternion(this.camera().quaternion); }
  viewRight(): Vector3 { return new Vector3(1, 0, 0).applyQuaternion(this.camera().quaternion); }
  viewUp(): Vector3 { return new Vector3(0, 1, 0).applyQuaternion(this.camera().quaternion); }

  // ---------------------------------------------------------------- navigation

  /** Leave camera view, keeping the current camera position as the user view. */
  leaveCamera(): void {
    if (this.persp !== 'CAMERA') return;
    const ob = this.sceneCamera();
    if (ob) {
      const m = app.matrices.world(ob);
      const pos = new Vector3(), quat = new Quaternion();
      m.decompose(pos, quat, new Vector3());
      this.rot.copy(quat);
      // keep the pivot in front of the camera at the current distance
      this.target.copy(pos).add(new Vector3(0, 0, -this.dist).applyQuaternion(quat));
    }
    this.persp = this.lastPersp;
    this.viewName = 'USER';
  }

  orbit(dx: number, dy: number, trackball = false): void {
    if (this.persp === 'CAMERA') {
      if (this.lockCameraToView) { this.orbitCamera(dx, dy); return; }
      this.leaveCamera();
    }
    this.anim = null;
    const s = 0.007;
    if (trackball) {
      const right = new Vector3(1, 0, 0).applyQuaternion(this.rot);
      const up = new Vector3(0, 1, 0).applyQuaternion(this.rot);
      const q1 = new Quaternion().setFromAxisAngle(up, -dx * s);
      const q2 = new Quaternion().setFromAxisAngle(right, -dy * s);
      this.rot.premultiply(q1).premultiply(q2).normalize();
    } else {
      const qz = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -dx * s);
      const qx = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -dy * s);
      this.rot.premultiply(qz).multiply(qx).normalize();
    }
    if (this.viewName !== 'USER') {
      this.viewName = 'USER';
      if (app.prefs.autoPerspective && this.persp === 'ORTHO') this.persp = 'PERSP';
    }
  }

  /** "Lock Camera to View": navigation moves the scene camera. */
  private orbitCamera(dx: number, dy: number): void {
    const ob = this.sceneCamera();
    if (!ob) return;
    const m = app.matrices.world(ob);
    const pos = new Vector3(), quat = new Quaternion();
    m.decompose(pos, quat, new Vector3());
    const pivot = pos.clone().add(new Vector3(0, 0, -this.dist).applyQuaternion(quat));
    const s = 0.007;
    const qz = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -dx * s);
    const qx = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -dy * s);
    const nq = quat.clone().premultiply(qz).multiply(qx).normalize();
    const npos = pivot.clone().add(new Vector3(0, 0, this.dist).applyQuaternion(nq));
    this.setCameraWorld(ob, npos, nq);
  }

  setCameraWorld(ob: BObject, pos: Vector3, quat: Quaternion): void {
    const world = new Matrix4().compose(pos, quat, new Vector3(...ob.scale));
    const parentWorld = ob.parent && app.doc.objects[ob.parent] ? app.matrices.world(app.doc.objects[ob.parent]).clone().multiply(new Matrix4().fromArray(ob.parentInverse)) : new Matrix4();
    const basis = parentWorld.invert().multiply(world);
    const p = new Vector3(), q = new Quaternion(), sc = new Vector3();
    basis.decompose(p, q, sc);
    ob.location = [p.x, p.y, p.z];
    const e = new Euler().setFromQuaternion(q, threeEulerOrder(ob.rotationMode));
    ob.rotation = [e.x, e.y, e.z];
    app.notify('scene');
  }

  pan(dx: number, dy: number): void {
    if (this.persp === 'CAMERA') {
      if (this.lockCameraToView) {
        const ob = this.sceneCamera();
        if (!ob) return;
        const m = app.matrices.world(ob);
        const pos = new Vector3(), quat = new Quaternion();
        m.decompose(pos, quat, new Vector3());
        const ps = this.pixelSizeAtTarget();
        const right = new Vector3(1, 0, 0).applyQuaternion(quat), up = new Vector3(0, 1, 0).applyQuaternion(quat);
        pos.add(right.multiplyScalar(-dx * ps)).add(up.multiplyScalar(dy * ps));
        this.setCameraWorld(ob, pos, quat);
        return;
      }
      const f = this.frame;
      if (f) {
        this.camOffset.x += dx / f.w;
        this.camOffset.y -= dy / f.h;
      }
      return;
    }
    this.anim = null;
    const ps = this.pixelSizeAtTarget();
    const right = new Vector3(1, 0, 0).applyQuaternion(this.rot);
    const up = new Vector3(0, 1, 0).applyQuaternion(this.rot);
    this.target.add(right.multiplyScalar(-dx * ps)).add(up.multiplyScalar(dy * ps));
  }

  zoom(factor: number, mx?: number, my?: number): void {
    if (this.persp === 'CAMERA') {
      if (this.lockCameraToView) {
        const ob = this.sceneCamera();
        if (!ob) return;
        const m = app.matrices.world(ob);
        const pos = new Vector3(), quat = new Quaternion();
        m.decompose(pos, quat, new Vector3());
        const fwd = new Vector3(0, 0, -1).applyQuaternion(quat);
        const move = this.dist * (1 - factor);
        this.dist *= factor;
        pos.add(fwd.multiplyScalar(move));
        this.setCameraWorld(ob, pos, quat);
        return;
      }
      this.camZoom = Math.max(-30, Math.min(600, this.camZoom + (factor < 1 ? 5 : -5) * Math.abs(Math.log(factor) / Math.log(1.2))));
      return;
    }
    this.anim = null;
    const old = this.dist;
    this.dist = Math.max(1e-3, Math.min(1e6, this.dist * factor));
    if (app.prefs.zoomToMouse && mx !== undefined && my !== undefined) {
      const before = this.unprojectAtDepth(mx, my, this.target);
      this.update();
      const after = this.unprojectAtDepth(mx, my, this.target);
      this.target.add(before.sub(after));
    }
    void old;
  }

  setView(name: Exclude<ViewName, 'USER' | 'CAMERA'>, align?: Quaternion): void {
    if (this.persp === 'CAMERA') this.leaveCamera();
    const q = align ? align.clone() : VIEW_QUATS[name].clone();
    this.smoothTo({ rot: q });
    this.viewName = align ? 'USER' : name;
    if (app.prefs.autoPerspective && !align) {
      if (this.persp === 'PERSP') this.lastPersp = 'PERSP';
      this.persp = 'ORTHO';
    }
  }

  /** Numpad 2/4/6/8 style rotation steps. */
  orbitStep(axis: 'Z' | 'X', angle: number): void {
    if (this.persp === 'CAMERA') this.leaveCamera();
    let q: Quaternion;
    if (axis === 'Z') q = this.rot.clone().premultiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), angle));
    else q = this.rot.clone().multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), angle));
    this.smoothTo({ rot: q });
    if (this.viewName !== 'USER') {
      this.viewName = 'USER';
      if (app.prefs.autoPerspective && this.persp === 'ORTHO') this.persp = 'PERSP';
    }
  }

  togglePersp(): void {
    if (this.persp === 'CAMERA') { this.leaveCamera(); }
    this.persp = this.persp === 'PERSP' ? 'ORTHO' : 'PERSP';
    this.lastPersp = this.persp;
  }

  toggleCamera(): void {
    if (this.persp === 'CAMERA') { this.persp = this.lastPersp; return; }
    if (!this.sceneCamera()) { app.report('WARNING', 'No active camera in scene'); return; }
    this.lastPersp = this.persp === 'ORTHO' ? 'ORTHO' : 'PERSP';
    this.persp = 'CAMERA';
    this.camOffset.set(0, 0);
  }

  /** Frame a bounding box (centre + radius). */
  frameBounds(center: Vector3, radius: number): void {
    if (this.persp === 'CAMERA') this.leaveCamera();
    const halfFov = Math.atan(SENSOR / this.lens * Math.min(this.width, this.height) / Math.max(this.width, this.height));
    let d = Math.max(0.05, radius) / Math.sin(halfFov);
    if (this.persp === 'ORTHO') d = Math.max(0.05, radius) * 1.2 / (SENSOR / this.lens * Math.min(this.width, this.height) / Math.max(this.width, this.height));
    this.smoothTo({ target: center.clone(), dist: d * 1.05 });
  }

  smoothTo(to: { rot?: Quaternion; target?: Vector3; dist?: number }): void {
    const dur = app.prefs.smoothView;
    const dest = { rot: (to.rot ?? this.rot).clone(), target: (to.target ?? this.target).clone(), dist: to.dist ?? this.dist };
    if (dur <= 0) {
      this.rot.copy(dest.rot); this.target.copy(dest.target); this.dist = dest.dist;
      this.anim = null;
      return;
    }
    this.anim = { from: { rot: this.rot.clone(), target: this.target.clone(), dist: this.dist }, to: dest, start: performance.now(), dur };
  }

  get animating(): boolean { return !!this.anim; }

  private tickAnim(): void {
    const a = this.anim;
    if (!a) return;
    let t = (performance.now() - a.start) / a.dur;
    if (t >= 1) t = 1;
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    this.rot.copy(a.from.rot).slerp(a.to.rot, e);
    this.target.lerpVectors(a.from.target, a.to.target, e);
    this.dist = a.from.dist + (a.to.dist - a.from.dist) * e;
    if (t >= 1) this.anim = null;
  }

  /** Quaternion that aligns the view with the active camera (for Ctrl+Alt+Numpad0 the inverse is used). */
  static readonly DEG = DEG;
}

