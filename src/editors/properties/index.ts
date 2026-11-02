// The Properties editor (Blender 2.79's "Buttons" space): a header with one tab per
// context (Render, Render Layers, Scene, World, Object, Constraints, Modifiers, Data,
// Material, Texture, Particles, Physics), the context path breadcrumb and one scrolling
// panel region whose panels depend on the current context.

import { app } from '../../app';
import { Editor, registerEditor } from '../../screen/editor';
import type { Area } from '../../screen/screen';
import type { BObject } from '../../core/types';
import { h, clear } from '../../ui/dom';
import { icon, objectDataIcon } from '../../ui/icons';
import { setUnitSettings } from '../../ui/format';
import { PanelRegion, type EnumItem, type Layout, type PanelDef } from '../../ui/layout';
import {
  activeMaterial, activeTexture, cameraData, flatPanel, lampData, meshData, worldData, type PropsCtx,
} from './common';
import { renderPanels } from './render';
import { renderLayerPanels } from './renderlayers';
import { scenePanels } from './scene';
import { worldPanels } from './world';
import { objectPanels } from './object';
import { constraintPanels } from './constraints';
import { modifierPanels } from './modifiers';
import { dataPanels } from './data';
import { hasMaterialSlots } from '../../core/matslots';
import { materialPanels } from './material';
import { texturePanels } from './texture';
import { particlePanels, physicsPanels } from './physics';
import { cyclesPanels } from './cycles';

export type ContextId =
  | 'RENDER' | 'RENDER_LAYER' | 'SCENE' | 'WORLD' | 'OBJECT' | 'CONSTRAINT' | 'MODIFIER' | 'DATA'
  | 'MATERIAL' | 'TEXTURE' | 'PARTICLES' | 'PHYSICS';

interface ContextDef {
  id: ContextId;
  label: string;
  description: string;
  icon: (ob: BObject | null) => string;
  poll: (ob: BObject | null) => boolean;
  panels: (ctx: PropsCtx) => PanelDef[];
}

const always = () => true;
const hasOb = (o: BObject | null) => !!o;
const isMesh = (o: BObject | null) => o?.type === 'MESH';
/** Types with a modifier stack (meshes, curves, surfaces and text, like 2.79). */
const hasModifiers = (o: BObject | null) => !!o && ['MESH', 'CURVE', 'SURFACE', 'FONT'].includes(o.type);

/** Contexts in Blender 2.79's order. */
const CONTEXTS: ContextDef[] = [
  { id: 'RENDER', label: 'Render', description: 'Render', icon: () => 'SCENE', poll: always, panels: cyclesPanels('RENDER', renderPanels) },
  { id: 'RENDER_LAYER', label: 'Render Layers', description: 'Render layer', icon: () => 'RENDERLAYERS', poll: always, panels: cyclesPanels('RENDER_LAYER', renderLayerPanels) },
  { id: 'SCENE', label: 'Scene', description: 'Scene', icon: () => 'SCENE_DATA', poll: always, panels: scenePanels },
  { id: 'WORLD', label: 'World', description: 'World', icon: () => 'WORLD', poll: always, panels: cyclesPanels('WORLD', worldPanels) },
  { id: 'OBJECT', label: 'Object', description: 'Object', icon: () => 'OBJECT_DATA', poll: hasOb, panels: objectPanels },
  { id: 'CONSTRAINT', label: 'Constraints', description: 'Object constraints', icon: () => 'CONSTRAINT', poll: hasOb, panels: constraintPanels },
  { id: 'MODIFIER', label: 'Modifiers', description: 'Modifiers', icon: () => 'MODIFIER', poll: hasModifiers, panels: modifierPanels },
  { id: 'DATA', label: 'Data', description: 'Object data', icon: (o) => objectDataIcon(o?.type ?? 'MESH'), poll: hasOb, panels: cyclesPanels('DATA', dataPanels) },
  { id: 'MATERIAL', label: 'Material', description: 'Material', icon: () => 'MATERIAL', poll: hasMaterialSlots, panels: cyclesPanels('MATERIAL', materialPanels) },
  { id: 'TEXTURE', label: 'Texture', description: 'Texture', icon: () => 'TEXTURE', poll: always, panels: texturePanels },
  { id: 'PARTICLES', label: 'Particles', description: 'Particle', icon: () => 'PARTICLES', poll: isMesh, panels: particlePanels },
  { id: 'PHYSICS', label: 'Physics', description: 'Physics', icon: () => 'PHYSICS', poll: hasOb, panels: physicsPanels },
];

export class PropertiesEditor extends Editor {
  static readonly TYPE = 'PROPERTIES';
  private region: PanelRegion;
  private ctx: PropsCtx;

  constructor(area: Area, state: Record<string, unknown>) {
    super(area, state);
    state.context ??= 'RENDER';
    state.pinned ??= false;
    this.ctx = { area, state };
    this.region = new PanelRegion(() => this.panels(), area, `${area.id}:props:`);
    this.region.el.style.background = 'var(--region-bg)';
    this.main.append(this.region.el);
  }

  get type(): string { return PropertiesEditor.TYPE; }

  // ---------------------------------------------------------------- context

  private available(): ContextDef[] {
    const o = app.activeObject;
    return CONTEXTS.filter((c) => c.poll(o));
  }

