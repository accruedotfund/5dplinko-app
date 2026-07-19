// core/pool.js — object pooling, ProofFront-native. A CORE service (built in boot.js
// alongside bus/store, OUTSIDE the pf-build tree-shake block) so it ALWAYS ships and
// is reachable as `ctx.pool` from every component — it is never shaken out of a build.
//
// Why this exists: object creation churns the GC on every layer — 2D/3D physics vec
// math, particle bursts, GL per-instance transients, DOM/keyed lists. JS can't pool
// transparently (no way to intercept `[x,y]` literals without a compile step or a slow
// Proxy), so this gives ergonomic pools the hot paths OPT INTO. Honest expectation: the
// real payoff is fewer/shorter GC PAUSES (frame smoothness) + faster cold-start, not a
// big throughput multiplier — V8's nursery already makes short-lived small objects cheap.
//
// TWO tools for two different lifetimes:
//
//  1. FREELIST — makePool(factory, reset): objects ACQUIRED then explicitly RELEASED.
//     Use for structured, individually-tracked objects (particles, contacts, DOM/GL
//     entities). You own the lifetime; call release() when done.
//
//       const pool = makePool(() => ({x:0,y:0,life:0}), (p,x,y) => { p.x=x; p.y=y; p.life=1; });
//       const p = pool.acquire(10, 20);   // reset(p,10,20) runs; p reused if available
//       …
//       pool.release(p);                  // back on the freelist
//       pool.releaseAll(arr);             // release every item + clear arr in one go
//
//  2. ARENA — makeArena(factory): transient scratch temps with NO per-object release;
//     you borrow next() temps during ONE computation, then reset() the whole arena at a
//     safe boundary (per frame / per physics step). Ideal for vec2/vec3/mat temporaries
//     in a math loop.
//
//       const v = makeArena(() => new Float64Array(2));
//       const a = v.next(), b = v.next();   // borrow scratch
//       …compute with a,b…
//       v.reset();                          // reclaim ALL at the boundary
//
//     ⚠ ALIASING FOOTGUN: an arena temp is valid only until the next reset(). NEVER store
//     a borrowed temp somewhere that outlives the frame/step (a contact cache, a manifold
//     kept across frames, component state) — it will be overwritten and silently corrupt.
//     If a value must persist, COPY it into an owned object (.slice() / a freelist item).
//     For a bounded borrow inside a larger scope, use mark()/release(m) instead of reset().
//
// NOTE for perf-critical INNER loops: a single dedicated module-level scratch (e.g. the
// physics `_va`/`_vb`) is faster than an arena there (no next()/counter overhead) — pool
// the STRUCTURED churn, not the two hottest temporaries. Measure; don't pool reflexively.
//
// ── RECIPE for component authors (esp. canvas / 2D) ───────────────────────────
// The high-value cases in a component are: (1) SPAWNED entities that churn — particles,
// projectiles, floating damage numbers, transient mobs — and (2) per-frame RENDER-LIST
// entries. Reference impl: `2d-particles.js`.
//
//   const parts = [];
//   const pool = ctx.pool.makePool(() => ({x:0,y:0,vx:0,vy:0,t:0}), null, { preheat: 64 });
//   function spawn(x, y) {                       // emit: acquire + FULLY re-init every field
//     const p = pool.acquire(); p.x=x; p.y=y; p.vx=0; p.vy=0; p.t=0; parts.push(p);
//   }
//   function update(dt) {                        // death: release back to the pool
//     for (let i=parts.length-1; i>=0; i--) { const p=parts[i]; p.t+=dt;
//       if (p.t>=1) { parts.splice(i,1); pool.release(p); } }
//   }
//   destroy() { pool.releaseAll(parts); }        // hand them all back on teardown
//
// Reuse ONE render-list entry per frame instead of `out.push({draw:()=>…})` each frame:
// build the entry + closure ONCE, have the closure read frame state from captured vars you
// refresh each frame (2d-particles' `_fx/_fy/_fby`). Safe because the render list is
// consumed the same frame it's built.
//
// DON'T pool utility RETURNS that callers naturally store — e.g. `tileCenter()→{x,y}`,
// `tileToWorld()`. A caller does `const p = tileCenter(...)` and keeps it; a shared/arena
// object would be overwritten under them. (TileRegistry.getInRadius already reuses an
// internal `_scratch` — same one-use contract; copy the result if you must keep it.)

