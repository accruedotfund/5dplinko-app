// ─────────────────────────────────────────────────────────────────────────────
// core/gl/font-atlas.js — bake a font's glyphs into ONE shared atlas canvas (cached
// per font), so 3D text is INSTANCED: a whole string (or a paragraph) is N instances
// of a single unit quad, each instance sampling its glyph's cell via a per-instance
// UV rect (renderer USE_INSTANCED_UV). One draw call + one texture for all the text —
// the efficient default for heavy / frequently-changing 3D text. No authored asset:
// the glyphs are drawn from the loaded web font at runtime.
// ─────────────────────────────────────────────────────────────────────────────

import { mat4 } from './math.js';
import { defaultMaterial } from './gltf.js';

const _cache = new Map(); // `${font}|${size}` → atlas

// printable ASCII 32..126
const ASCII = (() => { let s = ''; for (let c = 32; c < 127; c++) s += String.fromCharCode(c); return s; })();

// bakeFontAtlas → { canvas, glyphs:Map<char,{u0,v0,u1,v1,advance}>, cellRatio, size }.
// `advance`/`cellRatio` are normalized to `size` (world units when a glyph = `height`).
export function bakeFontAtlas({ font = 'BoldPixels, monospace', size = 64, chars } = {}) {
  const key = `${font}|${size}`;
  if (_cache.has(key)) return _cache.get(key);
  const list = Array.from(chars || ASCII);
  const pad = Math.ceil(size * 0.18), cell = size + pad * 2;
  const cols = 16, rows = Math.ceil(list.length / cols);
  const canvas = document.createElement('canvas');
  canvas.width = cols * cell; canvas.height = rows * cell;
  const c = canvas.getContext('2d');
  c.font = `700 ${size}px ${font}`; c.textBaseline = 'middle'; c.textAlign = 'center'; c.fillStyle = '#fff';
  const glyphs = new Map();
  list.forEach((ch, i) => {
    const col = i % cols, row = (i / cols) | 0, cx = col * cell, cy = row * cell;
    if (ch !== ' ') c.fillText(ch, cx + cell / 2, cy + cell / 2);
    const adv = ch === ' ' ? size * 0.42 : Math.max(c.measureText(ch).width, 1);
    glyphs.set(ch, { u0: cx / canvas.width, v0: cy / canvas.height, u1: (cx + cell) / canvas.width, v1: (cy + cell) / canvas.height, advance: adv / size });
  });
  const atlas = { canvas, glyphs, cellRatio: cell / size, size, font };
  _cache.set(key, atlas);
  return atlas;
}

// layoutTextInstances — for a string, build per-glyph INSTANCE data (centered on the
// origin so it billboards): { matrices:[Float32Array(16)], uvs:[[u0,v0,u1,v1]],
// glyphs:[{cx, q}], width }. Each glyph quad is a centered unit quad scaled to the
// cell size `q` and translated to its pen center `cx`.
export function layoutTextInstances(text, atlas, { height = 1 } = {}) {
  const chars = Array.from(String(text || ''));
  const q = atlas.cellRatio * height;          // world size of a glyph quad (square)
  let pen = 0;
  const items = chars.map((ch) => { const g = atlas.glyphs.get(ch) || atlas.glyphs.get('?'); const a = g.advance * height; const cx = pen + a / 2; pen += a; return { ch, g, cx, a }; });
  const width = pen;
  const matrices = [], uvs = [], glyphs = [];
  for (const it of items) {
    if (!it.ch.trim()) continue;                // skip spaces (no instance)
    const tx = it.cx - width / 2;               // center the line on origin
    matrices.push(new Float32Array([q, 0, 0, 0, 0, q, 0, 0, 0, 0, 1, 0, tx, 0, 0, 1])); // scale q · translate
    uvs.push([it.g.u0, it.g.v0, it.g.u1, it.g.v1]);
    glyphs.push({ cx: tx, q });
  }
  return { matrices, uvs, glyphs, width, height };
}

// a centered unit quad (x,y ∈ [-0.5,0.5], z=0) with UV 0..1 — the geometry every
// glyph instance reuses. `image` = the atlas canvas (BLEND, doubleSided).
export function quadScene(image, opts = {}) {
  const positions = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]);
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const uv0 = new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]);
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const material = {
    ...defaultMaterial(),
    baseColorFactor: opts.color ? [...opts.color, 1].slice(0, 4) : [1, 1, 1, 1],
    emissiveFactor: opts.emissive || opts.color || [0, 0, 0],
    roughnessFactor: 0.6, baseColorTexture: 0, alphaMode: 'BLEND', doubleSided: true,
  };
  return {
    nodes: [{ name: 'glyph', localMatrix: mat4(), worldMatrix: mat4(), meshIndex: 0, children: [] }], roots: [0],
    meshes: [{ name: 'glyph', primitives: [{ positions, normals, uv0, uv1: null, indices, materialIndex: 0, aabb: { min: new Float32Array([-0.5, -0.5, -0.02]), max: new Float32Array([0.5, 0.5, 0.02]) } }] }],
    materials: [material], textures: [{ imageIndex: 0, sampler: {} }], images: [image],
  };
}
