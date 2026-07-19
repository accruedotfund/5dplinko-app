// core/gl/projshadow.js — PROJECTED contact / blob shadows. A soft dark quad laid on
// the ground UNDER a tracked object, oriented to the surface normal. The cheap hybrid
// that complements the sun shadow map: it grounds MOVING objects + instanced props
// (which the v1 shadow map doesn't cast) and works even with shadows disabled.
//
// gl-scene resolves each shadow's placement per frame (caster position → raycast DOWN
// onto the real ground via the scene BVH → {point, normal}, faded by height) and pushes
// it here; this renders them all in ONE instanced draw after the opaque pass.
//
//   const ps = createProjShadowRenderer(gl, { max: 64 });
//   ps.setCount(n); ps.set(i, cx,cy,cz, radius, nx,ny,nz, dark);
//   ps.draw(viewProj);   // dark, depth-tested (LEQUAL), depth-write off

const VERT = `#version 300 es
layout(location=0) in vec2 a_corner;     // static unit quad −1..1
layout(location=1) in vec4 a_cr;          // center.xyz + radius
layout(location=2) in vec4 a_nd;          // ground normal.xyz + darkness
uniform mat4 u_viewProj;
out vec2 v_uv;
out float v_dark;
void main() {
  vec3 N = a_nd.xyz;
  vec3 up = abs(N.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 T = normalize(cross(up, N));
  vec3 B = cross(N, T);
  vec3 wp = a_cr.xyz + (T * a_corner.x + B * a_corner.y) * a_cr.w;
  v_uv = a_corner;
  v_dark = a_nd.w;
  gl_Position = u_viewProj * vec4(wp, 1.0);
}`;

const FRAG = `#version 300 es
precision mediump float;
in vec2 v_uv;
in float v_dark;
out vec4 o_color;
void main() {
  float d = length(v_uv);
  // soft elliptical falloff: solid core → feathered rim
  float a = (1.0 - smoothstep(0.45, 1.0, d)) * v_dark;
  if (a <= 0.001) discard;
  o_color = vec4(0.0, 0.0, 0.0, a);  // black, alpha-blended → darkens the ground
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src); gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('projshadow shader: ' + gl.getShaderInfoLog(sh));
  return sh;
}

export function createProjShadowRenderer(gl, { max = 64 } = {}) {
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('projshadow link: ' + gl.getProgramInfoLog(prog));
  const uVP = gl.getUniformLocation(prog, 'u_viewProj');

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  // static quad (two triangles, −1..1)
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  // per-instance: [cx,cy,cz,radius, nx,ny,nz,dark] = 8 floats
  const data = new Float32Array(max * 8);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, data.byteLength, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 0); gl.vertexAttribDivisor(1, 1);
  gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 32, 16); gl.vertexAttribDivisor(2, 1);
  gl.bindVertexArray(null);

  let count = 0, dirty = false;

  return {
    get count() { return count; },
    setCount(n) { count = Math.min(n, max); },
    set(i, cx, cy, cz, r, nx, ny, nz, dark) {
      if (i >= max) return;
      const o = i * 8;
      data[o] = cx; data[o + 1] = cy; data[o + 2] = cz; data[o + 3] = r;
      data[o + 4] = nx; data[o + 5] = ny; data[o + 6] = nz; data[o + 7] = dark;
      dirty = true;
    },
    draw(viewProj) {
      if (!count) return;
      if (dirty) { gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, count * 8); dirty = false; }
      gl.useProgram(prog);
      gl.uniformMatrix4fv(uVP, false, viewProj);
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false); gl.disable(gl.CULL_FACE);
      gl.bindVertexArray(vao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
      gl.bindVertexArray(null);
      gl.depthMask(true); gl.disable(gl.BLEND); gl.enable(gl.CULL_FACE);
    },
    destroy() { gl.deleteBuffer(quad); gl.deleteBuffer(buf); gl.deleteVertexArray(vao); gl.deleteProgram(prog); },
  };
}
