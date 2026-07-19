// core/gl/math.js — allocation-light 3D math on flat Float32Arrays.
// Conventions: column-major mat4 (WebGL order), right-handed, -Z forward.
// Every function takes an optional `out` to avoid per-frame allocation.

export function vec3(x = 0, y = 0, z = 0) { return new Float32Array([x, y, z]); }

export function v3set(out, x, y, z) { out[0] = x; out[1] = y; out[2] = z; return out; }
export function v3copy(out, a) { out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; return out; }
export function v3add(a, b, out = vec3()) { out[0] = a[0] + b[0]; out[1] = a[1] + b[1]; out[2] = a[2] + b[2]; return out; }
export function v3sub(a, b, out = vec3()) { out[0] = a[0] - b[0]; out[1] = a[1] - b[1]; out[2] = a[2] - b[2]; return out; }
export function v3scale(a, s, out = vec3()) { out[0] = a[0] * s; out[1] = a[1] * s; out[2] = a[2] * s; return out; }
export function v3addScaled(a, b, s, out = vec3()) { out[0] = a[0] + b[0] * s; out[1] = a[1] + b[1] * s; out[2] = a[2] + b[2] * s; return out; }
export function v3dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
export function v3cross(a, b, out = vec3()) {
  const ax = a[0], ay = a[1], az = a[2], bx = b[0], by = b[1], bz = b[2];
  out[0] = ay * bz - az * by; out[1] = az * bx - ax * bz; out[2] = ax * by - ay * bx;
  return out;
}
// plain sqrt of the dot, NOT Math.hypot — hypot is variadic + does overflow-safe rescaling
// that costs 3–20× in V8/JSC and buys nothing for graphics-range values (the gl-matrix trick).
export function v3len(a) { return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]); }
export function v3len2(a) { return a[0] * a[0] + a[1] * a[1] + a[2] * a[2]; }
export function v3dist(a, b) { const x = a[0] - b[0], y = a[1] - b[1], z = a[2] - b[2]; return Math.sqrt(x * x + y * y + z * z); }
export function v3normalize(a, out = vec3()) {
  const l = v3len(a);
  if (l < 1e-10) { out[0] = 0; out[1] = 0; out[2] = 0; return out; }
  return v3scale(a, 1 / l, out);
}
export function v3lerp(a, b, t, out = vec3()) {
  out[0] = a[0] + (b[0] - a[0]) * t; out[1] = a[1] + (b[1] - a[1]) * t; out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}

// ---------------------------------------------------------------- quaternion
export function quat(x = 0, y = 0, z = 0, w = 1) { return new Float32Array([x, y, z, w]); }

export function quatFromEuler(yaw, pitch, roll, out = quat()) {
  const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2);
  const cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
  const cr = Math.cos(roll / 2), sr = Math.sin(roll / 2);
  out[0] = sp * cy * cr + cp * sy * sr;
  out[1] = cp * sy * cr - sp * cy * sr;
  out[2] = cp * cy * sr - sp * sy * cr;
  out[3] = cp * cy * cr + sp * sy * sr;
  return out;
}

export function quatMul(a, b, out = quat()) {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3];
  const bx = b[0], by = b[1], bz = b[2], bw = b[3];
  out[0] = aw * bx + ax * bw + ay * bz - az * by;
  out[1] = aw * by - ax * bz + ay * bw + az * bx;
  out[2] = aw * bz + ax * by - ay * bx + az * bw;
  out[3] = aw * bw - ax * bx - ay * by - az * bz;
  return out;
}

export function quatSlerp(a, b, t, out = quat()) {
  let bx = b[0], by = b[1], bz = b[2], bw = b[3];
  let cos = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  let s0, s1;
  if (1 - cos > 1e-6) {
    const omega = Math.acos(cos), so = Math.sin(omega);
    s0 = Math.sin((1 - t) * omega) / so; s1 = Math.sin(t * omega) / so;
  } else { s0 = 1 - t; s1 = t; }
  out[0] = s0 * a[0] + s1 * bx; out[1] = s0 * a[1] + s1 * by;
  out[2] = s0 * a[2] + s1 * bz; out[3] = s0 * a[3] + s1 * bw;
  return out;
}

