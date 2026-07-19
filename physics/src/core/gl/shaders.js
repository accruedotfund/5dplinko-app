// core/gl/shaders.js — single uber-shader, variants resolved at compile time
// via #define flags and cached per (gl, defines) pair. One lighting model:
//   hemisphere ambient (replaced by lightmap when present)
//   + 1 directional sun + up to 4 point lights
//   + cheap Blinn-Phong specular shaped by PBR metallic/roughness factors
//   + exp2 depth fog + Reinhard tonemap + contrast/saturation grade.
// Fragment runs mediump; tonemap/grade happen in-shader (no float render
// targets — WebKit-safe, default RGBA8 backbuffer only).

import { SPATIAL_GLSL } from './spatial.js';

export const MAX_POINT_LIGHTS = 32;
export const MAX_DARK = 8;   // darkness spheres (negative light volumes — dim the lit surface in a radius)

const VERT = `#version 300 es
${SPATIAL_GLSL}
layout(location=0) in vec3 a_position;
layout(location=1) in vec3 a_normal;
layout(location=2) in vec2 a_uv0;
layout(location=3) in vec2 a_uv1;
#ifdef USE_INSTANCED
// per-instance model matrix (4 vec4 columns, divisor 1) — locations 4-7
layout(location=4) in vec4 a_i0;
layout(location=5) in vec4 a_i1;
layout(location=6) in vec4 a_i2;
layout(location=7) in vec4 a_i3;
#endif
#ifdef USE_INSTANCED_MAT
layout(location=8) in vec4 a_iTint;   // per-instance [tintR, tintG, tintB, roughMul] (divisor 1)
out vec4 v_iTint;
#endif
#ifdef USE_INSTANCED_UV
layout(location=9) in vec4 a_iUV;     // per-instance UV rect [u0,v0,u1,v1] → glyph-atlas cell
#endif
#ifdef USE_VERTEX_COLOR
layout(location=10) in vec4 a_color;  // baked / hand-painted vertex light (core/gl/vertex-paint.js)
out vec4 v_color;
#endif
#ifdef USE_VERTEX_MATERIAL
layout(location=11) in vec2 a_material;  // hand-painted [roughness, metallic] (wet/shiny vs matte)
out vec2 v_material;
#endif

uniform mat4 u_model;
uniform mat4 u_viewProj;
uniform mat3 u_normalMat;
uniform float u_psxSnap;   // PSX vertex snap: NDC grid steps across screen width (0 = off)
// u_camPosHi + u_spatial (the spatial compress/expand deform) are declared by SPATIAL_GLSL above

out vec3 v_worldPos;
out vec3 v_normal;
out vec2 v_uv0;
out vec2 v_uv1;

void main() {
#ifdef USE_INSTANCED
  mat4 model = mat4(a_i0, a_i1, a_i2, a_i3);
  // rotation+uniform-scale normal matrix (column-normalized upper 3×3);
  // instanced batches don't support shear/non-uniform scale
  mat3 nrm = mat3(normalize(model[0].xyz), normalize(model[1].xyz), normalize(model[2].xyz));
#else
  mat4 model = u_model;
  mat3 nrm = u_normalMat;
#endif
  vec4 wp = model * vec4(a_position, 1.0);
  v_worldPos = wp.xyz;
  v_normal = nrm * a_normal;
#ifdef USE_INSTANCED_UV
  v_uv0 = mix(a_iUV.xy, a_iUV.zw, a_uv0);   // remap the unit quad's UV into this instance's atlas cell
#else
  v_uv0 = a_uv0;
#endif
  v_uv1 = a_uv1;
#ifdef USE_INSTANCED_MAT
  v_iTint = a_iTint;
#endif
#ifdef USE_VERTEX_COLOR
  v_color = a_color;
#endif
#ifdef USE_VERTEX_MATERIAL
  v_material = a_material;
#endif
  gl_Position = u_viewProj * wp;
  // Spatial compress / expand — telephoto depth compression (SHARED pf_applySpatial from
  // core/gl/spatial.js, so the ground + every other world pass deform IDENTICALLY and
  // nothing slides/sinks relative to anything else). Must run on the same worldPos used
  // for lighting. See spatial.js for the full rationale.
  gl_Position = pf_applySpatial(gl_Position, wp.xyz);
  // PSX vertex snapping — quantize NDC.xy to a coarse grid so vertices "wobble"
  // between pixel cells as they move (the PS1 integer-coordinate look). Done in
  // clip space then re-multiplied by w. u_psxSnap = grid steps across the screen
  // (lower = chunkier; 0 = identity, no cost beyond the branch).
  if (u_psxSnap > 0.0) {
    vec2 ndc = gl_Position.xy / gl_Position.w;
    ndc = floor(ndc * u_psxSnap + 0.5) / u_psxSnap;
    gl_Position.xy = ndc * gl_Position.w;
  }
}`;

