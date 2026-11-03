// Drawing helpers for edit overlays of non-mesh objects: vertex-coloured points and lines that
// are drawn on top of the geometry (like Blender's curve / metaball edit drawing).

import { BufferAttribute, BufferGeometry, LineSegments, Points, ShaderMaterial } from 'three';

const POINT_VS = `
attribute vec3 color; varying vec3 vColor; uniform float size; uniform float bias;
void main(){ vColor = color; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv; gl_Position.z -= bias * gl_Position.w; gl_PointSize = size; }`;
const POINT_FS = `
varying vec3 vColor;
void main(){ vec2 d = gl_PointCoord - 0.5; if (dot(d,d) > 0.25) discard; gl_FragColor = vec4(vColor, 1.0); }`;
const LINE_VS = `
attribute vec3 color; varying vec3 vColor; uniform float bias;
void main(){ vColor = color; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position.z -= bias * gl_Position.w; }`;
const LINE_FS = `varying vec3 vColor; void main(){ gl_FragColor = vec4(vColor, 1.0); }`;

const pixelRatio = () => Math.min(2, window.devicePixelRatio || 1);

function geometry(positions: number[], colors: number[]): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
  g.computeBoundingSphere();
  return g;
}

/** Round vertex-coloured points (size in CSS pixels), on top of the geometry unless `depthTest`. */
export function editPoints(positions: number[], colors: number[], size = 5, opts: { depthTest?: boolean } = {}): Points {
  const m = new ShaderMaterial({
    vertexShader: POINT_VS, fragmentShader: POINT_FS, depthTest: opts.depthTest ?? false, depthWrite: false,
    uniforms: { size: { value: size * pixelRatio() }, bias: { value: 0.0008 } },
  });
  const p = new Points(geometry(positions, colors), m);
  p.renderOrder = 32;
  p.frustumCulled = false;
  return p;
}

/** Vertex-coloured line segments (pairs of points), on top of the geometry unless `depthTest`. */
export function editLines(positions: number[], colors: number[], opts: { depthTest?: boolean } = {}): LineSegments {
  const m = new ShaderMaterial({ vertexShader: LINE_VS, fragmentShader: LINE_FS, depthTest: opts.depthTest ?? false, depthWrite: false, uniforms: { bias: { value: 0.0005 } } });
  const l = new LineSegments(geometry(positions, colors), m);
  l.renderOrder = 31;
  l.frustumCulled = false;
  return l;
}