// ── freelist pool ────────────────────────────────────────────────────────────
// factory() → a fresh object. reset(obj, ...args) re-initialises a reused object for
// acquire(...args); if reset returns a value it's used (lets you reset primitives-in-a-box).
// opts: preheat (pre-allocate N up front to avoid first-use spikes), max (cap freelist
// growth so a huge transient burst doesn't pin memory forever).
export function makePool(factory, reset, { preheat = 0, max = Infinity } = {}) {
  const free = [];
  for (let i = 0; i < preheat; i++) free.push(factory());
  let created = preheat, live = 0;
  return {
    acquire(...args) {
      const o = free.length ? free.pop() : (created++, factory());
      live++;
      return reset ? (reset(o, ...args) ?? o) : o;
    },
    release(o) { if (o != null && free.length < max) { free.push(o); live--; } },
    // release every element of arr back to the pool and empty arr (arr.length = 0).
    releaseAll(arr) {
      for (let i = 0; i < arr.length; i++) { const o = arr[i]; if (o != null && free.length < max) { free.push(o); live--; } }
      arr.length = 0;
    },
    preheat(n) { while (free.length < n) { free.push(factory()); created++; } },
    stats: () => ({ free: free.length, created, live }),
  };
}

// ── scratch arena ────────────────────────────────────────────────────────────
// factory() → a fresh scratch object (typically a Float64Array/typed vec). next() hands
// out the next scratch object, growing in `chunk`s. reset() reclaims ALL of them at once.
// mark()/release(m) reclaim back to a saved high-water mark (nested/bounded borrows).
export function makeArena(factory, { chunk = 32 } = {}) {
  const buf = [];
  let n = 0, high = 0;
  return {
    next() {
      if (n >= buf.length) for (let i = 0; i < chunk; i++) buf.push(factory());
      const o = buf[n++];
      if (n > high) high = n;
      return o;
    },
    reset() { n = 0; },
    mark() { return n; },
    release(m) { if (m < n) n = m; },
    stats: () => ({ size: buf.length, inUse: n, high }),
  };
}

// ── ctx.pool service (built by boot.js) ──────────────────────────────────────
// Bundles the two constructors plus ready-made per-FRAME scratch arenas for the common
// vec sizes, and a frame() hook boot wires to `loop:frame` so they auto-reset each frame
// ("behind the scenes"). Components can also makePool()/makeArena() their own.
//
//   ctx.pool.v2()  → a scratch Float64Array(2), valid THIS frame only
//   ctx.pool.v3()  → scratch Float64Array(3)
//   ctx.pool.m4()  → scratch Float64Array(16)
//   ctx.pool.makePool(...) / ctx.pool.makeArena(...)   // own-lifetime pools
export function createPool({ bus } = {}) {
  const a2 = makeArena(() => new Float64Array(2));
  const a3 = makeArena(() => new Float64Array(3));
  const a4 = makeArena(() => new Float64Array(16));

  const pool = {
    makePool, makeArena,
    v2: () => a2.next(),
    v3: () => a3.next(),
    m4: () => a4.next(),
    // reset all per-frame arenas — boot calls this on loop:frame; call manually if you
    // drive your own loop. Safe because frame arenas hold ONLY transient temps.
    frame() { a2.reset(); a3.reset(); a4.reset(); },
    stats: () => ({ v2: a2.stats(), v3: a3.stats(), v4: a4.stats?.() }),
  };

  // auto-reset the per-frame scratch arenas each rendered frame. Unprefixed `loop:frame`
  // is emitted by the MAIN game-loop; a page with no loop just never resets (arenas grow
  // once to their high-water mark and are reused — still bounded, still fine).
  if (bus) pool._off = bus.on('loop:frame', () => pool.frame());
  return pool;
}
