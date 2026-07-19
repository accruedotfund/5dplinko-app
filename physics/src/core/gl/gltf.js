// core/gl/gltf.js — zero-dependency GLB / glTF 2.0 parser (static meshes, v1).
//
//   loadGLB(url)  → Promise<SceneGraph>   (binary .glb container)
//   loadGLTF(url) → Promise<SceneGraph>   (.gltf JSON + external .bin / images)
//
// SceneGraph = {
//   nodes:     [{ name, localMatrix(F32x16), worldMatrix(F32x16), meshIndex|-1, children[] }],
//   roots:     [nodeIndex],
//   meshes:    [{ name, primitives: [{ positions, normals, uv0, uv1, indices,
//                                      materialIndex, aabb:{min,max} }] }],
//   materials: [{ name, baseColorFactor[4], baseColorTexture|-1,
//                 metallicFactor, roughnessFactor, metallicRoughnessTexture|-1,
//                 normalTexture|-1, emissiveFactor[3], emissiveTexture|-1,
//                 alphaMode:'OPAQUE'|'MASK'|'BLEND', alphaCutoff, doubleSided }],
//   textures:  [{ imageIndex, sampler:{wrapS,wrapT,magFilter,minFilter} }],
//   images:    [ImageBitmap|null],
// }
//
// Scope (v1): TRIANGLES primitives, POSITION/NORMAL/TEXCOORD_0/TEXCOORD_1 attributes,
// pbrMetallicRoughness materials, embedded GLB buffers + external .bin, data: URIs.
// Skinning/animations/sparse accessors/Draco are out of scope but the accessor layer
// is generic so adding JOINTS_0/WEIGHTS_0 later is a parse-table entry, not a rewrite.

import { mat4, m4mul, m4fromTRS, vec3, quat } from './math.js';

const GLB_MAGIC = 0x46546C67; // 'glTF'
const CHUNK_JSON = 0x4E4F534A, CHUNK_BIN = 0x004E4942;

const COMPONENT_ARRAYS = {
  5120: Int8Array, 5121: Uint8Array, 5122: Int16Array,
  5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array,
};
const TYPE_SIZES = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

// ---------------------------------------------------------------- entry points

// Parse cache: the same URL is fetched/parsed/decoded ONCE per page, no matter
// how many components or manifest entries reference it (the renderer likewise
// shares one GPU upload per SceneGraph). Treat cached SceneGraphs as immutable.
const sceneCache = new Map(); // url → Promise<SceneGraph>
const imgCache = new Map();   // resolved image URL → Promise<ImageBitmap> (shared across all models)

export function loadGLB(url) {
  let p = sceneCache.get(url);
  if (!p) {
    p = fetchBuffer(url).then((buf) => {
      const { json, bin } = parseGLB(buf);
      return parseGLTF(json, [bin], url);
    });
    p.catch(() => sceneCache.delete(url)); // don't cache failures
    sceneCache.set(url, p);
  }
  return p;
}

export function loadGLTF(url) {
  let p = sceneCache.get(url);
  if (!p) {
    p = loadGLTFUncached(url);
    p.catch(() => sceneCache.delete(url));
    sceneCache.set(url, p);
  }
  return p;
}

async function loadGLTFUncached(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`gltf: ${res.status} fetching ${url}`);
  const json = await res.json();
  const buffers = await Promise.all((json.buffers || []).map((b) => {
    if (!b.uri) throw new Error('gltf: buffer with no uri in .gltf (GLB-only feature)');
    return fetchBuffer(resolveURI(b.uri, url));
  }));
  return parseGLTF(json, buffers, url);
}

// ---------------------------------------------------------------- GLB container

export function parseGLB(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  if (dv.getUint32(0, true) !== GLB_MAGIC) throw new Error('glb: bad magic (not a GLB file)');
  const version = dv.getUint32(4, true);
  if (version !== 2) throw new Error(`glb: unsupported version ${version}`);
  const total = dv.getUint32(8, true);
  let off = 12, json = null, bin = null;
  while (off + 8 <= total) {
    const len = dv.getUint32(off, true);          // 32-bit per spec — never BigInt
    const type = dv.getUint32(off + 4, true);
    const start = off + 8;
    if (type === CHUNK_JSON) {
      json = JSON.parse(new TextDecoder().decode(new Uint8Array(arrayBuffer, start, len)));
    } else if (type === CHUNK_BIN) {
      bin = arrayBuffer.slice(start, start + len);
    }
    off = start + len + (len % 4 ? 4 - (len % 4) : 0); // chunks are 4-byte aligned
  }
  if (!json) throw new Error('glb: missing JSON chunk');
  return { json, bin };
}

