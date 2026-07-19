// core/gl/bvh.js — static triangle BVH for collision + hitscan.
//
//   const bvh = buildBVH(positions, indices [, worldMatrix])
//   raycastBVH(bvh, origin, dir, maxDist)        → {t, point, normal, tri} | null
//   capsuleHitsBVH(bvh, p0, p1, radius, out[])   → MTV contacts against capsule
//
// Build: binned SAH over centroids (12 bins), leaves ≤ 8 tris. Stored flat:
//   nodes  Float32Array  per node: [minx,miny,minz, maxx,maxy,maxz, a, b]
//          a/b: interior → a=left child index, b=right child index (node indices)
//               leaf     → a=-(triStart+1), b=triCount
//   tris   Float32Array  9 floats per triangle (world-space, baked at build)
//
// Multiple meshes: concat with appendGeometry() before building.

import { vec3, v3sub, v3cross, v3dot, v3normalize, v3len, m4transformPoint } from './math.js';

const BINS = 12, LEAF_MAX = 8;

// Gather world-space triangle soup from one or more {positions, indices, world} entries.
export function triangleSoup(meshes) {
  let triCount = 0;
  for (const m of meshes) triCount += m.indices.length / 3;
  const tris = new Float32Array(triCount * 9);
  let o = 0;
  const p = vec3();
  for (const m of meshes) {
    const { positions, indices, world } = m;
    for (let i = 0; i < indices.length; i++) {
      const vi = indices[i] * 3;
      p[0] = positions[vi]; p[1] = positions[vi + 1]; p[2] = positions[vi + 2];
      if (world) m4transformPoint(world, p, p);
      tris[o++] = p[0]; tris[o++] = p[1]; tris[o++] = p[2];
    }
  }
  return tris;
}

// Parallel to triangleSoup: one RGB albedo per triangle (each mesh's `albedo` repeated
// for all its tris), in the SAME input order. Feed to buildBVH so a raycast can report
// the colour of the surface it hit (baked GI colour-bleed). Default mid-grey per mesh.
export function triangleSoupAlbedo(meshes) {
  let triCount = 0;
  for (const m of meshes) triCount += m.indices.length / 3;
  const alb = new Float32Array(triCount * 3);
  let o = 0;
  for (const m of meshes) {
    const a = m.albedo || [0.6, 0.6, 0.6];
    const n = m.indices.length / 3;
    for (let i = 0; i < n; i++) { alb[o++] = a[0]; alb[o++] = a[1]; alb[o++] = a[2]; }
  }
  return alb;
}

