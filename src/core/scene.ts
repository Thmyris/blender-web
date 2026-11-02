// Document creation, defaults that mirror Blender 2.79b's factory startup file,
// datablock naming and object matrix evaluation.

import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import type {
  BObject, CameraData, Doc, LampData, MaterialData, MeshData, ObjectType, RenderSettings, RotationMode,
  Scene, TextBlock, TextureData, TextureSlot, ToolSettings, Vec3, WorldData, DataCollection, LampType,
} from './types';
import { createMeshData, primCube, selectAllMesh } from './mesh';
import { primitiveUVs, setInitialUVs } from './uvdata';

export const BLENDER_VERSION = '2.79';
export const BLENDER_VERSION_FULL = '2.79b';
export const NUM_LAYERS = 20;

const deg = (d: number) => (d * Math.PI) / 180;

// ------------------------------------------------------------------ ids & names

export function newId(doc: Doc, prefix: string): string {
  doc.idCounter = (doc.idCounter || 0) + 1;
  return `${prefix}${doc.idCounter.toString(36)}`;
}

/** Blender-style unique naming: "Cube", "Cube.001", "Cube.002" ... */
export function uniqueName(existing: Iterable<string>, base: string, ignoreId?: string, items?: { id: string; name: string }[]): string {
  const names = new Set<string>();
  if (items) for (const it of items) { if (it.id !== ignoreId) names.add(it.name); }
  else for (const n of existing) names.add(n);
  if (!names.has(base)) return base;
  const m = /^(.*)\.(\d{3,})$/.exec(base);
  const stem = m ? m[1] : base;
  for (let i = 1; i < 100000; i++) {
    const cand = `${stem}.${String(i).padStart(3, '0')}`;
    if (!names.has(cand)) return cand;
  }
  return `${stem}.${Date.now()}`;
}

export function uniqueNameIn(doc: Doc, coll: DataCollection, base: string, ignoreId?: string): string {
  const items = Object.values(doc[coll] as Record<string, { id: string; name: string }>);
  return uniqueName([], base, ignoreId, items);
}

export function renameData(doc: Doc, coll: DataCollection, id: string, name: string): string {
  const item = (doc[coll] as Record<string, { id: string; name: string }>)[id];
  if (!item) return name;
  const trimmed = name.trim() || item.name;
  item.name = uniqueNameIn(doc, coll, trimmed, id);
  return item.name;
}

// ------------------------------------------------------------------ defaults

export function defaultToolSettings(): ToolSettings {
  return {
    meshSelectMode: [true, false, false], pivotPoint: 'MEDIAN_POINT', usePivotPointAlign: false,
    transformOrientation: 'GLOBAL', useSnap: false, snapElement: 'INCREMENT', proportionalEdit: 'DISABLED',
    proportionalFalloff: 'SMOOTH', proportionalSize: 1, useKeyframeInsertAuto: false, useMeshAutomerge: false,
    doubleThreshold: 0.0001,
  };
}

export function defaultRenderSettings(): RenderSettings {
  return {
    engine: 'BLENDER_RENDER', resolutionX: 1920, resolutionY: 1080, resolutionPercentage: 50,
    pixelAspectX: 1, pixelAspectY: 1, useBorder: false, useCropToBorder: false, useAntialiasing: true,
    antialiasingSamples: '8', filterSize: 1.5, useShadows: true, useRaytrace: true, useTextures: true, useSSS: true,
    useEnvMaps: true, alphaMode: 'SKY', filepath: '/tmp/', fileFormat: 'PNG', colorMode: 'RGBA', colorDepth: '8',
    compression: 15, quality: 90, useOverwrite: true, usePlaceholder: false, useFileExtension: true, display: 'AREA',
    useStamp: false, useFreestyle: false, useMotionBlur: false, threadsMode: 'AUTO', tileX: 64, tileY: 64,
    useLockInterface: false, useCompositing: true, useSequencer: true, ditherIntensity: 1, edgeEnable: false,
  };
}

export function emptyLayers(active = 0): boolean[] {
  const l = new Array(NUM_LAYERS).fill(false);
  l[active] = true;
  return l;
}

