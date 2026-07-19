// core/gl/controller.js — capsule FPS character controller over a static BVH.
// Pure simulation: no DOM, no GL. Drive it from a fixed-timestep tick.
//
//   const c = createController(bvh, { radius, height, speed, ... });
//   c.update(dt, { fwd, right, jump, sprint, yaw });   // dt seconds (fixed)
//   c.position  → Float32Array[3] (capsule FEET point)
//   c.eye()     → Float32Array[3] (camera position = feet + eyeHeight)
//
// Collision: integrate, then ≤3 passes of capsule-vs-BVH MTV resolution.
// Ground = any contact normal with y > 0.7. Step-up: on a blocking wall
// contact, retry the move lifted by maxStep and keep it if it resolves clean.

import { vec3, v3copy } from './math.js';
import { capsuleHitsBVH } from './bvh.js';

export function createController(bvh, spec = {}) {
  const radius = spec.radius ?? 0.35;
  const height = Math.max(spec.height ?? 1.8, radius * 2 + 0.01);
  const eyeHeight = spec.eyeHeight ?? height - 0.15;
  const speed = spec.speed ?? 5;
  const sprintMul = spec.sprintMul ?? 1.6;
  const accel = spec.accel ?? 60;
  const friction = spec.friction ?? 10;
  const airControl = spec.airControl ?? 0.25;
  const gravity = spec.gravity ?? 22;       // gamey gravity feels better than 9.8
  const groundStick = spec.groundStick ?? 2.5; // grounded: a small CONSTANT down-velocity instead of
  // ACCUMULATING gravity each frame — kills the per-frame sink/jitter and stops the (kinematic) capsule
  // from driving props it stands on downward. Still hugs downhill + steps (probes down each frame).
  const jumpSpeed = spec.jumpSpeed ?? 7.5;
  const coyoteTime = spec.coyoteTime ?? 0.12; // jump grace after walking off a ledge
  const jumpBuffer = spec.jumpBuffer ?? 0.12; // early-press grace before landing
  const jumpCut = spec.jumpCut ?? 0.5;        // release mid-rise → remaining lift multiplier
  const maxStep = spec.maxStep ?? 0.45;
  const maxSlope = 0.7;                      // normal.y above this = walkable ground
  // swim mode (opt-in; engaged per-tick via input.swim — see gl-scene water volumes):
  // free 6DOF movement ALONG the look direction + a vertical axis, with 3D drag so
  // you glide and stop. No gravity, no jump, no ground — you float.
  const swimSpeed = spec.swimSpeed ?? speed * 1.15;
  const swimAccel = spec.swimAccel ?? 42;
  const swimDrag = spec.swimDrag ?? 3.5;
  const canSwim = !!spec.swim;
  const fly = !!spec.fly;   // free-fly camera: always 6DOF swim-step (no gravity/ground)

  // water awareness lives HERE (body physics), not in gl-scene. The scene hands us
  // its gl-water volumes via setWater(); each frame we test the body against them and
  // either SWIM (swim:true) or apply buoyancy/drag/current (wade-in). The scene keeps
  // only scene concerns (underwater fog, droplet spray, submerged/surfaced events).
  let waterVols = [];
  const setWater = (v) => { waterVols = v || []; };
  function bodyWater(p) {
    for (const wv of waterVols) {
      if (p[0] > wv.min[0] && p[0] < wv.max[0] && p[2] > wv.min[2] && p[2] < wv.max[2] && p[1] < wv.level && p[1] > wv.min[1]) return wv;
    }
    return null;
  }

  const stepSmooth = spec.stepSmooth ?? 11; // camera glide rate after step snaps

  const position = spec.position ? Float32Array.from(spec.position) : vec3(0, 2, 0);
  const velocity = vec3();
  const state = { position, velocity, onGround: false };
  let stepOffset = 0; // visual-only: absorbs sudden grounded y-changes (stairs)
  // jump-feel state
  let sinceGround = 1e9;    // seconds airborne (coyote window)
  let jumpBufT = 0;         // pending early jump press
  let prevJumpHeld = false;
  let jumping = false;      // rising from OUR jump → jump-cut eligible
  let landImpact = 0;       // accumulated downward landing speed; feel layers consume

  const p0 = vec3(), p1 = vec3(), eyeOut = vec3();
  const contacts = [];

  function capsuleEnds(pos) {
    p0[0] = pos[0]; p0[1] = pos[1] + radius; p0[2] = pos[2];
    p1[0] = pos[0]; p1[1] = pos[1] + height - radius; p1[2] = pos[2];
  }

  // Resolve penetrations at `pos`; returns {ground, blocked} and mutates pos/velocity.
  function resolve(pos, vel) {
    let ground = false, blocked = false;
    for (let pass = 0; pass < 3; pass++) {
      capsuleEnds(pos);
      if (!capsuleHitsBVH(bvh, p0, p1, radius, contacts)) break;
      // deepest contact first — most stable single-pass behavior
      contacts.sort((a, b) => b.depth - a.depth);
      const c = contacts[0];
      const [nx, ny, nz] = c.normal;
      pos[0] += nx * c.depth; pos[1] += ny * c.depth; pos[2] += nz * c.depth;
      const vn = vel[0] * nx + vel[1] * ny + vel[2] * nz;
      if (vn < 0) { vel[0] -= nx * vn; vel[1] -= ny * vn; vel[2] -= nz * vn; }
      if (ny > maxSlope) ground = true;
      else if (Math.abs(ny) < maxSlope) blocked = true; // wall-ish
    }
    return { ground, blocked };
  }

  // ── dynamic rigid bodies: stand ON props and shove them (player-authoritative) ──
  // The scene hands us live phys3d bodies via getBodies() + an applyImpulse via
  // pushBody(). We resolve the capsule against each (push the PLAYER out, ground if
  // the contact faces up) and shove the body when we walk into its side. This makes
  // crates/boards standable AND pushable WITHOUT a separate kinematic mirror body
  // (which fought the controller and made standing on props "bug out").
  const getBodies = spec.getBodies || null;
  const pushBody = spec.pushBody || null;
  const _seg = (a, b, p, o) => {
    const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
    const d = abx * abx + aby * aby + abz * abz || 1;
    let t = ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby + (p[2] - a[2]) * abz) / d;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    o[0] = a[0] + abx * t; o[1] = a[1] + aby * t; o[2] = a[2] + abz * t; return o;
  };
  const _bc = vec3(), _bn = vec3(), _bp = vec3();
  // returns penetration {depth, n:_bn, p:_bp} (n points body→player) or null
  function bodyContact(b) {
    capsuleEnds(position);
    if (b.shape === 'sphere' || b.shape === 'capsule') {
      let cx = b.position[0], cy = b.position[1], cz = b.position[2];
      if (b.shape === 'capsule') { // body's own segment along its local +Y
        const R = b.R, hy = b.halfH || 0; cy = b.position[1]; // approx: use center
        cx = b.position[0]; cz = b.position[2]; void R; void hy;
      }
      _bc[0] = cx; _bc[1] = cy; _bc[2] = cz;
      _seg(p0, p1, _bc, _bp);
      const dx = _bp[0] - cx, dy = _bp[1] - cy, dz = _bp[2] - cz;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz), rr = radius + b.radius;
      if (dist >= rr || dist < 1e-6) return null;
      _bn[0] = dx / dist; _bn[1] = dy / dist; _bn[2] = dz / dist;
      _bp[0] = cx + _bn[0] * b.radius; _bp[1] = cy + _bn[1] * b.radius; _bp[2] = cz + _bn[2] * b.radius;
      return { depth: rr - dist, mass: b.mass || 1, id: b.id };
    }
    // box (OBB): closest segment point to box center, then sphere-vs-box there
    const R = b.R || [1, 0, 0, 0, 1, 0, 0, 0, 1], h = b.half, pc = b.position;
    _seg(p0, p1, pc, _bc);
    const dx = _bc[0] - pc[0], dy = _bc[1] - pc[1], dz = _bc[2] - pc[2];
    const lx = R[0] * dx + R[3] * dy + R[6] * dz, ly = R[1] * dx + R[4] * dy + R[7] * dz, lz = R[2] * dx + R[5] * dy + R[8] * dz;
    const cl = [Math.max(-h[0], Math.min(h[0], lx)), Math.max(-h[1], Math.min(h[1], ly)), Math.max(-h[2], Math.min(h[2], lz))];
    const ex = lx - cl[0], ey = ly - cl[1], ez = lz - cl[2];
    let dd = Math.sqrt(ex * ex + ey * ey + ez * ez), nlx, nly, nlz, depth;
    if (dd > 1e-6) { if (dd >= radius) return null; nlx = ex / dd; nly = ey / dd; nlz = ez / dd; depth = radius - dd; }
    else { // segment point inside the box → pop out nearest face
      let best = Infinity, ax = 0, sg = 1;
      const ll = [lx, ly, lz];
      for (let i = 0; i < 3; i++) { const pen = h[i] - Math.abs(ll[i]); if (pen < best) { best = pen; ax = i; sg = ll[i] >= 0 ? 1 : -1; } }
      nlx = ax === 0 ? sg : 0; nly = ax === 1 ? sg : 0; nlz = ax === 2 ? sg : 0; depth = best + radius; cl[ax] = sg * h[ax];
    }
    _bn[0] = R[0] * nlx + R[1] * nly + R[2] * nlz; _bn[1] = R[3] * nlx + R[4] * nly + R[5] * nlz; _bn[2] = R[6] * nlx + R[7] * nly + R[8] * nlz;
    _bp[0] = pc[0] + R[0] * cl[0] + R[1] * cl[1] + R[2] * cl[2];
    _bp[1] = pc[1] + R[3] * cl[0] + R[4] * cl[1] + R[5] * cl[2];
    _bp[2] = pc[2] + R[6] * cl[0] + R[7] * cl[1] + R[8] * cl[2];
    return { depth, mass: b.mass || 1, id: b.id };
  }
  function resolveBodies(vel) {
    if (!getBodies) return false;
    let ground = false;
    const reach = height + radius + 2;
    for (const b of getBodies()) {
      if (!b.dynamic || b.sensor) continue;
      // cheap reject: body center beyond the capsule's reach (+ its own extent)
      const dx = b.position[0] - position[0], dz = b.position[2] - position[2];
      const dy = b.position[1] - (position[1] + height / 2);
      const ext = b.radius || (b.half ? Math.max(b.half[0], b.half[1], b.half[2]) : 0.5);
      if (dx * dx + dy * dy + dz * dz > (reach + ext) * (reach + ext)) continue;
      const hit = bodyContact(b);
      if (!hit) continue;
      const nx = _bn[0], ny = _bn[1], nz = _bn[2];
      position[0] += nx * hit.depth; position[1] += ny * hit.depth; position[2] += nz * hit.depth;
      const vn = vel[0] * nx + vel[1] * ny + vel[2] * nz;
      if (vn < 0) { vel[0] -= nx * vn; vel[1] -= ny * vn; vel[2] -= nz * vn; }
      if (ny > maxSlope) ground = true;
      // NOTE: we do NOT impulse the body here. The controller is mirrored into
      // physics3d as a KINEMATIC capsule (gl-scene), so the solver pushes props
      // with REAL momentum (smooth) — the old hand-tuned impulse punted crates.
      // resolveBodies only keeps the PLAYER out of / standing on dynamic bodies.
    }
    return ground;
  }

  // ── swim integration: 6DOF along look dir + vertical axis, drag glide, collide ──
  function swimStep(dt, input, sin, cos) {
    const pitch = input.pitch ?? 0;
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    // forward = look direction (incl pitch); right = yaw-only; up = world up
    const fX = -sin * cp, fY = sp, fZ = -cos * cp;
    const rX = cos, rZ = -sin;
    const f = input.fwd ?? 0, r = input.right ?? 0, u = input.up ?? 0;
    let wx = fX * f + rX * r, wy = fY * f + u, wz = fZ * f + rZ * r;
    const wl = Math.sqrt(wx * wx + wy * wy + wz * wz);
    const damp = Math.exp(-swimDrag * dt);
    velocity[0] *= damp; velocity[1] *= damp; velocity[2] *= damp;   // glide to rest
    if (wl > 1e-4) {
      wx /= wl; wy /= wl; wz /= wl;
      const max = swimSpeed * (input.sprint ? sprintMul : 1);
      velocity[0] += wx * swimAccel * dt; velocity[1] += wy * swimAccel * dt; velocity[2] += wz * swimAccel * dt;
      const s = Math.sqrt(velocity[0] * velocity[0] + velocity[1] * velocity[1] + velocity[2] * velocity[2]);
      if (s > max) { const k = max / s; velocity[0] *= k; velocity[1] *= k; velocity[2] *= k; }
    }
    position[0] += velocity[0] * dt; position[1] += velocity[1] * dt; position[2] += velocity[2] * dt;
    resolve(position, velocity);          // collide with seabed / walls
    resolveBodies(velocity);              // …and dynamic props while swimming
    state.onGround = false;
    stepOffset *= Math.exp(-stepSmooth * dt);
    return state;
  }

  function update(dt, input = {}) {
    const yBefore = position[1], groundBefore = state.onGround;
    const yaw = input.yaw ?? 0;
    const sin = Math.sin(yaw), cos = Math.cos(yaw);
    const wv = bodyWater(position);                 // which gl-water volume is the body in?
    if (fly || (canSwim && wv)) return swimStep(dt, input, sin, cos);  // free-fly = always swim
    // camera-relative wish direction on the xz plane (-Z forward at yaw 0)
    const wishX = (input.right ?? 0) * cos - (input.fwd ?? 0) * sin;
    const wishZ = -(input.fwd ?? 0) * cos - (input.right ?? 0) * sin;
    const wishLen = Math.sqrt(wishX * wishX + wishZ * wishZ);
    const maxSpeed = speed * (input.sprint ? sprintMul : 1);

    if (state.onGround) {
      // exponential friction, then accelerate toward wish dir
      const damp = Math.exp(-friction * dt);
      velocity[0] *= damp; velocity[2] *= damp;
    }
    if (wishLen > 1e-4) {
      const ctl = state.onGround ? 1 : airControl;
      const nx = wishX / wishLen, nz = wishZ / wishLen;
      velocity[0] += nx * accel * ctl * dt;
      velocity[2] += nz * accel * ctl * dt;
      const hs = Math.sqrt(velocity[0] * velocity[0] + velocity[2] * velocity[2]);
      if (hs > maxSpeed) { velocity[0] *= maxSpeed / hs; velocity[2] *= maxSpeed / hs; }
    }

    // grounded & settling → constant down-stick (no gravity build-up); airborne/rising → real gravity.
    // (a jump initiated this frame overrides the stick below via jumpSpeed.)
    if (groundBefore && !jumping && velocity[1] <= 0) velocity[1] = -groundStick;
    else velocity[1] -= gravity * dt;

    // jump feel: buffer the press, allow it within the coyote window, cut on release
    const jumpHeld = !!input.jump;
    if (jumpHeld && !prevJumpHeld) jumpBufT = jumpBuffer;
    else jumpBufT = Math.max(0, jumpBufT - dt);
    prevJumpHeld = jumpHeld;
    sinceGround = state.onGround ? 0 : sinceGround + dt;
    if (jumpBufT > 0 && (state.onGround || (sinceGround < coyoteTime && !jumping && velocity[1] <= 0))) {
      velocity[1] = jumpSpeed;
      state.onGround = false;
      jumpBufT = 0; sinceGround = 1e9; jumping = true;
    }
    if (jumping && !jumpHeld && velocity[1] > 0) { velocity[1] *= jumpCut; jumping = false; }
    if (velocity[1] <= 0) jumping = false;

    const fallSpeed = -velocity[1]; // pre-resolve: landing impact reads this
    const prevX = position[0], prevY = position[1], prevZ = position[2];
    const preVX = velocity[0], preVZ = velocity[2]; // resolve() zeroes wall-facing velocity — keep it for step-up
    position[0] += velocity[0] * dt;
    position[1] += velocity[1] * dt;
    position[2] += velocity[2] * dt;

    const res = resolve(position, velocity);

    // step-up: blocked by a wall while grounded → probe forward ~a radius at
    // lift height; if clear, settle down and keep the landing if it gained height
    if (res.blocked && state.onGround && (preVX !== 0 || preVZ !== 0)) {
      const hl = Math.sqrt(preVX * preVX + preVZ * preVZ);
      const probe = Math.max(hl * dt, radius * 0.75);
      const tryPos = vec3(prevX + (preVX / hl) * probe, prevY + maxStep, prevZ + (preVZ / hl) * probe);
      const tryVel = vec3(preVX, 0, preVZ);
      const r2 = resolve(tryPos, tryVel);
      if (!r2.blocked) {
        // settle down in increments (one extra so a flush landing penetrates)
        const STEPS = 6;
        let landed = false;
        for (let s = 0; s <= STEPS && !landed; s++) {
          tryPos[1] -= maxStep / STEPS;
          const r3 = resolve(tryPos, tryVel);
          if (r3.ground) landed = true;
        }
        if (landed && tryPos[1] > prevY + 1e-3) {
          v3copy(position, tryPos);
          velocity[0] = tryVel[0]; velocity[2] = tryVel[2];
          if (velocity[1] < 0) velocity[1] = 0;
          res.ground = true;
        }
      }
    }

    // resolve against dynamic props (stand on them / shove them) — once, after BVH
    const bodyGround = resolveBodies(velocity);
    state.onGround = res.ground || bodyGround;

    // GROUND SNAP (downhill following): if we were grounded, aren't jumping/rising, and
    // walked off into thin air this tick (the slope dropped away faster than gravity),
    // probe straight DOWN up to maxStep and stick to the surface — so the capsule HUGS
    // a downhill heightfield instead of hopping off each triangle and free-falling.
    if (!state.onGround && groundBefore && !jumping && velocity[1] <= 0) {
      const snapPos = vec3(position[0], position[1] - maxStep, position[2]);
      const r4 = resolve(snapPos, vec3(0, 0, 0));
      if (r4.ground) { position[1] = snapPos[1]; state.onGround = true; }
    }
    if (state.onGround && velocity[1] < 0) velocity[1] = 0;
    if (!groundBefore && state.onGround && fallSpeed > 0.5) landImpact = Math.max(landImpact, fallSpeed);

    // stair smoothing: a sudden grounded→grounded height change (step-up snap,
    // or stepping down a ledge) is absorbed into a camera offset that decays —
    // the capsule teleports, the eye glides
    if (groundBefore && state.onGround) {
      const dy = position[1] - yBefore;
      if (Math.abs(dy) > 0.03) stepOffset -= dy;
    }
    if (stepOffset > 0.6) stepOffset = 0.6;
    else if (stepOffset < -0.6) stepOffset = -0.6;
    stepOffset *= Math.exp(-stepSmooth * dt);

    // non-swim body in water: buoyancy + horizontal drag + current (wade-in lakes).
    // (a swim:true body returned via swimStep above, so this only runs for walkers.)
    if (wv) {
      const k = Math.exp(-(wv.drag ?? 3.2) * dt);
      velocity[0] *= k; velocity[2] *= k;
      if (wv.flow) { velocity[0] += wv.flow[0] * (wv.flowForce ?? 2.5) * dt; velocity[2] += wv.flow[1] * (wv.flowForce ?? 2.5) * dt; }
      velocity[1] += (wv.buoyancy ?? 19) * dt;
    }
    return state;
  }

  function eye() {
    eyeOut[0] = position[0]; eyeOut[1] = position[1] + eyeHeight + stepOffset; eyeOut[2] = position[2];
    return eyeOut;
  }

  function setPosition(x, y, z) {
    position[0] = x; position[1] = y; position[2] = z;
    velocity.fill(0); state.onGround = false; stepOffset = 0; // teleports don't glide
  }

  // landing impact (downward m/s at touchdown) since last call — read-and-clear
  // so a feel layer on the frame loop can't miss a fixed-tick landing
  function consumeLanding() { const v = landImpact; landImpact = 0; return v; }

  return {
    position, velocity, eye, update, setPosition, consumeLanding, setWater,
    setBVH: (b) => { bvh = b; },   // swap the collision BVH (dynamic doors → world.setCollider rebuilds it)
    get onGround() { return state.onGround; },
    radius, height, eyeHeight, speed,
  };
}
