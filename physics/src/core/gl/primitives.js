// core/gl/primitives.js — procedural geometry as SceneGraph-shaped objects,
// drop-in compatible with renderer.uploadScene(). v1: the box (level blocking).
//
// boxScene({ size:[x,y,z], uvScale?, image?, color?, emissive?, roughness? })
//
// UVs are WORLD-scaled: each face's uv extent = faceSize / uvScale, so with a
// REPEAT-wrapped texture one repeat covers `uvScale` meters on every face of
// every box — no stretching across differently-sized walls (the reason plain
// GLB unit cubes can't be used for tiled level geometry).

import { mat4 } from './math.js';
import { defaultMaterial } from './gltf.js';

export function boxScene(opts = {}) {
  const [sx, sy, sz] = opts.size || [1, 1, 1];
  const hx = sx / 2, hy = sy / 2, hz = sz / 2;
  const uv = opts.uvScale ?? 1;

  // 6 faces × 4 verts. For each face: origin corner, U edge, V edge, normal.
  const faces = [
    { o: [hx, -hy, hz], u: [0, 0, -sz], v: [0, sy, 0], n: [1, 0, 0] },    // +x
    { o: [-hx, -hy, -hz], u: [0, 0, sz], v: [0, sy, 0], n: [-1, 0, 0] },  // -x
    { o: [-hx, hy, hz], u: [sx, 0, 0], v: [0, 0, -sz], n: [0, 1, 0] },    // +y (top)
    { o: [-hx, -hy, -hz], u: [sx, 0, 0], v: [0, 0, sz], n: [0, -1, 0] },  // -y (bottom)
    { o: [-hx, -hy, hz], u: [sx, 0, 0], v: [0, sy, 0], n: [0, 0, 1] },    // +z
    { o: [hx, -hy, -hz], u: [-sx, 0, 0], v: [0, sy, 0], n: [0, 0, -1] },  // -z
  ];

  // `subdivide:n` tessellates each face into n×n quads so per-vertex painting/baking
  // (core/gl/vertex-paint.js) has resolution to interpolate light pools/gradients.
  // Default 1 = the original 4-verts-per-face box (byte-identical geometry).
  const seg = Math.max(1, Math.floor(opts.subdivide || 1));
  const vpf = (seg + 1) * (seg + 1);             // verts per face
  const positions = new Float32Array(6 * vpf * 3);
  const normals = new Float32Array(6 * vpf * 3);
  const uv0 = new Float32Array(6 * vpf * 2);
  const indices = new Uint16Array(6 * seg * seg * 6);

  const stretch = opts.uvMode === 'stretch'; // one full texture per face (posters/murals)
  let vb = 0, ib = 0;
  faces.forEach((f) => {
    const uLen = stretch ? 1 : Math.hypot(...f.u) / uv;
    const vLen = stretch ? 1 : Math.hypot(...f.v) / uv;
    const base = vb;
    for (let iy = 0; iy <= seg; iy++) {
      for (let ix = 0; ix <= seg; ix++) {
        const du = ix / seg, dv = iy / seg;
        const vi = vb * 3, ti = vb * 2;
        for (let k = 0; k < 3; k++) {
          positions[vi + k] = f.o[k] + f.u[k] * du + f.v[k] * dv;
          normals[vi + k] = f.n[k];
        }
        uv0[ti] = du * uLen;
        uv0[ti + 1] = (1 - dv) * vLen;
        vb++;
      }
    }
    const row = seg + 1;
    for (let iy = 0; iy < seg; iy++) {
      for (let ix = 0; ix < seg; ix++) {
        const a = base + iy * row + ix, b = a + 1, c = a + row, d = c + 1;
        indices[ib++] = a; indices[ib++] = b; indices[ib++] = d;
        indices[ib++] = a; indices[ib++] = d; indices[ib++] = c;
      }
    }
  });

  // optional PBR maps — a box can now carry a NORMAL map (`normalImage`, e.g. grout grooves)
  // and a metallic-ROUGHNESS map (`mrImage`, G=roughness/B=metal) so tiled walls/floors read
  // as real glossy tile (grout matte, faces shiny) under the lit path.
  const images = [], textures = [];
  const addTex = (img) => { const i = images.length; images.push(img); textures.push({ imageIndex: i, sampler: {} }); return i; };
  const material = {
    ...defaultMaterial(),
    baseColorFactor: opts.color ? [...opts.color, 1].slice(0, 4) : [1, 1, 1, 1],
    roughnessFactor: opts.roughness ?? 0.92,
    metallicFactor: opts.metallic ?? 0,
    emissiveFactor: opts.emissive || [0, 0, 0],
    baseColorTexture: opts.image ? addTex(opts.image) : -1,
    normalTexture: opts.normalImage ? addTex(opts.normalImage) : -1,
    metallicRoughnessTexture: opts.mrImage ? addTex(opts.mrImage) : -1,
    // PARALLAX OCCLUSION MAPPING: a height map (white=high) ray-marched per fragment so a
    // flat box face reads as deep brick/cobble. pomScale = depth, pomLayers = [min,max] steps.
    heightTexture: opts.heightImage ? addTex(opts.heightImage) : -1,
    pomScale: opts.pom?.scale ?? 0.05,
    pomLayers: opts.pom?.layers || [8, 32],
    // BAKED CAVITY / AO map (tiling, uv0) — darkens ambient in recesses. aoStrength 0..1.
    aoTexture: opts.aoImage ? addTex(opts.aoImage) : -1,
    aoStrength: opts.aoStrength ?? 1,
    doubleSided: !!opts.doubleSided, // e.g. water surfaces seen from below
  };

  return {
    nodes: [{ name: 'box', localMatrix: mat4(), worldMatrix: mat4(), meshIndex: 0, children: [] }],
    roots: [0],
    meshes: [{
      name: 'box',
      primitives: [{
        positions, normals, uv0, uv1: null, indices,
        materialIndex: 0,
        aabb: { min: new Float32Array([-hx, -hy, -hz]), max: new Float32Array([hx, hy, hz]) },
      }],
    }],
    materials: [material],
    textures,
    images,
  };
}

