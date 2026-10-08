import type { Vec3 } from "./scene";

export interface CameraBasis {
  position: Vec3;
  right: Vec3;
  up: Vec3;
  forward: Vec3;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Orbit camera looking at a target, limited so it always stays in front of the open room. */
export class OrbitCamera {
  static readonly DEFAULTS = { yaw: 0, pitch: 0.06, distance: 4.4 };

  target: Vec3 = [0, 0.9, -0.3];
  yaw = OrbitCamera.DEFAULTS.yaw;
  pitch = OrbitCamera.DEFAULTS.pitch;
  distance = OrbitCamera.DEFAULTS.distance;
  /** Vertical field of view in degrees. */
  fov = 38;
  /** Thin lens aperture radius. 0 disables depth of field. */
  aperture = 0;

  orbit(deltaYaw: number, deltaPitch: number): void {
    this.yaw = clamp(this.yaw + deltaYaw, -0.75, 0.75);
    this.pitch = clamp(this.pitch + deltaPitch, -0.12, 0.6);
  }

  zoom(factor: number): void {
    this.distance = clamp(this.distance * factor, 2.6, 7.5);
  }

  reset(): void {
    Object.assign(this, OrbitCamera.DEFAULTS);
  }

  /** Distance from the eye to the target, used as the focus plane. */
  get focusDistance(): number {
    return this.distance;
  }

  basis(): CameraBasis {
    const cp = Math.cos(this.pitch);
    const position: Vec3 = [
      this.target[0] + this.distance * cp * Math.sin(this.yaw),
      this.target[1] + this.distance * Math.sin(this.pitch),
      this.target[2] + this.distance * cp * Math.cos(this.yaw),
    ];
    const forward = normalize([this.target[0] - position[0], this.target[1] - position[1], this.target[2] - position[2]]);
    const right = normalize(cross(forward, [0, 1, 0]));
    const up = cross(right, forward);
    return { position, right, up, forward };
  }
}