export function createScene(doc: Doc, name = 'Scene'): Scene {
  return {
    id: newId(doc, 'SC'), name: uniqueName(doc.scenes.map((s) => s.name), name), objects: [], world: null, camera: null,
    activeObject: null, cursor: [0, 0, 0], layers: emptyLayers(0), frameCurrent: 1, frameStart: 1, frameEnd: 250,
    frameStep: 1, fps: 24, fpsBase: 1, usePreviewRange: false, previewStart: 1, previewEnd: 250,
    render: defaultRenderSettings(), unit: { system: 'NONE', systemRotation: 'DEGREES', scaleLength: 1, useSeparate: false },
    useGravity: true, gravity: [0, 0, -9.81], toolSettings: defaultToolSettings(), markers: [], syncMode: 'NONE',
    keyingSet: '', fakeUser: false,
  };
}

export function createObject(doc: Doc, type: ObjectType, name: string, data: string | null): BObject {
  const ob: BObject = {
    id: newId(doc, 'OB'), name: uniqueNameIn(doc, 'objects', name), type, data,
    location: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], rotationMode: 'XYZ',
    deltaLocation: [0, 0, 0], deltaRotation: [0, 0, 0], deltaScale: [1, 1, 1],
    lockLocation: [false, false, false], lockRotation: [false, false, false], lockScale: [false, false, false],
    parent: null, parentInverse: new Matrix4().toArray(), layers: emptyLayers(0), hide: false, hideSelect: false,
    hideRender: false, select: false, modifiers: [], constraints: [], drawType: 'TEXTURED', showName: false,
    showAxis: false, showWire: false, showBounds: false, showXRay: false, showTransparent: false, color: [1, 1, 1, 1],
    emptyDrawType: 'PLAIN_AXES', emptyDrawSize: 1, fcurves: [], passIndex: 0, activeMaterialIndex: 0, particleSystems: [],
  };
  doc.objects[ob.id] = ob;
  return ob;
}

export function createMesh(doc: Doc, name: string, verts: Vec3[] = [], faces: number[][] = [], edges: [number, number][] = []): MeshData {
  const m = createMeshData(newId(doc, 'ME'), uniqueNameIn(doc, 'meshes', name), verts, faces, edges);
  doc.meshes[m.id] = m;
  return m;
}

export function createCamera(doc: Doc, name = 'Camera'): CameraData {
  const c: CameraData = {
    id: newId(doc, 'CA'), name: uniqueNameIn(doc, 'cameras', name), lensType: 'PERSP', lens: 35, lensUnit: 'MILLIMETERS',
    orthoScale: 7.314, sensorWidth: 32, sensorHeight: 18, sensorFit: 'AUTO', clipStart: 0.1, clipEnd: 100, shiftX: 0,
    shiftY: 0, drawSize: 0.5, showLimits: false, showName: false, showPassepartout: true, passepartoutAlpha: 0.5,
    showSensor: false, dofDistance: 0, fakeUser: false,
  };
  doc.cameras[c.id] = c;
  return c;
}

export function createLamp(doc: Doc, type: LampType = 'POINT', name?: string): LampData {
  const names: Record<LampType, string> = { POINT: 'Point', SUN: 'Sun', SPOT: 'Spot', HEMI: 'Hemi', AREA: 'Area' };
  const l: LampData = {
    id: newId(doc, 'LA'), name: uniqueNameIn(doc, 'lamps', name ?? names[type]), lampType: type, color: [1, 1, 1],
    energy: 1, distance: 25, falloff: 'INVERSE_SQUARE', useNegative: false, useOwnLayer: false, useSpecular: true,
    useDiffuse: true, useSphere: false, shadow: type === 'HEMI' ? 'NOSHADOW' : 'RAY_SHADOW', shadowColor: [0, 0, 0],
    shadowSoftSize: type === 'SUN' ? 0.2 : 0.25, shadowSamples: 1, spotSize: deg(45), spotBlend: 0.15, showCone: false,
    useSquare: false, useHalo: false, areaShape: 'SQUARE', areaSize: 0.1, areaSizeY: 0.1, fakeUser: false,
  };
  doc.lamps[l.id] = l;
  return l;
}

