// core/gl/procgen3d/index.js — the gl-procgen 3D framework barrel.
//
// Deterministic, seed-driven procedural generation of renderer-ready 3D meshes
// (and placement/biome data) for the custom WebGL2 engine. Reuses the engine's
// canonical 2D procgen (core/procgen.js: RNG, simplex/value/worley noise, fBM,
// poisson/jittered/weighted placement, BSP, WFC, L-systems) and adds the 3D
// MESH layer on top.
//
//   import * as P from './core/gl/procgen3d/index.js';
//   const terrain = P.generate('terrain', { seed: 12345, size: 64 });   // SceneGraph
//   const eco     = P.generate('ecosystem', { seed: 12345, biome: 'forest',
//                     region:[-32,-32,32,32], terrain:{ size:64 } });    // placements
//   const items   = P.realizeEcosystem(eco);   // [{ ...placement, sceneGraph }]
//   const desc    = P.describe('rock', { seed: 7, detail: 3 });          // serialize
//   const rock    = P.regenerate(desc);                                  // reproduce
//
// STATUS (architecture + stubs phase):
//   REAL: mesh-builder, rng (+ splitmix64), noise3d, registry/serialize, LOD chain,
//         chunk streamer, terrain, rock, character, biome table, ecosystem scatter,
//         animation graph (idle/walk/run).
//   STUB (signature + placeholder mesh, real algorithm TODO): tree, bush, grass,
//         flower, mushroom, structure, dungeon, cave, mesh decimation, jump/fall/
//         land/attack/wave clips, chunk worker pool, erosion/rivers/lakes/ocean.

// keystones
export { MeshBuilder, trs } from './mesh-builder.js';
export * from './rng.js';
export { makeNoise } from './noise3d.js';
export {
  register, has, get, list, meta, generate,
  describe, regenerate, serialize, deserialize,
} from './registry.js';
export { lodChain, buildLOD, decimate } from './lod.js';
export { makeChunkStreamer } from './chunks.js';

// generators (imported for their self-registration side effect + named export)
export { generateTerrain, heightField } from './gen-terrain.js';
export { generateRock } from './gen-rock.js';
export { generateCharacter } from './gen-character.js';
export { generateTree, generateBush, generateGrass, generateFlower, generateMushroom, generateMoss, generateFern, generateLog } from './gen-flora.js';
export { BIOMES, GENERATIONS, selectBiome, generateEcosystem, realizeEcosystem, generateStructure, generateDungeon, generateCave } from './gen-world.js';
export { CLIPS, makeAnimator } from './gen-animation.js';
