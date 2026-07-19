// core/gl/procgen3d/rng.js — deterministic RNG for procgen3d.
//
// Re-exports the engine's canonical generators (mulberry32, xorshift32, hashSeed,
// randInt/Range, gaussian, weightedChoice, shuffle) from core/procgen.js so the
// 3D layer shares ONE RNG implementation with the 2D one, and ADDS SplitMix64
// (the spec's third required generator) — handy for seeding sub-streams.
//
//   const r = mulberry32(12345);     r() → [0,1)
//   const sub = splitmix64(12345);   sub() → [0,1)   // independent stream
//   const treeR = mulberry32(hashSeed('world:tree:' + chunkId));  // named sub-seeds
//
// PATTERN: derive a NAMED sub-seed per subsystem (`hashSeed('world:rock:'+i)`) so
// adding/removing one generator never shifts another's random sequence.

export { rng, xorshift32, hashSeed, randInt, randRange, gaussian, exponential, weightedChoice, shuffle } from '../../procgen.js';
export { rng as mulberry32 } from '../../procgen.js';

// SplitMix64 — 64-bit state via BigInt; excellent avalanche, ideal for seeding
// other generators. Returns a function → [0,1). `.next64()` gives a raw BigInt.
const M64 = (1n << 64n) - 1n;
export function splitmix64(seed = 1) {
  let s = BigInt(Math.floor(seed)) & M64;
  const next64 = () => {
    s = (s + 0x9e3779b97f4a7c15n) & M64;
    let z = s;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M64;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M64;
    z = z ^ (z >> 31n);
    return z & M64;
  };
  const fn = () => Number(next64() >> 11n) / 9007199254740992; // 53-bit mantissa → [0,1)
  fn.next64 = next64;
  return fn;
}
