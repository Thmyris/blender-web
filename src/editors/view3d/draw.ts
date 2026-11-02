// Three.js drawing for the 3D viewport: object meshes in the different shading
// modes, floor grid, camera/lamp/empty wireframes, edit-mode overlay and the
// screen-space selection outline.

import {
  AmbientLight, BackSide, BufferAttribute, BufferGeometry, Color, DirectionalLight, DoubleSide, FrontSide, Group,
  HemisphereLight, LineBasicMaterial, LineDashedMaterial, LineSegments, Material, Matrix4, Mesh, MeshBasicMaterial,
  MeshPhongMaterial, NearestFilter, Object3D, OrthographicCamera, PlaneGeometry, PointLight, Points, Raycaster, Scene,
  ShaderMaterial, SphereGeometry, SpotLight, Vector3, WebGLRenderer, WebGLRenderTarget, Fog, PCFSoftShadowMap,
  type Intersection, type Camera, NoBlending, SRGBColorSpace,
} from 'three';
import { app } from '../../app';
import type { BObject, LampData, MaterialData, MeshData, Vec3 } from '../../core/types';
import { type EvalMesh, evalEdges } from '../../core/modifiers';
import { polyCenter, polyNormal, triangulatePoly, edgeKey, meshBounds, hiddenEdges } from '../../core/mesh';
import { isObjectVisible } from '../../core/scene';
import type { ViewState } from './viewstate';
import { buildTextureForMaterial, applyOrcoTexture } from './textures';

export type Shading = 'BOUNDBOX' | 'WIREFRAME' | 'SOLID' | 'TEXTURED' | 'MATERIAL' | 'RENDERED';

export interface ViewDisplay {
  shading: Shading;
  showFloor: boolean;
  showAxisX: boolean;
  showAxisY: boolean;
  showAxisZ: boolean;
  gridLines: number;
  gridScale: number;
  gridSubdivisions: number;
  showOutlineSelected: boolean;
  showAllOrigins: boolean;
  showRelationshipLines: boolean;
  showOnlyRender: boolean;
  showWorld: boolean;
  useOcclude: boolean;
  backfaceCulling: boolean;
  showTexturedSolid: boolean;
  matcap: boolean;
  showFaceDots: boolean;
  showNormals: boolean;
  normalsSize: number;
  useLocalLayers: boolean;
  layers: boolean[];
  manipulator: boolean;
  manipTranslate: boolean;
  manipRotate: boolean;
  manipScale: boolean;
}

export function defaultDisplay(): ViewDisplay {
  return {
    shading: 'SOLID', showFloor: true, showAxisX: true, showAxisY: true, showAxisZ: false, gridLines: 16, gridScale: 1,
    gridSubdivisions: 10, showOutlineSelected: true, showAllOrigins: false, showRelationshipLines: true, showOnlyRender: false,
    showWorld: false, useOcclude: true, backfaceCulling: false, showTexturedSolid: false, matcap: false, showFaceDots: true,
    showNormals: false, normalsSize: 0.1, useLocalLayers: false, layers: new Array(20).fill(false).map((_, i) => i === 0),
    manipulator: true, manipTranslate: true, manipRotate: false, manipScale: false,
  };
}

export const COL = {
  bg: new Color('#393939'),
  grid: new Color('#4a4a4a'),
  gridMajor: new Color('#575757'),
  axisX: new Color('#993535'),
  axisY: new Color('#5f9535'),
  axisZ: new Color('#3a5aa0'),
  wire: new Color('#000000'),
  select: new Color('#f15800'),
  active: new Color('#ffaa40'),
  vertSel: new Color('#ff8500'),
  edgeSel: new Color('#ffa000'),
  faceSel: new Color('#ff8500'),
};

interface GeomCache {
  src: EvalMesh;
  smoothKey: string;
  geom: BufferGeometry;
  edges: BufferGeometry;
  triFace: Int32Array;
  matCount: number;
}

interface ObjEntry {
  ob: BObject;
  root: Group;
  mesh: Mesh | null;
  wire: LineSegments | null;
  extras: LineSegments | null;
  extrasKey: string;
  box: LineSegments | null;
  geom: GeomCache | null;
}

const _m = new Matrix4();

// ------------------------------------------------------------------ geometry building

/** Build triangle geometry (with flat/smooth/auto-smooth normals and material groups) from an evaluated mesh. */
export function buildMeshGeometry(m: EvalMesh, autoSmooth: boolean, angle: number): { geom: BufferGeometry; triFace: Int32Array; matCount: number } {
  const fn = m.faces.map((f) => polyNormal(m.verts, f));
  const smoothAll = !!m.forceSmooth;
  // vertex -> faces
  const vf: number[][] = m.verts.map(() => []);
  m.faces.forEach((f, i) => { for (const v of f) vf[v].push(i); });
  const cosA = Math.cos(angle);
  const tris: { fi: number; c: [number, number, number] }[] = [];
  m.faces.forEach((f, fi) => { for (const t of triangulatePoly(m.verts, f)) tris.push({ fi, c: t }); });
  // sort by material for groups
  const mats = m.faceMat;
  tris.sort((a, b) => (mats[a.fi] ?? 0) - (mats[b.fi] ?? 0));
  const n = tris.length;
  const pos = new Float32Array(n * 9);
  const nor = new Float32Array(n * 9);
  const triFace = new Int32Array(n);
  const geom = new BufferGeometry();
  let groupStart = 0, curMat = n ? mats[tris[0].fi] ?? 0 : 0, matCount = 1;
  const smoothNormalCache = new Map<string, Vec3>();
  for (let t = 0; t < n; t++) {
    const { fi, c } = tris[t];
    const f = m.faces[fi];
    triFace[t] = fi;
    const mi = mats[fi] ?? 0;
    if (mi !== curMat) {
      geom.addGroup(groupStart * 3, (t - groupStart) * 3, curMat);
      groupStart = t;
      curMat = mi;
    }
    matCount = Math.max(matCount, mi + 1);
    const smooth = smoothAll || !!m.faceSmooth[fi];
    for (let k = 0; k < 3; k++) {
      const vi = f[c[k]];
      const p = m.verts[vi];
      pos.set(p, t * 9 + k * 3);
      let nn: Vec3 = fn[fi];
      if (smooth) {
        const key = autoSmooth ? `${vi}:${fi}` : `${vi}`;
        let cached = smoothNormalCache.get(key);
        if (!cached) {
          let x = 0, y = 0, z = 0;
          for (const g of vf[vi]) {
            if (!smoothAll && !m.faceSmooth[g]) continue;
            const gn = fn[g];
            if (autoSmooth && gn[0] * fn[fi][0] + gn[1] * fn[fi][1] + gn[2] * fn[fi][2] < cosA - 1e-6) continue;
            x += gn[0]; y += gn[1]; z += gn[2];
          }
          const l = Math.hypot(x, y, z) || 1;
          cached = [x / l, y / l, z / l];
          smoothNormalCache.set(key, cached);
        }
        nn = cached;
      }
      nor.set(nn, t * 9 + k * 3);
    }
  }
  if (n) geom.addGroup(groupStart * 3, (n - groupStart) * 3, curMat);
  geom.setAttribute('position', new BufferAttribute(pos, 3));
  geom.setAttribute('normal', new BufferAttribute(nor, 3));
  // generated texture coordinates (Blender "orco": bounding box mapped to -1..1)
  const b = meshBounds(m.verts);
  const orco = new Float32Array(n * 9);
  for (let i = 0; i < n * 3; i++) {
    for (let a = 0; a < 3; a++) {
      const size = b.max[a] - b.min[a];
      orco[i * 3 + a] = size > 1e-9 ? ((pos[i * 3 + a] - b.min[a]) / size) * 2 - 1 : 0;
    }
  }
  geom.setAttribute('orco', new BufferAttribute(orco, 3));
  geom.computeBoundingSphere();
  geom.computeBoundingBox();
  return { geom, triFace, matCount };
}

