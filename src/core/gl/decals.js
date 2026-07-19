// core/gl/decals.js — surface-painted decals (bullet holes, scorch marks).
// The FPS classic: a small dark quad ORIENTED TO THE HIT SURFACE that stays
// painted on the wall — vs particles, which are camera-facing billboards.
//
//   const dr = createDecalRenderer(gl, { max: 256 });
//   dr.add({ pos: [x,y,z], normal: [nx,ny,nz], size: 0.07, dark: 0.85 });
//   dr.draw(viewProj);          // after opaque/blend passes, before particles
//
// Ring buffer of `max` quads — the oldest decal is silently overwritten when
// full (how every shooter caps decal cost). Each add is one bufferSubData of
// 13 floats; drawing is ONE drawArraysInstanced. Fragment is procedural
// (dark core + soft soot halo + hashed irregular edge) — no texture fetch.
// Depth-tested (LEQUAL) but not depth-written; the quad is lifted 6mm along
// the surface normal at add-time so it never z-fights the wall.

const VERT = `#version 300 es
layout(location=0) in vec2 a_corner;        // static quad −1..1
layout(location=1) in vec3 a_center;
layout(location=2) in vec3 a_tan;           // half-size, rotated in plane
layout(location=3) in vec3 a_bit;
layout(location=4) in vec2 a_params;        // x: darkness, y: seed
uniform mat4 u_viewProj;
out vec2 v_uv;
out vec2 v_params;
void main() {
  vec3 wp = a_center + a_tan * a_corner.x + a_bit * a_corner.y;
  v_uv = a_corner;
  v_params = a_params;
  gl_Position = u_viewProj * vec4(wp, 1.0);
}`;

const FRAG = `#version 300 es
precision mediump float;
in vec2 v_uv;
in vec2 v_params;
out vec4 o_color;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  float d = length(v_uv);
  // irregular rim: jitter the radius by angle-hashed noise
  float ang = atan(v_uv.y, v_uv.x);
  float rim = 1.0 - 0.18 * hash(vec2(floor(ang * 5.0), v_params.y));
  if (d > rim) discard;
  float core = 1.0 - smoothstep(0.0, 0.42 * rim, d);     // punched hole
  float soot = 1.0 - smoothstep(0.30 * rim, rim, d);     // soft halo
  float a = clamp(core * 0.95 + soot * 0.5, 0.0, 1.0) * v_params.x;
  vec3 col = mix(vec3(0.085, 0.075, 0.065), vec3(0.015), core); // sooty → near-black
  o_color = vec4(col, a);
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src); gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
  return sh;
}

const STRIDE = 11; // center3 + tan3 + bit3 + params2

export function createDecalRenderer(gl, opts = {}) {
  const max = opts.max ?? 256;
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  const uVP = gl.getUniformLocation(prog, 'u_viewProj');

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const inst = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, inst);
  gl.bufferData(gl.ARRAY_BUFFER, max * STRIDE * 4, gl.DYNAMIC_DRAW);
  const attr = (loc, size, off) => {
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, STRIDE * 4, off * 4);
    gl.vertexAttribDivisor(loc, 1);
  };
  attr(1, 3, 0); attr(2, 3, 3); attr(3, 3, 6); attr(4, 2, 9);
  gl.bindVertexArray(null);

  const scratch = new Float32Array(STRIDE);
  const cpu = new Float32Array(max * STRIDE); // mirror — placements are rewritable
  let cursor = 0, count = 0;

  function add({ pos, normal, size = 0.07, dark = 0.85, rot }) {
    const n = normal || [0, 1, 0];
    const nl = Math.hypot(n[0], n[1], n[2]) || 1;
    const nx = n[0] / nl, ny = n[1] / nl, nz = n[2] / nl;
    // tangent basis: up × n (perpendicular to n), or world-x when n ≈ up
    let tx, ty, tz;
    if (Math.abs(ny) < 0.9) { tx = nz; ty = 0; tz = -nx; }
    else { tx = 1; ty = 0; tz = 0; }
    let tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;
    const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
    // random in-plane rotation so repeated hits don't look stamped
    const r = rot ?? Math.random() * Math.PI * 2;
    const cr = Math.cos(r), sr = Math.sin(r);
    const rtx = tx * cr + bx * sr, rty = ty * cr + by * sr, rtz = tz * cr + bz * sr;
    const rbx = bx * cr - tx * sr, rby = by * cr - ty * sr, rbz = bz * cr - tz * sr;
    scratch[0] = pos[0] + nx * 0.006; // lift off the surface (no z-fight)
    scratch[1] = pos[1] + ny * 0.006;
    scratch[2] = pos[2] + nz * 0.006;
    scratch[3] = rtx * size; scratch[4] = rty * size; scratch[5] = rtz * size;
    scratch[6] = rbx * size; scratch[7] = rby * size; scratch[8] = rbz * size;
    scratch[9] = dark;
    scratch[10] = (cursor * 0.613) % 1; // per-decal hash seed
    gl.bindBuffer(gl.ARRAY_BUFFER, inst);
    gl.bufferSubData(gl.ARRAY_BUFFER, cursor * STRIDE * 4, scratch);
    cpu.set(scratch, cursor * STRIDE);
    const slot = cursor;
    cursor = (cursor + 1) % max;       // ring: oldest decal gets overwritten
    if (count < max) count++;
    // return the slot + world placement so a caller can parent the decal to a
    // moving object (store in its local space, setPlacement on its moves)
    return {
      slot,
      center: [scratch[0], scratch[1], scratch[2]],
      tan: [scratch[3], scratch[4], scratch[5]],
      bit: [scratch[6], scratch[7], scratch[8]],
    };
  }

  // rewrite a decal's placement (center/tan/bit) — darkness/seed kept.
  // This is how parented decals RIDE a moving surface: 9 floats + one
  // bufferSubData per decal, only when its parent actually moves.
  function setPlacement(slot, center, tan, bit) {
    const o = slot * STRIDE;
    cpu[o] = center[0]; cpu[o + 1] = center[1]; cpu[o + 2] = center[2];
    cpu[o + 3] = tan[0]; cpu[o + 4] = tan[1]; cpu[o + 5] = tan[2];
    cpu[o + 6] = bit[0]; cpu[o + 7] = bit[1]; cpu[o + 8] = bit[2];
    gl.bindBuffer(gl.ARRAY_BUFFER, inst);
    gl.bufferSubData(gl.ARRAY_BUFFER, o * 4, cpu.subarray(o, o + 9));
  }

  function placement(slot) { // test/introspection hook
    const o = slot * STRIDE;
    return { center: [cpu[o], cpu[o + 1], cpu[o + 2]] };
  }

  function draw(viewProj) {
    if (!count) return;
    gl.useProgram(prog);
    gl.bindVertexArray(vao);
    gl.uniformMatrix4fv(uVP, false, viewProj);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    gl.depthMask(true);
    gl.bindVertexArray(null);
  }

  function clear() { cursor = 0; count = 0; }
  function destroy() {
    gl.deleteProgram(prog); gl.deleteBuffer(quad); gl.deleteBuffer(inst); gl.deleteVertexArray(vao);
  }

  return { add, setPlacement, placement, draw, clear, destroy, get count() { return count; } };
}
