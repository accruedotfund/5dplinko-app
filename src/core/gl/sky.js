// core/gl/sky.js — procedural skybox pass. A fullscreen triangle drawn at
// depth≈1 AFTER the opaque pass (LEQUAL, depth-write off) — it only fills
// pixels nothing else covered, so indoor scenes never see it and a doorway to
// "outside" frames it for free. Per-pixel view ray from the inverse viewProj.
//
//   sky: { zenith: [r,g,b], horizon: [r,g,b], clouds: 0..1, cloudScale: 1,
//          wind: 0.6, sunSize: 600 }   // sun dir/color come from the scene sun
//
// Gradient + sun disc/halo + two-octave drifting value-noise clouds, run
// through the same grade/gamma as the rest of the frame.

export const SKY_DEFAULTS = {
  zenith: [0.22, 0.45, 0.85], horizon: [0.72, 0.82, 0.92],
  clouds: 0.55, cloudScale: 1, wind: 0.5, sunSize: 700,
};

const VERT = `#version 300 es
out vec2 v_ndc;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2) * 2.0 - 1.0;
  v_ndc = p;
  gl_Position = vec4(p, 0.99999, 1.0); // as far as the depth buffer allows
}`;

const FRAG = `#version 300 es
precision mediump float;
in vec2 v_ndc;
out vec4 o_color;
uniform mat4 u_invViewProj;
uniform vec3 u_camPos;
uniform vec3 u_sunDir, u_sunColor;
uniform vec3 u_zenith, u_horizon, u_fogColor;
uniform float u_clouds, u_cloudScale, u_wind, u_sunSize, u_time;
uniform float u_gradeContrast, u_gradeSaturation, u_vignette;
uniform vec2 u_viewport;
uniform sampler2D u_skyTex;          // equirectangular sky photo (sRGB)
uniform float u_useSkyTex, u_skyRot; // u_useSkyTex>0.5 → sample the photo instead of procedural

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}

void main() {
  vec4 wp = u_invViewProj * vec4(v_ndc, 1.0, 1.0);
  vec3 dir = normalize(wp.xyz / wp.w - u_camPos);

  // IMAGE skybox: sample an equirectangular photo by the view-ray direction (lat/long).
  // u wraps around the horizon (atan), v = 0 at the zenith → top row of the image.
  if (u_useSkyTex > 0.5) {
    float uu = atan(dir.z, dir.x) * 0.15915494 + 0.5 + u_skyRot;
    float vv = acos(clamp(dir.y, -1.0, 1.0)) * 0.31830989;
    vec2 uv = vec2(uu, vv);
    // SEAM FIX: at the atan() wrap, du jumps ~1 across one pixel → auto-LOD picks the coarsest
    // (blurry) mip → a vertical seam line. Sample with textureGrad using UNWRAPPED derivatives.
    vec2 dx = dFdx(uv), dy = dFdy(uv);
    dx.x = fract(dx.x + 0.5) - 0.5;
    dy.x = fract(dy.x + 0.5) - 0.5;
    vec3 t = textureGrad(u_skyTex, uv, dx, dy).rgb;      // sRGB sampler → linear
    float lm = dot(t, vec3(0.2126, 0.7152, 0.0722));     // same grade as the procedural path
    t = mix(vec3(lm), t, u_gradeSaturation);
    t = pow(max(t, 0.0), vec3(u_gradeContrast));
    if (u_vignette > 0.0) {
      float vd2 = distance(gl_FragCoord.xy / u_viewport, vec2(0.5));
      t *= 1.0 - u_vignette * smoothstep(0.30, 0.85, vd2);
    }
    o_color = vec4(pow(max(t, 0.0), vec3(1.0 / 2.2)), 1.0);
    return;
  }

  float up = clamp(dir.y, 0.0, 1.0);
  vec3 color = mix(u_horizon, u_zenith, pow(up, 0.55));
  // below the horizon fade into fog (ground haze)
  if (dir.y < 0.0) color = mix(u_horizon, u_fogColor, clamp(-dir.y * 6.0, 0.0, 1.0));

  // sun disc + halo
  float sd = max(dot(dir, -u_sunDir), 0.0);
  color += u_sunColor * (pow(sd, u_sunSize) * 1.6 + pow(sd, 24.0) * 0.10);

  // clouds: project the upper dome onto a plane, two drifting noise octaves
  if (dir.y > 0.02 && u_clouds > 0.0) {
    vec2 cp = dir.xz / (dir.y + 0.18) * 1.6 * u_cloudScale + vec2(u_time * 0.013, u_time * 0.004) * u_wind * 10.0;
    float n = vnoise(cp) * 0.62 + vnoise(cp * 2.7 + 13.1) * 0.38;
    float cov = smoothstep(1.0 - u_clouds * 0.62, 1.06 - u_clouds * 0.5, n);
    vec3 cloudCol = mix(vec3(0.98), u_horizon * 0.7 + vec3(0.22), 0.35);
    color = mix(color, cloudCol, cov * smoothstep(0.02, 0.16, dir.y) * 0.92);
  }

  color = color / (color + vec3(1.0));
  float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color = mix(vec3(luma), color, u_gradeSaturation);
  color = pow(max(color, 0.0), vec3(u_gradeContrast));
  if (u_vignette > 0.0) {
    float vd = distance(gl_FragCoord.xy / u_viewport, vec2(0.5));
    color *= 1.0 - u_vignette * smoothstep(0.30, 0.85, vd);
  }
  o_color = vec4(pow(max(color, 0.0), vec3(1.0 / 2.2)), 1.0);
}`;

