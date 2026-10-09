/**
 * Ready-made scenes and materials. Every preset is plain data, so it can be
 * copied into a project as JSON and loaded with normalizeScene.
 */

import {
  createLight,
  createMaterial,
  createObject,
  normalizeScene,
  type DeepPartial,
  type Material,
  type Scene,
  type SceneObject,
} from "./scene";
import type { Vec3 } from "./math";

/* ------------------------------------------------------------ materials */

export interface MaterialPreset {
  id: string;
  label: string;
  material: Partial<Material>;
}

export const MATERIAL_PRESETS: MaterialPreset[] = [
  { id: "plastic", label: "Plastic", material: { baseColor: "#d8d8d8", roughness: 0.35 } },
  { id: "matte", label: "Matte", material: { baseColor: "#bdbdbd", roughness: 1, specular: 0.3 } },
  { id: "rubber", label: "Rubber", material: { baseColor: "#1c1c1c", roughness: 0.7 } },
  { id: "ceramic", label: "Ceramic", material: { baseColor: "#f2efe8", roughness: 0.6, clearcoat: 1, clearcoatRoughness: 0.03 } },
  { id: "car-paint", label: "Car paint", material: { baseColor: "#9c1018", roughness: 0.45, clearcoat: 1, clearcoatRoughness: 0.02 } },
  { id: "chrome", label: "Chrome", material: { baseColor: "#f4f4f4", metallic: 1, roughness: 0.03 } },
  { id: "brushed-steel", label: "Brushed steel", material: { baseColor: "#b9bcbf", metallic: 1, roughness: 0.32 } },
  { id: "gold", label: "Gold", material: { baseColor: "#ffd27a", metallic: 1, roughness: 0.15 } },
  { id: "copper", label: "Copper", material: { baseColor: "#f4a27c", metallic: 1, roughness: 0.25 } },
  { id: "glass", label: "Glass", material: { baseColor: "#ffffff", transmission: 1, roughness: 0, ior: 1.5 } },
  { id: "frosted-glass", label: "Frosted glass", material: { baseColor: "#f4f8ff", transmission: 1, roughness: 0.3, ior: 1.5 } },
  { id: "jade", label: "Jade", material: { baseColor: "#7fd6a4", transmission: 0.85, roughness: 0.18, ior: 1.6 } },
  { id: "diamond", label: "Diamond", material: { baseColor: "#ffffff", transmission: 1, roughness: 0, ior: 2.42 } },
  { id: "emissive", label: "Emissive", material: { baseColor: "#111111", emission: "#ffb070", emissionStrength: 6 } },
  { id: "checker", label: "Checker", material: { baseColor: "#e8e8e8", roughness: 0.6, pattern: "checker", patternColor: "#2a2a2a", patternScale: 4 } },
];

/** A new material built from a preset, with a fresh id. */
export function materialFromPreset(presetId: string, overrides: Partial<Material> = {}): Material {
  const preset = MATERIAL_PRESETS.find((p) => p.id === presetId) ?? MATERIAL_PRESETS[0];
  return createMaterial({ name: preset.label, ...preset.material, ...overrides });
}

/* --------------------------------------------------------------- scenes */

export interface ScenePreset {
  id: string;
  label: string;
  create: () => Scene;
}

const ROOM_MIN: Vec3 = [-1.6, 0, -1.2];
const ROOM_MAX: Vec3 = [1.6, 2, 1.4];

/** An open box (floor, ceiling and three walls) matching the original demo room. */
function room(walls: { floor: string; ceiling: string; back: string; left: string; right: string }): SceneObject[] {
  const [x0, y0, z0] = ROOM_MIN;
  const [x1, y1, z1] = ROOM_MAX;
  const w = x1 - x0, h = y1 - y0, d = z1 - z0;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
  return [
    createObject("plane", { name: "Floor", position: [cx, y0, cz], scale: [w, 1, d], materialId: walls.floor }),
    createObject("plane", { name: "Ceiling", position: [cx, y1, cz], rotation: [180, 0, 0], scale: [w, 1, d], materialId: walls.ceiling }),
    createObject("plane", { name: "Back wall", position: [cx, cy, z0], rotation: [90, 0, 0], scale: [w, 1, h], materialId: walls.back }),
    createObject("plane", { name: "Left wall", position: [x0, cy, cz], rotation: [0, 0, -90], scale: [h, 1, d], materialId: walls.left }),
    createObject("plane", { name: "Right wall", position: [x1, cy, cz], rotation: [0, 0, 90], scale: [h, 1, d], materialId: walls.right }),
  ];
}

const gray = (v: number): string => {
  const c = Math.round(Math.pow(v, 1 / 2.2) * 255).toString(16).padStart(2, "0");
  return `#${c}${c}${c}`;
};

function scene(partial: DeepPartial<Scene>): Scene {
  return normalizeScene(partial);
}

