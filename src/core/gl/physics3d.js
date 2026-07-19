// core/gl/physics3d.js — lightweight 3D rigid-body physics. Pure simulation:
// no DOM, no GL. The 3D sibling of components/physics.js (same architecture:
// spatial-hash broadphase, iterative impulses, sleeping) kept deliberately
// small: SPHERE and BOX (OBB) shapes, a ground plane, static/kinematic/dynamic
// bodies. Drive from a fixed timestep.
//
//   const world = createPhysics3D({ gravity: 18, ground: 0 });
//   world.addBody({ id:'crate1', shape:'box', half:[.35,.35,.35],
//                   position:[0,3,0], dynamic:true, density:1,
//                   restitution:.25, friction:.6 });
//   world.step(1/60);
//   body.position / body.quat → render via setModelTransform(id,{position,rotation:quat})
//
//   kinematic bodies (a car): world-driven — set body.position/yaw yourself each
//   step via world.moveKinematic(id, pos, quat, dt) (computes velocity so hits
//   transfer real momentum); infinite mass, never sleeps.
//
//   world.applyImpulse(id, [jx,jy,jz], point?) — shove (gun hits, explosions)
//   world.explode(center, radius, force, opts?) — radial impulse on all bodies in range
//   world.raycast(origin, dir, maxDist) → { id, t, point } | null  (dynamic+kinematic)
//   world.rayAll(origin, dir, maxDist) → { id, t, point, normal } | null (bodies + static level)
//   world.onContact = (a, b, impulse, point) => {}   // called for solid impacts
//   world.onTrigger = (sensorId, otherId, phase) => {} // phase 'enter'|'exit' (sensor bodies)
//
// SHAPES: 'sphere', 'box' (OBB), 'capsule' (segment+radius, axis=local Y; 'cylinder'
//   is an alias — collides as a capsule). CCD: spec.bullet=true sweeps the body's
//   path each step (vs static level + bodies) so fast projectiles don't tunnel.
//
// GRAVITY: opts.gravity may be a downward magnitude (number) or a vector [x,y,z].
//   world.setGravity(v) at runtime (tilt arcades, zero-g). Per body: gravityScale
//   (0 = floaty/zero-g, >1 = heavy). SENSORS: spec.sensor=true → overlap-only, no
//   response, fires onTrigger enter/exit. FILTER: spec.group/spec.mask bitmasks.
//
// STATIC LEVEL: world.setStaticBVH(bvh) lets DYNAMIC bodies collide with the real
//   triangle level (not just the flat ground plane) — props roll on stairs/ramps.
//
// JOINTS: world.addJoint({ type:'distance'|'spring'|'point'|'hinge', a, b, ... }) →
//   id; world.removeJoint(id). 'b' may be null/'__world' to pin to a world anchor.
//   distance {length, anchorA?, anchorB?}; spring {length, stiffness, damping};
//   point {anchorA?, anchorB?} (ball-socket / ragdoll); hinge {axis, anchorA?, anchorB?}.

import { capsuleHitsBVH, forEachTriInAABB, raycastBVH } from './bvh.js';

const SLEEP_LIN = 0.06, SLEEP_ANG = 0.08, SLEEP_TIME = 0.55;
const PEN_SLOP = 0.004;
// Positional correction is STATIC-AUTHORITATIVE: a body squeezed between a KINEMATIC pusher
// (car / the player's mirrored capsule, both invMass 0) and a STATIC wall (also invMass 0) must be
// pushed cleanly OUT of the wall and rest flush — NOT shoved through it by the pusher's contact.
// So the static surface gets a strong push, the kinematic pusher a weak one, dynamic↔dynamic moderate.
// Passes ITERATE (shrink the remaining penetration, not zero it) → real Gauss-Seidel convergence.
// Kinematic pusher gets a MODERATE push (pins a body against a wall so it doesn't drift, and keeps
// bodies out of a parked car) — the FINAL STATIC CLAMP (clampStatic, after the solve) is what
// guarantees the body can never be left inside a wall, so the pusher can pin without tunnelling.
const PEN_STATIC = 0.85, PEN_DYNAMIC = 0.5, PEN_KIN = 0.4, POS_PASSES = 4;

// ── tiny 3-vector helpers on plain arrays ────────────────────────────────────
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b, o = [0, 0, 0]) => {
  const x = a[1] * b[2] - a[2] * b[1], y = a[2] * b[0] - a[0] * b[2], z = a[0] * b[1] - a[1] * b[0];
  o[0] = x; o[1] = y; o[2] = z; return o;
};
const len = (a) => Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);

// quat [x,y,z,w] → row-major 3×3 (world = R · local); columns are local axes
function quatToR(q, R) {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  R[0] = 1 - (yy + zz); R[1] = xy - wz; R[2] = xz + wy;
  R[3] = xy + wz; R[4] = 1 - (xx + zz); R[5] = yz - wx;
  R[6] = xz - wy; R[7] = yz + wx; R[8] = 1 - (xx + yy);
}

