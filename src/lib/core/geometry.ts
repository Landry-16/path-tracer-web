/**
 * World-space geometry derived from the scene document: object matrices, light frames,
 * bounds and CPU ray casting (used for picking, the light follow mode and the editor gizmos).
 * The intersection routines mirror the GLSL ones in trace.frag.
 */

import {
  applyMat3,
  columnLengths,
  composeAffine,
  dot,
  invertAffine,
  length,
  madd,
  normalize,
  rotationMatrix,
  scale,
  sub,
  transformDirection,
  transformNormal,
  transformPoint,
  type Affine,
  type Vec3,
} from "./math";
import type { Light, Scene, SceneObject, ShapeType } from "./scene";
import type { Ray } from "./camera";

/** Radius of the sphere bounding the unit cube [-0.5, 0.5]^3. */
const UNIT_BOUND = Math.sqrt(0.75);

export interface ObjectFrame {
  matrix: Affine;
  inverse: Affine;
  center: Vec3;
  boundRadius: number;
}

export function objectFrame(object: SceneObject): ObjectFrame {
  const matrix = composeAffine(object.position, object.rotation, object.scale);
  const lengths = columnLengths(matrix);
  return {
    matrix,
    inverse: invertAffine(matrix),
    center: [...object.position],
    boundRadius: UNIT_BOUND * Math.max(lengths[0], lengths[1], lengths[2]) * 1.0001,
  };
}

export interface LightFrame {
  /** Half extent vectors of an area light. */
  u: Vec3;
  v: Vec3;
  /** Direction the light shines towards (local -Y). */
  normal: Vec3;
}

export function lightFrame(light: Light): LightFrame {
  const r = rotationMatrix(light.rotation);
  const x = applyMat3(r, [1, 0, 0]);
  const y = applyMat3(r, [0, 1, 0]);
  const z = applyMat3(r, [0, 0, 1]);
  return {
    u: scale(x, light.size[0] / 2),
    v: scale(z, light.size[1] / 2),
    normal: scale(y, -1),
  };
}

/* ---------------------------------------------------------------- shapes */

interface LocalHit {
  t: number;
  normal: Vec3;
}

function solveQuadratic(a: number, b: number, c: number): [number, number] | null {
  // a t^2 + 2 b t + c = 0
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) < 1e-12) return null;
    const t = -c / (2 * b);
    return [t, t];
  }
  const disc = b * b - a * c;
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  const t0 = (-b - s) / a;
  const t1 = (-b + s) / a;
  return t0 < t1 ? [t0, t1] : [t1, t0];
}

function consider(best: LocalHit | null, t: number, normal: Vec3, tMin: number): LocalHit | null {
  if (t > tMin && (!best || t < best.t)) return { t, normal };
  return best;
}

