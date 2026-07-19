// core/gl/animeground.js — ANIME GRASS GROUND. A faithful port of the Unity surface
// shader "FX/BlowingAnimeGrass": the ground albedo gets a moving GRASS×WIND noise added
// to it. Each of the two textures is sampled TWICE (two world-space scales, scrolled at
// different speeds) and the pair is cross-faded by a triangle-wave timer — that hides the
// scroll/tiling and gives the organic "wind blowing over the grass" shimmer. grass*wind
// is then ADDED to the base colour. It's a textured ground, not blades → ONE drawElements,
// trivially low-end friendly. Self-contained GL pass (drawn by renderer.drawFrame).
//
//   gl-scene child (type: 'gl-animegrass', alias 'gl-anime-ground'):
//   { type:'gl-animegrass', area:[x0,z0,x1,z1], level:0,
//     texture:'textures/animegrass-texture.png',   // _GrassTex (noise; RGB, NOT palette)
//     wind:'textures/animegrass-wind.png',          // _WindTex (distortion; defaults to texture)
//     color:[0.2,0.52,0.18], colorFar:[0.55,0.78,0.32],  // terrain albedo near→far gradient
//     fxStrength:0.35,                               // how much grass×wind brightens the grass
//     grassScale:0.4, grass2Scale:1, grassSpeed:1, grassBlendSpeed:0.5,
//     windScale:0.4,  wind2Scale:1,  windSpeed:1,  windBlendSpeed:0.5,
//     hills:1.8, hillScale:0.025 }                   // rolling amount / frequency
//
// TEXTURES MUST BE RGB (colorType 2), not palette/indexed — WebKit's createImageBitmap
// decodes indexed PNGs to black. Pair with a flat collision gl-box at `level` to walk on it.

// rolling-hill geometry comes from the SHARED core/gl/heightfield.js primitive (NOT baked
// here). The VISUAL mesh is baked from the SAME JS heightFn as collision/props (NOT the
// GLSL hgt — GPU vs CPU float precision would diverge), so all three agree exactly.
import { heightFn } from './heightfield.js';
import { SPATIAL_GLSL, setSpatialUniforms } from './spatial.js';

// re-export so callers that imported it from here keep working
export { heightFn as animeHeightFn } from './heightfield.js';

