// core/gl/particles.js — GPU-resident billboard particle system.
//
// Design: STATELESS SIMULATION. A particle is 18 floats written ONCE at emit
// time (ring buffer, bufferSubData); every frame the vertex shader integrates
// position/rotation/size/color from u_time alone. No per-frame CPU work, no
// readbacks — rendering N particles is one drawArraysInstanced call.
//
//   const sys = createParticleSystem(gl, { max: 4096, texture: ImageBitmap? });
//   sys.burst({
//     pos: [x,y,z], count: 60,
//     dir: [0,1,0], spread: 0.6,        // cone (radians) around dir
//     speed: [2, 6], life: [0.15, 0.5], // min/max ranges
//     size: [0.10, 0.02],               // start → end (meters)
//     colorA: [1,0.8,0.3], colorB: [1,0.2,0.05],  // birth → death tint
//     angle: [0, 6.28], angVel: [-6, 6],          // billboard roll
//     gravity: [0,-4,0],                // per-burst
//   });
//   sys.draw(view, viewProj, timeSec);  // AFTER opaque+blend passes
//
// Blending is ADDITIVE (ONE, ONE) with depth-test on / depth-write off →
// particles glow over the scene and stack brighter where they overlap, which
// is what sells "glowing in the dark". Texture optional (default: soft disc).

const FLOATS = 19, VERT_ATTRS = [
  // [name, size, offset]
  ['a_pos0', 3, 0], ['a_vel', 3, 3], ['a_birth', 1, 6], ['a_life', 1, 7],
  ['a_size', 2, 8], ['a_rot', 2, 10], ['a_colorA', 3, 12], ['a_colorB', 3, 15],
  ['a_grav', 1, 18],  // per-particle vertical gravity — a shared uniform would
                      // snap ALL live particles onto the last burst's parabola
];

const VERT = `#version 300 es
layout(location=0) in vec3 a_pos0;
layout(location=1) in vec3 a_vel;
layout(location=2) in float a_birth;
layout(location=3) in float a_life;
layout(location=4) in vec2 a_size;     // start, end
layout(location=5) in vec2 a_rot;      // angle0, angVel
layout(location=6) in vec3 a_colorA;
layout(location=7) in vec3 a_colorB;
layout(location=8) in float a_grav;

uniform mat4 u_viewProj;
uniform vec3 u_camRight, u_camUp;
uniform float u_time;

out vec2 v_uv;
out vec4 v_color;

void main() {
  float age = u_time - a_birth;
  float t = clamp(age / max(a_life, 1e-4), 0.0, 1.0);
  bool dead = age < 0.0 || age > a_life;

  // corner of a 2-triangle strip from gl_VertexID: (0,0)(1,0)(0,1)(1,1)
  vec2 c = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1)) - 0.5;
  v_uv = c + 0.5;

  float size = dead ? 0.0 : mix(a_size.x, a_size.y, t);
  float ang = a_rot.x + a_rot.y * age;
  float ca = cos(ang), sa = sin(ang);
  vec2 rc = vec2(c.x * ca - c.y * sa, c.x * sa + c.y * ca) * size;

  vec3 wp = a_pos0 + a_vel * age + vec3(0.0, 0.5 * a_grav * age * age, 0.0)
          + u_camRight * rc.x + u_camUp * rc.y;

  // fade: quick in, ease out
  float alpha = smoothstep(0.0, 0.07, t) * (1.0 - t * t);
  v_color = vec4(mix(a_colorA, a_colorB, t), alpha);
  gl_Position = dead ? vec4(2.0, 2.0, 2.0, 1.0) : u_viewProj * vec4(wp, 1.0);
}`;

const FRAG = `#version 300 es
precision mediump float;
in vec2 v_uv;
in vec4 v_color;
out vec4 o_color;
uniform sampler2D u_tex;
uniform float u_useTex;
void main() {
  float shape;
  vec3 tint = v_color.rgb;
  if (u_useTex > 0.5) {
    vec4 s = texture(u_tex, v_uv);
    shape = s.a;
    tint *= s.rgb;
  } else {
    // soft disc with a hot core
    float d = length(v_uv - 0.5) * 2.0;
    shape = smoothstep(1.0, 0.35, d) + smoothstep(0.35, 0.0, d) * 0.8;
  }
  // additive output (blend ONE, ONE): premultiply by alpha
  o_color = vec4(tint * shape * v_color.a, 1.0);
}`;

