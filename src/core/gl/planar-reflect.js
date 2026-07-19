// core/gl/planar-reflect.js — a TRUE planar mirror (the real thing, not a cubemap probe).
// Each frame the scene is re-rendered from the camera REFLECTED across the mirror plane
// into a texture; the mirror surface then samples that texture at its own screen position.
// Because it re-renders live, the reflection is exact and includes MOVING objects and the
// camera's own viewpoint — a genuine mirror, parallax-correct, view-dependent.
//
// Method (the classic water/mirror trick): render the world with viewProj = proj · view ·
// M_reflect (mirror the whole world across the plane), with FRONT-FACE winding flipped
// (the reflection flips handedness). The result, sampled at the mirror fragment's screen
// UV (gl_FragCoord.xy / viewport), is the correct reflection.

import { mat4, m4inv, m4transpose } from './math.js';

// mat4 (column-major) · vec4
function m4xv4(m, v, out) {
  const x = v[0], y = v[1], z = v[2], w = v[3];
  out[0] = m[0] * x + m[4] * y + m[8] * z + m[12] * w;
  out[1] = m[1] * x + m[5] * y + m[9] * z + m[13] * w;
  out[2] = m[2] * x + m[6] * y + m[10] * z + m[14] * w;
  out[3] = m[3] * x + m[7] * y + m[11] * z + m[15] * w;
  return out;
}

// Transform a WORLD-space plane (a,b,c,d) into eye space (the space `viewMatrix` maps to),
// for obliqueProjection. plane' = inverse(view)^T · plane.
const _pinv = mat4(), _pinvT = mat4();
export function planeToEye(planeWorld, viewMatrix, out) {
  m4inv(viewMatrix, _pinv); m4transpose(_pinv, _pinvT);
  return m4xv4(_pinvT, planeWorld, out);
}

// Lengyel oblique near-plane clipping: bend `proj`'s NEAR plane onto the eye-space plane
// `clip`, so everything on its negative side is hardware-clipped (zero fragment cost). This
// is what makes a wall-flush mirror correct — the wall BEHIND the mirror, which the world-
// reflection would otherwise pull in front and splat flat over the glass, gets clipped away.
export function obliqueProjection(proj, clip, out) {
  out.set(proj);
  const sgn = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
  const qx = (sgn(clip[0]) + proj[8]) / proj[0];
  const qy = (sgn(clip[1]) + proj[9]) / proj[5];
  const qz = -1, qw = (1 + proj[10]) / proj[14];
  const dp = clip[0] * qx + clip[1] * qy + clip[2] * qz + clip[3] * qw;
  const s = 2.0 / dp;
  out[2] = clip[0] * s;
  out[6] = clip[1] * s;
  out[10] = clip[2] * s + 1.0;
  out[14] = clip[3] * s;
  return out;
}

// 4×4 (column-major) reflection across the plane through `p` with unit-ish normal `n`.
export function reflectionMatrix(p, n, out = mat4()) {
  const l = Math.hypot(n[0], n[1], n[2]) || 1;
  const nx = n[0] / l, ny = n[1] / l, nz = n[2] / l;
  const d = nx * p[0] + ny * p[1] + nz * p[2];          // plane: n·x = d
  out[0] = 1 - 2 * nx * nx; out[1] = -2 * nx * ny; out[2] = -2 * nx * nz; out[3] = 0;
  out[4] = -2 * nx * ny; out[5] = 1 - 2 * ny * ny; out[6] = -2 * ny * nz; out[7] = 0;
  out[8] = -2 * nx * nz; out[9] = -2 * ny * nz; out[10] = 1 - 2 * nz * nz; out[11] = 0;
  out[12] = 2 * d * nx; out[13] = 2 * d * ny; out[14] = 2 * d * nz; out[15] = 1;
  return out;
}

// An off-screen colour+depth target that follows the viewport (optionally down-scaled).
export function createReflector(gl, scale = 1) {
  let w = 0, h = 0;
  const fbo = gl.createFramebuffer();
  const tex = gl.createTexture();
  const depth = gl.createRenderbuffer();

  function resize(W, H) {
    W = Math.max(2, Math.floor(W * scale)); H = Math.max(2, Math.floor(H * scale));
    if (W === w && H === h) return;
    w = W; h = H;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  return {
    tex,
    bind(W, H) { resize(W, H); gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); gl.viewport(0, 0, w, h); },
    get size() { return [w, h]; },
  };
}