// `albedos` (optional) = Float32Array(triCount*3) in INPUT order; reordered alongside
// the triangles into `bvh.triAlbedo` so raycastBVH can return the hit surface's colour.
export function buildBVH(tris, albedos) {
  const triCount = tris.length / 9;
  if (!triCount) return { nodes: new Float32Array(8), tris, order: new Uint32Array(0) };

  // centroids + per-tri AABBs for the build
  const cent = new Float32Array(triCount * 3);
  const tmin = new Float32Array(triCount * 3);
  const tmax = new Float32Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    for (let c = 0; c < 3; c++) {
      const a = tris[t * 9 + c], b = tris[t * 9 + 3 + c], d = tris[t * 9 + 6 + c];
      tmin[t * 3 + c] = Math.min(a, b, d);
      tmax[t * 3 + c] = Math.max(a, b, d);
      cent[t * 3 + c] = (a + b + d) / 3;
    }
  }

  const order = new Uint32Array(triCount);
  for (let i = 0; i < triCount; i++) order[i] = i;

  const nodes = []; // [{min,max,a,b}] then flattened

  function nodeBounds(start, count) {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = start; i < start + count; i++) {
      const t = order[i];
      for (let c = 0; c < 3; c++) {
        if (tmin[t * 3 + c] < mn[c]) mn[c] = tmin[t * 3 + c];
        if (tmax[t * 3 + c] > mx[c]) mx[c] = tmax[t * 3 + c];
      }
    }
    return { mn, mx };
  }

  function build(start, count) {
    const idx = nodes.length;
    const { mn, mx } = nodeBounds(start, count);
    nodes.push({ mn, mx, a: 0, b: 0 });
    if (count <= LEAF_MAX) {
      nodes[idx].a = -(start + 1); nodes[idx].b = count;
      return idx;
    }

    // binned SAH on the centroid extent's longest axis (try all 3, pick best)
    let bestAxis = -1, bestSplit = -1, bestCost = Infinity;
    for (let axis = 0; axis < 3; axis++) {
      let cmin = Infinity, cmax = -Infinity;
      for (let i = start; i < start + count; i++) {
        const v = cent[order[i] * 3 + axis];
        if (v < cmin) cmin = v; if (v > cmax) cmax = v;
      }
      if (cmax - cmin < 1e-8) continue;
      const scale = BINS / (cmax - cmin);
      const binCount = new Array(BINS).fill(0);
      const binMin = Array.from({ length: BINS }, () => [Infinity, Infinity, Infinity]);
      const binMax = Array.from({ length: BINS }, () => [-Infinity, -Infinity, -Infinity]);
      for (let i = start; i < start + count; i++) {
        const t = order[i];
        let bi = Math.floor((cent[t * 3 + axis] - cmin) * scale);
        if (bi >= BINS) bi = BINS - 1;
        binCount[bi]++;
        for (let c = 0; c < 3; c++) {
          if (tmin[t * 3 + c] < binMin[bi][c]) binMin[bi][c] = tmin[t * 3 + c];
          if (tmax[t * 3 + c] > binMax[bi][c]) binMax[bi][c] = tmax[t * 3 + c];
        }
      }
      // sweep: cost(split s) = leftArea*leftCount + rightArea*rightCount
      for (let s = 1; s < BINS; s++) {
        let lc = 0, la = null, lb = null;
        const lmn = [Infinity, Infinity, Infinity], lmx = [-Infinity, -Infinity, -Infinity];
        for (let b2 = 0; b2 < s; b2++) {
          if (!binCount[b2]) continue;
          lc += binCount[b2];
          for (let c = 0; c < 3; c++) {
            if (binMin[b2][c] < lmn[c]) lmn[c] = binMin[b2][c];
            if (binMax[b2][c] > lmx[c]) lmx[c] = binMax[b2][c];
          }
        }
        let rc = 0;
        const rmn = [Infinity, Infinity, Infinity], rmx = [-Infinity, -Infinity, -Infinity];
        for (let b2 = s; b2 < BINS; b2++) {
          if (!binCount[b2]) continue;
          rc += binCount[b2];
          for (let c = 0; c < 3; c++) {
            if (binMin[b2][c] < rmn[c]) rmn[c] = binMin[b2][c];
            if (binMax[b2][c] > rmx[c]) rmx[c] = binMax[b2][c];
          }
        }
        if (!lc || !rc) continue;
        const cost = area(lmn, lmx) * lc + area(rmn, rmx) * rc;
        if (cost < bestCost) { bestCost = cost; bestAxis = axis; bestSplit = cmin + (s / BINS) * (cmax - cmin); }
      }
    }

    let mid;
    if (bestAxis < 0) {
      mid = start + (count >> 1); // degenerate: median split
    } else {
      // partition order[] in place around bestSplit
      let lo = start, hi = start + count - 1;
      while (lo <= hi) {
        if (cent[order[lo] * 3 + bestAxis] < bestSplit) lo++;
        else { const tmp = order[lo]; order[lo] = order[hi]; order[hi] = tmp; hi--; }
      }
      mid = lo;
      if (mid === start || mid === start + count) mid = start + (count >> 1);
    }

    nodes[idx].a = build(start, mid - start);
    nodes[idx].b = build(mid, start + count - mid);
    return idx;
  }

  build(0, triCount);

  // flatten + reorder triangle data to leaf order (cache-friendly)
  const flat = new Float32Array(nodes.length * 8);
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    flat[i * 8] = n.mn[0]; flat[i * 8 + 1] = n.mn[1]; flat[i * 8 + 2] = n.mn[2];
    flat[i * 8 + 3] = n.mx[0]; flat[i * 8 + 4] = n.mx[1]; flat[i * 8 + 5] = n.mx[2];
    flat[i * 8 + 6] = n.a; flat[i * 8 + 7] = n.b;
  }
  const sorted = new Float32Array(tris.length);
  for (let i = 0; i < triCount; i++) sorted.set(tris.subarray(order[i] * 9, order[i] * 9 + 9), i * 9);

  // reorder per-tri albedo into leaf order so triAlbedo[sortedTri] aligns with sorted tris
  let triAlbedo = null;
  if (albedos) {
    triAlbedo = new Float32Array(triCount * 3);
    for (let i = 0; i < triCount; i++) { const s = order[i] * 3; triAlbedo[i * 3] = albedos[s]; triAlbedo[i * 3 + 1] = albedos[s + 1]; triAlbedo[i * 3 + 2] = albedos[s + 2]; }
  }

  return { nodes: flat, tris: sorted, triCount, order, triAlbedo };  // order: sorted[i] = input tri order[i]
}

