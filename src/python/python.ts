// Python scripting via Pyodide (CPython compiled to WebAssembly, loaded lazily
// from the jsDelivr CDN) with a small `bpy` compatibility layer that talks to the
// blender-web document through a JS bridge.

import { app } from '../app';
import type { BObject } from '../core/types';
import { insertKeyframe, ANIMATABLE } from '../core/anim';
import { newModifier, modifierDef } from '../core/modifiers';
import { renameData, createMaterial } from '../core/scene';
import { rebuildEdges, ensureArrays } from '../core/mesh';
import type { ModifierType } from '../core/types';

const PYODIDE_VERSION = '0.26.4';
/** CDN location of Pyodide; can be overridden with ?pyodide=<url> (e.g. a self-hosted copy). */
const PYODIDE_URL = (() => {
  const q = new URLSearchParams(location.search).get('pyodide');
  return q ? (q.endsWith('/') ? q : `${q}/`) : `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
})();

interface Pyodide {
  runPython(code: string): unknown;
  runPythonAsync(code: string): Promise<unknown>;
  registerJsModule(name: string, mod: object): void;
  globals: { get(name: string): unknown };
  FS: { writeFile(path: string, data: string): void };
}

let pyPromise: Promise<Pyodide> | null = null;
export let pythonStatus: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
export let pythonError = '';

const obByName = (name: string): BObject | undefined => Object.values(app.doc.objects).find((o) => o.name === name);
const toJs = (v: unknown): unknown => {
  const p = v as { toJs?: (o?: object) => unknown; destroy?: () => void } | null;
  if (p && typeof p.toJs === 'function') { const r = p.toJs({ dict_converter: Object.fromEntries }); p.destroy?.(); return r; }
  return v;
};

function changed(geometry = false): void {
  if (geometry) app.tagAllGeometry();
  app.notify('all');
}

/** Functions callable from Python as `_bw.<name>`. Values crossing the bridge are plain JS/JSON data. */
const bridge = {
  objects: () => app.objects().map((o) => o.name),
  all_objects: () => Object.values(app.doc.objects).map((o) => o.name),
  obj_get(name: string, attr: string): unknown {
    const o = obByName(name);
    if (!o) throw new Error(`Object "${name}" not found`);
    switch (attr) {
      case 'location': return o.location.slice();
      case 'rotation_euler': return o.rotation.slice();
      case 'scale': return o.scale.slice();
      case 'type': return o.type;
      case 'select': return o.select;
      case 'hide': return o.hide;
      case 'hide_select': return o.hideSelect;
      case 'hide_render': return o.hideRender;
      case 'layers': return o.layers.slice();
      case 'parent': return o.parent ? app.doc.objects[o.parent]?.name ?? null : null;
      case 'data': {
        if (!o.data) return null;
        const d = app.doc.meshes[o.data] ?? app.doc.cameras[o.data] ?? app.doc.lamps[o.data];
        return d ? d.name : null;
      }
      case 'modifiers': return o.modifiers.map((m) => [m.name, m.type]);
      case 'matrix_world': return app.matrices.world(o).toArray();
      case 'draw_type': return o.drawType;
      case 'show_name': return o.showName;
      case 'show_wire': return o.showWire;
      case 'show_x_ray': return o.showXRay;
      default: throw new Error(`'Object' object has no attribute '${attr}'`);
    }
  },
  obj_set(name: string, attr: string, value: unknown): void {
    const o = obByName(name);
    if (!o) throw new Error(`Object "${name}" not found`);
    const v = toJs(value);
    switch (attr) {
      case 'location': o.location = (v as number[]).slice(0, 3) as [number, number, number]; break;
      case 'rotation_euler': o.rotation = (v as number[]).slice(0, 3) as [number, number, number]; break;
      case 'scale': o.scale = (v as number[]).slice(0, 3) as [number, number, number]; break;
      case 'name': renameData(app.doc, 'objects', o.id, String(v)); break;
      case 'select': o.select = !!v; break;
      case 'hide': o.hide = !!v; break;
      case 'hide_select': o.hideSelect = !!v; break;
      case 'hide_render': o.hideRender = !!v; break;
      case 'layers': o.layers = (v as boolean[]).slice(0, 20).map(Boolean); break;
      case 'parent': { const p = v ? obByName(String(v)) : null; o.parent = p ? p.id : null; break; }
      case 'draw_type': o.drawType = String(v) as never; break;
      case 'show_name': o.showName = !!v; break;
      case 'show_wire': o.showWire = !!v; break;
      case 'show_x_ray': o.showXRay = !!v; break;
      default: throw new Error(`'Object' object attribute '${attr}' is read-only or unknown`);
    }
    changed();
  },
  active_object: () => app.activeObject?.name ?? null,
  set_active: (name: string | null) => { const o = name ? obByName(name) : null; app.activeObject = o ?? null; changed(); },
  selected: () => app.selectedObjects().map((o) => o.name),
  mode: () => (app.mode === 'EDIT' ? 'EDIT_MESH' : 'OBJECT'),
  scene_get(attr: string): unknown {
    const s = app.scene;
    switch (attr) {
      case 'name': return s.name;
      case 'frame_current': return s.frameCurrent;
      case 'frame_start': return s.frameStart;
      case 'frame_end': return s.frameEnd;
      case 'cursor_location': return s.cursor.slice();
      case 'camera': return s.camera ? app.doc.objects[s.camera]?.name ?? null : null;
      case 'resolution_x': return s.render.resolutionX;
      case 'resolution_y': return s.render.resolutionY;
      case 'resolution_percentage': return s.render.resolutionPercentage;
      case 'fps': return s.fps;
      case 'layers': return s.layers.slice();
      default: throw new Error(`'Scene' object has no attribute '${attr}'`);
    }
  },
  scene_set(attr: string, value: unknown): void {
    const s = app.scene;
    const v = toJs(value);
    switch (attr) {
      case 'name': s.name = String(v); break;
      case 'frame_current': app.setFrame(Number(v)); break;
      case 'frame_start': s.frameStart = Number(v); break;
      case 'frame_end': s.frameEnd = Number(v); break;
      case 'cursor_location': s.cursor = (v as number[]).slice(0, 3) as [number, number, number]; break;
      case 'camera': { const o = v ? obByName(String(v)) : null; s.camera = o ? o.id : null; break; }
      case 'resolution_x': s.render.resolutionX = Number(v); break;
      case 'resolution_y': s.render.resolutionY = Number(v); break;
      case 'resolution_percentage': s.render.resolutionPercentage = Number(v); break;
      case 'fps': s.fps = Number(v); break;
      case 'layers': s.layers = (v as boolean[]).slice(0, 20).map(Boolean); break;
      default: throw new Error(`'Scene' object attribute '${attr}' is read-only or unknown`);
    }
    changed();
  },
  op(id: string, kwargsJson: string): string {
    const def = app.operator(id);
    if (!def) throw new Error(`Calling operator "bpy.ops.${id}" error, could not be found`);
    const kwargs = JSON.parse(kwargsJson || '{}');
    const props = app.defaultProps(def, kwargs);
    const ctx = { app, area: null, event: null };
    if (def.poll && !def.poll(ctx)) throw new Error(`Operator bpy.ops.${id}.poll() failed, context is incorrect`);
    const fn = def.exec ?? def.invoke;
    if (!fn) return 'CANCELLED';
    const res = fn(ctx, props);
    if (res instanceof Promise) {
      void res.then((r) => { if (r === 'FINISHED') app.finishOperator(def, props, ctx); });
      return 'RUNNING_MODAL';
    }
    if (res === 'FINISHED') app.finishOperator(def, props, ctx);
    app.flush();
    return res;
  },
  ops_list: () => [...app.operators.keys()],
  mesh_names: () => Object.values(app.doc.meshes).map((m) => m.name),
  mesh_get(name: string): unknown {
    const m = Object.values(app.doc.meshes).find((x) => x.name === name);
    if (!m) throw new Error(`Mesh "${name}" not found`);
    return { verts: m.verts.map((v) => v.slice()), faces: m.faces.map((f) => f.slice()), edges: m.edges.map((e) => e.slice()), select: m.vsel.slice(), smooth: m.faceSmooth.slice() };
  },
  mesh_set_vert(name: string, i: number, co: unknown): void {
    const m = Object.values(app.doc.meshes).find((x) => x.name === name);
    if (!m || !m.verts[i]) throw new Error('vertex index out of range');
    m.verts[i] = (toJs(co) as number[]).slice(0, 3) as [number, number, number];
    app.tagGeometry(m.id);
    app.notify('all');
  },
  mesh_from_pydata(name: string, verts: unknown, edges: unknown, faces: unknown): void {
    const m = Object.values(app.doc.meshes).find((x) => x.name === name);
    if (!m) throw new Error(`Mesh "${name}" not found`);
    m.verts = (toJs(verts) as number[][]).map((v) => [v[0], v[1], v[2]]);
    m.faces = (toJs(faces) as number[][]).map((f) => f.slice());
    m.edges = (toJs(edges) as number[][]).map((e) => [Math.min(e[0], e[1]), Math.max(e[0], e[1])]);
    m.vsel = []; m.esel = []; m.fsel = []; m.faceSmooth = []; m.faceMat = [];
    rebuildEdges(m);
    ensureArrays(m);
    app.tagGeometry(m.id);
    app.notify('all');
  },
  material_names: () => Object.values(app.doc.materials).map((m) => m.name),
  material_new(name: string): string { const m = createMaterial(app.doc, name); changed(); return m.name; },
  material_get(name: string, attr: string): unknown {
    const m = Object.values(app.doc.materials).find((x) => x.name === name);
    if (!m) throw new Error(`Material "${name}" not found`);
    const map: Record<string, unknown> = { diffuse_color: m.diffuseColor, diffuse_intensity: m.diffuseIntensity, specular_color: m.specularColor, specular_intensity: m.specularIntensity, specular_hardness: m.specularHardness, emit: m.emit, alpha: m.alpha, use_transparency: m.useTransparency, use_shadeless: m.useShadeless, name: m.name };
    if (!(attr in map)) throw new Error(`'Material' object has no attribute '${attr}'`);
    return map[attr];
  },
  material_set(name: string, attr: string, value: unknown): void {
    const m = Object.values(app.doc.materials).find((x) => x.name === name);
    if (!m) throw new Error(`Material "${name}" not found`);
    const v = toJs(value);
    switch (attr) {
      case 'diffuse_color': m.diffuseColor = (v as number[]).slice(0, 3) as [number, number, number]; break;
      case 'diffuse_intensity': m.diffuseIntensity = Number(v); break;
      case 'specular_color': m.specularColor = (v as number[]).slice(0, 3) as [number, number, number]; break;
      case 'specular_intensity': m.specularIntensity = Number(v); break;
      case 'specular_hardness': m.specularHardness = Number(v); break;
      case 'emit': m.emit = Number(v); break;
      case 'alpha': m.alpha = Number(v); break;
      case 'use_transparency': m.useTransparency = !!v; break;
      case 'use_shadeless': m.useShadeless = !!v; break;
      case 'name': renameData(app.doc, 'materials', m.id, String(v)); break;
      default: throw new Error(`'Material' attribute '${attr}' is read-only or unknown`);
    }
    changed();
  },
  obj_materials(name: string): unknown {
    const o = obByName(name);
    const md = app.meshOf(o);
    return md ? md.materials.map((id) => (id ? app.doc.materials[id]?.name ?? null : null)) : [];
  },
  obj_material_append(name: string, mat: string | null): void {
    const o = obByName(name);
    const md = app.meshOf(o);
    if (!md) throw new Error('Object has no mesh data');
    const m = mat ? Object.values(app.doc.materials).find((x) => x.name === mat) : null;
    md.materials.push(m ? m.id : null);
    changed(true);
  },
  keyframe_insert(name: string, path: string, index: number, frame: number | null): boolean {
    const o = obByName(name);
    if (!o) throw new Error(`Object "${name}" not found`);
    const info = ANIMATABLE[path];
    if (!info) throw new Error(`keyframe_insert: property "${path}" not animatable in blender-web`);
    const f = frame ?? app.scene.frameCurrent;
    const idxs = index >= 0 ? [index] : info.size ? [0, 1, 2].slice(0, info.size) : [0];
    for (const i of idxs) insertKeyframe(o, path, i, f, undefined, app.prefs.keyframeInterpolation);
    changed();
    return true;
  },
  modifier_new(name: string, modName: string, type: string): string {
    const o = obByName(name);
    if (!o) throw new Error(`Object "${name}" not found`);
    const def = modifierDef(type);
    if (!def || !def.supported) throw new Error(`Modifier type "${type}" not available in blender-web`);
    const m = newModifier(type as ModifierType, o.modifiers);
    if (modName) m.name = modName;
    o.modifiers.push(m);
    changed(true);
    return m.name;
  },
  modifier_get(name: string, modName: string, attr: string): unknown {
    const o = obByName(name);
    const m = o?.modifiers.find((x) => x.name === modName);
    if (!m) throw new Error('modifier not found');
    return (m as Record<string, unknown>)[snakeToCamel(attr)];
  },
  modifier_set(name: string, modName: string, attr: string, value: unknown): void {
    const o = obByName(name);
    const m = o?.modifiers.find((x) => x.name === modName);
    if (!m) throw new Error('modifier not found');
    (m as Record<string, unknown>)[snakeToCamel(attr)] = toJs(value);
    changed(true);
  },
  modifier_remove(name: string, modName: string): void {
    const o = obByName(name);
    if (!o) return;
    o.modifiers = o.modifiers.filter((m) => m.name !== modName);
    changed(true);
  },
  report: (type: string, text: string) => app.report(type === 'ERROR' ? 'ERROR' : type === 'WARNING' ? 'WARNING' : 'INFO', text),
  push_undo: (name: string) => app.pushUndo(name),
};

function snakeToCamel(s: string): string {
  const special: Record<string, string> = { render_levels: 'renderLevels', use_x: 'useX', use_y: 'useY', use_z: 'useZ', relative_offset_displace: 'relativeOffset', constant_offset_displace: 'constantOffset', use_relative_offset: 'useRelativeOffset', use_constant_offset: 'useConstantOffset', use_merge_vertices: 'useMerge', merge_threshold: 'mergeThreshold', use_clip: 'useClip', use_mirror_merge: 'useMirrorMerge', mid_level: 'midLevel', deform_method: 'deformMethod' };
  return special[s] ?? s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

const BPY_SOURCE = String.raw`
import json, math, sys
import _bw

class Vector(list):
    """Minimal mathutils.Vector."""
    def __init__(self, seq=(0.0, 0.0, 0.0), _owner=None):
        super().__init__(float(x) for x in seq)
        self._owner = _owner
    def _sync(self):
        if self._owner is not None:
            self._owner(list(self))
    def __setitem__(self, i, v):
        super().__setitem__(i, float(v)); self._sync()
    x = property(lambda s: s[0], lambda s, v: s.__setitem__(0, v))
    y = property(lambda s: s[1], lambda s, v: s.__setitem__(1, v))
    z = property(lambda s: s[2], lambda s, v: s.__setitem__(2, v))
    def __add__(self, o): return Vector([a + b for a, b in zip(self, o)])
    def __sub__(self, o): return Vector([a - b for a, b in zip(self, o)])
    def __mul__(self, k):
        if isinstance(k, (int, float)): return Vector([a * k for a in self])
        return sum(a * b for a, b in zip(self, k))
    __rmul__ = __mul__
    def __truediv__(self, k): return Vector([a / k for a in self])
    def __neg__(self): return Vector([-a for a in self])
    @property
    def length(self): return math.sqrt(sum(a * a for a in self))
    def normalized(self):
        l = self.length
        return Vector([a / l for a in self]) if l else Vector(self)
    def dot(self, o): return sum(a * b for a, b in zip(self, o))
    def cross(self, o): return Vector([self[1]*o[2]-self[2]*o[1], self[2]*o[0]-self[0]*o[2], self[0]*o[1]-self[1]*o[0]])
    def copy(self): return Vector(self)
    def to_tuple(self, precision=-1): return tuple(round(a, precision) if precision >= 0 else a for a in self)
    def __repr__(self): return "Vector((%s))" % ", ".join("%.4f" % a for a in self)

Euler = Vector
Color = Vector

class _Collection:
    def __init__(self, names, make, remove=None, new=None):
        self._names, self._make, self._remove, self._new = names, make, remove, new
    def _list(self): return list(self._names())
    def __len__(self): return len(self._list())
    def __iter__(self): return (self._make(n) for n in self._list())
    def __contains__(self, k): return (k if isinstance(k, str) else getattr(k, 'name', None)) in self._list()
    def __getitem__(self, k):
        names = self._list()
        if isinstance(k, int): return self._make(names[k])
        if k in names: return self._make(k)
        raise KeyError('bpy_prop_collection[key]: key "%s" not found' % k)
    def get(self, k, default=None):
        return self._make(k) if k in self._list() else default
    def keys(self): return self._list()
    def values(self): return list(self)
    def items(self): return [(n, self._make(n)) for n in self._list()]
    def new(self, *a, **kw):
        if not self._new: raise TypeError('new() not supported')
        return self._new(*a, **kw)
    def remove(self, item, **kw):
        if not self._remove: raise TypeError('remove() not supported')
        self._remove(item)
    def __repr__(self): return "bpy.data.collection(%s)" % self._list()

class Modifier:
    def __init__(self, ob, name): object.__setattr__(self, '_ob', ob); object.__setattr__(self, 'name', name)
    def __getattr__(self, a):
        if a == 'type': return dict(_bw.obj_get(self._ob, 'modifiers').to_py())[self.name]
        v = _bw.modifier_get(self._ob, self.name, a)
        return v.to_py() if hasattr(v, 'to_py') else v
    def __setattr__(self, a, v): _bw.modifier_set(self._ob, self.name, a, list(v) if isinstance(v, (list, tuple)) else v)
    def __repr__(self): return 'bpy.data.objects["%s"].modifiers["%s"]' % (self._ob, self.name)

class _Modifiers(_Collection):
    def __init__(self, ob):
        super().__init__(lambda: [m[0] for m in _bw.obj_get(ob, 'modifiers').to_py()], lambda n: Modifier(ob, n), lambda m: _bw.modifier_remove(ob, m.name))
        self._ob = ob
    def new(self, name, type): return Modifier(self._ob, _bw.modifier_new(self._ob, name, type))

class MeshVertex:
    def __init__(self, mesh, i, co): self._mesh, self.index = mesh, i; self._co = co
    @property
    def co(self): return Vector(self._co, lambda v, m=self._mesh, i=self.index: _bw.mesh_set_vert(m, i, v))
    @co.setter
    def co(self, v): _bw.mesh_set_vert(self._mesh, self.index, list(v)); self._co = list(v)
    def __repr__(self): return 'bpy.data.meshes["%s"].vertices[%d]' % (self._mesh, self.index)

class MeshPolygon:
    def __init__(self, i, verts, smooth): self.index, self.vertices, self.use_smooth = i, tuple(verts), smooth
    def __repr__(self): return 'MeshPolygon(%d, %r)' % (self.index, self.vertices)

class Mesh:
    def __init__(self, name): object.__setattr__(self, 'name', name)
    def _d(self): return _bw.mesh_get(self.name).to_py()
    @property
    def vertices(self):
        d = self._d(); return [MeshVertex(self.name, i, v) for i, v in enumerate(d['verts'])]
    @property
    def polygons(self):
        d = self._d(); return [MeshPolygon(i, f, d['smooth'][i]) for i, f in enumerate(d['faces'])]
    @property
    def edges(self): return [tuple(e) for e in self._d()['edges']]
    def from_pydata(self, verts, edges, faces): _bw.mesh_from_pydata(self.name, [list(v) for v in verts], [list(e) for e in edges], [list(f) for f in faces])
    def update(self, *a, **kw): pass
    def __repr__(self): return 'bpy.data.meshes["%s"]' % self.name

class Material:
    def __init__(self, name): object.__setattr__(self, 'name', name)
    def __getattr__(self, a):
        v = _bw.material_get(self.name, a)
        v = v.to_py() if hasattr(v, 'to_py') else v
        return Color(v, lambda c, n=self.name, a=a: _bw.material_set(n, a, c)) if isinstance(v, list) else v
    def __setattr__(self, a, v):
        _bw.material_set(self.name, a, list(v) if isinstance(v, (list, tuple)) else v)
        if a == 'name': object.__setattr__(self, 'name', v)
    def __repr__(self): return 'bpy.data.materials["%s"]' % self.name

class _Slots(list):
    pass

class Object:
    _vec = ('location', 'rotation_euler', 'scale')
    def __init__(self, name): object.__setattr__(self, 'name', name)
    def __getattr__(self, a):
        n = object.__getattribute__(self, 'name')
        if a in Object._vec:
            return Vector(_bw.obj_get(n, a).to_py(), lambda v, n=n, a=a: _bw.obj_set(n, a, v))
        if a == 'modifiers': return _Modifiers(n)
        if a == 'data':
            d = _bw.obj_get(n, 'data')
            if d is None: return None
            return Mesh(d) if _bw.obj_get(n, 'type') == 'MESH' else d
        if a == 'parent':
            p = _bw.obj_get(n, 'parent'); return Object(p) if p else None
        if a == 'active_material':
            mats = _bw.obj_materials(n).to_py(); return Material(mats[0]) if mats and mats[0] else None
        if a == 'material_slots':
            return [Material(m) if m else None for m in _bw.obj_materials(n).to_py()]
        if a == 'dimensions':
            d = _bw.mesh_get(_bw.obj_get(n, 'data')).to_py()['verts'] if _bw.obj_get(n, 'type') == 'MESH' else [[0,0,0]]
            s = _bw.obj_get(n, 'scale').to_py()
            return Vector([(max(v[i] for v in d) - min(v[i] for v in d)) * abs(s[i]) for i in range(3)])
        v = _bw.obj_get(n, a)
        return v.to_py() if hasattr(v, 'to_py') else v
    def __setattr__(self, a, v):
        n = object.__getattribute__(self, 'name')
        if a == 'parent': v = v.name if v is not None else None
        if a == 'active_material':
            _bw.obj_material_append(n, v.name if v else None); return
        _bw.obj_set(n, a, list(v) if isinstance(v, (list, tuple)) else v)
        if a == 'name': object.__setattr__(self, 'name', _bw.active_object() if False else v)
    def select_set(self, state=True): _bw.obj_set(self.name, 'select', bool(state))
    def keyframe_insert(self, data_path, index=-1, frame=None, group=''):
        return _bw.keyframe_insert(self.name, data_path, index, frame)
    def __eq__(self, o): return isinstance(o, Object) and o.name == self.name
    def __hash__(self): return hash(self.name)
    def __repr__(self): return 'bpy.data.objects["%s"]' % self.name

class _Render:
    def __getattr__(self, a): return _bw.scene_get(a)
    def __setattr__(self, a, v): _bw.scene_set(a, v)

class Scene:
    def __getattr__(self, a):
        if a == 'objects': return _Collection(lambda: _bw.objects().to_py(), Object)
        if a == 'render': return _Render()
        if a == 'cursor_location': return Vector(_bw.scene_get(a).to_py(), lambda v: _bw.scene_set('cursor_location', v))
        if a == 'camera':
            c = _bw.scene_get('camera'); return Object(c) if c else None
        v = _bw.scene_get(a)
        return v.to_py() if hasattr(v, 'to_py') else v
    def __setattr__(self, a, v):
        if a == 'camera': v = v.name if v is not None else None
        _bw.scene_set(a, list(v) if isinstance(v, (list, tuple)) else v)
    def frame_set(self, frame, subframe=0.0): _bw.scene_set('frame_current', int(frame))
    def __repr__(self): return 'bpy.data.scenes["%s"]' % _bw.scene_get('name')

class _Context:
    scene = property(lambda s: Scene())
    object = property(lambda s: Object(_bw.active_object()) if _bw.active_object() else None)
    active_object = object
    selected_objects = property(lambda s: [Object(n) for n in _bw.selected().to_py()])
    selected_editable_objects = selected_objects
    visible_objects = property(lambda s: [Object(n) for n in _bw.objects().to_py()])
    mode = property(lambda s: _bw.mode())
    def __repr__(self): return '<bpy_struct, Context>'

def _remove_object(ob):
    for n in _bw.selected().to_py(): _bw.obj_set(n, 'select', False)
    _bw.obj_set(ob.name, 'select', True)
    _bw.op('object.delete', '{}')

class _Data:
    objects = property(lambda s: _Collection(lambda: _bw.all_objects().to_py(), Object, _remove_object))
    meshes = property(lambda s: _Collection(lambda: _bw.mesh_names().to_py(), Mesh))
    materials = property(lambda s: _Collection(lambda: _bw.material_names().to_py(), Material, None, lambda name: Material(_bw.material_new(name))))
    scenes = property(lambda s: _Collection(lambda: [_bw.scene_get('name')], lambda n: Scene()))
    def __repr__(self): return '<bpy_struct, BlendData>'

class _OpCall:
    def __init__(self, idname): self.idname = idname
    def __call__(self, *args, **kw):
        def conv(v):
            if isinstance(v, (Vector, tuple)): return list(v)
            if isinstance(v, set): return list(v)[0] if v else ''
            return v
        return {_bw.op(self.idname, json.dumps({k: conv(v) for k, v in kw.items()}))}
    def poll(self, *a): return True
    def __repr__(self): return '# bpy.ops.%s()' % self.idname

class _OpModule:
    def __init__(self, cat): self.cat = cat
    def __getattr__(self, name):
        if name.startswith('__'): raise AttributeError(name)
        idname = '%s.%s' % (self.cat, name)
        if idname not in _bw.ops_list().to_py(): raise AttributeError('Calling operator "bpy.ops.%s" error, could not be found' % idname)
        return _OpCall(idname)
    def __dir__(self): return [o.split('.')[1] for o in _bw.ops_list().to_py() if o.startswith(self.cat + '.')]

class _Ops:
    def __getattr__(self, cat):
        if cat.startswith('__'): raise AttributeError(cat)
        return _OpModule(cat)
    def __dir__(self): return sorted({o.split('.')[0] for o in _bw.ops_list().to_py()})

class _Module: pass
bpy = _Module()
bpy.context = _Context()
bpy.data = _Data()
bpy.ops = _Ops()
bpy.app = _Module(); bpy.app.version = (2, 79, 0); bpy.app.version_string = '2.79 (sub 0) blender-web'
mathutils = _Module(); mathutils.Vector = Vector; mathutils.Euler = Euler; mathutils.Color = Color
sys.modules['bpy'] = bpy
sys.modules['mathutils'] = mathutils

import code, io
_console = code.InteractiveConsole(locals={'bpy': bpy, 'C': bpy.context, 'D': bpy.data, 'Vector': Vector, 'mathutils': mathutils, 'math': math, **{k: getattr(math, k) for k in dir(math) if not k.startswith('_')}})

def _push(line):
    out, err = io.StringIO(), io.StringIO()
    old = sys.stdout, sys.stderr
    sys.stdout, sys.stderr = out, err
    try:
        more = _console.push(line)
    finally:
        sys.stdout, sys.stderr = old
    return [more, out.getvalue(), err.getvalue()]

def _complete(text):
    import rlcompleter
    c = rlcompleter.Completer(_console.locals)
    res, i = [], 0
    while i < 200:
        r = c.complete(text, i)
        if r is None: break
        res.append(r); i += 1
    return res

def _run_script(src, name):
    out, err = io.StringIO(), io.StringIO()
    old = sys.stdout, sys.stderr
    sys.stdout, sys.stderr = out, err
    ok = True
    try:
        exec(compile(src, name, 'exec'), {'__name__': '__main__', 'bpy': bpy, 'mathutils': mathutils})
    except BaseException:
        import traceback
        traceback.print_exc()
        ok = False
    finally:
        sys.stdout, sys.stderr = old
    return [ok, out.getvalue(), err.getvalue()]
`;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.crossOrigin = 'anonymous';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(s);
  });
}

export const pythonListeners = new Set<() => void>();
function setStatus(s: typeof pythonStatus, err = ''): void {
  pythonStatus = s;
  pythonError = err;
  for (const l of pythonListeners) l();
}

export function loadPython(): Promise<Pyodide> {
  if (pyPromise) return pyPromise;
  setStatus('loading');
  pyPromise = (async () => {
    await loadScript(`${PYODIDE_URL}pyodide.js`);
    const loader = (window as unknown as { loadPyodide: (o: object) => Promise<Pyodide> }).loadPyodide;
    const py = await loader({ indexURL: PYODIDE_URL });
    py.registerJsModule('_bw', bridge);
    py.runPython(BPY_SOURCE);
    setStatus('ready');
    return py;
  })();
  pyPromise.catch((e: Error) => { setStatus('error', e.message); pyPromise = null; });
  return pyPromise;
}

export async function consolePush(line: string): Promise<{ more: boolean; out: string; err: string }> {
  const py = await loadPython();
  const fn = py.globals.get('_push') as (l: string) => { toJs(): [boolean, string, string]; destroy(): void };
  const r = fn(line);
  const [more, out, err] = r.toJs();
  r.destroy();
  return { more, out, err };
}

export async function consoleComplete(text: string): Promise<string[]> {
  const py = await loadPython();
  const fn = py.globals.get('_complete') as (t: string) => { toJs(): string[]; destroy(): void };
  const r = fn(text);
  const out = r.toJs();
  r.destroy();
  return out;
}

export async function runScript(src: string, name: string): Promise<{ ok: boolean; out: string; err: string }> {
  const py = await loadPython();
  const fn = py.globals.get('_run_script') as (s: string, n: string) => { toJs(): [boolean, string, string]; destroy(): void };
  const r = fn(src, name);
  const [ok, out, err] = r.toJs();
  r.destroy();
  app.pushUndo('Run Script');
  app.notify('all');
  return { ok, out, err };
}

/** Text shown by the console after it loads (mirrors Blender's banner). */
export const CONSOLE_BANNER = [
  'PYTHON INTERACTIVE CONSOLE (Pyodide, CPython in WebAssembly)',
  '',
  'Command History:     Up/Down Arrow',
  'Cursor:              Left/Right Home/End',
  'Remove:              Backspace/Delete',
  'Execute:             Enter',
  'Autocomplete:        Ctrl-Space or Tab',
  'Zoom:                Ctrl +/-, Ctrl-Wheel',
  'Builtin Modules:     bpy, bpy.data, bpy.ops, bpy.context, mathutils',
  'Convenience Imports: from math import *',
  'Convenience Variables: C = bpy.context, D = bpy.data',
  '',
];
