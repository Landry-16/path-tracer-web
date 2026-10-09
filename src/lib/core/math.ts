/**
 * Small vector and affine matrix toolkit shared by the renderer, picking and the editor.
 * Matrices are 3x4 affine transforms stored row-major: [r0c0 r0c1 r0c2 tx, r1c0 ... ty, r2c0 ... tz].
 */

export type Vec3 = [number, number, number];
export type Mat3 = [number, number, number, number, number, number, number, number, number];
export type Affine = [number, number, number, number, number, number, number, number, number, number, number, number];

export const DEG = Math.PI / 180;

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const mul = (a: Vec3, b: Vec3): Vec3 => [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const madd = (a: Vec3, b: Vec3, s: number): Vec3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function normalize(a: Vec3): Vec3 {
  const len = length(a) || 1;
  return [a[0] / len, a[1] / len, a[2] / len];
}

/** Rotation matrix for Euler angles in degrees, applied as Rx * Ry * Rz (three.js "XYZ" order). */
export function rotationMatrix(rotation: Vec3): Mat3 {
  const [x, y, z] = rotation.map((v) => v * DEG);
  const a = Math.cos(x), b = Math.sin(x);
  const c = Math.cos(y), d = Math.sin(y);
  const e = Math.cos(z), f = Math.sin(z);
  return [
    c * e, -c * f, d,
    a * f + b * e * d, a * e - b * f * d, -b * c,
    b * f - a * e * d, b * e + a * f * d, a * c,
  ];
}

/** Inverse of rotationMatrix: Euler angles in degrees from a pure rotation matrix. */
export function eulerFromMatrix(m: Mat3): Vec3 {
  const y = Math.asin(clamp(m[2], -1, 1));
  let x: number;
  let z: number;
  if (Math.abs(m[2]) < 0.9999999) {
    x = Math.atan2(-m[5], m[8]);
    z = Math.atan2(-m[1], m[0]);
  } else {
    x = Math.atan2(m[7], m[4]);
    z = 0;
  }
  return [x / DEG, y / DEG, z / DEG];
}

export function multiplyMat3(a: Mat3, b: Mat3): Mat3 {
  const out = new Array(9).fill(0) as Mat3;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return out;
}

/** Rotation of `angle` radians around a unit axis (Rodrigues). */
export function axisAngleMatrix(axis: Vec3, angle: number): Mat3 {
  const [x, y, z] = normalize(axis);
  const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  return [
    t * x * x + c, t * x * y - s * z, t * x * z + s * y,
    t * x * y + s * z, t * y * y + c, t * y * z - s * x,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c,
  ];
}

export function applyMat3(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/** World transform T * R * S. */
export function composeAffine(position: Vec3, rotation: Vec3, scaleV: Vec3): Affine {
  const r = rotationMatrix(rotation);
  return [
    r[0] * scaleV[0], r[1] * scaleV[1], r[2] * scaleV[2], position[0],
    r[3] * scaleV[0], r[4] * scaleV[1], r[5] * scaleV[2], position[1],
    r[6] * scaleV[0], r[7] * scaleV[1], r[8] * scaleV[2], position[2],
  ];
}

export function invertAffine(m: Affine): Affine {
  const [a, b, c, tx, d, e, f, ty, g, h, i, tz] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  let det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) det = det < 0 ? -1e-12 : 1e-12;
  const inv = 1 / det;
  const r00 = A * inv, r01 = -(b * i - c * h) * inv, r02 = (b * f - c * e) * inv;
  const r10 = B * inv, r11 = (a * i - c * g) * inv, r12 = -(a * f - c * d) * inv;
  const r20 = C * inv, r21 = -(a * h - b * g) * inv, r22 = (a * e - b * d) * inv;
  return [
    r00, r01, r02, -(r00 * tx + r01 * ty + r02 * tz),
    r10, r11, r12, -(r10 * tx + r11 * ty + r12 * tz),
    r20, r21, r22, -(r20 * tx + r21 * ty + r22 * tz),
  ];
}

export function transformPoint(m: Affine, p: Vec3): Vec3 {
  return [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
    m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
    m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
  ];
}

export function transformDirection(m: Affine, d: Vec3): Vec3 {
  return [
    m[0] * d[0] + m[1] * d[1] + m[2] * d[2],
    m[4] * d[0] + m[5] * d[1] + m[6] * d[2],
    m[8] * d[0] + m[9] * d[1] + m[10] * d[2],
  ];
}

/** Normal transform from the inverse matrix: transpose(inverse) applied to n. */
export function transformNormal(inverse: Affine, n: Vec3): Vec3 {
  return normalize([
    inverse[0] * n[0] + inverse[4] * n[1] + inverse[8] * n[2],
    inverse[1] * n[0] + inverse[5] * n[1] + inverse[9] * n[2],
    inverse[2] * n[0] + inverse[6] * n[1] + inverse[10] * n[2],
  ]);
}

/** Length of each basis column, i.e. how much a unit along each local axis measures in world space. */
export function columnLengths(m: Affine): Vec3 {
  return [Math.hypot(m[0], m[4], m[8]), Math.hypot(m[1], m[5], m[9]), Math.hypot(m[2], m[6], m[10])];
}

export function luminance(c: Vec3): number {
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/** "#rrggbb" to linear RGB in [0, 1]. */
export function hexToLinear(hex: string): Vec3 {
  const value = /^#?([0-9a-f]{6})$/i.exec(hex.trim())?.[1] ?? "ffffff";
  return [0, 2, 4].map((i) => srgbToLinear(parseInt(value.slice(i, i + 2), 16) / 255)) as Vec3;
}

/** Linear RGB to "#rrggbb" (values above 1 are clamped). */
export function linearToHex(c: Vec3): string {
  return (
    "#" +
    c
      .map((v) => Math.round(clamp(linearToSrgb(clamp(v, 0, 1)), 0, 1) * 255).toString(16).padStart(2, "0"))
      .join("")
  );
}

export function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}
