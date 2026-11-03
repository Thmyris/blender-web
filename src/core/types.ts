// Core document data model. Everything here is plain JSON-serialisable data so the
// whole document can be snapshotted for undo and saved to / loaded from a file.

export type Vec3 = [number, number, number];
export type Color3 = [number, number, number];
export type Color4 = [number, number, number, number];

import type { ActionData, AnimData, MediaData, MovieClipData, NodeTree, SequenceEditorData } from './edtypes';
import type { CurveData, MetaBallData, VFontData } from './curvetypes';
export type { CurveData, MetaBallData, VFontData } from './curvetypes';
export type * from './edtypes';
import type { CollisionSettings, FieldSettings, ParticleSettingsExt, RigidBodyConstraint, RigidBodyObject, RigidBodyWorld } from '../sim/types';
import type { CyclesLampSettings, CyclesMaterialSettings, CyclesSceneSettings, CyclesWorldSettings } from '../render/cycles/types';
export type * from '../render/cycles/types';

export type ObjectType = 'MESH' | 'CAMERA' | 'LAMP' | 'EMPTY' | 'FONT' | 'ARMATURE' | 'LATTICE' | 'CURVE' | 'SURFACE' | 'META';
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
  /** Vertex colours (linear RGB per vertex), created by Vertex Paint. */
  vcol?: Color3[];
  fhide?: boolean[];
  /** UV maps (Data tab > UV Maps). Absent or empty when the mesh has no UVs. */
  uvLayers?: MeshUVLayer[];
  /** Index of the active UV map (the one edited in the UV/Image Editor). */
  uvActive?: number;
  /** Index of the UV map used for rendering (camera icon in the UV Maps list). */
  uvActiveRender?: number;
  /** UV seams, parallel to `edges` (Ctrl+E > Mark Seam). Absent when there are none. */
  seam?: boolean[];
  /**
   * Deform-vertex weights (vertex groups), one list per vertex of [group index, weight] pairs. Group
   * indices refer to the owning object's `vertexGroups`. Absent when the mesh has no weights.
   */
  dvert?: [number, number][][];
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
  /** Cycles lamp settings (src/render/cycles); derived from the Blender Internal ones when absent. */
  cycles?: Partial<CyclesLampSettings>;
  fakeUser: boolean;
}

