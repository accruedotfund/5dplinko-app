// core/gl/renderer.js — uploads parsed SceneGraphs to the GPU and draws them.
//
//   const r = createRenderer(gl);
//   const inst = r.uploadScene(sceneGraph, {lightmap: tex|null, transform: mat4|null});
//   r.drawFrame(camera, lights, env);   // draws every visible uploaded instance
//
// camera = { view: mat4, proj: mat4, pos: vec3 }
// lights = { sunDir, sunColor, skyColor, groundColor, points: [{pos:[x,y,z], color, decay}] }
// env    = { fog: {density, color} | null, grade: {contrast, saturation} | null }
//
// Draw list is rebuilt only when instances change; per-frame work is:
// frustum cull → sort by program/material (precomputed keys) → draw with
// redundant-state elision (program / vao / material).

import { mat4, m4mul, m4inv, m4transpose, frustumPlanes, aabbInFrustum, aabbTransform, vec3 } from './math.js';
import { uploadMesh, uploadTextures, collectColorTextures, createPixelTexture, createInstancedVAO, destroyAll } from './gpu.js';
import { getProgram, MAX_POINT_LIGHTS, MAX_DARK } from './shaders.js';
import { defaultMaterial } from './gltf.js';
import { bakeCube, bakeAmbientCube, createNeutralCube } from './reflection.js';
import { createReflector, reflectionMatrix, planeToEye, obliqueProjection } from './planar-reflect.js';
import { createShadowMap } from './shadow.js';
import { createProjShadowRenderer } from './projshadow.js';
import { createWaterRenderer } from './water.js';
import { createSkyRenderer } from './sky.js';
import { createFoliageRenderer } from './foliage.js';
import { createAnimeGroundRenderer } from './animeground.js';
import { createShaftRenderer } from './shafts.js';

