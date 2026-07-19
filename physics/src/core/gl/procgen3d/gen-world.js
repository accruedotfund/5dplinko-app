// core/gl/procgen3d/gen-world.js — biomes, ecosystem placement, and structure/
// dungeon/cave stubs.
//
// biome + ecosystem are REAL-ish (priority domains): they return DATA, not meshes.
//   • BIOMES — descriptor table (temperature/humidity/elevation/fertility +
//     spawn rules). selectBiome(t,h,e) → name via nearest-descriptor match.
//   • generate('ecosystem', {seed,region,biome,heightFn?}) → blue-noise PLACEMENTS
//     [{generator, params, position:[x,y,z], rotationY, scale}] using poissonDisk
//     + per-biome weighted species. A component instantiates these via the registry.
// structure/dungeon/cave are mesh STUBS (BSP/marching-cubes land in their phase).

import { MeshBuilder } from './mesh-builder.js';
import { register, generate } from './registry.js';
import { rng, poissonDisk, weightedChoice, randRange } from '../../procgen.js';
import { heightField } from './gen-terrain.js';
import { makeNoise } from './noise3d.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const TAU = Math.PI * 2;

// forest GENERATIONS — the same biome at different life stages (spec: young/
// mature/ancient/burned/recovering). Multipliers reshape size/density/deadwood/
// understory so one forest can age or be told as having burned.
export const GENERATIONS = {
  young:      { treeScale: 0.6, treeDensity: 1.2, deadwood: 0.1, understory: 1.3 },
  mature:     { treeScale: 1.0, treeDensity: 1.0, deadwood: 0.4, understory: 1.0 },
  ancient:    { treeScale: 1.5, treeDensity: 0.8, deadwood: 0.9, understory: 0.7 },
  burned:     { treeScale: 1.0, treeDensity: 0.5, deadwood: 1.5, understory: 0.3, charred: true },
  recovering: { treeScale: 0.5, treeDensity: 1.4, deadwood: 1.0, understory: 1.5 },
};

// ── biome descriptors (0..1 axes) + spawn weights ────────────────────────────
export const BIOMES = {
  plains:     { temperature: 0.6, humidity: 0.4, elevation: 0.3, fertility: 0.6, ground: [0.42, 0.52, 0.26], spawn: { grass: 1, flower: 0.3, tree: 0.08, bush: 0.15, rock: 0.06 } },
  forest:     { temperature: 0.55, humidity: 0.7, elevation: 0.35, fertility: 0.9, ground: [0.24, 0.4, 0.2], spawn: { tree: 0.8, bush: 0.4, mushroom: 0.15, grass: 0.6, rock: 0.08 } },
  pineForest: { temperature: 0.35, humidity: 0.6, elevation: 0.6, fertility: 0.7, ground: [0.26, 0.36, 0.24], spawn: { tree: 0.7, bush: 0.2, rock: 0.12, grass: 0.3 } },
  swamp:      { temperature: 0.6, humidity: 0.95, elevation: 0.15, fertility: 0.8, ground: [0.28, 0.3, 0.2], spawn: { tree: 0.3, mushroom: 0.4, bush: 0.3, grass: 0.4 } },
  desert:     { temperature: 0.95, humidity: 0.05, elevation: 0.3, fertility: 0.1, ground: [0.78, 0.68, 0.42], spawn: { rock: 0.3, bush: 0.05 } },
  tundra:     { temperature: 0.1, humidity: 0.3, elevation: 0.5, fertility: 0.2, ground: [0.82, 0.85, 0.9], spawn: { rock: 0.2, bush: 0.06, tree: 0.04 } },
  mountains:  { temperature: 0.3, humidity: 0.4, elevation: 0.9, fertility: 0.3, ground: [0.5, 0.5, 0.52], spawn: { rock: 0.5, tree: 0.06, bush: 0.05 } },
  volcanic:   { temperature: 0.9, humidity: 0.2, elevation: 0.7, fertility: 0.1, ground: [0.2, 0.16, 0.16], spawn: { rock: 0.4 } },
  crystal:    { temperature: 0.5, humidity: 0.5, elevation: 0.6, fertility: 0.5, ground: [0.3, 0.28, 0.4], spawn: { rock: 0.3, mushroom: 0.2 } },
  corrupted:  { temperature: 0.5, humidity: 0.5, elevation: 0.5, fertility: 0.4, ground: [0.3, 0.2, 0.32], spawn: { tree: 0.4, mushroom: 0.3, rock: 0.1 } },
};

// nearest-descriptor biome from climate axes (weighted euclidean).
export function selectBiome(temperature = 0.5, humidity = 0.5, elevation = 0.5) {
  let best = 'plains', bd = Infinity;
  for (const [name, b] of Object.entries(BIOMES)) {
    const d = (b.temperature - temperature) ** 2 + (b.humidity - humidity) ** 2 + (b.elevation - elevation) ** 2 * 1.5;
    if (d < bd) { bd = d; best = name; }
  }
  return best;
}