function studio(): Scene {
  const wall = createMaterial({ name: "Wall", baseColor: gray(0.72), roughness: 0.9 });
  const floor = createMaterial({ name: "Floor", baseColor: gray(0.7), roughness: 0.7 });
  const mirror = createMaterial({ name: "Mirror", baseColor: "#f4f4f4", metallic: 1, roughness: 0.02 });
  const glass = createMaterial({ name: "Glass", baseColor: "#ffffff", transmission: 1, roughness: 0, ior: 1.5 });
  const clay = createMaterial({ name: "Clay", baseColor: gray(0.82), roughness: 0.8 });
  const ink = createMaterial({ name: "Ink", baseColor: gray(0.06), roughness: 0.4 });
  return scene({
    name: "Studio",
    materials: [wall, floor, mirror, glass, clay, ink],
    objects: [
      ...room({ floor: floor.id, ceiling: wall.id, back: wall.id, left: wall.id, right: wall.id }),
      createObject("sphere", { name: "Mirror ball", position: [-0.78, 0.46, -0.5], scale: [0.92, 0.92, 0.92], materialId: mirror.id }),
      createObject("sphere", { name: "Glass ball", position: [0.62, 0.4, 0.15], scale: [0.8, 0.8, 0.8], materialId: glass.id }),
      createObject("sphere", { name: "Clay ball", position: [0.02, 0.27, -0.85], scale: [0.54, 0.54, 0.54], materialId: clay.id }),
      createObject("box", { name: "Pillar", position: [1.175, 0.55, -0.825], scale: [0.45, 1.1, 0.45], materialId: ink.id }),
    ],
    lights: [createLight("area", { name: "Ceiling light", position: [-0.55, 1.999, -0.3], size: [0.64, 0.44], color: "#fff4e6", intensity: 14 })],
  });
}

function cornell(): Scene {
  const white = createMaterial({ name: "White", baseColor: gray(0.725), roughness: 1 });
  const red = createMaterial({ name: "Red", baseColor: "#a5170f", roughness: 1 });
  const green = createMaterial({ name: "Green", baseColor: "#2a8f2c", roughness: 1 });
  const glass = createMaterial({ name: "Glass", baseColor: "#ffffff", transmission: 1, roughness: 0, ior: 1.5 });
  return scene({
    name: "Cornell box",
    materials: [white, red, green, glass],
    objects: [
      ...room({ floor: white.id, ceiling: white.id, back: white.id, left: red.id, right: green.id }),
      createObject("box", { name: "Tall box", position: [-0.62, 0.625, -0.55], rotation: [0, 18, 0], scale: [0.62, 1.25, 0.62], materialId: white.id }),
      createObject("box", { name: "Short box", position: [0.5, 0.3, -0.5], rotation: [0, -17, 0], scale: [0.62, 0.6, 0.62], materialId: white.id }),
      createObject("sphere", { name: "Glass ball", position: [0.55, 0.95, -0.5], scale: [0.7, 0.7, 0.7], materialId: glass.id }),
    ],
    lights: [createLight("area", { name: "Ceiling light", position: [0, 1.999, -0.2], size: [0.6, 0.5], color: "#ffd7a0", intensity: 17 })],
  });
}

function roughness(): Scene {
  const wall = createMaterial({ name: "Wall", baseColor: gray(0.6), roughness: 0.9 });
  const floor = createMaterial({ name: "Floor", baseColor: gray(0.45), roughness: 0.8 });
  const values = [0, 0.15, 0.3, 0.5, 0.8];
  const metals = values.map((r) => createMaterial({ name: `Brass ${r}`, baseColor: "#f2c98a", metallic: 1, roughness: r }));
  return scene({
    name: "Roughness ramp",
    materials: [wall, floor, ...metals],
    objects: [
      ...room({ floor: floor.id, ceiling: wall.id, back: wall.id, left: wall.id, right: wall.id }),
      ...metals.map((m, i) =>
        createObject("sphere", { name: `Sphere ${i + 1}`, position: [-1.2 + i * 0.6, 0.26, -0.4], scale: [0.52, 0.52, 0.52], materialId: m.id }),
      ),
    ],
    lights: [createLight("area", { name: "Strip light", position: [0, 1.999, 0], size: [1, 0.36], intensity: 12 })],
  });
}