function buildEdgeGeometry(m: EvalMesh): BufferGeometry {
  const edges = evalEdges(m);
  const pos = new Float32Array(edges.length * 6);
  edges.forEach(([a, b], i) => { pos.set(m.verts[a], i * 6); pos.set(m.verts[b], i * 6 + 3); });
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.computeBoundingSphere();
  return g;
}

function lineGeom(points: number[]): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(points), 3));
  g.computeBoundingSphere();
  return g;
}

function circlePoints(r: number, axis: 'X' | 'Y' | 'Z', seg = 32, z = 0): number[] {
  const out: number[] = [];
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    const p = (a: number) => {
      const c = Math.cos(a) * r, s = Math.sin(a) * r;
      return axis === 'Z' ? [c, s, z] : axis === 'Y' ? [c, z, s] : [z, c, s];
    };
    out.push(...p(a0), ...p(a1));
  }
  return out;
}

/** Wireframe for cameras, lamps and empties in object space. */
function extrasFor(ob: BObject): { pts: number[]; key: string } | null {
  const doc = app.doc;
  if (ob.type === 'EMPTY') {
    const s = ob.emptyDrawSize;
    const key = `E${ob.emptyDrawType}${s}`;
    let pts: number[] = [];
    switch (ob.emptyDrawType) {
      case 'PLAIN_AXES': pts = [-s, 0, 0, s, 0, 0, 0, -s, 0, 0, s, 0, 0, 0, -s, 0, 0, s]; break;
      case 'ARROWS': {
        const a = 0.1 * s;
        pts = [0, 0, 0, s, 0, 0, 0, 0, 0, 0, s, 0, 0, 0, 0, 0, 0, s,
          // letters X, Y, Z near the tips
          s * 1.1 - a, -a, 0, s * 1.1 + a, a, 0, s * 1.1 - a, a, 0, s * 1.1 + a, -a, 0,
          -a, s * 1.1 + a, 0, 0, s * 1.1, 0, a, s * 1.1 + a, 0, 0, s * 1.1, 0, 0, s * 1.1, 0, 0, s * 1.1 - a, 0,
          -a, 0, s * 1.1 + a, a, 0, s * 1.1 + a, a, 0, s * 1.1 + a, -a, 0, s * 1.1 - a, -a, 0, s * 1.1 - a, a, 0, s * 1.1 - a];
        break;
      }
      case 'SINGLE_ARROW': {
        const a = 0.035 * s * 2;
        pts = [0, 0, 0, 0, 0, s, 0, 0, s, a, 0, s - a * 3, 0, 0, s, -a, 0, s - a * 3, 0, 0, s, 0, a, s - a * 3, 0, 0, s, 0, -a, s - a * 3];
        break;
      }
      case 'CIRCLE': pts = circlePoints(s, 'Z'); break;
      case 'CUBE': {
        const c = [[-s, -s, -s], [s, -s, -s], [s, s, -s], [-s, s, -s], [-s, -s, s], [s, -s, s], [s, s, s], [-s, s, s]];
        const e = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
        for (const [a, b] of e) pts.push(...c[a], ...c[b]);
        break;
      }
      case 'SPHERE': pts = [...circlePoints(s, 'X'), ...circlePoints(s, 'Y'), ...circlePoints(s, 'Z')]; break;
      case 'CONE': {
        const base = circlePoints(s, 'Y', 16, 0);
        pts = base;
        for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI * 2; pts.push(Math.cos(a) * s, 0, Math.sin(a) * s, 0, 2 * s, 0); }
        break;
      }
    }
    return { pts, key };
  }
  if (ob.type === 'CAMERA' && ob.data) {
    const cd = doc.cameras[ob.data];
    if (!cd) return null;
    const r = app.scene.render;
    const ax = r.resolutionX * r.pixelAspectX, ay = r.resolutionY * r.pixelAspectY;
    const asp = ax < ay ? [ax / ay, 1] : [1, ay / ax];
    let facx: number, facy: number, depth: number, sx: number, sy: number, drawsz: number;
    if (cd.lensType === 'ORTHO') {
      facx = 0.5 * cd.orthoScale * asp[0];
      facy = 0.5 * cd.orthoScale * asp[1];
      sx = cd.shiftX * cd.orthoScale; sy = cd.shiftY * cd.orthoScale;
      depth = -cd.drawSize * cd.orthoScale;
      drawsz = 0.5 * cd.orthoScale;
    } else {
      const half = 0.5 * (cd.sensorFit === 'VERTICAL' ? cd.sensorHeight : cd.sensorWidth);
      drawsz = cd.drawSize;
      depth = (drawsz * cd.lens) / -half;
      facx = drawsz * asp[0]; facy = drawsz * asp[1];
      sx = cd.shiftX * drawsz * 2; sy = cd.shiftY * drawsz * 2;
    }
    const v = [[sx + facx, sy + facy, depth], [sx + facx, sy - facy, depth], [sx - facx, sy - facy, depth], [sx - facx, sy + facy, depth]];
    const pts: number[] = [];
    for (let i = 0; i < 4; i++) pts.push(...v[i], ...v[(i + 1) % 4]);
    for (let i = 0; i < 4; i++) pts.push(0, 0, 0, ...v[i]);
    // "up" triangle
    const t0 = [sx - 0.7 * drawsz, sy + drawsz * (asp[1] + 0.1), depth];
    const t1 = [sx + 0.7 * drawsz, sy + drawsz * (asp[1] + 0.1), depth];
    const t2 = [sx, sy + 1.1 * drawsz * (asp[1] + 0.7), depth];
    pts.push(...t0, ...t1, ...t1, ...t2, ...t2, ...t0);
    if (cd.showLimits) pts.push(0, 0, -cd.clipStart, 0, 0, -cd.clipEnd);
    return { pts, key: `C${cd.lensType}${cd.lens}${cd.orthoScale}${cd.sensorWidth}${cd.sensorFit}${cd.shiftX}${cd.shiftY}${cd.drawSize}${ax}${ay}${cd.showLimits}${cd.clipStart}${cd.clipEnd}` };
  }
  if (ob.type === 'LAMP' && ob.data) {
    const la = doc.lamps[ob.data];
    if (!la) return null;
    const pts: number[] = [];
    switch (la.lampType) {
      case 'SUN': pts.push(0, 0, 0, 0, 0, -3); break;
      case 'SPOT': {
        const d = Math.min(la.distance, 60);
        const r = Math.tan(la.spotSize / 2) * d;
        const seg = 32;
        for (let i = 0; i < seg; i++) {
          const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
          if (la.useSquare) continue;
          pts.push(Math.cos(a0) * r, Math.sin(a0) * r, -d, Math.cos(a1) * r, Math.sin(a1) * r, -d);
        }
        if (la.useSquare) { const c = [[r, r], [r, -r], [-r, -r], [-r, r]]; for (let i = 0; i < 4; i++) pts.push(c[i][0], c[i][1], -d, c[(i + 1) % 4][0], c[(i + 1) % 4][1], -d); }
        for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI * 2 + Math.PI / 4; pts.push(0, 0, 0, Math.cos(a) * r, Math.sin(a) * r, -d); }
        // blend circle
        const rb = r * (1 - la.spotBlend);
        if (la.spotBlend > 0.001) for (let i = 0; i < seg; i++) { const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2; pts.push(Math.cos(a0) * rb, Math.sin(a0) * rb, -d, Math.cos(a1) * rb, Math.sin(a1) * rb, -d); }
        break;
      }
      case 'HEMI': {
        for (let k = 0; k < 3; k++) {
          const a = (k / 3) * Math.PI;
          const seg = 12;
          for (let i = 0; i < seg; i++) {
            const t0 = (i / seg) * Math.PI, t1 = ((i + 1) / seg) * Math.PI;
            const p = (t: number) => [Math.cos(t) * Math.cos(a) * 0.4, Math.cos(t) * Math.sin(a) * 0.4, -Math.sin(t) * 0.4];
            pts.push(...p(t0), ...p(t1));
          }
        }
        pts.push(0, 0, 0, 0, 0, -1.5);
        break;
      }
      case 'AREA': {
        const sx = la.areaSize / 2, sy = (la.areaShape === 'RECTANGLE' ? la.areaSizeY : la.areaSize) / 2;
        const c = [[sx, sy], [sx, -sy], [-sx, -sy], [-sx, sy]];
        for (let i = 0; i < 4; i++) pts.push(c[i][0], c[i][1], 0, c[(i + 1) % 4][0], c[(i + 1) % 4][1], 0);
        pts.push(0, 0, 0, 0, 0, -1);
        break;
      }
      default: break;
    }
    return { pts, key: `L${la.lampType}${la.spotSize}${la.spotBlend}${la.distance}${la.useSquare}${la.areaSize}${la.areaSizeY}${la.areaShape}` };
  }
  return null;
}