export interface TextureData {
  id: string;
  name: string;
  type: 'NONE' | 'IMAGE' | 'CLOUDS' | 'BLEND' | 'WOOD' | 'MARBLE' | 'VORONOI' | 'MAGIC' | 'STUCCI' | 'NOISE';
  imageData: string | null;  // data URL for IMAGE textures
  imageName: string;
  /** Image datablock (`doc.images`) used by IMAGE textures; takes precedence over `imageData`. */
  image?: string | null;
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
  /** UV map name used when `textureCoords` is 'UV' (empty: the active render UV map). */
  uvLayer?: string;
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
  /** Use vertex colours as the diffuse colour (Options > Vertex Color Paint). */
  useVertexColorPaint?: boolean;
  /** Material node tree (Blender Internal shader nodes), used when `useNodes` is on. */
  useNodes?: boolean;
  nodeTree?: NodeTree | null;
  receiveShadows: boolean;
  castShadows: boolean;
  previewType: 'FLAT' | 'SPHERE' | 'CUBE' | 'MONKEY' | 'HAIR' | 'SPHERE_A';
  textureSlots: (TextureSlot | null)[];
  activeTextureIndex: number;
  /** Active texture paint slot (Texture Paint > Slots). */
  paintActiveSlot?: number;
  /** Cycles material settings and surface shader (src/render/cycles); derived from Blender Internal when absent. */
  cycles?: Partial<CyclesMaterialSettings>;
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
  /** Cycles world settings (src/render/cycles); derived from Blender Internal when absent. */
  cycles?: Partial<CyclesWorldSettings>;
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
  | 'WAVE' | 'DISPLACE' | 'SIMPLE_DEFORM' | 'CAST' | 'DECIMATE' | 'EDGE_SPLIT' | 'WIREFRAME' | 'BEVEL' | 'SCREW' | 'BUILD'
  | 'ARMATURE' | 'LATTICE' | 'HOOK' | 'MASK' | 'VERTEX_WEIGHT_EDIT' | 'VERTEX_WEIGHT_MIX' | 'VERTEX_WEIGHT_PROXIMITY'
  | 'CLOTH' | 'SOFT_BODY' | 'COLLISION' | 'EXPLODE' | 'CURVE';

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
  | 'TRACK_TO' | 'DAMPED_TRACK' | 'CHILD_OF' | 'FOLLOW_PATH' | 'CLAMP_TO';

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

/** Settings of a text (FONT) object. */
export interface TextData {
  body: string;
  size: number;
  extrude: number;
  bevelDepth: number;
  bevelResolution: number;
  resolution: number;
  align: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFY' | 'FLUSH';
  lineSpacing: number;
  shearX: number;
  offsetX: number;
  offsetY: number;
  /** Cursor position while editing. */
  cursor: number;
  /** Selection start while editing (Shift+arrows); equal to `cursor` when nothing is selected. */
  selStart?: number;
  /** Per-character style flags (1 bold, 2 italic, 4 underline, 8 small caps) and material slot. */
  charFormat?: number[];
  charMaterial?: number[];
  /** Style used for newly typed characters (bpy: edit_format). */
  editFormat?: number;
  /** Material slots of the text (bpy: the text curve's materials). */
  materials?: (string | null)[];
  /** VectorFont ids (null = the built-in Bfont). */
  font?: string | null;
  fontBold?: string | null;
  fontItalic?: string | null;
  fontBoldItalic?: string | null;
  underlinePosition?: number;
  underlineHeight?: number;
  smallCapsScale?: number;
  spaceCharacter?: number;
  spaceWord?: number;
  /** Curve object the text follows (Text on Curve). */
  followCurve?: string | null;
}

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
  activeParticleSystem?: number;
  /** Text settings (FONT objects only). */
  text?: TextData;
  /** Active action (id in doc.actions); its F-Curves are mirrored in `fcurves`. */
  action?: string | null;
  /** NLA tracks and action blending. */
  animData?: AnimData;
  /** Vertex groups (names; the weights live in the mesh's `dvert`). */
  vertexGroups?: VertexGroup[];
  activeVertexGroup?: number;
  /** Pose of an ARMATURE object: pose bones by bone name. */
  pose?: Record<string, PoseBone>;
  /** Bone of the parent armature this object is parented to (Ctrl+P > Bone). */
  parentBone?: string;
  /** Physics (src/sim): rigid body, rigid body constraint, force field and collision settings. */
  rigidBody?: RigidBodyObject | null;
  rigidBodyConstraint?: RigidBodyConstraint | null;
  field?: FieldSettings | null;
  collision?: CollisionSettings | null;
}

// ---------------------------------------------------------------- vertex groups, armatures, lattices

export interface VertexGroup {
  name: string;
  lockWeight: boolean;
}

export type BoneRotationMode = 'QUATERNION' | 'XYZ' | 'XZY' | 'YXZ' | 'YZX' | 'ZXY' | 'ZYX' | 'AXIS_ANGLE';

/** Rest bone of an armature (edit bone data), in armature space. */
export interface Bone {
  name: string;
  head: Vec3;
  tail: Vec3;
  roll: number;
  /** Parent bone name. */
  parent: string | null;
  useConnect: boolean;
  useDeform: boolean;
  useInheritRotation: boolean;
  useInheritScale: boolean;
  useLocalLocation: boolean;
  useEnvelopeMultiply: boolean;
  envelopeDistance: number;
  envelopeWeight: number;
  headRadius: number;
  tailRadius: number;
  bboneSegments: number;
  bboneX: number;
  bboneZ: number;
  /** 32 bone layers. */
  layers: boolean[];
  hide: boolean;
  hideSelect: boolean;
  select: boolean;
  selectHead: boolean;
  selectTail: boolean;
}

