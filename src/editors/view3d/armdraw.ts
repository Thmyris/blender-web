// Viewport drawing of armatures (Octahedral, Stick, B-Bone, Envelope and Wire display, names and
// axes, X-Ray) in Object, Edit and Pose Mode with Blender 2.79's colours, and of lattices (point grid).

import {
  BufferAttribute, BufferGeometry, Color, Group, LineBasicMaterial, LineSegments, Matrix4, Mesh, MeshPhongMaterial,
  Points, PointsMaterial, Vector3, DoubleSide,
} from 'three';
import { app } from '../../app';
import type { ArmatureData, BObject, Bone } from '../../core/types';
import { armatureOf, boneLength, boneRestMatrix, evaluatePose, isBoneVisible } from '../../core/armature';
import { latticeEdges } from '../../core/lattice';
import { registerObjectDrawer, type ObjectDrawState } from './edittypes';
import type { View3D } from './view3d';

// 2.79 theme colours
export const BONE_COL = {
  solid: new Color(0.7, 0.7, 0.7),
  wire: new Color(0, 0, 0),
  obSelect: new Color('#f15800'),
  obActive: new Color('#ffaa40'),
  editSelect: new Color('#ffa000'),
  editActive: new Color('#ffcc66'),
  editJointSel: new Color('#ff8500'),
  pose: new Color('#50c8ff'),
  poseActive: new Color('#8cffff'),
  poseSolidSel: new Color('#78b4dc'),
  poseSolidAct: new Color('#a0dcf0'),
};

/** How the armature is shown: rest bones (edit mode) or the evaluated pose. */
export function boneMatrices(ob: BObject, arm: ArmatureData): Map<string, Matrix4> {
  const editing = app.mode === 'EDIT' && app.editObject === ob.id;
  if (editing) return new Map(arm.bones.map((b) => [b.name, boneRestMatrix(b)]));
  return evaluatePose(app.doc, ob, { worldOf: (o) => app.matrices.world(o) }).pose;
}

// ------------------------------------------------------------------ geometry builders

class Builder {
  tri: number[] = [];
  triCol: number[] = [];
  line: number[] = [];
  lineCol: number[] = [];
  pickLine: number[] = [];
  pts: number[] = [];
  ptsCol: number[] = [];

  triangle(m: Matrix4, a: Vector3, b: Vector3, c: Vector3, col: Color): void {
    for (const p of [a, b, c]) {
      const q = p.clone().applyMatrix4(m);
      this.tri.push(q.x, q.y, q.z);
      this.triCol.push(col.r, col.g, col.b);
    }
  }

  seg(m: Matrix4, a: Vector3, b: Vector3, col: Color, pick = true): void {
    const p = a.clone().applyMatrix4(m), q = b.clone().applyMatrix4(m);
    this.line.push(p.x, p.y, p.z, q.x, q.y, q.z);
    this.lineCol.push(col.r, col.g, col.b, col.r, col.g, col.b);
    if (pick) this.pickLine.push(p.x, p.y, p.z, q.x, q.y, q.z);
  }

  sphere(m: Matrix4, c: Vector3, r: number, col: Color, wireCol: Color | null, seg = 10): void {
    const rings = Math.max(3, seg / 2);
    const P = (i: number, j: number) => {
      const th = (i / rings) * Math.PI, ph = (j / seg) * Math.PI * 2;
      return new Vector3(c.x + r * Math.sin(th) * Math.cos(ph), c.y + r * Math.cos(th), c.z + r * Math.sin(th) * Math.sin(ph));
    };
    for (let i = 0; i < rings; i++) for (let j = 0; j < seg; j++) {
      const a = P(i, j), b = P(i + 1, j), d = P(i, j + 1), e = P(i + 1, j + 1);
      this.triangle(m, a, b, e, col);
      this.triangle(m, a, e, d, col);
    }
    if (wireCol) {
      // silhouette-ish rings
      for (let j = 0; j < seg; j++) {
        const ph0 = (j / seg) * Math.PI * 2, ph1 = ((j + 1) / seg) * Math.PI * 2;
        this.seg(m, new Vector3(c.x + r * Math.cos(ph0), c.y, c.z + r * Math.sin(ph0)), new Vector3(c.x + r * Math.cos(ph1), c.y, c.z + r * Math.sin(ph1)), wireCol, false);
      }
    }
  }

  point(m: Matrix4, p: Vector3, col: Color): void {
    const q = p.clone().applyMatrix4(m);
    this.pts.push(q.x, q.y, q.z);
    this.ptsCol.push(col.r, col.g, col.b);
  }

