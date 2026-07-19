// core/gl/shadow.js — a single directional (sun) SHADOW MAP. Render the scene depth
// from the sun's orthographic POV into a DEPTH texture once per frame, then the uber-
// shader samples it (sampler2DShadow → hardware 2×2 PCF) to darken the sun term where
// a surface is occluded. The one real per-frame cost in the cheap-lighting roadmap.
//
//   const sm = createShadowMap(gl, 2048);
//   sm.begin(lightVP);                        // bind depth FBO, clear, use depth program
//   for (d of opaqueDraws) sm.drawModel(d.world, d.mesh);  // NON-instanced casters
//   sm.end(W, H);                             // restore default framebuffer + viewport
//   // main pass: bind sm.tex to a slot, sample with lightVP.
//
// v1 scope: NON-instanced casters only (auto-batched / instanced foliage don't cast,
// but everything still RECEIVES). Front faces are culled in the depth pass to push
// self-shadow acne onto back faces (paired with a slope-scaled bias in the shader).

import { mat4, m4mul, m4ortho, m4lookAt } from './math.js';

const DEPTH_VERT = `#version 300 es
layout(location=0) in vec3 a_position;
uniform mat4 u_lightVP;
uniform mat4 u_model;
void main() { gl_Position = u_lightVP * u_model * vec4(a_position, 1.0); }`;

const DEPTH_FRAG = `#version 300 es
precision mediump float;
void main() {}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src); gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('shadow shader: ' + gl.getShaderInfoLog(sh));
  return sh;
}

export function createShadowMap(gl, size = 2048) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, size, size, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  // comparison sampling → sampler2DShadow gives free bilinear PCF on the compare result
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);

  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, tex, 0);
  gl.drawBuffers([gl.NONE]); gl.readBuffer(gl.NONE);   // depth-only, no color attachment
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, DEPTH_VERT));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, DEPTH_FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('shadow link: ' + gl.getProgramInfoLog(prog));
  const uLightVP = gl.getUniformLocation(prog, 'u_lightVP');
  const uModel = gl.getUniformLocation(prog, 'u_model');

  // Build the light view-projection: an ortho box of half-extent `dist` around `center`,
  // looking from far along -sunDir. up flips to Z when the sun is near-vertical.
  const view = mat4(), proj = mat4(), lightVP = mat4();
  function computeLightVP(sunDir, center, dist) {
    const d = dist;
    const eye = [center[0] - sunDir[0] * d * 2, center[1] - sunDir[1] * d * 2, center[2] - sunDir[2] * d * 2];
    const up = Math.abs(sunDir[1]) > 0.95 ? [0, 0, 1] : [0, 1, 0];
    m4lookAt(eye, center, up, view);
    m4ortho(-d, d, -d, d, 0.05, d * 4, proj);
    return m4mul(proj, view, lightVP);
  }

  return {
    tex, size, lightVP,
    computeLightVP,
    begin(lvp) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.viewport(0, 0, size, size);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.useProgram(prog);
      gl.uniformMatrix4fv(uLightVP, false, lvp);
      gl.enable(gl.CULL_FACE); gl.cullFace(gl.FRONT);  // cull front → acne lands on back faces
    },
    drawModel(world, mesh) {
      gl.uniformMatrix4fv(uModel, false, world);
      gl.bindVertexArray(mesh.vao);
      gl.drawElements(gl.TRIANGLES, mesh.indexCount, mesh.indexType, 0);
    },
    end(W, H) {
      gl.cullFace(gl.BACK);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, W, H);
      gl.bindVertexArray(null);
    },
    free() { gl.deleteTexture(tex); gl.deleteFramebuffer(fbo); gl.deleteProgram(prog); },
  };
}
