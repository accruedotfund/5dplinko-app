// ─────────────────────────────────────────────────────────────────────────────
// component: gl-scene — custom WebGL2 3D scene (zero-dep engine, src/core/gl/).
// Loads GLB/glTF models, lights them with the cheap uber-shader (hemisphere +
// sun + point lights + optional lightmap via TEXCOORD_1 + fog + tonemap), and
// optionally runs an FPS kit: pointer-lock mouselook + capsule controller
// colliding against a BVH built from `collision:true` models.
//
//   spec: {
//     type: 'gl-scene',
//     id?: 'main',
//     fill?: true,               // viewport-fill (default) | false = embed in container
//     resolutionScale?,          // render scale; default min(devicePixelRatio, 1.5)
//     fov?: 70,                  // degrees
//     near?: 0.05, far?: 200,
//     clear?: [r,g,b],           // 0..1; defaults to fog color (or dark grey)
//     children: [
//       { type:'gl-model', src:'assets/models/level.glb',   // literal path (pf-build)
//         lightmap?: 'assets/lightmaps/level.png',          // needs TEXCOORD_1 in the GLB
//         collision?: true, position?:[x,y,z], scale?: 1 | [x,y,z],
//         rotation?: [x,y,z,w], color?: [r,g,b], roughness?: 0..1,   // color/roughness override all materials
//         instances?: [{position,rotation?,scale?}|[x,y,z], …] },    // GPU-INSTANCED: one draw
//                                  // call for N copies (large scenes; static — no id/bob)
//       { type:'gl-light', kind:'directional', dir:[.5,-1,.3], color:[1,.95,.85], intensity:2.5 },
//       { type:'gl-light', kind:'hemisphere', sky:[.4,.5,.7], ground:[.2,.15,.1] },
//       { type:'gl-light', kind:'point', pos:[2,1,0], color:[1,.5,.2], intensity:2, decay:.8 },
//       { type:'gl-light', kind:'point', follow:'camera', offset:1.5,   // flashlight
//         color:[1,.95,.8], intensity:6, decay:.6 },
//       { type:'gl-light', kind:'dark', pos:[2,1,0], radius:3, strength:0.9 }, // DARKNESS SPHERE
//         // dims the lit surface toward black within `radius` (a shadow bubble); up to 8, compound.
//       // gl-model/gl-box `vertexAlpha:true` → drive output alpha from the mesh's COLOR_0 .a
//       //   (needs a mesh WITH vertex colors; routes to the blended pass).
//       { type:'gl-box', size:[w,h,d], position:[x,y,z],                // procedural box
//         texture?:'assets/textures/x.png', uvScale?:1,                 // 1 repeat per uvScale meters
//         color?, emissive?:[r,g,b], roughness?, collision?:true },
//       { type:'gl-sphere', radius?:0.5 | size:[d], position:[x,y,z],   // procedural UV sphere
//         segments?:24, rings?:16, color?, emissive?, roughness?, metallic? }, // visual (no BVH collision)
//       { type:'gl-fps-controller', position:[0,1,0], speed?:5, jumpSpeed?:7.5,
//         radius?:.35, height?:1.8, sensitivity?:.0022, yaw?:0 },
//       { type:'gl-camera-static', pos:[0,2,5], target:[0,1,0] },  // when no controller
//       { type:'gl-fixture', pos:[x,y,z], size?, palette?|color?, intensity?,  // LIMINAL kit:
//         radius?, glow?, flicker?:'stable'|'intermittent'|'failing'|'dying',  // emissive panel
//         flickerAmount?, spot?, cone? },                                      // + point light
//       { type:'gl-zone', name, pos, size, profile:{ fogDensity?, ambientFactor?,  // per-area
//         falloffPow?, flickerAmount? } },        // lighting profile applied on player enter
//     ],
//     liminal?: true | { palette: 'backrooms-yellow'|'industrial-white'|'hospital-green'|
//       'maintenance-red'|'archive-amber', ambientFactor?, sunFactor?, falloffPow?,
//       flickerAmount?, grade?, bloom?, haze? },  // darkness-first preset; also
//                                                 // world.enableLiminalMode(on) at runtime
//     fog?:   { density:.03, color:[.55,.62,.72] },
//     grade?: { contrast:1.05, saturation:1.05 },
//     anchors?: [{ id:'tag', worldPos:[x,y,z] }],   // 3D point → [data-stage-anchor]
//   }
//
// Bus: glscene:<id>:ready {draws}, :loading {pct}, :lock/:unlock,
//      :fire {origin,dir,hit} (click while pointer-locked), :error.
// Loop: physics rides game-loop 'main' fixed phase when present, else an
//       internal accumulator; rendering always on this component's own rAF.
// el.world = { raycast(origin,dir,maxDist), controller, renderer } for siblings.
// world.particles.burst({..., texture?: 'assets/masks/set1/8.png'}) — SPRITE
// particles: alpha-mask textures (shape = alpha, tint × rgb, additive); one
// lazily-created GPU system per distinct texture. gl-emitter accepts texture too.
// ─────────────────────────────────────────────────────────────────────────────

import { h } from '../core/dom.js';
import { loadGLB, loadGLTF } from '../core/gl/gltf.js';
import { boxScene, sphereScene, textScene, glyphLayout } from '../core/gl/primitives.js';
import { paintSceneGraph } from '../core/gl/vertex-paint.js';
import { bakeFontAtlas, layoutTextInstances, quadScene } from '../core/gl/font-atlas.js';
import { createPostChain } from '../core/gl/post.js';
import { createParticleSystem } from '../core/gl/particles.js';
import { createDecalRenderer } from '../core/gl/decals.js';
import { applyMaterial } from '../core/gl/materials.js';
import { getEnvironment } from '../core/gl/environments.js';
import { LIMINAL_PALETTES, LIMINAL_DEFAULTS, flickerValue } from '../core/gl/liminal.js';
import { createRenderer } from '../core/gl/renderer.js';
import { triangleSoup, triangleSoupAlbedo, buildBVH, raycastBVH, raySphere, rayAABBHit } from '../core/gl/bvh.js';
import { animeHeightFn } from '../core/gl/animeground.js';
import { createPhysics3D } from '../core/gl/physics3d.js';
import { modalOpen, onStackChange } from '../core/ui-stack.js';
import { createController } from '../core/gl/controller.js';
import { createFPSInput } from '../core/gl/fps-input.js';
import { createTexture } from '../core/gl/gpu.js';
import {
  mat4, vec3, quat, m4perspective, m4lookAt, m4mul, m4inv, m4fromTRS, m4identity,
  quatFromEuler, v3normalize, projectPoint,
} from '../core/gl/math.js';

const _ZERO3 = new Float32Array(3), _ONE3 = new Float32Array([1, 1, 1]);
function quatToMat(q, out) { return m4fromTRS(_ZERO3, q, _ONE3, out); }

// a COARSE 12-triangle box (8 corners of an AABB) — a cheap occluder for the baked-AO BVH,
// so a heavily-subdivided gl-box doesn't dump tens of thousands of coplanar tris into it.
const _BOX_IDX = new Uint16Array([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0]);
function boxOccluderTris(aabb) {
  const a = aabb.min, b = aabb.max;
  return { positions: new Float32Array([a[0], a[1], a[2], b[0], a[1], a[2], b[0], b[1], a[2], a[0], b[1], a[2], a[0], a[1], b[2], b[0], a[1], b[2], b[0], b[1], b[2], a[0], b[1], b[2]]), indices: _BOX_IDX };
}

// spec.spatial → renderer env.spatial = [start, power, strength, range], or null when off.
// { start, range, power, strength } direct, OR { mode:'compress'|'expand', amount, ... }.
// strength > 0 compresses (distant geometry grows, telephoto feel); < 0 expands (roomier).
function parseSpatial(s) {
  if (!s) return null;
  const start = s.start ?? 8;
  const range = s.range ?? 40;
  const power = s.power ?? 2;
  let strength = s.strength;
  if (strength == null) {
    const amt = Math.abs(s.amount ?? 0.5);
    strength = s.mode === 'expand' ? -amt : amt; // default mode = compress
  }
  if (!strength) return null;               // strength 0 = identity, skip the uniform
  return [start, power, strength, range];
}

// gl-procgen → upload entries. `P` = the procgen3d module (dynamically imported).
//   { type:'gl-procgen', seed,
//     terrain?: { size, resolution, layers, color, collision? },   // ground mesh
//     biome?: 'forest' | spawn?: {...}, region?:[x0,z0,x1,z1], spacing?, variants?:4,
//     params?: { tree:{...}, rock:{...} },                          // per-species overrides
//     generator?, params?, position?, scale?, rotation?, collision?, id?, sun? } // single asset
// Scatter batches placements by (species × variant) into ONE instanced draw each,
// so a forest of hundreds of props is a handful of draw calls, not hundreds.
function expandProcgen(P, spec, out) {
  const seed = spec.seed ?? 1;
  const flat = spec.flat;          // low-poly flat shading for EVERY generated mesh
  if (spec.terrain) {
    const tsg = P.generate('terrain', { seed, flat, ...spec.terrain });
    out.push({ type: 'gl-procgen', _sg: tsg, position: spec.position || [0, 0, 0],
      collision: spec.terrain.collision !== false, sun: spec.sun });
  }
  if (spec.biome || spec.spawn || spec.mode === 'ecosystem') {
    const eco = P.generateEcosystem({ seed, biome: spec.biome, spawn: spec.spawn,
      region: spec.region, spacing: spec.spacing,
      terrain: spec.terrain ? { ...spec.terrain, seed } : null });
    const V = Math.max(1, spec.variants ?? 4);
    // group by species AND per-placement variant (e.g. dead trees) so each gets
    // its own geometry; key = "generator|variant".
    const byGen = new Map();
    for (const pl of eco.placements) {
      const key = pl.generator + '|' + (pl.params?.variant || '') + '|' + (pl.params?.style || '');
      if (!byGen.has(key)) byGen.set(key, { gen: pl.generator, variant: pl.params?.variant, style: pl.params?.style, pls: [] });
      byGen.get(key).pls.push(pl);
    }
    for (const { gen, variant, style, pls } of byGen.values()) {
      if (!P.has(gen) || !P.meta(gen)?.mesh) continue; // only mesh species get geometry
      const extra = { flat, ...(spec.params?.[gen] || {}), ...(variant ? { variant } : {}), ...(style ? { style } : {}) };
      const variants = [];
      for (let v = 0; v < V; v++) variants.push(P.generate(gen, { seed: (seed * 31 + gen.length * 7 + v * 101) >>> 0, ...extra }));
      const buckets = variants.map(() => []);
      pls.forEach((pl, i) => buckets[i % V].push(pl));
      buckets.forEach((bucket, v) => {
        if (!bucket.length) return;
        out.push({ type: 'gl-procgen', _sg: variants[v], sun: spec.sun,
          instances: bucket.map((pl) => ({ position: pl.position, rotation: [0, pl.rotationY * 180 / Math.PI, 0], scale: pl.scale })) });
      });
    }
  } else if (spec.generator) {
    const sg = P.generate(spec.generator, { seed, flat, ...(spec.params || {}) });
    out.push({ type: 'gl-procgen', _sg: sg, position: spec.position || [0, 0, 0],
      scale: spec.scale, rotation: spec.rotation, collision: spec.collision, id: spec.id, sun: spec.sun });
  }
}

// rotate an AABB's corners about (ax,ay,az) by mat R, shift by (dx,dy,dz)
// Allocation-free: writes the rotated+translated AABB into outMin/outMax (the
// draw's existing aabb arrays). A rotating movable hits this EVERY frame, so the
// old `return {min:[],max:[]}` allocated 3 objects/frame/object → GC stutter (most
// visible on a continuously-spinning coin). Scalars + out-params = zero garbage.
function aabbTransformDelta(R, bMin, bMax, ax, ay, az, dx, dy, dz, outMin, outMax) {
  let nx = Infinity, ny = Infinity, nz = Infinity, xx = -Infinity, xy = -Infinity, xz = -Infinity;
  for (let c = 0; c < 8; c++) {
    const px = (c & 1 ? bMax[0] : bMin[0]) - ax;
    const py = (c & 2 ? bMax[1] : bMin[1]) - ay;
    const pz = (c & 4 ? bMax[2] : bMin[2]) - az;
    const x = R[0] * px + R[4] * py + R[8] * pz + ax + dx;
    const y = R[1] * px + R[5] * py + R[9] * pz + ay + dy;
    const z = R[2] * px + R[6] * py + R[10] * pz + az + dz;
    if (x < nx) nx = x; if (x > xx) xx = x;
    if (y < ny) ny = y; if (y > xy) xy = y;
    if (z < nz) nz = z; if (z > xz) xz = z;
  }
  outMin[0] = nx; outMin[1] = ny; outMin[2] = nz;
  outMax[0] = xx; outMax[1] = xy; outMax[2] = xz;
}
import { getLoop } from './game-loop.js';

const FIXED_DT = 1 / 60;

