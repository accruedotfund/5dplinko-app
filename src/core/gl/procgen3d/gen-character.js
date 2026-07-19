// core/gl/procgen3d/gen-character.js — block character (PRIORITY, minimal-real).
//
//   generate('character', { seed, descriptor:{...}, variant, palette })
//   descriptor (all optional — defaults make a classic blocky figure):
//     height, torsoWidth, armLength, legLength, headRadius
//   variant: 'short'|'tall'|'stocky'|'thin' — biases the descriptor while
//            preserving the recognizable silhouette.
//   → SceneGraph (head + torso + 2 arms + 2 legs as boxes, feet on y=0)
//
// REAL today: descriptor → proportioned box body, deterministic per-seed jitter,
// 4 silhouette variants. Returns `parts` metadata (named pivots) so the animation
// graph can pose limbs. TODO (later): procedural clothing overlays (shirt/hoodie/
// robe/armor), face generator (eyes/mouth/brows/helmet), hands/feet detail, skin
// weighting for smooth limb bend.

import { MeshBuilder } from './mesh-builder.js';
import { register } from './registry.js';
import { rng } from '../../procgen.js';

const VARIANTS = {
  short: { height: 0.8, torsoWidth: 1.1, legLength: 0.7 },
  tall: { height: 1.25, torsoWidth: 0.9, legLength: 1.2 },
  stocky: { height: 0.95, torsoWidth: 1.35, armLength: 1.1 },
  thin: { height: 1.05, torsoWidth: 0.7, armLength: 0.95 },
};

export function generateCharacter(params = {}, ctx = {}) {
  const seed = ctx.seed ?? params.seed ?? 1;
  const r = rng(seed);
  const vb = VARIANTS[params.variant] || {};
  const d = params.descriptor || {};
  // base proportions (meters), scaled by variant + tiny per-seed jitter
  const j = (1 + (r() - 0.5) * 0.08);
  const H = (d.height ?? 1) * (vb.height ?? 1) * j;
  const tw = (d.torsoWidth ?? 1) * (vb.torsoWidth ?? 1);
  const armL = (d.armLength ?? 1) * (vb.armLength ?? 1);
  const legL = (d.legLength ?? 1) * (vb.legLength ?? 1);
  const hr = (d.headRadius ?? 1) * (vb.headRadius ?? 1);

  // dimensions (a ~1.8m figure at scale 1)
  const legH = 0.7 * legL, legHW = 0.13 * tw;
  const torsoH = 0.6, torsoHW = 0.26 * tw, torsoHD = 0.16;
  const armH = 0.55 * armL, armHW = 0.1;
  const headR = 0.18 * hr;
  const pal = params.palette || {};
  const skin = pal.skin || [0.86, 0.66, 0.52];
  const shirt = pal.shirt || [0.3, 0.45, 0.7];
  const pants = pal.pants || [0.24, 0.24, 0.3];

  // build each part in its own builder so we can give it its own material/color,
  // then merge into one SceneGraph (single draw). Pivots recorded for animation.
  const mb = new MeshBuilder();
  const parts = {};
  let yFeet = 0;
  const legCY = yFeet + legH;            // legs from 0..2*legH
  const torsoCY = legCY + legH + torsoH; // torso sits on legs
  const headCY = torsoCY + torsoH + headR;
  const shoulderY = torsoCY + torsoH - armHW;

  // legs
  mb.box([-legHW * 1.1, legCY, 0], [legHW, legH, legHW]);
  mb.box([legHW * 1.1, legCY, 0], [legHW, legH, legHW]);
  // torso
  mb.box([0, torsoCY, 0], [torsoHW, torsoH, torsoHD]);
  // arms (pivot at shoulder — recorded for the walk/idle swing)
  mb.box([-(torsoHW + armHW), shoulderY - armH + armHW, 0], [armHW, armH, armHW]);
  mb.box([(torsoHW + armHW), shoulderY - armH + armHW, 0], [armHW, armH, armHW]);
  // head
  mb.box([0, headCY, 0], [headR, headR, headR]);

  parts.headPivot = [0, headCY, 0];
  parts.shoulderL = [-(torsoHW + armHW), shoulderY, 0];
  parts.shoulderR = [(torsoHW + armHW), shoulderY, 0];
  parts.hipL = [-legHW * 1.1, legCY + legH, 0];
  parts.hipR = [legHW * 1.1, legCY + legH, 0];
  parts.eyeHeight = headCY;

  // NOTE: single-color for now — per-part skin/shirt/pants is the clothing TODO.
  void skin; void shirt; void pants;
  const sg = mb.toSceneGraph({ color: shirt, roughness: 0.8, name: 'character' });
  sg.procgen = { parts, height: headCY + headR, descriptor: { H, tw, armL, legL, hr } };
  return sg;
}

register('character', generateCharacter, { mesh: true, kind: 'character' });