const FRAG = `#version 300 es
precision mediump float;

in vec3 v_worldPos;
in vec3 v_normal;
in vec2 v_uv0;
in vec2 v_uv1;
#ifdef USE_INSTANCED_MAT
in vec4 v_iTint;   // per-instance [tintR, tintG, tintB, roughMul]
#endif
#ifdef USE_VERTEX_COLOR
in vec4 v_color;   // baked / hand-painted vertex light
#endif
#ifdef USE_VERTEX_MATERIAL
in vec2 v_material;   // hand-painted [roughness, metallic]
#endif
out vec4 o_color;

uniform vec4 u_baseColorFactor;
uniform float u_metallicFactor;
uniform float u_roughnessFactor;
uniform vec3 u_emissiveFactor;
uniform float u_alphaCutoff;
uniform float u_ambientFactor;  // per-draw ambient response (dark zones < 1)
uniform float u_specularFactor; // dielectric gloss boost (glazed tile, wet stone)
uniform float u_sunFactor;      // per-draw sun response (0 indoors, 1 outdoors)
uniform highp int u_lightMask;  // per-draw: bit i clear = light i occluded (walls)

uniform sampler2D u_baseColorTex;   // slot 0
uniform sampler2D u_metalRoughTex;  // slot 1
uniform sampler2D u_normalTex;      // slot 2
uniform sampler2D u_lightmapTex;    // slot 3
uniform sampler2D u_emissiveTex;    // slot 4
#ifdef USE_ENV_REFLECT
uniform samplerCube u_envMap;       // slot 5 — baked reflection probe (core/gl/reflection.js)
uniform float u_reflectivity;       // 0..1 base reflectance (mirror≈0.95, glass≈0.4, floor≈0.15)
#ifdef USE_ENV_PARALLAX
uniform vec3 u_envBoxMin;           // probe volume (world AABB) for parallax correction
uniform vec3 u_envBoxMax;
uniform vec3 u_envProbePos;         // where the cubemap was baked from
#endif
#ifdef USE_ENV_ANISO
uniform float u_envAniso;           // 0..1 anisotropic smear strength (brushed/wet streak)
#endif
#endif
#ifdef USE_PLANAR_REFLECT
uniform sampler2D u_planarRefl;     // slot 7 — TRUE planar mirror (core/gl/planar-reflect.js)
uniform float u_planarReflMix;      // base reflectance (Fresnel ramps it at grazing angles)
#endif
#ifdef USE_AO_MAP
// BAKED CAVITY / AMBIENT-OCCLUSION map (slot 9, R channel, uv0, TILES). Darkens the
// AMBIENT term in recesses (mortar grooves, crevices) so a flat surface reads as having
// soft contact shadow — view-INDEPENDENT, lit at runtime (responds to scene ambient).
// The height map doubles as one (low = occluded). aoStrength lerps 1→map.
uniform sampler2D u_aoTex;
uniform float u_aoStrength;     // 0 = off, 1 = full occlusion
#endif
#ifdef USE_POM
// PARALLAX OCCLUSION MAPPING — fake real surface depth from a HEIGHT map (slot 8) by
// ray-marching the view vector through the surface in tangent space and OFFSETTING the
// UVs per fragment, so a flat quad reads as deep brick/cobble (self-occludes at grazing
// angles). Height convention: white = HIGH (depth = 1 - height; surface top = 0).
uniform sampler2D u_heightTex;      // slot 8 — heightfield (R channel)
uniform float u_pomScale;           // max surface depth in UV units (~0.03–0.08)
uniform vec2  u_pomLayers;          // [minLayers, maxLayers] — march steps (grazing → more)
// uv = base UV; Vts = view dir (frag→eye) in TANGENT space. Returns the parallaxed UV.
vec2 pf_parallax(vec2 uv, vec3 Vts) {
  float vz = max(abs(Vts.z), 0.1);                          // offset-limit: tame grazing blowup
  float nLayers = mix(u_pomLayers.y, u_pomLayers.x, clamp(abs(Vts.z), 0.0, 1.0));
  float layerDepth = 1.0 / nLayers;
  vec2 P = (Vts.xy / vz) * u_pomScale;                      // total UV shift over full depth
  vec2 dUV = P / nLayers;
  float curDepth = 0.0;
  vec2 cUV = uv;
  float h = 1.0 - texture(u_heightTex, cUV).r;
  for (int i = 0; i < 64; i++) {                            // steep-parallax march (bounded)
    if (float(i) >= nLayers || curDepth >= h) break;
    cUV -= dUV; curDepth += layerDepth;
    h = 1.0 - texture(u_heightTex, cUV).r;
  }
  // OCCLUSION step: interpolate between the last layer (below the surface) and the
  // previous one (above it) by where the ray actually crossed the heightfield.
  vec2 pUV = cUV + dUV;
  float after = h - curDepth;
  float before = (1.0 - texture(u_heightTex, pUV).r) - (curDepth - layerDepth);
  float w = after / (after - before);
  return mix(cUV, pUV, clamp(w, 0.0, 1.0));
}
#endif
#ifdef USE_SHADOW
// dynamic SUN shadow map — sample the sun's depth from this fragment's light-space
// position with 3×3 PCF (sampler2DShadow → each tap is hardware-compared + filtered).
// Returns 0 (fully shadowed) … 1 (lit). See core/gl/shadow.js.
uniform highp sampler2DShadow u_shadowMap;   // slot 6
uniform mat4 u_shadowVP;                       // world → sun clip space
uniform vec2 u_shadowTexel;                    // 1 / shadow map size
uniform float u_shadowBias;
float pf_sunShadow(vec3 wp, float ndl) {
  vec4 sc = u_shadowVP * vec4(wp, 1.0);
  vec3 p = sc.xyz / sc.w * 0.5 + 0.5;
  if (p.z > 1.0 || p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) return 1.0; // outside the map → lit
  float bias = max(u_shadowBias * (1.0 - ndl), u_shadowBias * 0.25);             // slope-scaled
  float s = 0.0;
  for (int x = -1; x <= 1; x++)
    for (int y = -1; y <= 1; y++)
      s += texture(u_shadowMap, vec3(p.xy + vec2(float(x), float(y)) * u_shadowTexel, p.z - bias));
  return s / 9.0;
}
#endif
#ifdef USE_AMBIENT_CUBE
// 6 directional irradiance colors (+X,-X,+Y,-Y,+Z,-Z) baked from a probe point — a
// Source-style "ambient cube": per-draw indirect ambient that replaces the flat
// hemisphere term, near-zero cost (3 dot-weighted lookups). See core/gl/reflection.js.
uniform vec3 u_ambCube[6];
vec3 pf_ambientCube(vec3 n) {
  vec3 nsq = n * n;
  vec3 ax = n.x < 0.0 ? u_ambCube[1] : u_ambCube[0];
  vec3 ay = n.y < 0.0 ? u_ambCube[3] : u_ambCube[2];
  vec3 az = n.z < 0.0 ? u_ambCube[5] : u_ambCube[4];
  return nsq.x * ax + nsq.y * ay + nsq.z * az;
}
#endif

uniform vec3 u_camPos;
uniform vec3 u_sunDir;       // direction the light TRAVELS (normalized)
uniform vec3 u_sunColor;     // premultiplied by intensity
uniform vec3 u_skyColor;
uniform vec3 u_groundColor;
uniform vec4 u_pointPos[${MAX_POINT_LIGHTS}];   // xyz pos, w decay
uniform vec3 u_pointColor[${MAX_POINT_LIGHTS}]; // premultiplied; black = off
uniform vec4 u_pointDir[${MAX_POINT_LIGHTS}];   // xyz spot dir, w cosOuter (-2 = omni)
uniform vec4 u_darkPos[${MAX_DARK}];   // darkness spheres: xyz center, w radius
uniform float u_darkStr[${MAX_DARK}];  // 0..1 dim strength at the center (0 = off)
uniform float u_vertexAlpha;           // 1 = drive output alpha from vertex color .a (opt-in)
uniform vec3 u_fogColor;
uniform float u_fogDensity;
uniform float u_gradeContrast;
uniform float u_gradeSaturation;
uniform float u_vignette;   // 0 = off
uniform vec2 u_viewport;
uniform float u_time;
uniform float u_falloffPow;  // 1 = physical-ish; >1 = liminal (pools end sooner)
// underwater caustics: light lines on surfaces inside the water volume
uniform vec4 u_causticsArea;            // x0, z0, x1, z1 (strength 0 = off)
uniform vec4 u_causticsParams;          // level, strength, scale, depthFade

#ifdef USE_CAPSULE_OCCLUSION
// Capsule SPECULAR BLOCKERS — cheap fake reflections / specular occlusion. Each capsule
// (segment A→B, radius w) blocks the specular path from a surface to a light, carving a
// character-shaped silhouette into a glossy floor without a 2nd render pass.
uniform int u_capCount;
uniform vec4 u_capA[8];   // xyz = point A, w = radius
uniform vec4 u_capB[8];   // xyz = point B
// closest distance between segment p1→p2 and segment q1→q2 (clamped)
float pf_segSegDist(vec3 p1, vec3 p2, vec3 q1, vec3 q2) {
  vec3 d1 = p2 - p1, d2 = q2 - q1, r = p1 - q1;
  float a = max(dot(d1, d1), 1e-6), e = max(dot(d2, d2), 1e-6);
  float b = dot(d1, d2), c = dot(d1, r), f = dot(d2, r);
  float den = a * e - b * b;
  float s = den > 1e-6 ? clamp((b * f - c * e) / den, 0.0, 1.0) : 0.0;
  float t = clamp((b * s + f) / e, 0.0, 1.0);
  s = clamp((b * t - c) / a, 0.0, 1.0);
  return length((p1 + d1 * s) - (q1 + d2 * t));
}
// 1 = unobstructed, 0 = a capsule fully blocks the path P→light
float pf_capOcclusion(vec3 P, vec3 Lpos) {
  float occ = 1.0;
  for (int i = 0; i < 8; i++) {
    if (i >= u_capCount) break;
    float d = pf_segSegDist(P, Lpos, u_capA[i].xyz, u_capB[i].xyz);
    occ *= smoothstep(u_capA[i].w * 0.55, u_capA[i].w * 1.05, d);
  }
  return occ;
}
#endif

float chash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float cnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(chash(i), chash(i + vec2(1, 0)), f.x),
             mix(chash(i + vec2(0, 1)), chash(i + vec2(1, 1)), f.x), f.y);
}

// ── Cook-Torrance GGX BRDF (physically-based; replaces the old Blinn-Phong glint) ────
// D = Trowbridge-Reitz NDF, G = Smith height-correlated (Schlick-GGX, direct-light k),
// F = Fresnel-Schlick. Returns the specular reflectance for one light dir L; multiply by
// lightColor · NoL · attenuation outside (the NoL cancels the 1/NoL here, standard).
const float PF_PI = 3.14159265;
float pf_D_GGX(float NoH, float a) {
  float a2 = a * a;
  float d = NoH * NoH * (a2 - 1.0) + 1.0;
  return a2 / (PF_PI * d * d + 1e-7);
}
float pf_G_Smith(float NoV, float NoL, float rough) {
  float k = (rough + 1.0); k = k * k * 0.125;   // (rough+1)²/8  — direct-lighting geometry
  float gv = NoV / (NoV * (1.0 - k) + k);
  float gl = NoL / (NoL * (1.0 - k) + k);
  return gv * gl;
}
vec3 pf_F_Schlick(float VoH, vec3 F0) {
  return F0 + (1.0 - F0) * pow(clamp(1.0 - VoH, 0.0, 1.0), 5.0);
}
vec3 pf_ggxSpec(vec3 N, vec3 V, vec3 L, float rough, vec3 F0) {
  vec3 H = normalize(L + V);
  float NoV = max(dot(N, V), 1e-4);
  float NoL = max(dot(N, L), 1e-4);
  float NoH = max(dot(N, H), 0.0);
  float VoH = max(dot(V, H), 0.0);
  float a = max(rough * rough, 1e-3);
  return (pf_D_GGX(NoH, a) * pf_G_Smith(NoV, NoL, rough) * pf_F_Schlick(VoH, F0)) / (4.0 * NoV * NoL + 1e-4);
}
// grazing-angle Fresnel for IBL/env reflection, roughness-attenuated (rough kills the rim)
vec3 pf_F_roughness(float NoV, vec3 F0, float rough) {
  return F0 + (max(vec3(1.0 - rough), F0) - F0) * pow(clamp(1.0 - NoV, 0.0, 1.0), 5.0);
}

void main() {
  // POM offsets the material UV per fragment (must happen BEFORE any material sample so
  // base/normal/metal-rough/emissive all read the parallaxed coord; lightmap keeps v_uv1).
  vec2 uv = v_uv0;
#ifdef USE_POM
  {
    vec3 N0 = normalize(v_normal);
    vec3 dp1 = dFdx(v_worldPos), dp2 = dFdy(v_worldPos);
    vec2 du1 = dFdx(v_uv0), du2 = dFdy(v_uv0);
    vec3 dp2p = cross(dp2, N0), dp1p = cross(N0, dp1);
    vec3 T = normalize(dp2p * du1.x + dp1p * du2.x);
    vec3 Bn = normalize(dp2p * du1.y + dp1p * du2.y);
    vec3 Vw = normalize(u_camPos - v_worldPos);
    vec3 Vts = vec3(dot(Vw, T), dot(Vw, Bn), dot(Vw, N0)); // view dir in tangent space
    uv = pf_parallax(v_uv0, Vts);
  }
#endif
  vec4 base = u_baseColorFactor;
#ifdef USE_BASECOLOR_TEX
  base *= texture(u_baseColorTex, uv);
#endif
#ifdef USE_INSTANCED_MAT
  base.rgb *= v_iTint.rgb;   // per-instance colour tint
#endif
#ifdef USE_ALPHACUT
  if (base.a < u_alphaCutoff) discard;
#endif

  float valpha = 1.0;   // vertex-alpha factor (set below when USE_VERTEX_COLOR + u_vertexAlpha)

#ifdef USE_BAKED_LIGHT
  // UNLIT / baked: vertex color carries all light & shadow → skip the entire light
  // loop, normal mapping, ambient & specular. Near-zero per-fragment cost.
  vec3 color = base.rgb;
#ifdef USE_VERTEX_COLOR
  color *= v_color.rgb;
  valpha = mix(1.0, v_color.a, u_vertexAlpha);
#endif
#else
  vec3 N = normalize(v_normal);
#ifdef USE_NORMAL_MAP
  // screen-space TBN (no tangent attribute needed)
  vec3 dp1 = dFdx(v_worldPos), dp2 = dFdy(v_worldPos);
  vec2 duv1 = dFdx(v_uv0), duv2 = dFdy(v_uv0);
  vec3 dp2perp = cross(dp2, N), dp1perp = cross(N, dp1);
  vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
  vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
  float invmax = inversesqrt(max(dot(T, T), dot(B, B)) + 1e-8);
  vec3 nTex = texture(u_normalTex, uv).rgb * 2.0 - 1.0;
  N = normalize(mat3(T * invmax, B * invmax, N) * nTex);
#endif

  float metal = u_metallicFactor;
  float rough = u_roughnessFactor;
#ifdef USE_VERTEX_MATERIAL
  rough = v_material.x;   // painted shininess: low = wet/glossy, high = dry/matte
  metal = v_material.y;
#endif
#ifdef USE_INSTANCED_MAT
  rough = clamp(rough * v_iTint.w, 0.02, 1.0);   // per-instance roughness multiplier
#endif
#ifdef USE_METALROUGH
  vec3 mr = texture(u_metalRoughTex, uv).rgb; // g=rough, b=metal per glTF
  rough *= mr.g; metal *= mr.b;
#endif

  // ambient: lightmap (most specific) → ambient cube → flat hemisphere
#ifdef USE_LIGHTMAP
  vec3 ambient = texture(u_lightmapTex, v_uv1).rgb;
#elif defined(USE_AMBIENT_CUBE)
  vec3 ambient = pf_ambientCube(N);
#else
  vec3 ambient = mix(u_groundColor, u_skyColor, dot(N, vec3(0.0, 1.0, 0.0)) * 0.5 + 0.5);
#endif
  ambient *= u_ambientFactor;
#ifdef USE_AO_MAP
  ambient *= mix(1.0, texture(u_aoTex, uv).r, u_aoStrength); // baked cavity occlusion (tiling, uv0)
#endif

  vec3 V = normalize(u_camPos - v_worldPos);
  vec3 L = -u_sunDir;
  float ndl = max(dot(N, L), 0.0);
#ifdef USE_SHADOW
  float sunVis = pf_sunShadow(v_worldPos, ndl);   // 0 shadowed … 1 lit
#else
  float sunVis = 1.0;
#endif
  vec3 direct = u_sunColor * ndl * u_sunFactor * sunVis;

  // Cook-Torrance GGX specular (F0 = dielectric 0.04 lerped to albedo for metals)
  vec3 F0 = mix(vec3(0.04), base.rgb, metal);
  vec3 spec = pf_ggxSpec(N, V, L, rough, F0) * u_sunColor * u_sunFactor * sunVis * ndl;
#ifdef USE_CAPSULE_OCCLUSION
  spec *= pf_capOcclusion(v_worldPos, v_worldPos - u_sunDir * 50.0);  // capsules block the sun glint
#endif

  for (int i = 0; i < ${MAX_POINT_LIGHTS}; i++) {
    vec3 lc = u_pointColor[i];
    if (lc.r + lc.g + lc.b <= 0.0) continue;
    if ((u_lightMask & (1 << i)) == 0) continue;  // light can't reach this surface
    vec3 lv = u_pointPos[i].xyz - v_worldPos;
    float atten = 1.0 / (1.0 + u_pointPos[i].w * dot(lv, lv));
    atten = pow(atten, u_falloffPow);
    vec3 Lp = normalize(lv);
    // spotlight cone: -Lp = light→fragment; w=cosOuter, -2 = omni (skip profile)
    if (u_pointDir[i].w > -1.0) {
      float ca = dot(-Lp, u_pointDir[i].xyz);
      // t: 0 = beam axis → 1 = outer edge
      float t = clamp((1.0 - ca) / max(1.0 - u_pointDir[i].w, 1e-4), 0.0, 1.0);
      // flashlight lens profile: hot core + dim mid + corona ring + soft cutoff
      float spot = smoothstep(1.0, 0.82, t);                                   // outer cutoff
      spot *= 0.40 + 0.60 * smoothstep(0.42, 0.0, t);                          // hot center core
      spot += 0.18 * smoothstep(0.55, 0.72, t) * smoothstep(0.95, 0.78, t);    // corona ring
      spot += 0.08 * smoothstep(0.30, 0.40, t) * smoothstep(0.55, 0.45, t);    // faint inner ring
      atten *= spot;
    }
    float npl = max(dot(N, Lp), 0.0);
    direct += lc * npl * atten;
    float sOcc = 1.0;
#ifdef USE_CAPSULE_OCCLUSION
    sOcc = pf_capOcclusion(v_worldPos, u_pointPos[i].xyz);  // fake reflection: blocker carves the floor glint
#endif
    spec += pf_ggxSpec(N, V, Lp, rough, F0) * lc * atten * sOcc * npl;
  }

  // IBL ambient specular (split-sum approx): the environment irradiance reflects off the
  // surface, Fresnel-weighted by view angle + roughness → a subtle rim/sheen on EVERY lit
  // surface (metals tint it by albedo), so GGX materials read grounded, not flat, where no
  // direct light hits. Uses the diffuse irradiance as the env stand-in (no per-object probe).
  {
    float NoV = max(dot(N, V), 1e-4);
    spec += ambient * pf_F_roughness(NoV, F0, rough);
  }
  vec3 diffuse = base.rgb * (1.0 - metal);
  vec3 color = (ambient + direct) * diffuse + spec * u_specularFactor;
#ifdef USE_VERTEX_COLOR
  color *= v_color.rgb;   // baked AO / tint multiplied over dynamic lighting
  valpha = mix(1.0, v_color.a, u_vertexAlpha);
#endif
#ifdef USE_ENV_REFLECT
  // sample the baked cubemap along the reflection vector; roughness picks a mip (sharp
  // mirror → blurred frosted glass); Fresnel ramps reflectance at grazing angles.
  vec3 Renv = reflect(-V, N);
#ifdef USE_ENV_PARALLAX
  // PARALLAX-CORRECT: a single cubemap is only exact at the probe point. Intersect the
  // reflection ray with the probe's box volume, then re-aim the sample from the probe
  // centre toward that hit point — so reflections line up with the real room walls.
  vec3 invR = 1.0 / Renv;
  vec3 tA = (u_envBoxMin - v_worldPos) * invR;
  vec3 tB = (u_envBoxMax - v_worldPos) * invR;
  vec3 tMax = max(tA, tB);
  float tHit = min(min(tMax.x, tMax.y), tMax.z);
  Renv = (v_worldPos + Renv * tHit) - u_envProbePos;
#endif
  float envLod = rough * 6.0;
#ifdef USE_ENV_ANISO
  // ANISOTROPIC: smear the lookup along the surface tangent (screen-space dFdx),
  // scaled by roughness → a stretched brushed-metal / wet-floor streak, not a round blur.
  vec3 dpx = dFdx(v_worldPos);
  vec3 Tg = normalize(dpx - N * dot(dpx, N) + vec3(1e-5));
  float aniso = u_envAniso * (0.2 + rough);
  vec3 envc = (textureLod(u_envMap, normalize(Renv - Tg * aniso), envLod).rgb
             + textureLod(u_envMap, normalize(Renv + Tg * aniso), envLod).rgb
             + textureLod(u_envMap, Renv, envLod).rgb) * (1.0 / 3.0);
#else
  vec3 envc = textureLod(u_envMap, Renv, envLod).rgb;
#endif
  float fres = u_reflectivity + (1.0 - u_reflectivity) * pow(1.0 - max(dot(N, V), 0.0), 5.0);
  color = mix(color, envc, clamp(fres, 0.0, 1.0));
#endif
#ifdef USE_PLANAR_REFLECT
  // TRUE mirror: sample the live reflection render at this fragment's SCREEN position.
  vec2 puv = gl_FragCoord.xy / u_viewport;
  vec3 prefl = texture(u_planarRefl, puv).rgb;
  float pfres = u_planarReflMix + (1.0 - u_planarReflMix) * pow(1.0 - max(dot(N, V), 0.0), 5.0);
  color = mix(color, prefl, clamp(pfres, 0.0, 1.0));
#endif
#endif // USE_BAKED_LIGHT

#ifdef USE_EMISSIVE
  vec3 emis = u_emissiveFactor;
#ifdef USE_EMISSIVE_TEX
  emis *= texture(u_emissiveTex, uv).rgb;
#endif
  color += emis;
#endif

  // caustics: ridged moving noise projected on XZ, fading with depth
  if (u_causticsParams.y > 0.0 && v_worldPos.y < u_causticsParams.x
      && v_worldPos.x > u_causticsArea.x && v_worldPos.x < u_causticsArea.z
      && v_worldPos.z > u_causticsArea.y && v_worldPos.z < u_causticsArea.w) {
    vec2 cp = v_worldPos.xz * u_causticsParams.z;
    float n1 = 1.0 - abs(2.0 * cnoise(cp + vec2(u_time * 0.21, u_time * 0.13)) - 1.0);
    float n2 = 1.0 - abs(2.0 * cnoise(cp * 1.7 - vec2(u_time * 0.17, u_time * 0.23)) - 1.0);
    float caus = pow(n1 * n2, 3.0);
    float depthFade = exp(-(u_causticsParams.x - v_worldPos.y) * u_causticsParams.w);
    color += vec3(0.7, 0.95, 1.0) * caus * u_causticsParams.y * depthFade;
  }

  // darkness spheres — dim the lit+reflected surface toward black within a radius (a
  // "shadow bubble"). Multiplicative so it can't push color negative; spheres compound.
  for (int i = 0; i < ${MAX_DARK}; i++) {
    float s = u_darkStr[i];
    if (s <= 0.0) continue;
    vec3 dv = u_darkPos[i].xyz - v_worldPos;
    float r = max(u_darkPos[i].w, 1e-4);
    float f = 1.0 - smoothstep(0.0, r * r, dot(dv, dv));   // 1 at center → 0 at radius edge
    color *= 1.0 - s * f;
  }

#ifdef USE_FOG
  float dist = length(u_camPos - v_worldPos);
  float fog = 1.0 - exp(-u_fogDensity * u_fogDensity * dist * dist);
  color = mix(color, u_fogColor, clamp(fog, 0.0, 1.0));
#endif

#ifdef USE_TONEMAP
  color = color / (color + vec3(1.0));                         // Reinhard
  float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color = mix(vec3(luma), color, u_gradeSaturation);           // saturation
  // contrast as a power curve — the linear pivot form ((c-0.5)*k+0.5) clamps
  // dim channels to 0 at different points and hue-shifts darks toward red
  color = pow(max(color, 0.0), vec3(u_gradeContrast));
  if (u_vignette > 0.0) {                                      // soft edge darkening
    float vd = distance(gl_FragCoord.xy / u_viewport, vec2(0.5));
    color *= 1.0 - u_vignette * smoothstep(0.30, 0.85, vd);
  }
#endif

  // backbuffer is not sRGB — encode manually (cheap gamma 2.2 approx)
  o_color = vec4(pow(max(color, 0.0), vec3(1.0 / 2.2)), base.a * valpha);
}`;