function area(mn, mx) {
  const dx = Math.max(0, mx[0] - mn[0]), dy = Math.max(0, mx[1] - mn[1]), dz = Math.max(0, mx[2] - mn[2]);
  return 2 * (dx * dy + dy * dz + dz * dx);
}

// ---------------------------------------------------------------- raycast

const stack = new Int32Array(64);

export function raycastBVH(bvh, origin, dir, maxDist = Infinity) {
  const { nodes, tris } = bvh;
  if (!bvh.triCount) return null;
  const inv = [1 / dir[0], 1 / dir[1], 1 / dir[2]];
  let sp = 0; stack[sp++] = 0;
  let best = null, bestT = maxDist;

  while (sp > 0) {
    const ni = stack[--sp] * 8;
    if (!rayAABB(origin, inv, nodes, ni, bestT)) continue;
    const a = nodes[ni + 6], b = nodes[ni + 7];
    if (a < 0) {
      const start = -a - 1, count = b;
      for (let t = start; t < start + count; t++) {
        const hit = rayTri(origin, dir, tris, t * 9, bestT);
        if (hit) { bestT = hit.t; best = hit; best.tri = t; }
      }
    } else {
      stack[sp++] = a; stack[sp++] = b;
    }
  }
  if (best) {
    best.point = vec3(origin[0] + dir[0] * best.t, origin[1] + dir[1] * best.t, origin[2] + dir[2] * best.t);
    if (bvh.triAlbedo) { const a = best.tri * 3; best.albedo = [bvh.triAlbedo[a], bvh.triAlbedo[a + 1], bvh.triAlbedo[a + 2]]; }
  }
  return best;
}

function rayAABB(o, inv, nodes, ni, tmaxLimit) {
  let tmin = 0, tmax = tmaxLimit;
  for (let c = 0; c < 3; c++) {
    let t1 = (nodes[ni + c] - o[c]) * inv[c];
    let t2 = (nodes[ni + 3 + c] - o[c]) * inv[c];
    if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return false;
  }
  return true;
}

// Möller–Trumbore
function rayTri(o, d, tris, ti, tMax) {
  const ax = tris[ti], ay = tris[ti + 1], az = tris[ti + 2];
  const e1x = tris[ti + 3] - ax, e1y = tris[ti + 4] - ay, e1z = tris[ti + 5] - az;
  const e2x = tris[ti + 6] - ax, e2y = tris[ti + 7] - ay, e2z = tris[ti + 8] - az;
  const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-10) return null;
  const invDet = 1 / det;
  const tx = o[0] - ax, ty = o[1] - ay, tz = o[2] - az;
  const u = (tx * px + ty * py + tz * pz) * invDet;
  if (u < 0 || u > 1) return null;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (d[0] * qx + d[1] * qy + d[2] * qz) * invDet;
  if (v < 0 || u + v > 1) return null;
  const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;
  if (t < 1e-6 || t >= tMax) return null;
  let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
  const nl = Math.hypot(nx, ny, nz) || 1;
  nx /= nl; ny /= nl; nz /= nl;
  if (nx * d[0] + ny * d[1] + nz * d[2] > 0) { nx = -nx; ny = -ny; nz = -nz; } // face the ray
  return { t, normal: vec3(nx, ny, nz) };
}

