/**
 * Scene description shared by the renderer and the UI.
 * A scene is an open room (five walls and a rectangular ceiling light)
 * filled with spheres and axis-aligned boxes.
 */

export type Vec3 = [number, number, number];

export const enum MaterialType {
  Diffuse = 0,
  Metal = 1,
  Glass = 2,
}

export interface Material {
  type: MaterialType;
  albedo: Vec3;
  /** Metal only: 0 is a perfect mirror, 1 is very rough. */
  roughness?: number;
  /** Glass only: index of refraction. */
  ior?: number;
}

export interface Sphere {
  center: Vec3;
  radius: number;
  material: Material;
}

export interface Box {
  min: Vec3;
  max: Vec3;
  material: Material;
}

export interface Room {
  min: Vec3;
  max: Vec3;
  floor: Vec3;
  ceiling: Vec3;
  back: Vec3;
  left: Vec3;
  right: Vec3;
}

export interface AreaLight {
  /** Center of the light on the ceiling, as x and z. */
  position: [number, number];
  halfSize: [number, number];
  emission: Vec3;
}

export interface Scene {
  id: string;
  label: string;
  room: Room;
  light: AreaLight;
  spheres: Sphere[];
  boxes: Box[];
}

export const MAX_SPHERES = 8;
export const MAX_BOXES = 8;

const white = (v: number): Vec3 => [v, v, v];
const diffuse = (albedo: Vec3): Material => ({ type: MaterialType.Diffuse, albedo });
const metal = (albedo: Vec3, roughness: number): Material => ({ type: MaterialType.Metal, albedo, roughness });
const glass = (ior = 1.5): Material => ({ type: MaterialType.Glass, albedo: white(0.98), ior });

const ROOM_BOUNDS = { min: [-1.6, 0, -1.2] as Vec3, max: [1.6, 2, 1.4] as Vec3 };

export const SCENES: Scene[] = [
  {
    id: "studio",
    label: "Studio",
    room: { ...ROOM_BOUNDS, floor: white(0.7), ceiling: white(0.75), back: white(0.72), left: white(0.72), right: white(0.72) },
    light: { position: [-0.55, -0.3], halfSize: [0.32, 0.22], emission: [14, 13.4, 12.6] },
    spheres: [
      { center: [-0.78, 0.46, -0.5], radius: 0.46, material: metal(white(0.92), 0.02) },
      { center: [0.62, 0.4, 0.15], radius: 0.4, material: glass(1.5) },
      { center: [0.02, 0.27, -0.85], radius: 0.27, material: diffuse(white(0.82)) },
    ],
    boxes: [{ min: [0.95, 0, -1.05], max: [1.4, 1.1, -0.6], material: diffuse(white(0.06)) }],
  },
  {
    id: "cornell",
    label: "Cornell",
    room: {
      ...ROOM_BOUNDS,
      floor: white(0.725),
      ceiling: white(0.725),
      back: white(0.725),
      left: [0.63, 0.065, 0.05],
      right: [0.14, 0.45, 0.091],
    },
    light: { position: [0, -0.2], halfSize: [0.3, 0.25], emission: [17, 12, 4] },
    spheres: [{ center: [0.55, 0.35, 0.2], radius: 0.35, material: glass(1.5) }],
    boxes: [
      { min: [-1.0, 0, -0.9], max: [-0.35, 1.25, -0.35], material: diffuse(white(0.725)) },
      { min: [0.2, 0, -0.95], max: [0.9, 0.6, -0.35], material: diffuse(white(0.725)) },
    ],
  },
  {
    id: "roughness",
    label: "Roughness",
    room: { ...ROOM_BOUNDS, floor: white(0.45), ceiling: white(0.7), back: white(0.6), left: white(0.6), right: white(0.6) },
    light: { position: [0, 0], halfSize: [0.5, 0.18], emission: [12, 12, 12] },
    spheres: [0, 0.08, 0.2, 0.4, 0.75].map((roughness, i) => ({
      center: [-1.2 + i * 0.6, 0.26, -0.4] as Vec3,
      radius: 0.26,
      material: metal([0.95, 0.78, 0.5], roughness),
    })),
    boxes: [],
  },
];

export function cloneScene(scene: Scene): Scene {
  return structuredClone(scene);
}
