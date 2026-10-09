/**
 * Scene document: a plain JSON-serializable description shared by the renderer,
 * the viewer and the editor. Colors are sRGB hex strings ("#rrggbb"),
 * angles are degrees, distances are scene units (roughly meters).
 */

import { clamp, linearToHex, type Vec3 } from "./math";

export type { Vec3 } from "./math";

/** sRGB color as "#rrggbb". */
export type Color = string;

export const SHAPES = ["sphere", "box", "cylinder", "cone", "plane", "disk"] as const;
export type ShapeType = (typeof SHAPES)[number];

export const LIGHT_TYPES = ["area", "sphere", "point", "sun"] as const;
export type LightType = (typeof LIGHT_TYPES)[number];

export const TONE_MAPPINGS = ["aces", "reinhard", "linear"] as const;
export type ToneMapping = (typeof TONE_MAPPINGS)[number];

export const PATTERNS = ["none", "checker"] as const;
export type Pattern = (typeof PATTERNS)[number];

/** Physically based material, close to the glTF / Disney metallic-roughness model. */
export interface Material {
  id: string;
  name: string;
  baseColor: Color;
  /** 0 is a dielectric (plastic, wood...), 1 is a metal. */
  metallic: number;
  /** Microfacet roughness: 0 is a mirror, 1 is fully rough. */
  roughness: number;
  /** Dielectric specular level. 0.5 maps to a 4% reflectance (F0 = 0.04). */
  specular: number;
  /** 0 is opaque, 1 is clear glass. */
  transmission: number;
  /** Index of refraction used by transmission. */
  ior: number;
  /** Strength of a glossy varnish layer on top of the base. */
  clearcoat: number;
  clearcoatRoughness: number;
  emission: Color;
  /** Emitted radiance multiplier. 0 disables emission. */
  emissionStrength: number;
  /** Procedural pattern mixed into the base color, in object space. */
  pattern: Pattern;
  patternColor: Color;
  /** Checker cells per scene unit, measured in the object's own frame. */
  patternScale: number;
}

export interface Transform {
  position: Vec3;
  /** Euler angles in degrees, applied X then Y then Z (Rx * Ry * Rz). */
  rotation: Vec3;
  scale: Vec3;
}

/**
 * A primitive. Every shape fits the unit cube [-0.5, 0.5] in object space,
 * so `scale` is the size of the shape in world units.
 */
export interface SceneObject extends Transform {
  id: string;
  name: string;
  shape: ShapeType;
  materialId: string;
  visible: boolean;
}

export interface Light {
  id: string;
  name: string;
  type: LightType;
  enabled: boolean;
  /** Whether camera and reflection rays see the emitter itself (area and sphere lights). */
  visible: boolean;
  /** Position of the light. For a sun it only places the editor handle. */
  position: Vec3;
  /** Orientation in degrees. Area lights and suns shine along their local -Y axis. */
  rotation: Vec3;
  color: Color;
  /**
   * Area and sphere: emitted radiance. Point: radiant intensity.
   * Sun: irradiance on a surface facing it.
   */
  intensity: number;
  /** Area light width and depth. */
  size: [number, number];
  /** Sphere light radius. */
  radius: number;
  /** Sun angular diameter in degrees. 0 gives perfectly sharp shadows. */
  angle: number;
}

export interface Camera {
  target: Vec3;
  /** Horizontal orbit angle in degrees. */
  yaw: number;
  /** Vertical orbit angle in degrees. */
  pitch: number;
  distance: number;
  /** Vertical field of view in degrees. */
  fov: number;
  /** Thin lens radius. 0 disables depth of field. */
  aperture: number;
  /** Distance of the focus plane from the camera. 0 focuses on the orbit target. */
  focusDistance: number;
}

export interface Environment {
  type: "color" | "sky";
  color: Color;
  zenith: Color;
  horizon: Color;
  ground: Color;
  intensity: number;
}