/** Ray against a unit shape in object space. `d` does not need to be normalized. */
export function intersectShape(shape: ShapeType, o: Vec3, d: Vec3, tMin = 1e-6): LocalHit | null {
  let best: LocalHit | null = null;
  switch (shape) {
    case "sphere": {
      const roots = solveQuadratic(dot(d, d), dot(o, d), dot(o, o) - 0.25);
      if (!roots) return null;
      for (const t of roots) best = consider(best, t, normalize(madd(o, d, t)), tMin);
      return best;
    }
    case "box": {
      let tNear = -Infinity;
      let tFar = Infinity;
      for (let i = 0; i < 3; i++) {
        if (Math.abs(d[i]) < 1e-12) {
          if (o[i] < -0.5 || o[i] > 0.5) return null;
          continue;
        }
        let t0 = (-0.5 - o[i]) / d[i];
        let t1 = (0.5 - o[i]) / d[i];
        if (t0 > t1) [t0, t1] = [t1, t0];
        tNear = Math.max(tNear, t0);
        tFar = Math.min(tFar, t1);
      }
      if (tNear > tFar) return null;
      for (const t of [tNear, tFar]) {
        const p = madd(o, d, t);
        const a = p.map(Math.abs);
        const axis = a[0] > a[1] && a[0] > a[2] ? 0 : a[1] > a[2] ? 1 : 2;
        const n: Vec3 = [0, 0, 0];
        n[axis] = Math.sign(p[axis]) || 1;
        best = consider(best, t, n, tMin);
      }
      return best;
    }
    case "cylinder": {
      const roots = solveQuadratic(d[0] * d[0] + d[2] * d[2], o[0] * d[0] + o[2] * d[2], o[0] * o[0] + o[2] * o[2] - 0.25);
      if (roots) {
        for (const t of roots) {
          const p = madd(o, d, t);
          if (Math.abs(p[1]) <= 0.5) best = consider(best, t, normalize([p[0], 0, p[2]]), tMin);
        }
      }
      if (Math.abs(d[1]) > 1e-12) {
        for (const y of [-0.5, 0.5]) {
          const t = (y - o[1]) / d[1];
          const p = madd(o, d, t);
          if (p[0] * p[0] + p[2] * p[2] <= 0.25) best = consider(best, t, [0, Math.sign(y), 0], tMin);
        }
      }
      return best;
    }
    case "cone": {
      // Apex at y = 0.5, base of radius 0.5 at y = -0.5: x^2 + z^2 = ((0.5 - y) / 2)^2.
      const s0 = 0.5 - o[1];
      const roots = solveQuadratic(
        d[0] * d[0] + d[2] * d[2] - (d[1] * d[1]) / 4,
        o[0] * d[0] + o[2] * d[2] + (s0 * d[1]) / 4,
        o[0] * o[0] + o[2] * o[2] - (s0 * s0) / 4,
      );
      if (roots) {
        for (const t of roots) {
          const p = madd(o, d, t);
          if (p[1] >= -0.5 && p[1] <= 0.5) best = consider(best, t, normalize([2 * p[0], (0.5 - p[1]) / 2, 2 * p[2]]), tMin);
        }
      }
      if (Math.abs(d[1]) > 1e-12) {
        const t = (-0.5 - o[1]) / d[1];
        const p = madd(o, d, t);
        if (p[0] * p[0] + p[2] * p[2] <= 0.25) best = consider(best, t, [0, -1, 0], tMin);
      }
      return best;
    }
    case "plane":
    case "disk": {
      if (Math.abs(d[1]) < 1e-12) return null;
      const t = -o[1] / d[1];
      const p = madd(o, d, t);
      const inside = shape === "plane" ? Math.abs(p[0]) <= 0.5 && Math.abs(p[2]) <= 0.5 : p[0] * p[0] + p[2] * p[2] <= 0.25;
      return inside ? consider(null, t, [0, 1, 0], tMin) : null;
    }
  }
}

/* ------------------------------------------------------------- raycast */

export interface RayHit {
  kind: "object" | "light";
  id: string;
  t: number;
  point: Vec3;
  normal: Vec3;
}

export interface RaycastOptions {
  /** Include light emitters and handles. Defaults to true. */
  lights?: boolean;
  /** Radius used to pick point lights and the sun handle. */
  handleRadius?: number;
  /** Ids to skip. */
  ignore?: Set<string>;
}

function raySphere(ray: Ray, center: Vec3, radius: number): number | null {
  const oc = sub(ray.origin, center);
  const b = dot(oc, ray.direction);
  const c = dot(oc, oc) - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  const t = -b - s > 1e-6 ? -b - s : -b + s;
  return t > 1e-6 ? t : null;
}

