// core/gl/spatial.js — SHARED "spatial compress / expand" vertex deform. A reusable
// primitive (like heightfield.js's HGT_GLSL) so EVERY world-geometry pass deforms with
// IDENTICAL math. This matters: the effect scales each vertex's screen position by a
// power-curve of camera distance, so if the ground used one formula and the props on it
// used another (or none), they'd slide apart vertically and props would sink THROUGH the
// ground as the camera moves. One source of truth = everything stays glued.
//
// Telephoto-style depth compression WITHOUT changing FOV: in clip space, after the MVP,
// scale gl_Position.xy outward from screen-center by `s = 1 + strength·pow(t, power)`
// where `t = clamp((d − start)/range, 0, 1)` and d = Euclidean world-space camera→vertex
// distance. Foreground (d ≤ start) untouched. strength > 0 = compress (distant geometry
// grows); < 0 = expand. Only .xy is touched — .z/.w intact → depth/z-sort/shadows correct.
// A pure clip-space scale factors through w (clip.xy = ndc.xy·w), so no divide/×w needed.
//
// Shader contract: include SPATIAL_GLSL in a vertex shader, then call
//   gl_Position = pf_applySpatial(gl_Position, worldPos);
// AFTER computing gl_Position and the vertex's WORLD position. Declares the uniforms
// `highp vec3 u_camPosHi` and `vec4 u_spatial` (= start,power,strength,range); set them
// with setSpatialUniforms(). u_spatial.z (strength) = 0 → identity (branch only).

export const SPATIAL_GLSL = `
uniform highp vec3 u_camPosHi;   // camera world position (highp — distance needs it)
uniform vec4 u_spatial;          // (start, power, strength, range); strength 0 = off
vec4 pf_applySpatial(vec4 clip, vec3 worldPos){
  if (u_spatial.z != 0.0){
    float d = distance(u_camPosHi, worldPos);
    float t = clamp((d - u_spatial.x) / max(u_spatial.w, 1e-3), 0.0, 1.0);
    float s = 1.0 + u_spatial.z * pow(t, max(u_spatial.y, 1e-3));
    clip.xy *= s;
  }
  return clip;
}`;

// Set u_camPosHi + u_spatial on a program's collected uniform map `u`. Pass env.spatial
// (= [start, power, strength, range] or null/undefined) and the camera world position.
// Safe to call on any program — only sets the uniforms it actually declares.
export function setSpatialUniforms(gl, u, env, camPos) {
  if (u.u_camPosHi && camPos) gl.uniform3fv(u.u_camPosHi, camPos);
  if (u.u_spatial) {
    const sp = env && env.spatial;
    if (sp) gl.uniform4f(u.u_spatial, sp[0], sp[1], sp[2], sp[3]);
    else gl.uniform4f(u.u_spatial, 0, 1, 0, 1);
  }
}