export function createRenderer(gl) {
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.enable(gl.CULL_FACE);
  gl.cullFace(gl.BACK);
  gl.clearColor(0, 0, 0, 1);

  const white = createPixelTexture(gl, [255, 255, 255, 255]);
  const flatNormal = createPixelTexture(gl, [128, 128, 255, 255]);

  const instances = [];   // {draws:[...], visible}
  let drawList = null;    // flat, sorted; null = needs rebuild

  // scratch allocations reused across frames
  const viewProj = mat4(), planes = new Float32Array(24);
  const nrmScratch = mat4(), nrm3 = new Float32Array(9);
  let reflectionTex = null;        // baked reflection-probe cubemap (null → bind black)
  // scene-global lighting FEATURES — flipped by gl-scene BEFORE uploadScene so the
  // right shader variant is compiled into every draw's program (buildDefines reads this).
  const features = { ambientCube: false, envParallax: false, envAniso: false, shadows: false };
  const ZERO_AMB = new Float32Array(18); // fallback ambient cube (draws with no probe)
  let envBox = null;   // { min:[3], max:[3], pos:[3] } — parallax-correction volume
  let envAniso = 0;    // anisotropic reflection smear strength
  let shadowMap = null;            // lazily-created sun shadow map (core/gl/shadow.js)
  const shadowVP = mat4();         // world → sun clip (recomputed each frame from sunDir)
  let shadowBias = 0.0025;
  let inBake = false;              // true while baking probes → skip the shadow pass
  function setFeatures(f) { Object.assign(features, f); drawList = null; }
  let fallbackCube = null;            // 1×1 neutral-grey reflection fallback (lazy)
  let reflector = null;            // planar-mirror render target (lazy)
  let planarTex = null;            // last planar reflection texture (slot 7)
  let inReflectionPass = false;    // skip mirror draws while rendering a mirror's own reflection
  let reflPlane = null;            // current mirror plane {nx,ny,nz,d} for behind-plane culling
  const _reflM = mat4(), _reflView = mat4(), _obProj = mat4();
  const _planeW = new Float32Array(4), _clipE = new Float32Array(4), _reflEye = new Float32Array(3);
  const MAX_CAPSULES = 8;
  const capA = new Float32Array(MAX_CAPSULES * 4); // xyz + radius
  const capB = new Float32Array(MAX_CAPSULES * 4);
  let capCount = 0;
  const pointPos = new Float32Array(MAX_POINT_LIGHTS * 4);
  const pointColor = new Float32Array(MAX_POINT_LIGHTS * 3);
  const pointDir = new Float32Array(MAX_POINT_LIGHTS * 4);
  const darkPos = new Float32Array(MAX_DARK * 4);      // darkness spheres: xyz + radius
  const darkStr = new Float32Array(MAX_DARK);          // dim strength (0 = off)
  const aabbMin = vec3(), aabbMax = vec3();

  // GPU resources are shared per SceneGraph: re-uploading the same parsed scene
  // (e.g. 8 manifest entries all using box.glb) reuses one VAO/texture set —
  // only the per-instance transforms and material overrides differ.
  const gpuCache = new WeakMap(); // sceneGraph → { textures, gpuMeshes }
  const visScratch = [];          // per-frame visible-draw list (reused)
  const water = createWaterRenderer(gl); // dedicated animated water surfaces
  const sky = createSkyRenderer(gl);     // procedural skybox (depth-1 background pass)
  const foliage = createFoliageRenderer(gl); // instanced grass blades (opaque tail)
  const animeGround = createAnimeGroundRenderer(gl); // textured anime grass GROUND (opaque)
  const shafts = createShaftRenderer(gl);    // additive volumetric light beams
  const projShadows = createProjShadowRenderer(gl); // ground-projected contact/blob shadows
  const invViewProj = mat4();

  function uploadScene(sceneGraph, opts = {}) {
    let shared = gpuCache.get(sceneGraph);
    if (!shared) {
      const colorSet = collectColorTextures(sceneGraph.materials);
      shared = {
        textures: uploadTextures(gl, sceneGraph, colorSet),
        gpuMeshes: sceneGraph.meshes.map((m) => m.primitives.map((p) => ({
          mesh: uploadMesh(gl, p), prim: p,
        }))),
      };
      gpuCache.set(sceneGraph, shared);
    }
    const { textures, gpuMeshes } = shared;
    const lightmap = opts.lightmap || null;

    // per-instance material overrides — clone, never mutate the (shared) scene
    const matCache = new Map();
    const matFor = (idx) => {
      let m = matCache.get(idx);
      if (!m) {
        m = sceneGraph.materials[idx] || defaultMaterial();
        if (opts.color || opts.roughness !== undefined || opts.opacity !== undefined || opts.ambient !== undefined || opts.specular !== undefined || opts.metallic !== undefined || opts.sun !== undefined || opts.baked !== undefined || opts.capsuleOcclusion || opts.emissive !== undefined || opts.emissiveIntensity !== undefined || opts.reflective !== undefined || opts.mirror || opts.glass || opts.vertexAlpha) {
          m = { ...m };
          // vertexAlpha: drive output alpha from the mesh's COLOR_0 .a (needs a mesh WITH
          // vertex colors). Routes to the blended pass so the transparency actually shows.
          if (opts.vertexAlpha) { m.vertexAlpha = true; m.alphaMode = 'BLEND'; }
          if (opts.baked !== undefined) m.baked = opts.baked;
          if (opts.capsuleOcclusion) m.capsuleOcclusion = true;
          // REFLECTIVE / MIRROR / GLASS — sample the baked reflection probe (core/gl/reflection.js)
          if (opts.reflective !== undefined) m.reflective = opts.reflective;
          if (opts.mirror) { m.planar = true; m.planarMix = opts.mirror === true ? 0.92 : opts.mirror; m.roughnessFactor = 0.02; } // TRUE planar mirror (not cubemap)
          if (opts.glass) { m.reflective = typeof opts.glass === 'number' ? opts.glass : 0.35; m.roughnessFactor = opts.roughness ?? 0.05; m.alphaMode = 'BLEND'; m._glassAlpha = opts.opacity ?? 0.32; } // alpha applied last (below)
          if (opts.emissive !== undefined) { // glow override: scalar boosts the model's own emissive; array replaces it
            const k = opts.emissiveIntensity ?? 1;
            m.emissiveFactor = Array.isArray(opts.emissive)
              ? opts.emissive.map((c) => c * k)
              : m.emissiveFactor.map((c) => c * opts.emissive); // scalar = multiply existing emissive
          } else if (opts.emissiveIntensity !== undefined) {
            m.emissiveFactor = m.emissiveFactor.map((c) => c * opts.emissiveIntensity);
          }
          if (opts.color) m.baseColorFactor = [...opts.color, 1].slice(0, 4);
          if (opts.roughness !== undefined) m.roughnessFactor = opts.roughness;
          if (opts.ambient !== undefined) m.ambientFactor = opts.ambient;
          if (opts.specular !== undefined) m.specularFactor = opts.specular;
          if (opts.metallic !== undefined) m.metallicFactor = opts.metallic;
          if (opts.sun !== undefined) m.sunFactor = opts.sun;
          if (opts.opacity !== undefined && !opts.glass) {
            m.baseColorFactor = [...m.baseColorFactor];
            m.baseColorFactor[3] *= opts.opacity;
            m.alphaMode = 'BLEND';
          }
          if (m._glassAlpha != null) { m.baseColorFactor = [...m.baseColorFactor]; m.baseColorFactor[3] = m._glassAlpha; } // glass alpha, after color reset
        }
        matCache.set(idx, m);
      }
      return m;
    };

    const draws = [];
    const excluded = opts.exclude ? new Set(opts.exclude) : null;
    for (const node of sceneGraph.nodes) {
      if (node.meshIndex < 0) continue;
      if (excluded && excluded.has(node.name)) continue;
      let world = node.worldMatrix;
      if (opts.transform) world = m4mul(opts.transform, world, mat4());
      for (const { mesh, prim } of gpuMeshes[node.meshIndex]) {
        const mat = matFor(prim.materialIndex);
        // ── INSTANCED batch: one draw call for N transforms of this prim ──────
        // Per-instance world matrices + AABBs are precomputed; per frame the
        // surviving (frustum-visible) matrices are packed into a dynamic buffer
        // and rendered with drawElementsInstanced.
        if (opts.instances && opts.instances.length) {
          const N = opts.instances.length;
          const mats = new Float32Array(N * 16);
          const boxes = new Float32Array(N * 6);
          const agg = { min: vec3(), max: vec3() };
          agg.min.set([Infinity, Infinity, Infinity]); agg.max.set([-Infinity, -Infinity, -Infinity]);
          const tmp = mat4(), bMin = vec3(), bMax = vec3();
          for (let i = 0; i < N; i++) {
            m4mul(opts.instances[i], world, tmp);
            mats.set(tmp, i * 16);
            aabbTransform(tmp, prim.aabb.min, prim.aabb.max, bMin, bMax);
            boxes.set(bMin, i * 6); boxes.set(bMax, i * 6 + 3);
            for (let k = 0; k < 3; k++) {
              if (bMin[k] < agg.min[k]) agg.min[k] = bMin[k];
              if (bMax[k] > agg.max[k]) agg.max[k] = bMax[k];
            }
          }
          const instBuf = gl.createBuffer();
          gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
          gl.bufferData(gl.ARRAY_BUFFER, mats.byteLength, gl.DYNAMIC_DRAW);
          // opt-in per-instance MATERIAL: a vec4 tint [r,g,b,roughMul] per instance
          // (default identity). Only allocated when requested → plain scatter is byte-identical.
          const wantTint = opts.instanceTint || Array.isArray(opts.instanceTints);
          let tints = null, tintBuf = null, tintScratch = null;
          if (wantTint) {
            tints = new Float32Array(N * 4).fill(1);
            if (Array.isArray(opts.instanceTints)) opts.instanceTints.forEach((t, i) => t && tints.set(t, i * 4));
            tintBuf = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, tintBuf);
            gl.bufferData(gl.ARRAY_BUFFER, tints.byteLength, gl.DYNAMIC_DRAW);
            tintScratch = new Float32Array(N * 4);
          }
          // opt-in per-instance UV RECT [u0,v0,u1,v1] — glyph-atlas TEXT (one draw call
          // for a whole string; each instance samples its glyph cell). Init from instanceUVs.
          let uvs = null, uvBuf = null, uvScratch = null;
          if (Array.isArray(opts.instanceUVs)) {
            uvs = new Float32Array(N * 4);
            for (let i = 0; i < N; i++) { const u = opts.instanceUVs[i] || [0, 0, 1, 1]; uvs.set(u, i * 4); }
            uvBuf = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
            gl.bufferData(gl.ARRAY_BUFFER, uvs.byteLength, gl.DYNAMIC_DRAW);
            uvScratch = new Float32Array(N * 4);
          }
          const ivao = createInstancedVAO(gl, mesh, instBuf, tintBuf, uvBuf);
          const defines = [...buildDefines(mat, mesh, lightmap, textures, features), 'USE_INSTANCED'];
          if (wantTint) defines.push('USE_INSTANCED_MAT');
          if (uvs) defines.push('USE_INSTANCED_UV');
          const program = getProgram(gl, defines);
          draws.push({
            program, mat, world,
            mesh: { vao: ivao, indexCount: mesh.indexCount, indexType: mesh.indexType },
            instanced: { mats, boxes, count: N, buf: instBuf, scratch: new Float32Array(N * 16), live: 0, tints, tintBuf, tintScratch, uvs, uvBuf, uvScratch, local: { min: Float32Array.from(prim.aabb.min), max: Float32Array.from(prim.aabb.max) } },
            normalMat: normalMatrixOf(world),
            aabb: agg,
            alphaCut: mat.alphaMode === 'MASK',
            blend: mat.alphaMode === 'BLEND',
            lightMask: -1,
            center: [(agg.min[0] + agg.max[0]) / 2, (agg.min[1] + agg.max[1]) / 2, (agg.min[2] + agg.max[2]) / 2],
            dist: 0, doubleSided: mat.doubleSided,
            tex: {
              base: mat.baseColorTexture >= 0 ? textures[mat.baseColorTexture] : white,
              mr: mat.metallicRoughnessTexture >= 0 ? textures[mat.metallicRoughnessTexture] : white,
              normal: mat.normalTexture >= 0 ? textures[mat.normalTexture] : flatNormal,
              lightmap: lightmap || white,
              emissive: mat.emissiveTexture >= 0 ? textures[mat.emissiveTexture] : white,
              height: mat.heightTexture >= 0 ? textures[mat.heightTexture] : white,
              ao: mat.aoTexture >= 0 ? textures[mat.aoTexture] : white,
            },
            sortKey: 0,
          });
          continue;
        }
        const defines = buildDefines(mat, mesh, lightmap, textures, features);
        const program = getProgram(gl, defines);
        // world-space AABB precomputed once (static scenes)
        const wb = aabbTransform(world, prim.aabb.min, prim.aabb.max, vec3(), vec3());
        draws.push({
          program, mesh, mat, world, defines, // `defines` kept so auto-batch can build the USE_INSTANCED variant
          normalMat: normalMatrixOf(world),
          aabb: wb,
          alphaCut: mat.alphaMode === 'MASK',
          blend: mat.alphaMode === 'BLEND',
          lightMask: -1, // all lights; gl-scene clears bits for occluded static lights
          center: [(wb.min[0] + wb.max[0]) / 2, (wb.min[1] + wb.max[1]) / 2, (wb.min[2] + wb.max[2]) / 2],
          dist: 0, // camera distance, refreshed per frame for blend sorting
          doubleSided: mat.doubleSided,
          tex: {
            base: mat.baseColorTexture >= 0 ? textures[mat.baseColorTexture] : white,
            mr: mat.metallicRoughnessTexture >= 0 ? textures[mat.metallicRoughnessTexture] : white,
            normal: mat.normalTexture >= 0 ? textures[mat.normalTexture] : flatNormal,
            lightmap: lightmap || white,
            emissive: mat.emissiveTexture >= 0 ? textures[mat.emissiveTexture] : white,
          },
          sortKey: 0, // assigned at drawList build
        });
      }
    }
    const inst = { draws, visible: true };
    instances.push(inst);
    drawList = null;
    return inst;
  }

  function removeScene(inst) {
    const i = instances.indexOf(inst);
    if (i >= 0) { instances.splice(i, 1); drawList = null; }
  }

  let blendList = null; // BLEND-material draws, sorted back-to-front per frame

  // ── AUTO static/dynamic + AUTO instancing (the "physics-sleep" model) ────────
  // A draw is STATIC if nothing can move it (no movable handle), or DYNAMIC-but-
  // RESTING (a movable that hasn't been transformed for SLEEP frames — "asleep").
  // RESTING draws that share a mesh + material are MERGED into one instanced draw
  // (drawElementsInstanced) — so 500 copies of the same gl-model cost ~1 draw call
  // instead of 500. Moving a draw (setModelTransform → notifyMoved) WAKES it: it
  // pops out of its batch and renders individually; when it rests again it re-joins
  // a batch. Rebuilds are COALESCED so start/stop churn can't thrash. Authors no
  // longer need hand-written `instances:[]` — the engine batches the still ones.
  let frameNo = 0;
  const SLEEP = 30, BATCH_MIN = 4, COALESCE = 8;
  let needRebuild = false, lastBuild = -1e9, movers = [], autoBatches = [];
  const I16 = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const I9 = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const idOf = (() => { const m = new WeakMap(); let n = 0; return (o) => { if (!o) return 0; let i = m.get(o); if (i === undefined) m.set(o, i = ++n); return i; }; })();

  // movable + bob flags live on the draw (set by gl-scene). A draw with no handle
  // is static forever (nothing can move it); a movable rests after SLEEP idle
  // frames; a bob draw moves every frame so it never rests.
  function restingNow(d) {
    if (!d.movable) return true;
    if (d.noSleep) return false;
    return (frameNo - (d.restFrame ?? -1e9)) > SLEEP;
  }
  // setModelTransform calls this per moved draw. Stamp the time; if it was resting
  // (i.e. currently in a batch / the grid) it must re-classify → request a rebuild.
  function notifyMoved(d) {
    const wasResting = restingNow(d);
    d.restFrame = frameNo;
    if (wasResting) needRebuild = true;
  }

  // batch key: same GPU mesh + same program + same material values + same textures.
  function batchKey(d) {
    const m = d.mat, t = d.tex;
    return idOf(d.mesh) + '|' + idOf(d.program) + '|' + (m.baseColorFactor || []).join(',') + '|'
      + (m.roughnessFactor ?? 1) + ',' + (m.metallicFactor ?? 1) + ',' + (m.ambientFactor ?? 1) + ',' + (m.specularFactor ?? 1) + ',' + (m.sunFactor ?? 1) + '|'
      + idOf(t.base) + ',' + idOf(t.mr) + ',' + idOf(t.normal) + ',' + idOf(t.emissive) + ',' + idOf(t.lightmap) + '|' + (m.alphaMode || '') + (d.doubleSided ? 'D' : '');
  }
  function disposeAutoBatches() { for (const b of autoBatches) { gl.deleteBuffer(b.buf); gl.deleteVertexArray(b.vao); } autoBatches.length = 0; }

  // merge a group of resting draws (sharing mesh+material) into ONE instanced draw
  function buildMerged(members) {
    const N = members.length, mats = new Float32Array(N * 16), boxes = new Float32Array(N * 6);
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < N; i++) {
      const d = members[i];
      mats.set(d.world, i * 16);                          // full world matrix → instance transform
      boxes.set(d.aabb.min, i * 6); boxes.set(d.aabb.max, i * 6 + 3);
      for (let k = 0; k < 3; k++) { if (d.aabb.min[k] < mn[k]) mn[k] = d.aabb.min[k]; if (d.aabb.max[k] > mx[k]) mx[k] = d.aabb.max[k]; }
    }
    const m0 = members[0];
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, mats.byteLength, gl.DYNAMIC_DRAW);
    const vao = createInstancedVAO(gl, m0.mesh, buf);
    const program = getProgram(gl, [...(m0.defines || []), 'USE_INSTANCED']);
    autoBatches.push({ buf, vao });
    return {
      program, mat: m0.mat, world: I16, normalMat: I9, defines: m0.defines,
      mesh: { vao, indexCount: m0.mesh.indexCount, indexType: m0.mesh.indexType },
      instanced: { mats, boxes, count: N, buf, scratch: new Float32Array(N * 16), live: 0 },
      aabb: { min: Float32Array.from(mn), max: Float32Array.from(mx) },
      alphaCut: m0.alphaCut, blend: false, lightMask: -1,
      center: [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2],
      dist: 0, doubleSided: m0.doubleSided, tex: m0.tex, sortKey: 0, _merged: true,
      ambCube: m0.ambCube,   // batch shares the first member's nearest-probe ambient
    };
  }

  // ── spatial broad-phase grid (for many UNIQUE static draws) ─────────────────
  // Complements auto-batching: batching collapses REPEATED meshes; the grid speeds
  // culling when there are many DISTINCT static draws left. Adaptive: each grid
  // frame measures its own cost vs the flat scan and keeps the grid only while it
  // wins, re-probing every PROBE_EVERY frames.
  let grid = null, gridMode = true, probeFrames = 0;
  const GRID_MIN = 256, PROBE_EVERY = 20;
  const lastStats = { gridCells: 0, gridStatic: 0, dynamic: 0, path: 'flat', cullMs: 0, merged: 0, batched: 0 };

  function buildGrid(all) {
    const stat = [], dyn = [];
    for (const d of all) ((d._merged || !restingNow(d)) ? dyn : stat).push(d); // merged + awake → always-test; resting individuals → grid
    lastStats.gridStatic = stat.length; lastStats.dynamic = dyn.length; lastStats.gridCells = 0;
    if (stat.length < GRID_MIN) return null;
    let loX = Infinity, loY = Infinity, loZ = Infinity, hiX = -Infinity, hiY = -Infinity, hiZ = -Infinity;
    for (const d of stat) { const c = d.center; if (c[0] < loX) loX = c[0]; if (c[1] < loY) loY = c[1]; if (c[2] < loZ) loZ = c[2]; if (c[0] > hiX) hiX = c[0]; if (c[1] > hiY) hiY = c[1]; if (c[2] > hiZ) hiZ = c[2]; }
    const ext = Math.max(hiX - loX, hiY - loY, hiZ - loZ, 1);
    const cs = Math.min(64, Math.max(4, ext / 12));
    const map = new Map();
    for (const d of stat) {
      const k = Math.floor((d.center[0] - loX) / cs) + ',' + Math.floor((d.center[1] - loY) / cs) + ',' + Math.floor((d.center[2] - loZ) / cs);
      let cell = map.get(k);
      if (!cell) { cell = { min: new Float32Array([Infinity, Infinity, Infinity]), max: new Float32Array([-Infinity, -Infinity, -Infinity]), draws: [] }; map.set(k, cell); }
      cell.draws.push(d);
      const mn = d.aabb.min, mx = d.aabb.max;
      for (let a = 0; a < 3; a++) { if (mn[a] < cell.min[a]) cell.min[a] = mn[a]; if (mx[a] > cell.max[a]) cell.max[a] = mx[a]; }
    }
    const cells = [...map.values()];
    lastStats.gridCells = cells.length;
    return { cells, dynamic: dyn };
  }

  function buildDrawList() {
    disposeAutoBatches();
    const opaque = [], blended = [];
    for (const inst of instances) if (inst.visible) for (const d of inst.draws) (d.blend ? blended : opaque).push(d);
    // group RESTING non-instanced draws by batch key; everything else passes through
    const groups = new Map(), pass = [];
    movers = [];
    for (const d of opaque) {
      if (d.movable) movers.push(d);
      if (d.instanced) { pass.push(d); continue; }       // already an authored instanced draw
      if (restingNow(d)) { const k = batchKey(d); let a = groups.get(k); if (!a) groups.set(k, a = []); a.push(d); }
      else pass.push(d);
    }
    let merged = 0, batched = 0;
    const all = [];
    for (const g of groups.values()) {
      if (g.length >= BATCH_MIN) { all.push(buildMerged(g)); merged++; batched += g.length; }
      else for (const d of g) all.push(d);
    }
    for (const d of pass) all.push(d);
    for (const d of movers) d._restedAtBuild = restingNow(d); // baseline for sleep detection
    let pid = 0; const pids = new Map();
    for (const d of all) { if (!pids.has(d.program)) pids.set(d.program, pid++); d.sortKey = (d.alphaCut ? 1 << 16 : 0) | (pids.get(d.program) << 8); }
    all.sort((a, b) => a.sortKey - b.sortKey);
    drawList = all; blendList = blended;
    lastStats.merged = merged; lastStats.batched = batched;
    grid = buildGrid(all);
    gridMode = true; probeFrames = 0;
    needRebuild = false; lastBuild = frameNo;
    lastStats.builds = (lastStats.builds || 0) + 1; // rebuild counter (churn detection)
  }

  // narrow-phase: frustum-test ONE draw, and if visible record dist + queue it
  function cullPush(d, camera) {
    if (inReflectionPass && d.mat.planar) return; // don't render a mirror into its own reflection (feedback)
    if (inReflectionPass && reflPlane) {
      // skip draws whose AABB is ENTIRELY behind the mirror (the wall the mirror hangs on,
      // anything in the back room) — they'd otherwise reflect to in-front and splat the glass.
      const p = reflPlane, mn = d.aabb.min, mx = d.aabb.max;
      const fx = p.nx > 0 ? mx[0] : mn[0], fy = p.ny > 0 ? mx[1] : mn[1], fz = p.nz > 0 ? mx[2] : mn[2];
      if (p.nx * fx + p.ny * fy + p.nz * fz < p.d) return;
    }
    if (!aabbInFrustum(planes, d.aabb.min, d.aabb.max)) return;
    if (d.instanced && !cullInstances(d)) return;
    const dx = d.center[0] - camera.pos[0], dy = d.center[1] - camera.pos[1], dz = d.center[2] - camera.pos[2];
    d.dist = dx * dx + dy * dy + dz * dz;
    visScratch.push(d);
  }

  // shared per-draw state cache (reset each frame in drawFrame)
  let lastProgram, lastVAO, lastMat, lastCull;

  function drawOne(d, camera, lights, env) {
    if (d.program !== lastProgram) {
      lastProgram = d.program; lastMat = null;
      gl.useProgram(d.program.prog);
      setSceneUniforms(d.program.u, camera, lights, env, viewProj, pointPos, pointColor, pointDir, frameTime, darkPos, darkStr);
    }
    const u = d.program.u;

    gl.uniformMatrix4fv(u.u_model, false, d.world);
    gl.uniformMatrix3fv(u.u_normalMat, false, d.normalMat);
    if (u.u_lightMask) gl.uniform1i(u.u_lightMask, d.lightMask);
    // per-draw ambient cube (nearest probe, assigned at bake time) — 6 axis colors
    if (features.ambientCube && u.u_ambCube) gl.uniform3fv(u.u_ambCube, d.ambCube || ZERO_AMB);

    if (d.mat !== lastMat) {
      lastMat = d.mat;
      gl.uniform4fv(u.u_baseColorFactor, d.mat.baseColorFactor);
      if (u.u_vertexAlpha) gl.uniform1f(u.u_vertexAlpha, d.mat.vertexAlpha ? 1 : 0);
      gl.uniform1f(u.u_metallicFactor, d.mat.metallicFactor);
      gl.uniform1f(u.u_roughnessFactor, d.mat.roughnessFactor);
      if (u.u_emissiveFactor) gl.uniform3fv(u.u_emissiveFactor, d.mat.emissiveFactor);
      if (u.u_alphaCutoff) gl.uniform1f(u.u_alphaCutoff, d.mat.alphaCutoff);
      if (u.u_ambientFactor) gl.uniform1f(u.u_ambientFactor, d.mat.ambientFactor ?? 1);
      if (u.u_specularFactor) gl.uniform1f(u.u_specularFactor, d.mat.specularFactor ?? 1);
      if (u.u_sunFactor) gl.uniform1f(u.u_sunFactor, d.mat.sunFactor ?? 1);
      bindTex(0, d.tex.base); bindTex(1, d.tex.mr); bindTex(2, d.tex.normal);
      bindTex(3, d.tex.lightmap); bindTex(4, d.tex.emissive);
      if (d.mat.heightTexture >= 0 && u.u_heightTex) {        // parallax occlusion mapping
        bindTex(8, d.tex.height);
        gl.uniform1f(u.u_pomScale, d.mat.pomScale ?? 0.05);
        const pl = d.mat.pomLayers || [8, 32];
        gl.uniform2f(u.u_pomLayers, pl[0], pl[1]);
      }
      if (d.mat.aoTexture >= 0 && u.u_aoTex) {                 // baked cavity / AO map
        bindTex(9, d.tex.ao);
        gl.uniform1f(u.u_aoStrength, d.mat.aoStrength ?? 1);
      }
      if (d.mat.reflective && u.u_reflectivity) {
        gl.uniform1f(u.u_reflectivity, d.mat.reflective);
        gl.activeTexture(gl.TEXTURE0 + 5);
        gl.bindTexture(gl.TEXTURE_CUBE_MAP, reflectionTex || (fallbackCube ||= createNeutralCube(gl)));
      }
      if (d.mat.planar && u.u_planarReflMix && planarTex) {
        gl.uniform1f(u.u_planarReflMix, d.mat.planarMix ?? 0.9);
        bindTex(7, planarTex);
      }
    }

    const cull = !d.doubleSided;
    if (cull !== lastCull) {
      lastCull = cull;
      if (cull) gl.enable(gl.CULL_FACE); else gl.disable(gl.CULL_FACE);
    }

    if (d.mesh.vao !== lastVAO) {
      lastVAO = d.mesh.vao;
      gl.bindVertexArray(d.mesh.vao);
    }
    if (d.instanced) gl.drawElementsInstanced(gl.TRIANGLES, d.mesh.indexCount, d.mesh.indexType, 0, d.instanced.live);
    else gl.drawElements(gl.TRIANGLES, d.mesh.indexCount, d.mesh.indexType, 0);
  }

  // per-instance frustum cull: pack the surviving matrices into the dynamic
  // instance buffer; returns the live count (0 = whole batch culled)
  function cullInstances(d) {
    const { mats, boxes, count, scratch, buf, tints, tintBuf, tintScratch, uvs, uvBuf, uvScratch } = d.instanced;
    let live = 0;
    for (let i = 0; i < count; i++) {
      _ibMin[0] = boxes[i * 6]; _ibMin[1] = boxes[i * 6 + 1]; _ibMin[2] = boxes[i * 6 + 2];
      _ibMax[0] = boxes[i * 6 + 3]; _ibMax[1] = boxes[i * 6 + 4]; _ibMax[2] = boxes[i * 6 + 5];
      if (!aabbInFrustum(planes, _ibMin, _ibMax)) continue;
      scratch.set(mats.subarray(i * 16, i * 16 + 16), live * 16);
      if (tints) tintScratch.set(tints.subarray(i * 4, i * 4 + 4), live * 4); // pack tint in the SAME visible order
      if (uvs) uvScratch.set(uvs.subarray(i * 4, i * 4 + 4), live * 4);       // …and the UV rect
      live++;
    }
    d.instanced.live = live;
    if (live) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, scratch.subarray(0, live * 16));
      if (tints) { gl.bindBuffer(gl.ARRAY_BUFFER, tintBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, tintScratch.subarray(0, live * 4)); }
      if (uvs) { gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, uvScratch.subarray(0, live * 4)); }
    }
    return live;
  }
  const _ibMin = vec3(), _ibMax = vec3();

  // ── per-instance live edits (addressable scatter) ───────────────────────────
  // Write instance `i`'s world matrix (a ready mat4) into an instanced draw and
  // refresh its cull AABB. The next frame's cullInstances re-uploads it for free.
  const _tMin = vec3(), _tMax = vec3();
  function setInstanceTransform(d, i, m) {
    const inst = d && d.instanced; if (!inst || i < 0 || i >= inst.count) return false;
    inst.mats.set(m, i * 16);
    if (inst.local) { aabbTransform(m, inst.local.min, inst.local.max, _tMin, _tMax); inst.boxes.set(_tMin, i * 6); inst.boxes.set(_tMax, i * 6 + 3); }
    return true;
  }
  // Write instance `i`'s material tint (rgb colour multiplier + roughness multiplier).
  // Requires the draw was created with instanceTint:true.
  function setInstanceTint(d, i, r, g, b, rough = 1) {
    const inst = d && d.instanced; if (!inst || !inst.tints || i < 0 || i >= inst.count) return false;
    inst.tints[i * 4] = r; inst.tints[i * 4 + 1] = g; inst.tints[i * 4 + 2] = b; inst.tints[i * 4 + 3] = rough;
    return true;
  }
  // per-instance UV rect (glyph-atlas text). Requires the draw was made with instanceUVs.
  function setInstanceUV(d, i, u0, v0, u1, v1) {
    const inst = d && d.instanced; if (!inst || !inst.uvs || i < 0 || i >= inst.count) return false;
    inst.uvs[i * 4] = u0; inst.uvs[i * 4 + 1] = v0; inst.uvs[i * 4 + 2] = u1; inst.uvs[i * 4 + 3] = v1;
    return true;
  }

  let frameTime = 0;
  function drawFrame(camera, lights, env = {}, time = 0) {
    frameTime = time; frameNo++;
    // re-batch when a mover woke or fell asleep since the last build (coalesced so
    // bursts of start/stop don't thrash the instance-buffer rebuild).
    if (!needRebuild) { for (const d of movers) if (restingNow(d) !== d._restedAtBuild) { needRebuild = true; break; } }
    if (!drawList || (needRebuild && frameNo - lastBuild >= COALESCE)) buildDrawList();
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    // nothing to draw — but the bespoke passes (foliage/anime-ground/water/sky) live
    // OUTSIDE drawList/blendList, so a scene made only of those must NOT early-return.
    if (!drawList.length && !blendList.length
        && !foliage.patches.length && !animeGround.grounds.length
        && !water.surfaces.length && !sky.active) return 0;

    m4mul(camera.proj, camera.view, viewProj);
    frustumPlanes(viewProj, planes);
    packPointLights(lights.points || [], pointPos, pointColor, pointDir);
    packDark(lights.darks || [], darkPos, darkStr);
    capCount = packCapsules(lights.capsules || [], capA, capB, MAX_CAPSULES);

    // ── SUN SHADOW depth pass — render scene depth from the sun into u_shadowMap, so
    // the main pass can darken the sun term where occluded. Skipped during probe bakes.
    // NOTE: skipped during the planar-reflection pass too — shadowMap.end() rebinds the
    // DEFAULT framebuffer, which would steal the rest of this drawFrame away from the
    // reflector FBO (→ a blank/flat mirror). The shadow map from the main pass persists
    // (static sun), so the reflection still gets correct shadows.
    const scfg = env.shadow;
    if (features.shadows && scfg && !inBake && !inReflectionPass) {
      if (!shadowMap) shadowMap = createShadowMap(gl, scfg.size || 2048);
      shadowBias = scfg.bias ?? 0.0025;
      shadowVP.set(shadowMap.computeLightVP(lights.sunDir, scfg.center || [0, 0, 0], scfg.distance || 30));
      shadowMap.begin(shadowVP);
      for (const d of drawList) {
        if (d.instanced || d._merged) continue;   // v1: non-instanced opaque casters
        shadowMap.drawModel(d.world, d.mesh);
      }
      shadowMap.end(gl.drawingBufferWidth, gl.drawingBufferHeight);
    }

    lastProgram = null; lastVAO = null; lastMat = null; lastCull = true;
    let drawn = 0;

    // pass 1: opaque + alpha-cut. Cull (per-instance inside batches), then
    // order FRONT-TO-BACK within each program/material group — early-z kills
    // overdrawn fragment work, which is where the PBR shader cost lives.
    visScratch.length = 0;
    const _ct0 = performance.now();
    // pick the path: flat scan when no grid, else the adaptive grid (with periodic
    // re-probe so it re-engages when the view narrows again).
    let useGrid = grid && gridMode;
    if (grid && !gridMode && ++probeFrames >= PROBE_EVERY) { useGrid = true; probeFrames = 0; }
    if (useGrid) {
      let dvis = 0; // draws living in frustum-visible cells (the grid's narrow-phase load)
      for (const cell of grid.cells) {
        if (!aabbInFrustum(planes, cell.min, cell.max)) continue;
        dvis += cell.draws.length;
        for (const d of cell.draws) cullPush(d, camera);
      }
      for (const d of grid.dynamic) cullPush(d, camera); // movers/bobbers: always tested
      // cost model: grid does (cells + draws-in-visible-cells) AABB tests; the flat
      // scan does (all static draws). Keep the grid only while it's ~10% cheaper.
      gridMode = (grid.cells.length + dvis) < lastStats.gridStatic * 0.9;
      lastStats.path = 'grid';
    } else {
      for (const d of drawList) cullPush(d, camera);     // flat scan: every draw
      lastStats.path = 'flat';
    }
    const _ct = performance.now() - _ct0;
    lastStats.cullMs = lastStats.cullMs ? lastStats.cullMs * 0.9 + _ct * 0.1 : _ct; // EMA
    visScratch.sort((a, b) => (a.sortKey - b.sortKey) || (a.dist - b.dist));
    for (const d of visScratch) {
      drawOne(d, camera, lights, env);
      drawn += d.instanced ? d.instanced.live : 1;
    }

    // projected contact/blob shadows: dark ground quads under tracked objects (placed
    // by gl-scene each frame). After opaques so depth-test occludes them behind geometry.
    if (!inBake) projShadows.draw(viewProj);

    // anime grass ground (textured rolling surface) + foliage, depth-written with opaques
    animeGround.draw(camera, viewProj, lights, env, time);
    foliage.draw(camera, viewProj, lights, env, time);

    // sky: fills only pixels the opaque pass left at depth 1 (visible outdoors)
    if (sky.active) {
      m4inv(viewProj, invViewProj);
      sky.draw(camera, invViewProj, lights, env, time);
    }

    // foliage/sky bound their own programs+VAOs — drawOne's redundant-state
    // cache is now stale; without this reset the blend pass renders its draws
    // THROUGH the sky shader (invisible geometry + GL_INVALID_OPERATION)
    lastProgram = null; lastVAO = null; lastMat = null; lastCull = null;

    // pass 2: blended, back-to-front by camera distance, depth-test on / write off
    if (blendList.length) {
      for (const d of blendList) {
        const dx = d.center[0] - camera.pos[0], dy = d.center[1] - camera.pos[1], dz = d.center[2] - camera.pos[2];
        d.dist = dx * dx + dy * dy + dz * dz;
      }
      blendList.sort((a, b) => b.dist - a.dist);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      for (const d of blendList) {
        if (!aabbInFrustum(planes, d.aabb.min, d.aabb.max)) continue;
        if (d.instanced && !cullInstances(d)) continue;
        drawOne(d, camera, lights, env);
        drawn += d.instanced ? d.instanced.live : 1;
      }
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }

    // pass 3: water surfaces (own shader, same packed lights, alpha-blended)
    water.draw(camera, viewProj, pointPos, pointColor, pointDir, lights, env, time);
    // pass 4: light shafts (additive beams + dust)
    shafts.draw(camera, viewProj, time);

    gl.bindVertexArray(null);
    lastStats.drawn = drawn; lastStats.visible = visScratch.length;
    return drawn;
  }

  function bindTex(slot, tex) {
    gl.activeTexture(gl.TEXTURE0 + slot);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }

  function setSceneUniforms(u, camera, lights, env, vp, pPos, pColor, pDir, time = 0, dPos = null, dStr = null) {
    if (u.u_time) gl.uniform1f(u.u_time, time);
    if (u.u_psxSnap) gl.uniform1f(u.u_psxSnap, env.psxSnap || 0); // PS1 vertex wobble (0 = off)
    if (u.u_camPosHi) gl.uniform3fv(u.u_camPosHi, camera.pos); // highp cam pos for spatial deform
    if (u.u_spatial) { // spatial compress/expand (start,power,strength,range); strength 0 = off
      const sp = env.spatial;
      if (sp) gl.uniform4f(u.u_spatial, sp[0], sp[1], sp[2], sp[3]);
      else gl.uniform4f(u.u_spatial, 0, 1, 0, 1);
    }
    if (u.u_falloffPow) gl.uniform1f(u.u_falloffPow, env.falloffPow ?? 1);
    if (u.u_causticsParams) {
      const c = env.caustics;
      if (c) {
        gl.uniform4f(u.u_causticsArea, c.area[0], c.area[1], c.area[2], c.area[3]);
        gl.uniform4f(u.u_causticsParams, c.level, c.strength, c.scale, c.depthFade);
      } else {
        gl.uniform4f(u.u_causticsParams, 0, 0, 0, 0);
      }
    }
    gl.uniformMatrix4fv(u.u_viewProj, false, vp);
    if (u.u_viewport) gl.uniform2f(u.u_viewport, gl.drawingBufferWidth, gl.drawingBufferHeight); // planar mirror needs this even without grade
    gl.uniform3fv(u.u_camPos, camera.pos);
    gl.uniform3fv(u.u_sunDir, lights.sunDir);
    gl.uniform3fv(u.u_sunColor, lights.sunColor);
    gl.uniform3fv(u.u_skyColor, lights.skyColor);
    gl.uniform3fv(u.u_groundColor, lights.groundColor);
    if (u.u_pointPos) gl.uniform4fv(u.u_pointPos, pPos);
    if (u.u_pointColor) gl.uniform3fv(u.u_pointColor, pColor);
    if (u.u_pointDir) gl.uniform4fv(u.u_pointDir, pDir);
    if (u.u_darkPos && dPos) { gl.uniform4fv(u.u_darkPos, dPos); gl.uniform1fv(u.u_darkStr, dStr); }
    if (u.u_capCount) { gl.uniform1i(u.u_capCount, capCount); gl.uniform4fv(u.u_capA, capA); gl.uniform4fv(u.u_capB, capB); }
    if (u.u_fogColor && env.fog) {
      gl.uniform3fv(u.u_fogColor, env.fog.color);
      gl.uniform1f(u.u_fogDensity, env.fog.density);
    }
    if (u.u_envBoxMin && envBox) {
      gl.uniform3fv(u.u_envBoxMin, envBox.min);
      gl.uniform3fv(u.u_envBoxMax, envBox.max);
      gl.uniform3fv(u.u_envProbePos, envBox.pos);
    }
    if (u.u_envAniso) gl.uniform1f(u.u_envAniso, envAniso);
    if (u.u_shadowMap && shadowMap) {
      gl.activeTexture(gl.TEXTURE0 + 6);
      gl.bindTexture(gl.TEXTURE_2D, shadowMap.tex);
      gl.uniformMatrix4fv(u.u_shadowVP, false, shadowVP);
      gl.uniform2f(u.u_shadowTexel, 1 / shadowMap.size, 1 / shadowMap.size);
      gl.uniform1f(u.u_shadowBias, shadowBias);
    }
    if (u.u_gradeContrast) {
      gl.uniform1f(u.u_gradeContrast, env.grade?.contrast ?? 1);
      gl.uniform1f(u.u_gradeSaturation, env.grade?.saturation ?? 1);
      if (u.u_vignette) gl.uniform1f(u.u_vignette, env.grade?.vignette ?? 0);
      if (u.u_viewport) gl.uniform2f(u.u_viewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
    }
  }

  function normalMatrixOf(world) {
    // inverse-transpose upper 3×3 (handles non-uniform scale)
    m4inv(world, nrmScratch); m4transpose(nrmScratch, nrmScratch);
    const out = new Float32Array(9);
    out[0] = nrmScratch[0]; out[1] = nrmScratch[1]; out[2] = nrmScratch[2];
    out[3] = nrmScratch[4]; out[4] = nrmScratch[5]; out[5] = nrmScratch[6];
    out[6] = nrmScratch[8]; out[7] = nrmScratch[9]; out[8] = nrmScratch[10];
    return out;
  }

  function destroy() { water.destroy(); sky.destroy(); foliage.destroy(); animeGround.destroy(); shafts.destroy(); projShadows.destroy(); shadowMap?.free(); destroyAll(gl); instances.length = 0; drawList = null; }

  // warm-up: render ONE throwaway frame into a 1×1 scissor so the driver finalizes
  // every program the scene uses (first-DRAW finalization, separate from link) — call
  // it during boot/load (under the loader/cover) so the first VISIBLE frame never
  // stalls. The camera must FRAME the geometry or frustum culling skips the draws.
  function warmUp(camera, lights, env = {}) {
    if (!instances.length) return 0;
    drawList = null;                                  // include the freshly-uploaded scene
    const sc = gl.isEnabled(gl.SCISSOR_TEST);
    gl.enable(gl.SCISSOR_TEST); gl.scissor(0, 0, 1, 1);
    const n = drawFrame(camera, lights, env, 0);
    if (!sc) gl.disable(gl.SCISSOR_TEST);
    gl.finish();                                      // pay the finalization stall NOW (hidden), not on frame 1
    drawList = null;                                  // force a clean rebuild for the real first frame
    return n;
  }

  // Bake the reflection probe by re-rendering the scene 6 times (cube faces) from `pos`.
  // Reflective draws sample BLACK during the bake (can't read+write the same cube), then
  // the finished cube is installed for subsequent frames. One-shot for a static scene.
  function bakeReflectionProbe({ pos = [0, 1.5, 0], size = 256, near = 0.05, far = 200, bounds = null, aniso = 0 } = {}, lights = {}, env = {}) {
    reflectionTex = null;
    inBake = true;
    // store the parallax volume + anisotropy as uniform data (the shader VARIANT flags
    // were set earlier via setFeatures, before uploadScene). bounds = full [w,h,d] @ pos.
    envAniso = aniso || 0;
    if (bounds) {
      const hw = bounds[0] / 2, hh = bounds[1] / 2, hd = bounds[2] / 2;
      envBox = { min: [pos[0] - hw, pos[1] - hh, pos[2] - hd], max: [pos[0] + hw, pos[1] + hh, pos[2] + hd], pos: Array.from(pos) };
    }
    const cube = bakeCube(gl, {
      pos, size, near, far,
      drawFace: (cam) => drawFrame(cam, lights, env, frameTime),
      restoreViewport: () => gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight),
    });
    reflectionTex = cube;
    inBake = false;
    drawList = null;   // force a clean rebuild for the next real frame
    return cube;
  }

  // Bake one ambient cube per probe (render the scene 6×/probe at low res → 6 axis
  // colors), then assign EACH draw the colors of its NEAREST probe (by draw center).
  // Per-draw, zero per-frame cost. Probes: [{ pos:[x,y,z], intensity?, size? }].
  function bakeAmbientProbes(probes, lights = {}, env = {}) {
    if (!probes || !probes.length) return;
    inBake = true;
    const baked = probes.map((p) => ({
      pos: p.pos,
      colors: bakeAmbientCube(gl, {
        pos: p.pos, size: p.size || 16, intensity: p.intensity ?? 1,
        drawFace: (cam) => drawFrame(cam, lights, env, frameTime),
        restoreViewport: () => gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight),
      }),
    }));
    const nearest = (c) => {
      let best = baked[0], bd = Infinity;
      for (const b of baked) {
        const dx = b.pos[0] - c[0], dy = b.pos[1] - c[1], dz = b.pos[2] - c[2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bd) { bd = d2; best = b; }
      }
      return best.colors;
    };
    for (const inst of instances) for (const d of inst.draws) d.ambCube = nearest(d.center);
    inBake = false;
    drawList = null;   // rebuild so merged batches pick up ambCube
  }

  // TRUE planar mirror: re-render the scene from the camera mirrored across `plane`
  // {point,normal} into an offscreen texture, then the mirror surface samples it. Call
  // ONCE PER FRAME before the main drawFrame; the mirror draw reads `planarTex` (slot 7).
  function renderReflectionPass(plane, camera, lights, env = {}, time = 0) {
    if (!reflector) reflector = createReflector(gl, 1);
    const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
    reflector.bind(W, H);
    reflectionMatrix(plane.point, plane.normal, _reflM);
    m4mul(camera.view, _reflM, _reflView);   // view · M_reflect → mirror the whole world
    // normalized mirror plane (normal toward the room) + its world distance, for both the
    // behind-plane AABB cull (cullPush) and the OBLIQUE near-plane clip below.
    const n = plane.normal, pt = plane.point;
    const nl = Math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]) || 1;
    const nx = n[0] / nl, ny = n[1] / nl, nz = n[2] / nl;
    const dW = nx * pt[0] + ny * pt[1] + nz * pt[2];
    reflPlane = { nx, ny, nz, d: dW - 0.02 };  // tiny epsilon so surfaces flush ON the mirror survive
    // the REFLECTED eye position (mirror the camera across the plane). Pass THIS as the eye,
    // not the real camera: view-dependent shading (env reflect `reflect(-V,N)`, specular) must
    // use the eye the pass actually renders from, or a reflective surface samples the cubemap in
    // a wrong direction → reads black (the "black metal block in the mirror" bug).
    const cp = camera.pos;
    _reflEye[0] = _reflM[0] * cp[0] + _reflM[4] * cp[1] + _reflM[8] * cp[2] + _reflM[12];
    _reflEye[1] = _reflM[1] * cp[0] + _reflM[5] * cp[1] + _reflM[9] * cp[2] + _reflM[13];
    _reflEye[2] = _reflM[2] * cp[0] + _reflM[6] * cp[1] + _reflM[10] * cp[2] + _reflM[14];
    // oblique near-plane clip: keep the room (front) side, clip everything behind the mirror
    _planeW[0] = nx; _planeW[1] = ny; _planeW[2] = nz; _planeW[3] = -(dW - 0.02);
    planeToEye(_planeW, _reflView, _clipE);
    obliqueProjection(camera.proj, _clipE, _obProj);
    gl.frontFace(gl.CW);                       // the reflection flips handedness
    inReflectionPass = true;
    drawFrame({ view: _reflView, proj: _obProj, pos: _reflEye }, lights, env, time);
    inReflectionPass = false;
    reflPlane = null;
    gl.frontFace(gl.CCW);
    planarTex = reflector.tex;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);  // caller (gl-scene/post) rebinds its target
  }

  // Re-upload a SceneGraph's per-vertex colours into their existing VBOs (after a second,
  // occlusion-aware vertex-paint pass — see gl-scene's baked-AO refine). Same buffers, same
  // shader variant; only the bytes change. No-op if the SG was never colour-painted.
  function reuploadColors(sg) {
    const shared = gpuCache.get(sg);
    if (!shared) return;
    for (const meshes of shared.gpuMeshes) for (const { mesh, prim } of meshes) {
      if (prim.colors && mesh.buffers && mesh.buffers.col) {
        gl.bindBuffer(gl.ARRAY_BUFFER, mesh.buffers.col);
        gl.bufferData(gl.ARRAY_BUFFER, prim.colors, gl.STATIC_DRAW);
      }
    }
  }

  return { uploadScene, removeScene, drawFrame, warmUp, destroy, notifyMoved, setInstanceTransform, setInstanceTint, setInstanceUV, bakeReflectionProbe, bakeAmbientProbes, renderReflectionPass, reuploadColors, setFeatures, water, sky, foliage, animeGround, shafts, projShadows, get instances() { return instances; }, get cullStats() { return lastStats; } };
}

