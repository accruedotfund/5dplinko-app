// core/gl/environments.js — named ENVIRONMENT presets: one word in a manifest
// sets a coherent outdoor mood (sun + hemisphere + fog + sky + suggested grade)
// instead of hand-tuning six knobs that visually fight each other.
//
//   gl-scene spec:  environment: 'overcast'
//     → fills spec.sky + spec.fog defaults and injects sun/hemisphere lights
//       (any EXPLICIT gl-light children / fog / sky on the spec still win)
//
// Zone use: a sense component can pull a preset's fog and hand it to
// world.fogTo(fog, seconds) for smooth indoor↔outdoor transitions.

export const ENVIRONMENTS = {
  'day-clear': {
    sun: { dir: [0.45, -1, 0.3], color: [1, 0.97, 0.9], intensity: 2.0 },
    hemisphere: { sky: [0.34, 0.42, 0.55], ground: [0.16, 0.15, 0.12] },
    fog: { density: 0.008, color: [0.72, 0.80, 0.90] },
    sky: { zenith: [0.20, 0.42, 0.85], horizon: [0.72, 0.80, 0.90], clouds: 0.45, wind: 0.5 },
  },
  overcast: {
    sun: { dir: [0.3, -1, 0.2], color: [0.75, 0.78, 0.82], intensity: 1.1 },
    hemisphere: { sky: [0.38, 0.40, 0.44], ground: [0.14, 0.14, 0.13] },
    fog: { density: 0.014, color: [0.56, 0.60, 0.65] },
    sky: { zenith: [0.45, 0.50, 0.56], horizon: [0.62, 0.65, 0.68], clouds: 0.95, wind: 0.7, sunSize: 80 },
  },
  dusk: {
    sun: { dir: [0.9, -0.28, 0.2], color: [1, 0.55, 0.3], intensity: 1.3 },
    hemisphere: { sky: [0.22, 0.18, 0.30], ground: [0.10, 0.07, 0.06] },
    fog: { density: 0.018, color: [0.30, 0.22, 0.28] },
    sky: { zenith: [0.12, 0.10, 0.30], horizon: [0.85, 0.45, 0.25], clouds: 0.5, wind: 0.4 },
  },
  night: {
    sun: { dir: [0.3, -1, 0.2], color: [0.25, 0.30, 0.45], intensity: 0.5 }, // moonlight
    hemisphere: { sky: [0.05, 0.07, 0.12], ground: [0.015, 0.02, 0.02] },
    fog: { density: 0.030, color: [0.012, 0.02, 0.030] },
    sky: { zenith: [0.012, 0.02, 0.05], horizon: [0.05, 0.07, 0.10], clouds: 0.35, wind: 0.3, sunSize: 2200 },
  },
  'night-rain': {
    sun: { dir: [0.2, -1, 0.1], color: [0.18, 0.22, 0.30], intensity: 0.45 },
    hemisphere: { sky: [0.05, 0.06, 0.08], ground: [0.018, 0.02, 0.022] },
    fog: { density: 0.055, color: [0.04, 0.05, 0.065] },
    sky: { zenith: [0.02, 0.025, 0.04], horizon: [0.06, 0.07, 0.09], clouds: 1, wind: 1.4, sunSize: 4000 },
  },
};

export function getEnvironment(name) {
  const e = ENVIRONMENTS[name];
  if (!e) console.warn(`environments: unknown preset "${name}"`);
  return e || null;
}