// ---------------------------------------------------------------- glTF core

export async function parseGLTF(json, buffers, baseUrl = '') {
  // data: URI buffers (can appear in .gltf and even .glb)
  for (let i = 0; i < (json.buffers || []).length; i++) {
    if (!buffers[i] && json.buffers[i].uri?.startsWith('data:')) {
      buffers[i] = dataURIToBuffer(json.buffers[i].uri);
    }
  }

  const accessor = (i) => readAccessor(json, buffers, i);

  // KHR_draco_mesh_compression: the decoder (vendor/draco.js, ~62KB pure JS, no WASM) is
  // lazy-imported ONCE here, only when some primitive is Draco-compressed — non-Draco
  // models never pull it into the graph. Decoded attributes come back dequantized to Float32.
  const usesDraco = (json.meshes || []).some((m) =>
    (m.primitives || []).some((p) => p.extensions?.KHR_draco_mesh_compression));
  let decodeDracoMesh = null;
  if (usesDraco) ({ decodeDracoMesh } = await import('./draco.js'));

  // --- meshes / primitives
  const meshes = (json.meshes || []).map((m, mi) => ({
    name: m.name || `mesh${mi}`,
    primitives: (m.primitives || []).flatMap((p) => {
      const mode = p.mode === undefined ? 4 : p.mode;
      if (mode !== 4) { console.warn(`gltf: skipping non-TRIANGLES primitive (mode ${mode})`); return []; }
      if (p.attributes.POSITION === undefined) return [];

      // Draco branch: decode the compressed bufferView into plain typed arrays. The
      // primitive's own accessors are still used for the POSITION aabb (their min/max is
      // authoritative) and the material index.
      const dracoExt = p.extensions?.KHR_draco_mesh_compression;
      let positions, normals, uv0, uv1, indices, colors = null;
      if (dracoExt && decodeDracoMesh) {
        const bv = json.bufferViews[dracoExt.bufferView];
        const bytes = new Uint8Array(buffers[bv.buffer], bv.byteOffset || 0, bv.byteLength);
        const decoded = decodeDracoMesh(bytes, dracoExt.attributes);
        positions = decoded.attributes.POSITION;
        normals = decoded.attributes.NORMAL || null;
        uv0 = decoded.attributes.TEXCOORD_0 || null;
        uv1 = decoded.attributes.TEXCOORD_1 || null;
        if (decoded.attributes.COLOR_0) colors = toColorRGBA(decoded.attributes.COLOR_0, 4);
        indices = decoded.indices;
      } else {
        positions = accessor(p.attributes.POSITION);
        normals = p.attributes.NORMAL !== undefined ? accessor(p.attributes.NORMAL) : null;
        uv0 = p.attributes.TEXCOORD_0 !== undefined ? accessor(p.attributes.TEXCOORD_0) : null;
        uv1 = p.attributes.TEXCOORD_1 !== undefined ? accessor(p.attributes.TEXCOORD_1) : null;
        if (p.attributes.COLOR_0 !== undefined) { // artist-painted vertex colors (Blender vertex paint / baked AO)
          const a = json.accessors[p.attributes.COLOR_0];
          colors = toColorRGBA(accessor(p.attributes.COLOR_0), a.type === 'VEC3' ? 3 : 4);
        }
        indices = p.indices !== undefined ? accessor(p.indices) : sequentialIndices(positions.length / 3);
      }
      const prim = {
        positions, normals, uv0, uv1, colors, indices,
        materialIndex: p.material !== undefined ? p.material : -1,
        aabb: positionsAABB(positions, json.accessors[p.attributes.POSITION]),
      };
      if (!prim.normals) prim.normals = computeNormals(prim.positions, prim.indices);
      return [prim];
    }),
  }));

  // --- materials
  const materials = (json.materials || []).map((m, i) => {
    const pbr = m.pbrMetallicRoughness || {};
    return {
      name: m.name || `mat${i}`,
      baseColorFactor: pbr.baseColorFactor || [1, 1, 1, 1],
      baseColorTexture: pbr.baseColorTexture ? pbr.baseColorTexture.index : -1,
      metallicFactor: pbr.metallicFactor !== undefined ? pbr.metallicFactor : 1,
      roughnessFactor: pbr.roughnessFactor !== undefined ? pbr.roughnessFactor : 1,
      metallicRoughnessTexture: pbr.metallicRoughnessTexture ? pbr.metallicRoughnessTexture.index : -1,
      normalTexture: m.normalTexture ? m.normalTexture.index : -1,
      emissiveFactor: m.emissiveFactor || [0, 0, 0],
      emissiveTexture: m.emissiveTexture ? m.emissiveTexture.index : -1,
      alphaMode: m.alphaMode || 'OPAQUE',
      alphaCutoff: m.alphaCutoff !== undefined ? m.alphaCutoff : 0.5,
      doubleSided: !!m.doubleSided,
    };
  });
  if (!materials.length) materials.push(defaultMaterial());

  // --- textures + samplers
  const textures = (json.textures || []).map((t) => {
    const s = (json.samplers || [])[t.sampler] || {};
    return {
      imageIndex: t.source !== undefined ? t.source : -1,
      sampler: {
        wrapS: s.wrapS || 10497, wrapT: s.wrapT || 10497, // REPEAT
        magFilter: s.magFilter || 9729,                    // LINEAR
        minFilter: s.minFilter || 9987,                    // LINEAR_MIPMAP_LINEAR
      },
    };
  });

  // --- images (async decode). EXTERNAL images are cached per resolved URL ACROSS all
  // gltf/glb (imgCache) so a texture shared by N models — e.g. a kit's bark/leaf maps —
  // is fetched + createImageBitmap'd ONCE, not once per model. Concurrent loads dedupe
  // because we store the promise before awaiting. (Embedded bufferView images are unique
  // to their file, so they aren't cached.)
  const images = await Promise.all((json.images || []).map((img) => {
    if (img.uri && !img.uri.startsWith('data:')) {
      const u = resolveURI(img.uri, baseUrl);
      let p = imgCache.get(u);
      if (!p) {
        p = (async () => {
          const res = await fetch(u);
          if (!res.ok) throw new Error(`image ${res.status}`);
          return createImageBitmap(await res.blob(), { colorSpaceConversion: 'none' });
        })().catch((e) => { console.warn('gltf: image decode failed', u, e?.message); imgCache.delete(u); return null; });
        imgCache.set(u, p);
      }
      return p;
    }
    return (async () => {
      try {
        let blob;
        if (img.bufferView !== undefined) {
          const bv = json.bufferViews[img.bufferView];
          const bytes = new Uint8Array(buffers[bv.buffer], bv.byteOffset || 0, bv.byteLength);
          blob = new Blob([bytes], { type: img.mimeType || 'image/png' });
        } else if (img.uri) { blob = new Blob([dataURIToBuffer(img.uri)]); } else return null;
        return await createImageBitmap(blob, { colorSpaceConversion: 'none' });
      } catch (e) { console.warn('gltf: image decode failed', e); return null; }
    })();
  }));

  // --- node hierarchy
  const nodes = (json.nodes || []).map((n, i) => ({
    name: n.name || `node${i}`,
    localMatrix: nodeLocalMatrix(n),
    worldMatrix: mat4(),
    meshIndex: n.mesh !== undefined ? n.mesh : -1,
    children: n.children || [],
  }));
  const scene = json.scenes?.[json.scene || 0];
  const roots = scene?.nodes || nodes.map((_, i) => i).filter((i) => !nodes.some((n) => n.children.includes(i)));
  buildWorldMatrices(nodes, roots);

  return { nodes, roots, meshes, materials, textures, images };
}