export function createParticleSystem(gl, opts = {}) {
  const max = opts.max ?? 4096;
  const data = new Float32Array(max * FLOATS);
  let cursor = 0, lastDeath = -1;

  const prog = compile(gl);
  const u = {
    viewProj: gl.getUniformLocation(prog, 'u_viewProj'),
    camRight: gl.getUniformLocation(prog, 'u_camRight'),
    camUp: gl.getUniformLocation(prog, 'u_camUp'),
    time: gl.getUniformLocation(prog, 'u_time'),
    tex: gl.getUniformLocation(prog, 'u_tex'),
    useTex: gl.getUniformLocation(prog, 'u_useTex'),
  };

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, data.byteLength, gl.DYNAMIC_DRAW);
  VERT_ATTRS.forEach(([, size, offset], i) => {
    gl.enableVertexAttribArray(i);
    gl.vertexAttribPointer(i, size, gl.FLOAT, false, FLOATS * 4, offset * 4);
    gl.vertexAttribDivisor(i, 1); // per-instance
  });
  gl.bindVertexArray(null);

  let texture = null;
  if (opts.texture) setTexture(opts.texture);
  function setTexture(image) {
    texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  const rr = (range, def) => {
    if (range === undefined) range = def;
    return Array.isArray(range) ? range[0] + Math.random() * (range[1] - range[0]) : range;
  };

  function burst(o) {
    const count = Math.min(o.count ?? 30, max);
    const now = o.now ?? performance.now() / 1000;
    const pos = o.pos || [0, 0, 0];
    const dir = o.dir || [0, 1, 0];
    const dl = Math.sqrt(dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]) || 1;
    const D = [dir[0] / dl, dir[1] / dl, dir[2] / dl];
    // orthonormal basis around D for the spread cone
    const ref = Math.abs(D[1]) < 0.95 ? [0, 1, 0] : [1, 0, 0];
    const S1 = norm(cross(D, ref)), S2 = cross(D, S1);
    const spread = o.spread ?? 0.5;
    const grav = o.gravity ? o.gravity[1] : -3; // vertical-only (y component)

    for (let n = 0; n < count; n++) {
      const i = cursor * FLOATS;
      cursor = (cursor + 1) % max;
      const th = Math.random() * Math.PI * 2;
      const ca = Math.cos(Math.random() * spread); // cone angle
      const sa = Math.sqrt(1 - ca * ca);
      const vx = D[0] * ca + (S1[0] * Math.cos(th) + S2[0] * Math.sin(th)) * sa;
      const vy = D[1] * ca + (S1[1] * Math.cos(th) + S2[1] * Math.sin(th)) * sa;
      const vz = D[2] * ca + (S1[2] * Math.cos(th) + S2[2] * Math.sin(th)) * sa;
      const sp = rr(o.speed, [1, 3]);
      const life = rr(o.life, [0.2, 0.6]);
      const jit = o.posJitter ?? 0;
      data[i] = pos[0] + (Math.random() - 0.5) * jit;
      data[i + 1] = pos[1] + (Math.random() - 0.5) * jit;
      data[i + 2] = pos[2] + (Math.random() - 0.5) * jit;
      data[i + 3] = vx * sp; data[i + 4] = vy * sp; data[i + 5] = vz * sp;
      data[i + 6] = now; data[i + 7] = life;
      data[i + 8] = rr(o.size?.[0] ?? o.size, 0.08); data[i + 9] = o.size?.[1] ?? 0.01;
      data[i + 10] = rr(o.angle, [0, Math.PI * 2]); data[i + 11] = rr(o.angVel, [-4, 4]);
      const cA = o.colorA || [1, 0.85, 0.4], cB = o.colorB || cA;
      data[i + 12] = cA[0]; data[i + 13] = cA[1]; data[i + 14] = cA[2];
      data[i + 15] = cB[0]; data[i + 16] = cB[1]; data[i + 17] = cB[2];
      data[i + 18] = grav;
      if (now + life > lastDeath) lastDeath = now + life;
    }
    // upload just the written span (may wrap the ring → two uploads)
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    const start = (cursor - count + max) % max;
    if (start + count <= max) {
      gl.bufferSubData(gl.ARRAY_BUFFER, start * FLOATS * 4, data, start * FLOATS, count * FLOATS);
    } else {
      const head = max - start;
      gl.bufferSubData(gl.ARRAY_BUFFER, start * FLOATS * 4, data, start * FLOATS, head * FLOATS);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, (count - head) * FLOATS);
    }
  }

  function draw(view, viewProj, time) {
    if (time > lastDeath) return; // nothing alive
    gl.useProgram(prog);
    gl.bindVertexArray(vao);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.depthMask(false);
    gl.uniformMatrix4fv(u.viewProj, false, viewProj);
    gl.uniform3f(u.camRight, view[0], view[4], view[8]);
    gl.uniform3f(u.camUp, view[1], view[5], view[9]);
    gl.uniform1f(u.time, time);
    gl.uniform1f(u.useTex, texture ? 1 : 0);
    if (texture) { gl.activeTexture(gl.TEXTURE0 + 6); gl.bindTexture(gl.TEXTURE_2D, texture); gl.uniform1i(u.tex, 6); }
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, max);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }

  function destroy() {
    gl.deleteBuffer(buf); gl.deleteVertexArray(vao); gl.deleteProgram(prog);
    if (texture) gl.deleteTexture(texture);
  }

  return { burst, draw, destroy, setTexture, get max() { return max; } };
}

function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm(a) { const l = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }

function compile(gl) {
  const mk = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('particles: ' + gl.getShaderInfoLog(sh));
    return sh;
  };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('particles: link: ' + gl.getProgramInfoLog(p));
  return p;
}