function materials(): Scene {
  const ground = createMaterial({ name: "Ground", baseColor: "#d9d9d9", roughness: 0.8, pattern: "checker", patternColor: "#a3a3a3", patternScale: 1 });
  const rows: Partial<Material>[] = [
    { name: "Red plastic", baseColor: "#b3201a", roughness: 0.3 },
    { name: "Car paint", baseColor: "#1d3f9c", roughness: 0.5, clearcoat: 1, clearcoatRoughness: 0.02 },
    { name: "Gold", baseColor: "#ffd27a", metallic: 1, roughness: 0.18 },
    { name: "Copper", baseColor: "#f4a27c", metallic: 1, roughness: 0.4 },
    { name: "Glass", baseColor: "#ffffff", transmission: 1, roughness: 0 },
    { name: "Frosted", baseColor: "#e9f2ff", transmission: 1, roughness: 0.25 },
    { name: "Jade", baseColor: "#6fd39b", transmission: 0.85, roughness: 0.15, ior: 1.6 },
    { name: "Glow", baseColor: "#111111", emission: "#ff9a4d", emissionStrength: 2.5 },
  ];
  const mats = rows.map((m) => createMaterial(m));
  return scene({
    name: "Material showcase",
    camera: { target: [0, 0.35, 0], yaw: 0, pitch: 18, distance: 4.6, fov: 34 },
    environment: { type: "sky", zenith: "#3c64a8", horizon: "#c9d2dc", ground: "#4a4440", intensity: 0.45 },
    materials: [ground, ...mats],
    objects: [
      createObject("plane", { name: "Ground", position: [0, 0, 0], scale: [12, 1, 12], materialId: ground.id }),
      ...mats.map((m, i) =>
        createObject("sphere", {
          name: m.name,
          position: [-1.5 + (i % 4) * 1, 0.35, i < 4 ? -0.55 : 0.55],
          scale: [0.7, 0.7, 0.7],
          materialId: m.id,
        }),
      ),
    ],
    lights: [
      createLight("sun", { name: "Sun", position: [1.8, 2.2, 1], rotation: [-40, 0, 30], intensity: 2, angle: 2 }),
      createLight("area", { name: "Softbox", position: [-2, 2.4, 1.5], rotation: [-40, 0, -35], size: [1.6, 1.2], intensity: 2 }),
    ],
  });
}

function shapes(): Scene {
  const ground = createMaterial({ name: "Ground", baseColor: "#bfb8ad", roughness: 0.9 });
  const a = createMaterial({ name: "Coral", baseColor: "#e5684e", roughness: 0.45 });
  const b = createMaterial({ name: "Teal", baseColor: "#2b8c86", roughness: 0.3, clearcoat: 0.6 });
  const c = createMaterial({ name: "Steel", baseColor: "#c4c7cb", metallic: 1, roughness: 0.25 });
  const d = createMaterial({ name: "Glass", baseColor: "#ffffff", transmission: 1, roughness: 0 });
  const e = createMaterial({ name: "Sand", baseColor: "#e6c98f", roughness: 0.8 });
  return scene({
    name: "Primitives",
    camera: { target: [0, 0.45, 0], yaw: 25, pitch: 22, distance: 4.4, fov: 36 },
    environment: { type: "sky", zenith: "#5582c4", horizon: "#d5dae0", ground: "#55504a", intensity: 0.45 },
    materials: [ground, a, b, c, d, e],
    objects: [
      createObject("disk", { name: "Ground", position: [0, 0, 0], scale: [9, 1, 9], materialId: ground.id }),
      createObject("box", { name: "Box", position: [-1.1, 0.4, -0.3], rotation: [0, 30, 0], scale: [0.8, 0.8, 0.8], materialId: a.id }),
      createObject("cylinder", { name: "Cylinder", position: [0, 0.5, -0.8], scale: [0.7, 1, 0.7], materialId: b.id }),
      createObject("cone", { name: "Cone", position: [1.1, 0.5, -0.3], scale: [0.8, 1, 0.8], materialId: e.id }),
      createObject("sphere", { name: "Sphere", position: [-0.45, 0.35, 0.65], scale: [0.7, 0.7, 0.7], materialId: c.id }),
      createObject("sphere", { name: "Lens", position: [0.6, 0.3, 0.7], scale: [0.6, 0.6, 0.6], materialId: d.id }),
    ],
    lights: [createLight("sun", { name: "Sun", position: [1.5, 2.5, 1.5], rotation: [-35, 0, 40], intensity: 2.4, angle: 1.5 })],
  });
}

function empty(): Scene {
  const ground = createMaterial({ name: "Ground", baseColor: "#bdbdbd", roughness: 0.8 });
  const clay = createMaterial({ name: "Clay", baseColor: "#d6d0c8", roughness: 0.6 });
  return scene({
    name: "Empty",
    camera: { target: [0, 0.5, 0], yaw: 20, pitch: 18, distance: 4, fov: 38 },
    environment: { type: "sky", intensity: 0.45 },
    materials: [ground, clay],
    objects: [
      createObject("plane", { name: "Ground", position: [0, 0, 0], scale: [10, 1, 10], materialId: ground.id }),
      createObject("sphere", { name: "Sphere", position: [0, 0.5, 0], materialId: clay.id }),
    ],
    lights: [createLight("sun", { name: "Sun", intensity: 2.4, angle: 1 })],
  });
}

export const SCENE_PRESETS: ScenePreset[] = [
  { id: "studio", label: "Studio", create: studio },
  { id: "cornell", label: "Cornell box", create: cornell },
  { id: "roughness", label: "Roughness ramp", create: roughness },
  { id: "materials", label: "Material showcase", create: materials },
  { id: "primitives", label: "Primitives", create: shapes },
  { id: "empty", label: "Empty", create: empty },
];

/** A fresh copy of a preset scene (unknown ids fall back to the first preset). */
export function scenePreset(id: string): Scene {
  return (SCENE_PRESETS.find((p) => p.id === id) ?? SCENE_PRESETS[0]).create();
}