// sphereScene({ radius?|size?, segments?, rings?, color?, emissive?, roughness?, metallic? })
// A UV sphere as a SceneGraph — drop-in for renderer.uploadScene(), same shape as
// boxScene so it registers as a movable / collidable model identically. radius
// defaults to 0.5 (unit-diameter ball); `size:[d,..]` also accepted (radius=d/2).
export function sphereScene(opts = {}) {
  const r = opts.radius != null ? opts.radius
    : (Array.isArray(opts.size) ? (opts.size[0] || 1) / 2 : 0.5);
  const segs = Math.max(3, Math.floor(opts.segments || 24));   // longitude
  const rings = Math.max(2, Math.floor(opts.rings || 16));     // latitude

  const vcount = (rings + 1) * (segs + 1);
  const positions = new Float32Array(vcount * 3);
  const normals = new Float32Array(vcount * 3);
  const uv0 = new Float32Array(vcount * 2);
  const indices = new Uint16Array(rings * segs * 6);

  let v = 0;
  for (let iy = 0; iy <= rings; iy++) {
    const lat = (iy / rings) * Math.PI;          // 0 = +Y pole
    const sinLat = Math.sin(lat), cosLat = Math.cos(lat);
    for (let ix = 0; ix <= segs; ix++) {
      const lon = (ix / segs) * Math.PI * 2;
      const sinLon = Math.sin(lon), cosLon = Math.cos(lon);
      const nx = sinLat * cosLon, ny = cosLat, nz = sinLat * sinLon;
      const vi = v * 3, ti = v * 2;
      positions[vi] = r * nx; positions[vi + 1] = r * ny; positions[vi + 2] = r * nz;
      normals[vi] = nx; normals[vi + 1] = ny; normals[vi + 2] = nz;
      uv0[ti] = ix / segs; uv0[ti + 1] = iy / rings;
      v++;
    }
  }
  const row = segs + 1;
  let ib = 0;
  for (let iy = 0; iy < rings; iy++) {
    for (let ix = 0; ix < segs; ix++) {
      const a = iy * row + ix, b = a + 1, c = a + row, d = c + 1;
      indices[ib++] = a; indices[ib++] = c; indices[ib++] = b;
      indices[ib++] = b; indices[ib++] = c; indices[ib++] = d;
    }
  }

  const material = {
    ...defaultMaterial(),
    baseColorFactor: opts.color ? [...opts.color, 1].slice(0, 4) : [1, 1, 1, 1],
    roughnessFactor: opts.roughness ?? 0.5,
    metallicFactor: opts.metallic ?? 0,
    emissiveFactor: opts.emissive || [0, 0, 0],
    doubleSided: !!opts.doubleSided,
  };

  return {
    nodes: [{ name: 'sphere', localMatrix: mat4(), worldMatrix: mat4(), meshIndex: 0, children: [] }],
    roots: [0],
    meshes: [{
      name: 'sphere',
      primitives: [{
        positions, normals, uv0, uv1: null, indices,
        materialIndex: 0,
        aabb: { min: new Float32Array([-r, -r, -r]), max: new Float32Array([r, r, r]) },
      }],
    }],
    materials: [material],
    textures: [],
    images: [],
  };
}

