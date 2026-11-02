// Core document data model. Everything here is plain JSON-serialisable data so the
// whole document can be snapshotted for undo and saved to / loaded from a file.

export type Vec3 = [number, number, number];
export type Color3 = [number, number, number];
export type Color4 = [number, number, number, number];

export type ObjectType = 'MESH' | 'CAMERA' | 'LAMP' | 'EMPTY';
export type RotationMode = 'XYZ' | 'XZY' | 'YXZ' | 'YZX' | 'ZXY' | 'ZYX';
export type DrawType = 'BOUNDS' | 'WIRE' | 'SOLID' | 'TEXTURED';
export type EmptyDrawType = 'PLAIN_AXES' | 'ARROWS' | 'SINGLE_ARROW' | 'CIRCLE' | 'CUBE' | 'SPHERE' | 'CONE';
export type LampType = 'POINT' | 'SUN' | 'SPOT' | 'HEMI' | 'AREA';

export interface MeshData {
  id: string;
  name: string;
  verts: Vec3[];
  /** Polygons as lists of vertex indices, counter-clockwise when seen from outside. */
  faces: number[][];
  /** All edges, including the edges of faces and loose edges. Kept unique (a < b). */
  edges: [number, number][];
  faceSmooth: boolean[];
  faceMat: number[];
  vsel: boolean[];
  esel: boolean[];
  fsel: boolean[];
  /** Index of the active face in edit mode (-1 for none). */
  activeFace: number;
  /** Edit-mode hidden vertices / faces (H, Alt+H). Absent when nothing is hidden. */
  vhide?: boolean[];
  fhide?: boolean[];
  materials: (string | null)[];
  autoSmooth: boolean;
  autoSmoothAngle: number;
  doubleSided: boolean;
  fakeUser: boolean;
}

export interface CameraData {
  id: string;
  name: string;
  lensType: 'PERSP' | 'ORTHO';
  lens: number;
  lensUnit: 'MILLIMETERS' | 'FOV';
  orthoScale: number;
  sensorWidth: number;
  sensorHeight: number;
  sensorFit: 'AUTO' | 'HORIZONTAL' | 'VERTICAL';
  clipStart: number;
  clipEnd: number;
  shiftX: number;
  shiftY: number;
  drawSize: number;
  showLimits: boolean;
  showName: boolean;
  showPassepartout: boolean;
  passepartoutAlpha: number;
  showSensor: boolean;
  dofDistance: number;
  fakeUser: boolean;
}

export interface LampData {
  id: string;
  name: string;
  lampType: LampType;
  color: Color3;
  energy: number;
  distance: number;
  falloff: 'INVERSE_SQUARE' | 'INVERSE_LINEAR' | 'CONSTANT';
  useNegative: boolean;
  useOwnLayer: boolean;
  useSpecular: boolean;
  useDiffuse: boolean;
  useSphere: boolean;
  shadow: 'NOSHADOW' | 'RAY_SHADOW';
  shadowColor: Color3;
  shadowSoftSize: number;
  shadowSamples: number;
  spotSize: number;
  spotBlend: number;
  showCone: boolean;
  useSquare: boolean;
  useHalo: boolean;
  areaShape: 'SQUARE' | 'RECTANGLE';
  areaSize: number;
  areaSizeY: number;
  sunSize?: number;
  fakeUser: boolean;
}

export interface TextureData {
  id: string;
  name: string;
  type: 'NONE' | 'IMAGE' | 'CLOUDS' | 'BLEND' | 'WOOD' | 'MARBLE' | 'VORONOI' | 'MAGIC' | 'STUCCI' | 'NOISE';
  imageData: string | null;  // data URL for IMAGE textures
  imageName: string;
  noiseScale: number;
  noiseDepth: number;
  noiseBasis: 'BLENDER_ORIGINAL' | 'ORIGINAL_PERLIN' | 'IMPROVED_PERLIN';
  noiseType: 'SOFT_NOISE' | 'HARD_NOISE';
  progression: 'LINEAR' | 'QUADRATIC' | 'EASING' | 'DIAGONAL' | 'SPHERICAL' | 'QUADRATIC_SPHERE' | 'RADIAL';
  turbulence: number;
  woodType: 'BANDS' | 'RINGS' | 'BANDNOISE' | 'RINGNOISE';
  intensity: number;
  contrast: number;
  saturation: number;
  colorTint: Color3;
  extension: 'REPEAT' | 'EXTEND' | 'CLIP';
  repeatX: number;
  repeatY: number;
  fakeUser: boolean;
}

