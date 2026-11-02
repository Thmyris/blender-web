// Global application state: the document, edit mode, undo history, operator
// registry, reports, user preferences and evaluated-data caches.

import type { BObject, Doc, MeshData, Scene, Vec3 } from './core/types';
import { activeScene, createStartupDoc, isObjectSelectable, isObjectVisible, MatrixCache, sceneObjects, BLENDER_VERSION } from './core/scene';
import { evaluateModifiers, type EvalMesh } from './core/modifiers';
import { evaluateObjectAnimation } from './core/anim';
import { ensureArrays, rebuildEdges } from './core/mesh';

export type Mode = 'OBJECT' | 'EDIT' | 'SCULPT' | 'VERTEX_PAINT';

// ------------------------------------------------------------------ preferences

export interface Prefs {
  emulate3Button: boolean;
  emulateNumpad: boolean;
  selectMouse: 'RIGHT' | 'LEFT';
  orbitStyle: 'TURNTABLE' | 'TRACKBALL';
  invertZoomWheel: boolean;
  zoomToMouse: boolean;
  orbitAroundSelection: boolean;
  autoPerspective: boolean;
  smoothView: number;
  rotationAngle: number;
  undoSteps: number;
  showTooltips: boolean;
  showTooltipsPython: boolean;
  showSplash: boolean;
  uiScale: number;
  showViewName: boolean;
  showObjectInfo: boolean;
  showPlaybackFps: boolean;
  showMiniAxis: boolean;
  miniAxisSize: number;
  autoSave: boolean;
  autoSaveTime: number;
  keyframeInterpolation: 'BEZIER' | 'LINEAR' | 'CONSTANT';
  enterEditMode: boolean;
  alignNewObjects: 'WORLD' | 'VIEW';
  dragThreshold: number;
  showGridFloor: boolean;
  lastFiles: string[];
}

export const DEFAULT_PREFS: Prefs = {
  emulate3Button: false, emulateNumpad: false, selectMouse: 'RIGHT', orbitStyle: 'TURNTABLE', invertZoomWheel: false,
  zoomToMouse: false, orbitAroundSelection: false, autoPerspective: false, smoothView: 200, rotationAngle: 15,
  undoSteps: 32, showTooltips: true, showTooltipsPython: true, showSplash: true, uiScale: 1, showViewName: true,
  showObjectInfo: true, showPlaybackFps: true, showMiniAxis: true, miniAxisSize: 25, autoSave: true, autoSaveTime: 2,
  keyframeInterpolation: 'BEZIER', enterEditMode: false, alignNewObjects: 'WORLD', dragThreshold: 3, showGridFloor: true,
  lastFiles: [],
};

const PREFS_KEY = 'blender-web:userprefs';
const AUTOSAVE_KEY = 'blender-web:autosave';
const QUIT_KEY = 'blender-web:quit';

// ------------------------------------------------------------------ operators

export type OpResult = 'FINISHED' | 'CANCELLED' | 'RUNNING_MODAL' | 'PASS_THROUGH';

export interface OpPropDef {
  name: string;
  type: 'float' | 'int' | 'bool' | 'enum' | 'vector' | 'string' | 'bools';
  default: unknown;
  min?: number;
  max?: number;
  softMin?: number;
  softMax?: number;
  step?: number;
  precision?: number;
  subtype?: 'NONE' | 'DISTANCE' | 'ANGLE' | 'FACTOR' | 'PERCENTAGE' | 'XYZ' | 'TRANSLATION' | 'EULER';
  items?: [string, string][];
  size?: number;
  hidden?: boolean;
  description?: string;
}

export type OpProps = Record<string, unknown>;

/** Context an operator runs in. `area` is the screen area (editor) the operator was invoked from. */
export interface OpContext {
  app: App;
  area?: AreaLike | null;
  event?: MouseEvent | KeyboardEvent | PointerEvent | null;
}

export interface OperatorDef {
  id: string;
  label: string;
  description?: string;
  icon?: string;
  /** Push an undo step when finished. */
  undo?: boolean;
  /** Show in the redo ("last operator") panel and log to the Info editor. */
  register?: boolean;
  props?: Record<string, OpPropDef>;
  poll?: (ctx: OpContext) => boolean;
  /** Interactive entry point. Falls back to `exec`. */
  invoke?: (ctx: OpContext, props: OpProps) => OpResult | Promise<OpResult>;
  exec?: (ctx: OpContext, props: OpProps) => OpResult | Promise<OpResult>;
  /** Optional custom drawing of the redo panel. */
  drawRedo?: unknown;
}

