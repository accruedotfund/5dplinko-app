// core/gl/shafts.js — volumetric-looking LIGHT SHAFTS (godray beams from
// windows, cracks, fixtures). Each shaft is an axial-billboard quad (rotates
// around its axis to face the camera) with soft lateral falloff, longitudinal
// fade, and animated dust streaming through the beam. Additive blend.
//
//   gl-scene child:
//   { type: 'gl-shaft', pos: [x,y,z],      // beam ORIGIN (the window)
//     dir: [x,y,z], length: 8, radius: 1.2,
//     color: [1,0.95,0.8], intensity: 0.5, dust: 0.6, taper: 1.6 }

const VERT = `#version 300 es
layout(location=0) in vec2 a_q;            // (u: 0..1 along, v: -1..1 across)
uniform mat4 u_viewProj;
uniform vec3 u_origin, u_axis, u_camPos;
uniform float u_length, u_radius, u_taper;
out vec2 v_q;
void main() {
  vec3 p = u_origin + u_axis * (a_q.x * u_length);
  // axial billboard: width direction ⊥ axis, facing the camera
  vec3 toCam = u_camPos - p;
  vec3 side = normalize(cross(u_axis, toCam));
  float r = u_radius * mix(1.0, u_taper, a_q.x);   // beam widens with distance
  p += side * (a_q.y * r);
  v_q = a_q;
  gl_Position = u_viewProj * vec4(p, 1.0);
}`;

const FRAG = `#version 300 es
precision mediump float;
in vec2 v_q;
out vec4 o_color;
uniform vec3 u_color;
uniform float u_intensity, u_dust, u_time, u_soft;
uniform highp float u_length; // shared with the vertex stage (highp there)

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}

void main() {
  float across = 1.0 - abs(v_q.y);                       // soft beam edges
  float along = (1.0 - v_q.x) * smoothstep(0.0, 0.12, v_q.x); // fade to tip, soft root
  float body = pow(across, u_soft) * along;
  // dust: streaks drifting DOWN the beam + slow shimmer
  float dust = vnoise(vec2(v_q.y * 6.0, v_q.x * u_length * 1.5 - u_time * 0.55))
             * vnoise(vec2(v_q.y * 13.0 + 7.0, v_q.x * u_length * 3.0 - u_time * 0.9));
  body *= 1.0 + (dust - 0.35) * 2.2 * u_dust;
  o_color = vec4(u_color * max(body, 0.0) * u_intensity, 1.0);
}`;

export function createShaftRenderer(gl) {
  let prog = null, u = null, vao = null;
  const shafts = [];

  function ensure() {
    if (prog) return;
    prog = link(gl);
    u = {};
    const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const inf = gl.getActiveUniform(prog, i);
      u[inf.name] = gl.getUniformLocation(prog, inf.name);
    }
    vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    // strip: (0,-1)(0,1)(1,-1)(1,1)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 0, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  function add(spec) {
    ensure();
    const d = spec.dir || [0, -1, 0];
    const dl = Math.hypot(d[0], d[1], d[2]) || 1;
    const s = {
      pos: spec.pos, axis: [d[0] / dl, d[1] / dl, d[2] / dl],
      length: spec.length ?? 8, radius: spec.radius ?? 1,
      color: spec.color || [1, 0.95, 0.8], intensity: spec.intensity ?? 0.5,
      dust: spec.dust ?? 0.6, taper: spec.taper ?? 1.6,
      soft: spec.soft ?? 1.8, // edge falloff exponent (lower = harder sheet edges)
    };
    shafts.push(s);
    return s;
  }

  // additive, depth-tested but not written — drawn after the blend pass
  function draw(camera, viewProj, time) {
    if (!shafts.length) return;
    gl.useProgram(prog);
    gl.bindVertexArray(vao);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.uniformMatrix4fv(u.u_viewProj, false, viewProj);
    gl.uniform3fv(u.u_camPos, camera.pos);
    gl.uniform1f(u.u_time, time);
    for (const s of shafts) {
      gl.uniform3fv(u.u_origin, s.pos);
      gl.uniform3fv(u.u_axis, s.axis);
      gl.uniform1f(u.u_length, s.length);
      gl.uniform1f(u.u_radius, s.radius);
      gl.uniform1f(u.u_taper, s.taper);
      gl.uniform3fv(u.u_color, s.color);
      gl.uniform1f(u.u_intensity, s.intensity);
      gl.uniform1f(u.u_dust, s.dust);
      gl.uniform1f(u.u_soft, s.soft);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.enable(gl.CULL_FACE);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }

  function destroy() { if (prog) gl.deleteProgram(prog); if (vao) gl.deleteVertexArray(vao); shafts.length = 0; }

  return { add, draw, destroy, shafts };
}

function link(gl) {
  const mk = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('shafts: ' + gl.getShaderInfoLog(sh));
    return sh;
  };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('shafts: link: ' + gl.getProgramInfoLog(p));
  return p;
}