// ------------------------------------------------------------------ shaders

const OUTLINE_VS = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const OUTLINE_FS = `
uniform sampler2D mask; uniform vec2 texel; uniform vec3 selColor; uniform vec3 actColor; uniform float radius;
varying vec2 vUv;
void main(){
  vec4 c = texture2D(mask, vUv);
  if (c.r > 0.5) discard;
  float sel = 0.0; float act = 0.0;
  for (int x = -3; x <= 3; x++) for (int y = -3; y <= 3; y++) {
    vec2 o = vec2(float(x), float(y));
    if (dot(o, o) > radius * radius) continue;
    vec4 s = texture2D(mask, vUv + o * texel);
    sel = max(sel, s.r); act = max(act, s.g);
  }
  if (act > 0.5) gl_FragColor = vec4(actColor, 1.0);
  else if (sel > 0.5) gl_FragColor = vec4(selColor, 1.0);
  else discard;
}`;

/** Round points with a depth bias towards the camera (edit-mode vertices). */
const POINT_VS = `
attribute vec3 color; varying vec3 vColor; uniform float size; uniform float bias;
void main(){ vColor = color; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv; gl_Position.z -= bias * gl_Position.w; gl_PointSize = size; }`;
const POINT_FS = `
varying vec3 vColor;
void main(){ vec2 d = gl_PointCoord - 0.5; if (dot(d,d) > 0.25) discard; gl_FragColor = vec4(vColor, 1.0); }`;
const LINE_VS = `
attribute vec3 color; varying vec3 vColor; uniform float bias;
void main(){ vColor = color; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position.z -= bias * gl_Position.w; }`;
const LINE_FS = `varying vec3 vColor; void main(){ gl_FragColor = vec4(vColor, 1.0); }`;
const FACE_VS = `
attribute vec4 fcolor; varying vec4 vColor; uniform float bias;
void main(){ vColor = fcolor; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position.z -= bias * gl_Position.w; }`;
const FACE_FS = `varying vec4 vColor; void main(){ if (vColor.a < 0.003) discard; gl_FragColor = vColor; }`;
const SKY_VS = `varying vec3 vDir; void main(){ vDir = normalize((modelMatrix * vec4(position, 0.0)).xyz); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position.z = gl_Position.w; }`;
const SKY_FS = `
uniform vec3 horizon; uniform vec3 zenith; uniform int mode; varying vec3 vDir;
void main(){
  float t = mode == 2 ? abs(normalize(vDir).z) : (mode == 1 ? clamp(normalize(vDir).z * 0.5 + 0.5, 0.0, 1.0) : 0.0);
  vec3 c = mix(horizon, zenith, t);
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
}`;

// ------------------------------------------------------------------ renderer

export interface PickHit { ob: BObject; depth: number; point?: Vector3; faceIndex?: number }

export interface EditOverlay {
  group: Group;
  ob: BObject;
  /** triangle index -> polygon index of the cage mesh */
  cageTriFace: Int32Array;
  cageMesh: Mesh;
}

export class ViewportRenderer {
  renderer: WebGLRenderer;
  scene = new Scene();
  private objects = new Map<string, ObjEntry>();
  private gridGroup = new Group();
  private objGroup = new Group();
  private extraGroup = new Group();
  private lampLightGroup = new Group();
  private solidLights = new Group();
  private editGroup = new Group();
  private sky: Mesh;
  private ambient = new AmbientLight(0xffffff, 0);
  private maskRT: WebGLRenderTarget;
  private outlineMat: ShaderMaterial;
  private outlineScene = new Scene();
  private outlineCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private maskSelMat = new MeshBasicMaterial({ color: 0xff0000 });
  private maskActMat = new MeshBasicMaterial({ color: 0xffff00 });
  private maskDepthMat = new MeshBasicMaterial({ colorWrite: false });
  private materials = new Map<string, { solid: MeshPhongMaterial; lit: MeshPhongMaterial; basic: MeshBasicMaterial; key: string }>();
  private defaultMat = new MeshPhongMaterial({ color: new Color(0.8, 0.8, 0.8), shininess: 50, specular: new Color(0.25, 0.25, 0.25) });
  private gridKey = '';
  edit: EditOverlay | null = null;
  private editKey = '';
  private pointMat: ShaderMaterial;
  private lineMat: ShaderMaterial;
  private faceMat: ShaderMaterial;
  private wireMats = { normal: new LineBasicMaterial({ color: 0x000000 }), select: new LineBasicMaterial({ color: COL.select }), active: new LineBasicMaterial({ color: COL.active }) };
  private groundLineMat = new LineDashedMaterial({ color: 0x6a6a6a, dashSize: 0.15, gapSize: 0.1 });
  private relLineMat = new LineDashedMaterial({ color: 0x000000, dashSize: 0.1, gapSize: 0.1 });
  private extraLines = new Group();
  pixelRatio = 1;
  /** Render with a transparent background (Render > Alpha: Transparent). */
  transparentBackground = false;