  build(group: Group, xray: boolean, solid: boolean): void {
    const order = xray ? 40 : 0;
    if (this.tri.length && solid) {
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(new Float32Array(this.tri), 3));
      g.setAttribute('color', new BufferAttribute(new Float32Array(this.triCol), 3));
      g.computeVertexNormals();
      const mat = new MeshPhongMaterial({ vertexColors: true, shininess: 20, specular: new Color(0.15, 0.15, 0.15), side: DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
      mat.depthTest = !xray;
      const mesh = new Mesh(g, mat);
      mesh.renderOrder = order;
      group.add(mesh);
    }
    if (this.line.length) {
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(new Float32Array(this.line), 3));
      g.setAttribute('color', new BufferAttribute(new Float32Array(this.lineCol), 3));
      const mat = new LineBasicMaterial({ vertexColors: true });
      mat.depthTest = !xray;
      const l = new LineSegments(g, mat);
      l.renderOrder = order + 1;
      group.add(l);
    }
    if (this.pickLine.length) {
      // invisible copy used for picking in Object Mode
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(new Float32Array(this.pickLine), 3));
      const l = new LineSegments(g, new LineBasicMaterial({ visible: false }));
      l.userData.pick = true;
      group.add(l);
    }
    if (this.pts.length) {
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(new Float32Array(this.pts), 3));
      g.setAttribute('color', new BufferAttribute(new Float32Array(this.ptsCol), 3));
      const mat = new PointsMaterial({ size: 6 * (window.devicePixelRatio > 1 ? 1.5 : 1), sizeAttenuation: false, vertexColors: true });
      mat.depthTest = !xray;
      const p = new Points(g, mat);
      p.renderOrder = order + 2;
      group.add(p);
    }
  }
}

const V = (x: number, y: number, z: number) => new Vector3(x, y, z);

/** Octahedral bone in bone space (length 1, scaled by the matrix). */
function octahedral(B: Builder, m: Matrix4, L: number, solid: Color, wire: Color): void {
  const w = 0.1 * L;
  const head = V(0, 0, 0), tail = V(0, L, 0);
  const r = [V(w, w, w), V(w, w, -w), V(-w, w, -w), V(-w, w, w)];
  for (let i = 0; i < 4; i++) {
    const a = r[i], b = r[(i + 1) % 4];
    B.triangle(m, head, b, a, solid);
    B.triangle(m, tail, a, b, solid);
  }
  for (let i = 0; i < 4; i++) {
    B.seg(m, head, r[i], wire);
    B.seg(m, r[i], tail, wire);
    B.seg(m, r[i], r[(i + 1) % 4], wire);
  }
}

function box(B: Builder, m: Matrix4, L: number, sx: number, sz: number, solid: Color, wire: Color): void {
  const c = [V(-sx, 0, -sz), V(sx, 0, -sz), V(sx, 0, sz), V(-sx, 0, sz), V(-sx, L, -sz), V(sx, L, -sz), V(sx, L, sz), V(-sx, L, sz)];
  const quads = [[0, 1, 2, 3], [7, 6, 5, 4], [0, 4, 5, 1], [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 4, 0]];
  for (const q of quads) { B.triangle(m, c[q[0]], c[q[1]], c[q[2]], solid); B.triangle(m, c[q[0]], c[q[2]], c[q[3]], solid); }
  for (const [a, b] of [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]]) B.seg(m, c[a], c[b], wire);
}

interface BoneStyle { solid: Color; wire: Color; head: Color; tail: Color }

function styleFor(ob: BObject, arm: ArmatureData, b: Bone, s: ObjectDrawState): BoneStyle {
  const mode = app.editObject === ob.id ? app.mode : 'OBJECT';
  const isActive = arm.activeBone === b.name;
  if (mode === 'EDIT') {
    const wire = b.select ? (isActive ? BONE_COL.editActive : BONE_COL.editSelect) : BONE_COL.wire;
    return { solid: BONE_COL.solid, wire, head: b.selectHead ? BONE_COL.editJointSel : BONE_COL.wire, tail: b.selectTail ? BONE_COL.editJointSel : BONE_COL.wire };
  }
  if (mode === 'POSE' || (app.mode === 'WEIGHT_PAINT' && poseShownInWeightPaint(ob))) {
    const sel = b.select;
    const solid = sel ? (isActive ? BONE_COL.poseSolidAct : BONE_COL.poseSolidSel) : BONE_COL.solid;
    const wire = sel ? (isActive ? BONE_COL.poseActive : BONE_COL.pose) : BONE_COL.wire;
    return { solid, wire, head: wire, tail: wire };
  }
  const wire = s.selected ? (s.active ? BONE_COL.obActive : BONE_COL.obSelect) : BONE_COL.wire;
  return { solid: BONE_COL.solid, wire, head: wire, tail: wire };
}

