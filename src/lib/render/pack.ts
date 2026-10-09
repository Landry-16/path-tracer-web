/**
 * Packs a scene into the float textures read by trace.frag.
 * Layouts (one row per item, RGBA32F texels):
 *
 * objects   [0] shape, material index, -, -   [1..3] inverse matrix rows   [4] bounding sphere   [5] scale
 * materials [0] base rgb, metallic   [1] emission rgb, roughness   [2] specular, transmission, ior, clearcoat
 *           [3] pattern rgb, pattern scale   [4] clearcoat roughness, pattern type, -, -
 * lights    [0] type, visible, cos(max angle), 1 - cos(max angle)   [1] position or sun direction, radius
 *           [2] u half axis, -   [3] v half axis, -   [4] radiance rgb, area
 */

import { cameraBasis } from "../core/camera";
import { lightFrame, objectFrame } from "../core/geometry";
import { DEG, applyMat3, cross, hexToLinear, length, rotationMatrix, scale, type Vec3 } from "../core/math";
import { SHAPES, type Light, type Scene } from "../core/scene";

export const OBJECT_TEXELS = 6;
export const MATERIAL_TEXELS = 5;
export const LIGHT_TEXELS = 5;

export const LIGHT_CODES = { area: 0, sphere: 1, point: 2, sun: 3 } as const;

export interface PackedScene {
  objects: Float32Array;
  objectCount: number;
  materials: Float32Array;
  materialCount: number;
  lights: Float32Array;
  lightCount: number;
  /** Every uniform that influences the traced image, used to detect changes. */
  uniforms: Float32Array;
}

function packLight(light: Light, out: Float32Array, offset: number): void {
  const radiance = scale(hexToLinear(light.color), light.intensity);
  const frame = lightFrame(light);
  const code = LIGHT_CODES[light.type];
  let cosMax = 1;
  let oneMinusCos = 0;
  let position: Vec3 = light.position;
  let area = 0;

  if (light.type === "sun") {
    // Direction towards the sun is local +Y.
    position = applyMat3(rotationMatrix(light.rotation), [0, 1, 0]);
    const half = (light.angle * DEG) / 2;
    if (half > 1e-5) {
      cosMax = Math.cos(half);
      // 1 - cos(x) = 2 sin^2(x / 2), stable for tiny angles.
      oneMinusCos = 2 * Math.sin(half / 2) ** 2;
      // Intensity is irradiance: spread it over the disk's solid angle.
      const solidAngle = 2 * Math.PI * oneMinusCos;
      radiance[0] /= solidAngle;
      radiance[1] /= solidAngle;
      radiance[2] /= solidAngle;
    }
  } else if (light.type === "area") {
    area = 4 * length(cross(frame.u, frame.v));
  }

  out.set([code, light.visible ? 1 : 0, cosMax, oneMinusCos], offset);
  out.set([...position, light.radius], offset + 4);
  out.set([...frame.u, 0], offset + 8);
  out.set([...frame.v, 0], offset + 12);
  out.set([...radiance, area], offset + 16);
}

export function packScene(scene: Scene): PackedScene {
  const materialIndex = new Map(scene.materials.map((m, i) => [m.id, i]));

  const materials = new Float32Array(Math.max(1, scene.materials.length) * MATERIAL_TEXELS * 4);
  scene.materials.forEach((m, i) => {
    const o = i * MATERIAL_TEXELS * 4;
    const emission = scale(hexToLinear(m.emission), m.emissionStrength);
    materials.set([...hexToLinear(m.baseColor), m.metallic], o);
    materials.set([...emission, m.roughness], o + 4);
    materials.set([m.specular, m.transmission, m.ior, m.clearcoat], o + 8);
    materials.set([...hexToLinear(m.patternColor), m.patternScale], o + 12);
    materials.set([m.clearcoatRoughness, m.pattern === "checker" ? 1 : 0, 0, 0], o + 16);
  });

  const visibleObjects = scene.objects.filter((o) => o.visible);
  const objects = new Float32Array(Math.max(1, visibleObjects.length) * OBJECT_TEXELS * 4);
  visibleObjects.forEach((object, i) => {
    const o = i * OBJECT_TEXELS * 4;
    const f = objectFrame(object);
    objects.set([SHAPES.indexOf(object.shape), materialIndex.get(object.materialId) ?? 0, 0, 0], o);
    objects.set(f.inverse, o + 4);
    objects.set([...f.center, f.boundRadius], o + 16);
    objects.set([...object.scale, 0], o + 20);
  });

  const enabledLights = scene.lights.filter((l) => l.enabled && l.intensity > 0);
  const lights = new Float32Array(Math.max(1, enabledLights.length) * LIGHT_TEXELS * 4);
  enabledLights.forEach((light, i) => packLight(light, lights, i * LIGHT_TEXELS * 4));

  const cam = cameraBasis(scene.camera);
  const env = scene.environment;
  const k = env.intensity;
  const envColors = env.type === "color" ? [hexToLinear(env.color)] : [hexToLinear(env.zenith), hexToLinear(env.horizon), hexToLinear(env.ground)];
  const uniforms = new Float32Array([
    ...cam.position,
    ...cam.right,
    ...cam.up,
    ...cam.forward,
    cam.tanHalfFov,
    scene.camera.aperture,
    cam.focusDistance,
    env.type === "color" ? 0 : 1,
    ...envColors.flatMap((c) => scale(c, k)),
    ...(env.type === "color" ? [0, 0, 0, 0, 0, 0] : []),
    scene.render.maxBounces,
    scene.render.clamp,
  ]);

  return {
    objects,
    objectCount: visibleObjects.length,
    materials,
    materialCount: scene.materials.length,
    lights,
    lightCount: enabledLights.length,
    uniforms,
  };
}

/** Uniform layout offsets inside PackedScene.uniforms. */
export const U = {
  camPos: 0,
  camRight: 3,
  camUp: 6,
  camForward: 9,
  tanHalfFov: 12,
  aperture: 13,
  focus: 14,
  envType: 15,
  envA: 16,
  envB: 19,
  envC: 22,
  maxBounces: 25,
  clamp: 26,
} as const;
