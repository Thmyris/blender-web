// Registry of per-object-type handlers for the 3D View, used for object types other than meshes:
//
// - `registerEditType`: edit modes of non-mesh objects (armature, lattice, curves, ...) and other
//   element modes (Pose Mode). `select.ts`, `transform.ts`, `draw.ts` and `view3d.ts` dispatch to the
//   handler of the object being edited for picking, region selection, (de)select all, G/R/S and the
//   edit overlay.
// - `registerObjectDrawer`: custom viewport drawing of an object type (instead of the plain wire
//   "extras" used for cameras, lamps and empties). Line segments tagged `userData.pick = true` are
//   used for click / border selection in Object Mode.
//
// The dispatch hooks are already in place (added by the curve work): select.ts (clickSelectEdit,
// regionSelect), transform.ts (gatherElements/applyTransform/restoreElements/pivot), draw.ts (syncEdit
// -> syncEditTypeOverlay), view3d.ts (header menu, tweak, View Selected), overlay.ts (manipulator
// centre, draw2D), header.ts (mode menu) and menus.ts (Select / Add menus).

import type { Group, Matrix3, Matrix4, Vector3 } from 'three';
import { Group as ThreeGroup, type Object3D } from 'three';
import { app, type Mode } from '../../app';
import type { BObject, ObjectType } from '../../core/types';
import type { View3D } from './view3d';
import type { ViewDisplay, ViewportRenderer } from './draw';
import type { MenuItem } from '../../ui/menu';

/** A transformable element (a point, a bone, ...) for G/R/S in a non-mesh mode. */
export interface TransformPoint {
  /** World-space position at the start of the transform (pivot, snapping, proportional distance). */
  world: Vector3;
  /** True for selected elements; unselected ones are only moved by proportional editing. */
  selected: boolean;
  /** Proportional factor (1 for selected elements). Updated by the transform system. */
  factor: number;
  /**
   * Apply a world-space transform `m` relative to the start state (`m` already includes the
   * proportional factor). `mode` and `value` are the raw transform values (e.g. for bone roll).
   */
  apply(m: Matrix4, mode: string, value: number[]): void;
  /** Restore the start state. */
  restore(): void;
  /** Optional normal (world) for the Normal orientation / Shrink-Fatten. */
  normal?: Vector3;
}

export type SelectAction = 'TOGGLE' | 'SELECT' | 'DESELECT' | 'INVERT';
export type RegionMode = 'SET' | 'ADD' | 'SUB';

export interface EditTypeHandler {
  /** Object types this handler edits. */
  types: ObjectType[];
  /** Mode the handler is active in (default 'EDIT'). */
  mode?: Mode;
  /** Called when entering / leaving the mode. */
  enter?(ob: BObject): void;
  exit?(ob: BObject): void;
  /** RMB click: select the element under (x, y) (canvas pixels). Returns true when something was hit. */
  clickSelect(view: View3D, ob: BObject, x: number, y: number, extend: boolean): boolean;
  /** Border / circle / lasso selection. */
  regionSelect(view: View3D, ob: BObject, inside: (px: number, py: number) => boolean, mode: RegionMode): void;
  selectAll(ob: BObject, action: SelectAction): void;
  hasSelection(ob: BObject): boolean;
  /** Elements for G/R/S. With `propSize` > 0, also unselected elements within that (world) distance. */
  transformPoints(ob: BObject, propSize: number): TransformPoint[];
  /** Called after each transform step (`done` = confirmed / cancelled). */
  afterTransform?(ob: BObject, done: boolean): void;
  /** World positions of selected elements (View Selected, snap cursor, ...). */
  selectedPoints?(ob: BObject): Vector3[];
  /** Orientation for LOCAL / NORMAL transform orientation (columns are axes), if special. */
  orientation?(ob: BObject, orient: string): Matrix3 | null;
  /** Active element position (pivot "Active Element"). */
  activePoint?(ob: BObject): Vector3 | null;
  /** Edit overlay (drawn in the object's space, rebuilt when `overlayKey` changes). */
  overlayKey?(ob: BObject): string;
  buildOverlay?(ob: BObject, group: Group, renderer: ViewportRenderer): void;
  /** Header label for the mode-specific menu and its items (e.g. "Armature", "Pose", "Lattice"). */
  menuLabel?: string;
  /** Items of that header menu (replaces the "Mesh" menu). */
  menu?(): MenuItem[];
  /** Select menu / Add menu (Shift+A) in this mode, when different from the mesh ones. */
  selectMenu?(): MenuItem[];
  addMenu?(): MenuItem[];
  /**
   * Mouse button press in the viewport before the default handling (`ACTION` = LMB, `SELECT` = RMB with
   * right-click select). Return true when handled (e.g. paint strokes, Ctrl+click extrude).
   */
  pointerDown?(view: View3D, ob: BObject, e: PointerEvent, button: 'ACTION' | 'SELECT'): boolean;
  /** Key press in the viewport before the keymap (return true when handled). */
  key?(view: View3D, ob: BObject, e: KeyboardEvent): boolean;
  /** Track the mouse position in `view.brushPos` (paint modes draw a brush circle). */
  trackBrush?: boolean;
  /** Extra 2D drawing on the viewport's overlay canvas (e.g. metaball radius circles). */
  draw2D?(view: View3D, ctx: CanvasRenderingContext2D, ob: BObject): void;
}