export function defaultTextureSlot(texture: string | null): TextureSlot {
  return {
    texture, use: true, textureCoords: 'GENERATED', mapping: 'FLAT', offset: [0, 0, 0], scale: [1, 1, 1],
    useMapColorDiffuse: true, diffuseColorFactor: 1, useMapAlpha: false, alphaFactor: 1, blendType: 'MIX',
    useRgbToIntensity: false, color: [1, 0, 1],
  };
}

export function createMaterial(doc: Doc, name = 'Material'): MaterialData {
  const m: MaterialData = {
    id: newId(doc, 'MA'), name: uniqueNameIn(doc, 'materials', name), type: 'SURFACE', diffuseColor: [0.8, 0.8, 0.8],
    diffuseIntensity: 0.8, diffuseShader: 'LAMBERT', specularColor: [1, 1, 1], specularIntensity: 0.5,
    specularShader: 'COOKTORR', specularHardness: 50, emit: 0, ambient: 1, translucency: 0, useShadeless: false,
    useTransparency: false, transparencyMethod: 'Z_TRANSPARENCY', alpha: 1, specularAlpha: 1, rayMirror: 0,
    useMirror: false, receiveShadows: true, castShadows: true, previewType: 'SPHERE',
    textureSlots: new Array(18).fill(null), activeTextureIndex: 0, fakeUser: false,
  };
  doc.materials[m.id] = m;
  return m;
}

export function createTexture(doc: Doc, name = 'Texture'): TextureData {
  const t: TextureData = {
    id: newId(doc, 'TE'), name: uniqueNameIn(doc, 'textures', name), type: 'CLOUDS', imageData: null, imageName: '',
    noiseScale: 0.25, noiseDepth: 2, noiseBasis: 'BLENDER_ORIGINAL', noiseType: 'SOFT_NOISE', progression: 'LINEAR',
    turbulence: 5, woodType: 'BANDS', intensity: 1, contrast: 1, saturation: 1, colorTint: [1, 1, 1], extension: 'REPEAT',
    repeatX: 1, repeatY: 1, fakeUser: false,
  };
  doc.textures[t.id] = t;
  return t;
}

export function createWorld(doc: Doc, name = 'World'): WorldData {
  const w: WorldData = {
    id: newId(doc, 'WO'), name: uniqueNameIn(doc, 'worlds', name), horizonColor: [0.050876, 0.050876, 0.050876],
    zenithColor: [0.01, 0.01, 0.01], ambientColor: [0, 0, 0], usePaperSky: false, useBlendSky: false, useRealSky: false,
    exposure: 0, colorRange: 1, useAO: false, aoFactor: 1, useEnvLight: false, envEnergy: 1, useMist: false,
    mistStart: 5, mistDepth: 25, mistIntensity: 0, useStars: false, fakeUser: false,
  };
  doc.worlds[w.id] = w;
  return w;
}

export function createText(doc: Doc, name = 'Text', body = ''): TextBlock {
  const t: TextBlock = { id: newId(doc, 'TX'), name: uniqueNameIn(doc, 'texts', name), body, fakeUser: false };
  doc.texts[t.id] = t;
  return t;
}

export function emptyDoc(): Doc {
  return {
    version: 1, filename: '', scenes: [], activeScene: '', objects: {}, meshes: {}, cameras: {}, lamps: {},
    materials: {}, textures: {}, worlds: {}, texts: {}, armatures: {}, lattices: {}, curves: {}, metaballs: {}, fonts: {}, idCounter: 0,
  };
}