export function buildWorldMatrices(nodes, roots) {
  const walk = (i, parent) => {
    const n = nodes[i];
    if (parent) m4mul(parent, n.localMatrix, n.worldMatrix);
    else n.worldMatrix.set(n.localMatrix);
    for (const c of n.children) walk(c, n.worldMatrix);
  };
  for (const r of roots) walk(r, null);
}

// ---------------------------------------------------------------- accessors

function readAccessor(json, buffers, idx) {
  const acc = json.accessors[idx];
  if (acc.sparse) throw new Error('gltf: sparse accessors not supported (v1)');
  const Arr = COMPONENT_ARRAYS[acc.componentType];
  if (!Arr) throw new Error(`gltf: unknown componentType ${acc.componentType}`);
  const comps = TYPE_SIZES[acc.type];
  const count = acc.count * comps;

  if (acc.bufferView === undefined) return new Arr(count); // spec: zero-filled

  const bv = json.bufferViews[acc.bufferView];
  const buffer = buffers[bv.buffer];
  if (!buffer) throw new Error(`gltf: missing buffer ${bv.buffer}`);
  const byteOffset = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const elemBytes = Arr.BYTES_PER_ELEMENT * comps;
  const stride = bv.byteStride || elemBytes;

  if (stride === elemBytes && byteOffset % Arr.BYTES_PER_ELEMENT === 0) {
    // tight — copy once into a dense array (slice so GPU upload owns clean memory)
    return new Arr(buffer.slice(byteOffset, byteOffset + count * Arr.BYTES_PER_ELEMENT));
  }
  // interleaved / misaligned — de-stride element by element
  const out = new Arr(count);
  const dv = new DataView(buffer);
  const read = dvReader(dv, acc.componentType);
  for (let i = 0; i < acc.count; i++) {
    const base = byteOffset + i * stride;
    for (let c = 0; c < comps; c++) out[i * comps + c] = read(base + c * Arr.BYTES_PER_ELEMENT);
  }
  return out;
}

