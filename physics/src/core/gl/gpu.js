// core/gl/gpu.js — thin WebGL2 resource helpers. No hidden state beyond a
// per-context registry used by destroyAll() for clean teardown.
//
// Fixed attribute locations (every shader uses the same ones, so VAOs are
// shader-agnostic and never need re-binding when programs switch):
//   0 = position (vec3)   1 = normal (vec3)   2 = uv0 (vec2)   3 = uv1 (vec2)
//   10 = color (vec4, baked/hand-painted vertex light — see core/gl/vertex-paint.js)
//   11 = material (vec2 roughness,metallic — hand-painted shininess; vertex-paint.js)

export const ATTR_POSITION = 0, ATTR_NORMAL = 1, ATTR_UV0 = 2, ATTR_UV1 = 3, ATTR_COLOR = 10, ATTR_MATERIAL = 11;

const registries = new WeakMap(); // gl → { buffers:[], textures:[], vaos:[] }

function reg(gl) {
  let r = registries.get(gl);
  if (!r) { r = { buffers: [], textures: [], vaos: [] }; registries.set(gl, r); }
  return r;
}

// ---------------------------------------------------------------- buffers / VAO

function createBuffer(gl, target, data) {
  const buf = gl.createBuffer();
  gl.bindBuffer(target, buf);
  gl.bufferData(target, data, gl.STATIC_DRAW);
  reg(gl).buffers.push(buf);
  return buf;
}

// primitive = {positions, normals, uv0?, uv1?, indices} from gltf.js
// → GPUMesh {vao, indexCount, indexType, hasUV0, hasUV1}
export function uploadMesh(gl, primitive) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  reg(gl).vaos.push(vao);

  const buffers = { uv0: null, uv1: null, col: null, mat: null };
  const attach = (loc, data, size) => {
    const buf = createBuffer(gl, gl.ARRAY_BUFFER, data);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    return buf;
  };
  buffers.pos = attach(ATTR_POSITION, primitive.positions, 3);
  buffers.nrm = attach(ATTR_NORMAL, primitive.normals, 3);
  if (primitive.uv0) buffers.uv0 = attach(ATTR_UV0, primitive.uv0, 2);
  if (primitive.uv1) buffers.uv1 = attach(ATTR_UV1, primitive.uv1, 2);
  if (primitive.colors) buffers.col = attach(ATTR_COLOR, primitive.colors, 4); // baked/painted vertex light
  if (primitive.materials) buffers.mat = attach(ATTR_MATERIAL, primitive.materials, 2); // painted roughness,metallic

  let indices = primitive.indices;
  let indexType = gl.UNSIGNED_SHORT;
  if (indices instanceof Uint32Array) indexType = gl.UNSIGNED_INT;
  else if (indices instanceof Uint8Array) indices = Uint16Array.from(indices);
  buffers.idx = createBuffer(gl, gl.ELEMENT_ARRAY_BUFFER, indices);

  gl.bindVertexArray(null);
  return {
    vao, buffers, indexCount: primitive.indices.length, indexType,
    hasUV0: !!primitive.uv0, hasUV1: !!primitive.uv1, hasColors: !!primitive.colors, hasMaterials: !!primitive.materials,
  };
}

// instanced sibling VAO: shares a mesh's vertex/index buffers, adds a per-
// instance mat4 model matrix at locations 4-7 (divisor 1) read from instBuf.
export function createInstancedVAO(gl, gpuMesh, instBuf, tintBuf, uvBuf) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  reg(gl).vaos.push(vao);
  const b = gpuMesh.buffers;
  const attach = (loc, buf, size) => {
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
  };
  attach(ATTR_POSITION, b.pos, 3);
  attach(ATTR_NORMAL, b.nrm, 3);
  if (b.uv0) attach(ATTR_UV0, b.uv0, 2);
  if (b.uv1) attach(ATTR_UV1, b.uv1, 2);
  if (b.col) attach(ATTR_COLOR, b.col, 4); // shared baked/painted vertex color (divisor 0)
  if (b.mat) attach(ATTR_MATERIAL, b.mat, 2); // shared painted roughness,metallic (divisor 0)
  gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
  for (let i = 0; i < 4; i++) {
    gl.enableVertexAttribArray(4 + i);
    gl.vertexAttribPointer(4 + i, 4, gl.FLOAT, false, 64, i * 16);
    gl.vertexAttribDivisor(4 + i, 1);
  }
  // optional per-instance material tint (vec4) at location 8, divisor 1
  if (tintBuf) {
    gl.bindBuffer(gl.ARRAY_BUFFER, tintBuf);
    gl.enableVertexAttribArray(8);
    gl.vertexAttribPointer(8, 4, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(8, 1);
  }
  // optional per-instance UV RECT [u0,v0,u1,v1] (vec4) at location 9, divisor 1 —
  // remaps the mesh's 0..1 UV into a sub-rect of the texture (glyph-atlas text).
  if (uvBuf) {
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
    gl.enableVertexAttribArray(9);
    gl.vertexAttribPointer(9, 4, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(9, 1);
  }
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b.idx);
  gl.bindVertexArray(null);
  return vao;
}

