// Bounding volume hierarchy for the path tracer: a binned SAH build over triangle bounds,
// flattened in depth-first order so that an interior node's first child directly follows it.
//
// Node layout (2 RGBA32F texels per node, see packNodes):
//   texel 0: bounds min xyz, w = index of the second child (interior) or of the first triangle (leaf)
//   texel 1: bounds max xyz, w = triangle count (leaf, > 0) or -(split axis + 1) (interior)

export interface BvhResult {
  /** Flattened nodes, 8 floats each (see the layout above). */
  nodes: Float32Array;
  nodeCount: number;
  /** Triangle order: the leaf ranges index into this permutation of the input triangles. */
  order: Uint32Array;
}

const BINS = 12;
const MAX_LEAF = 4;
const TRAVERSAL_COST = 1.0;
const INTERSECT_COST = 1.0;

/**
 * Build a BVH over `n` triangles given as 9 floats each (v0, v1, v2).
 * Runs in O(n log n); iterative, so degenerate inputs cannot overflow the call stack.
 */
export function buildBvh(tri: Float32Array, n: number): BvhResult {
  const order = new Uint32Array(n);
  const bmin = new Float32Array(n * 3), bmax = new Float32Array(n * 3), cen = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    order[i] = i;
    for (let a = 0; a < 3; a++) {
      const x0 = tri[i * 9 + a], x1 = tri[i * 9 + 3 + a], x2 = tri[i * 9 + 6 + a];
      const lo = Math.min(x0, x1, x2), hi = Math.max(x0, x1, x2);
      bmin[i * 3 + a] = lo;
      bmax[i * 3 + a] = hi;
      cen[i * 3 + a] = (lo + hi) * 0.5;
    }
  }
  let cap = Math.max(1, 2 * n);
  let nodes = new Float32Array(cap * 8);
  let count = 0;
  const alloc = (): number => {
    if (count >= cap) {
      cap *= 2;
      const nn = new Float32Array(cap * 8);
      nn.set(nodes);
      nodes = nn;
    }
    return count++;
  };

  // scratch for binning
  const binCount = new Int32Array(BINS);
  const binMin = new Float32Array(BINS * 3), binMax = new Float32Array(BINS * 3);
  const rightArea = new Float32Array(BINS), rightCount = new Int32Array(BINS);

  // work stack: [nodeIndex, start, end]
  const stack: number[] = [];
  const root = alloc();
  stack.push(root, 0, n);
  while (stack.length) {
    const end = stack.pop()!, start = stack.pop()!;
    let node = stack.pop()!;
    if (node < 0) {
      // "right child of node P": allocated only now, after the left sibling's whole subtree
      const parent = -1 - node;
      node = alloc();
      nodes[parent * 8 + 3] = node;
    }
    // node bounds and centroid bounds
    let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    let cnx = Infinity, cny = Infinity, cnz = Infinity, cxx = -Infinity, cxy = -Infinity, cxz = -Infinity;
    for (let k = start; k < end; k++) {
      const i = order[k] * 3;
      if (bmin[i] < mnx) mnx = bmin[i];
      if (bmin[i + 1] < mny) mny = bmin[i + 1];
      if (bmin[i + 2] < mnz) mnz = bmin[i + 2];
      if (bmax[i] > mxx) mxx = bmax[i];
      if (bmax[i + 1] > mxy) mxy = bmax[i + 1];
      if (bmax[i + 2] > mxz) mxz = bmax[i + 2];
      const x = cen[i], y = cen[i + 1], z = cen[i + 2];
      if (x < cnx) cnx = x;
      if (y < cny) cny = y;
      if (z < cnz) cnz = z;
      if (x > cxx) cxx = x;
      if (y > cxy) cxy = y;
      if (z > cxz) cxz = z;
    }
    const o = node * 8;
    if (end === start) { mnx = mny = mnz = mxx = mxy = mxz = 0; }
    nodes[o] = mnx; nodes[o + 1] = mny; nodes[o + 2] = mnz;
    nodes[o + 4] = mxx; nodes[o + 5] = mxy; nodes[o + 6] = mxz;
    const cnt = end - start;
    const makeLeaf = () => { nodes[o + 3] = start; nodes[o + 7] = Math.max(cnt, 0); };
    if (cnt <= MAX_LEAF) { makeLeaf(); continue; }

    // choose the split with the binned surface area heuristic
    const ext = [cxx - cnx, cxy - cny, cxz - cnz];
    const cmin = [cnx, cny, cnz];
    let bestAxis = -1, bestBin = -1, bestCost = Infinity;
    for (let axis = 0; axis < 3; axis++) {
      if (ext[axis] <= 1e-12) continue;
      binCount.fill(0);
      binMin.fill(Infinity);
      binMax.fill(-Infinity);
      const scale = BINS / ext[axis];
      for (let k = start; k < end; k++) {
        const i = order[k] * 3;
        let b = Math.floor((cen[i + axis] - cmin[axis]) * scale);
        if (b >= BINS) b = BINS - 1;
        binCount[b]++;
        for (let a = 0; a < 3; a++) {
          if (bmin[i + a] < binMin[b * 3 + a]) binMin[b * 3 + a] = bmin[i + a];
          if (bmax[i + a] > binMax[b * 3 + a]) binMax[b * 3 + a] = bmax[i + a];
        }
      }
      // sweep from the right
      let rx0 = Infinity, ry0 = Infinity, rz0 = Infinity, rx1 = -Infinity, ry1 = -Infinity, rz1 = -Infinity, rc = 0;
      for (let b = BINS - 1; b > 0; b--) {
        if (binCount[b]) {
          rx0 = Math.min(rx0, binMin[b * 3]); ry0 = Math.min(ry0, binMin[b * 3 + 1]); rz0 = Math.min(rz0, binMin[b * 3 + 2]);
          rx1 = Math.max(rx1, binMax[b * 3]); ry1 = Math.max(ry1, binMax[b * 3 + 1]); rz1 = Math.max(rz1, binMax[b * 3 + 2]);
          rc += binCount[b];
        }
        rightCount[b] = rc;
        rightArea[b] = rc ? area(rx1 - rx0, ry1 - ry0, rz1 - rz0) : 0;
      }
      // sweep from the left and evaluate
      let lx0 = Infinity, ly0 = Infinity, lz0 = Infinity, lx1 = -Infinity, ly1 = -Infinity, lz1 = -Infinity, lc = 0;
      for (let b = 0; b < BINS - 1; b++) {
        if (binCount[b]) {
          lx0 = Math.min(lx0, binMin[b * 3]); ly0 = Math.min(ly0, binMin[b * 3 + 1]); lz0 = Math.min(lz0, binMin[b * 3 + 2]);
          lx1 = Math.max(lx1, binMax[b * 3]); ly1 = Math.max(ly1, binMax[b * 3 + 1]); lz1 = Math.max(lz1, binMax[b * 3 + 2]);
          lc += binCount[b];
        }
        const rcnt = rightCount[b + 1];
        if (!lc || !rcnt) continue;
        const cost = (lc ? area(lx1 - lx0, ly1 - ly0, lz1 - lz0) * lc : 0) + rightArea[b + 1] * rcnt;
        if (cost < bestCost) { bestCost = cost; bestAxis = axis; bestBin = b; }
      }
    }
    const parentArea = area(mxx - mnx, mxy - mny, mxz - mnz);
    let mid: number;
    if (bestAxis < 0) {
      // all centroids coincide: split by index if the leaf would be too large
      if (cnt <= 16) { makeLeaf(); continue; }
      mid = (start + end) >> 1;
      bestAxis = 0;
    } else {
      const leafCost = INTERSECT_COST * cnt;
      const splitCost = TRAVERSAL_COST + (INTERSECT_COST * bestCost) / Math.max(parentArea, 1e-20);
      if (splitCost >= leafCost && cnt <= 16) { makeLeaf(); continue; }
      // partition in place
      const scale = BINS / ext[bestAxis];
      let i0 = start, i1 = end - 1;
      while (i0 <= i1) {
        const t = order[i0];
        let b = Math.floor((cen[t * 3 + bestAxis] - cmin[bestAxis]) * scale);
        if (b >= BINS) b = BINS - 1;
        if (b <= bestBin) i0++;
        else { order[i0] = order[i1]; order[i1] = t; i1--; }
      }
      mid = i0;
      if (mid === start || mid === end) mid = (start + end) >> 1;
    }
    // depth-first layout: the left child directly follows its parent; the right child is pushed as a
    // placeholder (negative index) and allocated when popped, after the left subtree is complete
    const left = alloc();
    nodes[o + 7] = -(bestAxis + 1);
    stack.push(-1 - node, mid, end);
    stack.push(left, start, mid);
  }
  return { nodes: nodes.subarray(0, count * 8), nodeCount: count, order };
}

function area(x: number, y: number, z: number): number {
  return 2 * (x * y + y * z + z * x);
}
