// core/gl/post.js — post-processing pipeline: scene renders into an offscreen
// RGBA8 framebuffer (WebKit-safe — no float targets), then a CHAIN of effect
// passes ping-pongs to the screen. Effects are data, not code forks:
//
//   const chain = createPostChain(gl, [
//     { effect: 'vhs',    wobble: 0.0016, grain: 0.10, bleed: 1.4 },
//     { effect: 'glitch', interval: [3, 9], duration: 0.25, strength: 1 },
//   ]);
//   // per frame:  chain.begin(); <draw scene>; chain.end(timeSeconds);
//   chain.resize(w, h);  chain.destroy();
//
// Each registered effect = { frag, defaults, update? }.
//   frag      — fragment source; gets u_tex/u_time/u_res + one uniform per param
//   defaults  — param name → default value (number | [x,y] | [x,y,z])
//   update    — (state, time, params) → param overrides (for time-driven params
//               like glitch bursts; state is a per-instance scratch object)
// Add new effects with registerEffect(name, def) — no pipeline changes needed.

const VERT = `#version 300 es
out vec2 v_uv;
void main() {
  // fullscreen triangle from gl_VertexID — no buffers needed
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAG_HEADER = `#version 300 es
precision mediump float;
in vec2 v_uv;
out vec4 o_color;
uniform sampler2D u_tex;
uniform float u_time;
uniform vec2 u_res;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
`;

const EFFECTS = {};

export function registerEffect(name, def) { EFFECTS[name] = def; }

// ── built-in: VHS tape ───────────────────────────────────────────────────────
registerEffect('vhs', {
  defaults: { wobble: 0.0006, grain: 0.08, bleed: 1.2, scanline: 0.12, tint: 0.06, tracking: 0.5 },
  frag: `
uniform float u_wobble, u_grain, u_bleed, u_scanline, u_tint, u_tracking;
void main() {
  vec2 uv = v_uv;
  // tape wobble: slow whole-frame sway only — high-frequency per-line sin turns
  // straight vertical edges into a sawtooth, which reads as "curvy walls"
  uv.x += sin(uv.y * 3.1 - u_time * 1.3) * u_wobble
        + sin(u_time * 0.7) * u_wobble * 0.5;
  // tracking band: a noisy displaced strip that crawls up the frame
  float band = fract(u_time * 0.11);
  float inBand = smoothstep(0.012, 0.0, abs(uv.y - band)) * u_tracking;
  uv.x += (hash(vec2(floor(uv.y * 90.0), floor(u_time * 24.0))) - 0.5) * 0.12 * inBand;
  // chroma bleed: R and B sampled offset (composite-video fringing)
  float off = u_bleed / u_res.x;
  vec3 c;
  c.r = texture(u_tex, uv + vec2(off, 0.0)).r;
  c.g = texture(u_tex, uv).g;
  c.b = texture(u_tex, uv - vec2(off, 0.0)).b;
  // scanlines + grain + band brightening
  c *= 1.0 - u_scanline * (0.5 + 0.5 * sin(uv.y * u_res.y * 3.14159));
  c += (hash(uv * vec2(u_time * 60.0, u_time * 31.0)) - 0.5) * u_grain;
  c += inBand * 0.25;
  // tape head noise strip at the very bottom
  if (uv.y > 0.985) c = mix(c, vec3(hash(vec2(uv.x * 200.0, u_time * 50.0))), 0.6);
  // slight green-ish cast + soft clamp like crushed tape blacks
  c = mix(c, c * vec3(0.92, 1.04, 0.92), u_tint * 10.0 * 0.1);
  c = max(c, vec3(0.02));
  o_color = vec4(c, 1.0);
}`,
});

// ── built-in: bloom — bright pixels halo outward (fixture glow) ──────────────
registerEffect('bloom', {
  defaults: { threshold: 0.6, strength: 1.4, radius: 12 },
  frag: `