/** In Weight Paint mode, the armature deforming the painted mesh shows its pose selection. */
function poseShownInWeightPaint(armOb: BObject): boolean {
  const pob = app.editObject ? app.doc.objects[app.editObject] : null;
  return !!pob && pob.modifiers.some((m) => m.type === 'ARMATURE' && m.object === armOb.id);
}

function drawArmature(ob: BObject, root: Group, s: ObjectDrawState): void {
  const arm = armatureOf(app.doc, ob);
  if (!arm) return;
  const mats = boneMatrices(ob, arm);
  const B = new Builder();
  const shading = s.display.shading;
  const solidShade = shading !== 'WIREFRAME' && shading !== 'BOUNDBOX' && ob.drawType !== 'WIRE' && ob.drawType !== 'BOUNDS';
  const editing = app.mode === 'EDIT' && app.editObject === ob.id;
  const unit = new Matrix4();
  for (const b of arm.bones) {
    if (!isBoneVisible(arm, b)) continue;
    const m = mats.get(b.name);
    if (!m) continue;
    const L = boneLength(b);
    const st = styleFor(ob, arm, b, s);
    switch (arm.drawType) {
      case 'STICK': {
        B.seg(m, V(0, 0, 0), V(0, L, 0), st.wire);
        B.point(m, V(0, 0, 0), st.head.equals(BONE_COL.wire) ? BONE_COL.solid : st.head);
        B.point(m, V(0, L, 0), st.tail.equals(BONE_COL.wire) ? BONE_COL.solid : st.tail);
        break;
      }
      case 'WIRE': {
        B.seg(m, V(0, 0, 0), V(0, L, 0), st.wire.equals(BONE_COL.wire) ? BONE_COL.solid : st.wire);
        break;
      }
      case 'BBONE': {
        box(B, m, L, b.bboneX, b.bboneZ, st.solid, st.wire);
        if (editing) { B.point(m, V(0, 0, 0), st.head); B.point(m, V(0, L, 0), st.tail); }
        break;
      }
      case 'ENVELOPE': {
        const sc = new Vector3().setFromMatrixColumn(m, 1).length() || 1;
        void sc;
        B.sphere(m, V(0, 0, 0), b.headRadius, st.head.equals(BONE_COL.wire) ? BONE_COL.solid : st.head, null);
        B.sphere(m, V(0, L, 0), b.tailRadius, st.tail.equals(BONE_COL.wire) ? BONE_COL.solid : st.tail, null);
        // tapered body
        const seg = 12;
        for (let i = 0; i < seg; i++) {
          const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
          const p0 = V(Math.cos(a0) * b.headRadius, 0, Math.sin(a0) * b.headRadius), p1 = V(Math.cos(a1) * b.headRadius, 0, Math.sin(a1) * b.headRadius);
          const q0 = V(Math.cos(a0) * b.tailRadius, L, Math.sin(a0) * b.tailRadius), q1 = V(Math.cos(a1) * b.tailRadius, L, Math.sin(a1) * b.tailRadius);
          B.triangle(m, p0, q0, q1, st.solid); B.triangle(m, p0, q1, p1, st.solid);
        }
        B.seg(m, V(0, 0, 0), V(0, L, 0), st.wire);
        if (editing && b.select) {
          // the deform distance zone
          const r0 = b.headRadius + b.envelopeDistance, r1 = b.tailRadius + b.envelopeDistance;
          for (let i = 0; i < 24; i++) {
            const a0 = (i / 24) * Math.PI * 2, a1 = ((i + 1) / 24) * Math.PI * 2;
            B.seg(m, V(Math.cos(a0) * r0, 0, Math.sin(a0) * r0), V(Math.cos(a1) * r0, 0, Math.sin(a1) * r0), BONE_COL.editSelect, false);
            B.seg(m, V(Math.cos(a0) * r1, L, Math.sin(a0) * r1), V(Math.cos(a1) * r1, L, Math.sin(a1) * r1), BONE_COL.editSelect, false);
          }
        }
        break;
      }
      default: {
        octahedral(B, m, L, st.solid, st.wire);
        // joints
        const jr = 0.05 * L;
        B.sphere(m, V(0, 0, 0), jr, st.head.equals(BONE_COL.wire) ? BONE_COL.solid : st.head, null, 8);
        B.sphere(m, V(0, L, 0), jr, st.tail.equals(BONE_COL.wire) ? BONE_COL.solid : st.tail, null, 8);
      }
    }
    if (arm.showAxes) {
      const a = Math.max(0.1, L * 0.25);
      const t = V(0, L, 0);
      B.seg(m, t, t.clone().add(V(a, 0, 0)), new Color('#dc1e1e'), false);
      B.seg(m, t, t.clone().add(V(0, a, 0)), new Color('#2ec42e'), false);
      B.seg(m, t, t.clone().add(V(0, 0, a)), new Color('#3a6bf0'), false);
    }
    // dashed relationship line to an unconnected parent (edit/pose)
    if (b.parent && !b.useConnect && (editing || app.mode === 'POSE')) {
      const pm = mats.get(b.parent);
      const pb = arm.bones.find((x) => x.name === b.parent);
      if (pm && pb) {
        const ptail = V(0, boneLength(pb), 0).applyMatrix4(pm);
        const head = V(0, 0, 0).applyMatrix4(m);
        B.seg(unit, head, ptail, new Color(0.25, 0.25, 0.25), false);
      }
    }
  }
  B.build(root, ob.showXRay, solidShade || arm.drawType === 'ENVELOPE');
}