function buildDefines(mat, mesh, lightmap, textures, features) {
  const d = ['USE_FOG', 'USE_TONEMAP'];
  if (features && features.ambientCube) d.push('USE_AMBIENT_CUBE'); // scene-global indirect ambient
  if (features && features.shadows) d.push('USE_SHADOW');           // dynamic sun shadow map
  if (mat.baseColorTexture >= 0 && textures[mat.baseColorTexture] && mesh.hasUV0) d.push('USE_BASECOLOR_TEX');
  if (mat.metallicRoughnessTexture >= 0 && textures[mat.metallicRoughnessTexture] && mesh.hasUV0) d.push('USE_METALROUGH');
  if (mat.normalTexture >= 0 && textures[mat.normalTexture] && mesh.hasUV0) d.push('USE_NORMAL_MAP');
  if (mat.heightTexture >= 0 && textures[mat.heightTexture] && mesh.hasUV0) d.push('USE_POM'); // parallax occlusion mapping
  if (mat.aoTexture >= 0 && textures[mat.aoTexture] && mesh.hasUV0) d.push('USE_AO_MAP'); // baked cavity occlusion (tiling)
  if (lightmap && mesh.hasUV1) d.push('USE_LIGHTMAP');
  if (mesh.hasColors) d.push('USE_VERTEX_COLOR');         // baked/painted vertex light
  if (mesh.hasMaterials) d.push('USE_VERTEX_MATERIAL');   // painted per-vertex roughness/metallic
  if (mat.baked) d.push('USE_BAKED_LIGHT');               // render UNLIT (skip the light loop)
  if (mat.capsuleOcclusion) d.push('USE_CAPSULE_OCCLUSION'); // capsule specular blockers (fake reflection)
  if (mat.planar) d.push('USE_PLANAR_REFLECT');             // TRUE planar mirror (live re-render)
  if (mat.reflective && !mat.planar) {
    d.push('USE_ENV_REFLECT');                              // cubemap reflection probe (glass/glossy)
    if (features && features.envParallax) d.push('USE_ENV_PARALLAX'); // box-corrected reflection
    if (features && features.envAniso) d.push('USE_ENV_ANISO');       // anisotropic smear
  }
  if (mat.alphaMode === 'MASK') d.push('USE_ALPHACUT');
  const hasEmis = mat.emissiveFactor.some((v) => v > 0) || mat.emissiveTexture >= 0;
  if (hasEmis) {
    d.push('USE_EMISSIVE');
    if (mat.emissiveTexture >= 0 && textures[mat.emissiveTexture] && mesh.hasUV0) d.push('USE_EMISSIVE_TEX');
  }
  return d;
}