export interface TextureSlot {
  texture: string | null;
  use: boolean;
  textureCoords: 'GENERATED' | 'ORCO' | 'UV' | 'OBJECT' | 'GLOBAL' | 'NORMAL' | 'REFLECTION';
  mapping: 'FLAT' | 'CUBE' | 'TUBE' | 'SPHERE';
  offset: Vec3;
  scale: Vec3;
  useMapColorDiffuse: boolean;
  diffuseColorFactor: number;
  useMapAlpha: boolean;
  alphaFactor: number;
  blendType: 'MIX' | 'ADD' | 'SUBTRACT' | 'MULTIPLY' | 'SCREEN';
  useRgbToIntensity: boolean;
  color: Color3;
}

export interface MaterialData {
  id: string;
  name: string;
  type: 'SURFACE' | 'WIRE' | 'VOLUME' | 'HALO';
  diffuseColor: Color3;
  diffuseIntensity: number;
  diffuseShader: 'LAMBERT' | 'OREN_NAYAR' | 'TOON' | 'MINNAERT' | 'FRESNEL';
  specularColor: Color3;
  specularIntensity: number;
  specularShader: 'COOKTORR' | 'PHONG' | 'BLINN' | 'TOON' | 'WARDISO';
  specularHardness: number;
  emit: number;
  ambient: number;
  translucency: number;
  useShadeless: boolean;
  useTransparency: boolean;
  transparencyMethod: 'MASK' | 'Z_TRANSPARENCY' | 'RAYTRACE';
  alpha: number;
  specularAlpha: number;
  rayMirror: number;
  useMirror: boolean;
  receiveShadows: boolean;
  castShadows: boolean;
  previewType: 'FLAT' | 'SPHERE' | 'CUBE' | 'MONKEY' | 'HAIR' | 'SPHERE_A';
  textureSlots: (TextureSlot | null)[];
  activeTextureIndex: number;
  fakeUser: boolean;
}

export interface WorldData {
  id: string;
  name: string;
  horizonColor: Color3;
  zenithColor: Color3;
  ambientColor: Color3;
  usePaperSky: boolean;
  useBlendSky: boolean;
  useRealSky: boolean;
  exposure: number;
  colorRange: number;
  useAO: boolean;
  aoFactor: number;
  useEnvLight: boolean;
  envEnergy: number;
  useMist: boolean;
  mistStart: number;
  mistDepth: number;
  mistIntensity: number;
  useStars: boolean;
  fakeUser: boolean;
}

export interface TextBlock {
  id: string;
  name: string;
  body: string;
  fakeUser: boolean;
}

// ---------------------------------------------------------------- modifiers

export type ModifierType =
  | 'SUBSURF' | 'MIRROR' | 'ARRAY' | 'SOLIDIFY' | 'TRIANGULATE' | 'SMOOTH'
  | 'WAVE' | 'DISPLACE' | 'SIMPLE_DEFORM' | 'CAST' | 'DECIMATE' | 'EDGE_SPLIT' | 'WIREFRAME' | 'BEVEL' | 'SCREW' | 'BUILD';

export interface Modifier {
  type: ModifierType;
  name: string;
  showViewport: boolean;
  showRender: boolean;
  showInEditmode: boolean;
  showOnCage: boolean;
  showExpanded: boolean;
  /** Type specific settings. */
  [key: string]: unknown;
}

// ---------------------------------------------------------------- constraints