uniform float u_threshold, u_strength, u_radius;
void main() {
  vec3 src = texture(u_tex, v_uv).rgb;
  // sparse spiral gather of above-threshold neighbors
  vec3 acc = vec3(0.0);
  const int N = 12;
  for (int i = 0; i < N; i++) {
    float a = float(i) * 2.39996;                 // golden-angle spiral
    float r = sqrt(float(i) / float(N)) * u_radius;
    vec2 off = vec2(cos(a), sin(a)) * r / u_res;
    vec3 s = texture(u_tex, v_uv + off).rgb;
    acc += max(s - vec3(u_threshold), 0.0);
  }
  o_color = vec4(src + acc / float(N) * u_strength, 1.0);
}`,
});

// ── built-in: godrays — radial crepuscular streaks from the sun's screen pos ──
// gl-scene drives `center` ([u,v]) + `intensity` per frame via chain.setParam
// (intensity 0 when the sun is off-screen/behind — the pass copies through).
registerEffect('godrays', {
  defaults: { center: [0.5, 0.5], intensity: 0, threshold: 0.55, decay: 0.94, strength: 0.9 },
  frag: `
uniform vec2 u_center;
uniform float u_intensity, u_threshold, u_decay, u_strength;
void main() {
  vec3 src = texture(u_tex, v_uv).rgb;
  if (u_intensity <= 0.0) { o_color = vec4(src, 1.0); return; }
  vec2 delta = (u_center - v_uv) / 28.0;
  vec2 uv = v_uv;
  vec3 acc = vec3(0.0);
  float w = 1.0;
  for (int i = 0; i < 28; i++) {
    uv += delta;
    acc += max(texture(u_tex, uv).rgb - vec3(u_threshold), 0.0) * w;
    w *= u_decay;
  }
  o_color = vec4(src + acc / 28.0 * u_strength * u_intensity, 1.0);
}`,
});

// ── built-in: intermittent glitch bursts ─────────────────────────────────────
registerEffect('glitch', {
  defaults: { amount: 0, strength: 1, interval: [3, 9], duration: 0.25 },
  // JS-side scheduler: amount snaps to `strength` for `duration`s every
  // interval[0]..interval[1] seconds, else 0 (pass-through copy)
  update(state, time, params) {
    if (state.nextAt === undefined) state.nextAt = time + 1.5;
    if (time >= state.nextAt) {
      state.until = time + (params.duration ?? 0.25);
      const [a, b] = params.interval ?? [3, 9];
      state.nextAt = time + a + Math.random() * (b - a);
    }
    return { amount: time < (state.until ?? 0) ? (params.strength ?? 1) : 0 };
  },
  frag: `
uniform float u_amount, u_strength;
uniform vec2 u_interval;
uniform float u_duration;
void main() {
  if (u_amount <= 0.0) { o_color = texture(u_tex, v_uv); return; }
  vec2 uv = v_uv;
  // horizontal slice displacement, re-rolled several times per burst
  float t = floor(u_time * 18.0);
  float slice = floor(uv.y * (6.0 + hash(vec2(t, 1.0)) * 10.0));
  float shift = (hash(vec2(slice, t)) - 0.5) * 0.22 * u_amount;
  if (hash(vec2(slice, t + 7.0)) > 0.55) uv.x = fract(uv.x + shift);
  // hard RGB split + occasional full-frame jump
  float off = 4.0 * u_amount / u_res.x * (1.0 + hash(vec2(t, 3.0)) * 4.0);
  uv.y = fract(uv.y + (hash(vec2(t, 5.0)) > 0.92 ? 0.05 * u_amount : 0.0));
  vec3 c;
  c.r = texture(u_tex, uv + vec2(off, 0.0)).r;
  c.g = texture(u_tex, fract(uv + vec2(0.0, off * 0.5))).g;
  c.b = texture(u_tex, uv - vec2(off, 0.0)).b;
  // blocky luma noise
  vec2 cell = floor(uv * vec2(48.0, 28.0));
  if (hash(cell + t) > 0.93) c += (hash(cell + t + 2.0) - 0.3) * 0.5 * u_amount;
  o_color = vec4(c, 1.0);
}`,
});

// ── built-in: PSX — retro PlayStation-1 look ─────────────────────────────────
// Low internal resolution (pixelation), reduced colour depth (15-bit-ish), and
// ordered (Bayer) dithering — the three signature PS1 framebuffer traits. Pair
// with heavy fog + (optionally) gl-scene vertexSnap for the full effect.
//   { effect:'psx', resolution: 320, levels: 32, dither: 1.0, scanline: 0.0 }
//     resolution — virtual horizontal pixels (lower = chunkier; 256–384 typical)
//     levels     — colour steps per channel (32 = 5-bit ≈ PS1's 15-bit RGB)
//     dither     — ordered-dither strength (0..1.5)
registerEffect('psx', {
  defaults: { resolution: 320, levels: 32.0, dither: 1.0, scanline: 0.0 },
  frag: `
