// The object-data ID template (`template_ID(ob, "data")`) shared by the mesh, camera and
// lamp data tabs.

import { app } from '../../app';
import { newId, renameData, uniqueNameIn } from '../../core/scene';
import type { DataCollection } from '../../core/types';
import type { Layout } from '../../ui/layout';
import { cloneJSON, ob, usersOf } from './common';

type ObDataColl = 'meshes' | 'cameras' | 'lamps';

const PREFIX: Record<ObDataColl, string> = { meshes: 'ME', cameras: 'CA', lamps: 'LA' };

/** `template_ID(ob, "data")`: browse / rename / users / fake user / new (copy of current). */
export function objectDataTemplate(l: Layout, coll: ObDataColl, ic: string, title: string): void {
  const items = () => app.doc[coll] as Record<string, { id: string; name: string; fakeUser: boolean }>;
  const cur = () => { const o = ob(); return o?.data ? items()[o.data] ?? null : null; };
  const editLocked = () => {
    if (coll === 'meshes' && app.mode === 'EDIT') { app.report('WARNING', 'Cannot change mesh data in Edit Mode'); return true; }
    return false;
  };
  const sp = l.split(0.65);
  sp.column().idTemplate({
    icon: ic, title,
    items: () => Object.values(items()).map((d) => ({ id: d.id, name: d.name, icon: ic })),
    get: () => ob()?.data ?? null,
    set: (id) => {
      const o = ob();
      if (!o || !id || editLocked()) return;
      o.data = id;
      if (coll === 'meshes') app.tagGeometry(id);
    },
    name: () => cur()?.name ?? '',
    rename: (n) => { const d = cur(); if (d) renameData(app.doc, coll as DataCollection, d.id, n); },
    users: () => usersOf(coll, ob()?.data),
    fakeUser: { get: () => !!cur()?.fakeUser, set: (v) => { const d = cur(); if (d) d.fakeUser = v; } },
    onNew: () => {
      const o = ob();
      const d = cur();
      if (!o || !d || editLocked()) return;
      // Blender's "+" here makes a single-user copy of the current data
      const copy = cloneJSON(d);
      copy.id = newId(app.doc, PREFIX[coll]);
      copy.name = uniqueNameIn(app.doc, coll, d.name);
      copy.fakeUser = false;
      items()[copy.id] = copy;
      o.data = copy.id;
      if (coll === 'meshes') app.tagGeometry(copy.id);
    },
  });
  sp.column();
}