// ── ECOLOGICAL placement — relationships, not random distribution ─────────────
// Drives species choice from layered influence FIELDS instead of flat weights, so
// the world generates clusters/clearings/tree-lines/outcrops/micro-biomes:
//   • grove field (low-freq)  → forest density: dense groves ↔ open clearings,
//     thinned to a TREE LINE at the region edge.
//   • moisture field          → mushrooms/understory favor damp shade.
//   • rock field (worley)     → rocks CLUSTER into outcrops, not uniform scatter.
//   • blight field            → dead patches / ghost stands (dead-tree variant).
//   • LIGHT COMPETITION       → grass/flowers suppressed under canopy, favored in
//     clearings; understory (bush/mushroom/moss) favored under canopy.
//   • MICRO-BIOMES emerge where fields cross thresholds (mushroom circle, rock
//     garden, dead patch) — tagged on each placement for downstream use.
export function generateEcosystem(params = {}, ctx = {}) {
  const seed = ctx.seed ?? params.seed ?? 1;
  const region = params.region || [-32, -32, 32, 32];
  const biome = BIOMES[params.biome] || BIOMES.plains;
  const spawn = params.spawn || biome.spawn;
  const fg = GENERATIONS[params.generation] || GENERATIONS.mature;
  const r = rng(seed);
  const n = makeNoise(seed);
  const hf = params.heightFn || (params.terrain ? heightField({ ...params.terrain, seed }) : () => 0);
  const w = region[2] - region[0], d = region[3] - region[1];
  const cx = (region[0] + region[2]) / 2, cz = (region[1] + region[3]) / 2;
  const edgeR = Math.min(w, d) / 2;
  const pts = poissonDisk({ rng: r, w, h: d, minDist: params.spacing ?? 3 });

  // influence fields at a world point → 0..1
  const grove = (x, z) => clamp01(n.sample2D(x * 0.03 + 11, z * 0.03 - 7) * 0.5 + 0.5);
  const moist = (x, z) => clamp01(n.sample2D(x * 0.05 - 31, z * 0.05 + 19) * 0.5 + 0.5);
  const rockF = (x, z) => clamp01(1 - n.cell2D(x * 0.06, z * 0.06));          // outcrop centers
  const blight = (x, z) => clamp01(n.sample2D(x * 0.04 + 71, z * 0.04 + 53) * 0.5 + 0.5);

  const out = [], micro = [];
  let idx = 0;
  for (const p of pts) {
    const x = region[0] + p.x, z = region[1] + p.y;
    // tree-line: forest thins toward the region boundary
    const edge = clamp01(1 - (Math.hypot(x - cx, z - cz) / edgeR - 0.6) / 0.4);
    const g = grove(x, z) * (0.35 + 0.65 * edge);
    const mo = moist(x, z), rk = rockF(x, z), bl = blight(x, z);
    const canopy = g;                       // shade under dense groves
    const light = 1 - canopy * 0.85;        // available light at the floor

    // context-weighted species (relationships) — biome base × field × generation
    const W = {
      tree: (spawn.tree || 0) * Math.pow(g, 1.5) * (1 - rk * 0.7) * fg.treeDensity,
      bush: (spawn.bush || 0) * (0.25 + canopy * 0.75) * fg.understory,
      mushroom: (spawn.mushroom || 0) * mo * (0.3 + canopy * 0.7) * fg.understory,
      flower: (spawn.flower || 0) * light * (1 - rk),
      grass: (spawn.grass || 0) * light,
      rock: (spawn.rock || 0.04) + rk * 0.9,
      // UNDERSTORY layers — forest floor is never empty (favored under canopy)
      moss: 0.5 * canopy * fg.understory,
      fern: 0.35 * canopy * mo * fg.understory,
      log: 0.4 * canopy * fg.deadwood,        // fallen deadwood (environmental story)
    };
    let tag = null, variant;
    // burned stands: trees are charred snags, floor sparse
    if (fg.charred && W.tree > 0.05) { variant = 'dead'; tag = 'burned'; W.flower = W.moss = W.fern = 0; }
    // micro-biomes from field crossings
    if (bl > 0.74) { W.tree *= 0.4; W.flower = W.grass = W.mushroom = 0; variant = 'dead'; tag = 'dead-patch'; }
    else if (rk > 0.82) { W.tree *= 0.2; W.flower *= 0.3; W.grass *= 0.3; W.rock += 1.2; tag = 'rock-garden'; }
    else if (mo > 0.78 && canopy > 0.6) { W.mushroom += 1.0; W.flower *= 0.4; tag = 'mushroom-circle'; }

    const species = Object.keys(W), weights = species.map((s) => W[s]);
    const total = weights.reduce((a, b) => a + b, 0);
    if (total < 0.05 || r() > Math.min(1, total * 0.9)) continue; // dead zones stay bare
    const gen = weightedChoice(r, species, weights);
    if (!spawn[gen] && gen !== 'rock') { /* allow rock fallback only */ }
    // ancient groves grow bigger trees; clearing/edge trees are younger/smaller
    const treeScale = gen === 'tree' ? (0.7 + g * 0.8) * fg.treeScale : randRange(r, 0.8, 1.25);
    // rock FORMATIONS: outcrops/gardens get geological styles, not just boulders
    let rockStyle;
    if (gen === 'rock') rockStyle = tag === 'rock-garden' ? (r() < 0.3 ? 'basalt' : 'spire') : (r() < 0.15 ? 'slab' : undefined);
    out.push({
      generator: gen,
      params: { seed: (seed * 131 + idx * 17) >>> 0,
        ...(variant && gen === 'tree' ? { variant } : {}),
        ...(rockStyle ? { style: rockStyle } : {}) },
      position: [x, hf(x, z), z],
      rotationY: randRange(r, 0, Math.PI * 2),
      scale: treeScale,
      cluster: tag,
    });
    if (tag && !micro.includes(tag)) micro.push(tag);
    idx++;
  }

  // ── LANDMARK: an ANCIENT tree at the densest grove point — a navigation anchor
  // the player can orient by (spec: "players navigate visually").
  if (params.landmark !== false) {
    let bestG = -1, bx = cx, bz = cz;
    for (let i = 0; i < 48; i++) { const sx = region[0] + r() * w, sz = region[1] + r() * d; const gg = grove(sx, sz); if (gg > bestG) { bestG = gg; bx = sx; bz = sz; } }
    out.push({ generator: 'tree', params: { seed: (seed * 977) >>> 0, variant: fg.charred ? 'dead' : 'giant' },
      position: [bx, hf(bx, bz), bz], rotationY: r() * TAU, scale: 2.6, cluster: 'landmark' });
    micro.push('ancient-landmark');
  }

  // ── WONDER: a rare deterministic set-piece — stone ring OR glowing fairy ring.
  if (params.wonder !== false) {
    const wx = cx + (r() - 0.5) * w * 0.4, wz = cz + (r() - 0.5) * d * 0.4;
    const N = 8, isStone = r() < 0.5;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * TAU, rr = isStone ? 3 : 1.6;
      const px = wx + Math.cos(a) * rr, pz = wz + Math.sin(a) * rr;
      out.push(isStone
        ? { generator: 'rock', params: { seed: (seed * 131 + i) >>> 0, detail: 2, radius: 0.7, squash: [1, 1.6, 1] }, position: [px, hf(px, pz), pz], rotationY: a, scale: 1.4, cluster: 'stone-ring' }
        : { generator: 'mushroom', params: { seed: (seed * 131 + i) >>> 0, glowing: true }, position: [px, hf(px, pz), pz], rotationY: a, scale: 2.2, cluster: 'fairy-ring' });
    }
    micro.push(isStone ? 'stone-ring' : 'fairy-ring');
  }

  return { biome: params.biome || 'plains', ground: biome.ground, placements: out, microBiomes: micro };
}

