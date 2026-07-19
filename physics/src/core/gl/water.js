// core/gl/water.js — dedicated water surface renderer.
//
// A water surface is a horizontal rectangle with a PROCEDURAL ANIMATED surface:
// three directional gerstner-lite waves + micro-ripple noise perturb the normal
// per-fragment, so the scene's real lights streak and glint across it. Clarity
// is a dial: 1 = glass (see the bottom through low alpha), 0 = thick muck
// (near-opaque). Flow scrolls the whole wavefield directionally (and the same
// vector drives current physics in gl-scene).
//
//   const wr = createWaterRenderer(gl);
//   wr.add({ area: [x0, z0, x1, z1], level: -0.1,
//            color: [0.16, 0.4, 0.45], clarity: 0.7,
//            waveScale: 2.4, waveHeight: 0.7, waveSpeed: 1.0,
//            flow: [0.3, 0], sparkle: 1 });
//   // drawn by renderer.drawFrame after the blend pass (same lights/env/fog)
//
// Mucky preset: clarity 0.05–0.2, dark color, waveHeight low, slow speed.

import { MAX_POINT_LIGHTS } from './shaders.js';
import { SPATIAL_GLSL, setSpatialUniforms } from './spatial.js';

const VERT = `#version 300 es
${SPATIAL_GLSL}
layout(location=0) in vec2 a_corner;     // 0..1 quad
uniform vec4 u_area;                      // x0, z0, x1, z1
uniform float u_level;
uniform mat4 u_viewProj;
out vec3 v_worldPos;
void main() {
  vec3 wp = vec3(mix(u_area.x, u_area.z, a_corner.x), u_level, mix(u_area.y, u_area.w, a_corner.y));
  v_worldPos = wp;
  gl_Position = u_viewProj * vec4(wp, 1.0);
  // SAME telephoto deform as ground + props so the water surface stays glued to its shore.
  gl_Position = pf_applySpatial(gl_Position, wp);
}`;

const FRAG = `#version 300 es
precision mediump float;
in vec3 v_worldPos;
out vec4 o_color;

uniform vec3 u_camPos;
uniform vec3 u_sunDir, u_sunColor, u_skyColor, u_groundColor;
uniform vec4 u_pointPos[${MAX_POINT_LIGHTS}];
uniform vec3 u_pointColor[${MAX_POINT_LIGHTS}];
uniform vec4 u_pointDir[${MAX_POINT_LIGHTS}];
uniform vec3 u_fogColor;
uniform float u_fogDensity;
uniform float u_gradeContrast, u_gradeSaturation, u_vignette;
uniform vec2 u_viewport;
uniform float u_time;

uniform vec3 u_waterColor;
uniform float u_clarity;      // 1 = clear, 0 = muck
uniform float u_opacity;      // >= 0: direct alpha override (clarity still shapes gloss)
uniform float u_waveScale, u_waveHeight, u_waveSpeed, u_sparkle;
uniform vec2 u_flow;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}

void main() {
  vec2 p = (v_worldPos.xz - u_flow * u_time) / u_waveScale;
  float t = u_time * u_waveSpeed;

  // 3 directional waves: analytic slope sum → normal
  vec2 d1 = vec2(0.8, 0.6), d2 = vec2(-0.6, 0.8), d3 = vec2(0.2, -0.98);
  float s1 = cos(dot(d1, p) * 4.1 + t * 1.6);
  float s2 = cos(dot(d2, p) * 6.7 + t * 2.3);
  float s3 = cos(dot(d3, p) * 10.3 + t * 3.1);
  vec2 slope = (d1 * s1 * 0.5 + d2 * s2 * 0.3 + d3 * s3 * 0.2) * u_waveHeight;
  // micro ripple
  float e = 0.18;
  vec2 rp = p * 9.0 + t * 0.7;
  slope += vec2(vnoise(rp + vec2(e, 0.0)) - vnoise(rp - vec2(e, 0.0)),
                vnoise(rp + vec2(0.0, e)) - vnoise(rp - vec2(0.0, e))) * 0.7 * u_waveHeight;
  vec3 N = normalize(vec3(-slope.x, 1.0, -slope.y));

  vec3 V = normalize(u_camPos - v_worldPos);
  float NdotV = max(dot(N, V), 0.0);
  float fresnel = 0.03 + 0.97 * pow(1.0 - NdotV, 5.0);

  // ambient + diffuse-ish body color
  vec3 ambient = mix(u_groundColor, u_skyColor, 0.75);
  vec3 body = u_waterColor * (ambient + u_sunColor * max(dot(N, -u_sunDir), 0.0) * 0.4);

  // specular glints from sun + every point light (high shininess = streaks)
  float shin = mix(220.0, 60.0, clamp(1.0 - u_clarity, 0.0, 1.0));
  vec3 spec = u_sunColor * pow(max(dot(N, normalize(-u_sunDir + V)), 0.0), shin);
  for (int i = 0; i < ${MAX_POINT_LIGHTS}; i++) {
    vec3 lc = u_pointColor[i];
    if (lc.r + lc.g + lc.b <= 0.0) continue;
    vec3 lv = u_pointPos[i].xyz - v_worldPos;
    float atten = 1.0 / (1.0 + u_pointPos[i].w * dot(lv, lv));
    vec3 Lp = normalize(lv);
    if (u_pointDir[i].w > -1.0) {
      float ca = dot(-Lp, u_pointDir[i].xyz);
      atten *= smoothstep(u_pointDir[i].w, u_pointDir[i].w + 0.12, ca);
    }
    spec += lc * pow(max(dot(N, normalize(Lp + V)), 0.0), shin) * atten * 2.0;
    body += u_waterColor * lc * max(dot(N, Lp), 0.0) * atten * 0.35;
  }
  // sparkle pops where micro-noise peaks align with the view
  spec *= 1.0 + u_sparkle * smoothstep(0.78, 0.95, vnoise(p * 14.0 + t)) * 2.0;

  // clarity → alpha: clear water is see-through except at grazing fresnel
  float alpha = u_opacity >= 0.0
    ? clamp(u_opacity + fresnel * 0.35, 0.0, 0.97)
    : clamp(mix(0.92, 0.18, u_clarity) + fresnel * 0.7, 0.0, 0.97);
  vec3 color = mix(body, u_skyColor * 1.4, fresnel * 0.5) + spec;

  float dist = length(u_camPos - v_worldPos);
  float fog = 1.0 - exp(-u_fogDensity * u_fogDensity * dist * dist);
  color = mix(color, u_fogColor, clamp(fog, 0.0, 1.0));

  color = color / (color + vec3(1.0));
  float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color = mix(vec3(luma), color, u_gradeSaturation);
  color = pow(max(color, 0.0), vec3(u_gradeContrast));
  if (u_vignette > 0.0) {
    float vd = distance(gl_FragCoord.xy / u_viewport, vec2(0.5));
    color *= 1.0 - u_vignette * smoothstep(0.30, 0.85, vd);
  }
  o_color = vec4(pow(max(color, 0.0), vec3(1.0 / 2.2)), alpha);
}`;

