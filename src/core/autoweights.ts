// Automatic bone weights ("With Automatic Weights"): every vertex is heated by its nearest bone(s);
// the heat diffuses over the mesh edges (a screened Poisson / heat equation solved with Gauss-Seidel
// iterations) so that weights blend smoothly between bones, and the result is normalised.

import type { Bone, Vec3 } from './types';
import { envelopeWeight } from './armature';
import { Vector3 } from 'three';

function segDist(p: Vec3, a: Vec3, b: Vec3): number {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const l2 = abx * abx + aby * aby + abz * abz;
  let t = l2 > 0 ? ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby + (p[2] - a[2]) * abz) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + abx * t), p[1] - (a[1] + aby * t), p[2] - (a[2] + abz * t));
}

/**
 * Weights per bone (array per bone, one value per vertex). `verts` must be in armature space.
 * Weights below 0.01 are dropped and the rest normalised per vertex.
 */
export function automaticWeights(verts: Vec3[], edges: [number, number][], bones: Bone[], iterations = 150): Float32Array[] {
  const nv = verts.length, nb = bones.length;
  const out = bones.map(() => new Float32Array(nv));
  if (!nv || !nb) return out;
  const dist = bones.map((b) => Float32Array.from(verts, (p) => segDist(p, b.head, b.tail)));
  const dmin = new Float32Array(nv).fill(Infinity);
  for (let b = 0; b < nb; b++) for (let v = 0; v < nv; v++) dmin[v] = Math.min(dmin[v], dist[b][v]);
  // adjacency (CSR)
  const deg = new Int32Array(nv);
  for (const [a, b] of edges) { deg[a]++; deg[b]++; }
  const start = new Int32Array(nv + 1);
  for (let v = 0; v < nv; v++) start[v + 1] = start[v] + deg[v];
  const fill = start.slice(0, nv);
  const adj = new Int32Array(start[nv]);
  let lenSum = 0;
  for (const [a, b] of edges) {
    adj[fill[a]++] = b; adj[fill[b]++] = a;
    lenSum += Math.hypot(verts[a][0] - verts[b][0], verts[a][1] - verts[b][1], verts[a][2] - verts[b][2]);
  }
  const avgLen = edges.length ? lenSum / edges.length : 1;
  // heat transfer coefficient: strong near a bone, weak far away
  const H = Float32Array.from(dmin, (d) => Math.min(1e4, (avgLen * avgLen) / Math.max(d * d, 1e-8)));
  for (let b = 0; b < nb; b++) {
    const p = new Float32Array(nv);
    for (let v = 0; v < nv; v++) {
      // nearest bone(s): ties share the heat
      if (dist[b][v] <= dmin[v] * 1.0001 + 1e-9) {
        let ties = 0;
        for (let c = 0; c < nb; c++) if (dist[c][v] <= dmin[v] * 1.0001 + 1e-9) ties++;
        p[v] = 1 / ties;
      }
    }
    const w = Float32Array.from(p);
    for (let it = 0; it < iterations; it++) {
      let change = 0;
      for (let v = 0; v < nv; v++) {
        const d = deg[v];
        if (!d) { w[v] = p[v]; continue; }
        let s = 0;
        for (let k = start[v]; k < start[v + 1]; k++) s += w[adj[k]];
        const nw = (s + H[v] * p[v]) / (d + H[v]);
        change = Math.max(change, Math.abs(nw - w[v]));
        w[v] = nw;
      }
      if (change < 1e-5) break;
    }
    out[b] = w;
  }
  normalize(out, nv);
  return out;
}

/** Envelope-based weights (With Envelope Weights). */
export function envelopeWeights(verts: Vec3[], bones: Bone[]): Float32Array[] {
  const p = new Vector3();
  return bones.map((b) => Float32Array.from(verts, (v) => envelopeWeight(b, p.set(v[0], v[1], v[2]))));
}

function normalize(ws: Float32Array[], nv: number): void {
  for (let v = 0; v < nv; v++) {
    let s = 0;
    for (const w of ws) { if (w[v] < 0.01) w[v] = 0; s += w[v]; }
    if (s > 0) for (const w of ws) w[v] /= s;
  }
}