/** The Blender 2.79b factory startup scene: a cube with a material, a camera and a point lamp. */
export function createStartupDoc(): Doc {
  const doc = emptyDoc();
  const scene = createScene(doc, 'Scene');
  doc.scenes.push(scene);
  doc.activeScene = scene.id;
  const world = createWorld(doc, 'World');
  scene.world = world.id;

  const mat = createMaterial(doc, 'Material');
  const cubeGeom = primCube(1);
  const mesh = createMesh(doc, 'Cube', cubeGeom.verts, cubeGeom.faces);
  setInitialUVs(mesh, primitiveUVs('Cube', cubeGeom.verts, cubeGeom.faces));
  mesh.materials = [mat.id];
  selectAllMesh(mesh, true);
  const cube = createObject(doc, 'MESH', 'Cube', mesh.id);
  cube.select = true;

  const lampData = createLamp(doc, 'POINT', 'Lamp');
  lampData.distance = 30;
  const lamp = createObject(doc, 'LAMP', 'Lamp', lampData.id);
  lamp.location = [4.076245, 1.005454, 5.903862];
  lamp.rotation = [0.650328, 0.055217, 1.866391];

  const camData = createCamera(doc, 'Camera');
  const cam = createObject(doc, 'CAMERA', 'Camera', camData.id);
  cam.location = [7.358891, -6.925791, 4.958309];
  cam.rotation = [1.109319, 0, 0.814928];

  scene.objects.push(cam.id, cube.id, lamp.id);
  scene.camera = cam.id;
  scene.activeObject = cube.id;
  return doc;
}

// ------------------------------------------------------------------ queries

export function activeScene(doc: Doc): Scene {
  return doc.scenes.find((s) => s.id === doc.activeScene) ?? doc.scenes[0];
}

export function sceneObjects(doc: Doc, scene: Scene): BObject[] {
  return scene.objects.map((id) => doc.objects[id]).filter(Boolean);
}

/** Objects that are on a visible layer and not hidden. */
export function isObjectVisible(scene: Scene, ob: BObject, layers: boolean[] = scene.layers): boolean {
  if (ob.hide) return false;
  return ob.layers.some((l, i) => l && layers[i]);
}

export function isObjectSelectable(scene: Scene, ob: BObject, layers?: boolean[]): boolean {
  return isObjectVisible(scene, ob, layers) && !ob.hideSelect;
}

export function dataCollectionFor(type: ObjectType): DataCollection | null {
  switch (type) {
    case 'MESH': return 'meshes';
    case 'CAMERA': return 'cameras';
    case 'LAMP': return 'lamps';
    case 'ARMATURE': return 'armatures';
    case 'LATTICE': return 'lattices';
    case 'CURVE': case 'SURFACE': return 'curves';
    case 'META': return 'metaballs';
    default: return null;
  }
}

/** Number of objects (in any scene) using a datablock, plus fake user. */
export function dataUsers(doc: Doc, coll: DataCollection, id: string): number {
  let n = 0;
  if (coll === 'materials') {
    for (const m of Object.values(doc.meshes)) n += m.materials.filter((x) => x === id).length;
    // curves, surfaces, metaballs and text objects
    for (const c of [...Object.values(doc.curves ?? {}), ...Object.values(doc.metaballs ?? {})]) n += c.materials.filter((x) => x === id).length;
    for (const ob of Object.values(doc.objects)) if (ob.text?.materials) n += ob.text.materials.filter((x) => x === id).length;
  } else if (coll === 'fonts') {
    for (const ob of Object.values(doc.objects)) { const t = ob.text; if (t && [t.font, t.fontBold, t.fontItalic, t.fontBoldItalic].includes(id)) n++; }
  } else if (coll === 'worlds') {
    for (const s of doc.scenes) if (s.world === id) n++;
  } else if (coll === 'textures') {
    for (const m of Object.values(doc.materials)) n += m.textureSlots.filter((s) => s && s.texture === id).length;
  } else if (coll === 'objects') {
    for (const s of doc.scenes) if (s.objects.includes(id)) n++;
  } else {
    for (const ob of Object.values(doc.objects)) if (ob.data === id) n++;
  }
  const item = (doc[coll] as Record<string, { fakeUser?: boolean }>)[id];
  if (item?.fakeUser) n++;
  return n;
}

/** Remove datablocks that have no users (Blender does this on save/reload). */
export function purgeOrphans(doc: Doc): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const coll of ['objects', 'meshes', 'cameras', 'lamps', 'materials', 'textures', 'worlds', 'armatures', 'lattices', 'curves', 'metaballs', 'fonts'] as DataCollection[]) {
      const map = (doc[coll] ?? {}) as Record<string, unknown>;
      for (const id of Object.keys(map)) {
        if (dataUsers(doc, coll, id) === 0) { delete map[id]; changed = true; }
      }
    }
  }
}

