/**
 * path-tracer-web: a progressive WebGL2 path tracer with a scene editor.
 *
 * Main entry points:
 * - Viewer: a canvas showing a scene, with camera and light controls.
 * - Editor: the full editor UI (outliner, materials, inspector, gizmos).
 * - renderMaterialPreview: path traced material thumbnails.
 * - defineElements: registers <pt-viewer>, <pt-editor> and <pt-material-preview>.
 * - Scene helpers: createScene, normalizeScene, presets, share link encoding.
 */

export { Viewer, type ViewerOptions, type ViewerEvents, type FrameInfo, type PointerTool } from "./viewer/viewer";
export { Editor, DEFAULT_BASE_URL, type EditorOptions, type EditorEvents } from "./editor/editor";
export { renderMaterialPreview, type PreviewOptions } from "./preview/preview";
export { Renderer } from "./render/renderer";
export { GLError } from "./render/gl";
export {
  defineElements,
  PathTracerViewerElement,
  PathTracerEditorElement,
  PathTracerMaterialPreviewElement,
} from "./elements/elements";

export {
  SHAPES,
  LIGHT_TYPES,
  TONE_MAPPINGS,
  PATTERNS,
  DEFAULT_MATERIAL,
  DEFAULT_CAMERA,
  DEFAULT_ENVIRONMENT,
  DEFAULT_RENDER,
  uid,
  createScene,
  createMaterial,
  createObject,
  createLight,
  cloneScene,
  normalizeScene,
  normalizeMaterial,
  normalizeObject,
  normalizeLight,
  findItem,
  findMaterial,
  type Scene,
  type SceneObject,
  type Light,
  type Material,
  type Camera,
  type Environment,
  type RenderSettings,
  type Transform,
  type ShapeType,
  type LightType,
  type ToneMapping,
  type Pattern,
  type Color,
  type DeepPartial,
} from "./core/scene";
export { SCENE_PRESETS, MATERIAL_PRESETS, scenePreset, materialFromPreset, type ScenePreset, type MaterialPreset } from "./core/presets";
export { encodeScene, decodeScene, sceneFromHash } from "./core/share";
export { cameraBasis, cameraRay, projectPoint, orbit, pan, zoom, frame, type CameraBasis, type Ray } from "./core/camera";
export { raycast, sceneBounds, objectBounds, type RayHit, type Bounds } from "./core/geometry";
export type { Vec3 } from "./core/math";