const editTypes: EditTypeHandler[] = [];

export function registerEditType(h: EditTypeHandler): void { editTypes.push(h); }

/** Handler for editing `type` in `mode`. */
export function editTypeFor(type: ObjectType, mode: Mode = 'EDIT'): EditTypeHandler | null {
  return editTypes.find((h) => (h.mode ?? 'EDIT') === mode && h.types.includes(type)) ?? null;
}

/** Handler and object of the current non-mesh element mode (null in Object Mode or mesh edit mode). */
export function activeEditType(): { handler: EditTypeHandler; ob: BObject } | null {
  if (app.mode === 'OBJECT' || !app.editObject) return null;
  const ob = app.doc.objects[app.editObject];
  if (!ob) return null;
  const handler = editTypeFor(ob.type, app.mode);
  return handler ? { handler, ob } : null;
}

/** Can `ob` enter edit mode through a registered handler? */
export function hasEditType(type: ObjectType): boolean { return !!editTypeFor(type, 'EDIT'); }

// ------------------------------------------------------------------ custom object drawing

export interface ObjectDrawState {
  selected: boolean;
  active: boolean;
  display: ViewDisplay;
  renderer: ViewportRenderer;
}

export interface ObjectDrawer {
  types: ObjectType[];
  /** Cache key: the drawing is rebuilt when it changes. */
  key(ob: BObject, s: ObjectDrawState): string;
  /** Build the drawing into `root` (object space; the root carries the object's world matrix). */
  build(ob: BObject, root: Group, s: ObjectDrawState): void;
  /** Optional 2D drawing on the overlay canvas (e.g. bone names), for visible objects of this type. */
  draw2D?(view: View3D, ob: BObject, ctx: CanvasRenderingContext2D): void;
}

const drawers: ObjectDrawer[] = [];

/** 2D overlay drawing of custom-drawn objects (called by overlay.ts). */
export function drawObjects2D(view: View3D, ctx: CanvasRenderingContext2D): void {
  for (const ob of app.objects()) {
    const d = drawers.find((x) => x.types.includes(ob.type));
    if (d?.draw2D && view.renderer.objectVisible(ob.id)) d.draw2D(view, ob, ctx);
  }
}

export function registerObjectDrawer(d: ObjectDrawer): void { drawers.push(d); }

export function objectDrawerFor(type: ObjectType): ObjectDrawer | null {
  return drawers.find((d) => d.types.includes(type)) ?? null;
}

// ------------------------------------------------------------------ helpers shared by the dispatch hooks

/** Anything selected in the current non-mesh element mode? */
export function editTypeHasSelection(): boolean {
  const e = activeEditType();
  return !!e && e.handler.hasSelection(e.ob);
}

/** Selected element positions of the current non-mesh element mode (null when not in such a mode). */
export function editTypeSelectedPoints(): Vector3[] | null {
  const e = activeEditType();
  if (!e) return null;
  if (e.handler.selectedPoints) return e.handler.selectedPoints(e.ob);
  return e.handler.transformPoints(e.ob, 0).filter((p) => p.selected).map((p) => p.world.clone());
}

/** 2D overlay drawing of the current non-mesh element mode (called by overlay.ts). */
export function drawEditType2D(view: View3D, ctx: CanvasRenderingContext2D): void {
  const e = activeEditType();
  e?.handler.draw2D?.(view, ctx, e.ob);
}

/** Distance from (px, py) to the screen segment a-b, in pixels. */
export function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// ------------------------------------------------------------------ edit overlay sync (called by draw.ts)

interface OverlayState { key: string; obId: string; group: ThreeGroup }
const overlayStates = new WeakMap<object, OverlayState>();

/**
 * Keep the edit overlay of the current non-mesh element mode up to date in one viewport: `parent` is the
 * viewport's edit group. The overlay is rebuilt when the handler's `overlayKey` changes and follows the
 * object's world matrix. Returns true when such a mode is active.
 */
export function syncEditTypeOverlay(parent: Group, renderer: ViewportRenderer): boolean {
  const st = overlayStates.get(parent);
  const e = activeEditType();
  const drop = () => {
    if (!st) return;
    parent.remove(st.group);
    st.group.traverse((o) => {
      const x = o as Object3D & { geometry?: { dispose(): void }; material?: { dispose(): void } | { dispose(): void }[] };
      x.geometry?.dispose();
      if (Array.isArray(x.material)) x.material.forEach((m) => m.dispose()); else x.material?.dispose();
    });
    overlayStates.delete(parent);
  };
  if (!e || !e.handler.buildOverlay) { drop(); return !!e; }
  const key = `${app.mode}|${e.ob.type}|${e.handler.overlayKey?.(e.ob) ?? Math.random()}`;
  let state = st;
  if (!state || state.key !== key || state.obId !== e.ob.id) {
    drop();
    const group = new ThreeGroup();
    group.matrixAutoUpdate = false;
    e.handler.buildOverlay(e.ob, group, renderer);
    parent.add(group);
    state = { key, obId: e.ob.id, group };
    overlayStates.set(parent, state);
  }
  state.group.matrix.copy(app.matrices.world(e.ob));
  state.group.matrixWorldNeedsUpdate = true;
  return true;
}
