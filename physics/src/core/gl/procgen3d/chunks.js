// core/gl/procgen3d/chunks.js — chunk streaming bookkeeping.
//
// The visibility/diff logic is REAL: given a camera position it tells you which
// chunk coords to LOAD and UNLOAD (square ring of `radius` chunks, with a
// per-chunk LOD that grows with distance). The actual mesh generation and any
// background-thread work are delegated to a callback you provide.
//
//   const cs = makeChunkStreamer({ chunkSize:64, radius:3,
//     lodFor:(dist)=> dist<1?0 : dist<2?1 : 2 });
//   const { load, unload } = cs.update([camX, camZ]);
//   for (const c of load)  myGenerateChunk(c.cx, c.cz, c.lod);   // ← you generate
//   for (const c of unload) myDisposeChunk(c.key);
//
// TODO (chunk phase): a real Web Worker pool that runs terrain/ecosystem
// generation off the main thread and posts transferable Float32Arrays back;
// hysteresis so a camera hovering a chunk border doesn't thrash load/unload.

export function makeChunkStreamer(opts = {}) {
  const size = opts.chunkSize ?? 64;
  const radius = opts.radius ?? 3;
  const lodFor = opts.lodFor || ((d) => (d < 1 ? 0 : d < 2 ? 1 : d < 4 ? 2 : 3));
  const loaded = new Map(); // key → { cx, cz, lod }
  const key = (cx, cz) => cx + ',' + cz;

  function update(camPos) {
    const ccx = Math.floor(camPos[0] / size), ccz = Math.floor((camPos[2] ?? camPos[1]) / size);
    const want = new Map();
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const cx = ccx + dx, cz = ccz + dz;
        const dist = Math.max(Math.abs(dx), Math.abs(dz));
        if (dist > radius) continue;
        want.set(key(cx, cz), { cx, cz, lod: lodFor(dist), key: key(cx, cz) });
      }
    }
    const load = [], unload = [], relod = [];
    for (const [k, c] of want) {
      const have = loaded.get(k);
      if (!have) load.push(c);
      else if (have.lod !== c.lod) relod.push(c); // distance band changed → re-LOD
    }
    for (const [k, c] of loaded) if (!want.has(k)) unload.push({ ...c, key: k });
    // commit the new desired set
    loaded.clear();
    for (const [k, c] of want) loaded.set(k, c);
    return { load, unload, relod, count: loaded.size };
  }

  return { update, get loaded() { return [...loaded.values()]; }, chunkSize: size, worldToChunk: (x, z) => [Math.floor(x / size), Math.floor(z / size)] };
}
