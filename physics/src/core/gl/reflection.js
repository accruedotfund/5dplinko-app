// core/gl/reflection.js — a baked CUBEMAP reflection probe = the engine's reflective &
// glass material capability. The scene is rendered 6 times (the cube faces) from a probe
// point into a cubemap once; any material flagged reflective then samples it via
// reflect(-V,N), giving REAL room reflections to a mirror, a glass shower, or a glossy
// floor — no per-frame cost after the bake (the room is static). Roughness picks a mip
// (sharp = mirror, blurred = brushed metal / frosted glass).
//
// Mirror parallax caveat: a single probe is exact only AT the probe point — a flat wall
// mirror reflects with slight parallax error vs a true planar render, but reads correct
// for a static room. Place the probe near the main reflective surface (e.g. in front of
// the mirror / at eye height in the room centre).

import { mat4, m4mul, m4perspective, m4lookAt } from './math.js';

// GL cubemap face order + the look dir / up for each (WebGL's left-handed cube convention)
const FACES = [
  { dir: [1, 0, 0], up: [0, -1, 0] },   // +X
  { dir: [-1, 0, 0], up: [0, -1, 0] },  // -X
  { dir: [0, 1, 0], up: [0, 0, 1] },    // +Y
  { dir: [0, -1, 0], up: [0, 0, -1] },  // -Y
  { dir: [0, 0, 1], up: [0, -1, 0] },   // +Z
  { dir: [0, 0, -1], up: [0, -1, 0] },  // -Z
];

// a 1×1 NEUTRAL-GREY cubemap so reflective draws sample SOMETHING during the bake (you
// can't read+write the same texture). It's grey, NOT black, deliberately: a black fallback
// bakes pure-black holes into the probe wherever a reflective surface (glossy floor, metal,
// the mirror) appears, and any OTHER reflective object then samples that black → reads as a
// jarring black blob (e.g. a metal block going black inside a planar mirror). Grey reads as
// "reflecting a plain environment" and Fresnel grazing edges can't pull pure black.
export function createNeutralCube(gl) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_CUBE_MAP, tex);
  const px = new Uint8Array([56, 60, 70, 255]); // ~linear 0.22,0.24,0.27 — a calm grey-blue room
  for (let i = 0; i < 6; i++) gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + i, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return tex;
}

// Render the scene into a cubemap from `pos`. `drawFace(camera)` should render one frame
// (the renderer's drawFrame) into the currently-bound framebuffer. Returns a mipmapped
// cubemap texture. `restore()` rebinds the prior framebuffer + viewport afterwards.

// Bake a Source-style AMBIENT CUBE from a probe point: render the scene into each of the
// 6 axis directions at low res and AVERAGE each face's pixels → one irradiance color per
// axis (+X,-X,+Y,-Y,+Z,-Z). Returns Float32Array(18) (6 × rgb, linear). The scene shader
// gamma-encodes its output (pow 1/2.2), so we linearize on read-back.
export function bakeAmbientCube(gl, { pos, size = 16, near = 0.05, far = 200, drawFace, restoreViewport, intensity = 1 }) {
  const out = new Float32Array(18);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  const fbo = gl.createFramebuffer();
  const depth = gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, size, size);

  const proj = m4perspective(Math.PI / 2, 1, near, far);
  const center = [0, 0, 0], view = mat4();
  const px = new Uint8Array(size * size * 4);
  for (let i = 0; i < 6; i++) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    gl.viewport(0, 0, size, size);
    const f = FACES[i];
    center[0] = pos[0] + f.dir[0]; center[1] = pos[1] + f.dir[1]; center[2] = pos[2] + f.dir[2];
    m4lookAt(pos, center, f.up, view);
    drawFace({ view, proj, pos });
    gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let r = 0, g = 0, b = 0;
    for (let p = 0; p < px.length; p += 4) {
      r += Math.pow(px[p] / 255, 2.2);       // linearize (shader output is gamma-encoded)
      g += Math.pow(px[p + 1] / 255, 2.2);
      b += Math.pow(px[p + 2] / 255, 2.2);
    }
    const n = size * size;
    out[i * 3] = (r / n) * intensity;
    out[i * 3 + 1] = (g / n) * intensity;
    out[i * 3 + 2] = (b / n) * intensity;
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo); gl.deleteRenderbuffer(depth); gl.deleteTexture(tex);
  if (restoreViewport) restoreViewport();
  return out;
}

export function bakeCube(gl, { pos, size = 256, near = 0.05, far = 200, drawFace, restoreViewport }) {
  const cube = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_CUBE_MAP, cube);
  for (let i = 0; i < 6; i++) gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + i, 0, gl.RGBA8, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  const fbo = gl.createFramebuffer();
  const depth = gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, size, size);

  const proj = m4perspective(Math.PI / 2, 1, near, far);  // 90° fov, square aspect
  const center = [0, 0, 0], view = mat4();
  for (let i = 0; i < 6; i++) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_CUBE_MAP_POSITIVE_X + i, cube, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    gl.viewport(0, 0, size, size);
    const f = FACES[i];
    center[0] = pos[0] + f.dir[0]; center[1] = pos[1] + f.dir[1]; center[2] = pos[2] + f.dir[2];
    m4lookAt(pos, center, f.up, view);
    drawFace({ view, proj, pos });
  }

  gl.bindTexture(gl.TEXTURE_CUBE_MAP, cube);
  gl.generateMipmap(gl.TEXTURE_CUBE_MAP);   // mip chain → roughness-blurred reflections
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  gl.deleteRenderbuffer(depth);
  if (restoreViewport) restoreViewport();
  return cube;
}
