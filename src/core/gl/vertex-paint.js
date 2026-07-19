// core/gl/vertex-paint.js — HAND-PAINTED + BAKED-ONCE per-vertex lighting for
// STATIC gl scenes. Fills a `colors` Float32Array (RGBA, one per vertex) on each
// primitive; the renderer uploads it to attribute location 10 (a_color) and, when
// the material is `baked`, the fragment shader renders UNLIT (final = base × vColor),
// skipping the whole 32-light loop + per-draw lightMask → near-zero per-frame cost.
//
// All work happens ONCE, at scene-build time, on the CPU — purely analytic (no GPU
// readback, no BVH dependency): light is evaluated per vertex (ambient + sun + point
// falloff), and "hand-painted" light pools / soft shadows are world-space brushes.
//
//   paint: {
//     unlit?: true,                 // render with no dynamic light loop (default true)
//     base?: [r,g,b],               // starting vertex color (default white)
//     bake?: true | { sun?, points?, ambient?,        // analytic light bake → vertex color
//                     // BAKED OCCLUSION (when paintSceneGraph gets a BVH `raycast`): ~2× quality
//                     // at ZERO runtime cost (it's all in the vertex colour). gl-scene supplies
//                     // the raycast + a load-time budget; per-mesh opt-out below:
//                     occlusion?: false,              // disable AO + cast shadows for this mesh
//                     ao?: false, aoRays?: 4, aoRadius?: 2, aoStrength?: 0.55,  // ambient occlusion
//                     sunShadow?: false, pointShadow?: false, shadowSoft?: 0.18,  // cast shadows (soft = bounce floor)
//                     // SOFT (area-light) shadows — penumbra instead of a hard edge:
//                     shadowSamples?: 6, lightRadius?: 0.3,
//                     // BAKED RAYTRACING (path-traced indirect GI + colour bleed) — needs a colour
//                     // BVH (gl-scene gives occluders an albedo). Bakes into vertex colour → still
//                     // renders UNLIT. Cost ≈ samples×bounces rays/vertex at LOAD (gl-scene budgets it).
//                     gi?: true | { samples?: 12, bounces?: 1, strength?: 1, maxDist?: 30, shadows?: true } },
//     gradient?: { axis:'x'|'y'|'z', from:[r,g,b], to:[r,g,b], min, max },
//     brushes?: [   // applied IN ORDER, ON TOP of base/bake/gradient → fine-tune by hand:
//       { type:'light',  at:[x,y,z] | box:[x0,y0,z0,x1,y1,z1], color?, radius, falloff?:2, strength?:1, plane?:'y' }, // add glow
//       { type:'shadow', at:[x,y,z] | box:[x0,y0,z0,x1,y1,z1], color?, radius, falloff?:2, strength?:1, plane?:'y' }, // darken toward color (default black)
//       { type:'splat', …, mode:'add'|'mul' },   // low-level (light=add · shadow=mul black)
//       { type:'tint', color:[r,g,b] },          // flat multiply over the whole mesh
//     ],
//     // `at` = radial point · `box` = axis-aligned region (0 inside, feathered over `radius`).
//     // `plane:'y'` measures distance on the ground plane (pools/shadows on floors/tables).
//     // Brushes run AFTER `bake`, so you can bake real lights then hand-add darkness/light.
//     // SHININESS painting — per-vertex roughness/metallic, feeds the LIT path (NOT unlit).
//     // A dynamic light then throws a specular streak across the painted-glossy patches.
//     material?: {
//       base?: [roughness, metallic],        // default per vertex (e.g. [0.9, 0])
//       brushes?: [ { at:[x,y,z], radius, falloff?:2, strength?:1, plane?:'y',
//                     roughness?, metallic? } ],  // wet puddle = low roughness inside radius
//     },
//   }
//
// A LOW-poly mesh shows blocky light — use `subdivide` on gl-box (or a dense GLB)
// so brushes/bake have vertices to interpolate across.

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// world point = m · (x,y,z,1); m is column-major mat4 (or null = identity)
function xformPoint(m, x, y, z, out) {
  if (!m) { out[0] = x; out[1] = y; out[2] = z; return out; }
  out[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
  out[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
  out[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  return out;
}
// world normal = normalize(upper-3×3 · n) — approximate under non-uniform scale, fine for shading
function xformDir(m, x, y, z, out) {
  if (!m) { out[0] = x; out[1] = y; out[2] = z; }
  else {
    out[0] = m[0] * x + m[4] * y + m[8] * z;
    out[1] = m[1] * x + m[5] * y + m[9] * z;
    out[2] = m[2] * x + m[6] * y + m[10] * z;
  }
  const l = Math.hypot(out[0], out[1], out[2]) || 1;
  out[0] /= l; out[1] /= l; out[2] /= l;
  return out;
}

// ── BAKE-TIME OCCLUSION (ambient occlusion + cast shadows) ────────────────────
// All of this runs ONCE at scene build (CPU, against a BVH `raycast`) and bakes into the
// vertex colour, so the RUNTIME render stays unlit/zero-cost — quality up, low-end safe.

// cosine-weighted hemisphere sample dirs (z-up), deterministic golden-angle spiral
const AO_DIRS = (() => {
  const n = 8, ga = Math.PI * (3 - Math.sqrt(5)), out = [];
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n, rr = Math.sqrt(t), phi = i * ga;
    out.push([rr * Math.cos(phi), rr * Math.sin(phi), Math.sqrt(Math.max(0, 1 - t))]);
  }
  return out;
})();
const _T = [0, 0, 0], _B = [0, 0, 0], _o = [0, 0, 0], _d = [0, 0, 0], _lt = [0, 0, 0], _lb = [0, 0, 0];
const EPS = 0.02; // push the ray origin off the surface so it doesn't self-hit
// robust tangent frame around N → T, B (caller-supplied arrays, so it's reentrant)
function basisInto(N, T, B) {
  const hx = Math.abs(N[1]) < 0.99 ? 0 : 1, hy = Math.abs(N[1]) < 0.99 ? 1 : 0;
  T[0] = hy * N[2]; T[1] = -hx * N[2]; T[2] = hx * N[1] - hy * N[0];
  const l = Math.hypot(T[0], T[1], T[2]) || 1; T[0] /= l; T[1] /= l; T[2] /= l;
  B[0] = N[1] * T[2] - N[2] * T[1]; B[1] = N[2] * T[0] - N[0] * T[2]; B[2] = N[0] * T[1] - N[1] * T[0];
}
function basis(N) { basisInto(N, _T, _B); }  // → module _T,_B (AO path)

// cosine-weighted hemisphere dirs (z-up), golden-angle spiral; cached per sample count.
// Cosine weighting folds the N·L term into the sample density → the gather estimator is a
// plain average of the hit radiance (no per-sample cosine/pdf factor needed).
const _hemiCache = new Map();
function hemiDirs(n) {
  n = Math.max(1, Math.min(64, n | 0));
  let d = _hemiCache.get(n);
  if (d) return d;
  const ga = Math.PI * (3 - Math.sqrt(5)); d = [];
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n, rr = Math.sqrt(t), phi = i * ga;
    d.push([rr * Math.cos(phi), rr * Math.sin(phi), Math.sqrt(Math.max(0, 1 - t))]);
  }
  _hemiCache.set(n, d); return d;
}
// disk offsets (golden spiral) for soft area-light shadows — jitter the shadow-ray target
const SHADOW_DISK = (() => {
  const n = 8, ga = Math.PI * (3 - Math.sqrt(5)), out = [];
  for (let i = 0; i < n; i++) { const rr = Math.sqrt((i + 0.5) / n), phi = i * ga; out.push([rr * Math.cos(phi), rr * Math.sin(phi)]); }
  return out;
})();
// 1 (open) … 1-strength (fully occluded). Casts `rays` hemisphere rays up to `radius`.
function computeAO(wp, N, raycast, rays, radius, strength) {
  basis(N);
  _o[0] = wp[0] + N[0] * EPS; _o[1] = wp[1] + N[1] * EPS; _o[2] = wp[2] + N[2] * EPS;
  let hits = 0;
  for (let i = 0; i < rays; i++) {
    const s = AO_DIRS[i];
    _d[0] = s[0] * _T[0] + s[1] * _B[0] + s[2] * N[0];
    _d[1] = s[0] * _T[1] + s[1] * _B[1] + s[2] * N[1];
    _d[2] = s[0] * _T[2] + s[1] * _B[2] + s[2] * N[2];
    if (raycast(_o, _d, radius)) hits++;
  }
  return 1 - (hits / rays) * strength;
}
// 1 = lit, `soft` (a small bounce floor, NOT 0) = shadowed. Ray toward a light position.
// The non-zero floor keeps shadows from going pure black (cheap indirect-bounce stand-in),
// so adding shadows ENHANCES a scene instead of crushing it (an enclosed lamp stays lit).
// `samples`>1 + `radius` → SOFT shadows: jitter the target across a disk of `radius` facing
// the light (an area light) and average the visibilities → penumbra instead of a hard edge.
function visToPoint(wp, N, lx, ly, lz, dist, raycast, soft, samples, radius) {
  _o[0] = wp[0] + N[0] * EPS; _o[1] = wp[1] + N[1] * EPS; _o[2] = wp[2] + N[2] * EPS;
  if (!samples || samples <= 1 || !radius) {
    _d[0] = lx / dist; _d[1] = ly / dist; _d[2] = lz / dist;
    return raycast(_o, _d, dist - EPS * 2) ? soft : 1;
  }
  _d[0] = lx / dist; _d[1] = ly / dist; _d[2] = lz / dist; basisInto(_d, _lt, _lb); // disk ⟂ light dir
  let vis = 0;
  const n = Math.min(samples, SHADOW_DISK.length);
  for (let k = 0; k < n; k++) {
    const off = SHADOW_DISK[k];
    const tx = lx + (_lt[0] * off[0] + _lb[0] * off[1]) * radius;
    const ty = ly + (_lt[1] * off[0] + _lb[1] * off[1]) * radius;
    const tz = lz + (_lt[2] * off[0] + _lb[2] * off[1]) * radius;
    const dd = Math.hypot(tx, ty, tz) || 1;
    _d[0] = tx / dd; _d[1] = ty / dd; _d[2] = tz / dd;
    vis += raycast(_o, _d, dd - EPS * 2) ? soft : 1;
  }
  return vis / n;
}

// hemisphere ambient + sun + point falloff, with optional baked occlusion when `raycast` is set:
//   ambient × AO · sun × sun-shadow · each point × point-shadow
function evalLight(wp, N, lights, opts, raycast, out) {
  const r = out || [0, 0, 0]; r[0] = r[1] = r[2] = 0;  // reuse the caller's buffer to avoid per-hit allocation
  const soft = opts.shadowSoft ?? 0.18;   // light retained in shadow (bounce stand-in; 0 = hard black)
  let ao = 1;
  // AO only multiplies the AMBIENT term → don't cast AO rays when ambient is off (pure waste).
  if (raycast && opts.ao !== false && opts.ambient !== false) ao = computeAO(wp, N, raycast, opts.aoRays || 4, opts.aoRadius || 2.0, opts.aoStrength ?? 0.55);
  if (opts.ambient !== false) {
    const up = N[1] * 0.5 + 0.5; // NdotUp remapped 0..1
    for (let k = 0; k < 3; k++) r[k] += (lights.groundColor[k] + (lights.skyColor[k] - lights.groundColor[k]) * up) * ao;
  }
  // skip the sun entirely (incl. its shadow ray) when the sun is dark — common for baked
  // interiors/horror scenes that kill the default sun (color 0 → it contributed nothing anyway).
  if (opts.sun !== false && (lights.sunColor[0] + lights.sunColor[1] + lights.sunColor[2]) > 1e-4) {
    const ndl = Math.max(0, -(N[0] * lights.sunDir[0] + N[1] * lights.sunDir[1] + N[2] * lights.sunDir[2]));
    let vis = 1;
    if (raycast && ndl > 0 && opts.sunShadow !== false) { // ray toward the sun (= -sunDir), far
      _o[0] = wp[0] + N[0] * EPS; _o[1] = wp[1] + N[1] * EPS; _o[2] = wp[2] + N[2] * EPS;
      _d[0] = -lights.sunDir[0]; _d[1] = -lights.sunDir[1]; _d[2] = -lights.sunDir[2];
      vis = raycast(_o, _d, 80) ? soft : 1;
    }
    for (let k = 0; k < 3; k++) r[k] += lights.sunColor[k] * ndl * vis;
  }
  if (opts.points !== false) {
    for (const p of lights.points || []) {
      const lx = p.pos[0] - wp[0], ly = p.pos[1] - wp[1], lz = p.pos[2] - wp[2];
      const d2 = lx * lx + ly * ly + lz * lz, dl = Math.sqrt(d2) || 1;
      const ndl = Math.max(0, (N[0] * lx + N[1] * ly + N[2] * lz) / dl);
      if (ndl <= 0) continue;
      const atten = 1 / (1 + (p.decay ?? 0.5) * d2);
      const inten0 = (p.intensity ?? 1) * atten * ndl;     // UNSHADOWED contribution
      if (inten0 < 5e-4) continue;                          // far/dim light → skip BEFORE the shadow ray (sub-quantization, no visual change)
      let vis = 1;
      if (raycast && opts.pointShadow !== false) vis = visToPoint(wp, N, lx, ly, lz, dl, raycast, soft, opts.shadowSamples, opts.lightRadius);
      const inten = inten0 * vis;
      for (let k = 0; k < 3; k++) r[k] += (p.color[k] ?? 1) * inten;
    }
  }
  return r;
}

// ── BAKED RAYTRACING (path-traced indirect / global illumination) ─────────────
// The "raytracing arm" of the baker: from each vertex, shoot `samples` cosine-weighted rays;
// each one WALKS A PATH of up to `bounces` segments, at every hit gathering albedo(hit) ×
// directLight(hit) (× the accumulated throughput) → indirect light WITH colour bleed (a red
// floor reddens the wall above it), miss → sky radiance. Bakes into the vertex colour →
// renders UNLIT, zero runtime cost. Rays hit COARSE box occluders (exact for gl-box rooms).
//
// PATH TRACING, not recursive splitting: at each hit we continue ONE ray, so cost is
// samples×bounces (LINEAR). The old code recursed a full hemisphere per hit → samples^bounces
// rays/vertex (28 samples × 2 bounces = ~800 rays/vertex instead of 56) — THAT was the
// load-time killer. The 1st-bounce term is identical; only the cheap 2nd+ bounce is now
// single-sampled. Stratified primaries + a deterministic permuted continuation dir keep the
// bake SMOOTH (no Monte-Carlo speckle) and reproducible. Reentrant: all state is LOCAL.
const _GREY = [0.6, 0.6, 0.6];
// MODULE SCRATCH for the (now non-recursive) path tracer — zero per-vertex allocation. `_gLd` is
// the bounce-light out-buffer; `_Lp` is the PRIMARY direct-light buffer (kept DISTINCT because the
// caller holds the primary L while the gather overwrites _gLd). Distinct from evalLight's _o/_d/_T/_B.
const _gT = [0, 0, 0], _gB = [0, 0, 0], _gT2 = [0, 0, 0], _gB2 = [0, 0, 0], _gO = [0, 0, 0], _gD = [0, 0, 0], _gAcc = [0, 0, 0], _gLd = [0, 0, 0], _Lp = [0, 0, 0];
function gatherIndirect(wp, N, lights, raycast, gi) {
  const dirs = hemiDirs(gi.samples), n = dirs.length, bounces = gi.bounces, maxD = gi.maxDist;
  basisInto(N, _gT, _gB);                       // wp frame (fixed across paths)
  _gAcc[0] = _gAcc[1] = _gAcc[2] = 0;
  const bounceOpts = gi.bounceOpts;             // built ONCE per mesh (in giOpts), not per vertex
  for (let i = 0; i < n; i++) {
    const s = dirs[i];
    _gO[0] = wp[0] + N[0] * EPS; _gO[1] = wp[1] + N[1] * EPS; _gO[2] = wp[2] + N[2] * EPS;
    _gD[0] = s[0] * _gT[0] + s[1] * _gB[0] + s[2] * N[0];
    _gD[1] = s[0] * _gT[1] + s[1] * _gB[1] + s[2] * N[1];
    _gD[2] = s[0] * _gT[2] + s[1] * _gB[2] + s[2] * N[2];
    let th0 = 1, th1 = 1, th2 = 1;   // path throughput (carries surface albedo → colour bleed)
    for (let b = 0; b < bounces; b++) {
      const hit = raycast(_gO, _gD, maxD);
      if (!hit) {                    // escaped → sky radiance in dir _gD, attenuated by throughput
        const up = _gD[1] * 0.5 + 0.5;
        _gAcc[0] += th0 * (lights.groundColor[0] + (lights.skyColor[0] - lights.groundColor[0]) * up);
        _gAcc[1] += th1 * (lights.groundColor[1] + (lights.skyColor[1] - lights.groundColor[1]) * up);
        _gAcc[2] += th2 * (lights.groundColor[2] + (lights.skyColor[2] - lights.groundColor[2]) * up);
        break;
      }
      const alb = hit.albedo || _GREY;
      const Ld = evalLight(hit.point, hit.normal, lights, bounceOpts, raycast, _gLd);  // direct at the hit
      _gAcc[0] += th0 * alb[0] * Ld[0]; _gAcc[1] += th1 * alb[1] * Ld[1]; _gAcc[2] += th2 * alb[2] * Ld[2];
      if (b + 1 >= bounces) break;
      th0 *= alb[0]; th1 *= alb[1]; th2 *= alb[2];             // throughput for the next segment
      basisInto(hit.normal, _gT2, _gB2);                       // continue along ONE stratified cosine ray
      const sc = dirs[(i + b + 1) % n];                        // permuted by sample+bounce → decorrelated
      _gO[0] = hit.point[0] + hit.normal[0] * EPS; _gO[1] = hit.point[1] + hit.normal[1] * EPS; _gO[2] = hit.point[2] + hit.normal[2] * EPS;
      _gD[0] = sc[0] * _gT2[0] + sc[1] * _gB2[0] + sc[2] * hit.normal[0];
      _gD[1] = sc[0] * _gT2[1] + sc[1] * _gB2[1] + sc[2] * hit.normal[1];
      _gD[2] = sc[0] * _gT2[2] + sc[1] * _gB2[2] + sc[2] * hit.normal[2];
    }
  }
  const inv = gi.strength / n;
  _gAcc[0] *= inv; _gAcc[1] *= inv; _gAcc[2] *= inv;
  return _gAcc;                                  // module scratch — caller consumes immediately
}

// Paint every primitive in a SceneGraph. `transform` = the node's world transform
// (column-major mat4 or null). Mutates each primitive, attaching `prim.colors`.
export function paintSceneGraph(sceneGraph, transform, paint, lights, raycast) {
  if (!paint) return;
  const base = paint.base || [1, 1, 1];
  const bake = paint.bake ? (paint.bake === true ? {} : paint.bake) : null;
  // baked occlusion (AO + cast shadows) only when a BVH raycast is supplied AND not opted out
  const rc = (bake && bake.occlusion === false) ? null : raycast;
  // baked raytracing (path-traced indirect GI) — resolved ONCE; null unless `bake.gi` + a raycast.
  // Needs a colour-carrying BVH (raycast hits return `albedo`) for colour bleed; greys out otherwise.
  const giOpts = (bake && bake.gi && rc) ? (() => {
    const g = bake.gi === true ? {} : bake.gi;
    const shadows = g.shadows !== false, shadowSoft = bake.shadowSoft ?? 0.2;
    const shadowSamples = g.shadowSamples ?? bake.shadowSamples, lightRadius = g.lightRadius ?? bake.lightRadius;
    return { samples: g.samples ?? 12, bounces: Math.max(1, g.bounces ?? 1), strength: g.strength ?? 1,
      maxDist: g.maxDist ?? 30, shadows, shadowSoft, shadowSamples, lightRadius,
      // bounce direct-light opts, built ONCE here (not per vertex): no ambient/AO, shadows gated
      bounceOpts: { ambient: false, ao: false, sunShadow: shadows, pointShadow: shadows, shadowSoft, shadowSamples, lightRadius } };
  })() : null;
  const grad = paint.gradient || null;
  const brushes = paint.brushes || [];
  const wantColor = bake || grad || brushes.length || paint.base;
  const matSpec = paint.material || null;       // per-vertex roughness/metallic
  const matBase = matSpec ? (matSpec.base || [0.9, 0]) : null;
  const matBrushes = matSpec ? (matSpec.brushes || []) : [];
  const wp = [0, 0, 0], N = [0, 0, 0];

  // planar/3D distance helper shared by colour + material brushes. Supports a radial
  // point (`at`) OR an axis-aligned `box:[minx,miny,minz,maxx,maxy,maxz]` (distance to the
  // box, 0 inside → feathered over `radius` outside) for region darkening/lighting.
  const splatDist = (b) => {
    let dx, dy, dz;
    if (b.box) {
      const x = b.box, p = wp;
      dx = Math.max(x[0] - p[0], 0, p[0] - x[3]);
      dy = Math.max(x[1] - p[1], 0, p[1] - x[4]);
      dz = Math.max(x[2] - p[2], 0, p[2] - x[5]);
    } else {
      dx = wp[0] - b.at[0]; dy = wp[1] - b.at[1]; dz = wp[2] - b.at[2];
    }
    if (b.plane === 'y') dy = 0; else if (b.plane === 'x') dx = 0; else if (b.plane === 'z') dz = 0;
    return Math.hypot(dx, dy, dz);
  };

  for (const mesh of sceneGraph.meshes || []) {
    for (const prim of mesh.primitives || []) {
      const pos = prim.positions, nrm = prim.normals;
      const vc = pos.length / 3;
      const colors = wantColor ? new Float32Array(vc * 4) : null;
      const materials = matSpec ? new Float32Array(vc * 2) : null;
      for (let i = 0; i < vc; i++) {
        xformPoint(transform, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], wp);
        xformDir(transform, nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2], N);

        // ── COLOR channel (light & shadow) ──────────────────────────────────
        if (colors) {
          // 1. base / bake — the starting per-vertex color
          let c0, c1, c2;
          if (bake) {
            const L = evalLight(wp, N, lights, bake, rc, _Lp);
            if (giOpts) { const I = gatherIndirect(wp, N, lights, rc, giOpts); L[0] += I[0]; L[1] += I[1]; L[2] += I[2]; }
            c0 = L[0]; c1 = L[1]; c2 = L[2];
          } else { c0 = base[0]; c1 = base[1]; c2 = base[2]; }

          // 2. gradient along a world axis (mixes the current color toward from→to)
          if (grad) {
            const ax = grad.axis === 'x' ? wp[0] : grad.axis === 'z' ? wp[2] : wp[1];
            const t = clamp01((ax - (grad.min ?? 0)) / ((grad.max ?? 1) - (grad.min ?? 0) || 1));
            const f = grad.from || [0, 0, 0], g = grad.to || [1, 1, 1];
            c0 = f[0] + (g[0] - f[0]) * t; c1 = f[1] + (g[1] - f[1]) * t; c2 = f[2] + (g[2] - f[2]) * t;
          }

          // 3. brushes — hand-paint light & shadow ON TOP of base/bake to fine-tune a scene:
          //    { type:'light',  at|box, color?, radius, falloff?, strength?, plane? }  add glow
          //    { type:'shadow', at|box, color?, radius, falloff?, strength?, plane? }  darken (toward black)
          //    { type:'splat',  …, mode:'add'|'mul' }  (low-level; light=add, shadow=mul)
          //    { type:'tint', color }  flat multiply over the whole mesh
          for (const b of brushes) {
            if (b.type === 'tint') { const col = b.color || [1, 1, 1]; c0 *= col[0]; c1 *= col[1]; c2 *= col[2]; continue; }
            const dist = splatDist(b);
            const r = b.radius ?? b.feather ?? 1;
            if (dist >= r) continue;
            const w = Math.pow(clamp01(1 - dist / r), b.falloff ?? 2) * (b.strength ?? 1);
            const darken = b.type === 'shadow' || (b.type === 'splat' && b.mode === 'mul');
            if (darken) {                         // multiply toward shadow color (default black)
              const sc = b.color || [0, 0, 0];
              c0 *= 1 + (sc[0] - 1) * w; c1 *= 1 + (sc[1] - 1) * w; c2 *= 1 + (sc[2] - 1) * w;
            } else {                              // add light (type:'light' or splat add)
              const col = b.color || (b.type === 'light' ? [1, 0.96, 0.88] : [1, 1, 1]);
              c0 += col[0] * w; c1 += col[1] * w; c2 += col[2] * w;
            }
          }
          colors[i * 4] = c0; colors[i * 4 + 1] = c1; colors[i * 4 + 2] = c2; colors[i * 4 + 3] = 1;
        }

        // ── MATERIAL channel (painted shininess) ────────────────────────────
        if (materials) {
          let rough = matBase[0], metal = matBase[1] ?? 0;
          for (const b of matBrushes) {
            const dist = splatDist(b);
            const r = b.radius ?? 1;
            if (dist >= r) continue;
            const w = Math.pow(clamp01(1 - dist / r), b.falloff ?? 2) * (b.strength ?? 1);
            if (b.roughness !== undefined) rough += (b.roughness - rough) * w;  // toward wet/matte
            if (b.metallic !== undefined) metal += (b.metallic - metal) * w;
          }
          materials[i * 2] = clamp01(rough) || 0.02; materials[i * 2 + 1] = clamp01(metal);
        }
      }
      if (materials) prim.materials = materials;
      if (colors) prim.colors = colors;
    }
  }
}