// ---------------------------------------------------------------- textures

// sRGB ONLY for color (baseColor/emissive) textures; normal maps,
// metallic-roughness and lightmaps are linear data — sRGB-decoding them
// silently wrecks the lighting math.
export function createTexture(gl, image, { sRGB = false, sampler = {}, mipmap = true } = {}) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  reg(gl).textures.push(tex);

  const internal = sRGB ? gl.SRGB8_ALPHA8 : gl.RGBA8;
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, gl.RGBA, gl.UNSIGNED_BYTE, image);

  // WebGL2 (GLES3) supports mipmaps + REPEAT on NON-power-of-two textures — the POT
  // restriction is a WebGL1-only holdover. Gating mipmaps on `pot` left every NPOT GLB
  // texture (e.g. 1200×800) with NO mip chain → MIN_FILTER=LINEAR aliases/shimmers and
  // washes toward flat color as the camera pulls back ("detail glitches in up close,
  // reverts to shape+color far away"). Generate mips for ALL textures here.
  const wantMip = mipmap;
  if (wantMip) gl.generateMipmap(gl.TEXTURE_2D);

  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, sampler.wrapS || gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, sampler.wrapT || gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, sampler.magFilter || gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, wantMip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
  // ANISOTROPIC FILTERING — without it, a surface seen at a GRAZING angle is foreshortened
  // (many texels per pixel along the steep axis), so trilinear jumps to a coarse isotropic mip
  // that BLURS detail in both directions → normal/height/AO maps average to their neutral
  // values and the relief (POM depth, bump lighting, groove AO) "fades to nothing" at angle/
  // distance. Aniso samples ALONG the foreshortened direction, keeping detail crisp. Cheap,
  // one-time per texture; helps every tiled wall/floor (not just the surface-map demo).
  if (wantMip) {
    const aniso = anisoExt(gl);
    if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, aniso.max));
  }
  return tex;
}

// EXT_texture_filter_anisotropic — queried once per GL context, cached. Returns the enum +
// the hardware MAX, or null if unsupported (then we just keep trilinear — no breakage).
const _anisoCache = new WeakMap();
function anisoExt(gl) {
  if (_anisoCache.has(gl)) return _anisoCache.get(gl);
  const ext = gl.getExtension('EXT_texture_filter_anisotropic')
    || gl.getExtension('MOZ_EXT_texture_filter_anisotropic')
    || gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic');
  const info = ext ? {
    TEXTURE_MAX_ANISOTROPY_EXT: ext.TEXTURE_MAX_ANISOTROPY_EXT,
    max: gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT),
  } : null;
  _anisoCache.set(gl, info);
  return info;
}

// 1×1 fallback so shaders can sample unconditionally
export function createPixelTexture(gl, rgba = [255, 255, 255, 255]) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(rgba));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  reg(gl).textures.push(tex);
  return tex;
}

// SceneGraph textures/images → WebGLTexture[] aligned with sceneGraph.textures.
// colorTexSet = Set of texture indices that hold COLOR data (sRGB).
export function uploadTextures(gl, sceneGraph, colorTexSet) {
  return sceneGraph.textures.map((t, i) => {
    const img = sceneGraph.images[t.imageIndex];
    if (!img) return null;
    return createTexture(gl, img, { sRGB: colorTexSet.has(i), sampler: t.sampler });
  });
}

// Which texture indices are color data? Walk materials: baseColor + emissive.
export function collectColorTextures(materials) {
  const set = new Set();
  for (const m of materials) {
    if (m.baseColorTexture >= 0) set.add(m.baseColorTexture);
    if (m.emissiveTexture >= 0) set.add(m.emissiveTexture);
  }
  return set;
}

// ---------------------------------------------------------------- teardown

export function destroyAll(gl) {
  const r = registries.get(gl);
  if (!r) return;
  for (const b of r.buffers) gl.deleteBuffer(b);
  for (const t of r.textures) gl.deleteTexture(t);
  for (const v of r.vaos) gl.deleteVertexArray(v);
  registries.delete(gl);
}

function isPow2(n) { return (n & (n - 1)) === 0 && n > 0; }