export interface RenderSettings {
  maxBounces: number;
  /** Stop refining after this many samples per pixel. 0 never stops. */
  maxSamples: number;
  /** Exposure in stops (EV). */
  exposure: number;
  toneMapping: ToneMapping;
  /** Luminance clamp applied to each sample to tame fireflies. 0 disables it. */
  clamp: number;
}

export interface Scene {
  version: 2;
  name: string;
  camera: Camera;
  environment: Environment;
  render: RenderSettings;
  materials: Material[];
  objects: SceneObject[];
  lights: Light[];
}

/** Deep partial used by the factories and by normalizeScene. */
export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] };

/* ------------------------------------------------------------------ ids */

let counter = 0;

/** Short unique id with a readable prefix, e.g. "obj-k3f9a2". */
export function uid(prefix: string): string {
  counter = (counter + 1) % 1296;
  const random = Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, "0");
  return `${prefix}-${random}${counter.toString(36).padStart(2, "0")}`;
}

/* ------------------------------------------------------------ defaults */

export const DEFAULT_MATERIAL: Omit<Material, "id"> = {
  name: "Material",
  baseColor: "#cccccc",
  metallic: 0,
  roughness: 0.5,
  specular: 0.5,
  transmission: 0,
  ior: 1.5,
  clearcoat: 0,
  clearcoatRoughness: 0.05,
  emission: "#ffffff",
  emissionStrength: 0,
  pattern: "none",
  patternColor: "#222222",
  patternScale: 4,
};

export const DEFAULT_CAMERA: Camera = {
  target: [0, 0.9, -0.3],
  yaw: 0,
  pitch: 3.5,
  distance: 4.4,
  fov: 38,
  aperture: 0,
  focusDistance: 0,
};

export const DEFAULT_ENVIRONMENT: Environment = {
  type: "color",
  color: "#000000",
  zenith: "#4a7bc8",
  horizon: "#c9d6e6",
  ground: "#3a3632",
  intensity: 0.45,
};

export const DEFAULT_RENDER: RenderSettings = {
  maxBounces: 8,
  maxSamples: 4096,
  exposure: 0,
  toneMapping: "aces",
  clamp: 8,
};

const SHAPE_NAMES: Record<ShapeType, string> = {
  sphere: "Sphere",
  box: "Box",
  cylinder: "Cylinder",
  cone: "Cone",
  plane: "Plane",
  disk: "Disk",
};

const LIGHT_NAMES: Record<LightType, string> = {
  area: "Area light",
  sphere: "Sphere light",
  point: "Point light",
  sun: "Sun",
};

/* ----------------------------------------------------------- factories */

export function createMaterial(partial: Partial<Material> = {}): Material {
  return { ...DEFAULT_MATERIAL, ...partial, id: partial.id ?? uid("mat") };
}

export function createObject(shape: ShapeType, partial: Partial<SceneObject> = {}): SceneObject {
  const flat = shape === "plane" || shape === "disk";
  return {
    id: partial.id ?? uid("obj"),
    name: partial.name ?? SHAPE_NAMES[shape],
    shape,
    position: partial.position ?? [0, flat ? 0 : 0.5, 0],
    rotation: partial.rotation ?? [0, 0, 0],
    scale: partial.scale ?? (flat ? [2, 1, 2] : [1, 1, 1]),
    materialId: partial.materialId ?? "",
    visible: partial.visible ?? true,
  };
}

export function createLight(type: LightType, partial: Partial<Light> = {}): Light {
  const defaults: Record<LightType, Partial<Light>> = {
    area: { intensity: 12, position: [0, 1.95, 0] },
    sphere: { intensity: 20, position: [0, 1.4, 0], radius: 0.1 },
    point: { intensity: 2, position: [0, 1.4, 0] },
    sun: { intensity: 2.4, position: [0, 2.5, 0], rotation: [-35, 0, 25], color: "#fff4e0" },
  };
  return {
    id: uid("light"),
    name: LIGHT_NAMES[type],
    enabled: true,
    visible: true,
    position: [0, 1.5, 0],
    rotation: [0, 0, 0],
    color: "#ffffff",
    intensity: 10,
    size: [0.6, 0.4],
    radius: 0.1,
    angle: 0.53,
    ...defaults[type],
    ...partial,
    type,
  };
}