function packCapsules(caps, a, b, max) {
  const n = Math.min(caps.length, max);
  for (let i = 0; i < n; i++) {
    const c = caps[i];
    a[i * 4] = c.a[0]; a[i * 4 + 1] = c.a[1]; a[i * 4 + 2] = c.a[2]; a[i * 4 + 3] = c.r ?? c.radius ?? 0.2;
    b[i * 4] = c.b[0]; b[i * 4 + 1] = c.b[1]; b[i * 4 + 2] = c.b[2]; b[i * 4 + 3] = 0;
  }
  return n;
}

// darkness spheres → u_darkPos (xyz + radius) + u_darkStr (0..1 dim strength)
function packDark(darks, pos, str) {
  pos.fill(0); str.fill(0);
  for (let i = 0; i < Math.min(darks.length, MAX_DARK); i++) {
    const d = darks[i];
    pos[i * 4] = d.pos[0]; pos[i * 4 + 1] = d.pos[1]; pos[i * 4 + 2] = d.pos[2];
    pos[i * 4 + 3] = d.radius ?? d.r ?? 3;
    str[i] = Math.max(0, Math.min(1, d.strength ?? d.str ?? 1));
  }
}

function packPointLights(points, pos, color, dir) {
  pos.fill(0); color.fill(0); dir.fill(0);
  for (let i = 0; i < MAX_POINT_LIGHTS; i++) dir[i * 4 + 3] = -2; // omni default
  for (let i = 0; i < Math.min(points.length, MAX_POINT_LIGHTS); i++) {
    const p = points[i];
    pos[i * 4] = p.pos[0]; pos[i * 4 + 1] = p.pos[1]; pos[i * 4 + 2] = p.pos[2];
    pos[i * 4 + 3] = p.decay ?? 0.5;
    const inten = p.intensity ?? 1;
    color[i * 3] = p.color[0] * inten; color[i * 3 + 1] = p.color[1] * inten; color[i * 3 + 2] = p.color[2] * inten;
    if (p.cone && p.dir) { // spotlight: dir + outer half-angle (degrees)
      const l = Math.sqrt(p.dir[0] * p.dir[0] + p.dir[1] * p.dir[1] + p.dir[2] * p.dir[2]) || 1;
      dir[i * 4] = p.dir[0] / l; dir[i * 4 + 1] = p.dir[1] / l; dir[i * 4 + 2] = p.dir[2] / l;
      dir[i * 4 + 3] = Math.cos((p.cone * Math.PI) / 180);
    }
  }
}