// ---------------------------------------------------------------- compile + cache

const caches = new WeakMap(); // gl → Map<definesKey, ProgramInfo>

export function getProgram(gl, defines) {
  let cache = caches.get(gl);
  if (!cache) { cache = new Map(); caches.set(gl, cache); }
  const key = [...defines].sort().join('|');
  let info = cache.get(key);
  if (!info) { info = compileProgram(gl, defines); cache.set(key, info); }
  return info;
}

function compileProgram(gl, defines) {
  const header = [...defines].map((d) => `#define ${d}`).join('\n');
  const inject = (src) => src.replace('#version 300 es', `#version 300 es\n${header}`);
  const vs = compileShader(gl, gl.VERTEX_SHADER, inject(VERT)); // USE_INSTANCED is a vertex variant
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, inject(FRAG));
  const prog = gl.createProgram();
  gl.attachShader(prog, vs); gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error('gl: link failed: ' + gl.getProgramInfoLog(prog));
  }
  gl.deleteShader(vs); gl.deleteShader(fs);

  // cache every uniform location once
  const u = {};
  const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const inf = gl.getActiveUniform(prog, i);
    const name = inf.name.replace(/\[0\]$/, '');
    u[name] = gl.getUniformLocation(prog, inf.name);
  }
  // fixed texture slots — set once at link time
  gl.useProgram(prog);
  const slot = (uname, s) => { if (u[uname]) gl.uniform1i(u[uname], s); };
  slot('u_baseColorTex', 0); slot('u_metalRoughTex', 1);
  slot('u_normalTex', 2); slot('u_lightmapTex', 3); slot('u_emissiveTex', 4);
  slot('u_envMap', 5);   // reflection probe cubemap
  slot('u_planarRefl', 7);   // planar mirror reflection texture (slot 6 = shadow map)
  slot('u_shadowMap', 6); // sun shadow depth map
  slot('u_heightTex', 8); // parallax-occlusion height map
  slot('u_aoTex', 9);     // baked cavity / AO map (tiling, uv0)

  return { prog, u };
}

function compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    const numbered = src.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n');
    throw new Error(`gl: shader compile failed:\n${log}\n${numbered}`);
  }
  return sh;
}

export function clearProgramCache(gl) { caches.delete(gl); }