uniform float u_resolution, u_levels, u_dither, u_scanline;
// 4x4 ordered Bayer in [0,1) via nested 2x2 (compact, no LUT)
float bayer2(vec2 a){ a = floor(a); return fract(a.x * 0.5 + a.y * a.y * 0.75); }
float bayer4(vec2 a){ return bayer2(0.5 * a) * 0.25 + bayer2(a); }
void main() {
  // pixelate to a virtual low-res grid (keeps aspect via u_res ratio)
  vec2 grid = vec2(u_resolution, u_resolution * u_res.y / u_res.x);
  vec2 luv = (floor(v_uv * grid) + 0.5) / grid;
  vec3 c = texture(u_tex, luv).rgb;
  // ordered dither nudges colour before quantization → smooth gradients band cleanly
  float d = (bayer4(v_uv * grid) - 0.5) * u_dither / u_levels;
  c = floor(c * u_levels + 0.5 + d) / u_levels;
  // optional faint scanline darkening on odd virtual rows
  if (u_scanline > 0.0) c *= 1.0 - u_scanline * step(0.5, fract(floor(v_uv.y * grid.y) * 0.5));
  o_color = vec4(c, 1.0);
}`,
});

// ── built-in: SPATIAL COMPRESSION — intra-frame (JPEG/MPEG-I) block artifacts ─
// Simulates LOW-BITRATE spatial compression: the frame is split into macroblocks,
// chroma (colour) is subsampled to a coarser block grid than luma (4:2:0-style → the
// signature colour "bleed"/blockiness), each block is pulled toward its average (DC,
// the flat-block look) and the result is quantized in YCbCr (banding + posterized
// colour). Distinct from `psx` (that's pixel-grid + global colour depth); this is
// block-based and colour-subsampled, the look of a heavily-compressed video frame.
//   { effect:'compress', block:8, chroma:2, quality:0.4 }
//     block   — luma macroblock size in px (8 = classic DCT block)
//     chroma  — chroma block = block*chroma (2 → 16px colour blocks; higher = blockier colour)
//     quality — 0..1 (lower = stronger DC pull + coarser quantization = more artifacts)
registerEffect('compress', {
  defaults: { block: 8.0, chroma: 2.0, quality: 0.4 },
  frag: `