export function createWaterRenderer(gl) {
  let prog = null, u = null, vao = null;
  const surfaces = [];

  function ensure() {
    if (prog) return;
    prog = link(gl);
    u = {};
    const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const inf = gl.getActiveUniform(prog, i);
      u[inf.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(prog, inf.name);
    }
    vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  function add(spec) {
    ensure();
    const s = {
      area: spec.area, level: spec.level ?? 0,
      color: spec.color || [0.16, 0.40, 0.45],
      clarity: spec.clarity ?? 0.6,
      waveScale: spec.waveScale ?? 2.6, waveHeight: spec.waveHeight ?? 0.6,
      waveSpeed: spec.waveSpeed ?? 1, sparkle: spec.sparkle ?? 1,
      flow: spec.flow || [0, 0],
      opacity: spec.opacity ?? -1, // -1 = derive from clarity
    };
    surfaces.push(s);
    return s;
  }

  function remove(s) {
    const i = surfaces.indexOf(s);
    if (i >= 0) surfaces.splice(i, 1);
  }

  // called by renderer.drawFrame after the blend pass, same packed light arrays
  function draw(camera, viewProj, pPos, pColor, pDir, lights, env, time) {
    if (!surfaces.length) return;
    gl.useProgram(prog);
    gl.bindVertexArray(vao);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE); // visible from above AND below
    gl.uniformMatrix4fv(u.u_viewProj, false, viewProj);
    gl.uniform3fv(u.u_camPos, camera.pos);
    setSpatialUniforms(gl, u, env, camera.pos); // SAME deform → water stays glued to its shore
    gl.uniform3fv(u.u_sunDir, lights.sunDir);
    gl.uniform3fv(u.u_sunColor, lights.sunColor);
    gl.uniform3fv(u.u_skyColor, lights.skyColor);
    gl.uniform3fv(u.u_groundColor, lights.groundColor);
    gl.uniform4fv(u.u_pointPos, pPos);
    gl.uniform3fv(u.u_pointColor, pColor);
    gl.uniform4fv(u.u_pointDir, pDir);
    if (env.fog) { gl.uniform3fv(u.u_fogColor, env.fog.color); gl.uniform1f(u.u_fogDensity, env.fog.density); }
    else gl.uniform1f(u.u_fogDensity, 0);
    gl.uniform1f(u.u_gradeContrast, env.grade?.contrast ?? 1);
    gl.uniform1f(u.u_gradeSaturation, env.grade?.saturation ?? 1);
    gl.uniform1f(u.u_vignette, env.grade?.vignette ?? 0);
    gl.uniform2f(u.u_viewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.uniform1f(u.u_time, time);
    for (const s of surfaces) {
      gl.uniform4f(u.u_area, s.area[0], s.area[1], s.area[2], s.area[3]);
      gl.uniform1f(u.u_level, s.level);
      gl.uniform3fv(u.u_waterColor, s.color);
      gl.uniform1f(u.u_clarity, s.clarity);
      gl.uniform1f(u.u_opacity, s.opacity);
      gl.uniform1f(u.u_waveScale, s.waveScale);
      gl.uniform1f(u.u_waveHeight, s.waveHeight);
      gl.uniform1f(u.u_waveSpeed, s.waveSpeed);
      gl.uniform1f(u.u_sparkle, s.sparkle);
      gl.uniform2f(u.u_flow, s.flow[0], s.flow[1]);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.enable(gl.CULL_FACE);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }

  function destroy() { if (prog) gl.deleteProgram(prog); if (vao) gl.deleteVertexArray(vao); surfaces.length = 0; }

  return { add, remove, draw, destroy, surfaces };
}

function link(gl) {
  const mk = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('water: ' + gl.getShaderInfoLog(sh));
    return sh;
  };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('water: link: ' + gl.getProgramInfoLog(p));
  return p;
}