/** Pose channel of a bone (ob.pose.bones["name"]). */
export interface PoseBone {
  location: Vec3;
  /** (w, x, y, z) like Blender. */
  rotationQuaternion: [number, number, number, number];
  rotationEuler: Vec3;
  /** (angle, x, y, z). */
  rotationAxisAngle: [number, number, number, number];
  rotationMode: BoneRotationMode;
  scale: Vec3;
  lockLocation: [boolean, boolean, boolean];
  lockRotation: [boolean, boolean, boolean];
  lockScale: [boolean, boolean, boolean];
  constraints: BoneConstraint[];
  ikStretch: number;
}

export type BoneConstraintType = 'IK' | 'COPY_LOCATION' | 'COPY_ROTATION' | 'DAMPED_TRACK' | 'LIMIT_ROTATION';

/** Bone constraint (Bone Constraints tab). Targets are objects; armature targets may name a bone (subtarget). */
export interface BoneConstraint {
  type: BoneConstraintType;
  name: string;
  mute: boolean;
  showExpanded: boolean;
  influence: number;
  target: string | null;
  subtarget: string;
  [key: string]: unknown;
}

export interface ArmatureData {
  id: string;
  name: string;
  bones: Bone[];
  activeBone: string | null;
  drawType: 'OCTAHEDRAL' | 'STICK' | 'BBONE' | 'ENVELOPE' | 'WIRE';
  showNames: boolean;
  showAxes: boolean;
  showGroupColors: boolean;
  showBoneCustomShapes: boolean;
  useMirrorX: boolean;
  useDeformPreserveVolume: boolean;
  /** 32 visible armature layers. */
  layers: boolean[];
  layersProtected: boolean[];
  posePosition: 'POSE' | 'REST';
  fakeUser: boolean;
}

export type LatticeInterpolation = 'KEY_LINEAR' | 'KEY_CARDINAL' | 'KEY_BSPLINE';

export interface LatticeData {
  id: string;
  name: string;
  pointsU: number;
  pointsV: number;
  pointsW: number;
  interpolationU: LatticeInterpolation;
  interpolationV: LatticeInterpolation;
  interpolationW: LatticeInterpolation;
  useOutside: boolean;
  /** Point positions (u fastest, then v, then w), in lattice object space. */
  points: Vec3[];
  /** Point selection (edit mode). */
  select: boolean[];
  vertexGroup: string;
  fakeUser: boolean;
}