// ---------------------------------------------------------------- analytic ray tests
// Shared primitives for picking non-triangle targets (spheres / world-AABBs) —
// so callers stop hand-rolling ray-vs-sphere inline. Both return the nearest
// FRONT-facing hit distance `t`, or Infinity on a miss.

// ray (origin o, unit dir d) vs sphere (center c, radius r)
export function raySphere(o, d, c, r) {
  const lx = c[0] - o[0], ly = c[1] - o[1], lz = c[2] - o[2];
  const tca = lx * d[0] + ly * d[1] + lz * d[2];
  const d2 = lx * lx + ly * ly + lz * lz - tca * tca;
  if (d2 > r * r) return Infinity;
  const thc = Math.sqrt(r * r - d2);
  const t0 = tca - thc;
  if (t0 >= 0) return t0;
  const t1 = tca + thc;      // origin inside the sphere → exit point
  return t1 >= 0 ? t1 : Infinity;
}

// ray vs axis-aligned box given by world min/max (slab test)
export function rayAABBHit(o, d, min, max) {
  let tmin = 0, tmax = Infinity;
  for (let i = 0; i < 3; i++) {
    const inv = 1 / d[i];
    let t1 = (min[i] - o[i]) * inv, t2 = (max[i] - o[i]) * inv;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return Infinity;
  }
  return tmin;
}

// ---------------------------------------------------------------- capsule query

// Capsule = segment p0→p1 with radius r. Pushes {depth, normal:[x,y,z]} MTV
// contacts into out[] for every triangle the capsule overlaps. Returns count.
const _c = vec3(), _n = vec3(), _e0 = vec3(), _e1 = vec3(), _e2 = vec3();
const _v0 = vec3(), _v1 = vec3(), _v2 = vec3(), _seg = vec3(), _tmp = vec3();

export function capsuleHitsBVH(bvh, p0, p1, radius, out) {
  const { nodes, tris } = bvh;
  out.length = 0;
  if (!bvh.triCount) return 0;
  // capsule AABB
  const mn = [Math.min(p0[0], p1[0]) - radius, Math.min(p0[1], p1[1]) - radius, Math.min(p0[2], p1[2]) - radius];
  const mx = [Math.max(p0[0], p1[0]) + radius, Math.max(p0[1], p1[1]) + radius, Math.max(p0[2], p1[2]) + radius];

  let sp = 0; stack[sp++] = 0;
  while (sp > 0) {
    const ni = stack[--sp] * 8;
    if (nodes[ni] > mx[0] || nodes[ni + 3] < mn[0] ||
        nodes[ni + 1] > mx[1] || nodes[ni + 4] < mn[1] ||
        nodes[ni + 2] > mx[2] || nodes[ni + 5] < mn[2]) continue;
    const a = nodes[ni + 6], b = nodes[ni + 7];
    if (a < 0) {
      const start = -a - 1;
      for (let t = start; t < start + b; t++) capsuleTri(p0, p1, radius, tris, t * 9, out);
    } else { stack[sp++] = a; stack[sp++] = b; }
  }
  return out.length;
}

// Visit every triangle whose leaf-node AABB overlaps [mn,mx]. cb(tris, ti) gets
// the flat tri array + the float offset (9 floats: v0,v1,v2). Used by physics3d
// for box-vs-level SAT (sphere/capsule reuse capsuleHitsBVH directly).
export function forEachTriInAABB(bvh, mn, mx, cb) {
  const { nodes, tris } = bvh;
  if (!bvh.triCount) return;
  let sp = 0; stack[sp++] = 0;
  while (sp > 0) {
    const ni = stack[--sp] * 8;
    if (nodes[ni] > mx[0] || nodes[ni + 3] < mn[0] ||
        nodes[ni + 1] > mx[1] || nodes[ni + 4] < mn[1] ||
        nodes[ni + 2] > mx[2] || nodes[ni + 5] < mn[2]) continue;
    const a = nodes[ni + 6], b = nodes[ni + 7];
    if (a < 0) { const start = -a - 1; for (let t = start; t < start + b; t++) cb(tris, t * 9); }
    else { stack[sp++] = a; stack[sp++] = b; }
  }
}