// ── stubs: structures / dungeons / caves (mesh) ──────────────────────────────
function placeholderBox(color, size, name) {
  const mb = new MeshBuilder();
  mb.box([0, size[1], 0], [size[0], size[1], size[2]]);
  mb.computeSmoothNormals();
  return mb.toSceneGraph({ color, roughness: 0.9, name });
}
// TODO structure: modular parts (cabins/ruins/towers/shrines/villages).
export function generateStructure(p = {}, ctx = {}) { void ctx; return placeholderBox(p.color || [0.5, 0.42, 0.34], p.size || [2, 1.5, 2], 'structure'); }
// TODO dungeon: BSP rooms + corridors + loops → floor/wall mesh.
export function generateDungeon(p = {}, ctx = {}) { void ctx; return placeholderBox(p.color || [0.3, 0.3, 0.34], p.size || [8, 0.2, 8], 'dungeon'); }
// TODO cave: 3D-noise density field → marching cubes → tunnels/caverns.
export function generateCave(p = {}, ctx = {}) { void ctx; return placeholderBox(p.color || [0.18, 0.17, 0.16], p.size || [6, 3, 6], 'cave'); }

register('ecosystem', generateEcosystem, { mesh: false, kind: 'ecosystem' });
register('structure', generateStructure, { mesh: true, kind: 'structure', stub: true });
register('dungeon', generateDungeon, { mesh: true, kind: 'dungeon', stub: true });
register('cave', generateCave, { mesh: true, kind: 'cave', stub: true });

// expose a convenience: instantiate an ecosystem's placements into SceneGraphs.
export function realizeEcosystem(eco) {
  return eco.placements.map((pl) => ({ ...pl, sceneGraph: generate(pl.generator, pl.params) }));
}