/** Minimal interface the App needs from a screen area (avoids a circular import). */
export interface AreaLike {
  id: string;
  type: string;
  editor: unknown;
}

export interface ScreenLike {
  areas(): AreaLike[];
  refresh(flags: Set<string>): void;
  areaUnderMouse(): AreaLike | null;
  setLayout?(name: string): void;
}

export interface Report {
  type: 'INFO' | 'WARNING' | 'ERROR' | 'OPERATOR' | 'PROPERTY';
  text: string;
  time: number;
}

export interface ModalHandler {
  /** Return true when the event was consumed. */
  onEvent(e: Event): boolean;
  cancel(): void;
  /** Header text shown while running (e.g. "D: 1.0000 along global X"). */
  status?: () => string;
  cursor?: string;
}

interface UndoStep {
  name: string;
  state: string;
}

interface LastOp {
  def: OperatorDef;
  props: OpProps;
  ctx: OpContext;
  /** Index into the undo stack of the state from before the operator ran. */
  undoIndex: number;
}

// ------------------------------------------------------------------ app

type Listener = (flags: Set<string>) => void;

export class App {
  doc: Doc;
  mode: Mode = 'OBJECT';
  editObject: string | null = null;
  prefs: Prefs;
  screen: ScreenLike | null = null;
  reports: Report[] = [];
  operators = new Map<string, OperatorDef>();
  modal: ModalHandler | null = null;
  lastOp: LastOp | null = null;
  matrices: MatrixCache;
  playing: 0 | 1 | -1 = 0;
  /** Mouse position in window coordinates (updated globally). */
  mouse = { x: 0, y: 0 };
  /** Clipboard for copy/paste of single values when hovering fields. */
  valueClipboard: unknown = null;
  /** Viewport-only state that is not stored in the file. */
  fps = 0;

  private undoStack: UndoStep[] = [];
  private undoIndex = -1;
  private listeners: Listener[] = [];
  private pendingFlags = new Set<string>();
  private refreshScheduled = false;
  private evalCache = new Map<string, { key: string; mesh: EvalMesh }>();
  private dataVersion = new Map<string, number>();
  private playHandle = 0;
  private autosaveTimer = 0;
  dirty = false;

  constructor() {
    this.doc = createStartupDoc();
    this.prefs = { ...DEFAULT_PREFS, ...this.loadPrefs() };
    this.matrices = new MatrixCache(this.doc);
    this.pushUndo('Original');
    this.setupAutosave();
    window.addEventListener('beforeunload', () => {
      try { localStorage.setItem(QUIT_KEY, JSON.stringify(this.doc)); } catch { /* storage full */ }
    });
  }

  // ---------------------------------------------------------------- context helpers

  get scene(): Scene { return activeScene(this.doc); }

  get activeObject(): BObject | null {
    const id = this.scene.activeObject;
    return id ? this.doc.objects[id] ?? null : null;
  }

  set activeObject(ob: BObject | null) { this.scene.activeObject = ob ? ob.id : null; }

  objects(): BObject[] { return sceneObjects(this.doc, this.scene); }

  visibleObjects(layers?: boolean[]): BObject[] { return this.objects().filter((o) => isObjectVisible(this.scene, o, layers)); }

  selectedObjects(): BObject[] { return this.objects().filter((o) => o.select && isObjectVisible(this.scene, o)); }

  selectableObjects(layers?: boolean[]): BObject[] { return this.objects().filter((o) => isObjectSelectable(this.scene, o, layers)); }

  get editMesh(): MeshData | null {
    if (this.mode !== 'EDIT' || !this.editObject) return null;
    const ob = this.doc.objects[this.editObject];
    return ob && ob.type === 'MESH' && ob.data ? this.doc.meshes[ob.data] ?? null : null;
  }

  /** Object being sculpted (Sculpt Mode). */
  get sculptObj(): BObject | null {
    return this.mode === 'SCULPT' && this.editObject ? this.doc.objects[this.editObject] ?? null : null;
  }

