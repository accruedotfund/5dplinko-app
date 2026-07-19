// core/gl/foliage.js — instanced grass/foliage renderer. Tens of thousands of
// curved, oriented blades in ONE drawArraysInstanced call. Each blade is a
// multi-segment tapered TRIANGLE STRIP (real geometry, not a billboard): it has a
// random facing, a forward arc, and wind that increases toward the tip. The big
// quality win is ROUNDED NORMALS — the per-vertex normal is bent across the blade
// width so each blade shades like a cylinder, giving the field a soft volumetric
// look instead of flat cards (technique: medium.com/antaeus-ar grass-with-triangles).
// Depth-written cutout (no blending) so it sorts itself.
//
//   gl-scene child:
//   { type: 'gl-foliage', area: [x0, z0, x1, z1], y: 0,
//     density: 6,                    // blades per m²
//     height: [0.25, 0.6], width: 0.05,
//     segments: 4,                   // blade resolution (1..8) — more = smoother arc
//     bend: 0.25,                    // forward curvature of each blade
//     roundness: 0.4,                // normal bend across width (cylindrical shading)
//     windDir: [0.8, 0.6],           // wind heading in XZ
//     baseColor: [0.05,0.14,0.04], tipColor: [0.22,0.42,0.13],
//     sway: 0.12, swaySpeed: 1, seed: 1, sun: 1,
//     // ── stylized (Ghibli) ──
//     tipWarm: [..], tipCool: [..],  // painterly patch palette (blend across the field)
//     patchScale: 0.06,              // patch frequency (0 = off → single tipColor)
//     sunStrength: 0.45,             // <1 flattens the sun for a painted look
//     // ── low-end GPU ──
//     quality: 'low'|'med'|'high',   // sets default segments (1/2/4) + backlight off on 'low'
//     backlight: false,              // skip the subsurface term (cheaper fragment)
//     maxBlades: 300000,             // hard blade cap for this patch
//     maxDist: 45 }                  // cull whole blades past this distance (0 = off) }

import { SPATIAL_GLSL, setSpatialUniforms } from './spatial.js';