  constructor(public canvas: HTMLCanvasElement, public view: ViewState, public display: ViewDisplay, opts: { alpha?: boolean } = {}) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: !!opts.alpha, preserveDrawingBuffer: true });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.autoClear = false;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    this.pixelRatio = Math.min(2, window.devicePixelRatio || 1);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.scene.add(this.gridGroup, this.objGroup, this.extraGroup, this.extraLines, this.lampLightGroup, this.editGroup, this.ambient);
    // solid-mode lights (Blender 2.79 default "solid OpenGL lights", in view space)
    const mk = (dir: number[], col: number[], inten: number) => {
      const l = new DirectionalLight(new Color(col[0], col[1], col[2]), inten * Math.PI);
      l.position.set(dir[0], dir[1], dir[2]);
      l.target.position.set(0, 0, 0);
      this.solidLights.add(l, l.target);
      return l;
    };
    mk([-0.892, 0.3, 0.9], [0.8, 0.8, 0.8], 0.75);
    mk([0.588, 0.46, 0.248], [0.498, 0.5, 0.6], 0.6);
    mk([0.216, -0.392, -0.216], [0.798, 0.838, 1.0], 0.55);
    this.solidLights.add(new AmbientLight(0xffffff, 0.2 * Math.PI));
    this.scene.add(this.solidLights);

    this.sky = new Mesh(new SphereGeometry(1, 32, 16), new ShaderMaterial({
      vertexShader: SKY_VS, fragmentShader: SKY_FS, side: BackSide, depthWrite: false, depthTest: false,
      uniforms: { horizon: { value: new Color() }, zenith: { value: new Color() }, mode: { value: 0 } },
    }));
    this.sky.renderOrder = -1000;
    this.sky.frustumCulled = false;

    this.maskRT = new WebGLRenderTarget(4, 4, { minFilter: NearestFilter, magFilter: NearestFilter });
    this.outlineMat = new ShaderMaterial({
      vertexShader: OUTLINE_VS, fragmentShader: OUTLINE_FS, transparent: true, depthTest: false, depthWrite: false,
      uniforms: { mask: { value: this.maskRT.texture }, texel: { value: [1, 1] }, selColor: { value: COL.select.clone().convertLinearToSRGB() }, actColor: { value: COL.active.clone().convertLinearToSRGB() }, radius: { value: 1.5 } },
    });
    this.outlineMat.blending = NoBlending;
    const quad = new Mesh(new PlaneGeometry(2, 2), this.outlineMat);
    quad.frustumCulled = false;
    this.outlineScene.add(quad);

    this.pointMat = new ShaderMaterial({ vertexShader: POINT_VS, fragmentShader: POINT_FS, uniforms: { size: { value: 5 }, bias: { value: 0.0006 } } });
    this.lineMat = new ShaderMaterial({ vertexShader: LINE_VS, fragmentShader: LINE_FS, uniforms: { bias: { value: 0.0004 } } });
    this.faceMat = new ShaderMaterial({ vertexShader: FACE_VS, fragmentShader: FACE_FS, transparent: true, depthWrite: false, side: DoubleSide, uniforms: { bias: { value: 0.0002 } } });
  }

  setSize(w: number, h: number): void {
    this.renderer.setSize(w, h, false);
    const pw = Math.max(1, Math.floor(w * this.pixelRatio)), ph = Math.max(1, Math.floor(h * this.pixelRatio));
    this.maskRT.setSize(pw, ph);
    this.outlineMat.uniforms.texel.value = [1 / pw, 1 / ph];
    this.outlineMat.uniforms.radius.value = 1.5 * this.pixelRatio;
    this.pointMat.uniforms.size.value = 5 * this.pixelRatio;
  }

  dispose(): void {
    this.renderer.dispose();
    this.maskRT.dispose();
  }

  /** Layers used by this view (scene layers unless the view has local layers). */
  viewLayers(): boolean[] {
    return this.display.useLocalLayers ? this.display.layers : app.scene.layers;
  }

  isVisible(ob: BObject, localView: Set<string> | null): boolean {
    if (!isObjectVisible(app.scene, ob, this.viewLayers())) return false;
    if (localView && !localView.has(ob.id)) return false;
    if (this.display.showOnlyRender && ob.hideRender) return false;
    return true;
  }

  // ---------------------------------------------------------------- materials

  private materialFor(id: string | null | undefined): { solid: MeshPhongMaterial; lit: MeshPhongMaterial; basic: MeshBasicMaterial; data: MaterialData | null } {
    const ma = id ? app.doc.materials[id] ?? null : null;
    if (!ma) return { solid: this.defaultMat, lit: this.defaultMat, basic: new MeshBasicMaterial({ color: 0xcccccc }), data: null };
    let e = this.materials.get(ma.id);
    if (!e) {
      e = { solid: new MeshPhongMaterial(), lit: new MeshPhongMaterial(), basic: new MeshBasicMaterial(), key: '' };
      this.materials.set(ma.id, e);
    }
    const key = JSON.stringify([ma, this.display.backfaceCulling, Object.values(app.doc.textures).map((t) => [t.id, t.type, t.noiseScale, t.imageData ? t.imageData.length : 0, t.intensity, t.contrast, t.turbulence, t.progression, t.woodType, t.noiseType])]);
    if (e.key !== key) {
      e.key = key;
      const side = this.display.backfaceCulling ? FrontSide : DoubleSide;
      const diff = new Color(ma.diffuseColor[0], ma.diffuseColor[1], ma.diffuseColor[2]);
      const spec = new Color(ma.specularColor[0], ma.specularColor[1], ma.specularColor[2]).multiplyScalar(ma.specularIntensity);
      e.solid.color.copy(diff);
      e.solid.specular.copy(spec).multiplyScalar(0.6);
      e.solid.shininess = Math.max(1, ma.specularHardness);
      e.solid.side = side;
      const transparent = ma.useTransparency && ma.alpha < 1;
      e.lit.color.copy(diff).multiplyScalar(ma.diffuseIntensity);
      e.lit.specular.copy(spec);
      e.lit.shininess = Math.max(1, ma.specularHardness);
      e.lit.emissive.copy(diff).multiplyScalar(ma.emit);
      e.lit.transparent = transparent;
      e.lit.opacity = ma.useTransparency ? ma.alpha : 1;
      e.lit.side = side;
      e.lit.wireframe = ma.type === 'WIRE';
      e.lit.depthWrite = !transparent;
      e.basic.color.copy(diff);
      e.basic.transparent = transparent;
      e.basic.opacity = e.lit.opacity;
      e.basic.side = side;
      e.basic.wireframe = ma.type === 'WIRE';
      // texture (Blender Internal style, generated coordinates)
      const tex = buildTextureForMaterial(ma);
      applyOrcoTexture(e.lit, tex, ma);
      applyOrcoTexture(e.basic, tex, ma);
      e.lit.needsUpdate = true;
      e.basic.needsUpdate = true;
      e.solid.needsUpdate = true;
    }
    return { ...e, data: ma };
  }

  /** Solid mode material: in "Textured" shading, textures are shown with solid lighting. */
  private texturedSolid = new Map<string, MeshPhongMaterial>();

  // ---------------------------------------------------------------- sync

  sync(localView: Set<string> | null): void {
    const doc = app.doc;
    const shading = this.display.shading;
    const seen = new Set<string>();
    const editId = app.mode === 'EDIT' ? app.editObject : null;
    for (const id of app.scene.objects) {
      const ob = doc.objects[id];
      if (!ob) continue;
      seen.add(id);
      let e = this.objects.get(id);
      if (!e) {
        e = { ob, root: new Group(), mesh: null, wire: null, extras: null, extrasKey: '', box: null, geom: null };
        e.root.matrixAutoUpdate = false;
        this.objects.set(id, e);
        this.objGroup.add(e.root);
      }
      e.ob = ob;
      const vis = this.isVisible(ob, localView);
      e.root.visible = vis;
      if (!vis) continue;
      const world = app.matrices.world(ob);
      e.root.matrix.copy(world);
      e.root.matrixWorldNeedsUpdate = true;
      const selected = ob.select;
      const active = app.scene.activeObject === ob.id;
      const wireMat = active && selected ? this.wireMats.active : selected ? this.wireMats.select : this.wireMats.normal;

      if (ob.type === 'MESH') {
        const em = app.evalMesh(ob, false);
        const md = app.meshOf(ob);
        if (em && md) {
          const smoothKey = `${md.autoSmooth}${md.autoSmoothAngle}`;
          if (!e.geom || e.geom.src !== em || e.geom.smoothKey !== smoothKey) {
            e.geom?.geom.dispose();
            e.geom?.edges.dispose();
            const b = buildMeshGeometry(em, md.autoSmooth, md.autoSmoothAngle);
            e.geom = { src: em, smoothKey, geom: b.geom, edges: buildEdgeGeometry(em), triFace: b.triFace, matCount: b.matCount };
            if (e.mesh) { e.mesh.geometry = e.geom.geom; }
            if (e.wire) { e.wire.geometry = e.geom.edges; }
            if (e.box) { e.root.remove(e.box); e.box.geometry.dispose(); e.box = null; }
          }
          if (!e.mesh) {
            e.mesh = new Mesh(e.geom.geom, this.defaultMat);
            e.mesh.castShadow = true;
            e.mesh.receiveShadow = true;
            e.mesh.userData.obId = ob.id;
            e.root.add(e.mesh);
          }
          if (!e.wire) {
            e.wire = new LineSegments(e.geom.edges, wireMat);
            e.root.add(e.wire);
          }
          // materials per slot
          const mats: Material[] = [];
          for (let i = 0; i < Math.max(1, e.geom.matCount, md.materials.length); i++) {
            const mm = this.materialFor(md.materials[i] ?? null);
            let m: Material;
            if (shading === 'MATERIAL' || shading === 'RENDERED') m = mm.data?.useShadeless ? mm.basic : mm.lit;
            else if (shading === 'TEXTURED' && mm.data && (mm.lit as MeshPhongMaterial & { userData: { hasTex?: boolean } }).userData.hasTex) {
              let t = this.texturedSolid.get(mm.data.id);
              if (!t) { t = mm.lit.clone(); this.texturedSolid.set(mm.data.id, t); }
              t.copy(mm.lit);
              t.emissive.setRGB(0, 0, 0);
              t.onBeforeCompile = mm.lit.onBeforeCompile;
              t.customProgramCacheKey = mm.lit.customProgramCacheKey;
              m = t;
            } else m = mm.solid;
            mats.push(m);
          }
          e.mesh.material = mats.length === 1 ? mats[0] : mats;
          const drawType = minDraw(ob.drawType, shading);
          const isEdit = editId === ob.id;
          e.mesh.visible = drawType === 'SOLID' || drawType === 'TEXTURED';
          e.mesh.renderOrder = ob.showXRay ? 10 : 0;
          (Array.isArray(e.mesh.material) ? e.mesh.material : [e.mesh.material]).forEach((m) => {
            m.polygonOffset = isEdit;
            m.polygonOffsetFactor = isEdit ? 1 : 0;
            m.polygonOffsetUnits = isEdit ? 1 : 0;
          });
          e.wire.visible = !isEdit && (drawType === 'WIRE' || ((ob.showWire) && drawType !== 'BOUNDS'));
          e.wire.material = drawType === 'WIRE' ? wireMat : this.wireMats.normal;
          if (drawType === 'WIRE' && shading !== 'WIREFRAME' && !selected) e.wire.material = this.wireMats.normal;
          // bounds
          const showBox = drawType === 'BOUNDS' || ob.showBounds;
          if (showBox) {
            if (!e.box) {
              const bb = e.geom.geom.boundingBox!;
              const c = [[bb.min.x, bb.min.y, bb.min.z], [bb.max.x, bb.min.y, bb.min.z], [bb.max.x, bb.max.y, bb.min.z], [bb.min.x, bb.max.y, bb.min.z], [bb.min.x, bb.min.y, bb.max.z], [bb.max.x, bb.min.y, bb.max.z], [bb.max.x, bb.max.y, bb.max.z], [bb.min.x, bb.max.y, bb.max.z]];
              const ed = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
              const pts: number[] = [];
              for (const [a, b] of ed) pts.push(...c[a], ...c[b]);
              e.box = new LineSegments(lineGeom(pts), wireMat);
              e.root.add(e.box);
            }
            e.box.material = wireMat;
            e.box.visible = true;
          } else if (e.box) e.box.visible = false;
        }
      } else {
        const ex = extrasFor(ob);
        if (ex && (!e.extras || e.extrasKey !== ex.key)) {
          if (e.extras) { e.root.remove(e.extras); e.extras.geometry.dispose(); }
          e.extras = new LineSegments(lineGeom(ex.pts), wireMat);
          e.extrasKey = ex.key;
          e.root.add(e.extras);
        }
        if (e.extras) {
          e.extras.material = wireMat;
          e.extras.visible = !this.display.showOnlyRender;
        }
      }
    }
    for (const [id, e] of this.objects) {
      if (!seen.has(id)) {
        this.objGroup.remove(e.root);
        e.geom?.geom.dispose();
        e.geom?.edges.dispose();
        this.objects.delete(id);
      }
    }
    this.syncExtraLines(localView);
    this.syncLights(localView);
    this.syncEdit();
  }

  /** Lamp ground lines and parent relationship lines. */
  private syncExtraLines(localView: Set<string> | null): void {
    for (const c of [...this.extraLines.children]) { this.extraLines.remove(c); (c as LineSegments).geometry.dispose(); }
    if (this.display.showOnlyRender) return;
    const ground: number[] = [];
    const rel: number[] = [];
    for (const ob of app.objects()) {
      if (!this.isVisible(ob, localView)) continue;
      const p = app.matrices.location(ob);
      if (ob.type === 'LAMP') ground.push(p.x, p.y, p.z, p.x, p.y, 0);
      if (ob.parent && this.display.showRelationshipLines) {
        const par = app.doc.objects[ob.parent];
        if (par) { const q = app.matrices.location(par); rel.push(p.x, p.y, p.z, q.x, q.y, q.z); }
      }
    }
    if (ground.length) {
      const l = new LineSegments(lineGeom(ground), this.groundLineMat);
      l.computeLineDistances();
      this.extraLines.add(l);
    }
    if (rel.length) {
      const l = new LineSegments(lineGeom(rel), this.relLineMat);
      l.computeLineDistances();
      this.extraLines.add(l);
    }
  }

  private lampKey = '';
  private syncLights(localView: Set<string> | null): void {
    const shading = this.display.shading;
    const lit = shading === 'MATERIAL' || shading === 'RENDERED';
    this.solidLights.visible = !lit;
    this.lampLightGroup.visible = lit;
    if (!lit) { this.ambient.intensity = 0; return; }
    const world = app.scene.world ? app.doc.worlds[app.scene.world] : null;
    const amb = world?.ambientColor ?? [0, 0, 0];
    this.ambient.color.setRGB(amb[0], amb[1], amb[2]);
    this.ambient.intensity = Math.PI;
    const lamps = app.objects().filter((o) => o.type === 'LAMP' && o.data && this.isVisible(o, localView) && !o.hideRender);
    const shadows = shading === 'RENDERED' && app.scene.render.useShadows;
    const key = JSON.stringify(lamps.map((o) => [o.id, app.doc.lamps[o.data!], app.matrices.world(o).elements])) + shadows;
    if (key === this.lampKey) return;
    this.lampKey = key;
    for (const c of [...this.lampLightGroup.children]) { this.lampLightGroup.remove(c); (c as PointLight).dispose?.(); }
    this.renderer.shadowMap.enabled = shadows;
    for (const ob of lamps) {
      const la = app.doc.lamps[ob.data!];
      const l = makeThreeLight(la, app.matrices.world(ob), shadows);
      if (l) this.lampLightGroup.add(l, ...(l as DirectionalLight).target ? [(l as DirectionalLight).target] : []);
    }
    // keep shadow maps up to date
    this.renderer.shadowMap.needsUpdate = true;
  }

  // ---------------------------------------------------------------- edit mode overlay

  private syncEdit(): void {
    const md = app.editMesh;
    const ob = app.editObj;
    if (!md || !ob) {
      if (this.edit) { this.clearEdit(); }
      return;
    }
    const ts = app.scene.toolSettings;
    const key = JSON.stringify([ob.id, md.verts.length, md.faces.length, md.edges.length, ts.meshSelectMode, this.display.useOcclude]) + versionKey(md);
    if (this.edit && key === this.editKey) {
      this.edit.group.matrix.copy(app.matrices.world(ob));
      this.edit.group.matrixWorldNeedsUpdate = true;
      return;
    }
    this.editKey = key;
    this.clearEdit();
    const group = new Group();
    group.matrixAutoUpdate = false;
    group.matrix.copy(app.matrices.world(ob));
    const mode = ts.meshSelectMode;
    const occlude = this.display.useOcclude;
    // faces
    const tris: number[] = [];
    const triFaceArr: number[] = [];
    const fcol: number[] = [];
    const ehid = hiddenEdges(md);
    md.faces.forEach((f, fi) => {
      if (md.fhide?.[fi]) return;
      const sel = md.fsel[fi];
      const isAct = fi === md.activeFace && sel;
      const col = isAct ? [1, 1, 1, 0.24] : sel ? [1, 0.52, 0, 0.24] : [0, 0, 0, 0.07];
      for (const t of triangulatePoly(md.verts, f)) {
        for (const c of t) { tris.push(...md.verts[f[c]]); fcol.push(...col); }
        triFaceArr.push(fi);
      }
    });
    const fg = new BufferGeometry();
    fg.setAttribute('position', new BufferAttribute(new Float32Array(tris), 3));
    fg.setAttribute('fcolor', new BufferAttribute(new Float32Array(fcol), 4));
    fg.computeBoundingSphere();
    this.faceMat.depthTest = occlude;
    const faceMesh = new Mesh(fg, this.faceMat);
    faceMesh.renderOrder = 20;
    group.add(faceMesh);
    // cage mesh for picking (invisible)
    const cage = new Mesh(fg, new MeshBasicMaterial({ visible: false, side: DoubleSide }));
    group.add(cage);
    // edges
    const ep: number[] = [];
    const ec: number[] = [];
    const black = [0, 0, 0], esel = [1, 0.627, 0], vsel = [1, 0.52, 0];
    md.edges.forEach(([a, b], i) => {
      if (ehid[i]) return;
      ep.push(...md.verts[a], ...md.verts[b]);
      if (mode[0]) {
        ec.push(...(md.vsel[a] ? vsel : black), ...(md.vsel[b] ? vsel : black));
      } else {
        const c = md.esel[i] ? esel : black;
        ec.push(...c, ...c);
      }
    });
    const eg = new BufferGeometry();
    eg.setAttribute('position', new BufferAttribute(new Float32Array(ep), 3));
    eg.setAttribute('color', new BufferAttribute(new Float32Array(ec), 3));
    eg.computeBoundingSphere();
    this.lineMat.depthTest = occlude;
    const lines = new LineSegments(eg, this.lineMat);
    lines.renderOrder = 21;
    group.add(lines);
    // vertices (vertex select mode) / face dots (face mode)
    if (mode[0]) {
      const vp: number[] = [], vc: number[] = [];
      md.verts.forEach((v, i) => { if (md.vhide?.[i]) return; vp.push(...v); vc.push(...(md.vsel[i] ? vsel : black)); });
      const vg = new BufferGeometry();
      vg.setAttribute('position', new BufferAttribute(new Float32Array(vp), 3));
      vg.setAttribute('color', new BufferAttribute(new Float32Array(vc), 3));
      vg.computeBoundingSphere();
      this.pointMat.depthTest = occlude;
      const pts = new Points(vg, this.pointMat);
      pts.renderOrder = 22;
      group.add(pts);
    } else if (mode[2] && this.display.showFaceDots) {
      const vp: number[] = [], vc: number[] = [];
      md.faces.forEach((f, i) => { if (md.fhide?.[i]) return; vp.push(...polyCenter(md.verts, f)); vc.push(...(md.fsel[i] ? vsel : black)); });
      const vg = new BufferGeometry();
      vg.setAttribute('position', new BufferAttribute(new Float32Array(vp), 3));
      vg.setAttribute('color', new BufferAttribute(new Float32Array(vc), 3));
      vg.computeBoundingSphere();
      const pts = new Points(vg, this.pointMat);
      pts.renderOrder = 22;
      group.add(pts);
    }
    // normals display
    if (this.display.showNormals) {
      const np: number[] = [];
      const s = this.display.normalsSize;
      md.faces.forEach((f) => { const c = polyCenter(md.verts, f), n = polyNormal(md.verts, f); np.push(...c, c[0] + n[0] * s, c[1] + n[1] * s, c[2] + n[2] * s); });
      const nl = new LineSegments(lineGeom(np), new LineBasicMaterial({ color: 0x22dddd }));
      group.add(nl);
    }
    this.editGroup.add(group);
    this.edit = { group, ob, cageTriFace: Int32Array.from(triFaceArr), cageMesh: cage };
  }

  private clearEdit(): void {
    if (!this.edit) return;
    this.edit.group.traverse((o) => { if ((o as Mesh).geometry) (o as Mesh).geometry.dispose(); });
    this.editGroup.remove(this.edit.group);
    this.edit = null;
    this.editKey = '';
  }

  /** Force the edit overlay to rebuild (selection changed). */
  invalidateEdit(): void { this.editKey = ''; }

  // ---------------------------------------------------------------- grid

  private syncGrid(): void {
    const v = this.view;
    const d = this.display;
    const axisView = v.viewName !== 'USER' && v.persp === 'ORTHO';
    let key: string;
    if (axisView) {
      const ps = v.pixelSizeAtTarget();
      key = `O${v.viewName}${ps.toFixed(6)}${v.target.toArray().map((x) => x.toFixed(3))}${v.width}x${v.height}${d.gridScale}${d.gridSubdivisions}`;
    } else key = `P${d.showFloor}${d.showAxisX}${d.showAxisY}${d.showAxisZ}${d.gridLines}${d.gridScale}`;
    if (key === this.gridKey) return;
    this.gridKey = key;
    for (const c of [...this.gridGroup.children]) { this.gridGroup.remove(c); (c as LineSegments).geometry.dispose(); }
    const minor: number[] = [], major: number[] = [], ax: number[] = [], ay: number[] = [], az: number[] = [];
    if (axisView) {
      // adaptive grid in the view plane through the origin
      const ps = v.pixelSizeAtTarget();
      const sub = Math.max(2, d.gridSubdivisions);
      let step = d.gridScale;
      while (step / ps < 12) step *= sub;
      while (step / ps > 12 * sub) step /= sub;
      const span = Math.max(v.width, v.height) * ps * 0.75 + step * 2;
      const q = v.rot;
      const right = new Vector3(1, 0, 0).applyQuaternion(q), up = new Vector3(0, 1, 0).applyQuaternion(q);
      // axes of the plane (world aligned)
      const ar = axisOf(right), au = axisOf(up);
      const c = v.target.clone();
      const cr = c.getComponent(ar), cu = c.getComponent(au);
      const r0 = Math.floor((cr - span) / step), r1 = Math.ceil((cr + span) / step);
      const u0 = Math.floor((cu - span) / step), u1 = Math.ceil((cu + span) / step);
      const pt = (rv: number, uv: number) => { const p = [0, 0, 0]; p[ar] = rv; p[au] = uv; return p; };
      for (let i = r0; i <= r1; i++) {
        const x = i * step;
        const list = Math.abs(x) < step * 1e-3 ? (ar === 0 ? ay : ar === 1 ? ax : ax) : (i % sub === 0 ? major : minor);
        const target = Math.abs(x) < step * 1e-3 ? (au === 2 ? az : au === 1 ? ay : ax) : list;
        target.push(...pt(x, u0 * step), ...pt(x, u1 * step));
      }
      for (let j = u0; j <= u1; j++) {
        const y = j * step;
        const target = Math.abs(y) < step * 1e-3 ? (ar === 0 ? ax : ar === 1 ? ay : az) : (j % sub === 0 ? major : minor);
        target.push(...pt(r0 * step, y), ...pt(r1 * step, y));
      }
    } else if (d.showFloor) {
      const n = Math.max(1, Math.floor(d.gridLines / 2));
      const s = d.gridScale;
      for (let i = -n; i <= n; i++) {
        const x = i * s;
        if (i === 0) {
          (d.showAxisY ? ay : minor).push(0, -n * s, 0, 0, n * s, 0);
          (d.showAxisX ? ax : minor).push(-n * s, 0, 0, n * s, 0, 0);
        } else {
          minor.push(x, -n * s, 0, x, n * s, 0);
          minor.push(-n * s, x, 0, n * s, x, 0);
        }
      }
      if (d.showAxisZ) az.push(0, 0, -n * s, 0, 0, n * s);
    } else {
      const n = 1000;
      if (d.showAxisX) ax.push(-n, 0, 0, n, 0, 0);
      if (d.showAxisY) ay.push(0, -n, 0, 0, n, 0);
      if (d.showAxisZ) az.push(0, 0, -n, 0, 0, n);
    }
    const add = (pts: number[], color: Color) => {
      if (!pts.length) return;
      const l = new LineSegments(lineGeom(pts), new LineBasicMaterial({ color, depthWrite: false }));
      l.renderOrder = -10;
      this.gridGroup.add(l);
    };
    add(minor, COL.grid);
    add(major, COL.gridMajor);
    add(ax, COL.axisX);
    add(ay, COL.axisY);
    add(az, COL.axisZ);
  }

  // ---------------------------------------------------------------- render

  render(localView: Set<string> | null): void {
    const v = this.view;
    const cam = v.camera();
    const r = this.renderer;
    const shading = this.display.shading;
    const world = app.scene.world ? app.doc.worlds[app.scene.world] : null;
    const showWorld = (shading === 'RENDERED' || this.display.showWorld) && world && !this.transparentBackground;
    this.syncGrid();
    this.gridGroup.visible = !this.display.showOnlyRender;
    // solid lights follow the camera
    this.solidLights.position.copy(cam.position);
    this.solidLights.quaternion.copy(cam.quaternion);
    this.solidLights.updateMatrixWorld(true);
    // world background / mist
    if (showWorld && world) {
      const sm = this.sky.material as ShaderMaterial;
      sm.uniforms.horizon.value.setRGB(world.horizonColor[0], world.horizonColor[1], world.horizonColor[2]);
      sm.uniforms.zenith.value.setRGB(world.zenithColor[0], world.zenithColor[1], world.zenithColor[2]);
      sm.uniforms.mode.value = world.useBlendSky ? (world.useRealSky ? 2 : 1) : 0;
      this.scene.background = null;
      if (!this.sky.parent) this.scene.add(this.sky);
      this.sky.position.copy(cam.position);
      this.sky.scale.setScalar(Math.max(1, (cam as OrthographicCamera).far ? 10 : 10));
      this.scene.fog = world.useMist && shading === 'RENDERED' ? new Fog(new Color(world.horizonColor[0], world.horizonColor[1], world.horizonColor[2]), world.mistStart, world.mistStart + world.mistDepth) : null;
    } else {
      if (this.sky.parent) this.scene.remove(this.sky);
      this.scene.background = this.transparentBackground ? null : COL.bg;
      this.scene.fog = null;
    }
    // extras hidden in "only render"
    for (const e of this.objects.values()) {
      if (e.extras) e.extras.visible = !this.display.showOnlyRender;
    }
    r.setRenderTarget(null);
    r.setClearColor(COL.bg, this.transparentBackground ? 0 : 1);
    r.clear(true, true, true);
    r.render(this.scene, cam);

    // selection outline (solid shading only; not for the object in edit mode)
    if (this.display.showOutlineSelected && (shading === 'SOLID' || shading === 'TEXTURED' || shading === 'MATERIAL') && !this.display.showOnlyRender) {
      this.renderOutline(cam);
    }
  }

  private renderOutline(cam: Camera): void {
    const meshes: { mesh: Mesh; mat: Material | Material[]; sel: boolean; act: boolean }[] = [];
    let any = false;
    const editId = app.mode === 'EDIT' || app.mode === 'SCULPT' ? app.editObject : null;
    for (const e of this.objects.values()) {
      if (!e.mesh || !e.root.visible || !e.mesh.visible) continue;
      const sel = e.ob.select && e.ob.id !== editId;
      const act = sel && app.scene.activeObject === e.ob.id;
      if (sel) any = true;
      meshes.push({ mesh: e.mesh, mat: e.mesh.material, sel, act });
    }
    if (!any) return;
    const r = this.renderer;
    const hidden: Object3D[] = [];
    for (const g of [this.gridGroup, this.extraGroup, this.extraLines, this.editGroup]) { if (g.visible) { g.visible = false; hidden.push(g); } }
    for (const e of this.objects.values()) {
      for (const c of [e.wire, e.extras, e.box]) if (c && c.visible) { c.visible = false; hidden.push(c); }
    }
    const bg = this.scene.background;
    const skyParent = this.sky.parent;
    if (skyParent) this.scene.remove(this.sky);
    this.scene.background = null;
    const fog = this.scene.fog;
    this.scene.fog = null;
    for (const m of meshes) m.mesh.material = m.act ? this.maskActMat : m.sel ? this.maskSelMat : this.maskDepthMat;
    r.setRenderTarget(this.maskRT);
    r.setClearColor(0x000000, 0);
    r.clear(true, true, true);
    r.render(this.scene, cam);
    r.setRenderTarget(null);
    for (const m of meshes) m.mesh.material = m.mat;
    for (const o of hidden) o.visible = true;
    this.scene.background = bg;
    if (skyParent) this.scene.add(this.sky);
    this.scene.fog = fog;
    r.render(this.outlineScene, this.outlineCam);
  }

  // ---------------------------------------------------------------- picking

  private raycaster = new Raycaster();

  /** Mesh objects hit by a ray through pixel (x, y), nearest first. */
  pickMeshes(x: number, y: number): PickHit[] {
    const cam = this.view.camera();
    this.raycaster.setFromCamera(this.view.ndc(x, y), cam);
    this.raycaster.params.Line = { threshold: 0 };
    const targets: Mesh[] = [];
    for (const e of this.objects.values()) {
      if (!e.root.visible || !e.mesh || e.ob.hideSelect) continue;
      e.root.updateMatrixWorld(true);
      // include objects drawn as wire/bounds as pick targets as well (they still have geometry)
      targets.push(e.mesh);
    }
    const out: PickHit[] = [];
    const hits: Intersection[] = [];
    for (const t of targets) {
      const vis = t.visible;
      t.visible = true;
      const side = (Array.isArray(t.material) ? t.material : [t.material]).map((m) => m.side);
      (Array.isArray(t.material) ? t.material : [t.material]).forEach((m) => { m.side = DoubleSide; });
      this.raycaster.intersectObject(t, false, hits);
      (Array.isArray(t.material) ? t.material : [t.material]).forEach((m, i) => { m.side = side[i]; });
      t.visible = vis;
    }
    hits.sort((a, b) => a.distance - b.distance);
    const seen = new Set<string>();
    for (const h of hits) {
      const id = h.object.userData.obId as string;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ ob: app.doc.objects[id], depth: h.distance, point: h.point.clone() });
    }
    return out;
  }

  /** Ray-cast against the edit cage. Returns polygon index and hit distance. */
  pickEditFace(x: number, y: number): { face: number; distance: number; point: Vector3 } | null {
    if (!this.edit) return null;
    const cam = this.view.camera();
    this.raycaster.setFromCamera(this.view.ndc(x, y), cam);
    this.edit.group.updateMatrixWorld(true);
    const cage = this.edit.cageMesh;
    const hits = this.raycaster.intersectObject(cage, false);
    if (!hits.length || hits[0].faceIndex === undefined || hits[0].faceIndex === null) return null;
    return { face: this.edit.cageTriFace[hits[0].faceIndex], distance: hits[0].distance, point: hits[0].point.clone() };
  }

  /** Is a world point visible (not occluded by the edit cage)? */
  editPointVisible(p: Vector3): boolean {
    if (!this.display.useOcclude || !this.edit) return true;
    const cam = this.view.camera();
    const camPos = new Vector3().setFromMatrixPosition(cam.matrixWorld);
    let origin: Vector3, dir: Vector3, dist: number;
    if (this.view.isOrtho) {
      dir = this.view.viewDir();
      origin = p.clone().sub(dir.clone().multiplyScalar(1e4));
      dist = 1e4;
    } else {
      origin = camPos;
      dir = p.clone().sub(camPos);
      dist = dir.length();
      dir.normalize();
    }
    this.raycaster.set(origin, dir);
    this.raycaster.far = dist;
    this.edit.group.updateMatrixWorld(true);
    const hits = this.raycaster.intersectObject(this.edit.cageMesh, false);
    this.raycaster.far = Infinity;
    if (!hits.length) return true;
    return hits[0].distance >= dist - Math.max(1e-4, dist * 2e-4);
  }

  /** Line segments of extras (cameras/lamps/empties) in world space, for click selection. */
  extraSegments(ob: BObject): Vector3[] {
    const e = this.objects.get(ob.id);
    if (!e || !e.extras || !e.root.visible) return [];
    const pos = e.extras.geometry.getAttribute('position');
    const out: Vector3[] = [];
    for (let i = 0; i < pos.count; i++) out.push(new Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(e.root.matrix));
    return out;
  }

  /** World-space vertices of an object's evaluated mesh (for border select). */
  worldVerts(ob: BObject): Vector3[] {
    const em = app.evalMesh(ob);
    if (!em) return [];
    const m = app.matrices.world(ob);
    return em.verts.map((v) => new Vector3(v[0], v[1], v[2]).applyMatrix4(m));
  }

  objectVisible(id: string): boolean {
    return !!this.objects.get(id)?.root.visible;
  }

  /** Render the scene from the given camera into an offscreen canvas (OpenGL render). */
  snapshot(): string {
    return this.canvas.toDataURL('image/png');
  }
}