function dvReader(dv, componentType) {
  switch (componentType) {
    case 5120: return (o) => dv.getInt8(o);
    case 5121: return (o) => dv.getUint8(o);
    case 5122: return (o) => dv.getInt16(o, true);
    case 5123: return (o) => dv.getUint16(o, true);
    case 5125: return (o) => dv.getUint32(o, true);
    case 5126: return (o) => dv.getFloat32(o, true);
    default: throw new Error(`gltf: componentType ${componentType}`);
  }
}

// ---------------------------------------------------------------- helpers

function nodeLocalMatrix(n) {
  if (n.matrix) return new Float32Array(n.matrix);
  const t = n.translation ? new Float32Array(n.translation) : vec3();
  const r = n.rotation ? new Float32Array(n.rotation) : quat();
  const s = n.scale ? new Float32Array(n.scale) : new Float32Array([1, 1, 1]);
  return m4fromTRS(t, r, s);
}

function positionsAABB(positions, acc) {
  // prefer accessor min/max (required for POSITION per spec); fall back to a scan
  if (acc?.min && acc?.max) return { min: new Float32Array(acc.min), max: new Float32Array(acc.max) };
  const min = new Float32Array([Infinity, Infinity, Infinity]);
  const max = new Float32Array([-Infinity, -Infinity, -Infinity]);
  for (let i = 0; i < positions.length; i += 3) {
    for (let c = 0; c < 3; c++) {
      const v = positions[i + c];
      if (v < min[c]) min[c] = v;
      if (v > max[c]) max[c] = v;
    }
  }
  return { min, max };
}

function computeNormals(positions, indices) {
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    const e1x = positions[b] - positions[a], e1y = positions[b + 1] - positions[a + 1], e1z = positions[b + 2] - positions[a + 2];
    const e2x = positions[c] - positions[a], e2y = positions[c + 1] - positions[a + 1], e2z = positions[c + 2] - positions[a + 2];
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    for (const v of [a, b, c]) { normals[v] += nx; normals[v + 1] += ny; normals[v + 2] += nz; }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const l = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    normals[i] /= l; normals[i + 1] /= l; normals[i + 2] /= l;
  }
  return normals;
}

function sequentialIndices(vertexCount) {
  const Arr = vertexCount > 65535 ? Uint32Array : Uint16Array;
  const out = new Arr(vertexCount);
  for (let i = 0; i < vertexCount; i++) out[i] = i;
  return out;
}

// COLOR_0 → Float32Array RGBA in 0..1. Expands VEC3→VEC4 (a=1) and defensively
// normalizes integer color data (some exporters store 0..255 / 0..65535 unnormalized).
function toColorRGBA(raw, components) {
  const n = raw.length / components;
  const out = new Float32Array(n * 4);
  let max = 0;
  for (let i = 0; i < raw.length; i++) if (raw[i] > max) max = raw[i];
  const scale = max > 1.5 ? (max > 300 ? 1 / 65535 : 1 / 255) : 1;
  for (let i = 0; i < n; i++) {
    out[i * 4] = raw[i * components] * scale;
    out[i * 4 + 1] = raw[i * components + 1] * scale;
    out[i * 4 + 2] = raw[i * components + 2] * scale;
    out[i * 4 + 3] = components === 4 ? raw[i * components + 3] * scale : 1;
  }
  return out;
}

export function defaultMaterial() {
  return {
    name: 'default', baseColorFactor: [1, 1, 1, 1], baseColorTexture: -1,
    metallicFactor: 0, roughnessFactor: 0.9, metallicRoughnessTexture: -1,
    normalTexture: -1, emissiveFactor: [0, 0, 0], emissiveTexture: -1,
    alphaMode: 'OPAQUE', alphaCutoff: 0.5, doubleSided: false,
  };
}

async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`gltf: ${res.status} fetching ${url}`);
  return res.arrayBuffer();
}

function resolveURI(uri, baseUrl) {
  if (uri.startsWith('data:')) return uri;
  return new URL(uri, new URL(baseUrl, location.href)).href;
}

function dataURIToBuffer(uri) {
  const b64 = uri.slice(uri.indexOf(',') + 1);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
