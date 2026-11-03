// Document model for the node editor (node trees), actions and the NLA, the video sequencer,
// media files and movie clips. Plain JSON data like the rest of the document (see types.ts).

import type { Color3, Color4, FCurve } from './types';

// ---------------------------------------------------------------- node trees

export type NodeTreeType = 'COMPOSITING' | 'SHADER' | 'TEXTURE';

export type SocketValue = number | number[] | string;

export interface BNode {
  /** Unique within the tree (Blender uses the node name as its key). */
  name: string;
  /** Node type id (bl_idname), e.g. "CompositorNodeMixRGB". */
  type: string;
  label: string;
  /** Location in node space, Blender convention (y up). */
  location: [number, number];
  width: number;
  select: boolean;
  /** Collapsed (H). */
  hide: boolean;
  /** Muted (M): inputs are passed through. */
  mute: boolean;
  /** Frame node this node is in. */
  parent: string | null;
  /** Default values of unlinked input sockets by socket identifier. */
  inputs: Record<string, SocketValue>;
  /** Sockets hidden with Ctrl+H, by identifier. */
  hiddenSockets?: string[];
  /** Type specific settings (blend_type, use_alpha, size_x, ...). */
  props: Record<string, unknown>;
  useCustomColor?: boolean;
  color?: Color3;
  showOptions?: boolean;
  /** Height of frame nodes. */
  height?: number;
}

export interface NodeLink {
  fromNode: string;
  fromSocket: string;
  toNode: string;
  toSocket: string;
}

export interface NodeTree {
  type: NodeTreeType;
  nodes: BNode[];
  links: NodeLink[];
  /** Name of the active node. */
  active: string | null;
}

// ---------------------------------------------------------------- actions and NLA

/** A reusable, named set of F-Curves (bpy.types.Action). */
export interface ActionData {
  id: string;
  name: string;
  fcurves: FCurve[];
  fakeUser: boolean;
}

export type NlaBlend = 'REPLACE' | 'ADD' | 'SUBTRACT' | 'MULTIPLY';
export type NlaExtrapolation = 'HOLD' | 'HOLD_FORWARD' | 'NOTHING';

export interface NlaStrip {
  name: string;
  action: string | null;
  frameStart: number;
  frameEnd: number;
  actionFrameStart: number;
  actionFrameEnd: number;
  scale: number;
  repeat: number;
  blendIn: number;
  blendOut: number;
  useAutoBlend: boolean;
  extrapolation: NlaExtrapolation;
  blendType: NlaBlend;
  influence: number;
  useAnimatedInfluence: boolean;
  mute: boolean;
  useReverse: boolean;
  select: boolean;
  active: boolean;
  useSyncLength: boolean;
}

export interface NlaTrack {
  name: string;
  strips: NlaStrip[];
  mute: boolean;
  isSolo: boolean;
  lock: boolean;
  select: boolean;
  active: boolean;
}

/** Animation data of an object besides its active action (bpy.types.AnimData). */
export interface AnimData {
  /** Bottom to top. */
  nlaTracks: NlaTrack[];
  /** NLA evaluation enabled (the checkbox on the object's NLA row). */
  useNla: boolean;
  actionBlendType: NlaBlend;
  actionInfluence: number;
  actionExtrapolation: NlaExtrapolation;
  /** Tweak mode: the strip whose action is being edited, and the action that was active before. */
  tweak: { track: number; strip: number; prevAction: string | null } | null;
}

// ---------------------------------------------------------------- media (movies, images, sounds)

export type MediaKind = 'IMAGE' | 'MOVIE' | 'SOUND';

/**
 * An external media file. The file itself is kept in memory (object URL) while the page is open; the
 * document stores its name and, when the file is small enough (< 5 MB), a data URL so it survives
 * save/load. Larger files show as missing media after a reload until they are opened again.
 */
export interface MediaData {
  id: string;
  name: string;
  kind: MediaKind;
  filepath: string;
  dataUrl?: string;
  /** Image sequences: one file per frame. */
  files?: { name: string; dataUrl?: string }[];
  width: number;
  height: number;
  /** Length in seconds (movies and sounds). */
  duration: number;
  /** Frames per second of a movie (assumed to be the scene rate when unknown). */
  fps: number;
  fakeUser: boolean;
}

// ---------------------------------------------------------------- video sequence editor

