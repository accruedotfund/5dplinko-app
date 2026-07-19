// core/gl/procgen3d/mesh-builder.js — THE bridge of the procgen3d layer.
//
// Every 3D generator (terrain, rock, tree, character, cave…) pushes triangles
// into a MeshBuilder and calls `.toSceneGraph(material)`. The result is the exact
// SceneGraph shape `renderer.uploadScene()` consumes (same as primitives.js
// boxScene) — so anything generated drops straight into a gl-scene with full
// instancing / culling / lighting support, no special-casing in the renderer.
//
//   const mb = new MeshBuilder();
//   mb.box([0,0,0], [0.5,1,0.5]);                 // a quick box
//   const a = mb.vertex(x,y,z, nx,ny,nz, u,v);     // explicit vertex → index
//   mb.tri(a, b, c);                               // triangle by index
//   mb.addTri([x0,y0,z0],[x1,y1,z1],[x2,y2,z2]);   // flat-shaded tri (auto normal)
//   mb.pushMesh(otherSceneGraphPrimitive, mat4?);  // merge another mesh
//   const sg = mb.toSceneGraph({ color:[.4,.6,.3], roughness:.9 });
//
// Pure: no GL, no DOM. Indices are 32-bit (Uint32) so big terrain chunks are fine.

import { mat4 } from '../math.js';
import { defaultMaterial } from '../gltf.js';

export class MeshBuilder {
  constructor() {
    this.pos = [];   // x,y,z …
    this.nrm = [];   // nx,ny,nz …
    this.uv = [];    // u,v …
    this.idx = [];   // triangle indices
  }

  get vertexCount() { return this.pos.length / 3; }
  get triCount() { return this.idx.length / 3; }

  // explicit vertex; returns its index. normal defaults to up, uv to 0.
  vertex(x, y, z, nx = 0, ny = 1, nz = 0, u = 0, v = 0) {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.uv.push(u, v);
    return this.pos.length / 3 - 1;
  }

  tri(a, b, c) { this.idx.push(a, b, c); return this; }
  quad(a, b, c, d) { this.idx.push(a, b, c, a, c, d); return this; }

  // flat-shaded triangle from three positions — computes the face normal.
  addTri(p0, p1, p2, uv0 = [0, 0], uv1 = [1, 0], uv2 = [0, 1]) {
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
    const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    const a = this.vertex(p0[0], p0[1], p0[2], nx, ny, nz, uv0[0], uv0[1]);
    const b = this.vertex(p1[0], p1[1], p1[2], nx, ny, nz, uv1[0], uv1[1]);
    const c = this.vertex(p2[0], p2[1], p2[2], nx, ny, nz, uv2[0], uv2[1]);
    this.tri(a, b, c);
    return this;
  }

  addQuad(p0, p1, p2, p3) { this.addTri(p0, p1, p2); this.addTri(p0, p2, p3); return this; }

  // an axis-aligned box centered at c with half-extents h (24 verts, flat normals).
  box(c, h) {
    const [cx, cy, cz] = c, [hx, hy, hz] = h;
    const v = (x, y, z) => [cx + x * hx, cy + y * hy, cz + z * hz];
    const f = [
      [v(1, -1, 1), v(1, -1, -1), v(1, 1, -1), v(1, 1, 1)],   // +x
      [v(-1, -1, -1), v(-1, -1, 1), v(-1, 1, 1), v(-1, 1, -1)], // -x
      [v(-1, 1, 1), v(1, 1, 1), v(1, 1, -1), v(-1, 1, -1)],   // +y
      [v(-1, -1, -1), v(1, -1, -1), v(1, -1, 1), v(-1, -1, 1)], // -y
      [v(-1, -1, 1), v(1, -1, 1), v(1, 1, 1), v(-1, 1, 1)],   // +z
      [v(1, -1, -1), v(-1, -1, -1), v(-1, 1, -1), v(1, 1, -1)], // -z
    ];
    for (const [a, b, cc, d] of f) this.addQuad(a, b, cc, d);
    return this;
  }

  // merge a SceneGraph primitive ({positions,normals,uv0,indices}) into this builder,
  // optionally transformed by a mat4 (used to stamp instances / sub-parts).
  pushMesh(prim, m = null) {
    const base = this.vertexCount;
    const P = prim.positions, N = prim.normals, U = prim.uv0;
    for (let i = 0; i < P.length; i += 3) {
      let x = P[i], y = P[i + 1], z = P[i + 2];
      let nx = N ? N[i] : 0, ny = N ? N[i + 1] : 1, nz = N ? N[i + 2] : 0;
      if (m) {
        const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
        const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
        const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
        x = wx; y = wy; z = wz;
        const rx = m[0] * nx + m[4] * ny + m[8] * nz;
        const ry = m[1] * nx + m[5] * ny + m[9] * nz;
        const rz = m[2] * nx + m[6] * ny + m[10] * nz;
        const rl = Math.hypot(rx, ry, rz) || 1; nx = rx / rl; ny = ry / rl; nz = rz / rl;
      }
      this.pos.push(x, y, z); this.nrm.push(nx, ny, nz);
      const ui = (i / 3) * 2; this.uv.push(U ? U[ui] : 0, U ? U[ui + 1] : 0);
    }
    const I = prim.indices;
    for (let i = 0; i < I.length; i++) this.idx.push(base + I[i]);
    return this;
  }

  // merge a whole SceneGraph's first primitive (convenience).
  pushSceneGraph(sg, m = null) {
    const prim = sg?.meshes?.[0]?.primitives?.[0];
    if (prim) this.pushMesh(prim, m);
    return this;
  }