const VERT = `#version 300 es
${SPATIAL_GLSL}
layout(location=0) in vec4 a_seed;   // x, z, height, angle (facing)
layout(location=1) in vec4 a_var;    // width-jitter, color-jitter, bend-jitter, wind-phase

uniform mat4 u_viewProj;
uniform vec3 u_camPos;
uniform float u_y, u_width, u_sway, u_swaySpeed, u_time;
uniform float u_segments, u_bend, u_round;
uniform float u_noiseScale, u_maxDist;   // painterly patch frequency / far cull
uniform vec2 u_windDir;

out float v_tip;     // 0 root → 1 tip
out float v_cvar;
out float v_dist;    // per-blade camera distance (fog)
out float v_patch;   // 0..1 low-freq color patch (painterly / Ghibli zones)
out vec3 v_normal;   // rounded blade normal
out vec3 v_world;    // world pos (for view-dependent backlight)

// cheap value noise for soft color patches (per-blade, so it's ~free)
float h21(vec2 p) { p = fract(p * vec2(123.34, 345.45)); p += dot(p, p + 34.345); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  float a = h21(i), b = h21(i + vec2(1, 0)), c = h21(i + vec2(0, 1)), d = h21(i + vec2(1, 1));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

void main() {
  // a tapered triangle STRIP up the blade: per level a left/right pair, plus a tip.
  int seg = int(u_segments);
  int last = seg * 2;          // tip vertex index
  int vid = gl_VertexID;
  float t;                     // 0 root → 1 tip
  float across;                // -1 left edge, +1 right edge, 0 at the tip
  if (vid >= last) { t = 1.0; across = 0.0; }
  else { int level = vid / 2; across = (vid % 2 == 0) ? -1.0 : 1.0; t = float(level) / float(seg); }

  vec3 root = vec3(a_seed.x, u_y, a_seed.y);
  float h = a_seed.z;
  float dist = length(u_camPos - root);

  // far cull (low-end): collapse whole blades past u_maxDist to a degenerate point so
  // they raster zero fragments. dist is per-blade, so all 3+ verts collapse together.
  if (u_maxDist > 0.0 && dist > u_maxDist) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }

  // per-blade frame: facing dir (lean) + side axis, both in XZ
  float ang = a_seed.w;
  vec2 dir = vec2(cos(ang), sin(ang));
  vec2 sideXZ = vec2(-dir.y, dir.x);

  // wind: two sines, phase per blade, pushed along the global wind heading; the
  // static lean (a_var.z) and wind combine into one horizontal bend vector
  float ph = a_var.w;
  float wind = sin(u_time * u_swaySpeed + ph) * 0.7
             + sin(u_time * u_swaySpeed * 2.3 + ph * 1.7) * 0.3;
  vec2 bendVec = dir * (a_var.z * u_bend) + u_windDir * (wind * u_sway);

  // width tapers to the tip; widen distant blades a touch so they don't sub-pixel flicker
  float w = u_width * a_var.x * (1.0 - t) * (1.0 + smoothstep(15.0, 70.0, dist) * 1.2);

  // quadratic arc: root stays planted (t*t), bends forward toward bendVec
  vec3 pos = root
           + vec3(bendVec.x, 0.0, bendVec.y) * (t * t)
           + vec3(0.0, h * t, 0.0)
           + vec3(sideXZ.x, 0.0, sideXZ.y) * (across * w * 0.5);

  // normal: face normal from the curve tangent × side, then ROUND it across the
  // width so the two edges face outward → cylindrical, full-looking shading
  vec3 T = normalize(vec3(bendVec.x * 2.0 * t, h, bendVec.y * 2.0 * t));
  vec3 S = vec3(sideXZ.x, 0.0, sideXZ.y);
  vec3 faceN = normalize(cross(T, S));
  v_normal = normalize(faceN + S * (across * u_round));

  v_tip = t;
  v_cvar = a_var.y;
  v_dist = dist;
  v_patch = (u_noiseScale > 0.0) ? vnoise(root.xz * u_noiseScale) : 0.0;
  v_world = pos;
  gl_Position = u_viewProj * vec4(pos, 1.0);
  // SAME telephoto deform as ground + props so blades stay rooted in the ground.
  gl_Position = pf_applySpatial(gl_Position, pos);
}`;