function capsuleTri(p0, p1, r, tris, ti, out) {
  _v0[0] = tris[ti]; _v0[1] = tris[ti + 1]; _v0[2] = tris[ti + 2];
  _v1[0] = tris[ti + 3]; _v1[1] = tris[ti + 4]; _v1[2] = tris[ti + 5];
  _v2[0] = tris[ti + 6]; _v2[1] = tris[ti + 7]; _v2[2] = tris[ti + 8];

  // triangle normal
  v3sub(_v1, _v0, _e0); v3sub(_v2, _v0, _e1);
  v3cross(_e0, _e1, _n);
  const nl = v3len(_n);
  if (nl < 1e-10) return;
  _n[0] /= nl; _n[1] /= nl; _n[2] /= nl;

  // reference point on the capsule segment: clamp the segment to the tri plane
  v3sub(p1, p0, _seg);
  const denom = v3dot(_n, _seg);
  let s;
  if (Math.abs(denom) < 1e-8) s = 0.5;
  else {
    v3sub(_v0, p0, _tmp);
    s = v3dot(_n, _tmp) / denom;
    s = Math.max(0, Math.min(1, s));
  }
  _c[0] = p0[0] + _seg[0] * s; _c[1] = p0[1] + _seg[1] * s; _c[2] = p0[2] + _seg[2] * s;

  // closest point on triangle to _c
  const cp = closestPointOnTri(_c, _v0, _v1, _v2, _tmp);
  // re-find the closest point on the SEGMENT to cp (handles edge grazes)
  const sp2 = closestOnSegment(p0, p1, cp, _c);
  const dx = sp2[0] - cp[0], dy = sp2[1] - cp[1], dz = sp2[2] - cp[2];
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 >= r * r) return;
  const d = Math.sqrt(d2);
  let nx, ny, nz;
  if (d > 1e-8) { nx = dx / d; ny = dy / d; nz = dz / d; }
  else { nx = _n[0]; ny = _n[1]; nz = _n[2]; } // dead-center: push along face normal
  out.push({ depth: r - d, normal: [nx, ny, nz] });
}

function closestOnSegment(a, b, p, out) {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const t0 = ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby + (p[2] - a[2]) * abz) /
             (abx * abx + aby * aby + abz * abz || 1);
  const t = Math.max(0, Math.min(1, t0));
  out[0] = a[0] + abx * t; out[1] = a[1] + aby * t; out[2] = a[2] + abz * t;
  return out;
}

function closestPointOnTri(p, a, b, c, out) {
  // Ericson, Real-Time Collision Detection §5.1.5
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const acx = c[0] - a[0], acy = c[1] - a[1], acz = c[2] - a[2];
  const apx = p[0] - a[0], apy = p[1] - a[1], apz = p[2] - a[2];
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) { out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; return out; }
  const bpx = p[0] - b[0], bpy = p[1] - b[1], bpz = p[2] - b[2];
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) { out[0] = b[0]; out[1] = b[1]; out[2] = b[2]; return out; }
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    out[0] = a[0] + abx * v; out[1] = a[1] + aby * v; out[2] = a[2] + abz * v; return out;
  }
  const cpx = p[0] - c[0], cpy = p[1] - c[1], cpz = p[2] - c[2];
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) { out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; return out; }
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    out[0] = a[0] + acx * w; out[1] = a[1] + acy * w; out[2] = a[2] + acz * w; return out;
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    out[0] = b[0] + (c[0] - b[0]) * w; out[1] = b[1] + (c[1] - b[1]) * w; out[2] = b[2] + (c[2] - b[2]) * w;
    return out;
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  out[0] = a[0] + abx * v + acx * w;
  out[1] = a[1] + aby * v + acy * w;
  out[2] = a[2] + abz * v + acz * w;
  return out;
}