// textScene(text, opts) — a SceneGraph of GLYPH-ATLAS QUADS: each character is a
// textured quad sampling its cell from a baked font atlas (one canvas → one texture
// → one BLEND draw call). The anime.js "Text" feature in 3D. `height` = world height
// of the line; quads are centered on the origin (x ∈ [-w/2,w/2]) so it billboards
// cleanly. `color` tints + `emissive` makes it glow. Returns { sceneGraph, width, height }.
// per-glyph layout (center x + width, relative to the line center) — for SPLIT
// gl-text where each glyph is its own movable (typewriter / per-glyph animation).
export function glyphLayout(text, opts = {}) {
  const worldH = opts.height || 1, cellPx = 128, pad = 10;
  const fam = opts.font || 'BoldPixels, monospace';
  const chars = Array.from(String(text || ''));
  const m = document.createElement('canvas').getContext('2d'); m.font = `700 ${cellPx}px ${fam}`;
  const cellW = chars.map((c) => (c === ' ' ? cellPx * 0.4 : Math.max(m.measureText(c).width, 1)) + pad);
  const k = worldH / (cellPx + pad * 2);
  const worldW = cellW.reduce((a, b) => a + b, 0) * k;
  const glyphs = []; let x = -worldW / 2;
  chars.forEach((c, i) => { const w = cellW[i] * k; glyphs.push({ char: c, cx: x + w / 2, w }); x += w; });
  return { glyphs, width: worldW, height: worldH };
}

export function textScene(text, opts = {}) {
  const worldH = opts.height || 1;
  const cellPx = 128, pad = 10;
  const fam = opts.font || 'BoldPixels, monospace';
  const chars = Array.from(String(text || ''));
  const mctx = document.createElement('canvas').getContext('2d');
  mctx.font = `700 ${cellPx}px ${fam}`;
  const advr = chars.map((c) => (c === ' ' ? cellPx * 0.4 : Math.max(mctx.measureText(c).width, 1)));
  const atlasW = Math.ceil(advr.reduce((a, b) => a + b + pad, 0)) || 1;
  const atlas = document.createElement('canvas'); atlas.width = atlasW; atlas.height = cellPx + pad * 2;
  const a = atlas.getContext('2d');
  a.font = `700 ${cellPx}px ${fam}`; a.textBaseline = 'middle'; a.textAlign = 'left'; a.fillStyle = '#fff';
  const cells = []; let ax = 0;
  chars.forEach((c, i) => { const w = advr[i]; if (c !== ' ') a.fillText(c, ax + pad / 2, atlas.height / 2); cells.push({ x: ax, w: w + pad }); ax += w + pad; });

  const k = worldH / atlas.height;                  // px → world
  const worldW = ax * k;
  const positions = [], normals = [], uv0 = [], indices = [];
  let vb = 0, wx = -worldW / 2;
  for (const cell of cells) {
    const w = cell.w * k, h = worldH;
    const u0 = cell.x / atlasW, u1 = (cell.x + cell.w) / atlasW;
    const corners = [[wx, -h / 2], [wx + w, -h / 2], [wx + w, h / 2], [wx, h / 2]];
    const uvs = [[u0, 1], [u1, 1], [u1, 0], [u0, 0]];
    corners.forEach((cn, ci) => { positions.push(cn[0], cn[1], 0); normals.push(0, 0, 1); uv0.push(uvs[ci][0], uvs[ci][1]); });
    indices.push(vb, vb + 1, vb + 2, vb, vb + 2, vb + 3); vb += 4; wx += w;
  }
  const material = {
    ...defaultMaterial(),
    baseColorFactor: opts.color ? [...opts.color, 1].slice(0, 4) : [1, 1, 1, 1],
    emissiveFactor: opts.emissive || opts.color || [0, 0, 0],
    roughnessFactor: 0.6, baseColorTexture: 0, alphaMode: 'BLEND', doubleSided: true,
  };
  const sceneGraph = {
    nodes: [{ name: 'text', localMatrix: mat4(), worldMatrix: mat4(), meshIndex: 0, children: [] }], roots: [0],
    meshes: [{ name: 'text', primitives: [{ positions: new Float32Array(positions), normals: new Float32Array(normals), uv0: new Float32Array(uv0), uv1: null, indices: new Uint16Array(indices), materialIndex: 0, aabb: { min: new Float32Array([-worldW / 2, -worldH / 2, -0.02]), max: new Float32Array([worldW / 2, worldH / 2, 0.02]) } }] }],
    materials: [material], textures: [{ imageIndex: 0, sampler: {} }], images: [atlas],
  };
  return { sceneGraph, width: worldW, height: worldH };
}