export type ConstraintType =
  | 'COPY_LOCATION' | 'COPY_ROTATION' | 'COPY_SCALE' | 'LIMIT_LOCATION' | 'LIMIT_ROTATION' | 'LIMIT_SCALE'
  | 'TRACK_TO' | 'DAMPED_TRACK' | 'CHILD_OF';

export interface Constraint {
  type: ConstraintType;
  name: string;
  mute: boolean;
  showExpanded: boolean;
  influence: number;
  target: string | null;
  [key: string]: unknown;
}

// ---------------------------------------------------------------- animation

export type Interpolation = 'CONSTANT' | 'LINEAR' | 'BEZIER';

export interface Keyframe {
  frame: number;
  value: number;
  interpolation: Interpolation;
  select: boolean;
}

export interface FCurve {
  /** Property path relative to the object, e.g. "location", "rotation_euler", "scale", "hide". */
  path: string;
  index: number;
  keys: Keyframe[];
  select: boolean;
  mute: boolean;
}

export interface TimelineMarker {
  name: string;
  frame: number;
  select: boolean;
}

// ---------------------------------------------------------------- objects

export interface BObject {
  id: string;
  name: string;
  type: ObjectType;
  data: string | null;
  location: Vec3;
  rotation: Vec3;
  scale: Vec3;
  rotationMode: RotationMode;
  deltaLocation: Vec3;
  deltaRotation: Vec3;
  deltaScale: Vec3;
  lockLocation: [boolean, boolean, boolean];
  lockRotation: [boolean, boolean, boolean];
  lockScale: [boolean, boolean, boolean];
  parent: string | null;
  /** Column-major 4x4 matrix (inverse of parent world matrix at parenting time). */
  parentInverse: number[];
  layers: boolean[];
  hide: boolean;
  hideSelect: boolean;
  hideRender: boolean;
  select: boolean;
  modifiers: Modifier[];
  constraints: Constraint[];
  drawType: DrawType;
  showName: boolean;
  showAxis: boolean;
  showWire: boolean;
  showBounds: boolean;
  showXRay: boolean;
  showTransparent: boolean;
  color: Color4;
  emptyDrawType: EmptyDrawType;
  emptyDrawSize: number;
  fcurves: FCurve[];
  passIndex: number;
  /** Material slots linked to the object (only used if a slot link is OBJECT). Unused for now. */
  activeMaterialIndex: number;
  /** Particle systems (simple emitter). */
  particleSystems: ParticleSystem[];
}

export interface ParticleSystem {
  name: string;
  count: number;
  frameStart: number;
  frameEnd: number;
  lifetime: number;
  normalFactor: number;
  randomFactor: number;
  objectAlignFactor: Vec3;
  gravity: number;
  size: number;
  seed: number;
  emitFrom: 'VERT' | 'FACE' | 'VOLUME';
  showViewport: boolean;
  showRender: boolean;
  displayPercentage: number;
}

// ---------------------------------------------------------------- scene / document

export type PivotPoint = 'BOUNDING_BOX_CENTER' | 'CURSOR' | 'INDIVIDUAL_ORIGINS' | 'MEDIAN_POINT' | 'ACTIVE_ELEMENT';
export type TransformOrientation = 'GLOBAL' | 'LOCAL' | 'NORMAL' | 'GIMBAL' | 'VIEW';

export type SculptBrush = 'DRAW' | 'CLAY' | 'INFLATE' | 'SMOOTH' | 'FLATTEN' | 'PINCH' | 'GRAB' | 'CREASE' | 'LAYER';

export interface SculptSettings {
  brush: SculptBrush;
  /** Brush radius in screen pixels. */
  radius: number;
  strength: number;
  direction: 'ADD' | 'SUBTRACT';
  falloff: 'SMOOTH' | 'SPHERE' | 'ROOT' | 'SHARP' | 'LINEAR' | 'CONSTANT';
  symmetry: [boolean, boolean, boolean];
  lockAxis: [boolean, boolean, boolean];
  spacing: number;
  useFrontFacesOnly: boolean;
  /** Per-brush overrides of strength (like Blender's separate brush data-blocks). */
  brushStrength: Partial<Record<SculptBrush, number>>;
}