// ---------------------------------------------------------------- mat4
export function mat4() {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

export function m4identity(out) {
  out.fill(0); out[0] = out[5] = out[10] = out[15] = 1; return out;
}

export function m4copy(out, a) { out.set(a); return out; }

export function m4mul(a, b, out = mat4()) {
  // out = a * b  (safe when out === a or out === b)
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
  let b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3];
  out[0] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
  out[1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
  out[2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
  out[3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
  b0 = b[4]; b1 = b[5]; b2 = b[6]; b3 = b[7];
  out[4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
  out[5] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
  out[6] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
  out[7] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
  b0 = b[8]; b1 = b[9]; b2 = b[10]; b3 = b[11];
  out[8] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
  out[9] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
  out[10] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
  out[11] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
  b0 = b[12]; b1 = b[13]; b2 = b[14]; b3 = b[15];
  out[12] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
  out[13] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
  out[14] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
  out[15] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
  return out;
}

export function m4inv(a, out = mat4()) {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return m4identity(out);
  det = 1.0 / det;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return out;
}

export function m4transpose(a, out = mat4()) {
  if (out === a) {
    let t;
    t = a[1]; out[1] = a[4]; out[4] = t;
    t = a[2]; out[2] = a[8]; out[8] = t;
    t = a[3]; out[3] = a[12]; out[12] = t;
    t = a[6]; out[6] = a[9]; out[9] = t;
    t = a[7]; out[7] = a[13]; out[13] = t;
    t = a[11]; out[11] = a[14]; out[14] = t;
    return out;
  }
  out[0] = a[0]; out[1] = a[4]; out[2] = a[8]; out[3] = a[12];
  out[4] = a[1]; out[5] = a[5]; out[6] = a[9]; out[7] = a[13];
  out[8] = a[2]; out[9] = a[6]; out[10] = a[10]; out[11] = a[14];
  out[12] = a[3]; out[13] = a[7]; out[14] = a[11]; out[15] = a[15];
  return out;
}

export function m4perspective(fovY, aspect, near, far, out = mat4()) {
  const f = 1.0 / Math.tan(fovY / 2), nf = 1 / (near - far);
  out.fill(0);
  out[0] = f / aspect; out[5] = f;
  out[10] = (far + near) * nf; out[11] = -1;
  out[14] = 2 * far * near * nf;
  return out;
}

// orthographic projection (for directional-light shadow maps); maps z to [-1,1]
export function m4ortho(left, right, bottom, top, near, far, out = mat4()) {
  const lr = 1 / (left - right), bt = 1 / (bottom - top), nf = 1 / (near - far);
  out.fill(0);
  out[0] = -2 * lr; out[5] = -2 * bt; out[10] = 2 * nf;
  out[12] = (left + right) * lr; out[13] = (top + bottom) * bt; out[14] = (far + near) * nf;
  out[15] = 1;
  return out;
}

export function m4lookAt(eye, center, up, out = mat4()) {
  const zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
  let zl = Math.sqrt(zx * zx + zy * zy + zz * zz); if (zl < 1e-10) zl = 1;  // sqrt-form, not hypot (per-frame camera)
  const z0 = zx / zl, z1 = zy / zl, z2 = zz / zl;
  let x0 = up[1] * z2 - up[2] * z1, x1 = up[2] * z0 - up[0] * z2, x2 = up[0] * z1 - up[1] * z0;
  let xl = Math.sqrt(x0 * x0 + x1 * x1 + x2 * x2); if (xl < 1e-10) xl = 1;
  x0 /= xl; x1 /= xl; x2 /= xl;
  const y0 = z1 * x2 - z2 * x1, y1 = z2 * x0 - z0 * x2, y2 = z0 * x1 - z1 * x0;
  out[0] = x0; out[1] = y0; out[2] = z0; out[3] = 0;
  out[4] = x1; out[5] = y1; out[6] = z1; out[7] = 0;
  out[8] = x2; out[9] = y2; out[10] = z2; out[11] = 0;
  out[12] = -(x0 * eye[0] + x1 * eye[1] + x2 * eye[2]);
  out[13] = -(y0 * eye[0] + y1 * eye[1] + y2 * eye[2]);
  out[14] = -(z0 * eye[0] + z1 * eye[1] + z2 * eye[2]);
  out[15] = 1;
  return out;
}

export function m4fromTRS(t, r, s, out = mat4()) {
  // r is a quaternion [x,y,z,w]
  const x = r[0], y = r[1], z = r[2], w = r[3];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const sx = s[0], sy = s[1], sz = s[2];
  out[0] = (1 - (yy + zz)) * sx; out[1] = (xy + wz) * sx; out[2] = (xz - wy) * sx; out[3] = 0;
  out[4] = (xy - wz) * sy; out[5] = (1 - (xx + zz)) * sy; out[6] = (yz + wx) * sy; out[7] = 0;
  out[8] = (xz + wy) * sz; out[9] = (yz - wx) * sz; out[10] = (1 - (xx + yy)) * sz; out[11] = 0;
  out[12] = t[0]; out[13] = t[1]; out[14] = t[2]; out[15] = 1;
  return out;
}

export function m4transformPoint(m, p, out = vec3()) {
  const x = p[0], y = p[1], z = p[2];
  const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1;
  out[0] = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
  out[1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
  out[2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
  return out;
}

export function m4transformDir(m, d, out = vec3()) {
  const x = d[0], y = d[1], z = d[2];
  out[0] = m[0] * x + m[4] * y + m[8] * z;
  out[1] = m[1] * x + m[5] * y + m[9] * z;
  out[2] = m[2] * x + m[6] * y + m[10] * z;
  return out;
}

// Project a world point through a viewProj matrix → NDC + clip w.
// Returns {x, y, z, w} where x/y/z are NDC (-1..1); w<=0 means behind camera.
export function projectPoint(viewProj, p, out = { x: 0, y: 0, z: 0, w: 0 }) {
  const x = p[0], y = p[1], z = p[2];
  const cw = viewProj[3] * x + viewProj[7] * y + viewProj[11] * z + viewProj[15];
  out.w = cw;
  const inv = cw !== 0 ? 1 / cw : 0;
  out.x = (viewProj[0] * x + viewProj[4] * y + viewProj[8] * z + viewProj[12]) * inv;
  out.y = (viewProj[1] * x + viewProj[5] * y + viewProj[9] * z + viewProj[13]) * inv;
  out.z = (viewProj[2] * x + viewProj[6] * y + viewProj[10] * z + viewProj[14]) * inv;
  return out;
}

// ---------------------------------------------------------------- frustum / AABB
// Extract 6 planes [a,b,c,d]×6 from a viewProj matrix into a Float32Array(24).
export function frustumPlanes(vp, out = new Float32Array(24)) {
  // rows of vp (column-major): r0=[0,4,8,12] r1=[1,5,9,13] r2=[2,6,10,14] r3=[3,7,11,15]
  const set = (i, a, b, c, d) => {
    const l = Math.sqrt(a * a + b * b + c * c) || 1;  // sqrt-form, not hypot (per-frame culling)
    out[i * 4] = a / l; out[i * 4 + 1] = b / l; out[i * 4 + 2] = c / l; out[i * 4 + 3] = d / l;
  };
  set(0, vp[3] + vp[0], vp[7] + vp[4], vp[11] + vp[8], vp[15] + vp[12]);   // left
  set(1, vp[3] - vp[0], vp[7] - vp[4], vp[11] - vp[8], vp[15] - vp[12]);   // right
  set(2, vp[3] + vp[1], vp[7] + vp[5], vp[11] + vp[9], vp[15] + vp[13]);   // bottom
  set(3, vp[3] - vp[1], vp[7] - vp[5], vp[11] - vp[9], vp[15] - vp[13]);   // top
  set(4, vp[3] + vp[2], vp[7] + vp[6], vp[11] + vp[10], vp[15] + vp[14]);  // near
  set(5, vp[3] - vp[2], vp[7] - vp[6], vp[11] - vp[10], vp[15] - vp[14]);  // far
  return out;
}

// AABB as {min:[x,y,z], max:[x,y,z]} vs 24-float plane set. True = at least partially inside.
export function aabbInFrustum(planes, min, max) {
  for (let i = 0; i < 6; i++) {
    const a = planes[i * 4], b = planes[i * 4 + 1], c = planes[i * 4 + 2], d = planes[i * 4 + 3];
    // pick the AABB corner most in the plane's positive halfspace
    const px = a >= 0 ? max[0] : min[0];
    const py = b >= 0 ? max[1] : min[1];
    const pz = c >= 0 ? max[2] : min[2];
    if (a * px + b * py + c * pz + d < 0) return false;
  }
  return true;
}

// Transform an AABB by a mat4 → new AABB (Arvo's method).
export function aabbTransform(m, min, max, outMin = vec3(), outMax = vec3()) {
  for (let i = 0; i < 3; i++) {
    outMin[i] = outMax[i] = m[12 + i];
    for (let j = 0; j < 3; j++) {
      const e = m[j * 4 + i] * min[j], f = m[j * 4 + i] * max[j];
      if (e < f) { outMin[i] += e; outMax[i] += f; } else { outMin[i] += f; outMax[i] += e; }
    }
  }
  return { min: outMin, max: outMax };
}