// Geometry is BAKED on the CPU from the shared heightFn (same data as the collision mesh),
// NOT recomputed as noise on the GPU — value-noise's fract() hash differs between 32-bit
// GPU floats and 64-bit JS doubles, so a GPU-computed surface would DIVERGE from the
// CPU collision mesh (you'd walk through / under the visible grass). Baked pos+normal
// attributes guarantee the rendered surface == the walked surface exactly.
const VERT = `#version 300 es
${SPATIAL_GLSL}
layout(location=0) in vec3 a_pos;
layout(location=1) in vec3 a_normal;
uniform mat4 u_viewProj;
out vec3 v_world;
out vec3 v_normal;
void main() {
  v_world = a_pos;
  v_normal = a_normal;
  gl_Position = u_viewProj * vec4(a_pos, 1.0);
  // SAME telephoto deform as the uber-shader, so props stay glued to the ground
  // (the ground mesh is already in world space → worldPos = a_pos).
  gl_Position = pf_applySpatial(gl_Position, a_pos);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec3 v_world;
in vec3 v_normal;
out vec4 o_color;

uniform sampler2D u_grass, u_wind;
uniform vec3 u_camPos, u_sunDir, u_sunColor, u_skyColor, u_groundColor;
uniform vec3 u_fogColor; uniform float u_fogDensity;
uniform float u_gradeContrast, u_gradeSaturation, u_time;
uniform vec3 u_colorNear, u_colorFar;
uniform float u_fxStrength;
uniform float u_grassScale, u_grass2Scale, u_grassSpeed, u_grassBlendSpeed;
uniform float u_windScale, u_wind2Scale, u_windSpeed, u_windBlendSpeed;
// sand bed for basins: blend albedo → sand for LOW ground (a lake/pond floor).
uniform vec3 u_sandColor; uniform float u_sandTop, u_sandBottom, u_sandStrength;

// one "blowing" channel: two world-scaled layers scrolled at different speeds, cross-faded
// by a triangle-wave timer (Unity: abs((0.5-frac(t*blend))/0.5)).
float blow(sampler2D tex, vec2 w, float scale, float scale2, float speed, float blendSpeed) {
  float scroll = u_time * speed * 0.05;                 // _Time.x ≈ t/20 → slow drift
  float blend = abs((0.5 - fract(u_time * blendSpeed)) / 0.5);
  float a = texture(tex, w * (scale / 50.0) + scroll).r;
  float b = texture(tex, w * (scale / 50.0 * scale2) + scroll * scale2).r;
  return mix(a, b, blend);
}

void main() {
  vec2 w = v_world.xz;
  vec3 N = normalize(v_normal);   // baked per-vertex normal (CPU, from the same heightFn)
  float dist = length(u_camPos - v_world);

  // terrain albedo: a green gradient (near deep → far light/yellow), like a sunlit hill
  float gr = clamp(dist / 70.0, 0.0, 1.0);
  vec3 base = mix(u_colorNear, u_colorFar, gr * gr);

  // THE SHADER: grass × wind, both two-layer cross-faded scrolls → added to the albedo
  float grass = blow(u_grass, w, u_grassScale, u_grass2Scale, u_grassSpeed, u_grassBlendSpeed);
  float wind  = blow(u_wind,  w, u_windScale,  u_wind2Scale,  u_windSpeed,  u_windBlendSpeed);
  float grassWind = grass * wind;                       // the moving noise (Unity grassWind.a)
  vec3 albedo = base + grassWind * u_fxStrength;        // o.Albedo = grassWind + c.rgb

  // SAND BED: where the ground dips below u_sandTop (a basin floor), fade the green to
  // sand (full by u_sandBottom). Keeps the grass×wind shimmer faint at the waterline.
  if (u_sandStrength > 0.0) {
    float sandT = (1.0 - smoothstep(u_sandBottom, u_sandTop, v_world.y)) * u_sandStrength;
    albedo = mix(albedo, u_sandColor, clamp(sandT, 0.0, 1.0));
  }

  // flat anime cel lighting (high key, low contrast)
  vec3 hemi = mix(u_groundColor, u_skyColor, clamp(N.y, 0.0, 1.0));
  float ndl = max(dot(N, -u_sunDir), 0.0);
  vec3 color = albedo * (0.72 + 0.28 * hemi) * (0.85 + 0.22 * ndl);

  float fog = 1.0 - exp(-u_fogDensity * u_fogDensity * dist * dist);
  color = mix(color, u_fogColor, clamp(fog, 0.0, 1.0));
  float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color = mix(vec3(luma), color, max(u_gradeSaturation, 1.12));   // anime-vivid
  color = pow(max(color, 0.0), vec3(u_gradeContrast));
  o_color = vec4(pow(max(color, 0.0), vec3(1.0 / 2.2)), 1.0);
}`;

const GRID = 96; // plane subdivisions (smooth hills); ~18k tris, negligible