export function createSkyRenderer(gl) {
  let prog = null, u = null, vao = null, sky = null, skyTex = null;

  function setSky(spec) {
    sky = spec ? { ...SKY_DEFAULTS, ...spec } : null;
    if (sky && !prog) {
      prog = link(gl);
      u = {};
      const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) {
        const inf = gl.getActiveUniform(prog, i);
        u[inf.name] = gl.getUniformLocation(prog, inf.name);
      }
      vao = gl.createVertexArray();
    }
  }

  // attach a loaded equirectangular sky texture (gl-scene creates it via createTexture with
  // sRGB + wrapS:REPEAT/wrapT:CLAMP). Pass null to drop back to the procedural sky.
  function setTexture(tex) { skyTex = tex || null; if (skyTex && !prog) setSky({}); }

  function draw(camera, invViewProj, lights, env, time) {
    if (!sky) return;
    gl.useProgram(prog);
    gl.bindVertexArray(vao);
    gl.depthMask(false);
    gl.uniformMatrix4fv(u.u_invViewProj, false, invViewProj);
    gl.uniform3fv(u.u_camPos, camera.pos);
    gl.uniform3fv(u.u_sunDir, lights.sunDir);
    gl.uniform3fv(u.u_sunColor, lights.sunColor);
    gl.uniform3fv(u.u_zenith, sky.zenith);
    gl.uniform3fv(u.u_horizon, sky.horizon);
    gl.uniform3fv(u.u_fogColor, env.fog ? env.fog.color : sky.horizon);
    gl.uniform1f(u.u_clouds, sky.clouds);
    gl.uniform1f(u.u_cloudScale, sky.cloudScale);
    gl.uniform1f(u.u_wind, sky.wind);
    gl.uniform1f(u.u_sunSize, sky.sunSize);
    gl.uniform1f(u.u_time, time);
    gl.uniform1f(u.u_gradeContrast, env.grade?.contrast ?? 1);
    gl.uniform1f(u.u_gradeSaturation, env.grade?.saturation ?? 1);
    gl.uniform1f(u.u_vignette, env.grade?.vignette ?? 0);
    gl.uniform2f(u.u_viewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.uniform1f(u.u_useSkyTex, skyTex ? 1 : 0);
    gl.uniform1f(u.u_skyRot, (sky.rotation || 0) / 360);  // horizontal alignment, in degrees
    if (skyTex) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, skyTex); gl.uniform1i(u.u_skyTex, 0); }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.depthMask(true);
    gl.bindVertexArray(null);
  }

  function destroy() { if (prog) gl.deleteProgram(prog); if (vao) gl.deleteVertexArray(vao); }

  return { setSky, setTexture, draw, destroy, get active() { return !!sky; } };
}

function link(gl) {
  const mk = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('sky: ' + gl.getShaderInfoLog(sh));
    return sh;
  };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('sky: link: ' + gl.getProgramInfoLog(p));
  return p;
}