function axisOf(v: Vector3): number {
  const a = [Math.abs(v.x), Math.abs(v.y), Math.abs(v.z)];
  return a.indexOf(Math.max(...a));
}

function minDraw(drawType: BObject['drawType'], shading: Shading): 'BOUNDS' | 'WIRE' | 'SOLID' | 'TEXTURED' {
  const order = ['BOUNDS', 'WIRE', 'SOLID', 'TEXTURED'] as const;
  const shadeMax = shading === 'BOUNDBOX' ? 0 : shading === 'WIREFRAME' ? 1 : shading === 'SOLID' ? 2 : 3;
  return order[Math.min(order.indexOf(drawType), shadeMax)];
}

let versionCounter = 0;
const versions = new WeakMap<MeshData, { hash: string; v: number }>();
function versionKey(md: MeshData): string {
  // cheap change detection for the edit overlay: positions + selection
  let h = 0;
  const step = Math.max(1, Math.floor(md.verts.length / 4000));
  for (let i = 0; i < md.verts.length; i += step) {
    const v = md.verts[i];
    h = (h * 31 + Math.round(v[0] * 1e4) * 7 + Math.round(v[1] * 1e4) * 13 + Math.round(v[2] * 1e4) * 17) | 0;
  }
  for (let i = 0; i < md.vsel.length; i++) if (md.vsel[i]) h = (h * 31 + i) | 0;
  for (let i = 0; i < md.esel.length; i++) if (md.esel[i]) h = (h * 37 + i) | 0;
  for (let i = 0; i < md.fsel.length; i++) if (md.fsel[i]) h = (h * 41 + i) | 0;
  h = (h * 43 + md.activeFace) | 0;
  if (md.vhide) for (let i = 0; i < md.vhide.length; i++) if (md.vhide[i]) h = (h * 53 + i) | 0;
  if (md.fhide) for (let i = 0; i < md.fhide.length; i++) if (md.fhide[i]) h = (h * 59 + i) | 0;
  // faces hash (topology)
  for (let i = 0; i < md.faces.length; i += Math.max(1, Math.floor(md.faces.length / 2000))) h = (h * 47 + md.faces[i].length + md.faces[i][0]) | 0;
  const prev = versions.get(md);
  const hash = String(h);
  if (!prev || prev.hash !== hash) versions.set(md, { hash, v: ++versionCounter });
  return `#${versions.get(md)!.v}`;
}