export function createAnimeGroundRenderer(gl) {
  let prog = null, u = null;
  const grounds = [];

  function ensure() {
    if (prog) return;
    prog = link(gl);
    u = {};
    const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const inf = gl.getActiveUniform(prog, i); u[inf.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(prog, inf.name); }
  }

  // Bake a per-ground mesh from the CPU heightFn: positions (x, heightAt, z), per-vertex
  // normals (central difference of the SAME heightFn), and triangle indices. The collision
  // mesh reuses these exact positions → walked surface == rendered surface, bit for bit.
  function buildMesh(area, heightAt, N) {
    const [x0, z0, x1, z1] = area;
    const W = N + 1, dx = (x1 - x0) / N, dz = (z1 - z0) / N;
    const positions = new Float32Array(W * W * 3);
    const normals = new Float32Array(W * W * 3);
    let o = 0;
    for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) {
      const x = x0 + i * dx, z = z0 + j * dz;
      const y = heightAt(x, z);
      const e = Math.max(dx, dz) * 0.5;
      const hgx = heightAt(x + e, z) - heightAt(x - e, z);
      const hgz = heightAt(x, z + e) - heightAt(x, z - e);
      let nx = -hgx / (2 * e), ny = 1, nz = -hgz / (2 * e);
      const inv = 1 / Math.hypot(nx, ny, nz); nx *= inv; ny *= inv; nz *= inv;
      positions[o] = x; positions[o + 1] = y; positions[o + 2] = z;
      normals[o] = nx; normals[o + 1] = ny; normals[o + 2] = nz;
      o += 3;
    }
    const idx = [];
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const a = j * W + i, b = a + 1, c = a + W, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    return { positions, normals, indices: new Uint32Array(idx) };
  }

  // textures MUST be plain RGB (colorType 2) — createImageBitmap decodes PALETTE PNGs to
  // BLACK in WebKit (de-palette: ffmpeg -i in.png -pix_fmt rgb24 out.png). PREMULTIPLY/FLIP_Y
  // forced off (the engine leaves them on globally → would darken alpha). No mipmaps (NPOT
  // generateMipmap is incomplete in WebKit → samples black); plain LINEAR + REPEAT tiling.
  function loadTex(url) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([128, 160, 110, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    fetch(url).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); }).then((b) => createImageBitmap(b)).then((bm) => {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bm);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }).catch((e) => console.warn('[anime-grass] texture load FAILED:', url, e?.message));
    return tex;
  }

  function add(spec) {
    ensure();
    const tx = spec.texture || 'textures/animegrass-texture.png';
    const g = {
      area: spec.area, level: spec.level ?? 0,
      colorNear: spec.color || spec.colorNear || [0.20, 0.52, 0.18],
      colorFar: spec.colorFar || [0.55, 0.78, 0.32],
      fxStrength: spec.fxStrength ?? 0.35,
      grassScale: spec.grassScale ?? 0.4, grass2Scale: spec.grass2Scale ?? 1, grassSpeed: spec.grassSpeed ?? 1, grassBlendSpeed: spec.grassBlendSpeed ?? 0.5,
      windScale: spec.windScale ?? 0.4, wind2Scale: spec.wind2Scale ?? 1, windSpeed: spec.windSpeed ?? 1, windBlendSpeed: spec.windBlendSpeed ?? 0.5,
      hills: spec.hills ?? 1.8, hillScale: spec.hillScale ?? 0.025,
      grass: loadTex(tx),
      windTex: loadTex(spec.wind || tx),   // distortion; defaults to the grass noise
    };
    // height field → bake the visual mesh + (optional) collision mesh from the SAME data.
    // `basins` carve smooth bowls into BOTH (a lake/pond floor) — applied here in JS so the
    // baked mesh, normals and collision all dip together (no shader change needed).
    //   spec.basins: [{ x, z, radius, depth, rim? }]  rim = flat bottom fraction (0..1)
    const baseH = heightFn({ hills: g.hills, hillScale: g.hillScale, level: g.level });
    const basins = (spec.basins || []).map((b) => ({ x: b.x ?? 0, z: b.z ?? 0, r: Math.max(0.001, b.radius ?? 10), depth: b.depth ?? 2, rim: b.rim ?? 0 }));
    g.heightAt = basins.length ? (x, z) => {
      let y = baseH(x, z);
      for (const b of basins) {
        const d = Math.hypot(x - b.x, z - b.z);
        if (d >= b.r) continue;
        let t = 1 - d / b.r;                                  // 0 at rim → 1 at center
        if (b.rim > 0) t = Math.min(1, t / (1 - b.rim));      // flatten the central floor
        y -= b.depth * (t * t * (3 - 2 * t));                 // smoothstep bowl
      }
      return y;
    } : baseH;
    // sand bed params for the FRAG (default band = just under the surface down to the floor)
    g.sandColor = spec.sandColor || null;
    const deepest = basins.reduce((m, b) => Math.max(m, b.depth), 0);
    g.sandTop = spec.sandTop ?? (g.level - 0.3);
    g.sandBottom = spec.sandBottom ?? (g.level - Math.max(0.8, deepest * 0.65));
    const mesh = buildMesh(g.area, g.heightAt, GRID);
    g.indexCount = mesh.indices.length;
    g.vao = gl.createVertexArray();
    gl.bindVertexArray(g.vao);
    const pb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, pb); gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    const nb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, nb); gl.bufferData(gl.ARRAY_BUFFER, mesh.normals, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    g.buffers = [pb, nb, ib];
    // collision reuses the EXACT baked positions → walked surface == rendered surface
    if (spec.collision) g.collisionMesh = { positions: mesh.positions, indices: mesh.indices, world: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) };
    grounds.push(g);
    return g;
  }
  function freeGround(g) { gl.deleteTexture(g.grass); gl.deleteTexture(g.windTex); if (g.vao) gl.deleteVertexArray(g.vao); (g.buffers || []).forEach((b) => gl.deleteBuffer(b)); }
  function remove(g) { const i = grounds.indexOf(g); if (i >= 0) { freeGround(g); grounds.splice(i, 1); } }

  // drawn with the opaque pass (depth-written) — it's solid ground
  function draw(camera, viewProj, lights, env, time) {
    if (!grounds.length) return;
    gl.useProgram(prog);
    gl.disable(gl.CULL_FACE); // ground viewed from above; don't let winding cull it
    gl.uniformMatrix4fv(u.u_viewProj, false, viewProj);
    gl.uniform3fv(u.u_camPos, camera.pos);
    setSpatialUniforms(gl, u, env, camera.pos); // SAME deform as props → ground stays glued
    gl.uniform3fv(u.u_sunDir, lights.sunDir);
    gl.uniform3fv(u.u_sunColor, lights.sunColor);
    gl.uniform3fv(u.u_skyColor, lights.skyColor);
    gl.uniform3fv(u.u_groundColor, lights.groundColor);
    if (env.fog) { gl.uniform3fv(u.u_fogColor, env.fog.color); gl.uniform1f(u.u_fogDensity, env.fog.density); }
    else gl.uniform1f(u.u_fogDensity, 0);
    gl.uniform1f(u.u_gradeContrast, env.grade?.contrast ?? 1);
    gl.uniform1f(u.u_gradeSaturation, env.grade?.saturation ?? 1);
    gl.uniform1f(u.u_time, time);
    gl.uniform1i(u.u_grass, 2);
    gl.uniform1i(u.u_wind, 3);
    for (const g of grounds) {
      gl.bindVertexArray(g.vao);
      gl.uniform3fv(u.u_colorNear, g.colorNear);
      gl.uniform3fv(u.u_colorFar, g.colorFar);
      gl.uniform1f(u.u_fxStrength, g.fxStrength);
      gl.uniform1f(u.u_grassScale, g.grassScale); gl.uniform1f(u.u_grass2Scale, g.grass2Scale);
      gl.uniform1f(u.u_grassSpeed, g.grassSpeed); gl.uniform1f(u.u_grassBlendSpeed, g.grassBlendSpeed);
      gl.uniform1f(u.u_windScale, g.windScale); gl.uniform1f(u.u_wind2Scale, g.wind2Scale);
      gl.uniform1f(u.u_windSpeed, g.windSpeed); gl.uniform1f(u.u_windBlendSpeed, g.windBlendSpeed);
      if (g.sandColor) { gl.uniform3fv(u.u_sandColor, g.sandColor); gl.uniform1f(u.u_sandTop, g.sandTop); gl.uniform1f(u.u_sandBottom, g.sandBottom); gl.uniform1f(u.u_sandStrength, 1); }
      else gl.uniform1f(u.u_sandStrength, 0);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, g.grass);
      gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, g.windTex);
      gl.drawElements(gl.TRIANGLES, g.indexCount, gl.UNSIGNED_INT, 0);
    }
    gl.enable(gl.CULL_FACE);
    gl.bindVertexArray(null);
  }

  function destroy() {
    for (const g of grounds) freeGround(g);
    if (prog) gl.deleteProgram(prog);
    grounds.length = 0;
  }

  return { add, remove, draw, destroy, grounds };
}

function link(gl) {
  const mk = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('anime-grass: ' + gl.getShaderInfoLog(sh));
    return sh;
  };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('anime-grass: link: ' + gl.getProgramInfoLog(p));
  return p;
}
