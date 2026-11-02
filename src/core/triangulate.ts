// 2D polygon triangulation with holes (ear clipping; holes are joined to the outer
// boundary with bridge edges first). Used for filled 2D curves, curve caps and text.

export type P2 = [number, number];

/** Twice the signed area (positive = counter-clockwise). */
export function signedArea2(pts: P2[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] - pts[i][0]) * (pts[j][1] + pts[i][1]);
  return a;
}

export function pointInPolygon(x: number, y: number, pts: P2[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const cross3 = (a: P2, b: P2, c: P2) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

function inTriangle(p: P2, a: P2, b: P2, c: P2): boolean {
  const d1 = cross3(a, b, p), d2 = cross3(b, c, p), d3 = cross3(c, a, p);
  return d1 >= -1e-12 && d2 >= -1e-12 && d3 >= -1e-12;
}

function segmentsCross(a: P2, b: P2, c: P2, d: P2): boolean {
  const d1 = cross3(c, d, a), d2 = cross3(c, d, b), d3 = cross3(a, b, c), d4 = cross3(a, b, d);
  return ((d1 > 1e-12 && d2 < -1e-12) || (d1 < -1e-12 && d2 > 1e-12)) && ((d3 > 1e-12 && d4 < -1e-12) || (d3 < -1e-12 && d4 > 1e-12));
}

/**
 * Triangulate a polygon (outer ring) with optional holes. Rings are lists of indices into `pts`.
 * Orientation of the input does not matter. Returns triangles as index triples (counter-clockwise).
 */
export function triangulate(pts: P2[], outer: number[], holes: number[][] = []): [number, number, number][] {
  if (outer.length < 3) return [];
  const ringPts = (r: number[]) => r.map((i) => pts[i]);
  let ring = outer.slice();
  if (signedArea2(ringPts(ring)) < 0) ring.reverse();
  // join holes, rightmost hole first, each to a visible vertex of the current ring
  const hs = holes.filter((h) => h.length >= 3).map((h) => (signedArea2(ringPts(h)) > 0 ? h.slice().reverse() : h.slice()));
  hs.sort((a, b) => Math.max(...b.map((i) => pts[i][0])) - Math.max(...a.map((i) => pts[i][0])));
  for (const hole of hs) ring = bridgeHole(pts, ring, hole);
  return earClip(pts, ring);
}

function bridgeHole(pts: P2[], ring: number[], hole: number[]): number[] {
  // rightmost vertex of the hole
  let hi = 0;
  for (let i = 1; i < hole.length; i++) if (pts[hole[i]][0] > pts[hole[hi]][0]) hi = i;
  const hp = pts[hole[hi]];
  // candidate ring vertices sorted by distance; take the first whose bridge crosses no edge
  const order = ring.map((_, i) => i).sort((a, b) => {
    const pa = pts[ring[a]], pb = pts[ring[b]];
    const da = (pa[0] - hp[0]) ** 2 + (pa[1] - hp[1]) ** 2, db = (pb[0] - hp[0]) ** 2 + (pb[1] - hp[1]) ** 2;
    // prefer vertices to the right (like the classic algorithm), then distance
    return (pa[0] >= hp[0] ? 0 : 1) - (pb[0] >= hp[0] ? 0 : 1) || da - db;
  });
  let best = order[0];
  for (const ri of order) {
    const rp = pts[ring[ri]];
    let ok = true;
    for (let k = 0; k < ring.length && ok; k++) {
      const a = pts[ring[k]], b = pts[ring[(k + 1) % ring.length]];
      if (ring[k] === ring[ri] || ring[(k + 1) % ring.length] === ring[ri]) continue;
      if (segmentsCross(hp, rp, a, b)) ok = false;
    }
    for (let k = 0; k < hole.length && ok; k++) {
      const a = pts[hole[k]], b = pts[hole[(k + 1) % hole.length]];
      if (k === hi || (k + 1) % hole.length === hi) continue;
      if (segmentsCross(hp, rp, a, b)) ok = false;
    }
    if (ok) { best = ri; break; }
  }
  const holeSeq: number[] = [];
  for (let k = 0; k <= hole.length; k++) holeSeq.push(hole[(hi + k) % hole.length]);
  return [...ring.slice(0, best + 1), ...holeSeq, ...ring.slice(best)];
}

function earClip(pts: P2[], ring: number[]): [number, number, number][] {
  const out: [number, number, number][] = [];
  const idx = ring.slice();
  let guard = 0;
  while (idx.length > 3 && guard++ < 100000) {
    let clipped = false;
    const n = idx.length;
    for (let i = 0; i < n; i++) {
      const i0 = idx[(i + n - 1) % n], i1 = idx[i], i2 = idx[(i + 1) % n];
      const a = pts[i0], b = pts[i1], c = pts[i2];
      if (cross3(a, b, c) <= 1e-14) continue; // reflex or degenerate
      let ear = true;
      for (let k = 0; k < n; k++) {
        const v = idx[k];
        if (v === i0 || v === i1 || v === i2) continue;
        const p = pts[v];
        if ((p[0] === a[0] && p[1] === a[1]) || (p[0] === b[0] && p[1] === b[1]) || (p[0] === c[0] && p[1] === c[1])) continue;
        if (inTriangle(p, a, b, c)) { ear = false; break; }
      }
      if (!ear) continue;
      out.push([i0, i1, i2]);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) {
      // degenerate input (self intersections / collinear runs): remove a vertex with the smallest turn
      let bi = 0, bv = Infinity;
      for (let i = 0; i < idx.length; i++) {
        const n2 = idx.length;
        const v = Math.abs(cross3(pts[idx[(i + n2 - 1) % n2]], pts[idx[i]], pts[idx[(i + 1) % n2]]));
        if (v < bv) { bv = v; bi = i; }
      }
      const n2 = idx.length;
      const t: [number, number, number] = [idx[(bi + n2 - 1) % n2], idx[bi], idx[(bi + 1) % n2]];
      if (cross3(pts[t[0]], pts[t[1]], pts[t[2]]) > 1e-14) out.push(t);
      idx.splice(bi, 1);
    }
  }
  if (idx.length === 3 && cross3(pts[idx[0]], pts[idx[1]], pts[idx[2]]) > 1e-14) out.push([idx[0], idx[1], idx[2]]);
  return out;
}

/**
 * Group closed 2D rings into polygons with holes by nesting depth (even-odd rule, like
 * Blender's filled 2D curves). Returns [outerRingIndex, holeRingIndices[]] pairs.
 */
export function nestRings(rings: P2[][]): [number, number[]][] {
  const n = rings.length;
  const area = rings.map((r) => Math.abs(signedArea2(r)));
  const parent: number[] = new Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    if (!rings[i].length) continue;
    const p = rings[i][0];
    // smallest ring that contains this one
    let best = -1;
    for (let j = 0; j < n; j++) {
      if (j === i || area[j] <= area[i] || !rings[j].length) continue;
      if (pointInPolygon(p[0], p[1], rings[j]) && (best < 0 || area[j] < area[best])) best = j;
    }
    parent[i] = best;
  }
  const depth = (i: number): number => { let d = 0; for (let p = parent[i]; p >= 0; p = parent[p]) d++; return d; };
  const out: [number, number[]][] = [];
  for (let i = 0; i < n; i++) {
    if (rings[i].length < 3 || depth(i) % 2) continue;
    out.push([i, rings.map((_, j) => j).filter((j) => parent[j] === i && rings[j].length >= 3)]);
  }
  return out;
}