/** Casts a world ray against the scene and returns the closest object or light. */
export function raycast(scene: Scene, ray: Ray, options: RaycastOptions = {}): RayHit | null {
  let best: RayHit | null = null;
  const ignore = options.ignore;

  for (const object of scene.objects) {
    if (!object.visible || ignore?.has(object.id)) continue;
    const f = objectFrame(object);
    const tb = raySphere(ray, f.center, f.boundRadius);
    if (tb === null && length(sub(ray.origin, f.center)) > f.boundRadius) continue;
    const o = transformPoint(f.inverse, ray.origin);
    const d = transformDirection(f.inverse, ray.direction);
    const hit = intersectShape(object.shape, o, d);
    if (hit && (!best || hit.t < best.t)) {
      best = {
        kind: "object",
        id: object.id,
        t: hit.t,
        point: madd(ray.origin, ray.direction, hit.t),
        normal: transformNormal(f.inverse, hit.normal),
      };
    }
  }

  if (options.lights !== false) {
    const handle = options.handleRadius ?? 0.08;
    for (const light of scene.lights) {
      if (ignore?.has(light.id)) continue;
      let t: number | null = null;
      let normal: Vec3 = [0, 1, 0];
      if (light.type === "area") {
        const { u, v, normal: n } = lightFrame(light);
        const denom = dot(ray.direction, n);
        if (Math.abs(denom) > 1e-9) {
          const tt = dot(sub(light.position, ray.origin), n) / denom;
          const p = madd(ray.origin, ray.direction, tt);
          const rel = sub(p, light.position);
          if (tt > 1e-6 && Math.abs(dot(rel, u) / dot(u, u)) <= 1 && Math.abs(dot(rel, v) / dot(v, v)) <= 1) {
            t = tt;
            normal = n;
          }
        }
      } else {
        const radius = light.type === "sphere" ? Math.max(light.radius, handle * 0.5) : handle;
        t = raySphere(ray, light.position, radius);
        if (t !== null) normal = normalize(sub(madd(ray.origin, ray.direction, t), light.position));
      }
      if (t !== null && (!best || t < best.t)) {
        best = { kind: "light", id: light.id, t, point: madd(ray.origin, ray.direction, t), normal };
      }
    }
  }
  return best;
}

/* -------------------------------------------------------------- bounds */

export interface Bounds {
  min: Vec3;
  max: Vec3;
}

/** Local half height of a shape: flat shapes have no thickness. */
function halfHeight(object: SceneObject): number {
  return object.shape === "plane" || object.shape === "disk" ? 0 : 0.5;
}

export function objectBounds(object: SceneObject): Bounds {
  const f = objectFrame(object);
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const hy = halfHeight(object);
  for (let i = 0; i < 8; i++) {
    const corner: Vec3 = [i & 1 ? 0.5 : -0.5, i & 2 ? hy : -hy, i & 4 ? 0.5 : -0.5];
    const p = transformPoint(f.matrix, corner);
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], p[k]);
      max[k] = Math.max(max[k], p[k]);
    }
  }
  return { min, max };
}

/** Bounds of all visible objects, or null for an empty scene. */
export function sceneBounds(scene: Scene): Bounds | null {
  let result: Bounds | null = null;
  for (const object of scene.objects) {
    if (!object.visible) continue;
    const b = objectBounds(object);
    if (!result) result = b;
    else {
      result = {
        min: result.min.map((v, k) => Math.min(v, b.min[k])) as Vec3,
        max: result.max.map((v, k) => Math.max(v, b.max[k])) as Vec3,
      };
    }
  }
  return result;
}

/** Corners of the object's oriented box, used to draw the selection outline. */
export function objectCorners(object: SceneObject): Vec3[] {
  const { matrix } = objectFrame(object);
  const corners: Vec3[] = [];
  const hy = halfHeight(object);
  for (let i = 0; i < 8; i++) {
    corners.push(transformPoint(matrix, [i & 1 ? 0.5 : -0.5, i & 2 ? hy : -hy, i & 4 ? 0.5 : -0.5]));
  }
  return corners;
}

/** Corners of an area light rectangle, in order around the edge. */
export function areaCorners(light: Light): Vec3[] {
  const { u, v } = lightFrame(light);
  const p = light.position;
  return [
    madd(madd(p, u, -1), v, -1),
    madd(madd(p, u, 1), v, -1),
    madd(madd(p, u, 1), v, 1),
    madd(madd(p, u, -1), v, 1),
  ];
}
