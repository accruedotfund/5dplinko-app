// core/gl/liminal.js — the LIMINAL LIGHTING kit: backrooms-style isolation on
// top of the existing forward renderer. No shadow maps, no deferred, no HDR —
// just aggressive composition of what's already there: darkness-first ambient,
// practical fluorescent fixtures (emissive panel + point light), procedural
// flicker, steeper attenuation (light "islands"), palette presets, and a
// bloom/grade tuning that reads as old commercial lighting, not cinema.
//
//   flickerValue(mode, t, seed, amount) → intensity multiplier (deterministic,
//     no per-frame RNG — same t+seed always gives the same value, so fixtures
//     don't desync across save/replay)
//   LIMINAL_PALETTES — hemisphere + fixture-color + fog per mood
//   LIMINAL_DEFAULTS — the darkness-first preset enableLiminalMode applies

// ── palettes ──────────────────────────────────────────────────────────────────
export const LIMINAL_PALETTES = {
  'backrooms-yellow': {
    sky: [0.05, 0.05, 0.03], ground: [0.02, 0.02, 0.01],
    fixture: [1, 0.93, 0.6],
    fog: { density: 0.030, color: [0.010, 0.009, 0.004] },
  },
  'industrial-white': {
    sky: [0.04, 0.045, 0.05], ground: [0.015, 0.017, 0.02],
    fixture: [0.93, 0.97, 1],
    fog: { density: 0.028, color: [0.007, 0.008, 0.010] },
  },
  'hospital-green': {
    sky: [0.04, 0.05, 0.045], ground: [0.014, 0.02, 0.016],
    fixture: [0.84, 1, 0.88],
    fog: { density: 0.028, color: [0.006, 0.009, 0.007] },
  },
  'maintenance-red': {
    sky: [0.05, 0.02, 0.018], ground: [0.018, 0.007, 0.006],
    fixture: [1, 0.32, 0.22],
    fog: { density: 0.034, color: [0.009, 0.003, 0.002] },
  },
  'archive-amber': {
    sky: [0.05, 0.04, 0.024], ground: [0.018, 0.014, 0.007],
    fixture: [1, 0.7, 0.32],
    fog: { density: 0.028, color: [0.010, 0.007, 0.003] },
  },
};

// ── darkness-first preset ─────────────────────────────────────────────────────
// "light exists only where a fixture exists": hemisphere crushed, sun off,
// steeper point falloff (isolated pools), contrasty grade, fixture-only bloom.
export const LIMINAL_DEFAULTS = {
  ambientFactor: 0.12,     // × authored hemisphere
  sunFactor: 0,            // × authored sun
  falloffPow: 1.55,        // attenuation^pow — pools end sooner, gaps go black
  flickerAmount: 1,
  grade: { contrast: 1.16, saturation: 0.88, vignette: 0.42 },
  bloom: { threshold: 0.55, strength: 1.6, radius: 14 },  // fixtures bloom, walls don't
};

// ── procedural flicker ───────────────────────────────────────────────────────
// Deterministic hash noise over time slots — each mode is a different rhythm of
// the same multiplier. Applied to light intensity AND the fixture's emissive.
const hash = (n) => { const s = Math.sin(n * 12.9898) * 43758.5453; return s - Math.floor(s); };

export function flickerValue(mode, t, seed = 0, amount = 1) {
  if (!mode || mode === 'none' || amount <= 0) return 1;
  switch (mode) {
    case 'stable': {
      // ±2% mains shimmer — alive, not distracting
      const w = Math.sin(t * 13.7 + seed) * Math.sin(t * 31.1 + seed * 2.7);
      return 1 - 0.02 * amount * (0.5 + 0.5 * w);
    }
    case 'intermittent': {
      // mostly steady; occasional short brown-outs
      const slot = Math.floor(t * 2.2 + seed);
      const frac = (t * 2.2 + seed) - slot;
      const h = hash(slot);
      if (h < 0.13 && frac < 0.3) return 1 - amount * 0.78;        // brief drop
      const w = Math.sin(t * 17 + seed);
      return 1 - 0.03 * amount * (0.5 + 0.5 * w);
    }
    case 'failing': {
      // ballast on its way out: rapid uneven sputter with spikes
      const slot = Math.floor(t * 9 + seed);
      const h = hash(slot);
      if (h < 0.18) return 1 - amount * (0.55 + 0.4 * hash(slot * 7.1));
      if (h > 0.93) return 1 + amount * 0.35;                       // overshoot spike
      return 1 - 0.12 * amount * hash(slot * 3.3);
    }
    case 'dying': {
      // long blackouts, brief desperate flashes
      const slot = Math.floor(t * 0.55 + seed);
      const frac = (t * 0.55 + seed) - slot;
      const h = hash(slot);
      if (h < 0.3) {
        // a "lit" window at the start of some slots, itself sputtering
        if (frac < 0.22) return (0.7 + 0.5 * hash(Math.floor(t * 24) + seed)) * Math.min(1, amount + 0.2);
        return 1 - amount * 0.985;
      }
      return 1 - amount * 0.985;                                    // blackout
    }
    default: return 1;
  }
}