export type SeqType =
  | 'SCENE' | 'MOVIE' | 'IMAGE' | 'SOUND' | 'COLOR' | 'TEXT' | 'ADJUSTMENT' | 'META'
  | 'ADD' | 'SUBTRACT' | 'MULTIPLY' | 'ALPHA_OVER' | 'ALPHA_UNDER' | 'CROSS' | 'GAMMA_CROSS' | 'WIPE' | 'GLOW'
  | 'TRANSFORM' | 'COLORMIX' | 'SPEED' | 'OVER_DROP';

export type SeqBlend = 'REPLACE' | 'CROSS' | 'ADD' | 'SUBTRACT' | 'ALPHA_OVER' | 'ALPHA_UNDER' | 'GAMMA_CROSS' | 'MULTIPLY' | 'OVER_DROP';

export interface SeqText {
  text: string;
  fontSize: number;
  color: Color4;
  /** Normalised position (0..1, origin bottom left). */
  location: [number, number];
  wrapWidth: number;
  alignX: 'LEFT' | 'CENTER' | 'RIGHT';
  alignY: 'TOP' | 'CENTER' | 'BOTTOM';
  useShadow: boolean;
  shadowColor: Color4;
}

export interface Sequence {
  /** Unique name (the key, like in Blender). */
  name: string;
  type: SeqType;
  channel: number;
  /** Frame where the first frame of the (hard-cut) content is placed. */
  frameStart: number;
  /** Length of the content in frames (after hard cuts). */
  frameDuration: number;
  /** Soft trims (K): frames hidden at the start / end. */
  frameOffsetStart: number;
  frameOffsetEnd: number;
  /** Hard cuts (Shift+K): content frames removed from the start / end of the source. */
  animOffsetStart: number;
  animOffsetEnd: number;
  select: boolean;
  selectLeftHandle: boolean;
  selectRightHandle: boolean;
  mute: boolean;
  lock: boolean;
  blendType: SeqBlend;
  blendAlpha: number;
  media?: string | null;
  scene?: string | null;
  color?: Color3;
  /** Effect inputs (strip names). */
  input1?: string | null;
  input2?: string | null;
  /** Effect settings. */
  effect?: Record<string, unknown>;
  text?: SeqText;
  useCrop?: boolean;
  crop?: { minX: number; maxX: number; minY: number; maxY: number };
  useTranslation?: boolean;
  offset?: [number, number];
  volume?: number;
  /** Colour: saturation and multiply (Strip > Color panel). */
  colorSaturation?: number;
  colorMultiply?: number;
  useFlipX?: boolean;
  useFlipY?: boolean;
  useReverseFrames?: boolean;
  /** Strobe: only display every nth frame. */
  strobe?: number;
  /** Meta strips: contained strips. */
  sequences?: Sequence[];
}

export interface SequenceEditorData {
  sequences: Sequence[];
  active: string | null;
  /** Names of the meta strips being edited (Tab), outermost first. */
  metaStack: string[];
}

// ---------------------------------------------------------------- movie clips and tracking

export interface TrackMarker {
  frame: number;
  /** Normalised position in the frame (0..1, y up like Blender). */
  co: [number, number];
  disabled: boolean;
}

export interface TrackingTrack {
  name: string;
  markers: TrackMarker[];
  select: boolean;
  hide: boolean;
  lock: boolean;
  /** Pattern / search area sizes in pixels (square, centred on the marker). */
  patternSize: number;
  searchSize: number;
  correlationMin: number;
  framesLimit: number;
  margin: number;
  useCustomColor: boolean;
  color: Color3;
  /** Correlation of the last tracked frame. */
  correlation?: number;
}

export interface TrackingSettings {
  patternSize: number;
  searchSize: number;
  correlationMin: number;
  framesLimit: number;
  margin: number;
  motionModel: 'Loc';
  speed: 'FASTEST' | 'DOUBLE' | 'REALTIME' | 'HALF' | 'QUARTER';
  showPath: boolean;
  pathLength: number;
}

export interface MovieClipData {
  id: string;
  name: string;
  media: string;
  /** Scene frame at which the clip starts. */
  frameStart: number;
  frameOffset: number;
  tracks: TrackingTrack[];
  activeTrack: string | null;
  settings: TrackingSettings;
  fakeUser: boolean;
}