/** Create a three.js light that approximates a Blender Internal lamp. */
export function makeThreeLight(la: LampData, world: Matrix4, shadows: boolean): PointLight | DirectionalLight | SpotLight | HemisphereLight | null {
  const pos = new Vector3().setFromMatrixPosition(world);
  const dir = new Vector3(0, 0, -1).transformDirection(world);
  const col = new Color(la.color[0], la.color[1], la.color[2]);
  const energy = (la.useNegative ? -1 : 1) * la.energy * Math.PI;
  const decay = la.falloff === 'CONSTANT' ? 0 : la.falloff === 'INVERSE_LINEAR' ? 1 : 0;
  const castShadow = shadows && la.shadow === 'RAY_SHADOW';
  switch (la.lampType) {
    case 'SUN': {
      const l = new DirectionalLight(col, energy);
      l.position.copy(pos);
      l.target.position.copy(pos.clone().add(dir));
      if (castShadow) setupDirShadow(l, pos);
      return l;
    }
    case 'SPOT': {
      const l = new SpotLight(col, energy, la.distance * 2, Math.min(Math.PI / 2 - 0.01, la.spotSize / 2), Math.min(1, la.spotBlend), decay);
      l.position.copy(pos);
      l.target.position.copy(pos.clone().add(dir));
      l.castShadow = castShadow;
      if (castShadow) { l.shadow.mapSize.set(1024, 1024); l.shadow.bias = -0.0005; l.shadow.radius = 3; }
      return l;
    }
    case 'HEMI': {
      const l = new HemisphereLight(col, new Color(0, 0, 0), la.energy * Math.PI * 0.5);
      l.position.copy(dir.clone().negate());
      return l;
    }
    default: {
      const l = new PointLight(col, energy, la.distance * 2, decay);
      l.position.copy(pos);
      l.castShadow = castShadow;
      if (castShadow) { l.shadow.mapSize.set(1024, 1024); l.shadow.bias = -0.002; l.shadow.radius = 3; l.shadow.camera.near = 0.05; l.shadow.camera.far = Math.max(50, la.distance * 2); }
      return l;
    }
  }
}

function setupDirShadow(l: DirectionalLight, _pos: Vector3): void {
  l.castShadow = true;
  l.shadow.mapSize.set(2048, 2048);
  const cam = l.shadow.camera;
  cam.left = -20; cam.right = 20; cam.top = 20; cam.bottom = -20; cam.near = 0.1; cam.far = 200;
  l.shadow.bias = -0.0005;
  l.shadow.radius = 2;
}

// edge key re-export for select module convenience
export { edgeKey };