export function createPhysics3D(opts = {}) {
  // gravity: a downward magnitude (number) OR a full vector [x,y,z].
  const grav = Array.isArray(opts.gravity)
    ? opts.gravity.slice()
    : [0, -(opts.gravity ?? 18), 0];
  const ground = opts.ground; // y of an infinite floor plane, or undefined
  const iterations = opts.iterations ?? 12;   // impulse iterations — more = tighter squeeze/stack convergence
  const bodies = new Map();
  const list = []; // dense iteration order
  let bodySeq = 0; // monotonic, stable across removals → numeric broadphase pair keys
  const joints = []; // constraint list (distance/spring/point/hinge)
  let staticBVH = null; // dynamic bodies collide with the real level when set
  let warm = new Map(), warmNext = new Map(); // pair-key → last normal impulse (warm starting)
  const _cs0 = [0, 0, 0], _cs1 = [0, 0, 0]; // capsule segment scratch
  const _triggerHits = new Set(); // "sensorId otherId" overlaps this frame
  const world = {
    bodies, list, joints, step, addBody, removeBody, setBodyScale, applyImpulse, moveKinematic,
    raycast, rayAll, explode, addJoint, removeJoint, setGravity, setStaticBVH,
    gravity: grav, onContact: null, onTrigger: null,
  };

  function setGravity(v) {
    if (Array.isArray(v)) { grav[0] = v[0]; grav[1] = v[1]; grav[2] = v[2]; }
    else { grav[0] = 0; grav[1] = -v; grav[2] = 0; }
    for (const b of list) if (b.dynamic && b.sleeping) wake(b); // re-settle under new g
    return grav;
  }
  function setStaticBVH(bvh) { staticBVH = bvh || null; }

  function addBody(spec) {
    // 'cylinder' collides as a capsule (rounded ends) — documented approximation.
    const shape = spec.shape === 'sphere' ? 'sphere'
      : (spec.shape === 'capsule' || spec.shape === 'cylinder') ? 'capsule' : 'box';
    const half = shape === 'box' ? (spec.half || [0.5, 0.5, 0.5]).slice() : null;
    const radius = (shape === 'sphere' || shape === 'capsule') ? (spec.radius ?? 0.5) : 0;
    // capsule: halfH = half the CYLINDRICAL segment length along local +Y (excludes caps)
    const halfH = shape === 'capsule' ? (spec.halfHeight ?? spec.half?.[1] ?? 0.5) : 0;
    const dynamic = spec.dynamic !== false && !spec.kinematic;
    const density = spec.density ?? 1;
    const volume = shape === 'box' ? 8 * half[0] * half[1] * half[2]
      : shape === 'capsule' ? (Math.PI * radius * radius * (2 * halfH) + (4 / 3) * Math.PI * radius ** 3)
      : (4 / 3) * Math.PI * radius ** 3;
    const mass = dynamic ? Math.max(volume * density, 0.05) : 0;
    const b = {
      id: spec.id, _idx: ++bodySeq, shape, half, radius, halfH, baseRadius: radius,
      position: new Float64Array(spec.position || [0, 0, 0]),
      quat: new Float64Array(spec.quat || [0, 0, 0, 1]),
      vel: new Float64Array(spec.vel || [0, 0, 0]),
      angVel: new Float64Array(spec.angVel || [0, 0, 0]),
      dynamic, kinematic: !!spec.kinematic,
      invMass: dynamic ? 1 / mass : 0, mass,
      restitution: spec.restitution ?? 0.2,
      friction: spec.friction ?? 0.55,
      damping: spec.damping ?? 0.04,
      angularDamping: spec.angularDamping ?? 0.12,
      gravityScale: spec.gravityScale ?? 1,
      sensor: !!spec.sensor,          // overlap-only, no response
      bullet: !!spec.bullet,          // CCD swept against level + bodies
      group: spec.group ?? 1, mask: spec.mask ?? 0xffffffff, // collision filter
      canSleep: spec.sleep !== false && !spec.sensor,
      // asleep:true = born sleeping (pristine stacks until something hits them)
      sleeping: dynamic && !!spec.asleep, sleepT: 0,
      R: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
      invI: new Float64Array(3), // local-space diagonal inverse inertia
      aabb: { min: new Float64Array(3), max: new Float64Array(3) },
      overlaps: spec.sensor ? new Set() : null, // for trigger enter/exit tracking
      data: spec.data,
    };
    if (dynamic) {
      if (shape === 'box') {
        const [hx, hy, hz] = half, k = mass / 3; // (1/12)m(a²+b²), a=2h → (1/3)m(hy²+hz²)
        b.invI.set([1 / (k * (hy * hy + hz * hz)), 1 / (k * (hx * hx + hz * hz)), 1 / (k * (hx * hx + hy * hy))]);
      } else if (shape === 'capsule') {
        // approximate as a solid cylinder about its axes (good enough for gameplay)
        const r2 = radius * radius, hlen = 2 * halfH;
        const iY = 0.5 * mass * r2;                                   // about the axis
        const iXZ = (1 / 12) * mass * (3 * r2 + hlen * hlen) + 0.4 * mass * r2;
        b.invI.set([1 / Math.max(iXZ, 1e-4), 1 / Math.max(iY, 1e-4), 1 / Math.max(iXZ, 1e-4)]);
      } else {
        const i = 1 / ((2 / 5) * mass * radius * radius);
        b.invI.set([i, i, i]);
      }
    }
    quatToR(b.quat, b.R);
    updateAABB(b);
    bodies.set(b.id, b);
    list.push(b);
    return b;
  }

  function removeBody(id) {
    const b = bodies.get(id);
    if (!b) return;
    bodies.delete(id);
    list.splice(list.indexOf(b), 1);
  }

  // Resize a SPHERE body at runtime: radius = baseRadius·s. Recomputes mass (∝ r³,
  // keeping the original density) + the solid-sphere inverse inertia (∝ 1/(m r²)),
  // so a growing snowball collides at the new size AND carries correct momentum.
  // Conserves LINEAR momentum by default (v ·= m_old/m_new) — gravity along a slope
  // (a = g·sinθ, mass-independent) keeps re-accelerating it, so it rolls on as it
  // grows. `b.scaleVisual` is read by gl-scene to scale the bound visual mesh in lock-step.
  function setBodyScale(id, s, { conserveMomentum = true } = {}) {
    const b = bodies.get(id);
    if (!b || b.shape !== 'sphere') return false;        // sphere-only (box/capsule TODO)
    const r = (b.baseRadius || b.radius) * s;
    if (!(r > 0)) return false;
    if (b.dynamic) {
      const density = b.mass > 0 ? b.mass / ((4 / 3) * Math.PI * b.radius ** 3) : 1;
      const oldM = b.mass;
      b.radius = r;
      b.mass = Math.max((4 / 3) * Math.PI * r ** 3 * density, 0.05);
      b.invMass = 1 / b.mass;
      const i = 1 / ((2 / 5) * b.mass * r * r);
      b.invI[0] = b.invI[1] = b.invI[2] = i;
      if (conserveMomentum && oldM > 0) { const k = oldM / b.mass; b.vel[0] *= k; b.vel[1] *= k; b.vel[2] *= k; }
      wake(b);
    } else b.radius = r;
    b.scaleVisual = s;
    updateAABB(b);
    return true;
  }

  // capsule segment endpoints in world space (local axis = ±Y)
  function capsuleSeg(b, p0, p1) {
    const R = b.R, hy = b.halfH;
    const ax = R[1] * hy, ay = R[4] * hy, az = R[7] * hy; // R column 1 (local +Y) × halfH
    p0[0] = b.position[0] - ax; p0[1] = b.position[1] - ay; p0[2] = b.position[2] - az;
    p1[0] = b.position[0] + ax; p1[1] = b.position[1] + ay; p1[2] = b.position[2] + az;
  }

  function updateAABB(b) {
    const { min, max } = b.aabb, p = b.position;
    if (b.shape === 'sphere') {
      for (let i = 0; i < 3; i++) { min[i] = p[i] - b.radius; max[i] = p[i] + b.radius; }
    } else if (b.shape === 'capsule') {
      capsuleSeg(b, _cs0, _cs1);
      for (let i = 0; i < 3; i++) {
        min[i] = Math.min(_cs0[i], _cs1[i]) - b.radius;
        max[i] = Math.max(_cs0[i], _cs1[i]) + b.radius;
      }
    } else {
      const R = b.R, h = b.half;
      for (let i = 0; i < 3; i++) {
        const e = Math.abs(R[i * 3]) * h[0] + Math.abs(R[i * 3 + 1]) * h[1] + Math.abs(R[i * 3 + 2]) * h[2];
        min[i] = p[i] - e; max[i] = p[i] + e;
      }
    }
  }

  function wake(b) { if (b.dynamic) { b.sleeping = false; b.sleepT = 0; } }

  function applyImpulse(id, J, point) {
    const b = bodies.get(id);
    if (!b || !b.dynamic) return;
    wake(b);
    b.vel[0] += J[0] * b.invMass; b.vel[1] += J[1] * b.invMass; b.vel[2] += J[2] * b.invMass;
    if (point) {
      const r = [point[0] - b.position[0], point[1] - b.position[1], point[2] - b.position[2]];
      const t = cross(r, J);
      applyAngular(b, t);
    }
  }

  // torque/impulse through the world-space inverse inertia: I⁻¹w = R · diag · Rᵀ
  // no-alloc core: apply a torque given as scalars (hot-path form). Math is
  // byte-identical to the array form below.
  function applyAngularXYZ(b, tx, ty, tz) {
    const R = b.R, ii = b.invI;
    // local = Rᵀ t
    const lx = R[0] * tx + R[3] * ty + R[6] * tz;
    const ly = R[1] * tx + R[4] * ty + R[7] * tz;
    const lz = R[2] * tx + R[5] * ty + R[8] * tz;
    const sx = lx * ii[0], sy = ly * ii[1], sz = lz * ii[2];
    b.angVel[0] += R[0] * sx + R[1] * sy + R[2] * sz;
    b.angVel[1] += R[3] * sx + R[4] * sy + R[5] * sz;
    b.angVel[2] += R[6] * sx + R[7] * sy + R[8] * sz;
  }
  function applyAngular(b, t) { applyAngularXYZ(b, t[0], t[1], t[2]); }

  // kinematic mover: position the body AND carry the implied velocity so
  // contacts hand momentum to whatever it hits
  function moveKinematic(id, pos, quat, dt) {
    const b = bodies.get(id);
    if (!b) return;
    if (dt > 0) {
      b.vel[0] = (pos[0] - b.position[0]) / dt;
      b.vel[1] = (pos[1] - b.position[1]) / dt;
      b.vel[2] = (pos[2] - b.position[2]) / dt;
    }
    b.position[0] = pos[0]; b.position[1] = pos[1]; b.position[2] = pos[2];
    if (quat) { b.quat.set(quat); quatToR(b.quat, b.R); }
    updateAABB(b);
  }

  // ── narrowphase ─────────────────────────────────────────────────────────────
  // contacts: { a, b, n (a→b), p, depth, jn } — jn = accumulated normal impulse
  const contacts = [];

  function sphereSphere(a, b) {
    const d = [b.position[0] - a.position[0], b.position[1] - a.position[1], b.position[2] - a.position[2]];
    const l = len(d), r = a.radius + b.radius;
    if (l >= r || l < 1e-9) return;
    const n = [d[0] / l, d[1] / l, d[2] / l];
    contacts.push({ a, b, n, depth: r - l, jn: 0, jt1: 0, jt2: 0,
      p: [a.position[0] + n[0] * a.radius, a.position[1] + n[1] * a.radius, a.position[2] + n[2] * a.radius] });
  }

  function worldToLocal(box, p, o) {
    const R = box.R, d = [p[0] - box.position[0], p[1] - box.position[1], p[2] - box.position[2]];
    o[0] = R[0] * d[0] + R[3] * d[1] + R[6] * d[2];
    o[1] = R[1] * d[0] + R[4] * d[1] + R[7] * d[2];
    o[2] = R[2] * d[0] + R[5] * d[1] + R[8] * d[2];
    return o;
  }
  function localToWorld(box, l, o) {
    const R = box.R;
    o[0] = box.position[0] + R[0] * l[0] + R[1] * l[1] + R[2] * l[2];
    o[1] = box.position[1] + R[3] * l[0] + R[4] * l[1] + R[5] * l[2];
    o[2] = box.position[2] + R[6] * l[0] + R[7] * l[1] + R[8] * l[2];
    return o;
  }

  function sphereBox(s, box, flip) {
    const l = worldToLocal(box, s.position, [0, 0, 0]);
    const c = [
      Math.max(-box.half[0], Math.min(box.half[0], l[0])),
      Math.max(-box.half[1], Math.min(box.half[1], l[1])),
      Math.max(-box.half[2], Math.min(box.half[2], l[2]))];
    let d = [l[0] - c[0], l[1] - c[1], l[2] - c[2]];
    let dist = len(d);
    let nLocal, depth;
    if (dist > 1e-9) { // center outside the box
      if (dist >= s.radius) return;
      nLocal = [d[0] / dist, d[1] / dist, d[2] / dist];
      depth = s.radius - dist;
    } else { // center inside: pop out the nearest face
      let best = Infinity, axis = 0, sign = 1;
      for (let i = 0; i < 3; i++) {
        const pen = box.half[i] - Math.abs(l[i]);
        if (pen < best) { best = pen; axis = i; sign = l[i] >= 0 ? 1 : -1; }
      }
      nLocal = [0, 0, 0]; nLocal[axis] = sign;
      depth = best + s.radius;
      c[axis] = sign * box.half[axis];
    }
    const R = box.R;
    // sphere→box normal in world (from box surface toward sphere)
    let n = [
      R[0] * nLocal[0] + R[1] * nLocal[1] + R[2] * nLocal[2],
      R[3] * nLocal[0] + R[4] * nLocal[1] + R[5] * nLocal[2],
      R[6] * nLocal[0] + R[7] * nLocal[1] + R[8] * nLocal[2]];
    const p = localToWorld(box, c, [0, 0, 0]);
    // contact convention: n points a→b
    if (flip) contacts.push({ a: s, b: box, n: [-n[0], -n[1], -n[2]], p, depth, jn: 0, jt1: 0, jt2: 0 });
    else contacts.push({ a: box, b: s, n, p, depth, jn: 0, jt1: 0, jt2: 0 });
  }

  const _corn = [[-1, -1, -1], [1, -1, -1], [-1, 1, -1], [1, 1, -1], [-1, -1, 1], [1, -1, 1], [-1, 1, 1], [1, 1, 1]];
  function boxCorners(b, out) {
    for (let i = 0; i < 8; i++) {
      out[i] = localToWorld(b, [_corn[i][0] * b.half[0], _corn[i][1] * b.half[1], _corn[i][2] * b.half[2]], out[i] || [0, 0, 0]);
    }
    return out;
  }
  const _ax = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  function boxAxes(b) { // local axes in world = columns of R
    const R = b.R;
    _ax[0][0] = R[0]; _ax[0][1] = R[3]; _ax[0][2] = R[6];
    _ax[1][0] = R[1]; _ax[1][1] = R[4]; _ax[1][2] = R[7];
    _ax[2][0] = R[2]; _ax[2][1] = R[5]; _ax[2][2] = R[8];
    return [_ax[0].slice(), _ax[1].slice(), _ax[2].slice()];
  }
  const projRadius = (axes, half, n) =>
    Math.abs(dot(axes[0], n)) * half[0] + Math.abs(dot(axes[1], n)) * half[1] + Math.abs(dot(axes[2], n)) * half[2];

  function boxBox(a, b) {
    const A = boxAxes(a), B = boxAxes(b);
    const d = [b.position[0] - a.position[0], b.position[1] - a.position[1], b.position[2] - a.position[2]];
    let minDepth = Infinity, bestN = null;
    const tryAxis = (n) => {
      const l = len(n);
      if (l < 1e-7) return true;
      const u = [n[0] / l, n[1] / l, n[2] / l];
      const pen = projRadius(A, a.half, u) + projRadius(B, b.half, u) - Math.abs(dot(d, u));
      if (pen <= 0) return false; // separating axis
      if (pen < minDepth) {
        minDepth = pen;
        bestN = dot(d, u) < 0 ? [-u[0], -u[1], -u[2]] : u; // a→b
      }
      return true;
    };
    for (let i = 0; i < 3; i++) if (!tryAxis(A[i])) return;
    for (let i = 0; i < 3; i++) if (!tryAxis(B[i])) return;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (!tryAxis(cross(A[i], B[j], [0, 0, 0]))) return;

    // contact points: corners of each box penetrating the other (≤4 deepest)
    const pts = [];
    const lp = [0, 0, 0];
    const corners = boxCorners(a, []);
    for (const c of corners) {
      worldToLocal(b, c, lp);
      if (Math.abs(lp[0]) <= b.half[0] && Math.abs(lp[1]) <= b.half[1] && Math.abs(lp[2]) <= b.half[2]) pts.push(c.slice());
    }
    boxCorners(b, corners);
    for (const c of corners) {
      worldToLocal(a, c, lp);
      if (Math.abs(lp[0]) <= a.half[0] && Math.abs(lp[1]) <= a.half[1] && Math.abs(lp[2]) <= a.half[2]) pts.push(c.slice());
    }
    if (!pts.length) { // edge-edge: midpoint approximation
      pts.push([
        (a.position[0] + b.position[0]) / 2,
        (a.position[1] + b.position[1]) / 2,
        (a.position[2] + b.position[2]) / 2]);
    }
    const take = Math.min(pts.length, 4);
    for (let i = 0; i < take; i++) {
      contacts.push({ a, b, n: bestN, p: pts[i], depth: minDepth / take, jn: 0, jt1: 0, jt2: 0 });
    }
  }

  // ── capsule narrowphase ──────────────────────────────────────────────────────
  // closest point on segment [a,b] to point p
  function closestSegPt(a0, a1, p, o) {
    const abx = a1[0] - a0[0], aby = a1[1] - a0[1], abz = a1[2] - a0[2];
    const d = abx * abx + aby * aby + abz * abz || 1;
    let t = ((p[0] - a0[0]) * abx + (p[1] - a0[1]) * aby + (p[2] - a0[2]) * abz) / d;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    o[0] = a0[0] + abx * t; o[1] = a0[1] + aby * t; o[2] = a0[2] + abz * t;
    return o;
  }
  // closest points between two segments (Ericson §5.1.9), returns into c1,c2
  function closestSegSeg(p1, q1, p2, q2, c1, c2) {
    const d1 = [q1[0] - p1[0], q1[1] - p1[1], q1[2] - p1[2]];
    const d2 = [q2[0] - p2[0], q2[1] - p2[1], q2[2] - p2[2]];
    const r = [p1[0] - p2[0], p1[1] - p2[1], p1[2] - p2[2]];
    const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
    let s, t;
    if (a < 1e-9 && e < 1e-9) { s = t = 0; }
    else if (a < 1e-9) { s = 0; t = Math.max(0, Math.min(1, f / e)); }
    else {
      const c = dot(d1, r);
      if (e < 1e-9) { t = 0; s = Math.max(0, Math.min(1, -c / a)); }
      else {
        const bb = dot(d1, d2), denom = a * e - bb * bb;
        s = denom > 1e-9 ? Math.max(0, Math.min(1, (bb * f - c * e) / denom)) : 0;
        t = (bb * s + f) / e;
        if (t < 0) { t = 0; s = Math.max(0, Math.min(1, -c / a)); }
        else if (t > 1) { t = 1; s = Math.max(0, Math.min(1, (bb - c) / a)); }
      }
    }
    c1[0] = p1[0] + d1[0] * s; c1[1] = p1[1] + d1[1] * s; c1[2] = p1[2] + d1[2] * s;
    c2[0] = p2[0] + d2[0] * t; c2[1] = p2[1] + d2[1] * t; c2[2] = p2[2] + d2[2] * t;
  }
  const _q0 = [0, 0, 0], _q1 = [0, 0, 0], _r0 = [0, 0, 0], _r1 = [0, 0, 0];

  function capsuleSphere(cap, s, flip) { // n convention a→b set by flip
    capsuleSeg(cap, _q0, _q1);
    closestSegPt(_q0, _q1, s.position, _r0);
    const dx = s.position[0] - _r0[0], dy = s.position[1] - _r0[1], dz = s.position[2] - _r0[2];
    const l = Math.sqrt(dx * dx + dy * dy + dz * dz), r = cap.radius + s.radius;
    if (l >= r || l < 1e-9) return;
    const n = [dx / l, dy / l, dz / l]; // points cap→sphere
    const p = [_r0[0] + n[0] * cap.radius, _r0[1] + n[1] * cap.radius, _r0[2] + n[2] * cap.radius];
    if (flip) contacts.push({ a: s, b: cap, n: [-n[0], -n[1], -n[2]], p, depth: r - l, jn: 0, jt1: 0, jt2: 0 });
    else contacts.push({ a: cap, b: s, n, p, depth: r - l, jn: 0, jt1: 0, jt2: 0 });
  }
  function capsuleCapsule(a, b) {
    capsuleSeg(a, _q0, _q1); capsuleSeg(b, _r0, _r1);
    closestSegSeg(_q0, _q1, _r0, _r1, _va2, _vb2);
    const dx = _vb2[0] - _va2[0], dy = _vb2[1] - _va2[1], dz = _vb2[2] - _va2[2];
    const l = Math.sqrt(dx * dx + dy * dy + dz * dz), r = a.radius + b.radius;
    if (l >= r || l < 1e-9) return;
    const n = [dx / l, dy / l, dz / l]; // a→b
    contacts.push({ a, b, n, depth: r - l, jn: 0, jt1: 0, jt2: 0,
      p: [_va2[0] + n[0] * a.radius, _va2[1] + n[1] * a.radius, _va2[2] + n[2] * a.radius] });
  }
  // capsule vs OBB: treat the segment's closest point to the box as a sphere of
  // the capsule radius (a robust approximation for gameplay). capFirst = the
  // capsule is body 'a' of the pair (so n must point a→b = cap→box).
  function capsuleBox(cap, box, capFirst) {
    capsuleSeg(cap, _q0, _q1);
    closestSegPt(_q0, _q1, box.position, _r0); // ref point on the segment
    const l = worldToLocal(box, _r0, [0, 0, 0]);
    const cl = [Math.max(-box.half[0], Math.min(box.half[0], l[0])),
                Math.max(-box.half[1], Math.min(box.half[1], l[1])),
                Math.max(-box.half[2], Math.min(box.half[2], l[2]))];
    const d = [l[0] - cl[0], l[1] - cl[1], l[2] - cl[2]];
    let dist = len(d), nLocal, depth;
    if (dist > 1e-9) { if (dist >= cap.radius) return; nLocal = [d[0] / dist, d[1] / dist, d[2] / dist]; depth = cap.radius - dist; }
    else { // center inside the box → pop out nearest face
      let best = Infinity, axis = 0, sign = 1;
      for (let i = 0; i < 3; i++) { const pen = box.half[i] - Math.abs(l[i]); if (pen < best) { best = pen; axis = i; sign = l[i] >= 0 ? 1 : -1; } }
      nLocal = [0, 0, 0]; nLocal[axis] = sign; depth = best + cap.radius; cl[axis] = sign * box.half[axis];
    }
    const R = box.R;
    const npush = [ // box surface → capsule (push-out for the capsule), world space
      R[0] * nLocal[0] + R[1] * nLocal[1] + R[2] * nLocal[2],
      R[3] * nLocal[0] + R[4] * nLocal[1] + R[5] * nLocal[2],
      R[6] * nLocal[0] + R[7] * nLocal[1] + R[8] * nLocal[2]];
    const p = localToWorld(box, cl, [0, 0, 0]);
    if (capFirst) contacts.push({ a: cap, b: box, n: [-npush[0], -npush[1], -npush[2]], p, depth, jn: 0, jt1: 0, jt2: 0 });
    else contacts.push({ a: box, b: cap, n: npush, p, depth, jn: 0, jt1: 0, jt2: 0 });
  }
  const _va2 = [0, 0, 0], _vb2 = [0, 0, 0];

  // ── body vs static level (BVH) — dynamic bodies roll on real geometry ────────
  const STATICW = { id: '__static', dynamic: false, kinematic: false, invMass: 0, invI: [0, 0, 0],
    position: [0, 0, 0], vel: [0, 0, 0], angVel: [0, 0, 0],
    R: [1, 0, 0, 0, 1, 0, 0, 0, 1], restitution: 0.1, friction: 0.85, sleeping: false };
  const _bvhHits = [];
  function bvhContacts(b) {
    if (!staticBVH) return;
    if (b.shape === 'sphere' || b.shape === 'capsule') {
      if (b.shape === 'sphere') { _q0[0] = b.position[0]; _q0[1] = b.position[1]; _q0[2] = b.position[2]; _q1[0] = _q0[0]; _q1[1] = _q0[1]; _q1[2] = _q0[2]; }
      else capsuleSeg(b, _q0, _q1);
      if (!capsuleHitsBVH(staticBVH, _q0, _q1, b.radius, _bvhHits)) return;
      // keep a few deepest contacts so a body settles flat on the surface
      _bvhHits.sort((x, y) => y.depth - x.depth);
      const take = Math.min(_bvhHits.length, 4);
      for (let i = 0; i < take; i++) {
        const hit = _bvhHits[i], nrm = hit.normal; // points world→body (out of surface)
        contacts.push({ a: STATICW, b, n: nrm, depth: hit.depth, jn: 0, jt1: 0, jt2: 0,
          p: [b.position[0] - nrm[0] * b.radius, b.position[1] - nrm[1] * b.radius, b.position[2] - nrm[2] * b.radius] });
      }
    } else {
      // box: SAT against each candidate triangle
      forEachTriInAABB(staticBVH, b.aabb.min, b.aabb.max, (tris, ti) => boxTri(b, tris, ti));
    }
  }
  // box (OBB) vs triangle SAT → deepest-axis MTV contact (Akenine-Möller axes)
  const _bt = { v: [[0, 0, 0], [0, 0, 0], [0, 0, 0]] };
  function boxTri(box, tris, ti) {
    const A = boxAxes(box), h = box.half, c = box.position;
    const v = _bt.v;
    for (let k = 0; k < 3; k++) { v[k][0] = tris[ti + k * 3] - c[0]; v[k][1] = tris[ti + k * 3 + 1] - c[1]; v[k][2] = tris[ti + k * 3 + 2] - c[2]; }
    // triangle edges
    const E = [[v[1][0] - v[0][0], v[1][1] - v[0][1], v[1][2] - v[0][2]],
               [v[2][0] - v[1][0], v[2][1] - v[1][1], v[2][2] - v[1][2]],
               [v[0][0] - v[2][0], v[0][1] - v[2][1], v[0][2] - v[2][2]]];
    let minDepth = Infinity, bestN = null;
    const test = (ax) => {
      const al = len(ax); if (al < 1e-7) return true;
      const u = [ax[0] / al, ax[1] / al, ax[2] / al];
      const r = projRadius(A, h, u);
      const p0 = dot(v[0], u), p1 = dot(v[1], u), p2 = dot(v[2], u);
      const tmin = Math.min(p0, p1, p2), tmax = Math.max(p0, p1, p2);
      if (tmin > r || tmax < -r) return false; // separating axis
      const pen = Math.min(r - tmin, tmax + r);
      if (pen < minDepth) { minDepth = pen; bestN = (tmin + tmax) < 0 ? u : [-u[0], -u[1], -u[2]]; } // toward box
      return true;
    };
    for (let k = 0; k < 3; k++) if (!test(A[k])) return; // box faces
    const triN = cross(E[0], E[1], [0, 0, 0]); if (!test(triN)) return; // tri face
    for (let k = 0; k < 3; k++) for (let m = 0; m < 3; m++) if (!test(cross(A[k], E[m], [0, 0, 0]))) return;
    if (!bestN) return;
    // contact point: box center pushed to the surface along bestN
    const p = [c[0] - bestN[0] * (h[0]), c[1] - bestN[1] * h[1], c[2] - bestN[2] * h[2]];
    contacts.push({ a: STATICW, b: box, n: bestN, depth: minDepth, jn: 0, jt1: 0, jt2: 0, p });
  }

  function groundContacts(b) {
    if (ground === undefined) return;
    if (b.shape === 'sphere') {
      const pen = ground + b.radius - b.position[1];
      if (pen > 0) {
        contacts.push({ a: GROUND, b, n: [0, 1, 0], depth: pen, jn: 0, jt1: 0, jt2: 0,
          p: [b.position[0], ground, b.position[2]] });
      }
    } else if (b.shape === 'capsule') {
      capsuleSeg(b, _q0, _q1); // contact at whichever cap is lower
      for (const e of [_q0, _q1]) {
        const pen = ground + b.radius - e[1];
        if (pen > 0) contacts.push({ a: GROUND, b, n: [0, 1, 0], depth: pen, jn: 0, jt1: 0, jt2: 0, p: [e[0], ground, e[2]] });
      }
    } else {
      const corners = boxCorners(b, []);
      let added = 0;
      for (const c of corners) {
        const pen = ground - c[1];
        if (pen > 0 && added < 4) {
          contacts.push({ a: GROUND, b, n: [0, 1, 0], depth: pen, jn: 0, jt1: 0, jt2: 0, p: c.slice() });
          added++;
        }
      }
    }
  }
  const GROUND = { // pseudo-body the plane solves against
    id: '__ground', dynamic: false, kinematic: false, invMass: 0, invI: [0, 0, 0],
    position: [0, 0, 0], vel: [0, 0, 0], angVel: [0, 0, 0],
    R: [1, 0, 0, 0, 1, 0, 0, 0, 1], restitution: 0.2, friction: 0.8, sleeping: false,
  };

  // ── solver ──────────────────────────────────────────────────────────────────
  // relative velocity of body b at world point p → o. No allocation: the cross
  // product is inlined (same expression order as cross()).
  function velAtP(b, px, py, pz, o) {
    const rx = px - b.position[0], ry = py - b.position[1], rz = pz - b.position[2];
    const w = b.angVel;
    o[0] = (w[1] * rz - w[2] * ry) + b.vel[0];
    o[1] = (w[2] * rx - w[0] * rz) + b.vel[1];
    o[2] = (w[0] * ry - w[1] * rx) + b.vel[2];
    return o;
  }
  function velAt(b, p, o) { return velAtP(b, p[0], p[1], p[2], o); }
  // no-alloc core: apply an impulse J=(jx,jy,jz) at point p (hot-path form).
  function applyAtXYZ(b, jx, jy, jz, px, py, pz) {
    if (!b.invMass) return;
    b.vel[0] += jx * b.invMass; b.vel[1] += jy * b.invMass; b.vel[2] += jz * b.invMass;
    const rx = px - b.position[0], ry = py - b.position[1], rz = pz - b.position[2];
    // torque = cross(r, J)
    applyAngularXYZ(b, ry * jz - rz * jy, rz * jx - rx * jz, rx * jy - ry * jx);
  }
  function applyAt(b, J, p) { applyAtXYZ(b, J[0], J[1], J[2], p[0], p[1], p[2]); }
  // one body's angular contribution to the effective mass along axis (nx,ny,nz)
  // at point p. No allocation. kNormal sums both bodies + linear terms.
  function kNormalOne(body, px, py, pz, nx, ny, nz) {
    if (!body.invMass) return 0;
    const rx = px - body.position[0], ry = py - body.position[1], rz = pz - body.position[2];
    // rn = cross(r, n)
    const rnx = ry * nz - rz * ny, rny = rz * nx - rx * nz, rnz = rx * ny - ry * nx;
    const R = body.R, ii = body.invI;
    const lx = R[0] * rnx + R[3] * rny + R[6] * rnz;
    const ly = R[1] * rnx + R[4] * rny + R[7] * rnz;
    const lz = R[2] * rnx + R[5] * rny + R[8] * rnz;
    return lx * lx * ii[0] + ly * ly * ii[1] + lz * lz * ii[2];
  }
  // effective mass along n at point p — sum order matches the old loop (a then b).
  function kNormal(a, b, p, n) {
    return a.invMass + b.invMass
      + kNormalOne(a, p[0], p[1], p[2], n[0], n[1], n[2])
      + kNormalOne(b, p[0], p[1], p[2], n[0], n[1], n[2]);
  }

  const _va = [0, 0, 0], _vb = [0, 0, 0];
  function solve(dt) {
    for (const c of contacts) {
      c.kn = 1 / Math.max(kNormal(c.a, c.b, c.p, c.n), 1e-9);
      // restitution from approach speed — ONLY on a FRESH impact. A PERSISTENT (warm-started)
      // contact is a resting/pushed contact (c.jn>0 = it carried an impulse from last frame);
      // bouncing it every frame injects backward velocity, so a box pushed into a wall would
      // slowly crawl AWAY from it (and a fast push would spiral into an explosion).
      velAt(c.b, c.p, _vb); velAt(c.a, c.p, _va);
      const vn = (_vb[0] - _va[0]) * c.n[0] + (_vb[1] - _va[1]) * c.n[1] + (_vb[2] - _va[2]) * c.n[2];
      const e = Math.min(c.a.restitution ?? 0.2, c.b.restitution ?? 0.2);
      c.bounce = (c.jn <= 0 && vn < -1.2) ? -e * vn : 0;
      c.mu = Math.sqrt((c.a.friction ?? 0.5) * (c.b.friction ?? 0.5));
      // warm start: re-apply last frame's accumulated normal impulse for stable stacks
      if (c.jn > 0) {
        const Jx = c.n[0] * c.jn, Jy = c.n[1] * c.jn, Jz = c.n[2] * c.jn;
        const cpx = c.p[0], cpy = c.p[1], cpz = c.p[2];
        applyAtXYZ(c.b, Jx, Jy, Jz, cpx, cpy, cpz); applyAtXYZ(c.a, -Jx, -Jy, -Jz, cpx, cpy, cpz);
      }
    }
    for (let it = 0; it < iterations; it++) {
      for (const j of joints) solveJoint(j, dt);
      for (const c of contacts) {
        const a = c.a, b = c.b, n = c.n, p = c.p;
        // hoist normal + contact point to scalars ONCE — the inner loop then does
        // no bounds-checked array indexing and passes scalars (no array args).
        const nx = n[0], ny = n[1], nz = n[2];
        const px = p[0], py = p[1], pz = p[2];
        velAtP(b, px, py, pz, _vb); velAtP(a, px, py, pz, _va);
        const rvx = _vb[0] - _va[0], rvy = _vb[1] - _va[1], rvz = _vb[2] - _va[2];
        const vn = rvx * nx + rvy * ny + rvz * nz;
        let j = -(vn - c.bounce) * c.kn;
        const old = c.jn;
        c.jn = Math.max(old + j, 0);
        j = c.jn - old;
        if (j) {
          const Jx = nx * j, Jy = ny * j, Jz = nz * j;
          applyAtXYZ(b, Jx, Jy, Jz, px, py, pz); applyAtXYZ(a, -Jx, -Jy, -Jz, px, py, pz);
        }
        // friction: project relative velocity off the normal
        velAtP(b, px, py, pz, _vb); velAtP(a, px, py, pz, _va);
        let tx = _vb[0] - _va[0], ty = _vb[1] - _va[1], tz = _vb[2] - _va[2];
        const tn = tx * nx + ty * ny + tz * nz;
        tx -= nx * tn; ty -= ny * tn; tz -= nz * tn;
        const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
        if (tl > 1e-5) {
          tx /= tl; ty /= tl; tz /= tl;
          const kt = 1 / Math.max(a.invMass + b.invMass
            + kNormalOne(a, px, py, pz, tx, ty, tz)
            + kNormalOne(b, px, py, pz, tx, ty, tz), 1e-9);
          let jt = -tl * kt;
          const maxF = c.mu * c.jn;
          const oldT = c.jt1;
          c.jt1 = Math.max(-maxF, Math.min(maxF, oldT + jt));
          jt = c.jt1 - oldT;
          if (jt) {
            const Jx = tx * jt, Jy = ty * jt, Jz = tz * jt;
            applyAtXYZ(b, Jx, Jy, Jz, px, py, pz); applyAtXYZ(a, -Jx, -Jy, -Jz, px, py, pz);
          }
        }
      }
    }
    // positional correction — STATIC-AUTHORITATIVE + ITERATED (keeps stacks from sinking AND pushes a
    // body OUT of a static wall even while a kinematic body is driving it in). Each pass shrinks the
    // remaining penetration (not zeroes it) so successive passes actually converge.
    for (let pass = 0; pass < POS_PASSES; pass++) {
      for (const c of contacts) {
        const aStatic = !c.a.dynamic && !c.a.kinematic, bStatic = !c.b.dynamic && !c.b.kinematic;
        // authority: a STATIC surface (wall/ground) wins; a KINEMATIC pusher gets only a weak nudge.
        const factor = (aStatic || bStatic) ? PEN_STATIC : (c.a.kinematic || c.b.kinematic) ? PEN_KIN : PEN_DYNAMIC;
        const corr = Math.max(c.depth - PEN_SLOP, 0) * factor;
        if (corr <= 0) continue;
        const total = c.a.invMass + c.b.invMass;
        if (!total) continue;
        const each = corr / total;
        for (let i = 0; i < 3; i++) {
          if (c.b.invMass) c.b.position[i] += c.n[i] * each * c.b.invMass;
          if (c.a.invMass) c.a.position[i] -= c.n[i] * each * c.a.invMass;
        }
        c.depth = Math.max(c.depth - corr, PEN_SLOP);   // iterate: leave the residual for the next pass
      }
    }
    // remember impulses for next-frame warm starting (max per pair key)
    for (const c of contacts) {
      if (!c.warmKey || c.jn <= 0) continue;
      const prev = warmNext.get(c.warmKey) || 0;
      if (c.jn > prev) warmNext.set(c.warmKey, c.jn);
    }
  }

  // ── final STATIC clamp ───────────────────────────────────────────────────────
  // After the impulse solve, hard-guarantee no awake dynamic body is left penetrating STATIC
  // geometry (ground/BVH) and strip any remaining velocity INTO a static surface. The impulse
  // solver can leave residual penetration in an over-constrained squeeze (a body pinned between a
  // kinematic pusher and a wall); this re-evaluates the CURRENT penetration and projects it cleanly
  // out — the authority that stops a body being shoved THROUGH a wall by the car / player capsule.
  function clampStatic() {
    for (const b of list) {
      if (!b.dynamic || b.sleeping || b.sensor) continue;
      const before = contacts.length;
      groundContacts(b);
      bvhContacts(b);
      let moved = false;
      for (let i = before; i < contacts.length; i++) {
        const c = contacts[i], n = c.n;
        const push = Math.max(c.depth - PEN_SLOP, 0);
        if (push > 1e-6) { b.position[0] += n[0] * push; b.position[1] += n[1] * push; b.position[2] += n[2] * push; moved = true; }
        const vn = b.vel[0] * n[0] + b.vel[1] * n[1] + b.vel[2] * n[2];
        if (vn < 0) { b.vel[0] -= n[0] * vn; b.vel[1] -= n[1] * vn; b.vel[2] -= n[2] * vn; } // no velocity into the wall
      }
      contacts.length = before;   // discard — these were for the clamp only (not the solver/callback)
      if (moved) updateAABB(b);
    }
  }

  // ── broadphase: uniform spatial hash on AABBs ───────────────────────────────
  const CELL = opts.cell ?? 2.0;
  const grid = new Map();
  function hashBodies() {
    grid.clear();
    for (const b of list) {
      const { min, max } = b.aabb;
      // safety net: a NaN/runaway body would blow the cell loop — skip + freeze it
      if (!(max[0] - min[0] < 1e4) || !(max[1] - min[1] < 1e4) || !(max[2] - min[2] < 1e4) ||
          !Number.isFinite(min[0]) || !Number.isFinite(min[1]) || !Number.isFinite(min[2])) {
        if (b.dynamic) { b.vel[0] = b.vel[1] = b.vel[2] = 0; b.angVel[0] = b.angVel[1] = b.angVel[2] = 0; }
        continue;
      }
      const x0 = Math.floor(min[0] / CELL), x1 = Math.floor(max[0] / CELL);
      const y0 = Math.floor(min[1] / CELL), y1 = Math.floor(max[1] / CELL);
      const z0 = Math.floor(min[2] / CELL), z1 = Math.floor(max[2] / CELL);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
        const key = x * 73856093 ^ y * 19349663 ^ z * 83492791;
        let cell = grid.get(key);
        if (!cell) grid.set(key, cell = []);
        cell.push(b);
      }
    }
  }
  const aabbOverlap = (a, b) =>
    a.aabb.min[0] <= b.aabb.max[0] && a.aabb.max[0] >= b.aabb.min[0] &&
    a.aabb.min[1] <= b.aabb.max[1] && a.aabb.max[1] >= b.aabb.min[1] &&
    a.aabb.min[2] <= b.aabb.max[2] && a.aabb.max[2] >= b.aabb.min[2];

  // shape-pair dispatch (preserves pair order a=first for the contact convention)
  function narrowphase(a, b) {
    const sa = a.shape, sb = b.shape;
    if (sa === 'sphere' && sb === 'sphere') sphereSphere(a, b);
    else if (sa === 'capsule' && sb === 'capsule') capsuleCapsule(a, b);
    else if (sa === 'capsule' && sb === 'sphere') capsuleSphere(a, b, false);
    else if (sa === 'sphere' && sb === 'capsule') capsuleSphere(b, a, true);
    else if (sa === 'capsule' && sb === 'box') capsuleBox(a, b, true);
    else if (sa === 'box' && sb === 'capsule') capsuleBox(b, a, false);
    else if (sa === 'sphere') sphereBox(a, b, true);
    else if (sb === 'sphere') sphereBox(b, a, false);
    else boxBox(a, b);
  }
  // sensors don't solve — reuse the narrowphase math, then discard the contacts
  function sensorOverlap(a, b) {
    const before = contacts.length;
    narrowphase(a, b);
    const hit = contacts.length > before;
    contacts.length = before;
    return hit;
  }
  function fireTriggers() {
    for (const b of list) if (b.sensor) { (b._cur || (b._cur = new Set())).clear(); }
    for (const h of _triggerHits) {
      const sp = h.indexOf(' '); const s = bodies.get(h.slice(0, sp));
      if (s && s._cur) s._cur.add(h.slice(sp + 1));
    }
    for (const b of list) {
      if (!b.sensor) continue;
      const prev = b.overlaps, cur = b._cur;
      for (const oid of cur) if (!prev.has(oid)) { prev.add(oid); world.onTrigger && world.onTrigger(b.id, oid, 'enter'); }
      for (const oid of [...prev]) if (!cur.has(oid)) { prev.delete(oid); world.onTrigger && world.onTrigger(b.id, oid, 'exit'); }
    }
  }
  // warm starting: tag new contacts with their pair key and seed last frame's impulse
  function seedWarm(arr, before, key) {
    // per-CONTACT-POINT key (a box pair has up to 4) — sharing one key would
    // re-apply the same stored impulse to every point and inject 4× the energy.
    for (let i = before; i < arr.length; i++) {
      const k = key + ':' + (i - before);
      arr[i].warmKey = k;
      const w = warm.get(k);
      if (w) arr[i].jn = w;
    }
  }

  // ── joints ───────────────────────────────────────────────────────────────────
  let jointSeq = 0;
  function addJoint(spec) {
    const id = spec.id || `j${++jointSeq}`;
    const j = {
      id, type: spec.type || 'distance',
      a: spec.a, b: (spec.b && spec.b !== '__world') ? spec.b : null,
      anchorA: (spec.anchorA || [0, 0, 0]).slice(),
      anchorB: (spec.anchorB || [0, 0, 0]).slice(),
      length: spec.length, stiffness: spec.stiffness ?? 60, damping: spec.damping ?? 6,
      axis: (spec.axis || [0, 1, 0]).slice(),
      worldAnchor: spec.worldAnchor ? spec.worldAnchor.slice() : null,
    };
    joints.push(j);
    return id;
  }
  function removeJoint(id) { const i = joints.findIndex((j) => j.id === id); if (i >= 0) joints.splice(i, 1); }
  // anchor (local point) → world; static side (b===null) uses worldAnchor or anchorB
  function anchorWorld(body, local, o) {
    if (!body) { o[0] = local[0]; o[1] = local[1]; o[2] = local[2]; return o; }
    const R = body.R;
    o[0] = body.position[0] + R[0] * local[0] + R[1] * local[1] + R[2] * local[2];
    o[1] = body.position[1] + R[3] * local[0] + R[4] * local[1] + R[5] * local[2];
    o[2] = body.position[2] + R[6] * local[0] + R[7] * local[1] + R[8] * local[2];
    return o;
  }
  function prepJoints() {
    for (const j of joints) {
      j._a = bodies.get(j.a) || null;
      j._b = j.b ? bodies.get(j.b) : null;
      if (j._a) wake(j._a); if (j._b) wake(j._b);
      // resolve a distance default the first time we see it
      if ((j.type === 'distance' || j.type === 'spring') && j.length == null) {
        const pa = anchorWorld(j._a, j.anchorA, [0, 0, 0]);
        const pb = j._b ? anchorWorld(j._b, j.anchorB, [0, 0, 0]) : (j.worldAnchor || j.anchorB);
        j.length = len([pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]]);
      }
    }
  }
  const _pa = [0, 0, 0], _pb = [0, 0, 0];
  function solveJoint(j, dt) {
    const A = j._a, B = j._b;
    if (!A && !B) return;
    anchorWorld(A, j.anchorA, _pa);
    if (B) anchorWorld(B, j.anchorB, _pb);
    else { const w = j.worldAnchor || j.anchorB; _pb[0] = w[0]; _pb[1] = w[1]; _pb[2] = w[2]; }
    const dx = _pb[0] - _pa[0], dy = _pb[1] - _pa[1], dz = _pb[2] - _pa[2];
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
    const aBody = A || STATICW, bBody = B || STATICW;
    if (j.type === 'point' || j.type === 'hinge') {
      // ball-socket: drive the two anchor points together along each cardinal axis
      const beta = 0.2 / dt; // baumgarte position feedback
      for (const ax of _AXES) {
        const rvx = relVel(bBody, _pb, aBody, _pa);
        const vn = rvx[0] * ax[0] + rvx[1] * ax[1] + rvx[2] * ax[2];
        const sep = dx * ax[0] + dy * ax[1] + dz * ax[2];
        const k = kNormal(aBody, bBody, _pa, ax);
        const jmag = -(vn + beta * sep) / Math.max(k, 1e-9);
        const J = [ax[0] * jmag, ax[1] * jmag, ax[2] * jmag];
        applyAt(bBody, J, _pb); applyAt(aBody, [-J[0], -J[1], -J[2]], _pa);
      }
      if (j.type === 'hinge') hingeAngular(j, aBody, bBody);
    } else if (j.type === 'distance') {
      const n = [dx / d, dy / d, dz / d];
      const rv = relVel(bBody, _pb, aBody, _pa);
      const vn = rv[0] * n[0] + rv[1] * n[1] + rv[2] * n[2];
      const beta = 0.2 / dt, sep = d - j.length;
      const k = kNormal(aBody, bBody, _pa, n);
      const jmag = -(vn + beta * sep) / Math.max(k, 1e-9);
      const J = [n[0] * jmag, n[1] * jmag, n[2] * jmag];
      applyAt(bBody, J, _pb); applyAt(aBody, [-J[0], -J[1], -J[2]], _pa);
    } else if (j.type === 'spring') {
      const n = [dx / d, dy / d, dz / d];
      const rv = relVel(bBody, _pb, aBody, _pa);
      const vn = rv[0] * n[0] + rv[1] * n[1] + rv[2] * n[2];
      const force = (j.stiffness * (d - j.length) + j.damping * vn) * dt; // soft impulse
      const J = [n[0] * force, n[1] * force, n[2] * force];
      applyAt(bBody, J, _pb); applyAt(aBody, [-J[0], -J[1], -J[2]], _pa);
    }
  }
  const _AXES = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const _rvOut = [0, 0, 0];
  function relVel(b, pb, a, pa) {
    velAt(b, pb, _vb); velAt(a, pa, _va);
    _rvOut[0] = _vb[0] - _va[0]; _rvOut[1] = _vb[1] - _va[1]; _rvOut[2] = _vb[2] - _va[2];
    return _rvOut;
  }
  // hinge: remove relative angular velocity perpendicular to the world hinge axis
  function hingeAngular(j, A, B) {
    const ref = A.invMass ? A : B; const R = ref.R, la = j.axis;
    const ax = [R[0] * la[0] + R[1] * la[1] + R[2] * la[2],
                R[3] * la[0] + R[4] * la[1] + R[5] * la[2],
                R[6] * la[0] + R[7] * la[1] + R[8] * la[2]];
    const al = len(ax) || 1; ax[0] /= al; ax[1] /= al; ax[2] /= al;
    for (const body of [A, B]) {
      if (!body.invMass) continue;
      const w = body.angVel, along = w[0] * ax[0] + w[1] * ax[1] + w[2] * ax[2];
      // kill the perpendicular component (keep spin about the axis)
      w[0] = ax[0] * along; w[1] = ax[1] * along; w[2] = ax[2] * along;
    }
  }

  // ── CCD: sweep fast (bullet) bodies so they don't tunnel ─────────────────────
  function ccdSweep(dt) {
    for (const b of list) {
      if (!b.dynamic || !b.bullet || b.sleeping || b._px === undefined) continue;
      const dx = b.position[0] - b._px, dy = b.position[1] - b._py, dz = b.position[2] - b._pz;
      const dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dl < b.radius * 0.5 || dl < 1e-5) continue; // can't tunnel this frame
      const dir = [dx / dl, dy / dl, dz / dl], origin = [b._px, b._py, b._pz];
      const hit = rayAll(origin, dir, dl + b.radius, b.id);
      if (!hit) continue;
      const skin = Math.max(b.radius, 0.05), tt = Math.max(0, hit.t - skin);
      b.position[0] = origin[0] + dir[0] * tt; b.position[1] = origin[1] + dir[1] * tt; b.position[2] = origin[2] + dir[2] * tt;
      updateAABB(b);
      const n = hit.normal || [-dir[0], -dir[1], -dir[2]];
      const vn = b.vel[0] * n[0] + b.vel[1] * n[1] + b.vel[2] * n[2];
      if (vn < 0) {
        const jmag = -(1 + b.restitution) * vn;
        b.vel[0] += n[0] * jmag; b.vel[1] += n[1] * jmag; b.vel[2] += n[2] * jmag;
        const other = hit.id && bodies.get(hit.id);
        if (other && other.dynamic) applyImpulse(hit.id, [-n[0] * jmag * b.mass, -n[1] * jmag * b.mass, -n[2] * jmag * b.mass], hit.point);
      }
      if (world.onContact) world.onContact(b.id, hit.id || '__static', 100, hit.point);
    }
  }

  // ── radial impulse (explosions, shockwaves) ──────────────────────────────────
  function explode(center, radius, force, opts = {}) {
    const up = opts.up ?? 0.35, r2 = radius * radius;
    for (const b of list) {
      if (!b.dynamic) continue;
      const dx = b.position[0] - center[0], dy = b.position[1] - center[1], dz = b.position[2] - center[2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2) continue;
      const d = Math.sqrt(d2) || 1e-4;
      const falloff = 1 - d / radius; // linear
      const mag = force * falloff * (opts.massScaled === false ? 1 : b.mass);
      const n = [dx / d, dy / d + up, dz / d];
      const nl = len(n) || 1;
      applyImpulse(b.id, [n[0] / nl * mag, n[1] / nl * mag, n[2] / nl * mag], opts.point ? b.position : undefined);
    }
  }

  // ── combined ray: static level (BVH) + dynamic/kinematic bodies, closest hit ─
  function normalAt(b, point) {
    if (b.shape === 'sphere' || b.shape === 'capsule') {
      let cx = b.position[0], cy = b.position[1], cz = b.position[2];
      if (b.shape === 'capsule') { capsuleSeg(b, _q0, _q1); closestSegPt(_q0, _q1, point, _r0); cx = _r0[0]; cy = _r0[1]; cz = _r0[2]; }
      const n = [point[0] - cx, point[1] - cy, point[2] - cz], l = len(n) || 1;
      return [n[0] / l, n[1] / l, n[2] / l];
    }
    const l = worldToLocal(b, point, [0, 0, 0]);
    let axis = 0, best = -Infinity;
    for (let i = 0; i < 3; i++) { const v = Math.abs(l[i]) / b.half[i]; if (v > best) { best = v; axis = i; } }
    const sgn = l[axis] >= 0 ? 1 : -1, R = b.R;
    return [R[axis] * sgn, R[axis + 3] * sgn, R[axis + 6] * sgn];
  }
  function rayAll(origin, dir, maxDist = 100, excludeId) {
    let best = null;
    for (const b of list) {
      if (b.id === excludeId || b.sensor) continue;
      if (!b.dynamic && !b.kinematic) continue;
      const h = rayBody(b, origin, dir);
      if (h != null && h < maxDist && (!best || h < best.t)) {
        const point = [origin[0] + dir[0] * h, origin[1] + dir[1] * h, origin[2] + dir[2] * h];
        best = { id: b.id, t: h, point, normal: normalAt(b, point) };
      }
    }
    if (staticBVH) {
      const sh = raycastBVH(staticBVH, origin, dir, maxDist);
      if (sh && (!best || sh.t < best.t)) best = { id: '__static', t: sh.t, point: sh.point, normal: sh.normal };
    }
    return best;
  }

  // ── step ────────────────────────────────────────────────────────────────────
  const _pairSeen = new Set();
  function step(dt) {
    warmNext.clear();
    // integrate
    for (const b of list) {
      if (!b.dynamic || b.sleeping) continue;
      const gs = b.gravityScale;
      b.vel[0] += grav[0] * gs * dt; b.vel[1] += grav[1] * gs * dt; b.vel[2] += grav[2] * gs * dt;
      if (b.bullet) { b._px = b.position[0]; b._py = b.position[1]; b._pz = b.position[2]; } // CCD: remember pre-step pos
      const ld = Math.exp(-b.damping * dt), ad = Math.exp(-b.angularDamping * dt);
      b.vel[0] *= ld; b.vel[1] *= ld; b.vel[2] *= ld;
      b.angVel[0] *= ad; b.angVel[1] *= ad; b.angVel[2] *= ad;
      b.position[0] += b.vel[0] * dt; b.position[1] += b.vel[1] * dt; b.position[2] += b.vel[2] * dt;
      // dq = ½ ω q
      const [qx, qy, qz, qw] = b.quat, [wx, wy, wz] = b.angVel;
      b.quat[0] += 0.5 * dt * (wx * qw + wy * qz - wz * qy);
      b.quat[1] += 0.5 * dt * (wy * qw + wz * qx - wx * qz);
      b.quat[2] += 0.5 * dt * (wz * qw + wx * qy - wy * qx);
      b.quat[3] += 0.5 * dt * (-wx * qx - wy * qy - wz * qz);
      const ql = Math.sqrt(b.quat[0] * b.quat[0] + b.quat[1] * b.quat[1] + b.quat[2] * b.quat[2] + b.quat[3] * b.quat[3]) || 1;
      for (let i = 0; i < 4; i++) b.quat[i] /= ql;
      quatToR(b.quat, b.R);
      updateAABB(b);
    }

    // collide
    contacts.length = 0;
    _triggerHits.clear();
    hashBodies();
    _pairSeen.clear();
    for (const cell of grid.values()) {
      for (let i = 0; i < cell.length; i++) for (let j = i + 1; j < cell.length; j++) {
        const a = cell[i], b = cell[j];
        if (!a.dynamic && !b.dynamic) continue; // static/kinematic pairs do nothing
        // skip unless one side is "active": an awake dynamic OR a kinematic
        // (kinematic movers must wake sleepers they drive into)
        const aActive = a.dynamic ? !a.sleeping : a.kinematic;
        const bActive = b.dynamic ? !b.sleeping : b.kinematic;
        if (!aActive && !bActive) continue;
        // collision filter: both directions of group∩mask must pass
        if (!((a.group & b.mask) && (b.group & a.mask))) continue;
        // dedup pairs shared across cells with a NUMERIC key (no per-pair string
        // alloc). 2^22 supports 4M bodies; product stays < 2^44 (exact in a double).
        const ai = a._idx, bi = b._idx;
        const pk = ai < bi ? ai * 4194304 + bi : bi * 4194304 + ai;
        if (_pairSeen.has(pk)) continue;
        _pairSeen.add(pk);
        if (!aabbOverlap(a, b)) continue;
        // SENSORS: overlap-only — record for enter/exit, never generate a contact
        if (a.sensor || b.sensor) {
          if (sensorOverlap(a, b)) {
            if (a.sensor) _triggerHits.add(a.id + ' ' + b.id);
            if (b.sensor) _triggerHits.add(b.id + ' ' + a.id);
          }
          continue;
        }
        // a touching pair wakes a sleeper
        if (a.sleeping) wake(a);
        if (b.sleeping) wake(b);
        // warm-start key stays STRING id-based (stable persistence across frames);
        // built only for pairs that actually reach narrowphase.
        const key = a.id < b.id ? a.id + '|' + b.id : b.id + '|' + a.id;
        const before = contacts.length;
        narrowphase(a, b);
        seedWarm(contacts, before, key);
      }
    }
    // dynamic bodies vs ground plane + the static level BVH
    for (const b of list) {
      if (!b.dynamic || b.sleeping || b.sensor) continue;
      const before = contacts.length;
      groundContacts(b);
      bvhContacts(b);
      seedWarm(contacts, before, '__world|' + b.id);
    }

    fireTriggers();
    if (joints.length) prepJoints();
    if (contacts.length || joints.length) solve(dt);
    if (staticBVH || ground !== undefined) clampStatic();   // hard depenetrate dynamics from static walls/ground
    ccdSweep(dt);

    // contact callback for meaningful impacts
    if (world.onContact) {
      for (const c of contacts) {
        if (c.jn > 1.5) world.onContact(c.a.id, c.b.id, c.jn, c.p);
      }
    }

    // sleeping
    for (const b of list) {
      if (!b.dynamic || b.sleeping || !b.canSleep) continue;
      if (len(b.vel) < SLEEP_LIN && len(b.angVel) < SLEEP_ANG) {
        b.sleepT += dt;
        if (b.sleepT > SLEEP_TIME) { b.sleeping = true; b.vel.fill?.(0); b.vel[0] = b.vel[1] = b.vel[2] = 0; b.angVel[0] = b.angVel[1] = b.angVel[2] = 0; }
      } else b.sleepT = 0;
      updateAABB(b);
    }

    // double-buffer warm-start impulses (only keys touched this frame survive)
    const _t = warm; warm = warmNext; warmNext = _t;
  }

  // ── ray vs dynamic/kinematic bodies (gun hits, probes) ──────────────────────
  // per-body ray test → t (entry distance) or null. Capsule via segment-vs-ray
  // closest approach. Shared by raycast() and rayAll().
  function rayBody(b, origin, dir) {
    if (b.shape === 'sphere' || b.shape === 'capsule') {
      let cx = b.position[0], cy = b.position[1], cz = b.position[2];
      if (b.shape === 'capsule') { // closest point on the capsule axis to the ray line
        capsuleSeg(b, _q0, _q1);
        // sample the segment midpoint region: clamp segment param to the ray's nearest
        closestSegPt(_q0, _q1, origin, _r0); cx = _r0[0]; cy = _r0[1]; cz = _r0[2];
      }
      const oc = [origin[0] - cx, origin[1] - cy, origin[2] - cz];
      const bq = dot(oc, dir), cq = dot(oc, oc) - b.radius * b.radius;
      const disc = bq * bq - cq;
      if (disc >= 0) { const tt = -bq - Math.sqrt(disc); if (tt > 0) return tt; }
      return null;
    }
    const lo = worldToLocal(b, origin, [0, 0, 0]);
    const R = b.R;
    const ld = [
      R[0] * dir[0] + R[3] * dir[1] + R[6] * dir[2],
      R[1] * dir[0] + R[4] * dir[1] + R[7] * dir[2],
      R[2] * dir[0] + R[5] * dir[1] + R[8] * dir[2]];
    let t0 = 0, t1 = Infinity, ok = true;
    for (let i = 0; i < 3 && ok; i++) {
      if (Math.abs(ld[i]) < 1e-9) { if (Math.abs(lo[i]) > b.half[i]) ok = false; continue; }
      let ta = (-b.half[i] - lo[i]) / ld[i], tb = (b.half[i] - lo[i]) / ld[i];
      if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
      if (t0 > t1) ok = false;
    }
    return (ok && t0 > 0) ? t0 : null;
  }
  function raycast(origin, dir, maxDist = 100) {
    let best = null;
    for (const b of list) {
      if (!b.dynamic && !b.kinematic) continue;
      const t = rayBody(b, origin, dir);
      if (t != null && t < maxDist && (!best || t < best.t)) {
        best = { id: b.id, t, point: [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t] };
      }
    }
    return best;
  }

  return world;
}
