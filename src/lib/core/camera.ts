import { DEG, add, clamp, cross, dot, madd, normalize, scale, sub, type Vec3 } from "./math";
import type { Camera } from "./scene";

export interface CameraBasis {
  position: Vec3;
  right: Vec3;
  up: Vec3;
  forward: Vec3;
  /** tan(fov / 2), the half height of the image plane at distance 1. */
  tanHalfFov: number;
  focusDistance: number;
}

export interface Ray {
  origin: Vec3;
  direction: Vec3;
}

/**
 * Vertical tan(fov / 2) actually used for an image of the given aspect ratio: the field of
 * view is vertical for landscape images and horizontal for portrait ones, so a scene framed
 * on a desktop stays framed on a phone held upright.
 */
export function viewTanHalf(tanHalfFov: number, aspect: number): number {
  return aspect < 1 ? tanHalfFov / aspect : tanHalfFov;
}

/** Orbit camera basis: the eye sits on a sphere around `target`. */
export function cameraBasis(camera: Camera): CameraBasis {
  const yaw = camera.yaw * DEG;
  const pitch = camera.pitch * DEG;
  const cp = Math.cos(pitch);
  const offset: Vec3 = [camera.distance * cp * Math.sin(yaw), camera.distance * Math.sin(pitch), camera.distance * cp * Math.cos(yaw)];
  const position = add(camera.target, offset);
  const forward = normalize(scale(offset, -1));
  let right = cross(forward, [0, 1, 0]);
  right = Math.hypot(...right) < 1e-6 ? [1, 0, 0] : normalize(right);
  const up = cross(right, forward);
  return {
    position,
    right,
    up,
    forward,
    tanHalfFov: Math.tan((camera.fov * DEG) / 2),
    focusDistance: camera.focusDistance > 0 ? camera.focusDistance : camera.distance,
  };
}

/** Ray through normalized device coordinates (-1..1, y up). */
export function cameraRay(camera: Camera, ndcX: number, ndcY: number, aspect: number): Ray {
  const b = cameraBasis(camera);
  const t = viewTanHalf(b.tanHalfFov, aspect);
  const direction = normalize(add(add(b.forward, scale(b.right, ndcX * t * aspect)), scale(b.up, ndcY * t)));
  return { origin: b.position, direction };
}

/** Projects a world point to normalized device coordinates. `depth` is negative behind the camera. */
export function projectPoint(camera: Camera, point: Vec3, aspect: number): { x: number; y: number; depth: number } {
  const b = cameraBasis(camera);
  const v = sub(point, b.position);
  const depth = dot(v, b.forward);
  const z = Math.abs(depth) < 1e-6 ? 1e-6 : depth;
  const t = viewTanHalf(b.tanHalfFov, aspect);
  return {
    x: dot(v, b.right) / (z * t * aspect),
    y: dot(v, b.up) / (z * t),
    depth,
  };
}

export function orbit(camera: Camera, deltaYaw: number, deltaPitch: number): void {
  camera.yaw = ((camera.yaw + deltaYaw + 540) % 360) - 180;
  camera.pitch = clamp(camera.pitch + deltaPitch, -89, 89);
}

export function zoom(camera: Camera, factor: number): void {
  camera.distance = clamp(camera.distance * factor, 0.1, 1000);
}

/** Moves the target in the image plane. dx and dy are fractions of the viewport height. */
export function pan(camera: Camera, dx: number, dy: number): void {
  const b = cameraBasis(camera);
  const extent = 2 * b.tanHalfFov * camera.distance;
  camera.target = madd(madd(camera.target, b.right, -dx * extent), b.up, dy * extent);
}

/** Frames a bounding sphere, keeping the current viewing angle. */
export function frame(camera: Camera, center: Vec3, radius: number): void {
  camera.target = [...center];
  const fit = radius / Math.sin(Math.min(camera.fov, 90) * DEG * 0.5);
  camera.distance = clamp(fit * 1.15, 0.2, 1000);
}