uniform float u_block, u_chroma, u_quality;
vec3 rgb2ycc(vec3 c){ return vec3(dot(c, vec3(0.299, 0.587, 0.114)), 0.5 + dot(c, vec3(-0.168736, -0.331264, 0.5)), 0.5 + dot(c, vec3(0.5, -0.418688, -0.081312))); }
vec3 ycc2rgb(vec3 y){ float Y = y.x, Cb = y.y - 0.5, Cr = y.z - 0.5; return vec3(Y + 1.402 * Cr, Y - 0.344136 * Cb - 0.714136 * Cr, Y + 1.772 * Cb); }
// average a block by 4 taps at its quarter points → cheap DC estimate
vec3 blockAvg(vec2 uv, vec2 bpx) {
  vec2 o = (floor(uv / bpx)) * bpx;        // block origin (uv)
  vec3 s = texture(u_tex, o + bpx * 0.25).rgb + texture(u_tex, o + bpx * vec2(0.75, 0.25)).rgb
         + texture(u_tex, o + bpx * vec2(0.25, 0.75)).rgb + texture(u_tex, o + bpx * 0.75).rgb;
  return s * 0.25;
}
void main() {
  vec2 bpx = u_block / u_res;               // luma block size in uv
  vec2 cpx = bpx * u_chroma;                // chroma block (subsampled coarser)
  vec3 px = rgb2ycc(texture(u_tex, v_uv).rgb);
  vec3 lumaDC = rgb2ycc(blockAvg(v_uv, bpx));
  vec3 chromaDC = rgb2ycc(blockAvg(v_uv, cpx));
  // luma: blend toward the block average (DC) by how lossy we are; keep some detail
  float dc = 0.35 + 0.55 * (1.0 - u_quality);
  float Y = mix(px.x, lumaDC.x, dc);
  // chroma comes from the COARSER block (subsampling) — the colour-bleed signature
  vec2 C = mix(px.yz, chromaDC.yz, 0.7 + 0.3 * (1.0 - u_quality));
  // quantize (the DCT coefficient quantization → banding)
  float qY = mix(48.0, 7.0, 1.0 - u_quality), qC = mix(24.0, 4.0, 1.0 - u_quality);
  Y = floor(Y * qY + 0.5) / qY;
  C = floor(C * qC + 0.5) / qC;
  o_color = vec4(clamp(ycc2rgb(vec3(Y, C)), 0.0, 1.0), 1.0);
}`,
});

// ── built-in: VOLUMETRIC FOG — raymarched, depth-aware, with sun shafts ──────
// Reconstructs world position from the scene DEPTH texture, marches camera→surface
// accumulating height-based fog density (pools low, thins upward) modulated by
// animated 3D noise (wisps), and adds forward-scattering toward the sun so the
// fog visibly GLOWS into light shafts. Real volumetric look, not a colour blend.
//   { effect:'volfog', density:0.06, height:6, scatter:0.6, maxdist:90, noise:0.6 }
// Optional PNG DENSITY TEXTURE (fogTex = a WebGLTexture, e.g. a tiling noise/cloud
// map): sampled on the world XZ plane as two counter-scrolling octaves (r×a — works
// for grayscale noise AND white-on-transparent alpha masks) and multiplied into the
// density, so fog shape/patchiness becomes an ART asset. texAmount 0 (default) = off.
// `col` overrides the scene fog colour for THIS pass (r<0 sentinel = use scene's).
// Optional VOLUME BOUND (boxMin/boxMax world AABB, e.g. a gl-region's box): density
// is clamped to the box with a `boxFeather`-unit soft edge, and the height falloff
// re-bases to the box FLOOR — a fog volume that lives in one room, not the world.
// Sentinel min==max (default zeros) = unbounded.
registerEffect('volfog', {
  defaults: {
    density: 0.06, height: 6.0, scatter: 0.6, maxdist: 90.0, noise: 0.6, wind: 0.05,
    scatterColor: [1.0, 0.95, 0.82], col: [-1, -1, -1],
    fogTex: null, texAmount: 0.0, texScale: 0.02, texWind: [0.03, 0.01],
    boxMin: [0, 0, 0], boxMax: [0, 0, 0], boxFeather: 1.5,
  },
  frag: `
