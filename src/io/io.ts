// Import / export of common 3D formats: Wavefront OBJ (+MTL), STL and glTF 2.0 (GLB).
// Axis conventions follow Blender's exporters: OBJ/glTF are converted to Y-up, STL stays Z-up.

import { BufferAttribute, BufferGeometry, Group, Matrix4, Mesh, MeshStandardMaterial, Scene, Vector3, Color, DoubleSide } from 'three';
import { app } from '../app';
import type { BObject, Vec3 } from '../core/types';
import { createMesh, createObject, createMaterial, NUM_LAYERS } from '../core/scene';
import { triangulatePoly, polyNormal } from '../core/mesh';
import { downloadFile } from '../ui/dom';

function exportObjects(selectedOnly: boolean): BObject[] {
  return (selectedOnly ? app.selectedObjects() : app.visibleObjects()).filter((o) => o.type === 'MESH');
}

const zUpToYUp = (p: Vector3) => new Vector3(p.x, p.z, -p.y);
const yUpToZUp = (x: number, y: number, z: number): Vec3 => [x, -z, y];

// ------------------------------------------------------------------ OBJ

export function exportOBJ(opts: { selectedOnly: boolean; applyModifiers: boolean; writeNormals: boolean; writeMaterials: boolean; triangulate: boolean; yUp: boolean }): { obj: string; mtl: string } {
  const lines: string[] = ['# Blender v2.79 (sub 0) OBJ File (blender-web)', '# www.blender.org'];
  const base = (app.doc.filename || 'untitled').replace(/\.[^.]+$/, '');
  if (opts.writeMaterials) lines.push(`mtllib ${base}.mtl`);
  const mtl: string[] = ['# Blender MTL File (blender-web)', `# Material Count: ${Object.keys(app.doc.materials).length}`];
  const usedMats = new Set<string>();
  let vOff = 1, nOff = 1;
  for (const ob of exportObjects(opts.selectedOnly)) {
    const md = app.meshOf(ob)!;
    const em = opts.applyModifiers ? app.evalMesh(ob, false)! : { verts: md.verts, faces: md.faces, faceSmooth: md.faceSmooth, faceMat: md.faceMat, looseEdges: [] as [number, number][] };
    const m = app.matrices.world(ob);
    const nm = new Matrix4().extractRotation(m);
    lines.push(`o ${ob.name}_${md.name}`);
    for (const v of em.verts) {
      let p = new Vector3(...v).applyMatrix4(m);
      if (opts.yUp) p = zUpToYUp(p);
      lines.push(`v ${p.x.toFixed(6)} ${p.y.toFixed(6)} ${p.z.toFixed(6)}`);
    }
    const normals: string[] = [];
    if (opts.writeNormals) {
      for (const f of em.faces) {
        let n = new Vector3(...polyNormal(em.verts, f)).applyMatrix4(nm).normalize();
        if (opts.yUp) n = zUpToYUp(n);
        normals.push(`vn ${n.x.toFixed(4)} ${n.y.toFixed(4)} ${n.z.toFixed(4)}`);
      }
      lines.push(...normals);
    }
    let curMat = -2;
    let curSmooth: boolean | null = null;
    em.faces.forEach((f, fi) => {
      const mi = em.faceMat[fi] ?? 0;
      if (opts.writeMaterials && mi !== curMat) {
        const mid = md.materials[mi];
        const mname = mid ? app.doc.materials[mid]?.name : null;
        lines.push(`usemtl ${mname ?? 'None'}`);
        if (mid) usedMats.add(mid);
        curMat = mi;
      }
      const sm = !!em.faceSmooth[fi];
      if (sm !== curSmooth) { lines.push(`s ${sm ? '1' : 'off'}`); curSmooth = sm; }
      const polys = opts.triangulate ? triangulatePoly(em.verts, f).map((t) => t.map((c) => f[c])) : [f];
      for (const poly of polys) lines.push(`f ${poly.map((v) => (opts.writeNormals ? `${v + vOff}//${fi + nOff}` : `${v + vOff}`)).join(' ')}`);
    });
    for (const [a, b] of em.looseEdges ?? []) lines.push(`l ${a + vOff} ${b + vOff}`);
    vOff += em.verts.length;
    nOff += opts.writeNormals ? em.faces.length : 0;
  }
  for (const id of usedMats) {
    const ma = app.doc.materials[id];
    if (!ma) continue;
    const d = ma.diffuseColor.map((c) => c * ma.diffuseIntensity);
    const s = ma.specularColor.map((c) => c * ma.specularIntensity);
    mtl.push('', `newmtl ${ma.name}`, `Ns ${((ma.specularHardness - 1) * 1000 / 510).toFixed(6)}`, 'Ka 1.000000 1.000000 1.000000',
      `Kd ${d.map((x) => x.toFixed(6)).join(' ')}`, `Ks ${s.map((x) => x.toFixed(6)).join(' ')}`,
      `Ke ${ma.diffuseColor.map((c) => (c * ma.emit).toFixed(6)).join(' ')}`, 'Ni 1.000000', `d ${(ma.useTransparency ? ma.alpha : 1).toFixed(6)}`, 'illum 2');
  }
  return { obj: lines.join('\n') + '\n', mtl: mtl.join('\n') + '\n' };
}

export function importOBJ(text: string, name: string, yUp = true): BObject[] {
  const pos: Vec3[] = [];
  type Group = { name: string; faces: number[][]; smooth: boolean[]; mats: number[]; matNames: string[]; lines: [number, number][] };
  const groups: Group[] = [];
  let cur: Group | null = null;
  let smooth = false;
  let mat = 0;
  const ensure = () => { if (!cur) { cur = { name, faces: [], smooth: [], mats: [], matNames: [], lines: [] }; groups.push(cur); } return cur; };
  const idx = (s: string) => { const i = parseInt(s.split('/')[0], 10); return i < 0 ? pos.length + i : i - 1; };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    switch (parts[0]) {
      case 'v': {
        const x = parseFloat(parts[1]), y = parseFloat(parts[2]), z = parseFloat(parts[3]);
        pos.push(yUp ? yUpToZUp(x, y, z) : [x, y, z]);
        break;
      }
      case 'o': case 'g':
        cur = { name: parts.slice(1).join(' ') || name, faces: [], smooth: [], mats: [], matNames: [], lines: [] };
        groups.push(cur);
        mat = 0;
        break;
      case 's': smooth = parts[1] !== 'off' && parts[1] !== '0'; break;
      case 'usemtl': {
        const g = ensure();
        let i = g.matNames.indexOf(parts[1]);
        if (i < 0) { g.matNames.push(parts[1]); i = g.matNames.length - 1; }
        mat = i;
        break;
      }
      case 'f': {
        const g = ensure();
        const f = parts.slice(1).map(idx).filter((i) => i >= 0 && i < pos.length);
        if (f.length >= 3 && new Set(f).size === f.length) { g.faces.push(f); g.smooth.push(smooth); g.mats.push(mat); }
        break;
      }
      case 'l': {
        const g = ensure();
        const l = parts.slice(1).map(idx);
        for (let i = 0; i + 1 < l.length; i++) g.lines.push([l[i], l[i + 1]]);
        break;
      }
    }
  }
  const created: BObject[] = [];
  app.deselectAll();
  for (const g of groups) {
    if (!g.faces.length && !g.lines.length) continue;
    // compact the vertices used by this group
    const map = new Map<number, number>();
    const verts: Vec3[] = [];
    const use = (i: number) => { let j = map.get(i); if (j === undefined) { j = verts.length; verts.push(pos[i]); map.set(i, j); } return j; };
    const faces = g.faces.map((f) => f.map(use));
    const lines = g.lines.map(([a, b]) => [use(a), use(b)] as [number, number]);
    const mesh = createMesh(app.doc, g.name, verts, faces, lines);
    mesh.faceSmooth = g.smooth.slice();
    mesh.faceMat = g.mats.slice();
    mesh.materials = g.matNames.map((mn) => {
      const existing = Object.values(app.doc.materials).find((m) => m.name === mn);
      return existing ? existing.id : createMaterial(app.doc, mn).id;
    });
    const ob = createObject(app.doc, 'MESH', g.name, mesh.id);
    ob.layers = new Array(NUM_LAYERS).fill(false);
    ob.layers[Math.max(0, app.scene.layers.findIndex(Boolean))] = true;
    ob.select = true;
    app.scene.objects.push(ob.id);
    app.scene.activeObject = ob.id;
    created.push(ob);
    app.tagGeometry(mesh.id);
  }
  return created;
}