  /** Object being vertex painted. */
  get paintObj(): BObject | null {
    return this.mode === 'VERTEX_PAINT' && this.editObject ? this.doc.objects[this.editObject] ?? null : null;
  }

  get editObj(): BObject | null {
    return this.mode === 'EDIT' && this.editObject ? this.doc.objects[this.editObject] ?? null : null;
  }

  meshOf(ob: BObject | null | undefined): MeshData | null {
    return ob && ob.type === 'MESH' && ob.data ? this.doc.meshes[ob.data] ?? null : null;
  }

  selectObject(ob: BObject, select = true): void {
    if (select && ob.hideSelect) return;
    ob.select = select;
  }

  deselectAll(): void { for (const o of this.objects()) o.select = false; }

  // ---------------------------------------------------------------- notifications

  onChange(fn: Listener): () => void {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter((l) => l !== fn); };
  }

  /**
   * Notify editors that something changed. Flags: 'scene', 'select', 'frame', 'mode', 'data', 'geometry',
   * 'render', 'screen', 'prefs', 'view', 'reports'. Refresh happens once per animation frame.
   */
  notify(...flags: string[]): void {
    for (const f of flags.length ? flags : ['all']) this.pendingFlags.add(f);
    if (flags.some((f) => f !== 'view' && f !== 'reports' && f !== 'screen' && f !== 'prefs')) {
      this.matrices.clear();
      this.dirty = true;
    }
    if (this.refreshScheduled) return;
    this.refreshScheduled = true;
    requestAnimationFrame(() => this.flush());
  }

  /** Run pending refreshes synchronously. */
  flush(): void {
    this.refreshScheduled = false;
    const flags = this.pendingFlags;
    this.pendingFlags = new Set();
    if (!flags.size) return;
    this.matrices.clear();
    this.screen?.refresh(flags);
    for (const l of this.listeners) l(flags);
  }

  /** Mark mesh geometry as changed so evaluated meshes are rebuilt. */
  tagGeometry(meshId: string | null | undefined): void {
    if (!meshId) return;
    this.dataVersion.set(meshId, (this.dataVersion.get(meshId) ?? 0) + 1);
    this.notify('geometry');
  }

  tagAllGeometry(): void {
    for (const id of Object.keys(this.doc.meshes)) this.dataVersion.set(id, (this.dataVersion.get(id) ?? 0) + 1);
    this.evalCache.clear();
    this.notify('geometry');
  }

  /** Mesh with modifiers applied (cached). */
  evalMesh(ob: BObject, render = false): EvalMesh | null {
    const md = this.meshOf(ob);
    if (!md) return null;
    const editMode = this.mode === 'EDIT' && this.editObject === ob.id;
    const timeDependent = ob.modifiers.some((m) => m.type === 'WAVE' || m.type === 'BUILD');
    const key = [md.id, this.dataVersion.get(md.id) ?? 0, md.verts.length, md.faces.length, JSON.stringify(ob.modifiers), render, editMode, timeDependent ? this.scene.frameCurrent : 0].join('|');
    const cacheKey = `${ob.id}|${render}`;
    const hit = this.evalCache.get(cacheKey);
    if (hit && hit.key === key) return hit.mesh;
    const mesh = evaluateModifiers(md, ob.modifiers, { frame: this.scene.frameCurrent, render, editMode });
    this.evalCache.set(cacheKey, { key, mesh });
    return mesh;
  }

  // ---------------------------------------------------------------- undo

  private snapshot(): string {
    return JSON.stringify({ doc: this.doc, mode: this.mode, editObject: this.editObject });
  }

  pushUndo(name: string): void {
    this.undoStack = this.undoStack.slice(0, this.undoIndex + 1);
    this.undoStack.push({ name, state: this.snapshot() });
    const max = Math.max(1, this.prefs?.undoSteps ?? 32) + 1;
    while (this.undoStack.length > max) this.undoStack.shift();
    this.undoIndex = this.undoStack.length - 1;
    this.dirty = true;
  }

  private restore(state: string): void {
    const s = JSON.parse(state) as { doc: Doc; mode: Mode; editObject: string | null };
    this.doc = s.doc;
    this.mode = s.mode;
    this.editObject = s.editObject;
    this.matrices = new MatrixCache(this.doc);
    this.evalCache.clear();
    this.tagAllGeometry();
    this.notify('all');
  }

  undo(): boolean {
    if (this.modal) return false;
    if (this.undoIndex <= 0) { this.report('WARNING', 'No more steps to undo'); return false; }
    this.undoIndex--;
    this.restore(this.undoStack[this.undoIndex].state);
    this.lastOp = null;
    return true;
  }

  redo(): boolean {
    if (this.modal) return false;
    if (this.undoIndex >= this.undoStack.length - 1) { this.report('WARNING', 'No more steps to redo'); return false; }
    this.undoIndex++;
    this.restore(this.undoStack[this.undoIndex].state);
    this.lastOp = null;
    return true;
  }

  undoHistory(): { name: string; index: number; current: boolean }[] {
    return this.undoStack.map((s, i) => ({ name: s.name, index: i, current: i === this.undoIndex }));
  }

  undoTo(index: number): void {
    if (index < 0 || index >= this.undoStack.length) return;
    this.undoIndex = index;
    this.restore(this.undoStack[index].state);
    this.lastOp = null;
  }

  /** Reset the undo history (used after loading a file). */
  resetUndo(name = 'Original'): void {
    this.undoStack = [];
    this.undoIndex = -1;
    this.lastOp = null;
    this.pushUndo(name);
  }

  // ---------------------------------------------------------------- documents

  loadDoc(doc: Doc, filename = ''): void {
    if (this.modal) this.modal.cancel();
    this.doc = doc;
    this.doc.filename = filename || doc.filename || '';
    this.mode = 'OBJECT';
    this.editObject = null;
    // make sure topology arrays are consistent for older files
    for (const m of Object.values(this.doc.meshes)) { rebuildEdges(m); ensureArrays(m); }
    this.matrices = new MatrixCache(this.doc);
    this.evalCache.clear();
    this.resetUndo();
    this.dirty = false;
    this.evaluateAnimation();
    this.tagAllGeometry();
    this.notify('all');
  }

  newFile(): void {
    this.loadDoc(createStartupDoc(), '');
  }

  // ---------------------------------------------------------------- animation

  evaluateAnimation(): void {
    const f = this.scene.frameCurrent;
    for (const ob of Object.values(this.doc.objects)) if (ob.fcurves.length) evaluateObjectAnimation(ob, f);
  }

  setFrame(frame: number): void {
    const f = Math.round(frame);
    if (f === this.scene.frameCurrent && !this.playing) return;
    this.scene.frameCurrent = f;
    this.evaluateAnimation();
    this.notify('frame', 'scene');
  }

  play(direction: 1 | -1 = 1): void {
    if (this.playing) { this.stop(); return; }
    this.playing = direction;
    const sc = this.scene;
    let last = performance.now();
    let acc = 0;
    let frames = 0;
    let fpsTime = last;
    const step = (now: number) => {
      if (!this.playing) return;
      const s = this.scene;
      const frameDur = 1000 / (s.fps / (s.fpsBase || 1));
      acc += now - last;
      last = now;
      if (acc >= frameDur) {
        const n = s.syncMode === 'FRAME_DROP' ? Math.floor(acc / frameDur) : 1;
        acc = s.syncMode === 'FRAME_DROP' ? acc - n * frameDur : Math.min(acc - frameDur, frameDur);
        const start = s.usePreviewRange ? s.previewStart : s.frameStart;
        const end = s.usePreviewRange ? s.previewEnd : s.frameEnd;
        let f = s.frameCurrent + n * this.playing;
        if (f > end) f = start; else if (f < start) f = end;
        s.frameCurrent = f;
        this.evaluateAnimation();
        this.notify('frame', 'scene');
        frames++;
        if (now - fpsTime > 500) { this.fps = (frames * 1000) / (now - fpsTime); frames = 0; fpsTime = now; }
      }
      this.playHandle = requestAnimationFrame(step);
    };
    void sc;
    this.playHandle = requestAnimationFrame(step);
    this.notify('frame');
  }

  stop(restore = false, startFrame?: number): void {
    this.playing = 0;
    cancelAnimationFrame(this.playHandle);
    if (restore && startFrame !== undefined) this.setFrame(startFrame);
    this.notify('frame');
  }

  // ---------------------------------------------------------------- reports

  report(type: Report['type'], text: string): void {
    this.reports.push({ type, text, time: Date.now() });
    if (this.reports.length > 500) this.reports.shift();
    if (type === 'ERROR') console.error(text);
    this.notify('reports');
  }

  // ---------------------------------------------------------------- operators

  registerOperator(def: OperatorDef): void {
    this.operators.set(def.id, def);
  }

  operator(id: string): OperatorDef | undefined {
    return this.operators.get(id);
  }

  pollOperator(id: string, area?: AreaLike | null): boolean {
    const def = this.operators.get(id);
    if (!def) return false;
    try { return def.poll ? def.poll({ app: this, area: area ?? this.screen?.areaUnderMouse() ?? null }) : true; } catch { return false; }
  }

  defaultProps(def: OperatorDef, props: OpProps = {}): OpProps {
    const out: OpProps = {};
    for (const [k, p] of Object.entries(def.props ?? {})) out[k] = JSON.parse(JSON.stringify(p.default ?? null));
    return { ...out, ...props };
  }

  /**
   * Call an operator. `invoke` is used when interactive (the default); otherwise `exec`.
   * Modal operators finish later by calling `finishOperator`.
   */
  async callOperator(id: string, props: OpProps = {}, opts: { area?: AreaLike | null; event?: OpContext['event']; exec?: boolean } = {}): Promise<OpResult> {
    const def = this.operators.get(id);
    if (!def) { this.report('ERROR', `Operator "${id}" not found`); return 'CANCELLED'; }
    if (this.modal && !id.startsWith('wm.') && !id.startsWith('screen.')) return 'CANCELLED';
    const ctx: OpContext = { app: this, area: opts.area ?? this.screen?.areaUnderMouse() ?? null, event: opts.event ?? null };
    if (def.poll && !def.poll(ctx)) {
      this.report('WARNING', `Operator ${def.label}: context is incorrect`);
      return 'CANCELLED';
    }
    const full = this.defaultProps(def, props);
    const undoIndex = this.undoIndex;
    let res: OpResult;
    try {
      const fn = !opts.exec && def.invoke ? def.invoke : def.exec;
      if (!fn) return 'CANCELLED';
      res = await fn(ctx, full);
    } catch (err) {
      console.error(err);
      this.report('ERROR', `${def.label}: ${(err as Error).message}`);
      return 'CANCELLED';
    }
    if (res === 'FINISHED') this.finishOperator(def, full, ctx, undoIndex);
    return res;
  }

  /** Bookkeeping when an operator has finished: undo push, redo panel, info log. */
  finishOperator(def: OperatorDef, props: OpProps, ctx: OpContext, undoIndex = this.undoIndex): void {
    if (def.undo) {
      this.pushUndo(def.label);
      if (def.register) this.lastOp = { def, props: JSON.parse(JSON.stringify(props)), ctx, undoIndex };
    }
    if (def.register) this.report('OPERATOR', formatOperatorCall(def, props));
    this.notify('all');
  }

  /** Re-run the last operator with changed properties (the "Adjust Last Operation" panel). */
  async redoLast(props: OpProps): Promise<void> {
    const last = this.lastOp;
    if (!last || !last.def.exec) return;
    const step = this.undoStack[last.undoIndex];
    if (!step) return;
    this.undoStack = this.undoStack.slice(0, last.undoIndex + 1);
    this.undoIndex = last.undoIndex;
    const s = JSON.parse(step.state) as { doc: Doc; mode: Mode; editObject: string | null };
    this.doc = s.doc;
    this.mode = s.mode;
    this.editObject = s.editObject;
    this.matrices = new MatrixCache(this.doc);
    this.evalCache.clear();
    this.tagAllGeometry();
    try {
      const res = await last.def.exec(last.ctx, props);
      if (res === 'FINISHED') {
        this.pushUndo(last.def.label);
        this.lastOp = { ...last, props: JSON.parse(JSON.stringify(props)) };
        this.report('OPERATOR', formatOperatorCall(last.def, props));
      }
    } catch (err) {
      console.error(err);
      this.report('ERROR', (err as Error).message);
    }
    this.notify('all');
  }

  /** Run a modal handler: all input goes to it until it ends. */
  startModal(handler: ModalHandler): void {
    if (this.modal) this.modal.cancel();
    this.modal = handler;
    this.notify('view', 'screen');
  }

  endModal(handler: ModalHandler): void {
    if (this.modal === handler) this.modal = null;
    this.notify('view', 'screen');
  }

  // ---------------------------------------------------------------- preferences

  private loadPrefs(): Partial<Prefs> {
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      return raw ? (JSON.parse(raw) as Partial<Prefs>) : {};
    } catch { return {}; }
  }

  savePrefs(): void {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs)); this.report('INFO', 'Saved user preferences'); } catch { this.report('ERROR', 'Could not save user preferences'); }
  }

  resetPrefs(): void {
    this.prefs = { ...DEFAULT_PREFS };
    this.notify('prefs', 'all');
  }

  // ---------------------------------------------------------------- autosave

  private setupAutosave(): void {
    window.clearInterval(this.autosaveTimer);
    this.autosaveTimer = window.setInterval(() => {
      if (!this.prefs.autoSave || !this.dirty) return;
      this.writeAutosave();
    }, Math.max(1, this.prefs.autoSaveTime) * 60 * 1000);
  }

  writeAutosave(): void {
    try { localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(this.doc)); } catch { /* ignore quota errors */ }
  }

  readAutosave(): Doc | null {
    try { const raw = localStorage.getItem(AUTOSAVE_KEY); return raw ? (JSON.parse(raw) as Doc) : null; } catch { return null; }
  }

  readQuitSession(): Doc | null {
    try { const raw = localStorage.getItem(QUIT_KEY); return raw ? (JSON.parse(raw) as Doc) : null; } catch { return null; }
  }

  restartAutosave(): void { this.setupAutosave(); }

  // ---------------------------------------------------------------- misc helpers

  /** Statistics string for the Info header, e.g. "v2.79 | Verts:8 | Faces:6 | Tris:12 | Objects:1/3 | Lamps:0/1 | Cube". */
  stats(): string {
    const parts = [`v${BLENDER_VERSION}`];
    const ob = this.activeObject;
    const em = this.editMesh;
    if (em) {
      const sv = em.vsel.filter(Boolean).length, se = em.esel.filter(Boolean).length, sf = em.fsel.filter(Boolean).length;
      let tris = 0;
      for (const f of em.faces) tris += Math.max(0, f.length - 2);
      parts.push(`Verts:${sv}/${em.verts.length}`, `Edges:${se}/${em.edges.length}`, `Faces:${sf}/${em.faces.length}`, `Tris:${tris}`);
    } else {
      let v = 0, f = 0, t = 0;
      const vis = this.visibleObjects();
      for (const o of vis) {
        const m = o.type === 'MESH' ? this.evalMesh(o) : null;
        if (!m) continue;
        v += m.verts.length; f += m.faces.length;
        for (const p of m.faces) t += Math.max(0, p.length - 2);
      }
      const lamps = vis.filter((o) => o.type === 'LAMP');
      parts.push(`Verts:${v}`, `Faces:${f}`, `Tris:${t}`, `Objects:${vis.filter((o) => o.select).length}/${vis.length}`,
        `Lamps:${lamps.filter((o) => o.select).length}/${lamps.length}`);
    }
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    if (mem) parts.push(`Mem:${(mem.usedJSHeapSize / 1048576).toFixed(2)}M`);
    if (ob) parts.push(ob.name);
    return parts.join(' | ');
  }

  /** Point under which new objects are added (the 3D cursor). */
  get cursor(): Vec3 { return this.scene.cursor; }
}

/** Python-style representation of an operator call, as shown in Blender's Info editor. */
export function formatOperatorCall(def: OperatorDef, props: OpProps): string {
  const args: string[] = [];
  for (const [k, p] of Object.entries(def.props ?? {})) {
    if (p.hidden) continue;
    const v = props[k];
    args.push(`${k}=${pyRepr(v, p)}`);
  }
  return `bpy.ops.${def.id}(${args.join(', ')})`;
}

export function pyRepr(v: unknown, p?: OpPropDef): string {
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'number') {
    if (p?.type === 'int') return String(Math.round(v));
    return Number.isInteger(v) ? String(v) : String(+v.toFixed(6));
  }
  if (typeof v === 'string') return `'${v}'`;
  if (Array.isArray(v)) return `(${v.map((x) => pyRepr(x, p?.type === 'bools' ? undefined : { ...(p ?? { name: '', default: 0 }), type: 'float' })).join(', ')})`;
  if (v === null || v === undefined) return 'None';
  return String(v);
}

export let app: App;

export function createApp(): App {
  app = new App();
  return app;
}