// ------------------------------------------------------------------ matrices

/** Blender euler order "XYZ" means X is applied first: R = Rz * Ry * Rx, which is three.js order "ZYX". */
export function threeEulerOrder(mode: RotationMode): 'XYZ' | 'XZY' | 'YXZ' | 'YZX' | 'ZXY' | 'ZYX' {
  return mode.split('').reverse().join('') as 'XYZ';
}

const _q = new Quaternion();
const _e = new Euler();
const _v = new Vector3();
const _s = new Vector3();

/** Local (basis) matrix from location / rotation / scale including delta transforms. */
export function basisMatrix(ob: BObject, out = new Matrix4()): Matrix4 {
  _e.set(ob.rotation[0] + ob.deltaRotation[0], ob.rotation[1] + ob.deltaRotation[1], ob.rotation[2] + ob.deltaRotation[2], threeEulerOrder(ob.rotationMode));
  _q.setFromEuler(_e);
  _v.set(ob.location[0] + ob.deltaLocation[0], ob.location[1] + ob.deltaLocation[1], ob.location[2] + ob.deltaLocation[2]);
  _s.set(ob.scale[0] * ob.deltaScale[0], ob.scale[1] * ob.deltaScale[1], ob.scale[2] * ob.deltaScale[2]);
  return out.compose(_v, _q, _s);
}

/** Decompose a basis matrix back into the object's loc/rot/scale (deltas are subtracted). */
export function setBasisFromMatrix(ob: BObject, m: Matrix4): void {
  const pos = new Vector3(), quat = new Quaternion(), scl = new Vector3();
  m.decompose(pos, quat, scl);
  const e = new Euler().setFromQuaternion(quat, threeEulerOrder(ob.rotationMode));
  ob.location = [pos.x - ob.deltaLocation[0], pos.y - ob.deltaLocation[1], pos.z - ob.deltaLocation[2]];
  ob.rotation = [e.x - ob.deltaRotation[0], e.y - ob.deltaRotation[1], e.z - ob.deltaRotation[2]];
  ob.scale = [
    scl.x / (ob.deltaScale[0] || 1), scl.y / (ob.deltaScale[1] || 1), scl.z / (ob.deltaScale[2] || 1),
  ];
}

/**
 * Resolver of bone parents (installed by armature.ts): world matrix of the tail of `bone` of the
 * armature object `parent`, for objects parented with Ctrl+P > Bone.
 */
export const parentResolvers: { bone?: (doc: Doc, parent: BObject, bone: string, worldOf: (o: BObject) => Matrix4) => Matrix4 | null } = {};

/** World matrix including parenting and constraints. Results are cached per evaluation pass. */
/**
 * Hooks that replace an object's evaluated world matrix (the rigid body simulation, src/sim).
 * Return null to keep the regular result. Caches with `noOverrides` skip them.
 */
export const worldMatrixOverrides: ((ob: BObject, doc: Doc) => Matrix4 | null)[] = [];

export class MatrixCache {
  private cache = new Map<string, Matrix4>();
  private evaluating = new Set<string>();
  /** Ignore `worldMatrixOverrides` (used by simulations to read the unsimulated transforms). */
  noOverrides = false;
  constructor(private doc: Doc) {}

  clear(): void { this.cache.clear(); }

  world(ob: BObject): Matrix4 {
    const hit = this.cache.get(ob.id);
    if (hit) return hit;
    if (this.evaluating.has(ob.id)) return basisMatrix(ob); // dependency cycle guard
    if (!this.noOverrides) {
      for (const fn of worldMatrixOverrides) {
        const o = fn(ob, this.doc);
        if (o) { this.cache.set(ob.id, o); return o; }
      }
    }
    this.evaluating.add(ob.id);
    const m = basisMatrix(ob);
    const parent = ob.parent ? this.doc.objects[ob.parent] : null;
    if (parent) {
      let pw = this.world(parent);
      if (ob.parentBone && parent.type === 'ARMATURE' && parentResolvers.bone) pw = parentResolvers.bone(this.doc, parent, ob.parentBone, (o) => this.world(o)) ?? pw;
      const pm = pw.clone().multiply(new Matrix4().fromArray(ob.parentInverse));
      m.premultiply(pm);
    }
    applyConstraints(this.doc, ob, m, this);
    this.evaluating.delete(ob.id);
    this.cache.set(ob.id, m);
    return m;
  }