// ------------------------------------------------------------------ STL

export function exportSTL(selectedOnly: boolean, ascii: boolean, applyModifiers = true): Blob | string {
  const tris: { n: Vector3; a: Vector3; b: Vector3; c: Vector3 }[] = [];
  for (const ob of exportObjects(selectedOnly)) {
    const md = app.meshOf(ob)!;
    const em = applyModifiers ? app.evalMesh(ob, false)! : { verts: md.verts, faces: md.faces };
    const m = app.matrices.world(ob);
    for (const f of em.faces) for (const t of triangulatePoly(em.verts, f)) {
      const a = new Vector3(...em.verts[f[t[0]]]).applyMatrix4(m), b = new Vector3(...em.verts[f[t[1]]]).applyMatrix4(m), c = new Vector3(...em.verts[f[t[2]]]).applyMatrix4(m);
      const n = new Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a)).normalize();
      tris.push({ n, a, b, c });
    }
  }
  if (ascii) {
    const out = ['solid Exported from blender-web'];
    const f = (v: Vector3) => `${v.x.toExponential(6)} ${v.y.toExponential(6)} ${v.z.toExponential(6)}`;
    for (const t of tris) out.push(`facet normal ${f(t.n)}`, 'outer loop', `vertex ${f(t.a)}`, `vertex ${f(t.b)}`, `vertex ${f(t.c)}`, 'endloop', 'endfacet');
    out.push('endsolid Exported from blender-web');
    return out.join('\n') + '\n';
  }
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  const header = 'Exported from blender-web';
  for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i));
  dv.setUint32(80, tris.length, true);
  let o = 84;
  for (const t of tris) {
    for (const v of [t.n, t.a, t.b, t.c]) { dv.setFloat32(o, v.x, true); dv.setFloat32(o + 4, v.y, true); dv.setFloat32(o + 8, v.z, true); o += 12; }
    dv.setUint16(o, 0, true);
    o += 2;
  }
  return new Blob([buf], { type: 'model/stl' });
}