  /** The context actually shown: the user's choice when available, otherwise a sensible fallback. */
  get context(): ContextId {
    const want = this.state.context as ContextId;
    const avail = this.available();
    if (avail.some((c) => c.id === want)) return want;
    // object based tabs fall back to the Object tab (or Scene when nothing is active)
    if (avail.some((c) => c.id === 'OBJECT')) return 'OBJECT';
    return 'SCENE';
  }

  // ---------------------------------------------------------------- header

  override headerKey(): string {
    const o = app.activeObject;
    return `${this.available().map((c) => `${c.id}:${c.icon(o)}`).join(',')}`;
  }

  drawHeader(l: Layout): void {
    const o = app.activeObject;
    const items: EnumItem[] = this.available().map((c) => ({ id: c.id, label: c.label, icon: c.icon(o), description: c.description }));
    const row = l.prop({
      kind: 'enum', name: 'Context', items, undo: false, notify: ['screen'],
      description: 'Type of active data to display and edit', python: 'bpy.types.SpaceProperties.context',
      get: () => this.context,
      set: (v) => { this.state.context = v; },
    }, { expand: true, iconOnly: true });
    row.style.flex = '0 0 auto';
  }

  // ---------------------------------------------------------------- panels

  private panels(): PanelDef[] {
    const c = this.context;
    const def = CONTEXTS.find((x) => x.id === c) ?? CONTEXTS[0];
    return [this.pathPanel(c), ...def.panels(this.ctx)];
  }

  /** Context path breadcrumb (e.g. "Scene > Cube > Cube") with the pin toggle on the right. */
  private pathPanel(c: ContextId): PanelDef {
    const o = app.activeObject;
    return {
      id: 'context_path',
      label: '',
      noHeader: true,
      // the structural key of the whole region: context + active object (and its type)
      key: () => `${c}|${o?.id ?? ''}|${o?.type ?? ''}|${app.mode}`,
      draw: (l) => {
        flatPanel(l);
        l.el.style.padding = '2px 4px 0 4px';
        const row = l.row();
        const path = h('div', { style: { display: 'flex', alignItems: 'center', gap: '2px', minWidth: '0', overflow: 'hidden', flex: '1 1 auto', color: '#000' } });
        let lastKey = '';
        row.custom(path, () => {
          const parts = this.pathParts(c);
          const k = JSON.stringify(parts);
          if (k === lastKey) return;
          lastKey = k;
          clear(path);
          parts.forEach(([ic, name], i) => {
            if (i > 0) path.append(h('span', { style: { margin: '0 4px', opacity: '0.7', flex: '0 0 auto' } }, '›'));
            const ie = icon(ic);
            ie.style.flex = '0 0 auto';
            path.append(ie, h('span', { style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: '0' } }, name));
          });
        });
        // Pin: stored per area (Blender pins the ID shown; here it only toggles visually)
        const pin = row.prop({
          kind: 'bool', name: 'Pin ID', description: 'Use the pinned context (pinning is not functional in blender-web)', undo: false, notify: ['screen'],
          get: () => !!this.state.pinned, set: (v) => { this.state.pinned = v; },
        }, { iconOnly: true, icon: 'UNPINNED', iconOn: 'PINNED', emboss: false });
        pin.classList.add('fixed');
      },
    };
  }

  /** [icon, name] pairs of the context path. */
  private pathParts(c: ContextId): [string, string][] {
    const sc = app.scene;
    const parts: [string, string][] = [['SCENE_DATA', sc?.name ?? '']];
    const o = app.activeObject;
    switch (c) {
      case 'RENDER': case 'SCENE': break;
      case 'RENDER_LAYER': parts.push(['RENDERLAYERS', 'RenderLayer']); break;
      case 'WORLD': { const w = worldData(); if (w) parts.push(['WORLD', w.name]); break; }
      case 'TEXTURE': {
        if (o) parts.push(['OBJECT_DATA', o.name]);
        const ma = activeMaterial();
        if (ma) parts.push(['MATERIAL', ma.name]);
        const t = activeTexture();
        if (t) parts.push(['TEXTURE', t.name]);
        break;
      }
      default: {
        if (!o) break;
        parts.push(['OBJECT_DATA', o.name]);
        if (c === 'DATA') {
          const d = meshData() ?? cameraData() ?? lampData();
          if (d) parts.push([objectDataIcon(o.type), d.name]);
        } else if (c === 'MATERIAL') {
          const ma = activeMaterial();
          if (ma) parts.push(['MATERIAL', ma.name]);
        }
      }
    }
    return parts;
  }

  // ---------------------------------------------------------------- lifecycle

  override mount(): void {
    setUnitSettings(app.scene.unit);
    this.region.refresh(true);
  }

  override refresh(_flags: Set<string>): void {
    // number fields format lengths/rotations with the scene's unit settings
    setUnitSettings(app.scene.unit);
    this.region.refresh();
  }

  override resize(): void {
    // previews depend on the region width; their update() redraws on size change
    this.region.refresh();
  }
}

registerEditor({
  type: PropertiesEditor.TYPE,
  label: 'Properties',
  icon: 'BUTS',
  create: (area, state) => new PropertiesEditor(area as Area, state),
});
