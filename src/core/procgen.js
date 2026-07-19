// ──────────────────────────────────────────────────────────────────────
// procgen — engine-canonical procedural generation primitives.
// ──────────────────────────────────────────────────────────────────────
//
// This file is the *front end* of procgen — generative primitives that
// PRODUCE positions, paths, shapes, palettes. Pair it with the existing
// "back end" engine modules:
//
//   bake.js / proc-pool.js / proc-dmi.js   ← cache + render the result
//   procgen.js (this file)                  ← GENERATE the result
//
// Every primitive here is:
//   • Engine-canonical: byte-identical across all games on this engine.
//     Don't fork; don't add game-specific logic. If a game needs custom
//     behavior, COMPOSE these primitives in game/ code instead.
//   • Deterministic when given a seed: same seed → same output across
//     runs, sessions, machines. This is what lets a planet seed reproduce
//     the same world every time, lets test cases run hermetically, and
//     lets multiplayer clients agree on a generated world without sync.
//   • Stateless after construction: factories return functions that hold
//     their own state (RNG, noise tables). No globals, no module state.
//
// Don't reach for procgen.js for runtime-game-state things (player
// position, NPC AI, atmos sim) — those belong in game/ + ECS, not here.
//
// ── Section guide ────────────────────────────────────────────────────
//
//   1. RNG               — seeded uniform random (mulberry32, xorshift32)
//   2. Distributions     — gaussian, exponential, weighted choice
//   3. Noise             — simplex 2D, value noise, fractal (fBM) wrapper
//   4. Placement         — poisson disk, jittered grid, weighted scatter
//   5. Turtle / paths    — step-based path growth driven by noise/angle
//   6. Branching         — recursive branch helper for vines/trees
//   7. Path drawing      — smooth curves through a point list
//   8. Flow fields       — direction-per-cell vector field
//   9. Color             — HSV/RGB conversions, palette interp, hue jitter
//
// Each section is independent — import only what you need.

// ══════════════════════════════════════════════════════════════════════
// 1. RNG — seeded uniform random
// ══════════════════════════════════════════════════════════════════════

// Mulberry32 — fast, well-distributed, deterministic. The standard
// "small game" RNG. ~4ns per call. State is a single uint32.
//
// Returns a function that returns a float in [0, 1) on each call.
// Mutate the seed by calling many times; it advances internally.
//
//   const r = rng(42);
//   r(); r(); r();           // three independent draws
//   const r2 = rng(42);
//   r2() === <first r() value>  // true: reproducible
export function rng(seed = 1) {
  let s = seed >>> 0;
  return function() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// xorshift32 — even faster (~3ns), slightly weaker distribution. Use
// when you need maximum throughput for noise tables / particle batches
// where uniformity matters less than raw speed. Same API as `rng`.
export function xorshift32(seed = 1) {
  let s = seed >>> 0 || 1;
  return function() {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;  s >>>= 0;
    return s / 4294967296;
  };
}

// Hash a string seed → uint32. Useful for deriving per-entity seeds
// from string IDs without picking integer seeds by hand:
//
//   const treeRng = rng(hashSeed('cygnus:tree:42'));
//   const rockRng = rng(hashSeed('cygnus:rock:42'));
export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ══════════════════════════════════════════════════════════════════════
// 2. Distributions
// ══════════════════════════════════════════════════════════════════════

// Random integer in [lo, hi] (inclusive). `r` is an rng function.
export function randInt(r, lo, hi) {
  return Math.floor(r() * (hi - lo + 1)) + lo;
}

// Random float in [lo, hi).
export function randRange(r, lo, hi) {
  return lo + r() * (hi - lo);
}

// Gaussian (normal) sample. Box-Muller, returns mean=0 stddev=1.
// Use for "natural-looking" jitter where most values cluster around
// the mean and outliers are rare. Multiply/add for desired (μ, σ).
export function gaussian(r) {
  // Box-Muller. Avoid u=0 (log domain).
  let u = 0; while (u === 0) u = r();
  let v = 0; while (v === 0) v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Exponential — biased toward 0, long tail. `lambda` is the rate;
// mean = 1/lambda. Good for "occasionally something dramatic" events.
export function exponential(r, lambda = 1) {
  let u = 0; while (u === 0) u = r();
  return -Math.log(u) / lambda;
}

// Weighted choice — pick one item from `items` where `weights[i]` is
// the relative probability of `items[i]`. Weights don't have to sum
// to 1 — they're normalized internally.
//
//   const biome = weightedChoice(r,
//     ['forest', 'desert', 'tundra'],
//     [0.6,      0.3,       0.1]
//   );
export function weightedChoice(r, items, weights) {
  let total = 0;
  for (let i = 0; i < weights.length; i++) total += weights[i];
  let pick = r() * total;
  for (let i = 0; i < items.length; i++) {
    pick -= weights[i];
    if (pick <= 0) return items[i];
  }
  return items[items.length - 1];
}

// Fisher-Yates shuffle (in-place). Uses provided rng for determinism.
export function shuffle(r, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ══════════════════════════════════════════════════════════════════════
// 3. Noise — simplex 2D + value noise + fractal
// ══════════════════════════════════════════════════════════════════════

// Simplex 2D — Ken Perlin's improved gradient noise. Returns -1..1.
// Continuous, isotropic, no axis-aligned grid artifacts (vs Perlin).
// This is the noise you want for terrain heightfields, vine angle
// drift, cloud textures, anything that should look organic.
//
//   const noise = simplex2D(rng(42));
//   const v = noise(x, y);   // -1..1
//
// Standard Stefan Gustavson port, single-octave. For multi-octave
// detail (mountains-with-foothills feel), wrap with `fbm()` below.
export function simplex2D(r) {
  // Build a permutation table from the rng.
  const perm = new Uint8Array(512);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];

  const F2 = 0.5 * (Math.sqrt(3) - 1);
  const G2 = (3 - Math.sqrt(3)) / 6;
  const grad2 = [
    [1,1], [-1,1], [1,-1], [-1,-1],
    [1,0], [-1,0], [0,1], [0,-1],
  ];

  return function noise2(xin, yin) {
    let n0 = 0, n1 = 0, n2 = 0;
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const X0 = i - t, Y0 = j - t;
    const x0 = xin - X0, y0 = yin - Y0;
    let i1, j1;
    if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    const gi0 = perm[ii + perm[jj]] % 8;
    const gi1 = perm[ii + i1 + perm[jj + j1]] % 8;
    const gi2 = perm[ii + 1 + perm[jj + 1]] % 8;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 >= 0) { t0 *= t0; n0 = t0 * t0 * (grad2[gi0][0] * x0 + grad2[gi0][1] * y0); }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 >= 0) { t1 *= t1; n1 = t1 * t1 * (grad2[gi1][0] * x1 + grad2[gi1][1] * y1); }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 >= 0) { t2 *= t2; n2 = t2 * t2 * (grad2[gi2][0] * x2 + grad2[gi2][1] * y2); }
    return 70 * (n0 + n1 + n2);
  };
}

// Value noise 2D — bilinearly interpolated lattice of random values.
// Cheaper than simplex but blockier (axis-aligned artifacts visible
// at small scales). Use when speed matters and the result will get
// further smoothed by something else (fbm, blur, downstream noise).
export function valueNoise2D(r) {
  const SIZE = 256;
  const tbl = new Float32Array(SIZE * SIZE);
  for (let i = 0; i < tbl.length; i++) tbl[i] = r() * 2 - 1;
  const fade = t => t * t * (3 - 2 * t);
  const lerp = (a, b, t) => a + (b - a) * t;

  return function noise2(x, y) {
    const xi = Math.floor(x) & (SIZE - 1);
    const yi = Math.floor(y) & (SIZE - 1);
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const u = fade(xf), v = fade(yf);
    const a = tbl[yi * SIZE + xi];
    const b = tbl[yi * SIZE + ((xi + 1) & (SIZE - 1))];
    const c = tbl[((yi + 1) & (SIZE - 1)) * SIZE + xi];
    const d = tbl[((yi + 1) & (SIZE - 1)) * SIZE + ((xi + 1) & (SIZE - 1))];
    return lerp(lerp(a, b, u), lerp(c, d, u), v);
  };
}

// Fractal Brownian Motion (fBm) — sum N octaves of a noise function
// at increasing frequency × decreasing amplitude. Gives "natural"
// detail at multiple scales (mountains-with-foothills feel).
//
//   const baseNoise = simplex2D(rng(42));
//   const terrain = fbm(baseNoise, { octaves: 4, lacunarity: 2, gain: 0.5 });
//   const h = terrain(x * 0.01, y * 0.01);   // -1..1ish
//
//   • octaves: number of layers (3-6 typical)
//   • lacunarity: frequency multiplier per octave (2 = "double per layer")
//   • gain: amplitude multiplier per octave (0.5 = "half per layer")
export function fbm(noise, opts = {}) {
  const octaves = opts.octaves || 4;
  const lacunarity = opts.lacunarity != null ? opts.lacunarity : 2;
  const gain = opts.gain != null ? opts.gain : 0.5;
  return function fbm2(x, y) {
    let sum = 0;
    let amp = 1;
    let freq = 1;
    let max = 0;
    for (let o = 0; o < octaves; o++) {
      sum += noise(x * freq, y * freq) * amp;
      max += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / max;
  };
}

// ══════════════════════════════════════════════════════════════════════
// 4. Placement
// ══════════════════════════════════════════════════════════════════════

// Poisson disk sampling — generate points scattered in a rectangle
// such that NO two points are closer than `minDist`. Produces the
// "natural-looking but well-spread" distribution real foliage has
// (no clumping, no grid, but no two leaves on top of each other).
//
//   for (const pt of poissonDisk({ rng: r, w: 300, h: 200, minDist: 12 })) {
//     placeTreeAt(pt.x, pt.y);
//   }
//
// Uses Bridson's algorithm — O(n) in output points, very fast.
export function poissonDisk(opts) {
  const r = opts.rng;
  const w = opts.w, h = opts.h;
  const minDist = opts.minDist;
  const k = opts.k || 30;          // attempts per active point before giving up
  const cellSize = minDist / Math.SQRT2;
  const gridW = Math.ceil(w / cellSize);
  const gridH = Math.ceil(h / cellSize);
  const grid = new Int32Array(gridW * gridH).fill(-1);
  const points = [];
  const active = [];

  function gridIdx(x, y) {
    return Math.floor(y / cellSize) * gridW + Math.floor(x / cellSize);
  }

  // Seed with one random point. (Caller can pre-seed via opts.seedPoint
  // if they want a specific anchor.)
  const sx = opts.seedPoint ? opts.seedPoint.x : r() * w;
  const sy = opts.seedPoint ? opts.seedPoint.y : r() * h;
  points.push({ x: sx, y: sy });
  active.push(0);
  grid[gridIdx(sx, sy)] = 0;

  while (active.length) {
    const i = Math.floor(r() * active.length);
    const pi = active[i];
    const p = points[pi];
    let found = false;
    for (let attempt = 0; attempt < k; attempt++) {
      const angle = r() * Math.PI * 2;
      const dist = minDist * (1 + r());
      const nx = p.x + Math.cos(angle) * dist;
      const ny = p.y + Math.sin(angle) * dist;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      // Check neighborhood of grid cells for nearby points.
      const cx = Math.floor(nx / cellSize);
      const cy = Math.floor(ny / cellSize);
      let ok = true;
      for (let oy = -2; oy <= 2 && ok; oy++) {
        for (let ox = -2; ox <= 2 && ok; ox++) {
          const ncx = cx + ox, ncy = cy + oy;
          if (ncx < 0 || ncy < 0 || ncx >= gridW || ncy >= gridH) continue;
          const npi = grid[ncy * gridW + ncx];
          if (npi < 0) continue;
          const np = points[npi];
          const dx = np.x - nx, dy = np.y - ny;
          if (dx * dx + dy * dy < minDist * minDist) ok = false;
        }
      }
      if (ok) {
        const newIdx = points.length;
        points.push({ x: nx, y: ny });
        active.push(newIdx);
        grid[gridIdx(nx, ny)] = newIdx;
        found = true;
        break;
      }
    }
    if (!found) active.splice(i, 1);
  }
  return points;
}

// Jittered grid — N×M grid of cells, each cell gets a point at a
// random position within it. Cheaper than Poisson, looks "regular
// with breathing room." Use for crops, regular foliage, tile decals.
//
//   for (const pt of jitteredGrid({ rng: r, w: 300, h: 200, cell: 16, jitter: 0.7 })) {
//     ...
//   }
export function jitteredGrid(opts) {
  const r = opts.rng;
  const w = opts.w, h = opts.h;
  const cell = opts.cell;
  const jitter = opts.jitter != null ? opts.jitter : 0.5;
  const points = [];
  for (let y = cell / 2; y < h; y += cell) {
    for (let x = cell / 2; x < w; x += cell) {
      const dx = (r() - 0.5) * cell * jitter;
      const dy = (r() - 0.5) * cell * jitter;
      points.push({ x: x + dx, y: y + dy });
    }
  }
  return points;
}

// Weighted scatter — drop N points uniformly, but accept each one
// only if `weight(x, y)` returns > rng. Use for "place trees more
// densely where the noise function says forest, sparser elsewhere."
//
//   const density = (x, y) => Math.max(0, noise(x * 0.01, y * 0.01));
//   for (const pt of weightedScatter({ rng: r, w, h, count: 2000, weight: density })) {
//     placeTreeAt(pt.x, pt.y);
//   }
export function weightedScatter(opts) {
  const r = opts.rng;
  const points = [];
  for (let i = 0; i < opts.count; i++) {
    const x = r() * opts.w;
    const y = r() * opts.h;
    const w = opts.weight(x, y);
    if (r() < w) points.push({ x, y });
  }
  return points;
}

// ══════════════════════════════════════════════════════════════════════
// 5. Turtle / paths — step-based path growth
// ══════════════════════════════════════════════════════════════════════

// Turtle — walk a path step-by-step, drifting the angle each step
// by a (typically noise-driven) callback. Returns an array of
// {x, y, angle, t, life} samples for downstream drawing/branching.
//
//   const noise = simplex2D(rng(42));
//   const path = turtle({
//     x: 100, y: 100,
//     angle: 0,
//     steps: 400,
//     step: 2,
//     // Angle drift per step — noise-driven for organic curl
//     angleDrift: (x, y, t) => noise(x * 0.02, y * 0.02) * 0.4,
//     // Optional: stop early if condition met (e.g. out of bounds, hit obstacle)
//     stopWhen: (x, y, t) => x < 0 || x > W || y < 0 || y > H,
//   });
//
// Each sample has:
//   x, y       — world position
//   angle      — heading (radians) AT this sample
//   t          — step index (0..steps-1)
//   life       — t / (steps-1), 0..1, for tapering / fading
//
// `angleDrift(x, y, t)` returns radians-per-step. For a vine, scale
// noise output by ~0.2-0.6; bigger = more curl.
export function turtle(opts) {
  let x = opts.x;
  let y = opts.y;
  let angle = opts.angle || 0;
  const steps = opts.steps;
  const step = opts.step;
  const angleDrift = opts.angleDrift || (() => 0);
  const stopWhen = opts.stopWhen || (() => false);
  const path = [];
  for (let t = 0; t < steps; t++) {
    if (stopWhen(x, y, t)) break;
    path.push({ x, y, angle, t, life: t / Math.max(1, steps - 1) });
    angle += angleDrift(x, y, t);
    x += Math.cos(angle) * step;
    y += Math.sin(angle) * step;
  }
  return path;
}

// ══════════════════════════════════════════════════════════════════════
// 6. Branching — recursive structure
// ══════════════════════════════════════════════════════════════════════

// Branch — recursive helper for vines/trees. At each step, the caller
// gets a chance to spawn a child branch via the `onBranch` callback,
// which itself receives a fresh sub-state to recurse on.
//
// The library doesn't draw — it gives you a structured TREE of paths
// (one path per branch) so you can decide rendering, tapering, color
// per branch independently.
//
//   const root = branch({
//     rng: r,
//     x: 100, y: 100, angle: 0,
//     depth: 0, maxDepth: 4,
//     turtle: {
//       steps: 200,
//       step: 2,
//       angleDrift: (x, y, t) => noise(x * 0.02, y * 0.02) * 0.4,
//     },
//     branchProbability: 0.04,    // chance to spawn a child PER STEP
//     branchAngleSpread: 0.6,     // child angle = parent + ±spread (radians)
//   });
//
//   // root = { path: [...], children: [{ path, children: [...] }, ...] }
//
//   // Render recursively:
//   function render(node, baseWidth) {
//     drawSmoothPath(ctx, node.path, { lineWidth: baseWidth, taper: true });
//     for (const c of node.children) render(c, baseWidth * 0.6);
//   }
//   render(root, 4);
export function branch(opts) {
  const r = opts.rng;
  const depth = opts.depth || 0;
  const maxDepth = opts.maxDepth != null ? opts.maxDepth : 4;
  const branchProbability = opts.branchProbability != null ? opts.branchProbability : 0.04;
  const branchAngleSpread = opts.branchAngleSpread != null ? opts.branchAngleSpread : 0.6;

  // Walk the parent path while collecting branch points.
  const branchPoints = [];
  const tOpts = Object.assign({}, opts.turtle, {
    x: opts.x, y: opts.y, angle: opts.angle || 0,
  });
  // Wrap the angleDrift so we can sample branch points along the way.
  const userDrift = tOpts.angleDrift || (() => 0);
  tOpts.angleDrift = (x, y, t) => {
    if (depth < maxDepth && r() < branchProbability) {
      branchPoints.push({ x, y, angle: tOpts.lastAngle != null ? tOpts.lastAngle : 0, t });
    }
    return userDrift(x, y, t);
  };
  const path = turtle(tOpts);
  // Re-derive angles for branch points from the path's actual heading.
  for (const bp of branchPoints) {
    const sample = path[bp.t];
    if (sample) bp.angle = sample.angle;
  }

  // Recurse for each branch point.
  const children = [];
  for (const bp of branchPoints) {
    const childAngle = bp.angle + (r() * 2 - 1) * branchAngleSpread;
    children.push(branch(Object.assign({}, opts, {
      x: bp.x, y: bp.y,
      angle: childAngle,
      depth: depth + 1,
      // Children have shorter paths than parents — natural tapering of length.
      turtle: Object.assign({}, opts.turtle, {
        steps: Math.max(8, Math.floor((opts.turtle.steps || 200) * 0.6)),
      }),
    })));
  }
  return { path, children, depth };
}

// ══════════════════════════════════════════════════════════════════════
// 7. Path drawing — smooth curves
// ══════════════════════════════════════════════════════════════════════

// Draw a smooth curve through a list of points using quadratic
// midpoint interpolation. Each segment ends at the midpoint between
// two source points and uses the next source point as the curve's
// control. Avoids the "polyline jaggies" of straight lineTo().
//
// Pass `taper: true` to draw segments individually with linewidth
// fading from `lineWidth` at the start to `tipWidth` at the end —
// gives the natural "thick base, thin tip" vine/tendril feel.
//
//   drawSmoothPath(ctx, path, {
//     lineWidth: 4,      // base width
//     tipWidth: 0.5,     // tip width; defaults to lineWidth × 0.1
//     taper: true,
//     stroke: '#3a6',    // optional, otherwise caller sets ctx.strokeStyle
//   });
export function drawSmoothPath(ctx, path, opts = {}) {
  if (path.length < 2) return;
  const baseW = opts.lineWidth != null ? opts.lineWidth : 1;
  const tipW = opts.tipWidth != null ? opts.tipWidth : baseW * 0.1;
  const taper = !!opts.taper;
  if (opts.stroke) ctx.strokeStyle = opts.stroke;
  ctx.lineCap = opts.lineCap || 'round';
  ctx.lineJoin = opts.lineJoin || 'round';

  if (!taper) {
    ctx.lineWidth = baseW;
    ctx.beginPath();
    ctx.moveTo(path[0].x, path[0].y);
    for (let i = 1; i < path.length - 1; i++) {
      const xc = (path[i].x + path[i + 1].x) / 2;
      const yc = (path[i].y + path[i + 1].y) / 2;
      ctx.quadraticCurveTo(path[i].x, path[i].y, xc, yc);
    }
    ctx.lineTo(path[path.length - 1].x, path[path.length - 1].y);
    ctx.stroke();
    return;
  }

  // Tapered: per-segment stroke so width can change smoothly.
  for (let i = 1; i < path.length - 1; i++) {
    const a = path[i - 1], b = path[i], c = path[i + 1];
    const xc1 = (a.x + b.x) / 2, yc1 = (a.y + b.y) / 2;
    const xc2 = (b.x + c.x) / 2, yc2 = (b.y + c.y) / 2;
    const w = baseW + (tipW - baseW) * b.life;
    ctx.lineWidth = Math.max(0.1, w);
    ctx.beginPath();
    ctx.moveTo(xc1, yc1);
    ctx.quadraticCurveTo(b.x, b.y, xc2, yc2);
    ctx.stroke();
  }
}

// Spiral path — deliberate constant-rate rotation. Looks hand-drawn,
// not noise-drifty. Use for stylized vine curls / pixel-art tendrils
// where a clean 270°+ spiral matters more than organic curl.
//
//   const path = spiral({
//     x: 50, y: 100,
//     angle: -Math.PI / 2,        // initial heading
//     steps: 80,
//     step: 1,
//     rate: 0.06,                 // radians PER STEP (positive = CW, negative = CCW)
//     accel: 1.005,               // step-size multiplier per step (>1 = expanding spiral, <1 = tightening)
//     stopWhen: (x, y, t) => false,
//   });
//
// Pair with `branch()` by replacing the branch's turtle.angleDrift
// with a constant value (e.g. `() => 0.06`) for the same effect inside
// a tree of branches.
export function spiral(opts) {
  let x = opts.x, y = opts.y;
  let angle = opts.angle || 0;
  const steps = opts.steps;
  let step = opts.step;
  const rate = opts.rate || 0.05;
  const accel = opts.accel != null ? opts.accel : 1;
  const stopWhen = opts.stopWhen || (() => false);
  const path = [];
  for (let t = 0; t < steps; t++) {
    if (stopWhen(x, y, t)) break;
    path.push({ x, y, angle, t, life: t / Math.max(1, steps - 1) });
    angle += rate;
    x += Math.cos(angle) * step;
    y += Math.sin(angle) * step;
    step *= accel;
  }
  return path;
}

// Pixel-art path stamper — walk a path and stamp discrete `width`×`width`
// fillRect blocks at each sample's integer pixel. No quadratic curves,
// no anti-aliasing — gives a crisp pixel-art line. Sample stride lets
// you skip dense oversampling so the line has visible "pixel steps"
// rather than a continuous bevel.
//
//   drawPixelPath(sctx, path, {
//     color: '#3a8e3e',
//     width: 1,       // px per stamp (1 = 1px line, 2 = 2x2 block)
//     stride: 1,      // walk every Nth sample (higher = sparser pixels)
//     taper: false,   // if true, width drops to 0 at path end via life
//   });
//
// Stamps are tile-aligned via Math.floor; assumes the bake context
// has imageSmoothingEnabled=false (set by bakeCanvas() automatically).
export function drawPixelPath(ctx, path, opts = {}) {
  if (path.length === 0) return;
  const color = opts.color || '#fff';
  const width = opts.width != null ? opts.width : 1;
  const stride = opts.stride != null ? opts.stride : 1;
  const taper = !!opts.taper;
  ctx.fillStyle = color;
  for (let i = 0; i < path.length; i += stride) {
    const p = path[i];
    let w = width;
    if (taper) {
      w = Math.max(1, Math.round(width * (1 - p.life)));
    }
    const off = Math.floor(w / 2);
    ctx.fillRect(Math.floor(p.x) - off, Math.floor(p.y) - off, w, w);
  }
}

// ══════════════════════════════════════════════════════════════════════
// 8. Flow field — direction per cell
// ══════════════════════════════════════════════════════════════════════

// Build a flow field — a W×H grid of direction vectors derived from
// a noise function. Returns a sampler `(x, y) → angle` that turtle()
// can use as `angleDrift`.
//
// Flow fields produce more organized swirls/clusters than per-step
// noise: turtles drifting through them naturally tangle together
// because they share the field. Great for jungle vines, hair, fur.
//
//   const fld = flowField({
//     w: 300, h: 200,
//     cell: 8,
//     noise: simplex2D(rng(42)),
//     scale: 0.02,
//   });
//
//   const path = turtle({
//     x: 50, y: 50, angle: 0,
//     steps: 500, step: 2,
//     angleDrift: (x, y) => fld.angleAt(x, y) - lastAngle,
//   });
//
// The simpler integration: have the turtle TRACK the field directly
// rather than drift toward it. Set angle = fld.angleAt(x, y) each step.
export function flowField(opts) {
  const w = opts.w, h = opts.h;
  const cell = opts.cell || 8;
  const scale = opts.scale != null ? opts.scale : 0.02;
  const noise = opts.noise;
  const cols = Math.ceil(w / cell);
  const rows = Math.ceil(h / cell);
  const angles = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // Map noise -1..1 to -PI..PI for a full direction range.
      angles[r * cols + c] = noise(c * cell * scale, r * cell * scale) * Math.PI;
    }
  }
  return {
    angleAt(x, y) {
      const c = Math.max(0, Math.min(cols - 1, Math.floor(x / cell)));
      const r = Math.max(0, Math.min(rows - 1, Math.floor(y / cell)));
      return angles[r * cols + c];
    },
    cols, rows, cell,
  };
}

// ══════════════════════════════════════════════════════════════════════
// 9. Color
// ══════════════════════════════════════════════════════════════════════

// HSV → RGB. h, s, v all in 0..1. Returns {r, g, b} in 0..255.
export function hsvToRgb(h, s, v) {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let R, G, B;
  switch (i % 6) {
    case 0: R = v; G = t; B = p; break;
    case 1: R = q; G = v; B = p; break;
    case 2: R = p; G = v; B = t; break;
    case 3: R = p; G = q; B = v; break;
    case 4: R = t; G = p; B = v; break;
    case 5: R = v; G = p; B = q; break;
  }
  return { r: Math.round(R * 255), g: Math.round(G * 255), b: Math.round(B * 255) };
}

// RGB → HSV. r, g, b in 0..255. Returns {h, s, v} in 0..1.
export function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r)      h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else                h = (r - g) / d + 4;
    h /= 6; if (h < 0) h += 1;
  }
  const s = max === 0 ? 0 : d / max;
  return { h, s, v: max };
}

// Parse '#rgb' / '#rrggbb' / 'rgba(...)' / 'rgb(...)' → {r, g, b} 0..255.
export function parseColor(css) {
  if (!css) return { r: 255, g: 255, b: 255 };
  if (css[0] === '#') {
    if (css.length === 4) {
      return {
        r: parseInt(css[1] + css[1], 16),
        g: parseInt(css[2] + css[2], 16),
        b: parseInt(css[3] + css[3], 16),
      };
    }
    return {
      r: parseInt(css.slice(1, 3), 16),
      g: parseInt(css.slice(3, 5), 16),
      b: parseInt(css.slice(5, 7), 16),
    };
  }
  const m = css.match(/(\d+(?:\.\d+)?)/g);
  if (m && m.length >= 3) {
    return { r: parseFloat(m[0]), g: parseFloat(m[1]), b: parseFloat(m[2]) };
  }
  return { r: 255, g: 255, b: 255 };
}

// '#rrggbb' from {r, g, b} 0..255.
export function rgbToHex(r, g, b) {
  const h = n => n.toString(16).padStart(2, '0');
  return '#' + h(r | 0) + h(g | 0) + h(b | 0);
}

// HSV jitter — perturb a base color by random offsets in HSV space.
// More natural than per-channel RGB jitter (no muddy gray drift).
//
//   const variant = hsvJitter(r, '#3a6', { h: 0.05, s: 0.1, v: 0.15 });
//
//   • h: hue offset range (±max, in 0..1 HSV space — 0.05 ≈ ±18°)
//   • s: saturation offset range
//   • v: value offset range
export function hsvJitter(r, baseCss, opts = {}) {
  const dh = opts.h != null ? opts.h : 0;
  const ds = opts.s != null ? opts.s : 0;
  const dv = opts.v != null ? opts.v : 0;
  const c = parseColor(baseCss);
  const hsv = rgbToHsv(c.r, c.g, c.b);
  hsv.h = (hsv.h + (r() * 2 - 1) * dh + 1) % 1;
  hsv.s = Math.max(0, Math.min(1, hsv.s + (r() * 2 - 1) * ds));
  hsv.v = Math.max(0, Math.min(1, hsv.v + (r() * 2 - 1) * dv));
  const out = hsvToRgb(hsv.h, hsv.s, hsv.v);
  return rgbToHex(out.r, out.g, out.b);
}

// Linear interpolate between two colors. `t` in 0..1.
export function lerpColor(aCss, bCss, t) {
  const a = parseColor(aCss), b = parseColor(bCss);
  return rgbToHex(
    a.r + (b.r - a.r) * t,
    a.g + (b.g - a.g) * t,
    a.b + (b.b - a.b) * t,
  );
}

// Sample a palette gradient. Pass a list of CSS color stops; returns
// a function `(t) → '#rrggbb'` that lerps between adjacent stops.
//
//   const grass = paletteRamp(['#1a3a1c', '#3a6e2e', '#7eb850']);
//   const c = grass(0.5);   // midway between green and lime
export function paletteRamp(stops) {
  if (stops.length === 0) return () => '#fff';
  if (stops.length === 1) return () => stops[0];
  return function(t) {
    if (t <= 0) return stops[0];
    if (t >= 1) return stops[stops.length - 1];
    const f = t * (stops.length - 1);
    const i = Math.floor(f);
    return lerpColor(stops[i], stops[i + 1], f - i);
  };
}

// ══════════════════════════════════════════════════════════════════════
// 10. Pixel-art shapes — discrete pixel stamps, no anti-aliasing
// ══════════════════════════════════════════════════════════════════════
//
// All functions below take `ctx` and stamp 1-pixel-wide shapes at
// integer coords. Companions to drawPixelPath. Assume `ctx` has
// `imageSmoothingEnabled = false` (set by bakeCanvas() automatically).

// Bresenham line — discrete 1-pixel-wide line from (x0,y0) to (x1,y1).
export function pixelLine(ctx, x0, y0, x1, y1, color = '#fff') {
  ctx.fillStyle = color;
  x0 = Math.floor(x0); y0 = Math.floor(y0);
  x1 = Math.floor(x1); y1 = Math.floor(y1);
  let dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  while (true) {
    ctx.fillRect(x0, y0, 1, 1);
    if (x0 === x1 && y0 === y1) break;
    const e2 = err * 2;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 <  dx) { err += dx; y0 += sy; }
  }
}

// Midpoint-circle outline (1-pixel ring).
export function pixelCircle(ctx, cx, cy, r, color = '#fff') {
  ctx.fillStyle = color;
  cx = Math.floor(cx); cy = Math.floor(cy); r = Math.floor(r);
  if (r < 0) return;
  let x = r, y = 0, err = 0;
  while (x >= y) {
    ctx.fillRect(cx + x, cy + y, 1, 1);
    ctx.fillRect(cx - x, cy + y, 1, 1);
    ctx.fillRect(cx + x, cy - y, 1, 1);
    ctx.fillRect(cx - x, cy - y, 1, 1);
    ctx.fillRect(cx + y, cy + x, 1, 1);
    ctx.fillRect(cx - y, cy + x, 1, 1);
    ctx.fillRect(cx + y, cy - x, 1, 1);
    ctx.fillRect(cx - y, cy - x, 1, 1);
    if (err <= 0) { y++; err += 2 * y + 1; }
    if (err >  0) { x--; err -= 2 * x + 1; }
  }
}

// Filled disc.
export function pixelDisc(ctx, cx, cy, r, color = '#fff') {
  ctx.fillStyle = color;
  cx = Math.floor(cx); cy = Math.floor(cy); r = Math.floor(r);
  const r2 = r * r;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy <= r2) ctx.fillRect(cx + dx, cy + dy, 1, 1);
    }
  }
}

// Ellipse outline.
export function pixelEllipse(ctx, cx, cy, rx, ry, color = '#fff') {
  ctx.fillStyle = color;
  cx = Math.floor(cx); cy = Math.floor(cy);
  rx = Math.max(0, Math.floor(rx)); ry = Math.max(0, Math.floor(ry));
  let x = 0, y = ry;
  let rx2 = rx * rx, ry2 = ry * ry;
  let p = ry2 - rx2 * ry + 0.25 * rx2;
  while (2 * ry2 * x <= 2 * rx2 * y) {
    ctx.fillRect(cx + x, cy + y, 1, 1);
    ctx.fillRect(cx - x, cy + y, 1, 1);
    ctx.fillRect(cx + x, cy - y, 1, 1);
    ctx.fillRect(cx - x, cy - y, 1, 1);
    if (p < 0) { x++; p += 2 * ry2 * x + ry2; }
    else { x++; y--; p += 2 * ry2 * x - 2 * rx2 * y + ry2; }
  }
  p = ry2 * (x + 0.5) * (x + 0.5) + rx2 * (y - 1) * (y - 1) - rx2 * ry2;
  while (y >= 0) {
    ctx.fillRect(cx + x, cy + y, 1, 1);
    ctx.fillRect(cx - x, cy + y, 1, 1);
    ctx.fillRect(cx + x, cy - y, 1, 1);
    ctx.fillRect(cx - x, cy - y, 1, 1);
    if (p > 0) { y--; p -= 2 * rx2 * y + rx2; }
    else { y--; x++; p += 2 * ry2 * x - 2 * rx2 * y + rx2; }
  }
}

// Filled ellipse.
export function pixelEllipseDisc(ctx, cx, cy, rx, ry, color = '#fff') {
  ctx.fillStyle = color;
  cx = Math.floor(cx); cy = Math.floor(cy);
  for (let dy = -ry; dy <= ry; dy++) {
    for (let dx = -rx; dx <= rx; dx++) {
      if ((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) <= 1) {
        ctx.fillRect(cx + dx, cy + dy, 1, 1);
      }
    }
  }
}

// Rectangle outline (1-pixel border).
export function pixelRect(ctx, x, y, w, h, color = '#fff') {
  ctx.fillStyle = color;
  x = Math.floor(x); y = Math.floor(y);
  w = Math.floor(w); h = Math.floor(h);
  if (w <= 0 || h <= 0) return;
  ctx.fillRect(x, y, w, 1);
  ctx.fillRect(x, y + h - 1, w, 1);
  ctx.fillRect(x, y, 1, h);
  ctx.fillRect(x + w - 1, y, 1, h);
}

// Annulus / ring (filled disc with hole).
export function pixelRing(ctx, cx, cy, ri, ro, color = '#fff') {
  ctx.fillStyle = color;
  cx = Math.floor(cx); cy = Math.floor(cy);
  const ri2 = ri * ri, ro2 = ro * ro;
  for (let dy = -ro; dy <= ro; dy++) {
    for (let dx = -ro; dx <= ro; dx++) {
      const d2 = dx * dx + dy * dy;
      if (d2 <= ro2 && d2 >= ri2) ctx.fillRect(cx + dx, cy + dy, 1, 1);
    }
  }
}

// Filled diamond (rotated square, manhattan distance ≤ r).
export function pixelDiamond(ctx, cx, cy, r, color = '#fff') {
  ctx.fillStyle = color;
  cx = Math.floor(cx); cy = Math.floor(cy);
  for (let dy = -r; dy <= r; dy++) {
    const w = r - Math.abs(dy);
    ctx.fillRect(cx - w, cy + dy, 2 * w + 1, 1);
  }
}

// Diamond outline (1-pixel border).
export function pixelDiamondHollow(ctx, cx, cy, r, color = '#fff') {
  ctx.fillStyle = color;
  cx = Math.floor(cx); cy = Math.floor(cy);
  for (let dy = -r; dy <= r; dy++) {
    const w = r - Math.abs(dy);
    if (w === 0) ctx.fillRect(cx, cy + dy, 1, 1);
    else { ctx.fillRect(cx - w, cy + dy, 1, 1); ctx.fillRect(cx + w, cy + dy, 1, 1); }
  }
}

// Plus sign / crosshair.
export function pixelCross(ctx, cx, cy, r, color = '#fff') {
  ctx.fillStyle = color;
  cx = Math.floor(cx); cy = Math.floor(cy);
  ctx.fillRect(cx - r, cy, 2 * r + 1, 1);
  ctx.fillRect(cx, cy - r, 1, 2 * r + 1);
}

// X-mark (diagonal cross).
export function pixelX(ctx, cx, cy, r, color = '#fff') {
  pixelLine(ctx, cx - r, cy - r, cx + r, cy + r, color);
  pixelLine(ctx, cx - r, cy + r, cx + r, cy - r, color);
}

// ══════════════════════════════════════════════════════════════════════
// 11. Pixel-art curves — beziers as discrete pixels
// ══════════════════════════════════════════════════════════════════════

// Quadratic bezier P0→P1→P2 rasterized as discrete pixels (lineify by
// sampling fine then connecting samples with bresenham). Cleaner than
// canvas's anti-aliased quadraticCurveTo for pixel-art aesthetics.
export function bezier2pixel(ctx, p0, p1, p2, opts = {}) {
  const color = opts.color || '#fff';
  const steps = opts.steps || 64;
  let prevX = p0.x, prevY = p0.y;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, u = 1 - t;
    const x = u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x;
    const y = u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y;
    pixelLine(ctx, prevX, prevY, x, y, color);
    prevX = x; prevY = y;
  }
}

// Cubic bezier P0→P1→P2→P3 rasterized.
export function bezier3pixel(ctx, p0, p1, p2, p3, opts = {}) {
  const color = opts.color || '#fff';
  const steps = opts.steps || 96;
  let prevX = p0.x, prevY = p0.y;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, u = 1 - t;
    const x = u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x;
    const y = u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y;
    pixelLine(ctx, prevX, prevY, x, y, color);
    prevX = x; prevY = y;
  }
}

// ══════════════════════════════════════════════════════════════════════
// 12. Symmetry — mirror / bilateral / radial
// ══════════════════════════════════════════════════════════════════════

// SSR-safe temp canvas helper.
function _tempCanvas(w, h) {
  if (typeof document === 'undefined') {
    throw new Error('[procgen] DOM required for symmetry primitives');
  }
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// Run a draw callback into a temp canvas, then blit normally PLUS
// mirrored across one or both axes. `axis`:
//   'x'  — flip horizontally (left/right mirror)
//   'y'  — flip vertically (top/bottom mirror)
//   'xy' — both (4 quadrants)
//   'r4' — 4-way radial (0°, 90°, 180°, 270° rotations)
//   'r8' — 8-way radial (every 45°)
//
//   mirror(ctx, 32, 32, 'r8', (sctx) => {
//     // draw a wedge that gets replicated 8 times around the center
//     pixelLine(sctx, 16, 16, 16, 4, '#fff');
//   });
export function mirror(ctx, w, h, axis, drawFn) {
  const tmp = _tempCanvas(w, h);
  const tctx = tmp.getContext('2d');
  tctx.imageSmoothingEnabled = false;
  drawFn(tctx);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, 0, 0);
  if (axis === 'x' || axis === 'xy') {
    ctx.save(); ctx.translate(w, 0); ctx.scale(-1, 1);
    ctx.drawImage(tmp, 0, 0); ctx.restore();
  }
  if (axis === 'y' || axis === 'xy') {
    ctx.save(); ctx.translate(0, h); ctx.scale(1, -1);
    ctx.drawImage(tmp, 0, 0); ctx.restore();
  }
  if (axis === 'xy') {
    ctx.save(); ctx.translate(w, h); ctx.scale(-1, -1);
    ctx.drawImage(tmp, 0, 0); ctx.restore();
  }
  if (axis === 'r4') {
    for (let i = 1; i < 4; i++) {
      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.rotate(i * Math.PI / 2);
      ctx.translate(-w / 2, -h / 2);
      ctx.drawImage(tmp, 0, 0);
      ctx.restore();
    }
  }
  if (axis === 'r8') {
    for (let i = 1; i < 8; i++) {
      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.rotate(i * Math.PI / 4);
      ctx.translate(-w / 2, -h / 2);
      ctx.drawImage(tmp, 0, 0);
      ctx.restore();
    }
  }
  ctx.restore();
}

// Bilateral — draw something into the temp's left half, then the
// whole tmp gets stamped + mirrored on top. If drawFn only fills the
// left half (x < w/2), the result is a perfect bilateral-symmetric
// sprite. If it draws across the full width, things stack symmetrically.
//
//   bilateral(ctx, 16, 24, (sctx) => {
//     // Draw the left side of a creature; right side mirrors.
//     pixelDisc(sctx, 6, 8, 2, '#3a8e3e');
//     pixelLine(sctx, 6, 12, 4, 20, '#1a3a1c');
//   });
export function bilateral(ctx, w, h, drawFn) {
  const tmp = _tempCanvas(w, h);
  const tctx = tmp.getContext('2d');
  tctx.imageSmoothingEnabled = false;
  drawFn(tctx);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, 0, 0);
  ctx.translate(w, 0); ctx.scale(-1, 1);
  ctx.drawImage(tmp, 0, 0);
  ctx.restore();
}

// ══════════════════════════════════════════════════════════════════════
// 13. Sprite cleanup — outline, dilate, erode, silhouette
// ══════════════════════════════════════════════════════════════════════
//
// Operate on an HTMLCanvasElement in-place (read pixels, write pixels).
// The sprite's transparent pixels are the "background"; opaque pixels
// are the "shape." Sprite-cleanup ops modify the shape in canonical
// pixel-art ways.

// Add a 1-pixel outline of `color` around all opaque pixels. The outline
// goes INTO the transparent area (doesn't overwrite the existing sprite).
//
// ⚠️ NAME COLLISION: `effects.js` ALSO exports `outline` — that one is
// a draw-with-glowy-ring helper that wraps a draw callback. When
// importing both modules in the same file, alias one of them:
//
//     import { outline } from '../core/effects.js';
//     import { outline as pgOutline } from '../core/procgen.js';
//
// Procgen.outline = "scan a baked canvas, add a 1-pixel border."
// Effects.outline = "render with a glowy ring AROUND a draw callback."
// Same word, different abstractions.
export function outline(canvas, color = '#000') {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  if (w === 0 || h === 0) return;
  const src = ctx.getImageData(0, 0, w, h);
  const dst = ctx.createImageData(w, h);
  dst.data.set(src.data);
  const c = parseColor(color);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (src.data[i + 3] !== 0) continue;
      let touch = false;
      if (x > 0     && src.data[(y * w + x - 1) * 4 + 3] > 0) touch = true;
      if (!touch && x < w - 1 && src.data[(y * w + x + 1) * 4 + 3] > 0) touch = true;
      if (!touch && y > 0     && src.data[((y - 1) * w + x) * 4 + 3] > 0) touch = true;
      if (!touch && y < h - 1 && src.data[((y + 1) * w + x) * 4 + 3] > 0) touch = true;
      if (touch) {
        dst.data[i] = c.r; dst.data[i+1] = c.g; dst.data[i+2] = c.b; dst.data[i+3] = 255;
      }
    }
  }
  ctx.putImageData(dst, 0, 0);
}

// Grow the opaque region by `n` pixels in 4 directions per pass. New
// pixels copy the color of an opaque neighbor (or `color` if provided).
export function dilate(canvas, n = 1, color = null) {
  for (let pass = 0; pass < n; pass++) _dilatePass(canvas, color);
}
function _dilatePass(canvas, color) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const src = ctx.getImageData(0, 0, w, h);
  const dst = ctx.createImageData(w, h);
  dst.data.set(src.data);
  const c = color ? parseColor(color) : null;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (src.data[i + 3] !== 0) continue;
      let nr = -1, ng = 0, nb = 0;
      if (x > 0     && src.data[(y * w + x - 1) * 4 + 3] > 0) { const j = (y * w + x - 1) * 4; nr = src.data[j]; ng = src.data[j+1]; nb = src.data[j+2]; }
      else if (x < w - 1 && src.data[(y * w + x + 1) * 4 + 3] > 0) { const j = (y * w + x + 1) * 4; nr = src.data[j]; ng = src.data[j+1]; nb = src.data[j+2]; }
      else if (y > 0     && src.data[((y - 1) * w + x) * 4 + 3] > 0) { const j = ((y - 1) * w + x) * 4; nr = src.data[j]; ng = src.data[j+1]; nb = src.data[j+2]; }
      else if (y < h - 1 && src.data[((y + 1) * w + x) * 4 + 3] > 0) { const j = ((y + 1) * w + x) * 4; nr = src.data[j]; ng = src.data[j+1]; nb = src.data[j+2]; }
      if (nr >= 0) {
        if (c) { dst.data[i] = c.r; dst.data[i+1] = c.g; dst.data[i+2] = c.b; }
        else   { dst.data[i] = nr;  dst.data[i+1] = ng;  dst.data[i+2] = nb;  }
        dst.data[i + 3] = 255;
      }
    }
  }
  ctx.putImageData(dst, 0, 0);
}

// Shrink the opaque region by `n` pixels per pass — opaque pixels
// adjacent to transparent become transparent.
export function erode(canvas, n = 1) {
  for (let pass = 0; pass < n; pass++) _erodePass(canvas);
}
function _erodePass(canvas) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const src = ctx.getImageData(0, 0, w, h);
  const dst = ctx.createImageData(w, h);
  dst.data.set(src.data);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (src.data[i + 3] === 0) continue;
      let trans = false;
      if (x === 0 || x === w - 1 || y === 0 || y === h - 1) trans = true;
      if (!trans && src.data[(y * w + x - 1) * 4 + 3] === 0) trans = true;
      if (!trans && src.data[(y * w + x + 1) * 4 + 3] === 0) trans = true;
      if (!trans && src.data[((y - 1) * w + x) * 4 + 3] === 0) trans = true;
      if (!trans && src.data[((y + 1) * w + x) * 4 + 3] === 0) trans = true;
      if (trans) dst.data[i + 3] = 0;
    }
  }
  ctx.putImageData(dst, 0, 0);
}

// Flatten all non-transparent pixels to a single color (useful for
// shadow casting, stencil work, mask generation).
export function silhouette(canvas, color = '#000') {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const data = ctx.getImageData(0, 0, w, h);
  const c = parseColor(color);
  for (let i = 0; i < data.data.length; i += 4) {
    if (data.data[i + 3] > 0) {
      data.data[i] = c.r; data.data[i + 1] = c.g; data.data[i + 2] = c.b;
      data.data[i + 3] = 255;
    }
  }
  ctx.putImageData(data, 0, 0);
}

// Flood-fill the connected region containing (x,y) with `color`. Uses
// iterative scanline fill — handles big regions without stack overflow.
export function floodFill(canvas, x, y, color = '#fff') {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  x = Math.floor(x); y = Math.floor(y);
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  const data = ctx.getImageData(0, 0, w, h);
  const c = parseColor(color);
  const i0 = (y * w + x) * 4;
  const tr = data.data[i0], tg = data.data[i0 + 1], tb = data.data[i0 + 2], ta = data.data[i0 + 3];
  if (tr === c.r && tg === c.g && tb === c.b && ta === 255) return; // already that color
  const stack = [[x, y]];
  while (stack.length) {
    const [sx, sy] = stack.pop();
    let lx = sx;
    while (lx >= 0 && _matchPx(data.data, (sy * w + lx) * 4, tr, tg, tb, ta)) lx--;
    lx++;
    let rx = sx;
    while (rx < w && _matchPx(data.data, (sy * w + rx) * 4, tr, tg, tb, ta)) rx++;
    rx--;
    for (let fx = lx; fx <= rx; fx++) {
      const j = (sy * w + fx) * 4;
      data.data[j] = c.r; data.data[j + 1] = c.g; data.data[j + 2] = c.b; data.data[j + 3] = 255;
    }
    for (let fx = lx; fx <= rx; fx++) {
      if (sy > 0     && _matchPx(data.data, ((sy - 1) * w + fx) * 4, tr, tg, tb, ta)) stack.push([fx, sy - 1]);
      if (sy < h - 1 && _matchPx(data.data, ((sy + 1) * w + fx) * 4, tr, tg, tb, ta)) stack.push([fx, sy + 1]);
    }
  }
  ctx.putImageData(data, 0, 0);
}
function _matchPx(d, i, r, g, b, a) {
  return d[i] === r && d[i + 1] === g && d[i + 2] === b && d[i + 3] === a;
}

// ══════════════════════════════════════════════════════════════════════
// 14. Patterns — fill textures (hatching, crosshatch, stipple, checker)
// ══════════════════════════════════════════════════════════════════════

// Diagonal hatching — parallel lines at `angle` (radians) with `spacing`
// pixels between lines. Useful for shading a region with one color.
export function hatching(ctx, x, y, w, h, opts = {}) {
  const color = opts.color || '#000';
  const spacing = opts.spacing || 3;
  const angle = opts.angle != null ? opts.angle : Math.PI / 4;
  ctx.fillStyle = color;
  const sa = Math.sin(angle), ca = Math.cos(angle);
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const d = px * sa - py * ca;
      const m = ((d % spacing) + spacing) % spacing;
      if (m < 1) ctx.fillRect(x + px, y + py, 1, 1);
    }
  }
}

// Crosshatch — two hatching passes at perpendicular angles.
export function crosshatch(ctx, x, y, w, h, opts = {}) {
  hatching(ctx, x, y, w, h, opts);
  hatching(ctx, x, y, w, h, Object.assign({}, opts,
    { angle: -((opts.angle != null ? opts.angle : Math.PI / 4)) }));
}

// Stipple — random dot density (rng-driven). Pass `density` 0..1.
export function stipple(ctx, x, y, w, h, opts = {}) {
  const r = opts.rng || rng(1);
  const color = opts.color || '#000';
  const density = opts.density != null ? opts.density : 0.1;
  ctx.fillStyle = color;
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      if (r() < density) ctx.fillRect(x + px, y + py, 1, 1);
    }
  }
}

// Checkerboard pattern. `cellSize` is in pixels.
export function checker(ctx, x, y, w, h, opts = {}) {
  const a = opts.colorA || '#000';
  const b = opts.colorB || '#fff';
  const cellSize = opts.cellSize || 2;
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const cx = Math.floor(px / cellSize);
      const cy = Math.floor(py / cellSize);
      ctx.fillStyle = ((cx + cy) % 2 === 0) ? a : b;
      ctx.fillRect(x + px, y + py, 1, 1);
    }
  }
}

// ══════════════════════════════════════════════════════════════════════
// 15. Dithering — quantize to a palette with a dithered approximation
// ══════════════════════════════════════════════════════════════════════

// 4×4 Bayer matrix — values 0..15, normalized to 0..1 via /16.
const _BAYER_4 = [
  [ 0,  8,  2, 10],
  [12,  4, 14,  6],
  [ 3, 11,  1,  9],
  [15,  7, 13,  5],
];

// Bayer ordered dithering — quantize each pixel to nearest palette
// color BIASED by the bayer matrix offset. Produces a regular dot
// pattern (looks "retro CRT" / "GameBoy"). Cheap and deterministic.
export function bayerDither(canvas, palette) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const data = ctx.getImageData(0, 0, w, h);
  const palRgb = palette.map(parseColor);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const offset = (_BAYER_4[y & 3][x & 3] / 16 - 0.5) * 32;
      const r = data.data[i] + offset;
      const g = data.data[i + 1] + offset;
      const b = data.data[i + 2] + offset;
      let best = palRgb[0], bestD = Infinity;
      for (let k = 0; k < palRgb.length; k++) {
        const p = palRgb[k];
        const d = (p.r - r) * (p.r - r) + (p.g - g) * (p.g - g) + (p.b - b) * (p.b - b);
        if (d < bestD) { bestD = d; best = p; }
      }
      data.data[i] = best.r; data.data[i + 1] = best.g; data.data[i + 2] = best.b;
    }
  }
  ctx.putImageData(data, 0, 0);
}

// Floyd-Steinberg error-diffusion dithering. Distributes the
// quantization error to the right + below neighbors using the
// 7/16 - 3/16 - 5/16 - 1/16 kernel. Looks more "natural" than Bayer
// but lacks the regular pattern that some pixel-art aesthetics want.
export function floydSteinberg(canvas, palette) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const data = ctx.getImageData(0, 0, w, h);
  const palRgb = palette.map(parseColor);
  // Working buffer in float for negative error values.
  const buf = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    buf[i * 3]     = data.data[i * 4];
    buf[i * 3 + 1] = data.data[i * 4 + 1];
    buf[i * 3 + 2] = data.data[i * 4 + 2];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const r = buf[i], g = buf[i + 1], b = buf[i + 2];
      let best = palRgb[0], bestD = Infinity;
      for (let k = 0; k < palRgb.length; k++) {
        const p = palRgb[k];
        const d = (p.r - r) * (p.r - r) + (p.g - g) * (p.g - g) + (p.b - b) * (p.b - b);
        if (d < bestD) { bestD = d; best = p; }
      }
      const er = r - best.r, eg = g - best.g, eb = b - best.b;
      buf[i] = best.r; buf[i + 1] = best.g; buf[i + 2] = best.b;
      const distribute = (dx, dy, w16) => {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) return;
        const j = (ny * w + nx) * 3;
        buf[j]     += er * w16 / 16;
        buf[j + 1] += eg * w16 / 16;
        buf[j + 2] += eb * w16 / 16;
      };
      distribute( 1, 0, 7);
      distribute(-1, 1, 3);
      distribute( 0, 1, 5);
      distribute( 1, 1, 1);
    }
  }
  for (let i = 0; i < w * h; i++) {
    data.data[i * 4]     = buf[i * 3];
    data.data[i * 4 + 1] = buf[i * 3 + 1];
    data.data[i * 4 + 2] = buf[i * 3 + 2];
  }
  ctx.putImageData(data, 0, 0);
}

// ══════════════════════════════════════════════════════════════════════
// 16. Cellular noise — Worley / Voronoi
// ══════════════════════════════════════════════════════════════════════

// Worley noise — distance to nearest seed point. Returns a function
// (x, y) → distance. Use for cellular textures: scales, cracks, stones.
//
//   const w = worley2D({ rng: rng(42), cellSize: 24 });
//   const d = w(x, y);          // 0 = on a seed, large = far from any
//   const t = Math.min(1, d / 24);  // 0..1ish
export function worley2D(opts) {
  const cellSize = opts.cellSize || 32;
  const baseSeed = opts.seed || 1;
  const cache = new Map();
  function seedFor(cx, cy) {
    const k = cx + ',' + cy;
    let s = cache.get(k);
    if (!s) {
      const local = rng(((cx * 73856093) ^ (cy * 19349663) ^ baseSeed) >>> 0);
      s = { x: cx * cellSize + local() * cellSize, y: cy * cellSize + local() * cellSize };
      cache.set(k, s);
    }
    return s;
  }
  return function(x, y) {
    const cx = Math.floor(x / cellSize), cy = Math.floor(y / cellSize);
    let minD = Infinity;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const s = seedFor(cx + ox, cy + oy);
        const dx = s.x - x, dy = s.y - y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < minD) minD = d;
      }
    }
    return minD;
  };
}

// Voronoi — partition w×h into N cells. Returns `{ seeds, cellAt }`.
//   const v = voronoi2D({ rng: rng(42), w: 200, h: 200, count: 24 });
//   const id = v.cellAt(x, y);  // which cell does this pixel belong to?
export function voronoi2D(opts) {
  const r = opts.rng;
  const w = opts.w, h = opts.h;
  const count = opts.count || 16;
  const seeds = [];
  for (let i = 0; i < count; i++) {
    seeds.push({ x: r() * w, y: r() * h, id: i });
  }
  return {
    seeds,
    cellAt(x, y) {
      let bestId = 0, bestD = Infinity;
      for (let i = 0; i < seeds.length; i++) {
        const dx = seeds[i].x - x, dy = seeds[i].y - y;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; bestId = i; }
      }
      return bestId;
    },
  };
}

// ══════════════════════════════════════════════════════════════════════
// 17. Domain warp — feed noise position through another noise
// ══════════════════════════════════════════════════════════════════════

// Domain warp — sample `noise` at warped coordinates. The warp is
// driven by `warpNoise` (typically the same simplex with a different
// seed). Produces non-axis-aligned organic distortion — clouds,
// magma flows, fabric textures.
//
//   const base = simplex2D(rng(1));
//   const warp = simplex2D(rng(2));
//   const warped = domainWarp(base, warp, { strength: 8, scale: 0.05 });
export function domainWarp(noise, warpNoise, opts = {}) {
  const strength = opts.strength != null ? opts.strength : 8;
  const scale = opts.scale != null ? opts.scale : 0.1;
  return function(x, y) {
    const dx = warpNoise(x * scale,         y * scale)         * strength;
    const dy = warpNoise(x * scale + 100,   y * scale + 100)   * strength;
    return noise(x + dx, y + dy);
  };
}

// ══════════════════════════════════════════════════════════════════════
// 18. Cellular automaton — Conway-style rule iteration
// ══════════════════════════════════════════════════════════════════════

// Apply CA rules to a Uint8Array grid. Cells are 0/1.
//   rules: { birth: [n0, n1, ...], survive: [n0, n1, ...] }
// Default: Conway's Game of Life ({ birth: [3], survive: [2,3] }).
// Famous cave-generation rule: { birth: [5,6,7,8], survive: [4,5,6,7,8] }
// over 4-5 iterations of a 45%-density random grid.
export function cellularAutomaton(grid, w, h, rules, iterations = 1) {
  const _r = rules || { birth: [3], survive: [2, 3] };
  const birth = new Set(_r.birth);
  const survive = new Set(_r.survive);
  let buf = grid;
  let scratch = new Uint8Array(w * h);
  for (let it = 0; it < iterations; it++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let live = 0;
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            if (ox === 0 && oy === 0) continue;
            const nx = x + ox, ny = y + oy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            if (buf[ny * w + nx]) live++;
          }
        }
        const wasLive = !!buf[y * w + x];
        const willLive = wasLive ? survive.has(live) : birth.has(live);
        scratch[y * w + x] = willLive ? 1 : 0;
      }
    }
    const t = buf; buf = scratch; scratch = t;
  }
  // Make the result the SAME ARRAY the caller passed (in-place feel).
  if (buf !== grid) grid.set(buf);
  return grid;
}

// ══════════════════════════════════════════════════════════════════════
// 19. L-systems — string rewriting + turtle interpreter
// ══════════════════════════════════════════════════════════════════════

// Expand `axiom` by replacing each character with `rules[ch]` per
// iteration. Returns the final expanded string.
//
//   const s = lsystem('F', { 'F': 'F+F-F-F+F' }, 4);   // Koch curve
export function lsystem(axiom, rules, iterations = 4) {
  let s = axiom;
  for (let i = 0; i < iterations; i++) {
    let next = '';
    for (let c = 0; c < s.length; c++) {
      const ch = s[c];
      next += rules[ch] != null ? rules[ch] : ch;
    }
    s = next;
  }
  return s;
}

// Interpret an L-system string with a turtle. Returns line segments.
// Standard commands:
//   F — move forward `step` and emit a draw segment
//   f — move forward `step` without drawing
//   + — turn left by `turn` radians
//   - — turn right by `turn` radians
//   [ — push (x, y, angle)
//   ] — pop  (x, y, angle)
// Custom commands handled via opts.handlers[ch] — receives turtle state.
//
//   const s = lsystem('F', { F: 'F[+F]F[-F]F' }, 4);
//   const segs = interpretLsystem(s, {
//     x: 100, y: 200, angle: -Math.PI/2,
//     step: 4, turn: Math.PI/8,
//   });
//   for (const seg of segs) pixelLine(ctx, seg.x0, seg.y0, seg.x1, seg.y1);
export function interpretLsystem(s, opts) {
  let x = opts.x || 0, y = opts.y || 0;
  let angle = opts.angle || 0;
  const step = opts.step != null ? opts.step : 1;
  const turn = opts.turn != null ? opts.turn : Math.PI / 6;
  const stack = [];
  const segments = [];
  const handlers = opts.handlers || {};
  for (let c = 0; c < s.length; c++) {
    const ch = s[c];
    if (ch === 'F') {
      const nx = x + Math.cos(angle) * step;
      const ny = y + Math.sin(angle) * step;
      segments.push({ x0: x, y0: y, x1: nx, y1: ny });
      x = nx; y = ny;
    } else if (ch === 'f') {
      x += Math.cos(angle) * step;
      y += Math.sin(angle) * step;
    } else if (ch === '+') {
      angle -= turn;
    } else if (ch === '-') {
      angle += turn;
    } else if (ch === '[') {
      stack.push({ x, y, angle });
    } else if (ch === ']') {
      const st = stack.pop();
      if (st) { x = st.x; y = st.y; angle = st.angle; }
    } else if (handlers[ch]) {
      handlers[ch]({ x, y, angle, step, turn });
    }
  }
  return segments;
}

// ══════════════════════════════════════════════════════════════════════
// 20. Sprite stamping — rotate / flip / scale
// ══════════════════════════════════════════════════════════════════════

// Stamp a baked sprite at (x, y) with optional rotation (degrees,
// pixel-perfect at 0/90/180/270), horizontal/vertical flip, and
// integer scale. Maintains pixel-art crispness via no smoothing.
//
//   stamp(ctx, leafSprite, 16, 24, { rotate: 90, flipX: true, scale: 2 });
export function stamp(ctx, sprite, x, y, opts = {}) {
  const rotate = opts.rotate || 0;
  const flipX = !!opts.flipX;
  const flipY = !!opts.flipY;
  const scale = Math.max(1, Math.floor(opts.scale || 1));
  const w = sprite.width || sprite.naturalWidth || 0;
  const h = sprite.height || sprite.naturalHeight || 0;
  if (w === 0 || h === 0) return;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.translate(Math.floor(x + (w * scale) / 2), Math.floor(y + (h * scale) / 2));
  if (rotate) ctx.rotate(rotate * Math.PI / 180);
  ctx.scale(flipX ? -scale : scale, flipY ? -scale : scale);
  ctx.drawImage(sprite, -Math.floor(w / 2), -Math.floor(h / 2));
  ctx.restore();
}

// ══════════════════════════════════════════════════════════════════════
// 21. Wave Function Collapse — tile-based generation with adjacency
// ══════════════════════════════════════════════════════════════════════

// Simplified WFC. `tiles` is an array of `{ id, weight, edges: { N, E, S, W } }`
// where edges are arbitrary equality keys. Two tiles can be neighbors in
// direction D if tile1.edges[D] === tile2.edges[opposite(D)].
//
// Returns Int32Array(w*h) of tile indices into `tiles`. Throws on
// contradiction — caller can retry with a different seed.
//
//   const grid = waveFunctionCollapse({
//     rng: rng(42), w: 16, h: 16, tiles: [
//       { id: 'grass', weight: 5, edges: { N: 'g', E: 'g', S: 'g', W: 'g' } },
//       { id: 'edge',  weight: 1, edges: { N: 'g', E: 's', S: 's', W: 'g' } },
//       { id: 'sand',  weight: 3, edges: { N: 's', E: 's', S: 's', W: 's' } },
//     ],
//   });
export function waveFunctionCollapse(opts) {
  const r = opts.rng;
  const w = opts.w, h = opts.h;
  const tiles = opts.tiles;
  const N = tiles.length;
  // Precompute compatibility: compat[ti][dir] = Set of tile indices that fit
  const DIRS = [
    ['E',  1,  0, 'W'],
    ['W', -1,  0, 'E'],
    ['S',  0,  1, 'N'],
    ['N',  0, -1, 'S'],
  ];
  const compat = [];
  for (let ti = 0; ti < N; ti++) {
    compat.push({});
    for (const [d, , , opp] of DIRS) {
      const set = new Set();
      for (let oj = 0; oj < N; oj++) {
        if (tiles[ti].edges[d] === tiles[oj].edges[opp]) set.add(oj);
      }
      compat[ti][d] = set;
    }
  }
  const cells = [];
  for (let i = 0; i < w * h; i++) {
    const all = new Set();
    for (let k = 0; k < N; k++) all.add(k);
    cells.push(all);
  }
  function propagate(cx, cy) {
    const stack = [[cx, cy]];
    while (stack.length) {
      const [x, y] = stack.pop();
      const cell = cells[y * w + x];
      for (const [d, dx, dy] of DIRS) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const allowed = new Set();
        for (const ti of cell) for (const ok of compat[ti][d]) allowed.add(ok);
        const ncell = cells[ny * w + nx];
        let changed = false;
        for (const ti of ncell) {
          if (!allowed.has(ti)) { ncell.delete(ti); changed = true; }
        }
        if (changed) {
          if (ncell.size === 0) throw new Error('[wfc] contradiction at ' + nx + ',' + ny);
          stack.push([nx, ny]);
        }
      }
    }
  }
  while (true) {
    let bestX = -1, bestY = -1, bestE = Infinity;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const sz = cells[y * w + x].size;
        if (sz > 1 && sz < bestE) { bestE = sz; bestX = x; bestY = y; }
      }
    }
    if (bestX < 0) break;
    const cell = cells[bestY * w + bestX];
    const candidates = [];
    const weights = [];
    let total = 0;
    for (const ti of cell) {
      candidates.push(ti);
      const wt = tiles[ti].weight || 1;
      weights.push(wt);
      total += wt;
    }
    let pick = r() * total;
    let chosen = candidates[0];
    for (let i = 0; i < candidates.length; i++) {
      pick -= weights[i];
      if (pick <= 0) { chosen = candidates[i]; break; }
    }
    cell.clear();
    cell.add(chosen);
    propagate(bestX, bestY);
  }
  const out = new Int32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const it = cells[i].values().next();
    out[i] = it.done ? -1 : it.value;
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════
// 22. BSP partition — recursive room layout
// ══════════════════════════════════════════════════════════════════════

// Binary Space Partition — recursively split a rectangle until each
// leaf is below `minSize` or `maxDepth` is reached. Returns a tree
// where each node is `{ rect: {x,y,w,h}, children: [node,node]|[] }`.
//
// Use for procedural dungeon room layout: leaf rectangles are room
// candidates, and you connect them via corridors using their centers.
export function bsp(rect, opts) {
  const r = opts.rng;
  const minSize = opts.minSize || 8;
  const maxDepth = opts.maxDepth != null ? opts.maxDepth : 6;
  const splitJitter = opts.splitJitter != null ? opts.splitJitter : 0.4;
  function partition(rect, depth) {
    if (depth >= maxDepth) return { rect, children: [] };
    const canH = rect.h >= minSize * 2;
    const canV = rect.w >= minSize * 2;
    if (!canH && !canV) return { rect, children: [] };
    let horizontal;
    if      (rect.w / rect.h > 1.4 && canV) horizontal = false;
    else if (rect.h / rect.w > 1.4 && canH) horizontal = true;
    else if (canH && canV) horizontal = r() < 0.5;
    else                   horizontal = canH;
    if (horizontal) {
      const range = rect.h - minSize * 2;
      const split = minSize + Math.floor(rect.h / 2 - range * splitJitter / 2 + r() * range * splitJitter);
      return {
        rect, children: [
          partition({ x: rect.x, y: rect.y, w: rect.w, h: split }, depth + 1),
          partition({ x: rect.x, y: rect.y + split, w: rect.w, h: rect.h - split }, depth + 1),
        ],
      };
    } else {
      const range = rect.w - minSize * 2;
      const split = minSize + Math.floor(rect.w / 2 - range * splitJitter / 2 + r() * range * splitJitter);
      return {
        rect, children: [
          partition({ x: rect.x, y: rect.y, w: split, h: rect.h }, depth + 1),
          partition({ x: rect.x + split, y: rect.y, w: rect.w - split, h: rect.h }, depth + 1),
        ],
      };
    }
  }
  return partition(rect, 0);
}

// Walk a BSP tree and return only the leaf rects.
export function bspLeaves(node) {
  const out = [];
  function walk(n) {
    if (n.children.length === 0) out.push(n.rect);
    else for (const c of n.children) walk(c);
  }
  walk(node);
  return out;
}

// ══════════════════════════════════════════════════════════════════════
// 23. Marching squares — convert scalar field to vector outline
// ══════════════════════════════════════════════════════════════════════

// Generate line segments tracing the contour at `threshold` through a
// scalar field. `grid` is a w×h Float32Array (or similar). Returns
// array of `{ x0, y0, x1, y1 }` segments. Saddle cases (5, 10) split
// into two segments.
//
// Useful for: outlining a noise heightfield (`grid[i] = noise(x*0.05, y*0.05)`)
// to get an organic silhouette, then rasterizing the silhouette as
// pixel art.
export function marchingSquares(grid, w, h, threshold = 0.5) {
  const segs = [];
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const tl = grid[y * w + x] >= threshold ? 1 : 0;
      const tr = grid[y * w + x + 1] >= threshold ? 1 : 0;
      const br = grid[(y + 1) * w + x + 1] >= threshold ? 1 : 0;
      const bl = grid[(y + 1) * w + x] >= threshold ? 1 : 0;
      const code = (tl << 3) | (tr << 2) | (br << 1) | bl;
      const T = { x: x + 0.5, y: y },     R = { x: x + 1, y: y + 0.5 };
      const B = { x: x + 0.5, y: y + 1 }, L = { x: x,     y: y + 0.5 };
      const seg = (a, b) => segs.push({ x0: a.x, y0: a.y, x1: b.x, y1: b.y });
      switch (code) {
        case  1: seg(L, B); break;
        case  2: seg(B, R); break;
        case  3: seg(L, R); break;
        case  4: seg(T, R); break;
        case  5: seg(L, T); seg(B, R); break;       // saddle
        case  6: seg(T, B); break;
        case  7: seg(L, T); break;
        case  8: seg(L, T); break;
        case  9: seg(T, B); break;
        case 10: seg(L, B); seg(T, R); break;       // saddle
        case 11: seg(T, R); break;
        case 12: seg(L, R); break;
        case 13: seg(B, R); break;
        case 14: seg(L, B); break;
        // 0 / 15: fully outside / fully inside, no crossing.
      }
    }
  }
  return segs;
}

// ══════════════════════════════════════════════════════════════════════
// 24. Dynamic / animated primitives — procgen for things that move
//
// Everything above generates STATIC content (a path, a tile grid, a
// silhouette). The primitives below are stateful: you call them every
// frame with `dt` and they advance an organic system. They cover the
// "things that grow / breathe / flock / spread" family of effects that
// appear constantly in game code (vines growing in over time, swarms,
// infection spread, breathing creatures, curl-noise smoke, etc.).
// ══════════════════════════════════════════════════════════════════════

// growPath — path-as-time. Given a precomputed path and a 0..1 progress
// value `t`, returns the prefix of the path "drawn so far". This is the
// canonical way to animate a procgen path INTO existence: compute the
// path once (turtle, branch, etc.), advance `t` over time, render the
// prefix every frame. Beats recomputing the whole path each frame.
//
//   const path = turtle({ ... });
//   // each frame:
//   const visible = growPath(path, vine.grown);
//   drawPixelPath(ctx, visible, '#3a7');
export function growPath(path, t) {
  const n = (path.length * Math.max(0, Math.min(1, t))) | 0;
  return path.slice(0, n);
}

// breathe — smooth bipolar oscillator in [-1, 1]. Use as a multiplier
// for "things that breathe" (creatures, blobs, idle UI pulses). Phase
// offset lets you keep many entities desynced.
//
//   const r = baseR + breathe(time, 1.6, entity.phase) * 1.5;
export function breathe(time, freq, phase) {
  return Math.sin(time * freq + (phase || 0));
}

// pulseTrain — heartbeat-style waveform. `sharpness` 0..1 controls how
// "spiky" the pulse is (0 = pure sine, 1 = near impulse). Useful for
// LEDs, alarm strobes, monster aggro flashes.
//
//   const flash = pulseTrain(time, 2.0, 0.7);  // ~heartbeat
export function pulseTrain(time, freq, sharpness) {
  const s = Math.sin(time * freq);
  // Raise to high power on positive lobe, clamp negatives — gives a
  // characteristic "thump" shape rather than a smooth sine.
  const k = 1 + (sharpness || 0) * 8;
  return s > 0 ? Math.pow(s, k) : 0;
}

// springTo — critically-ish-damped spring, used for follow/chase that
// looks alive instead of robotic. Mutates `state` in place. `state`
// must have `value` and `vel` numbers; pass scalars for 1D, or call
// once per axis for 2D.
//
//   springTo(eye, mouseX, dt, 80, 14);   // eye chases mouse with spring
export function springTo(state, target, dt, stiffness, damping) {
  const k = stiffness != null ? stiffness : 80;
  const d = damping != null ? damping : 14;
  const a = (target - state.value) * k - state.vel * d;
  state.vel += a * dt;
  state.value += state.vel * dt;
  return state.value;
}

// curlFlow — animated 2D divergence-free flow vector. Sample anywhere
// `(x, y, time)` and get a `{vx, vy}` velocity. Particles advected by
// this vector field swirl like smoke/fluid. Built from finite-differenced
// simplex noise so the flow has natural eddies. `noise` is a simplex2D
// instance you pass in (so the same RNG seed gives the same flow).
//
//   const flow = simplex2D(rng(7));
//   for (const p of particles) {
//     const v = curlFlow(flow, p.x * 0.02, p.y * 0.02, time * 0.3);
//     p.x += v.vx * dt * 30;
//     p.y += v.vy * dt * 30;
//   }
export function curlFlow(noise, x, y, time, eps) {
  const e = eps || 0.01;
  // Curl of a 2D scalar field f → (df/dy, -df/dx). Time advances the
  // noise so the flow itself evolves; without it the flow is static.
  const fy1 = noise(x, y + e, time);
  const fy0 = noise(x, y - e, time);
  const fx1 = noise(x + e, y, time);
  const fx0 = noise(x - e, y, time);
  return { vx: (fy1 - fy0) / (2 * e), vy: -(fx1 - fx0) / (2 * e) };
}

// flockStep — one boids step for a population of agents. Each agent
// must have `{ x, y, vx, vy }`. Updates velocities in place using
// separation, alignment, and cohesion. Tune via the opts; defaults are
// reasonable for ~30 agents at game scale.
//
//   flockStep(birds, dt, { sepR: 12, alignR: 30, cohR: 30, maxSpeed: 60 });
export function flockStep(agents, dt, opts) {
  const o = opts || {};
  const sepR     = o.sepR     != null ? o.sepR     : 12;
  const alignR   = o.alignR   != null ? o.alignR   : 30;
  const cohR     = o.cohR     != null ? o.cohR     : 30;
  const sepW     = o.sepW     != null ? o.sepW     : 1.6;
  const alignW   = o.alignW   != null ? o.alignW   : 1.0;
  const cohW     = o.cohW     != null ? o.cohW     : 0.8;
  const maxSpeed = o.maxSpeed != null ? o.maxSpeed : 60;
  const sepR2 = sepR * sepR, alignR2 = alignR * alignR, cohR2 = cohR * cohR;
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i];
    let sx = 0, sy = 0, sN = 0;
    let ax = 0, ay = 0, aN = 0;
    let cx = 0, cy = 0, cN = 0;
    for (let j = 0; j < agents.length; j++) {
      if (i === j) continue;
      const b = agents[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < sepR2) { sx -= dx; sy -= dy; sN++; }
      if (d2 < alignR2) { ax += b.vx; ay += b.vy; aN++; }
      if (d2 < cohR2) { cx += b.x;  cy += b.y;  cN++; }
    }
    if (sN > 0) { a.vx += (sx / sN) * sepW * dt; a.vy += (sy / sN) * sepW * dt; }
    if (aN > 0) { a.vx += ((ax / aN) - a.vx) * alignW * dt; a.vy += ((ay / aN) - a.vy) * alignW * dt; }
    if (cN > 0) { a.vx += ((cx / cN) - a.x) * 0.05 * cohW * dt; a.vy += ((cy / cN) - a.y) * 0.05 * cohW * dt; }
    // Clamp speed.
    const sp2 = a.vx * a.vx + a.vy * a.vy;
    if (sp2 > maxSpeed * maxSpeed) {
      const s = maxSpeed / Math.sqrt(sp2);
      a.vx *= s; a.vy *= s;
    }
  }
  for (let i = 0; i < agents.length; i++) {
    agents[i].x += agents[i].vx * dt;
    agents[i].y += agents[i].vy * dt;
  }
}

// growthGrid — viral/infection-style spread on a 2D grid. Each tick,
// "alive" cells have a chance to infect each 4-neighbor. Use for
// biomass spread, fire spread, slime, mold, lichen colonization.
// `grid` is a Uint8Array of length w*h: 0 = empty, >0 = alive intensity.
// `passable(idx)` lets you forbid spreading through walls. Returns
// the number of newly-infected cells (so the caller can throttle/stop).
//
//   const grid = new Uint8Array(W * H);
//   grid[seedIdx] = 255;
//   // each tick:
//   growthGrid(grid, W, H, rng, {
//     spreadChance: 0.08,
//     decay: 0,
//     passable: i => !tilemap.solid[i],
//   });
export function growthGrid(grid, w, h, rng, opts) {
  const spread = (opts && opts.spreadChance) != null ? opts.spreadChance : 0.05;
  const decay  = (opts && opts.decay)        != null ? opts.decay : 0;
  const passable = (opts && opts.passable) || (() => true);
  const next = new Uint8Array(grid.length);
  let infected = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = grid[i];
      if (v > 0 && decay > 0) v = Math.max(0, v - decay);
      if (v > 0) {
        next[i] = v;
        const neighbors = [
          x > 0     ? i - 1 : -1,
          x < w - 1 ? i + 1 : -1,
          y > 0     ? i - w : -1,
          y < h - 1 ? i + w : -1,
        ];
        for (let k = 0; k < 4; k++) {
          const ni = neighbors[k];
          if (ni < 0 || grid[ni] > 0 || !passable(ni)) continue;
          if (rng() < spread) { next[ni] = Math.max(next[ni], (v * 0.85) | 0); infected++; }
        }
      }
    }
  }
  grid.set(next);
  return infected;
}

// reactionDiffusion — one Gray-Scott step on two scalar buffers.
// Produces self-organizing patterns: spots, stripes, mazes, coral.
// `a` and `b` are Float32Arrays of length w*h. Mutates them in place.
// Defaults give "spots" pattern; tune `feed` and `kill` for variety:
//   spots: feed=0.0367 kill=0.0649
//   stripes: feed=0.039 kill=0.058
//   mazes: feed=0.029 kill=0.057
// Call repeatedly each frame for visible evolution.
export function reactionDiffusion(a, b, w, h, opts) {
  const dA = (opts && opts.dA)   != null ? opts.dA   : 1.0;
  const dB = (opts && opts.dB)   != null ? opts.dB   : 0.5;
  const f  = (opts && opts.feed) != null ? opts.feed : 0.0367;
  const k  = (opts && opts.kill) != null ? opts.kill : 0.0649;
  const dt = (opts && opts.dt)   != null ? opts.dt   : 1.0;
  const a2 = new Float32Array(a);
  const b2 = new Float32Array(b);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lapA = a2[i - 1] + a2[i + 1] + a2[i - w] + a2[i + w] - 4 * a2[i];
      const lapB = b2[i - 1] + b2[i + 1] + b2[i - w] + b2[i + w] - 4 * b2[i];
      const ab2 = a2[i] * b2[i] * b2[i];
      a[i] = a2[i] + (dA * lapA - ab2 + f * (1 - a2[i])) * dt;
      b[i] = b2[i] + (dB * lapB + ab2 - (k + f) * b2[i]) * dt;
    }
  }
}

// ageList — utility for managing pools of timed entities (particles,
// projectiles, floats, blood splats). Decrements `life` by `dt` and
// removes entries with life <= 0. Mutates the array in place. Saves
// you from writing the same reverse-iter splice loop 20 times.
//
//   ageList(particles, dt);
//   ageList(particles, dt, p => p.vy += 200 * dt);  // with extra update
export function ageList(items, dt, onUpdate) {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    it.life -= dt;
    if (it.life <= 0) { items.splice(i, 1); continue; }
    if (onUpdate) onUpdate(it, dt);
  }
}

// ══════════════════════════════════════════════════════════════════════
// 25. Emergent / simulation-driven primitives
//
// Fully procedural runtime art: nothing is baked, nothing is authored.
// Visuals come from interactions of simple rules — vines that grow via
// physics, lightning from random walks, slime trails from agent pheromone
// deposits. These are the "Reactive Generative Rendering" primitives.
//
// All of them are stateful: you keep the buffer/agents around and step
// them every frame. Render whatever the state currently looks like.
// ══════════════════════════════════════════════════════════════════════

// dlaStep — diffusion-limited aggregation. Random walkers stick on
// contact with the existing structure, producing branching crystalline
// shapes (lightning, frost, coral, mineral growth, lichtenberg figures).
// `grid` is Uint8Array(w*h): 0 empty, 255 stuck. Seed a few cells before
// the first step. Spawns up to `walkerBudget` walkers per call from the
// edges; each walks until it sticks or escapes.
//
// Real-time: call once per frame and the structure visibly grows.
export function dlaStep(grid, w, h, rng, opts) {
  const budget = (opts && opts.walkerBudget) != null ? opts.walkerBudget : 8;
  const maxSteps = (opts && opts.maxSteps) != null ? opts.maxSteps : 400;
  let stuck = 0;
  for (let n = 0; n < budget; n++) {
    // Spawn on a random edge.
    const edge = (rng() * 4) | 0;
    let x, y;
    if (edge === 0) { x = (rng() * w) | 0; y = 0; }
    else if (edge === 1) { x = (rng() * w) | 0; y = h - 1; }
    else if (edge === 2) { x = 0; y = (rng() * h) | 0; }
    else { x = w - 1; y = (rng() * h) | 0; }
    for (let s = 0; s < maxSteps; s++) {
      const dir = (rng() * 4) | 0;
      if (dir === 0) x++; else if (dir === 1) x--;
      else if (dir === 2) y++; else y--;
      if (x < 0 || y < 0 || x >= w || y >= h) break;
      // Stick if any neighbor is stuck.
      const i = y * w + x;
      const left  = x > 0     && grid[i - 1] > 0;
      const right = x < w - 1 && grid[i + 1] > 0;
      const up    = y > 0     && grid[i - w] > 0;
      const down  = y < h - 1 && grid[i + w] > 0;
      if (left || right || up || down) { grid[i] = 255; stuck++; break; }
    }
  }
  return stuck;
}

// slimeMoldStep — Physarum-inspired pheromone-trail agents. Each agent
// senses 3 forward points on a `trail` Float32Array, turns toward the
// brightest one, deposits trail at its position, moves forward. The
// trail diffuses and decays each step. Result: agents organize into
// transport networks resembling slime molds, neuronal networks, or
// mycelium. Pure emergence — no global plan.
//
//   const agents = makeAgents(...);
//   const trail = new Float32Array(W * H);
//   // each frame:
//   slimeMoldStep(agents, trail, W, H, { sensorAngle: 0.5, deposit: 5, decay: 0.95 });
export function slimeMoldStep(agents, trail, w, h, opts) {
  const o = opts || {};
  const sensAng  = o.sensorAngle    != null ? o.sensorAngle    : 0.5;
  const sensDist = o.sensorDistance != null ? o.sensorDistance : 9;
  const turnAng  = o.turnAngle      != null ? o.turnAngle      : 0.4;
  const speed    = o.speed          != null ? o.speed          : 1.0;
  const deposit  = o.deposit        != null ? o.deposit        : 5;
  const decay    = o.decay          != null ? o.decay          : 0.95;
  const sample = (sx, sy) => {
    const x = ((sx % w) + w) % w;
    const y = ((sy % h) + h) % h;
    return trail[(y | 0) * w + (x | 0)];
  };
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i];
    const fAng = a.angle;
    const fx = a.x + Math.cos(fAng) * sensDist;
    const fy = a.y + Math.sin(fAng) * sensDist;
    const lAng = a.angle - sensAng;
    const lx = a.x + Math.cos(lAng) * sensDist;
    const ly = a.y + Math.sin(lAng) * sensDist;
    const rAng = a.angle + sensAng;
    const rx = a.x + Math.cos(rAng) * sensDist;
    const ry = a.y + Math.sin(rAng) * sensDist;
    const F = sample(fx, fy), L = sample(lx, ly), R = sample(rx, ry);
    if (F < L && F < R) a.angle += (Math.random() < 0.5 ? -turnAng : turnAng);
    else if (L > R) a.angle -= turnAng;
    else if (R > L) a.angle += turnAng;
    a.x = ((a.x + Math.cos(a.angle) * speed) % w + w) % w;
    a.y = ((a.y + Math.sin(a.angle) * speed) % h + h) % h;
    const ti = ((a.y | 0) * w) + (a.x | 0);
    trail[ti] = Math.min(255, trail[ti] + deposit);
  }
  // Diffuse + decay (3x3 box blur, multiplied by `decay`).
  const next = new Float32Array(trail.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0, cnt = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          sum += trail[ny * w + nx]; cnt++;
        }
      }
      next[y * w + x] = (sum / cnt) * decay;
    }
  }
  trail.set(next);
}

// verletStep — verlet integration for a cloth/rope/string. `points`
// are `{ x, y, ox, oy, pinned? }`. Implicit velocity = current - previous,
// so collisions/constraints are positional. Apply gravity etc as direct
// position offsets after step.
//
//   for (const p of points) verletStep(p, dt, { gx: 0, gy: 600 });
//   for (const c of constraints) constrain(c.a, c.b, c.rest);
export function verletStep(p, dt, opts) {
  if (p.pinned) return;
  const gx = (opts && opts.gx) || 0;
  const gy = (opts && opts.gy) || 0;
  const vx = (p.x - p.ox) * (opts && opts.damping != null ? opts.damping : 0.99);
  const vy = (p.y - p.oy) * (opts && opts.damping != null ? opts.damping : 0.99);
  p.ox = p.x; p.oy = p.y;
  p.x += vx + gx * dt * dt;
  p.y += vy + gy * dt * dt;
}

// constrainDistance — one position-correction pass for verlet ropes.
// Snaps two points back to `rest` distance with stiffness in [0,1].
// Call several times per frame for stiffer ropes.
export function constrainDistance(a, b, rest, stiffness) {
  const k = stiffness != null ? stiffness : 0.5;
  const dx = b.x - a.x, dy = b.y - a.y;
  const d = Math.hypot(dx, dy) || 1e-6;
  const diff = (rest - d) / d * k;
  const ox = dx * 0.5 * diff;
  const oy = dy * 0.5 * diff;
  if (!a.pinned) { a.x -= ox; a.y -= oy; }
  if (!b.pinned) { b.x += ox; b.y += oy; }
}

// metaball — sample the implicit surface formed by N point-charges.
// Returns the field strength at (x,y); render as solid where >= threshold
// for blobs that smoothly merge. Cheap, allocates nothing per call.
//
//   for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
//     if (metaball(px, py, blobs) >= 1) ctx.fillRect(px, py, 1, 1);
//   }
export function metaball(x, y, blobs) {
  let f = 0;
  for (let i = 0; i < blobs.length; i++) {
    const b = blobs[i];
    const dx = x - b.x, dy = y - b.y;
    f += (b.r * b.r) / (dx * dx + dy * dy + 1);
  }
  return f;
}

// lloydRelax — one Lloyd's step on a Voronoi point set. Each site
// migrates toward the centroid of its cell. Repeated calls produce
// organic disc-packing (cell tessellations, soap films, leaf venation).
// `points` is `[{x, y}, ...]`; `bounds` is `{w, h}`. Mutates points.
// Step rate slows convergence so the relaxation is visible over time.
export function lloydRelax(points, bounds, opts) {
  const rate = (opts && opts.rate) != null ? opts.rate : 0.2;
  const samples = (opts && opts.samples) != null ? opts.samples : 200;
  const sumX = new Float32Array(points.length);
  const sumY = new Float32Array(points.length);
  const cnt  = new Uint32Array(points.length);
  for (let s = 0; s < samples; s++) {
    const sx = Math.random() * bounds.w;
    const sy = Math.random() * bounds.h;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < points.length; i++) {
      const dx = points[i].x - sx, dy = points[i].y - sy;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    }
    sumX[best] += sx; sumY[best] += sy; cnt[best]++;
  }
  for (let i = 0; i < points.length; i++) {
    if (cnt[i] === 0) continue;
    const cx = sumX[i] / cnt[i], cy = sumY[i] / cnt[i];
    points[i].x += (cx - points[i].x) * rate;
    points[i].y += (cy - points[i].y) * rate;
  }
}

// branchGrowStep — incremental L-system. Each call extends every active
// tip by one segment and may spawn forks. Unlike the static `branch()`,
// you keep the tree state and step it every frame: trees, vines, mycelium
// visibly grow at runtime.
//
//   const tips = [{ x, y, angle: -Math.PI/2, depth: 0, alive: true }];
//   // each frame:
//   branchGrowStep(tips, rng, { stepLen: 2, forkChance: 0.05, maxDepth: 6 });
//   // render: each tip carries .history of points it has walked.
export function branchGrowStep(tips, rng, opts) {
  const o = opts || {};
  const stepLen   = o.stepLen   != null ? o.stepLen   : 2;
  const forkProb  = o.forkChance != null ? o.forkChance : 0.05;
  const forkSpread = o.forkSpread != null ? o.forkSpread : 0.6;
  const maxDepth  = o.maxDepth  != null ? o.maxDepth  : 6;
  const wander    = o.wander    != null ? o.wander    : 0.15;
  const spawned = [];
  for (let i = 0; i < tips.length; i++) {
    const t = tips[i];
    if (!t.alive) continue;
    if (!t.history) t.history = [{ x: t.x, y: t.y }];
    t.angle += (rng() - 0.5) * wander;
    t.x += Math.cos(t.angle) * stepLen;
    t.y += Math.sin(t.angle) * stepLen;
    t.history.push({ x: t.x, y: t.y });
    t.life = (t.life || 0) + 1;
    if (t.life > (o.maxLife || 80)) t.alive = false;
    if (t.depth < maxDepth && rng() < forkProb) {
      spawned.push({
        x: t.x, y: t.y,
        angle: t.angle - forkSpread * (0.6 + rng() * 0.6),
        depth: t.depth + 1, alive: true,
        history: [{ x: t.x, y: t.y }],
      });
      t.angle += forkSpread * (0.6 + rng() * 0.6);
    }
  }
  for (let i = 0; i < spawned.length; i++) tips.push(spawned[i]);
}

// attractorAdvect — push a particle through a Lorenz-style strange
// attractor. Beautiful chaotic flow, useful for ambient swirl visuals
// or "haunted" particle trails. Mutates `p` in place. Map XYZ to your
// 2D screen however you like (default returns x,y; z modulates alpha).
//
//   for (const p of dust) attractorAdvect(p, dt, 'lorenz');
export function attractorAdvect(p, dt, kind) {
  const k = kind || 'lorenz';
  if (p.z == null) p.z = 0;
  if (k === 'lorenz') {
    const s = 10, r = 28, b = 8/3;
    const dx = s * (p.y - p.x);
    const dy = p.x * (r - p.z) - p.y;
    const dz = p.x * p.y - b * p.z;
    p.x += dx * dt; p.y += dy * dt; p.z += dz * dt;
  } else if (k === 'aizawa') {
    const a = 0.95, b = 0.7, c = 0.6, d = 3.5, e = 0.25, f = 0.1;
    const dx = (p.z - b) * p.x - d * p.y;
    const dy = d * p.x + (p.z - b) * p.y;
    const dz = c + a * p.z - p.z*p.z*p.z/3 - (p.x*p.x + p.y*p.y) * (1 + e * p.z) + f * p.z * p.x*p.x*p.x;
    p.x += dx * dt; p.y += dy * dt; p.z += dz * dt;
  }
}

// ══════════════════════════════════════════════════════════════════════
// 26. Metamorphosis pipeline — operate on a sprite's pixels each frame
//
// The previous sections create or simulate visuals from scratch. This
// section operates on EXISTING pixels (a sprite's RGBA buffer). Together
// they form a metamorphosis pipeline you call every frame to evolve a
// sprite tick-by-tick: deform → dissolve → regrow into a target form.
//
// Usage pattern:
//   1. Draw your source sprite (player, NPC) into a scratch canvas
//   2. getImageData → pass `data` (Uint8ClampedArray) to these functions
//   3. putImageData back, drawImage scaled to world position
// ══════════════════════════════════════════════════════════════════════

// entropyDeform — domain-warp resample. Reads `src` and writes `dst`,
// sampling src at (x + warp, y + warp) so the sprite distorts/morphs.
// `amp` is warp magnitude in pixels. Drive `amp` with your transform
// timer for tick-by-tick deformation. `noise` is a simplex2D instance
// (or any (x,y,t) → [-1..1] function); `time` advances the warp field.
//
//   entropyDeform(srcData, dstData, w, h, noise, time, amp);
export function entropyDeform(src, dst, w, h, noise, time, amp) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const wx = (x + noise(x * 0.18, y * 0.18, time) * amp) | 0;
      const wy = (y + noise(x * 0.18 + 99, y * 0.18 + 99, time) * amp) | 0;
      const sx = wx < 0 ? 0 : wx >= w ? w - 1 : wx;
      const sy = wy < 0 ? 0 : wy >= h ? h - 1 : wy;
      const di = (y * w + x) * 4;
      const si = (sy * w + sx) * 4;
      dst[di]     = src[si];
      dst[di + 1] = src[si + 1];
      dst[di + 2] = src[si + 2];
      dst[di + 3] = src[si + 3];
    }
  }
}

// dissolveBuffer — punch alpha-zero holes in opaque pixels using noise
// thresholding. Sprite "boils away" / disintegrates. `threshold` 0..1
// (rising over time = more dissolve). `noise` is any (x,y,t) function;
// `time` lets the dissolve pattern shift, so the holes shimmer.
export function dissolveBuffer(buf, w, h, noise, time, threshold, scale) {
  const s = scale || 0.35;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (buf[i + 3] === 0) continue;
      const n = noise(x * s, y * s, time) * 0.5 + 0.5;
      if (n < threshold) buf[i + 3] = 0;
    }
  }
}

// regrowMass — additively paint a metaball field over an existing
// buffer. Where field >= threshold we OVERWRITE the pixel with a color
// from `palette` (a paletteRamp function). Use to grow new flesh/mass
// over a deformed sprite — combine with `entropyDeform` and
// `dissolveBuffer` for the full warp→decay→regrow cycle.
//
//   const blobs = [{ x: 8, y: 9, r: 4 + t*3 }, ...];
//   regrowMass(buf, w, h, blobs, ramp);
export function regrowMass(buf, w, h, blobs, palette, opts) {
  const thresh = (opts && opts.threshold) != null ? opts.threshold : 1.0;
  const innerT = (opts && opts.innerThreshold) != null ? opts.innerThreshold : 1.4;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const f = metaball(x, y, blobs);
      if (f < thresh) continue;
      const i = (y * w + x) * 4;
      const u = Math.min(1, (f - thresh) / Math.max(0.001, innerT - thresh));
      const c = palette(u);
      // Parse #rrggbb (caching would matter if blobs were huge; for 16×16 not yet).
      const r = parseInt(c.slice(1, 3), 16);
      const g = parseInt(c.slice(3, 5), 16);
      const b = parseInt(c.slice(5, 7), 16);
      buf[i]     = r;
      buf[i + 1] = g;
      buf[i + 2] = b;
      buf[i + 3] = 255;
    }
  }
}

// fragmentEdges — pixel-level shatter pass. For every opaque pixel on
// the silhouette EDGE (at least one transparent 4-neighbor) there's a
// `chance` to clear it, simulating chunks flaking off. Combined with
// dissolveBuffer this gives the sprite a chewed-on outline that looks
// like the body is being eaten away. `chance` 0..1, scale by your
// transform timer for stage-gated decay.
export function fragmentEdges(buf, w, h, rng, chance) {
  // Snapshot alpha so neighbor reads don't see this pass's clears.
  const alpha = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) alpha[i] = buf[i * 4 + 3];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ai = y * w + x;
      if (alpha[ai] === 0) continue;
      const onEdge =
        (x === 0     || alpha[ai - 1] === 0) ||
        (x === w - 1 || alpha[ai + 1] === 0) ||
        (y === 0     || alpha[ai - w] === 0) ||
        (y === h - 1 || alpha[ai + w] === 0);
      if (onEdge && rng() < chance) buf[ai * 4 + 3] = 0;
    }
  }
}

// metamorphStep — orchestrator. Composes the above passes with a stage
// curve so a single `t` (0..1) drives the full warp→decay→fragment→
// regrow timeline. Pass src/dst Uint8ClampedArrays (typically pulled
// from getImageData), the dimensions, the timer `t`, the time-of-day
// `time` for noise advection, and a config bag with the noise instance,
// rng, palette, and a `blobsForT(t)` callback that returns the regrowth
// metaball list at the given progress.
//
//   metamorphStep(srcData, dstData, 16, 16, t, time, {
//     noise, rng, palette,
//     blobsForT: (t) => [{ x: 8, y: 8, r: 3 + t * 4 }, ...],
//   });
export function metamorphStep(src, dst, w, h, t, time, cfg) {
  // Stage 1: warp. Amplitude rises 0 → ~3px through the first half.
  const warpAmp = Math.min(1, t * 1.6) * 3.0;
  entropyDeform(src, dst, w, h, cfg.noise, time, warpAmp);

  // Stage 2: dissolve. Threshold rises starting at t≈0.15, peaks ~0.55,
  // then BACKS OFF as regrowth fills back in (so the sprite isn't gone).
  const dissT = t < 0.6 ? Math.max(0, (t - 0.15) * 1.3) : Math.max(0, (1 - t) * 0.6);
  if (dissT > 0) dissolveBuffer(dst, w, h, cfg.noise, time, dissT * 0.55);

  // Stage 3: fragment edges (gated to mid-transformation so the body
  // visibly chews itself apart before reforming).
  const fragChance = t > 0.2 && t < 0.7 ? (t - 0.2) * 0.18 : 0;
  if (fragChance > 0) fragmentEdges(dst, w, h, cfg.rng, fragChance);

  // Stage 4: regrow. Metaballs paint new flesh over the deformed body.
  // The palette + blob radii come from caller so different transforms
  // (Hulk, zombie, frost lich, slime) reuse the same pipeline.
  if (t > 0.1 && cfg.blobsForT) {
    const blobs = cfg.blobsForT(t);
    regrowMass(dst, w, h, blobs, cfg.palette, {
      threshold: 0.85,
      innerThreshold: 1.4,
    });
  }
}

// ══════════════════════════════════════════════════════════════════════
// 27. Flora & vegetation — reactive generative growth pipeline
// ══════════════════════════════════════════════════════════════════════
//
// A composable engine for procedural plants. The flow is conceptually
// rendering-pass shaped:
//
//   seedEnvironment → germinateField → sproutCluster → generateBranches
//   → buildCanopy → decorateFoliage → applyDecay → render
//
// You can call any pass directly, or use the `runFloraPipeline(seed)`
// orchestrator that wires the common path. Live updates go through
// `runBiomeSimulation(state, dt)` which advances growth, decay, wind.
//
// Every primitive is pure (returns new data) unless its name implies
// mutation (`witherFlora`, `lifeTick`, `reactToWind`).

// seedEnvironment — central context for all flora calls. Holds the
// rng, noise + fbm fields, wind/light vectors, and a per-frame `t`.
//
//   const env = seedEnvironment({ seed: 1234, scale: 0.04,
//                                 wind: { x: 0.3, y: 0 } });
//   env.growthNoise(x, y)   // 0..1 organic potential
//   env.distort(x, y)       // domain-warp offset {dx, dy}
export function seedEnvironment(opts = {}) {
  const seed = opts.seed != null ? opts.seed : 1;
  const scale = opts.scale != null ? opts.scale : 0.04;
  const r = rng(seed);
  const baseNoise = valueNoise2D(rng(seed ^ 0x5EED));
  const warpNoise = valueNoise2D(rng(seed ^ 0xDA12));
  const f = fbm(baseNoise, { octaves: opts.octaves || 4, gain: 0.55 });
  const fw = fbm(warpNoise, { octaves: 2, gain: 0.5 });
  return {
    seed, scale,
    rng: r, noise: baseNoise, fbm: f, warpFbm: fw,
    wind: opts.wind ? { x: opts.wind.x, y: opts.wind.y } : { x: 0, y: 0 },
    light: opts.light || { x: -0.3, y: -1 },
    biome: opts.biome || null,
    palette: opts.palette || null,
    t: 0,
    growthNoise(x, y) { return (f(x * scale, y * scale) + 1) * 0.5; },
    distort(x, y, k) {
      const kk = k != null ? k : 6;
      return { dx: fw(x * scale + 11, y * scale) * kk,
               dy: fw(x * scale, y * scale + 31) * kk };
    },
  };
}

// distortGrowthField — return a domain-warp function `(x,y) => {dx,dy}`
// for use with `applyFlowField`.
export function distortGrowthField(env, opts = {}) {
  const k = opts.strength != null ? opts.strength : 4;
  const s = opts.scale != null ? opts.scale : env.scale * 1.5;
  return (x, y) => ({
    dx: env.warpFbm(x * s + 17, y * s) * k,
    dy: env.warpFbm(x * s, y * s + 31) * k,
  });
}

// sampleGrowthNoise — quick scalar 0..1 at (x, y).
export function sampleGrowthNoise(env, x, y, scale) {
  const s = scale != null ? scale : env.scale;
  return (env.fbm(x * s, y * s) + 1) * 0.5;
}

// applyFlowField — perturb each path point by `field(x,y)*strength`.
// Pure. Returns a new path array.
export function applyFlowField(path, field, strength) {
  const k = strength != null ? strength : 1;
  const out = new Array(path.length);
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    const f = field(p.x, p.y);
    out[i] = { x: p.x + f.dx * k, y: p.y + f.dy * k,
               angle: p.angle, t: p.t, life: p.life };
  }
  return out;
}

// germinateField — Poisson seeds across a rectangle, gated by a
// growth-potential threshold sampled from env.fbm. Each seed receives
// a `vigor` (0..1) and a randomized stem-angle.
export function germinateField(env, opts) {
  const x0 = opts.x || 0, y0 = opts.y || 0;
  const w = opts.w, h = opts.h;
  const spacing = opts.spacing || 16;
  const kind = opts.kind || 'plant';
  const threshold = opts.threshold != null ? opts.threshold : 0;
  const points = poissonDisk({ rng: env.rng, w, h, minDist: spacing });
  const seeds = [];
  for (const p of points) {
    const vigor = sampleGrowthNoise(env, x0 + p.x, y0 + p.y);
    if (vigor < threshold) continue;
    seeds.push({
      x: x0 + p.x, y: y0 + p.y, kind, vigor,
      stemAngle: -Math.PI / 2 + (env.rng() - 0.5) * 0.3,
    });
  }
  return seeds;
}

// sproutCluster — N small members around a seed point. Use for flower
// patches, mushroom rings, fern thickets. Members inherit dampened
// vigor.
export function sproutCluster(env, seed, opts = {}) {
  const count = opts.count != null ? opts.count : 5;
  const radius = opts.radius != null ? opts.radius : 6;
  const members = [];
  for (let i = 0; i < count; i++) {
    const a = env.rng() * Math.PI * 2;
    const r = env.rng() * radius;
    members.push({
      x: seed.x + Math.cos(a) * r,
      y: seed.y + Math.sin(a) * r,
      vigor: (seed.vigor || 1) * (0.6 + env.rng() * 0.4),
      kind: opts.memberKind || seed.kind,
      angle: -Math.PI / 2 + (env.rng() - 0.5) * 0.5,
    });
  }
  return { center: seed, members };
}

// generateBranches — vegetation-tuned wrapper around `branch()`. Adds
// gravity bias, optional light bias, and flattens the recursive tree
// to a list of `{path, depth, parent}` for easy iteration.
export function generateBranches(env, opts) {
  const x = opts.x, y = opts.y;
  const angle = opts.angle != null ? opts.angle : -Math.PI / 2;
  const height = opts.height || 20;
  const spread = opts.spread != null ? opts.spread : 0.7;
  const splits = opts.splits != null ? opts.splits : 0.06;
  const maxDepth = opts.maxDepth != null ? opts.maxDepth : 2;
  const gravityBias = opts.gravityBias != null ? opts.gravityBias : 0;
  const driftAmp = opts.drift != null ? opts.drift : 0.12;
  const root = branch({
    rng: env.rng,
    x, y, angle,
    maxDepth,
    branchProbability: splits,
    branchAngleSpread: spread,
    turtle: {
      steps: height, step: opts.step || 1.05,
      angleDrift: () => (env.rng() - 0.5) * driftAmp + gravityBias,
    },
  });
  const out = [];
  function walk(node, depth, parent) {
    out.push({ path: node.path, depth, parent });
    for (const c of node.children) walk(c, depth + 1, node);
  }
  walk(root, 0, null);
  return out;
}

// formRoots — downward-biased branches with shorter, more-frequent
// forks. Same return shape as generateBranches.
export function formRoots(env, opts) {
  return generateBranches(env, Object.assign({
    angle: Math.PI / 2,
    height: Math.max(6, Math.floor((opts.height || 12) * 0.6)),
    spread: 1.1,
    splits: 0.12,
    maxDepth: opts.maxDepth != null ? opts.maxDepth : 2,
    gravityBias: 0.04,
  }, opts));
}

// extendBranches — produce a new branch list with each path's tip
// pushed `amount` steps further along its terminal heading. Used for
// "the plant grew" frames.
export function extendBranches(branches, amount) {
  const out = [];
  for (const b of branches) {
    if (b.path.length < 2) { out.push(b); continue; }
    const path = b.path.slice();
    const tip = path[path.length - 1];
    const prev = path[path.length - 2];
    const ang = Math.atan2(tip.y - prev.y, tip.x - prev.x);
    for (let i = 1; i <= amount; i++) {
      path.push({ x: tip.x + Math.cos(ang) * i,
                  y: tip.y + Math.sin(ang) * i,
                  angle: ang, t: tip.t + i, life: 1 });
    }
    out.push(Object.assign({}, b, { path }));
  }
  return out;
}

// buildCanopy — emit metaball blobs at terminal-branch tips. Each blob
// has {x, y, r, depth}. Returns {blobs, bounds}. Feed into a metaball
// pass for an organic silhouette.
export function buildCanopy(env, branches, opts = {}) {
  const blobScale = opts.blobScale != null ? opts.blobScale : 4;
  const tipRatio = opts.tipRatio != null ? opts.tipRatio : 0.4;
  const stride = opts.stride || 2;
  const blobs = [];
  let bx0 = +Infinity, by0 = +Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (const b of branches) {
    if (b.path.length < 2) continue;
    const tipStart = Math.floor(b.path.length * (1 - tipRatio));
    for (let i = tipStart; i < b.path.length; i += stride) {
      const p = b.path[i];
      const r = blobScale * (0.6 + env.rng() * 0.6);
      blobs.push({ x: p.x, y: p.y, r, depth: b.depth });
      if (p.x - r < bx0) bx0 = p.x - r;
      if (p.y - r < by0) by0 = p.y - r;
      if (p.x + r > bx1) bx1 = p.x + r;
      if (p.y + r > by1) by1 = p.y + r;
    }
  }
  if (!blobs.length) return { blobs: [], bounds: { x: 0, y: 0, w: 0, h: 0 } };
  return { blobs, bounds: { x: bx0, y: by0, w: bx1 - bx0, h: by1 - by0 } };
}

// expandFoliage — grow each canopy blob's radius by `amount`. Pure.
// Use to enlarge an existing canopy (e.g., as the plant matures).
export function expandFoliage(canopy, amount) {
  const blobs = canopy.blobs.map(b => ({ x: b.x, y: b.y, r: b.r + amount, depth: b.depth }));
  const k = amount;
  const bounds = canopy.bounds;
  return { blobs, bounds: { x: bounds.x - k, y: bounds.y - k,
                            w: bounds.w + 2 * k, h: bounds.h + 2 * k } };
}

// weaveVines — generate vine paths between sequential anchors. Each
// vine drapes with parabolic sag plus per-vine fbm jitter. Returns
// `[{path, anchorA, anchorB}]`.
export function weaveVines(env, anchors, opts = {}) {
  const sag = opts.sag != null ? opts.sag : 8;
  const segs = opts.segments != null ? opts.segments : 16;
  const vines = [];
  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i], b = anchors[i + 1];
    const path = [];
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      const x = a.x + (b.x - a.x) * t;
      const yLine = a.y + (b.y - a.y) * t;
      const droop = Math.sin(t * Math.PI) * sag;
      const jx = env.fbm((x + i * 30) * env.scale * 2, 0) * 1.3;
      const jy = env.fbm(0, (yLine + i * 30) * env.scale * 2) * 1.3;
      path.push({ x: x + jx, y: yLine + droop + jy, t, life: t });
    }
    vines.push({ path, anchorA: a, anchorB: b });
  }
  return vines;
}

// creepVines — like weaveVines but each segment hugs a target surface
// described by `surfaceFn(x, y) → { x, y }` (snaps to nearest point).
// Use for SS13-style vines crawling along walls.
export function creepVines(env, start, end, surfaceFn, opts = {}) {
  const segs = opts.segments || 24;
  const path = [];
  for (let s = 0; s <= segs; s++) {
    const t = s / segs;
    const lx = start.x + (end.x - start.x) * t;
    const ly = start.y + (end.y - start.y) * t;
    const snap = surfaceFn(lx, ly);
    const jx = env.fbm(lx * env.scale, ly * env.scale) * 0.8;
    path.push({ x: snap.x + jx, y: snap.y, t, life: t });
  }
  return [{ path, anchorA: start, anchorB: end }];
}

// traceGrowthPaths — turtle path with t-progress applied (uses
// growPath to slice). t ∈ [0,1].
export function traceGrowthPaths(env, opts, t) {
  const tt = t != null ? t : 1;
  const tOpts = Object.assign({
    angleDrift: () => (env.rng() - 0.5) * 0.12,
  }, opts);
  return growPath(turtle(tOpts), tt);
}

// pulseGrowth — 1 + sin(time*freq*2π)*amp. Use to breathe live plants.
export function pulseGrowth(time, freq, amp) {
  return 1 + Math.sin(time * freq * Math.PI * 2) * amp;
}

// bloomCycle — 0..1 sawtooth over period seconds. Pair with
// scatterPetals or expandFoliage for periodic blooms.
export function bloomCycle(time, period) {
  return ((time % period) + period) % period / period;
}

// applyDecay — return visual decay parameters {wilt, brown, lossMask, age}.
// Pure; pairs with witherFlora for state mutation.
export function applyDecay(plant, t, opts = {}) {
  const tt = Math.max(0, Math.min(1, t));
  const max = opts.max != null ? opts.max : 1;
  return {
    wilt: tt * max,
    brown: tt * (opts.brownMax != null ? opts.brownMax : 0.7),
    lossMask: tt * tt,
    age: tt,
  };
}

// witherFlora — mutate plant.wilt by dt*rate. Returns plant.
export function witherFlora(plant, dt, opts = {}) {
  const rate = opts.rate != null ? opts.rate : 0.05;
  plant.wilt = Math.min(1, (plant.wilt || 0) + dt * rate);
  return plant;
}

// erodeVegetation — remove a fraction of branch paths (oldest first
// or uniformly random). Returns NEW branches list.
export function erodeVegetation(branches, fraction, rng_) {
  const r = rng_ || rng(1);
  return branches.filter(() => r() > fraction);
}

// shedLeaves — convert a fraction of canopy blobs into falling-leaf
// particles with downward velocity. Mutates canopy (drops blobs) and
// returns the new particle list.
export function shedLeaves(canopy, fraction, env) {
  const drop = [];
  const keep = [];
  const r = env.rng;
  for (const b of canopy.blobs) {
    if (r() < fraction) {
      drop.push({
        x: b.x, y: b.y, r: b.r * 0.4,
        vx: (r() - 0.5) * 0.3 + (env.wind.x || 0) * 0.5,
        vy: 0.4 + r() * 0.4,
        spin: (r() - 0.5) * 0.2, age: 0, life: 1,
      });
    } else keep.push(b);
  }
  canopy.blobs = keep;
  return drop;
}

// entropyPass — drop a fraction of canopy blobs uniformly at random.
// Pure: returns new canopy.
export function entropyPass(canopy, fraction, rng_) {
  const r = rng_ || rng(1);
  const keep = canopy.blobs.filter(() => r() > fraction);
  return Object.assign({}, canopy, { blobs: keep });
}

// rotCycle — periodic 0..1 over `period` seconds. Use to drive
// bloom→decay→regrow loops on long-lived sprites.
export function rotCycle(time, period) {
  return ((time % period) + period) % period / period;
}

// scatterPetals — radial petal positions around a bloom center.
// Returns `[{x, y, angle, layer}]` suitable for stamping bright pixels.
export function scatterPetals(cx, cy, opts = {}) {
  const count = opts.count != null ? opts.count : 8;
  const radius = opts.radius != null ? opts.radius : 2;
  const layers = opts.layers != null ? opts.layers : 1;
  const r = opts.rng || rng(1);
  const petals = [];
  for (let l = 0; l < layers; l++) {
    const lr = radius * (1 + l * 0.45);
    const lc = count + l * 2;
    for (let i = 0; i < lc; i++) {
      const a = (i / lc) * Math.PI * 2 + r() * 0.2;
      petals.push({
        x: cx + Math.cos(a) * lr,
        y: cy + Math.sin(a) * lr,
        angle: a, layer: l,
      });
    }
  }
  return petals;
}

// placeLeaves — sparse leaf positions along branch paths (not at tips).
// Useful for non-canopy plants (vines, ferns) that need leaves IN the
// branch line rather than blobbed at the end.
export function placeLeaves(branches, opts = {}) {
  const r = opts.rng || rng(1);
  const density = opts.density != null ? opts.density : 0.18;
  const out = [];
  for (const b of branches) {
    for (let i = 1; i < b.path.length - 1; i++) {
      if (r() < density) {
        const p = b.path[i];
        const side = r() < 0.5 ? -1 : 1;
        out.push({
          x: p.x + Math.cos(p.angle + Math.PI / 2) * side * 1.2,
          y: p.y + Math.sin(p.angle + Math.PI / 2) * side * 1.2,
          angle: p.angle, side, depth: b.depth,
        });
      }
    }
  }
  return out;
}

// decorateFoliage — pick highlight (`sparkles`) and shadow (`pockets`)
// positions inside an existing canopy. Pure.
export function decorateFoliage(canopy, opts = {}) {
  const r = opts.rng || rng(1);
  const sparkles = [];
  const pockets = [];
  const nS = opts.sparkles != null ? opts.sparkles : 6;
  const nP = opts.pockets != null ? opts.pockets : 4;
  if (!canopy.blobs.length) return { sparkles, pockets };
  for (let i = 0; i < nS; i++) {
    const b = canopy.blobs[Math.floor(r() * canopy.blobs.length)];
    const a = r() * Math.PI * 2;
    const d = r() * b.r * 0.6;
    sparkles.push({ x: Math.round(b.x + Math.cos(a) * d),
                    y: Math.round(b.y + Math.sin(a) * d) });
  }
  for (let i = 0; i < nP; i++) {
    const b = canopy.blobs[Math.floor(r() * canopy.blobs.length)];
    pockets.push({ x: Math.round(b.x), y: Math.round(b.y) });
  }
  return { sparkles, pockets };
}

// addUndergrowth — small ground cover (mushrooms, ferns, pebbles) at
// a Poisson distribution. Returns `[{x, y, kind}]`.
export function addUndergrowth(env, region, opts = {}) {
  const spacing = opts.spacing || 6;
  const kinds = opts.kinds || ['mushroom', 'fern', 'pebble'];
  const points = poissonDisk({
    rng: env.rng, w: region.w, h: region.h, minDist: spacing,
  });
  const out = [];
  for (const p of points) {
    out.push({
      x: region.x + p.x, y: region.y + p.y,
      kind: kinds[Math.floor(env.rng() * kinds.length)],
    });
  }
  return out;
}

// scatterFloraClusters — Mitchell best-candidate cluster centers
// for organic clumping. Each center is a candidate seed for sproutCluster.
export function scatterFloraClusters(env, region, opts = {}) {
  const count = opts.count != null ? opts.count : 8;
  const candidates = opts.candidates != null ? opts.candidates : 8;
  const out = [];
  for (let i = 0; i < count; i++) {
    let bestX = 0, bestY = 0, bestD = -1;
    for (let c = 0; c < candidates; c++) {
      const cx = region.x + env.rng() * region.w;
      const cy = region.y + env.rng() * region.h;
      let minD = Infinity;
      for (const p of out) {
        const d = (p.x - cx) ** 2 + (p.y - cy) ** 2;
        if (d < minD) minD = d;
      }
      if (minD > bestD) { bestD = minD; bestX = cx; bestY = cy; }
    }
    out.push({ x: bestX, y: bestY });
  }
  return out;
}

// reactToWind — apply per-blob sway driven by env.wind + per-position
// phase. Mutates canopy blob positions.
export function reactToWind(canopy, env, time, opts = {}) {
  const strength = opts.strength != null ? opts.strength : 1.5;
  const freq = opts.freq != null ? opts.freq : 1.2;
  for (const b of canopy.blobs) {
    const phase = (b.x + b.y) * 0.05 + time * freq;
    b.x += Math.sin(phase) * env.wind.x * strength;
    b.y += Math.cos(phase * 0.8) * env.wind.y * strength * 0.4;
  }
  return canopy;
}

// followLight — bias each branch's path toward light direction.
// Returns NEW branches list with cumulatively shifted points.
export function followLight(branches, dir, strength) {
  const k = strength != null ? strength : 0.05;
  const out = [];
  for (const b of branches) {
    const path = new Array(b.path.length);
    for (let i = 0; i < b.path.length; i++) {
      const p = b.path[i];
      path[i] = { x: p.x + dir.x * k * i, y: p.y + dir.y * k * i,
                  angle: p.angle, t: p.t, life: p.life };
    }
    out.push(Object.assign({}, b, { path }));
  }
  return out;
}

// seekWater — bias branch tips toward the nearest water cell in a
// boolean grid. `waterFn(x,y) → boolean`.
export function seekWater(branches, waterFn, opts = {}) {
  const reach = opts.reach != null ? opts.reach : 8;
  const k = opts.strength != null ? opts.strength : 0.04;
  const out = [];
  for (const b of branches) {
    if (b.path.length < 2) { out.push(b); continue; }
    let nearest = null, bestD = Infinity;
    const tip = b.path[b.path.length - 1];
    for (let dx = -reach; dx <= reach; dx++) {
      for (let dy = -reach; dy <= reach; dy++) {
        if (waterFn(tip.x + dx, tip.y + dy)) {
          const d = dx * dx + dy * dy;
          if (d < bestD) { bestD = d; nearest = { x: tip.x + dx, y: tip.y + dy }; }
        }
      }
    }
    if (!nearest) { out.push(b); continue; }
    const angle = Math.atan2(nearest.y - tip.y, nearest.x - tip.x);
    out.push(followLight([b], { x: Math.cos(angle), y: Math.sin(angle) }, k)[0]);
  }
  return out;
}

// adaptToTerrain — translate each plant root to its local terrain
// height. `heightFn(x, y) → y`.
export function adaptToTerrain(plants, heightFn) {
  for (const p of plants) {
    const h = heightFn(p.x, p.y);
    const dy = h - p.y;
    p.y = h;
    if (p.branches) {
      for (const b of p.branches) for (const pt of b.path) pt.y += dy;
    }
  }
  return plants;
}

// alignToSurface — angle to grow upward from a (normalX, normalY)
// surface normal. For wall-vines / cliff-side flora.
export function alignToSurface(normalX, normalY) {
  return Math.atan2(-normalY, -normalX) - Math.PI / 2;
}

// applyEnvironmentalForces — composite wind + light pass on a plant
// in one call. Mutates plant.canopy + returns plant.
export function applyEnvironmentalForces(plant, env, dt) {
  if (plant.canopy) reactToWind(plant.canopy, env, env.t, { strength: 0.6 });
  if (plant.branches && env.light) {
    plant.branches = followLight(plant.branches, env.light, dt * 0.02);
  }
  return plant;
}

// resolveGrowthConstraints — clamp each branch path inside `bounds`
// (rect). Helps when a plant is generated near an edge.
export function resolveGrowthConstraints(plant, bounds) {
  if (!plant.branches) return plant;
  const x0 = bounds.x, y0 = bounds.y;
  const x1 = bounds.x + bounds.w, y1 = bounds.y + bounds.h;
  for (const b of plant.branches) {
    for (const p of b.path) {
      if (p.x < x0) p.x = x0; else if (p.x > x1) p.x = x1;
      if (p.y < y0) p.y = y0; else if (p.y > y1) p.y = y1;
    }
  }
  return plant;
}

// seasonShift — return season-adjusted `{huet, density, decay}` knobs.
// Drive palette + density + decay biases off this.
export function seasonShift(env, season) {
  const mods = {
    spring: { huet: 'bloom',  density: 1.0, decay: 0.0 },
    summer: { huet: 'lush',   density: 1.1, decay: 0.05 },
    autumn: { huet: 'amber',  density: 0.9, decay: 0.4 },
    winter: { huet: 'frost',  density: 0.4, decay: 0.7 },
  };
  return mods[season] || mods.summer;
}

// lifeTick — global env time-step. Advances env.t and drifts wind.
export function lifeTick(env, dt) {
  env.t = (env.t || 0) + dt;
  if (env.wind) {
    env.wind.x += (env.fbm(env.t * 0.05, 0) - 0.5) * 0.02;
    env.wind.y += (env.fbm(0, env.t * 0.05) - 0.5) * 0.005;
  }
  return env;
}

// ── High-level pipelines (rendering-pass shape) ─────────────────────

// runGrowthPass — advance every plant's age + tProgress by dt.
export function runGrowthPass(plants, env, dt) {
  for (const p of plants) {
    p.age = (p.age || 0) + dt;
    if (p.tProgress != null && p.tProgress < 1) {
      p.tProgress = Math.min(1, p.tProgress + dt * (p.growthRate || 0.2));
    }
  }
  return plants;
}

// runFoliagePass — rebuild canopies from current branches. Cheap
// enough for live updates if the population is small.
export function runFoliagePass(plants, env) {
  for (const p of plants) {
    if (p.branches) p.canopy = buildCanopy(env, p.branches);
  }
  return plants;
}

// runDecayPass — advance plant wilt + drop a wilt-proportional fraction
// of canopy blobs.
export function runDecayPass(plants, env, dt) {
  for (const p of plants) {
    witherFlora(p, dt);
    if (p.canopy) p.canopy = entropyPass(p.canopy, p.wilt * 0.5, env.rng);
  }
  return plants;
}

// runDetailPass — refresh sparkle + pocket positions for all plants.
export function runDetailPass(plants, env) {
  for (const p of plants) {
    if (p.canopy) p.detail = decorateFoliage(p.canopy, { rng: env.rng });
  }
  return plants;
}

// runFloraPipeline — THE orchestrator. Seeds env, germinates a field,
// generates branches + canopy + decoration for every seed. Returns
// {env, plants} ready to render.
//
//   const flora = runFloraPipeline(42, {
//     width: 256, height: 256, spacing: 24,
//     plantHeight: 22, spread: 0.6,
//   });
//   for (const p of flora.plants) renderPlant(p);
export function runFloraPipeline(seed, opts = {}) {
  const env = seedEnvironment({
    seed, scale: opts.scale,
    wind: opts.wind, light: opts.light,
    biome: opts.biome, palette: opts.palette,
  });
  const seeds = germinateField(env, {
    x: 0, y: 0,
    w: opts.width || 200, h: opts.height || 200,
    spacing: opts.spacing || 16,
    kind: opts.kind || 'tree',
    threshold: opts.threshold || 0,
  });
  const plants = [];
  for (const s of seeds) {
    const branches = generateBranches(env, {
      x: s.x, y: s.y, angle: s.stemAngle,
      height: opts.plantHeight || 18,
      spread: opts.spread || 0.7,
      splits: opts.splits || 0.07,
      gravityBias: opts.gravityBias || 0,
    });
    const canopy = buildCanopy(env, branches, {
      blobScale: opts.blobScale || 4,
      tipRatio: opts.tipRatio || 0.4,
    });
    plants.push({
      x: s.x, y: s.y, vigor: s.vigor,
      branches, canopy,
      tProgress: 1, age: 0, wilt: 0,
    });
  }
  runDetailPass(plants, env);
  return { env, plants };
}

// runBiomeSimulation — one tick of the entire ecosystem (env + plants).
export function runBiomeSimulation(state, dt) {
  lifeTick(state.env, dt);
  runGrowthPass(state.plants, state.env, dt);
  runDecayPass(state.plants, state.env, dt);
  return state;
}

// synthesizeEcosystem — alias for runFloraPipeline. Reserved for
// future cross-cutting (animals, weather).
export function synthesizeEcosystem(seed, opts) {
  return runFloraPipeline(seed, opts);
}

// evolveEnvironment — pure env evolution; no plant updates.
export function evolveEnvironment(env, dt) {
  return lifeTick(env, dt);
}

// ── Drawing helpers (consumed by bakers + live renders) ─────────────

// drawCanopy — render a canopy via per-pixel metaball + paletteRamp
// shading. Pure ctx-emitter; no allocation per frame beyond stack vars.
//
//   drawCanopy(ctx, canopy, {
//     palette: paletteRamp(['#0c2410', '#3a8030', '#80e060']),
//     noise: env.fbm,           // optional fbm field for variation
//     lightX: 6, lightY: 6,     // light source in canopy coords
//     lightRadius: 24,
//     threshold: 0.85,
//   });
// Generate a list of small foliage "tufts" (cluster centers) arranged
// in one of three silhouette modes. Each tuft is `{ x, y, r }` ready to
// pass to `drawTufts`. The clustering algorithm matters because real
// pixel-art canopies (96tree.dmi, 164tree.dmi, evergreen.dmi) are not
// smooth metaballs — they're collections of small overlapping disks
// arranged into specific silhouette shapes:
//
//   mode: 'vertical-egg'  — tall canopy stacked along a trunk axis
//                           (deciduous trees: oak, maple, birch)
//   mode: 'horizontal'    — wide squat tuft for bushes / shrubs
//                           (no visible trunk, just stem hint)
//   mode: 'round'         — symmetric ball (decorative orbs, balloons)
//
// Returns an array of tufts. Pass to `drawTufts` to rasterize them.
export function tuftCluster(opts = {}) {
  const {
    cx = 0, cy = 0,
    width = 16, height = 24,
    rng: r = rng(1),
    mode = 'vertical-egg',
    tiers = 5,
    perTier = 5,
    interior = 8,
    minR = 2.5, maxR = 4,
    interiorMinR = 2, interiorMaxR = 3.5,
  } = opts;
  const tufts = [];
  const halfH = height / 2;

  if (mode === 'vertical-egg') {
    // Stack tiers along the vertical axis; widest in the middle.
    for (let tier = 0; tier < tiers; tier++) {
      const t = tier / Math.max(1, tiers - 1);
      const tierY = (cy - halfH) + t * height;
      const tierW = (width * 0.5) * Math.sin(t * Math.PI) + width * 0.2;
      const n = perTier + Math.floor(r() * 2);
      for (let i = 0; i < n; i++) {
        const ax = (i / Math.max(1, n - 1) - 0.5) * 2;
        tufts.push({
          x: cx + ax * tierW + (r() - 0.5) * 1.5,
          y: tierY + (r() - 0.5) * 2,
          r: minR + r() * (maxR - minR),
        });
      }
    }
    for (let i = 0; i < interior; i++) {
      tufts.push({
        x: cx + (r() - 0.5) * width * 0.4,
        y: cy + (r() - 0.5) * height * 0.6,
        r: interiorMinR + r() * (interiorMaxR - interiorMinR),
      });
    }
  } else if (mode === 'horizontal') {
    // Squat horizontal-egg for bushes — no vertical tiering, ring layout.
    const ringN = perTier * tiers;
    for (let i = 0; i < ringN; i++) {
      const ang = (i / ringN) * Math.PI * 2 + r() * 0.4;
      const dist = (width / 4) + r() * (width / 8);
      tufts.push({
        x: cx + Math.cos(ang) * dist * 1.2,
        y: cy + Math.sin(ang) * dist * 0.7,
        r: minR + r() * (maxR - minR),
      });
    }
    for (let i = 0; i < interior; i++) {
      tufts.push({
        x: cx + (r() - 0.5) * width * 0.5,
        y: cy + (r() - 0.5) * height * 0.5,
        r: interiorMinR + r() * (interiorMaxR - interiorMinR),
      });
    }
  } else {  // 'round'
    const n = perTier * tiers;
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2 + r() * 0.3;
      const dist = (Math.min(width, height) / 4) + r() * 3;
      tufts.push({
        x: cx + Math.cos(ang) * dist,
        y: cy + Math.sin(ang) * dist,
        r: minR + r() * (maxR - minR),
      });
    }
    for (let i = 0; i < interior; i++) {
      tufts.push({
        x: cx + (r() - 0.5) * 6,
        y: cy + (r() - 0.5) * 6,
        r: interiorMinR + r() * (interiorMaxR - interiorMinR),
      });
    }
  }
  return tufts;
}

// Rasterize a tuft cluster onto a canvas with light-aware shading and
// edge-gap dropping. Each pixel covered by ≥1 tuft is shaded by a per-
// tuft Lambert dot product, then ~`gapDrop` of the perimeter pixels are
// dropped using fbm noise — that's what gives real reference canopies
// their characteristic bumpy outline with negative space between tufts.
//
//   palette  — color stops, 4-6 entries (use hueShiftRamp)
//   tufts    — output of tuftCluster
//   noise2D  — fbm/value noise (pass env.fbm or a fresh one)
//   lightDx, lightDy  — light direction (unit-ish, e.g. -0.7, -0.85)
//   gapDrop  — 0..1, fraction of edge pixels to drop (0.18 default)
export function drawTufts(canvas, tufts, opts = {}) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const {
    palette,
    noise2D,
    lightDx = -0.7, lightDy = -0.85,
    gapDrop = 0.18,
    seed = 0,
    // Stop math: stop = round(centerStop + l * lightSpread). Defaults
    // match the original inlined recipe (centered slightly dark of
    // midtone, narrow spread). Bumping centerStop or lightSpread
    // brightens / increases contrast, but most callers want defaults.
    centerStop = 2,
    lightSpread = 2.2,
  } = opts;
  if (!palette || palette.length < 3) {
    throw new Error('drawTufts: palette of ≥3 stops required');
  }
  const lastStop = palette.length - 1;
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      let covered = false, lit = 0, wsum = 0;
      for (const t of tufts) {
        const dx = px - t.x, dy = py - t.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < t.r * t.r) {
          covered = true;
          const w = t.r * t.r - d2;
          lit += (-(dx * lightDx + dy * lightDy)) / t.r * w;
          wsum += w;
        }
      }
      if (!covered) continue;
      if (noise2D) {
        const n = (noise2D(px * 0.4 + seed, py * 0.4) + 1) * 0.5;
        if (n < gapDrop) continue;
      }
      const l = wsum > 0 ? lit / wsum : 0;
      const stop = Math.max(0, Math.min(lastStop,
        Math.round(centerStop + l * lightSpread)));
      ctx.fillStyle = palette[stop];
      ctx.fillRect(px, py, 1, 1);
    }
  }
}

// Build a stacked-skirt conifer canopy directly into a canvas. This is
// the architecture used by every real BYOND conifer (evergreen.dmi,
// pinetrees.dmi, 96tree.dmi pines): N horizontal triangle skirts that
// widen toward the base, each separated by a 1-2px gap, with a 1px
// dark stroke along the bottom of each skirt suggesting occlusion by
// the next skirt down.
//
//   palette  — 5-6 stop hueShiftRamp
//   tiers    — number of skirts (6-7 looks best)
//   topY/bottomY  — vertical extent of the cone
//   baseHalfWidth — half-width of the bottom skirt (top is always 3px)
//   noise2D  — for needle-edge wobble (pass env.fbm)
export function buildSkirtStack(canvas, opts = {}) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const {
    palette,
    cx = W / 2,
    topY = 3,
    bottomY = canvas.height - 11,
    tiers = 7,
    baseHalfWidth = 14,
    topHalfWidth = 3,
    noise2D = null,
    edgeWobble = 1.6,
    seed = 0,
  } = opts;
  if (!palette || palette.length < 5) {
    throw new Error('buildSkirtStack: palette of ≥5 stops required');
  }

  const tierH = (bottomY - topY) / tiers;
  const tierBottoms = [];
  for (let i = 0; i < tiers; i++) {
    const t = i / Math.max(1, tiers - 1);
    const halfW = topHalfWidth + t * (baseHalfWidth - topHalfWidth);
    const yTop = Math.round(topY + i * tierH);
    const yBot = Math.round(yTop + tierH + 1);
    tierBottoms.push({ y: yBot, halfW });

    for (let y = yTop; y <= yBot; y++) {
      const ty = (y - yTop) / Math.max(1, yBot - yTop);
      const rowHalf = halfW * (1 - ty * 0.65);
      const wobL = noise2D ? noise2D(y * 0.7 + seed, i * 3.1) * edgeWobble : 0;
      const wobR = noise2D ? noise2D(y * 0.7 + seed + 100, i * 3.1) * edgeWobble : 0;
      const xL = Math.round(cx - rowHalf - wobL);
      const xR = Math.round(cx + rowHalf + wobR);
      const lightT = 0.65 - ty * 0.55;
      for (let x = xL; x <= xR; x++) {
        const sideT = (x - cx) / Math.max(1, rowHalf);
        const sideShade = sideT > 0 ? -0.18 : 0.05;
        const shade = Math.max(0, Math.min(1, lightT + sideShade));
        const stop = Math.floor(shade * (palette.length - 1));
        ctx.fillStyle = palette[stop];
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }

  // Pointed tip (single column above the topmost skirt)
  ctx.fillStyle = palette[3] || palette[2];
  ctx.fillRect(Math.round(cx), topY - 2, 1, 2);

  // Skirt-bottom shadow lines — 1px dark stroke along each skirt's
  // lower row, restricted to the inner 62% so it doesn't reach the
  // edge silhouette. This is THE detail that sells the layered look.
  ctx.fillStyle = palette[0];
  for (const tb of tierBottoms) {
    const halfW = tb.halfW * 0.62;
    const xL = Math.round(cx - halfW);
    const xR = Math.round(cx + halfW);
    for (let x = xL; x <= xR; x++) {
      const px = ctx.getImageData(x, tb.y, 1, 1).data;
      if (px[3] > 0) ctx.fillRect(x, tb.y, 1, 1);
    }
  }
}

// Recursive asymmetric branching with mid-segment kinks. Produces the
// gnarled silhouettes seen in deadtrees.dmi / 128tree.dmi rather than
// the symmetric Y-shapes that `branch()` and `generateBranches` give.
// Returns flat list of `{ x0, y0, x1, y1, depth }` segments — pipe to
// drawBranchPath or rasterize directly.
//
//   x, y       — start point (usually base of trunk)
//   ang        — initial angle in radians (-PI/2 = up)
//   length     — initial segment length
//   maxDepth   — recursion limit (4-5 looks best)
//   rng        — seeded rng
//   kinkChance — 0..1, probability a segment bends at midpoint
//   forkSpread — base angle of L/R fork in radians (~0.5)
//   stubChance — probability of a 3rd offshoot from a fork
export function gnarledBranches(opts = {}) {
  const {
    x = 0, y = 0, ang = -Math.PI / 2,
    length = 10, maxDepth = 4,
    rng: r = rng(1),
    kinkChance = 0.55,
    forkSpread = 0.5,
    stubChance = 0.35,
    minLength = 1.5,
  } = opts;
  const segments = [];
  const walk = (sx, sy, sang, slen, depth) => {
    if (depth <= 0 || slen < minLength) return;
    let ex, ey;
    if (depth > 1 && r() < kinkChance) {
      const m = 0.4 + r() * 0.3;
      const mx = sx + Math.cos(sang) * slen * m;
      const my = sy + Math.sin(sang) * slen * m;
      segments.push({ x0: sx, y0: sy, x1: mx, y1: my, depth });
      sang += (r() - 0.5) * 0.7;
      ex = mx + Math.cos(sang) * slen * (1 - m);
      ey = my + Math.sin(sang) * slen * (1 - m);
      segments.push({ x0: mx, y0: my, x1: ex, y1: ey, depth });
    } else {
      ex = sx + Math.cos(sang) * slen;
      ey = sy + Math.sin(sang) * slen;
      segments.push({ x0: sx, y0: sy, x1: ex, y1: ey, depth });
    }
    const lJit = 0.6 + r() * 0.25, rJit = 0.6 + r() * 0.25;
    const lAng = -forkSpread - r() * (forkSpread * 1.2);
    const rAng =  forkSpread + r() * (forkSpread * 1.2);
    walk(ex, ey, sang + lAng, slen * lJit, depth - 1);
    walk(ex, ey, sang + rAng, slen * rJit, depth - 1);
    if (r() < stubChance && depth > 1) {
      walk(ex, ey, sang + (r() - 0.5) * 0.5,
           slen * (0.4 + r() * 0.2), depth - 1);
    }
  };
  walk(x, y, ang, length, maxDepth);
  return segments;
}

// Multi-stop random texture pass over an existing canvas. Drops dark
// "gap" pixels and bright "tip" pixels onto a small fraction of the
// already-solid pixels, suggesting individual leaves/needles. This is
// the highest-impact texture multiplier for foliage — the difference
// between a smooth blob and a "lush" canopy.
//
//   palette        — same ramp used to draw the canopy
//   density        — 0..1 fraction of total canvas pixels to attempt
//                    (only solid pixels actually receive speckle, so
//                    effective density is lower for sparse silhouettes;
//                    0.04 gives ~120 dots on 48×64 — the "lush" default)
//   darkRatio      — fraction of dots that are dark (others bright)
//   darkStop/brightStop — palette indices for the two colors
//   rng            — seeded rng
export function speckleTexture(canvas, opts = {}) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const {
    palette,
    density = 0.04,
    darkRatio = 0.6,
    darkStop = 1,
    brightStop = palette ? palette.length - 2 : 4,
    brightestStop = palette ? palette.length - 1 : 5,
    brightestRatio = 0.15,    // of the bright fraction, this much is brightest
    rng: r = rng(1),
  } = opts;
  if (!palette) throw new Error('speckleTexture: palette required');
  const total = Math.floor((W * H) * density);
  for (let i = 0; i < total; i++) {
    const sx = Math.floor(r() * W);
    const sy = Math.floor(r() * H);
    const data = ctx.getImageData(sx, sy, 1, 1).data;
    if (data[3] === 0) continue;
    const roll = r();
    let stop;
    if (roll < darkRatio) stop = darkStop;
    else if (roll < darkRatio + (1 - darkRatio) * (1 - brightestRatio)) stop = brightStop;
    else stop = brightestStop;
    ctx.fillStyle = palette[stop];
    ctx.fillRect(sx, sy, 1, 1);
  }
}

// Sketch dark "branch peek-through" twigs into a canopy, occlusion-
// aware: a stamped pixel only persists if the underlying canvas pixel
// is already solid (so the twig appears to be *behind* the foliage,
// poking through gaps). Adds depth and structural suggestion at near-
// zero cost.
//
//   anchorX, anchorY  — where branches root (usually trunk top)
//   color             — twig color (use a dark bark stop)
//   count             — number of twigs to sketch
//   spread            — horizontal spread of twig endpoints
//   reach             — vertical reach upward from anchor
//   density           — fraction of segment pixels actually stamped
//                       (lower = more sketchy, higher = more solid)
//   rng               — seeded rng
export function peekThroughBranches(canvas, opts = {}) {
  const ctx = canvas.getContext('2d');
  const {
    anchorX = canvas.width / 2,
    anchorY = canvas.height / 2,
    color = '#2a1a08',
    count = 3,
    spread = 14,
    reach = 14,
    density = 0.5,
    rng: r = rng(1),
  } = opts;
  ctx.fillStyle = color;
  for (let b = 0; b < count; b++) {
    const startX = anchorX + (r() - 0.5) * 4;
    const endX = startX + (r() - 0.5) * spread;
    const endY = anchorY - reach * (0.5 + r() * 0.6);
    const steps = 12;
    for (let s = 0; s <= steps; s++) {
      const f = s / steps;
      const x = Math.round(startX + (endX - startX) * f);
      const y = Math.round(anchorY + (endY - anchorY) * f);
      const px = ctx.getImageData(x, y, 1, 1).data;
      if (px[3] > 0 && r() < density) ctx.fillRect(x, y, 1, 1);
    }
  }
}

export function drawCanopy(ctx, canopy, opts) {
  const palette = opts.palette;
  const lightX = opts.lightX != null ? opts.lightX : canopy.bounds.x;
  const lightY = opts.lightY != null ? opts.lightY : canopy.bounds.y;
  const lightR = opts.lightRadius || 26;
  const threshold = opts.threshold != null ? opts.threshold : 0.85;
  const noise = opts.noise;
  const x0 = Math.floor(canopy.bounds.x);
  const y0 = Math.floor(canopy.bounds.y);
  const x1 = Math.ceil(canopy.bounds.x + canopy.bounds.w);
  const y1 = Math.ceil(canopy.bounds.y + canopy.bounds.h);
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      const m = metaball(px, py, canopy.blobs);
      if (m < threshold) continue;
      const n = noise ? (noise(px * 0.22, py * 0.22) + 1) * 0.5 : 0.5;
      const dist = Math.hypot(px - lightX, py - lightY);
      const dirLight = Math.max(0, 1 - dist / lightR);
      const depth = Math.min(1, (m - threshold) * 1.6);
      const shade = Math.max(0, Math.min(1,
        (n * 0.45 + dirLight * 0.7) * (0.35 + depth * 0.65)));
      ctx.fillStyle = palette(shade);
      ctx.fillRect(px, py, 1, 1);
    }
  }
}

// drawBranchPath — render a tapered branch path with directional
// shading (lit-edge / core / shadow-edge).
export function drawBranchPath(ctx, path, opts = {}) {
  const baseW = opts.thickness != null ? opts.thickness : 4;
  const taper = opts.taper != null ? opts.taper : 0.55;
  const colCore = opts.core || '#000';
  const colLit = opts.lit || '#fff';
  const colShade = opts.shade || '#000';
  for (let i = 0; i < path.length; i++) {
    const pt = path[i];
    const prog = i / Math.max(1, path.length - 1);
    const w = Math.max(1, Math.round(baseW * (1 - prog * taper)));
    const half = w >> 1;
    for (let dx = -half; dx < w - half; dx++) {
      ctx.fillStyle = dx < 0 ? colLit : (dx === 0 ? colCore : colShade);
      ctx.globalAlpha = dx < 0 ? 0.4 : (dx === 0 ? 1 : 0.45);
      ctx.fillRect(Math.round(pt.x + dx), Math.round(pt.y), 1, 1);
    }
  }
  ctx.globalAlpha = 1;
}

// ══════════════════════════════════════════════════════════════════════
// 28. Pixel-art finishing — wang/9-slice, cluster cleanup,
//     curvature outline, bitmap fonts
// ══════════════════════════════════════════════════════════════════════
//
// These primitives push generated output toward "intentional pixel art":
// connecting tiles read as continuous (wang), surfaces stretch cleanly
// at any size (9-slice), noise speckles get cleaned, outlines bulk up
// at concave corners, and labels can be authored in ASCII.

// 28.1 ── Wang tiles + 9-slice ──────────────────────────────────────

// wang4Index — encode 4-cardinal-neighbor connectivity as a 0..15 index.
// Bits: N=1, E=2, S=4, W=8. Use to drive a 16-tile autotile lookup.
//
//   const idx = wang4Index(grid, x, y, c => c === 'w');
//   ctx.drawImage(waterTiles[idx], dx, dy);
export function wang4Index(grid, x, y, predicate) {
  const w = grid[0].length, h = grid.length;
  let idx = 0;
  if (y > 0     && predicate(grid[y - 1][x])) idx |= 1;
  if (x < w - 1 && predicate(grid[y][x + 1])) idx |= 2;
  if (y < h - 1 && predicate(grid[y + 1][x])) idx |= 4;
  if (x > 0     && predicate(grid[y][x - 1])) idx |= 8;
  return idx;
}

// wang8Index — full 8-neighbor connectivity (0..255). Use for ground-cover
// transitions where corner-only matches need their own variants.
// Bits: N=1, NE=2, E=4, SE=8, S=16, SW=32, W=64, NW=128.
export function wang8Index(grid, x, y, predicate) {
  const w = grid[0].length, h = grid.length;
  const at = (cx, cy) => (cx >= 0 && cy >= 0 && cx < w && cy < h && predicate(grid[cy][cx]));
  let idx = 0;
  if (at(x,     y - 1)) idx |= 1;
  if (at(x + 1, y - 1)) idx |= 2;
  if (at(x + 1, y    )) idx |= 4;
  if (at(x + 1, y + 1)) idx |= 8;
  if (at(x,     y + 1)) idx |= 16;
  if (at(x - 1, y + 1)) idx |= 32;
  if (at(x - 1, y    )) idx |= 64;
  if (at(x - 1, y - 1)) idx |= 128;
  return idx;
}

// buildWangMask4 — produce the SILHOUETTE MASK for a 4-cardinal wang
// tile at the given index. Returns Uint8Array of length size*size; 1
// = filled silhouette pixel, 0 = transparent. Each "open" side (a bit
// not set in `idx`) is inset by `opts.inset` pixels, and corners
// where two adjacent sides are both open get a `opts.chamfer`-pixel
// diagonal cut so the silhouette reads as rounded.
//
// This is the GEOMETRY of wang tiles — caller does its own rendering
// (fbm fill, rim, outline, palette lookup) on top of the mask. Use
// when you want wang's connectivity-aware shape but with custom art
// styling (game-specific palette, special blend modes, etc).
//
//   const mask = buildWangMask4(idx, 16, { inset: 2, chamfer: 1 });
//   for (let py = 0; py < 16; py++) {
//     for (let px = 0; px < 16; px++) {
//       if (mask[py * 16 + px]) {
//         ctx.fillRect(px, py, 1, 1);
//       }
//     }
//   }
//
// opts:
//   inset     pixels to inset on each open side (default size/8)
//   chamfer   diagonal corner-cut size where two adjacent sides are
//             both open (default 1)
export function buildWangMask4(idx, size, opts = {}) {
  const inset = opts.inset != null ? opts.inset : Math.max(1, Math.floor(size / 8));
  const chamfer = opts.chamfer != null ? opts.chamfer : 1;
  const N = (idx & 1) !== 0;
  const E = (idx & 2) !== 0;
  const S = (idx & 4) !== 0;
  const W = (idx & 8) !== 0;
  const insetN = N ? 0 : inset;
  const insetE = E ? 0 : inset;
  const insetS = S ? 0 : inset;
  const insetW = W ? 0 : inset;
  const mask = new Uint8Array(size * size);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      if (py < insetN) continue;
      if (py >= size - insetS) continue;
      if (px < insetW) continue;
      if (px >= size - insetE) continue;
      // Chamfer open corners — diagonal cut where two adjacent open
      // sides meet, so the silhouette has rounded outside corners
      // instead of a hard 90° step.
      if (!N && !W && (px - insetW) + (py - insetN) < chamfer) continue;
      if (!N && !E && ((size - 1 - insetE) - px) + (py - insetN) < chamfer) continue;
      if (!S && !W && (px - insetW) + ((size - 1 - insetS) - py) < chamfer) continue;
      if (!S && !E && ((size - 1 - insetE) - px) + ((size - 1 - insetS) - py) < chamfer) continue;
      mask[py * size + px] = 1;
    }
  }
  return mask;
}

// wang8Neighbors — collect the 8-neighbor connectivity flags for a
// cell. Returns { N, NE, E, SE, S, SW, W, NW } booleans. The full
// 8-neighbor info is what the "blob47" autotile needs to decide
// concave-vs-convex corners; bare wang4Index can't.
export function wang8Neighbors(grid, x, y, predicate) {
  const w = grid[0].length, h = grid.length;
  const at = (cx, cy) =>
    cx >= 0 && cy >= 0 && cx < w && cy < h && predicate(grid[cy][cx]);
  return {
    N:  at(x,     y - 1),
    NE: at(x + 1, y - 1),
    E:  at(x + 1, y    ),
    SE: at(x + 1, y + 1),
    S:  at(x,     y + 1),
    SW: at(x - 1, y + 1),
    W:  at(x - 1, y    ),
    NW: at(x - 1, y - 1),
  };
}

// buildWangMask47 — "blob47" silhouette. Like buildWangMask4 but
// diagonal-aware: when two cardinal sides are BOTH connected (the
// silhouette extends to the corner) but the diagonal between them is
// MISSING, the corner gets a concave inside-cut. This is the
// difference between "blocky 16-tile wang" and "proper Stardew-style
// autotile" — without the concave cut, an L-shaped path has a hard
// 90° step at the inside corner; with it, the corner reads as a
// rounded notch following the silhouette boundary.
//
//   const neighbors = wang8Neighbors(grid, x, y, isPath);
//   const mask = buildWangMask47(neighbors, 16, { inset: 2, concave: 2 });
//
// opts:
//   inset      open-side inset (same as buildWangMask4; default size/8)
//   chamfer    open-corner chamfer (same as buildWangMask4; default 1)
//   concave    inside-corner cut size in pixels (default 2). Larger
//              values give more pronounced rounding on inside corners.
export function buildWangMask47(neighbors, size, opts = {}) {
  const inset   = opts.inset   != null ? opts.inset   : Math.max(1, Math.floor(size / 8));
  const chamfer = opts.chamfer != null ? opts.chamfer : 1;
  const concave = opts.concave != null ? opts.concave : 2;
  const { N, NE, E, SE, S, SW, W, NW } = neighbors;
  const idx = (N ? 1 : 0) | (E ? 2 : 0) | (S ? 4 : 0) | (W ? 8 : 0);
  const mask = buildWangMask4(idx, size, { inset, chamfer });
  // Concave inside-corner cuts. Triggered when both adjacent cardinals
  // are connected (silhouette reaches the corner) but the diagonal
  // is NOT — meaning visually there should be a notch. The cut is a
  // small triangular bite at the corner.
  // NE corner — cut top-right
  if (N && E && !NE) {
    for (let py = 0; py < concave; py++) {
      for (let px = size - concave; px < size; px++) {
        const dx = (size - 1) - px;
        const dy = py;
        if (dx + dy < concave - 0.5) mask[py * size + px] = 0;
      }
    }
  }
  // NW corner — cut top-left
  if (N && W && !NW) {
    for (let py = 0; py < concave; py++) {
      for (let px = 0; px < concave; px++) {
        if (px + py < concave - 0.5) mask[py * size + px] = 0;
      }
    }
  }
  // SE corner — cut bottom-right
  if (S && E && !SE) {
    for (let py = size - concave; py < size; py++) {
      for (let px = size - concave; px < size; px++) {
        const dx = (size - 1) - px;
        const dy = (size - 1) - py;
        if (dx + dy < concave - 0.5) mask[py * size + px] = 0;
      }
    }
  }
  // SW corner — cut bottom-left
  if (S && W && !SW) {
    for (let py = size - concave; py < size; py++) {
      for (let px = 0; px < concave; px++) {
        const dy = (size - 1) - py;
        if (px + dy < concave - 0.5) mask[py * size + px] = 0;
      }
    }
  }
  return mask;
}

// buildWangMap — precompute the wang index for every cell. Useful when
// many tiles consult the same predicate; compute once, reuse during render.
export function buildWangMap(grid, predicate, mode) {
  const w = grid[0].length, h = grid.length;
  const fn = mode === 8 ? wang8Index : wang4Index;
  const out = [];
  for (let y = 0; y < h; y++) {
    const row = mode === 8 ? new Uint16Array(w) : new Uint8Array(w);
    for (let x = 0; x < w; x++) row[x] = fn(grid, x, y, predicate);
    out.push(row);
  }
  return out;
}

// draw9Slice — render a stretchy panel from a 9-slice source sprite.
// `cornerSize` is the size of each fixed corner; the four edges stretch
// to fill the target dimensions, the center tiles or stretches as well.
// Use for UI panels, dialogue boxes, terrain transitions.
//
//   draw9Slice(ctx, panelImg, 0, 0, 24, 24,    // source sub-rect
//                            mx, my, mw, mh,   // dest rect
//                            8);                // corner size
export function draw9Slice(ctx, src, sx, sy, sw, sh, dx, dy, dw, dh, cornerSize) {
  const cs = cornerSize;
  const eW = sw - 2 * cs, eH = sh - 2 * cs;        // source edge dims
  const dEW = dw - 2 * cs, dEH = dh - 2 * cs;      // dest edge dims
  // Corners (1:1).
  ctx.drawImage(src, sx,           sy,           cs, cs, dx,           dy,           cs, cs);
  ctx.drawImage(src, sx + sw - cs, sy,           cs, cs, dx + dw - cs, dy,           cs, cs);
  ctx.drawImage(src, sx,           sy + sh - cs, cs, cs, dx,           dy + dh - cs, cs, cs);
  ctx.drawImage(src, sx + sw - cs, sy + sh - cs, cs, cs, dx + dw - cs, dy + dh - cs, cs, cs);
  // Edges (stretched).
  if (dEW > 0 && eW > 0) {
    ctx.drawImage(src, sx + cs, sy,           eW, cs, dx + cs, dy,           dEW, cs);
    ctx.drawImage(src, sx + cs, sy + sh - cs, eW, cs, dx + cs, dy + dh - cs, dEW, cs);
  }
  if (dEH > 0 && eH > 0) {
    ctx.drawImage(src, sx,           sy + cs, cs, eH, dx,           dy + cs, cs, dEH);
    ctx.drawImage(src, sx + sw - cs, sy + cs, cs, eH, dx + dw - cs, dy + cs, cs, dEH);
  }
  // Center (stretched).
  if (dEW > 0 && dEH > 0 && eW > 0 && eH > 0) {
    ctx.drawImage(src, sx + cs, sy + cs, eW, eH, dx + cs, dy + cs, dEW, dEH);
  }
}

// 28.2 ── Pixel cluster cleanup ─────────────────────────────────────

// cleanIsolatedPixels — remove pixels with fewer than `minNeighbors`
// opaque 4-neighbors. Isolated single pixels read as noise; this pass
// strips them, lifting bake quality from "speckled output" toward
// "intentional pixel art."
//
//   cleanIsolatedPixels(canvas);                  // default: minN=1
//   cleanIsolatedPixels(canvas, { minNeighbors: 2 });  // stricter
export function cleanIsolatedPixels(canvas, opts = {}) {
  const minN = opts.minNeighbors != null ? opts.minNeighbors : 1;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const img = ctx.getImageData(0, 0, w, h);
  const src = img.data;
  const dst = new Uint8ClampedArray(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (src[i + 3] < 8) continue;
      let cnt = 0;
      if (y > 0     && src[((y - 1) * w + x) * 4 + 3] >= 8) cnt++;
      if (y < h - 1 && src[((y + 1) * w + x) * 4 + 3] >= 8) cnt++;
      if (x > 0     && src[(y * w + x - 1) * 4 + 3] >= 8) cnt++;
      if (x < w - 1 && src[(y * w + x + 1) * 4 + 3] >= 8) cnt++;
      if (cnt >= minN) {
        dst[i]     = src[i];
        dst[i + 1] = src[i + 1];
        dst[i + 2] = src[i + 2];
        dst[i + 3] = src[i + 3];
      }
    }
  }
  ctx.putImageData(new ImageData(dst, w, h), 0, 0);
  return canvas;
}

// breakBanding — soften long single-color runs by injecting a darker/
// lighter pixel every `period`. Combats the "stripe" look fbm fills
// produce when threshold-quantized.
//
//   breakBanding(canvas, { period: 5, jitter: 0.3, rng: r });
export function breakBanding(canvas, opts = {}) {
  const period = opts.period || 5;
  const jitter = opts.jitter != null ? opts.jitter : 0.3;
  const r = opts.rng || rng(1);
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const img = ctx.getImageData(0, 0, w, h);
  const data = img.data;
  for (let y = 0; y < h; y++) {
    let runStart = 0;
    let runR = data[(y * w) * 4];
    let runG = data[(y * w) * 4 + 1];
    let runB = data[(y * w) * 4 + 2];
    for (let x = 1; x <= w; x++) {
      const i = (y * w + x) * 4;
      const same = x < w
        && data[i]     === runR
        && data[i + 1] === runG
        && data[i + 2] === runB
        && data[i + 3] >= 8;
      if (!same) {
        const len = x - runStart;
        if (len >= period) {
          // Jitter every `period` step.
          for (let k = runStart + period; k < x; k += period) {
            if (r() > jitter) continue;
            const ji = (y * w + k) * 4;
            const f = (r() < 0.5 ? 0.85 : 1.15);
            data[ji]     = Math.max(0, Math.min(255, runR * f | 0));
            data[ji + 1] = Math.max(0, Math.min(255, runG * f | 0));
            data[ji + 2] = Math.max(0, Math.min(255, runB * f | 0));
          }
        }
        runStart = x;
        if (x < w) {
          runR = data[i]; runG = data[i + 1]; runB = data[i + 2];
        }
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// 28.3 ── Curvature-aware outline ───────────────────────────────────

// smartOutline — outline a silhouette with curvature-aware thickening.
// Phase 1 places 1-pixel outline at every empty cell adjacent to an
// opaque pixel. Phase 2 detects concave dents (cells with 5+ opaque
// 8-neighbors) and extends the outline one cell outward in the direction
// of the dent's "open" side. Result: smooth edges stay 1-pixel, tucked
// corners get a 2-pixel bulk that reads as deliberate ink-economy.
//
//   smartOutline(canvas, { color: '#000' });
export function smartOutline(canvas, opts = {}) {
  const color = opts.color || '#000';
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const img = ctx.getImageData(0, 0, w, h);
  const src = img.data;
  const dst = new Uint8ClampedArray(src);
  const isOpaque = (x, y) =>
    x >= 0 && y >= 0 && x < w && y < h && src[(y * w + x) * 4 + 3] >= 8;
  const { r: or, g: og, b: ob } = parseColor(color);

  const concave = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (isOpaque(x, y)) continue;
      let opCount = 0;
      let cardCount = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          if (isOpaque(x + dx, y + dy)) {
            opCount++;
            if (dx === 0 || dy === 0) cardCount++;
          }
        }
      }
      // Outline pixels need at least one cardinal opaque neighbor —
      // pure-diagonal-only adjacency reads as a stair gap, not an edge.
      if (cardCount === 0) continue;
      const i = (y * w + x) * 4;
      dst[i]     = or;
      dst[i + 1] = og;
      dst[i + 2] = ob;
      dst[i + 3] = 255;
      if (opCount >= 5) concave.push([x, y]);
    }
  }
  // Phase 2: extend outline outward from concave points.
  for (let i = 0; i < concave.length; i++) {
    const x = concave[i][0], y = concave[i][1];
    let nx = 0, ny = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        if (isOpaque(x + dx, y + dy)) { nx -= dx; ny -= dy; }
      }
    }
    const sx = nx === 0 ? 0 : (nx > 0 ? 1 : -1);
    const sy = ny === 0 ? 0 : (ny > 0 ? 1 : -1);
    if (sx === 0 && sy === 0) continue;
    const ox = x + sx, oy = y + sy;
    if (ox < 0 || oy < 0 || ox >= w || oy >= h) continue;
    if (isOpaque(ox, oy)) continue;
    const oi = (oy * w + ox) * 4;
    dst[oi]     = or;
    dst[oi + 1] = og;
    dst[oi + 2] = ob;
    dst[oi + 3] = 255;
  }
  ctx.putImageData(new ImageData(dst, w, h), 0, 0);
  return canvas;
}

// 28.4 ── BitmapFont ────────────────────────────────────────────────
//
// Stateful glyph cache + tinted draw. Glyphs are authored as ASCII
// templates: `' '` = transparent, anything else = filled.
//
//   const font = new BitmapFont({
//     cellW: 5, cellH: 7,
//     glyphs: {
//       'A': [' XXX ', 'X   X', 'X   X', 'XXXXX', 'X   X', 'X   X', 'X   X'],
//       'B': ['XXXX ', 'X   X', 'X   X', 'XXXX ', 'X   X', 'X   X', 'XXXX '],
//       // ...
//     },
//     kerning: -1,        // tighter inter-glyph spacing
//     lineHeight: 8,
//   });
//   font.draw(ctx, 'HELLO', 10, 10, { color: '#fff' });
//   font.measure('HELLO');   // → { w, h }
//
// At construction the white-on-transparent base canvas for each glyph
// is baked once. Tinted draws cache per `(ch, color)` pair so repeated
// text in the same color avoids re-baking.
export class BitmapFont {
  constructor(spec = {}) {
    this.cellW      = spec.cellW || 5;
    this.cellH      = spec.cellH || 7;
    this.lineHeight = spec.lineHeight != null ? spec.lineHeight : (this.cellH + 1);
    this.kerning    = spec.kerning != null ? spec.kerning : 0;
    this.spaceW     = spec.spaceW != null ? spec.spaceW : Math.max(2, Math.floor(this.cellW * 0.6));
    this.glyphCache = new Map();
    this._tintCache = new Map();
    if (spec.glyphs) {
      for (const ch in spec.glyphs) this.bake(ch, spec.glyphs[ch]);
    }
  }
  // Bake a single glyph from its ASCII row spec (' ' = empty, else filled).
  bake(ch, rows) {
    const cnv = (typeof OffscreenCanvas !== 'undefined')
      ? new OffscreenCanvas(this.cellW, this.cellH)
      : document.createElement('canvas');
    if (!('width' in cnv && 'height' in cnv) || cnv.width !== this.cellW) {
      cnv.width = this.cellW; cnv.height = this.cellH;
    }
    const gctx = cnv.getContext('2d');
    gctx.clearRect(0, 0, this.cellW, this.cellH);
    gctx.fillStyle = '#fff';
    for (let y = 0; y < rows.length && y < this.cellH; y++) {
      const row = rows[y];
      for (let x = 0; x < row.length && x < this.cellW; x++) {
        if (row[x] !== ' ' && row[x] !== '.') gctx.fillRect(x, y, 1, 1);
      }
    }
    this.glyphCache.set(ch, cnv);
    // Invalidate any tinted variants of this glyph — re-baked source.
    for (const k of this._tintCache.keys()) {
      if (k[0] === ch && k[1] === '|') this._tintCache.delete(k);
    }
  }
  // Returns { w, h } in pixels for the rendered string. Honors '\n'.
  measure(str) {
    let lineW = 0, maxW = 0, lines = 1;
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (ch === '\n') { if (lineW > maxW) maxW = lineW; lineW = 0; lines++; continue; }
      if (ch === ' ')  { lineW += this.spaceW + this.kerning; continue; }
      lineW += this.cellW + this.kerning;
    }
    if (lineW > maxW) maxW = lineW;
    return { w: Math.max(0, maxW - this.kerning), h: lines * this.lineHeight };
  }
  // Render `str` at (x, y). Per-char missing glyphs are skipped.
  draw(ctx, str, x, y, opts = {}) {
    const color = opts.color || '#fff';
    let cx = x, cy = y;
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (ch === '\n') { cx = x; cy += this.lineHeight; continue; }
      if (ch === ' ')  { cx += this.spaceW + this.kerning; continue; }
      const tinted = this._getTinted(ch, color);
      if (tinted) ctx.drawImage(tinted, cx, cy);
      cx += this.cellW + this.kerning;
    }
  }
  // Convenience: draw a single glyph as an icon.
  drawGlyph(ctx, ch, x, y, opts = {}) {
    const color = opts.color || '#fff';
    const tinted = this._getTinted(ch, color);
    if (tinted) ctx.drawImage(tinted, x, y);
  }
  _getTinted(ch, color) {
    const src = this.glyphCache.get(ch);
    if (!src) return null;
    if (color === '#fff' || color === '#ffffff' || color === 'white') return src;
    const key = ch + '|' + color;
    const hit = this._tintCache.get(key);
    if (hit) return hit;
    const cnv = (typeof OffscreenCanvas !== 'undefined')
      ? new OffscreenCanvas(this.cellW, this.cellH)
      : document.createElement('canvas');
    if (cnv.width !== this.cellW) { cnv.width = this.cellW; cnv.height = this.cellH; }
    const c = cnv.getContext('2d');
    c.clearRect(0, 0, this.cellW, this.cellH);
    c.drawImage(src, 0, 0);
    c.globalCompositeOperation = 'source-in';
    c.fillStyle = color;
    c.fillRect(0, 0, this.cellW, this.cellH);
    this._tintCache.set(key, cnv);
    return cnv;
  }
}

// ══════════════════════════════════════════════════════════════════════
// 29. Pixel-art shading + palette discipline
// ══════════════════════════════════════════════════════════════════════
//
// The primitives that bridge "procedurally drew some shapes" and
// "looks like real pixel art." The defining differences between
// amateur and professional pixel art aren't shapes — those we have.
// They're SHADING and PALETTE: hue-shifted ramps (cooler shadows,
// warmer highlights), form-aware gradients (distance from the
// silhouette edge, not just radial fills), selective outlines (lit
// side has no rim, shadow side has a hard 1px outline), anti-jaggies
// (no 2-pixel diagonal stairs), and rim lighting / subsurface glow.
//
// THE QUALITY-LEAP RECIPE — apply in order to any silhouette:
//
//   1. silhouette = whatever shape you produced (pixelDisc, branch,
//      metaball, hand-drawn, etc.) painted in any solid color.
//
//   2. formShade(canvas, hueShiftRamp({ h, s, v }))
//        → flat fill becomes 3D-shaded form. Distance-from-edge
//        + light-direction bias colors each pixel via the palette.
//
//   3. selectiveOutline(canvas, { color: '#000', lightDx, lightDy })
//        → traces a 1-pixel dark outline ONLY on the shadow side,
//        leaving the lit side rim-less. Reads as more 3D than a
//        full surrounding outline.
//
//   4. subsurfaceRim(canvas, { color: '#fff8', lightDx, lightDy })
//        → 1-pixel bright rim INSIDE the silhouette on the light-
//        facing side. Reads as backlit translucency (leaves, fur,
//        skin, jelly).
//
//   5. antiJaggy(canvas)
//        → softens 2-pixel stair patterns on diagonals so curves
//        read as curves, not staircases.
//
//   6. cleanIsolatedPixels(canvas)  // §28
//        → drops any single pixels with no opaque neighbors. Strips
//        speckle noise from procgen output.
//
// Optional decoration:
//   • shadowDrop(canvas) — soft offset ellipse for grounding sprites.
//   • bevelEdge(canvas) — UI / mechanical 1-pixel bevel.
//   • dust(ctx, ...) — atmospheric particle scatter.

// ── Palette generation ────────────────────────────────────────────────

// hueShiftRamp — generate an N-stop palette with hue-shifting along
// the brightness ramp. The single biggest quality gap between flat
// procgen fills and real pixel art is hue-shifted ramps: shadows are
// cooler/bluer, highlights are warmer/yellower than the base color.
//
//   const greenPalette = hueShiftRamp({
//     h: 110, s: 0.6, v: 0.55,
//     n: 5, hueShift: 35, valSpread: 0.8, satCurve: 0.85,
//   });
//
// opts:
//   h, s, v       base color in HSV (h: 0..360, s/v: 0..1)
//   n             number of stops (default 5)
//   hueShift      total hue range across the ramp in degrees (default 30).
//                 Negative shifts = cool highlights for moody palettes.
//   valSpread     darkness range; 0.8 means deepest = 60% of base brightness
//   satCurve      0..1 — saturation dip at extremes for desaturated hi/lo
//
// ──────────────────────────────────────────────────────────────────────
// Section 29.5: Classifier-painter pipeline (first-principles redesign)
// ──────────────────────────────────────────────────────────────────────
// The old shading recipe (formShade → selectiveOutline → subsurfaceRim →
// ambientOcclusion → bouncedLight → specularHighlight → antiJaggy →
// cleanIsolatedPixels → enforceClusters) stacked 9 alpha-blend passes
// on RGBA, fighting each other and accumulating quantization error.
//
// First-principles approach:
//   Stage 1  classify   →  every solid pixel gets a ROLE + STOP INDEX
//   Stage 2  paint      →  walk the index buffer once, write final colors
//
// Edge roles are mutually exclusive — a single classifier replaces the
// outline + rim + AO + bounce primitives. Specular and speckle are
// deterministic post-classifiers that operate on the index buffer
// (never on RGBA) so they can't cause palette drift.
//
// Six pixel roles:
//   INTERIOR     — solid, no transparent 8-neighbor; gets lambert-mapped stop
//   LIT_RIM      — boundary pixel facing the light (positive dot product)
//   TERMINATOR   — boundary pixel near 90° to light (mid-stop terminator)
//   SHADOW_EDGE  — boundary pixel facing away from light (outline color)
//   CONTACT      — shadow-side boundary mostly bordered by transparent below
//                  (contact-shadow / ground-meeting edge)
//   CONCAVE      — boundary with ≤2 transparent neighbors (inner pocket)

export const PIXEL_ROLE = {
  TRANSPARENT: 0xFF,
  INTERIOR:    0,
  LIT_RIM:     1,
  TERMINATOR:  2,
  SHADOW_EDGE: 3,
  CONTACT:     4,
  CONCAVE:     5,
};

// Extract a silhouette mask from a canvas. Returns a Uint8Array of size
// W*H where 1 = solid (alpha > 0), 0 = transparent. Cheap O(W*H) read.
export function silhouetteFrom(canvas) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const data = ctx.getImageData(0, 0, W, H).data;
  const sil = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    sil[i] = data[i * 4 + 3] > 0 ? 1 : 0;
  }
  return sil;
}

// Classify every pixel in the silhouette. Returns:
//   { roles, indices, W, H, centroidX, centroidY, formRadius }
//
// `roles` is a Uint8Array of PIXEL_ROLE values, 0xFF for transparent.
// `indices` is a Uint8Array of palette stop indices (0..palette.length-1),
// 0xFF for transparent.
//
// opts:
//   palette       array of color strings, ≥4 stops recommended (5-6 ideal)
//   lightDx       light direction X (-1..1, default -0.7)
//   lightDy       light direction Y (-1..1, default -0.7)
//   litCutoff     dot threshold for LIT_RIM classification (default 0.25)
//   shadowCutoff  dot threshold for SHADOW_EDGE / CONTACT (default -0.15)
//   cluster       if true (default), run a 1-stop monotonic smoothing
//                 pass over interior pixels to produce clean cluster
//                 shapes (no isolated stop changes)
export function classifyPixels(silhouette, W, H, opts = {}) {
  const {
    palette,
    lightDx = -0.7, lightDy = -0.7,
    litCutoff = 0.25,
    shadowCutoff = -0.15,
    cluster = true,
  } = opts;
  if (!palette || palette.length < 4) {
    throw new Error('classifyPixels: palette of ≥4 stops required');
  }
  const N = palette.length;
  const TR = PIXEL_ROLE.TRANSPARENT;
  const roles = new Uint8Array(W * H).fill(TR);
  const indices = new Uint8Array(W * H).fill(TR);

  // Compute centroid + bounding radius of solid pixels.
  let sumX = 0, sumY = 0, count = 0;
  let minX = W, minY = H, maxX = 0, maxY = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (silhouette[y * W + x] === 0) continue;
      sumX += x; sumY += y; count++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (count === 0) {
    return { roles, indices, W, H, centroidX: 0, centroidY: 0, formRadius: 1 };
  }
  const cx = sumX / count, cy = sumY / count;
  const formRadius = Math.max(1, Math.max(maxX - cx, cx - minX,
                                          maxY - cy, cy - minY));

  const isSolid = (x, y) =>
    x >= 0 && x < W && y >= 0 && y < H && silhouette[y * W + x] === 1;

  // ── Pass 1: classify roles ────────────────────────────────────
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (silhouette[y * W + x] === 0) continue;
      // Position-from-centroid as a normal approximation. For typical
      // convex sprite blobs, the radial direction is a fine stand-in
      // for the surface normal, and it generalizes — no sphere math.
      const nx = (x - cx) / formRadius;
      const ny = (y - cy) / formRadius;
      // Lambert: dot(-light, normal). Higher = more lit.
      const dot = -(nx * lightDx + ny * lightDy);

      // Count transparent 8-neighbors (and their direction).
      let transparent = 0, transparentBelow = 0, transparentAbove = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          if (!isSolid(x + dx, y + dy)) {
            transparent++;
            if (dy > 0) transparentBelow++;
            else if (dy < 0) transparentAbove++;
          }
        }
      }

      let role;
      if (transparent === 0) {
        role = PIXEL_ROLE.INTERIOR;
      } else if (transparent <= 2) {
        // Tightly enclosed boundary = concave pocket.
        role = PIXEL_ROLE.CONCAVE;
      } else {
        // Convex boundary; classify by light direction.
        if (dot >= litCutoff) {
          role = PIXEL_ROLE.LIT_RIM;
        } else if (dot <= shadowCutoff) {
          // Distinguish contact-shadow (mostly bottom-bordered) from
          // generic shadow-edge.
          if (transparentBelow >= 2 && transparentBelow > transparentAbove) {
            role = PIXEL_ROLE.CONTACT;
          } else {
            role = PIXEL_ROLE.SHADOW_EDGE;
          }
        } else {
          role = PIXEL_ROLE.TERMINATOR;
        }
      }
      roles[y * W + x] = role;

      // ── Pass 1b: assign palette stop based on role + lambert ──
      // Universal lambert→stop, then offset per role. This guarantees
      // boundary pixels are always darker than adjacent interior of
      // the same lambert (no terminator inversion).
      const t = Math.max(0, Math.min(1, (dot + 1) * 0.5));
      const lambertStop = 1 + Math.round(t * (N - 3));   // 1..N-2
      let stop;
      switch (role) {
        case PIXEL_ROLE.INTERIOR:
          stop = lambertStop;
          break;
        case PIXEL_ROLE.LIT_RIM:
          // Match interior lambert — rim is the brightest cluster's
          // outline pixel, naturally bright but not specular. Specular
          // pass promotes a single pixel to N-1.
          stop = lambertStop;
          break;
        case PIXEL_ROLE.TERMINATOR:
          // 1 stop darker than interior would be — gives a visible
          // mid-band between lit and shadow without inversion.
          stop = Math.max(0, lambertStop - 1);
          break;
        case PIXEL_ROLE.SHADOW_EDGE:
          stop = 0;          // darkest = outline
          break;
        case PIXEL_ROLE.CONTACT:
          stop = 0;
          break;
        case PIXEL_ROLE.CONCAVE:
          stop = 0;
          break;
        default:
          stop = TR;
      }
      indices[y * W + x] = stop;
    }
  }

  // ── Pass 2: monotonic cluster smoothing (interior only) ──────
  // Interior pixels whose stop differs from majority of solid neighbors
  // by ≥2 are pulled 1 stop toward the majority. This is what creates
  // clean, connected cluster shapes instead of noisy lambert gradients.
  if (cluster) {
    const out = new Uint8Array(indices);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const idx = y * W + x;
        if (roles[idx] !== PIXEL_ROLE.INTERIOR) continue;
        const myStop = indices[idx];
        const counts = new Map();
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
            const ni = ny * W + nx;
            if (indices[ni] === TR) continue;
            counts.set(indices[ni], (counts.get(indices[ni]) || 0) + 1);
          }
        }
        let bestStop = myStop, bestCount = 0;
        for (const [s, c] of counts) {
          if (c > bestCount) { bestCount = c; bestStop = s; }
        }
        if (Math.abs(bestStop - myStop) >= 2) {
          out[idx] = myStop + Math.sign(bestStop - myStop);
        }
      }
    }
    indices.set(out);
  }

  return { roles, indices, W, H, centroidX: cx, centroidY: cy, formRadius };
}

// Walk an index buffer and paint final colors onto a canvas. This is
// the only place where palette colors are written — every other primitive
// in this section operates on indices, so we never lose precision to
// alpha blends. Transparent pixels are preserved.
export function paintFromIndices(canvas, indices, palette) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  // Pre-parse palette colors once.
  const parsed = palette.map(p => parseColor(p));
  const TR = PIXEL_ROLE.TRANSPARENT;
  for (let i = 0; i < W * H; i++) {
    const stop = indices[i];
    if (stop === TR) continue;
    const c = parsed[stop];
    if (!c) continue;
    const o = i * 4;
    d[o]     = c.r;
    d[o + 1] = c.g;
    d[o + 2] = c.b;
    d[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

// ──────────────────────────────────────────────────────────────────────
// Material textures — distinctive surface features per material class.
// ──────────────────────────────────────────────────────────────────────
// Without textures, every material in PIXEL_MATERIALS is "the same
// shading recipe with different palette" — they all look like clay
// orbs. Real materials have characteristic visual signatures:
//
//   wood     →  directional grain lines parallel to the longer axis
//   metal    →  anisotropic streaked specular (vertical or horizontal)
//   stone    →  angular crack lines + chipped silhouette
//   fur      →  outward-protruding pixels along the rim (fuzz)
//   bone     →  scattered single-pixel pores (darker stop)
//   leather  →  sparse pore pattern + slight wrinkle lines
//   lava     →  emissive — interior brighter than rim (inverse lambert)
//   ember    →  same emissive but smaller scale
//   water    →  horizontal ripple lines + scattered specular wave caps
//   ice      →  angular crack lines (like stone but bright/cool)
//   crystal  →  facet edges (1px bright lines through interior)
//   slime    →  bumpy bottom edge (drips) + interior bubbles
//   fabric   →  weave dots (regular grid pattern at low contrast)
//   chrome   →  horizontal mirror-bands (alternating 1px stripes)
//
// Each texture function operates after paintFromIndices, reading
// roles + indices to know where it can paint. They modify the canvas
// directly. Costs are O(W*H) per texture.

// Wood grain — 1-pixel dark streaks running parallel to the longer
// axis of the silhouette. The streak count + spacing scale with form
// size, so a 16×16 sprite gets fewer grain lines than a 32×32.
export function textureGrain(canvas, roles, palette, opts = {}) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const { spacing = 4, intensity = 0.7, rng: r = rng(7) } = opts;
  ctx.fillStyle = palette[0];     // darkest stop
  ctx.globalAlpha = intensity;
  // Determine major axis from silhouette bounds.
  let minX = W, maxX = 0, minY = H, maxY = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const role = roles[y * W + x];
      if (role === PIXEL_ROLE.TRANSPARENT) continue;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  const horizontal = (maxX - minX) >= (maxY - minY);
  const isInterior = (i) =>
    roles[i] === PIXEL_ROLE.INTERIOR || roles[i] === PIXEL_ROLE.LIT_RIM;
  if (horizontal) {
    // Grain runs left-right, lines stacked vertically
    for (let y = minY + 1; y < maxY; y += spacing) {
      const yJ = y + Math.floor((r() - 0.5) * 1.5);
      for (let x = minX; x <= maxX; x++) {
        const i = yJ * W + x;
        if (yJ < 0 || yJ >= H) continue;
        if (!isInterior(i)) continue;
        // Break every few pixels for natural grain feel
        if (r() < 0.15) continue;
        ctx.fillRect(x, yJ, 1, 1);
      }
    }
  } else {
    for (let x = minX + 1; x < maxX; x += spacing) {
      const xJ = x + Math.floor((r() - 0.5) * 1.5);
      for (let y = minY; y <= maxY; y++) {
        const i = y * W + xJ;
        if (xJ < 0 || xJ >= W) continue;
        if (!isInterior(i)) continue;
        if (r() < 0.15) continue;
        ctx.fillRect(xJ, y, 1, 1);
      }
    }
  }
  ctx.globalAlpha = 1;
}

// Anisotropic streak — 1-pixel-wide bright bands along one axis,
// suggesting brushed/polished metal. Bands placed at jittered
// intervals; each band is a single-stop value brighter.
export function textureStreak(canvas, roles, palette, opts = {}) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const { spacing = 5, axis = 'horizontal', rng: r = rng(11) } = opts;
  const N = palette.length;
  // Use second-brightest stop for streaks (brightest is reserved for
  // specularStamp). On lit-side pixels brighten; on shadow-side leave alone.
  const litColor = palette[N - 2];
  ctx.fillStyle = litColor;
  let minX = W, maxX = 0, minY = H, maxY = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (roles[y * W + x] === PIXEL_ROLE.TRANSPARENT) continue;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  const stride = spacing + Math.floor(r() * 2);
  if (axis === 'horizontal') {
    for (let y = minY + 1; y < maxY; y += stride) {
      const yJ = y + Math.floor((r() - 0.5) * 2);
      if (yJ < 0 || yJ >= H) continue;
      for (let x = minX; x <= maxX; x++) {
        const i = yJ * W + x;
        const role = roles[i];
        if (role !== PIXEL_ROLE.INTERIOR && role !== PIXEL_ROLE.LIT_RIM) continue;
        ctx.fillRect(x, yJ, 1, 1);
      }
    }
  } else {
    for (let x = minX + 1; x < maxX; x += stride) {
      const xJ = x + Math.floor((r() - 0.5) * 2);
      if (xJ < 0 || xJ >= W) continue;
      for (let y = minY; y <= maxY; y++) {
        const i = y * W + xJ;
        const role = roles[i];
        if (role !== PIXEL_ROLE.INTERIOR && role !== PIXEL_ROLE.LIT_RIM) continue;
        ctx.fillRect(xJ, y, 1, 1);
      }
    }
  }
}

// Cracks — 2-3 jagged dark lines crossing the form, suggesting stone
// fracture or ice cleavage planes.
export function textureCracks(canvas, roles, palette, opts = {}) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const { count = 2, intensity = 0.85, rng: r = rng(13) } = opts;
  ctx.fillStyle = palette[0];
  ctx.globalAlpha = intensity;
  // Find bounds
  let minX = W, maxX = 0, minY = H, maxY = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (roles[y * W + x] === PIXEL_ROLE.TRANSPARENT) continue;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  const isInterior = (x, y) => {
    if (x < 0 || x >= W || y < 0 || y >= H) return false;
    const role = roles[y * W + x];
    return role !== PIXEL_ROLE.TRANSPARENT;
  };
  for (let c = 0; c < count; c++) {
    let x = minX + Math.floor(r() * (maxX - minX + 1));
    let y = minY + Math.floor(r() * (maxY - minY + 1));
    let ang = r() * Math.PI * 2;
    const length = 6 + Math.floor(r() * 8);
    for (let s = 0; s < length; s++) {
      const xi = Math.round(x), yi = Math.round(y);
      if (!isInterior(xi, yi)) break;
      ctx.fillRect(xi, yi, 1, 1);
      // Jagged path: turn slightly each step
      ang += (r() - 0.5) * 0.9;
      x += Math.cos(ang);
      y += Math.sin(ang);
    }
  }
  ctx.globalAlpha = 1;
}

// Pores — scattered dark single-pixel holes. Random but deterministic
// per seed; uses INTERIOR role only (rim/edge pixels skipped).
export function texturePores(canvas, roles, palette, opts = {}) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const { density = 0.04, rng: r = rng(17), stop = 0 } = opts;
  ctx.fillStyle = palette[stop];
  const target = Math.floor(W * H * density);
  for (let i = 0; i < target; i++) {
    const x = Math.floor(r() * W);
    const y = Math.floor(r() * H);
    if (roles[y * W + x] !== PIXEL_ROLE.INTERIOR) continue;
    ctx.fillRect(x, y, 1, 1);
  }
}

// Emissive glow — INVERTS the lambert-mapped shading. Center of form
// becomes brightest, edges become dimmer. This is what makes lava
// look like it emits light instead of catching it. Uses palette
// brightest stop for the core, second-brightest for mid, etc.
export function textureGlow(canvas, roles, palette, opts = {}) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const { coreRadius = 0.5, intensity = 0.85 } = opts;
  // Find centroid + bounding radius
  let sumX = 0, sumY = 0, count = 0, maxR2 = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (roles[y * W + x] === PIXEL_ROLE.TRANSPARENT) continue;
      sumX += x; sumY += y; count++;
    }
  }
  if (count === 0) return;
  const cx = sumX / count, cy = sumY / count;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - cx, dy = y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 > maxR2) maxR2 = d2;
    }
  }
  const maxR = Math.sqrt(maxR2);
  const N = palette.length;
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const role = roles[i];
      if (role === PIXEL_ROLE.TRANSPARENT) continue;
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      const t = 1 - (dist / Math.max(1, maxR));   // 1 at center, 0 at edge
      // Map t to bright stops: 1 → palette[N-1], 0 → palette[1]
      const stop = Math.max(1, Math.min(N - 1,
        Math.round(1 + t * (N - 2))));
      const target = parseColor(palette[stop]);
      const o = i * 4;
      const blend = intensity;
      d[o]     = Math.round(d[o] * (1 - blend) + target.r * blend);
      d[o + 1] = Math.round(d[o + 1] * (1 - blend) + target.g * blend);
      d[o + 2] = Math.round(d[o + 2] * (1 - blend) + target.b * blend);
    }
  }
  ctx.putImageData(img, 0, 0);
}

// Water ripples — horizontal 1-pixel bright lines suggesting wave
// caps. Less regular than streak: short broken segments at varying y.
export function textureRipples(canvas, roles, palette, opts = {}) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const { count = 4, rng: r = rng(19) } = opts;
  const N = palette.length;
  ctx.fillStyle = palette[N - 1];     // brightest
  let minX = W, maxX = 0, minY = H, maxY = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (roles[y * W + x] === PIXEL_ROLE.TRANSPARENT) continue;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  for (let c = 0; c < count; c++) {
    const ry = minY + Math.floor(r() * (maxY - minY));
    const rx = minX + Math.floor(r() * (maxX - minX));
    const len = 2 + Math.floor(r() * 4);
    for (let s = 0; s < len; s++) {
      const xi = rx + s;
      if (xi >= W) break;
      const role = roles[ry * W + xi];
      if (role === PIXEL_ROLE.INTERIOR || role === PIXEL_ROLE.LIT_RIM) {
        ctx.fillRect(xi, ry, 1, 1);
      }
    }
  }
}

// Fur fuzz — single-pixel protrusions OUTSIDE the main silhouette,
// rooted on rim pixels and pointing outward. Also adds small radial
// 1px strands within the body suggesting fur clumps.
export function textureFuzz(canvas, roles, palette, opts = {}) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const { density = 0.5, rng: r = rng(23) } = opts;
  const N = palette.length;
  // Find centroid for outward-direction calc
  let sumX = 0, sumY = 0, count = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (roles[y * W + x] === PIXEL_ROLE.TRANSPARENT) continue;
      sumX += x; sumY += y; count++;
    }
  }
  if (count === 0) return;
  const cx = sumX / count, cy = sumY / count;
  // Walk every rim pixel; with probability `density`, stamp a fuzz
  // pixel one unit further outward in the direction from centroid.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const role = roles[i];
      const isRim = role === PIXEL_ROLE.LIT_RIM ||
                    role === PIXEL_ROLE.SHADOW_EDGE ||
                    role === PIXEL_ROLE.TERMINATOR;
      if (!isRim) continue;
      if (r() > density) continue;
      const dx = x - cx, dy = y - cy;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < 0.5) continue;
      const ox = Math.round(x + (dx / len));
      const oy = Math.round(y + (dy / len));
      if (ox < 0 || ox >= W || oy < 0 || oy >= H) continue;
      // Only paint if currently transparent (don't overwrite the body)
      if (roles[oy * W + ox] !== PIXEL_ROLE.TRANSPARENT) continue;
      // Pick a mid-stop color so fuzz reads as form, not outline
      const stop = role === PIXEL_ROLE.LIT_RIM ? N - 2 : 1;
      ctx.fillStyle = palette[stop];
      ctx.fillRect(ox, oy, 1, 1);
    }
  }
}

// Crystal facets — 1-pixel bright diagonal lines through the interior,
// suggesting reflective faces meeting at edges.
export function textureFacets(canvas, roles, palette, opts = {}) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const { count = 2, rng: r = rng(29) } = opts;
  const N = palette.length;
  ctx.fillStyle = palette[N - 1];
  let minX = W, maxX = 0, minY = H, maxY = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (roles[y * W + x] === PIXEL_ROLE.TRANSPARENT) continue;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  const isInterior = (x, y) => {
    if (x < 0 || x >= W || y < 0 || y >= H) return false;
    const role = roles[y * W + x];
    return role === PIXEL_ROLE.INTERIOR || role === PIXEL_ROLE.LIT_RIM;
  };
  for (let c = 0; c < count; c++) {
    const x0 = minX + Math.floor(r() * (maxX - minX + 1));
    const y0 = minY + Math.floor(r() * (maxY - minY + 1));
    const ang = r() * Math.PI * 2;
    const length = 4 + Math.floor(r() * 5);
    for (let s = 0; s < length; s++) {
      const xi = Math.round(x0 + Math.cos(ang) * s);
      const yi = Math.round(y0 + Math.sin(ang) * s);
      if (!isInterior(xi, yi)) break;
      ctx.fillRect(xi, yi, 1, 1);
    }
  }
}

// Fabric weave — regular dot pattern on every Nth pixel of every Nth
// row, painted at slightly darker stop. Reads as woven texture.
export function textureWeave(canvas, roles, palette, opts = {}) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const { spacing = 2, stop = 1 } = opts;
  ctx.fillStyle = palette[stop];
  for (let y = 0; y < H; y += spacing) {
    for (let x = (y % (spacing * 2)) === 0 ? 0 : Math.floor(spacing / 2);
         x < W; x += spacing) {
      const role = roles[y * W + x];
      if (role !== PIXEL_ROLE.INTERIOR) continue;
      ctx.fillRect(x, y, 1, 1);
    }
  }
}

// Texture dispatcher — looks up the texture function by name and
// applies it. Material specs use this with `texture: { kind: 'grain' }`.
const TEXTURE_FNS = {
  grain:   textureGrain,
  streak:  textureStreak,
  cracks:  textureCracks,
  pores:   texturePores,
  glow:    textureGlow,
  ripples: textureRipples,
  fuzz:    textureFuzz,
  facets:  textureFacets,
  weave:   textureWeave,
};
export function applyMaterialTexture(canvas, roles, palette, spec) {
  if (!spec) return;
  const kind = typeof spec === 'string' ? spec : spec.kind;
  const fn = TEXTURE_FNS[kind];
  if (!fn) return;
  const opts = typeof spec === 'object' ? spec : {};
  fn(canvas, roles, palette, opts);
}

// ──────────────────────────────────────────────────────────────────────
// Material lighting modes — reassign INTERIOR stop indices based on
// non-default lighting models. Operates on the index buffer; called
// AFTER classify() but BEFORE paintFromIndices() in the painter chain.
//
//   gradient   — default lambert (no change to indices)
//   banded     — quantize lambert to 3 hard bands (metal, ceramic)
//   emissive   — inverse falloff (center bright, edge dark — lava)
//   flat       — clamp every interior to the midtone (paper, fabric)
//   mirror     — horizontal stripe-banding ignoring lambert (chrome)
//   crisp      — like banded but with 4 bands and bright peak (gold)
// ──────────────────────────────────────────────────────────────────────
export function applyLightingMode(indices, roles, W, H, opts) {
  const {
    mode = 'gradient',
    palette,
    lightDx = -0.7, lightDy = -0.7,
    centroidX = W / 2, centroidY = H / 2,
    formRadius = Math.min(W, H) / 2,
    contrast = 1,
  } = opts;
  if (mode === 'gradient' && contrast === 1) return;
  if (!palette) return;
  const N = palette.length;

  // Bounding extent for mirror mode
  let minY = H, maxY = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (roles[y * W + x] !== PIXEL_ROLE.TRANSPARENT) {
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const formH = Math.max(1, maxY - minY);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (roles[i] !== PIXEL_ROLE.INTERIOR) continue;
      const nx = (x - centroidX) / formRadius;
      const ny = (y - centroidY) / formRadius;
      const lambert = -(nx * lightDx + ny * lightDy);
      const t = Math.max(0, Math.min(1, (lambert + 1) * 0.5));
      // Apply contrast — compress or expand the lambert range
      const tC = 0.5 + (t - 0.5) * contrast;
      let stop;
      switch (mode) {
        case 'banded':
          // 3 hard bands: shadow / mid / lit
          if (tC < 0.4) stop = 1;
          else if (tC < 0.7) stop = Math.floor(N / 2);
          else stop = N - 2;
          break;
        case 'crisp':
          // 4 bands with brighter peak (metal/gold)
          if (tC < 0.3) stop = 1;
          else if (tC < 0.55) stop = Math.floor(N / 2) - 1;
          else if (tC < 0.8) stop = N - 2;
          else stop = N - 1;
          break;
        case 'emissive': {
          const dist = Math.sqrt(nx * nx + ny * ny);
          const center = Math.max(0, 1 - dist);
          stop = Math.max(1, Math.round(1 + center * (N - 2)));
          break;
        }
        case 'flat':
          stop = Math.floor(N / 2);
          if (tC > 0.6) stop = Math.min(N - 2, stop + 1);
          break;
        case 'mirror': {
          const yT = (y - minY) / formH;
          // Horizontal stripes — bright "horizon" mid-form
          if (yT < 0.25) stop = N - 2;
          else if (yT < 0.4) stop = N - 1;
          else if (yT < 0.55) stop = Math.floor(N / 2) - 1;
          else if (yT < 0.75) stop = Math.floor(N / 2);
          else stop = 1;
          break;
        }
        case 'gradient':
        default:
          stop = 1 + Math.round(tC * (N - 3));
      }
      indices[i] = Math.max(0, Math.min(N - 1, stop));
    }
  }
}

// ──────────────────────────────────────────────────────────────────────
// Material edge styles — modify the silhouette boundary post-paint to
// give different physical surfaces different edge characters.
//
//   clean   — (default) sharp 1-pixel boundary, do nothing
//   rough   — chip random boundary pixels (stone, concrete)
//   fuzzy   — protrude pixels outward (fur, moss)
//   soft    — anti-aliased dither at the boundary (cloud, water)
//   jagged  — extend pointy spikes outward (crystal, ice)
// ──────────────────────────────────────────────────────────────────────
export function applyEdgeStyle(canvas, style, opts = {}) {
  if (!style || style === 'clean') return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  const { intensity = 0.4, color, rng: r = rng(43) } = opts;
  const isSolid = (x, y) => {
    if (x < 0 || x >= W || y < 0 || y >= H) return false;
    return d[(y * W + x) * 4 + 3] > 0;
  };

  if (style === 'rough') {
    // Chip random boundary pixels (alpha = 0)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!isSolid(x, y)) continue;
        let exposed = false;
        for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
          if (!isSolid(x + dx, y + dy)) { exposed = true; break; }
        }
        if (!exposed) continue;
        if (r() < intensity) d[(y * W + x) * 4 + 3] = 0;
      }
    }
  } else if (style === 'fuzzy') {
    // Protrude pixels outward in cardinal/diagonal directions
    const protrusions = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!isSolid(x, y)) continue;
        for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          if (isSolid(nx, ny)) continue;
          if (r() > intensity) continue;
          // Inherit the source pixel's color
          const sIdx = (y * W + x) * 4;
          protrusions.push([nx, ny, d[sIdx], d[sIdx + 1], d[sIdx + 2]]);
        }
      }
    }
    for (const [px, py, r2, g2, b2] of protrusions) {
      const idx = (py * W + px) * 4;
      d[idx] = r2; d[idx + 1] = g2; d[idx + 2] = b2; d[idx + 3] = 255;
    }
  } else if (style === 'soft') {
    // Halve alpha on boundary pixels — softer transition
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!isSolid(x, y)) continue;
        let exposed = false;
        for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
          if (!isSolid(x + dx, y + dy)) { exposed = true; break; }
        }
        if (!exposed) continue;
        const idx = (y * W + x) * 4;
        d[idx + 3] = Math.round(d[idx + 3] * 0.7);
      }
    }
  } else if (style === 'jagged') {
    // Add 1-2px spike protrusions at boundary
    const spikes = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!isSolid(x, y)) continue;
        let exposedDir = null;
        for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
          if (!isSolid(x + dx, y + dy)) { exposedDir = [dx, dy]; break; }
        }
        if (!exposedDir) continue;
        if (r() > intensity) continue;
        const sIdx = (y * W + x) * 4;
        const px = x + exposedDir[0], py = y + exposedDir[1];
        if (px < 0 || px >= W || py < 0 || py >= H) continue;
        spikes.push([px, py, d[sIdx], d[sIdx + 1], d[sIdx + 2]]);
        // Extend 1 more pixel half the time for longer spikes
        if (r() < 0.4) {
          const px2 = px + exposedDir[0], py2 = py + exposedDir[1];
          if (px2 >= 0 && px2 < W && py2 >= 0 && py2 < H) {
            spikes.push([px2, py2, d[sIdx], d[sIdx + 1], d[sIdx + 2]]);
          }
        }
      }
    }
    for (const [px, py, r2, g2, b2] of spikes) {
      const idx = (py * W + px) * 4;
      d[idx] = r2; d[idx + 1] = g2; d[idx + 2] = b2; d[idx + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);
}

// ──────────────────────────────────────────────────────────────────────
// Overlay dispatcher — applies one or more decoration primitives by
// name, used by materials' `overlays` field for auto-applied accents.
//
//   spec: string OR { kind, ...opts } OR array of either
// ──────────────────────────────────────────────────────────────────────
const OVERLAY_FNS = {
  sparkles, scratches, drips, stitches, rivets, haloRing,
  bubbles, lightning, stains, rays, runes, wearEdges,
  frost, moss, rust,
};
export function applyOverlays(canvas, specs, ctxRect) {
  if (!specs) return;
  const list = Array.isArray(specs) ? specs : [specs];
  const ctx = canvas.getContext('2d');
  for (const spec of list) {
    const kind = typeof spec === 'string' ? spec : spec.kind;
    const fn = OVERLAY_FNS[kind];
    if (!fn) continue;
    const opts = typeof spec === 'object' ? spec : {};
    // Decorations have varying signatures — dispatch by name
    if (kind === 'sparkles' || kind === 'scratches' || kind === 'bubbles' ||
        kind === 'stains' || kind === 'rays') {
      const x = opts.x != null ? opts.x : 0;
      const y = opts.y != null ? opts.y : 0;
      const w = opts.w != null ? opts.w : canvas.width;
      const h = opts.h != null ? opts.h : canvas.height;
      if (kind === 'rays') fn(ctx, x + w / 2, y + h / 2, opts);
      else fn(ctx, x, y, w, h, opts);
    } else if (kind === 'drips' || kind === 'wearEdges' ||
               kind === 'frost' || kind === 'moss' || kind === 'rust') {
      fn(canvas, opts);
    } else if (kind === 'lightning') {
      fn(ctx, opts.x0, opts.y0, opts.x1, opts.y1, opts);
    } else if (kind === 'haloRing') {
      fn(ctx, opts.cx, opts.cy, opts.radius, opts);
    } else if (kind === 'stitches') {
      fn(ctx, opts.x, opts.y, opts.length, opts);
    } else if (kind === 'rivets' || kind === 'runes') {
      fn(ctx, opts.positions || [], opts);
    }
  }
}

// Apply per-role opacity to an already-painted canvas. The map is
// keyed by role name (string) — e.g. { INTERIOR: 0.4, TERMINATOR: 0.7 }
// — and writes the corresponding alpha value into pixels of that role.
// Pixels whose role is not in the map keep their current alpha (which
// is normally 255 from paintFromIndices).
//
// This is what makes glass / water / ice / slime / crystal actually
// transparent: paintFromIndices commits opaque palette colors, then
// this pass selectively reduces alpha for roles that should be
// see-through. Edges (LIT_RIM, SHADOW_EDGE) typically stay fully
// opaque — they're where the visible "substance" of the material lives.
export function applyRoleOpacity(canvas, roles, opacityMap) {
  if (!opacityMap) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  // Build a Uint8Array lookup table indexed by role enum value, with
  // a sentinel of 255 for roles not in the map (no change).
  const lut = new Uint8Array(7).fill(255);
  for (const key of Object.keys(opacityMap)) {
    const role = PIXEL_ROLE[key];
    if (role == null || role === PIXEL_ROLE.TRANSPARENT) continue;
    lut[role] = Math.round(Math.max(0, Math.min(1, opacityMap[key])) * 255);
  }
  for (let i = 0; i < W * H; i++) {
    const r = roles[i];
    if (r === PIXEL_ROLE.TRANSPARENT) continue;
    const a = lut[r];
    if (a === 255) continue;
    // Premultiply if alpha < 255 — canvas uses non-premult by default,
    // but reducing alpha alone changes how subsequent blits composite
    // (which is exactly what we want for overlays of this glass on
    // contents drawn before).
    d[i * 4 + 3] = a;
  }
  ctx.putImageData(img, 0, 0);
}

// Debug visualizer — paint role values as fixed colors so you can see
// the classification map directly. Useful for tuning lightDx/Dy or
// debugging why a sprite doesn't shade as expected.
export function paintRoleMap(canvas, roles, opts = {}) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const colors = opts.colors || {
    [PIXEL_ROLE.INTERIOR]:    '#3a4860',
    [PIXEL_ROLE.LIT_RIM]:     '#ffe080',
    [PIXEL_ROLE.TERMINATOR]:  '#a06848',
    [PIXEL_ROLE.SHADOW_EDGE]: '#181020',
    [PIXEL_ROLE.CONTACT]:     '#400828',
    [PIXEL_ROLE.CONCAVE]:     '#005838',
  };
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  for (let i = 0; i < W * H; i++) {
    const role = roles[i];
    if (role === PIXEL_ROLE.TRANSPARENT) continue;
    const c = parseColor(colors[role] || '#888');
    const o = i * 4;
    d[o] = c.r; d[o+1] = c.g; d[o+2] = c.b; d[o+3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

// Promote 1-3 lit-rim pixels to the brightest palette stop, picked
// deterministically by maximum dot product against the light. Operates
// on the index buffer — no alpha blending. Stamps grow outward from
// the chosen peak by promoting same-role 4-neighbors.
//
//   indices, roles, W, H — from classifyPixels
//   palette              — same palette, used to compute brightest stop
//   lightDx, lightDy     — must match classifyPixels for correct peak
//   size                 — 1 = single, 2 = peak + 1 neighbor, 3 = peak + 2
export function specularStamp(indices, roles, W, H, opts = {}) {
  const {
    palette,
    lightDx = -0.7, lightDy = -0.7,
    centroidX = W / 2, centroidY = H / 2,
    size = 2,
  } = opts;
  if (!palette) throw new Error('specularStamp: palette required');
  const N = palette.length;
  // Find the LIT_RIM pixel with the maximum dot vs -light.
  let bestI = -1, bestDot = -Infinity;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (roles[i] !== PIXEL_ROLE.LIT_RIM) continue;
      const dot = -((x - centroidX) * lightDx + (y - centroidY) * lightDy);
      if (dot > bestDot) { bestDot = dot; bestI = i; }
    }
  }
  if (bestI < 0) return;
  indices[bestI] = N - 1;
  if (size < 2) return;
  // Promote 4-neighbors that are also LIT_RIM, up to size-1 of them.
  const x0 = bestI % W, y0 = (bestI / W) | 0;
  const candidates = [];
  for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
    const nx = x0 + dx, ny = y0 + dy;
    if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
    const ni = ny * W + nx;
    if (roles[ni] === PIXEL_ROLE.LIT_RIM ||
        roles[ni] === PIXEL_ROLE.INTERIOR) {
      const dot = -((nx - centroidX) * lightDx + (ny - centroidY) * lightDy);
      candidates.push({ i: ni, dot });
    }
  }
  candidates.sort((a, b) => b.dot - a.dot);
  const promote = Math.min(size - 1, candidates.length);
  for (let i = 0; i < promote; i++) indices[candidates[i].i] = N - 1;
}

// Deterministic speckle accent — promote every Nth pixel of a target
// role to a brighter or darker stop. Unlike random scatter, this
// produces stable, even distribution and is reproducible across runs.
//
// opts:
//   role     PIXEL_ROLE to target (default INTERIOR)
//   every    pixel stride between accents (default 7)
//   delta    +1 brightens, -1 darkens (default +1)
//   offset   linear offset for stride start (lets you do dual passes
//            with different offsets without overlap)
export function speckleAccent(indices, roles, W, H, opts = {}) {
  const {
    role = PIXEL_ROLE.INTERIOR,
    every = 7,
    delta = 1,
    offset = 0,
    paletteLength = 6,
  } = opts;
  let counter = offset;
  const maxStop = paletteLength - 1;
  for (let i = 0; i < W * H; i++) {
    if (roles[i] !== role) continue;
    if (counter % every === 0) {
      const cur = indices[i];
      const target = Math.max(0, Math.min(maxStop, cur + delta));
      indices[i] = target;
    }
    counter++;
  }
}

// Cluster enforcement on the index buffer. Pixels whose stop appears
// in fewer than `minCluster` 8-neighbors are snapped to the dominant
// neighbor stop. Operates on indices (cleaner than the RGBA version
// in `enforceClusters`). Use as the final pass.
export function enforceClusterIndices(indices, roles, W, H, opts = {}) {
  const { minCluster = 2 } = opts;
  const TR = PIXEL_ROLE.TRANSPARENT;
  const out = new Uint8Array(indices);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      if (indices[idx] === TR) continue;
      const myStop = indices[idx];
      let same = 0;
      const counts = new Map();
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          const ni = ny * W + nx;
          if (indices[ni] === TR) continue;
          if (indices[ni] === myStop) same++;
          counts.set(indices[ni], (counts.get(indices[ni]) || 0) + 1);
        }
      }
      if (same >= minCluster) continue;
      let bestStop = myStop, bestCount = 0;
      for (const [s, c] of counts) {
        if (c > bestCount) { bestCount = c; bestStop = s; }
      }
      if (bestCount >= 2) out[idx] = bestStop;
    }
  }
  indices.set(out);
}

// ──────────────────────────────────────────────────────────────────────
// Section 29.7: PixelPainter — coherent painting engine
// ──────────────────────────────────────────────────────────────────────
// Stateful fluent orchestrator that owns the full pipeline from silhouette
// to finished pixel-art sprite. Designed around three core insights:
//
//   1. There's a hard architectural boundary between STRUCTURE (which
//      pixel gets which palette index) and MATERIAL (off-palette
//      half-tones from rim/bounce). Structure is computed on indices;
//      material is alpha-blended on RGBA AFTER commit. They never
//      fight because they operate on different representations.
//
//   2. The classifier's ROLE MAP is the universal coordinate system.
//      Every operation can target a role ("brighten LIT_RIM",
//      "darken CONCAVE", "speckle INTERIOR"). Roles replace ad-hoc
//      direction-vector heuristics.
//
//   3. Materials are bundles, not parameters. A "metal" sprite differs
//      from "organic" not by one knob but by a coherent palette + rim
//      + bounce + speckle config. The painter ships preset materials
//      so calling `.material('metal').preset('classic')` is enough.
//
// Lifecycle:
//
//   const p = createPainter({ palette, lightDx, lightDy });
//   p.shape(canvas, ctx => pixelDisc(ctx, 12, 12, 11, palette[2]));
//   p.classify();           ← reads silhouette, fills roles + indices
//   p.specular();           ← role-aware, operates on indices
//   p.speckle();            ← deterministic, operates on indices
//   p.cluster();            ← cleanup orphan stops
//   p.commit();             ← writes final palette colors to canvas
//   p.rim();                ← painterly half-tone overlay (alpha)
//   p.bounce();             ← warm shadow underside
//   p.polish();             ← antiJaggy + isolated cleanup
//
// Or just `p.preset('painterly')` for the default chain.
//
// Calling any post-commit stage before commit() auto-commits.
// Calling any pre-commit stage after commit() throws — the index
// buffer is no longer canonical once colors are on the canvas.

// Built-in material presets — palette generators + accent defaults.
// Add entries here for new material classes; users can also pass a
// custom material object to createPainter({ material: {...} }).
// Material schema (rich):
//   palette       hueShiftRamp config
//   lightingMode  'gradient' (default) | 'banded' | 'crisp' | 'emissive'
//                 | 'flat' | 'mirror'
//   contrast      0..1+ — value range (0.3 = flat, 1.0 = full, 1.3 = punchy)
//   edgeStyle     'clean' (default) | 'rough' | 'fuzzy' | 'soft' | 'jagged'
//   edgeStyleOpts overrides for the edge processor
//   rim           { color } — lit-edge subsurface bleed (alpha applied as preset rim)
//   bounce        { color, strength, reach } — shadow underside fill
//   speckle       { every, delta } — pre-commit deterministic accent
//   specularSize  0..3 — number of brightest-stop pixels at lit peak
//   texture       { kind, ...opts } — surface character (grain/streak/cracks/...)
//   overlays      array of decoration specs — auto-applied accents
//   opacity       per-role alpha map
//
// Each material is a coherent physical model — palette + lighting + edge
// + texture + overlays all reinforcing one substance. They should look
// dramatically different from each other, not just hue-shifted.
export const PIXEL_MATERIALS = {

  // ═══ STONE / GEOLOGICAL ═══════════════════════════════════════════
  // Stone — chunky weathered rock. Banded lighting (hard transitions
  // suggest faceted geological surfaces), rough edges (chips/erosion),
  // matte (no specular), heavy crack texture, sparse moss/wear overlay.
  stone: {
    palette: { h: 35, s: 0.18, v: 0.5, n: 6, hueShift: 12 },
    lightingMode: 'banded',
    contrast: 0.7,
    edgeStyle: 'rough',
    edgeStyleOpts: { intensity: 0.25 },
    rim: { color: 'rgba(255, 240, 220, 0.2)' },
    bounce: { color: '#3a2818', strength: 0.18, reach: 0.5 },
    speckle: { every: 7, delta: -1 },
    specularSize: 0,
    texture: { kind: 'cracks', count: 3, intensity: 0.7 },
  },

  // Wood — directional plank. Gradient lighting with slight contrast,
  // clean edges (cut planks have sharp lines), heavy grain texture.
  wood: {
    palette: { h: 28, s: 0.55, v: 0.42, n: 6, hueShift: 22 },
    lightingMode: 'gradient',
    contrast: 0.65,
    edgeStyle: 'clean',
    rim: { color: 'rgba(255, 200, 140, 0.25)' },
    bounce: { color: '#3a1a08', strength: 0.22, reach: 0.45 },
    speckle: { every: 13, delta: -1 },
    specularSize: 1,
    texture: { kind: 'grain', spacing: 2, intensity: 0.85 },
  },

  // ═══ METALS ════════════════════════════════════════════════════════
  // Metal — polished steel. Crisp 4-band lighting (hard specular falloff),
  // clean edges, horizontal polish streaks, scratches as overlay.
  metal: {
    palette: { h: 215, s: 0.18, v: 0.6, n: 6, hueShift: -25 },
    lightingMode: 'crisp',
    contrast: 1.1,
    edgeStyle: 'clean',
    rim: { color: 'rgba(220, 240, 255, 0.7)' },
    bounce: { color: '#202838', strength: 0.15, reach: 0.35 },
    speckle: { every: 0, delta: 0 },
    specularSize: 3,
    texture: { kind: 'streak', spacing: 5, axis: 'horizontal' },
  },

  // Gold — pristine warm mirror. Crisp lighting with brightest peak
  // (4 bands ending in pure brightest stop), strong specular, dense
  // polish streaks. NO scratches — gold is shown pristine.
  gold: {
    palette: { h: 45, s: 0.78, v: 0.72, n: 6, hueShift: 35 },
    lightingMode: 'crisp',
    contrast: 1.2,
    edgeStyle: 'clean',
    rim: { color: 'rgba(255, 245, 180, 0.85)' },
    bounce: { color: '#604010', strength: 0.18, reach: 0.4 },
    speckle: { every: 0, delta: 0 },
    specularSize: 3,
    texture: { kind: 'streak', spacing: 3, axis: 'horizontal' },
  },

  // Bronze — patinated antique metal. Gradient lighting (softer than
  // pristine metal), gentle streak. Includes verdigris stain overlay.
  bronze: {
    palette: { h: 30, s: 0.5, v: 0.5, n: 6, hueShift: 28 },
    lightingMode: 'gradient',
    contrast: 0.8,
    edgeStyle: 'clean',
    rim: { color: 'rgba(255, 220, 180, 0.5)' },
    bounce: { color: '#402010', strength: 0.18, reach: 0.4 },
    speckle: { every: 13, delta: 1 },
    specularSize: 2,
    texture: { kind: 'streak', spacing: 6, axis: 'horizontal' },
    overlays: [
      { kind: 'stains', x: 4, y: 4, w: 28, h: 24,
        count: 3, color: '#406030', intensity: 0.4, size: 3 },
    ],
  },

  // Copper — warm metal with vertical brushed grain.
  copper: {
    palette: { h: 18, s: 0.68, v: 0.55, n: 6, hueShift: 30 },
    lightingMode: 'crisp',
    contrast: 1.0,
    edgeStyle: 'clean',
    rim: { color: 'rgba(255, 200, 150, 0.7)' },
    bounce: { color: '#502010', strength: 0.2, reach: 0.4 },
    speckle: { every: 0, delta: 0 },
    specularSize: 2,
    texture: { kind: 'streak', spacing: 3, axis: 'vertical' },
  },

  // Chrome — perfect mirror finish. Mirror lighting mode (horizontal
  // bands ignoring lambert) gives the cubemap-like reflection look.
  chrome: {
    palette: { h: 200, s: 0.15, v: 0.85, n: 6, hueShift: -30 },
    lightingMode: 'mirror',
    contrast: 1.3,
    edgeStyle: 'clean',
    rim: { color: 'rgba(240, 250, 255, 0.95)' },
    bounce: { color: '#304050', strength: 0.18, reach: 0.4 },
    speckle: { every: 0, delta: 0 },
    specularSize: 3,
  },

  // ═══ TRANSPARENT / GLASS ═══════════════════════════════════════════
  // Glass — clean transparent. Gradient lighting, very bright rim,
  // sharp specular, smooth (no texture), high transparency on interior.
  glass: {
    palette: { h: 195, s: 0.12, v: 0.85, n: 6, hueShift: -8 },
    lightingMode: 'gradient',
    contrast: 0.75,
    edgeStyle: 'clean',
    rim: { color: 'rgba(255, 255, 255, 0.95)' },
    bounce: { color: '#000', strength: 0 },
    speckle: { every: 0, delta: 0 },
    specularSize: 3,
    opacity: {
      INTERIOR: 0.4, TERMINATOR: 0.6, LIT_RIM: 1.0,
      SHADOW_EDGE: 0.85, CONTACT: 0.85, CONCAVE: 0.9,
    },
  },

  // Crystal — faceted colored gem. Flat lighting + jagged edges
  // (sharp angular spikes), dense facet lines, sparkle overlays
  // accentuate gem-like reflectivity.
  crystal: {
    palette: { h: 160, s: 0.75, v: 0.7, n: 6, hueShift: 55 },
    lightingMode: 'flat',
    contrast: 0.9,
    edgeStyle: 'jagged',
    edgeStyleOpts: { intensity: 0.3 },
    rim: { color: 'rgba(255, 255, 255, 0.85)' },
    bounce: { color: '#000', strength: 0 },
    speckle: { every: 0, delta: 0 },
    specularSize: 3,
    opacity: { INTERIOR: 0.7, TERMINATOR: 0.85 },
    texture: { kind: 'facets', count: 4 },
    overlays: [
      { kind: 'sparkles', count: 3, kind2: 'star', size: 1,
        coreColor: '#ffffff', midColor: '#a0ffff' },
    ],
  },

  // Ice — translucent crystalline. Gradient lighting with cool palette,
  // soft edges (water-touched ice melts at boundary), bright specular,
  // frost crystal overlay around rim.
  ice: {
    palette: { h: 200, s: 0.3, v: 0.88, n: 6, hueShift: -25 },
    lightingMode: 'gradient',
    contrast: 0.7,
    edgeStyle: 'soft',
    rim: { color: 'rgba(220, 240, 255, 0.95)' },
    bounce: { color: '#2050a0', strength: 0.2, reach: 0.4 },
    speckle: { every: 0, delta: 0 },
    specularSize: 3,
    opacity: { INTERIOR: 0.78, TERMINATOR: 0.9 },
    texture: { kind: 'cracks', count: 2, intensity: 0.4 },
  },

  // ═══ FLUIDS / ENERGY ═══════════════════════════════════════════════
  // Water — translucent blue with wave-cap ripples. Soft edges
  // (water boundary is fuzzy), strong horizontal specular, ripples
  // give surface life.
  water: {
    palette: { h: 200, s: 0.6, v: 0.65, n: 6, hueShift: 35 },
    lightingMode: 'gradient',
    contrast: 0.65,
    edgeStyle: 'soft',
    rim: { color: 'rgba(255, 255, 255, 0.7)' },
    bounce: { color: '#082030', strength: 0.15, reach: 0.3 },
    speckle: { every: 0, delta: 0 },
    specularSize: 3,
    opacity: { INTERIOR: 0.55, TERMINATOR: 0.75 },
    texture: { kind: 'ripples', count: 5 },
  },

  // Lava — fully emissive. Inverse lambert (interior brighter than
  // rim), no bounce (it emits light, doesn't catch it), soft edges.
  lava: {
    palette: { h: 18, s: 0.95, v: 0.85, n: 6, hueShift: 45 },
    lightingMode: 'emissive',
    contrast: 1.2,
    edgeStyle: 'soft',
    rim: { color: 'rgba(255, 230, 100, 0.85)' },
    bounce: { color: '#000', strength: 0 },
    speckle: { every: 4, delta: 1 },
    specularSize: 0,
    texture: { kind: 'glow', intensity: 0.7 },
  },

  // Ember — small emissive ember. Like lava but lower intensity,
  // fewer bright spots. Use for fire particles, hot magic, sparks.
  ember: {
    palette: { h: 25, s: 0.9, v: 0.75, n: 6, hueShift: 38 },
    lightingMode: 'emissive',
    contrast: 1.0,
    edgeStyle: 'soft',
    rim: { color: 'rgba(255, 200, 80, 0.7)' },
    bounce: { color: '#000', strength: 0 },
    speckle: { every: 5, delta: 1 },
    specularSize: 0,
    texture: { kind: 'glow', intensity: 0.6 },
  },

  // Slime — translucent goo. Gradient lighting, soft drippy edges,
  // multiple bright specular catchlights (suggesting bubbles inside),
  // semi-transparent.
  slime: {
    palette: { h: 95, s: 0.7, v: 0.55, n: 6, hueShift: 40 },
    lightingMode: 'gradient',
    contrast: 0.7,
    edgeStyle: 'soft',
    rim: { color: 'rgba(180, 255, 160, 0.75)' },
    bounce: { color: '#103010', strength: 0.2, reach: 0.4 },
    speckle: { every: 11, delta: 1 },
    specularSize: 3,
    opacity: { INTERIOR: 0.7, TERMINATOR: 0.85 },
  },

  // ═══ BIOLOGICAL ═══════════════════════════════════════════════════
  // Skin — pale Caucasian baseline. Flat-ish lighting (skin doesn't
  // have hard transitions), soft edges, warm subsurface bounce
  // (the iconic skin signature), tiny specular for moisture.
  skin: {
    palette: { h: 22, s: 0.32, v: 0.9, n: 6, hueShift: 22 },
    lightingMode: 'gradient',
    contrast: 0.45,
    edgeStyle: 'soft',
    rim: { color: 'rgba(255, 220, 200, 0.55)' },
    bounce: { color: '#c04040', strength: 0.22, reach: 0.55 },
    speckle: { every: 23, delta: -1 },
    specularSize: 1,
  },

  // Bone — porous off-white. Gradient lighting with low contrast,
  // dense pore overlay + occasional crack lines.
  bone: {
    palette: { h: 42, s: 0.18, v: 0.86, n: 6, hueShift: 18 },
    lightingMode: 'gradient',
    contrast: 0.5,
    edgeStyle: 'clean',
    rim: { color: 'rgba(255, 240, 220, 0.4)' },
    bounce: { color: '#806040', strength: 0.18, reach: 0.5 },
    speckle: { every: 15, delta: -1 },
    specularSize: 1,
    texture: { kind: 'pores', density: 0.06 },
  },

  // Fur — fuzzy mass. Flat lighting (light scatters everywhere in fur),
  // FUZZY edges (the defining trait), heavy fuzz overlay, dense bright
  // tip speckle, very warm rim from subsurface scattering.
  fur: {
    palette: { h: 30, s: 0.5, v: 0.48, n: 6, hueShift: 28 },
    lightingMode: 'flat',
    contrast: 0.45,
    edgeStyle: 'fuzzy',
    edgeStyleOpts: { intensity: 0.65 },
    rim: { color: 'rgba(255, 220, 180, 0.7)' },
    bounce: { color: '#502010', strength: 0.28, reach: 0.6 },
    speckle: { every: 4, delta: 1 },
    specularSize: 0,
    texture: { kind: 'fuzz', density: 0.7 },
  },

  // Coral — vivid pink branching organic. Jagged edges (organic spikes),
  // sparkle overlay (catches sea light), saturated palette.
  coral: {
    palette: { h: 350, s: 0.78, v: 0.62, n: 6, hueShift: 32 },
    lightingMode: 'gradient',
    contrast: 0.7,
    edgeStyle: 'jagged',
    edgeStyleOpts: { intensity: 0.25 },
    rim: { color: 'rgba(255, 200, 200, 0.7)' },
    bounce: { color: '#80305a', strength: 0.22, reach: 0.45 },
    speckle: { every: 11, delta: 1 },
    specularSize: 2,
    overlays: [
      { kind: 'sparkles', count: 4, kind2: 'plus', size: 1,
        coreColor: '#ffffff', midColor: '#ffc0d0' },
    ],
  },

  // Moss — clumpy organic green. Flat lighting (moss is matte), fuzzy
  // edges (clumps protrude outward), heavy texture suggesting clumps.
  moss: {
    palette: { h: 75, s: 0.55, v: 0.42, n: 6, hueShift: 30 },
    lightingMode: 'flat',
    contrast: 0.5,
    edgeStyle: 'fuzzy',
    edgeStyleOpts: { intensity: 0.5 },
    rim: { color: 'rgba(200, 230, 150, 0.4)' },
    bounce: { color: '#302010', strength: 0.2, reach: 0.5 },
    speckle: { every: 4, delta: 1 },
    specularSize: 0,
  },

  // Foliage — leafy mass. Gradient lighting, rough edges (irregular
  // leaf cluster outline), dense fine speckle for leaf detail.
  foliage: {
    palette: { h: 110, s: 0.7, v: 0.45, n: 6, hueShift: 32 },
    lightingMode: 'gradient',
    contrast: 0.65,
    edgeStyle: 'rough',
    edgeStyleOpts: { intensity: 0.18 },
    rim: { color: 'rgba(255, 250, 200, 0.45)' },
    bounce: { color: '#503020', strength: 0.2, reach: 0.4 },
    speckle: { every: 5, delta: 1 },
    specularSize: 1,
  },

  // ═══ MANUFACTURED ═════════════════════════════════════════════════
  // Fabric — soft cloth. Flat lighting (very soft shadow falloff),
  // soft edges, weave texture, no specular (fabric is matte).
  fabric: {
    palette: { h: 15, s: 0.42, v: 0.68, n: 6, hueShift: 22 },
    lightingMode: 'flat',
    contrast: 0.4,
    edgeStyle: 'soft',
    rim: { color: 'rgba(255, 240, 220, 0.35)' },
    bounce: { color: '#503010', strength: 0.22, reach: 0.5 },
    speckle: { every: 17, delta: -1 },
    specularSize: 0,
    texture: { kind: 'weave', spacing: 2 },
  },

  // Leather — tooled hide. Gradient lighting, clean edges, warm rim,
  // heavy pore texture, optional stitch overlay.
  leather: {
    palette: { h: 22, s: 0.6, v: 0.4, n: 6, hueShift: 18 },
    lightingMode: 'gradient',
    contrast: 0.6,
    edgeStyle: 'clean',
    rim: { color: 'rgba(255, 200, 160, 0.5)' },
    bounce: { color: '#301808', strength: 0.2, reach: 0.45 },
    speckle: { every: 13, delta: -1 },
    specularSize: 1,
    texture: { kind: 'pores', density: 0.05 },
  },

  // Rubber — matte black tire. Very flat lighting, soft edges (rounded
  // rubber boundaries), no specular, no texture (smooth surface).
  rubber: {
    palette: { h: 220, s: 0.12, v: 0.22, n: 6, hueShift: -10 },
    lightingMode: 'flat',
    contrast: 0.35,
    edgeStyle: 'soft',
    rim: { color: 'rgba(180, 180, 200, 0.25)' },
    bounce: { color: '#101018', strength: 0.15, reach: 0.4 },
    speckle: { every: 0, delta: 0 },
    specularSize: 0,
  },

  // Paper — pure matte white. Almost flat lighting (paper has minimal
  // value variation), clean edges. No specular, no texture, no rim.
  paper: {
    palette: { h: 45, s: 0.06, v: 0.95, n: 6, hueShift: 8 },
    lightingMode: 'flat',
    contrast: 0.25,
    edgeStyle: 'clean',
    rim: { color: 'rgba(255, 250, 240, 0.2)' },
    bounce: { color: '#806040', strength: 0.08, reach: 0.3 },
    speckle: { every: 0, delta: 0 },
    specularSize: 0,
  },

  // Ceramic — glossy white porcelain. Crisp banded lighting (porcelain
  // has hard shadow transitions), clean edges, very large bright
  // specular pinpoint (the glaze catch).
  ceramic: {
    palette: { h: 200, s: 0.06, v: 0.92, n: 6, hueShift: -5 },
    lightingMode: 'crisp',
    contrast: 1.0,
    edgeStyle: 'clean',
    rim: { color: 'rgba(255, 255, 255, 0.85)' },
    bounce: { color: '#403038', strength: 0.18, reach: 0.4 },
    speckle: { every: 0, delta: 0 },
    specularSize: 3,
  },

  // ═══ LEGACY ALIASES ═══════════════════════════════════════════════
  // Keep `organic` and `gem` as semantic aliases — they map to the
  // most-used physical models for backwards compat with earlier code.
  organic: {
    palette: { h: 110, s: 0.6, v: 0.5, n: 6, hueShift: 35 },
    lightingMode: 'gradient',
    contrast: 0.6,
    edgeStyle: 'soft',
    rim: { color: 'rgba(255, 250, 220, 0.5)' },
    bounce: { color: '#a8704c', strength: 0.22, reach: 0.45 },
    speckle: { every: 11, delta: 1 },
    specularSize: 1,
  },
  gem: {
    palette: { h: 285, s: 0.75, v: 0.55, n: 6, hueShift: 55 },
    lightingMode: 'flat',
    contrast: 0.85,
    edgeStyle: 'jagged',
    edgeStyleOpts: { intensity: 0.25 },
    rim: { color: 'rgba(255, 255, 255, 0.85)' },
    bounce: { color: '#000', strength: 0 },
    speckle: { every: 0, delta: 0 },
    specularSize: 3,
    opacity: { INTERIOR: 0.7, TERMINATOR: 0.85 },
  },
};

// Built-in pipeline presets. Each preset is a sequence of method names
// to call on the painter. Custom presets can be registered or passed
// directly as an array of stage names.
export const PIXEL_PRESETS = {
  // Pure on-palette — no off-palette accents. Cleanest for tilemap atlases.
  flat: ['classify', 'specular', 'cluster', 'commit'],
  // Default — clean structure + painterly half-tones.
  classic: [
    'classify', 'specular', 'cluster', 'commit',
    'rim', 'bounce', 'polish',
  ],
  // Heavy painterly — denser speckle, stronger material accents.
  painterly: [
    'classify', 'specular', 'speckle', 'cluster', 'commit',
    'rim', 'bounce', 'polish',
  ],
  // Debug — run classify then immediately paint the role map.
  debug: ['classify', 'debugRoles'],
};

// Factory. Returns a fluent painter object.
//
//   opts.palette    — array of color strings; OR opts.material name
//                     looks up a palette spec from PIXEL_MATERIALS
//   opts.material   — string key into PIXEL_MATERIALS (auto-builds palette)
//   opts.lightDx, lightDy   — light direction (default -0.7, -0.7)
//   opts.material   — override material name; used by all default ops
export function createPainter(opts = {}) {
  let materialName = opts.material || 'organic';
  let material = PIXEL_MATERIALS[materialName];
  if (!material) throw new Error(`unknown material: ${materialName}`);
  // Build palette unless explicit.
  let palette = opts.palette || hueShiftRamp(material.palette);
  if (palette.length < 4) {
    throw new Error('createPainter: palette of ≥4 stops required');
  }
  const state = {
    palette,
    materialName,
    material,
    lightDx: opts.lightDx != null ? opts.lightDx : -0.7,
    lightDy: opts.lightDy != null ? opts.lightDy : -0.7,
    canvas: null, W: 0, H: 0,
    silhouette: null,
    roles: null,
    indices: null,
    centroidX: 0, centroidY: 0, formRadius: 1,
    classified: false,
    committed: false,
  };

  function ensureClassified() {
    if (!state.classified) api.classify();
  }
  function ensureCommitted() {
    if (!state.committed) api.commit();
  }
  function checkPreCommit(name) {
    if (state.committed) {
      throw new Error(`painter.${name}(): index buffer locked after commit()`);
    }
    ensureClassified();
  }

  const api = {
    // ─── Source: define the silhouette ────────────────────────────
    // Either point at an existing canvas (silhouette is whatever has
    // alpha > 0) or `shape(canvas, drawFn)` to clear + draw fresh.
    silhouette(canvas) {
      state.canvas = canvas;
      state.W = canvas.width;
      state.H = canvas.height;
      state.silhouette = silhouetteFrom(canvas);
      state.classified = false;
      state.committed = false;
      return api;
    },
    shape(canvas, drawFn) {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      drawFn(ctx, state.palette[Math.floor(palette.length / 2)]);
      return api.silhouette(canvas);
    },

    // ─── Stage 1: classify pixels into roles + indices ───────────
    classify(opts2 = {}) {
      if (!state.silhouette) throw new Error('classify(): set silhouette first');
      const result = classifyPixels(state.silhouette, state.W, state.H, {
        palette: state.palette,
        lightDx: state.lightDx, lightDy: state.lightDy,
        ...opts2,
      });
      state.roles = result.roles;
      state.indices = result.indices;
      state.centroidX = result.centroidX;
      state.centroidY = result.centroidY;
      state.formRadius = result.formRadius;
      state.classified = true;
      state.committed = false;
      return api;
    },

    // ─── Stage 2: pre-commit index operations ────────────────────
    specular(opts2 = {}) {
      checkPreCommit('specular');
      specularStamp(state.indices, state.roles, state.W, state.H, {
        palette: state.palette,
        lightDx: state.lightDx, lightDy: state.lightDy,
        centroidX: state.centroidX, centroidY: state.centroidY,
        size: state.material.specularSize != null
          ? state.material.specularSize : 2,
        ...opts2,
      });
      return api;
    },
    speckle(opts2 = {}) {
      checkPreCommit('speckle');
      const cfg = state.material.speckle || {};
      if ((opts2.every || cfg.every) === 0) return api;  // disabled
      speckleAccent(state.indices, state.roles, state.W, state.H, {
        role: PIXEL_ROLE.INTERIOR,
        every: cfg.every != null ? cfg.every : 11,
        delta: cfg.delta != null ? cfg.delta : 1,
        paletteLength: state.palette.length,
        ...opts2,
      });
      return api;
    },
    cluster(opts2 = {}) {
      checkPreCommit('cluster');
      enforceClusterIndices(state.indices, state.roles, state.W, state.H, {
        minCluster: 2,
        ...opts2,
      });
      return api;
    },
    // Targeted role-scoped index mutation — promote/demote a role to
    // a specific stop. Useful for "darken all CONCAVE pixels by 1" etc.
    shiftRole(role, delta, opts2 = {}) {
      checkPreCommit('shiftRole');
      const N = state.palette.length;
      for (let i = 0; i < state.W * state.H; i++) {
        if (state.roles[i] !== role) continue;
        state.indices[i] = Math.max(0, Math.min(N - 1, state.indices[i] + delta));
      }
      return api;
    },

    // ─── Stage 3: commit indices to canvas ───────────────────────
    // Full pipeline (in order):
    //   1. lightingMode  — reassign INTERIOR stops (banded/emissive/...)
    //   2. paintFromIndices — write palette colors
    //   3. texture       — surface character (grain/streak/cracks/...)
    //   4. edgeStyle     — boundary modification (rough/fuzzy/jagged)
    //   5. overlays      — auto-applied decorations
    //   6. opacity       — per-role transparency
    commit() {
      ensureClassified();
      // 1. Apply non-default lighting model BEFORE painting indices
      if (state.material.lightingMode || state.material.contrast != null) {
        applyLightingMode(state.indices, state.roles, state.W, state.H, {
          mode: state.material.lightingMode || 'gradient',
          palette: state.palette,
          lightDx: state.lightDx, lightDy: state.lightDy,
          centroidX: state.centroidX, centroidY: state.centroidY,
          formRadius: state.formRadius,
          contrast: state.material.contrast != null
            ? state.material.contrast : 1,
        });
      }
      // 2. Paint indices to canvas
      paintFromIndices(state.canvas, state.indices, state.palette);
      // 3. Surface texture (grain/streak/cracks/glow/...)
      if (state.material.texture) {
        applyMaterialTexture(state.canvas, state.roles, state.palette,
                             state.material.texture);
      }
      // 4. Edge style — modify silhouette character
      if (state.material.edgeStyle) {
        applyEdgeStyle(state.canvas, state.material.edgeStyle,
                       state.material.edgeStyleOpts || {});
      }
      // 5. Overlays — auto-applied decorations
      if (state.material.overlays) {
        applyOverlays(state.canvas, state.material.overlays);
      }
      // 6. Per-role opacity
      if (state.material.opacity) {
        applyRoleOpacity(state.canvas, state.roles, state.material.opacity);
      }
      state.committed = true;
      return api;
    },
    // Manual opacity application — for callers building custom chains
    // that don't want commit()'s automatic pass.
    opacity(map) {
      if (!state.committed) {
        throw new Error('opacity(): call after commit() to set per-role alpha');
      }
      applyRoleOpacity(state.canvas, state.roles, map);
      return api;
    },

    // ─── Stage 4: post-commit material accents (alpha blends) ────
    rim(opts2 = {}) {
      ensureCommitted();
      subsurfaceRim(state.canvas, {
        color: state.material.rim ? state.material.rim.color : 'rgba(255,255,255,0.5)',
        lightDx: state.lightDx, lightDy: state.lightDy,
        ...opts2,
      });
      return api;
    },
    bounce(opts2 = {}) {
      ensureCommitted();
      const cfg = state.material.bounce || {};
      if ((opts2.strength != null ? opts2.strength : cfg.strength) === 0) return api;
      bouncedLight(state.canvas, {
        color: cfg.color || '#806040',
        strength: cfg.strength != null ? cfg.strength : 0.2,
        reach: cfg.reach != null ? cfg.reach : 0.4,
        lightDx: state.lightDx, lightDy: state.lightDy,
        ...opts2,
      });
      return api;
    },
    polish(opts2 = {}) {
      ensureCommitted();
      antiJaggy(state.canvas, { strength: 0.5, ...opts2 });
      cleanIsolatedPixels(state.canvas);
      return api;
    },
    shadow(opts2 = {}) {
      ensureCommitted();
      shadowDrop(state.canvas, {
        offsetY: 0, alpha: 0.35, widthScale: 0.6,
        ...opts2,
      });
      return api;
    },

    // ─── Pipeline presets ───────────────────────────────────────
    preset(nameOrStages) {
      const stages = Array.isArray(nameOrStages)
        ? nameOrStages
        : PIXEL_PRESETS[nameOrStages];
      if (!stages) throw new Error(`unknown preset: ${nameOrStages}`);
      for (const stageName of stages) {
        if (typeof api[stageName] !== 'function') {
          throw new Error(`preset stage "${stageName}" not on painter`);
        }
        api[stageName]();
      }
      return api;
    },

    // ─── Debug ──────────────────────────────────────────────────
    // Paints the role map to the painter's canvas in place — useful
    // when chained: `.classify().debugRoles()` shows roles instead of
    // committing the real palette.
    debugRoles(target) {
      ensureClassified();
      paintRoleMap(target || state.canvas, state.roles);
      state.committed = true;       // canvas is now consumed
      return api;
    },
    // Read-only state access for advanced callers / inspection.
    inspect() {
      return {
        palette: state.palette,
        material: state.materialName,
        lightDx: state.lightDx, lightDy: state.lightDy,
        W: state.W, H: state.H,
        roles: state.roles, indices: state.indices,
        centroid: { x: state.centroidX, y: state.centroidY },
        formRadius: state.formRadius,
        classified: state.classified,
        committed: state.committed,
      };
    },

    // ─── Configuration ──────────────────────────────────────────
    setLight(dx, dy) {
      state.lightDx = dx; state.lightDy = dy;
      state.classified = false;     // light change invalidates classification
      return api;
    },
    setMaterial(name) {
      const m = PIXEL_MATERIALS[name];
      if (!m) throw new Error(`unknown material: ${name}`);
      state.materialName = name;
      state.material = m;
      // Don't auto-rebuild palette — caller may have customized.
      return api;
    },
    setPalette(p) {
      state.palette = p;
      state.classified = false;
      return api;
    },
  };

  return api;
}

// One-shot convenience: paint a sprite end-to-end. For callers that
// don't need the fluent state — pass a canvas, draw fn, and material;
// returns the canvas with the chosen preset already applied.
//
//   paintSprite(canvas, drawFn, { material: 'gem', preset: 'classic' })
export function paintSprite(canvas, drawFn, opts = {}) {
  const p = createPainter({
    material: opts.material || 'organic',
    palette: opts.palette,
    lightDx: opts.lightDx, lightDy: opts.lightDy,
  });
  p.shape(canvas, drawFn);
  p.preset(opts.preset || 'classic');
  return canvas;
}

// ──────────────────────────────────────────────────────────────────────
// Section 30.5 — growFlora: generative flora system
// ──────────────────────────────────────────────────────────────────────
// Unified flora generator. Composes:
//   archetype  — structural topology (tree/bush/flower/vine/...)
//   biome      — palette + material profile (forest/desert/cave/...)
//   season     — palette modulation + density
//   style      — material substitution (organic/crystalline/glow/wilt)
//   age        — overall scale + density (0..1 sapling..mature)
//   magicLevel — glow / sparkle accents (0..1)
//
// Internally builds a SKELETON (segments + blobs + spots) then renders
// each element via the painter. The painter handles all shading, so
// flora inherits the full material vocabulary automatically.

// Archetype = topological structure of the plant.
const FLORA_ARCHETYPES = ['tree', 'bush', 'grass', 'flower', 'vine',
                          'succulent', 'mushroom', 'fern'];

// Biome configs — drive palette hues + archetype affinity.
const FLORA_BIOMES = {
  forest:    { canopyHue: 110, canopySat: 0.65, canopyVal: 0.45,
               trunkMaterial: 'wood',
               affinity: ['oak', 'fir', 'pine', 'bushyTree', 'bush',
                          'fern', 'mushroom', 'flower'] },
  desert:    { canopyHue: 80,  canopySat: 0.45, canopyVal: 0.55,
               trunkMaterial: 'wood',
               affinity: ['succulent', 'cypress', 'bush', 'flower', 'grass'] },
  tropical:  { canopyHue: 120, canopySat: 0.75, canopyVal: 0.5,
               trunkMaterial: 'wood',
               affinity: ['jungle', 'palm', 'banyan', 'fern', 'flower', 'vine'] },
  tundra:    { canopyHue: 140, canopySat: 0.4, canopyVal: 0.4,
               trunkMaterial: 'wood',
               affinity: ['fir', 'pine', 'cypress', 'bush', 'grass'] },
  cave:      { canopyHue: 280, canopySat: 0.5, canopyVal: 0.5,
               trunkMaterial: 'stone',
               affinity: ['mushroom', 'vine', 'bush'] },
  underwater:{ canopyHue: 180, canopySat: 0.65, canopyVal: 0.5,
               trunkMaterial: 'coral',
               affinity: ['vine', 'flower', 'bush', 'succulent'] },
  lavaland:  { canopyHue: 15,  canopySat: 0.85, canopyVal: 0.55,
               trunkMaterial: 'stone',
               affinity: ['mushroom', 'succulent', 'bush', 'oak'] },
  alien:     { canopyHue: 290, canopySat: 0.8, canopyVal: 0.6,
               trunkMaterial: 'crystal',
               affinity: ['mushroom', 'flower', 'succulent', 'cypress'] },
};

// Season configs — modulate canopy palette + density.
const FLORA_SEASONS = {
  spring: { hueShiftBoost: 35, satMul: 1.05, valMul: 1.05,
            density: 0.95, hasFlowers: true,  hasFruits: false,
            hasLeaves: true },
  summer: { hueShiftBoost: 30, satMul: 1.0,  valMul: 1.0,
            density: 1.0,  hasFlowers: true, hasFruits: true,
            hasLeaves: true },
  autumn: { hueShiftBoost: 50, satMul: 0.85, valMul: 0.95,
            hueShift: -50,    // shift greens toward orange
            density: 0.85, hasFlowers: false, hasFruits: true,
            hasLeaves: true },
  winter: { hueShiftBoost: 0,  satMul: 0.4,  valMul: 0.7,
            density: 0.0,  hasFlowers: false, hasFruits: false,
            hasLeaves: false },  // bare branches
};

// Style configs — material substitutions + accent layers.
const FLORA_STYLES = {
  organic:        { canopyMaterial: 'foliage' },
  crystalline:    { canopyMaterial: 'crystal',
                    accents: { sparkles: 6 } },
  bioluminescent: { canopyMaterial: 'ember',
                    accents: { sparkles: 8, halos: 2 } },
  wilted:         { canopyMaterial: 'fur', densityMul: 0.55,
                    contrastMul: 0.6 },
  alien:          { canopyMaterial: 'slime',
                    accents: { sparkles: 4 } },
  fungal:         { canopyMaterial: 'moss' },
  charred:        { canopyMaterial: 'stone', densityMul: 0.7 },
  festive:        { canopyMaterial: 'foliage',
                    accents: { snow: true, ornaments: true } },
  flowering:      { canopyMaterial: 'foliage',
                    accents: { whiteFlowers: true } },
};

// Pick an archetype with biome affinity bias.
function _chooseArchetype(r, biome, requested) {
  if (requested !== 'auto' && FLORA_ARCHETYPES.includes(requested)) {
    return requested;
  }
  const affinity = (FLORA_BIOMES[biome] || FLORA_BIOMES.forest).affinity;
  return affinity[Math.floor(r() * affinity.length)];
}

// Build palettes for a flora element given biome/season/style.
function _buildFloraPalettes(r, biome, season, style) {
  const b = FLORA_BIOMES[biome] || FLORA_BIOMES.forest;
  const s = FLORA_SEASONS[season] || FLORA_SEASONS.summer;
  const baseH = b.canopyHue + (s.hueShift || 0);
  const baseS = b.canopySat * s.satMul;
  const baseV = b.canopyVal * s.valMul;
  // Per-flora hue jitter so clones look unique.
  const hJ = (r() - 0.5) * 30;
  return {
    canopy: hueShiftRamp({
      h: baseH + hJ, s: baseS, v: baseV,
      n: 6, hueShift: 30 + s.hueShiftBoost,
    }),
    trunk: hueShiftRamp({
      h: 28 + (r() - 0.5) * 12, s: 0.55, v: 0.42,
      n: 6, hueShift: 22,
    }),
    flower: hueShiftRamp({
      h: (baseH + 180 + (r() - 0.5) * 60) % 360,
      s: 0.8, v: 0.7, n: 6, hueShift: 30,
    }),
    fruit: hueShiftRamp({
      h: (baseH + 200 + (r() - 0.5) * 40) % 360,
      s: 0.85, v: 0.6, n: 6, hueShift: 20,
    }),
  };
}

// Skeleton element types:
//   { kind: 'stroke', from: [x,y], to: [x,y], thickness, material }
//   { kind: 'curve', points: [[x,y],...], thickness, material }
//   { kind: 'cluster', x, y, radius, density, material }
//   { kind: 'spot', x, y, radius, material, palette? }

// Tree archetype — picks among mature variants (oak/pine/fir/etc.).
// Use specific archetype names for deterministic output.
function _growTree(r, opts) {
  // Random pick from mature tree variants
  const variants = ['oak', 'pine', 'fir', 'cypress', 'bushyTree'];
  const variant = variants[Math.floor(r() * variants.length)];
  return ARCHETYPE_GROWERS[variant](r, opts);
}

// Internal: original "small mixed tree" (trunk + branches + tip clusters).
// Kept for backwards compat, but mature archetypes are preferred.
function _growSaplingTree(r, opts) {
  const { width: W, height: H, age, palettes, season } = opts;
  const trunkH = Math.round(H * (0.35 + age * 0.4));
  const baseY = H - 3;
  const trunkTopY = baseY - trunkH;
  const trunkBaseX = W / 2 + (r() - 0.5) * 2;
  const trunkBaseW = 3 + Math.round(age * 4);
  const segments = [];
  const clusters = [];
  const spots = [];

  // Trunk — quadratic-flare base, slight sway
  const sway = (r() - 0.5) * 1.2;
  segments.push({
    kind: 'taperedTrunk',
    baseX: trunkBaseX, baseY,
    topX: trunkBaseX + sway, topY: trunkTopY,
    baseW: trunkBaseW, topW: 2,
    material: 'trunk',
  });

  // Branches — 2-5 forks emerging from trunk
  const hasFoliage = season ? FLORA_SEASONS[season].hasLeaves : true;
  const branchCount = 2 + Math.floor(r() * 4);
  const branches = [];
  for (let i = 0; i < branchCount; i++) {
    const t = 0.3 + (i / branchCount) * 0.7;
    const branchX = trunkBaseX + sway * t;
    const branchY = baseY - trunkH * t;
    const ang = (-Math.PI / 2) + (r() - 0.5) * 1.6;
    const len = 6 + r() * 8;
    const ex = branchX + Math.cos(ang) * len;
    const ey = branchY + Math.sin(ang) * len;
    branches.push({ start: [branchX, branchY], end: [ex, ey], len });
    segments.push({
      kind: 'stroke',
      from: [branchX, branchY], to: [ex, ey],
      thickness: 1, material: 'trunk',
    });
  }

  // Canopy clusters — at branch tips + trunk top
  if (hasFoliage) {
    const tipPoints = branches.map(b => b.end);
    tipPoints.push([trunkBaseX + sway, trunkTopY]);
    for (const [cx, cy] of tipPoints) {
      clusters.push({
        kind: 'cluster',
        x: cx, y: cy,
        radius: 4 + r() * 3,
        density: 0.85,
        material: 'canopy',
      });
    }
    // Optional flowers
    if (FLORA_SEASONS[opts.season]?.hasFlowers && r() < 0.6) {
      for (let i = 0; i < 3; i++) {
        const b = branches[Math.floor(r() * branches.length)];
        spots.push({
          kind: 'spot', x: b.end[0] + (r() - 0.5) * 4,
          y: b.end[1] + (r() - 0.5) * 4,
          radius: 1, material: 'flower',
        });
      }
    }
    if (FLORA_SEASONS[opts.season]?.hasFruits && r() < 0.5) {
      for (let i = 0; i < 2; i++) {
        const b = branches[Math.floor(r() * branches.length)];
        spots.push({
          kind: 'spot', x: b.end[0] + (r() - 0.5) * 3,
          y: b.end[1] + 2, radius: 1, material: 'fruit',
        });
      }
    }
  }

  return { segments, clusters, spots };
}

// Mature oak — based on 164tree.dmi reference. Tall trunk goes nearly
// full height with VISIBLE leaf clusters stacked along it on
// alternating sides (not one big canopy mass). The trunk peeks
// between clusters, which is what gives this tree its character.
function _growOak(r, opts) {
  const { width: W, height: H, age, season } = opts;
  const segments = [], clusters = [], spots = [];
  const baseY = H - 2;
  const baseX = W / 2;

  // Tall trunk — extends to ~85% of height
  const trunkTopY = Math.max(4, Math.round(H * 0.12));
  const trunkH = baseY - trunkTopY;
  const trunkBaseW = 4 + Math.round(age * 3);
  const trunkTopW = 2;
  const swayX = (r() - 0.5) * 2;

  segments.push({
    kind: 'taperedTrunk',
    baseX, baseY, topX: baseX + swayX, topY: trunkTopY,
    baseW: trunkBaseW, topW: trunkTopW,
    material: 'trunk',
  });
  segments.push({
    kind: 'roots', x: baseX, y: baseY,
    count: 3 + Math.floor(r() * 2), length: trunkBaseW + 1,
    material: 'trunk',
  });

  // 4-5 round leaf clusters stacked vertically along the trunk on
  // alternating sides — the 164tree.dmi pattern. Each cluster is a
  // dense round blob; trunk peeks between them.
  if (FLORA_SEASONS[season]?.hasLeaves !== false) {
    const clusterCount = 4 + Math.floor(r() * 2);
    const verticalSpan = trunkH * 0.85;
    const verticalStart = trunkTopY + 2;
    for (let i = 0; i < clusterCount; i++) {
      const t = i / Math.max(1, clusterCount - 1);
      const cy = verticalStart + t * verticalSpan;
      // Alternate side offset; scale grows from top (small) to bottom (large)
      const sideSign = (i % 2 === 0 ? -1 : 1);
      const sideOffset = sideSign * (3 + t * 3);
      // Slight trunk-axis x using sway interpolation
      const trunkX = baseX + swayX * (1 - t);
      const cx = trunkX + sideOffset;
      const radius = 4 + t * 3 + r() * 1.5;
      // Each main cluster also has a small overlap bump on its inner
      // (trunk-side) so the two halves merge with the trunk.
      clusters.push({
        kind: 'cluster', x: cx, y: cy,
        radius, density: 1, material: 'canopy',
      });
      // Small inner overlap bump
      clusters.push({
        kind: 'cluster',
        x: trunkX + sideSign * 1, y: cy + 1,
        radius: radius * 0.55,
        density: 1, material: 'canopy',
      });
    }
    // Top apex cluster — covers trunk top
    clusters.push({
      kind: 'cluster',
      x: baseX + swayX, y: trunkTopY,
      radius: 3 + age * 1.5,
      density: 1, material: 'canopy',
    });

    // Fruits clustered on the lower main clumps
    if (FLORA_SEASONS[season]?.hasFruits && r() < 0.55) {
      for (let i = 0; i < 4; i++) {
        const cl = clusters[Math.floor(r() * clusters.length)];
        spots.push({
          kind: 'spot',
          x: cl.x + (r() - 0.5) * cl.radius * 1.4,
          y: cl.y + (r() - 0.5) * cl.radius * 1.2,
          radius: 1, material: 'fruit',
        });
      }
    }
    if (FLORA_SEASONS[season]?.hasFlowers && r() < 0.45) {
      for (let i = 0; i < 5; i++) {
        const cl = clusters[Math.floor(r() * clusters.length)];
        spots.push({
          kind: 'spot',
          x: cl.x + (r() - 0.5) * cl.radius * 1.3,
          y: cl.y - cl.radius * 0.5,
          radius: 1, material: 'flower',
        });
      }
    }
  }

  // Base undergrowth — grass tufts + small flowers at trunk base,
  // creating the "tree growing from a meadow" lush feel.
  if (FLORA_SEASONS[season]?.hasLeaves !== false && opts.understory !== false) {
    const grassWidth = trunkBaseW * 4;
    for (let i = 0; i < 3 + Math.floor(r() * 3); i++) {
      const gx = baseX + (r() - 0.5) * grassWidth;
      const gy = baseY + 1;
      // Short grass blade as 1-2px curve
      const tipY = gy - (1 + Math.floor(r() * 2));
      segments.push({
        kind: 'curve',
        points: [[gx, gy], [gx + (r() - 0.5), tipY]],
        thickness: 1, material: 'understory',
      });
    }
    // Small flowers at the base
    if (FLORA_SEASONS[season]?.hasFlowers && r() < 0.7) {
      for (let i = 0; i < 2 + Math.floor(r() * 2); i++) {
        spots.push({
          kind: 'spot',
          x: baseX + (r() - 0.5) * grassWidth,
          y: baseY - 1,
          radius: 0, material: 'flower',
        });
      }
    }
  }

  return { segments, clusters, spots };
}

// Pine — tall narrow conifer made of stacked BOUGH CLUSTERS (each
// bough = small ellipse), not a filled cone. Reference: evergreen.dmi
// where each tier is a distinct visible clump that overlaps the next.
function _growPine(r, opts) {
  const { width: W, height: H, age, season } = opts;
  const segments = [], clusters = [], spots = [];
  const baseY = H - 2;
  const baseX = W / 2;

  // Short visible trunk at base only
  const trunkH = Math.round(H * 0.1);
  const trunkTopY = baseY - trunkH;
  segments.push({
    kind: 'taperedTrunk',
    baseX, baseY, topX: baseX, topY: trunkTopY,
    baseW: 3, topW: 2, material: 'trunk',
  });
  segments.push({
    kind: 'roots', x: baseX, y: baseY, count: 2, length: 2,
    material: 'trunk',
  });

  // Stacked bough clusters — each tier 1-2 cluster blobs that fan
  // outward. Tighter stack (1.2 px overlap) creates the dense pine
  // look with visible internal cluster shading on each bough.
  if (FLORA_SEASONS[season]?.hasLeaves !== false) {
    const tiers = 8 + Math.floor(r() * 3);
    const apex = 3;
    const bot = trunkTopY + 1;
    const tierH = (bot - apex) / tiers;
    for (let i = 0; i < tiers; i++) {
      const t = i / Math.max(1, tiers - 1);
      const cy = Math.round(apex + i * tierH);
      const halfW = 1.5 + t * (5 + age * 1.5);
      // Single bough cluster centered on trunk axis (one cluster per
      // tier for narrow pine)
      clusters.push({
        kind: 'cluster',
        x: baseX, y: cy + halfW * 0.4,
        radius: halfW + 0.5,
        density: 1, material: 'canopy',
        // Slightly squashed — wider than tall to suggest bough
        squashed: true,
      });
    }
  }
  return { segments, clusters, spots };
}

// Fir — wider stepped conifer with distinct boughs that fan out on
// both sides at each tier. Reference: evergreen.dmi (left/middle).
// More dramatic tiered look than pine — wider base, fewer tiers.
function _growFir(r, opts) {
  const { width: W, height: H, age, season } = opts;
  const segments = [], clusters = [], spots = [];
  const baseY = H - 2;
  const baseX = W / 2;

  const trunkH = Math.round(H * 0.08);
  const trunkTopY = baseY - trunkH;
  segments.push({
    kind: 'taperedTrunk',
    baseX, baseY, topX: baseX, topY: trunkTopY,
    baseW: 4, topW: 2, material: 'trunk',
  });
  segments.push({
    kind: 'roots', x: baseX, y: baseY, count: 3, length: 2,
    material: 'trunk',
  });

  if (FLORA_SEASONS[season]?.hasLeaves !== false) {
    const tiers = 6 + Math.floor(r() * 2);
    const apex = 2;
    const bot = trunkTopY + 1;
    const tierH = (bot - apex) / tiers;
    for (let i = 0; i < tiers; i++) {
      const t = i / Math.max(1, tiers - 1);
      const cy = Math.round(apex + i * tierH);
      const halfW = 2 + t * (9 + age * 2);
      if (i === 0) {
        // Top apex — single small cluster
        clusters.push({
          kind: 'cluster', x: baseX, y: cy,
          radius: 2, density: 1, material: 'canopy',
        });
      } else {
        // Two bough clusters fanning out left and right on this tier
        const sideOffset = halfW * 0.55;
        clusters.push({
          kind: 'cluster',
          x: baseX - sideOffset, y: cy + 1,
          radius: halfW * 0.7,
          density: 1, material: 'canopy',
        });
        clusters.push({
          kind: 'cluster',
          x: baseX + sideOffset, y: cy + 1,
          radius: halfW * 0.7,
          density: 1, material: 'canopy',
        });
        // Center cluster fills the gap
        clusters.push({
          kind: 'cluster',
          x: baseX, y: cy,
          radius: halfW * 0.5,
          density: 1, material: 'canopy',
        });
      }
    }
  }
  return { segments, clusters, spots };
}

// Cypress — narrow columnar tree. Single tall slim canopy.
function _growCypress(r, opts) {
  const { width: W, height: H, age, season } = opts;
  const segments = [], clusters = [], spots = [];
  const baseY = H - 2;
  const baseX = W / 2;

  const trunkH = Math.round(H * 0.08);
  const trunkTopY = baseY - trunkH;
  segments.push({
    kind: 'taperedTrunk',
    baseX, baseY, topX: baseX, topY: trunkTopY,
    baseW: 3, topW: 2, material: 'trunk',
  });

  if (FLORA_SEASONS[season]?.hasLeaves !== false) {
    // Narrow upright cone with subtle tier definition
    segments.push({
      kind: 'cone',
      cx: baseX, topY: 2, bottomY: trunkTopY + 1,
      topHalfW: 2, bottomHalfW: 5,
      tiers: 12, jitter: 0.6,
      material: 'canopy',
    });
  }
  return { segments, clusters, spots };
}

// Palm — tall slim curved trunk with radial fronds at the top.
// Reference: palm.dmi. Trunk has a slight curve (asymmetric); 5-7
// frond clusters fan out from the apex.
function _growPalm(r, opts) {
  const { width: W, height: H, age, season } = opts;
  const segments = [], clusters = [], spots = [];
  const baseY = H - 2;
  const baseX = W / 2;

  // Curved trunk — uses curve points to make a gentle S
  const trunkH = Math.round(H * (0.55 + age * 0.2));
  const trunkTopY = baseY - trunkH;
  const swayMid = (r() - 0.5) * 4;
  const swayTop = (r() - 0.5) * 5;
  segments.push({
    kind: 'curve',
    points: [
      [baseX, baseY],
      [baseX + swayMid, baseY - trunkH * 0.5],
      [baseX + swayTop, trunkTopY],
    ],
    thickness: 2, material: 'trunk',
  });
  // Tiny base flare
  segments.push({
    kind: 'roots', x: baseX, y: baseY, count: 2, length: 2,
    material: 'trunk',
  });

  // Radial fronds at apex
  if (FLORA_SEASONS[season]?.hasLeaves !== false) {
    const apex = [baseX + swayTop, trunkTopY];
    const frondCount = 5 + Math.floor(r() * 3);
    for (let i = 0; i < frondCount; i++) {
      const t = i / Math.max(1, frondCount - 1);
      // Fronds fan radially: top of arc covers ~210° (mostly upward + outward)
      const ang = -Math.PI + t * Math.PI * 1.2 - 0.1;
      const len = 5 + r() * 4;
      // Each frond = curve from apex outward + slight droop at tip
      const midX = apex[0] + Math.cos(ang) * len * 0.55;
      const midY = apex[1] + Math.sin(ang) * len * 0.55;
      const tipX = apex[0] + Math.cos(ang) * len + Math.cos(ang) * 1.2;
      const tipY = apex[1] + Math.sin(ang) * len + 1.5;   // droop
      segments.push({
        kind: 'curve',
        points: [apex, [midX, midY], [tipX, tipY]],
        thickness: 1, material: 'canopy',
      });
      // Cluster blob along each frond for fuller leaves
      clusters.push({
        kind: 'cluster',
        x: (apex[0] + tipX) / 2, y: (apex[1] + tipY) / 2,
        radius: 1.8 + r(), density: 1, material: 'canopy',
      });
    }
    // Optional coconut-like fruit clusters at apex
    if (FLORA_SEASONS[season]?.hasFruits && r() < 0.5) {
      for (let i = 0; i < 3; i++) {
        spots.push({
          kind: 'spot',
          x: apex[0] + (r() - 0.5) * 2,
          y: apex[1] + 1 + (r() - 0.5),
          radius: 1, material: 'fruit',
        });
      }
    }
  }
  return { segments, clusters, spots };
}

// Willow — drooping branches cascading down from a central canopy.
// Trunk goes up ~50%; from the top, multiple downward-arc branches
// fall past the trunk, each with leaf cluster trail.
function _growWillow(r, opts) {
  const { width: W, height: H, age, season } = opts;
  const segments = [], clusters = [], spots = [];
  const baseY = H - 2;
  const baseX = W / 2;
  const trunkH = Math.round(H * 0.4);
  const trunkTopY = baseY - trunkH;
  const trunkBaseW = 4 + Math.round(age * 2);

  segments.push({
    kind: 'taperedTrunk',
    baseX, baseY, topX: baseX, topY: trunkTopY,
    baseW: trunkBaseW, topW: 3, material: 'trunk',
  });
  segments.push({
    kind: 'roots', x: baseX, y: baseY,
    count: 3, length: trunkBaseW,
    material: 'trunk',
  });

  if (FLORA_SEASONS[season]?.hasLeaves !== false) {
    // Top crown — small dense round mass at the top
    clusters.push({
      kind: 'cluster',
      x: baseX, y: trunkTopY - 4,
      radius: 5, density: 1, material: 'canopy',
    });
    // Drooping branches — multiple downward arcs falling outward then down
    const branchCount = 6 + Math.floor(r() * 3);
    for (let i = 0; i < branchCount; i++) {
      const t = (i + 0.5) / branchCount - 0.5;       // -0.5..0.5
      const startX = baseX + t * 8;
      const startY = trunkTopY - 4 + (r() - 0.5);
      // Outward midpoint
      const midX = startX + t * 6;
      const midY = startY + 4;
      // Drooping tip
      const tipX = midX + t * 2;
      const tipY = midY + 6 + r() * 4;
      segments.push({
        kind: 'curve',
        points: [[startX, startY], [midX, midY], [tipX, tipY]],
        thickness: 1, material: 'canopy',
      });
      // Small leaf clusters at the drooping tips
      clusters.push({
        kind: 'cluster',
        x: tipX, y: tipY,
        radius: 1.5 + r() * 0.8,
        density: 1, material: 'canopy',
      });
      // Mid-droop cluster for fuller foliage
      if (r() < 0.6) {
        clusters.push({
          kind: 'cluster',
          x: (midX + tipX) / 2, y: (midY + tipY) / 2,
          radius: 1.2 + r() * 0.5,
          density: 1, material: 'canopy',
        });
      }
    }
  }
  return { segments, clusters, spots };
}

// Jungle — banyan with much wider canopy + buttress roots + hanging
// vines drooping from the canopy. The "lush full mature jungle tree"
// look from jungletrees.dmi.
function _growJungle(r, opts) {
  const { width: W, height: H, age, season } = opts;
  const segments = [], clusters = [], spots = [];
  const baseY = H - 2;
  const baseX = W / 2;
  const rootZoneTop = Math.round(H * 0.5);

  // Multiple intertwined trunks (like banyan)
  const trunkCount = 4 + Math.floor(r() * 3);
  for (let i = 0; i < trunkCount; i++) {
    const t = (i + 0.5) / trunkCount - 0.5;
    const baseOffset = t * (W * 0.35);
    const startX = baseX + baseOffset;
    const topX = baseX + baseOffset * 0.3 + (r() - 0.5);
    const topY = rootZoneTop + (r() - 0.5) * 2;
    segments.push({
      kind: 'curve',
      points: [
        [startX, baseY],
        [startX + (topX - startX) * 0.5, baseY - (baseY - topY) * 0.55],
        [topX, topY],
      ],
      thickness: 2, material: 'trunk',
    });
  }
  // Wider buttress root tendrils
  for (let i = 0; i < 5; i++) {
    const sign = i % 2 === 0 ? -1 : 1;
    const ang = sign * (Math.PI * (0.5 + r() * 0.35));
    const len = 4 + r() * 3;
    const startX = baseX + sign * (W * 0.3);
    const ex = startX + Math.cos(ang) * len;
    const ey = baseY + Math.abs(Math.sin(ang)) * 1.5;
    segments.push({
      kind: 'stroke',
      from: [startX, baseY], to: [ex, ey],
      thickness: 1, material: 'trunk',
    });
  }

  // Wide dense canopy made of multiple distinct cluster blobs
  if (FLORA_SEASONS[season]?.hasLeaves !== false) {
    const canopyR = Math.min(W * 0.45, 14 + age * 4);
    const canopyCY = Math.round(rootZoneTop * 0.55);
    // Big central mass
    clusters.push({
      kind: 'cluster', x: baseX, y: canopyCY,
      radius: canopyR, density: 1, material: 'canopy',
    });
    // Several distinct overlapping bumps for the lush look
    for (let i = 0; i < 6; i++) {
      const ang = (i / 6) * Math.PI * 2 + r() * 0.4;
      const dist = canopyR * 0.6;
      clusters.push({
        kind: 'cluster',
        x: baseX + Math.cos(ang) * dist,
        y: canopyCY + Math.sin(ang) * dist * 0.85,
        radius: canopyR * (0.4 + r() * 0.2),
        density: 1, material: 'canopy',
      });
    }
    // Mark with hangingVines flag for post-process
    spots.push({ kind: 'meta', tag: 'hangingVines' });
  }
  return { segments, clusters, spots };
}

// Banyan — multi-trunk tropical tree with intertwined exposed roots.
// Reference: jungletreesmall.dmi. The lower 60% is a mass of
// dark twisted root tendrils; the upper 40% is a dense round canopy.
function _growBanyan(r, opts) {
  const { width: W, height: H, age, season } = opts;
  const segments = [], clusters = [], spots = [];
  const baseY = H - 2;
  const baseX = W / 2;
  const rootZoneTop = Math.round(H * 0.4);

  // Multi-trunk root mass — 5-7 intertwining vertical strokes that
  // taper as they rise + exposed root tendrils spreading at the base.
  const trunkCount = 5 + Math.floor(r() * 3);
  for (let i = 0; i < trunkCount; i++) {
    const t = (i + 0.5) / trunkCount - 0.5;       // -0.5..0.5
    const baseOffset = t * (W * 0.45);
    const startX = baseX + baseOffset;
    // Each trunk angles slightly toward the center as it rises
    const topX = baseX + baseOffset * 0.4 + (r() - 0.5) * 1.5;
    const topY = rootZoneTop + (r() - 0.5) * 3;
    segments.push({
      kind: 'curve',
      points: [
        [startX, baseY],
        [startX + (topX - startX) * 0.4, baseY - (baseY - topY) * 0.5 + (r() - 0.5) * 1.5],
        [topX, topY],
      ],
      thickness: 2, material: 'trunk',
    });
  }
  // Outermost root tendrils — short curving lines spreading outward at the very base
  const tendrilCount = 4 + Math.floor(r() * 3);
  for (let i = 0; i < tendrilCount; i++) {
    const sign = i % 2 === 0 ? -1 : 1;
    const ang = sign * (Math.PI * (0.55 + r() * 0.3));
    const len = 3 + r() * 3;
    const startX = baseX + sign * (W * 0.25);
    const ex = startX + Math.cos(ang) * len;
    const ey = baseY + Math.abs(Math.sin(ang)) * 1;
    segments.push({
      kind: 'stroke',
      from: [startX, baseY], to: [ex, ey],
      thickness: 1, material: 'trunk',
    });
  }

  // Dense round canopy at top
  if (FLORA_SEASONS[season]?.hasLeaves !== false) {
    const canopyR = Math.min(W * 0.4, 12 + age * 3);
    const canopyCY = Math.round(rootZoneTop * 0.5) - 2;
    clusters.push({
      kind: 'cluster', x: baseX, y: canopyCY,
      radius: canopyR, density: 1, material: 'canopy',
    });
    // Bumps for asymmetric outline
    for (let i = 0; i < 5; i++) {
      const ang = (i / 5) * Math.PI * 2 + r() * 0.4;
      clusters.push({
        kind: 'cluster',
        x: baseX + Math.cos(ang) * canopyR * 0.55,
        y: canopyCY + Math.sin(ang) * canopyR * 0.5,
        radius: canopyR * 0.45,
        density: 1, material: 'canopy',
      });
    }
  }
  return { segments, clusters, spots };
}

// Bushy tree — round full canopy on a thick rooted trunk. Like oak
// but with the canopy a single tight round mass instead of asymmetric.
function _growBushyTree(r, opts) {
  const { width: W, height: H, age, season } = opts;
  const segments = [], clusters = [], spots = [];
  const baseY = H - 2;
  const baseX = W / 2;

  // Thick rooted trunk
  const trunkH = Math.round(H * 0.3);
  const trunkBaseW = 4 + Math.round(age * 2);
  const trunkTopY = baseY - trunkH;
  segments.push({
    kind: 'taperedTrunk',
    baseX, baseY, topX: baseX, topY: trunkTopY,
    baseW: trunkBaseW, topW: 3, material: 'trunk',
  });
  segments.push({
    kind: 'roots', x: baseX, y: baseY,
    count: 3, length: trunkBaseW, material: 'trunk',
  });

  if (FLORA_SEASONS[season]?.hasLeaves !== false) {
    const canopyR = Math.min(W * 0.4, 14 + age * 3);
    const canopyCY = trunkTopY - canopyR * 0.6;
    // Single dense round mass
    clusters.push({
      kind: 'cluster', x: baseX, y: canopyCY,
      radius: canopyR, density: 1, material: 'canopy',
    });
    // Few overlapping bumps for organic outline (less than oak)
    for (let i = 0; i < 3; i++) {
      const ang = (i / 3) * Math.PI * 2 + r() * 0.3;
      clusters.push({
        kind: 'cluster',
        x: baseX + Math.cos(ang) * canopyR * 0.55,
        y: canopyCY + Math.sin(ang) * canopyR * 0.4,
        radius: canopyR * 0.5,
        density: 1, material: 'canopy',
      });
    }
  }
  return { segments, clusters, spots };
}

// Bush — short multi-stem cluster.
function _growBush(r, opts) {
  const { width: W, height: H, age, season } = opts;
  const baseY = H - 3;
  const baseX = W / 2;
  const segments = [], clusters = [], spots = [];
  const stems = 3 + Math.floor(r() * 3);
  const branches = [];
  for (let i = 0; i < stems; i++) {
    const ang = -Math.PI / 2 + (i - (stems - 1) / 2) * 0.5;
    const len = (4 + r() * 4) * (0.7 + age * 0.5);
    const ex = baseX + Math.cos(ang) * len;
    const ey = baseY + Math.sin(ang) * len;
    segments.push({
      kind: 'stroke', from: [baseX, baseY], to: [ex, ey],
      thickness: 1, material: 'trunk',
    });
    branches.push([ex, ey]);
  }
  // Cluster blobs at top of each stem
  if (FLORA_SEASONS[season]?.hasLeaves !== false) {
    for (const [bx, by] of branches) {
      clusters.push({
        kind: 'cluster', x: bx, y: by,
        radius: 3 + r() * 2,
        density: 0.85, material: 'canopy',
      });
    }
  }
  if (FLORA_SEASONS[season]?.hasFlowers && r() < 0.7) {
    for (let i = 0; i < 4; i++) {
      const [bx, by] = branches[Math.floor(r() * branches.length)];
      spots.push({
        kind: 'spot', x: bx + (r() - 0.5) * 3,
        y: by + (r() - 0.5) * 2,
        radius: 1, material: 'flower',
      });
    }
  }
  return { segments, clusters, spots };
}

// Grass — fanning vertical blades (1-px strokes).
function _growGrass(r, opts) {
  const { width: W, height: H, age } = opts;
  const segments = [];
  const baseY = H - 2;
  const baseX = W / 2;
  const blades = 5 + Math.floor(r() * 5);
  const maxLen = 4 + age * 6;
  for (let i = 0; i < blades; i++) {
    const t = (i / Math.max(1, blades - 1) - 0.5) * 2;
    const startX = baseX + t * 4;
    const len = maxLen * (0.6 + r() * 0.5);
    const tipX = startX + t * 2 + (r() - 0.5);
    const tipY = baseY - len;
    segments.push({
      kind: 'curve',
      points: [[startX, baseY], [tipX, tipY]],
      thickness: 1, material: 'canopy',
    });
  }
  // Optional seed-heads on top of a blade or two
  const spots = [];
  if (r() < 0.4) {
    for (let i = 0; i < 2; i++) {
      const seg = segments[Math.floor(r() * segments.length)];
      const tip = seg.points[seg.points.length - 1];
      spots.push({ kind: 'spot', x: tip[0], y: tip[1] - 1,
                   radius: 1, material: 'flower' });
    }
  }
  return { segments, clusters: [], spots };
}

// Flower — single stem + bloom.
function _growFlower(r, opts) {
  const { width: W, height: H, age } = opts;
  const segments = [], clusters = [], spots = [];
  const baseY = H - 2;
  const baseX = W / 2 + (r() - 0.5) * 2;
  const stemLen = (5 + r() * 5) * (0.6 + age * 0.5);
  const tipX = baseX + (r() - 0.5) * 3;
  const tipY = baseY - stemLen;
  segments.push({
    kind: 'curve',
    points: [[baseX, baseY], [(baseX + tipX) / 2, baseY - stemLen / 2], [tipX, tipY]],
    thickness: 1, material: 'canopy',
  });
  // Bloom
  spots.push({ kind: 'spot', x: tipX, y: tipY - 1,
               radius: 2, material: 'flower' });
  // Optional small leaves on stem
  if (r() < 0.7) {
    spots.push({ kind: 'spot', x: baseX - 1, y: baseY - stemLen * 0.5,
                 radius: 1, material: 'canopy' });
    spots.push({ kind: 'spot', x: baseX + 1, y: baseY - stemLen * 0.65,
                 radius: 1, material: 'canopy' });
  }
  return { segments, clusters, spots };
}

// Vine — snaking line with leaves along it.
function _growVine(r, opts) {
  const { width: W, height: H, age } = opts;
  const segments = [], clusters = [], spots = [];
  // Vines can hang from top OR snake horizontally
  const isHanging = r() < 0.5;
  const len = 12 + Math.floor(age * 16);
  const points = [];
  if (isHanging) {
    let x = W / 2 + (r() - 0.5) * 8, y = 2;
    points.push([x, y]);
    for (let i = 0; i < len; i++) {
      x += (r() - 0.5) * 1.5;
      y += 1 + r() * 0.8;
      if (y >= H - 1) break;
      points.push([x, y]);
    }
  } else {
    let x = 2, y = H / 2 + (r() - 0.5) * 6;
    points.push([x, y]);
    for (let i = 0; i < len; i++) {
      x += 1 + r() * 0.8;
      y += (r() - 0.5) * 1.5;
      if (x >= W - 1) break;
      points.push([x, y]);
    }
  }
  segments.push({ kind: 'curve', points, thickness: 1, material: 'trunk' });
  // Leaf clusters along the vine
  for (let i = 2; i < points.length - 2; i += 3) {
    const [px, py] = points[i];
    const side = (i % 6 === 0) ? -1 : 1;
    clusters.push({
      kind: 'cluster',
      x: px + side * 2, y: py,
      radius: 2 + r() * 1.5,
      density: 0.9, material: 'canopy',
    });
  }
  return { segments, clusters, spots };
}

// Succulent — radial rosette of fleshy leaves.
function _growSucculent(r, opts) {
  const { width: W, height: H, age } = opts;
  const segments = [], clusters = [], spots = [];
  const cx = W / 2, cy = H - 5;
  const rays = 5 + Math.floor(r() * 4);
  const rad = 4 + age * 5;
  for (let i = 0; i < rays; i++) {
    const ang = (i / rays) * Math.PI * 2 + (r() - 0.5) * 0.2;
    // Bias upward — succulent leaves grow up + outward
    const tipX = cx + Math.cos(ang) * rad;
    const tipY = cy + Math.sin(ang) * rad * 0.7;
    clusters.push({
      kind: 'cluster',
      x: (cx + tipX) / 2, y: (cy + tipY) / 2,
      radius: 2 + r() * 1.5, density: 0.95,
      material: 'canopy',
    });
  }
  // Optional central flower spike
  if (r() < 0.4) {
    spots.push({ kind: 'spot', x: cx, y: cy - rad * 0.8,
                 radius: 1, material: 'flower' });
  }
  return { segments, clusters, spots };
}

// Mushroom — stem + cap.
function _growMushroom(r, opts) {
  const { width: W, height: H, age } = opts;
  const segments = [], clusters = [], spots = [];
  const baseY = H - 2;
  const baseX = W / 2;
  const stemH = (3 + r() * 5) * (0.6 + age * 0.5);
  const stemTopY = baseY - stemH;
  segments.push({
    kind: 'taperedTrunk',
    baseX, baseY, topX: baseX, topY: stemTopY,
    baseW: 3, topW: 2, material: 'trunk',
  });
  // Cap — wider blob on top
  const capR = 4 + r() * 3;
  clusters.push({
    kind: 'cluster',
    x: baseX, y: stemTopY - capR * 0.3,
    radius: capR, density: 1.0,
    material: 'canopy',
    flatBottom: true,        // cap has flat underside
  });
  // Spore dots on cap
  if (r() < 0.7) {
    for (let i = 0; i < 3; i++) {
      spots.push({ kind: 'spot',
                   x: baseX + (r() - 0.5) * capR * 1.2,
                   y: stemTopY - capR * 0.5 + (r() - 0.5) * 1,
                   radius: 0, material: 'spore' });
    }
  }
  return { segments, clusters, spots };
}

// Fern — multiple curving fronds with leaflets.
function _growFern(r, opts) {
  const { width: W, height: H, age } = opts;
  const segments = [], clusters = [], spots = [];
  const baseY = H - 3;
  const baseX = W / 2;
  const fronds = 3 + Math.floor(r() * 3);
  const maxLen = (10 + r() * 6) * (0.5 + age * 0.6);
  for (let i = 0; i < fronds; i++) {
    const ang = -Math.PI / 2 + (i - (fronds - 1) / 2) * 0.4;
    const curve = (r() - 0.5) * 0.3;
    const points = [];
    let x = baseX, y = baseY, theta = ang;
    for (let s = 0; s < maxLen; s++) {
      points.push([x, y]);
      theta += curve / maxLen;
      x += Math.cos(theta);
      y += Math.sin(theta);
    }
    segments.push({
      kind: 'curve', points, thickness: 1, material: 'canopy',
    });
    // Leaflets at intervals along the frond
    for (let s = 2; s < points.length - 1; s += 2) {
      const [px, py] = points[s];
      const side = (s % 4 === 0) ? -1 : 1;
      const perpAng = theta + (Math.PI / 2) * side;
      const lx = px + Math.cos(perpAng) * 1.5;
      const ly = py + Math.sin(perpAng) * 1.5;
      clusters.push({
        kind: 'cluster', x: lx, y: ly,
        radius: 1 + r() * 0.8, density: 1, material: 'canopy',
      });
    }
  }
  return { segments, clusters, spots };
}

const ARCHETYPE_GROWERS = {
  tree: _growTree, bush: _growBush, grass: _growGrass,
  flower: _growFlower, vine: _growVine, succulent: _growSucculent,
  mushroom: _growMushroom, fern: _growFern,
  // Mature tree variants
  oak: _growOak, pine: _growPine, fir: _growFir,
  cypress: _growCypress, bushyTree: _growBushyTree,
  banyan: _growBanyan,
  palm: _growPalm, willow: _growWillow, jungle: _growJungle,
};

// Render a skeleton element as a silhouette into a canvas. Each
// material gets its own canvas so the painter can shade independently.
function _drawSkeletonSilhouette(canvas, skeleton, materialKind, materialKey, opts) {
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#888888';   // arbitrary mid color — painter recolors anyway
  function strokeLine(from, to, thickness) {
    const steps = Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1])) + 1;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const px = Math.round(from[0] + (to[0] - from[0]) * t);
      const py = Math.round(from[1] + (to[1] - from[1]) * t);
      for (let dy = 0; dy < thickness; dy++) {
        ctx.fillRect(px, py + dy - Math.floor(thickness / 2), 1, 1);
      }
    }
  }
  function strokeCurve(points, thickness) {
    for (let i = 0; i < points.length - 1; i++) {
      strokeLine(points[i], points[i + 1], thickness);
    }
  }
  function fillCluster(cx, cy, radius, density, flatBottom) {
    const r2 = radius * radius;
    for (let dy = -Math.ceil(radius); dy <= Math.ceil(radius); dy++) {
      if (flatBottom && dy > 0) break;
      for (let dx = -Math.ceil(radius); dx <= Math.ceil(radius); dx++) {
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        if (density < 1 && (d2 / r2) > density && (Math.random() < 0.3)) continue;
        ctx.fillRect(Math.round(cx + dx), Math.round(cy + dy), 1, 1);
      }
    }
  }
  function fillTrunk(baseX, baseY, topX, topY, baseW, topW) {
    const dy = topY - baseY;
    for (let i = 0; i <= -dy; i++) {
      const t = i / -dy;
      const w = topW + (baseW - topW) * (1 - t) * (1 - t);
      const cx = baseX + (topX - baseX) * t;
      const half = w / 2;
      const y = baseY + (topY - baseY) * t;
      for (let x = Math.floor(cx - half); x <= Math.ceil(cx + half); x++) {
        ctx.fillRect(x, Math.round(y), 1, 1);
      }
    }
  }
  // Filled tiered cone — for conifers (pine, fir). Tiers stack
  // tightly with each lower tier wider; optional bumpy edge via
  // jitter parameter.
  function fillCone(cone) {
    const { cx, topY, bottomY, topHalfW, bottomHalfW, tiers = 1, jitter = 0 } = cone;
    const tierH = (bottomY - topY) / tiers;
    for (let i = 0; i < tiers; i++) {
      const tierTopY = Math.round(topY + i * tierH);
      const tierBotY = Math.round(topY + (i + 1) * tierH);
      // Tier's max half-width: linear interp from topHalfW to bottomHalfW
      const tierT = (i + 0.5) / tiers;
      const tierMaxHalfW = topHalfW + (bottomHalfW - topHalfW) * tierT;
      for (let y = tierTopY; y <= tierBotY; y++) {
        const ty = (y - tierTopY) / Math.max(1, tierBotY - tierTopY);
        // Within tier: row taper toward apex of tier (top brighter, bot wider)
        const rowHalf = tierMaxHalfW * (0.6 + ty * 0.4);
        const wob = jitter > 0 ? (Math.sin(y * 1.3) * 0.5 + Math.cos(y * 0.7) * 0.5) * jitter : 0;
        const xL = Math.round(cx - rowHalf - Math.abs(wob));
        const xR = Math.round(cx + rowHalf + Math.abs(wob));
        for (let x = xL; x <= xR; x++) ctx.fillRect(x, y, 1, 1);
      }
    }
  }
  // Roots — radial flare segments at a base point (from tree base
  // outward, kept low/short to suggest exposed surface roots)
  function fillRoots(roots) {
    const { x, y, count, length } = roots;
    for (let i = 0; i < count; i++) {
      const t = (i + 0.5) / count - 0.5;        // -0.5..0.5
      const ang = Math.PI * (0.5 + t * 0.6);    // mostly down/outward
      const dx = Math.cos(ang) * length;
      const dy = Math.sin(ang) * length * 0.4;  // squashed vertically
      strokeLine([x, y], [x + dx, y + dy], 2);
    }
  }
  for (const seg of skeleton.segments) {
    if (seg.material !== materialKey) continue;
    if (seg.kind === 'stroke') strokeLine(seg.from, seg.to, seg.thickness);
    else if (seg.kind === 'curve') strokeCurve(seg.points, seg.thickness);
    else if (seg.kind === 'taperedTrunk') {
      fillTrunk(seg.baseX, seg.baseY, seg.topX, seg.topY, seg.baseW, seg.topW);
    }
    else if (seg.kind === 'cone') fillCone(seg);
    else if (seg.kind === 'roots') fillRoots(seg);
  }
  for (const cl of skeleton.clusters) {
    if (cl.material !== materialKey) continue;
    fillCluster(cl.x, cl.y, cl.radius, cl.density || 1, cl.flatBottom);
  }
}

// Main entry point — build skeleton, render, return canvas.
export function growFlora(opts = {}) {
  const {
    seed = 1,
    width = 48, height = 64,
    archetype = 'auto',
    biome = 'forest',
    season = 'summer',
    style = 'organic',
    age = 0.85,
    magicLevel = 0,
    light = { dx: -0.7, dy: -0.85 },
  } = opts;

  const r = rng(seed);
  const arch = _chooseArchetype(r, biome, archetype);
  const palettes = _buildFloraPalettes(r, biome, season, style);

  const grower = ARCHETYPE_GROWERS[arch] || _growTree;
  const skeleton = grower(r, { width, height, age, palettes, season });

  const styleCfg = FLORA_STYLES[style] || FLORA_STYLES.organic;
  const biomeCfg = FLORA_BIOMES[biome] || FLORA_BIOMES.forest;

  // Final canvas
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const fctx = canvas.getContext('2d');

  // Render each material region as its own painter-shaded layer.
  // Order: understory (grass) → trunk → canopy → spots
  const understoryPalette = hueShiftRamp({
    h: palettes.canopy ? 100 : 100,
    s: 0.6, v: 0.5, n: 6, hueShift: 30,
  });
  const layers = [
    { key: 'understory', material: 'foliage', palette: understoryPalette },
    { key: 'trunk',  material: biomeCfg.trunkMaterial, palette: palettes.trunk },
    { key: 'canopy', material: styleCfg.canopyMaterial,
      palette: palettes.canopy },
  ];
  for (const layer of layers) {
    const layerCanvas = document.createElement('canvas');
    layerCanvas.width = width; layerCanvas.height = height;
    _drawSkeletonSilhouette(layerCanvas, skeleton, layer.key, layer.key);
    // Skip if no pixels were drawn
    const lctx = layerCanvas.getContext('2d');
    const data = lctx.getImageData(0, 0, width, height).data;
    let hasContent = false;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > 0) { hasContent = true; break; }
    }
    if (!hasContent) continue;
    // Convert silhouette to painter input
    const p = createPainter({
      material: layer.material,
      palette: layer.palette,
      lightDx: light.dx, lightDy: light.dy,
    });
    p.silhouette(layerCanvas);
    p.preset('classic');

    // Tiered shadow bands — for cones flagged with tieredShadowBands
    // (firs, stepped conifers). Stamps 1-pixel dark strokes at each
    // tier-bottom y, restricted to solid canopy pixels.
    if (layer.key === 'canopy') {
      const lctx2 = layerCanvas.getContext('2d');
      const data = lctx2.getImageData(0, 0, width, height);
      const dd = data.data;
      const dark = parseColor(layer.palette[0]);
      let modified = false;
      for (const seg of skeleton.segments) {
        if (seg.kind !== 'cone' || seg.material !== 'canopy') continue;
        if (!seg.tieredShadowBands) continue;
        const tierH = (seg.bottomY - seg.topY) / seg.tiers;
        for (let i = 0; i < seg.tiers; i++) {
          const bandY = Math.round(seg.topY + (i + 1) * tierH) - 1;
          if (bandY < 0 || bandY >= height) continue;
          for (let x = 0; x < width; x++) {
            const idx = (bandY * width + x) * 4;
            if (dd[idx + 3] === 0) continue;
            // Skip pixels at the silhouette edge (already dark from outline)
            const lIdx = (bandY * width + Math.max(0, x - 1)) * 4;
            const rIdx = (bandY * width + Math.min(width - 1, x + 1)) * 4;
            if (dd[lIdx + 3] === 0 || dd[rIdx + 3] === 0) continue;
            // Blend toward darkest stop
            dd[idx]     = Math.round(dd[idx]     * 0.4 + dark.r * 0.6);
            dd[idx + 1] = Math.round(dd[idx + 1] * 0.4 + dark.g * 0.6);
            dd[idx + 2] = Math.round(dd[idx + 2] * 0.4 + dark.b * 0.6);
            modified = true;
          }
        }
      }
      if (modified) lctx2.putImageData(data, 0, 0);
    }

    // Internal cluster shading — for canopy layers, draw 1-pixel
    // dark arcs along the shadow side of each cluster center to
    // create visible leaf-clump definition (the "you can see
    // individual cluster shapes" look of mature trees).
    if (layer.key === 'canopy' && skeleton.clusters.length >= 3) {
      const clusterList = skeleton.clusters
        .filter(cl => cl.material === 'canopy' && cl.radius >= 3);
      if (clusterList.length > 0) {
        clusterShading(layerCanvas, clusterList, {
          color: layer.palette[0],
          intensity: 0.55,
          lightDx: light.dx, lightDy: light.dy,
        });
      }
    }

    fctx.drawImage(layerCanvas, 0, 0);
  }

  // Spots — flowers, fruits, spores. Each is a small painter pass.
  for (const spot of skeleton.spots) {
    const palette = spot.material === 'flower' ? palettes.flower
      : spot.material === 'fruit' ? palettes.fruit
      : spot.material === 'spore' ? palettes.canopy
      : palettes.canopy;
    const material = spot.material === 'spore' ? 'bone'
                   : spot.material === 'fruit' ? 'gem'
                   : spot.material === 'canopy' ? styleCfg.canopyMaterial
                   : 'organic';
    const spotCanvas = document.createElement('canvas');
    spotCanvas.width = width; spotCanvas.height = height;
    const sp = createPainter({
      material, palette, lightDx: light.dx, lightDy: light.dy,
    });
    sp.shape(spotCanvas, (ctx, mid) => {
      ctx.fillStyle = mid;
      const cx = Math.round(spot.x), cy = Math.round(spot.y);
      const sr = spot.radius;
      if (sr <= 0) {
        ctx.fillRect(cx, cy, 1, 1);
      } else {
        for (let dy = -sr; dy <= sr; dy++) {
          for (let dx = -sr; dx <= sr; dx++) {
            if (dx * dx + dy * dy > sr * sr) continue;
            ctx.fillRect(cx + dx, cy + dy, 1, 1);
          }
        }
      }
    });
    sp.preset('classic');
    fctx.drawImage(spotCanvas, 0, 0);
  }

  // Berries on mature trees with fruits — placed after canopy paint
  // for proper sphere-shaded clusters within the foliage.
  if (FLORA_SEASONS[season]?.hasFruits && (arch === 'oak' || arch === 'bushyTree')) {
    if (r() < 0.55) {
      berries(canvas, {
        count: 3 + Math.floor(r() * 3),
        color: palettes.fruit[3],
        rng: rng(seed * 19 + 3),
      });
    }
  }

  // Hanging vines — jungle archetype OR any flora flagged via skeleton meta
  const hangingFlag = arch === 'jungle' ||
    skeleton.spots.some(s => s.kind === 'meta' && s.tag === 'hangingVines');
  if (hangingFlag) {
    hangingVines(canvas, {
      count: 8, color: palettes.canopy[1],
      leafColor: palettes.canopy[2],
      minLength: 5, maxLength: 14,
      rng: rng(seed * 29 + 1),
    });
  }

  // Snow cap on top edges — winter season + conifer trees, OR festive style
  const snowyConifers = ['pine', 'fir', 'cypress'];
  if ((season === 'winter' && snowyConifers.includes(arch)) ||
      (styleCfg.accents && styleCfg.accents.snow)) {
    snowCap(canvas, {
      density: style === 'festive' ? 0.9 : 0.75,
      thickness: 2,
      rng: rng(seed * 31),
    });
  }

  // Christmas-style ornaments
  if (styleCfg.accents && styleCfg.accents.ornaments) {
    ornaments(canvas, {
      colors: ['#ff4040', '#ffe040', '#40d040', '#4080ff', '#e040c0', '#ffffff'],
      count: 12, minSpacing: 3,
      rng: rng(seed * 37),
    });
  }

  // White flowering accents — clusters of white dots scattered on canopy
  if (styleCfg.accents && styleCfg.accents.whiteFlowers) {
    sparkles(canvas.getContext('2d'), 0, 0, width, height, {
      count: 18, kind: 'plus', size: 0,
      coreColor: '#ffffff', midColor: '#ffe0a0', glowColor: '#000000',
      rng: rng(seed * 41),
    });
  }

  // Style accents — bioluminescent uses dedicated glow primitives now
  if (style === 'bioluminescent' || magicLevel > 0) {
    if (style === 'bioluminescent') {
      // Outward aura
      glowAura(canvas, {
        color: '#80ffd0', reach: 4, intensity: 0.65,
      });
      // Internal vein glow
      glowVeins(canvas, {
        color: '#80ffe0', count: 3, length: 14, intensity: 0.85,
        rng: rng(seed * 17 + 5),
      });
      // Bright glow nodes scattered on the silhouette
      glowSpots(canvas, {
        count: 8 + Math.floor(magicLevel * 4),
        coreColor: '#ffffff', glowColor: '#a0ffd0',
        radius: 2, intensity: 1.0,
        silhouetteOnly: true,
        rng: rng(seed * 23),
      });
    } else if (magicLevel > 0) {
      glowSpots(canvas, {
        count: Math.floor(4 + magicLevel * 8),
        coreColor: '#ffffff', glowColor: '#a0e0ff',
        radius: 2, intensity: magicLevel,
        silhouetteOnly: true,
        rng: rng(seed * 13),
      });
    }
  }
  if (style === 'crystalline') {
    sparkles(fctx, 0, 0, width, height, {
      count: 6, kind: 'star', size: 1,
      coreColor: '#ffffff', midColor: '#a0c0ff',
      glowColor: '#4080ff', rng: rng(seed * 7),
    });
  }

  // Winter / dead — frost overlay
  if (season === 'winter') {
    frost(canvas, { density: 0.5, topBias: 0.7 });
  }
  // Wilted — wear edges
  if (style === 'wilted') {
    wearEdges(canvas, { intensity: 0.18, chipChance: 0.6 });
  }
  // Charred — soot stains
  if (style === 'charred') {
    stains(fctx, 0, 0, width, height,
      { count: 4, color: '#1a0a08', size: 4, intensity: 0.6 });
  }

  shadowDrop(canvas, { offsetY: 0, alpha: 0.35, widthScale: 0.5 });
  return canvas;
}

// ──────────────────────────────────────────────────────────────────────
// Section 31 — Tile generation system
// ──────────────────────────────────────────────────────────────────────
// A tile is a square sprite designed to repeat or autotile. Built on
// the PixelPainter so tiles inherit the full material vocabulary +
// scale across 8/16/32/64+ sizes with feature-density adjustments.
//
// Architecture:
//   buildTile(spec, opts)            — single tile at any size
//   createAutotileSet(spec, opts)    — 47 wang variants (lazy)
//   createBlendTile(specA, specB)    — biome transition tile
//   TILE_SPECS                       — library of common terrain types
//   TILE_FEATURES                    — feature renderers (speckle/tuft/...)

// Resolution-aware feature renderers. Each takes (canvas, opts,
// palette, rng_) and decorates the canvas in place. Feature `minSize`
// in spec auto-skips on tiles too small for the detail to read.
const TILE_FEATURES = {
  // Random dotting at the base palette stops
  speckle(canvas, opts, palette, r_) {
    speckleTexture(canvas, {
      palette,
      density: opts.density != null ? opts.density : 0.05,
      darkRatio: opts.darkRatio != null ? opts.darkRatio : 0.6,
      darkStop: opts.darkStop != null ? opts.darkStop : 1,
      brightStop: opts.brightStop != null ? opts.brightStop : palette.length - 2,
      rng: r_,
    });
  },

  // Small grass tufts — 3-pixel cluster with tip highlight
  tuft(canvas, opts, palette, r_) {
    const W = canvas.width, H = canvas.height;
    const ctx = canvas.getContext('2d');
    const baseCount = opts.count != null ? opts.count : 1;
    const count = Math.max(1, Math.round(baseCount * (W * H) / (32 * 32)));
    for (let i = 0; i < count; i++) {
      const cx = 1 + Math.floor(r_() * (W - 2));
      const cy = 1 + Math.floor(r_() * (H - 2));
      ctx.fillStyle = palette[2];
      ctx.fillRect(cx, cy, 1, 1);
      ctx.fillRect(cx - 1, cy, 1, 1);
      ctx.fillRect(cx + 1, cy, 1, 1);
      ctx.fillStyle = palette[3];
      ctx.fillRect(cx, cy - 1, 1, 1);
      if (W >= 24) {
        ctx.fillStyle = palette[palette.length - 1];
        ctx.fillRect(cx, cy - 2, 1, 1);
      }
    }
  },

  // 2-3 pixel pebble/stone with directional shading
  pebble(canvas, opts, palette, r_) {
    const W = canvas.width, H = canvas.height;
    const ctx = canvas.getContext('2d');
    const baseCount = opts.count != null ? opts.count : 2;
    const count = Math.max(1, Math.round(baseCount * (W * H) / (32 * 32)));
    const dark = opts.darkColor || palette[0];
    const mid = opts.midColor || palette[2];
    const lit = opts.litColor || palette[palette.length - 2];
    for (let i = 0; i < count; i++) {
      const cx = 1 + Math.floor(r_() * (W - 2));
      const cy = 1 + Math.floor(r_() * (H - 2));
      ctx.fillStyle = mid;
      ctx.fillRect(cx, cy, 2, 1);
      ctx.fillRect(cx, cy + 1, 1, 1);
      ctx.fillStyle = lit;
      ctx.fillRect(cx, cy, 1, 1);
      ctx.fillStyle = dark;
      ctx.fillRect(cx + 1, cy + 1, 1, 1);
    }
  },

  // Random small flower spots — single pixels in a colored hue
  flowerDot(canvas, opts, palette, r_) {
    const W = canvas.width, H = canvas.height;
    if (W < (opts.minSize || 16)) return;
    const chance = opts.chance != null ? opts.chance : 0.4;
    const ctx = canvas.getContext('2d');
    const colors = opts.colors || ['#ffe040', '#ff80a0', '#ffffff', '#e04040'];
    if (r_() > chance) return;
    const x = 1 + Math.floor(r_() * (W - 2));
    const y = 1 + Math.floor(r_() * (H - 2));
    ctx.fillStyle = colors[Math.floor(r_() * colors.length)];
    ctx.fillRect(x, y, 1, 1);
    if (W >= 24) {
      ctx.fillStyle = '#fff8c0';
      ctx.fillRect(x, y - 1, 1, 1);
    }
  },

  // Surface cracks via texture function
  cracks(canvas, opts, palette, r_) {
    const sil = silhouetteFrom(canvas);
    const result = classifyPixels(sil, canvas.width, canvas.height,
      { palette, lightDx: -0.7, lightDy: -0.85 });
    textureCracks(canvas, result.roles, palette, {
      count: opts.count || 2,
      intensity: opts.intensity || 0.7,
      rng: r_,
    });
  },

  // Water ripples
  ripples(canvas, opts, palette, r_) {
    const sil = silhouetteFrom(canvas);
    const result = classifyPixels(sil, canvas.width, canvas.height,
      { palette, lightDx: -0.7, lightDy: -0.85 });
    textureRipples(canvas, result.roles, palette, {
      count: opts.count || 4,
      rng: r_,
    });
  },

  // Wood grain (directional)
  grain(canvas, opts, palette, r_) {
    const sil = silhouetteFrom(canvas);
    const result = classifyPixels(sil, canvas.width, canvas.height,
      { palette, lightDx: -0.7, lightDy: -0.85 });
    textureGrain(canvas, result.roles, palette, {
      spacing: opts.spacing || 3,
      intensity: opts.intensity || 0.7,
      rng: r_,
    });
  },

  // Plank divider lines — for wood floor tiles
  planks(canvas, opts, palette, r_) {
    const W = canvas.width, H = canvas.height;
    if (W < 16) return;
    const ctx = canvas.getContext('2d');
    const orientation = opts.orientation || 'horizontal';
    const plankSize = opts.plankSize || Math.floor(H / 2);
    ctx.fillStyle = palette[0];
    ctx.globalAlpha = 0.85;
    if (orientation === 'horizontal') {
      for (let y = plankSize; y < H; y += plankSize) {
        for (let x = 0; x < W; x++) ctx.fillRect(x, y, 1, 1);
      }
    } else {
      for (let x = plankSize; x < W; x += plankSize) {
        for (let y = 0; y < H; y++) ctx.fillRect(x, y, 1, 1);
      }
    }
    ctx.globalAlpha = 1;
  },

  // Brick mortar grid
  brick(canvas, opts, palette, r_) {
    const W = canvas.width, H = canvas.height;
    if (W < 16) return;
    const ctx = canvas.getContext('2d');
    const brickH = opts.brickH || Math.floor(H / 4);
    const brickW = opts.brickW || Math.floor(W / 2);
    const mortar = opts.mortarColor || palette[0];
    ctx.fillStyle = mortar;
    // Horizontal mortar lines
    for (let y = brickH - 1; y < H; y += brickH) {
      for (let x = 0; x < W; x++) ctx.fillRect(x, y, 1, 1);
    }
    // Staggered vertical mortar lines
    for (let row = 0; row < H / brickH; row++) {
      const offset = (row % 2 === 0) ? 0 : Math.floor(brickW / 2);
      for (let x = brickW - 1 + offset; x < W; x += brickW) {
        for (let y = row * brickH; y < (row + 1) * brickH - 1; y++) {
          ctx.fillRect(x, y, 1, 1);
        }
      }
    }
  },

  // Snow drift speckle — bright white dots concentrated on top
  snowDrift(canvas, opts, palette, r_) {
    const W = canvas.width, H = canvas.height;
    const ctx = canvas.getContext('2d');
    const density = opts.density != null ? opts.density : 0.04;
    const count = Math.floor(W * H * density);
    ctx.fillStyle = opts.color || '#ffffff';
    for (let i = 0; i < count; i++) {
      const x = Math.floor(r_() * W);
      const y = Math.floor(r_() * H * 0.6);  // top 60%
      const idx = (y * W + x) * 4;
      const data = ctx.getImageData(x, y, 1, 1).data;
      if (data[3] === 0) continue;
      ctx.fillRect(x, y, 1, 1);
    }
  },

  // Glow patches — for lava (use textureGlow on existing canvas)
  glowSpots(canvas, opts, palette, r_) {
    glowSpots(canvas, {
      count: opts.count || 3,
      coreColor: opts.coreColor || palette[palette.length - 1],
      glowColor: opts.glowColor || palette[palette.length - 2],
      radius: opts.radius || 2,
      intensity: opts.intensity || 0.8,
      silhouetteOnly: true,
      rng: r_,
    });
  },
};

// Library of prebuilt tile specs. Keys are semantic names for tile types.
export const TILE_SPECS = {
  grass: {
    material: 'foliage',
    palette: { h: 110, s: 0.55, v: 0.5, hueShift: 30 },
    features: [
      { type: 'speckle', density: 0.06, darkRatio: 0.55 },
      { type: 'tuft', count: 1, minSize: 16 },
      { type: 'flowerDot', chance: 0.25, minSize: 24,
        colors: ['#ffe040', '#ff80a0', '#ffffff'] },
    ],
    // Brown dirt rim just inside the boundary
    edgeRim: { color: '#3a2010', variation: 12 },
    // Grass tufts protruding outward into the void
    edgeProtrude: {
      color: '#3a5a18', tipColor: '#7aa838', density: 0.55,
    },
  },
  sand: {
    material: 'stone',
    palette: { h: 45, s: 0.45, v: 0.85, hueShift: 18 },
    features: [
      { type: 'speckle', density: 0.05, darkRatio: 0.65 },
      { type: 'pebble', count: 1, minSize: 16,
        darkColor: '#604030', midColor: '#a0805a',
        litColor: '#e0c898' },
    ],
    // Slightly darker tan rim
    edgeRim: { color: '#806040', variation: 8 },
    // Light sand grain bumps protruding (sparse)
    edgeProtrude: { color: '#d0a070', density: 0.25 },
  },
  dirt: {
    material: 'stone',
    palette: { h: 25, s: 0.55, v: 0.4, hueShift: 22 },
    features: [
      { type: 'speckle', density: 0.07, darkRatio: 0.7 },
      { type: 'pebble', count: 2, minSize: 16,
        darkColor: '#2a1808', midColor: '#5a3818',
        litColor: '#806038' },
    ],
    edgeRim: { color: '#1a0a04', variation: 6 },
    edgeProtrude: { color: '#3a1808', density: 0.3 },
  },
  stone: {
    material: 'stone',
    palette: { h: 220, s: 0.1, v: 0.55, hueShift: -15 },
    features: [
      { type: 'speckle', density: 0.04, darkRatio: 0.7 },
      { type: 'cracks', count: 1, minSize: 24, intensity: 0.6 },
      { type: 'pebble', count: 1, minSize: 16 },
    ],
    edgeRim: { color: '#2a3038', variation: 6 },
    // Sharp-edged stone — minimal protrusion
    edgeProtrude: { color: '#404858', density: 0.18 },
  },
  water: {
    material: 'water',
    palette: { h: 200, s: 0.65, v: 0.55, hueShift: 30 },
    features: [
      { type: 'ripples', count: 3, minSize: 16 },
      { type: 'speckle', density: 0.03, darkRatio: 0.4 },
    ],
    // Foam-white edge with bright speckle protrusion (water lapping at shore)
    edgeRim: { color: '#80c0e0', variation: 10 },
    edgeProtrude: { color: '#e0f0ff', tipColor: '#ffffff', density: 0.4 },
  },
  snow: {
    material: 'ice',
    palette: { h: 200, s: 0.15, v: 0.92, hueShift: -18 },
    features: [
      { type: 'snowDrift', density: 0.05 },
      { type: 'speckle', density: 0.02, darkRatio: 0.3 },
    ],
    // Frosty blue rim
    edgeRim: { color: '#a0c0d8', variation: 8 },
    edgeProtrude: { color: '#ffffff', density: 0.5 },
  },
  lava: {
    material: 'lava',
    palette: { h: 18, s: 0.95, v: 0.85, hueShift: 45 },
    features: [
      { type: 'glowSpots', count: 2, minSize: 16, intensity: 0.85,
        radius: 2 },
      { type: 'speckle', density: 0.04, darkRatio: 0.4 },
    ],
    // Cooled crust rim — dark almost-black
    edgeRim: { color: '#1a0a04', variation: 8 },
    // Bright orange spark protrusions
    edgeProtrude: { color: '#ff6020', tipColor: '#ffe040', density: 0.4 },
  },
  wood: {
    material: 'wood',
    palette: { h: 28, s: 0.55, v: 0.45, hueShift: 22 },
    features: [
      { type: 'grain', spacing: 3, intensity: 0.85 },
      { type: 'planks', minSize: 16, orientation: 'horizontal' },
    ],
  },
  ice: {
    material: 'ice',
    palette: { h: 195, s: 0.25, v: 0.85, hueShift: -22 },
    features: [
      { type: 'cracks', count: 1, minSize: 24, intensity: 0.4 },
      { type: 'speckle', density: 0.03, darkRatio: 0.4 },
    ],
    edgeRim: { color: '#7080a0', variation: 6 },
    edgeProtrude: { color: '#c0d8e8', density: 0.3 },
  },
  brick: {
    material: 'stone',
    palette: { h: 18, s: 0.55, v: 0.45, hueShift: 20 },
    features: [
      { type: 'speckle', density: 0.03, darkRatio: 0.7 },
      { type: 'brick', minSize: 16 },
    ],
    edgeRim: { color: '#2a1808', variation: 4 },
  },
  mud: {
    material: 'stone',
    palette: { h: 30, s: 0.45, v: 0.32, hueShift: 18 },
    features: [
      { type: 'speckle', density: 0.07, darkRatio: 0.7 },
    ],
    edgeRim: { color: '#1a0e04', variation: 6 },
    edgeProtrude: { color: '#2a1808', density: 0.25 },
  },
  moss: {
    material: 'moss',
    palette: { h: 90, s: 0.55, v: 0.4, hueShift: 30 },
    features: [
      { type: 'speckle', density: 0.06, darkRatio: 0.55 },
      { type: 'tuft', count: 2, minSize: 16 },
    ],
    edgeRim: { color: '#2a3818', variation: 8 },
    edgeProtrude: { color: '#5a8030', tipColor: '#9ab050', density: 0.55 },
  },
  // ── Organic edges — bumpy curved silhouettes ─────────────────────
  // Path — dirt path with rocky pebble texture, organic curved edges.
  // Heavy wobble + thick 2-pixel rim for the reference-style look.
  path: {
    material: 'stone',
    palette: { h: 25, s: 0.4, v: 0.45, hueShift: 18 },
    features: [
      { type: 'speckle', density: 0.08, darkRatio: 0.7 },
      { type: 'pebble', count: 3, minSize: 16,
        darkColor: '#3a1a08', midColor: '#604030',
        litColor: '#806040' },
    ],
    edgeRim: { color: '#2a1408', variation: 10, thickness: 2 },
    organic: { wobble: 1.1, scale: 0.18, seed: 11, radius: 3 },
  },
  // (cliff removed — equivalent to TILE_SPECS.stone with `organic`
  //  added; biome blends + organic stone autotile cover the same
  //  use case without a duplicate spec.)
  // Shore — sand/water boundary, gentler organic curves
  shore: {
    material: 'stone',
    palette: { h: 45, s: 0.5, v: 0.85, hueShift: 18 },
    features: [
      { type: 'speckle', density: 0.05, darkRatio: 0.6 },
      { type: 'pebble', count: 2, minSize: 16,
        darkColor: '#604030', midColor: '#a0805a',
        litColor: '#e0c898' },
    ],
    edgeRim: { color: '#806040', variation: 8, thickness: 1 },
    organic: { wobble: 0.85, scale: 0.22, seed: 23, radius: 2 },
  },
  // River — water with organic flowing edges
  river: {
    material: 'water',
    palette: { h: 200, s: 0.6, v: 0.55, hueShift: 30 },
    features: [
      { type: 'ripples', count: 4, minSize: 16 },
      { type: 'speckle', density: 0.04, darkRatio: 0.4 },
    ],
    edgeRim: { color: '#80c0e0', variation: 10, thickness: 1 },
    edgeProtrude: { color: '#e0f0ff', tipColor: '#ffffff', density: 0.4 },
    organic: { wobble: 0.9, scale: 0.22, seed: 31, radius: 2 },
  },
};

// Apply edge embellishments to a partially-filled tile. Two effects:
//   edgeRim       — darker border painted just INSIDE the silhouette
//                   boundary (the "dirt edge" between grass and void)
//   edgeProtrude  — decoration painted just OUTSIDE the silhouette
//                   (grass tufts, water foam, lava sparks reaching out)
function _applyTileEdges(canvas, spec, palette, r_) {
  if (!spec.edgeRim && !spec.edgeProtrude) return;
  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  const isSolid = (x, y) => {
    if (x < 0 || x >= W || y < 0 || y >= H) return false;
    return d[(y * W + x) * 4 + 3] > 0;
  };
  // Find inner boundary (solid pixels adjacent to transparent) and
  // outer boundary (transparent pixels adjacent to solid). Distinguish
  // by side so we can prefer protrusions on top edges (where tufts
  // would naturally grow upward).
  const innerB = [], outerB = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const here = isSolid(x, y);
      let n = false, e = false, s = false, w = false;
      if (!isSolid(x, y - 1)) n = true;
      if (!isSolid(x + 1, y)) e = true;
      if (!isSolid(x, y + 1)) s = true;
      if (!isSolid(x - 1, y)) w = true;
      if (here) {
        if (n || e || s || w) innerB.push([x, y, n, e, s, w]);
      } else {
        if (isSolid(x, y - 1) || isSolid(x + 1, y) ||
            isSolid(x, y + 1) || isSolid(x - 1, y)) {
          outerB.push([x, y]);
        }
      }
    }
  }
  // edgeRim — overwrite inner-boundary pixels with rim color.
  // Supports multi-pixel thickness via successive shrink passes.
  if (spec.edgeRim) {
    const rim = parseColor(spec.edgeRim.color);
    const variation = spec.edgeRim.variation || 0;
    const thickness = spec.edgeRim.thickness || 1;
    // Layer 1: outermost rim
    for (const [x, y] of innerB) {
      const idx = (y * W + x) * 4;
      const j = (r_() - 0.5) * variation;
      d[idx]     = Math.max(0, Math.min(255, rim.r + j));
      d[idx + 1] = Math.max(0, Math.min(255, rim.g + j));
      d[idx + 2] = Math.max(0, Math.min(255, rim.b + j));
    }
    // Additional layers — each one ring inward, slightly lighter
    if (thickness >= 2) {
      const isRimPixel = new Uint8Array(W * H);
      for (const [x, y] of innerB) isRimPixel[y * W + x] = 1;
      for (let layer = 1; layer < thickness; layer++) {
        const newRim = [];
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            const idx = y * W + x;
            if (isRimPixel[idx]) continue;
            const idx4 = idx * 4;
            if (d[idx4 + 3] === 0) continue;
            // Touches an existing rim pixel?
            let touchesRim = false;
            for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
              const nx = x + dx, ny = y + dy;
              if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
              if (isRimPixel[ny * W + nx]) { touchesRim = true; break; }
            }
            if (touchesRim) newRim.push([x, y]);
          }
        }
        // Paint slightly lighter mix: 70% rim + 30% original
        for (const [x, y] of newRim) {
          const idx = (y * W + x) * 4;
          const j = (r_() - 0.5) * variation;
          d[idx]     = Math.max(0, Math.min(255,
            d[idx] * 0.3 + (rim.r + j) * 0.7));
          d[idx + 1] = Math.max(0, Math.min(255,
            d[idx + 1] * 0.3 + (rim.g + j) * 0.7));
          d[idx + 2] = Math.max(0, Math.min(255,
            d[idx + 2] * 0.3 + (rim.b + j) * 0.7));
          isRimPixel[y * W + x] = 1;
        }
      }
    }
  }
  // edgeProtrude — paint into outer boundary with decoration color
  if (spec.edgeProtrude) {
    const ep = spec.edgeProtrude;
    const density = ep.density != null ? ep.density : 0.5;
    const protColor = parseColor(ep.color || '#000');
    const tipColor = ep.tipColor ? parseColor(ep.tipColor) : null;
    for (const [x, y] of outerB) {
      if (r_() > density) continue;
      const idx = (y * W + x) * 4;
      d[idx]     = protColor.r;
      d[idx + 1] = protColor.g;
      d[idx + 2] = protColor.b;
      d[idx + 3] = 255;
      // Optional tip highlight one pixel further out
      if (tipColor && r_() < 0.4) {
        // Find which side this outer pixel is on (away from solid)
        let tx = x, ty = y;
        if (isSolid(x, y + 1)) ty = y - 1;        // solid below, tip up
        else if (isSolid(x, y - 1)) ty = y + 1;
        else if (isSolid(x + 1, y)) tx = x - 1;
        else if (isSolid(x - 1, y)) tx = x + 1;
        if (tx >= 0 && tx < W && ty >= 0 && ty < H) {
          const tIdx = (ty * W + tx) * 4;
          if (d[tIdx + 3] === 0) {
            d[tIdx]     = tipColor.r;
            d[tIdx + 1] = tipColor.g;
            d[tIdx + 2] = tipColor.b;
            d[tIdx + 3] = 255;
          }
        }
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

// Build a single tile from a spec.
//
//   spec       — TILE_SPECS entry or custom { material, palette, features }
//   opts.size  — tile dimension (default 32)
//   opts.silhouette — Uint8Array of size*size; 1 = paint, 0 = transparent
//                     Used for autotile variants and blend masks.
//   opts.seed  — seed for deterministic variation
//   opts.light — { dx, dy } light direction
//   opts.edges — boolean, apply edgeRim/edgeProtrude (default true if
//                spec defines them and silhouette is partial)
export function buildTile(spec, opts = {}) {
  const { size = 32, silhouette = null, seed = 1,
          light = { dx: -0.7, dy: -0.85 },
          edges = true } = opts;
  const r_ = rng(seed);
  const palette = hueShiftRamp({ ...spec.palette, n: 6 });
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const painter = createPainter({
    material: spec.material,
    palette,
    lightDx: light.dx, lightDy: light.dy,
  });
  painter.shape(canvas, (ctx, mid) => {
    ctx.fillStyle = mid;
    if (silhouette) {
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          if (silhouette[y * size + x]) ctx.fillRect(x, y, 1, 1);
        }
      }
    } else {
      ctx.fillRect(0, 0, size, size);
    }
  });
  painter.preset('classic');
  // Apply features — each scales with tile size
  for (const feature of spec.features || []) {
    if (feature.minSize && size < feature.minSize) continue;
    const fn = TILE_FEATURES[feature.type];
    if (!fn) continue;
    fn(canvas, feature, palette, r_);
  }
  // Edge embellishments — only meaningful when silhouette is partial
  // (full-coverage tiles have no edges to decorate)
  if (edges && silhouette) {
    _applyTileEdges(canvas, spec, palette, r_);
  }
  return canvas;
}

// Apply organic edge wobble to a mask via fbm-driven erosion/dilation.
// Pixels at the silhouette boundary are randomly nudged in or out
// based on fbm values, producing bumpy organic curves instead of
// sharp wang chamfers. Use for paths, shorelines, cliffs.
//
// IMPORTANT: To make adjacent tiles' wobble line up at shared edges,
// the fbm samples the GLOBAL tile coordinates (tileX*size + x), so
// neighboring tiles' boundaries see the same noise field at the seam.
// Pass `tileX, tileY` when rendering as part of a map; for isolated
// preview tiles, leave them at 0.
export function applyEdgeWobble(mask, size, opts = {}) {
  const {
    amplitude = 1.0,
    scale = 0.22,
    seed = 1,
    tileX = 0, tileY = 0,
    radius = 2,           // how many pixels of wobble depth (1-3)
  } = opts;
  if (amplitude <= 0) return mask;
  const noise = valueNoise2D(rng(seed));
  const fbmN = fbm(noise, { octaves: 2, gain: 0.55 });

  // Compute distance-from-boundary for each pixel up to `radius`.
  // Pixels within radius of the boundary become candidates for wobble.
  const distOut = new Uint8Array(size * size);   // distance from solid into transparent
  const distIn  = new Uint8Array(size * size);   // distance from transparent into solid
  for (let i = 0; i < size * size; i++) {
    distOut[i] = mask[i] ? 0 : 99;
    distIn[i] = mask[i] ? 99 : 0;
  }
  // BFS-style dilation up to radius
  for (let r = 1; r <= radius; r++) {
    const newOut = new Uint8Array(distOut);
    const newIn = new Uint8Array(distIn);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        if (distOut[i] === 99) {
          for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || nx >= size || ny < 0 || ny >= size) continue;
            if (distOut[ny * size + nx] === r - 1) {
              newOut[i] = r; break;
            }
          }
        }
        if (distIn[i] === 99) {
          for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || nx >= size || ny < 0 || ny >= size) continue;
            if (distIn[ny * size + nx] === r - 1) {
              newIn[i] = r; break;
            }
          }
        }
      }
    }
    distOut.set(newOut);
    distIn.set(newIn);
  }

  // Build output: per pixel, sample fbm and decide whether to flip.
  const out = new Uint8Array(mask);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const dOut = distOut[i], dIn = distIn[i];
      // Skip pixels too far from boundary
      if ((mask[i] && dOut > radius) || (!mask[i] && dIn > radius)) continue;
      if (mask[i] && dOut === 99) continue;
      if (!mask[i] && dIn === 99) continue;
      // Skip core pixels (deep interior or far exterior)
      if (mask[i] && dOut === 0 && dIn > radius) continue;

      const gx = (tileX * size + x) * scale;
      const gy = (tileY * size + y) * scale;
      const n = (fbmN(gx, gy) + 1) * 0.5;       // 0..1
      // The wobble threshold scales with distance from the boundary.
      // Pixels right at the boundary flip easily; pixels deeper need
      // stronger noise to flip. This produces coherent bumps instead
      // of a single-pixel perimeter wobble.
      if (mask[i]) {
        // Solid pixel — erode if noise is low enough
        const dist = dOut > 0 ? dOut : 1;     // distance into solid from outside
        const threshold = amplitude * (0.55 - (dist - 1) * 0.18);
        if (n < threshold) out[i] = 0;
      } else {
        // Transparent pixel — dilate if noise is high enough
        const dist = dIn > 0 ? dIn : 1;
        const threshold = 1 - amplitude * (0.55 - (dist - 1) * 0.18);
        if (n > threshold) out[i] = 1;
      }
    }
  }
  return out;
}

// Build a wang mask with organic curved edges. Wraps buildWangMask47
// with rounded corners + edge wobble. The result is a tile silhouette
// suitable for paths, shorelines, cliff edges that need to look hand-
// drawn rather than geometric.
//
//   neighbors  — 8-neighbor flags { N, E, S, W, NE, SE, SW, NW }
//   size       — tile size
//   opts.wobble  — fbm edge wobble amplitude (0..1, default 0.7)
//   opts.scale   — fbm frequency (default 0.35)
//   opts.seed    — wobble seed (default tile-key based)
//   opts.curve   — extra concave radius (smooths inner corners)
export function buildWangMaskOrganic(neighbors, size, opts = {}) {
  const {
    wobble = 0.7,
    scale = 0.35,
    seed = 1,
    curve = Math.max(2, Math.floor(size / 7)),
    tileX = 0, tileY = 0,
  } = opts;
  // Build base mask with extra-rounded corners
  let mask = buildWangMask47(neighbors, size, {
    inset: 0,
    chamfer: 0,
    concave: curve,
  });
  if (wobble > 0) {
    mask = applyEdgeWobble(mask, size,
      { amplitude: wobble, scale, seed, tileX, tileY });
  }
  return mask;
}

// Generate the 47 distinct wang-blob neighbor configurations.
// Each is an 8-neighbor flag set { N, E, S, W, NE, SE, SW, NW }.
// The 47 set collapses 256 patterns by the rule: a corner counts as
// "filled" only when both adjacent cardinals are filled.
function _wang47Configs() {
  const seen = new Set();
  const configs = [];
  for (let mask = 0; mask < 256; mask++) {
    const N  = (mask & 1) > 0;
    const E  = (mask & 2) > 0;
    const S  = (mask & 4) > 0;
    const W  = (mask & 8) > 0;
    const NE = (mask & 16) > 0 && N && E;
    const SE = (mask & 32) > 0 && S && E;
    const SW = (mask & 64) > 0 && S && W;
    const NW = (mask & 128) > 0 && N && W;
    const key = (N ? 1 : 0) | (E ? 2 : 0) | (S ? 4 : 0) | (W ? 8 : 0)
      | (NE ? 16 : 0) | (SE ? 32 : 0) | (SW ? 64 : 0) | (NW ? 128 : 0);
    if (seen.has(key)) continue;
    seen.add(key);
    configs.push({ N, E, S, W, NE, SE, SW, NW, key });
  }
  return configs;
}
const WANG47_CONFIGS = _wang47Configs();

// Generate an autotile set for a tile spec at a given size.
// Returns an object with `getTile(neighbors, x, y)` that returns the
// canvas for any 8-neighbor configuration. Tiles are cached.
//
// If `spec.organic` is set, the tile uses curved/wobbly silhouettes
// via buildWangMaskOrganic. Pass tile coordinates `x, y` when rendering
// a map so the wobble fbm samples global coordinates (adjacent tiles'
// boundaries align). Without coordinates, isolated tiles use 0,0.
export function createAutotileSet(spec, opts = {}) {
  const { size = 32, seed = 1 } = opts;
  const cache = new Map();
  const organic = spec.organic || null;
  function getTile(neighbors, tileX = 0, tileY = 0) {
    const N = !!neighbors.N, E = !!neighbors.E,
          S = !!neighbors.S, W = !!neighbors.W;
    const NE = !!neighbors.NE && N && E;
    const SE = !!neighbors.SE && S && E;
    const SW = !!neighbors.SW && S && W;
    const NW = !!neighbors.NW && N && W;
    const key = (N ? 1 : 0) | (E ? 2 : 0) | (S ? 4 : 0) | (W ? 8 : 0)
      | (NE ? 16 : 0) | (SE ? 32 : 0) | (SW ? 64 : 0) | (NW ? 128 : 0);
    // Cache key includes tile coords for organic so wobble varies per cell
    const cacheKey = organic ? `${key}_${tileX}_${tileY}` : `${key}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    let mask;
    if (organic) {
      mask = buildWangMaskOrganic({ N, E, S, W, NE, SE, SW, NW }, size, {
        wobble: organic.wobble != null ? organic.wobble : 0.7,
        scale: organic.scale != null ? organic.scale : 0.35,
        seed: seed + (organic.seed || 0),
        curve: organic.curve,
        tileX, tileY,
      });
    } else {
      mask = buildWangMask47({ N, E, S, W, NE, SE, SW, NW }, size,
        { inset: 0, chamfer: 0,
          concave: Math.max(2, Math.floor(size / 6)) });
    }
    const tile = buildTile(spec, {
      size, silhouette: mask,
      seed: seed + key + tileX * 7 + tileY * 13,
    });
    cache.set(cacheKey, tile);
    return tile;
  }
  return { getTile, allConfigs: WANG47_CONFIGS, organic: !!organic };
}

// Render a tile map (2D grid of biome IDs) to a canvas using an
// autotile set. Each cell looks at its 8 neighbors and fetches the
// matching tile shape. Cells of the same biome ID connect.
export function renderTileMap(map, w, h, tileSet, opts = {}) {
  const { tileSize = 32 } = opts;
  const canvas = document.createElement('canvas');
  canvas.width = w * tileSize; canvas.height = h * tileSize;
  const ctx = canvas.getContext('2d');
  const get = (x, y) =>
    (x >= 0 && x < w && y >= 0 && y < h) ? map[y * w + x] : 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const here = get(x, y);
      if (here === 0) continue;
      const neighbors = {
        N:  get(x, y - 1) === here,
        E:  get(x + 1, y) === here,
        S:  get(x, y + 1) === here,
        W:  get(x - 1, y) === here,
        NE: get(x + 1, y - 1) === here,
        SE: get(x + 1, y + 1) === here,
        SW: get(x - 1, y + 1) === here,
        NW: get(x - 1, y - 1) === here,
      };
      const tile = tileSet.getTile(neighbors, x, y);
      ctx.drawImage(tile, x * tileSize, y * tileSize);
    }
  }
  return canvas;
}

// Generate an fbm-based blend mask between two biomes.
// Returns Uint8Array of size*size; 1 = use specA, 0 = use specB.
// `weight` controls how much of the tile is biome A (0..1).
export function buildBlendMask(size, opts = {}) {
  const { seed = 1, weight = 0.5, scale = 0.15 } = opts;
  const noise = valueNoise2D(rng(seed));
  const fbmN = fbm(noise, { octaves: 3 });
  const mask = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = (fbmN(x * scale, y * scale) + 1) * 0.5;
      mask[y * size + x] = n < weight ? 1 : 0;
    }
  }
  return mask;
}

// Build a tile that blends two biomes using a mask. The mask is
// either passed in (precomputed gradient) or generated via fbm.
export function createBlendTile(specA, specB, opts = {}) {
  const { size = 32, seed = 1, weight = 0.5, mask: providedMask = null,
          fbmScale = 0.15 } = opts;
  const mask = providedMask || buildBlendMask(size,
    { seed, weight, scale: fbmScale });
  // Build B as the base (full coverage)
  const baseTile = buildTile(specB, { size, seed });
  // Build A only on its mask region
  const overlayTile = buildTile(specA,
    { size, silhouette: mask, seed: seed + 1 });
  // Composite
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(baseTile, 0, 0);
  ctx.drawImage(overlayTile, 0, 0);
  return canvas;
}

// Returns: array of '#rrggbb' strings, ready for paletteRamp().
export function hueShiftRamp(opts = {}) {
  const baseH = opts.h != null ? opts.h : 0;
  const baseS = opts.s != null ? opts.s : 0.7;
  const baseV = opts.v != null ? opts.v : 0.55;
  const n     = opts.n != null ? opts.n : 5;
  const hueShift  = opts.hueShift  != null ? opts.hueShift  : 30;
  const valSpread = opts.valSpread != null ? opts.valSpread : 0.8;
  const satCurve  = opts.satCurve  != null ? opts.satCurve  : 0.85;
  const stops = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    const hDeg = ((baseH + (t - 0.5) * hueShift) % 360 + 360) % 360;
    const sBias = 1 - Math.abs(t - 0.5) * 2 * (1 - satCurve);
    const s = Math.max(0, Math.min(1, baseS * sBias));
    const vMin = Math.max(0.05, baseV * (1 - valSpread / 2));
    const vMax = Math.min(1, baseV + (1 - baseV) * (valSpread / 2));
    const v = vMin + t * (vMax - vMin);
    // hsvToRgb expects hue normalized 0..1 (the procgen convention,
    // not degrees). Convert before calling.
    const rgb = hsvToRgb(hDeg / 360, s, v);
    stops.push(rgbToHex(rgb.r, rgb.g, rgb.b));
  }
  return stops;
}

// paletteFromHue — convenience wrapper around hueShiftRamp.
export function paletteFromHue(hue, opts = {}) {
  return hueShiftRamp({
    h: hue, s: opts.s, v: opts.v, n: opts.n,
    hueShift: opts.hueShift, valSpread: opts.valSpread, satCurve: opts.satCurve,
  });
}

// quantizeToPalette — snap every pixel to the nearest palette color
// (RGB Euclidean distance). Use AFTER drawing with arbitrary colors
// to lock the sprite to a constrained palette. Pair with bayerDither
// (§15) for dithered transitions instead of nearest-neighbor snaps.
export function quantizeToPalette(canvas, palette) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const img = ctx.getImageData(0, 0, w, h);
  const data = img.data;
  const palRgb = palette.map(c => parseColor(c));
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 8) continue;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    let bestI = 0, bestD = Infinity;
    for (let p = 0; p < palRgb.length; p++) {
      const c = palRgb[p];
      const d = (r - c.r) * (r - c.r) + (g - c.g) * (g - c.g) + (b - c.b) * (b - c.b);
      if (d < bestD) { bestD = d; bestI = p; }
    }
    data[i]     = palRgb[bestI].r;
    data[i + 1] = palRgb[bestI].g;
    data[i + 2] = palRgb[bestI].b;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// ── Form shading ──────────────────────────────────────────────────────

// _distanceFromEdge — internal: Manhattan distance map of every
// opaque pixel to the nearest silhouette edge. Two-pass forward +
// backward refinement. Returns Int16Array length w*h, with -1 for
// transparent cells.
function _distanceFromEdge(data, w, h) {
  const dist = new Int16Array(w * h);
  for (let i = 0; i < w * h; i++) {
    dist[i] = data[i * 4 + 3] < 8 ? -1 : 9999;
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (dist[i] < 0) continue;
      if (x === 0 || y === 0) { dist[i] = 0; continue; }
      if (dist[i - 1] < 0 || dist[i - w] < 0) { dist[i] = 0; continue; }
      let d = dist[i];
      if (dist[i - 1] + 1 < d) d = dist[i - 1] + 1;
      if (dist[i - w] + 1 < d) d = dist[i - w] + 1;
      dist[i] = d;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (dist[i] < 0) continue;
      if (x === w - 1 || y === h - 1) {
        if (dist[i] > 0) dist[i] = 0;
        continue;
      }
      if (dist[i + 1] < 0 || dist[i + w] < 0) {
        if (dist[i] > 0) dist[i] = 0;
        continue;
      }
      let d = dist[i];
      if (dist[i + 1] + 1 < d) d = dist[i + 1] + 1;
      if (dist[i + w] + 1 < d) d = dist[i + w] + 1;
      dist[i] = d;
    }
  }
  return dist;
}

// formShade — replace the silhouette's flat fill with a form-aware
// gradient. Each pixel's color = palette(t) where t combines:
//   • distance-from-edge (deeper inside = mid-to-bright)
//   • light-direction bias (pixels facing the light = brighter)
//
// This is the primitive that turns a flat circle into a SPHERE, a
// flat trunk into a CYLINDER, a flat leaf into a curved leaf.
//
//   formShade(myCanvas, {
//     palette: hueShiftRamp({ h: 110, s: 0.6, v: 0.55 }),
//     lightDx: -0.7, lightDy: -0.7,
//     intensity: 0.65,
//   });
//
// opts:
//   palette      array of hex stops; passed through paletteRamp internally
//   lightDx,Dy   light direction (default upper-left = -1, -1)
//   intensity    0..1 — 0 = pure depth shading, 1 = pure light direction
//                (default 0.55 — balanced)
//   minT         floor on the palette parameter so the deepest shadows
//                stay one stop in (default 0.05)
export function formShade(canvas, opts = {}) {
  const palette = opts.palette || ['#000', '#444', '#888', '#ccc', '#fff'];
  const lightDx = opts.lightDx != null ? opts.lightDx : -1;
  const lightDy = opts.lightDy != null ? opts.lightDy : -1;
  const intensity = opts.intensity != null ? opts.intensity : 0.55;
  const minT = opts.minT != null ? opts.minT : 0.05;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const img = ctx.getImageData(0, 0, w, h);
  const data = img.data;
  const dist = _distanceFromEdge(data, w, h);
  let maxD = 0;
  for (let i = 0; i < dist.length; i++) {
    if (dist[i] > maxD) maxD = dist[i];
  }
  if (maxD === 0) return canvas;
  const ramp = paletteRamp(palette);
  const lLen = Math.hypot(lightDx, lightDy) || 1;
  const lx = lightDx / lLen, ly = lightDy / lLen;
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const idx = py * w + px;
      if (dist[idx] < 0) continue;
      const i = idx * 4;
      const depth = dist[idx] / maxD;
      // Distance-field gradient ≈ surface normal direction (points
      // toward the silhouette interior).
      let gx = 0, gy = 0;
      if (px > 0     && dist[idx - 1] >= 0) gx -= dist[idx - 1];
      if (px < w - 1 && dist[idx + 1] >= 0) gx += dist[idx + 1];
      if (py > 0     && dist[idx - w] >= 0) gy -= dist[idx - w];
      if (py < h - 1 && dist[idx + w] >= 0) gy += dist[idx + w];
      const gLen = Math.hypot(gx, gy);
      const lit = gLen > 0 ? -((gx / gLen) * lx + (gy / gLen) * ly) : 0;
      const litT = (lit + 1) * 0.5;
      let t = depth * (1 - intensity) + litT * intensity;
      t = Math.max(minT, Math.min(1, t));
      const col = parseColor(ramp(t));
      data[i]     = col.r;
      data[i + 1] = col.g;
      data[i + 2] = col.b;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// ── Selective outline (selout) ────────────────────────────────────────

// selectiveOutline — outline ONLY the shadow-facing side of the
// silhouette. Empty pixels adjacent to opaque ones get the outline
// color IF the outward normal points away from the light. The lit
// side stays rim-less — reads as more dimensional than a uniform
// surrounding outline.
//
//   selectiveOutline(canvas, {
//     color: '#000',
//     lightDx: -0.7, lightDy: -0.7,
//   });
//
// opts:
//   color        shadow-side outline color (default '#000')
//   litColor     optional lit-side outline (default null = none)
//   lightDx,Dy   light direction (must match formShade)
//   threshold    -1..1 dot cutoff (default 0). Positive shrinks the
//                outlined region; negative grows it.
export function selectiveOutline(canvas, opts = {}) {
  const color = opts.color || '#000';
  const litColor = opts.litColor || null;
  const lightDx = opts.lightDx != null ? opts.lightDx : -1;
  const lightDy = opts.lightDy != null ? opts.lightDy : -1;
  const threshold = opts.threshold != null ? opts.threshold : 0;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const img = ctx.getImageData(0, 0, w, h);
  const src = img.data;
  const dst = new Uint8ClampedArray(src);
  const isOpaque = (x, y) =>
    x >= 0 && y >= 0 && x < w && y < h && src[(y * w + x) * 4 + 3] >= 8;
  const lLen = Math.hypot(lightDx, lightDy) || 1;
  const lx = lightDx / lLen, ly = lightDy / lLen;
  const shadowRgb = parseColor(color);
  const litRgb = litColor ? parseColor(litColor) : null;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (isOpaque(x, y)) continue;
      let nx = 0, ny = 0, hits = 0, cardHits = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          if (isOpaque(x + dx, y + dy)) {
            nx -= dx; ny -= dy; hits++;
            if (dx === 0 || dy === 0) cardHits++;
          }
        }
      }
      if (hits === 0 || cardHits === 0) continue;
      const nLen = Math.hypot(nx, ny);
      const dot = nLen > 0 ? (nx / nLen) * lx + (ny / nLen) * ly : 0;
      const isLit = dot > threshold;
      const rgb = isLit ? litRgb : shadowRgb;
      if (!rgb) continue;
      const i = (y * w + x) * 4;
      dst[i]     = rgb.r;
      dst[i + 1] = rgb.g;
      dst[i + 2] = rgb.b;
      dst[i + 3] = 255;
    }
  }
  ctx.putImageData(new ImageData(dst, w, h), 0, 0);
  return canvas;
}

// ── Subsurface rim ────────────────────────────────────────────────────

// subsurfaceRim — adds a 1-pixel BRIGHT rim INSIDE the silhouette on
// the light-facing edge. Reads as light passing through translucent
// material (leaves, fur, skin, jelly).
//
// opts:
//   color        rim color, often rgba for blended brightness
//   lightDx,Dy   light direction
//   thickness    1..3 px (default 1)
//   threshold    dot cutoff (default 0)
export function subsurfaceRim(canvas, opts = {}) {
  const color = opts.color || 'rgba(255, 255, 220, 0.7)';
  const lightDx = opts.lightDx != null ? opts.lightDx : -1;
  const lightDy = opts.lightDy != null ? opts.lightDy : -1;
  const thickness = opts.thickness != null ? opts.thickness : 1;
  const threshold = opts.threshold != null ? opts.threshold : 0;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const img = ctx.getImageData(0, 0, w, h);
  const src = img.data;
  const dist = _distanceFromEdge(src, w, h);
  const lLen = Math.hypot(lightDx, lightDy) || 1;
  const lx = lightDx / lLen, ly = lightDy / lLen;
  ctx.fillStyle = color;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (dist[i] < 0) continue;
      if (dist[i] > thickness - 1) continue;
      let gx = 0, gy = 0;
      if (x > 0     && dist[i - 1] >= 0) gx -= dist[i - 1]; else gx += 1;
      if (x < w - 1 && dist[i + 1] >= 0) gx += dist[i + 1]; else gx -= 1;
      if (y > 0     && dist[i - w] >= 0) gy -= dist[i - w]; else gy += 1;
      if (y < h - 1 && dist[i + w] >= 0) gy += dist[i + w]; else gy -= 1;
      const gLen = Math.hypot(gx, gy);
      // Outward normal = -gradient direction.
      const dot = gLen > 0 ? -((gx / gLen) * lx + (gy / gLen) * ly) : 0;
      if (dot <= threshold) continue;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  return canvas;
}

// ── Anti-jaggies ──────────────────────────────────────────────────────

// antiJaggy — softens 2-pixel diagonal stair patterns by removing the
// inside corner of L-shaped elbows. Run AFTER any outline pass.
//
// opts:
//   strength     0..1 fraction of detected stairs to soften (default 1)
export function antiJaggy(canvas, opts = {}) {
  const strength = opts.strength != null ? opts.strength : 1.0;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const img = ctx.getImageData(0, 0, w, h);
  const src = img.data;
  const dst = new Uint8ClampedArray(src);
  const opaque = (x, y) =>
    x >= 0 && y >= 0 && x < w && y < h && src[(y * w + x) * 4 + 3] >= 8;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (!opaque(x, y)) continue;
      const N  = opaque(x, y - 1), S  = opaque(x, y + 1);
      const W_ = opaque(x - 1, y), E_ = opaque(x + 1, y);
      const NE = opaque(x + 1, y - 1), NW = opaque(x - 1, y - 1);
      const SE = opaque(x + 1, y + 1), SW = opaque(x - 1, y + 1);
      const isElbowNW = N && W_ && !NW && !NE && !SW;
      const isElbowNE = N && E_ && !NE && !NW && !SE;
      const isElbowSW = S && W_ && !SW && !SE && !NW;
      const isElbowSE = S && E_ && !SE && !SW && !NE;
      if (!(isElbowNW || isElbowNE || isElbowSW || isElbowSE)) continue;
      if (Math.random() > strength) continue;
      const i = (y * w + x) * 4;
      dst[i + 3] = 0;
    }
  }
  ctx.putImageData(new ImageData(dst, w, h), 0, 0);
  return canvas;
}

// ── Drop shadow ───────────────────────────────────────────────────────

// shadowDrop — soft elliptical shadow under the silhouette's lowest
// row. Grounds sprites in the world (entity standing on terrain).
//
// opts:
//   offsetY      below silhouette base (default 1)
//   alpha        0..1 (default 0.35)
//   color        '#000' usually
//   widthScale   ellipse width relative to silhouette (default 0.85)
//   heightPx     ellipse height (default 2)
export function shadowDrop(canvas, opts = {}) {
  const offsetY = opts.offsetY != null ? opts.offsetY : 1;
  const alpha = opts.alpha != null ? opts.alpha : 0.35;
  const color = opts.color || '#000';
  const widthScale = opts.widthScale != null ? opts.widthScale : 0.85;
  const heightPx = opts.heightPx != null ? opts.heightPx : 2;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const img = ctx.getImageData(0, 0, w, h);
  const src = img.data;
  let minX = w, maxX = -1, lowY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (src[(y * w + x) * 4 + 3] < 8) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y > lowY) lowY = y;
    }
  }
  if (maxX < 0) return canvas;
  const cx = Math.round((minX + maxX) / 2);
  const ry = heightPx;
  const rx = Math.round(((maxX - minX + 1) * widthScale) / 2);
  const cy = lowY + offsetY;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  for (let dy = -ry; dy <= ry; dy++) {
    for (let dx = -rx; dx <= rx; dx++) {
      const fx = dx / rx, fy = dy / ry;
      if (fx * fx + fy * fy > 1) continue;
      const px = cx + dx, py = cy + dy;
      if (px < 0 || py < 0 || px >= w || py >= h) continue;
      if (src[(py * w + px) * 4 + 3] >= 8) continue;
      ctx.fillRect(px, py, 1, 1);
    }
  }
  ctx.restore();
  return canvas;
}

// ── Bevel edge ────────────────────────────────────────────────────────

// bevelEdge — paints a 1-pixel UI/mechanical bevel: lit color on
// top + left silhouette edges, shaded color on bottom + right.
// Standard for buttons, panels, weapons, machinery.
export function bevelEdge(canvas, opts = {}) {
  const lit = opts.lit || '#ffffff';
  const shade = opts.shade || '#000000';
  const alpha = opts.alpha != null ? opts.alpha : 1;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const img = ctx.getImageData(0, 0, w, h);
  const src = img.data;
  const dst = new Uint8ClampedArray(src);
  const opaque = (x, y) =>
    x >= 0 && y >= 0 && x < w && y < h && src[(y * w + x) * 4 + 3] >= 8;
  const litRgb = parseColor(lit);
  const shadeRgb = parseColor(shade);
  const A = Math.round(alpha * 255);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!opaque(x, y)) continue;
      const isTop  = !opaque(x, y - 1);
      const isLeft = !opaque(x - 1, y);
      const isBot  = !opaque(x, y + 1);
      const isRight= !opaque(x + 1, y);
      const i = (y * w + x) * 4;
      if (isTop || isLeft) {
        dst[i]     = litRgb.r;
        dst[i + 1] = litRgb.g;
        dst[i + 2] = litRgb.b;
        dst[i + 3] = A;
      } else if (isBot || isRight) {
        dst[i]     = shadeRgb.r;
        dst[i + 1] = shadeRgb.g;
        dst[i + 2] = shadeRgb.b;
        dst[i + 3] = A;
      }
    }
  }
  ctx.putImageData(new ImageData(dst, w, h), 0, 0);
  return canvas;
}

// ── Atmospheric scatter ───────────────────────────────────────────────

// dust — sparse particle scatter: dust motes in a sunbeam, spores
// drifting around a mushroom, snow flecks, magical sparkles.
//
// Specular pinpoint — concentrated brightest-palette stamp at the
// silhouette's curvature peak on the lit side. This is the single
// highest-impact addition to the quality-leap recipe: a 1-3px hot
// spot is what makes a sphere read as "glossy" vs just "shaded".
//
// We find the peak by taking a moment along the light direction:
// for every solid pixel, compute the dot product against (-lightDx,
// -lightDy); the pixel with the maximum dot is the lit-side curvature
// peak. Stamp the brightest stop there (and 1-2 neighbors if `size>1`).
//
//   color      — brightest palette stop (e.g. palette[palette.length-1])
//   lightDx, lightDy — light direction (matches formShade)
//   size       — 1 = single pixel, 2 = 1+2 neighbors, 3 = small disc
export function specularHighlight(canvas, opts = {}) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const {
    color = '#ffffff',
    lightDx = -0.7, lightDy = -0.7,
    size = 2,
  } = opts;
  const data = ctx.getImageData(0, 0, W, H).data;
  // Find centroid of solid pixels (anchor for offset normalization).
  let sumX = 0, sumY = 0, count = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (data[(y * W + x) * 4 + 3] === 0) continue;
      sumX += x; sumY += y; count++;
    }
  }
  if (count === 0) return;
  const cx = sumX / count, cy = sumY / count;
  // Find lit-side peak: pixel with max dot product against -light.
  let bestX = -1, bestY = -1, bestDot = -Infinity;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (data[(y * W + x) * 4 + 3] === 0) continue;
      const dot = -((x - cx) * lightDx + (y - cy) * lightDy);
      if (dot > bestDot) { bestDot = dot; bestX = x; bestY = y; }
    }
  }
  if (bestX < 0) return;
  ctx.fillStyle = color;
  ctx.fillRect(bestX, bestY, 1, 1);
  if (size >= 2) {
    // Two neighboring pixels along the light direction (toward center)
    const nx = bestX + Math.sign(lightDx) || 1;
    const ny = bestY + Math.sign(lightDy) || 1;
    if (data[(bestY * W + nx) * 4 + 3] > 0) ctx.fillRect(nx, bestY, 1, 1);
    if (data[(ny * W + bestX) * 4 + 3] > 0) ctx.fillRect(bestX, ny, 1, 1);
  }
  if (size >= 3) {
    // Add a 4th pixel diagonally for a small specular disc
    const nx = bestX + (Math.sign(lightDx) || 1);
    const ny = bestY + (Math.sign(lightDy) || 1);
    if (data[(ny * W + nx) * 4 + 3] > 0) ctx.fillRect(nx, ny, 1, 1);
  }
}

// Ambient occlusion — darken pixels on the silhouette boundary that
// sit in concave pockets, plus a faint contact-shadow ring along the
// underside. CRITICAL: only fires on *boundary* pixels (those with
// at least one transparent 8-neighbor), never on interiors. A solid
// convex shape gets only a faint contact shadow at its bottom; a
// shape with inner corners (L-junction, peanut-of-two-orbs) gets
// strong darkening at the corner crease.
//
// Boundary classification by transparent-neighbor count:
//   0           → interior, skip entirely
//   1-2         → concave pocket, heavy AO
//   3-5 + below → convex underside, faint contact-shadow AO
//   3-5 + above → convex top edge, no AO (light reaches it)
//   6+          → near-isolated speckle pixel, skip
//
//   color     — AO darkening color (use palette[0] or a darker tone)
//   strength  — 0..1 alpha multiplier (default 0.4)
//   underBias — 0..1, how strongly contact-shadow tracks underside
//               (1 = only bottom-edge AO, 0 = uniform contact ring)
export function ambientOcclusion(canvas, opts = {}) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const { color = '#000', strength = 0.4, underBias = 0.6 } = opts;
  const src = ctx.getImageData(0, 0, W, H);
  const d = src.data;
  const isSolid = (x, y) => {
    if (x < 0 || x >= W || y < 0 || y >= H) return false;
    return d[(y * W + x) * 4 + 3] > 0;
  };
  const tgt = parseColor(color);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!isSolid(x, y)) continue;
      let transparent = 0, transparentBelow = 0, transparentAbove = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          if (!isSolid(x + dx, y + dy)) {
            transparent++;
            if (dy > 0) transparentBelow++;
            else if (dy < 0) transparentAbove++;
          }
        }
      }
      // Interior pixel — light reaches it through ambient, no AO.
      if (transparent === 0) continue;
      // Speckle / lone pixel — skip (cleanIsolatedPixels handles those).
      if (transparent >= 6) continue;

      let weight;
      if (transparent <= 2) {
        // Concave pocket: deep AO. Count of 1 → 1.0, 2 → 0.8.
        weight = 1.0 - (transparent - 1) * 0.2;
      } else {
        // Convex edge. AO only on the underside (light blocked from above).
        // For perfect convex top edges (transparentAbove > transparentBelow),
        // skip — they catch ambient light.
        if (transparentBelow <= transparentAbove) continue;
        // Faint contact-shadow scaling with how much of the gap is below.
        weight = 0.35 * (transparentBelow / 3);
      }
      const dirBias = (1 - underBias) + underBias * (transparentBelow / 3);
      const w = weight * strength * dirBias;
      const idx = (y * W + x) * 4;
      d[idx]     = Math.round(d[idx]     * (1 - w) + tgt.r * w);
      d[idx + 1] = Math.round(d[idx + 1] * (1 - w) + tgt.g * w);
      d[idx + 2] = Math.round(d[idx + 2] * (1 - w) + tgt.b * w);
    }
  }
  ctx.putImageData(src, 0, 0);
}

// Bounced light — soft warm fill on the shadow-side bottom edge,
// suggesting light reflected from the ground back onto the underside
// of the form. This is the subtle complement to subsurfaceRim: rim is
// the lit-edge glow, bounce is the shadow-edge warm fill.
//
// We find pixels on the shadow side (negative dot vs light) AND on
// the lower half of the form, then blend a warm tint into them. The
// effect should be subtle — usually `strength` around 0.15-0.25.
//
//   color    — bounced fill color (warm earth tone for ground bounce,
//              cool blue-white for snow/water bounce)
//   lightDx, lightDy — light direction
//   strength — 0..1 alpha (default 0.2)
//   reach    — 0..1, how far up the shadow side bounce travels
//              (default 0.4 = bottom 40%)
export function bouncedLight(canvas, opts = {}) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const {
    color = '#806040',
    lightDx = -0.7, lightDy = -0.7,
    strength = 0.2,
    reach = 0.4,
  } = opts;
  const src = ctx.getImageData(0, 0, W, H);
  const d = src.data;
  // Find form bbox + centroid (so the algorithm works for any sprite size).
  let sumX = 0, sumY = 0, count = 0;
  let minY = H, maxY = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (d[(y * W + x) * 4 + 3] === 0) continue;
      sumX += x; sumY += y; count++;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (count === 0) return;
  const cx = sumX / count, cy = sumY / count;
  const formH = Math.max(1, maxY - minY);
  const reachY = maxY - formH * reach;
  const tgt = parseColor(color);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = (y * W + x) * 4;
      if (d[idx + 3] === 0) continue;
      // Shadow side: dot product against light is negative.
      const dot = (x - cx) * lightDx + (y - cy) * lightDy;
      if (dot < 0) continue;
      // Lower portion only.
      if (y < reachY) continue;
      // Falloff: stronger near the very bottom + shadow-most pixels.
      const yT = (y - reachY) / Math.max(1, maxY - reachY);
      const dotT = Math.min(1, dot / Math.max(1, formH * 0.5));
      const w = strength * yT * dotT;
      d[idx]     = Math.round(d[idx]     * (1 - w) + tgt.r * w);
      d[idx + 1] = Math.round(d[idx + 1] * (1 - w) + tgt.g * w);
      d[idx + 2] = Math.round(d[idx + 2] * (1 - w) + tgt.b * w);
    }
  }
  ctx.putImageData(src, 0, 0);
}

// Cluster enforcement — eliminates 1-2 pixel value-noise dots that
// don't belong by replacing any pixel whose color does not appear in
// at least `minCluster` adjacent pixels with the dominant 8-neighbor
// color. Use AFTER speckleTexture / antiJaggy / quantizeToPalette to
// clean stray-pixel noise that visually reads as artifacts rather
// than texture. Distinct from cleanIsolatedPixels which only removes
// fully-orphaned single pixels — this targets *value clusters*.
//
//   minCluster  — minimum same-color neighborhood size to keep (default 2)
export function enforceClusters(canvas, opts = {}) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const { minCluster = 2 } = opts;
  const src = ctx.getImageData(0, 0, W, H);
  const d = src.data;
  const out = new Uint8ClampedArray(d);
  const sameRGB = (i, j) =>
    d[i] === d[j] && d[i+1] === d[j+1] && d[i+2] === d[j+2] && d[i+3] > 0 && d[j+3] > 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = (y * W + x) * 4;
      if (d[idx + 3] === 0) continue;
      // Count same-color 8-neighbors.
      let same = 0;
      const counts = new Map();   // color → count for dominant lookup
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          const nIdx = (ny * W + nx) * 4;
          if (d[nIdx + 3] === 0) continue;
          if (sameRGB(idx, nIdx)) same++;
          const key = (d[nIdx] << 16) | (d[nIdx+1] << 8) | d[nIdx+2];
          counts.set(key, (counts.get(key) || 0) + 1);
        }
      }
      if (same >= minCluster) continue;
      // Replace with dominant neighbor color.
      let bestKey = null, bestCount = 0;
      for (const [k, v] of counts) {
        if (v > bestCount) { bestCount = v; bestKey = k; }
      }
      if (bestKey == null || bestCount < 2) continue;
      out[idx]     = (bestKey >> 16) & 0xff;
      out[idx + 1] = (bestKey >>  8) & 0xff;
      out[idx + 2] = bestKey & 0xff;
    }
  }
  src.data.set(out);
  ctx.putImageData(src, 0, 0);
}

// opts:
//   density      0..1 fraction of pixels dotted (default 0.03)
//   colors       array of color strings, per-pixel pick is random
//   rng          seeded RNG (default = rng(1))
//   minAlpha     0..1 (default 0.4) — bottom of alpha jitter range
//   alphaJitter  bool (default true) — vary alpha per dot for soft feel
export function dust(ctx, x, y, w, h, opts = {}) {
  const density = opts.density != null ? opts.density : 0.03;
  const colors = opts.colors || ['#ffffff'];
  const r = opts.rng || rng(1);
  const minAlpha = opts.minAlpha != null ? opts.minAlpha : 0.4;
  const alphaJitter = opts.alphaJitter !== false;
  const prevA = ctx.globalAlpha;
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      if (r() > density) continue;
      ctx.fillStyle = colors[Math.floor(r() * colors.length)];
      ctx.globalAlpha = alphaJitter
        ? prevA * (minAlpha + r() * (1 - minAlpha))
        : prevA;
      ctx.fillRect(x + px, y + py, 1, 1);
    }
  }
  ctx.globalAlpha = prevA;
}

// ──────────────────────────────────────────────────────────────────────
// Decoration primitives — post-process effects (rewritten from scratch)
// ──────────────────────────────────────────────────────────────────────
// Each primitive is a proper post-processing pass that ENHANCES the
// existing canvas rather than stamping single-color marks.
//
// Three composite categories:
//   ADDITIVE    (sparkles, halo, rays, lightning, frost highlights,
//                bubbles catchlights, sun glints) — uses 'lighter'
//                blend so highlights brighten whatever is beneath
//   SUBTRACTIVE (stains, shadow drips, soot, wear darkening) — uses
//                'multiply' or manual darken so they tint underlying
//                color rather than overwriting
//   STAMPED     (rivets, runes, stitches) — proper Lambert-shaded
//                multi-pixel patterns with highlight + body + shadow
//                stops, drawn over but with anti-isolated rules so
//                they don't float
//
// Internal helper: shaded falloff rendering. Most decorations use a
// 3-stop pattern (core / mid / edge) instead of a single color; the
// `_falloffStops(t, stops)` helper picks the right stop based on
// distance/alpha.

// Pick the right stop from a 3-stop palette by normalized t (0..1).
// 0..0.33 → core, 0.33..0.66 → mid, 0.66..1.0 → edge.
function _stop3(t, stops) {
  if (t < 0.33) return stops[0];
  if (t < 0.66) return stops[1];
  return stops[2];
}
// Manual 'lighter' blend a color into a pixel (RGB additive, alpha max).
function _addPixel(d, idx, r, g, b, intensity) {
  const ia = Math.min(1, intensity);
  d[idx]     = Math.min(255, d[idx]     + r * ia);
  d[idx + 1] = Math.min(255, d[idx + 1] + g * ia);
  d[idx + 2] = Math.min(255, d[idx + 2] + b * ia);
  if (d[idx + 3] === 0) d[idx + 3] = Math.round(255 * ia);
}
// Multiply blend (subtractive — darkens underlying color toward target).
function _multiplyPixel(d, idx, r, g, b, intensity) {
  const ia = Math.min(1, intensity);
  d[idx]     = Math.round(d[idx]     * (1 - ia) + (d[idx]     * r / 255) * ia);
  d[idx + 1] = Math.round(d[idx + 1] * (1 - ia) + (d[idx + 1] * g / 255) * ia);
  d[idx + 2] = Math.round(d[idx + 2] * (1 - ia) + (d[idx + 2] * b / 255) * ia);
}

// Sparkles — additive twinkles with proper diamond falloff. Each sparkle
// is a 3-stop diamond: hot core (1px white) + warm mid (4 cardinals) +
// faint outer halo (4 corners + extended cardinals at lower intensity).
// All blended with 'lighter' so they brighten whatever's underneath.
export function sparkles(ctx, x, y, w, h, opts = {}) {
  const {
    count = 8,
    coreColor   = '#ffffff',
    midColor    = '#ffe0a0',
    glowColor   = '#ffaa40',
    kind = 'star',          // 'star' | 'plus' | 'dot'
    size = 1,
    rng: rng_ = rng(7),
  } = opts;
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  const core  = parseColor(coreColor);
  const mid   = parseColor(midColor);
  const glow  = parseColor(glowColor);
  const stamp = (cx, cy, dx, dy, color, intensity) => {
    const px = cx + dx, py = cy + dy;
    if (px < 0 || px >= W || py < 0 || py >= H) return;
    _addPixel(d, (py * W + px) * 4, color.r, color.g, color.b, intensity);
  };
  for (let i = 0; i < count; i++) {
    const cx = x + Math.floor(rng_() * w);
    const cy = y + Math.floor(rng_() * h);
    // Outer halo (8 corners + extended cardinals at low intensity)
    if (size >= 1) {
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const m = Math.abs(dx) + Math.abs(dy);
          if (m === 0 || m > 3) continue;
          if (m === 1) continue;            // skip cardinals (mid stop fills these)
          const intensity = m === 2 ? 0.35 : 0.15;
          stamp(cx, cy, dx, dy, glow, intensity);
        }
      }
    }
    if (kind !== 'dot') {
      // Cardinals — mid stop, ~70% intensity
      stamp(cx, cy, -1, 0, mid, 0.85);
      stamp(cx, cy,  1, 0, mid, 0.85);
      stamp(cx, cy,  0,-1, mid, 0.85);
      stamp(cx, cy,  0, 1, mid, 0.85);
      if (kind === 'star') {
        stamp(cx, cy, -1,-1, mid, 0.5);
        stamp(cx, cy,  1, 1, mid, 0.5);
        stamp(cx, cy, -1, 1, mid, 0.5);
        stamp(cx, cy,  1,-1, mid, 0.5);
      }
    }
    // Hot core — full intensity white
    stamp(cx, cy, 0, 0, core, 1);
  }
  ctx.putImageData(img, 0, 0);
}

// Scratches — proper 2-stop battle damage. Each scratch has a darker
// gouge line + a brighter highlight on the lit side. Reads underlying
// pixel brightness; only lands on pixels brighter than `minBrightness`
// (skips background / outline pixels).
export function scratches(ctx, x, y, w, h, opts = {}) {
  const {
    count = 6,
    gougeColor     = '#1a1a1a',
    highlightColor = '#ffffff',
    maxLength = 6,
    minBrightness = 60,           // skip pixels darker than this (luma)
    rng: rng_ = rng(11),
    lightDx = -1, lightDy = -1,    // highlight side
  } = opts;
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  const gouge = parseColor(gougeColor);
  const hi = parseColor(highlightColor);
  const lumaAt = (px, py) => {
    if (px < 0 || px >= W || py < 0 || py >= H) return 0;
    const idx = (py * W + px) * 4;
    return d[idx] * 0.3 + d[idx + 1] * 0.59 + d[idx + 2] * 0.11;
  };
  // Highlight offset — perpendicular to scratch direction
  for (let i = 0; i < count; i++) {
    const sx = x + Math.floor(rng_() * w);
    const sy = y + Math.floor(rng_() * h);
    if (lumaAt(sx, sy) < minBrightness) continue;
    const len = 2 + Math.floor(rng_() * maxLength);
    const dx = rng_() > 0.5 ? 1 : -1;
    const dy = rng_() > 0.5 ? 1 : -1;
    // Highlight side perpendicular to scratch direction
    const hx = -dy * (lightDx > 0 ? 1 : -1);
    const hy =  dx * (lightDy > 0 ? 1 : -1);
    for (let s = 0; s < len; s++) {
      const px = sx + s * dx, py = sy + s * dy;
      if (px < 0 || px >= W || py < 0 || py >= H) continue;
      if (lumaAt(px, py) < minBrightness) continue;
      const idx = (py * W + px) * 4;
      // Gouge: darken underlying pixel
      _multiplyPixel(d, idx, gouge.r, gouge.g, gouge.b, 0.85);
      // Highlight on opposite side (1px offset)
      const hpx = px + hx, hpy = py + hy;
      if (hpx >= 0 && hpx < W && hpy >= 0 && hpy < H) {
        const hidx = (hpy * W + hpx) * 4;
        if (d[hidx + 3] > 0) {
          _addPixel(d, hidx, hi.r, hi.g, hi.b, 0.4);
        }
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

// Drips — properly shaded vertical streaks with 3-stop body + teardrop
// bead. Each drip: darker shadow side (1px) + body (1px) + brighter
// catchlight on lit side (1px when len > 3). Bead at tip is a tiny
// shaded sphere (3 pixels: body + highlight + shadow).
export function drips(canvas, opts = {}) {
  const {
    color = '#a02020',
    shadowColor = null,         // auto-derived if null
    highlightColor = null,
    count = 4,
    maxLength = 6,
    rng: rng_ = rng(13),
    bead = true,
    lightDx = -0.7,
  } = opts;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  const main = parseColor(color);
  const shadow = shadowColor ? parseColor(shadowColor)
    : { r: Math.round(main.r * 0.55), g: Math.round(main.g * 0.55),
        b: Math.round(main.b * 0.55) };
  const hi = highlightColor ? parseColor(highlightColor)
    : { r: Math.min(255, Math.round(main.r * 1.3 + 40)),
        g: Math.min(255, Math.round(main.g * 1.3 + 40)),
        b: Math.min(255, Math.round(main.b * 1.3 + 40)) };
  // Find bottom-most solid pixel per column
  const bottomY = new Int16Array(W).fill(-1);
  for (let xx = 0; xx < W; xx++) {
    for (let yy = H - 1; yy >= 0; yy--) {
      if (d[(yy * W + xx) * 4 + 3] > 0) { bottomY[xx] = yy; break; }
    }
  }
  const litSide = lightDx < 0 ? -1 : 1;       // x offset of highlight
  const stamp = (px, py, c, intensity = 1) => {
    if (px < 0 || px >= W || py < 0 || py >= H) return;
    const idx = (py * W + px) * 4;
    d[idx]     = Math.round(d[idx]     * (1 - intensity) + c.r * intensity);
    d[idx + 1] = Math.round(d[idx + 1] * (1 - intensity) + c.g * intensity);
    d[idx + 2] = Math.round(d[idx + 2] * (1 - intensity) + c.b * intensity);
    d[idx + 3] = 255;
  };
  for (let i = 0; i < count; i++) {
    const x = Math.floor(rng_() * W);
    if (bottomY[x] < 0) continue;
    const len = 2 + Math.floor(rng_() * maxLength);
    for (let dy = 1; dy <= len; dy++) {
      const y = bottomY[x] + dy;
      if (y >= H) break;
      // Shadow side first (opposite of light)
      stamp(x - litSide, y, shadow, 0.7);
      // Main body
      stamp(x, y, main, 1);
      // Highlight on lit side (only on longer drips)
      if (len > 3 && dy > 0) stamp(x + litSide, y, hi, 0.5);
    }
    // Bead at tip — shaded teardrop: highlight + body + shadow
    if (bead && bottomY[x] + len + 1 < H) {
      const tipY = bottomY[x] + len + 1;
      stamp(x, tipY, main, 1);
      stamp(x + litSide, tipY, hi, 0.7);
      stamp(x - litSide, tipY, shadow, 0.7);
      stamp(x, tipY + 1, shadow, 0.5);
    }
  }
  ctx.putImageData(img, 0, 0);
}

// Stitches — proper 3-stop X marks: dark shadow line (1px) + thread
// body (1-2px) + bright highlight on lit side. Each stitch is now 3-4
// pixels wide visually, not just dot pattern.
export function stitches(ctx, x, y, length, opts = {}) {
  const {
    threadColor = '#3a2010',
    shadowColor = null,
    highlightColor = null,
    spacing = 4,
    axis = 'horizontal',
    lightDx = -0.7, lightDy = -0.7,
  } = opts;
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  const thread = parseColor(threadColor);
  const shadow = shadowColor ? parseColor(shadowColor)
    : { r: Math.round(thread.r * 0.4), g: Math.round(thread.g * 0.4),
        b: Math.round(thread.b * 0.4) };
  const hi = highlightColor ? parseColor(highlightColor)
    : { r: Math.min(255, thread.r + 80), g: Math.min(255, thread.g + 80),
        b: Math.min(255, thread.b + 80) };
  const stamp = (px, py, c, intensity = 1) => {
    if (px < 0 || px >= W || py < 0 || py >= H) return;
    const idx = (py * W + px) * 4;
    if (d[idx + 3] === 0) return;
    d[idx]     = Math.round(d[idx]     * (1 - intensity) + c.r * intensity);
    d[idx + 1] = Math.round(d[idx + 1] * (1 - intensity) + c.g * intensity);
    d[idx + 2] = Math.round(d[idx + 2] * (1 - intensity) + c.b * intensity);
  };
  const steps = Math.floor(length / spacing);
  for (let i = 0; i <= steps; i++) {
    const px = axis === 'horizontal' ? x + i * spacing : x;
    const py = axis === 'horizontal' ? y : y + i * spacing;
    // X cross — main thread pixels (4 diagonals)
    stamp(px - 1, py - 1, thread, 0.95);
    stamp(px + 1, py + 1, thread, 0.95);
    stamp(px - 1, py + 1, thread, 0.95);
    stamp(px + 1, py - 1, thread, 0.95);
    // Center pixel — slight indent shadow
    stamp(px, py, shadow, 0.6);
    // Highlight on the lit-side ends of the X
    const hx = lightDx < 0 ? -1 : 1, hy = lightDy < 0 ? -1 : 1;
    stamp(px + hx, py + hy, hi, 0.6);
  }
  ctx.putImageData(img, 0, 0);
}

// Rivets — fully-shaded 3D bumps. Each rivet is a 5-pixel sphere stamp
// with: dark shadow ring underneath (contact shadow), body, lit side
// highlight, brightest pinpoint. Properly directional based on light.
export function rivets(ctx, positions, opts = {}) {
  const {
    bodyColor   = '#888888',
    shadowColor = '#1a1a1a',
    highlightColor = '#f0f0f0',
    pinpointColor  = '#ffffff',
    radius = 1,
    lightDx = -0.7, lightDy = -0.7,
    contactShadow = true,
  } = opts;
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  const body = parseColor(bodyColor);
  const sh = parseColor(shadowColor);
  const hi = parseColor(highlightColor);
  const pin = parseColor(pinpointColor);
  const stamp = (px, py, c, intensity = 1) => {
    if (px < 0 || px >= W || py < 0 || py >= H) return;
    const idx = (py * W + px) * 4;
    if (d[idx + 3] === 0 && !contactShadow) return;
    d[idx]     = Math.round(d[idx]     * (1 - intensity) + c.r * intensity);
    d[idx + 1] = Math.round(d[idx + 1] * (1 - intensity) + c.g * intensity);
    d[idx + 2] = Math.round(d[idx + 2] * (1 - intensity) + c.b * intensity);
    d[idx + 3] = 255;
  };
  const lit_x = lightDx < 0 ? -1 : 1, lit_y = lightDy < 0 ? -1 : 1;
  const sh_x = -lit_x, sh_y = -lit_y;
  for (const [px, py] of positions) {
    // Contact shadow ring (1px below + 1px to shadow side, very faint)
    if (contactShadow) {
      stamp(px + sh_x * (radius + 1), py, sh, 0.3);
      stamp(px, py + sh_y * (radius + 1), sh, 0.3);
      stamp(px + sh_x, py + sh_y * (radius + 1), sh, 0.4);
    }
    // Body — diamond shape
    stamp(px, py, body, 1);
    if (radius >= 1) {
      stamp(px - 1, py, body, 1);
      stamp(px + 1, py, body, 1);
      stamp(px, py - 1, body, 1);
      stamp(px, py + 1, body, 1);
    }
    if (radius >= 2) {
      stamp(px - 2, py, body, 1);
      stamp(px + 2, py, body, 1);
      stamp(px, py - 2, body, 1);
      stamp(px, py + 2, body, 1);
      stamp(px - 1, py - 1, body, 1);
      stamp(px + 1, py + 1, body, 1);
      stamp(px - 1, py + 1, body, 1);
      stamp(px + 1, py - 1, body, 1);
    }
    // Shadow side (opposite of light) — darken bottom-right
    stamp(px + sh_x, py + sh_y, sh, 0.7);
    if (radius >= 1) stamp(px + sh_x, py, sh, 0.4);
    // Highlight side
    stamp(px + lit_x, py + lit_y, hi, 0.85);
    // Pinpoint — single brightest pixel slightly off-center toward light
    stamp(px + lit_x, py + lit_y, pin, 1);
  }
  ctx.putImageData(img, 0, 0);
}

// Halo ring — soft additive radial glow with proper distance falloff.
// Uses 'lighter' compositing so the ring brightens whatever is beneath.
// Falloff is smooth: pixels closer to the ideal radius are brighter.
export function haloRing(ctx, cx, cy, radius, opts = {}) {
  const {
    color = '#ffe080',
    thickness = 2,
    intensity = 0.7,
    falloff = 'smooth',     // 'smooth' | 'hard'
  } = opts;
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  const c = parseColor(color);
  const outerR = radius + thickness;
  for (let dy = -outerR - 1; dy <= outerR + 1; dy++) {
    for (let dx = -outerR - 1; dx <= outerR + 1; dx++) {
      const px = cx + dx, py = cy + dy;
      if (px < 0 || px >= W || py < 0 || py >= H) continue;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const t = (dist - radius) / thickness;        // -1 inside, 0 at ring, +1 outside
      let alpha;
      if (falloff === 'hard') {
        alpha = (t >= -0.5 && t <= 1) ? intensity : 0;
      } else {
        // Smooth: peak at ring, fall off both ways
        const u = Math.abs(t - 0.5);    // 0 at peak (just inside outer)
        if (u > 1.0) continue;
        alpha = intensity * (1 - u);
      }
      if (alpha <= 0) continue;
      _addPixel(d, (py * W + px) * 4, c.r, c.g, c.b, alpha);
    }
  }
  ctx.putImageData(img, 0, 0);
}

// Bubbles — properly shaded sphere stamps. Each bubble is a 4-stop
// pattern: dark rim outline (sphere edge) + body fill (faint interior)
// + bright catchlight (lit-side spot) + bright pinpoint. Uses additive
// for the catchlight only.
export function bubbles(ctx, x, y, w, h, opts = {}) {
  const {
    count = 6,
    rimColor   = '#80a0c0',
    bodyColor  = '#c0d8f0',
    highlightColor = '#ffffff',
    rng: rng_ = rng(17),
    lightDx = -0.7, lightDy = -0.7,
    minRadius = 1, maxRadius = 3,
  } = opts;
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  const rim = parseColor(rimColor);
  const body = parseColor(bodyColor);
  const hi = parseColor(highlightColor);
  const lit_x = lightDx < 0 ? -1 : 1, lit_y = lightDy < 0 ? -1 : 1;
  const stamp = (px, py, c, intensity, additive = false) => {
    if (px < 0 || px >= W || py < 0 || py >= H) return;
    const idx = (py * W + px) * 4;
    if (additive) {
      _addPixel(d, idx, c.r, c.g, c.b, intensity);
      return;
    }
    d[idx]     = Math.round(d[idx]     * (1 - intensity) + c.r * intensity);
    d[idx + 1] = Math.round(d[idx + 1] * (1 - intensity) + c.g * intensity);
    d[idx + 2] = Math.round(d[idx + 2] * (1 - intensity) + c.b * intensity);
    d[idx + 3] = 255;
  };
  for (let i = 0; i < count; i++) {
    const bx = x + Math.floor(rng_() * w);
    const by = y + Math.floor(rng_() * h);
    const r = minRadius + Math.floor(rng_() * (maxRadius - minRadius + 1));
    // Rim — pixel circle (manual to control intensity per pixel)
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (Math.abs(dist - r) > 0.6) continue;
        stamp(bx + dx, by + dy, rim, 0.85);
      }
    }
    // Faint body fill (semi-transparent toward water)
    for (let dy = -r + 1; dy <= r - 1; dy++) {
      for (let dx = -r + 1; dx <= r - 1; dx++) {
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > r - 0.5) continue;
        stamp(bx + dx, by + dy, body, 0.25);
      }
    }
    // Catchlight (additive bright pinpoint on lit side)
    stamp(bx + lit_x, by + lit_y, hi, 1, true);
    if (r >= 2) stamp(bx + lit_x * 2, by + lit_y, hi, 0.4, true);
  }
  ctx.putImageData(img, 0, 0);
}

// Lightning — three-layer bolt: faint outer glow (additive, broad) +
// inner glow (additive, narrow) + bright white core (1px). Multiple
// branches with thinning intensity.
export function lightning(ctx, x0, y0, x1, y1, opts = {}) {
  const {
    coreColor  = '#ffffff',
    glowColor  = '#fff080',
    outerColor = '#ffae40',
    segments = 8, jitter = 4,
    branches = 2,
    rng: rng_ = rng(19),
  } = opts;
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  const core = parseColor(coreColor);
  const glow = parseColor(glowColor);
  const outer = parseColor(outerColor);
  // Collect path points first, then render in 3 passes (outer→glow→core).
  function makePath(sx, sy, ex, ey, segs, jit) {
    const points = [[sx, sy]];
    let px = sx, py = sy;
    for (let s = 1; s <= segs; s++) {
      const t = s / segs;
      const tx = sx + (ex - sx) * t + (rng_() - 0.5) * jit;
      const ty = sy + (ey - sy) * t + (rng_() - 0.5) * jit;
      const dx = tx - px, dy = ty - py;
      const steps = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)));
      for (let i = 1; i <= steps; i++) {
        const ft = i / Math.max(1, steps);
        points.push([Math.round(px + dx * ft), Math.round(py + dy * ft)]);
      }
      px = tx; py = ty;
    }
    return points;
  }
  const paths = [makePath(x0, y0, x1, y1, segments, jitter)];
  for (let b = 0; b < branches; b++) {
    const t = 0.3 + rng_() * 0.4;
    const bx = x0 + (x1 - x0) * t + (rng_() - 0.5) * jitter;
    const by = y0 + (y1 - y0) * t + (rng_() - 0.5) * jitter;
    const len = 4 + Math.floor(rng_() * 4);
    const ang = Math.atan2(y1 - y0, x1 - x0) + (rng_() < 0.5 ? -0.7 : 0.7);
    paths.push(makePath(bx, by,
      bx + Math.cos(ang) * len, by + Math.sin(ang) * len,
      3, jitter * 0.6));
  }
  const stampAdd = (px, py, c, intensity) => {
    if (px < 0 || px >= W || py < 0 || py >= H) return;
    _addPixel(d, (py * W + px) * 4, c.r, c.g, c.b, intensity);
  };
  // Pass 1: outer glow (3px wide, faint)
  for (const path of paths) {
    const branchScale = path === paths[0] ? 1 : 0.6;
    for (const [px, py] of path) {
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > 2) continue;
          const a = (1 - dist / 2) * 0.4 * branchScale;
          stampAdd(px + dx, py + dy, outer, a);
        }
      }
    }
  }
  // Pass 2: inner glow (1-2px wide, brighter yellow)
  for (const path of paths) {
    const branchScale = path === paths[0] ? 1 : 0.7;
    for (const [px, py] of path) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > 1.2) continue;
          const a = (1 - dist) * 0.85 * branchScale;
          stampAdd(px + dx, py + dy, glow, a);
        }
      }
    }
  }
  // Pass 3: white-hot core
  for (const path of paths) {
    const branchScale = path === paths[0] ? 1 : 0.85;
    for (const [px, py] of path) {
      stampAdd(px, py, core, 1 * branchScale);
    }
  }
  ctx.putImageData(img, 0, 0);
}

// Stains — multi-stop wet-stain pattern. Multiplicative blend so the
// stain TINTS underlying color (preserving texture/lighting beneath).
// Pattern: dark wet core (saturated) + main body + feathered outer
// edge. Used for blood, oil, ink, dirt, water marks.
export function stains(ctx, x, y, w, h, opts = {}) {
  const {
    color     = '#702020',
    coreColor = null,
    count = 3,
    size = 4,
    intensity = 0.85,
    rng: rng_ = rng(23),
  } = opts;
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  const main = parseColor(color);
  const core = coreColor ? parseColor(coreColor)
    : { r: Math.round(main.r * 0.5), g: Math.round(main.g * 0.5),
        b: Math.round(main.b * 0.5) };
  for (let i = 0; i < count; i++) {
    const cx = x + Math.floor(rng_() * w);
    const cy = y + Math.floor(rng_() * h);
    const radius = size * (0.7 + rng_() * 0.5);
    for (let py = -radius; py <= radius; py++) {
      for (let px = -radius; px <= radius; px++) {
        const dist = Math.sqrt(px * px + py * py);
        if (dist > radius) continue;
        const ax = cx + px, ay = cy + py;
        if (ax < 0 || ax >= W || ay < 0 || ay >= H) continue;
        const idx = (ay * W + ax) * 4;
        if (d[idx + 3] === 0) continue;
        // Edge feather: drop ~40% of perimeter pixels
        const t = dist / radius;
        if (t > 0.7 && rng_() < 0.4) continue;
        // Core (inner 35%) is darker; outer is main color.
        const target = t < 0.35 ? core : main;
        const localIntensity = intensity * (1 - t * 0.4);
        _multiplyPixel(d, idx, target.r, target.g, target.b, localIntensity);
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

// Rays — radiating additive light beams with distance falloff. Each ray
// fades from bright at the inner gap to nothing at the tip. Multiple
// stop colors (core/mid) make the beams read as 3D shafts of light.
export function rays(ctx, cx, cy, opts = {}) {
  const {
    count = 12,
    length = 10,
    coreColor = '#ffffff',
    midColor  = '#ffe080',
    intensity = 0.85,
    gap = 4,
    angleOffset = 0,
  } = opts;
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  const core = parseColor(coreColor);
  const mid = parseColor(midColor);
  for (let i = 0; i < count; i++) {
    const ang = angleOffset + (i / count) * Math.PI * 2;
    const dx = Math.cos(ang), dy = Math.sin(ang);
    for (let s = gap; s < length + gap; s++) {
      const px = Math.round(cx + dx * s);
      const py = Math.round(cy + dy * s);
      if (px < 0 || px >= W || py < 0 || py >= H) continue;
      // Linear falloff toward the tip
      const t = (s - gap) / length;          // 0 at base, 1 at tip
      const a = intensity * (1 - t);
      const idx = (py * W + px) * 4;
      // Mix core white at base, mid color at tip
      const r = core.r * (1 - t) + mid.r * t;
      const g = core.g * (1 - t) + mid.g * t;
      const b = core.b * (1 - t) + mid.b * t;
      _addPixel(d, idx, r, g, b, a);
    }
  }
  ctx.putImageData(img, 0, 0);
}

// Runes — glowing inscriptions. Two-pass: dark engraving below + bright
// glyph on top. Optional outer glow for magical feel.
const RUNE_GLYPHS = [
  [[0,1,1,1,0],[1,0,0,0,1],[1,0,1,0,1],[1,0,0,0,1],[0,1,1,1,0]], // O+cross
  [[0,0,1,0,0],[0,1,0,1,0],[1,0,0,0,1],[1,1,1,1,1],[0,0,0,0,0]], // ▲
  [[1,1,1,1,1],[0,0,0,1,0],[0,0,1,0,0],[0,1,0,0,0],[1,1,1,1,1]], // Z
  [[0,1,1,1,0],[1,0,0,0,1],[0,1,0,1,0],[0,0,0,0,0],[0,0,1,0,0]], // eye
  [[1,0,0,0,1],[0,1,0,1,0],[0,0,1,0,0],[0,1,0,1,0],[1,0,0,0,1]], // X
];
export function runes(ctx, positions, opts = {}) {
  const {
    glyphColor = '#c080ff',
    shadowColor = '#1a0820',
    glowColor = '#ff80ff',
    glow = true,
    glyphs = RUNE_GLYPHS,
    rng: rng_ = rng(29),
  } = opts;
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  const glyph = parseColor(glyphColor);
  const sh = parseColor(shadowColor);
  const gl = parseColor(glowColor);
  for (const [px, py] of positions) {
    const g = glyphs[Math.floor(rng_() * glyphs.length)];
    const gh = g.length, gw = g[0].length;
    const ox = px - Math.floor(gw / 2);
    const oy = py - Math.floor(gh / 2);
    // Pass 1: outer glow (additive, around glyph pixels)
    if (glow) {
      for (let yy = 0; yy < gh; yy++) {
        for (let xx = 0; xx < gw; xx++) {
          if (!g[yy][xx]) continue;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              const ax = ox + xx + dx, ay = oy + yy + dy;
              if (ax < 0 || ax >= W || ay < 0 || ay >= H) continue;
              const idx = (ay * W + ax) * 4;
              if (d[idx + 3] === 0) continue;
              _addPixel(d, idx, gl.r, gl.g, gl.b, 0.3);
            }
          }
        }
      }
    }
    // Pass 2: dark engraving (1px shadow below/right of glyph)
    for (let yy = 0; yy < gh; yy++) {
      for (let xx = 0; xx < gw; xx++) {
        if (!g[yy][xx]) continue;
        const ax = ox + xx + 1, ay = oy + yy + 1;
        if (ax < 0 || ax >= W || ay < 0 || ay >= H) continue;
        const idx = (ay * W + ax) * 4;
        if (d[idx + 3] === 0) continue;
        _multiplyPixel(d, idx, sh.r, sh.g, sh.b, 0.7);
      }
    }
    // Pass 3: bright glyph fill
    for (let yy = 0; yy < gh; yy++) {
      for (let xx = 0; xx < gw; xx++) {
        if (!g[yy][xx]) continue;
        const ax = ox + xx, ay = oy + yy;
        if (ax < 0 || ax >= W || ay < 0 || ay >= H) continue;
        const idx = (ay * W + ax) * 4;
        d[idx] = glyph.r; d[idx + 1] = glyph.g; d[idx + 2] = glyph.b;
        d[idx + 3] = 255;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

// Edge wear — exposes underlying material at chipped edges. Doesn't
// just delete pixels; replaces them with a darker "exposed" tone so
// the wear reads as worn-through-to-darker-substrate, not just holes.
export function wearEdges(canvas, opts = {}) {
  const {
    intensity = 0.4,
    chipChance = 0.5,         // of wear pixels, this fraction become
                              // fully transparent (chips); others become
                              // darkened (exposed substrate).
    exposeColor = null,        // auto-derived from underlying if null
    rng: rng_ = rng(31),
  } = opts;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  const isSolid = (x, y) => {
    if (x < 0 || x >= W || y < 0 || y >= H) return false;
    return d[(y * W + x) * 4 + 3] > 0;
  };
  const exp = exposeColor ? parseColor(exposeColor) : null;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!isSolid(x, y)) continue;
      let exposed = false;
      for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
        if (!isSolid(x + dx, y + dy)) { exposed = true; break; }
      }
      if (!exposed) continue;
      if (rng_() > intensity) continue;
      const idx = (y * W + x) * 4;
      if (rng_() < chipChance) {
        d[idx + 3] = 0;       // full chip — see through
      } else {
        // Expose darker substrate
        if (exp) {
          d[idx] = exp.r; d[idx + 1] = exp.g; d[idx + 2] = exp.b;
        } else {
          d[idx]     = Math.round(d[idx]     * 0.45);
          d[idx + 1] = Math.round(d[idx + 1] * 0.45);
          d[idx + 2] = Math.round(d[idx + 2] * 0.45);
        }
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

// Frost — multi-layer crystalline buildup. Three passes: bright white
// crystals at boundary (top-biased), cyan/blue interior tint (subtle),
// random sparkle accents on top of the crystals.
export function frost(canvas, opts = {}) {
  const {
    crystalColor = '#ffffff',
    interiorColor = '#c0e0ff',
    sparkleColor = '#ffffff',
    density = 0.7,
    topBias = 0.7,
    interiorTint = 0.15,        // alpha of interior cyan tint
    sparkleCount = 3,
    rng: rng_ = rng(33),
  } = opts;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  const cr = parseColor(crystalColor);
  const inT = parseColor(interiorColor);
  const sp = parseColor(sparkleColor);
  const isSolid = (x, y) => {
    if (x < 0 || x >= W || y < 0 || y >= H) return false;
    return d[(y * W + x) * 4 + 3] > 0;
  };
  let minY = H, maxY = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (isSolid(x, y)) { if (y < minY) minY = y; if (y > maxY) maxY = y; break; }
    }
  }
  const formH = Math.max(1, maxY - minY);
  // Pass 1: interior cyan tint (subtle cool wash)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!isSolid(x, y)) continue;
      const yT = 1 - (y - minY) / formH;
      const idx = (y * W + x) * 4;
      _multiplyPixel(d, idx, inT.r, inT.g, inT.b, interiorTint * (0.5 + yT * 0.5));
    }
  }
  // Pass 2: white crystal buildup at boundary, top-biased
  const crystalSeeds = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!isSolid(x, y)) continue;
      let exposed = false;
      for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
        if (!isSolid(x + dx, y + dy)) { exposed = true; break; }
      }
      if (!exposed) continue;
      const yT = 1 - (y - minY) / formH;
      const localDensity = density * ((1 - topBias) + topBias * yT);
      if (rng_() < localDensity) {
        const idx = (y * W + x) * 4;
        d[idx] = cr.r; d[idx + 1] = cr.g; d[idx + 2] = cr.b;
        d[idx + 3] = 255;
        crystalSeeds.push([x, y]);
      }
    }
  }
  // Pass 3: sparkle accents (additive bright spots on a few crystals)
  for (let i = 0; i < sparkleCount && crystalSeeds.length > 0; i++) {
    const [x, y] = crystalSeeds[Math.floor(rng_() * crystalSeeds.length)];
    const idx = (y * W + x) * 4;
    _addPixel(d, idx, sp.r, sp.g, sp.b, 0.8);
    // Cardinal arms
    for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
      const ax = x + dx, ay = y + dy;
      if (ax < 0 || ax >= W || ay < 0 || ay >= H) continue;
      const aidx = (ay * W + ax) * 4;
      if (d[aidx + 3] > 0) _addPixel(d, aidx, sp.r, sp.g, sp.b, 0.5);
    }
  }
  ctx.putImageData(img, 0, 0);
}

// Moss — proper organic clumps. Each clump is a 3-stop pattern: dark
// shadow base (1-2px under clump) + body (medium green) + bright tips
// (1-2 px brighter green where light catches). Bottom-biased.
export function moss(canvas, opts = {}) {
  const {
    bodyColor = '#5a8030',
    shadowColor = '#2a4015',
    tipColor = '#9ab050',
    density = 0.4,
    bottomBias = 0.7,
    rng: rng_ = rng(35),
  } = opts;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  const isSolid = (x, y) => {
    if (x < 0 || x >= W || y < 0 || y >= H) return false;
    return d[(y * W + x) * 4 + 3] > 0;
  };
  const body = parseColor(bodyColor);
  const sh = parseColor(shadowColor);
  const tip = parseColor(tipColor);
  let minY = H, maxY = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (isSolid(x, y)) { if (y < minY) minY = y; if (y > maxY) maxY = y; break; }
    }
  }
  const formH = Math.max(1, maxY - minY);
  const stamp = (x, y, c, intensity) => {
    if (!isSolid(x, y)) return;
    const idx = (y * W + x) * 4;
    d[idx]     = Math.round(d[idx]     * (1 - intensity) + c.r * intensity);
    d[idx + 1] = Math.round(d[idx + 1] * (1 - intensity) + c.g * intensity);
    d[idx + 2] = Math.round(d[idx + 2] * (1 - intensity) + c.b * intensity);
  };
  // Seed clumps at boundary pixels
  const clumps = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!isSolid(x, y)) continue;
      let exposed = false;
      for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
        if (!isSolid(x + dx, y + dy)) { exposed = true; break; }
      }
      if (!exposed) continue;
      const yT = (y - minY) / formH;
      const localDensity = density * ((1 - bottomBias) + bottomBias * yT);
      if (rng_() < localDensity) clumps.push([x, y]);
    }
  }
  // Render each clump as a 3-stop blob (~3-5 pixels)
  for (const [x, y] of clumps) {
    // Shadow base (1px below + 1 to a side)
    stamp(x, y + 1, sh, 0.7);
    stamp(x + (rng_() < 0.5 ? -1 : 1), y, sh, 0.5);
    // Main body (3-pixel cluster)
    stamp(x, y, body, 1);
    stamp(x - 1, y, body, 0.8);
    stamp(x + 1, y, body, 0.8);
    if (rng_() < 0.5) stamp(x, y - 1, body, 0.7);
    // Tip highlight (1 bright pixel on top, occasionally)
    if (rng_() < 0.65) stamp(x + (rng_() < 0.5 ? -1 : 0), y - 1, tip, 0.85);
  }
  ctx.putImageData(img, 0, 0);
}

// ──────────────────────────────────────────────────────────────────────
// Bioluminescent / lush flora primitives
// ──────────────────────────────────────────────────────────────────────

// Glow spots — scattered bright additive spots with radial falloff.
// Unlike sparkles (geometric +/star pattern), each spot is a smooth
// 3×3 fade — reads as an organic glow node (firefly, glowing pore).
//
//   count       — number of spots
//   coreColor   — center pixel (brightest)
//   glowColor   — falloff color (default = coreColor)
//   radius      — falloff radius in pixels (1..3)
//   intensity   — base alpha at center (0..1)
//   silhouetteOnly — if true, only place on solid pixels of canvas
export function glowSpots(canvas, opts = {}) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const {
    count = 8,
    coreColor = '#ffffff',
    glowColor = '#a0e0ff',
    radius = 2,
    intensity = 1.0,
    silhouetteOnly = false,
    rng: r = rng(41),
    x: regionX = 0, y: regionY = 0,
    w: regionW = W, h: regionH = H,
  } = opts;
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  const core = parseColor(coreColor);
  const glow = parseColor(glowColor);
  const placed = [];
  for (let i = 0; i < count; i++) {
    const cx = regionX + Math.floor(r() * regionW);
    const cy = regionY + Math.floor(r() * regionH);
    if (silhouetteOnly) {
      if (cx < 0 || cx >= W || cy < 0 || cy >= H) continue;
      if (d[(cy * W + cx) * 4 + 3] === 0) continue;
    }
    placed.push([cx, cy]);
  }
  for (const [cx, cy] of placed) {
    // Outer falloff (radius 2-3, faint)
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const px = cx + dx, py = cy + dy;
        if (px < 0 || px >= W || py < 0 || py >= H) continue;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > radius) continue;
        const t = 1 - dist / radius;          // 1 at center, 0 at edge
        const a = intensity * t * t;          // squared falloff
        const idx = (py * W + px) * 4;
        const c = dist < 0.5 ? core : glow;
        _addPixel(d, idx, c.r, c.g, c.b, a);
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

// Glow aura — soft additive bloom around the silhouette. For each
// transparent pixel near a solid pixel, paint additive falloff based
// on distance from the nearest solid pixel. Result: silhouette appears
// to be radiating light into the surrounding background.
//
//   color     — glow color
//   reach     — pixels of bloom outside silhouette (1..6)
//   intensity — peak alpha at silhouette boundary
export function glowAura(canvas, opts = {}) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const { color = '#80ffd0', reach = 4, intensity = 0.7 } = opts;
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  const c = parseColor(color);
  // Two-pass distance transform (Manhattan approx is enough for small reach)
  // Pass 1: build distance map — 0 for solid, large for transparent
  const dist = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    dist[i] = d[i * 4 + 3] > 0 ? 0 : 255;
  }
  // Iterative dilation — cheap for small `reach`
  for (let r = 1; r <= reach; r++) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (dist[i] !== 255) continue;
        // Check 4-neighbors for distance r-1
        for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          if (dist[ny * W + nx] === r - 1) { dist[i] = r; break; }
        }
      }
    }
  }
  // Apply additive glow based on distance
  for (let i = 0; i < W * H; i++) {
    if (dist[i] === 0 || dist[i] === 255) continue;
    const t = 1 - (dist[i] - 1) / reach;     // 1 at boundary, 0 at edge
    const a = intensity * t * t;
    _addPixel(d, i * 4, c.r, c.g, c.b, a);
  }
  ctx.putImageData(img, 0, 0);
}

// Glow veins — thin additive curving lines through the silhouette
// interior. Generates N organic random walks, paints them additively
// in a glow color. Reads "like glowing capillaries" through translucent
// tissue.
//
//   count    — number of vein paths
//   color    — vein bright color
//   length   — pixels per vein
//   intensity — peak alpha
export function glowVeins(canvas, opts = {}) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const {
    color = '#80ffe0', count = 3, length = 14,
    intensity = 0.85, rng: rr = rng(43),
  } = opts;
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  const c = parseColor(color);
  // Find solid pixels to seed from
  const solids = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (d[(y * W + x) * 4 + 3] > 0) solids.push([x, y]);
    }
  }
  if (solids.length === 0) { ctx.putImageData(img, 0, 0); return; }
  for (let i = 0; i < count; i++) {
    let [x, y] = solids[Math.floor(rr() * solids.length)];
    let ang = rr() * Math.PI * 2;
    for (let s = 0; s < length; s++) {
      const xi = Math.round(x), yi = Math.round(y);
      if (xi < 0 || xi >= W || yi < 0 || yi >= H) break;
      const idx = (yi * W + xi) * 4;
      if (d[idx + 3] === 0) break;
      const t = 1 - s / length;          // brighter at start
      _addPixel(d, idx, c.r, c.g, c.b, intensity * (0.5 + t * 0.5));
      // Add 1-pixel side-glow
      const sx = xi + Math.round(Math.cos(ang + Math.PI / 2));
      const sy = yi + Math.round(Math.sin(ang + Math.PI / 2));
      if (sx >= 0 && sx < W && sy >= 0 && sy < H) {
        const sIdx = (sy * W + sx) * 4;
        if (d[sIdx + 3] > 0) _addPixel(d, sIdx, c.r, c.g, c.b, intensity * 0.4);
      }
      ang += (rr() - 0.5) * 0.6;
      x += Math.cos(ang);
      y += Math.sin(ang);
    }
  }
  ctx.putImageData(img, 0, 0);
}

// Berries — silhouette-aware berry clusters. Places N small clusters
// of 3-5 berries each at random points within the canvas's silhouette.
// Each berry is a 1-pixel sphere with proper highlight + shadow.
//
//   count           — number of berry clusters
//   color           — berry main color
//   highlightColor  — bright catchlight pixel (auto-derived if null)
//   berriesPerCluster — 2-5 berries per cluster
export function berries(canvas, opts = {}) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const {
    count = 4,
    color = '#c81818',
    highlightColor = null,
    shadowColor = null,
    berriesPerCluster = 4,
    rng: rr = rng(47),
  } = opts;
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  const main = parseColor(color);
  const hi = highlightColor ? parseColor(highlightColor)
    : { r: Math.min(255, main.r + 80), g: Math.min(255, main.g + 80),
        b: Math.min(255, main.b + 80) };
  const sh = shadowColor ? parseColor(shadowColor)
    : { r: Math.round(main.r * 0.45), g: Math.round(main.g * 0.45),
        b: Math.round(main.b * 0.45) };
  // Find solid pixels (interior only — skip rim) to seed from
  const seeds = [];
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      if (d[(y * W + x) * 4 + 3] === 0) continue;
      // Require all 4 neighbors solid (interior)
      let allSolid = true;
      for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
        if (d[((y + dy) * W + (x + dx)) * 4 + 3] === 0) { allSolid = false; break; }
      }
      if (allSolid) seeds.push([x, y]);
    }
  }
  if (seeds.length === 0) return;
  const stamp = (x, y, c, intensity = 1) => {
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    const idx = (y * W + x) * 4;
    if (d[idx + 3] === 0) return;
    d[idx]     = Math.round(d[idx]     * (1 - intensity) + c.r * intensity);
    d[idx + 1] = Math.round(d[idx + 1] * (1 - intensity) + c.g * intensity);
    d[idx + 2] = Math.round(d[idx + 2] * (1 - intensity) + c.b * intensity);
    d[idx + 3] = 255;
  };
  for (let c = 0; c < count; c++) {
    const [cx, cy] = seeds[Math.floor(rr() * seeds.length)];
    const n = 2 + Math.floor(rr() * berriesPerCluster);
    for (let b = 0; b < n; b++) {
      const bx = cx + Math.floor((rr() - 0.5) * 4);
      const by = cy + Math.floor((rr() - 0.5) * 3);
      // Each berry: 3-stop sphere — shadow below-right, body, highlight upper-left
      stamp(bx, by, main, 1);
      stamp(bx - 1, by, main, 0.85);
      stamp(bx + 1, by, main, 0.85);
      stamp(bx, by - 1, main, 0.85);
      stamp(bx, by + 1, sh, 0.7);
      stamp(bx + 1, by + 1, sh, 0.4);
      stamp(bx - 1, by - 1, hi, 0.6);  // catchlight
    }
  }
  ctx.putImageData(img, 0, 0);
}

// Cluster shadow lines — internal definition for canopies. Given a
// list of cluster centers + radii, paints 1-pixel dark arcs along
// each cluster's bottom-right (shadow side) restricted to solid pixels.
// Creates the "you can see individual leaf clumps" look that mature
// canopies have in reference art.
export function clusterShading(canvas, clusters, opts = {}) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const { color = '#1a2410', intensity = 0.6,
          lightDx = -0.7, lightDy = -0.85 } = opts;
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  const c = parseColor(color);
  const isSolid = (x, y) => {
    if (x < 0 || x >= W || y < 0 || y >= H) return false;
    return d[(y * W + x) * 4 + 3] > 0;
  };
  // Shadow side direction (opposite of light)
  const shx = -lightDx, shy = -lightDy;
  for (const cl of clusters) {
    const r = cl.radius;
    // Walk the cluster's lower-right arc
    for (let theta = -Math.PI * 0.1; theta < Math.PI * 1.1; theta += 0.15) {
      // Map theta range to the shadow-side arc
      const ang = Math.atan2(shy, shx) + theta - Math.PI / 2;
      const px = Math.round(cl.x + Math.cos(ang) * r * 0.85);
      const py = Math.round(cl.y + Math.sin(ang) * r * 0.85);
      if (!isSolid(px, py)) continue;
      const idx = (py * W + px) * 4;
      d[idx]     = Math.round(d[idx]     * (1 - intensity) + c.r * intensity);
      d[idx + 1] = Math.round(d[idx + 1] * (1 - intensity) + c.g * intensity);
      d[idx + 2] = Math.round(d[idx + 2] * (1 - intensity) + c.b * intensity);
    }
  }
  ctx.putImageData(img, 0, 0);
}

// ──────────────────────────────────────────────────────────────────────
// Lighting decoration primitives
// ──────────────────────────────────────────────────────────────────────
// All additive (lighter) blend so they brighten what's beneath
// instead of replacing it. Multi-stop where useful — bright core +
// warm fade for natural light bloom.

// Shine — diagonal gleam stripe across a surface. The "moving highlight
// on polished metal" effect. Three-stripe by default (faint+bright+faint)
// for soft falloff perpendicular to the gleam direction. Optionally
// silhouette-aware so the shine clips to the form.
//
//   angle           — degrees, 0 = horizontal, -45 = top-right to bottom-left
//   thickness       — 1 = single line, 3 = 3-stripe gleam
//   color           — gleam color (default white)
//   intensity       — 0..1 peak alpha
//   silhouetteOnly  — if true, only paint on solid pixels
export function shine(ctx, x, y, w, h, opts = {}) {
  const {
    angle = -45,
    thickness = 3,
    color = '#ffffff',
    intensity = 0.85,
    silhouetteOnly = false,
    offset = null,         // pixel offset along normal — null = auto-center
  } = opts;
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  const c = parseColor(color);
  const ang = angle * Math.PI / 180;
  const dx = Math.cos(ang), dy = Math.sin(ang);
  // Perpendicular direction
  const px = -dy, py = dx;
  const cx = x + w / 2, cy = y + h / 2;
  const oNorm = offset != null ? offset : 0;
  const half = Math.floor(thickness / 2);
  // For each pixel in region, compute distance from the central
  // gleam line; if within half+1 pixels, paint with falloff.
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      if (xx < 0 || xx >= W || yy < 0 || yy >= H) continue;
      const idx = (yy * W + xx) * 4;
      if (silhouetteOnly && d[idx + 3] === 0) continue;
      // Project (xx-cx, yy-cy) onto perpendicular axis
      const proj = (xx - cx) * px + (yy - cy) * py - oNorm;
      const dist = Math.abs(proj);
      if (dist > half + 0.5) continue;
      // Center band brightest, edges fade
      const t = 1 - dist / (half + 0.5);
      _addPixel(d, idx, c.r, c.g, c.b, intensity * t * t);
    }
  }
  ctx.putImageData(img, 0, 0);
}

// Glint — single hot pinpoint of light. Smallest possible lighting
// primitive: 1 bright center pixel + 4 cardinal half-bright pixels.
// Additive blend.
export function glint(ctx, x, y, opts = {}) {
  const {
    color = '#ffffff',
    intensity = 1.0,
  } = opts;
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  const c = parseColor(color);
  const stamp = (px, py, alpha) => {
    if (px < 0 || px >= W || py < 0 || py >= H) return;
    _addPixel(d, (py * W + px) * 4, c.r, c.g, c.b, alpha);
  };
  stamp(x, y, intensity);
  stamp(x - 1, y, intensity * 0.5);
  stamp(x + 1, y, intensity * 0.5);
  stamp(x, y - 1, intensity * 0.5);
  stamp(x, y + 1, intensity * 0.5);
  ctx.putImageData(img, 0, 0);
}

// Gleam — small triangular highlight at a corner. The "shiny corner"
// effect: 3-pixel triangular glow indicating the lit-side of an
// object. Position controls which corner.
//
//   corner — 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
//   size   — 1 = 3-pixel triangle, 2 = 6-pixel
export function gleam(ctx, x, y, opts = {}) {
  const {
    color = '#ffffff',
    intensity = 0.95,
    corner = 'top-left',
    size = 2,
  } = opts;
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  const c = parseColor(color);
  const sx = corner.includes('right') ? -1 : 1;
  const sy = corner.includes('bottom') ? -1 : 1;
  const stamp = (px, py, alpha) => {
    if (px < 0 || px >= W || py < 0 || py >= H) return;
    if (d[(py * W + px) * 4 + 3] === 0) return;       // silhouette-aware
    _addPixel(d, (py * W + px) * 4, c.r, c.g, c.b, alpha);
  };
  // Triangle: corner pixel brightest, then 2 along edges
  for (let dy = 0; dy < size; dy++) {
    for (let dx = 0; dx < size - dy; dx++) {
      const t = 1 - (dx + dy) / size;
      stamp(x + dx * sx, y + dy * sy, intensity * t);
    }
  }
  ctx.putImageData(img, 0, 0);
}

// Spotlight — soft circular brightening on a canvas region. Like a
// stage light hitting a surface. Brightens existing pixels with
// quadratic radial falloff. Doesn't add new pixels (silhouette-aware).
export function spotlight(canvas, cx, cy, radius, opts = {}) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const {
    color = '#fffff0',
    intensity = 0.5,
    falloff = 'smooth',     // 'smooth' | 'linear' | 'sharp'
  } = opts;
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  const c = parseColor(color);
  const r2 = radius * radius;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || x >= W || y < 0 || y >= H) continue;
      const dist2 = dx * dx + dy * dy;
      if (dist2 > r2) continue;
      const idx = (y * W + x) * 4;
      const t = 1 - Math.sqrt(dist2) / radius;
      let alpha;
      if (falloff === 'sharp') alpha = intensity;
      else if (falloff === 'linear') alpha = intensity * t;
      else alpha = intensity * t * t;
      _addPixel(d, idx, c.r, c.g, c.b, alpha);
    }
  }
  ctx.putImageData(img, 0, 0);
}

// Sunbeam — directional shaft of light with 4-stop cross-section.
// Modeled after pixel-art reference (light streaming through window).
//
// Each row across the beam has FIVE bands by distance from the axis:
//   0.00..0.15  white core           (brightest)
//   0.15..0.45  bright cream         (high)
//   0.45..0.75  warm yellow mid      (medium)
//   0.75..1.00  faint outer halo     (low)
//   1.00..1.20  outer feather edge   (very low, optional)
//
// This produces the layered look you see in real pixel-art god-rays
// and window light: a clear bright "shaft" with a defined edge that
// reads as solid light, not a hazy bloom.
//
//   angle           — degrees, 0 = right, 90 = down
//   length          — beam length in pixels
//   widthStart      — beam half-pair width at source (default 8)
//   widthEnd        — width at tip (default = widthStart, parallel)
//   coreColor       — center stripe (default white)
//   brightColor     — bright cream band
//   midColor        — warm mid band
//   haloColor       — outermost faint halo
//   intensity       — overall scalar (1.0 = full)
//   tipFade         — how much intensity drops at the tip (0..1)
//                     0 = no fade, 0.7 = significant
//   featherEdge     — extra outer feather band beyond the main beam
export function sunbeam(ctx, cx, cy, opts = {}) {
  const {
    angle = 90,
    length = 28,
    widthStart = 8,
    widthEnd = null,
    coreColor = '#ffffff',
    brightColor = '#fff4b0',
    midColor = '#e8c060',
    haloColor = '#806030',
    intensity = 1.0,
    tipFade = 0.55,
    featherEdge = true,
  } = opts;
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  const core = parseColor(coreColor);
  const bright = parseColor(brightColor);
  const mid = parseColor(midColor);
  const halo = parseColor(haloColor);
  const ang = angle * Math.PI / 180;
  const dx = Math.cos(ang), dy = Math.sin(ang);
  const px = -dy, py = dx;
  const we = widthEnd != null ? widthEnd : widthStart;

  // Track painted pixels — outer-to-inner pass order means later
  // (brighter) bands overwrite earlier (dimmer) bands when stacked.
  const stamped = new Uint8Array(W * H);
  function blend(x, y, c, a) {
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    const idx = y * W + x;
    if (stamped[idx]) return;
    stamped[idx] = 1;
    _addPixel(d, idx * 4, c.r, c.g, c.b, a);
  }

  for (let s = 0; s < length; s++) {
    const t = s / Math.max(1, length - 1);
    const halfW = (widthStart + (we - widthStart) * t) * 0.5;
    if (halfW < 0.5) continue;

    const lenFade = 1 - t * tipFade;
    const baseX = cx + dx * s;
    const baseY = cy + dy * s;

    // Walk perpendicular OUTWARD-IN per row so brighter bands stamp last.
    // Use two-pass strategy: first paint outer feather + halo + mid,
    // then overwrite center with bright + core.

    // Pass 1: outer-to-mid bands
    const outerExtent = featherEdge ? halfW * 1.2 : halfW;
    for (let i = -Math.ceil(outerExtent); i <= Math.ceil(outerExtent); i++) {
      const x = Math.round(baseX + px * i);
      const y = Math.round(baseY + py * i);
      const u = Math.abs(i) / halfW;
      let c, a;
      if (u >= 1.0 && u <= 1.2 && featherEdge) {
        // Outer feather — very faint
        c = halo;
        a = intensity * lenFade * 0.18 * (1.2 - u) / 0.2;
      } else if (u >= 0.75 && u < 1.0) {
        // Halo band
        c = halo;
        a = intensity * lenFade * 0.45;
      } else if (u >= 0.45 && u < 0.75) {
        // Warm mid band
        c = mid;
        a = intensity * lenFade * 0.7;
      } else continue;
      blend(x, y, c, a);
    }
  }

  // Pass 2: bright + core stripes (uses fresh stamp tracker so they
  // override anything pass 1 painted in their bands)
  const stamped2 = new Uint8Array(W * H);
  function blend2(x, y, c, a) {
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    const idx = y * W + x;
    if (stamped2[idx]) return;
    stamped2[idx] = 1;
    _addPixel(d, idx * 4, c.r, c.g, c.b, a);
  }
  for (let s = 0; s < length; s++) {
    const t = s / Math.max(1, length - 1);
    const halfW = (widthStart + (we - widthStart) * t) * 0.5;
    if (halfW < 0.5) continue;
    const lenFade = 1 - t * tipFade;
    const baseX = cx + dx * s;
    const baseY = cy + dy * s;
    const brightExtent = halfW * 0.45;
    for (let i = -Math.ceil(brightExtent); i <= Math.ceil(brightExtent); i++) {
      const x = Math.round(baseX + px * i);
      const y = Math.round(baseY + py * i);
      const u = Math.abs(i) / halfW;
      let c, a;
      if (u <= 0.15) {
        // White core
        c = core;
        a = intensity * lenFade * 1.0;
      } else if (u <= 0.45) {
        // Bright cream band
        c = bright;
        a = intensity * lenFade * 0.95;
      } else continue;
      blend2(x, y, c, a);
    }
  }

  ctx.putImageData(img, 0, 0);
}

// Multiple parallel light shafts from a region — for the "sunlight
// streaming through forest canopy" effect. Casts N beams parallel to
// `angle` from positions spread perpendicular along `spread`.
//
//   count        — number of shafts
//   angle        — degrees, direction of travel for all shafts
//   length       — shaft length
//   width        — width of each individual shaft
//   spread       — pixels of perpendicular spread between shafts
//   intensityVar — 0..1, random per-shaft intensity variation
export function godRays(ctx, cx, cy, opts = {}) {
  const {
    count = 4, angle = 70, length = 22, width = 2, spread = 18,
    color = '#fff8c0', coreColor = '#ffffff', intensity = 0.6,
    intensityVar = 0.35,
    rng: rr = rng(67),
  } = opts;
  const ang = angle * Math.PI / 180;
  const px = -Math.sin(ang), py = Math.cos(ang);
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) / count - 0.5;       // -0.5..0.5
    const offset = t * spread + (rr() - 0.5) * 1.5;
    const beamCx = cx + px * offset;
    const beamCy = cy + py * offset;
    const beamIntensity = intensity * (1 - intensityVar * rr());
    const beamLen = length * (0.85 + rr() * 0.3);
    sunbeam(ctx, beamCx, beamCy, {
      angle, length: beamLen, widthStart: width,
      color, coreColor, intensity: beamIntensity,
    });
  }
}

// Lens flare — bright center + concentric faint rings + 4-way spokes.
// The "camera staring into the sun" effect. Use for sun representation,
// magic gem, energy core.
//
//   size       — center pinpoint radius (1-3)
//   spokes     — 0 = no radial spokes, N = number of spokes
//   ringCount  — concentric ring count (each ring at decreasing alpha)
export function flare(ctx, cx, cy, opts = {}) {
  const {
    color = '#fff8c0',
    coreColor = '#ffffff',
    size = 3,
    spokes = 4,
    spokeLength = 8,
    ringCount = 3,
  } = opts;
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  const cBase = parseColor(color);
  const core = parseColor(coreColor);
  const stamp = (x, y, c, a) => {
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    _addPixel(d, (y * W + x) * 4, c.r, c.g, c.b, a);
  };
  // Bright core
  for (let dy = -size; dy <= size; dy++) {
    for (let dx = -size; dx <= size; dx++) {
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > size) continue;
      const t = 1 - dist / size;
      const c = dist < 0.5 ? core : cBase;
      stamp(cx + dx, cy + dy, c, t * t);
    }
  }
  // Concentric rings — each at increasing radius and decreasing alpha
  for (let r = 1; r <= ringCount; r++) {
    const rr = size + r * 3;
    const a = 0.4 / r;
    for (let theta = 0; theta < Math.PI * 2; theta += 0.2) {
      const x = Math.round(cx + Math.cos(theta) * rr);
      const y = Math.round(cy + Math.sin(theta) * rr);
      stamp(x, y, cBase, a);
    }
  }
  // Radial spokes — 4-axis crosshair
  for (let i = 0; i < spokes; i++) {
    const ang = (i / spokes) * Math.PI * 2;
    const dx = Math.cos(ang), dy = Math.sin(ang);
    for (let s = size + 1; s <= spokeLength + size; s++) {
      const a = (1 - (s - size) / spokeLength) * 0.65;
      stamp(Math.round(cx + dx * s), Math.round(cy + dy * s), cBase, a);
    }
  }
  ctx.putImageData(img, 0, 0);
}

// Hanging vines — vertical drooping strokes from the bottom edge of a
// silhouette. Reference: jungletrees.dmi where vines droop from the
// canopy mass past the trunks. Each vine is a 1-pixel column with
// optional leaf clusters at intervals.
//
//   count           — number of vines to drop
//   color           — vine main color (defaults to dark organic)
//   leafColor       — color for small leaf accents along vine (null = no leaves)
//   minLength       — min vine length in pixels
//   maxLength       — max vine length
//   leafChance      — 0..1 probability of leaf accents on each vine
export function hangingVines(canvas, opts = {}) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const {
    count = 6,
    color = '#3a5018',
    leafColor = '#4a6020',
    minLength = 4, maxLength = 12,
    leafChance = 0.5,
    rng: rr = rng(53),
  } = opts;
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  // Find canopy bottom edges — solid pixels with transparent below
  const candidates = [];
  for (let y = 0; y < H - 1; y++) {
    for (let x = 0; x < W; x++) {
      const idx = (y * W + x) * 4;
      if (d[idx + 3] === 0) continue;
      const belowIdx = ((y + 1) * W + x) * 4;
      if (d[belowIdx + 3] === 0) candidates.push([x, y]);
    }
  }
  if (candidates.length === 0) return;
  const main = parseColor(color);
  const leaf = leafColor ? parseColor(leafColor) : null;
  for (let i = 0; i < count; i++) {
    const [sx, sy] = candidates[Math.floor(rr() * candidates.length)];
    const len = minLength + Math.floor(rr() * (maxLength - minLength + 1));
    let curX = sx;
    for (let s = 1; s <= len; s++) {
      const y = sy + s;
      if (y >= H) break;
      // Slight curve — drift x by +/-0.5 every few rows
      if (s % 3 === 0) curX += (rr() - 0.5) > 0 ? 1 : -1;
      if (curX < 0 || curX >= W) break;
      const idx = (y * W + curX) * 4;
      // Don't paint if a solid pixel exists (e.g., trunk in the way)
      if (d[idx + 3] > 0) continue;
      d[idx] = main.r; d[idx + 1] = main.g; d[idx + 2] = main.b; d[idx + 3] = 255;
      // Occasional leaf clump
      if (leaf && s > 2 && s % 4 === 0 && rr() < leafChance) {
        const lIdx = (y * W + (curX + (rr() < 0.5 ? -1 : 1))) * 4;
        if (lIdx >= 0 && d[lIdx + 3] === 0) {
          d[lIdx] = leaf.r; d[lIdx + 1] = leaf.g; d[lIdx + 2] = leaf.b; d[lIdx + 3] = 255;
        }
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

// Snow cap — heavy white buildup on TOP-FACING edges only. Use on
// conifers, ledges, hats — anything that catches snow from above.
// Reference: pinetrees.dmi where conifers wear thick snow on their
// upper-facing skirt edges.
//
//   density   — 0..1, fraction of top-edges to paint
//   color     — snow color (default near-white slight blue)
//   thickness — 1 = single pixel, 2 = stacks 1px above (snow piles up)
export function snowCap(canvas, opts = {}) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const {
    color = '#f0f8ff', density = 0.85, thickness = 1,
    rng: rr = rng(57),
  } = opts;
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  const c = parseColor(color);
  const isSolid = (x, y) =>
    x >= 0 && x < W && y >= 0 && y < H && d[(y * W + x) * 4 + 3] > 0;
  // Pass 1: paint white on top-edge pixels (solid with transparent above)
  const tops = [];
  for (let y = 1; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!isSolid(x, y)) continue;
      if (isSolid(x, y - 1)) continue;
      if (rr() > density) continue;
      tops.push([x, y]);
      const idx = (y * W + x) * 4;
      d[idx] = c.r; d[idx + 1] = c.g; d[idx + 2] = c.b; d[idx + 3] = 255;
    }
  }
  // Pass 2: pile up — paint snow 1-2 pixels ABOVE the top edge into
  // transparent space (suggesting snow accumulation on the surface).
  if (thickness >= 2) {
    for (const [x, y] of tops) {
      const py = y - 1;
      if (py < 0) continue;
      const idx = (py * W + x) * 4;
      if (d[idx + 3] === 0 && rr() < 0.6) {
        d[idx] = c.r; d[idx + 1] = c.g; d[idx + 2] = c.b; d[idx + 3] = 255;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

// Ornaments — decorative colorful gem-stop dots scattered on a
// silhouette. For Christmas tree lights, festival decorations,
// fruit accents. Each ornament is a single bright pixel in one of
// several colors.
//
//   colors   — array of color strings to rotate through
//   count    — number of ornaments to place
//   minSpacing — min pixel distance between any two ornaments
export function ornaments(canvas, opts = {}) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const {
    colors = ['#ff4040', '#ffe040', '#40d040', '#4080ff', '#e040c0'],
    count = 10,
    minSpacing = 2,
    rng: rr = rng(59),
  } = opts;
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  // Find solid pixels — ornaments only land on the silhouette
  const candidates = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (d[(y * W + x) * 4 + 3] > 0) candidates.push([x, y]);
    }
  }
  if (candidates.length === 0) return;
  const placed = [];
  let attempts = 0;
  while (placed.length < count && attempts < count * 10) {
    attempts++;
    const [x, y] = candidates[Math.floor(rr() * candidates.length)];
    let tooClose = false;
    for (const [px, py] of placed) {
      if (Math.abs(px - x) + Math.abs(py - y) < minSpacing) {
        tooClose = true; break;
      }
    }
    if (tooClose) continue;
    const c = parseColor(colors[Math.floor(rr() * colors.length)]);
    const idx = (y * W + x) * 4;
    d[idx] = c.r; d[idx + 1] = c.g; d[idx + 2] = c.b; d[idx + 3] = 255;
    placed.push([x, y]);
  }
  ctx.putImageData(img, 0, 0);
}

// Rust — multi-stop oxidation rings using multiplicative blend. Each
// rust spot has 4 stops: deep core (very dark) + body (orange-brown)
// + light edge (warm tan) + halo bleed (faint warm). Reads through to
// preserve underlying texture/lighting.
export function rust(canvas, opts = {}) {
  const {
    coreColor = '#3a1808',
    bodyColor = '#a04020',
    edgeColor = '#c87040',
    haloColor = '#705030',
    count = 6,
    size = 4,
    rng: rng_ = rng(37),
  } = opts;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  const isSolid = (x, y) =>
    x >= 0 && x < W && y >= 0 && y < H && d[(y * W + x) * 4 + 3] > 0;
  const core = parseColor(coreColor);
  const body = parseColor(bodyColor);
  const edge = parseColor(edgeColor);
  const halo = parseColor(haloColor);
  for (let i = 0; i < count; i++) {
    const cx = Math.floor(rng_() * W);
    const cy = Math.floor(rng_() * H);
    if (!isSolid(cx, cy)) continue;
    const radius = size * (0.7 + rng_() * 0.6);
    for (let py = -Math.ceil(radius + 1); py <= Math.ceil(radius + 1); py++) {
      for (let px = -Math.ceil(radius + 1); px <= Math.ceil(radius + 1); px++) {
        const ax = cx + px, ay = cy + py;
        if (!isSolid(ax, ay)) continue;
        const dist = Math.sqrt(px * px + py * py);
        const t = dist / radius;       // 0 at center, 1 at edge, >1 outside
        const idx = (ay * W + ax) * 4;
        let target, intensity;
        if (t < 0.25) { target = core; intensity = 0.95; }
        else if (t < 0.6) { target = body; intensity = 0.85; }
        else if (t < 1.0) {
          // Edge feather — drop ~30% of pixels
          if (rng_() < 0.3) continue;
          target = edge; intensity = 0.7;
        } else if (t < 1.3) {
          // Halo bleed — very subtle
          target = halo; intensity = 0.25;
        } else continue;
        _multiplyPixel(d, idx, target.r, target.g, target.b, intensity);
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