export function createScene(partial: DeepPartial<Scene> = {}): Scene {
  return normalizeScene(partial);
}

export function cloneScene(scene: Scene): Scene {
  return structuredClone(scene);
}

/* -------------------------------------------------------- normalization */

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, fallback: number, lo = -Infinity, hi = Infinity): number =>
  typeof v === "number" && Number.isFinite(v) ? clamp(v, lo, hi) : fallback;
const str = (v: unknown, fallback: string): string => (typeof v === "string" && v.length > 0 ? v : fallback);
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);
const oneOf = <T extends string>(v: unknown, values: readonly T[], fallback: T): T =>
  values.includes(v as T) ? (v as T) : fallback;

function vec3(v: unknown, fallback: Vec3): Vec3 {
  if (!Array.isArray(v) || v.length !== 3) return [...fallback];
  return v.map((x, i) => num(x, fallback[i])) as Vec3;
}

/** Accepts "#rgb", "#rrggbb" or a linear [r, g, b] array and returns "#rrggbb". */
export function color(v: unknown, fallback: Color): Color {
  if (typeof v === "string") {
    const short = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(v.trim());
    if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
    const long = /^#?([0-9a-f]{6})$/i.exec(v.trim());
    if (long) return `#${long[1].toLowerCase()}`;
  }
  if (Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number")) return linearToHex(v as Vec3);
  return fallback;
}

export function normalizeMaterial(input: unknown): Material {
  const m = isObject(input) ? input : {};
  const d = DEFAULT_MATERIAL;
  return {
    id: str(m.id, uid("mat")),
    name: str(m.name, d.name),
    baseColor: color(m.baseColor, d.baseColor),
    metallic: num(m.metallic, d.metallic, 0, 1),
    roughness: num(m.roughness, d.roughness, 0, 1),
    specular: num(m.specular, d.specular, 0, 1),
    transmission: num(m.transmission, d.transmission, 0, 1),
    ior: num(m.ior, d.ior, 1, 3),
    clearcoat: num(m.clearcoat, d.clearcoat, 0, 1),
    clearcoatRoughness: num(m.clearcoatRoughness, d.clearcoatRoughness, 0, 1),
    emission: color(m.emission, d.emission),
    emissionStrength: num(m.emissionStrength, d.emissionStrength, 0, 1000),
    pattern: oneOf(m.pattern, PATTERNS, d.pattern),
    patternColor: color(m.patternColor, d.patternColor),
    patternScale: num(m.patternScale, d.patternScale, 0.01, 1000),
  };
}

export function normalizeObject(input: unknown): SceneObject {
  const o = isObject(input) ? input : {};
  const base = createObject(oneOf(o.shape, SHAPES, "sphere"), { id: str(o.id, uid("obj")) });
  return {
    ...base,
    name: str(o.name, base.name),
    position: vec3(o.position, base.position),
    rotation: vec3(o.rotation, base.rotation),
    scale: vec3(o.scale, base.scale),
    materialId: typeof o.materialId === "string" ? o.materialId : "",
    visible: bool(o.visible, true),
  };
}

export function normalizeLight(input: unknown): Light {
  const l = isObject(input) ? input : {};
  const base = createLight(oneOf(l.type, LIGHT_TYPES, "area"), { id: str(l.id, uid("light")) });
  const size = Array.isArray(l.size) && l.size.length === 2 ? l.size : base.size;
  return {
    ...base,
    name: str(l.name, base.name),
    enabled: bool(l.enabled, true),
    visible: bool(l.visible, true),
    position: vec3(l.position, base.position),
    rotation: vec3(l.rotation, base.rotation),
    color: color(l.color, base.color),
    intensity: num(l.intensity, base.intensity, 0, 1e6),
    size: [num(size[0], base.size[0], 0.001), num(size[1], base.size[1], 0.001)],
    radius: num(l.radius, base.radius, 0.001),
    angle: num(l.angle, base.angle, 0, 90),
  };
}

/**
 * Turns any JSON-like value into a valid scene: missing fields get defaults,
 * out of range numbers are clamped and dangling material references are repaired.
 * Use it on anything loaded from a file, a URL or a user.
 */
export function normalizeScene(input: unknown): Scene {
  const s = isObject(input) ? input : {};
  const cam = isObject(s.camera) ? s.camera : {};
  const env = isObject(s.environment) ? s.environment : {};
  const render = isObject(s.render) ? s.render : {};

  const materials = (Array.isArray(s.materials) ? s.materials : []).map(normalizeMaterial);
  if (materials.length === 0) materials.push(createMaterial({ id: "mat-default", name: "Default" }));
  const materialIds = new Set(materials.map((m) => m.id));

  const objects = (Array.isArray(s.objects) ? s.objects : []).map(normalizeObject);
  for (const o of objects) if (!materialIds.has(o.materialId)) o.materialId = materials[0].id;

  return {
    version: 2,
    name: str(s.name, "Untitled"),
    camera: {
      target: vec3(cam.target, DEFAULT_CAMERA.target),
      yaw: num(cam.yaw, DEFAULT_CAMERA.yaw),
      pitch: num(cam.pitch, DEFAULT_CAMERA.pitch, -89, 89),
      distance: num(cam.distance, DEFAULT_CAMERA.distance, 0.05, 1e4),
      fov: num(cam.fov, DEFAULT_CAMERA.fov, 5, 150),
      aperture: num(cam.aperture, DEFAULT_CAMERA.aperture, 0, 10),
      focusDistance: num(cam.focusDistance, DEFAULT_CAMERA.focusDistance, 0, 1e4),
    },
    environment: {
      type: oneOf(env.type, ["color", "sky"] as const, DEFAULT_ENVIRONMENT.type),
      color: color(env.color, DEFAULT_ENVIRONMENT.color),
      zenith: color(env.zenith, DEFAULT_ENVIRONMENT.zenith),
      horizon: color(env.horizon, DEFAULT_ENVIRONMENT.horizon),
      ground: color(env.ground, DEFAULT_ENVIRONMENT.ground),
      intensity: num(env.intensity, DEFAULT_ENVIRONMENT.intensity, 0, 1e4),
    },
    render: {
      maxBounces: Math.round(num(render.maxBounces, DEFAULT_RENDER.maxBounces, 1, 32)),
      maxSamples: Math.round(num(render.maxSamples, DEFAULT_RENDER.maxSamples, 0, 1e6)),
      exposure: num(render.exposure, DEFAULT_RENDER.exposure, -10, 10),
      toneMapping: oneOf(render.toneMapping, TONE_MAPPINGS, DEFAULT_RENDER.toneMapping),
      clamp: num(render.clamp, DEFAULT_RENDER.clamp, 0, 1e4),
    },
    materials,
    objects,
    lights: (Array.isArray(s.lights) ? s.lights : []).map(normalizeLight),
  };
}

/* -------------------------------------------------------------- lookup */

export type Selectable = { kind: "object"; item: SceneObject } | { kind: "light"; item: Light };

export function findItem(scene: Scene, id: string | null | undefined): Selectable | null {
  if (!id) return null;
  const object = scene.objects.find((o) => o.id === id);
  if (object) return { kind: "object", item: object };
  const light = scene.lights.find((l) => l.id === id);
  if (light) return { kind: "light", item: light };
  return null;
}

export function findMaterial(scene: Scene, id: string): Material {
  return scene.materials.find((m) => m.id === id) ?? scene.materials[0];
}