export function glSceneComponent(spec, ctx) {
  const id = spec.id || 'main';
  const fill = spec.fill !== false;
  const el = h('div', {
    class: ['pf-glscene', fill ? 'is-fill' : 'is-embed'],
    'data-component': 'gl-scene', 'data-gl-id': id,
  });
  const canvas = h('canvas', { class: 'pf-glscene__c', 'data-role': 'gl-canvas' });
  el.append(canvas);

  const transparent = !!spec.transparent; // composite over the DOM behind the canvas
  if (transparent) el.classList.add('is-overlay');
  const gl = canvas.getContext('webgl2', { antialias: true, alpha: transparent, powerPreference: 'high-performance' });
  if (!gl) {
    ctx.bus.emit(`glscene:${id}:error`, { message: 'WebGL2 not available' });
    el.append(h('div', { class: 'pf-glscene__nogl', 'data-role': 'gl-error' }, 'WebGL2 not available'));
    return { el, destroy() {} };
  }

  // ── environment preset (spec.environment: 'overcast' | 'night-rain' | …) ──
  const envPreset = spec.environment ? getEnvironment(spec.environment) : null;
  if (envPreset) {
    if (!spec.sky) spec.sky = envPreset.sky;
    if (!spec.fog) spec.fog = envPreset.fog;
  }

  // ── parse children ─────────────────────────────────────────────────────────
  const kids = (spec.children || spec.components || []).map(applyMaterial);
  // Tag each child with its manifest index so the IDE manifest editor can
  // debug-select it BY PATH (…/children/<i>) even when it has no `id` — every
  // child is in the structure, id or not. `meshByChild` maps that index to the
  // uploaded draws (filled in the upload loop) so debug() can box id-less items.
  kids.forEach((k, i) => { if (k && typeof k === 'object') k._ci = i; });
  const meshByChild = new Map();
  // ambient-cube probes (gl-ambient-probe). The renderer feature is flipped right
  // after createRenderer (below) — BEFORE any uploadScene — so the USE_AMBIENT_CUBE
  // shader variant is compiled into every draw's program.
  const ambientProbeSpecs = kids.filter((k) => k.type === 'gl-ambient-probe');

  // projected contact/blob shadows (gl-projected-shadow): a soft dark quad on the
  // ground under a tracked object — `target:'<movableId>'` or static `pos:[x,y,z]`,
  // projected onto the `groundY` plane, faded + grown by height above it.
  const projShadowList = kids.filter((k) => k.type === 'gl-projected-shadow').map((k) => ({
    target: k.target || null, pos: k.pos || null,
    radius: k.radius ?? 0.6, dark: k.dark ?? 0.5,
    maxHeight: k.maxHeight ?? 6, groundY: k.groundY ?? 0,
  }));

  let modelSpecs = kids.filter((k) => k.type === 'gl-model' || k.type === 'gl-box' || k.type === 'gl-sphere' || k.type === 'gl-text');
  // gl-text → INSTANCED glyph quads off a SHARED, auto-baked font ATLAS: the whole
  // string is N instances of ONE unit quad (one draw call, one texture), each instance
  // sampling its glyph cell via a per-instance UV rect + tinted per-glyph. Efficient
  // for heavy/dynamic text; per-glyph addressable via world.instanceGroup(id).
  for (const k of modelSpecs) {
    if (k.type !== 'gl-text') continue;
    const atlas = bakeFontAtlas({ font: k.font, size: 64 });
    const lay = layoutTextInstances(k.text, atlas, { height: k.height || k.size || 1 });
    k._sg = quadScene(atlas.canvas, { color: k.color, emissive: k.emissive });
    k.instances = lay.glyphs.map((g) => ({ position: [g.cx, 0, 0], scale: [g.q, g.q, 1] }));
    k.instanceUVs = lay.uvs;
    k.instanceTint = true;          // per-glyph colour/alpha (typewriter reveal = alpha)
    k._glyphLayout = lay;
  }
  // PICKABLES: id'd movables that world.pick() should hit even without a collision
  // body (decorative/animated gl-models — drones, floating loot, NPC heads). A spec
  // `pickable:true` → sphere radius 0.5; `pickable:{radius}` or `pickable:{aabb:[w,h,d]}`.
  const pickables = new Map();
  const addPickable = (id, pk = {}) => pickables.set(id, {
    id, kind: pk.aabb ? 'aabb' : 'sphere', radius: pk.radius ?? 0.5,
    half: pk.aabb ? [pk.aabb[0] / 2, pk.aabb[1] / 2, pk.aabb[2] / 2] : null,
  });
  for (const k of modelSpecs) if (k.pickable && k.id) addPickable(k.id, k.pickable === true ? {} : k.pickable);
  const procgenSpecs = kids.filter((k) => k.type === 'gl-procgen'); // procedural meshes (procgen3d)
  const waterSpecs = kids.filter((k) => k.type === 'gl-water');

  // anime-grass ground height field: lets the player walk the NOISE hills (its collision
  // mesh joins the BVH) and snaps props (`groundSnap:true`) onto the surface.
  const animeSpec = kids.find((k) => k.type === 'gl-animegrass' || k.type === 'gl-anime-ground');
  let groundH = animeSpec ? animeHeightFn(animeSpec) : null;
  if (groundH) for (const k of kids) {
    if (k.groundSnap && Array.isArray(k.position)) k.position = [k.position[0], groundH(k.position[0], k.position[2]), k.position[2]];
  }
  // gl-body children → lightweight 3D rigid bodies (core/gl/physics3d.js):
  // { type:'gl-body', id, shape:'box'|'sphere'|'capsule'|'cylinder', half|radius|halfHeight,
  //   position, dynamic, kinematic?, sensor?, bullet?(CCD), gravityScale?, group?, mask?,
  //   density?, restitution?, friction?, damping? } — id matches a movable gl-model/gl-box
  //   group; physics writes its transform every tick. Dynamic bodies collide with the
  //   level BVH (not just the ground plane). gl-joint children add constraints:
  //   { type:'gl-joint', type:'distance'|'spring'|'point'|'hinge', a, b?, anchorA?, anchorB?,
  //     length?, stiffness?, damping?, axis?, worldAnchor? }. spec.physics3d.gravity may be a
  //   number or [x,y,z]; runtime control via el.world.phys.* (impulse/explode/setGravity/
  //   rayAll/fireBody/spawnBody/addJoint). Bus: glscene:<id>:collide3d, glscene:<id>:trigger.
  const bodySpecs = kids.filter((k) => k.type === 'gl-body');
  let phys3d = null;
  // create the physics world if there are bodies, joints, or an explicit config —
  // a manifest can run a body-less world and spawn projectiles/props at runtime.
  if (bodySpecs.length || kids.some((k) => k.type === 'gl-joint') || spec.physics3d) {
    phys3d = createPhysics3D({ gravity: spec.physics3d?.gravity ?? 18, ground: spec.physics3d?.ground });
    for (const bs of bodySpecs) phys3d.addBody(bs);
    phys3d.onContact = (a, b, impulse, point) =>
      ctx.bus.emit(`glscene:${id}:collide3d`, { a, b, impulse, point });
    // sensor bodies → enter/exit bus events (pickups, goal zones, kill volumes)
    phys3d.onTrigger = (sensorId, otherId, phase) =>
      ctx.bus.emit(`glscene:${id}:trigger`, { sensor: sensorId, other: otherId, phase });
  }
  const fpsSpec = kids.find((k) => k.type === 'gl-fps-controller') || null;
  const camSpec = kids.find((k) => k.type === 'gl-camera-static') || null;
  const lights = {
    sunDir: v3normalize(vec3(0.5, -1, 0.3)), sunColor: vec3(2, 1.9, 1.7),
    skyColor: vec3(0.4, 0.5, 0.7), groundColor: vec3(0.2, 0.16, 0.12), points: [], darks: [],
  };
  for (const k of kids) {
    if (k.type !== 'gl-light') continue;
    const inten = k.intensity ?? 1;
    if (k.kind === 'directional') {
      lights.sunDir = v3normalize(Float32Array.from(k.dir || [0.5, -1, 0.3]));
      lights.sunColor = vec3(...(k.color || [1, 1, 1]).map((c) => c * inten));
    } else if (k.kind === 'hemisphere') {
      lights.skyColor = vec3(...(k.sky || [0.4, 0.5, 0.7]).map((c) => c * inten));
      lights.groundColor = vec3(...(k.ground || [0.2, 0.16, 0.12]).map((c) => c * inten));
    } else if (k.kind === 'point') {
      const pl = { pos: Array.from(k.pos || [0, 1, 0]), color: k.color || [1, 1, 1], intensity: inten, decay: k.decay ?? 0.5 };
      if (k.cone) { pl.cone = k.cone; pl.dir = Array.from(k.dir || [0, -1, 0]); } // spotlight (outer half-angle, deg)
      if (k.follow === 'camera') { pl.follow = true; pl.followDist = k.offset ?? 1.5; } // flashlight
      lights.points.push(pl);
    } else if (k.kind === 'dark') {
      // darkness sphere — dims the lit surface toward black within `radius` (a shadow bubble).
      lights.darks.push({ pos: Array.from(k.pos || [0, 1, 0]), radius: k.radius ?? k.range ?? 3, strength: k.strength ?? k.intensity ?? 1 });
    }
  }
  // gl-blocker: a CAPSULE specular occluder (cheap fake reflection / specular shadow).
  // { type:'gl-blocker', a:[x,y,z], b:[x,y,z], radius } — blocks the specular path on any
  // draw flagged `specularBlockers:true`. `follow:'<movable id>'` re-centres it each frame.
  lights.capsules = [];
  for (const k of kids) {
    if (k.type !== 'gl-blocker') continue;
    lights.capsules.push({ a: Array.from(k.a || [0, 0, 0]), b: Array.from(k.b || k.a || [0, 1, 0]), r: k.radius ?? k.r ?? 0.2, follow: k.follow || null, _base: { a: Array.from(k.a || [0, 0, 0]), b: Array.from(k.b || k.a || [0, 1, 0]) } });
  }
  // ── gl-fixture: PRACTICAL fluorescent fixtures (liminal kit) ────────────────
  // { type:'gl-fixture', pos:[x,y,z], size?:[w,h,d], palette?|color?, intensity?,
  //   radius?, glow?, flicker?:'stable'|'intermittent'|'failing'|'dying',
  //   flickerAmount?, spot?:true, cone? }
  // → an emissive ceiling panel (blooms brighter than the room) + a point light
  //   under it (+ optional down-spot). Flicker drives BOTH light and panel.
  const fixtures = [];
  for (const k of kids) {
    if (k.type !== 'gl-fixture') continue;
    const pal = LIMINAL_PALETTES[k.palette || (typeof spec.liminal === 'object' ? spec.liminal.palette : '')] || null;
    const color = k.color || pal?.fixture || [1, 0.93, 0.6];
    const size = k.size || [1.4, 0.08, 0.4];
    const pos = k.pos || [0, 2.9, 0];
    const glow = k.glow ?? 2.4;
    const radius = k.radius ?? 7;                       // ~where the pool dies
    const pl = { pos: [pos[0], pos[1] - size[1] / 2 - 0.06, pos[2]],
      color: [...color], intensity: k.intensity ?? 2.4, decay: k.decay ?? 4 / (radius * radius) };
    lights.points.push(pl);
    const rec = { mode: k.flicker || 'stable', amount: k.flickerAmount ?? 1,
      seed: fixtures.length * 7.31 + 1.7, lights: [{ l: pl, base: pl.intensity }],
      mats: null, baseEmis: color.map((c) => c * glow) };
    if (k.spot) {
      const sp = { pos: [...pl.pos], color: [...color], intensity: (k.intensity ?? 2.4) * 0.9,
        decay: pl.decay * 0.5, cone: k.cone ?? 40, dir: [0, -1, 0] };
      lights.points.push(sp);
      rec.lights.push({ l: sp, base: sp.intensity });
    }
    modelSpecs.push({ type: 'gl-box', size, position: pos, color: [0.85, 0.85, 0.82],
      roughness: 0.9, emissive: rec.baseEmis, _fixture: rec });
    fixtures.push(rec);
  }

  // preset sun/hemisphere apply only when the manifest didn't declare its own
  if (envPreset) {
    if (!kids.some((k) => k.type === 'gl-light' && k.kind === 'directional')) {
      const su = envPreset.sun;
      lights.sunDir = v3normalize(Float32Array.from(su.dir));
      lights.sunColor = vec3(...su.color.map((c) => c * su.intensity));
    }
    if (!kids.some((k) => k.type === 'gl-light' && k.kind === 'hemisphere')) {
      lights.skyColor = vec3(...envPreset.hemisphere.sky);
      lights.groundColor = vec3(...envPreset.hemisphere.ground);
    }
  }
  // vertexSnap: PS1 vertex-wobble grid (NDC steps across the screen; lower = chunkier).
  // `vertexSnap:true` → 160; a number sets the grid directly. Passed to the renderer as
  // env.psxSnap → the vertex shader's u_psxSnap. 0/absent = off (no visual change).
  const psxSnap = spec.vertexSnap === true ? 160 : (typeof spec.vertexSnap === 'number' ? spec.vertexSnap : 0);
  // spatial: telephoto-style depth compress/expand done in the vertex shader (scales
  // each vertex's screen position outward from center by a power-curve of world-space
  // camera distance; .z/.w untouched → depth/shadows correct; rotation-invariant).
  //   spec.spatial = { start, range, power, strength }  — strength>0 compress, <0 expand
  //   convenience: { mode:'compress'|'expand', amount, start, range, power }
  // Passed to the renderer as env.spatial = [start, power, strength, range]; absent/0 = off.
  const spatial = parseSpatial(spec.spatial);
  // dynamic SUN shadows (core/gl/shadow.js): spec.shadows = true | { size, distance,
  // center:[x,y,z], bias }. The feature flag is set right after createRenderer (below);
  // env.shadow carries the per-frame ortho-fit params the renderer reads.
  const shadowsCfg = spec.shadows
    ? {
        size: spec.shadows.size || 2048,
        distance: spec.shadows.distance ?? 30,
        center: spec.shadows.center || [0, 0, 0],
        bias: spec.shadows.bias ?? 0.0025,
      }
    : null;
  const env = { fog: spec.fog || null, grade: spec.grade || null, psxSnap, spatial, shadow: shadowsCfg };
  // ── LIMINAL MODE: darkness-first preset (core/gl/liminal.js) ────────────────
  // spec.liminal: true | { palette?, ambientFactor?, sunFactor?, falloffPow?,
  // flickerAmount?, grade?, bloom?, haze? }. world.enableLiminalMode(on) toggles
  // at runtime. "Light exists only where a fixture exists."
  const liminalCfg = spec.liminal ? { ...LIMINAL_DEFAULTS, ...(spec.liminal === true ? {} : spec.liminal) } : null;
  const baseSky = Float32Array.from(lights.skyColor), baseGround = Float32Array.from(lights.groundColor), baseSun = Float32Array.from(lights.sunColor);
  const ambBase = { sky: Float32Array.from(lights.skyColor), ground: Float32Array.from(lights.groundColor) };
  const zone = { amb: 1, ambT: 1, falloff: 1, falloffT: 1, flick: 1, flickT: 1 };
  function applyLiminal(on = true) {
    const L = liminalCfg || LIMINAL_DEFAULTS;
    const pal = LIMINAL_PALETTES[(typeof spec.liminal === 'object' && spec.liminal.palette) || ''];
    if (on) {
      const sky = pal ? pal.sky : baseSky, gnd = pal ? pal.ground : baseGround;
      const af = pal ? 1 : L.ambientFactor;             // palette skies are pre-crushed
      for (let i = 0; i < 3; i++) {
        lights.skyColor[i] = sky[i] * af;
        lights.groundColor[i] = gnd[i] * af;
        lights.sunColor[i] = baseSun[i] * L.sunFactor;
      }
      zone.falloff = zone.falloffT = L.falloffPow;
      zone.flick = zone.flickT = L.flickerAmount;
      env.falloffPow = L.falloffPow;
      if (!spec.grade) env.grade = L.grade;
      if (!spec.fog && pal?.fog) env.fog = { density: pal.fog.density, color: [...pal.fog.color] };
    } else {
      lights.skyColor.set(baseSky); lights.groundColor.set(baseGround); lights.sunColor.set(baseSun);
      zone.falloff = zone.falloffT = 1; zone.flick = zone.flickT = 1;
      env.falloffPow = 1;
      env.grade = spec.grade || null;
      env.fog = spec.fog || null;
    }
    ambBase.sky.set(lights.skyColor); ambBase.ground.set(lights.groundColor);
    zone.amb = zone.ambT = 1;
  }
  if (liminalCfg) applyLiminal(true);
  // smooth fog transitions: world.fogTo(target, seconds) lerps density+color
  // in the frame loop instead of swapping instantly (the "lighting clip-in")
  let fogTween = null;
  function fogTo(target, seconds = 1.2) {
    if (!target) return;
    const from = env.fog ? { density: env.fog.density, color: [...env.fog.color] } : { density: 0, color: [...target.color] };
    env.fog = { density: from.density, color: [...from.color] };
    fogTween = { from, to: { density: target.density, color: [...target.color] }, t: 0, dur: Math.max(seconds, 0.01) };
  }
  // per-draw sun response default (set 0 for indoor levels with an outdoor zone)
  for (const k of kids) {
    if ((k.type === 'gl-model' || k.type === 'gl-box') && k.sun === undefined && spec.sunDefault !== undefined) {
      k.sun = spec.sunDefault;
    }
  }

  // ── renderer + sizing ──────────────────────────────────────────────────────
  const renderer = createRenderer(gl);
  // reflection probe with a `bounds` box → parallax-corrected; `aniso` → anisotropic.
  // (flags must be set BEFORE uploadScene so reflective draws compile the right variant.)
  const reflProbeSpec = kids.find((k) => k.type === 'gl-reflection-probe');
  renderer.setFeatures({
    ambientCube: ambientProbeSpecs.length > 0,
    envParallax: !!(reflProbeSpec && reflProbeSpec.bounds),
    envAniso: !!(reflProbeSpec && reflProbeSpec.aniso),
    shadows: !!shadowsCfg,
  });
  if (transparent) {
    gl.clearColor(0, 0, 0, 0); // alpha-0 background → the DOM shows through
  } else {
    const cc = spec.clear || (spec.fog ? spec.fog.color : [0.06, 0.07, 0.09]);
    gl.clearColor(Math.pow(cc[0], 1 / 2.2), Math.pow(cc[1], 1 / 2.2), Math.pow(cc[2], 1 / 2.2), 1);
  }

  if (spec.sky) renderer.sky.setSky(spec.sky === true ? {} : spec.sky);

  // post-processing chain (spec.post = [{effect:'vhs',...}, {effect:'glitch',...}])
  const postSpecs = spec.post?.length ? spec.post
    : (liminalCfg ? [{ effect: 'bloom', ...liminalCfg.bloom }] : null);   // fixtures bloom, walls don't
  let post = postSpecs ? createPostChain(gl, postSpecs) : null;           // `let`: ensurePost can retrofit

  // particle system (always available; one instanced draw, GPU-simulated)
  const particles = createParticleSystem(gl, { max: spec.particles?.max ?? 4096 });
  const decals = createDecalRenderer(gl, { max: spec.decals?.max ?? 256 });
  // decal PARENTING: a decal added with `parent: <movable id>` is stored in the
  // movable's hit-time LOCAL space; every setModelTransform on that movable
  // re-projects it (9 floats + one bufferSubData per decal) → marks RIDE the
  // surface they hit instead of floating where it used to be.
  const decalAttach = new Map();    // movable id → [{slot, lc, lt, lb}]
  const decalSlotOwner = new Map(); // slot → movable id (ring reuse cleanup)
  const _dRm = mat4(), _dv = [0, 0, 0];
  const rotApply = (R, v, o) => {
    const x = v[0], y = v[1], z = v[2];
    o[0] = R[0] * x + R[4] * y + R[8] * z;
    o[1] = R[1] * x + R[5] * y + R[9] * z;
    o[2] = R[2] * x + R[6] * y + R[10] * z;
    return o;
  };
  const rotApplyT = (R, v, o) => {
    const x = v[0], y = v[1], z = v[2];
    o[0] = R[0] * x + R[1] * y + R[2] * z;
    o[1] = R[4] * x + R[5] * y + R[6] * z;
    o[2] = R[8] * x + R[9] * y + R[10] * z;
    return o;
  };
  function releaseDecalSlot(slot) {
    const owner = decalSlotOwner.get(slot);
    if (owner == null) return;
    const arr = decalAttach.get(owner);
    if (arr) {
      const i = arr.findIndex((e) => e.slot === slot);
      if (i >= 0) arr.splice(i, 1);
    }
    decalSlotOwner.delete(slot);
  }
  const decalsApi = {
    add(opts) {
      const mid = opts.parent && movable.has(opts.parent) ? opts.parent : null;
      if (mid) {
        // the BVH (hitscan) is STATIC — a movable that's currently transformed
        // away from its collision pose gives hit points on the invisible
        // "ghost" surface, so a decal would float. Paint only at rest pose.
        const m = movable.get(mid);
        const moved = m.lastQuat
          || (m.current && (m.current[0] !== m.anchor[0] || m.current[1] !== m.anchor[1] || m.current[2] !== m.anchor[2]));
        if (moved) return null;
      }
      const ret = decals.add(opts);
      releaseDecalSlot(ret.slot); // ring may have recycled a parented slot
      if (mid) {
        const m = movable.get(mid);
        const cur = m.current || m.anchor;
        const R = m.lastQuat ? quatToMat(m.lastQuat, _dRm) : null;
        // hit-time local: lc = Rᵀ(c − cur) + anchor; directions just Rᵀ·v
        const toL = (pnt, isPoint) => {
          const d = isPoint ? [pnt[0] - cur[0], pnt[1] - cur[1], pnt[2] - cur[2]] : pnt;
          const o = [0, 0, 0];
          if (R) rotApplyT(R, d, o); else { o[0] = d[0]; o[1] = d[1]; o[2] = d[2]; }
          if (isPoint) { o[0] += m.anchor[0]; o[1] += m.anchor[1]; o[2] += m.anchor[2]; }
          return o;
        };
        let arr = decalAttach.get(mid);
        if (!arr) decalAttach.set(mid, arr = []);
        arr.push({ slot: ret.slot, lc: toL(ret.center, true), lt: toL(ret.tan, false), lb: toL(ret.bit, false) });
        decalSlotOwner.set(ret.slot, mid);
      }
      return ret;
    },
    setPlacement: (...a) => decals.setPlacement(...a),
    placement: (...a) => decals.placement(...a),
    clear() { decals.clear(); decalAttach.clear(); decalSlotOwner.clear(); },
    get count() { return decals.count; },
  };
  // TEXTURED particle systems: one per distinct sprite (a system holds ONE
  // texture). Lazily created on first use; alpha-mask sprites from
  // assets/masks/set*/ work directly (shape = alpha, tint × rgb, additive).
  const texSystems = new Map();   // url → { sys, loaded, ready }
  function sysFor(url) {
    if (!url) return null;
    let t = texSystems.get(url);
    if (!t) {
      const sys = createParticleSystem(gl, { max: 2048 });
      t = { sys, loaded: false, ready: null };
      t.ready = fetch(url).then((r) => r.blob()).then((b) => createImageBitmap(b))
        .then((bm) => { sys.setTexture(bm); t.loaded = true; })
        .catch((e) => console.error('[gl-scene] particle texture failed:', url, e));
      texSystems.set(url, t);
    }
    return t;
  }
  const emitters = kids.filter((k) => k.type === 'gl-emitter').map((k) => ({ spec: k, next: 0 }));
  // gl-sparkles: glints popping on an object (movable id) or a fixed box —
  // { target?: 'id', pos?: [x,y,z], size?: [w,h,d], rate?: 3, color?, glintSize? }
  const sparklers = kids.filter((k) => k.type === 'gl-sparkles').map((k) => ({ spec: k, next: 0 }));
  // gl-mist: { area:[x0,z0,x1,z1], y?, density?, color?, size? } → a slow fat-particle haze
  for (const k of kids) {
    if (k.type !== 'gl-mist') continue;
    const [x0, z0, x1, z1] = k.area;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const span = Math.max(x1 - x0, z1 - z0);
    emitters.push({ next: 0, spec: {
      rate: k.density ?? 3, perEmit: 2,
      pos: [cx, k.y ?? 1.2, cz], posJitter: span,
      spread: Math.PI, dir: [0, 1, 0],
      speed: [0.02, 0.12], life: [5, 10],
      size: [k.size ?? 2.6, (k.size ?? 2.6) * 1.4],
      colorA: k.color || [0.045, 0.05, 0.055], colorB: k.color || [0.045, 0.05, 0.055],
      gravity: [0, 0.005, 0],
    } });
  }
  // liminal haze: barely-there dust so light FADES into darkness — air depth,
  // not visible fog clouds (huge ultra-dim slow particles)
  // haze is OPT-IN (haze:true): additive grey particles smudge lit walls —
  // the reference look is clean pools + PURE black gaps, no airborne soup
  if (liminalCfg && liminalCfg.haze === true && !kids.some((k) => k.type === 'gl-mist')) {
    emitters.push({ next: 0, spec: {
      rate: 2, perEmit: 2, pos: [0, 1.7, 0], posJitter: 13,
      spread: Math.PI, dir: [0, 1, 0], speed: [0.01, 0.06], life: [6, 12],
      size: [1.9, 2.7], colorA: [0.014, 0.013, 0.009], colorB: [0.008, 0.008, 0.006],
      gravity: [0, 0.002, 0],
    } });
  }

  // burst with optional short-lived point light ("muzzle flash")
  function burstFX(o) {
    // o.texture: sprite-shaped particles (first use waits for the image once)
    if (o.texture) {
      const t = sysFor(o.texture);
      if (t.loaded) t.sys.burst(o);
      else t.ready.then(() => alive && t.sys.burst(o));
    } else particles.burst(o);
    if (o.flash) {
      const pl = {
        pos: [...(o.pos || [0, 0, 0])], color: o.flash.color || [1, 0.8, 0.4],
        intensity: o.flash.intensity ?? 8, decay: o.flash.decay ?? 0.8,
      };
      lights.points.push(pl);
      setTimeout(() => {
        const i = lights.points.indexOf(pl);
        if (i >= 0) lights.points.splice(i, 1);
      }, o.flash.ms ?? 80);
    }
  }

  const resScale = spec.resolutionScale ?? Math.min(window.devicePixelRatio || 1, 1.5);
  let aspect = 1;
  function relayout() {
    const w = fill ? window.innerWidth : (el.clientWidth || 1);
    const hgt = fill ? window.innerHeight : (el.clientHeight || 1);
    canvas.width = Math.max(1, Math.round(w * resScale));
    canvas.height = Math.max(1, Math.round(hgt * resScale));
    gl.viewport(0, 0, canvas.width, canvas.height);
    aspect = canvas.width / canvas.height;
    post?.resize(canvas.width, canvas.height);
  }
  relayout();
  window.addEventListener('resize', relayout);

  // ── camera state ───────────────────────────────────────────────────────────
  const proj = mat4(), view = mat4(), viewProj = mat4();
  const camPos = vec3(0, 2, 5);
  const fov = (spec.fov ?? 70) * Math.PI / 180;
  const near = spec.near ?? 0.05, far = spec.far ?? 200;
  // camera feel hook — feel layers (gl-gunfeel) write these every frame:
  // offset = world-space eye displacement (bob/landing dip), roll = view-space
  // lean (radians), fovMul = FOV multiplier (ADS zoom / sprint widen)
  const camFX = { offset: vec3(), roll: 0, fovMul: 1 };
  const _fxEye = vec3(), _rollM = mat4();

  // ── head-bob / breathing / landing-dip (FPS "walk feel", esp. horror) ────────
  // Opt-in via `gl-fps-controller` `bob:true | {…}`. Each render frame it writes
  // camFX.offset + camFX.roll from the controller's own motion: a footfall bob
  // (2 dips/stride), a lateral sway + view roll, idle breathing that fades while
  // moving, and a dip on landing. amp/sway/breathe in world units; freq =
  // steps/sec at full speed; roll in radians at full sway. (Skip if a gunfeel
  // layer owns camFX — those scenes won't set `bob`.)
  const HB = (fpsSpec && fpsSpec.bob)
    ? Object.assign({ amp: 0.055, sway: 0.04, freq: 1.9, roll: 0.012, breathe: 0.012, breatheFreq: 0.5, land: 0.10 },
        fpsSpec.bob === true ? {} : fpsSpec.bob)
    : null;
  let hbPhase = 0, hbBreathe = 0, hbDip = 0, hbSpeedSm = 0;
  function headBob(dt) {
    if (!HB || !controller) return;
    const v = controller.velocity, sp = Math.hypot(v[0], v[2]);
    const frac = controller.onGround ? Math.min(1, sp / (controller.speed || 5)) : 0;
    hbSpeedSm += (frac - hbSpeedSm) * Math.min(1, dt * 10);            // smooth speed ramp
    hbPhase += dt * HB.freq * Math.PI * 2 * (0.35 + 0.65 * hbSpeedSm); // walk cadence
    hbBreathe += dt * HB.breatheFreq * Math.PI * 2;
    const land = controller.consumeLanding ? controller.consumeLanding() : 0;
    if (land > 0.5) hbDip = Math.min(HB.land * 2.5, hbDip + land * HB.land);
    hbDip *= Math.max(0, 1 - dt * 6);
    const bobY = -Math.abs(Math.sin(hbPhase)) * HB.amp * hbSpeedSm;    // each footfall dips down
    const breY = Math.sin(hbBreathe) * HB.breathe * (1 - hbSpeedSm * 0.7); // breathing recedes while walking
    camFX.offset[0] = Math.sin(hbPhase * 0.5) * HB.sway * hbSpeedSm;
    camFX.offset[1] = bobY + breY - hbDip;
    camFX.roll = Math.sin(hbPhase * 0.5) * HB.roll * hbSpeedSm;
  }
  if (camSpec) {
    camPos.set(camSpec.pos || [0, 2, 5]);
    m4lookAt(camPos, Float32Array.from(camSpec.target || [0, 0, 0]), vec3(0, 1, 0), view);
  }

  // ── FPS kit ────────────────────────────────────────────────────────────────
  let controller = null, input = null, bvh = null;
  // DYNAMIC COLLIDERS (gl-box `collision:'dynamic'`, id'd) — a solid door's triangles kept
  // OUT of the static BVH so it can be toggled: world.setCollider(id,on) rebuilds the BVH
  // = static + currently-enabled dynamics, and re-points the controller + phys3d at it.
  let staticColl = [];
  const dynColl = new Map();   // id → [{positions,indices,world}…]  (at authored/closed pose)
  const dynOn = new Set();     // ids currently solid
  let playerBodyId = null, playerCapOff = 0, playerCapBase = 0, playerCapHalf = 0; // kinematic player body
  const _invVP = mat4(); // scratch: inverse view-proj for depth-aware post (volfog)
  let locoState = 'stop';   // idle/walk/run — emits glscene:<id>:foot:<state> on change (footstep audio)
  let manualFreeze = false; // setInputFrozen (cutscenes); modalOpen() ORs in per frame
  // a modal (pause menu/dialog) needs a CURSOR: release the pointer lock while
  // it's open, re-acquire when it closes. The stack notifies synchronously
  // inside the closing click/keypress, so the relock is gesture-sanctioned.
  let relockAfterModal = false;
  const offStack = onStackChange(() => {
    if (!input) return;
    if (modalOpen()) {
      if (input.locked) { relockAfterModal = true; input.exitLock(); }
    } else if (relockAfterModal) {
      relockAfterModal = false;
      input.requestLock();
    }
  });
  if (fpsSpec) {
    input = createFPSInput(canvas, {
      sensitivity: fpsSpec.sensitivity, yaw: fpsSpec.yaw, pitch: fpsSpec.pitch,
      freeLook: fpsSpec.freeLook, pitchLimit: fpsSpec.pitchLimit,
      // lock the BODY, not the canvas: the lock then survives level swaps that
      // destroy this scene (level-host) — the next scene's input adopts it
      lockEl: document.body,
      onLock: () => ctx.bus.emit(`glscene:${id}:lock`),
      onUnlock: () => ctx.bus.emit(`glscene:${id}:unlock`),
    });
    // mousedown, NOT pointerdown: while RMB is held (ADS) a LMB press is a
    // chorded button — the single mouse pointer fires no second pointerdown.
    // Split listeners: canvas acquires the lock; once locked, events retarget
    // to the locked element (body), so firing listens on the document.
    canvas.addEventListener('mousedown', onCanvasDown);
    document.addEventListener('mousedown', onLockedDown);
  }
  function onCanvasDown(e) {
    if (e.button !== 0 || input.locked || modalOpen()) return; // menus own the click
    input.requestLock();
  }
  function onLockedDown(e) {
    // a ui-stack modal (menu/dialog/radial) owns input — no firing behind it
    if (e.button !== 0 || !input?.locked || input.frozen) return;
    // hitscan while locked — hits BOTH the static level AND dynamic props
    const eye = controller ? controller.eye() : camPos;
    const dir = input.lookDir(vec3());
    // rayAll (physics) covers level BVH + bodies; fall back to BVH-only if no phys world
    const hit = phys3d ? phys3d.rayAll(eye, dir, 500) : (bvh ? raycastBVH(bvh, eye, dir, 500) : null);
    if (hit && hit.id && hit.id !== '__static' && phys3d) {
      // shove the struck body along the shot (mass-scaled so light props fly)
      const f = (spec.physics3d?.hitImpulse ?? 8) * (phys3d.bodies.get(hit.id)?.mass || 1);
      phys3d.applyImpulse(hit.id, [dir[0] * f, dir[1] * f, dir[2] * f], hit.point);
    }
    ctx.bus.emit(`glscene:${id}:fire`, {
      origin: Array.from(eye), dir: Array.from(dir),
      hit: hit ? { point: Array.from(hit.point), normal: hit.normal ? Array.from(hit.normal) : null, t: hit.t, id: hit.id } : null,
    });
  }

  // ── anchors (3D → DOM, pin/frame compatible) ───────────────────────────────
  const anchorEls = new Map();
  const ndc = { x: 0, y: 0, z: 0, w: 0 };
  function publishAnchors() {
    if (!spec.anchors) return;
    for (const a of spec.anchors) {
      let m = anchorEls.get(a.id);
      if (!m) { m = h('i', { class: 'pf-glscene__anchor', 'data-stage-anchor': a.id }); el.append(m); anchorEls.set(a.id, m); }
      projectPoint(viewProj, a.worldPos, ndc);
      if (ndc.w <= 0 || ndc.x < -1.2 || ndc.x > 1.2 || ndc.y < -1.2 || ndc.y > 1.2) {
        // park far offscreen, don't display:none — a zero rect would make `pin`
        // render its content collapsed at the viewport origin
        m.style.left = '-500%';
        m.style.top = '-500%';
        continue;
      }
      m.style.left = ((ndc.x * 0.5 + 0.5) * 100).toFixed(3) + '%';
      m.style.top = ((-ndc.y * 0.5 + 0.5) * 100).toFixed(3) + '%';
    }
  }
  // project a 3D world point → {x,y} as PERCENT of the gl canvas (+ behind flag) —
  // for DOM overlays (interaction prompts, labels) that track a world position.
  const _wsNdc = { x: 0, y: 0, z: 0, w: 0 };
  function worldToScreen(p) {
    projectPoint(viewProj, p, _wsNdc);
    return { x: (_wsNdc.x * 0.5 + 0.5) * 100, y: (-_wsNdc.y * 0.5 + 0.5) * 100, behind: _wsNdc.w <= 0 };
  }
  function playerPos() { const p = controller ? controller.position : camPos; return [p[0], p[1], p[2]]; }

  // ── async load ─────────────────────────────────────────────────────────────
  let alive = true, ready = false;
  const subs = [];
  const sceneMirrors = []; // planar-mirror planes {point,normal}, re-rendered each frame
  const bakeOccluders = []; // world-space triangle soups (non-instanced geometry) for the baked-AO BVH
  const bakeRefine = [];    // { sg, transform, paintSpec } baked meshes to re-bake with occlusion
  const animated = []; // gl-model bob instances, driven in frame()
  const movable = new Map(); // gl-model/gl-box id → draw handles for setModelPosition
  const runtimeInsts = new Map(); // id → uploaded inst, for world.addModel/removeModel (runtime meshes)
  const instanceGroups = new Map(); // id → { draws:[instanced draws], count } for per-instance transform/tint
  const waterVolumes = [];   // gl-water physics: drag/current/buoyancy + fog swap
  let submerged = false, surfaceFog;
  // free camera: override/tween state (cutscenes, NPC shots, room reveals)
  let camOverride = null, camTween = null;
  const _liveTarget = vec3(), _ld = vec3();
  function liveShot() {
    const eye = controller ? controller.eye() : camPos;
    const d = input ? input.lookDir(_ld) : [0, 0, -1];
    return { pos: [eye[0], eye[1], eye[2]], target: [eye[0] + d[0] * 6, eye[1] + d[1] * 6, eye[2] + d[2] * 6] };
  }
  function cameraTween(shot, seconds = 1.4, opts = {}) {
    const from = camOverride ? { pos: [...camOverride.pos], target: [...camOverride.target] } : liveShot();
    camTween = { from, to: shot, t: 0, dur: Math.max(seconds, 0.01), release: !!opts.release };
    ctx.bus.emit(`glscene:${id}:camera`, { state: opts.release ? 'releasing' : 'tweening' });
  }
  const cameraApi = {
    pos: camPos,
    lookDir: (out = vec3()) => (input ? input.lookDir(out) : out),
    set(shot) { camOverride = { pos: [...shot.pos], target: [...shot.target] }; camTween = null; },
    tweenTo(shot, seconds, opts) { cameraTween({ pos: [...shot.pos], target: [...shot.target] }, seconds, opts); },
    release(seconds = 1.0) { if (camOverride || camTween) cameraTween(null, seconds, { release: true }); },
    get active() { return !!(camOverride || camTween); },
  };
  // regions: named AABBs emitting enter/leave for the player + movable entities
  const regions = kids.filter((k) => k.type === 'gl-region' || k.type === 'gl-zone').map((k) => ({
    profile: k.profile || null,
    name: k.name,
    min: k.min || [k.pos[0] - k.size[0] / 2, k.pos[1] - k.size[1] / 2, k.pos[2] - k.size[2] / 2],
    max: k.max || [k.pos[0] + k.size[0] / 2, k.pos[1] + k.size[1] / 2, k.pos[2] + k.size[2] / 2],
    occupants: new Set(),
  }));
  const inBox = (p, r) => p[0] > r.min[0] && p[0] < r.max[0] && p[1] > r.min[1] && p[1] < r.max[1] && p[2] > r.min[2] && p[2] < r.max[2];
  function tickRegions() {
    if (!regions.length) return;
    for (const r of regions) {
      const now = new Set();
      if (controller && inBox(controller.position, r)) now.add('player');
      for (const [mid, m] of movable) {
        const p = m.current || m.anchor;
        if (inBox(p, r)) now.add(mid);
      }
      for (const e of now) if (!r.occupants.has(e)) {
        ctx.bus.emit(`glscene:${id}:region:${r.name}:enter`, { entity: e });
        // gl-zone lighting profile: retune the area feel as the player enters
        if (r.profile && e === 'player') {
          const p = r.profile;
          if (p.fogDensity != null || p.fogColor) fogTo({ density: p.fogDensity ?? env.fog?.density ?? 0, color: p.fogColor || env.fog?.color || [0, 0, 0] }, p.fogSeconds ?? 1.6);
          if (p.ambientFactor != null) zone.ambT = p.ambientFactor;
          if (p.falloffPow != null) zone.falloffT = p.falloffPow;
          if (p.flickerAmount != null) zone.flickT = p.flickerAmount;
        }
      }
      for (const e of r.occupants) if (!now.has(e)) ctx.bus.emit(`glscene:${id}:region:${r.name}:leave`, { entity: e });
      r.occupants = now;
    }
  }
  // tiles: a queryable grid over the XZ plane (combat reach, zone-of-control)
  const tilesSpec = kids.find((k) => k.type === 'gl-tiles');
  const tilesApi = tilesSpec ? (() => {
    const cell = tilesSpec.cell ?? 1, ox = tilesSpec.origin?.[0] ?? 0, oz = tilesSpec.origin?.[1] ?? 0;
    const toTile = (x, z) => [Math.floor((x - ox) / cell), Math.floor((z - oz) / cell)];
    const entityTile = (e) => {
      if (e === 'player') return controller ? toTile(controller.position[0], controller.position[2]) : null;
      const m = movable.get(e);
      return m ? toTile((m.current || m.anchor)[0], (m.current || m.anchor)[2]) : null;
    };
    const entitiesAt = (tx, tz) => {
      const found = [];
      if (controller) { const t = entityTile('player'); if (t && t[0] === tx && t[1] === tz) found.push('player'); }
      for (const mid of movable.keys()) { const t = entityTile(mid); if (t && t[0] === tx && t[1] === tz) found.push(mid); }
      return found;
    };
    // cells N tiles ahead of a position facing yawDeg (the punch query):
    // ahead([x,z], yaw, reach=2, span=1) → entity ids in those cells
    const ahead = (fromXZ, yawDeg, reach = 2, span = 1) => {
      const a = (yawDeg * Math.PI) / 180;
      const fx = -Math.sin(a), fz = -Math.cos(a);          // forward on XZ
      const rx = Math.cos(a), rz = -Math.sin(a);           // right
      const [t0x, t0z] = toTile(fromXZ[0], fromXZ[1]);
      const hits = new Set();
      for (let r = 1; r <= reach; r++) {
        for (let w = -Math.floor(span / 2); w <= Math.floor(span / 2); w++) {
          const cx = t0x + Math.round(fx * r + rx * w);
          const cz = t0z + Math.round(fz * r + rz * w);
          for (const e of entitiesAt(cx, cz)) hits.add(e);
        }
      }
      return [...hits];
    };
    return { cell, toTile, entitiesAt, entityTile, ahead };
  })() : null;
  // 3D positional sound children (uses core/sound's world-space pos3d path)
  const soundSpecs = kids.filter((k) => k.type === 'gl-sound');
  const soundHandles = [];

  (async () => {
    try {
      const collisionMeshes = [];
      const imageCache = new Map(); // texture url → Promise<ImageBitmap>
      const imageFor = (url) => {
        let p = imageCache.get(url);
        if (!p) { p = fetch(url).then((r) => r.blob()).then((bl) => createImageBitmap(bl)); imageCache.set(url, p); }
        return p;
      };
      // average colour of a texture (its 1×1 downsample) = the GI bounce ALBEDO for a textured
      // surface, so colour-bleed works without a per-texel material. Cached by URL.
      const avgCache = new Map();
      const avgColorFor = async (url) => {
        if (avgCache.has(url)) return avgCache.get(url);
        let rgb = [0.6, 0.6, 0.6];
        try {
          const img = await imageFor(url);
          const cv = document.createElement('canvas'); cv.width = 1; cv.height = 1;
          const cx = cv.getContext('2d'); cx.drawImage(img, 0, 0, 1, 1);
          const px = cx.getImageData(0, 0, 1, 1).data;
          rgb = [px[0] / 255, px[1] / 255, px[2] / 255];
        } catch { /* keep grey */ }
        avgCache.set(url, rgb); return rgb;
      };
      // EQUIRECTANGULAR SKYBOX — load the sky photo (if `sky.texture`) and hand the GL texture to
      // the sky pass; the procedural gradient shows until it arrives. wrapS REPEAT (horizon wrap) /
      // wrapT CLAMP (no pole seam); sRGB so it grades like the rest of the frame.
      if (spec.sky && spec.sky.texture) {
        imageFor(spec.sky.texture).then((img) => {
          if (!alive) return;
          renderer.sky.setTexture(createTexture(gl, img, { sRGB: true, sampler: { wrapS: gl.REPEAT, wrapT: gl.CLAMP_TO_EDGE } }));
        }).catch((e) => console.warn('[gl-scene] sky texture failed:', spec.sky.texture, e));
      }
      let loaded = 0;
      // expand gl-procgen children into generated upload entries (terrain + scattered
      // ecosystem instances), then upload them through the SAME path as models.
      const genEntries = [];
      if (procgenSpecs.length) {
        const P = await import('../core/gl/procgen3d/index.js');
        if (!alive) return;
        for (const ps of procgenSpecs) {
          try { expandProcgen(P, ps, genEntries); }
          catch (e) { console.error('[gl-scene] gl-procgen expand failed:', e); }
        }
      }
      const uploadList = modelSpecs.concat(genEntries);
      // does any baked-paint mesh want AO/cast-shadow occlusion? (drives occluder collection)
      const anyBakeAO = uploadList.some((m) => { const ps = m.paint || (m.bake ? { bake: m.bake } : null); return ps && ps.bake && (ps.bake === true || ps.bake.occlusion !== false); });
      // does any mesh want BAKED RAYTRACING (GI)? → occluders also carry an albedo (colour bleed)
      const anyGI = uploadList.some((m) => { const ps = m.paint || (m.bake ? { bake: m.bake } : null); const b = ps && ps.bake; return !!(b && typeof b === 'object' && b.gi); });
      // PARALLEL PREFETCH — warm the per-URL caches for every DISTINCT model + gl-box
      // texture concurrently. loadGLTF/loadGLB/imageFor cache by URL, so the sequential
      // upload loop below then resolves instantly from cache instead of stalling on each
      // network+parse in turn (e.g. a 14-model meadow: ~all-at-once vs ~14×600ms serial).
      {
        const modelUrls = [...new Set(uploadList.filter((m) => !m._sg && m.type !== 'gl-box' && m.src).map((m) => m.src))];
        const texUrls = [...new Set(uploadList.filter((m) => m.type === 'gl-box' && m.texture).map((m) => m.texture))];
        let warmed = 0; const total = modelUrls.length + texUrls.length;
        const tick = () => { if (total) { warmed++; ctx.bus.emit(`glscene:${id}:loading`, { pct: warmed / total }); ctx.bus.emit('loader:progress', warmed / total); } };
        await Promise.all([
          ...modelUrls.map((u) => (u.endsWith('.gltf') ? loadGLTF(u) : loadGLB(u)).then(tick, (e) => { console.error('[gl-scene] preload', u, e?.message); tick(); })),
          ...texUrls.map((u) => imageFor(u).then(tick, tick)),
        ]);
        if (!alive) return;
      }
      for (const ms of uploadList) {
        let sg;
        if (ms._sg) {
          sg = ms._sg; // pre-generated SceneGraph (gl-procgen)
        } else if (ms.type === 'gl-box') {
          sg = boxScene({
            size: ms.size, uvScale: ms.uvScale, uvMode: ms.uvMode, color: ms.color, doubleSided: ms.doubleSided,
            emissive: ms.emissive, roughness: ms.roughness, metallic: ms.metallic, subdivide: ms.subdivide,
            image: ms.texture ? await imageFor(ms.texture) : null,
            normalImage: ms.normalTex ? await imageFor(ms.normalTex) : null, // bump map (grout grooves)
            mrImage: ms.roughTex ? await imageFor(ms.roughTex) : null,       // metallic-roughness map
            heightImage: ms.heightTex ? await imageFor(ms.heightTex) : null, // parallax-occlusion height map (white=high)
            pom: ms.pom, // { scale, layers:[min,max] } — POM depth + march steps
            aoImage: ms.aoTex ? await imageFor(ms.aoTex) : null, // baked cavity/AO map (tiling, uv0; low=occluded)
            aoStrength: ms.aoStrength, // 0..1
          });
        } else if (ms.type === 'gl-sphere') {
          sg = sphereScene({
            radius: ms.radius, size: ms.size, segments: ms.segments, rings: ms.rings,
            color: ms.color, emissive: ms.emissive, roughness: ms.roughness, metallic: ms.metallic, doubleSided: ms.doubleSided,
          });
        } else if (ms.type === 'gl-text') {
          sg = textScene(ms.text, { height: ms.height || ms.size || 1, color: ms.color, emissive: ms.emissive, font: ms.font }).sceneGraph; // glyph-atlas quads
        } else {
          sg = ms.src.endsWith('.gltf') ? await loadGLTF(ms.src) : await loadGLB(ms.src);
        }
        if (!alive) return;
        let transform = null;
        if (ms.position || ms.scale || ms.rotation) {
          const s = ms.scale ?? 1;
          // rotation: [x°,y°,z°] euler degrees, or [x,y,z,w] quaternion
          let rot = ms.rotation || [0, 0, 0, 1];
          if (rot.length === 3) {
            const r = Math.PI / 180;
            rot = quatFromEuler(rot[1] * r, rot[0] * r, rot[2] * r);
          }
          transform = m4fromTRS(
            Float32Array.from(ms.position || [0, 0, 0]),
            Float32Array.from(rot),
            Float32Array.from(Array.isArray(s) ? s : [s, s, s]),
          );
        }
        let lightmap = null;
        if (ms.lightmap) {
          const img = await createImageBitmap(await (await fetch(ms.lightmap)).blob());
          if (!alive) return;
          lightmap = createTexture(gl, img, { sRGB: false });
        }
        // instances: [{position, rotation?, scale?} | [x,y,z], …] → ONE GPU-
        // instanced draw per primitive instead of N copies (large scenes).
        // Instanced entries are static: no id/bob (use plain entries for those).
        let instances = null;
        if (Array.isArray(ms.instances) && ms.instances.length) {
          const rr = Math.PI / 180;
          instances = ms.instances.map((it) => {
            const o = Array.isArray(it) ? { position: it } : it;
            let irot = o.rotation || [0, 0, 0, 1];
            if (irot.length === 3) irot = quatFromEuler(irot[1] * rr, irot[0] * rr, irot[2] * rr);
            const sc = o.scale ?? 1;
            return m4fromTRS(
              Float32Array.from(o.position || [0, 0, 0]),
              Float32Array.from(irot),
              Float32Array.from(Array.isArray(sc) ? sc : [sc, sc, sc]),
            );
          });
          if (ms.id || ms.bob) console.warn('[gl-scene] `instances` entries are static — id/bob ignored:', ms.id);
        }
        // VERTEX PAINTING: hand-painted / baked-once per-vertex light & shadow for
        // static scenes. `paint`/`bake` → fill prim.colors; `unlit` (default) renders
        // with NO dynamic light loop (core/gl/vertex-paint.js).
        const paintSpec = ms.paint || (ms.bake ? { bake: ms.bake } : null);
        if (paintSpec) paintSceneGraph(sg, transform, paintSpec, lights);
        const inst = renderer.uploadScene(sg, {
          transform, lightmap, instances, instanceTint: !!ms.instanceTint, instanceUVs: ms.instanceUVs, color: ms.color, roughness: ms.roughness,
          opacity: ms.opacity, ambient: ms.ambient, specular: ms.specular, metallic: ms.metallic,
          emissive: ms.emissive, emissiveIntensity: ms.emissiveIntensity,
          reflective: ms.reflective, mirror: ms.mirror, glass: ms.glass,
          sun: ms.sun, exclude: ms.excludeNodes,
          // unlit (baked) is the default for pure light/shadow painting; a `material`
          // (shininess) paint needs the LIT path, so it defaults to NOT baked.
          baked: paintSpec ? (paintSpec.unlit ?? !paintSpec.material) : undefined,
          capsuleOcclusion: !!(ms.specularBlockers || ms.capsuleOcclusion), // fake reflection via gl-blocker capsules
        });
        // BAKED-AO: collect this (non-instanced) mesh as an occluder + as a refine target if it
        // has analytic baked LIGHT — after the loop we rebuild a BVH and re-bake with AO + shadows.
        // EMISSIVE meshes are light SOURCES (lamp shades, neon tubes) → never occlude (else a
        // shade enclosing its bulb blocks the lamp's own light → black room).
        if (anyBakeAO && !instances && !ms.emissive) {
          // COARSE 12-tri box occluders (each mesh's AABB) → a tiny BVH that ray-casts fast.
          // EXACT for gl-box (the dominant geometry in interior vertex-lit scenes); a coarse
          // proxy for models (small props), which is fine — the bake stays cheap + low-end-safe.
          // GI colour-bleed: this occluder bounces its surface colour — explicit `color`/
          // `bakeAlbedo`, else the texture's average, else neutral grey.
          let occAlbedo = null;
          if (anyGI) occAlbedo = ms.color || ms.bakeAlbedo || (ms.texture ? await avgColorFor(ms.texture) : null) || [0.6, 0.6, 0.6];
          for (const node of sg.nodes) {
            if (node.meshIndex < 0) continue;
            let w = node.worldMatrix;
            if (transform) w = m4mul(transform, w, mat4());
            for (const p of sg.meshes[node.meshIndex].primitives) if (p.aabb) bakeOccluders.push({ ...boxOccluderTris(p.aabb), world: w, albedo: occAlbedo });
          }
          if (paintSpec && paintSpec.bake && (paintSpec.bake === true || paintSpec.bake.occlusion !== false)) bakeRefine.push({ sg, transform, paintSpec });
        }
        // id on an INSTANCED model → an addressable instance GROUP (per-instance
        // transform/tint via world.instanceGroup(id)). Distinct from the movable
        // path below (which is for non-instanced id'd models).
        if (ms.id && instances) {
          const idraws = inst.draws.filter((d) => d.instanced);
          if (idraws.length) instanceGroups.set(ms.id, { draws: idraws, count: idraws[0].instanced.count, glyphs: ms._glyphLayout?.glyphs || null, origin: ms.position || [0, 0, 0] });
        }
        // id: registers the instance as movable/rotatable via
        // world.setModelTransform(id, {position, rotation}). Multiple children
        // sharing an id form ONE rigid group (e.g. a tree's trunk + canopy)
        // pivoting about the FIRST registration's anchor (override: ms.anchor).
        if (ms._fixture) ms._fixture.mats = inst.draws.map((d) => d.mat);
        if (ms.id && !instances) {
          const handles = inst.draws.map((d) => {
            d.movable = true; d.restFrame = 0; // can move via setModelTransform; sleeps→auto-batches after idle
            return { d, base: Float32Array.from(d.world), bMin: Float32Array.from(d.aabb.min), bMax: Float32Array.from(d.aabb.max) };
          });
          const existing = movable.get(ms.id);
          if (existing) existing.draws.push(...handles);
          else movable.set(ms.id, { anchor: ms.anchor || ms.position || [0, 0, 0], draws: handles });
        }
        // Register EVERY child's draws by manifest index (id'd or not) so the
        // IDE can debug-select id-less objects by their path. Uses world aabb.
        if (ms._ci != null && inst && inst.draws && inst.draws.length) {
          const arr = meshByChild.get(ms._ci) || [];
          for (const d of inst.draws) arr.push(d);
          meshByChild.set(ms._ci, arr);
        }
        // bob: {amp, speed, phase?} — oscillate the instance up/down each frame
        if (ms.bob && !instances) {
          animated.push({
            amp: ms.bob.amp ?? 0.3, speed: ms.bob.speed ?? 1, phase: ms.bob.phase ?? 0,
            draws: inst.draws.map((d) => { d.movable = true; d.noSleep = true; return { d, baseY: d.world[13], aabbMinY: d.aabb.min[1], aabbMaxY: d.aabb.max[1] }; }),
          });
        }
        if (ms.collision) {
          const excluded = ms.excludeNodes ? new Set(ms.excludeNodes) : null;
          const dynamic = ms.collision === 'dynamic' && ms.id;   // toggleable (solid door)
          const bucket = dynamic ? [] : collisionMeshes;
          for (const node of sg.nodes) {
            if (node.meshIndex < 0) continue;
            if (excluded && excluded.has(node.name)) continue;
            let world = node.worldMatrix;
            if (transform) world = m4mul(transform, world, mat4());
            for (const p of sg.meshes[node.meshIndex].primitives) {
              bucket.push({ positions: p.positions, indices: p.indices, world });
            }
          }
          if (dynamic) { dynColl.set(ms.id, bucket); dynOn.add(ms.id); }  // dynamic colliders start SOLID
        }
        loaded++;
        ctx.bus.emit(`glscene:${id}:loading`, { pct: loaded / uploadList.length });
        ctx.bus.emit('loader:progress', loaded / uploadList.length);
      }
      // gl-foliage children: instanced grass patches (density = blades/m²)
      for (const fs of kids) if (fs.type === 'gl-foliage') renderer.foliage.add(fs);
      // gl-animegrass (alias gl-anime-ground): textured "blowing anime grass" GROUND.
      // collision:true → its noise heightfield joins the BVH so the player WALKS the hills.
      for (const ag of kids) if (ag.type === 'gl-animegrass' || ag.type === 'gl-anime-ground') {
        const gr = renderer.animeGround.add(ag);
        if (gr && gr.collisionMesh) collisionMeshes.push(gr.collisionMesh);
      }
      // gl-shaft children: volumetric light beams
      for (const sh of kids) if (sh.type === 'gl-shaft') renderer.shafts.add(sh);
      // gl-water children: render surface + physics volume + underwater fog
      for (const ws of waterSpecs) {
        renderer.water.add(ws);
        if (ws.caustics !== false && !env.caustics) {
          const c = typeof ws.caustics === 'object' ? ws.caustics : {};
          env.caustics = {
            area: ws.area, level: ws.level ?? 0,
            strength: c.strength ?? 0.45, scale: c.scale ?? 1.4, depthFade: c.depthFade ?? 0.35,
          };
        }
        waterVolumes.push({
          min: [ws.area[0], (ws.level ?? 0) - (ws.depth ?? 2.5), ws.area[1]],
          max: [ws.area[2], ws.level ?? 0, ws.area[3]],
          level: ws.level ?? 0,
          flow: ws.flow || [0, 0],
          flowForce: ws.flowForce ?? 2.5,
          drag: ws.drag ?? 3.2,
          buoyancy: ws.buoyancy ?? 19,
          underFog: ws.underFog || { density: 0.3, color: [ws.color?.[0] ?? 0.05, (ws.color?.[1] ?? 0.2) * 0.5, (ws.color?.[2] ?? 0.25) * 0.5] },
        });
      }
      if (spec.particles?.texture) { // optional sprite texture for ALL particles
        const img = await createImageBitmap(await (await fetch(spec.particles.texture)).blob());
        if (!alive) return;
        particles.setTexture(img);
      }
      staticColl = collisionMeshes;                              // kept for dynamic-collider rebuilds
      const allColl = collisionMeshes.concat(...[...dynOn].map((id) => dynColl.get(id) || []));
      if (allColl.length) bvh = buildBVH(triangleSoup(allColl));
      if (bvh) bakeLightOcclusion();
      // ── BAKED-AO REFINE — re-bake every `bake:` mesh WITH ambient occlusion + cast shadows
      // (BVH rays) for ~2× the vertex-lighting quality, then re-upload the colours. All CPU,
      // ONCE at load → the runtime render stays unlit/zero-cost (low-end-GPU safe). Bounded by
      // a vertex budget so the load-time bake can't stall on huge scenes; opt out per mesh with
      // `bake:{ occlusion:false }`.
      // count occluder triangles up-front: if the scene is huge (big outdoor scene), skip the
      // whole occlusion bake — even building the BVH would stall the load. AO matters most for
      // INTERIORS (corners/contacts) anyway; raise `config.bakeOcclusionTris` to force it.
      // ALL-OR-NOTHING: estimate total cost up front (refine vertices). If the whole scene
      // won't fit the budget, SKIP occlusion entirely (keep the clean analytic bake) rather
      // than a patchy partial. Big outdoor scenes (many trees) stay analytic — AO matters most
      // for interiors anyway. `config.bakeOcclusionVerts` raises the cap; `bake:{occlusion:false}` opts a mesh out.
      let totalVerts = 0; for (const t of bakeRefine) for (const me of t.sg.meshes) for (const p of me.primitives) totalVerts += p.positions.length / 3;
      const VERT_CAP = spec.bakeOcclusionVerts ?? 160000;
      if (bakeRefine.length && bakeOccluders.length && totalVerts <= VERT_CAP) {
        const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
        const t0 = now();
        // GI ray budget — path-traced GI casts ~samples×bounces×(1 segment + shadow rays) per
        // vertex; clamp samples so a big/over-sampled scene can't stall the LOAD bake (low-end safe).
        if (anyGI) {
          const GI_RAY_CAP = spec.bakeGIRays ?? 6000000;
          // rays per segment = the segment ray itself + one shadow ray per active light
          const lightFactor = 1 + ((lights.sunColor[0] + lights.sunColor[1] + lights.sunColor[2]) > 1e-4 ? 1 : 0) + (lights.points ? lights.points.length : 0);
          let giRays = 0; const giList = [];
          for (const t of bakeRefine) {
            const b = t.paintSpec.bake, g = b && typeof b === 'object' && b.gi; if (!g) continue;
            const samples = g === true ? 12 : (g.samples ?? 12), bounces = Math.max(1, g === true ? 1 : (g.bounces ?? 1));
            let v = 0; for (const me of t.sg.meshes) for (const p of me.primitives) v += p.positions.length / 3;
            giRays += v * samples * bounces * lightFactor; giList.push({ t, samples });
          }
          if (giRays > GI_RAY_CAP) {
            const scale = GI_RAY_CAP / giRays;
            for (const e of giList) { const b = e.t.paintSpec.bake, g = b.gi === true ? (b.gi = {}) : b.gi; g.samples = Math.max(4, Math.floor(e.samples * scale)); }
            console.warn(`[gl-scene] GI samples scaled ×${scale.toFixed(2)} — ${(giRays / 1e6).toFixed(1)}M rays exceeded budget ${(GI_RAY_CAP / 1e6).toFixed(0)}M (raise config.bakeGIRays)`);
          }
        }
        const occBVH = buildBVH(triangleSoup(bakeOccluders), anyGI ? triangleSoupAlbedo(bakeOccluders) : undefined);
        const raycast = (o, d, md) => raycastBVH(occBVH, o, d, md);
        for (const t of bakeRefine) { paintSceneGraph(t.sg, t.transform, t.paintSpec, lights, raycast); renderer.reuploadColors(t.sg); }
        const bakeMs = now() - t0;
        el.__bakeStats = { ms: Math.round(bakeMs), meshes: bakeRefine.length, verts: totalVerts, gi: anyGI };  // headless perf hook
        console.log(`[gl-scene] baked ${anyGI ? 'GI+' : ''}AO/shadows: ${bakeRefine.length} meshes, ${totalVerts} verts in ${bakeMs.toFixed(0)}ms`);
      } else if (bakeRefine.length && totalVerts > VERT_CAP) {
        console.warn(`[gl-scene] baked-AO skipped — ${totalVerts} verts exceeds budget ${VERT_CAP} (large scene kept analytic; raise config.bakeOcclusionVerts to force)`);
      }
      // REFLECTION PROBE — bake a cubemap once (static scene) if a `gl-reflection-probe` is
      // declared OR any material is mirror/glass/reflective. Mirror/glass surfaces then
      // sample the room via reflect(-V,N). (core/gl/reflection.js)
      const probeSpec = reflProbeSpec;
      if (probeSpec || uploadList.some((m) => m.reflective !== undefined || m.glass)) {
        const pp = probeSpec?.pos || probeSpec?.position || [0, 1.5, 0];
        renderer.bakeReflectionProbe({
          pos: Array.from(pp), size: probeSpec?.size || 256,
          bounds: probeSpec?.bounds || null,
          aniso: probeSpec?.aniso === true ? 0.5 : (probeSpec?.aniso || 0),
        }, lights, env);
      }
      // PLANAR MIRRORS — re-rendered live each frame. Plane = the mirror's facing normal
      // (default +Z, override with `normal:[x,y,z]`) through its position.
      for (const m of uploadList) if (m.mirror) {
        sceneMirrors.push({ point: Array.from(m.position || [0, 0, 0]), normal: Array.from(m.normal || [0, 0, 1]) });
      }
      // AMBIENT CUBES — bake one 6-color irradiance probe per `gl-ambient-probe`, then
      // assign each draw its nearest probe (per-draw indirect ambient; ~0 per-frame cost).
      if (ambientProbeSpecs.length) {
        renderer.bakeAmbientProbes(ambientProbeSpecs.map((p) => ({
          pos: Array.from(p.pos || p.position || [0, 1.5, 0]),
          intensity: p.intensity ?? 1, size: p.size,
        })), lights, env);
      }
      // dynamic rigid bodies collide with the real level (stairs/ramps/walls),
      // not just the flat ground plane. + declarative joints from gl-joint kids.
      if (phys3d && bvh) phys3d.setStaticBVH(bvh);
      if (phys3d) {
        // the child's `type` is 'gl-joint'; its joint KIND is `jtype` (or `kind`)
        for (const js of kids.filter((k) => k.type === 'gl-joint')) phys3d.addJoint({ ...js, type: js.jtype || js.kind || 'distance' });
      }
      if (fpsSpec && bvh) {
        // The controller resolves itself against dynamic props (stand on / not
        // pass through) via getBodies. It does NOT impulse them — instead it's
        // mirrored into physics3d as a KINEMATIC capsule (below) so the SOLVER
        // pushes crates with real momentum (smooth) rather than a tuned shove.
        const ctlSpec = (phys3d && fpsSpec.pushBodies !== false)
          ? { ...fpsSpec, getBodies: () => phys3d.list }
          : fpsSpec;
        controller = createController(bvh, ctlSpec);
        if (fpsSpec.position) controller.setPosition(...fpsSpec.position);
        controller.setWater(waterVolumes); // controller owns water response (swim / buoyancy)
        // KINEMATIC player body — the controller AS a rigid body in the physics
        // world (same idea as gl-car). It spans torso→head (base RAISED ~0.55m
        // above the feet) so it shoves crates at body height with real momentum
        // but never squirts out what you're standing ON. Opt out: pushBodies:false.
        if (phys3d && fpsSpec.pushBodies !== false) {
          const pr = (fpsSpec.radius ?? 0.4) * 0.95;
          const fullH = fpsSpec.height ?? 1.8;
          playerCapBase = Math.min(0.55, fullH * 0.3);
          const topY = fullH - pr;
          playerCapHalf = Math.max(0.05, (topY - playerCapBase) / 2);
          playerCapOff = (playerCapBase + topY) / 2;       // center offset above feet
          playerBodyId = '__playerCap';
          phys3d.addBody({ id: playerBodyId, shape: 'capsule', radius: pr, halfHeight: playerCapHalf,
            kinematic: true, position: [controller.position[0], controller.position[1] + playerCapOff, controller.position[2]] });
        }
      }
      for (const ss of soundSpecs) {
        if (!ctx.sound) break;
        const h = ctx.sound.loop(ss.src, {
          pos3d: ss.pos, volume: ss.volume ?? 1, ref: ss.ref, rolloff: ss.rolloff, id: ss.id,
        });
        if (h) soundHandles.push(h);
      }
      // SHADER WARM-UP (during boot/load, under the loader): render one throwaway
      // scissored frame from a camera that frames the scene, so the driver finalizes
      // every program now — the first VISIBLE frame (and gl-transition reveal) never stalls.
      try {
        const wp = camSpec?.pos || (controller ? Array.from(controller.eye()) : [0, 4, 16]);
        const wt = camSpec?.target || [0, 1, 0];
        camPos.set(wp);
        m4lookAt(camPos, Float32Array.from(wt), vec3(0, 1, 0), view);
        m4mul(proj, view, viewProj);
        renderer.warmUp({ view, proj, pos: camPos }, lights, env);
      } catch (e) { console.warn('[gl-scene] shader warm-up skipped:', e?.message); }

      ready = true;
      ctx.bus.emit(`glscene:${id}:ready`, { models: loaded, collisionTris: bvh ? bvh.triCount : 0 });
    } catch (e) {
      console.error('[gl-scene] load failed:', e);
      ctx.bus.emit(`glscene:${id}:error`, { message: String(e) });
    }
  })();

  // ── light occlusion bake ───────────────────────────────────────────────────
  // For each STATIC light × STATIC draw: can any ray from the light reach the
  // draw's AABB without a wall in the way? If not, clear that light's bit in
  // the draw's lightMask. One-time cost at load (a few ms of BVH raycasts);
  // result: light spills through doorways but never through solid walls.
  // Dynamic lights (flashlight, burst flashes) and movable/bobbing instances
  // keep full masks — they're local and short-range anyway.
  function bakeLightOcclusion() {
    const staticIdx = [];
    lights.points.forEach((pl, i) => { if (!pl.follow) staticIdx.push(i); });
    if (!staticIdx.length) return;
    const skip = new Set();
    for (const m of movable.values()) for (const h of m.draws) skip.add(h.d);
    for (const a of animated) for (const h of a.draws) skip.add(h.d);
    const dir = vec3(), sample = vec3();
    for (const inst of renderer.instances) {
      for (const d of inst.draws) {
        if (skip.has(d)) continue;
        const { min, max } = d.aabb;
        // sample points: center + 4 alternating corners, nudged inward
        const pts = [
          d.center,
          [min[0] * 0.9 + max[0] * 0.1, min[1] * 0.9 + max[1] * 0.1, min[2] * 0.9 + max[2] * 0.1],
          [max[0] * 0.9 + min[0] * 0.1, min[1] * 0.9 + max[1] * 0.1, max[2] * 0.9 + min[2] * 0.1],
          [min[0] * 0.9 + max[0] * 0.1, max[1] * 0.9 + min[1] * 0.1, max[2] * 0.9 + min[2] * 0.1],
          [max[0] * 0.9 + min[0] * 0.1, max[1] * 0.9 + min[1] * 0.1, min[2] * 0.9 + max[2] * 0.1],
        ];
        const halfDiag = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2;
        for (const li of staticIdx) {
          const lp = lights.points[li].pos;
          let reached = false;
          for (const pt of pts) {
            sample[0] = pt[0]; sample[1] = pt[1]; sample[2] = pt[2];
            dir[0] = sample[0] - lp[0]; dir[1] = sample[1] - lp[1]; dir[2] = sample[2] - lp[2];
            const dist = Math.hypot(dir[0], dir[1], dir[2]) || 1;
            dir[0] /= dist; dir[1] /= dist; dir[2] /= dist;
            // a hit closer than (dist - local size) means a wall blocks the path;
            // hitting the draw's own surface near the target still counts as reached
            const hit = raycastBVH(bvh, lp, dir, dist - Math.min(halfDiag, dist * 0.5) - 0.05);
            if (!hit) { reached = true; break; }
          }
          if (!reached) d.lightMask &= ~(1 << li);
        }
      }
    }
  }

  // droplet spray at the eye when crossing the waterline (both directions)
  function crossingSplash(wv) {
    if (!controller) return;
    const eye = controller.eye();
    const d = input ? input.lookDir(_followDir) : [0, 0, -1];
    burstFX({
      pos: [eye[0] + d[0] * 0.4, eye[1], eye[2] + d[2] * 0.4],
      count: 50, spread: 2.6, posJitter: 0.5,
      speed: [0.6, 2.8], life: [0.18, 0.55], size: [0.05, 0.008],
      colorA: [0.5, 0.8, 0.85], colorB: [0.15, 0.35, 0.4], gravity: [0, -6, 0],
    });
  }

  // ── simulation (fixed) ─────────────────────────────────────────────────────
  function physicsTick(dt) {
    if (phys3d) { // rigid bodies run with or without an FPS controller
      // drive the player's KINEMATIC capsule to the controller (1-tick lag is
      // fine) so the solver transfers real momentum to crates it walks into.
      if (playerBodyId && controller) {
        phys3d.moveKinematic(playerBodyId,
          [controller.position[0], controller.position[1] + playerCapOff, controller.position[2]], null, dt);
      }
      phys3d.step(dt);
      for (const b of phys3d.bodies.values()) {
        if ((b.dynamic || b.kinematic) && !b.sleeping && movable.has(b.id)) {
          setModelTransform(b.id, { position: b.position, rotation: b.quat, scale: b.scaleVisual }); // scale = a resized (growing) body
        }
      }
    }
    if (!ready || !controller || !input) return;
    // The controller owns ALL body physics, including water response (swim / buoyancy /
    // drag / current) — it was handed the gl-water volumes via setWater() at load. The
    // scene only does scene-level water below (fog swap + submerged/surfaced events).
    // `_inp` is reused by the footstep-state block below (sprint check), so snapshot it.
    const _inp = input.getInput();
    controller.update(dt, _inp);
    // locomotion state → footstep bus events: glscene:<id>:foot:walk|run|stop,
    // emitted only on CHANGE so play-loop footstep sounds can start/swap/stop.
    // HYSTERESIS (start>0.8, stop<0.45): walking into a wall makes speed oscillate
    // near a single threshold → it would chatter walk↔stop and stutter the loop;
    // the dead-band holds the current state through the wobble. Airborne = stop.
    {
      const vv = controller.velocity, sp = Math.hypot(vv[0], vv[2]);
      let st = locoState;
      if (!controller.onGround) st = 'stop';
      else if (sp > 0.8) st = _inp.sprint ? 'run' : 'walk';
      else if (sp < 0.45) st = 'stop';
      else if (locoState !== 'stop') st = _inp.sprint ? 'run' : 'walk';   // in-band & moving: honor sprint
      if (st !== locoState) { locoState = st; ctx.bus.emit(`glscene:${id}:foot:${st}`, { state: st }); }
    }
    // Move a controller-attached visual body (id from fpsSpec.bodyId) —
    // position is updated inline with the capsule so the body never lags.
    // The body's facing quat is written by game code (third-person-cam, etc.)
    // into el.world._bodyQuat each frame.
    if (fpsSpec.bodyId && movable.has(fpsSpec.bodyId)) {
      const bq = el.world ? el.world._bodyQuat : null;
      setModelTransform(fpsSpec.bodyId, {
        position: [controller.position[0], controller.position[1], controller.position[2]],
        rotation: bq || null,
      });
    }
    // water volumes — SCENE concern only: swap to underwater fog at the eye. (Body
    // forces — swim/buoyancy/drag/current — live in the controller, see setWater().)
    const eye = controller.eye();
    let eyeUnder = false;
    for (const wv of waterVolumes) {
      if (eye[0] > wv.min[0] && eye[0] < wv.max[0] && eye[2] > wv.min[2] && eye[2] < wv.max[2] && eye[1] < wv.level) {
        eyeUnder = true;
        if (!submerged) { surfaceFog = env.fog; env.fog = wv.underFog; }
      }
    }
    tickRegions();
    if (submerged !== eyeUnder) {
      submerged = eyeUnder;
      if (!submerged && surfaceFog) env.fog = surfaceFog;
      ctx.bus.emit(`glscene:${id}:` + (submerged ? 'submerged' : 'surfaced'));
    }
    // fell into the void (pits) → respawn at start
    if (fpsSpec.killY !== undefined && controller.position[1] < fpsSpec.killY) {
      controller.setPosition(...(fpsSpec.position || [0, 1, 0]));
      ctx.bus.emit(`glscene:${id}:fell`);
    }
  }
  const loop = getLoop('main');
  let accum = 0;
  if (loop) subs.push(loop.add(({ dt }) => physicsTick(dt), { phase: 'physics', kind: 'fixed' }));

  // ── render (own rAF, pixel-stage precedent) ────────────────────────────────
  let raf = 0, last = 0;
  const _followDir = vec3();
  const _sunNdc = { x: 0, y: 0, z: 0, w: 0 };
  // place each projected contact shadow on its ground plane (caster XZ → groundY),
  // faded + enlarged by the caster's height above it. Pushed to the renderer pass.
  function updateProjShadows() {
    if (!projShadowList.length) return;
    let n = 0;
    for (const s of projShadowList) {
      let p = s.pos;
      if (s.target) { const m = movable.get(s.target); p = m ? (m.current || m.anchor) : null; }
      if (!p) continue;
      const height = Math.max(0, p[1] - s.groundY);
      const fade = 1 - Math.min(height / s.maxHeight, 1);
      if (fade <= 0.001) continue;
      const r = s.radius * (1 + height * 0.2);
      renderer.projShadows.set(n, p[0], s.groundY + 0.02, p[2], r, 0, 1, 0, s.dark * fade);
      n++;
    }
    renderer.projShadows.setCount(n);
  }

  function frame(t) {
    if (!alive) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min((t - last) / 1000 || 0, 0.1);
    last = t;
    if (input) { // a ui-stack modal (menu/dialog/radial) freezes look + keys
      const want = manualFreeze || modalOpen();
      if (input.frozen !== want) input.frozen = want;
    }
    if (!loop) { // no game-loop on the page → internal fixed accumulator
      accum += dt;
      while (accum >= FIXED_DT) { physicsTick(FIXED_DT); accum -= FIXED_DT; }
    }
    if (!fill && (el.clientWidth * resScale | 0) !== canvas.width) relayout();

    if (HB) headBob(dt);                                   // horror walk feel → camFX
    if (controller && input) {
      const ce = controller.eye();
      _fxEye[0] = ce[0] + camFX.offset[0]; _fxEye[1] = ce[1] + camFX.offset[1]; _fxEye[2] = ce[2] + camFX.offset[2];
      input.getViewMatrix(_fxEye, view);
      camPos.set(_fxEye);
    } else if (input) {
      input.getViewMatrix(camPos, view);
    }
    if (camFX.roll) { // view-space lean: view' = Rz(roll) · view
      const cr = Math.cos(camFX.roll), sr = Math.sin(camFX.roll);
      m4identity(_rollM);
      _rollM[0] = cr; _rollM[1] = sr; _rollM[4] = -sr; _rollM[5] = cr;
      m4mul(_rollM, view, view);
    }
    // free-camera override: tweened shots win over the live fps view
    if (camTween) {
      camTween.t = Math.min(camTween.t + dt / camTween.dur, 1);
      const k0 = camTween.t, k = k0 * k0 * (3 - 2 * k0);
      const dst = camTween.release ? liveShot() : camTween.to;
      const cp = camTween.from.pos, ct = camTween.from.target;
      camOverride = {
        pos: [cp[0] + (dst.pos[0] - cp[0]) * k, cp[1] + (dst.pos[1] - cp[1]) * k, cp[2] + (dst.pos[2] - cp[2]) * k],
        target: [ct[0] + (dst.target[0] - ct[0]) * k, ct[1] + (dst.target[1] - ct[1]) * k, ct[2] + (dst.target[2] - ct[2]) * k],
      };
      if (camTween.t >= 1) {
        const wasRelease = camTween.release;
        camTween = null;
        if (wasRelease) { camOverride = null; ctx.bus.emit(`glscene:${id}:camera`, { state: 'live' }); }
        else ctx.bus.emit(`glscene:${id}:camera`, { state: 'held' });
      }
    }
    if (camOverride) {
      camPos.set(camOverride.pos);
      m4lookAt(camPos, Float32Array.from(camOverride.target), vec3(0, 1, 0), view);
    }
    // 3D audio listener rides the camera
    if (ctx.sound?.listener3d) {
      const fw = camOverride
        ? v3normalize(vec3(camOverride.target[0] - camPos[0], camOverride.target[1] - camPos[1], camOverride.target[2] - camPos[2]))
        : (input ? input.lookDir(_ld) : [0, 0, -1]);
      ctx.sound.listener3d(camPos, fw);
    }
    // flashlight: held at the (right) hand, beam aimed at the surface point the
    // camera is looking at (raycast vs level BVH) so beam and aim converge
    if (input) {
      for (const pl of lights.points) {
        if (!pl.follow) continue;
        const d = input.lookDir(_followDir);
        const yaw = input.yaw;
        // hand = eye + right*0.22 - up*0.18 + fwd*offset
        const hx = camPos[0] + Math.cos(yaw) * 0.22 + d[0] * pl.followDist;
        const hy = camPos[1] - 0.18 + d[1] * pl.followDist;
        const hz = camPos[2] - Math.sin(yaw) * 0.22 + d[2] * pl.followDist;
        pl.pos[0] = hx; pl.pos[1] = hy; pl.pos[2] = hz;
        if (pl.cone) {
          // aim point: what the CAMERA centers on (or 20m out if nothing hit)
          const hit = bvh ? raycastBVH(bvh, camPos, d, 60) : null;
          const tx = hit ? hit.point[0] : camPos[0] + d[0] * 20;
          const ty = hit ? hit.point[1] : camPos[1] + d[1] * 20;
          const tz = hit ? hit.point[2] : camPos[2] + d[2] * 20;
          let ax = tx - hx, ay = ty - hy, az = tz - hz;
          const al = Math.hypot(ax, ay, az) || 1;
          pl.dir = pl.dir || [0, 0, -1];
          pl.dir[0] = ax / al; pl.dir[1] = ay / al; pl.dir[2] = az / al;
        }
      }
    }
    if (fogTween) {
      fogTween.t = Math.min(fogTween.t + dt / fogTween.dur, 1);
      const k = fogTween.t * fogTween.t * (3 - 2 * fogTween.t); // smoothstep
      const { from, to } = fogTween;
      if (!env.fog) env.fog = { density: from.density, color: [...from.color] }; // fog may have been nulled mid-tween (enableLiminalMode(false))
      env.fog.density = from.density + (to.density - from.density) * k;
      for (let c = 0; c < 3; c++) env.fog.color[c] = from.color[c] + (to.color[c] - from.color[c]) * k;
      if (fogTween.t >= 1) fogTween = null;
    }

    // drive bob animations (translation only — normals/culling stay valid)
    for (const a of animated) {
      const dy = Math.sin(t / 1000 * a.speed * Math.PI * 2 + a.phase) * a.amp;
      for (const { d, baseY, aabbMinY, aabbMaxY } of a.draws) {
        d.world[13] = baseY + dy;
        d.aabb.min[1] = aabbMinY + dy - 0.01;
        d.aabb.max[1] = aabbMaxY + dy + 0.01;
        d.center[1] = (d.aabb.min[1] + d.aabb.max[1]) / 2;
      }
    }

    // continuous emitters (gl-emitter children)
    const ts = t / 1000;
    // fixture flicker (deterministic) + zone-profile lerps
    if (zone.ambT !== zone.amb || zone.falloffT !== zone.falloff || zone.flickT !== zone.flick) {
      zone.amb += (zone.ambT - zone.amb) * 0.05;
      zone.falloff += (zone.falloffT - zone.falloff) * 0.05;
      zone.flick += (zone.flickT - zone.flick) * 0.05;
      for (let i = 0; i < 3; i++) {
        lights.skyColor[i] = ambBase.sky[i] * zone.amb;
        lights.groundColor[i] = ambBase.ground[i] * zone.amb;
      }
      if (env.falloffPow != null || zone.falloff !== 1) env.falloffPow = zone.falloff;
    }
    for (const fx of fixtures) {
      const m = flickerValue(fx.mode, ts, fx.seed, fx.amount * zone.flick);
      for (const e of fx.lights) e.l.intensity = e.base * m;
      if (fx.mats) {
        const em = Math.max(m, 0.03);
        for (const mt of fx.mats) mt.emissiveFactor = [fx.baseEmis[0] * em, fx.baseEmis[1] * em, fx.baseEmis[2] * em];
      }
    }
    for (const em of emitters) {
      if (ts < em.next) continue;
      const step = 1 / (em.spec.rate ?? 4);
      // catch up missed intervals on slow frames (emit in one merged burst)
      const missed = Math.min(Math.ceil((ts - em.next) / step) + 1, 12);
      em.next = Math.max(em.next + missed * step, ts + step * 0.5);
      burstFX({ ...em.spec, count: (em.spec.perEmit ?? 1) * missed, now: ts });
    }

    for (const sp of sparklers) {
      if (ts < sp.next) continue;
      const k = sp.spec;
      sp.next = ts + (0.5 + Math.random()) / (k.rate ?? 3);
      let mn, mx;
      if (k.target && movable.has(k.target)) {
        const m = movable.get(k.target);
        mn = [Infinity, Infinity, Infinity]; mx = [-Infinity, -Infinity, -Infinity];
        for (const h2 of m.draws) for (let c = 0; c < 3; c++) {
          if (h2.d.aabb.min[c] < mn[c]) mn[c] = h2.d.aabb.min[c];
          if (h2.d.aabb.max[c] > mx[c]) mx[c] = h2.d.aabb.max[c];
        }
      } else if (k.pos) {
        const sz = k.size || [1, 1, 1];
        mn = [k.pos[0] - sz[0] / 2, k.pos[1] - sz[1] / 2, k.pos[2] - sz[2] / 2];
        mx = [k.pos[0] + sz[0] / 2, k.pos[1] + sz[1] / 2, k.pos[2] + sz[2] / 2];
      } else continue;
      burstFX({
        pos: [mn[0] + Math.random() * (mx[0] - mn[0]), mn[1] + Math.random() * (mx[1] - mn[1]), mn[2] + Math.random() * (mx[2] - mn[2])],
        count: 1, spread: 0.1, speed: [0, 0.05], life: [0.35, 0.7],
        size: [k.glintSize ?? 0.14, 0.004], angVel: [-9, 9],
        colorA: (k.color || [1, 1, 0.95]).map((c) => c * 2.2),
        colorB: (k.color || [1, 1, 0.95]).map((c) => c * 0.4),
        gravity: [0, 0, 0], now: ts,
      });
    }

    m4perspective(fov * camFX.fovMul, aspect, near, far, proj);
    m4mul(proj, view, viewProj);
    const cam = { view, proj, pos: camPos };
    updateProjShadows();
    // TRUE planar mirror: render the mirrored-camera view into a texture BEFORE the main
    // pass (mirror surfaces sample it via slot 7). v1 supports one mirror plane.
    if (sceneMirrors.length) renderer.renderReflectionPass(sceneMirrors[0], cam, lights, env, ts);
    if (post?.enabled) {
      if (post.has('godrays')) {   // ask the LIVE chain (postSpecs is null on a retrofitted chain)
        // project the sun onto the screen; fade rays by how directly we face it
        const sw = [camPos[0] - lights.sunDir[0] * 200, camPos[1] - lights.sunDir[1] * 200, camPos[2] - lights.sunDir[2] * 200];
        projectPoint(viewProj, sw, _sunNdc);
        const ld = input ? input.lookDir(_followDir) : [0, 0, -1];
        const facing = -(ld[0] * lights.sunDir[0] + ld[1] * lights.sunDir[1] + ld[2] * lights.sunDir[2]);
        const on = _sunNdc.w > 0 && Math.abs(_sunNdc.x) < 1.35 && Math.abs(_sunNdc.y) < 1.35;
        post.setParam('godrays', 'center', [_sunNdc.x * 0.5 + 0.5, _sunNdc.y * 0.5 + 0.5]);
        post.setParam('godrays', 'intensity', on ? Math.max(facing, 0) ** 2 : 0);
      }
      post.begin();
      el.__drawn = renderer.drawFrame(cam, lights, env, ts);
      decals.draw(viewProj);
      particles.draw(view, viewProj, ts);
      for (const t of texSystems.values()) if (t.loaded) t.sys.draw(view, viewProj, ts);
      // depth-aware effects (volfog) need to reconstruct world pos from scene depth
      m4inv(viewProj, _invVP);
      post.end(ts, { invViewProj: _invVP, camPos: cam.pos, sunDir: lights.sunDir,
        fogColor: env.fog ? env.fog.color : [0.5, 0.5, 0.55] });
    } else {
      el.__drawn = renderer.drawFrame(cam, lights, env, ts);
      decals.draw(viewProj);
      particles.draw(view, viewProj, ts);
      for (const t of texSystems.values()) if (t.loaded) t.sys.draw(view, viewProj, ts);
    }
    publishAnchors();
    ctx.bus?.emit('pf:anchors');                         // markers are current THIS frame → pins re-read now (zero-lag follow)
  }
  raf = requestAnimationFrame(frame);

  // ── context loss (Safari reclaims aggressively when backgrounded) ──────────
  const onLost = (e) => { e.preventDefault(); cancelAnimationFrame(raf); ctx.bus.emit(`glscene:${id}:contextlost`); };
  const onRestored = () => { ctx.bus.emit(`glscene:${id}:contextrestored`); location.reload(); };
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);

  // transform a registered instance group: absolute position (of its anchor)
  // and/or euler rotation (degrees) about the anchor. Rigid — all draws sharing
  // the id move together; AABBs are conservatively re-derived for culling/sort.
  const _xq = quat(), _xr = mat4(), _xd = mat4(), _xs = mat4(), _IDENT = m4identity(mat4()), _sMin = [0, 0, 0], _sMax = [0, 0, 0];
  function setModelTransform(mid, { position, rotation, scale } = {}) {
    const m = movable.get(mid);
    if (!m) return false;
    if (position) m.current = [position[0], position[1], position[2]];
    const ax = m.anchor[0], ay = m.anchor[1], az = m.anchor[2];
    // delta from anchor uses the PERSISTED current pos, NOT just this call's `position` —
    // else a rotation/scale-only call (e.g. a loop-spin after a slide) recomputes delta=0
    // and the mesh SNAPS back to its anchor. m.current already merges (set above when
    // position is passed; the last value otherwise), so this keeps the slid position.
    const cur = m.current || m.anchor;
    const dx = cur[0] - ax, dy = cur[1] - ay, dz = cur[2] - az;
    // runtime SCALE multiplier about the anchor — PERSISTED on the movable so a
    // later position-only call keeps the scale (gl-tween writes scale every frame).
    if (scale !== undefined) m.scale = scale == null ? null : (typeof scale === 'number' ? [scale, scale, scale] : [scale[0], scale[1], scale[2]]);
    const scl = m.scale && (m.scale[0] !== 1 || m.scale[1] !== 1 || m.scale[2] !== 1) ? m.scale : null;
    let rot = null;
    if (rotation && rotation.length === 4) { // quaternion (physics3d bodies)
      _xq[0] = rotation[0]; _xq[1] = rotation[1]; _xq[2] = rotation[2]; _xq[3] = rotation[3];
      rot = quatToMat(_xq, _xr);
      m.lastQuat = [_xq[0], _xq[1], _xq[2], _xq[3]];
    } else if (rotation && (rotation[0] || rotation[1] || rotation[2])) {
      const r = Math.PI / 180;
      quatFromEuler(rotation[1] * r, rotation[0] * r, rotation[2] * r, _xq);
      rot = quatToMat(_xq, _xr);
      m.lastQuat = [_xq[0], _xq[1], _xq[2], _xq[3]];
    } else if (rotation) m.lastQuat = null;
    const useMatrix = !!(rot || scl);
    for (const { d, base, bMin, bMax } of m.draws) {
      if (useMatrix) {
        // world = T(anchor+delta) · R · S · T(-anchor) · base
        m4identity(_xd);
        _xd[12] = -ax; _xd[13] = -ay; _xd[14] = -az;
        m4mul(_xd, base, d.world);          // base shifted to pivot space: T(-anchor)·base
        if (scl) { m4identity(_xs); _xs[0] = scl[0]; _xs[5] = scl[1]; _xs[10] = scl[2]; m4mul(_xs, d.world, d.world); } // S·…
        if (rot) m4mul(rot, d.world, d.world);                                                                          // R·…
        d.world[12] += ax + dx; d.world[13] += ay + dy; d.world[14] += az + dz;
        // conservative AABB: pre-scale the rest AABB about the anchor, then apply
        // the rot+delta (identity rot when only scaling).
        let aMin = bMin, aMax = bMax;
        if (scl) {
          for (let k = 0; k < 3; k++) {
            const a = [ax, ay, az][k];
            let lo = a + (bMin[k] - a) * scl[k], hi = a + (bMax[k] - a) * scl[k];
            if (lo > hi) { const t = lo; lo = hi; hi = t; }
            _sMin[k] = lo; _sMax[k] = hi;
          }
          aMin = _sMin; aMax = _sMax;
        }
        aabbTransformDelta(rot || _IDENT, aMin, aMax, ax, ay, az, dx, dy, dz, d.aabb.min, d.aabb.max);
      } else {
        d.world.set(base);
        d.world[12] = base[12] + dx; d.world[13] = base[13] + dy; d.world[14] = base[14] + dz;
        d.aabb.min[0] = bMin[0] + dx; d.aabb.min[1] = bMin[1] + dy; d.aabb.min[2] = bMin[2] + dz;
        d.aabb.max[0] = bMax[0] + dx; d.aabb.max[1] = bMax[1] + dy; d.aabb.max[2] = bMax[2] + dz;
      }
      d.center[0] = (d.aabb.min[0] + d.aabb.max[0]) / 2;
      d.center[1] = (d.aabb.min[1] + d.aabb.max[1]) / 2;
      d.center[2] = (d.aabb.min[2] + d.aabb.max[2]) / 2;
      renderer.notifyMoved(d); // WAKE: pop out of any auto-batch / re-classify
    }
    // re-project parented decals through the new group transform:
    // world = R·(local − anchor) + currentPos
    const att = decalAttach.get(mid);
    if (att && att.length) {
      const cur = m.current || m.anchor;
      const R = m.lastQuat ? quatToMat(m.lastQuat, _dRm) : null;
      for (const a of att) {
        _dv[0] = a.lc[0] - m.anchor[0]; _dv[1] = a.lc[1] - m.anchor[1]; _dv[2] = a.lc[2] - m.anchor[2];
        const c = R ? rotApply(R, _dv, [0, 0, 0]) : [_dv[0], _dv[1], _dv[2]];
        c[0] += cur[0]; c[1] += cur[1]; c[2] += cur[2];
        const t = R ? rotApply(R, a.lt, [0, 0, 0]) : a.lt;
        const b = R ? rotApply(R, a.lb, [0, 0, 0]) : a.lb;
        decals.setPlacement(a.slot, c, t, b);
      }
    }
    return true;
  }
  function setModelPosition(mid, x, y, z) { return setModelTransform(mid, { position: [x, y, z] }); }

  // runtime MATERIAL morph — write live material values onto a movable's draws.
  // The renderer reads d.mat.* as uniforms EVERY frame, so this animates instantly.
  // Clones the (shared) scene material on first touch so sibling instances are
  // unaffected, and wakes the draw so it leaves any resting auto-batch (whose batch
  // KEY snapshots the material values). props: color[rgb] · opacity · roughness ·
  // metallic · ambient · specular · sun. (opacity needs a BLEND material to visibly
  // fade — an OPAQUE draw ignores alpha.)
  function setMaterial(mid, props = {}) {
    const m = movable.get(mid);
    if (!m || !props) return false;
    for (const { d } of m.draws) {
      if (!d.mat) continue;
      if (!d._matOwned) { // clone once — never mutate the shared scene material
        const src = d.mat;
        d.mat = { ...src, baseColorFactor: [...(src.baseColorFactor || [1, 1, 1, 1])] };
        d._matOwned = true;
      }
      const mat = d.mat;
      if (props.color) { mat.baseColorFactor[0] = props.color[0]; mat.baseColorFactor[1] = props.color[1]; mat.baseColorFactor[2] = props.color[2]; }
      if (props.opacity !== undefined) { mat.baseColorFactor[3] = props.opacity; if (props.opacity < 1) mat.alphaMode = 'BLEND'; }
      if (props.roughness !== undefined) mat.roughnessFactor = props.roughness;
      if (props.metallic !== undefined) mat.metallicFactor = props.metallic;
      if (props.ambient !== undefined) mat.ambientFactor = props.ambient;
      if (props.specular !== undefined) mat.specularFactor = props.specular;
      if (props.sun !== undefined) mat.sunFactor = props.sun;
      renderer.notifyMoved(d); // re-classify out of any stale material batch
    }
    return true;
  }

  el.world = {
    _bodyQuat: null,   // controller-attached body facing (written by game code, read in physicsTick)
    raycast: (origin, dir, maxDist) => (bvh ? raycastBVH(bvh, origin, dir, maxDist) : null),
    groundHeight: (x, z) => (groundH ? groundH(x, z) : 0),  // anime-grass noise surface height

    // UNIFIED PICK — nearest hit across the static level BVH, physics bodies, AND
    // registered body-less pickables (sphere/AABB at their LIVE position), in one
    // call. Scope with flags; returns { id, kind:'static'|'body'|'movable', t, point,
    // normal } or null. Replaces choosing between raycast (BVH-only) and rayAll
    // (BVH+bodies) and hand-rolled ray-vs-sphere for decorative/animated targets.
    pick(origin, dir, opts = {}) {
      const wantStatic = opts.static !== false, wantBodies = opts.bodies !== false, wantMov = opts.movables !== false;
      let best = null, bestT = opts.maxDist ?? Infinity;
      if (wantStatic && bvh) {
        const h = raycastBVH(bvh, origin, dir, bestT);
        if (h) { best = { id: '__static', kind: 'static', t: h.t, point: h.point, normal: h.normal }; bestT = h.t; }
      }
      if (wantBodies && phys3d) {
        const h = phys3d.raycast(origin, dir, bestT);
        if (h && h.t < bestT) { best = { id: h.id, kind: 'body', t: h.t, point: h.point, normal: null }; bestT = h.t; }
      }
      if (wantMov && pickables.size) {
        for (const pk of pickables.values()) {
          if (pk.id === opts.exclude) continue;
          const m = movable.get(pk.id); const c = m && (m.current || m.anchor);
          if (!c) continue;
          const t = pk.kind === 'aabb'
            ? rayAABBHit(origin, dir, [c[0] - pk.half[0], c[1] - pk.half[1], c[2] - pk.half[2]], [c[0] + pk.half[0], c[1] + pk.half[1], c[2] + pk.half[2]])
            : raySphere(origin, dir, c, pk.radius);
          if (t < bestT) {
            const p = [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t];
            const nl = Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]) || 1;
            best = { id: pk.id, kind: 'movable', t, point: p, normal: [(p[0] - c[0]) / nl, (p[1] - c[1]) / nl, (p[2] - c[2]) / nl] };
            bestT = t;
          }
        }
      }
      return best;
    },
    addPickable: (id, opts) => addPickable(id, opts || {}),
    removePickable: (id) => pickables.delete(id),

    // toggle a DYNAMIC collider (gl-box collision:'dynamic') — rebuilds the BVH from
    // static + enabled dynamics and re-points the controller + phys3d. A solid door
    // calls setCollider(id,false) on open (player passes), true on close (blocks).
    setCollider(mid, enabled) {
      if (!dynColl.has(mid)) return false;
      if (enabled) dynOn.add(mid); else dynOn.delete(mid);
      const all = staticColl.concat(...[...dynOn].map((id) => dynColl.get(id) || []));
      bvh = all.length ? buildBVH(triangleSoup(all)) : null;
      if (controller && controller.setBVH) controller.setBVH(bvh);
      if (phys3d && bvh) phys3d.setStaticBVH(bvh);
      return true;
    },
    hasCollider: (mid) => dynColl.has(mid),

    get controller() { return controller; },
    get input() { return input; },
    // id of the visual body attached to the FPS controller (null if none) —
    // lets follow cameras prefer the controller's zero-lag position for it.
    get playerId() { return fpsSpec ? (fpsSpec.bodyId || null) : null; },
    // current world position of a movable group (its last setModelTransform
    // position, else its authored anchor). Used by follow/orbit cameras to
    // target ANY entity by id, not just the player. Returns null if unknown.
    getModelPosition(mid) {
      const m = movable.get(mid);
      if (!m) return null;
      const p = m.current || m.anchor;
      return [p[0], p[1], p[2]];
    },
    movableIds: () => [...movable.keys()],   // read-only: every id'd gl-model/gl-box (for gl-transition targets:'*')

    // DEBUG SELECT — used by the IDE manifest editor to show WHICH gl object is
    // selected (GL children have no DOM box). Highlights the id'd object with a
    // translucent emissive cube at its live world AABB, drawn IN the scene (so
    // it's automatically camera-correct — no cross-origin screen projection).
    // Reuses uploadScene (no debug-line shader); `debug(null)` clears. Defensive:
    // a no-op when the id isn't an addressable (movable/instanced) object.
    debug(key) {
      try {
        if (this._dbgInst) { renderer.removeScene(this._dbgInst); this._dbgInst = null; }
        if (key == null) return false;
        let mn = null, mx = null;
        const acc = (amin, amax) => {
          if (!mn) { mn = [amin[0], amin[1], amin[2]]; mx = [amax[0], amax[1], amax[2]]; return; }
          for (let k = 0; k < 3; k++) { if (amin[k] < mn[k]) mn[k] = amin[k]; if (amax[k] > mx[k]) mx[k] = amax[k]; }
        };
        // (1) by manifest PATH (…/children/<i>) — resolves id-LESS objects too.
        if (typeof key === 'string' && key.indexOf('children/') >= 0) {
          const parts = key.split('/');
          let ci = -1;
          for (let i = parts.length - 2; i >= 0; i--) { if (parts[i] === 'children') { ci = +parts[i + 1]; break; } }
          const draws = ci >= 0 ? meshByChild.get(ci) : null;
          if (draws) for (const d of draws) acc(d.aabb.min, d.aabb.max);
        }
        // (2) by id (movable / instanced groups).
        if (!mn) {
          const mv = movable.get(key);
          if (mv) for (const h of mv.draws) acc(h.d.aabb.min, h.d.aabb.max);
          const ig = instanceGroups.get(key);
          if (ig) for (const d of ig.draws) acc(d.aabb.min, d.aabb.max);
          if (!mn) {          // body-less (gl-light etc.) → small box at its point
            const p = (mv && (mv.current || mv.anchor)) || this.getModelPosition(key);
            if (p) { mn = [p[0] - 0.5, p[1] - 0.5, p[2] - 0.5]; mx = [p[0] + 0.5, p[1] + 0.5, p[2] + 0.5]; }
          }
        }
        if (!mn) return false;
        // WIREFRAME box: 12 thin edge bars outlining the AABB, drawn as ONE
        // instanced unit box (no line shader needed). Each instance matrix is
        // absolute (instance × identity box worldMatrix), so it places + scales
        // a bar onto one edge. Reads like a selection gizmo without occluding
        // the object the way a solid translucent cube did.
        const sx = (mx[0] - mn[0]) || 0.2, sy = (mx[1] - mn[1]) || 0.2, sz = (mx[2] - mn[2]) || 0.2;
        const cx = (mn[0] + mx[0]) / 2, cy = (mn[1] + mx[1]) / 2, cz = (mn[2] + mx[2]) / 2;
        const th = Math.max(0.015, Math.max(sx, sy, sz) * 0.02);   // edge thickness (world units)
        const Q = Float32Array.from([0, 0, 0, 1]);
        const edges = [];
        const bar = (px, py, pz, ex, ey, ez) =>
          edges.push(m4fromTRS(Float32Array.from([px, py, pz]), Q, Float32Array.from([ex, ey, ez])));
        for (const y of [mn[1], mx[1]]) for (const z of [mn[2], mx[2]]) bar(cx, y, z, sx + th, th, th); // 4 X-edges
        for (const x of [mn[0], mx[0]]) for (const z of [mn[2], mx[2]]) bar(x, cy, z, th, sy + th, th); // 4 Y-edges
        for (const x of [mn[0], mx[0]]) for (const y of [mn[1], mx[1]]) bar(x, y, cz, th, th, sz + th); // 4 Z-edges
        this._dbgInst = renderer.uploadScene(boxScene({ size: [1, 1, 1] }), {
          instances: edges, baked: true,
          color: [0.45, 0.78, 1.0], emissive: [0.45, 0.78, 1.0], emissiveIntensity: 1.3,
        });
        return true;
      } catch (_) { return false; }
    },
    camFX,
    physics: phys3d,
    // ── runtime physics API (no-ops when there's no physics world) ──────────────
    // Pattern for projectiles: pre-place a POOL of movable gl-model/gl-box + matching
    // dynamic gl-body (asleep, off-screen) in the manifest, then fireBody() one on
    // demand — reuses the movable↔body binding so no runtime mesh creation is needed.
    phys: {
      get world() { return phys3d; },
      body: (bid) => phys3d?.bodies.get(bid) || null,
      setBodyScale: (bid, s, opts) => phys3d?.setBodyScale(bid, s, opts), // grow/shrink a sphere body (resizes collision + mass; visual follows)
      applyImpulse: (bid, J, point) => phys3d?.applyImpulse(bid, J, point),
      explode: (center, radius, force, opts) => phys3d?.explode(center, radius, force, opts),
      setGravity: (v) => phys3d?.setGravity(v),
      rayAll: (origin, dir, maxDist) => phys3d?.rayAll(origin, dir, maxDist) || null,
      addJoint: (j) => phys3d?.addJoint(j),
      removeJoint: (jid) => phys3d?.removeJoint(jid),
      spawnBody: (s) => phys3d?.addBody(s),
      removeBody: (bid) => phys3d?.removeBody(bid),
      // teleport+launch a (pooled) body: set pose/velocity, wake it, snap its visual
      fireBody: (bid, position, velocity) => {
        const b = phys3d?.bodies.get(bid); if (!b) return;
        b.position[0] = position[0]; b.position[1] = position[1]; b.position[2] = position[2];
        if (velocity) { b.vel[0] = velocity[0]; b.vel[1] = velocity[1]; b.vel[2] = velocity[2]; }
        b.angVel[0] = b.angVel[1] = b.angVel[2] = 0;
        b.sleeping = false; b.sleepT = 0;
        if (movable.has(bid)) setModelTransform(bid, { position: b.position, rotation: b.quat, scale: b.scaleVisual });
      },
    },
    renderer, lights, env,
    get post() { return post; },
    // retrofit a post chain onto a scene built WITHOUT `post:[...]` — an EMPTY chain
    // is inert (enabled=false, render path untouched) until a component adds a pass
    // (gl-volumetric-fog does). Same landmine as authored chains: conflicts with
    // dynamic `shadows:` / reflection+ambient probes.
    ensurePost() {
      if (!post) { post = createPostChain(gl, []); post.resize(canvas.width, canvas.height); }
      return post;
    },
    particles: { burst: burstFX },
    decals: decalsApi,

    // ── RUNTIME mesh creation ───────────────────────────────────────────────
    // Add a movable gl-box to the LIVE scene: uploads a fresh box to the GPU,
    // registers it as a setModelTransform target, and renders it immediately —
    // the same pipeline as an authored gl-box child, done on demand. For very
    // high-frequency spawning a pooled body + `phys.fireBody` still avoids the
    // per-add GPU upload; this is the direct path for occasional/data-driven
    // entities (e.g. a contract streaming a changing body set). Idempotent per id.
    //   spec: { id, size?:[w,h,d], position?:[x,y,z], rotation?:[x,y,z(,w)],
    //           scale?, color?, emissive?, emissiveIntensity?, roughness?, metallic? }
    addModel(spec = {}) {
      const id = spec.id;
      if (id == null) throw new Error('gl-scene addModel: spec.id required');
      if (movable.has(id)) return id;
      const sg = (spec.shape === 'ball' || spec.shape === 'sphere')
        ? sphereScene({ radius: spec.radius, size: spec.size, segments: spec.segments, rings: spec.rings, color: spec.color, emissive: spec.emissive, roughness: spec.roughness, metallic: spec.metallic })
        : boxScene({ size: spec.size || [1, 1, 1], color: spec.color, emissive: spec.emissive, roughness: spec.roughness, metallic: spec.metallic });
      let transform = null;
      if (spec.position || spec.rotation || spec.scale) {
        const s = spec.scale ?? 1;
        let rot = spec.rotation || [0, 0, 0, 1];
        if (rot.length === 3) { const r = Math.PI / 180; rot = quatFromEuler(rot[1] * r, rot[0] * r, rot[2] * r); }
        transform = m4fromTRS(Float32Array.from(spec.position || [0, 0, 0]), Float32Array.from(rot), Float32Array.from(Array.isArray(s) ? s : [s, s, s]));
      }
      const inst = renderer.uploadScene(sg, {
        transform, color: spec.color, roughness: spec.roughness, metallic: spec.metallic,
        emissive: spec.emissive, emissiveIntensity: spec.emissiveIntensity,
      });
      const handles = inst.draws.map((d) => {
        d.movable = true; d.restFrame = 0;
        return { d, base: Float32Array.from(d.world), bMin: Float32Array.from(d.aabb.min), bMax: Float32Array.from(d.aabb.max) };
      });
      movable.set(id, { anchor: spec.position || [0, 0, 0], draws: handles });
      runtimeInsts.set(id, inst);
      return id;
    },
    // Remove a runtime-added model (frees its GPU scene + unregisters the movable).
    removeModel(id) {
      const inst = runtimeInsts.get(id);
      if (inst) { try { renderer.removeScene(inst); } catch (_) { /* noop */ } runtimeInsts.delete(id); }
      return movable.delete(id);
    },
    // Remove an ARRAY of runtime-added models by id. Returns the count removed.
    removeModels(ids) {
      let n = 0;
      if (Array.isArray(ids)) for (const id of ids) {
        const inst = runtimeInsts.get(id);
        if (inst) { try { renderer.removeScene(inst); } catch (_) { /* noop */ } runtimeInsts.delete(id); }
        if (movable.delete(id)) n++;
      }
      return n;
    },
    // CLEAR the scene: remove EVERY runtime-added model (addModel). Authored
    // gl-scene children (floor/lights/props) are untouched. The reliable one-call
    // reset — use it to guarantee no ghost meshes survive a scene reset.
    clearModels() {
      const ids = Array.from(runtimeInsts.keys());
      for (const inst of runtimeInsts.values()) { try { renderer.removeScene(inst); } catch (_) { /* noop */ } }
      runtimeInsts.clear();
      for (const id of ids) movable.delete(id);
      return ids.length;
    },
    // Ids of all runtime-added models — e.g. to clearModels a filtered subset.
    modelIds: () => Array.from(runtimeInsts.keys()),
    hasModel: (id) => movable.has(id),

    setModelPosition, setModelTransform, setMaterial, fogTo, worldToScreen, playerPos,
    materialOf: (mid) => { const m = movable.get(mid); const d = m && m.draws[0]?.d; return d && d.mat ? { color: [...(d.mat.baseColorFactor || [])], roughness: d.mat.roughnessFactor, metallic: d.mat.metallicFactor } : null; }, // debug: read live material
    scaleOf: (mid) => movable.get(mid)?.scale || null, // debug: read live scale multiplier
    transformOf: (mid) => { const m = movable.get(mid); return m ? { position: m.current || m.anchor, quat: m.lastQuat } : null; }, // debug: live transform
    // address INDIVIDUAL instances of an id'd instanced scatter (gl-model/gl-box with
    // `instances:[…]`). setTransform writes instance i's WORLD matrix; setTint needs
    // `instanceTint:true` on the spec. Per-instance edits without leaving the 1-draw-call batch.
    instanceGroup: (gid) => {
      const g = instanceGroups.get(gid);
      if (!g) return null;
      return {
        count: g.count,
        setTransform(i, { position = [0, 0, 0], rotation = [0, 0, 0], scale = 1 } = {}) {
          let q = rotation;
          if (q.length === 3) { const rr = Math.PI / 180; q = quatFromEuler(q[1] * rr, q[0] * rr, q[2] * rr); }
          const sc = Array.isArray(scale) ? scale : [scale, scale, scale];
          const m = m4fromTRS(Float32Array.from(position), Float32Array.from(q), Float32Array.from(sc));
          for (const d of g.draws) renderer.setInstanceTransform(d, i, m);
          return true;
        },
        setTint(i, { color = [1, 1, 1], roughness = 1 } = {}) {
          for (const d of g.draws) renderer.setInstanceTint(d, i, color[0], color[1], color[2], roughness);
          return true;
        },
        setUV(i, [u0, v0, u1, v1]) { for (const d of g.draws) renderer.setInstanceUV(d, i, u0, v0, u1, v1); return true; },
        // glyph i's base layout in WORLD space (origin + local center, size q) — a text
        // animation driver reads this then setTransform's the glyph relative to it.
        glyph(i) { const gl = g.glyphs && g.glyphs[i]; return gl ? { x: g.origin[0] + gl.cx, y: g.origin[1], z: g.origin[2], q: gl.q } : null; },
        isText: !!g.glyphs,
      };
    },
    enableLiminalMode: applyLiminal,
    camera: cameraApi,
    setInputFrozen: (v) => { manualFreeze = !!v; if (input) input.frozen = manualFreeze || modalOpen(); },
    regions: {
      occupants: (name) => [...(regions.find((r) => r.name === name)?.occupants || [])],
      inside: (name, entity) => !!regions.find((r) => r.name === name)?.occupants.has(entity),
      // region AABB — lets siblings scope things to a region's volume
      // (gl-volumetric-fog `region:` bounds its fog march to this box)
      bounds: (name) => { const r = regions.find((r2) => r2.name === name); return r ? { min: [...r.min], max: [...r.max] } : null; },
    },
    tiles: tilesApi,
    // is this world point on (or inside) a MOVABLE instance group? Decal logic
    // uses it: marks must only stick to static geometry — a decal painted on a
    // movable floats in air the moment the movable animates away.
    movableAt(point, pad = 0.04) {
      for (const [mid, m] of movable) {
        for (const { d } of m.draws) {
          if (point[0] > d.aabb.min[0] - pad && point[0] < d.aabb.max[0] + pad
            && point[1] > d.aabb.min[1] - pad && point[1] < d.aabb.max[1] + pad
            && point[2] > d.aabb.min[2] - pad && point[2] < d.aabb.max[2] + pad) return mid;
        }
      }
      return null;
    },
  };

  return {
    el,
    destroy() {
      alive = false;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', relayout);
      canvas.removeEventListener('mousedown', onCanvasDown);
      document.removeEventListener('mousedown', onLockedDown);
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      for (const u of subs) u && u();
      offStack();
      input?.destroy();
      for (const m of anchorEls.values()) m.remove();
      anchorEls.clear();
      for (const h of soundHandles) h.stop?.();
      post?.destroy();
      particles.destroy();
      decals.destroy();
      for (const t of texSystems.values()) t.sys.destroy();
      renderer.destroy();
    },
  };
}