export function importSTL(data: ArrayBuffer, name: string): BObject | null {
  const bytes = new Uint8Array(data);
  const tris: Vec3[][] = [];
  const headerText = new TextDecoder().decode(bytes.slice(0, Math.min(bytes.length, 512)));
  const dv = new DataView(data);
  const isBinary = bytes.length >= 84 && 84 + dv.getUint32(80, true) * 50 === bytes.length;
  if (!isBinary && /^\s*solid/.test(headerText)) {
    const text = new TextDecoder().decode(bytes);
    const re = /vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g;
    let m: RegExpExecArray | null;
    let tri: Vec3[] = [];
    while ((m = re.exec(text))) {
      tri.push([parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])]);
      if (tri.length === 3) { tris.push(tri); tri = []; }
    }
  } else {
    const n = dv.getUint32(80, true);
    for (let i = 0; i < n; i++) {
      const o = 84 + i * 50 + 12;
      const tri: Vec3[] = [];
      for (let k = 0; k < 3; k++) tri.push([dv.getFloat32(o + k * 12, true), dv.getFloat32(o + k * 12 + 4, true), dv.getFloat32(o + k * 12 + 8, true)]);
      tris.push(tri);
    }
  }
  if (!tris.length) return null;
  // merge identical vertices
  const map = new Map<string, number>();
  const verts: Vec3[] = [];
  const faces: number[][] = [];
  for (const t of tris) {
    const f = t.map((p) => {
      const k = `${p[0].toFixed(6)},${p[1].toFixed(6)},${p[2].toFixed(6)}`;
      let i = map.get(k);
      if (i === undefined) { i = verts.length; verts.push(p); map.set(k, i); }
      return i;
    });
    if (new Set(f).size === 3) faces.push(f);
  }
  app.deselectAll();
  const mesh = createMesh(app.doc, name, verts, faces);
  const ob = createObject(app.doc, 'MESH', name, mesh.id);
  ob.layers = new Array(NUM_LAYERS).fill(false);
  ob.layers[Math.max(0, app.scene.layers.findIndex(Boolean))] = true;
  ob.select = true;
  app.scene.objects.push(ob.id);
  app.scene.activeObject = ob.id;
  app.tagGeometry(mesh.id);
  return ob;
}