  location(ob: BObject): Vector3 {
    return new Vector3().setFromMatrixPosition(this.world(ob));
  }
}

function applyConstraints(doc: Doc, ob: BObject, m: Matrix4, cache: MatrixCache): void {
  for (const con of ob.constraints) {
    if (con.mute || con.influence <= 0) continue;
    const target = con.target ? doc.objects[con.target] : null;
    const pos = new Vector3(), quat = new Quaternion(), scl = new Vector3();
    m.decompose(pos, quat, scl);
    const before = { pos: pos.clone(), quat: quat.clone(), scl: scl.clone() };
    const axes = [con.useX !== false, con.useY !== false, con.useZ !== false];
    switch (con.type) {
      case 'COPY_LOCATION': {
        if (!target || target.id === ob.id) continue;
        const tp = cache.location(target);
        const off = con.useOffset ? before.pos : new Vector3();
        if (axes[0]) pos.x = tp.x * (con.invertX ? -1 : 1) + off.x;
        if (axes[1]) pos.y = tp.y * (con.invertY ? -1 : 1) + off.y;
        if (axes[2]) pos.z = tp.z * (con.invertZ ? -1 : 1) + off.z;
        break;
      }
      case 'COPY_ROTATION': {
        if (!target || target.id === ob.id) continue;
        const tq = new Quaternion();
        cache.world(target).decompose(new Vector3(), tq, new Vector3());
        const te = new Euler().setFromQuaternion(tq, 'ZYX');
        const oe = new Euler().setFromQuaternion(quat, 'ZYX');
        if (axes[0]) oe.x = te.x * (con.invertX ? -1 : 1);
        if (axes[1]) oe.y = te.y * (con.invertY ? -1 : 1);
        if (axes[2]) oe.z = te.z * (con.invertZ ? -1 : 1);
        quat.setFromEuler(oe);
        break;
      }
      case 'COPY_SCALE': {
        if (!target || target.id === ob.id) continue;
        const ts = new Vector3();
        cache.world(target).decompose(new Vector3(), new Quaternion(), ts);
        if (axes[0]) scl.x = ts.x;
        if (axes[1]) scl.y = ts.y;
        if (axes[2]) scl.z = ts.z;
        break;
      }
      case 'LIMIT_LOCATION': {
        const c = con as unknown as Record<string, number | boolean>;
        if (c.useMinX) pos.x = Math.max(pos.x, c.minX as number);
        if (c.useMaxX) pos.x = Math.min(pos.x, c.maxX as number);
        if (c.useMinY) pos.y = Math.max(pos.y, c.minY as number);
        if (c.useMaxY) pos.y = Math.min(pos.y, c.maxY as number);
        if (c.useMinZ) pos.z = Math.max(pos.z, c.minZ as number);
        if (c.useMaxZ) pos.z = Math.min(pos.z, c.maxZ as number);
        break;
      }
      case 'LIMIT_ROTATION': {
        const c = con as unknown as Record<string, number | boolean>;
        const e = new Euler().setFromQuaternion(quat, 'ZYX');
        if (c.useLimitX) e.x = Math.min(Math.max(e.x, c.minX as number), c.maxX as number);
        if (c.useLimitY) e.y = Math.min(Math.max(e.y, c.minY as number), c.maxY as number);
        if (c.useLimitZ) e.z = Math.min(Math.max(e.z, c.minZ as number), c.maxZ as number);
        quat.setFromEuler(e);
        break;
      }
      case 'LIMIT_SCALE': {
        const c = con as unknown as Record<string, number | boolean>;
        if (c.useMinX) scl.x = Math.max(scl.x, c.minX as number);
        if (c.useMaxX) scl.x = Math.min(scl.x, c.maxX as number);
        if (c.useMinY) scl.y = Math.max(scl.y, c.minY as number);
        if (c.useMaxY) scl.y = Math.min(scl.y, c.maxY as number);
        if (c.useMinZ) scl.z = Math.max(scl.z, c.minZ as number);
        if (c.useMaxZ) scl.z = Math.min(scl.z, c.maxZ as number);
        break;
      }
      case 'TRACK_TO':
      case 'DAMPED_TRACK': {
        if (!target || target.id === ob.id) continue;
        const tp = cache.location(target);
        const dir = tp.clone().sub(pos);
        if (dir.lengthSq() < 1e-12) continue;
        dir.normalize();
        // Blender default for cameras/lamps: track -Z, up Y
        const trackAxis = (con.trackAxis as string) ?? 'TRACK_NEGATIVE_Z';
        const axisVec: Record<string, Vector3> = {
          TRACK_X: new Vector3(1, 0, 0), TRACK_Y: new Vector3(0, 1, 0), TRACK_Z: new Vector3(0, 0, 1),
          TRACK_NEGATIVE_X: new Vector3(-1, 0, 0), TRACK_NEGATIVE_Y: new Vector3(0, -1, 0), TRACK_NEGATIVE_Z: new Vector3(0, 0, -1),
        };
        const local = axisVec[trackAxis] ?? axisVec.TRACK_NEGATIVE_Z;
        if (con.type === 'DAMPED_TRACK') {
          const cur = local.clone().applyQuaternion(quat);
          const delta = new Quaternion().setFromUnitVectors(cur.normalize(), dir);
          quat.premultiply(delta);
        } else {
          // Track To: map the local track axis onto the target direction and the local up axis
          // as close as possible to world Z (Blender's default "Up: Z" for the world).
          const upName = (con.upAxis as string) ?? 'UP_Y';
          const upLocal = upName === 'UP_X' ? new Vector3(1, 0, 0) : upName === 'UP_Z' ? new Vector3(0, 0, 1) : new Vector3(0, 1, 0);
          const t = local.clone().normalize();
          if (Math.abs(t.dot(upLocal)) > 0.999) break; // track and up axis are the same: Blender disables the constraint
          const u = upLocal.clone().sub(t.clone().multiplyScalar(upLocal.dot(t))).normalize();
          const w = new Vector3().crossVectors(t, u);
          const worldUp = new Vector3(0, 0, 1);
          if (Math.abs(dir.dot(worldUp)) > 0.999) worldUp.set(0, 1, 0);
          const uw = worldUp.sub(dir.clone().multiplyScalar(worldUp.dot(dir))).normalize();
          const ww = new Vector3().crossVectors(dir, uw);
          const A = new Matrix4().makeBasis(dir, uw, ww);
          const B = new Matrix4().makeBasis(t, u, w);
          quat.setFromRotationMatrix(A.multiply(B.transpose()));
        }
        break;
      }
      case 'CHILD_OF': {
        if (!target || target.id === ob.id) continue;
        const inv = new Matrix4().fromArray((con.inverse as number[]) ?? new Matrix4().toArray());
        const res = cache.world(target).clone().multiply(inv).multiply(m);
        res.decompose(pos, quat, scl);
        break;
      }
    }
    const t = Math.min(1, con.influence);
    if (t < 1) {
      pos.lerpVectors(before.pos, pos, t);
      quat.copy(before.quat.clone().slerp(quat, t));
      scl.lerpVectors(before.scl, scl, t);
    }
    m.compose(pos, quat, scl);
  }
}

/** Set an object's parent while keeping its world transform (Blender: Ctrl+P > Object). */
export function setParentKeepTransform(doc: Doc, child: BObject, parent: BObject | null, cache: MatrixCache): void {
  if (parent) {
    // reject cycles
    let p: BObject | undefined = parent;
    while (p) { if (p.id === child.id) return; p = p.parent ? doc.objects[p.parent] : undefined; }
    child.parent = parent.id;
    child.parentInverse = cache.world(parent).clone().invert().toArray();
  } else {
    const world = cache.world(child).clone();
    child.parent = null;
    child.parentInverse = new Matrix4().toArray();
    setBasisFromMatrix(child, world);
  }
}

export function childrenOf(doc: Doc, scene: Scene, id: string): BObject[] {
  return sceneObjects(doc, scene).filter((o) => o.parent === id);
}