function armatureKey(ob: BObject, s: ObjectDrawState): string {
  const arm = armatureOf(app.doc, ob);
  if (!arm) return 'none';
  const editing = app.mode !== 'OBJECT' && app.editObject === ob.id ? app.mode : app.mode === 'WEIGHT_PAINT' ? 'WP' : 'OBJECT';
  const pose = editing === 'EDIT' ? '' : JSON.stringify(ob.pose);
  // constraint targets move the pose: include their world matrices
  const tgt = editing !== 'EDIT' ? Object.values(ob.pose ?? {}).flatMap((pb) => pb.constraints.map((c) => (c.target && app.doc.objects[c.target] ? app.matrices.world(app.doc.objects[c.target]).elements.join() : ''))).join() : '';
  const cons = tgt ? app.matrices.world(ob).elements.join() : '';
  return [editing, s.selected, s.active, s.display.shading, ob.showXRay, ob.drawType, JSON.stringify(arm), pose, tgt, cons].join('|');
}

/** Bone names (Display > Names). */
function drawNames(view: View3D, ob: BObject, ctx: CanvasRenderingContext2D): void {
  const arm = armatureOf(app.doc, ob);
  if (!arm?.showNames) return;
  const mats = boneMatrices(ob, arm);
  const w = app.matrices.world(ob);
  ctx.font = '11px "DejaVu Sans", Verdana, sans-serif';
  for (const b of arm.bones) {
    if (!isBoneVisible(arm, b)) continue;
    const m = mats.get(b.name);
    if (!m) continue;
    const p = new Vector3(0, boneLength(b) * 0.5, 0).applyMatrix4(m).applyMatrix4(w);
    const sp = view.view.project(p);
    if (sp.behind) continue;
    const sel = b.select && app.editObject === ob.id && (app.mode === 'EDIT' || app.mode === 'POSE');
    ctx.fillStyle = sel ? '#ffffff' : '#000000';
    ctx.fillText(b.name, sp.x + 6, sp.y + 4);
  }
}

registerObjectDrawer({ types: ['ARMATURE'], key: armatureKey, build: drawArmature, draw2D: drawNames });

// ------------------------------------------------------------------ lattice

registerObjectDrawer({
  types: ['LATTICE'],
  key: (ob, s) => {
    const lt = ob.data ? app.doc.lattices?.[ob.data] : null;
    const editing = app.mode === 'EDIT' && app.editObject === ob.id;
    return [editing, s.selected, s.active, JSON.stringify(lt)].join('|');
  },
  build: (ob, root, s) => {
    const lt = ob.data ? app.doc.lattices?.[ob.data] : null;
    if (!lt) return;
    const editing = app.mode === 'EDIT' && app.editObject === ob.id;
    const B = new Builder();
    const unit = new Matrix4();
    const wire = editing ? new Color(0, 0, 0) : s.selected ? (s.active ? BONE_COL.obActive : BONE_COL.obSelect) : new Color(0, 0, 0);
    for (const [a, b] of latticeEdges(lt)) B.seg(unit, V(...lt.points[a]), V(...lt.points[b]), wire);
    if (editing) lt.points.forEach((p, i) => B.point(unit, V(...p), lt.select[i] ? BONE_COL.editJointSel : new Color(0, 0, 0)));
    B.build(root, false, false);
  },
});