// ------------------------------------------------------------------ glTF

export async function exportGLB(selectedOnly: boolean): Promise<Blob> {
  const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
  const scene = new Scene();
  const root = new Group();
  root.name = 'blender-web';
  root.rotation.x = -Math.PI / 2; // Z-up -> Y-up
  scene.add(root);
  const mats = new Map<string, MeshStandardMaterial>();
  for (const ob of exportObjects(selectedOnly)) {
    const md = app.meshOf(ob)!;
    const em = app.evalMesh(ob, false)!;
    const geom = new BufferGeometry();
    const pos: number[] = [], nor: number[] = [];
    const groups: { start: number; count: number; mat: number }[] = [];
    em.faces.forEach((f, fi) => {
      const n = polyNormal(em.verts, f);
      const mi = em.faceMat[fi] ?? 0;
      const start = pos.length / 3;
      for (const t of triangulatePoly(em.verts, f)) for (const c of t) { pos.push(...em.verts[f[c]]); nor.push(...n); }
      const last = groups[groups.length - 1];
      if (last && last.mat === mi && last.start + last.count === start) last.count += pos.length / 3 - start;
      else groups.push({ start, count: pos.length / 3 - start, mat: mi });
    });
    geom.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    geom.setAttribute('normal', new BufferAttribute(new Float32Array(nor), 3));
    for (const g of groups) geom.addGroup(g.start, g.count, g.mat);
    const materials = Array.from({ length: Math.max(1, md.materials.length) }, (_, i) => {
      const id = md.materials[i];
      const ma = id ? app.doc.materials[id] : null;
      const key = ma?.id ?? '__default';
      let m = mats.get(key);
      if (!m) {
        m = new MeshStandardMaterial({ name: ma?.name ?? 'Material', side: DoubleSide });
        if (ma) {
          m.color = new Color(ma.diffuseColor[0] * ma.diffuseIntensity, ma.diffuseColor[1] * ma.diffuseIntensity, ma.diffuseColor[2] * ma.diffuseIntensity);
          m.roughness = Math.max(0.05, 1 - Math.min(1, ma.specularHardness / 511) * ma.specularIntensity * 2);
          m.metalness = 0;
          m.emissive = new Color(ma.diffuseColor[0] * ma.emit, ma.diffuseColor[1] * ma.emit, ma.diffuseColor[2] * ma.emit);
          if (ma.useTransparency && ma.alpha < 1) { m.transparent = true; m.opacity = ma.alpha; }
        } else m.color = new Color(0.8, 0.8, 0.8);
        mats.set(key, m);
      }
      return m;
    });
    const mesh = new Mesh(geom, materials.length === 1 ? materials[0] : materials);
    mesh.name = ob.name;
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(app.matrices.world(ob));
    root.add(mesh);
  }
  scene.updateMatrixWorld(true);
  const exporter = new GLTFExporter();
  const result = await exporter.parseAsync(scene, { binary: true });
  return new Blob([result as ArrayBuffer], { type: 'model/gltf-binary' });
}

export function baseName(): string {
  return (app.doc.filename || 'untitled').replace(/\.blend(\.json)?$/i, '').replace(/\.[^.]+$/, '');
}

export function download(name: string, data: Blob | string, mime?: string): void { downloadFile(name, data, mime); }