  // recompute smooth (area-weighted) vertex normals from the index buffer.
  computeSmoothNormals() {
    const n = this.pos.length;
    const acc = new Float32Array(n);
    for (let t = 0; t < this.idx.length; t += 3) {
      const a = this.idx[t] * 3, b = this.idx[t + 1] * 3, c = this.idx[t + 2] * 3;
      const ux = this.pos[b] - this.pos[a], uy = this.pos[b + 1] - this.pos[a + 1], uz = this.pos[b + 2] - this.pos[a + 2];
      const vx = this.pos[c] - this.pos[a], vy = this.pos[c + 1] - this.pos[a + 1], vz = this.pos[c + 2] - this.pos[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; // unnormalized = area-weighted
      for (const o of [a, b, c]) { acc[o] += nx; acc[o + 1] += ny; acc[o + 2] += nz; }
    }
    for (let i = 0; i < n; i += 3) {
      const l = Math.hypot(acc[i], acc[i + 1], acc[i + 2]) || 1;
      this.nrm[i] = acc[i] / l; this.nrm[i + 1] = acc[i + 1] / l; this.nrm[i + 2] = acc[i + 2] / l;
    }
    return this;
  }

  // FLAT shading (the low-poly look): unweld every triangle to its own 3 verts
  // with the face normal, so each facet reads as a crisp flat plane. Replaces the
  // index/normal buffers in place. Call this INSTEAD of computeSmoothNormals().
  faceted() {
    const P = this.pos, U = this.uv, I = this.idx;
    const np = [], nn = [], nu = [], ni = [];
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
      const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      let nx = uy * vz - uz * vy, nyv = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, nyv, nz) || 1; nx /= l; nyv /= l; nz /= l;
      const base = np.length / 3, srcIdx = [I[t], I[t + 1], I[t + 2]], pos = [a, b, c];
      for (let k = 0; k < 3; k++) {
        np.push(P[pos[k]], P[pos[k] + 1], P[pos[k] + 2]); nn.push(nx, nyv, nz);
        const u = srcIdx[k] * 2; nu.push(U[u] || 0, U[u + 1] || 0);
      }
      ni.push(base, base + 1, base + 2);
    }
    this.pos = np; this.nrm = nn; this.uv = nu; this.idx = ni;
    return this;
  }

  // pick the shading mode by flag (low-poly facets vs smooth).
  shade(flat) { return flat ? this.faceted() : this.computeSmoothNormals(); }

  aabb() {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < this.pos.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const c = this.pos[i + k];
        if (c < min[k]) min[k] = c;
        if (c > max[k]) max[k] = c;
      }
    }
    if (!this.pos.length) { min.fill(0); max.fill(0); }
    return { min: new Float32Array(min), max: new Float32Array(max) };
  }

  // → the SceneGraph shape renderer.uploadScene() expects (matches primitives.js).
  toSceneGraph(matOpts = {}) {
    const material = {
      ...defaultMaterial(),
      baseColorFactor: matOpts.color ? [...matOpts.color, matOpts.opacity ?? 1].slice(0, 4) : [1, 1, 1, 1],
      roughnessFactor: matOpts.roughness ?? 0.9,
      metallicFactor: matOpts.metallic ?? 0,
      emissiveFactor: matOpts.emissive || [0, 0, 0],
      baseColorTexture: -1,
      doubleSided: !!matOpts.doubleSided,
    };
    return {
      nodes: [{ name: matOpts.name || 'procgen', localMatrix: mat4(), worldMatrix: mat4(), meshIndex: 0, children: [] }],
      roots: [0],
      meshes: [{
        name: matOpts.name || 'procgen',
        primitives: [{
          positions: new Float32Array(this.pos),
          normals: new Float32Array(this.nrm),
          uv0: new Float32Array(this.uv),
          uv1: null,
          indices: new Uint32Array(this.idx),
          materialIndex: 0,
          aabb: this.aabb(),
        }],
      }],
      materials: [material],
      textures: [],
      images: [],
    };
  }
}

// combine several builders into ONE SceneGraph with multiple primitives/materials
// (e.g. a tree's brown BARK + green LEAVES in a single uploadable asset). Each
// part = { builder|mb, ...matOpts }. One node, one mesh, N primitives.
export function combine(parts, name = 'procgen') {
  const meshes0 = [], materials = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i], mb = p.builder || p.mb;
    if (!mb || !mb.pos.length) continue;
    materials.push({
      ...defaultMaterial(),
      baseColorFactor: p.color ? [...p.color, p.opacity ?? 1].slice(0, 4) : [1, 1, 1, 1],
      roughnessFactor: p.roughness ?? 0.9, metallicFactor: p.metallic ?? 0,
      emissiveFactor: p.emissive || [0, 0, 0], baseColorTexture: -1, doubleSided: !!p.doubleSided,
    });
    meshes0.push({
      positions: new Float32Array(mb.pos), normals: new Float32Array(mb.nrm),
      uv0: new Float32Array(mb.uv), uv1: null, indices: new Uint32Array(mb.idx),
      materialIndex: materials.length - 1, aabb: mb.aabb(),
    });
  }
  return {
    nodes: [{ name, localMatrix: mat4(), worldMatrix: mat4(), meshIndex: 0, children: [] }],
    roots: [0],
    meshes: [{ name, primitives: meshes0 }],
    materials, textures: [], images: [],
  };
}

// stamp a transform helper (translate + uniform scale + Y rotation) — generators
// use it to place sub-parts / instances without pulling in the full math module.
export function trs(tx, ty, tz, scale = 1, yawRad = 0) {
  const m = mat4();
  const c = Math.cos(yawRad), s = Math.sin(yawRad);
  m[0] = c * scale; m[2] = -s * scale; m[5] = scale; m[8] = s * scale; m[10] = c * scale;
  m[12] = tx; m[13] = ty; m[14] = tz;
  return m;
}
