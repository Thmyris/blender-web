// `bpy` shim support for Cycles: scene.render.engine and scene.cycles.<setting> (snake_case
// Python names map onto the camelCase fields of scene.cycles).

import { app } from '../../app';
import type { CyclesSceneSettings } from '../../core/types';
import { ensureSceneSettings, SCENE_DEFAULTS } from './settings';

const ENGINES = ['BLENDER_RENDER', 'BLENDER_GAME', 'CYCLES'];

function camel(name: string): keyof CyclesSceneSettings {
  const key = name.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase()) as keyof CyclesSceneSettings;
  if (!(key in SCENE_DEFAULTS)) throw new Error(`'CyclesRenderSettings' object has no attribute '${name}'`);
  return key;
}

export function cyclesPyGet(name: string): unknown {
  const v = ensureSceneSettings(app.scene)[camel(name)];
  return v;
}

export function cyclesPySet(name: string, value: unknown): void {
  const key = camel(name);
  const c = ensureSceneSettings(app.scene) as unknown as Record<string, unknown>;
  const def = SCENE_DEFAULTS[key];
  if (typeof def === 'number') c[key] = Number(value);
  else if (typeof def === 'boolean') c[key] = !!value;
  else c[key] = String(value);
}

/** Validate and set scene.render.engine. */
export function setEngine(value: unknown): void {
  const v = String(value);
  if (!ENGINES.includes(v)) throw new TypeError(`bpy_struct: item.attr = val: enum "${v}" not found in ('BLENDER_RENDER', 'BLENDER_GAME', 'CYCLES')`);
  if (v === 'BLENDER_GAME') throw new Error('The Blender Game engine is not available in blender-web');
  app.scene.render.engine = v as CyclesEngine;
}

type CyclesEngine = 'BLENDER_RENDER' | 'BLENDER_GAME' | 'CYCLES';

/** Python side: `scene.cycles`. */
export const CYCLES_PY = `
class _CyclesSettings:
    def __getattr__(self, a):
        v = _bw.cycles_get(a)
        return v.to_py() if hasattr(v, 'to_py') else v
    def __setattr__(self, a, v): _bw.cycles_set(a, v)
    def __repr__(self): return 'bpy.data.scenes["%s"].cycles' % _bw.scene_get('name')
`;
