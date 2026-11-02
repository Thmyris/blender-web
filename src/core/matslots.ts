// Material slots of any object type with geometry: meshes, curves / surfaces, metaballs and text.

import type { BObject, Doc } from './types';

/** The material slot list of an object's data (a live array), or null for types without materials. */
export function materialSlots(doc: Doc, ob: BObject | null | undefined): (string | null)[] | null {
  if (!ob) return null;
  switch (ob.type) {
    case 'MESH': return ob.data ? doc.meshes[ob.data]?.materials ?? null : null;
    case 'CURVE': case 'SURFACE': return ob.data ? doc.curves?.[ob.data]?.materials ?? null : null;
    case 'META': return ob.data ? doc.metaballs?.[ob.data]?.materials ?? null : null;
    case 'FONT': return ob.text ? (ob.text.materials ??= []) : null;
    default: return null;
  }
}

/** Object types that can have materials. */
export function hasMaterialSlots(ob: BObject | null | undefined): boolean {
  return !!ob && ['MESH', 'CURVE', 'SURFACE', 'META', 'FONT'].includes(ob.type);
}