export interface ToolSettings {
  sculpt?: SculptSettings;
  meshSelectMode: [boolean, boolean, boolean];
  pivotPoint: PivotPoint;
  usePivotPointAlign: boolean;
  transformOrientation: TransformOrientation;
  useSnap: boolean;
  snapElement: 'INCREMENT' | 'VERTEX' | 'EDGE' | 'FACE' | 'VOLUME';
  proportionalEdit: 'DISABLED' | 'ENABLED' | 'CONNECTED';
  proportionalFalloff: 'SMOOTH' | 'SPHERE' | 'ROOT' | 'INVERSE_SQUARE' | 'SHARP' | 'LINEAR' | 'CONSTANT' | 'RANDOM';
  proportionalSize: number;
  useKeyframeInsertAuto: boolean;
  useMeshAutomerge: boolean;
  doubleThreshold: number;
}

export interface RenderSettings {
  engine: 'BLENDER_RENDER' | 'BLENDER_GAME' | 'CYCLES';
  resolutionX: number;
  resolutionY: number;
  resolutionPercentage: number;
  pixelAspectX: number;
  pixelAspectY: number;
  useBorder: boolean;
  useCropToBorder: boolean;
  useAntialiasing: boolean;
  antialiasingSamples: '5' | '8' | '11' | '16';
  filterSize: number;
  useShadows: boolean;
  useRaytrace: boolean;
  useTextures: boolean;
  useSSS: boolean;
  useEnvMaps: boolean;
  alphaMode: 'SKY' | 'TRANSPARENT';
  filepath: string;
  fileFormat: 'PNG' | 'JPEG' | 'BMP' | 'WEBP';
  colorMode: 'BW' | 'RGB' | 'RGBA';
  colorDepth: '8' | '16';
  compression: number;
  quality: number;
  useOverwrite: boolean;
  usePlaceholder: boolean;
  useFileExtension: boolean;
  display: 'SCREEN' | 'AREA' | 'WINDOW' | 'NONE';
  useStamp: boolean;
  useFreestyle: boolean;
  useMotionBlur: boolean;
  threadsMode: 'AUTO' | 'FIXED';
  tileX: number;
  tileY: number;
  useLockInterface: boolean;
  useCompositing: boolean;
  useSequencer: boolean;
  ditherIntensity: number;
  edgeEnable: boolean;
}

export interface UnitSettings {
  system: 'NONE' | 'METRIC' | 'IMPERIAL';
  systemRotation: 'DEGREES' | 'RADIANS';
  scaleLength: number;
  useSeparate: boolean;
}

export interface Scene {
  id: string;
  name: string;
  objects: string[];
  world: string | null;
  camera: string | null;
  activeObject: string | null;
  cursor: Vec3;
  layers: boolean[];
  frameCurrent: number;
  frameStart: number;
  frameEnd: number;
  frameStep: number;
  fps: number;
  fpsBase: number;
  usePreviewRange: boolean;
  previewStart: number;
  previewEnd: number;
  render: RenderSettings;
  unit: UnitSettings;
  useGravity: boolean;
  gravity: Vec3;
  toolSettings: ToolSettings;
  markers: TimelineMarker[];
  syncMode: 'NONE' | 'FRAME_DROP' | 'AUDIO_SYNC';
  keyingSet: string;
  fakeUser: boolean;
}

export interface Doc {
  version: number;
  filename: string;
  scenes: Scene[];
  activeScene: string;
  objects: Record<string, BObject>;
  meshes: Record<string, MeshData>;
  cameras: Record<string, CameraData>;
  lamps: Record<string, LampData>;
  materials: Record<string, MaterialData>;
  textures: Record<string, TextureData>;
  worlds: Record<string, WorldData>;
  texts: Record<string, TextBlock>;
  /** Monotonic counter for id generation. */
  idCounter: number;
}

export type DataCollection = 'objects' | 'meshes' | 'cameras' | 'lamps' | 'materials' | 'textures' | 'worlds' | 'texts';
