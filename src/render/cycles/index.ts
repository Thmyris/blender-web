// Cycles render engine for blender-web: registers the engine with the F12 renderer and the
// operator hooks it needs. The path tracer lives in tracer.ts (WebGL 2) + shaders.ts, the scene
// export in build.ts, settings and Blender Internal derivation in settings.ts, the viewport
// integration in viewport.ts and the Properties panels in src/editors/properties/cycles.ts.

import { app, operatorHooks } from '../../app';
import { initNewCyclesMaterial } from '../../editors/properties/cycles';
import { materialSlots } from '../../core/matslots';
import { isCycles } from './settings';
import './engine';

let initialised = false;

export function initCycles(): void {
  if (initialised) return;
  initialised = true;
  // like Blender 2.79, new materials get a node tree (here a Principled BSDF) while Cycles is the engine
  operatorHooks.push({
    after(def, _ctx, _token, result) {
      if (def.id !== 'material.new' || result !== 'FINISHED' || !isCycles(app.scene)) return;
      const ob = app.activeObject;
      const slots = materialSlots(app.doc, ob);
      const ma = ob && slots ? app.doc.materials[slots[ob.activeMaterialIndex] ?? ''] : null;
      if (ma) initNewCyclesMaterial(ma);
    },
  });
}
