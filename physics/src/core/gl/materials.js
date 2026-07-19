// core/gl/materials.js — named material presets for gl-box / gl-model specs.
//
//   { type: 'gl-box', material: 'tile-white', size: …, position: … }
//
// A preset is just a bundle of the spec props the engine already understands
// (color / roughness / metallic? / specular / opacity / texture / uvScale /
// emissive / doubleSided / ambient). Explicit props on the spec WIN over the
// preset, so `{ material: 'tile-white', uvScale: 4 }` retiles but keeps gloss.
// Add your own with registerMaterial(name, def).
//
// `specular` is the dielectric gloss boost (multiplies F0 in the shader):
// 1 = plain, 3-4 = glazed ceramic / wet surfaces. Metals use `metallic` instead.

export const MATERIALS = {
  // ── tiles / ceramics ─────────────────────────────────────────────────────
  'tile-white': {
    texture: 'assets/textures/materials/tile-white.png', uvScale: 1.6,
    color: [1, 1, 1], roughness: 0.14, specular: 3.2,
  },
  'tile-grimy': {
    texture: 'assets/textures/materials/tile-white.png', uvScale: 1.6,
    color: [0.82, 0.8, 0.72], roughness: 0.3, specular: 2.2,
  },
  porcelain: { color: [0.95, 0.95, 0.93], roughness: 0.1, specular: 3.5 },

  // ── metals ───────────────────────────────────────────────────────────────
  'metal-steel': { color: [0.60, 0.62, 0.66], metallic: 1, roughness: 0.3 },
  'metal-chrome': { color: [0.88, 0.90, 0.94], metallic: 1, roughness: 0.08 },
  'metal-brass': { color: [0.78, 0.62, 0.30], metallic: 1, roughness: 0.25 },
  'metal-rust': { color: [0.45, 0.26, 0.16], metallic: 0.6, roughness: 0.75 },

  // ── liquids / glass ──────────────────────────────────────────────────────
  water: {
    color: [0.16, 0.40, 0.45], opacity: 0.38, roughness: 0.05,
    specular: 4, doubleSided: true,
  },
  'water-murky': {
    color: [0.10, 0.22, 0.20], opacity: 0.55, roughness: 0.1,
    specular: 3, doubleSided: true,
  },
  glass: { color: [0.7, 0.8, 0.85], opacity: 0.25, roughness: 0.05, specular: 4, doubleSided: true },

  // ── architectural ────────────────────────────────────────────────────────
  concrete: { color: [0.52, 0.52, 0.49], roughness: 0.92 },
  plaster: { color: [0.78, 0.77, 0.72], roughness: 0.85 },
  asphalt: { color: [0.16, 0.16, 0.17], roughness: 0.95 },
  wood: { color: [0.38, 0.25, 0.13], roughness: 0.7, specular: 1.4 },
};

export function registerMaterial(name, def) { MATERIALS[name] = def; }

// preset + explicit spec props (explicit wins); returns a NEW merged spec
export function applyMaterial(spec) {
  if (!spec.material) return spec;
  const preset = MATERIALS[spec.material];
  if (!preset) { console.warn(`materials: unknown preset "${spec.material}"`); return spec; }
  return { ...preset, ...spec };
}