export interface ParticleSystem extends ParticleSettingsExt {
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

export interface VertexPaintSettings {
  color: Color3;
  radius: number;
  strength: number;
  blend: 'MIX' | 'ADD' | 'SUB' | 'MUL' | 'LIGHTEN' | 'DARKEN' | 'BLUR';
}

export interface WeightPaintSettings {
  weight: number;
  radius: number;
  strength: number;
  blend: 'MIX' | 'ADD' | 'SUB' | 'MUL' | 'BLUR' | 'LIGHTEN' | 'DARKEN';
  falloff: 'SMOOTH' | 'SPHERE' | 'ROOT' | 'SHARP' | 'LINEAR' | 'CONSTANT';
  useFrontFacesOnly: boolean;
  useAccumulate: boolean;
}

export interface ToolSettings {
  sculpt?: SculptSettings;
  vpaint?: VertexPaintSettings;
  /** Weight Paint brush and options. */
  wpaint?: WeightPaintSettings;
  /** Weight used by Assign in edit mode (Vertex Groups panel). */
  vertexGroupWeight?: number;
  useAutoNormalize?: boolean;
  useMultipaint?: boolean;
  /** Weight Paint X-mirror (Options > X Mirror). */
  useWeightPaintMirrorX?: boolean;
  /** Texture Paint brush settings. */
  imagePaint?: ImagePaintSettings;
  /** UV/Image Editor tool settings (UV select mode, sticky selection, sync selection). */
  uvEdit?: UVEditSettings;
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
  /** Compositing node tree (used when `useNodes` is on). */
  useNodes?: boolean;
  nodeTree?: NodeTree | null;
  /** Video sequence editor strips. */
  sequenceEditor?: SequenceEditorData | null;
  /** Rigid Body World (src/sim). */
  rigidBodyWorld?: RigidBodyWorld | null;
  /** Cycles render settings (scene.cycles, src/render/cycles); defaults are filled in on use. */
  cycles?: Partial<CyclesSceneSettings>;
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
  /** Image datablocks (UV/Image Editor, image textures, texture paint). Absent in older files. */
  images?: Record<string, BImage>;
  armatures: Record<string, ArmatureData>;
  lattices: Record<string, LatticeData>;
  curves: Record<string, CurveData>;
  metaballs: Record<string, MetaBallData>;
  fonts: Record<string, VFontData>;
  /** Actions (reusable sets of F-Curves), media files (movies, images, sounds) and movie clips. */
  actions?: Record<string, ActionData>;
  media?: Record<string, MediaData>;
  clips?: Record<string, MovieClipData>;
  /** Monotonic counter for id generation. */
  idCounter: number;
}

export type DataCollection = 'objects' | 'meshes' | 'cameras' | 'lamps' | 'materials' | 'textures' | 'worlds' | 'texts' | 'armatures' | 'lattices' | 'curves' | 'metaballs' | 'fonts';

// ---------------------------------------------------------------- UV maps, images, texture paint

/** A UV map: per-face-corner coordinates. `uv[f]` is `[u0, v0, u1, v1, ...]` for the corners of `faces[f]`. */
export interface MeshUVLayer {
  name: string;
  uv: number[][];
  /**
   * Per-corner flags parallel to `uv` (one number per corner): bit 1 = selected in the UV editor,
   * bit 2 = pinned. Optional; consumers must tolerate missing or short arrays.
   */
  flag?: number[][];
}

/** An image datablock (bpy.types.Image). Pixels are stored as a PNG data URL. */
export interface BImage {
  id: string;
  name: string;
  width: number;
  height: number;
  source: 'GENERATED' | 'FILE';
  generatedType: 'BLANK' | 'UV_GRID' | 'COLOR_GRID';
  /** Generated fill colour (RGBA, display space). */
  color: Color4;
  useAlpha: boolean;
  /** PNG/JPEG data URL of the pixels (null for an image that failed to load). */
  data: string | null;
  filepath: string;
  /** Packed into the .blend (always true for generated / painted images in blender-web). */
  packed: boolean;
  fakeUser: boolean;
}

export type ImagePaintBrush = 'DRAW' | 'SOFTEN' | 'SMEAR' | 'CLONE' | 'FILL';
export type ImagePaintBlend = 'MIX' | 'ADD' | 'SUB' | 'MUL' | 'LIGHTEN' | 'DARKEN' | 'ERASE_ALPHA' | 'ADD_ALPHA';

export interface ImagePaintSettings {
  brush: ImagePaintBrush;
  /** Paint colour (display space RGB). */
  color: Color3;
  secondaryColor: Color3;
  /** Radius in screen pixels. */
  radius: number;
  strength: number;
  blend: ImagePaintBlend;
  falloff: 'SMOOTH' | 'SPHERE' | 'ROOT' | 'SHARP' | 'LINEAR' | 'CONSTANT';
  spacing: number;
  /** Clone brush: source image (null = same image) and offset in pixels (image editor) . */
  cloneImage?: string | null;
  /** Fill brush threshold (0..1 colour distance). */
  fillThreshold: number;
  /** 3D view: only paint faces facing the view; occlude hidden surfaces. */
  useOcclude: boolean;
  useBackfaceCulling: boolean;
}

export interface UVEditSettings {
  selectMode: 'VERTEX' | 'EDGE' | 'FACE' | 'ISLAND';
  stickyMode: 'DISABLED' | 'SHARED_LOCATION' | 'SHARED_VERTEX';
  useSync: boolean;
  /** Snap to pixels while transforming with Ctrl. */
  snapToPixels?: boolean;
  /** Pivot point in the UV editor. */
  pivot: 'BOUNDING_BOX_CENTER' | 'MEDIAN_POINT' | 'CURSOR' | 'INDIVIDUAL_ORIGINS';
  /** 2D cursor in UV space. */
  cursor: [number, number];
  proportional?: boolean;
}