uniform sampler2D u_depth, u_fogTex;
uniform mat4 u_invViewProj;
uniform vec3 u_camPos, u_sunDir, u_fogColor, u_scatterColor, u_col, u_boxMin, u_boxMax;
uniform float u_density, u_height, u_scatter, u_maxdist, u_noise, u_wind, u_texAmount, u_texScale, u_boxFeather;
uniform vec2 u_texWind;
float h3(vec3 p){ return fract(sin(dot(p, vec3(127.1,311.7,74.7))) * 43758.5453); }
float vnoise(vec3 p){
  vec3 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(mix(h3(i),               h3(i+vec3(1,0,0)), f.x),
                 mix(h3(i+vec3(0,1,0)),   h3(i+vec3(1,1,0)), f.x), f.y),
             mix(mix(h3(i+vec3(0,0,1)),   h3(i+vec3(1,0,1)), f.x),
                 mix(h3(i+vec3(0,1,1)),   h3(i+vec3(1,1,1)), f.x), f.y), f.z);
}
void main(){
  vec3 scene = texture(u_tex, v_uv).rgb;
  float d = texture(u_depth, v_uv).r;
  vec4 ndc = vec4(v_uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec4 wp = u_invViewProj * ndc; wp /= wp.w;
  vec3 ro = u_camPos, rd = wp.xyz - ro;
  float dist = min(length(rd), u_maxdist); rd = normalize(rd);
  const int N = 24;
  float stepLen = dist / float(N);
  float jitter = h3(vec3(v_uv * u_res, u_time));   // per-pixel start offset → no banding
  float sun = max(dot(rd, -normalize(u_sunDir)), 0.0);
  float phase = pow(sun, 8.0);                      // forward scatter (god-ray cone)
  float fog = 0.0, scat = 0.0;
  bool boxed = any(greaterThan(u_boxMax, u_boxMin));
  float hBase = boxed ? u_boxMin.y : 0.0;                           // pool from the box floor
  for (int i = 0; i < N; i++) {
    vec3 p = ro + rd * (stepLen * (float(i) + jitter));
    float hd = exp(-max(p.y - hBase, 0.0) / max(u_height, 0.1));    // height falloff
    float wn = mix(1.0, vnoise(p * 0.12 + vec3(u_time * u_wind, u_time * 0.03, 0.0)) * 1.6, u_noise);
    if (u_texAmount > 0.0) {                                        // PNG density map (XZ-projected)
      vec2 tuv = p.xz * u_texScale + u_texWind * u_time;
      vec4 t1 = texture(u_fogTex, tuv);
      vec4 t2 = texture(u_fogTex, tuv * 0.531 - u_texWind * u_time * 1.7 + 0.37);
      float tex = t1.r * t1.a * 0.9 + t2.r * t2.a * 0.9;            // two drifting octaves
      wn *= mix(1.0, tex * 1.35, u_texAmount);
    }
    float dens = u_density * hd * wn;
    if (boxed) {                                                    // clamp to the volume, soft faces
      vec3 de = min(p - u_boxMin, u_boxMax - p);
      dens *= clamp(min(min(de.x, de.y), de.z) / max(u_boxFeather, 0.01), 0.0, 1.0);
    }
    fog += dens * stepLen;
    scat += dens * stepLen * phase;
  }
  fog = 1.0 - exp(-fog);
  vec3 base = (u_col.r < 0.0) ? u_fogColor : u_col;                 // per-pass tint override
  vec3 fogCol = base + u_scatterColor * scat * u_scatter;           // light-coloured shafts
  o_color = vec4(mix(scene, fogCol, clamp(fog, 0.0, 1.0)), 1.0);
}`,
});

// ── built-in: SSAO — screen-space ambient occlusion (contact shadows) ─────────
// Reconstructs world position + geometric normal from the scene DEPTH, samples a spiral
// of neighbours, and darkens where nearby geometry sits ABOVE the surface plane within
// `radius` — the "grounded/AAA" cue (crevices, contact between props). Depth-only (no
// G-buffer). Sample ring shrinks with view distance → ~constant world radius.
//   { effect:'ssao', radius:1.0, strength:1.4, bias:0.025, samples:16 }
registerEffect('ssao', {
  defaults: { radius: 1.0, strength: 1.4, bias: 0.025 },
  frag: `
uniform sampler2D u_depth;
uniform mat4 u_invViewProj;
uniform vec3 u_camPos;
uniform float u_radius, u_strength, u_bias;
float aoh(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
vec3 aoWp(vec2 uv, float d){ vec4 n = vec4(uv*2.0-1.0, d*2.0-1.0, 1.0); vec4 w = u_invViewProj * n; return w.xyz / w.w; }
void main(){
  vec3 scene = texture(u_tex, v_uv).rgb;
  float d = texture(u_depth, v_uv).r;
  if (d >= 1.0) { o_color = vec4(scene, 1.0); return; }   // skybox / no geometry
  vec3 P = aoWp(v_uv, d);
  vec3 Nrm = normalize(cross(dFdx(P), dFdy(P)));
  float dist = length(P - u_camPos);
  float sr = clamp(u_radius / max(dist, 0.5) * 0.55, 0.004, 0.09);   // screen ring ≈ constant world radius
  const int N = 16;
  float a0 = aoh(v_uv * u_res) * 6.2831853;
  float occ = 0.0;
  for (int i = 0; i < N; i++) {
    float t = (float(i) + 0.5) / float(N);
    float a = a0 + t * 6.2831853 * 3.0;                    // 3 spiral turns
    vec2 uv = v_uv + vec2(cos(a), sin(a)) * sr * t;
    float dn = texture(u_depth, uv).r;
    if (dn >= 1.0) continue;
    vec3 Q = aoWp(uv, dn);
    vec3 dv = Q - P; float dl = length(dv);
    if (dl < 1e-4 || dl > u_radius) continue;
    float ndv = dot(Nrm, dv / dl);
    if (ndv > u_bias) occ += (ndv - u_bias) * (1.0 - dl / u_radius);  // above-surface + near = occluded
  }
  float ao = 1.0 - clamp(occ / float(N) * u_strength, 0.0, 1.0);
  o_color = vec4(scene * ao, 1.0);
}`,
});

// ── built-in: DOF — depth-of-field (focus + bokeh disc blur) ─────────────────
// Circle-of-confusion from |worldDist − focus|/range → a spiral disc blur that grows
// out of focus. Cheap single-pass. `{ focus:8, range:12, maxblur:22 }` (focus/range world m).
registerEffect('dof', {
  defaults: { focus: 8.0, range: 12.0, maxblur: 22.0 },
  frag: `
uniform sampler2D u_depth;
uniform mat4 u_invViewProj;
uniform vec3 u_camPos;
uniform float u_focus, u_range, u_maxblur;
void main(){
  float d = texture(u_depth, v_uv).r;
  vec3 col = texture(u_tex, v_uv).rgb;
  if (d >= 1.0) { o_color = vec4(col, 1.0); return; }
  vec4 n = vec4(v_uv*2.0-1.0, d*2.0-1.0, 1.0); vec4 w = u_invViewProj * n;
  float dist = length(w.xyz / w.w - u_camPos);
  float coc = clamp(abs(dist - u_focus) / max(u_range, 0.01), 0.0, 1.0) * u_maxblur;
  if (coc < 0.5) { o_color = vec4(col, 1.0); return; }
  vec3 sum = col; float wsum = 1.0;
  const int N = 24;
  for (int i = 0; i < N; i++){
    float a = float(i) * 2.3999632;                 // golden-angle spiral disc
    float r = sqrt((float(i)+0.5)/float(N)) * coc;
    vec2 off = vec2(cos(a), sin(a)) * r / u_res;
    sum += texture(u_tex, v_uv + off).rgb; wsum += 1.0;
  }
  o_color = vec4(sum / wsum, 1.0);
}`,
});

// ── built-in: COLORGRADE — procedural cinematic grade (no LUT texture needed) ─
// Lift/gamma/gain (shadows/mids/highlights, ASC-CDL-ish) + temperature/tint + saturation
// + contrast + a filmic knee. The "film LUT" look as data.
//   { effect:'colorgrade', lift:[0,0,0.02], gamma:[1,1,1], gain:[1.05,1,0.95],
//     temp:0.1, tint:0, sat:1.1, contrast:1.08, filmic:0.3 }
registerEffect('colorgrade', {
  defaults: { lift: [0, 0, 0], gamma: [1, 1, 1], gain: [1, 1, 1], temp: 0, tint: 0, sat: 1, contrast: 1, filmic: 0 },
  frag: `
uniform vec3 u_lift, u_gamma, u_gain;
uniform float u_temp, u_tint, u_sat, u_contrast, u_filmic;
void main(){
  vec3 c = texture(u_tex, v_uv).rgb;
  c *= vec3(1.0 + u_temp*0.12, 1.0 + u_tint*0.06, 1.0 - u_temp*0.12);   // temperature / tint
  c = pow(max(c * u_gain + u_lift, 0.0), 1.0 / max(u_gamma, vec3(1e-3))); // lift·gamma·gain
  c = (c - 0.5) * u_contrast + 0.5;                                        // contrast about mid
  float l = dot(max(c, 0.0), vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, u_sat);                                             // saturation
  vec3 f = (c * (2.51*c + 0.03)) / (c * (2.43*c + 0.59) + 0.14);          // ACES-ish filmic knee
  c = mix(c, f, clamp(u_filmic, 0.0, 1.0));
  o_color = vec4(clamp(c, 0.0, 1.0), 1.0);
}`,
});

// ─────────────────────────────────────────────────────────────────────────────

export function createPostChain(gl, specs, width = 2, height = 2) {
  function makePass(s) {
    const def = EFFECTS[s.effect];
    if (!def) { console.warn(`post: unknown effect "${s.effect}"`); return null; }
    const params = { ...def.defaults, ...s };
    delete params.effect; delete params.as;
    const prog = compile(gl, FRAG_HEADER + def.frag);
    const uniforms = {};
    for (const k of Object.keys(params)) uniforms[k] = gl.getUniformLocation(prog, 'u_' + k);
    return {
      // `as` = INSTANCE name for setParam/remove/has — two volfog volumes (e.g. one
      // per region) coexist without clobbering each other's params
      def, params, prog, uniforms, state: {}, name: s.as || s.effect,
      uTex: gl.getUniformLocation(prog, 'u_tex'),
      uTime: gl.getUniformLocation(prog, 'u_time'),
      uRes: gl.getUniformLocation(prog, 'u_res'),
      // scene uniforms (only resolve on effects that declare them, e.g. volfog)
      uDepth: gl.getUniformLocation(prog, 'u_depth'),
      uInvVP: gl.getUniformLocation(prog, 'u_invViewProj'),
      uCamPos: gl.getUniformLocation(prog, 'u_camPos'),
      uSunDir: gl.getUniformLocation(prog, 'u_sunDir'),
      uFogColor: gl.getUniformLocation(prog, 'u_fogColor'),
    };
  }
  const passes = specs.map(makePass).filter(Boolean);

  const vao = gl.createVertexArray(); // empty — vertices from gl_VertexID
  let W = 0, H = 0;
  // [0] = scene (color + depth), rendered by begin() and thereafter READ-ONLY (its depth
  // feeds depth effects; its color is the first source). [1]/[2] = color-only ping-pong for
  // effect passes — so no effect ever WRITES to [0] while reading its depth (feedback loop).
  const targets = [makeTarget(gl, true), makeTarget(gl, false), makeTarget(gl, false)];

  function resize(w, h) {
    if (w === W && h === H) return;
    W = w; H = h;
    for (const t of targets) sizeTarget(gl, t, w, h);
  }
  resize(width, height);

  function begin() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, targets[0].fbo);
    gl.viewport(0, 0, W, H);
  }

  function end(time, scene) {
    gl.bindVertexArray(vao);
    gl.disable(gl.DEPTH_TEST);
    let srcTex = targets[0].tex;   // first source = the rendered scene color
    let pong = 1;                  // next write buffer (ping-pongs 1↔2; never 0)
    for (let i = 0; i < passes.length; i++) {
      const p = passes[i];
      const last = i === passes.length - 1;
      gl.bindFramebuffer(gl.FRAMEBUFFER, last ? null : targets[pong].fbo);
      gl.viewport(0, 0, W, H);
      gl.useProgram(p.prog);
      gl.activeTexture(gl.TEXTURE0 + 7); // clear of the scene's material slots
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      gl.uniform1i(p.uTex, 7);
      gl.uniform1f(p.uTime, time);
      gl.uniform2f(p.uRes, W, H);
      // scene reconstruction uniforms (depth-aware effects: volfog) — the SCENE
      // depth always lives on targets[0], regardless of ping-pong src.
      if (p.uDepth && scene) {
        gl.activeTexture(gl.TEXTURE0 + 6);
        gl.bindTexture(gl.TEXTURE_2D, targets[0].depth);
        gl.uniform1i(p.uDepth, 6);
      }
      if (p.uInvVP && scene?.invViewProj) gl.uniformMatrix4fv(p.uInvVP, false, scene.invViewProj);
      if (p.uCamPos && scene?.camPos) gl.uniform3fv(p.uCamPos, scene.camPos);
      if (p.uSunDir && scene?.sunDir) gl.uniform3fv(p.uSunDir, scene.sunDir);
      if (p.uFogColor && scene?.fogColor) gl.uniform3fv(p.uFogColor, scene.fogColor);
      const live = p.def.update ? { ...p.params, ...p.def.update(p.state, time, p.params) } : p.params;
      let texUnit = 8;                             // extra per-effect textures sit above u_depth(6)/u_tex(7)
      for (const [k, v] of Object.entries(live)) {
        const loc = p.uniforms[k];
        if (!loc || v == null) continue;           // null = param declared but unset (e.g. no fog texture)
        if (typeof v === 'number') gl.uniform1f(loc, v);
        else if (v instanceof WebGLTexture) {      // texture-valued param (volfog's PNG density map)
          gl.activeTexture(gl.TEXTURE0 + texUnit);
          gl.bindTexture(gl.TEXTURE_2D, v);
          gl.uniform1i(loc, texUnit);
          texUnit++;
        } else if (v.length === 2) gl.uniform2f(loc, v[0], v[1]);
        else if (v.length === 3) gl.uniform3f(loc, v[0], v[1], v[2]);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (!last) { srcTex = targets[pong].tex; pong = pong === 1 ? 2 : 1; }
    }
    gl.enable(gl.DEPTH_TEST);
    gl.bindVertexArray(null);
  }

  function destroy() {
    for (const t of targets) { gl.deleteFramebuffer(t.fbo); gl.deleteTexture(t.tex); if (t.depth) gl.deleteTexture(t.depth); }
    for (const p of passes) gl.deleteProgram(p.prog);
    gl.deleteVertexArray(vao);
  }

  // live-tune an effect's params (e.g. AI raising glitch frequency on sight)
  function setParam(effectName, key, value) {
    for (const p of passes) if (p.name === effectName) p.params[key] = value;
  }

  // runtime chain edits — a COMPONENT can attach an effect to a scene built without
  // one (gl-scene's ensurePost creates an empty inert chain; `enabled` flips true
  // here). New uniforms not in defaults won't bind — declare them in the effect.
  function add(spec) {
    const p = makePass(spec);
    if (p) passes.push(p);
    return !!p;
  }
  function remove(effectName) {
    for (let i = passes.length - 1; i >= 0; i--) {
      if (passes[i].name === effectName) { gl.deleteProgram(passes[i].prog); passes.splice(i, 1); }
    }
  }
  const has = (effectName) => passes.some((p) => p.name === effectName);

  return { begin, end, resize, destroy, setParam, add, remove, has, gl, get enabled() { return passes.length > 0; } };
}

function makeTarget(gl, withDepth) {
  // depth is a sampleable TEXTURE (not a renderbuffer) so post effects like
  // volfog can reconstruct world position from scene depth.
  return { fbo: gl.createFramebuffer(), tex: gl.createTexture(), depth: withDepth ? gl.createTexture() : null };
}

function sizeTarget(gl, t, w, h) {
  gl.bindTexture(gl.TEXTURE_2D, t.tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
  if (t.depth) {
    gl.bindTexture(gl.TEXTURE_2D, t.depth);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, w, h, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, t.depth, 0);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

function compile(gl, fragSrc) {
  const make = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error('post: compile failed: ' + gl.getShaderInfoLog(sh) + '\n' + src.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n'));
    }
    return sh;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, make(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, make(gl.FRAGMENT_SHADER, fragSrc));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('post: link failed: ' + gl.getProgramInfoLog(prog));
  return prog;
}