const FRAG = `#version 300 es
precision highp float;
in float v_tip;
in float v_cvar;
in float v_dist;
in float v_patch;
in vec3 v_normal;
in vec3 v_world;
out vec4 o_color;

uniform vec3 u_baseColor, u_tipWarm, u_tipCool;
uniform vec3 u_skyColor, u_groundColor, u_sunColor, u_sunDir;
uniform float u_sunFactor;
uniform vec3 u_fogColor, u_camPos;
uniform float u_fogDensity;
uniform float u_gradeContrast, u_gradeSaturation;
uniform float u_sunStrength;   // 1 = realistic, lower = flat stylized (Ghibli)
uniform float u_backlight;     // 0 disables the subsurface term (low-end)

void main() {
  // two-sided: flip the normal for back faces (blades are drawn with culling off)
  vec3 N = normalize(v_normal);
  if (!gl_FrontFacing) N = -N;

  // painterly tip color: soft patches blend warm↔cool across the field (Ghibli zones).
  // (warm==cool when the manifest gives a single tipColor → no patches, classic look.)
  vec3 tip = mix(u_tipCool, u_tipWarm, v_patch);
  vec3 albedo = mix(u_baseColor, tip, v_tip) * (0.85 + v_cvar * 0.3);

  // hemisphere ambient (sky above ↔ ground below by the rounded normal) + sun diffuse.
  vec3 hemi = mix(u_groundColor, u_skyColor, clamp(N.y * 0.5 + 0.5, 0.0, 1.0));
  float ndl = max(dot(N, -u_sunDir), 0.0);
  vec3 lightFull = hemi + u_sunColor * ndl * u_sunFactor;
  // u_sunStrength<1 blends the lighting toward FLAT WHITE so the bright stylized albedo
  // shows through (painted, low-contrast Ghibli look) instead of being crushed by dim
  // scene ambient. =1 → fully physical (classic). The soft root AO is kept either way.
  vec3 light = mix(vec3(1.0), lightFull, clamp(u_sunStrength, 0.0, 1.0));
  float ao = mix(0.55, 1.0, v_tip);          // root self-occlusion → darker base
  vec3 color = albedo * light * ao;

  // subsurface backlight: thin blades glow when the sun is behind them (skipped on low-end)
  if (u_backlight > 0.5) {
    vec3 V = normalize(u_camPos - v_world);
    float trans = pow(max(dot(-V, -u_sunDir), 0.0), 4.0);
    color += albedo * u_sunColor * (trans * 0.25 * v_tip * u_sunFactor);
  }

  float fog = 1.0 - exp(-u_fogDensity * u_fogDensity * v_dist * v_dist);
  color = mix(color, u_fogColor, clamp(fog, 0.0, 1.0));
  // stylized (sunStrength<1): apply less Reinhard tonemap + BOOST saturation so the
  // painted greens stay punchy. Realistic (=1): full tonemap + the manifest grade.
  float s = clamp(u_sunStrength, 0.0, 1.0);
  vec3 mapped = color / (color + vec3(1.0));
  color = clamp(mix(color, mapped, s), 0.0, 1.4);
  float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
  float sat = mix(1.45, u_gradeSaturation, s);
  color = mix(vec3(luma), color, sat);
  color = pow(max(color, 0.0), vec3(u_gradeContrast));
  o_color = vec4(pow(max(color, 0.0), vec3(1.0 / 2.2)), 1.0);
}`;

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createFoliageRenderer(gl) {
  let prog = null, u = null;
  const patches = [];

  function ensure() {
    if (prog) return;
    prog = link(gl);
    u = {};
    const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const inf = gl.getActiveUniform(prog, i);
      u[inf.name] = gl.getUniformLocation(prog, inf.name);
    }
  }

  function add(spec) {
    ensure();
    const [x0, z0, x1, z1] = spec.area;
    const density = spec.density ?? 6;
    const hMin = spec.height?.[0] ?? 0.25, hMax = spec.height?.[1] ?? 0.6;
    const count = Math.min(Math.floor((x1 - x0) * (z1 - z0) * density), spec.maxBlades ?? 300000);
    const rnd = mulberry32(spec.seed ?? 1);
    // 8 floats/blade: a_seed(x,z,height,angle) + a_var(widthJit,colorJit,bendJit,phase)
    const data = new Float32Array(count * 8);
    for (let i = 0; i < count; i++) {
      const o = i * 8;
      data[o] = x0 + rnd() * (x1 - x0);
      data[o + 1] = z0 + rnd() * (z1 - z0);
      data[o + 2] = hMin + rnd() * (hMax - hMin);
      data[o + 3] = rnd() * Math.PI * 2;        // facing angle
      data[o + 4] = 0.7 + rnd() * 0.6;          // width jitter
      data[o + 5] = rnd();                      // color jitter
      data[o + 6] = 0.6 + rnd() * 0.8;          // bend jitter
      data[o + 7] = rnd() * Math.PI * 2;        // wind phase
    }
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 32, 0);
    gl.vertexAttribDivisor(0, 1);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 16);
    gl.vertexAttribDivisor(1, 1);
    gl.bindVertexArray(null);
    // quality presets (low-end tuning): fewer blade segments + no backlight on 'low'
    const quality = spec.quality || 'high';
    const lowEnd = quality === 'low';
    const defSeg = lowEnd ? 1 : (quality === 'med' ? 2 : 4);
    const segments = Math.max(1, Math.min(spec.segments ?? defSeg, 8));
    const wd = spec.windDir || [0.8, 0.6];
    const wlen = Math.hypot(wd[0], wd[1]) || 1;
    const tip = spec.tipColor || [0.22, 0.42, 0.13];
    const patch = {
      vao, buf, count,
      y: spec.y ?? 0, width: spec.width ?? 0.05,
      sway: spec.sway ?? 0.12, swaySpeed: spec.swaySpeed ?? 1,
      segments, vertsPerBlade: segments * 2 + 1,
      bend: spec.bend ?? 0.25, roundness: spec.roundness ?? 0.4,
      windDir: [wd[0] / wlen, wd[1] / wlen],
      baseColor: spec.baseColor || [0.05, 0.14, 0.04],
      // stylized painterly patches: warm↔cool tip palette + patch frequency. Default
      // both to the single tipColor (no patches → classic look).
      tipWarm: spec.tipWarm || tip,
      tipCool: spec.tipCool || tip,
      patchScale: spec.patchScale ?? 0,
      sunStrength: spec.sunStrength ?? 1,
      backlight: (spec.backlight ?? !lowEnd) ? 1 : 0,
      maxDist: spec.maxDist ?? 0,
      sun: spec.sun ?? 1,
      center: [(x0 + x1) / 2, (z0 + z1) / 2],
    };
    patches.push(patch);
    return patch;
  }

  // drawn with the opaque pass tail: depth-written, no blending
  function draw(camera, viewProj, lights, env, time) {
    if (!patches.length) return;
    gl.useProgram(prog);
    gl.disable(gl.CULL_FACE); // blades visible from both sides
    gl.uniformMatrix4fv(u.u_viewProj, false, viewProj);
    gl.uniform3fv(u.u_camPos, camera.pos);
    setSpatialUniforms(gl, u, env, camera.pos); // SAME deform → blades stay rooted
    gl.uniform3fv(u.u_skyColor, lights.skyColor);
    gl.uniform3fv(u.u_groundColor, lights.groundColor);
    gl.uniform3fv(u.u_sunColor, lights.sunColor);
    gl.uniform3fv(u.u_sunDir, lights.sunDir);
    if (env.fog) { gl.uniform3fv(u.u_fogColor, env.fog.color); gl.uniform1f(u.u_fogDensity, env.fog.density); }
    else gl.uniform1f(u.u_fogDensity, 0);
    gl.uniform1f(u.u_gradeContrast, env.grade?.contrast ?? 1);
    gl.uniform1f(u.u_gradeSaturation, env.grade?.saturation ?? 1);
    gl.uniform1f(u.u_time, time);
    for (const p of patches) {
      gl.bindVertexArray(p.vao);
      gl.uniform1f(u.u_y, p.y);
      gl.uniform1f(u.u_width, p.width);
      gl.uniform1f(u.u_sway, p.sway);
      gl.uniform1f(u.u_swaySpeed, p.swaySpeed);
      gl.uniform1f(u.u_segments, p.segments);
      gl.uniform1f(u.u_bend, p.bend);
      gl.uniform1f(u.u_round, p.roundness);
      gl.uniform1f(u.u_noiseScale, p.patchScale);
      gl.uniform1f(u.u_maxDist, p.maxDist);
      gl.uniform2fv(u.u_windDir, p.windDir);
      gl.uniform3fv(u.u_baseColor, p.baseColor);
      gl.uniform3fv(u.u_tipWarm, p.tipWarm);
      gl.uniform3fv(u.u_tipCool, p.tipCool);
      gl.uniform1f(u.u_sunStrength, p.sunStrength);
      gl.uniform1f(u.u_backlight, p.backlight);
      gl.uniform1f(u.u_sunFactor, p.sun);
      // each instance is its own tapered triangle strip (curved, oriented blade)
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, p.vertsPerBlade, p.count);
    }
    gl.enable(gl.CULL_FACE);
    gl.bindVertexArray(null);
  }

  function destroy() {
    for (const p of patches) { gl.deleteBuffer(p.buf); gl.deleteVertexArray(p.vao); }
    if (prog) gl.deleteProgram(prog);
    patches.length = 0;
  }

  return { add, draw, destroy, patches };
}

function link(gl) {
  const mk = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('foliage: ' + gl.getShaderInfoLog(sh));
    return sh;
  };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('foliage: link: ' + gl.getProgramInfoLog(p));
  return p;
}
